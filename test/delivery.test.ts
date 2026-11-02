import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { createDeliveryController } from "../src/delivery.ts";
import type { Job } from "../src/types.ts";

function job(): Job {
  return {
    id: "bg-1", command: "echo result", cwd: "/x", pid: 123, status: "done", exitCode: 0, signal: null,
    logPath: "/no/log", startedAt: 1000, endedAt: 2000, background: true, fromForeground: false,
    delivery: "notify", notified: false, delivered: false,
  };
}

function controller(sendMessage: ExtensionAPI["sendMessage"]) {
  return createDeliveryController({ sendMessage }, {
    getSettings: () => DEFAULT_SETTINGS,
    isIdle: () => false,
    isHandedOff: () => false,
    persist: () => {},
    onDelivered: () => {},
  });
}

test("concurrent status waits suppress automatic delivery until every wait releases", () => {
  const sent: unknown[] = [];
  const delivery = controller((message) => { sent.push(message); });
  const result = job();
  const releaseFirst = delivery.hold(result);
  const releaseSecond = delivery.hold(result);
  delivery.enqueue(result);
  delivery.drain("turn");
  assert.deepEqual(delivery.drain("followUp"), []);
  assert.equal(sent.length, 0);

  releaseFirst();
  delivery.drain("turn");
  assert.deepEqual(delivery.drain("followUp"), []);
  assert.equal(sent.length, 0, "one remaining wait still owns the result");

  releaseSecond();
  delivery.drain("turn");
  assert.equal(sent.length, 1, "only a readiness notice is sent");
  assert.equal(result.delivered, false);
  delivery.collect(result);
  assert.equal(result.delivered, true);
  assert.deepEqual(delivery.drain("followUp"), [], "collection withdraws the full automatic result");
  assert.equal(sent.length, 1);
});

test("a failed send leaves the result uncollected and available for retry", () => {
  let fail = true;
  const sent: unknown[] = [];
  const delivery = controller((message) => {
    if (fail) throw new Error("send failed");
    sent.push(message);
  });
  const result = job();
  result.delivery = "steer";
  delivery.enqueue(result);
  assert.throws(() => delivery.drain("turn"), /send failed/);
  assert.equal(result.delivered, false);
  assert.equal(result.deliveredAt, undefined);

  fail = false;
  delivery.drain("turn");
  assert.equal(result.delivered, true);
  assert.equal(typeof result.deliveredAt, "number");
  delivery.drain("idle");
  assert.equal(sent.length, 1, "successful retry delivers the result exactly once");
});
