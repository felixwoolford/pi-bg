import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWidgetLines, type WidgetTheme } from "../src/widget.ts";
import type { Job } from "../src/types.ts";

const theme: WidgetTheme = { fg: (_color, text) => text, bold: (text) => text };

function job(over: Partial<Job> = {}): Job {
  return {
    id: "bg-1", command: "sleep 30", cwd: "/x", pid: 123, status: "done", exitCode: 0, signal: null,
    logPath: "/no/log", startedAt: 1000, endedAt: 31_000, background: true, fromForeground: false,
    delivery: "followUp", notified: false, delivered: false, ...over,
  };
}

test("the widget identifies each job's delivery mode", () => {
  const jobs = (["notify", "steer", "followUp"] as const).map((delivery, i) =>
    job({ id: `bg-${i + 1}`, delivery, status: "running", endedAt: null }));
  const text = buildWidgetLines(jobs, theme, 5000).join("\n");
  assert.match(text, /bg-1 \[notify\]/);
  assert.match(text, /bg-2 \[steer\]/);
  assert.match(text, /bg-3 \[follow-up\]/);
});

test("finished results remain visible until handoff or collection, even after a ready notice", () => {
  const now = 600_000;
  for (const notified of [false, true]) {
    const text = buildWidgetLines([job({ notified })], theme, now).join("\n");
    assert.match(text, /bg-1/);
    assert.match(text, /1 ready/);
    assert.match(text, /30s · ready/);
  }
  assert.deepEqual(buildWidgetLines([job({ background: false })], theme, now), [], "private foreground records stay hidden");
});

test("finished rows expire 15 seconds after delivery, not after process completion", () => {
  const result = job({ delivered: true, deliveredAt: 600_000 });
  const before = buildWidgetLines([result], theme, 614_999);
  assert.ok(before.some((line) => line.includes("bg-1")), "a long-held result remains briefly visible after handoff");
  assert.ok(before.some((line) => line.includes("0 ready")));
  assert.deepEqual(buildWidgetLines([result], theme, 615_001), []);
});

test("legacy delivered records without a handoff timestamp retain the old completion grace period", () => {
  const legacy = job({ delivered: true });
  assert.ok(buildWidgetLines([legacy], theme, 40_000).some((line) => line.includes("bg-1")));
  assert.deepEqual(buildWidgetLines([legacy], theme, 46_001), []);
});
