import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JobRegistry } from "../src/registry.ts";

function baseDir(): string {
  return mkdtempSync(join(tmpdir(), "sbg-reg-"));
}

test("only registration allocates an id, with separate launch and transfer counters", () => {
  const dir = baseDir();
  try {
    const r = new JobRegistry(dir);
    const execution = r.createExecution("echo a", "/x");
    assert.equal(execution.id, undefined);
    assert.equal(r.all().length, 0);
    assert.deepEqual(readdirSync(dir), ["logs"], "no foreground sidecar");
    assert.equal(dirname(execution.logPath), join(dir, "logs"));
    const logPath = execution.logPath;
    const startedAt = execution.startedAt;
    execution.pid = 123;
    const a = r.register(execution, false);
    const b = r.register(r.createExecution("echo b", "/x"), true);
    const c = r.register(r.createExecution("echo c", "/x"), false);
    assert.equal(a, execution, "promotion preserves the live execution record");
    assert.equal(a.logPath, logPath);
    assert.equal(a.startedAt, startedAt);
    assert.equal(a.pid, 123);
    assert.equal(a.id, "bg-1");
    assert.equal(b.id, "fg-1");
    assert.equal(c.id, "bg-2");
    assert.equal(a.background, true);
    assert.equal(b.fromForeground, true);
    assert.equal(r.running().length, 3);
    assert.equal(r.get("fg-1")?.command, "echo b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persist writes a sidecar and load restores + continues the counter", () => {
  const dir = baseDir();
  try {
    const r1 = new JobRegistry(dir);
    const j = r1.register(r1.createExecution("sleep 1", "/x"), false);
    j.pid = 999_999_999; // almost certainly not a live pid
    r1.persist(j);
    assert.ok(readdirSync(dir).some((f) => f === "bg-1.json"));

    // Fresh registry over the same dir: reconcile the dead running job to done,
    // and keep numbering after the highest restored id.
    const r2 = new JobRegistry(dir);
    r2.load();
    const restored = r2.get("bg-1");
    assert.ok(restored);
    assert.equal(restored!.status, "done", "a running job with a dead pid settles");
    assert.equal(restored!.background, true);
    assert.equal(r2.register(r2.createExecution("echo next", "/x"), false).id, "bg-2");
    assert.equal(r2.register(r2.createExecution("echo moved", "/x"), true).id, "fg-1", "the transfer counter is independent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running record from another host pid is orphaned, not adopted (finding f072)", () => {
  const dir = baseDir();
  try {
    // A sidecar left by a different (or since-crashed) host, whose pid happens to
    // be live and — worst case — is *ours*. It must never be treated as running,
    // or session_shutdown would killTree a pid this host did not spawn.
    const foreign = {
      id: "bg-1",
      command: "sleep 999",
      cwd: "/x",
      pid: process.pid,
      hostPid: process.pid + 100_000, // a host that is not this one
      status: "running",
      exitCode: null,
      signal: null,
      logPath: join(dir, "logs", "bg-1.log"),
      startedAt: Date.now(),
      endedAt: null,
      auto: false,
      delivered: false,
    };
    writeFileSync(join(dir, "bg-1.json"), JSON.stringify(foreign));
    const r = new JobRegistry(dir);
    r.load();
    assert.equal(r.get("bg-1")?.status, "orphaned", "a foreign-host running record is marked orphaned");
    assert.equal(r.running().length, 0, "and excluded from running() so it is never killed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running record with no hostPid (pre-upgrade) is treated as foreign", () => {
  const dir = baseDir();
  try {
    const old = {
      id: "bg-1",
      command: "x",
      cwd: "/x",
      pid: process.pid,
      status: "running",
      exitCode: null,
      signal: null,
      logPath: join(dir, "logs", "bg-1.log"),
      startedAt: Date.now(),
      endedAt: null,
      auto: false,
      delivered: false,
    };
    writeFileSync(join(dir, "bg-1.json"), JSON.stringify(old));
    const r = new JobRegistry(dir);
    r.load();
    assert.equal(r.get("bg-1")?.status, "orphaned");
    assert.equal(r.get("bg-1")?.background, true, "legacy sidecars retain their visibility");
    assert.equal(r.running().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload restores both counters without exposing old foreground records", () => {
  const dir = baseDir();
  try {
    const first = new JobRegistry(dir);
    first.register(first.createExecution("sleep 1", "/x"), false);
    first.register(first.createExecution("sleep 2", "/x"), true);
    // A foreground-only sidecar from an older version stays out of the roster,
    // but its id must not be reused while that file still exists.
    const oldForeground = { ...first.createExecution("echo done", "/x"), id: "fg-8", status: "done" };
    writeFileSync(join(dir, "fg-8.json"), JSON.stringify(oldForeground));

    const restored = new JobRegistry(dir);
    restored.load();
    assert.equal(restored.all().length, 2);
    assert.equal(restored.get("bg-1")?.background, true);
    assert.equal(restored.get("fg-1")?.fromForeground, true);
    assert.equal(restored.get("fg-8"), undefined);
    assert.equal(restored.register(restored.createExecution("echo next", "/x"), false).id, "bg-2");
    assert.equal(restored.register(restored.createExecution("echo next", "/x"), true).id, "fg-9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy automatically backgrounded jobs retain their IDs and foreground provenance", () => {
  const dir = baseDir();
  try {
    const first = new JobRegistry(dir);
    const legacy = {
      ...first.createExecution("echo old", "/x"), id: "fg-3", status: "done", background: true,
      fromForeground: undefined, auto: true,
    };
    writeFileSync(join(dir, "fg-3.json"), JSON.stringify(legacy));
    const restored = new JobRegistry(dir);
    restored.load();
    assert.equal(restored.get("fg-3")?.fromForeground, true);
    assert.equal(restored.register(restored.createExecution("echo new", "/x"), true).id, "fg-4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load tolerates a corrupt sidecar", () => {
  const dir = baseDir();
  try {
    const r = new JobRegistry(dir);
    writeFileSync(join(dir, "bg-9.json"), "{not json");
    assert.doesNotThrow(() => r.load());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
