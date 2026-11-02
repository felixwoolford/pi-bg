import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWidgetLines, createWidgetController, type WidgetTheme } from "../src/widget.ts";
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

function widgetHarness() {
  const updates: unknown[] = [];
  const ctx = {
    hasUI: true,
    ui: { theme, setWidget: (_name: string, content: unknown) => { updates.push(content); } },
  } as unknown as ExtensionContext;
  const state: { ctx: ExtensionContext | null; jobs: Job[] | undefined } = { ctx, jobs: undefined };
  const widget = createWidgetController({
    getJobs: () => state.jobs,
    getContext: () => state.ctx,
    setContext: (next) => { state.ctx = next; },
  });
  return { widget, state, ctx, updates };
}

test("widget controller keeps one refresh timer, expires handed-off rows, and stops on shutdown", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 600_000 });
  const { widget, state, ctx, updates } = widgetHarness();
  t.after(() => widget.stop(ctx));
  assert.equal(updates.length, 0, "construction has no UI or timer side effects");
  const result = job();
  state.jobs = [result];
  widget.render();
  assert.equal(typeof updates[0], "function");
  t.mock.timers.tick(1000);
  assert.equal(updates.length, 2, "the timer refreshes without another event");
  widget.render();
  t.mock.timers.tick(1000);
  assert.equal(updates.length, 4, "rerendering does not accumulate timers");

  result.delivered = true;
  result.deliveredAt = Date.now();
  t.mock.timers.tick(15_001);
  assert.equal(updates.at(-1), undefined, "expired rows clear the widget without another event");
  const cleared = updates.length;
  t.mock.timers.tick(2000);
  assert.equal(updates.length, cleared, "an empty widget stops refreshing");

  state.jobs = [job({ id: "bg-2" })];
  widget.render();
  const restarted = updates.length;
  t.mock.timers.tick(1000);
  assert.equal(updates.length, restarted + 1, "a new visible job restarts refreshing");
  widget.stop(ctx);
  assert.equal(updates.at(-1), undefined);
  const stopped = updates.length;
  t.mock.timers.tick(2000);
  assert.equal(updates.length, stopped, "shutdown stops refreshing");
});

test("widget controller does nothing without a context, UI, or initialized job registry", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { widget, state, ctx, updates } = widgetHarness();
  t.after(() => widget.stop(ctx));
  widget.render(); // No registry yet.
  state.jobs = [job()];
  state.ctx = null;
  widget.render();
  state.ctx = { ...ctx, hasUI: false };
  widget.render();
  t.mock.timers.tick(2000);
  assert.deepEqual(updates, []);
});
