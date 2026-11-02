/**
 * Settings from `.pi/shell-background.json` (project) or
 * `<agentDir>/shell-background.json` (global). Invalid values warn and fall back
 * to defaults rather than taking the extension down.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ShellBgSettings {
  /** @deprecated Ignored. Automatic backgrounding is disabled; remove in a future release. */
  autoBackgroundMs: number;
  /** Bytes of the log tail shown in a status/collect result. */
  tailBytes: number;
  /** Maximum live background jobs. Foreground execution does not count. */
  maxBackground: number;
  /** Automatically report uncollected results using each job's delivery choice. */
  deliverResults: boolean;
}

export const DEFAULT_SETTINGS: ShellBgSettings = {
  autoBackgroundMs: 0,
  tailBytes: 64 * 1024,
  maxBackground: 8,
  deliverResults: true,
};

type NumericKey = "tailBytes" | "maxBackground";

const LIMITS: Record<NumericKey, { min: number; max: number }> = {
  tailBytes: { min: 1024, max: 4 * 1024 * 1024 },
  maxBackground: { min: 1, max: 64 },
};

export function resolveSettings(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { settings: ShellBgSettings; warnings: string[] } {
  const settings: ShellBgSettings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];

  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push("settings file is not an object — ignored");
    } else {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        // TODO: Remove these compatibility settings in a future release. They
        // must never re-enable time-based backgrounding, even in old configs.
        if (key === "autoBackgroundMs") {
          warnings.push('"autoBackgroundMs" is deprecated and ignored; automatic backgrounding is disabled and scheduled for removal');
          continue;
        }
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
          warnings.push(`unknown setting "${key}"`);
          continue;
        }
        if (key === "deliverResults") {
          if (typeof value === "boolean") settings.deliverResults = value;
          else warnings.push(`"deliverResults" must be true or false — using ${DEFAULT_SETTINGS.deliverResults}`);
          continue;
        }
        const name = key as NumericKey;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          warnings.push(`"${key}" must be a number — using ${DEFAULT_SETTINGS[name]}`);
          continue;
        }
        settings[name] = clamp(name, value, warnings);
      }
    }
  }

  if (env.SHELL_BG_MS !== undefined && env.SHELL_BG_MS !== "") {
    warnings.push("SHELL_BG_MS is deprecated and ignored; automatic backgrounding is disabled and scheduled for removal");
  }

  return { settings, warnings };
}

/** First readable file wins: project settings replace, rather than merge with, global settings. */
export function loadSettings(
  cwd: string,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { settings: ShellBgSettings; warnings: string[] } {
  for (const file of [join(cwd, ".pi", "shell-background.json"), join(agentDir, "shell-background.json")]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      return resolveSettings(JSON.parse(raw), env);
    } catch (err) {
      return {
        settings: DEFAULT_SETTINGS,
        warnings: [`${file}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }
  return resolveSettings(undefined, env);
}

function clamp(name: NumericKey, value: number, warnings: string[]): number {
  const { min, max } = LIMITS[name];
  const c = Math.round(Math.min(max, Math.max(min, value)));
  if (c !== value) warnings.push(`"${name}" clamped to ${c} (allowed ${min}–${max})`);
  return c;
}
