import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatResult } from "../src/format.ts";
import type { Job } from "../src/types.ts";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "bg-1",
    command: "npm test",
    cwd: "/x",
    pid: 123,
    status: "done",
    exitCode: 0,
    signal: null,
    logPath: "/no/log",
    startedAt: 1000,
    endedAt: 5200,
    background: true,
    auto: false,
    delivered: false,
    ...over,
  };
}

test("results include command output", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-fmt-"));
  try {
    const logPath = join(dir, "l.log");
    writeFileSync(logPath, "line one\nline two\n");
    const text = formatResult(job({ logPath }), 65536);
    assert.match(text, /line one\nline two/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatResult is honest about no output, and about a log it cannot read", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-fmt-"));
  try {
    const logPath = join(dir, "empty.log");
    writeFileSync(logPath, "");
    assert.match(formatResult(job({ logPath }), 65536), /\(no output\)/);
    assert.match(formatResult(job({ logPath, status: "running", endedAt: null }), 65536), /\(no output yet\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A missing log is not a command that printed nothing.
  assert.match(formatResult(job({ logPath: "/no/such" }), 65536), /\(log unavailable: \/no\/such could not be read\)/);
});

test("long results retain failures and access to the full unchanged log", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-fmt-"));
  try {
    const logPath = join(dir, "build.log");
    const body = Array.from({ length: 600 }, (_, i) => (i === 300 ? "error TS2304: Cannot find name 'x'" : `INFO step ${i}`));
    writeFileSync(logPath, body.join("\n") + "\n");
    const text = formatResult(job({ logPath }), 65536, 200);
    assert.match(text, /error TS2304/, "the failing step survived in the middle");
    assert.ok(text.includes(logPath), "the full log remains accessible");
    assert.ok(text.includes("INFO step 599"), "the tail is there");
    assert.ok(text.includes("INFO step 0"), "the head is there");
    assert.ok(text.split("\n").length < body.length, "repetitive output is bounded");
    assert.equal(readFileSync(logPath, "utf8"), body.join("\n") + "\n", "the full log is unchanged");
    // tailLines 0 turns shrinking off.
    assert.ok(formatResult(job({ logPath }), 65536, 0).split("\n").length > 600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
