/**
 * Spawn a detached shell command with stdout and stderr sharing a log file.
 * The child inherits the file descriptor, so output goes straight to disk
 * without parent-owned pipes or drain timers. Its pid is a process-group id
 * for killTree; unref keeps a running job from holding the host open.
 */
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

export interface Spawned {
  pid: number | null;
  /** Resolves when the process exits or fails to start. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnToFile(
  shell: string,
  shellArgs: readonly string[],
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
): Spawned {
  // Append without clipping existing output; command logs may contain secrets.
  const fd = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(shell, [...shellArgs, command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } catch {
    return { pid: null, exit: Promise.resolve({ code: null, signal: null }) };
  } finally {
    // The child owns its inherited descriptors; the parent no longer needs one.
    closeSync(fd);
  }

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });

  child.unref();
  return { pid: child.pid ?? null, exit };
}
