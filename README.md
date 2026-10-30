# shell-background

Long-running bash goes async in [pi](https://github.com/earendil-works/pi). Pass `background: true` to launch a command and get its job id back immediately. An interactive foreground command still running after 30 seconds is automatically moved to the background, freeing the agent to continue working.

## Usage

```text
bash { command: "npm run build" }                   # finishes normally, or auto-backgrounds after 30s
bash { command: "npm run dev", background: true }   # returns bg-1 immediately
shell_status { id: "bg-1" }                         # status and output so far
shell_status { id: "bg-1", wait: 60 }               # wait up to 60s for completion
shell_status                                       # list background jobs
shell_kill { id: "bg-1" }                           # kill the job's process tree
```

`/shell-bg` lists jobs; `/shell-bg kill bg-1` stops one.

| Situation | Behaviour |
|---|---|
| Command finishes before the threshold | Returns its result, without registering a background job. |
| Interactive command reaches the threshold | Registers an `fg-N` job and returns immediately. |
| `background: true` | Registers a `bg-N` job immediately. |
| `timeout: N` | Kills the process tree after N seconds, including after backgrounding. |
| Foreground call is aborted | Kills its process tree. A job already backgrounded is independent of the turn's abort signal. |

### Job IDs and widget

IDs are assigned **only when a command enters the background**:

- `bg-N`: explicitly backgrounded with `background: true`.
- `fg-N`: started in the foreground and automatically backgrounded.

Each prefix has its own session counter: `bg-1`, `fg-1`, `bg-2`, `fg-2`. Ordinary foreground runs consume neither counter and never appear in `shell_status`, the widget, or persisted job records. IDs and both counters survive `/reload`; existing background jobs retain their IDs.

The widget above the editor shows running background jobs and jobs completed in the last 15 seconds. Its prefixes distinguish automatic from explicit backgrounding.

## Completion delivery

An uncollected background result is pushed into the conversation once, after the current agent run settles, or immediately if the agent is idle. Collecting a finished job with `shell_status` suppresses duplicate delivery. Polling a still-running job does not cancel its eventual delivery.

Under headless `pi -p`, auto-backgrounding is disabled because the session does not remain alive after the prompt completes. Explicit backgrounding still works; collect results within the same run using `shell_status { id, wait: N }`. `wait` is clamped to 0–300 seconds.

Set `deliverResults: false` to disable automatic delivery while keeping the widget and status tools.

## Execution and output

The extension replaces Pi's bash execution to support returning before a command finishes. It reuses Pi's shell resolution, working directory, managed-bin PATH, and `PI_*` session variables. Inherited editor, pager, prompt, CI, and terminal settings are left alone.

Commands run in detached POSIX process groups. Timeout, cancellation, `shell_kill`, and session shutdown kill the whole group with `SIGKILL`, matching Pi's immediate process-tree cancellation. Foreground calls retain only private in-memory state for execution and cleanup; they are not persisted as jobs.

Stdout and stderr share a log file descriptor from launch, preserving output from before a command backgrounds. Model-facing results contain the last `tailBytes` bytes (64 KiB by default), with a path to the full log when truncated. ANSI escapes and control characters are cleaned, and carriage-return progress redraws are collapsed to their final frame. There is no line filtering, deduplication, or JSON test-report rewriting. The log on disk keeps the original bytes.

Programmatic callers receive Pi-compatible `structuredContent`: `output`, `truncated`, optional `full_output_path`, `exit_code`, and `wall_time_seconds`, plus `status` and an optional `job_id`. Only backgrounded commands have a `job_id`; `exit_code` is absent while running. Structured output is bounded to 1 MiB, retaining the head and tail when truncated.

## Session lifecycle

Background jobs are mirrored to sidecars in a private temporary directory keyed by the Pi session id. Sessions do not see or kill one another's jobs.

On `/reload`, background jobs survive and the new extension instance adopts them. Other session shutdowns kill running jobs and remove the session directory. Any still-active foreground calls are cancelled rather than handed off. Records from another host process are marked `orphaned` and never treated as live processes to signal. Stray directories from crashes are swept after seven days.

Supported platforms are Linux, macOS, and other POSIX systems. There are no runtime dependencies beyond the Pi host.

## Settings

Use `.pi/shell-background.json` for project settings or `<agentDir>/shell-background.json` for global settings:

```json
{
  "autoBackgroundMs": 30000,
  "tailBytes": 65536,
  "maxBackground": 8,
  "deliverResults": true
}
```

- `autoBackgroundMs`: foreground duration before automatic backgrounding. `0` disables it; explicit backgrounding still works. `SHELL_BG_MS` overrides it for one run.
- `tailBytes`: maximum bytes read for model-facing output tails.
- `maxBackground`: maximum simultaneously running background jobs. At capacity, explicit background requests are refused; foreground commands continue running without automatically backgrounding. Foreground runs do not count toward the limit.
- `deliverResults`: whether finished background jobs automatically deliver their results.

Invalid values fall back to defaults or are clamped with a warning. Unknown settings produce a warning.

## License

MIT
