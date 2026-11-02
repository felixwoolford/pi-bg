/** Formatting command results, background job lists, and lifecycle messages. */
import type { DeliveryMode, Execution, Job } from "./types.ts";
import { readTail } from "./tail.ts";
import { sanitizeOutput } from "./sanitize.ts";

function kb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function secs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Foreground results have no public job id. */
export function header(job: Execution): string {
  const id = job.id ? `${job.id} · ` : "";
  const duration = secs(Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt));
  if (job.status === "running") return `[${id}running · ${duration}]`;
  const verdict = job.status === "orphaned"
    ? "orphaned (another session)"
    : job.signal ? `signal ${job.signal}` : job.status === "killed" ? "killed" : `exit ${job.exitCode ?? "?"}`;
  return `[${id}${job.status} · ${verdict} · ${duration}]`;
}

/** A cleaned byte-bounded tail; no line selection, deduplication, or report rewriting. */
export function formatResult(job: Execution, tailBytes: number): string {
  const tail = readTail(job.logPath, tailBytes);
  const lines = [header(job)];
  if (tail.missing) {
    lines.push(`(log unavailable: ${job.logPath} could not be read)`);
    return lines.join("\n");
  }
  if (tail.truncated) {
    lines.push(`… this is the last ${kb(Buffer.byteLength(tail.text, "utf8"))} of a ${kb(tail.bytes)} log — full log: ${job.logPath}`);
  }
  const text = sanitizeOutput(tail.text).replace(/\n+$/, "");
  lines.push(text || (job.status === "running" ? "(no output yet)" : "(no output)"));
  return lines.join("\n");
}

export function deliveryLabel(delivery: DeliveryMode): string {
  return delivery === "followUp" ? "follow-up" : delivery;
}

/** A roster of background jobs for shell_status with no id. */
export function formatList(jobs: Job[]): string {
  if (jobs.length === 0) return "No background commands this session.";
  const rows = jobs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => {
      const cmd = j.command.replace(/\s+/g, " ").trim();
      const short = cmd.length <= 48 ? cmd : `${cmd.slice(0, 47)}…`;
      return `${header(j)} [${deliveryLabel(j.delivery)}]  ${short}`;
    });
  return [`${jobs.filter((j) => j.status === "running").length} running, ${jobs.length} total:`, ...rows].join("\n");
}

export interface BackgroundedInput {
  id: string;
  command: string;
  elapsedMs: number;
  /** True when the user transfers a running foreground call with /bg. */
  fromForeground: boolean;
  /** Whether uncollected results will be delivered automatically. */
  deliverResults: boolean;
  delivery: DeliveryMode;
  /** Whether a UI/interactive session is present to deliver into. */
  interactive: boolean;
  /** The tool to collect with, e.g. "shell_status". */
  collectWith: string;
}

function elapsed(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function clip(command: string, max = 60): string {
  const one = command.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export interface BackgroundedResult {
  text: string;
  details: {
    id: string;
    status: "running";
    background: true;
    fromForeground: boolean;
    delivery: DeliveryMode;
    retryable: true;
    pollRequired: boolean;
    elapsedMs: number;
  };
}

/** Launch guidance differs because headless sessions cannot deliver after the run ends. */
export function backgroundedResult(input: BackgroundedInput): BackgroundedResult {
  const head = input.fromForeground
    ? `The user moved ${input.id} to the background after ${elapsed(input.elapsedMs)} without cancelling it.`
    : `${input.id} started in the background.`;
  const mode = `Delivery: ${deliveryLabel(input.delivery)}.`;
  const line = `  $ ${clip(input.command)}`;
  const tail = !input.interactive
    ? [
        "This is a headless run: nothing is delivered after your turn ends. Collect it",
        `in this same turn — ${input.collectWith} {id: "${input.id}", wait: 60} blocks until it`,
        "finishes (or the wait elapses); do not end your turn expecting the result to arrive on its own.",
      ]
    : input.deliverResults
      ? [
          "Completion will be delivered automatically; no status check is required.",
          input.delivery === "notify"
            ? "While you work, one short notice announces completion; the full result follows when you finish, unless collected first."
            : input.delivery === "steer"
              ? "The full result arrives at the next safe opportunity, even while you are working."
              : "The full result arrives after your current work, without an earlier notice.",
          `Use ${input.collectWith} for progress or to explicitly wait for a result.`,
        ]
      : [
          "Automatic result delivery is disabled.",
          `Collect the result with ${input.collectWith} {id: "${input.id}", wait: 60}.`,
        ];
  tail.unshift("The command is still running, not completed or verified. Only proceed with work independent of its result.");
  return {
    text: [head, mode, line, "", ...tail].join("\n"),
    details: {
      id: input.id,
      status: "running",
      background: true,
      fromForeground: input.fromForeground,
      delivery: input.delivery,
      retryable: true,
      pollRequired: !input.interactive || !input.deliverResults,
      elapsedMs: input.elapsedMs,
    },
  };
}

/** How a finished background job introduces itself when it arrives unasked. */
export function deliveryMessage(id: string, body: string): string {
  return [
    `<shell_background_result id="${id}">`,
    body.trim(),
    `</shell_background_result>`,
    "",
    `Completed result for ${id}, a command you sent to the background.`,
  ].join("\n");
}

/** A short availability notice, without the command's output or a repeated reminder. */
export function readyMessage(ids: string[]): string {
  return `Background result${ids.length === 1 ? "" : "s"} ready: ${ids.join(", ")}. ` +
    "Use shell_status if useful now; otherwise the full result will arrive as a follow-up.";
}

/** The custom-message type a delivered result travels under. */
export const DELIVERY_TYPE = "shell-background-result";
export const READY_TYPE = "shell-background-ready";

/** The user-triggered background-and-steer message, distinct from a finished result. */
export const STEERING_TYPE = "shell-background-steering";
