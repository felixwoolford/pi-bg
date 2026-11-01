import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, DEFAULT_SETTINGS } from "../src/config.ts";

test("defaults disable automatic backgrounding", () => {
  const { settings, warnings } = resolveSettings(undefined, {});
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(settings.autoBackgroundMs, 0);
  assert.deepEqual(warnings, []);
});

test("valid overrides are taken", () => {
  const { settings } = resolveSettings({ tailBytes: 8192, maxBackground: 3 }, {});
  assert.equal(settings.tailBytes, 8192);
  assert.equal(settings.maxBackground, 3);
});

test("legacy auto-background settings cannot enable automatic backgrounding", () => {
  for (const value of [0, 100, 30_000, 999_999_999, "soon"]) {
    const { settings, warnings } = resolveSettings({ autoBackgroundMs: value }, {});
    assert.equal(settings.autoBackgroundMs, 0);
    assert.ok(warnings.some((w) => w.includes("autoBackgroundMs") && w.includes("deprecated") && w.includes("ignored")));
  }
});

test("out-of-range and wrong-type values fall back with a warning", () => {
  const { settings, warnings } = resolveSettings({ maxBackground: 999, tailBytes: "big" }, {});
  assert.equal(settings.maxBackground, 64, "clamped to max");
  assert.equal(settings.tailBytes, DEFAULT_SETTINGS.tailBytes, "kept default");
  assert.ok(warnings.some((w) => w.includes("clamped")));
  assert.ok(warnings.some((w) => w.includes("must be a number")));
});

test("maxBackground defaults to 8 and clamps to 1–64", () => {
  assert.equal(resolveSettings(undefined, {}).settings.maxBackground, 8);
  assert.equal(resolveSettings({ maxBackground: 3 }, {}).settings.maxBackground, 3);
  const low = resolveSettings({ maxBackground: 0 }, {});
  assert.equal(low.settings.maxBackground, 1);
  assert.ok(low.warnings.some((w) => w.includes("maxBackground")));
  assert.equal(resolveSettings({ maxBackground: 1000 }, {}).settings.maxBackground, 64);
});

test("unknown keys warn and are ignored", () => {
  const { warnings } = resolveSettings({ nope: 1 }, {});
  assert.ok(warnings.some((w) => w.includes('unknown setting "nope"')));
});

test("SHELL_BG_MS is deprecated and cannot enable automatic backgrounding", () => {
  for (const value of ["5000", "0", "soon"]) {
    const { settings, warnings } = resolveSettings(undefined, { SHELL_BG_MS: value });
    assert.equal(settings.autoBackgroundMs, 0);
    assert.ok(warnings.some((w) => w.includes("SHELL_BG_MS") && w.includes("deprecated") && w.includes("ignored")));
  }
});

test("deliverResults defaults to true and accepts a boolean", () => {
  assert.equal(resolveSettings(undefined, {}).settings.deliverResults, true);
  assert.equal(resolveSettings({ deliverResults: false }, {}).settings.deliverResults, false);
});

test("a non-boolean deliverResults warns and keeps the default", () => {
  const { settings, warnings } = resolveSettings({ deliverResults: "no" }, {});
  assert.equal(settings.deliverResults, true);
  assert.ok(warnings.some((w) => w.includes("deliverResults")));
});
