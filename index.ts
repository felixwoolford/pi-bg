/**
 * shell-background — long-running bash goes async.
 *
 * Re-registers pi's `bash` tool with the same shell, cwd and env, but a
 * different lifecycle:
 *
 *   - a command's stdout+stderr are written straight to a log file via
 *     inherited file descriptors (no pipes, so no drain deadlock and no lost
 *     output at any volume), the process is spawned detached and unref'd so it
 *     survives the tool returning;
 *   - a foreground command that is still running after the auto-background
 *     threshold (default 30s, interactive sessions only) is moved to the
 *     background: the tool returns "moved to background, id=…" and the result is
 *     delivered into the conversation when the command finishes;
 *   - `background: true` launches detached from the start and returns the id
 *     immediately.
 *
 * `shell_status` polls or collects a job (and lists them all); `shell_kill`
 * terminates one and its whole process tree. Delivery only works in a session
 * that outlives the run, so auto-background is off under headless `pi -p` (explicit
 * background still works, collected with shell_status inside the turn).
 *
 * pi has no native background bash — every command is awaited to completion —
 * so the spawn is our own, reusing pi's shell resolution (getShellConfig) for
 * byte-identical shell behaviour. Zero runtime dependencies.
 */
import {
  createBashToolDefinition,
  getAgentDir,
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";

import { JobRegistry, isAlive } from "./src/registry.ts";
import { spawnToFile } from "./src/spawn.ts";
import { killTree } from "./src/kill.ts";
import { readTail } from "./src/tail.ts";
import { buildEnv } from "./src/env.ts";
import { DEFAULT_SETTINGS, resolveSettings, type ShellBgSettings } from "./src/config.ts";
import { backgroundedResult, deliveryMessage, DELIVERY_TYPE } from "./src/pending.ts";
import { formatResult, formatList, header } from "./src/format.ts";
import { sanitizeOutput } from "./src/sanitize.ts";
import { readFull } from "./src/tail.ts";
import { STRUCTURED_OUTPUT_MAX_BYTES, bashOutputSchema, buildStructured, type BashStructured } from "./src/structured.ts";
import { buildWidgetLines } from "./src/widget.ts";
import { isFinished } from "./src/types.ts";
import type { Execution, Job } from "./src/types.ts";

type UiContext = ExtensionContext;
type AnyTool = { name: string; execute: (...a: never[]) => unknown; [k: string]: unknown };
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  /** pi 0.99: what codemode scripts and ctx.executeTool() callers receive instead of the text. */
  structuredContent?: BashStructured;
  isError?: boolean;
};

const WIDGET = "shell-bg";

export default function shellBackground(pi: ExtensionAPI) {
  let settings: ShellBgSettings = DEFAULT_SETTINGS;
  let registry: JobRegistry | null = null;
  // Only running foreground executions need private shutdown bookkeeping.
  const foreground = new Set<Execution>();
  let lastUiCtx: UiContext | null = null;
  let widgetTimer: NodeJS.Timeout | null = null;
  // Set on a /reload shutdown: this (old) instance's processes are being handed
  // to the next instance in the same host process, so its settle/delivery
  // closures must go quiet — flush status to disk, but never kill and never
  // deliver through the now-stale pi handle. Each instance has its own copy
  // (reload builds a fresh closure), so this only ever flips once, on the way out.
  let handedOff = false;

  const ROOT = join(tmpdir(), "shell-bg");
  const MAX_SESSION_DIR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  // Ref'd on purpose: this backs the shell_status `wait` poll, which is awaited
  // inside an in-flight tool call, so the timer must actually resolve rather than
  // let an otherwise-idle loop exit out from under it.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * The one auto-background threshold, computed once so the bash guideline and
   * runBash cannot drift: auto-background needs a session that outlives the run
   * to deliver into, which a headless `pi -p` does not have, so it is off there.
   */
  const effectiveAutoMs = (hasUI: boolean): number => (hasUI ? settings.autoBackgroundMs : 0);

  // ── setup ──────────────────────────────────────────────────────────

  /**
   * A stable per-session key: the session id survives a /reload (so adopted
   * jobs are found again) and differs across /new and /resume (so sessions never
   * reconcile or kill each other's jobs). Falls back to a cwd hash only when no
   * session manager is present (e.g. the unit harness).
   */
  function sessionKey(ctx: UiContext): string {
    let id: string | undefined;
    try {
      id = ctx.sessionManager?.getSessionId?.();
    } catch {
      // ignore — fall through to the cwd hash
    }
    if (id) return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
    return createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 16);
  }

  /** Remove sibling session dirs untouched for a week (a crash leaves the dir). */
  function sweepOldDirs(keep: string): void {
    let names: string[];
    try {
      names = readdirSync(ROOT);
    } catch {
      return;
    }
    const cutoff = Date.now() - MAX_SESSION_DIR_AGE_MS;
    for (const name of names) {
      if (name === keep) continue; // never sweep the session we are starting
      const p = join(ROOT, name);
      try {
        const st = statSync(p);
        if (st.isDirectory() && st.mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
      } catch {
        // A dir we cannot stat or remove is not worth failing startup over.
      }
    }
  }

  function loadSettings(cwd: string): string[] {
    for (const file of [join(cwd, ".pi", "shell-background.json"), join(getAgentDir(), "shell-background.json")]) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = resolveSettings(JSON.parse(raw));
        settings = parsed.settings;
        return parsed.warnings;
      } catch (err) {
        settings = DEFAULT_SETTINGS;
        return [`${file}: ${err instanceof Error ? err.message : String(err)}`];
      }
    }
    const parsed = resolveSettings(undefined);
    settings = parsed.settings;
    return parsed.warnings;
  }

  /** Shell + args, reusing pi's resolution; command rides in argv (not stdin). */
  function shellArgv(): { shell: string; args: string[] } {
    const cfg = getShellConfig();
    return { shell: cfg.shell, args: [...cfg.args] };
  }

  function stopWidgetTimer(): void {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI || !registry) return;
    lastUiCtx = ctx;
    const now = Date.now();
    const lines = buildWidgetLines(registry.all(), ctx.ui.theme as never, now);
    if (lines.length === 0) {
      ctx.ui.setWidget(WIDGET, undefined);
      stopWidgetTimer();
      return;
    }
    ctx.ui.setWidget(WIDGET, (_tui: unknown) => new Text(lines.join("\n"), 0, 0), { placement: "aboveEditor" });
    // Keep the box live between events: tick the elapsed clock while jobs run and
    // clear a finished job once it falls out of its 15s window, even if nothing
    // else fires a render. Unref'd, so a lingering box never holds the host open.
    if (!widgetTimer) {
      widgetTimer = setInterval(() => renderWidget(), 1000);
      widgetTimer.unref?.();
    }
  }

  // ── run ────────────────────────────────────────────────────────────

  function snapshot(job: Execution): ToolResult {
    const tail = readTail(job.logPath, settings.tailBytes);
    return {
      content: [{ type: "text", text: `${header(job)}\n${sanitizeOutput(tail.text).replace(/\n+$/, "") || "(no output yet)"}` }],
      details: { status: job.status },
    };
  }

  /** The structured half of any result about a job: the whole log (bounded) plus status, for scripts. */
  function structured(job: Execution): BashStructured {
    return buildStructured(job, readFull(job.logPath, STRUCTURED_OUTPUT_MAX_BYTES));
  }

  function finished(job: Execution): ToolResult {
    return {
      content: [{ type: "text", text: formatResult(job, settings.tailBytes) }],
      details: { status: job.status, exitCode: job.exitCode, signal: job.signal, background: false },
      structuredContent: structured(job),
      isError: job.status !== "done",
    };
  }

  /** Push a finished job's result into the conversation through the live pi. */
  function deliver(job: Job): void {
    renderWidget();
    if (!settings.deliverResults) return;
    pi.sendMessage(
      {
        customType: DELIVERY_TYPE,
        content: deliveryMessage(job.id, formatResult(job, settings.tailBytes)),
        display: true,
        details: { id: job.id, status: job.status, exitCode: job.exitCode },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  /**
   * Jobs a shell_status wait is blocking on, by id. Seen on pi 1.0.4 with the
   * TUI captured: a foreground command auto-backgrounds at 30s, the model
   * waits on it with shell_status, the exit handler delivers the finish as a
   * follow-up in the same instant the wait returns it, and the model spends a
   * whole extra turn acknowledging a result it had just reported. While a
   * wait is active the finish is returned there and marked collected; the
   * delivery path stands down.
   */
  const waiters = new Map<string, number>();
  const awaited = (job: Job): boolean => (waiters.get(job.id) ?? 0) > 0;

  // A finished job's result must reach the model exactly once, and NOT while
  // the model may still collect it itself. The old code sent the follow-up the
  // instant the process exited, so a `shell_status {id}` that collected the
  // same job later in that turn got the result a second time (issue #2): the
  // message was already queued when the job ended, and marking it collected
  // afterwards was too late. So a finished job is held in `pending` and
  // delivered only at a turn boundary (agent_settled) — or right away while
  // idle, so a job finishing between turns still wakes the agent — and the
  // drain skips any job a `shell_status` read marked `delivered` meanwhile.
  // `waiters` still covers an ACTIVE wait, which returns and collects the
  // result itself and so must never also be sent.
  const pending = new Set<Job>();
  let turnActive = false;

  function enqueueDelivery(job: Job): void {
    if (job.delivered) return;
    pending.add(job);
    maybeDrainDeliveries();
  }

  /** Drain now only while idle; during a turn the model may still collect a job, so wait for agent_settled. */
  function maybeDrainDeliveries(): void {
    if (!turnActive) drainDeliveries();
  }

  function drainDeliveries(): void {
    for (const job of [...pending]) {
      // Collected (by a shell_status read) since it was queued — never send it.
      if (job.delivered) {
        pending.delete(job);
        continue;
      }
      // An active shell_status wait will return and collect this job itself.
      if (awaited(job)) continue;
      pending.delete(job);
      job.delivered = true;
      registry?.persist(job);
      deliver(job);
    }
  }

  /** Deliver a finished background job into the conversation, once. */
  function scheduleDelivery(job: Job, exit: Promise<unknown>): void {
    exit
      .then(() => {
        // Handed off to a newer instance: only flush the final status to disk
        // for it to read. Do not mark delivered, touch lastUiCtx, or send through
        // this stale pi (which would throw and, worse, having already flipped
        // delivered would stop the new instance from ever delivering).
        if (handedOff) {
          registry?.persist(job);
          return;
        }
        enqueueDelivery(job);
      })
      .catch(() => {
        // A /reload can make captured handles throw; delivery is a convenience,
        // shell_status still collects the result.
      });
  }

  async function runBash(
    params: { command: string; timeout?: number; background?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: ((r: ToolResult) => void) | undefined,
    ctx: UiContext,
  ): Promise<ToolResult> {
    lastUiCtx = ctx;
    if (!registry) throw new Error("shell-background not initialized");
    const owner = registry;
    const command = String(params.command ?? "").trim();
    if (!command) return { content: [{ type: "text", text: "Empty command." }], details: {}, isError: true };
    // Match Pi's timeout validation and do not start an already-cancelled call.
    if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout * 1000 > 2_147_483_647)) {
      throw new Error("Invalid timeout: must be positive, finite, and at most 2147483.647 seconds");
    }
    if (signal?.aborted) throw new Error("aborted");

    const runningBackground = () => owner.running().length;
    if (params.background && runningBackground() >= settings.maxBackground) {
      const n = runningBackground();
      return {
        content: [{ type: "text", text:
          `${n} background command${n === 1 ? " is" : "s are"} already running (maxBackground = ${settings.maxBackground}). ` +
          `shell_kill one you no longer need, wait for one with shell_status {id, wait}, or run this in the foreground without background:true.` }],
        details: { running: n, limit: settings.maxBackground },
        isError: true,
      };
    }

    const execution = owner.createExecution(command, ctx.cwd);
    let job: Job | undefined;
    let spawned;
    try {
      const { shell, args } = shellArgv();
      spawned = spawnToFile(shell, args, command, ctx.cwd, buildEnv(ctx, join(getAgentDir(), "bin")), execution.logPath);
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to start: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
    }
    execution.pid = spawned.pid;
    foreground.add(execution);

    const settle = spawned.exit.then(({ code, signal: sig }) => {
      foreground.delete(execution);
      if (execution.status === "running") {
        execution.status = execution.killedByUs || sig ? "killed" : code === 0 ? "done" : "failed";
      }
      execution.exitCode = code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1);
      execution.signal = sig;
      execution.endedAt = Date.now();
      if (job) {
        owner.persist(job);
        if (!handedOff) renderWidget();
      }
    });

    const kill = () => {
      if (execution.status !== "running") return;
      execution.killedByUs = true;
      killTree(execution.pid);
    };
    // One deadline for the entire execution, including explicit background jobs
    // and any later transition. Clear it on exit, not when the tool returns.
    let timedOut = false;
    const deadline = params.timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      kill();
    }, params.timeout * 1000);
    deadline?.unref();
    void settle.then(() => clearTimeout(deadline));

    const background = (auto: boolean): ToolResult => {
      job = owner.register(execution, auto);
      foreground.delete(execution);
      renderWidget(ctx);
      scheduleDelivery(job, settle);
      const r = backgroundedResult({
        id: job.id,
        command,
        elapsedMs: auto ? Date.now() - execution.startedAt : 0,
        auto,
        interactive: ctx.hasUI,
        collectWith: "shell_status",
      });
      return { content: [{ type: "text", text: r.text }], details: r.details, structuredContent: structured(job) };
    };
    if (params.background) return background(false);

    // No public job record while the call is still awaited. Cancellation and
    // shutdown only need the private process handle, not a persisted job id.
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Keep an awaited foreground call alive even though its child is unref'd.
    const tick = setInterval(() => onUpdate?.(snapshot(execution)), 1000);
    let autoTimer: NodeJS.Timeout | undefined;
    try {
      const autoMs = effectiveAutoMs(ctx.hasUI);
      const exit = settle.then(() => "exit");
      const outcome = autoMs > 0 ? await Promise.race([exit, new Promise<string>((resolve) => {
        autoTimer = setTimeout(() => resolve("auto"), autoMs);
      })]) : await exit;
      let keptForeground = false;
      if (outcome === "auto" && execution.status === "running" && !timedOut && !signal?.aborted && !handedOff) {
        if (runningBackground() < settings.maxBackground) return background(true);
        keptForeground = true;
      }
      await settle;
      const result = finished(execution);
      if (timedOut) result.content[0]!.text += `\n\n[killed: exceeded the ${params.timeout}s timeout]`;
      else if (signal?.aborted) result.content[0]!.text += "\n\n[killed: the turn was aborted]";
      else if (keptForeground) result.content[0]!.text += `\n\n[kept in the foreground: ${settings.maxBackground} background commands were already running]`;
      return result;
    } finally {
      clearTimeout(autoTimer);
      clearInterval(tick);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // ── tools & lifecycle ────────────────────────────────────────────────

  function registerBash(cwd: string, hasUI: boolean): void {
    const original = createBashToolDefinition(cwd) as unknown as AnyTool;
    const autoMs = effectiveAutoMs(hasUI);
    // The guideline must match what runBash will actually do for this session:
    // auto-background only happens interactively with a positive threshold.
    const backgroundLine = !hasUI
      ? `This is a headless run: commands run to completion unless you pass background:true, which returns an id immediately. Nothing is delivered after your turn, so collect a backgrounded command within the same turn with shell_status {id, wait: N} (it blocks until the command finishes or the wait elapses).`
      : autoMs === 0
        ? `Commands run to completion; pass background:true for anything long-running (a server, build, or watcher) to get an id back immediately, then collect or check it with shell_status.`
        : `A command still running after ${Math.round(autoMs / 1000)}s is moved to the background and its result is delivered when it finishes; pass background:true to background a long task (a server, build, or watcher) immediately. Collect or check with shell_status.`;
    const guidelines = [
      ...(Array.isArray((original as { promptGuidelines?: unknown }).promptGuidelines)
        ? ((original as { promptGuidelines?: string[] }).promptGuidelines as string[])
        : []),
      backgroundLine,
    ];
    pi.registerTool({
      ...original,
      // pi's description promises its own truncation ("last 2000 lines or
      // 50KB … saved to a temp file"); this tool returns the last
      // `tailBytes` of a log it keeps for the whole command, and says where.
      description:
        `Execute a shell command in the current working directory. Returns stdout and stderr, interleaved as they ` +
        `arrived; a long output is shown as its last ${Math.round(settings.tailBytes / 1024)}KB with the path of the ` +
        `full log. Optionally provide a timeout in seconds, or background:true to get an id back immediately.`,
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in seconds; a command that hits it is killed with its whole process tree." }),
        ),
        background: Type.Optional(
          Type.Boolean({ description: "Launch detached and return an id immediately instead of waiting for the command to finish." }),
        ),
      }),
      promptGuidelines: guidelines,
      // pi 0.99: scripts and ctx.executeTool() callers receive structuredContent
      // instead of the text. Same fields as pi's bash, plus status/job_id;
      // exit_code is absent while the command still runs in the background.
      outputSchema: bashOutputSchema,
      // Let pi render the result with its default text renderer; keep the call
      // renderer (it only needs the command) if the original had one.
      renderResult: undefined,
      execute: async (_id: string, params: never, sig: never, upd: never, ctx: never) =>
        runBash(params, sig as AbortSignal | undefined, upd as never, ctx as UiContext),
    } as never);
  }

  pi.registerTool({
    name: "shell_status",
    label: "Background shell status",
    promptSnippet: "Check or collect a backgrounded command",
    description:
      "Report a background command by id (its status and output tail), or list all this session's background commands when given no id. Pass wait (seconds, 0–300) to block until a still-running command finishes or the wait elapses — useful in a headless run where nothing is delivered after the turn. Finished results survive until the session ends.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job id, e.g. bg-1 or fg-2. Omit to list all." })),
      wait: Type.Optional(
        Type.Number({ description: "Seconds to block while the command is still running (clamped 0–300). Default 0 — return immediately." }),
      ),
    }),
    async execute(_id: string, params: { id?: string; wait?: number }, sig?: AbortSignal): Promise<ToolResult> {
      if (!registry) return { content: [{ type: "text", text: "shell-background not initialized" }], details: {}, isError: true };
      const id = params.id?.trim();
      if (!id) return { content: [{ type: "text", text: formatList(registry.all()) }], details: {} };
      const job = registry.get(id);
      if (!job) {
        const known = registry.all().map((j) => j.id).join(", ") || "(none)";
        return { content: [{ type: "text", text: `No job "${id}". Known: ${known}` }], details: {}, isError: true };
      }
      // Optionally block until it finishes. A bounded poll of job.status (not an
      // in-memory promise) so it works for adopted jobs too — those have no
      // settle closure; their status is flipped by the adoption poller / a
      // sibling instance persisting the sidecar. Cheap: status mutates in place.
      const waitSec = Number.isFinite(params.wait) ? Math.min(300, Math.max(0, Math.floor(params.wait as number))) : 0;
      if (waitSec > 0 && job.status === "running") {
        const deadline = Date.now() + waitSec * 1000;
        waiters.set(job.id, (waiters.get(job.id) ?? 0) + 1);
        try {
          while (job.status === "running" && Date.now() < deadline && !sig?.aborted) await sleep(250);
        } finally {
          waiters.set(job.id, Math.max(0, (waiters.get(job.id) ?? 1) - 1));
        }
      }
      if (sig?.aborted) {
        // The model never sees an aborted tool result. If the job finished
        // while the wait held delivery back, hand it to the turn-boundary drain
        // (it was not collected here) rather than dropping it.
        if (isFinished(job) && !job.delivered) enqueueDelivery(job);
        return { content: [{ type: "text", text: `shell_status ${job.id}: wait aborted` }], details: { id: job.id }, isError: true };
      }
      // Reading a finished job marks it collected so the turn-boundary drain
      // never also sends it (issue #2). A still-running poll must never do this:
      // setting delivered here would permanently cancel the promised delivery.
      if (isFinished(job)) {
        job.delivered = true;
        pending.delete(job);
        registry.persist(job);
      }
      return {
        content: [{ type: "text", text: formatResult(job, settings.tailBytes) }],
        details: { id: job.id, status: job.status, exitCode: job.exitCode },
        structuredContent: structured(job),
      };
    },
  });

  pi.registerTool({
    name: "shell_kill",
    label: "Kill background shell",
    promptSnippet: "Stop a backgrounded command",
    description: "Terminate a background command and its whole process tree by id.",
    parameters: Type.Object({ id: Type.String({ description: "Job id, e.g. bg-1 or fg-2" }) }),
    async execute(_id: string, params: { id: string }): Promise<ToolResult> {
      if (!registry) return { content: [{ type: "text", text: "shell-background not initialized" }], details: {}, isError: true };
      const job = registry.get(params.id?.trim());
      if (!job) return { content: [{ type: "text", text: `No job "${params.id}".` }], details: {}, isError: true };
      if (job.status !== "running") {
        return { content: [{ type: "text", text: `${job.id} already ${job.status}.` }], details: { id: job.id, status: job.status } };
      }
      job.killedByUs = true;
      killTree(job.pid);
      return { content: [{ type: "text", text: `Killing ${job.id} (pid ${job.pid ?? "?"}) and its process tree.` }], details: { id: job.id } };
    },
  });

  pi.registerCommand("shell-bg", {
    description: "Background shell jobs: /shell-bg [kill <id>]",
    handler: async (args, ctx: UiContext) => {
      if (!ctx.hasUI || !registry) return;
      const [verb, id] = (args ?? "").trim().split(/\s+/);
      if (verb === "kill" && id) {
        const job = registry.get(id);
        if (job && job.status === "running") {
          job.killedByUs = true;
          killTree(job.pid);
          ctx.ui.notify(`Killing ${job.id}.`, "info");
        } else {
          ctx.ui.notify(job ? `${id} already ${job.status}.` : `No job "${id}".`, "warning");
        }
        return;
      }
      ctx.ui.notify(formatList(registry.all()), "info");
    },
  });

  /**
   * After load(), take over every job still running from a previous instance of
   * this same host — a /reload survivor (a foreign/dead host's jobs were settled
   * to orphaned by load() and are not here). Their settle/delivery closures went
   * with the old instance, so poll the sidecar the old closure keeps flushing:
   * when it flips to a finished status (or the pid is simply gone) copy that in,
   * persist, re-render, and deliver through the live pi if it was not delivered.
   * One unref'd interval for them all; it stops once none are still running.
   */
  function adoptRunning(ctx: UiContext): void {
    if (!registry) return;
    const adopted = registry.running();
    if (adopted.length === 0) return;
    lastUiCtx = ctx;
    const timer = setInterval(() => {
      if (!registry) {
        clearInterval(timer);
        return;
      }
      let anyRunning = false;
      for (const job of adopted) {
        if (job.status === "running") {
          const disk = registry.readSidecar(job.id);
          if (disk && disk.status !== "running") {
            job.status = disk.status;
            job.exitCode = disk.exitCode;
            job.signal = disk.signal;
            job.endedAt = disk.endedAt ?? Date.now();
          } else if (!isAlive(job.pid)) {
            // The old instance never flushed a final status (it crashed) but the
            // process is gone: settle it here so it is not shown running forever.
            job.status = job.killedByUs ? "killed" : "done";
            job.endedAt = job.endedAt ?? Date.now();
          }
        }
        if (job.status === "running") anyRunning = true;
        else if (job.background) enqueueDelivery(job);
      }
      renderWidget(ctx);
      if (!anyRunning) clearInterval(timer);
    }, 1000);
    timer.unref?.();
  }

  // Turn boundaries drive delivery: a finished job is pushed only when the
  // current turn ends, so a job the model collects during the turn is never
  // also delivered as a follow-up (issue #2).
  pi.on("agent_start", async (_event, ctx) => {
    turnActive = true;
    lastUiCtx = ctx;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    turnActive = false;
    lastUiCtx = ctx;
    drainDeliveries();
  });

  pi.on("session_start", async (_event, ctx) => {
    const warnings = loadSettings(ctx.cwd);
    const key = sessionKey(ctx);
    sweepOldDirs(key);
    registry = new JobRegistry(join(ROOT, key));
    registry.load();
    registerBash(ctx.cwd, ctx.hasUI);
    renderWidget(ctx);
    adoptRunning(ctx);
    if (warnings.length > 0 && ctx.hasUI) ctx.ui.notify(`shell-background settings: ${warnings.join("; ")}`, "warning");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Foreground calls have no public records to hand off. Cancel any still
    // active calls; only registered background jobs survive a reload.
    for (const execution of foreground) {
      execution.killedByUs = true;
      killTree(execution.pid);
      execution.status = "killed";
      execution.endedAt = Date.now();
    }
    foreground.clear();
    if (event.reason === "reload") {
      // Same host process, a fresh instance is coming right after: hand the jobs
      // off rather than kill them. This (old) instance's closures go quiet
      // (handedOff) and the new instance adopts the still-running ones from the
      // sidecars — that is what registry.ts and the README promise across /reload.
      handedOff = true;
      stopWidgetTimer();
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    // quit / new / resume / fork: this session is ending for good. Kill each
    // running tree and record it killed synchronously so a resumed/next reader
    // never sees a dead job as running, then best-effort drop this session's dir.
    if (registry) {
      for (const job of registry.running()) {
        job.killedByUs = true;
        killTree(job.pid);
        job.status = "killed";
        job.endedAt = job.endedAt ?? Date.now();
        registry.persist(job);
      }
      try {
        rmSync(registry.dir(), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup: the 7-day age sweep on a later session_start
        // collects whatever is left behind.
      }
    }
    stopWidgetTimer();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  });
}
