import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, resolveSettings, DEFAULT_SETTINGS } from "../src/config.ts";

function configDirs(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "sbg-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  return { cwd, agentDir, projectFile: join(cwd, ".pi", "shell-background.json"), globalFile: join(agentDir, "shell-background.json") };
}

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

test("settings loading prefers project over global without merging, and falls back for unreadable files", (t) => {
  const { cwd, agentDir, projectFile, globalFile } = configDirs(t);
  assert.deepEqual(loadSettings(cwd, agentDir, {}), { settings: DEFAULT_SETTINGS, warnings: [] });
  writeFileSync(globalFile, JSON.stringify({ maxBackground: 2, tailBytes: 8192 }));
  assert.equal(loadSettings(cwd, agentDir, {}).settings.maxBackground, 2);

  writeFileSync(projectFile, JSON.stringify({ maxBackground: 4 }));
  const project = loadSettings(cwd, agentDir, {});
  assert.equal(project.settings.maxBackground, 4);
  assert.equal(project.settings.tailBytes, DEFAULT_SETTINGS.tailBytes, "global values do not leak into project settings");

  rmSync(projectFile);
  mkdirSync(projectFile); // A directory cannot be read as a settings file.
  assert.equal(loadSettings(cwd, agentDir, {}).settings.maxBackground, 2);
  rmSync(globalFile);
  assert.deepEqual(loadSettings(cwd, agentDir, {}), { settings: DEFAULT_SETTINGS, warnings: [] });
});

test("malformed project settings warn and use defaults rather than silently loading global settings", (t) => {
  const { cwd, agentDir, projectFile, globalFile } = configDirs(t);
  writeFileSync(globalFile, JSON.stringify({ maxBackground: 2 }));
  writeFileSync(projectFile, "{broken");
  const loaded = loadSettings(cwd, agentDir, {});
  assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
  assert.equal(loaded.warnings.length, 1);
  assert.ok(loaded.warnings[0]!.includes(projectFile), "the warning identifies the broken file");
});
