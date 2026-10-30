/** Kill the detached POSIX process group, matching Pi's immediate cancellation. */
export function killTree(pid: number | null | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process is already gone or cannot be signalled.
    }
  }
}
