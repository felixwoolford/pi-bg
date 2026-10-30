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

test("JSON test reports are returned verbatim rather than rewritten as summaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-report-"));
  try {
    const logPath = join(dir, "report.log");
    const reports = [
      { exitcode: 0, tests: [{ nodeid: "test_example.py::test_ok", outcome: "passed", metadata: { value: 42 } }] },
      { numFailedTests: 0, numPassedTests: 1, testResults: [{ assertionResults: [{ status: "passed", title: "kept", duration: 12 }] }] },
    ];
    for (const report of reports) {
      const raw = JSON.stringify(report, null, 2);
      writeFileSync(logPath, raw);
      const result = formatResult(job({ logPath }), 65536);
      assert.equal(result.slice(result.indexOf("\n") + 1), raw);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long results preserve every line without deduplication or importance filtering", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-fmt-"));
  try {
    const logPath = join(dir, "build.log");
    const body = Array.from({ length: 600 }, (_, i) => (i === 300 ? "error TS2304: Cannot find name 'x'" : `INFO step ${i}`));
    writeFileSync(logPath, body.join("\n") + "\n");
    const text = formatResult(job({ logPath }), 65536);
    assert.equal(text.slice(text.indexOf("\n") + 1), body.join("\n"));
    assert.equal(readFileSync(logPath, "utf8"), body.join("\n") + "\n", "the full log is unchanged");
    const bounded = formatResult(job({ logPath }), 1024);
    assert.ok(bounded.includes(logPath), "byte truncation points to the full log");
    assert.ok(bounded.endsWith("INFO step 599"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
