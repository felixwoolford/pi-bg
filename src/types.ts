/**
 * Shared shapes for shell-background.
 * No imports from pi packages: src/ typechecks and unit-tests standalone.
 */

export type JobStatus = "running" | "done" | "failed" | "killed" | "orphaned";
export type DeliveryMode = "notify" | "steer" | "followUp";

export function isDeliveryMode(value: unknown): value is DeliveryMode {
  return value === "notify" || value === "steer" || value === "followUp";
}

export interface Execution {
  /** Assigned only when backgrounded: bg-N at launch, fg-N transferred by the user. */
  id?: string;
  command: string;
  cwd: string;
  /** OS pid of the shell process; null before spawn or if spawn failed. */
  pid: number | null;
  /**
   * pid of the pi host that spawned this job. A record whose hostPid is not the
   * current process was written by another (or a since-crashed) host: its pid is
   * not ours to signal, so it is never treated as running here. A `/reload`
   * keeps the same host pid, so genuine reload survivors still adopt. Optional
   * so a pre-upgrade sidecar (no hostPid) is simply treated as foreign.
   */
  hostPid?: number;
  status: JobStatus;
  /** Process exit code, once finished. */
  exitCode: number | null;
  /** Terminating signal name, if the process was signalled. */
  signal: string | null;
  /** Absolute path of the merged stdout+stderr log file. */
  logPath: string;
  startedAt: number;
  endedAt: number | null;
  /** Whether the command has actually entered the background. */
  background: boolean;
  /** True when transferred from a foreground call rather than backgrounded at launch. */
  fromForeground: boolean;
  /** How to report completion while the agent is busy. Idle agents receive the full result. */
  delivery: DeliveryMode;
  /** Whether the one-time result-ready notice has been sent (not full-result delivery). */
  notified: boolean;
  /** Whether the finished result has been delivered or collected with shell_status. */
  delivered: boolean;
  /** Time the full result was handed off or collected, not proof the model read it. */
  deliveredAt?: number;
  /** Set when we killed it (timeout/abort/shell_kill), so exit reads as killed. */
  killedByUs?: boolean;
}

/** A registered background execution, with a public session-monotonic id. */
export interface Job extends Execution {
  id: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finished job is anything past running. */
export function isFinished(job: Job): boolean {
  return job.status !== "running";
}
