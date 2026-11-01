/**
 * Core execution, backgrounding, delivery and session-lifecycle tests driven
 * through a minimal mock of the pi ExtensionAPI. Commands run in real shells;
 * every spawned command is torn down before the test returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import shellBackground from "../index.ts";
import { DELIVERY_TYPE, STEERING_TYPE } from "../src/format.ts";

// Isolate from the developer's own settings: the extension reads
// <agentDir>/shell-background.json, which would otherwise leak into every test
// (e.g. a global deliverResults:false silences the delivery assertions).
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sbg-agentdir-"));

type AnyTool = { name: string; execute: (...a: any[]) => Promise<any> };
type AnyHandler = (event: any, ctx: any) => any;

interface Harness {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  handlers: Map<string, AnyHandler>;
  commands: Map<string, { handler: AnyHandler }>;
  sent: any[];
  sendOptions: any[];
}

function harness(): Harness {
  const tools = new Map<string, AnyTool>();
  const handlers = new Map<string, AnyHandler>();
  const sent: any[] = [];
  const sendOptions: any[] = [];
  const commands = new Map<string, { handler: AnyHandler }>();
  const pi = {
    registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: AnyHandler }) => commands.set(name, command),
    on: (event: string, handler: AnyHandler) => handlers.set(event, handler),
    sendMessage: (msg: unknown, options: unknown) => { sent.push(msg); sendOptions.push(options); },
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers, commands, sent, sendOptions };
}

function makeCtx(cwd: string, hasUI: boolean, sessionId?: string): ExtensionContext {
  return {
    cwd,
    hasUI,
    isIdle: () => true,
    // The registry keys off the session id (stable across /reload); the unit
    // tests supply one so a session survives a simulated reload the way it does
    // in a real host, where PI_SESSION_ID is never on the host's own env.
    sessionManager: sessionId
      ? { getSessionId: () => sessionId, getSessionFile: () => undefined }
      : undefined,
    model: undefined,
    ui: {
      setWidget: () => {},
      notify: () => {},
      select: async () => undefined,
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function rmDir(p: string): Promise<void> {
  rmSync(p, { recursive: true, force: true });
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met in time");
    await sleep(25);
  }
}

/** A unique, filesystem-safe session id so each test gets its own registry dir. */
function uniqueSession(): { id: string; regDir: string } {
  const id = `sbgtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, regDir: join(tmpdir(), "shell-bg", id) };
}

/**
 * Kill every still-running job and wait until nothing runs, so no child process
 * outlives the test and blocks the runner from exiting.
 */
async function teardown(h: Harness, ctx: ExtensionContext): Promise<void> {
  const shutdown = h.handlers.get("session_shutdown");
  if (shutdown) await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  const status = h.tools.get("shell_status");
  if (!status) return;
  await waitFor(async () => {
    const list = await status.execute("teardown", {});
    return /^(?:0 running|No background commands)/.test(String(list.content[0].text));
  }, 8000).catch(() => {});
}

test("foreground commands return success, failure, timeout and abort without duplicate delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-fg-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ autoBackgroundMs: 0 }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;

    const done = await bash.execute("success", { command: "echo ok" }, undefined, undefined, ctx);
    assert.equal(done.details.id, undefined);
    assert.equal(done.structuredContent.job_id, undefined);
    assert.equal(done.details.status, "done");
    assert.equal(done.structuredContent.exit_code, 0);
    assert.match(done.structuredContent.output, /ok/);
    const failed = await bash.execute("failure", { command: "exit 1" }, undefined, undefined, ctx);
    assert.equal(failed.details.status, "failed");
    assert.equal(failed.structuredContent.exit_code, 1);
    assert.equal(failed.isError, true);
    const timedOut = await bash.execute("timeout", { command: "sleep 10", timeout: 0.1 }, undefined, undefined, ctx);
    assert.equal(timedOut.details.status, "killed");
    const controller = new AbortController();
    const aborted = bash.execute("abort", { command: "sleep 10" }, controller.signal, undefined, ctx);
    controller.abort();
    assert.equal((await aborted).details.status, "killed");
    assert.equal(h.sent.length, 0, "foreground results are not delivered again");
    const list = await h.tools.get("shell_status")!.execute("list", {});
    assert.match(list.content[0].text, /No background commands/);
    assert.deepEqual(readdirSync(regDir).filter((f) => f.endsWith(".json")), [], "no foreground sidecars");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("jobs register only on backgrounding, with independent counters that survive reload", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-bg-"));
  const { id: sid, regDir } = uniqueSession();
  const a = harness();
  const b = harness();
  const ctxA = makeCtx(cwd, true, sid);
  const ctxB = makeCtx(cwd, true, sid);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ autoBackgroundMs: 400 })); // ignored legacy config
    shellBackground(a.pi);
    await a.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    const bash = a.tools.get("bash")!;
    const quick = await bash.execute("quick", { command: "echo ok" }, undefined, undefined, ctxA);
    assert.equal(quick.details.id, undefined);
    const explicit = await bash.execute("explicit", { command: "sleep 10", background: true }, undefined, undefined, ctxA);
    assert.equal(explicit.details.id, "bg-1");
    assert.equal(explicit.details.fromForeground, false);

    const moving = bash.execute("transfer", { command: "echo before; touch ready; sleep 10" }, undefined, undefined, ctxA);
    await waitFor(() => existsSync(join(cwd, "ready")), 2000);
    const before = await a.tools.get("shell_status")!.execute("before", {});
    assert.match(before.content[0].text, /1 running, 1 total/);
    assert.deepEqual(readdirSync(regDir).filter((f) => f.endsWith(".json")), ["bg-1.json"]);
    await a.commands.get("bg")!.handler("", ctxA);
    const moved = await moving;
    assert.equal(moved.details.id, "fg-1");
    assert.equal(moved.details.background, true);
    assert.equal(moved.structuredContent.job_id, "fg-1");
    assert.equal(moved.details.fromForeground, true);
    assert.equal(moved.details.auto, undefined);
    assert.equal(a.sent[0].customType, STEERING_TYPE);
    assert.equal(a.sent[0].details.id, "fg-1");
    assert.match(a.sent[0].content, /still running, not completed/);
    assert.deepEqual(a.sendOptions[0], { deliverAs: "steer", triggerTurn: true });
    assert.match(moved.structuredContent.output, /before/, "output from before the transition survives");
    const sidecar = JSON.parse(readFileSync(join(regDir, "fg-1.json"), "utf8"));
    assert.equal(sidecar.background, true);
    assert.equal(sidecar.fromForeground, true);

    await a.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctxA);
    shellBackground(b.pi);
    await b.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctxB);
    const list = await b.tools.get("shell_status")!.execute("list", {});
    assert.match(list.content[0].text, /2 running, 2 total/);
    assert.match(list.content[0].text, /bg-1/);
    assert.match(list.content[0].text, /fg-1/);
    const next = await b.tools.get("bash")!.execute("next", { command: "sleep 10", background: true }, undefined, undefined, ctxB);
    assert.equal(next.details.id, "bg-2");
    const nextMoving = b.tools.get("bash")!.execute("next-transfer", { command: "sleep 10" }, undefined, undefined, ctxB);
    await b.commands.get("bg")!.handler("", ctxB);
    assert.equal((await nextMoving).details.id, "fg-2");
    const killed = await b.tools.get("shell_kill")!.execute("kill", { id: "fg-1" });
    assert.equal(killed.details.id, "fg-1");
    await waitFor(async () => (await b.tools.get("shell_status")!.execute("status", { id: "fg-1" })).details.status === "killed", 6000);
  } finally {
    await teardown(a, ctxA);
    await teardown(b, ctxB);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("foreground executions stay private, do not consume the background cap, and are killed on shutdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-private-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  let running: Promise<any> | undefined;
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ maxBackground: 1 }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const bash = h.tools.get("bash")!;
    running = bash.execute("foreground", { command: "echo ready > ready; sleep 10" }, undefined, undefined, ctx);
    await waitFor(() => existsSync(join(cwd, "ready")), 2000);
    const list = await h.tools.get("shell_status")!.execute("list", {});
    assert.match(list.content[0].text, /No background commands/);
    assert.deepEqual(readdirSync(regDir).filter((f) => f.endsWith(".json")), []);
    const background = await bash.execute("background", { command: "sleep 10", background: true }, undefined, undefined, ctx);
    assert.equal(background.details.id, "bg-1", "foreground does not consume the background cap");
    await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    const stopped = await running;
    assert.equal(stopped.details.status, "killed");
    assert.equal(stopped.details.id, undefined);
  } finally {
    await teardown(h, ctx);
    await running;
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("already-aborted calls and invalid timeouts do not start a command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-cancelled-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const bash = h.tools.get("bash")!;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(bash.execute("aborted", { command: "touch unwanted" }, controller.signal, undefined, ctx), /aborted/);
    for (const timeout of [0, -1, NaN, Infinity, 2147484]) {
      await assert.rejects(bash.execute("invalid", { command: "touch unwanted", timeout }, undefined, undefined, ctx), /Invalid timeout/);
    }
    assert.equal(existsSync(join(cwd, "unwanted")), false);
    assert.deepEqual(readdirSync(join(regDir, "logs")), [], "no process or log was started");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("explicit background jobs retain their timeout but detach from the turn's abort signal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-explicit-timeout-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const controller = new AbortController();
    const started = await h.tools.get("bash")!.execute("background", { command: "sleep 10", background: true, timeout: 0.5 }, controller.signal, undefined, ctx);
    controller.abort();
    const status = h.tools.get("shell_status")!;
    assert.equal((await status.execute("running", { id: started.details.id })).details.status, "running");
    await waitFor(async () => (await status.execute("finished", { id: started.details.id })).details.status === "killed", 3000);
    assert.equal((await status.execute("code", { id: started.details.id })).structuredContent.exit_code, 137);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("polling a running job does not cancel its auto-delivery (bug #1)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext1-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    // Launch a background command that takes ~2s to finish.
    const started = await bash.execute("t1", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;
    assert.ok(jobId, "the launch returned a job id");

    // Poll it while it is still running — this must NOT mark it delivered.
    const polled = await shellStatus.execute("t2", { id: jobId });
    assert.equal(polled.details.status, "running", "job is still running when polled");
    assert.equal(h.sent.length, 0, "nothing delivered while still running");

    // Delivery must still fire when it finishes, because the poll did not cancel
    // it. (Before the fix, the poll set delivered=true and this never arrives, so
    // this waitFor times out and the test fails.)
    await waitFor(() => h.sent.length > 0, 6000);
    assert.equal(h.sent.length, 1, "the finished job was auto-delivered exactly once");
    assert.equal(h.sent[0].customType, DELIVERY_TYPE);
    assert.equal(h.sent[0].details.id, jobId);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("deliverResults: false finishes the job without pushing a message into the conversation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext-nodeliver-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ deliverResults: false }));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    const started = await bash.execute("t1", { command: "echo done", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // The job still finishes and shell_status still collects it...
    await waitFor(async () => (await shellStatus.execute("t2", { id: jobId })).details.status === "done", 6000);
    // ...but nothing was pushed into the conversation.
    await sleep(300);
    assert.equal(h.sent.length, 0, "no delivery message when deliverResults is false");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("maxBackground: an explicit background request over the cap is refused, not the command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-cap1-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ maxBackground: 1 }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;

    const first = await bash.execute("t1", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    assert.ok(first.details.id, "the first background job starts");

    const second = await bash.execute("t2", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    assert.equal(second.isError, true, "the second background request is refused");
    assert.match(String(second.content[0].text), /maxBackground = 1/);
    assert.equal(second.details.limit, 1);

    // The same command still runs in the foreground: the cap never refuses execution.
    const fg = await bash.execute("t3", { command: "echo still-runs" }, undefined, undefined, ctx);
    assert.notEqual(fg.isError, true);
    assert.match(String(fg.content[0].text), /still-runs/);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("maxBackground: a user transfer over the cap leaves the foreground call awaited", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-cap2-"));
  const { id: sid, regDir } = uniqueSession();
  const prevMs = process.env.SHELL_BG_MS;
  process.env.SHELL_BG_MS = "200";
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ maxBackground: 1 }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;

    const parked = await bash.execute("t1", { command: "sleep 3", background: true }, undefined, undefined, ctx);
    assert.ok(parked.details.id);

    let returned = false;
    const running = bash.execute("t2", { command: "sleep 1" }, undefined, undefined, ctx).then((res) => { returned = true; return res; });
    const notices: string[] = [];
    ctx.ui.notify = (message) => { notices.push(message); };
    await h.commands.get("bg")!.handler("do something else", ctx);
    assert.equal(returned, false);
    assert.equal(h.sent.length, 0, "a refused transfer must not send the prose or template");
    assert.ok(notices.some((message) => message.includes("maxBackground = 1")));
    const res = await running;
    assert.equal(res.details.background, false, "not backgrounded");
    assert.equal(res.details.status, "done");
    assert.equal(res.details.id, undefined);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
    if (prevMs === undefined) delete process.env.SHELL_BG_MS;
    else process.env.SHELL_BG_MS = prevMs;
  }
});

test("a user-transferred command detaches from abort but retains its original timeout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext3-"));
  const { id: sid, regDir } = uniqueSession();
  const prevMs = process.env.SHELL_BG_MS;
  // A legacy override must not control the user-requested transition.
  process.env.SHELL_BG_MS = "200";
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    const controller = new AbortController();
    const running = bash.execute("t1", { command: "sleep 3", timeout: 1 }, controller.signal, undefined, ctx);
    await h.commands.get("bg")!.handler("", ctx);
    // Abort before even awaiting the returned tool result to catch a delayed
    // listener detachment. /bg must not cancel the process.
    controller.abort();
    const res = await running;
    assert.equal(res.details.background, true, "the command was moved to the background");
    const jobId = res.details.id as string;
    assert.equal((await shellStatus.execute("early", { id: jobId })).details.status, "running");

    // The original deadline must still fire after the transfer.
    await waitFor(async () => (await shellStatus.execute("p", { id: jobId })).details.status !== "running", 6000);
    const final = await shellStatus.execute("f", { id: jobId });
    assert.equal(final.details.status, "killed", "the surviving timeout killed the backgrounded job");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
    if (prevMs === undefined) delete process.env.SHELL_BG_MS;
    else process.env.SHELL_BG_MS = prevMs;
  }
});

test("a /reload hands jobs to the new instance, which delivers exactly once (finding f071/f078)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-reload-"));
  const { id: sid, regDir } = uniqueSession();
  const a = harness();
  const b = harness();
  const ctxA = makeCtx(cwd, false, sid);
  const ctxB = makeCtx(cwd, false, sid);
  try {
    // Instance A starts and launches a background command that runs a few seconds.
    shellBackground(a.pi);
    await a.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    const started = await a.tools
      .get("bash")!
      .execute("t1", { command: "sleep 3", background: true }, undefined, undefined, ctxA);
    const jobId = started.details.id as string;
    assert.ok(jobId);

    // /reload: shut A down with reason "reload" (this must NOT kill the job) then
    // stand up a fresh instance B over the same registry dir with reason "reload".
    await a.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctxA);
    shellBackground(b.pi);
    await b.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctxB);

    const statusB = b.tools.get("shell_status")!;
    // B adopts the handed-off job while it is still running...
    const early = await statusB.execute("s1", { id: jobId });
    assert.equal(early.details.status, "running", "B adopts the job as still running");

    // ...and delivers it exactly once, through B's own pi, when it finishes.
    await waitFor(() => b.sent.length > 0, 8000);
    assert.equal(b.sent.length, 1, "B delivered the finished job exactly once");
    assert.equal(b.sent[0].customType, DELIVERY_TYPE);
    assert.equal(b.sent[0].details.id, jobId);

    const late = await statusB.execute("s2", { id: jobId });
    assert.notEqual(late.details.status, "running", "B now shows the job finished");

    // The old instance A must stay silent: had it delivered, or (before the fix)
    // marked the sidecar delivered before its stale send threw, B would never
    // have delivered and the assertion above would have failed. Pin it directly.
    assert.equal(a.sent.length, 0, "the old instance A delivered nothing");
  } finally {
    await teardown(b, ctxB);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("a handed-off instance flushes final status without marking it delivered (finding f071)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-handoff-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const started = await h.tools
      .get("bash")!
      .execute("t1", { command: "sleep 1", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // Reload hand-off, but no new instance is started here. The old closures are
    // still alive in-process; when the command ends they must persist the final
    // status but NOT deliver and NOT flip delivered (which would have stranded a
    // real successor). Wait past the command's runtime, then read the sidecar.
    await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx);
    await sleep(2500);

    const sidecar = JSON.parse(readFileSync(join(regDir, `${jobId}.json`), "utf8"));
    assert.notEqual(sidecar.status, "running", "the old instance flushed a final status");
    assert.equal(sidecar.delivered, false, "but did not mark it delivered");
    assert.equal(h.sent.length, 0, "and delivered nothing through the stale pi");
  } finally {
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("quit kills a running job and records it killed (finding f078 complement)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-quit-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const started = await h.tools
      .get("bash")!
      .execute("t1", { command: "sleep 30", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // A quit shutdown ends the session for good: it must kill the tree and record
    // "killed" synchronously so a later reader never sees a dead job as running.
    await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    const status = await h.tools.get("shell_status")!.execute("s", { id: jobId });
    assert.equal(status.details.status, "killed", "the quit-killed job is recorded killed");
    assert.equal(existsSync(regDir), false, "and the session's registry dir is cleaned up");
  } finally {
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

for (const { name, hasUI, threshold } of [
  { name: "headless", hasUI: false, threshold: "100" },
  { name: "interactive with legacy auto-background configured", hasUI: true, threshold: "100" },
]) {
  test(`${name}: commands run to completion without auto-backgrounding`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sbg-no-auto-"));
    const { id: sid, regDir } = uniqueSession();
    const prevMs = process.env.SHELL_BG_MS;
    process.env.SHELL_BG_MS = threshold;
    const h = harness();
    const ctx = makeCtx(cwd, hasUI, sid);
    try {
      shellBackground(h.pi);
      await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
      // Outlive a positive legacy threshold in either mode. Both config and
      // environment overrides must be ignored, not just defaulted to zero.
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ autoBackgroundMs: 100 }));
      const result = await h.tools.get("bash")!.execute(
        "run", { command: "sleep 0.3; echo completed" }, undefined, undefined, ctx,
      );
      assert.equal(result.details.background, false);
      assert.equal(result.details.status, "done");
      assert.equal(result.structuredContent.exit_code, 0);
      assert.match(result.structuredContent.output, /completed/);
      assert.equal(h.sent.length, 0, "foreground results are not auto-delivered");
    } finally {
      await teardown(h, ctx);
      await rmDir(cwd);
      await rmDir(regDir);
      if (prevMs === undefined) delete process.env.SHELL_BG_MS;
      else process.env.SHELL_BG_MS = prevMs;
    }
  });
}

test("shell_status wait blocks until a running job finishes (finding f075)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-wait-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const started = await h.tools
      .get("bash")!
      .execute("t1", { command: "sleep 1", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    const t0 = Date.now();
    const res = await h.tools.get("shell_status")!.execute("w", { id: jobId, wait: 10 });
    assert.notEqual(res.details.status, "running", "wait blocked until the job finished");
    assert.ok(Date.now() - t0 >= 500, "and it actually waited for it");
    // The wait returned the finish, so it is not ALSO delivered as a follow-up
    // (seen on pi 1.0.4: the model spent a turn acknowledging what it had just
    // reported). Give the exit handler and delivery a moment to misfire.
    await sleep(1500);
    assert.equal(h.sent.length, 0, "a result returned by a wait is not delivered a second time");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("pi 0.99: results carry structuredContent for scripts — exit_code once finished, absent while running", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-struct-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;
    assert.ok((bash as { outputSchema?: unknown }).outputSchema, "the tool declares its outputSchema");

    const done = await bash.execute("t1", { command: "echo structured-ok" }, undefined, undefined, ctx);
    const sc = done.structuredContent as { output: string; exit_code?: number; status: string; job_id?: string; truncated: boolean };
    assert.match(sc.output, /structured-ok/);
    assert.equal(sc.exit_code, 0);
    assert.equal(sc.status, "done");
    assert.equal(sc.truncated, false);
    assert.equal(sc.job_id, undefined);

    const bg = await bash.execute("t2", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    const running = bg.structuredContent as { status: string; exit_code?: number; job_id: string };
    assert.equal(running.status, "running");
    assert.equal(running.job_id, "bg-1");
    assert.equal("exit_code" in running, false);
    const status = h.tools.get("shell_status")!;
    await waitFor(async () => (await status.execute("p", { id: running.job_id })).details.status !== "running", 6000);
    const collected = await status.execute("c", { id: running.job_id });
    assert.equal((collected.structuredContent as { exit_code?: number }).exit_code, 0);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("issue #2: a job collected with shell_status during the turn is not also delivered", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-issue2-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    // Pi is busy: hold delivery until a safe boundary, without lifecycle events.
    ctx.isIdle = () => false;
    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    const started = await bash.execute("t1", { command: "echo done", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // The model collects it this turn (each shell_status read on a finished job collects it).
    await waitFor(async () => (await shellStatus.execute("t2", { id: jobId })).details.status === "done", 6000);
    await sleep(300); // let any exit-time delivery attempt settle
    assert.equal(h.sent.length, 0, "collected during the turn, so nothing queued");

    // The tool batch ends while Pi is still busy: skip the collected job.
    await h.handlers.get("turn_end")!({ type: "turn_end" }, ctx);
    await sleep(200);
    assert.equal(h.sent.length, 0, "a job collected with shell_status is never delivered a second time");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("/bg preserves steering prose, releases the tool, and delivers the eventual result once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-steer-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  let running: Promise<any> | undefined;
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    ctx.isIdle = () => false;
    let returned = false;
    running = h.tools.get("bash")!.execute("foreground", {
      command: "echo before; touch ready; while [ ! -e finish ]; do sleep 0.02; done; echo after",
    }, undefined, undefined, ctx).then((result) => { returned = true; return result; });
    await waitFor(() => existsSync(join(cwd, "ready")), 2000);
    const prose = "Inspect the documentation meanwhile.\nDo not change files until the command finishes.";
    await h.commands.get("bg")!.handler(prose, ctx);
    await waitFor(() => returned, 1000);
    const result = await running;
    assert.equal(result.details.id, "fg-1");
    assert.equal(result.structuredContent.status, "running");
    assert.equal(result.structuredContent.exit_code, undefined);
    assert.match(result.structuredContent.output, /before/);
    assert.equal(h.sent.length, 1, "steering was queued before the call returned");
    assert.equal(h.sent[0].customType, STEERING_TYPE);
    assert.ok(h.sent[0].content.startsWith(prose + "\n\n"), "prose and newlines are preserved");
    assert.match(h.sent[0].content, /fg-1/);
    assert.match(h.sent[0].content, /not completed or verified/);
    assert.deepEqual(h.sendOptions[0], { deliverAs: "steer", triggerTurn: true });

    writeFileSync(join(cwd, "finish"), "");
    await waitFor(() => JSON.parse(readFileSync(join(regDir, "fg-1.json"), "utf8")).status === "done", 3000);
    assert.equal(h.sent.length, 1, "completion waits until the tool batch ends");
    await h.handlers.get("turn_end")!({ type: "turn_end" }, ctx);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].customType, DELIVERY_TYPE);
    assert.match(h.sent[1].content, /before\nafter/);
    await h.handlers.get("turn_end")!({ type: "turn_end" }, ctx);
    assert.equal(h.sent.length, 2, "no duplicate completion");
  } finally {
    await teardown(h, ctx);
    await running;
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("/bg steering still works when automatic completion delivery is disabled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-steer-no-delivery-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  let running: Promise<any> | undefined;
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ deliverResults: false }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    ctx.isIdle = () => false;
    running = h.tools.get("bash")!.execute("foreground", {
      command: "while [ ! -e finish ]; do sleep 0.02; done; echo completed",
    }, undefined, undefined, ctx);
    await h.commands.get("bg")!.handler("", ctx);
    const result = await running;
    assert.equal(result.details.pollRequired, true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].customType, STEERING_TYPE);
    assert.match(h.sent[0].content, /Automatic result delivery is disabled/);
    writeFileSync(join(cwd, "finish"), "");
    const collected = await h.tools.get("shell_status")!.execute("collect", { id: "fg-1", wait: 2 });
    assert.equal(collected.details.status, "done");
    assert.match(collected.structuredContent.output, /completed/);
    await h.handlers.get("turn_end")!({ type: "turn_end" }, ctx);
    assert.equal(h.sent.length, 1, "only the requested steering, never a completion push");
  } finally {
    await teardown(h, ctx);
    await running;
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("/bg returns the handle and prose through the tool if steering injection throws", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-steer-fallback-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  let running: Promise<any> | undefined;
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    h.pi.sendMessage = () => { throw new Error("message injection unavailable"); };
    running = h.tools.get("bash")!.execute("foreground", { command: "sleep 10" }, undefined, undefined, ctx);
    await h.commands.get("bg")!.handler("Keep this instruction.", ctx);
    const result = await running;
    assert.equal(result.details.id, "fg-1");
    assert.equal(result.structuredContent.status, "running");
    assert.match(result.content[0].text, /Keep this instruction/);
    assert.match(result.content[0].text, /fg-1/);
  } finally {
    await teardown(h, ctx);
    await running;
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("/bg picks only the selected task, supports cancellation, and does nothing without a foreground call", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-pick-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  const calls: Promise<any>[] = [];
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    let firstReturned = false;
    calls.push(h.tools.get("bash")!.execute("first", { command: "sleep 10; echo first" }, undefined, undefined, ctx)
      .then((result) => { firstReturned = true; return result; }));
    calls.push(h.tools.get("bash")!.execute("second", { command: "sleep 10; echo second" }, undefined, undefined, ctx));
    ctx.ui.select = async (_title, options) => {
      assert.equal(options.length, 2);
      return undefined;
    };
    await h.commands.get("bg")!.handler("cancelled prose", ctx);
    assert.equal(h.sent.length, 0);
    assert.equal(firstReturned, false);
    assert.deepEqual(readdirSync(regDir).filter((f) => f.endsWith(".json")), []);

    ctx.ui.select = async (_title, options) => options[1];
    await h.commands.get("bg")!.handler("Review the first task while the second runs.", ctx);
    assert.equal((await calls[1]).details.id, "fg-1");
    assert.equal(firstReturned, false, "the unselected call is still awaited");
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].details.id, "fg-1");
    assert.match(JSON.parse(readFileSync(join(regDir, "fg-1.json"), "utf8")).command, /second/);

    // Only one call remains: there must be no second picker.
    ctx.ui.select = async () => { throw new Error("unexpected picker"); };
    await h.commands.get("bg")!.handler("", ctx);
    assert.equal((await calls[0]).details.id, "fg-2");
    assert.equal(h.sent.length, 2);
    await h.commands.get("bg")!.handler("must not be sent", ctx);
    assert.equal(h.sent.length, 2, "no active call: no steering or duplicate registration");
  } finally {
    await teardown(h, ctx);
    await Promise.all(calls);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("/bg never substitutes a different task if the selection finishes while the picker is open", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-pick-exit-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  const calls: Promise<any>[] = [];
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    calls.push(h.tools.get("bash")!.execute("first", {
      command: "while [ ! -e finish ]; do sleep 0.02; done",
    }, undefined, undefined, ctx));
    let secondReturned = false;
    calls.push(h.tools.get("bash")!.execute("second", { command: "sleep 10" }, undefined, undefined, ctx)
      .then((result) => { secondReturned = true; return result; }));
    const notices: string[] = [];
    ctx.ui.notify = (message) => { notices.push(message); };
    ctx.ui.select = async (_title, options) => {
      writeFileSync(join(cwd, "finish"), "");
      assert.equal((await calls[0]).details.status, "done");
      return options[0];
    };
    await h.commands.get("bg")!.handler("must not be sent", ctx);
    assert.equal(secondReturned, false);
    assert.equal(h.sent.length, 0);
    assert.deepEqual(readdirSync(regDir).filter((f) => f.endsWith(".json")), []);
    assert.ok(notices.some((message) => message.includes("finished or was cancelled")));
  } finally {
    await teardown(h, ctx);
    await Promise.all(calls);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("/bg rechecks the background limit after the picker yields", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-pick-cap-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  const calls: Promise<any>[] = [];
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ maxBackground: 1 }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const bash = h.tools.get("bash")!;
    calls.push(bash.execute("first", { command: "sleep 10" }, undefined, undefined, ctx));
    calls.push(bash.execute("second", { command: "sleep 10" }, undefined, undefined, ctx));
    ctx.ui.select = async (_title, options) => {
      const parked = await bash.execute("fill-cap", { command: "sleep 10", background: true }, undefined, undefined, ctx);
      assert.equal(parked.details.id, "bg-1");
      return options[0];
    };
    await h.commands.get("bg")!.handler("must not be sent", ctx);
    assert.equal(h.sent.length, 0);
    assert.deepEqual(readdirSync(regDir).filter((f) => f.endsWith(".json")), ["bg-1.json"]);
  } finally {
    await teardown(h, ctx);
    await Promise.all(calls);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("busy completions arrive at the next tool boundary; native idle completions need no boundary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-boundary-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  let idle = false;
  ctx.isIdle = () => idle;
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start" }, ctx);
    const bash = h.tools.get("bash")!;
    const started = await bash.execute("background", {
      command: "sleep 0.05; echo background-complete; touch background-done", background: true,
    }, undefined, undefined, ctx);
    assert.match(started.content[0].text, /Completion will be delivered automatically; no status check is required/);
    const foreground = await bash.execute("foreground", {
      command: "while [ ! -e background-done ]; do sleep 0.02; done; sleep 0.05; echo foreground-complete",
    }, undefined, undefined, ctx);
    assert.equal(foreground.details.status, "done");
    await waitFor(() => JSON.parse(readFileSync(join(regDir, `${started.details.id}.json`), "utf8")).status === "done", 3000);
    assert.equal(h.sent.length, 0, "do not insert a completion in the middle of a tool batch");

    // The agent is still busy. Deliver before its next request, not after its
    // final response, so it can report both outcomes without a status call.
    await h.handlers.get("turn_end")!({ type: "turn_end" }, ctx);
    assert.equal(ctx.isIdle(), false);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].customType, DELIVERY_TYPE);
    assert.equal(h.sent[0].details.id, started.details.id);
    assert.match(h.sent[0].content, /background-complete/);
    await h.handlers.get("turn_end")!({ type: "turn_end" }, ctx);
    assert.equal(h.sent.length, 1, "completion is delivered exactly once");

    // A native-state change needs no matching extension lifecycle event.
    idle = true;
    const next = await bash.execute("idle-background", { command: "echo idle-complete", background: true }, undefined, undefined, ctx);
    await waitFor(() => h.sent.length === 2, 3000);
    assert.equal(h.sent[1].details.id, next.details.id);
    assert.match(h.sent[1].content, /idle-complete/);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});
