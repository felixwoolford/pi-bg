/**
 * Core execution, backgrounding, delivery and session-lifecycle tests driven
 * through a minimal mock of the pi ExtensionAPI. Commands run in real shells;
 * every spawned command is torn down before the test returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import shellBackground from "../index.ts";
import { DELIVERY_TYPE } from "../src/pending.ts";

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
  sent: any[];
}

function harness(): Harness {
  const tools = new Map<string, AnyTool>();
  const handlers = new Map<string, AnyHandler>();
  const sent: any[] = [];
  const pi = {
    registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: AnyHandler) => handlers.set(event, handler),
    sendMessage: (msg: unknown) => sent.push(msg),
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers, sent };
}

function makeCtx(cwd: string, hasUI: boolean, sessionId?: string): ExtensionContext {
  return {
    cwd,
    hasUI,
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
    return /^0 running/.test(String(list.content[0].text));
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
    assert.equal(done.details.id, "fg-1");
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
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("explicit and automatic background jobs retain IDs and remain manageable after reload", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-bg-"));
  const { id: sid, regDir } = uniqueSession();
  const a = harness();
  const b = harness();
  const ctxA = makeCtx(cwd, true, sid);
  const ctxB = makeCtx(cwd, true, sid);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ autoBackgroundMs: 400 }));
    shellBackground(a.pi);
    await a.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    const bash = a.tools.get("bash")!;
    const quick = await bash.execute("quick", { command: "echo ok" }, undefined, undefined, ctxA);
    assert.equal(quick.details.id, "fg-1");
    const explicit = await bash.execute("explicit", { command: "sleep 10", background: true }, undefined, undefined, ctxA);
    assert.equal(explicit.details.id, "bg-2");
    assert.equal(explicit.details.background, true);
    assert.equal(explicit.details.auto, false);
    assert.equal(explicit.structuredContent.status, "running");

    const moved = await bash.execute("automatic", { command: "sleep 10" }, undefined, undefined, ctxA);
    assert.equal(moved.details.id, "fg-3");
    assert.equal(moved.details.background, true);
    assert.equal(moved.structuredContent.job_id, "fg-3");
    assert.equal(moved.details.auto, true);
    assert.equal(moved.structuredContent.status, "running");
    const sidecar = JSON.parse(readFileSync(join(regDir, "fg-3.json"), "utf8"));
    assert.equal(sidecar.background, true);
    assert.equal(sidecar.auto, true);

    await a.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctxA);
    shellBackground(b.pi);
    await b.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctxB);
    const list = await b.tools.get("shell_status")!.execute("list", {});
    assert.match(list.content[0].text, /2 running, 3 total/);
    assert.match(list.content[0].text, /bg-2/);
    assert.match(list.content[0].text, /fg-3/);
    const next = await b.tools.get("bash")!.execute("next", { command: "echo next" }, undefined, undefined, ctxB);
    assert.equal(next.details.id, "fg-4", "shared counter survives reload with both prefixes");
    const status = await b.tools.get("shell_status")!.execute("status", { id: "fg-3" });
    assert.equal(status.details.status, "running");
    const killed = await b.tools.get("shell_kill")!.execute("kill", { id: "fg-3" });
    assert.equal(killed.details.id, "fg-3", "fg IDs work with shell_kill too");
    await waitFor(async () => (await b.tools.get("shell_status")!.execute("status", { id: "fg-3" })).details.status === "killed", 6000);
  } finally {
    await teardown(a, ctxA);
    await teardown(b, ctxB);
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

test("maxBackground: over the cap a long foreground command stays in the foreground instead of auto-backgrounding", async () => {
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

    // Outlives the 200ms threshold, but the cap is full: it must NOT move to the
    // background — it runs to completion in the foreground and says why.
    const res = await bash.execute("t2", { command: "sleep 1" }, undefined, undefined, ctx);
    assert.equal(res.details.background, false, "not backgrounded");
    assert.equal(res.details.status, "done");
    assert.match(String(res.content[0].text), /kept in the foreground/);
    assert.equal(res.details.id, "fg-2");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
    if (prevMs === undefined) delete process.env.SHELL_BG_MS;
    else process.env.SHELL_BG_MS = prevMs;
  }
});

test("a timeout still fires after a command auto-backgrounds (bug #3)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext3-"));
  const { id: sid, regDir } = uniqueSession();
  const prevMs = process.env.SHELL_BG_MS;
  // Move to the background quickly so the test does not wait the default 30s.
  process.env.SHELL_BG_MS = "200";
  const h = harness();
  const ctx = makeCtx(cwd, true, sid); // hasUI so auto-background is enabled
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    // A command with a 1s timeout that outlives both the 200ms auto-background
    // threshold and the timeout: it must auto-background, then the timeout must
    // survive that move and kill it around the 1s mark (well before it would end
    // on its own).
    const res = await bash.execute("t1", { command: "sleep 3", timeout: 1 }, undefined, undefined, ctx);
    assert.equal(res.details.background, true, "the command was moved to the background");
    const jobId = res.details.id as string;

    // Before the fix the timeout is dropped, so it is still "running" past the
    // 1s deadline; after the fix the surviving timeout kills it.
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
  { name: "auto-background disabled", hasUI: true, threshold: "0" },
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
      // Outlive the headless case's configured threshold: checking guideline
      // wording alone would not detect accidental auto-backgrounding here.
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
    const sc = done.structuredContent as { output: string; exit_code?: number; status: string; job_id: string; truncated: boolean };
    assert.match(sc.output, /structured-ok/);
    assert.equal(sc.exit_code, 0);
    assert.equal(sc.status, "done");
    assert.equal(sc.truncated, false);
    assert.equal(sc.job_id, "fg-1");

    const bg = await bash.execute("t2", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    const running = bg.structuredContent as { status: string; exit_code?: number; job_id: string };
    assert.equal(running.status, "running");
    assert.equal(running.job_id, "bg-2");
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
    // A turn is running: delivery must be deferred to its end, not sent at exit.
    await h.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    const started = await bash.execute("t1", { command: "echo done", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // The model collects it this turn (each shell_status read on a finished job collects it).
    await waitFor(async () => (await shellStatus.execute("t2", { id: jobId })).details.status === "done", 6000);
    await sleep(300); // let any exit-time delivery attempt settle
    assert.equal(h.sent.length, 0, "collected during the turn, so nothing queued");

    // The turn ends: the drain must skip the already-collected job.
    await h.handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
    await sleep(200);
    assert.equal(h.sent.length, 0, "a job collected with shell_status is never delivered a second time");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("issue #2: a job nobody collects is delivered once at the turn boundary, not mid-turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-issue2b-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    await h.handlers.get("agent_start")!({ type: "agent_start" }, ctx);
    const started = await h.tools.get("bash")!.execute("t1", { command: "echo done", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // The job finishes during the turn but is not collected: held, not sent yet.
    await sleep(800);
    assert.equal(h.sent.length, 0, "not delivered while the turn is still running");

    // The turn ends: now it is delivered, exactly once.
    await h.handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
    assert.equal(h.sent.length, 1, "delivered once when the turn ended");
    assert.equal(h.sent[0].customType, DELIVERY_TYPE);
    assert.equal(h.sent[0].details.id, jobId);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});
