import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWidgetLines } from "../src/widget.ts";
import type { Job } from "../src/types.ts";

const now = 100_000;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function job(over: Partial<Job> = {}): Job {
  return {
    id: "fg-1", command: "sleep 60", cwd: "/x", pid: 123,
    status: "running", exitCode: null, signal: null, logPath: "/no/log",
    startedAt: now - 30_000, endedAt: null, background: false, auto: false, delivered: false,
    ...over,
  };
}

test("foreground commands never appear, running or recently finished", () => {
  for (const status of ["running", "done", "failed", "killed", "orphaned"] as const) {
    assert.deepEqual(buildWidgetLines([job({ status, endedAt: status === "running" ? null : now })], theme, now), []);
  }
});

test("explicit and automatic background jobs appear with their actual IDs", () => {
  const lines = buildWidgetLines([
    job(),
    job({ id: "bg-2", background: true }),
    job({ id: "fg-3", background: true, auto: true }),
  ], theme, now).join("\n");
  assert.match(lines, /2 running/);
  assert.match(lines, /bg-2/);
  assert.match(lines, /fg-3/);
  assert.doesNotMatch(lines, /fg-1/);
});

test("only genuine background completions remain visible for 15 seconds", () => {
  const completed = job({ background: true, auto: true, status: "done", endedAt: now });
  assert.match(buildWidgetLines([completed], theme, now + 14_999).join("\n"), /fg-1/);
  assert.deepEqual(buildWidgetLines([completed], theme, now + 15_000), []);
});
