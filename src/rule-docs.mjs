// Rule teaching material, parsed from docs/RULES.md.
//
// The docs are the single source of truth for *why* a rule exists — what it
// catches, why an AI assistant tends to write the pattern, and how to fix it.
// Rather than duplicating that prose into the YAML or into the report
// generator, both read it from here. If the docs improve, every surface does.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// `- **Label:** text` … continuation lines are indented.
const FIELD_RE = /^-\s+\*\*([^:*]+):\*\*\s*([\s\S]*)$/;

const FIELD_KEYS = {
  owasp: "owasp",
  cwe: "cwe",
  catches: "catches",
  "why ai writes this": "whyAi",
  fix: "fix",
  status: "status",
};

// Markdown emphasis and code ticks are noise once the text is being rendered
// into a terminal or into HTML that styles its own code spans.
function flatten(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    // The docs write these as sentence fragments continuing the bold label.
    // Standing alone in a report or a `rules <id>` section, they read as
    // sentences, so give them a capital.
    .replace(/^([a-z])/, (m) => m.toUpperCase());
}

/**
 * Parse docs/RULES.md into { [ruleId]: { owasp, cwe, catches, whyAi, fix } }.
 * Returns an empty object when the docs are not present — every consumer
 * degrades to whatever the rule YAML carries rather than failing.
 */
export function parseRuleDocs(docsPath) {
  if (!docsPath || !existsSync(docsPath)) return {};
  let text;
  try {
    text = readFileSync(docsPath, "utf8");
  } catch {
    return {};
  }

  const docs = {};
  // Each rule is a `#### \`rule-id\`` section running to the next heading.
  const sections = text.split(/^#### `([^`]+)`\s*$/m);
  for (let i = 1; i < sections.length; i += 2) {
    const ruleId = sections[i];
    const body = (sections[i + 1] || "").split(/^#{1,4}\s/m)[0];

    const entry = {};
    // Bullets can wrap across lines; a new bullet starts at column 0 with `-`.
    const bullets = body
      .split(/\n(?=-\s+\*\*)/)
      .map((b) => b.trim())
      .filter(Boolean);
    for (const bullet of bullets) {
      const m = bullet.match(FIELD_RE);
      if (!m) continue;
      const key = FIELD_KEYS[m[1].trim().toLowerCase()];
      if (!key) continue;
      entry[key] = flatten(m[2]);
    }
    if (Object.keys(entry).length) docs[ruleId] = entry;
  }
  return docs;
}

/**
 * Read the shipped rule YAMLs for the facts the pack itself defines:
 * severity, OWASP id, CWEs, references, and the message shown on a finding.
 * Deliberately a shallow scrape — pulling in a YAML parser to read five
 * fields would be a dependency we do not otherwise need.
 */
export function readRuleMeta(rulesDir) {
  const meta = {};
  if (!existsSync(rulesDir)) return meta;
  for (const file of readdirSync(rulesDir).filter((f) => f.endsWith(".yaml"))) {
    let text;
    try {
      text = readFileSync(join(rulesDir, file), "utf8");
    } catch {
      continue;
    }
    const id = (text.match(/^\s*-\s*id:\s*(\S+)/m) || [])[1] ||
      file.replace(/\.yaml$/, "");
    const cweBlock = text.match(/cwe:\s*\n((?:\s*-\s*.*\n)+)/);
    meta[id] = {
      ruleId: id,
      severity: (text.match(/^\s*severity:\s*(\S+)/m) || [])[1] || "INFO",
      owasp: (text.match(/owasp-llm:\s*(\S+)/) || [])[1] || null,
      cwe: cweBlock
        ? cweBlock[1]
            .split("\n")
            .map((l) => (l.match(/-\s*["']?([^"'\s]+)["']?/) || [])[1])
            .filter(Boolean)
        : [],
      references: [...text.matchAll(/^\s*-\s*(https?:\/\/\S+)\s*$/gm)].map(
        (m) => m[1]
      ),
    };
  }
  return meta;
}

// Fixture markers are Semgrep's annotation protocol, not teaching material.
const FIXTURE_NOISE = /^\s*\/\/\s*(@ts-nocheck|ok:|ruleid:|todoruleid:)/;

/**
 * The pack ships a proven-safe implementation for every rule: the `safe.*`
 * fixture, which `npm test` asserts produces zero findings. That makes it the
 * one example of the fix we can show without hand-waving — it is executable,
 * and it is verified on every commit.
 *
 * Returns { name, code } or null.
 */
export function readSafeExample(fixturesDir, ruleId) {
  for (const ext of ["ts", "tsx", "js"]) {
    const path = join(fixturesDir, ruleId, `safe.${ext}`);
    if (!existsSync(path)) continue;
    let code;
    try {
      code = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    const lines = code.split("\n").filter((l) => !FIXTURE_NOISE.test(l));
    // Drop the blank line the stripped header leaves behind.
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return { name: `test/fixtures/${ruleId}/safe.${ext}`, code: lines.join("\n") };
  }
  return null;
}
