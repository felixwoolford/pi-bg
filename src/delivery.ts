/** Completion delivery, collection, and duplicate suppression for one extension instance. */
import type { CustomMessageEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ShellBgSettings } from "./config.ts";
import { deliveryMessage, readyMessage, DELIVERY_TYPE, READY_TYPE, formatResult } from "./format.ts";
import { isFinished, type Job } from "./types.ts";

interface DeliveryOptions {
  // Read live session state rather than capturing startup defaults or stale contexts.
  getSettings(): Pick<ShellBgSettings, "deliverResults" | "tailBytes">;
  isIdle(): boolean;
  isHandedOff(): boolean;
  persist(job: Job): void;
  onDelivered(): void;
}

export function createDeliveryController(pi: Pick<ExtensionAPI, "sendMessage">, options: DeliveryOptions) {
  // Full results stay withdrawable until delivery: a later status read can
  // collect them before the follow-up boundary. A notice is not collection.
  const pending = new Set<Job>();
  // Concurrent shell_status waits own their results. Auto-delivery must not
  // race their return and cause another turn acknowledging the same output.
  const waiters = new Map<string, number>();

  function resultMessage(job: Job): Omit<CustomMessageEntryDraft, "type"> {
    return {
      customType: DELIVERY_TYPE,
      content: deliveryMessage(job.id, formatResult(job, options.getSettings().tailBytes)),
      display: true,
      details: { id: job.id, status: job.status, exitCode: job.exitCode },
    };
  }

  function markDelivered(job: Job): void {
    job.delivered = true;
    job.deliveredAt ??= Date.now();
    pending.delete(job);
    options.persist(job);
    options.onDelivered();
  }

  function enqueue(job: Job): void {
    if (options.isHandedOff() || job.delivered || !options.getSettings().deliverResults) return;
    pending.add(job);
    if (options.isIdle()) drain("idle");
  }

  function drain(phase: "idle" | "turn" | "followUp"): CustomMessageEntryDraft[] {
    if (options.isHandedOff() || !options.getSettings().deliverResults) return [];
    const entries: CustomMessageEntryDraft[] = [];
    const notices: Job[] = [];
    for (const job of [...pending]) {
      if (job.delivered) {
        pending.delete(job);
        continue;
      }
      if ((waiters.get(job.id) ?? 0) > 0) continue;
      if (phase !== "turn" || job.delivery === "steer") {
        if (phase === "followUp") entries.push({ type: "custom_message", ...resultMessage(job) });
        else pi.sendMessage(resultMessage(job), { deliverAs: "steer", triggerTurn: true });
        markDelivered(job);
      } else if (job.delivery === "notify" && !job.notified) {
        notices.push(job);
      }
    }
    if (notices.length > 0) {
      // One batched steering notice, never repeated merely because the agent
      // continued without collecting. Full output remains pending.
      pi.sendMessage({
        customType: READY_TYPE,
        content: readyMessage(notices.map((job) => job.id)),
        display: true,
        details: { ids: notices.map((job) => job.id) },
      }, { deliverAs: "steer", triggerTurn: true });
      for (const job of notices) {
        job.notified = true;
        options.persist(job);
      }
    }
    return entries;
  }

  function schedule(job: Job, exit: Promise<unknown>): void {
    exit
      .then(() => {
        // After reload, only flush final status for the new instance to read.
        // Never mark delivered or send through the old instance's stale API.
        if (options.isHandedOff()) {
          options.persist(job);
          return;
        }
        enqueue(job);
      })
      .catch(() => {
        // A stale API may throw after reload. Status can still collect output.
      });
  }

  /** Hold automatic delivery for a status wait; release in its finally block. */
  function hold(job: Job): () => void {
    waiters.set(job.id, (waiters.get(job.id) ?? 0) + 1);
    return () => {
      waiters.set(job.id, Math.max(0, (waiters.get(job.id) ?? 1) - 1));
    };
  }

  function collect(job: Job): void {
    // A running poll must never cancel the promised completion delivery.
    if (isFinished(job)) markDelivered(job);
  }

  return { enqueue, drain, schedule, hold, collect };
}
