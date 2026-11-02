# shell-background

Explicit background shell jobs in [pi](https://github.com/earendil-works/pi). Pass `background: true` to launch a command and get its job ID immediately. Foreground calls wait for completion unless **you** transfer one with `/bg`.

**Automatic backgrounding is disabled and scheduled for removal.** Elapsed time is not evidence that the agent can safely proceed without a command's result. Old settings cannot re-enable it.

## Usage

```text
bash { command: "npm run build" }                   # await the prerequisite result
bash { command: "npm run dev", background: true }   # return bg-1 immediately
bash { command: "npm test", background: true, delivery: "followUp" } # full result after current work
shell_status { id: "bg-1" }                         # status and output so far
shell_status { id: "bg-1", wait: 60 }               # wait up to 60s for completion
shell_status                                       # list background jobs
shell_kill { id: "bg-1" }                           # kill the job's process tree
```

Prefer explicit backgrounding for servers, watchers, and tasks independent of the agent's next action. Keep prerequisite builds, installs, migrations, and checks in the foreground, or collect their background result before relying on it. A returned job ID is not evidence of success.

`/shell-bg` lists jobs; `/shell-bg kill bg-1` stops one.

### Background and steer a running call

While a foreground shell command runs, submit:

```text
/bg
/bg Review the documentation meanwhile. Do not edit files until the build finishes.
```

Pi executes `/bg` immediately, even while the agent is awaiting the tool. It transfers the existing process without restarting or cancelling it, assigns an `fg-N` job ID, and releases that tool call. With multiple foreground calls, a picker lets you choose one; the others remain awaited. Consequently, an outstanding sibling tool call can still hold up the agent's next response.

The extension queues a visible steering message **before** releasing the tool. With `/bg` alone it contains only the backgrounding template. With prose it contains your text followed by that template. The template identifies the job, states that its result is still pending, and explains how to collect it; it does not imply success or permission to perform dependent work. The tool result carries the current output and job handle. Completion arrives separately, using the original call's `delivery` choice (default `notify`). `/bg` itself always steers immediately, regardless of that choice.

Cancelling the picker changes nothing. If the selected call finishes or is cancelled while the picker is open, no other task is substituted. If no foreground call is available or the background limit is full, the extension notifies you and sends no steering message. Without a UI, multiple calls cannot be selected and are left unchanged.

| Situation | Behaviour |
|---|---|
| Foreground command | Awaits completion, with no public job record. |
| `/bg [message]` | Transfers the selected foreground call and queues steering. |
| `background: true` | Registers a `bg-N` job immediately. |
| `timeout: N` | Kills the process tree after N seconds, including after backgrounding. |
| Foreground call is aborted | Kills its process tree. A job already backgrounded is independent of the turn's abort signal. |

### Job IDs and widget

IDs are assigned **only when a command enters the background**:

- `bg-N`: explicitly backgrounded at launch with `background: true`.
- `fg-N`: started in the foreground and transferred by the user with `/bg`.

Each prefix has its own session counter: `bg-1`, `fg-1`, `bg-2`, `fg-2`. Ordinary foreground runs consume neither counter and never appear in `shell_status`, the widget, or persisted job records. IDs and both counters survive `/reload`; legacy automatically backgrounded jobs retain their IDs.

The widget above the editor shows each job's delivery mode: `[notify]`, `[steer]`, or `[follow-up]`. Its prefixes distinguish jobs backgrounded at launch from transferred foreground jobs.

Finished results remain visible as **ready** until the full result is handed off or collected with `shell_status`; a readiness notice alone does not clear them. Afterwards, the row remains for 15 seconds measured from handoff/collection, not process completion. Handoff means delivery to the conversation, not proof the model has considered the result. Jobs remain available through `shell_status` after their widget rows disappear.

## Completion delivery

Each call can choose `delivery`. The tool schema explains each choice in plain English:

| Choice | While the agent is working |
|---|---|
| `notify` (default) | Tell me once that the result is ready; give me the full output when I finish, unless I collect it first. |
| `steer` | Give me the full result at the next safe opportunity, even while I am working. |
| `followUp` | Let me finish my current work, then give me the full result, without an earlier notice. |

All three deliver the full result immediately if Pi's `ctx.isIdle()` reports that the agent is idle. Activity comes from Pi directly, not extension-maintained lifecycle flags. A safe opportunity during work is the end of the current tool batch, before the next model request. A follow-up arrives when the agent would otherwise finish and return control to you; it does not wait for your next message.

Ready notices contain job IDs, not command output. Several ready jobs share one short steering notice. The notice is sent **once per job**, never repeatedly until acknowledged. A notice does not consume the full result.

Collecting a finished job with `shell_status` suppresses its automatic full-result delivery, even after a ready notice. Full follow-ups are assembled from the still-uncollected results at the delivery boundary, not queued irrevocably in advance. Polling a running job does not cancel its eventual delivery. The delivery choice and notice state survive `/reload`, including completed results awaiting a follow-up.

In interactive sessions with automatic delivery enabled, no status check is required. Use `shell_status` for progress or to explicitly wait for a result.

Under headless `pi -p`, collect results within the same run using `shell_status { id, wait: N }`: the session does not remain alive after the prompt completes. `wait` is clamped to 0–300 seconds.

Set `deliverResults: false` to disable all automatic completion delivery and ready notices while keeping the widget and status tools. This does not suppress user-triggered `/bg` steering messages.

## Execution and output

The extension replaces Pi's bash execution to support returning before a command finishes. It reuses Pi's shell resolution, working directory, managed-bin PATH, and `PI_*` session variables. Inherited editor, pager, prompt, CI, and terminal settings are left alone.

Commands run in detached POSIX process groups. Timeout, cancellation, `shell_kill`, and session shutdown kill the whole group with `SIGKILL`, matching Pi's immediate process-tree cancellation. Foreground calls retain only private in-memory state for execution and cleanup; they are not persisted as jobs.

Stdout and stderr share a log file descriptor from launch, preserving output from before a command backgrounds. Model-facing results contain the last `tailBytes` bytes (64 KiB by default), with a path to the full log when truncated. ANSI escapes and control characters are cleaned, and carriage-return progress redraws are collapsed to their final frame. There is no line filtering, deduplication, or JSON test-report rewriting. The log on disk keeps the original bytes.

Programmatic callers receive Pi-compatible `structuredContent`: `output`, `truncated`, optional `full_output_path`, `exit_code`, and `wall_time_seconds`, plus `status` and an optional `job_id`. Only backgrounded commands have a `job_id`; `exit_code` is absent while running. Structured output is bounded to 1 MiB, retaining the head and tail when truncated. Background tool-result details use `fromForeground`, replacing the old `auto` flag.

## Session lifecycle

Background jobs are mirrored to sidecars in a private temporary directory keyed by the Pi session ID. Sessions do not see or kill one another's jobs.

On `/reload`, background jobs survive and the new extension instance adopts them. Other session shutdowns kill running jobs and remove the session directory. Any still-active foreground calls are cancelled rather than handed off. Records from another host process are marked `orphaned` and never treated as live processes to signal. Stray directories from crashes are swept after seven days.

Supported platforms are Linux, macOS, and other POSIX systems. There are no runtime dependencies beyond the Pi host.

## Settings

Use `.pi/shell-background.json` for project settings or `<agentDir>/shell-background.json` for global settings:

```json
{
  "tailBytes": 65536,
  "maxBackground": 8,
  "deliverResults": true
}
```

- `tailBytes`: maximum bytes read for model-facing output tails.
- `maxBackground`: maximum simultaneously running background jobs. At capacity, explicit background requests and `/bg` transfers are refused; foreground commands remain awaited. Foreground runs do not count toward the limit.
- `deliverResults`: whether finished background jobs automatically deliver their results.

`autoBackgroundMs` and `SHELL_BG_MS` are **deprecated, ignored, and scheduled for removal**. Automatic backgrounding stays disabled even if old configuration sets a positive threshold. Remove those entries to silence the deprecation warning.

Invalid values fall back to defaults or are clamped with a warning. Unknown settings produce a warning.

## License

MIT
