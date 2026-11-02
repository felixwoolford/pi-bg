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
 *   - foreground commands are awaited until completion, unless the user sends
 *     /bg [prose] to transfer one to the background and steer the agent;
 *   - `background: true` launches detached from the start and returns the id
 *     immediately.
 *
 * `shell_status` polls or collects a job (and lists them all); `shell_kill`
 * terminates one and its whole process tree. Delivery only works in a session
 * that outlives the run. Under headless `pi -p`, collect background results with
 * shell_status inside the turn. Time-based backgrounding is disabled.
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
import { Type } from "typebox";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readdirSync, statSync, rmSync } from "node:fs";

import { JobRegistry, isAlive } from "./src/registry.ts";
import { spawnToFile, killTree } from "./src/spawn.ts";
import { readTail } from "./src/tail.ts";
import { buildEnv } from "./src/env.ts";
import { DEFAULT_SETTINGS, loadSettings, type ShellBgSettings } from "./src/config.ts";
import { backgroundedResult, STEERING_TYPE, formatResult, formatList, header } from "./src/format.ts";
import { createDeliveryController } from "./src/delivery.ts";
import { sanitizeOutput } from "./src/sanitize.ts";
import { readFull } from "./src/tail.ts";
import { STRUCTURED_OUTPUT_MAX_BYTES, bashOutputSchema, buildStructured, type BashStructured } from "./src/structured.ts";
import { createWidgetController } from "./src/widget.ts";
import { isDeliveryMode, isFinished } from "./src/types.ts";
import type { DeliveryMode, Execution, Job } from "./src/types.ts";

type UiContext = ExtensionContext;
type AnyTool = { name: string; execute: (...a: never[]) => unknown; [k: string]: unknown };
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  /** pi 0.99: what codemode scripts and ctx.executeTool() callers receive instead of the text. */
  structuredContent?: BashStructured;
  isError?: boolean;
};

export default function shellBackground(pi: ExtensionAPI) {
  let settings: ShellBgSettings = DEFAULT_SETTINGS;
  let registry: JobRegistry | null = null;
  // Only running foreground executions need private shutdown bookkeeping.
  const foreground = new Set<Execution>();
  // Only awaited, transferable calls are exposed to /bg; no public job IDs yet.
  const backgroundRequests = new Map<Execution, (prose: string) => boolean>();
  let lastUiCtx: UiContext | null = null;
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

  /** Shell + args, reusing pi's resolution; command rides in argv (not stdin). */
  function shellArgv(): { shell: string; args: string[] } {
    const cfg = getShellConfig();
    return { shell: cfg.shell, args: [...cfg.args] };
  }

  const widget = createWidgetController({
    getJobs: () => registry?.all(),
    getContext: () => lastUiCtx,
    setContext: (ctx) => { lastUiCtx = ctx; },
  });

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

  const delivery = createDeliveryController(pi, {
    getSettings: () => settings,
    isIdle: () => lastUiCtx?.isIdle() ?? false,
    isHandedOff: () => handedOff,
    persist: (job) => registry?.persist(job),
    onDelivered: widget.render,
  });

  async function runBash(
    params: { command: string; timeout?: number; background?: boolean; delivery?: DeliveryMode },
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
    if (params.delivery !== undefined && !isDeliveryMode(params.delivery)) {
      throw new Error("Invalid delivery: use notify, steer, or followUp");
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

    const execution = owner.createExecution(command, ctx.cwd, params.delivery);
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
      backgroundRequests.delete(execution);
      if (execution.status === "running") {
        execution.status = execution.killedByUs || sig ? "killed" : code === 0 ? "done" : "failed";
      }
      execution.exitCode = code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1);
      execution.signal = sig;
      execution.endedAt = Date.now();
      if (job) {
        owner.persist(job);
        if (!handedOff) widget.render();
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

    const background = (fromForeground: boolean): ToolResult => {
      job = owner.register(execution, fromForeground);
      foreground.delete(execution);
      backgroundRequests.delete(execution);
      widget.render(ctx);
      delivery.schedule(job, settle);
      const r = backgroundedResult({
        id: job.id,
        command,
        elapsedMs: fromForeground ? Date.now() - execution.startedAt : 0,
        fromForeground,
        deliverResults: settings.deliverResults,
        delivery: job.delivery,
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
    const moved = new Promise<ToolResult>((resolve) => {
      backgroundRequests.set(execution, (prose) => {
        if (!backgroundRequests.has(execution) || execution.status !== "running" ||
            execution.killedByUs || timedOut || signal?.aborted || handedOff ||
            runningBackground() >= settings.maxBackground) return false;
        // Detach cancellation synchronously, before another steering/abort can
        // affect the transferred process. Its original timeout remains active.
        signal?.removeEventListener("abort", onAbort);
        const result = background(true);
        const message = [prose.trim(), result.content[0]!.text].filter(Boolean).join("\n\n");
        try {
          // Custom steering queues synchronously, before releasing the tool.
          // This avoids a new model request racing ahead of the user's prose.
          pi.sendMessage({
            customType: STEERING_TYPE,
            content: message,
            display: true,
            details: result.details,
          }, { deliverAs: "steer", triggerTurn: true });
          // The steering message carries the template; the tool result carries
          // the current output, not a duplicate of that message.
          resolve({ ...result, content: snapshot(execution).content });
        } catch {
          // Even if message injection fails, return the user's instructions and
          // background handle through the already-awaited tool rather than hang.
          resolve({ ...result, content: [{ type: "text", text: message }] });
        }
        return true;
      });
    });
    try {
      const transferred = await Promise.race([moved, settle.then(() => undefined)]);
      if (transferred) return transferred;
      const result = finished(execution);
      if (timedOut) result.content[0]!.text += `\n\n[killed: exceeded the ${params.timeout}s timeout]`;
      else if (signal?.aborted) result.content[0]!.text += "\n\n[killed: the turn was aborted]";
      return result;
    } finally {
      backgroundRequests.delete(execution);
      clearInterval(tick);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // ── tools & lifecycle ────────────────────────────────────────────────

  function registerBash(cwd: string, hasUI: boolean): void {
    const original = createBashToolDefinition(cwd) as unknown as AnyTool;
    const backgroundLine =
      `Foreground commands wait for completion; there is no automatic backgrounding. ` +
      `Prefer background:true for servers/watchers and tasks whose result is not needed before your next action. ` +
      `Await prerequisite results before depending on them, whether returned directly, delivered automatically, or collected with shell_status {id, wait: N}. ` +
      (!hasUI
        ? `This is a headless run: nothing is delivered after your turn, so collect background results within this same turn.`
        : `Choose how background completion reaches you: by default, one short notice during your work, then full output when you finish unless collected first; choose steer for full output sooner, or followUp for full output later without a notice. The user can transfer a running foreground call with /bg, optionally adding steering instructions. A running job is not a successful result.`);
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
        `full log. Foreground calls wait for completion; they never background automatically. ` +
        `Prefer background:true for servers, watchers, and work independent of your next action; it returns a job id immediately. ` +
        `Await prerequisite results before depending on them. The optional delivery setting controls when completion is reported. Optionally provide a timeout in seconds.`,
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in seconds; a command that hits it is killed with its whole process tree." }),
        ),
        background: Type.Optional(
          Type.Boolean({ description: "Return a job id immediately. Use for servers/watchers or work independent of your next action. Await completion, delivered automatically or collected with shell_status, before relying on its result." }),
        ),
        delivery: Type.Optional(Type.Union([
          Type.Literal("notify", { description: "Tell me once that the result is ready while I work; send full output when I finish unless I collect it first. Default." }),
          Type.Literal("steer", { description: "Give me the full result at the next safe opportunity, even while I am working." }),
          Type.Literal("followUp", { description: "Let me finish my current work, then give me the full result, without an earlier notice." }),
        ], { description: "How to report completion if this command is backgrounded, including later via /bg. Default: notify. All choices deliver the full result immediately if I am idle. Automatic delivery must be enabled.", default: "notify" })),
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
        const releaseDelivery = delivery.hold(job);
        try {
          while (job.status === "running" && Date.now() < deadline && !sig?.aborted) await sleep(250);
        } finally {
          releaseDelivery();
        }
      }
      if (sig?.aborted) {
        // The model never sees an aborted tool result. If the job finished
        // while the wait held delivery back, hand it to the turn-boundary drain
        // (it was not collected here) rather than dropping it.
        if (isFinished(job)) delivery.enqueue(job);
        return { content: [{ type: "text", text: `shell_status ${job.id}: wait aborted` }], details: { id: job.id }, isError: true };
      }
      delivery.collect(job);
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

  pi.registerCommand("bg", {
    description: "Background a running foreground shell command and steer the agent: /bg [message]",
    handler: async (args, ctx) => {
      const tasks = [...backgroundRequests.entries()].filter(([execution]) =>
        execution.status === "running" && !execution.killedByUs);
      if (tasks.length === 0) {
        ctx.ui.notify("No foreground shell command to background; no steering message was sent.", "warning");
        return;
      }
      let task = tasks[0]!;
      if (tasks.length > 1) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Several foreground shell commands are running; an interactive task picker is required.", "warning");
          return;
        }
        const labels = tasks.map(([execution], i) =>
          `${i + 1}. ${sanitizeOutput(execution.command).replace(/\s+/g, " ").trim().slice(0, 120)}`);
        const selected = await ctx.ui.select("Background which foreground command?", labels);
        if (selected === undefined) return;
        const index = labels.indexOf(selected);
        if (index < 0) return;
        task = tasks[index]!;
      }
      // A picker yields: recheck capacity and liveness, never transfer a
      // different task if the selected one finished while the dialog was open.
      if (!registry || registry.running().length >= settings.maxBackground) {
        ctx.ui.notify(`Background job limit reached (maxBackground = ${settings.maxBackground}); command left in the foreground. No steering message was sent.`, "warning");
        return;
      }
      if (!task[1](args ?? "")) {
        ctx.ui.notify("That foreground command finished or was cancelled; no steering message was sent.", "warning");
      }
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
      if (handedOff || !registry) {
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
        else if (job.background) delivery.enqueue(job);
      }
      widget.render(ctx);
      if (!anyRunning) clearInterval(timer);
    }, 1000);
    timer.unref?.();
  }

  // Only interrupt ongoing work at a safe tool-batch boundary, with either
  // explicitly requested full output or a one-time availability notice.
  pi.on("turn_end", async (_event, ctx) => {
    lastUiCtx = ctx;
    delivery.drain(ctx.isIdle() ? "idle" : "turn");
  });

  // The agent would otherwise stop: append only results still uncollected
  // now and request a follow-up response. Boundary entries avoid irrevocably
  // queueing output earlier that a later status read might collect first.
  // This hook tracks no activity state; ctx.isIdle() remains authoritative.
  pi.on("agent_before_settle", async (event, ctx) => {
    lastUiCtx = ctx;
    const entries = delivery.drain("followUp");
    if (entries.length > 0) return { entries: [...event.entries, ...entries], continue: true };
  });

  pi.on("session_start", async (_event, ctx) => {
    lastUiCtx = ctx;
    const loaded = loadSettings(ctx.cwd, getAgentDir());
    settings = loaded.settings;
    const key = sessionKey(ctx);
    sweepOldDirs(key);
    registry = new JobRegistry(join(ROOT, key));
    registry.load();
    registerBash(ctx.cwd, ctx.hasUI);
    widget.render(ctx);
    adoptRunning(ctx);
    // Completed-but-uncollected results also survive reloads, including jobs
    // whose one-time notice was already sent by the previous instance.
    for (const job of registry.all()) {
      if (isFinished(job) && job.status !== "orphaned") delivery.enqueue(job);
    }
    if (loaded.warnings.length > 0 && ctx.hasUI) ctx.ui.notify(`shell-background settings: ${loaded.warnings.join("; ")}`, "warning");
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
    backgroundRequests.clear();
    if (event.reason === "reload") {
      // Same host process, a fresh instance is coming right after: hand the jobs
      // off rather than kill them. This (old) instance's closures go quiet
      // (handedOff) and the new instance adopts the still-running ones from the
      // sidecars — that is what registry.ts and the README promise across /reload.
      handedOff = true;
      widget.stop(ctx);
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
    widget.stop(ctx);
  });
}
