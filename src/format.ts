/** Formatting command results and background job lists. */
import type { Execution, Job } from "./types.ts";
import { readTail } from "./tail.ts";
import { sanitizeOutput } from "./sanitize.ts";

function kb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function secs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Foreground results have no public job id. */
export function header(job: Execution): string {
  const id = job.id ? `${job.id} · ` : "";
  const duration = secs(Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt));
  if (job.status === "running") return `[${id}running · ${duration}]`;
  const verdict = job.status === "orphaned"
    ? "orphaned (another session)"
    : job.signal ? `signal ${job.signal}` : job.status === "killed" ? "killed" : `exit ${job.exitCode ?? "?"}`;
  return `[${id}${job.status} · ${verdict} · ${duration}]`;
}

/** A cleaned byte-bounded tail; no line selection, deduplication, or report rewriting. */
export function formatResult(job: Execution, tailBytes: number): string {
  const tail = readTail(job.logPath, tailBytes);
  const lines = [header(job)];
  if (tail.missing) {
    lines.push(`(log unavailable: ${job.logPath} could not be read)`);
    return lines.join("\n");
  }
  if (tail.truncated) {
    lines.push(`… this is the last ${kb(Buffer.byteLength(tail.text, "utf8"))} of a ${kb(tail.bytes)} log — full log: ${job.logPath}`);
  }
  const text = sanitizeOutput(tail.text).replace(/\n+$/, "");
  lines.push(text || (job.status === "running" ? "(no output yet)" : "(no output)"));
  return lines.join("\n");
}

/** A roster of background jobs for shell_status with no id. */
export function formatList(jobs: Job[]): string {
  if (jobs.length === 0) return "No background commands this session.";
  const rows = jobs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => {
      const cmd = j.command.replace(/\s+/g, " ").trim();
      const short = cmd.length <= 48 ? cmd : `${cmd.slice(0, 47)}…`;
      return `${header(j)}  ${short}`;
    });
  return [`${jobs.filter((j) => j.status === "running").length} running, ${jobs.length} total:`, ...rows].join("\n");
}
