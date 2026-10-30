/**
 * Kill a shell command and its descendants via its POSIX process group.
 * Detached spawning makes the child's pid a process-group id. Send SIGTERM,
 * then escalate to SIGKILL after a grace period. Fall back to the bare pid
 * when the group no longer exists.
 */

const GRACE_MS = 3000;

export function killTree(pid: number | null | undefined): void {
  if (!pid || pid <= 0) return;

  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (!signalGroup("SIGTERM")) return;
  const timer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
  timer.unref?.();
}
