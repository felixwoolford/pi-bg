/**
 * The aboveEditor box lists running jobs, completed results awaiting handoff,
 * and results handed off or collected in the last 15s.
 * Includes a pure line builder and a session-scoped rendering/timer controller.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { deliveryLabel } from "./format.ts";
import type { Job } from "./types.ts";

const WIDGET = "shell-bg";
const WIDTH = 54;
const MAX_ROWS = 8;

interface WidgetOptions {
  getJobs(): Job[] | undefined;
  getContext(): ExtensionContext | null;
  setContext(ctx: ExtensionContext): void;
}

/** No timer starts until a non-empty widget is rendered. Stop on session shutdown. */
export function createWidgetController(options: WidgetOptions) {
  let timer: NodeJS.Timeout | null = null;

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function render(ctx: ExtensionContext | null = options.getContext()): void {
    if (!ctx || !ctx.hasUI) return;
    const jobs = options.getJobs();
    if (!jobs) return;
    options.setContext(ctx);
    const lines = buildWidgetLines(jobs, ctx.ui.theme as unknown as WidgetTheme, Date.now());
    if (lines.length === 0) {
      ctx.ui.setWidget(WIDGET, undefined);
      stopTimer();
      return;
    }
    ctx.ui.setWidget(WIDGET, () => new Text(lines.join("\n"), 0, 0), { placement: "aboveEditor" });
    // Tick elapsed time and expire handed-off rows even without other events.
    // Unref'd so a lingering box never holds the host open.
    if (!timer) {
      timer = setInterval(() => render(), 1000);
      timer.unref?.();
    }
  }

  function stop(ctx: ExtensionContext | null = options.getContext()): void {
    stopTimer();
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  }

  return { render, stop };
}

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function icon(job: Job): string {
  switch (job.status) {
    case "running":
      return "⟳";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "◼";
  }
}

function color(job: Job): string {
  switch (job.status) {
    case "running":
      return "warning";
    case "done":
      return "success";
    case "failed":
      return "error";
    default:
      return "dim";
  }
}

function elapsed(job: Job, now: number): string {
  const end = job.endedAt ?? now;
  const s = Math.max(0, Math.round((end - job.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function buildWidgetLines(jobs: Job[], theme: WidgetTheme, now: number): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const visible = jobs
    .filter((j) => j.background && (j.status === "running" || !j.delivered ||
      (j.deliveredAt ?? j.endedAt ?? 0) > now - 15_000))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (visible.length === 0) return [];

  const running = visible.filter((j) => j.status === "running").length;
  const ready = visible.filter((j) => j.status !== "running" && !j.delivered).length;
  const title = ` ⚙ shell-bg · ${running} running · ${ready} ready `;
  const hint = " /shell-bg ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  const lines = [dim(`╭${title}${"─".repeat(pad)}${hint}╮`)];

  const shown = visible.slice(-MAX_ROWS);
  const hidden = visible.length - shown.length;
  for (const j of shown) {
    const c = color(j);
    const state = j.status !== "running" && !j.delivered ? " · ready" : "";
    lines.push(truncateToWidth(
      `${theme.fg(c, icon(j))} ${theme.fg(c, j.id)} ${dim(`[${deliveryLabel(j.delivery)}] · ${elapsed(j, now)}${state}`)} ${dim(clip(j.command, 28))}`,
      WIDTH,
    ));
  }
  if (hidden > 0) lines.push(dim(`│ … +${hidden} more`));
  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
