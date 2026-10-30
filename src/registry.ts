/**
 * Background job records, in memory and mirrored to disk.
 *
 * The live Map is the source of truth while the session runs. Each job is also
 * written to a small JSON sidecar (atomically, temp + rename) so the status
 * tool still answers after a `/reload` re-instantiates the extension, and so a
 * job that outran the session can be reconciled: on load, a job still marked
 * running whose pid is no longer alive is settled as finished rather than shown
 * as forever-running.
 *
 * Scoped to one session via the base directory the caller supplies, so two pi
 * sessions never reconcile each other's jobs. Zero dependencies — node:fs/path.
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Execution, Job } from "./types.ts";
import { isRecord } from "./types.ts";

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

function isJob(v: unknown): v is Job {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.command === "string" &&
    typeof v.logPath === "string" &&
    typeof v.status === "string"
  );
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private counters = { bg: 0, fg: 0 };
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    // Logs and sidecars carry command output and cwd paths: the user's eyes only.
    mkdirSync(join(baseDir, "logs"), { recursive: true, mode: 0o700 });
  }

  /** The directory this registry's sidecars and logs live under. */
  dir(): string {
    return this.baseDir;
  }

  /** Private execution state: no public id, counter allocation, or sidecar. */
  createExecution(command: string, cwd: string): Execution {
    return {
      command,
      cwd,
      pid: null,
      hostPid: process.pid,
      status: "running",
      exitCode: null,
      signal: null,
      logPath: join(this.baseDir, "logs", `${randomUUID()}.log`),
      startedAt: Date.now(),
      endedAt: null,
      background: false,
      auto: false,
      delivered: false,
    };
  }

  /** Promote an execution without changing its process, log, or start time. */
  register(execution: Execution, auto: boolean): Job {
    if (execution.id) throw new Error("Execution is already registered");
    const prefix = auto ? "fg" : "bg";
    const job = Object.assign(execution, {
      id: `${prefix}-${++this.counters[prefix]}`,
      background: true,
      auto,
    });
    this.jobs.set(job.id, job);
    this.persist(job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  all(): Job[] {
    return [...this.jobs.values()];
  }

  running(): Job[] {
    return this.all().filter((j) => j.status === "running");
  }

  persist(job: Job): void {
    try {
      const file = join(this.baseDir, `${job.id}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // A registry we cannot persist still works for the live session.
    }
  }

  /** Read one job's sidecar from disk, or null if missing/corrupt. */
  readSidecar(id: string): Job | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.baseDir, `${id}.json`), "utf8"));
      return isJob(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * Load persisted jobs and reconcile any still marked running:
   *
   *  - a record written by this same host process (a `/reload` keeps the host
   *    pid) is a genuine survivor — kept running if its pid is still alive so the
   *    new instance can adopt it, settled to `done` if the process has since died;
   *  - a record from any other host pid (another session that reused this dir, or
   *    a crashed one, or a pre-upgrade sidecar with no hostPid) is *not* ours: its
   *    pid may since belong to something unrelated, so we never treat it as
   *    running (which would make session_shutdown kill a stranger's pid) — it is
   *    surfaced as `orphaned` and kept out of running().
   */
  load(): void {
    let files: string[];
    try {
      files = readdirSync(this.baseDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.baseDir, f), "utf8"));
        if (!isJob(raw)) continue;
        const job = raw;
        // Older versions did not record foreground/background state. Preserve
        // their existing visibility and IDs rather than guessing from the prefix
        // (every command used to be bg-N).
        if (typeof job.background !== "boolean") job.background = true;
        if (job.status === "running") {
          if (job.hostPid !== process.pid) {
            job.status = "orphaned";
            job.endedAt = job.endedAt ?? Date.now();
          } else if (!isAlive(job.pid)) {
            job.status = "done";
            job.endedAt = job.endedAt ?? Date.now();
          }
        }
        const match = /^(bg|fg)-(\d+)$/.exec(job.id);
        if (match) {
          const prefix = match[1] as "bg" | "fg";
          this.counters[prefix] = Math.max(this.counters[prefix], Number(match[2]));
        }
        // Old foreground records are not background jobs. Keep them out of the
        // public registry, but avoid reusing their ids when migrating.
        if (job.background) this.jobs.set(job.id, job);
      } catch {
        // Skip a corrupt sidecar rather than fail the whole load.
      }
    }
  }
}
