// Project config: `.llm-audit.json`, or an "llm-audit" key in package.json.
//
// It exists so the same policy applies in the pre-commit hook, in CI, and at
// a developer's terminal without repeating flags in three places. Flags on
// the command line still win.
//
// Strict on purpose: an unknown key or a misspelled rule id is an error. A
// typo in a security tool's config must never read as "configured".

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const CONFIG_FILE = ".llm-audit.json";

const FAIL_LEVELS = ["any", "error", "warning", "info", "never"];
const SEV_LEVELS = ["error", "warning", "info"];
const KEYS = ["$schema", "failOn", "severity", "disable", "ignore", "baseline"];

class ConfigError extends Error {}

// Walk up from the working directory to the filesystem root, stopping at the
// first directory that has either a config file or a package.json with our
// key. A monorepo package can override its root this way.
function find(start) {
  // Paths in messages are relative to where the user is standing.
  const show = (p) => relative(resolve(start), p) || p;
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) return { file: show(file), read: () => JSON.parse(readFileSync(file, "utf8")) };
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8"));
        if (json && typeof json === "object" && "llm-audit" in json) {
          return { file: `${show(pkg)} ("llm-audit" key)`, read: () => json["llm-audit"] };
        }
      } catch {
        // A broken package.json is someone else's error to report.
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Load and validate the project config.
 * Returns { file, failOn?, severity?, disable: [], ignore: [], baseline? }
 * or { file: null, disable: [], ignore: [] } when there is none.
 * Throws ConfigError with a message meant for the user.
 */
export function loadConfig(cwd, knownRules) {
  const found = find(cwd);
  if (!found) return { file: null, disable: [], ignore: [] };
  let raw;
  try {
    raw = found.read();
  } catch (err) {
    throw new ConfigError(`${found.file}: not valid JSON (${err.message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${found.file}: expected an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) {
      throw new ConfigError(`${found.file}: unknown key "${key}". Known keys: ${KEYS.slice(1).join(", ")}`);
    }
  }
  const out = { file: found.file, disable: [], ignore: [] };
  if (raw.failOn !== undefined) {
    if (!FAIL_LEVELS.includes(raw.failOn)) {
      throw new ConfigError(`${found.file}: failOn must be one of ${FAIL_LEVELS.join(", ")}`);
    }
    out.failOn = raw.failOn;
  }
  if (raw.severity !== undefined) {
    if (!SEV_LEVELS.includes(raw.severity)) {
      throw new ConfigError(`${found.file}: severity must be one of ${SEV_LEVELS.join(", ")}`);
    }
    out.severity = raw.severity.toUpperCase();
  }
  const strings = (key) => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.trim())) {
      throw new ConfigError(`${found.file}: ${key} must be an array of strings`);
    }
    return v.map((s) => s.trim());
  };
  out.disable = strings("disable");
  for (const id of out.disable) {
    if (!knownRules.includes(id)) {
      throw new ConfigError(`${found.file}: disable lists unknown rule "${id}". Run \`llm-audit rules\` for the list.`);
    }
  }
  out.ignore = strings("ignore");
  if (raw.baseline !== undefined) {
    if (typeof raw.baseline !== "string" || !raw.baseline.trim()) {
      throw new ConfigError(`${found.file}: baseline must be a git ref, like "origin/main"`);
    }
    out.baseline = raw.baseline.trim();
  }
  return out;
}

export { ConfigError };
