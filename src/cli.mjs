#!/usr/bin/env node
// llm-audit — CLI entry
//
// Subcommands:
//   demo              Run the rule pack against bundled vulnerable fixtures
//   scan [paths...]   Run the rule pack with semgrep against given paths (default: .)
//   init [--force]    Install a husky pre-commit hook + a GitHub Action workflow
//   rules             List the rule IDs in this pack
//
// Flags:
//   --version         Print version and exit
//   -h, --help        Show usage
//
// Semgrep is a peer dependency. Install with `brew install semgrep` or
// `pipx install semgrep`. The CLI shells out to it.

import { spawnSync } from "node:child_process";
import {
  readdirSync,
  rmSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir, homedir } from "node:os";
import { parseRuleDocs, readRuleMeta, readSafeExample } from "./rule-docs.mjs";
import { renderHtmlReport } from "./report.mjs";
import { buildPayload, learnLink, redact, DEFAULT_LEARN_URL } from "./share.mjs";
import { loadConfig, ConfigError, CONFIG_FILE } from "./config.mjs";
import { applySuppressions } from "./suppress.mjs";
import { inGitHubActions, writeAnnotations, writeStepSummary } from "./github.mjs";
import { renderLearnPage } from "./learn.mjs";
import { LESSONS, groupFindings, fixPrompt } from "./lessons.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");
const RULES_DIR = join(PKG_ROOT, "rules");
const TEMPLATES_DIR = join(PKG_ROOT, "templates");
const SKILLS_DIR = join(PKG_ROOT, "skills");
const RULE_DOCS = join(PKG_ROOT, "docs", "RULES.md");
const FIXTURES_DIR = join(PKG_ROOT, "test", "fixtures");

function getVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PKG_ROOT, "package.json"), "utf8")
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const KNOWN_SUBCOMMANDS = ["demo", "scan", "learn", "prompt", "init", "uninstall", "rules", "doctor"];

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Closest candidate within an edit-distance budget, or null. Rule IDs are
// long, so the budget scales with the length of what was typed.
function nearest(input, candidates, budget) {
  const limit = budget ?? Math.max(3, Math.round(input.length / 3));
  const ranked = candidates
    .map((c) => [c, levenshtein(input, c)])
    .filter(([, d]) => d <= limit)
    .sort((a, b) => a[1] - b[1]);
  return ranked.length ? ranked[0][0] : null;
}

// Words people reach for that are not our word. Edit distance never connects
// "delete" to "uninstall", and leaving someone at a dead end over vocabulary
// is a bad trade for six lines of table.
const SUBCOMMAND_ALIASES = {
  delete: "uninstall",
  remove: "uninstall",
  rm: "uninstall",
  uninstal: "uninstall",
  setup: "init",
  install: "init",
  check: "scan",
  run: "scan",
  lint: "scan",
  audit: "scan",
  list: "rules",
  lessons: "learn",
  open: "learn",
  fix: "prompt",
  help: "--help",
  version: "--version",
};

function suggestSubcommand(input) {
  return SUBCOMMAND_ALIASES[input] || nearest(input, KNOWN_SUBCOMMANDS, 3);
}

// Numeric semver compare, e.g. "0.0.10" > "0.0.9" → positive.
// Ignores prerelease tags; we don't ship those.
function compareSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// One-shot, on-demand version check. Used only by `doctor`. We deliberately
// do not call this on every run — see the README "Versions and updates"
// section for the rationale (security-tool optics, predictability, no
// background phoning home).
async function fetchLatestVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch("https://registry.npmjs.org/llm-audit/latest", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!r.ok) return null;
    const d = await r.json();
    // Shallow validation is intentional: the npm registry is already the
    // trust root for this package's distribution, so a stricter check on
    // the version string wouldn't change the threat model.
    return typeof d?.version === "string" ? d.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ensureSemgrep() {
  const r = spawnSync("semgrep", ["--version"], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error("error: `semgrep` isn't installed, or isn't on your PATH.");
    console.error("install: `brew install semgrep` or `pipx install semgrep`");
    process.exit(127);
  }
}

// Stable JSON envelope schema. Bump schemaVersion when you make any
// breaking change to the shape below. Consumers (CI, agents, dashboards)
// can pin to a schemaVersion they understand.
const JSON_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Semgrep invocation + our own human renderer.
//
// We do not use Semgrep's text formatter. It derives the displayed rule ID
// from the *config path*, so an installed package renders every finding as
// `Users.you..npm._npx.<hash>.node_modules.llm-audit.rules.hardcoded-llm-api-key`
// instead of `hardcoded-llm-api-key`. That is unreadable, it leaks the user's
// home directory into terminal output and CI logs, and there is no Semgrep
// flag to turn it off. Rendering from `--json` ourselves also drops Semgrep's
// upsell footer and lets the finding carry its OWASP mapping, which is the
// thing this pack exists to communicate.
// ---------------------------------------------------------------------------

// A scan of a real repo takes seconds, and silence for seconds reads as a
// hang. Braille spinner on a TTY only; erased on completion so nothing is left
// behind in the transcript, and never written when output is piped.
function withProgress(label, fn) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return fn();
  const frames = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
  let i = 0;
  const draw = () => {
    process.stderr.write(`\r${c.dim}${frames[i++ % frames.length]} ${label}${c.reset}`);
  };
  draw();
  const timer = setInterval(draw, 80);
  try {
    return fn();
  } finally {
    clearInterval(timer);
    process.stderr.write("\r\u001b[2K");
  }
}

function runSemgrepJson(targetPaths, { cwd, exclude = [], label } = {}) {
  // `--` locks interpretation: any path starting with `-` is a path, not a
  // semgrep flag. Defends against a wrapper or piped input injecting flags
  // via path arguments.
  const ruleCount = readdirSync(RULES_DIR).filter((f) => f.endsWith(".yaml")).length;
  const r = withProgress(
    label || `scanning ${targetPaths.join(" ")} \u00b7 ${ruleCount} rules`,
    () => spawnSync(
    "semgrep",
    [
      "--config", RULES_DIR,
      "--json",
      "--metrics=off",
      "--quiet",
      ...exclude.flatMap((g) => ["--exclude", g]),
      "--",
      ...targetPaths,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd }
    )
  );

  if (r.status !== 0 && r.status !== 1) {
    // --quiet means semgrep can fail with nothing on stderr. Exiting silently
    // leaves the user with a status code and no idea what happened.
    const detail = (r.stderr || "").trim();
    process.stderr.write(
      detail
        ? detail + "\n"
        : `error: semgrep exited ${r.status} without a message.\n` +
          "run `llm-audit doctor` to check the engine and the rule pack.\n"
    );
    process.exit(r.status ?? 1);
  }

  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch (e) {
    process.stderr.write(`error: could not parse semgrep output: ${e.message}\n`);
    process.exit(1);
  }
  if (!out || typeof out !== "object" || !Array.isArray(out.results)) {
    process.stderr.write("error: unexpected semgrep output shape\n");
    process.exit(1);
  }
  return out;
}

// Semgrep's JSON substitutes the literal string "requires login" for the
// matched source when the caller is not authenticated to semgrep.dev. The code
// is the most useful part of a finding, and this tool has no account to log in
// with, so read the span off disk ourselves and fall back to whatever Semgrep
// gave us.
// Which code does this report describe? A scan forwarded to a reviewer, or
// filed as a compliance artifact, is only as useful as its answer to that
// question. Read it from git when there is a git; degrade silently when there
// is not, because plenty of scans run on unpacked tarballs and CI checkouts.
function readProvenance(cwd = process.cwd()) {
  const git = (args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : null;
  };
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  const commit = git(["rev-parse", "HEAD"]);
  if (!commit) return null; // a repo with no commits yet
  const status = git(["status", "--porcelain"]);
  return {
    commit,
    shortCommit: commit.slice(0, 8),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) || null,
    // A dirty tree means the report describes something no commit captures.
    // Saying so is the difference between a record and a snapshot.
    dirty: status !== null && status.length > 0,
  };
}

// Read the matched span plus a couple of lines either side. A single matched
// line is enough to locate a finding and rarely enough to judge it.
function readContext(path, startLine, endLine, pad = 2) {
  if (!path || !startLine) return null;
  try {
    const all = readFileSync(path, "utf8").split("\n");
    const from = Math.max(1, startLine - pad);
    const to = Math.min(all.length, (endLine ?? startLine) + pad);
    return {
      from,
      matchFrom: startLine,
      matchTo: endLine ?? startLine,
      // A hardcoded key is the finding, not something to reprint. Every
      // surface that shows code (terminal, HTML, JSON, learn page) goes
      // through here or readSnippet, so this is the one place to redact.
      lines: all.slice(from - 1, to).map(redact),
    };
  } catch {
    return null;
  }
}

function readSnippet(path, startLine, endLine, fallback) {
  const given = (fallback || "").trim();
  if (given && given !== "requires login") return fallback.split("\n").map(redact).join("\n");
  if (!path || !startLine) return "";
  try {
    const all = readFileSync(path, "utf8").split("\n");
    return all.slice(startLine - 1, (endLine ?? startLine)).map(redact).join("\n");
  } catch {
    return "";
  }
}

function ruleDocsUrl(ruleId) {
  return `https://github.com/Javierlozo/llm-audit/blob/main/docs/RULES.md#${ruleId}`;
}

function buildEnvelope(semgrepOut, targetPaths) {
  // Semgrep reports one result per matching pattern, so a rule with two
  // patterns that both match the same span yields two identical findings.
  // Collapse those: same rule, same file, same span is one finding. Distinct
  // rules on the same line stay distinct — that is real, not duplication.
  const seen = new Set();
  const findings = [];

  for (const f of semgrepOut.results) {
    // Semgrep namespaces check_id by config path; keep only the rule ID.
    const ruleId = ((f.check_id || "") + "").split(".").pop();
    const key = `${ruleId}\u0000${f.path}\u0000${f.start?.line}\u0000${f.end?.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      ruleId,
      severity: f.extra?.severity || "INFO",
      owasp: f.extra?.metadata?.["owasp-llm"] || null,
      cwe: Array.isArray(f.extra?.metadata?.cwe) ? f.extra.metadata.cwe : [],
      path: f.path,
      startLine: f.start?.line,
      endLine: f.end?.line,
      message: ((f.extra?.message || "") + "").trim(),
      lines: readSnippet(f.path, f.start?.line, f.end?.line, f.extra?.lines),
      // Additive since schemaVersion 1.
      docsUrl: ruleDocsUrl(ruleId),
    });
  }

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: "llm-audit", version: getVersion() },
    // Additive since schemaVersion 1: null outside a git checkout.
    repo: readProvenance(),
    scannedPaths: targetPaths,
    summary: { findings: findings.length },
    findings,
  };
}

// Colour only when writing to a terminal, and honour the NO_COLOR convention
// (https://no-color.org). Piped output stays plain so it greps and diffs.
// FORCE_COLOR opts a non-TTY consumer back in — CI runners that render ANSI,
// and our own README asset generator, which needs the coloured human output
// without allocating a pty.
// Elapsed time is genuinely useful and genuinely volatile. Anything that
// renders output into a committed artifact — the README hero, a golden test —
// sets this so the same input produces the same bytes.
const DETERMINISTIC = Boolean(process.env.LLM_AUDIT_DETERMINISTIC);

const COLOR =
  (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR)) &&
  !process.env.NO_COLOR;
const c = {
  reset: COLOR ? "\u001b[0m" : "",
  bold: COLOR ? "\u001b[1m" : "",
  dim: COLOR ? "\u001b[2m" : "",
  red: COLOR ? "\u001b[31m" : "",
  green: COLOR ? "\u001b[32m" : "",
  yellow: COLOR ? "\u001b[33m" : "",
  blue: COLOR ? "\u001b[34m" : "",
  magenta: COLOR ? "\u001b[35m" : "",
};

// ── Identity ────────────────────────────────────────────────────────────────
// No ASCII wordmark. The project's identity is the authority-boundary mark in
// assets/, not a block-letter rendering of its own name — see ff24b0e. What
// the two human-facing surfaces get instead is a single line that says what
// the tool is, which is the part a first-time reader actually needs.
function banner(tagline) {
  // Piped or captured means no escapes and no surprises, unless the consumer
  // explicitly asked for colour.
  if (!process.stdout.isTTY && !process.env.FORCE_COLOR) return;
  console.log("");
  console.log(
    `  ${c.bold}llm-audit${c.reset} ${c.dim}v${getVersion()}${c.reset}` +
      `  ${c.dim}\u00b7${c.reset}  ${tagline}`
  );
  console.log("");
}

// ── Severity ────────────────────────────────────────────────────────────────
// Severity is what a reader triages on, so it drives the order of the report
// and the shape of the summary. The labels are Semgrep's own — we do not
// re-grade someone else's finding into a scarier word.
const SEV_RANK = { ERROR: 0, WARNING: 1, INFO: 2 };
const SEV_COLOR = { ERROR: () => c.red, WARNING: () => c.yellow, INFO: () => c.blue };
const SEV_MARK = { ERROR: "\u2717", WARNING: "!", INFO: "\u00b7" };

function sevRank(sev) {
  return SEV_RANK[sev] ?? SEV_RANK.INFO;
}

function sevTag(sev) {
  const color = (SEV_COLOR[sev] || SEV_COLOR.INFO)();
  return `${color}${(sev || "INFO").toLowerCase().padEnd(7)}${c.reset}`;
}

function wrap(text, width, indent) {
  const out = [];
  // Rule messages are authored with paragraphs and `-` bullets. Both carry
  // meaning — the bullets are the remediation steps — so rewrap within a
  // block rather than flattening everything into one paragraph.
  const blocks = text
    .replace(/\n(?=\s*-\s)/g, "\n\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const bullet = /^\s*-\s+/.test(block);
    const hanging = bullet ? indent + "  " : indent;
    const words = block.replace(/^\s*-\s+/, "").split(/\s+/).filter(Boolean);
    let line = "";
    let first = true;
    for (const word of words) {
      const prefix = first ? (bullet ? indent + "- " : indent) : hanging;
      if (line && (prefix + line + " " + word).length > width) {
        out.push(prefix + line);
        line = word;
        first = false;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push((first ? (bullet ? indent + "- " : indent) : hanging) + line);
    // Consecutive bullets read as one list; only paragraphs get breathing room.
    if (!bullet) out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

// Absolute paths in output are noise at best and a home-directory disclosure
// at worst (screenshots, CI logs, pasted bug reports). Show the shortest
// honest form: relative to the package root for bundled fixtures, otherwise
// relative to the working directory when that is shorter than the absolute.
function displayPath(path, stripPrefix) {
  if (!path) return path;
  if (stripPrefix && path.startsWith(stripPrefix + "/")) {
    return path.slice(stripPrefix.length + 1);
  }
  if (!isAbsolute(path)) return path;
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") && rel.length < path.length ? rel : path;
}

// The matched span in colour, its neighbours dimmed. Context is what turns a
// line number into something a reader can judge without opening the file.
function printSnippet(f) {
  const ctx = readContext(f.path, f.startLine, f.endLine);
  if (!ctx) {
    if (!f.lines) return;
    console.log("");
    f.lines.replace(/\n+$/, "").split("\n").forEach((line, i) => {
      const n = String((f.startLine ?? 1) + i).padStart(5);
      console.log(`  ${c.dim}${n} \u2502${c.reset} ${c.magenta}${line}${c.reset}`);
    });
    return;
  }
  console.log("");
  ctx.lines.forEach((line, i) => {
    const n = ctx.from + i;
    const matched = n >= ctx.matchFrom && n <= ctx.matchTo;
    console.log(
      `  ${c.dim}${String(n).padStart(5)} \u2502${c.reset} ` +
        (matched ? `${c.magenta}${line}${c.reset}` : `${c.dim}${line}${c.reset}`)
    );
  });
}

// Above this many findings the full rationale stops being a lesson and starts
// being a wall. Past it we switch to one line per finding and say so, unless
// the user explicitly asked for --verbose.
const COMPACT_THRESHOLD = 15;

// One line per finding: severity, rule, location. The rationale lives one
// command away (`llm-audit rules <id>`) or in the HTML report.
function renderCompact(envelope, meta = {}) {
  const { findings } = envelope;
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.path)) byFile.set(f.path, []);
    byFile.get(f.path).push(f);
  }
  const files = [...byFile.entries()].sort((a, b) => {
    const worst = (list) => Math.min(...list.map((f) => sevRank(f.severity)));
    return worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]);
  });

  console.log("");
  for (const [path, fileFindings] of files) {
    console.log(`${c.bold}${displayPath(path, meta.stripPrefix)}${c.reset}`);

    // Six rows that differ only by line number are one fact, not six. Collapse
    // a rule's repeats within a file onto one row and list the lines.
    const byRule = new Map();
    for (const f of fileFindings) {
      const row = byRule.get(f.ruleId) || {
        ruleId: f.ruleId,
        severity: f.severity,
        owasp: f.owasp,
        lines: [],
      };
      row.lines.push(f.startLine);
      if (sevRank(f.severity) < sevRank(row.severity)) row.severity = f.severity;
      byRule.set(f.ruleId, row);
    }

    const rows = [...byRule.values()].sort(
      (a, b) =>
        sevRank(a.severity) - sevRank(b.severity) ||
        Math.min(...a.lines) - Math.min(...b.lines)
    );

    for (const row of rows) {
      const mark = (SEV_COLOR[row.severity] || SEV_COLOR.INFO)() +
        (SEV_MARK[row.severity] || SEV_MARK.INFO) + c.reset;
      // Two rules can match different spans on one line; as a list of places
      // to look, that line is one entry.
      const lines = [...new Set(row.lines)].sort((a, b) => a - b);
      // Past a handful the exact numbers stop being scannable, and the count
      // is the part that matters.
      const where =
        lines.length > 6
          ? `${lines.length} lines from ${lines[0]}`
          : `line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}`;
      console.log(
        `  ${mark} ${sevTag(row.severity)} ${c.bold}${row.ruleId}${c.reset}` +
          `${row.owasp ? ` ${c.yellow}${row.owasp}${c.reset}` : ""}` +
          `${c.dim}  ${where}${c.reset}`
      );
    }
    console.log("");
  }
}

// Grouped by rule instead of by file: the shape you want when you are fixing
// a class of problem across a codebase rather than cleaning one file.
function renderByRule(envelope, meta, width) {
  const byRule = new Map();
  for (const f of envelope.findings) {
    if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
    byRule.get(f.ruleId).push(f);
  }
  const rules = [...byRule.entries()].sort(
    (a, b) =>
      sevRank(a[1][0].severity) - sevRank(b[1][0].severity) ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0])
  );

  for (const [ruleId, hits] of rules) {
    const first = hits[0];
    const mark = (SEV_COLOR[first.severity] || SEV_COLOR.INFO)() +
      (SEV_MARK[first.severity] || SEV_MARK.INFO) + c.reset;
    console.log("");
    console.log(
      `${mark} ${sevTag(first.severity)} ${c.bold}${ruleId}${c.reset}` +
        `${first.owasp ? `  ${c.yellow}${first.owasp}${c.reset}` : ""}` +
        `${c.dim}  ${hits.length} occurrence${hits.length === 1 ? "" : "s"}${c.reset}`
    );

    // The rationale belongs to the rule, so under this grouping it is stated
    // once by construction rather than by suppression.
    const [risk, ...rest] = first.message.split(/\n(?=Fix:)/);
    console.log(wrap(risk, width - 4, "    "));
    for (const block of rest) {
      console.log("");
      console.log(`${c.blue}${wrap(block, width - 4, "    ")}${c.reset}`);
    }

    for (const f of hits.sort(
      (a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine
    )) {
      console.log("");
      console.log(
        `  ${c.bold}${displayPath(f.path, meta.stripPrefix)}${c.reset}` +
          `${c.dim}:${f.startLine}${c.reset}`
      );
      printSnippet(f);
    }
  }
}

function renderHuman(envelope, meta = {}) {
  // COLUMNS wins when set, so a piped or generated render is reproducible
  // instead of inheriting whatever terminal happened to run it.
  const width = Math.min(
    Math.max(Number(process.env.COLUMNS) || process.stdout.columns || 80, 60),
    100
  );
  const { findings } = envelope;
  const ruleCount =
    meta.ruleCount ??
    readdirSync(RULES_DIR).filter((f) => f.endsWith(".yaml")).length;

  if (findings.length === 0) {
    console.log("");
    if (meta.filtered) {
      // "Clean" would overclaim: only part of the pack was allowed to speak.
      console.log(
        `${c.green}\u2713 0 findings${c.reset} for the selected ` +
          `${meta.filterLabel || "filter"}.` +
          `${c.dim}  Run \`llm-audit scan\` unfiltered for the whole picture.${c.reset}`
      );
      return;
    }
    console.log(
      `${c.green}\u2713 0 findings${c.reset} \u2014 clean.` +
        `${c.dim}  ${ruleCount} rules run${c.reset}`
    );
    console.log("");
    console.log(
      `${c.dim}To see what these rules catch on deliberately vulnerable code:${c.reset}`
    );
    console.log("  npx llm-audit demo");
    return;
  }

  if (meta.compact) {
    renderCompact(envelope, meta);
  } else if (meta.by === "rule") {
    renderByRule(envelope, meta, width);
  } else {
    // Group by file so a reader fixes one file at a time, then put the files
    // holding the worst finding first — the top of the report is the work that
    // matters most, not whichever path sorted first.
    const byFile = new Map();
    for (const f of findings) {
      if (!byFile.has(f.path)) byFile.set(f.path, []);
      byFile.get(f.path).push(f);
    }
    const files = [...byFile.entries()].sort((a, b) => {
      const worst = (list) => Math.min(...list.map((f) => sevRank(f.severity)));
      return worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]);
    });

    // A rule that fires ten times does not need its rationale printed ten
    // times. The first occurrence teaches; the rest just point at a line.
    const explained = new Set();

    for (const [path, fileFindings] of files) {
      const sorted = fileFindings.sort(
        (a, b) => sevRank(a.severity) - sevRank(b.severity) || a.startLine - b.startLine
      );
      console.log("");
      console.log(
        `${c.bold}${displayPath(path, meta.stripPrefix)}${c.reset}` +
          `${c.dim}  ${sorted.length} finding${sorted.length === 1 ? "" : "s"}${c.reset}`
      );

      for (const f of sorted) {
        const mark = (SEV_COLOR[f.severity] || SEV_COLOR.INFO)() +
          (SEV_MARK[f.severity] || SEV_MARK.INFO) + c.reset;
        const owasp = f.owasp ? `  ${c.yellow}${f.owasp}${c.reset}` : "";
        const repeat = explained.has(f.ruleId);
        console.log("");
        console.log(
          `  ${mark} ${sevTag(f.severity)} ${c.bold}${f.ruleId}${c.reset}${owasp}` +
            `${c.dim}  line ${f.startLine}${c.reset}`
        );

        if (repeat) {
          // Already explained above in this run; keep the evidence, drop the essay.
          console.log(
            `${c.dim}      same rule as above \u2014 see the first occurrence for the fix${c.reset}`
          );
        } else {
          explained.add(f.ruleId);
          // The message carries the risk and the canonical fix. It is the whole
          // product for a reader who has never seen this rule before.
          const [risk, ...rest] = f.message.split(/\n(?=Fix:)/);
          console.log(wrap(risk, width - 6, "      "));
          for (const block of rest) {
            console.log("");
            console.log(`${c.blue}${wrap(block, width - 6, "      ")}${c.reset}`);
          }
        }

        printSnippet(f);
      }
    }
  }

  // Summary: totals a human can act on, and a breakdown a triager can plan
  // around. Counts are only printed for severities that actually occurred.
  const counts = new Map();
  for (const f of findings) {
    counts.set(f.severity, (counts.get(f.severity) || 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => sevRank(a[0]) - sevRank(b[0]))
    .map(([sev, n]) => {
      const color = (SEV_COLOR[sev] || SEV_COLOR.INFO)();
      return `${color}${n} ${sev.toLowerCase()}${c.reset}`;
    })
    .join(`${c.dim} \u00b7 ${c.reset}`);

  const fileCount = new Set(findings.map((f) => f.path)).size;
  const ruleIds = new Set(findings.map((f) => f.ruleId));

  console.log("");
  console.log(`${c.dim}${"\u2500".repeat(Math.min(width, 60))}${c.reset}`);
  console.log(
    `${c.bold}${findings.length} finding${findings.length === 1 ? "" : "s"}${c.reset}` +
      `  ${breakdown}` +
      `${c.dim}  in ${fileCount} file${fileCount === 1 ? "" : "s"}` +
      ` \u00b7 ${ruleIds.size} of ${ruleCount} rules fired` +
      `${meta.elapsedMs && !DETERMINISTIC ? ` \u00b7 ${(meta.elapsedMs / 1000).toFixed(1)}s` : ""}${c.reset}`
  );

  // One next action, not a list. The worst rule with the most occurrences is
  // where a reader gets the most risk removed per unit of work.
  const worst = [...counts.keys()].sort((a, b) => sevRank(a) - sevRank(b))[0];
  const ranked = new Map();
  for (const f of findings.filter((f) => f.severity === worst)) {
    ranked.set(f.ruleId, (ranked.get(f.ruleId) || 0) + 1);
  }
  const [topRule, topCount] = [...ranked.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0];
  console.log(
    `${c.bold}Start here:${c.reset} ${topRule}` +
      `${c.dim} \u2014 ${topCount} ${worst.toLowerCase()}` +
      `${topCount === 1 ? "" : "s"}, the largest cluster.` +
      `  \`llm-audit rules ${topRule}\`${c.reset}`
  );
  if (meta.filtered) {
    console.log(
      `${c.yellow}Filtered view${c.reset}${c.dim} \u2014 other rules or severities ` +
        `may still have findings. Run \`llm-audit scan\` unfiltered for the whole picture.${c.reset}`
    );
  }
  if (meta.compact) {
    console.log(
      `${c.dim}Compact view.${c.reset} ` +
        `\`llm-audit rules <rule-id>\` explains one rule; ` +
        `${c.dim}--verbose${c.reset} prints every rationale inline.`
    );
  }
  console.log(
    `${c.dim}Why each rule exists:${c.reset} ` +
      `https://github.com/Javierlozo/llm-audit/blob/main/docs/RULES.md`
  );
  if (meta.failOn !== undefined) {
    console.log(
      `${c.dim}Gate this in CI:${c.reset} ` +
        `llm-audit scan --fail-on error  ${c.dim}(or --sarif for code scanning)${c.reset}`
    );
  }
}

// Write the standalone HTML report and tell the user where it landed. The
// path goes to stderr when stdout is carrying machine output, so `scan --json
// --html r.html > findings.json` still produces clean JSON on stdout.
function writeHtmlReport(envelope, htmlPath, targetPaths, filters = {}) {
  const out = resolve(htmlPath);
  const examples = {};
  for (const ruleId of new Set(envelope.findings.map((f) => f.ruleId))) {
    const example = readSafeExample(FIXTURES_DIR, ruleId);
    if (example) examples[ruleId] = example;
  }
  const html = renderHtmlReport(envelope, {
    examples,
    filters,
    docs: parseRuleDocs(RULE_DOCS),
    ruleMeta: readRuleMeta(RULES_DIR),
    ruleCount: readdirSync(RULES_DIR).filter((f) => f.endsWith(".yaml")).length,
    displayPath: (p) => displayPath(p),
    readContext: (f) => readContext(f.path, f.startLine, f.endLine),
    version: getVersion(),
  });
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
  } catch (err) {
    process.stderr.write(`error: could not write ${out}: ${err.message}\n`);
    process.exit(1);
  }
  const note =
    `\nReport written to ${displayPath(out)}` +
    ` \u2014 open it in a browser, attach it to a PR, or keep it as a CI artifact.\n`;
  if (process.stdout.isTTY || process.env.FORCE_COLOR) process.stdout.write(note);
  else process.stderr.write(note);
}

// ── The learn page ──────────────────────────────────────────────────────────
// The terminal says what failed. The learn page teaches it: one lesson per
// kind of mistake, every place it occurs, how it gets exploited, and a prompt
// to fix it. Every page is the same static file (learn.mjs); a scan reaches it
// either embedded in a private temp file (`learn`, `--open`) or in the URL
// fragment of a share link (`--link`; nothing is uploaded, see share.mjs).

// A person at a terminal, as opposed to a hook, a pipe, or a CI runner. Only
// they get the lesson view, the saved scan, and the learn hint; everything
// else keeps the compact per-file output that hooks and CI logs rely on.
function interactive() {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

// Hints name the command the way the user ran it. Under npx or an npm
// script, a bare `llm-audit` may not be on PATH.
function self() {
  return process.env.npm_command ? "npx llm-audit" : "llm-audit";
}

// OSC 8 makes "Open the lessons" itself clickable, instead of a few
// kilobytes of URL wrapping across the screen. Only for terminals known to
// support it: elsewhere the escape is printed as garbage. FORCE_HYPERLINK is
// the convention other CLIs use to override detection either way.
function supportsHyperlinks() {
  const force = process.env.FORCE_HYPERLINK;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (!process.stdout.isTTY || process.env.CI) return false;
  const term = process.env.TERM_PROGRAM || "";
  return (
    ["iTerm.app", "vscode", "WezTerm", "ghostty", "Hyper", "Tabby"].includes(term) ||
    Boolean(process.env.WT_SESSION || process.env.KITTY_WINDOW_ID || process.env.KONSOLE_VERSION)
  );
}

const hyperlink = (url, text) => `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;

function termWidth() {
  return Math.min(Math.max(Number(process.env.COLUMNS) || process.stdout.columns || 80, 60), 100);
}

// ── The last scan, per project ──────────────────────────────────────────────
// `learn` and `prompt` work from the last scan of this project, so a scan's
// lessons are one short command away instead of a long URL. The file holds
// code snippets (secrets redacted), so it lives in the user's cache directory
// with owner-only permissions, never in the project.

function cacheDir() {
  if (process.env.LLM_AUDIT_CACHE_DIR) return process.env.LLM_AUDIT_CACHE_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "llm-audit");
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "llm-audit", "Cache");
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "llm-audit");
}

// One saved scan per project: the git root if there is one, so `learn` works
// from any subdirectory, otherwise the working directory.
function lastScanFile() {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  let root = top.status === 0 ? top.stdout.trim() : process.cwd();
  try {
    root = realpathSync(root);
  } catch {}
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(cacheDir(), "scans", `${key}.json`);
}

function saveLastScan(payload) {
  try {
    const file = lastScanFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), payload }), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // A read-only home directory costs the user a shortcut, not the scan.
  }
}

function loadLastScan() {
  try {
    const saved = JSON.parse(readFileSync(lastScanFile(), "utf8"));
    return saved && saved.payload ? saved : null;
  } catch {
    return null;
  }
}

// Saved payload rows back into the finding shape lessons work with.
function payloadFindings(payload) {
  return (payload.f || []).map(([ruleId, severity, path, startLine, endLine]) => ({
    ruleId,
    severity,
    path,
    startLine,
    endLine,
  }));
}

function learnBase(flag) {
  return flag || process.env.LLM_AUDIT_LEARN_URL || DEFAULT_LEARN_URL;
}

function shareOptions(stripPrefix, filtered) {
  return {
    context: (f) => {
      const ctx = readContext(f.path, f.startLine, f.endLine);
      return ctx ? { from: ctx.from, lines: ctx.lines } : null;
    },
    display: (p) => displayPath(p, stripPrefix),
    filtered,
  };
}

// The full shareable URL. Printed only on request (--link), because it is
// long and it carries code snippets.
function printLearnLink(envelope, { base, stripPrefix, filtered } = {}) {
  const { url, detail } = learnLink(envelope, {
    ...shareOptions(stripPrefix, filtered),
    base: learnBase(base),
  });
  console.log("");
  if (!url) {
    console.log(
      `${c.bold}Share link:${c.reset} too many findings to fit in a link. ` +
        `\`${self()} learn\` opens them from a local file.`
    );
    return;
  }
  const trimmed =
    detail === "context"
      ? ""
      : detail === "match"
        ? " Surrounding lines were left out to keep it short."
        : " Code was left out to keep it short.";
  console.log(`${c.bold}Share link:${c.reset}`);
  console.log(url);
  const note =
    "The results are in the part after the #, which browsers never send to a server. " +
    `It includes code snippets, with secrets redacted.${trimmed}`;
  console.log(`${c.dim}${wrap(note, termWidth(), "")}${c.reset}`);
}

// The one next step after an interactive scan. `learnCmd` lets demo point at
// its own page instead of the project's saved scan.
function printLearnFooter(envelope, { base, stripPrefix, filtered, learnCmd } = {}) {
  const cmd = learnCmd || `${self()} learn`;
  const has = envelope.findings.length > 0;
  console.log("");
  if (!has) {
    console.log(`${c.dim}See what was checked:${c.reset}  ${cmd}`);
    return;
  }
  console.log(`Read the lessons, with your code and a fix prompt for each:`);
  if (supportsHyperlinks()) {
    const { url } = learnLink(envelope, { ...shareOptions(stripPrefix, filtered), base: learnBase(base) });
    if (url) {
      console.log(`  ${c.yellow}${hyperlink(url, "Open the lessons ↗")}${c.reset}${c.dim}  or ${cmd}${c.reset}`);
    } else {
      console.log(`  ${cmd}`);
    }
  } else {
    console.log(`  ${c.bold}${cmd}${c.reset}`);
  }
  if (!learnCmd) {
    console.log(`${c.dim}Copy a fix prompt for your AI tool:${c.reset}  ${self()} prompt 1`);
  }
}

// Write a learn page to a private temp directory and hand it to the system
// browser. `scan` is a share payload, or null for the lesson library. The
// note goes to stderr when stdout is carrying machine output.
function openPage(scan) {
  const html = renderLearnPage({ scan, version: getVersion(), base: learnBase() });
  let file;
  try {
    const dir = mkdtempSync(join(tmpdir(), "llm-audit-learn-"));
    file = join(dir, "index.html");
    writeFileSync(file, html, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`error: could not write the learn page: ${err.message}\n`);
    return false;
  }

  const say = (text) =>
    process.stdout.isTTY || process.env.FORCE_COLOR
      ? process.stdout.write(text)
      : process.stderr.write(text);

  // Tests and headless boxes set this to get the file without a browser.
  if (process.env.LLM_AUDIT_NO_BROWSER) {
    say(`\nLearn page written to ${file}\n`);
    return true;
  }
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", file]]
        : ["xdg-open", [file]];
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 });
  say(
    r.status === 0
      ? `\nOpened the lessons in your browser. ${c.dim}${file}${c.reset}\n`
      : `\nCould not open a browser. The learn page is at ${file}\n`
  );
  return r.status === 0;
}

function openLearnPage(envelope, { stripPrefix, filtered } = {}) {
  return openPage(buildPayload(envelope, { ...shareOptions(stripPrefix, filtered), detail: "context" }));
}

// ── The lesson view ─────────────────────────────────────────────────────────
// The default at a terminal. Same shape as the learn page: a headline, then
// one numbered entry per kind of mistake with every place it occurs. The
// numbers match the page and `prompt <n>`.

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function renderLessons(envelope, meta = {}) {
  const width = termWidth();
  const { findings } = envelope;
  const paths = (envelope.scannedPaths || []).map((p) => displayPath(p, meta.stripPrefix)).join(", ") || ".";
  const repo = envelope.repo;
  const where =
    meta.label ||
    `scan of ${paths}` +
      (repo ? ` · ${repo.branch || "detached"} @ ${repo.shortCommit}${repo.dirty ? " (uncommitted changes)" : ""}` : "");
  const elapsed = meta.elapsedMs && !DETERMINISTIC ? ` · ${(meta.elapsedMs / 1000).toFixed(1)}s` : "";

  console.log("");
  console.log(`${c.bold}llm-audit${c.reset}${c.dim}  ·  ${where}${elapsed}${c.reset}`);
  console.log("");

  const ruleCount = meta.ruleCount ?? readdirSync(RULES_DIR).filter((f) => f.endsWith(".yaml")).length;
  if (findings.length === 0) {
    if (meta.filtered) {
      console.log(`${c.green}✓ 0 findings${c.reset} for the selected ${meta.filterLabel || "filter"}.`);
      console.log(`${c.dim}Other rules may still have findings. Run \`${self()} scan\` unfiltered for the whole picture.${c.reset}`);
      return;
    }
    console.log(`${c.green}${c.bold}No mistakes found${c.reset}`);
    console.log(`All ${ruleCount} checks passed. That means no obvious holes, not proof there are none.`);
    return;
  }

  const { groups, unknown } = groupFindings(findings, LESSONS);
  // A rule with no lesson still gets an entry, under its own name.
  for (const f of unknown) {
    groups.push({ lesson: { title: f.ruleId, slug: f.ruleId }, hits: [f], severity: f.severity });
  }
  const counts = new Map();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) || 0) + 1);
  const sevWords = [...counts.entries()]
    .sort((a, b) => sevRank(a[0]) - sevRank(b[0]))
    .map(([sev, n]) => `${(SEV_COLOR[sev] || SEV_COLOR.INFO)()}${plural(n, sev.toLowerCase())}${c.reset}`);
  const sevText = sevWords.length > 1 ? `${sevWords.slice(0, -1).join(", ")} and ${sevWords.at(-1)}` : sevWords[0];
  const fileCount = new Set(findings.map((f) => f.path)).size;

  console.log(`${c.bold}${plural(groups.length, "mistake")} in ${plural(findings.length, "place")}${c.reset}`);
  console.log(`${sevText} across ${plural(fileCount, "file")}`);

  const MAX_FILES = 6;
  groups.forEach((g, i) => {
    const no = String(i + 1).padStart(2);
    const sev = (g.severity || "INFO").toLowerCase();
    const right = `${sev}  ${plural(g.hits.length, "place")}`;
    const title = g.lesson.title;
    const gap = Math.max(2, width - 4 - title.length - right.length);
    console.log("");
    console.log(
      `${c.bold}${no}  ${title}${c.reset}${" ".repeat(gap)}` +
        `${(SEV_COLOR[g.severity] || SEV_COLOR.INFO)()}${sev}${c.reset}${c.dim}  ${plural(g.hits.length, "place")}${c.reset}`
    );

    const byFile = new Map();
    for (const f of g.hits) {
      const p = displayPath(f.path, meta.stripPrefix);
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(f.startLine);
    }
    const files = [...byFile.entries()];
    const shown = files.slice(0, MAX_FILES);
    const col = Math.min(Math.max(...shown.map(([p]) => p.length)), width - 16);
    for (const [p, lines] of shown) {
      const uniq = [...new Set(lines)].sort((a, b) => a - b);
      const list = uniq.length > 5 ? `${uniq.slice(0, 5).join(", ")}, …` : uniq.join(", ");
      console.log(`    ${p.padEnd(col)}  ${c.dim}${list}${c.reset}`);
    }
    if (files.length > MAX_FILES) {
      console.log(`    ${c.dim}and ${plural(files.length - MAX_FILES, "more file")}${c.reset}`);
    }
  });

  console.log("");
  console.log(`${c.dim}${"─".repeat(Math.min(width, 64))}${c.reset}`);
  if (meta.filtered) {
    console.log(
      `${c.yellow}Filtered view.${c.reset}${c.dim} Other rules or severities may still have findings.${c.reset}`
    );
  }
}

// ── learn and prompt ────────────────────────────────────────────────────────

function cmdLearn(args = []) {
  const share = args.includes("--link");
  for (const a of args) {
    if (a !== "--link") {
      process.stderr.write(`unknown flag for learn: ${a}\n`);
      process.stderr.write("learn takes only --link. run `llm-audit --help` for usage.\n");
      process.exit(2);
    }
  }
  const saved = loadLastScan();
  if (!saved) {
    console.log(
      `No scan saved for this project yet, so this is the lesson library.\n` +
        `${c.dim}Run \`${self()} scan\` at a terminal for lessons about your own code.${c.reset}`
    );
    openPage(null);
    return;
  }
  if (share) {
    const { url } = learnLinkFromPayload(saved.payload);
    if (!url) {
      process.stderr.write("too many findings to fit in a link.\n");
      process.exit(1);
    }
    console.log(url);
    return;
  }
  const when = new Date(saved.savedAt);
  const n = (saved.payload.f || []).length;
  console.log(
    `Lessons for your last scan ${c.dim}(${plural(n, "finding")}, ` +
      `${isNaN(when) ? "earlier" : when.toLocaleString()})${c.reset}`
  );
  openPage(saved.payload);
}

// A saved payload already holds the snippets and redactions, so the share
// link is built from it directly rather than from a fresh envelope.
function learnLinkFromPayload(payload) {
  const envelope = {
    tool: { version: payload.tool },
    repo: payload.repo,
    scannedPaths: payload.paths,
    findings: (payload.f || []).map(([ruleId, severity, path, startLine, endLine, from, lines]) => ({
      ruleId, severity, path, startLine, endLine, lines: lines.join("\n"), _ctx: { from, lines },
    })),
  };
  return learnLink(envelope, { context: (f) => f._ctx, base: learnBase(), filtered: payload.filtered });
}

function copyToClipboard(text) {
  const tries =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, a] of tries) {
    const r = spawnSync(cmd, a, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (r.status === 0) return true;
  }
  return false;
}

function cmdPrompt(args = []) {
  let check = false;
  let copy = null; // null: copy at a terminal, print when piped
  let n = null;
  for (const a of args) {
    if (a === "--check") check = true;
    else if (a === "--copy") copy = true;
    else if (a === "--no-copy") copy = false;
    else if (/^\d+$/.test(a)) n = Number(a);
    else {
      process.stderr.write(`unknown argument for prompt: ${a}\n`);
      process.stderr.write("usage: llm-audit prompt <lesson number> [--check] [--no-copy]\n");
      process.exit(2);
    }
  }

  const saved = loadLastScan();
  if (!saved) {
    process.stderr.write(`No scan saved for this project yet. Run \`${self()} scan\` at a terminal first.\n`);
    process.exit(1);
  }
  const { groups } = groupFindings(payloadFindings(saved.payload), LESSONS);
  if (!groups.length) {
    console.log("Your last scan found nothing to fix.");
    return;
  }

  if (n === null) {
    console.log("");
    console.log(`${c.bold}Which lesson?${c.reset}`);
    groups.forEach((g, i) => {
      console.log(`  ${String(i + 1).padStart(2)}  ${g.lesson.title}${c.dim}  ${plural(g.hits.length, "place")}${c.reset}`);
    });
    console.log("");
    console.log(`${c.dim}Then:${c.reset} ${self()} prompt 1  ${c.dim}(add --check for the prompt that checks the rest of the project)${c.reset}`);
    return;
  }
  if (n < 1 || n > groups.length) {
    process.stderr.write(`There is no lesson ${n}. Your last scan has ${plural(groups.length, "lesson")}.\n`);
    process.exit(2);
  }

  const g = groups[n - 1];
  const text = check ? g.lesson.askPrompt : fixPrompt(g.lesson, g.hits);
  const doCopy = copy ?? Boolean(process.stdout.isTTY);
  if (!process.stdout.isTTY) {
    // Piped: the prompt and nothing else, so `prompt 1 | claude -p` works.
    process.stdout.write(text + "\n");
    if (doCopy) copyToClipboard(text);
    return;
  }
  console.log("");
  console.log(`${c.dim}${check ? "Check prompt" : "Fix prompt"} · lesson ${n} · ${g.lesson.title}${c.reset}`);
  console.log(`${c.dim}${"─".repeat(Math.min(termWidth(), 64))}${c.reset}`);
  console.log(text);
  console.log(`${c.dim}${"─".repeat(Math.min(termWidth(), 64))}${c.reset}`);
  if (doCopy && copyToClipboard(text)) {
    console.log(`${c.green}✓ Copied.${c.reset} Paste it into Claude Code, Cursor, or whatever wrote the code.`);
  } else {
    console.log("Paste it into Claude Code, Cursor, or whatever wrote the code.");
  }
}

// What policy removed from this scan, said once, under the results.
function printScanNotes(envelope, notes, config) {
  const lines = [];
  for (const p of notes.problems) {
    lines.push(
      `${c.yellow}!${c.reset} llm-audit-ignore at ${displayPath(p.path)}:${p.line} ${p.message}`
    );
  }
  const sup = envelope.suppressed?.length || 0;
  if (sup) {
    lines.push(`${c.dim}${plural(sup, "finding")} suppressed by llm-audit-ignore comments. --json lists them with their reasons.${c.reset}`);
  }
  if (envelope.baseline) {
    lines.push(
      `${c.dim}Only findings new since ${envelope.baseline.ref}: ` +
        `${plural(envelope.baseline.hidden, "existing finding")} left out.${c.reset}`
    );
  }
  if (notes.disabled.length) {
    lines.push(`${c.dim}${plural(notes.disabled.length, "rule")} turned off in ${config.file}: ${notes.disabled.join(", ")}.${c.reset}`);
  }
  if (!lines.length) return;
  console.log("");
  for (const l of lines) console.log(l);
}

// Findings that already existed at `ref` are left out, so a repo can adopt
// the scan without first fixing its whole history. Semgrep has a baseline
// flag, but it refuses to run with uncommitted changes, which is the normal
// state at a terminal. So: check `ref` out into a temporary worktree, scan
// it with the same rules, and subtract by rule, file, and matched code.
// Line numbers are ignored, so code that moved is still old code.
function filterBaseline(findings, ref, targetPaths, exclude) {
  const fail = (msg) => {
    process.stderr.write(`error: ${msg}\n`);
    process.exit(2);
  };
  const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) fail("a baseline needs a git repository.");
  const root = realpathSync(top.stdout.trim());
  const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (sha.status !== 0) {
    fail(
      `baseline "${ref}" is not a commit in this repository.\n` +
        "In CI, fetch the history first (actions/checkout with fetch-depth: 0)."
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "llm-audit-baseline-"));
  const tree = join(dir, "tree");
  const add = git(["worktree", "add", "--detach", "--quiet", tree, sha.stdout.trim()], root);
  if (add.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    fail(`could not check out ${ref} for the baseline: ${(add.stderr || "").trim()}`);
  }

  const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
  const here = realpathSync(process.cwd());
  const rel = (p, base) => relative(base, resolve(base, p));
  try {
    const cwdInTree = join(tree, relative(root, here));
    const paths = targetPaths
      .map((p) => rel(p, here) || ".")
      .filter((p) => existsSync(join(cwdInTree, p)));
    const counts = new Map();
    if (paths.length) {
      const out = runSemgrepJson(paths, { cwd: cwdInTree, exclude, label: `scanning ${ref} for the baseline` });
      const seen = new Set();
      for (const r of out.results) {
        const ruleId = String(r.check_id || "").split(".").pop();
        const span = `${ruleId}\0${r.path}\0${r.start?.line}\0${r.end?.line}`;
        if (seen.has(span)) continue;
        seen.add(span);
        const text = readSnippet(join(cwdInTree, r.path), r.start?.line, r.end?.line, r.extra?.lines);
        const key = `${ruleId}\0${rel(r.path, cwdInTree)}\0${norm(text)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    let hidden = 0;
    const kept = findings.filter((f) => {
      const key = `${f.ruleId}\0${rel(f.path, here)}\0${norm(f.lines)}`;
      const n = counts.get(key) || 0;
      if (!n) return true;
      counts.set(key, n - 1);
      hidden++;
      return false;
    });
    return { findings: kept, hidden };
  } finally {
    git(["worktree", "remove", "--force", tree], root);
    rmSync(dir, { recursive: true, force: true });
    git(["worktree", "prune"], root);
  }
}

function cmdScan(args) {
  // Flags are validated before the environment is. A typo in a flag is the
  // user's mistake and should be reported as such even on a machine where
  // semgrep is missing — telling someone to install an engine when what they
  // actually did was misspell `--sarif` sends them down the wrong path.
  //
  // Parse our recognized flags out of args; everything else is a path.
  // We accept `--json` and `--sarif` as output-format selectors, plus
  // a defensive `--` literal that some users include explicitly.
  let outputFormat = "human"; // "human" | "json" | "sarif"
  let failOn = null; // null (config, else "any") | "any" | "error" | "warning" | "info" | "never"
  let baselineRef; // undefined (config) | null (--no-baseline) | git ref
  let github = true;
  let density = "auto"; // "auto" | "compact" | "verbose"
  let minSeverity = null; // null | "ERROR" | "WARNING" | "INFO"
  let htmlPath = null;
  let groupBy = null; // null (pick for the audience) | "lesson" | "file" | "rule"
  let linkMode = "auto"; // "auto" | "always" | "never"
  let openPage = false;
  let learnUrl = null;
  const ruleFilter = new Set();
  const paths = [];
  const FAIL_LEVELS = ["any", "error", "warning", "info", "never"];
  const SEV_LEVELS = ["error", "warning", "info"];
  const needsValue = (flag, inline, next) => {
    const value = inline !== null ? inline : next;
    if (!value) {
      process.stderr.write(`${flag} expects a value\n`);
      process.exit(2);
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--json") {
      outputFormat = "json";
    } else if (arg === "--sarif") {
      outputFormat = "sarif";
    } else if (arg === "--fail-on" || arg.startsWith("--fail-on=")) {
      // Exit-code policy. The default (`any`) is the safe one for a pre-commit
      // hook; a team ratcheting a legacy repo can start at `--fail-on error`
      // and tighten later without losing the report itself.
      const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : args[++i];
      if (!value || !FAIL_LEVELS.includes(value)) {
        process.stderr.write(
          `--fail-on expects one of: ${FAIL_LEVELS.join(", ")}\n`
        );
        process.exit(2);
      }
      failOn = value;
    } else if (arg === "--by" || arg.startsWith("--by=")) {
      const inline = arg.includes("=") ? arg.split("=").slice(1).join("=") : null;
      const value = needsValue("--by", inline, args[++i]);
      if (!["lesson", "file", "rule"].includes(value)) {
        process.stderr.write("--by expects one of: lesson, file, rule\n");
        process.exit(2);
      }
      groupBy = value;
    } else if (arg === "--compact") {
      density = "compact";
    } else if (arg === "--verbose") {
      density = "verbose";
    } else if (arg === "--rule" || arg.startsWith("--rule=")) {
      // Repeatable, and comma-separated for convenience: the two forms people
      // reach for without reading the help.
      const inline = arg.includes("=") ? arg.split("=").slice(1).join("=") : null;
      const value = needsValue("--rule", inline, args[++i]);
      for (const id of value.split(",").map((v) => v.trim()).filter(Boolean)) {
        ruleFilter.add(id);
      }
    } else if (arg === "--severity" || arg.startsWith("--severity=")) {
      const inline = arg.includes("=") ? arg.split("=").slice(1).join("=") : null;
      const value = needsValue("--severity", inline, args[++i]).toLowerCase();
      if (!SEV_LEVELS.includes(value)) {
        process.stderr.write(
          `--severity expects one of: ${SEV_LEVELS.join(", ")}\n`
        );
        process.exit(2);
      }
      minSeverity = value.toUpperCase();
    } else if (arg === "--html" || arg.startsWith("--html=")) {
      const inline = arg.includes("=") ? arg.split("=").slice(1).join("=") : null;
      htmlPath = needsValue("--html", inline, args[++i]);
    } else if (arg === "--link") {
      linkMode = "always";
    } else if (arg === "--no-link") {
      linkMode = "never";
    } else if (arg === "--baseline" || arg.startsWith("--baseline=")) {
      const inline = arg.includes("=") ? arg.split("=").slice(1).join("=") : null;
      baselineRef = needsValue("--baseline", inline, args[++i]);
      if (baselineRef.startsWith("-")) {
        process.stderr.write("--baseline expects a git ref, like origin/main\n");
        process.exit(2);
      }
    } else if (arg === "--no-baseline") {
      baselineRef = null;
    } else if (arg === "--no-github") {
      github = false;
    } else if (arg === "--open") {
      openPage = true;
    } else if (arg === "--learn-url" || arg.startsWith("--learn-url=")) {
      const inline = arg.includes("=") ? arg.split("=").slice(1).join("=") : null;
      learnUrl = needsValue("--learn-url", inline, args[++i]);
      if (!/^https?:\/\/[^#\s]+$/.test(learnUrl)) {
        process.stderr.write("--learn-url expects an http(s) URL with no #fragment\n");
        process.exit(2);
      }
    } else if (arg.startsWith("-")) {
      process.stderr.write(`unknown flag: ${arg}\n`);
      process.stderr.write(
        "supported: --json, --sarif, --html <file>, --open, --link, --no-link,\n" +
          "           --rule <id>, --severity <level>, --by <lesson|file|rule>, --compact,\n" +
          "           --verbose, --fail-on <level>, --baseline <ref>, --no-baseline,\n" +
          "           --no-github, --learn-url <url>. " +
          "run `llm-audit --help` for usage.\n"
      );
      process.exit(2);
    } else {
      paths.push(arg);
    }
  }
  const targetPaths = paths.length ? paths : ["."];

  // Same reasoning as the flag check: a path the user mistyped is their error,
  // and semgrep's own failure for a missing target is silent under --quiet.
  // Without this, `llm-audit scan /wrong/path` printed nothing at all.
  for (const p of targetPaths) {
    if (existsSync(p)) continue;
    process.stderr.write(`error: no such file or directory: ${p}\n`);
    process.stderr.write("scan takes paths to scan; run `llm-audit --help` for usage.\n");
    process.exit(2);
  }

  // A misspelled rule id must never look like a clean bill of health. Without
  // this, `--rule hardcoded-llm-api-kye` filters every real finding away and
  // reports "0 findings — clean", which in CI is a silent pass on a file full
  // of hardcoded keys.
  if (ruleFilter.size) {
    const known = new Set(
      readdirSync(RULES_DIR)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.replace(/\.yaml$/, ""))
    );
    for (const id of ruleFilter) {
      if (known.has(id)) continue;
      process.stderr.write(`unknown rule: ${id}\n`);
      const near = nearest(id, [...known]);
      if (near) process.stderr.write(`did you mean \`${near}\`?\n`);
      process.stderr.write("run `llm-audit rules` for the full list.\n");
      process.exit(2);
    }
  }

  // The project config fills in whatever the command line left unsaid.
  const knownRules = readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));
  let config;
  try {
    config = loadConfig(process.cwd(), knownRules);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  failOn = failOn ?? config.failOn ?? "any";
  if (!minSeverity && config.severity) minSeverity = config.severity;
  if (baselineRef === undefined) baselineRef = config.baseline ?? null;
  const disabled = new Set(config.disable);

  // Arguments are good; now the environment has to be.
  ensureSemgrep();

  // SARIF is a passthrough of Semgrep's own writer, so our filters and our
  // report have nothing to act on. Say that plainly instead of silently
  // ignoring flags the user typed.
  if (outputFormat === "sarif" && (ruleFilter.size || minSeverity || htmlPath || openPage || linkMode === "always" || baselineRef)) {
    process.stderr.write(
      "--sarif can't be combined with --rule, --severity, --html, --open, --link, or a baseline\n" +
        "(including severity or baseline from the project config).\n" +
        "run the scan twice, or filter the SARIF downstream.\n"
    );
    process.exit(2);
  }

  // Filters narrow what the report shows and what the exit code reacts to.
  // A filtered run is a focused run, not a partial audit — the summary says
  // so, so nobody mistakes a `--rule` pass for a clean bill of health.
  const applyFilters = (envelope) => {
    if (!ruleFilter.size && !minSeverity) return envelope;
    const findings = envelope.findings.filter(
      (f) =>
        (!ruleFilter.size || ruleFilter.has(f.ruleId)) &&
        (!minSeverity || sevRank(f.severity) <= sevRank(minSeverity))
    );
    return { ...envelope, summary: { ...envelope.summary, findings: findings.length }, findings };
  };

  // One scan, then policy: rules the config turns off, findings an
  // llm-audit-ignore comment explains, and findings that already existed at
  // the baseline. What each step removed stays visible: counted in the
  // output, listed in --json.
  const notes = { problems: [], disabled: [...disabled] };
  const scan = () => {
    const raw = buildEnvelope(runSemgrepJson(targetPaths, { exclude: config.ignore }), targetPaths);
    let findings = raw.findings.filter((f) => !disabled.has(f.ruleId));
    const sup = applySuppressions(findings, knownRules);
    findings = sup.findings;
    notes.problems = sup.problems;
    let baseline = null;
    if (baselineRef) {
      const b = filterBaseline(findings, baselineRef, targetPaths, config.ignore);
      findings = b.findings;
      baseline = { ref: baselineRef, hidden: b.hidden };
    }
    return applyFilters({
      ...raw,
      summary: { findings: findings.length, suppressed: sup.suppressed.length },
      findings,
      suppressed: sup.suppressed,
      ...(baseline ? { baseline } : {}),
    });
  };

  // Inside GitHub Actions, findings also become inline annotations on the
  // pull request and a summary on the job page.
  const toGitHub = (envelope, write) => {
    if (!github || !inGitHubActions()) return;
    const { groups, unknown } = groupFindings(envelope.findings, LESSONS);
    for (const f of unknown) groups.push({ lesson: { title: f.ruleId, summary: "" }, hits: [f], severity: f.severity });
    writeAnnotations(groups, { docs: ruleDocsUrl, write });
    writeStepSummary(groups, {
      total: envelope.findings.length,
      suppressed: envelope.suppressed?.length || 0,
      baseline: envelope.baseline || null,
      learnUrl: learnBase(learnUrl),
      version: getVersion(),
    });
  };

  // Translate the policy into an exit code. `any` keeps the historical
  // behaviour: one finding of any severity fails the run.
  const exitFor = (findings) => {
    if (failOn === "never") return 0;
    if (findings.length === 0) return 0;
    if (failOn === "any") return 1;
    const threshold = sevRank(failOn.toUpperCase());
    return findings.some((f) => sevRank(f.severity) <= threshold) ? 1 : 0;
  };

  if (outputFormat === "human") {
    const startedAt = Date.now();
    const envelope = scan();
    const elapsedMs = Date.now() - startedAt;
    const filtered = Boolean(ruleFilter.size || minSeverity);
    const filterLabel = ruleFilter.size
      ? `rule${ruleFilter.size === 1 ? "" : "s"} (${[...ruleFilter].join(", ")})`
      : minSeverity
        ? `severity (${minSeverity.toLowerCase()} or worse)`
        : null;
    // A person at a terminal gets the lesson view. Hooks, pipes, and CI keep
    // the per-file view they have always parsed, unless a flag says otherwise.
    const view =
      groupBy || (density !== "auto" ? "file" : interactive() ? "lesson" : "file");
    if (view === "lesson") {
      renderLessons(envelope, { elapsedMs, filtered, filterLabel });
    } else {
      const compact =
        density === "compact" ||
        (density === "auto" && envelope.findings.length > COMPACT_THRESHOLD);
      renderHuman(envelope, { failOn, compact, by: view, elapsedMs, filtered, filterLabel });
    }
    printScanNotes(envelope, notes, config);
    toGitHub(envelope, (t) => process.stdout.write(t));
    // Save the scan for `learn` and `prompt`, and say so, whenever a person
    // is reading. Never from CI, and never with --no-link.
    if (linkMode !== "never" && (interactive() || view === "lesson")) {
      saveLastScan(buildPayload(envelope, { ...shareOptions(undefined, filtered), detail: "context" }));
      printLearnFooter(envelope, { base: learnUrl, filtered });
    }
    if (linkMode === "always" && envelope.findings.length) {
      printLearnLink(envelope, { base: learnUrl, filtered });
    }
    if (openPage) openLearnPage(envelope, { filtered });
    if (htmlPath) {
      writeHtmlReport(envelope, htmlPath, targetPaths, {
        rules: [...ruleFilter],
        severity: minSeverity,
      });
    }
    process.exit(exitFor(envelope.findings));
  }

  if (outputFormat === "sarif") {
    // Passthrough Semgrep's native SARIF 2.1.0 output. SARIF is the
    // standard for security-tool output and lets users upload findings
    // directly to GitHub Code Scanning via actions/codeql-action/upload-sarif.
    // `--quiet` suppresses Semgrep's status box on stderr so the SARIF
    // on stdout is the only meaningful output (clean for pipelines that
    // redirect stdout to a `.sarif` file).
    const r = spawnSync(
      "semgrep",
      [
        "--config", RULES_DIR,
        "--sarif",
        "--metrics=off",
        "--quiet",
        ...config.ignore.flatMap((g) => ["--exclude", g]),
        "--",
        ...targetPaths,
      ],
      { stdio: "inherit" }
    );
    process.exit(r.status === 1 ? 1 : r.status ?? 1);
  }

  // outputFormat === "json": wrap the findings in our versioned envelope.
  // Exit 0 on no findings, 1 on findings — same convention as human mode.
  const envelope = scan();
  // stdout is the JSON, so everything else goes to stderr.
  for (const p of notes.problems) {
    process.stderr.write(`warning: llm-audit-ignore at ${displayPath(p.path)}:${p.line} ${p.message}\n`);
  }
  toGitHub(envelope, (t) => process.stderr.write(t));
  if (htmlPath) {
    writeHtmlReport(envelope, htmlPath, targetPaths, {
      rules: [...ruleFilter],
      severity: minSeverity,
    });
  }
  const filtered = Boolean(ruleFilter.size || minSeverity);
  if (openPage) openLearnPage(envelope, { filtered });
  // stdout is the JSON. An explicitly requested link goes to stderr.
  if (linkMode === "always" && envelope.findings.length) {
    const { url } = learnLink(envelope, {
      ...shareOptions(undefined, filtered),
      base: learnBase(learnUrl),
    });
    process.stderr.write(url ? `${url}\n` : "too many findings to fit in a link; use --open\n");
  }

  process.stdout.write(JSON.stringify(envelope, null, 2));
  process.stdout.write("\n");
  process.exit(exitFor(envelope.findings));
}

function cmdDemo(args = []) {
  const openPage = args.includes("--open");
  for (const a of args) {
    if (a !== "--open") {
      process.stderr.write(`unknown flag for demo: ${a}\n`);
      process.stderr.write("demo takes only --open. run `llm-audit --help` for usage.\n");
      process.exit(2);
    }
  }
  ensureSemgrep();
  const FIXTURES_DIR = join(PKG_ROOT, "test", "fixtures");
  if (!existsSync(FIXTURES_DIR)) {
    console.error(
      "error: demo fixtures not found. This usually means the package was " +
        "installed without the bundled fixtures, which shouldn't happen on a " +
        "normal install."
    );
    console.error(
      "  please open an issue: https://github.com/Javierlozo/llm-audit/issues"
    );
    process.exit(1);
  }

  // Find every <rule-id>/vulnerable.{ts,tsx,js} that ships with the package.
  const ruleIds = readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();

  const vulnerableFiles = [];
  for (const ruleId of ruleIds) {
    const fixtureDir = join(FIXTURES_DIR, ruleId);
    if (!existsSync(fixtureDir)) continue;
    for (const name of ["vulnerable.ts", "vulnerable.tsx", "vulnerable.js"]) {
      const candidate = join(fixtureDir, name);
      if (existsSync(candidate)) {
        vulnerableFiles.push(candidate);
        break;
      }
    }
  }

  if (vulnerableFiles.length === 0) {
    console.error("error: no vulnerable fixtures found to demo against.");
    process.exit(1);
  }

  banner("OWASP LLM Top 10 for TypeScript, at commit time.");
  console.log(
    `Running llm-audit against ${vulnerableFiles.length} bundled fixtures.`
  );
  console.log(
    "Each finding below is a real rule firing on intentionally vulnerable"
  );
  console.log(
    "code that ships with this package, demonstrating what llm-audit"
  );
  console.log("would catch in your own TS/JS LLM-application code.");
  console.log("");

  // Run all rules against all vulnerable fixtures in one pass, rendered with
  // the same formatter as `scan` so the demo shows exactly what a real run
  // looks like.
  const envelope = buildEnvelope(
    runSemgrepJson(vulnerableFiles),
    [FIXTURES_DIR]
  );
  if (interactive()) {
    renderLessons(envelope, {
      ruleCount: ruleIds.length,
      stripPrefix: PKG_ROOT,
      label: `demo \u00b7 ${vulnerableFiles.length} deliberately vulnerable fixtures`,
    });
    if (!openPage) {
      printLearnFooter(envelope, { stripPrefix: PKG_ROOT, learnCmd: `${self()} demo --open` });
    }
  } else {
    renderHuman(envelope, { ruleCount: ruleIds.length, stripPrefix: PKG_ROOT });
  }
  if (openPage) openLearnPage(envelope, { stripPrefix: PKG_ROOT });

  console.log("");
  console.log("Next steps:");
  console.log("  - run on your own repo:        `npx llm-audit scan`");
  console.log("  - wire up pre-commit + CI:     `npx llm-audit init`");
  console.log("  - read the rule rationale:     https://github.com/Javierlozo/llm-audit/blob/main/docs/RULES.md");
  console.log("  - the website and lessons:     https://llm-audit.luislozoya.com");
  // Always exit 0: finding things is the point of demo, not a failure.
  process.exit(0);
}

function cmdRules(args = []) {
  const target = args.find((a) => !a.startsWith("-"));
  const meta = readRuleMeta(RULES_DIR);

  // No argument at a terminal: the rules under the lesson that teaches them,
  // which is how the scan and the learn page group them too.
  if (!target && process.stdout.isTTY) {
    const width = termWidth();
    console.log("");
    console.log(`${c.bold}${Object.keys(meta).length} rules${c.reset}${c.dim}  \u00b7  grouped by the mistake they catch${c.reset}`);
    for (const lesson of LESSONS) {
      console.log("");
      console.log(`${c.bold}${lesson.title}${c.reset}${c.dim}  ${lesson.owasp || ""}${c.reset}`);
      for (const id of lesson.rules) {
        const r = meta[id] || {};
        const sev = (r.severity || "INFO").toLowerCase();
        console.log(`  ${id.padEnd(Math.min(56, width - 12))}${(SEV_COLOR[r.severity] || SEV_COLOR.INFO)()}${sev}${c.reset}`);
      }
    }
    console.log("");
    console.log(`${c.dim}One rule in full:${c.reset}  ${self()} rules <rule-id>`);
    console.log(`${c.dim}All lessons in your browser:${c.reset}  ${self()} learn`);
    return;
  }

  // No argument, piped: the index, tab-separated so it stays greppable.
  if (!target) {
    for (const id of Object.keys(meta).sort()) {
      const r = meta[id];
      console.log(`${id}\t${r.severity}\t${r.owasp || ""}`);
    }
    return;
  }

  const rule = meta[target];
  if (!rule) {
    process.stderr.write(`unknown rule: ${target}\n`);
    const near = nearest(target, Object.keys(meta));
    if (near) process.stderr.write(`did you mean \`${near}\`?\n`);
    process.stderr.write("run `llm-audit rules` for the full list.\n");
    process.exit(2);
  }

  // With an argument: the long form. This is where the terminal teaches, so
  // the compact scan view has somewhere to point.
  const width = Math.min(
    Math.max(Number(process.env.COLUMNS) || process.stdout.columns || 80, 60),
    100
  );
  const docs = parseRuleDocs(RULE_DOCS)[target] || {};
  const sev = (rule.severity || "INFO").toLowerCase();

  const section = (label, text) => {
    if (!text) return;
    console.log("");
    console.log(`${c.bold}${label}${c.reset}`);
    console.log(wrap(text, width - 2, "  "));
  };

  console.log("");
  console.log(
    `${sevTag(rule.severity)} ${c.bold}${target}${c.reset}` +
      `${rule.owasp ? `  ${c.yellow}${rule.owasp}${c.reset}` : ""}` +
      `${rule.cwe.length ? `${c.dim}  ${rule.cwe.join(", ")}${c.reset}` : ""}`
  );

  section("What it catches", docs.catches);
  section("Why an AI assistant writes this", docs.whyAi);
  section("How to fix it", docs.fix);

  // The safe fixture is the fix, in code, asserted clean on every commit.
  // Printing it here is the difference between telling someone to validate
  // their input and showing them what that looks like.
  const example = readSafeExample(FIXTURES_DIR, target);
  if (example) {
    console.log("");
    console.log(
      `${c.bold}The fixed shape${c.reset}` +
        `${c.dim}  ${example.name} \u2014 asserted to produce 0 findings by \`npm test\`${c.reset}`
    );
    console.log("");
    for (const line of example.code.split("\n")) {
      console.log(`  ${c.green}${line}${c.reset}`);
    }
  }

  if (rule.references.length) {
    console.log("");
    console.log(`${c.bold}References${c.reset}`);
    for (const r of rule.references) console.log(`  ${r}`);
  }

  console.log("");
  console.log(
    `${c.dim}Scan for just this rule:${c.reset} llm-audit scan --rule ${target}`
  );
}

// Yes/no prompt with a sensible default. In non-TTY contexts (CI runners,
// piped stdin) we don't block on input — we honor the default and continue.
// This keeps `init` scriptable without losing the safety net interactively.
async function promptYesNo(question, defaultYes = true) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = await new Promise((resolve) => {
    rl.question(question + suffix, resolve);
  });
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

function detectHuskyState(cwd) {
  const pkgPath = join(cwd, "package.json");
  let inDeps = false;
  let hasPrepare = false;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      inDeps = !!(
        (pkg.dependencies && pkg.dependencies.husky) ||
        (pkg.devDependencies && pkg.devDependencies.husky)
      );
      hasPrepare = !!(
        pkg.scripts &&
        typeof pkg.scripts.prepare === "string" &&
        /husky/.test(pkg.scripts.prepare)
      );
    } catch {
      // ignore malformed package.json; treat as no husky
    }
  }
  // husky v9 creates .husky/_/ when initialized
  const initialized = existsSync(join(cwd, ".husky", "_"));
  return { inDeps, hasPrepare, initialized };
}

// What is already at this path? `init` refusing to overwrite a file it wrote
// itself is the worst possible answer, so tell the cases apart.
//   absent    nothing there
//   same      byte-identical to what we would write: already installed
//   ours      mentions llm-audit but differs: an older version's file
//   foreign   somebody else's file
function classifyExisting(destPath, templatePath) {
  if (!existsSync(destPath)) return "absent";
  let current, wanted;
  try {
    current = readFileSync(destPath, "utf8");
    wanted = readFileSync(templatePath, "utf8");
  } catch {
    return "foreign";
  }
  if (current === wanted) return "same";
  return /llm-audit/.test(current) ? "ours" : "foreign";
}

async function cmdInit(args) {
  const cwd = process.cwd();
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const installSkill = args.includes("--skill") || args.includes("--skill-only");
  const skillOnly = args.includes("--skill-only");

  // Ask once, at install time, before we write a hook into the user's
  // local commit flow. Non-interactive callers (CI, scripts) and `--yes`
  // skip the prompt and accept the default. Declining skips only the
  // local hook — the GH Action workflow is still written, since that's
  // project-wide CI code the user reviews in their PR.
  // Check the disk before asking anything. Prompting and then announcing
  // there was nothing to do wastes the one question this command gets to ask.
  if (!force && !dryRun) {
    const planned = [];
    if (!skillOnly) {
      planned.push([join(cwd, ".husky", "pre-commit"), join(TEMPLATES_DIR, "husky-pre-commit")]);
      planned.push([
        join(cwd, ".github", "workflows", "llm-audit.yml"),
        join(TEMPLATES_DIR, "github-action.yml"),
      ]);
    }
    if (installSkill) {
      planned.push([
        join(cwd, ".claude", "skills", "llm-audit", "SKILL.md"),
        join(SKILLS_DIR, "llm-audit", "SKILL.md"),
      ]);
    }
    const allSame =
      planned.length > 0 &&
      planned.every(([dest, tpl]) => classifyExisting(dest, tpl) === "same");
    if (allSame) {
      console.log("Everything is already installed and up to date:");
      for (const [dest] of planned) console.log(`  ${displayPath(dest)}`);
      console.log("");
      console.log("Nothing to do. `llm-audit init --force` reinstalls from the templates.");
      return;
    }
  }

  let installHook = !skillOnly;
  if (installHook && !yes && !dryRun) {
    installHook = await promptYesNo(
      "Install the llm-audit pre-commit hook in this repo?",
      true
    );
    if (!installHook) {
      console.log(
        "  skipping pre-commit hook. you can run `npx llm-audit scan` manually anytime."
      );
    }
  }

  function writeOrRefuse(srcAbsPath, destPath, exec = false) {
    const state = classifyExisting(destPath, srcAbsPath);
    const shown = displayPath(destPath);

    if (dryRun) {
      const what = {
        absent: "would write",
        same: "already installed, would leave alone",
        ours: "installed by an older version, would update with --force",
        foreign: "not ours, would refuse without --force",
      }[state];
      console.log(`[dry-run] ${what} ${shown}`);
      return;
    }

    // Already exactly what we would write. Saying so and moving on is the
    // whole point of running init twice.
    if (state === "same" && !force) {
      console.log(`already installed  ${shown}`);
      return;
    }

    if (state === "ours" && !force) {
      console.log(`already installed  ${shown}`);
      console.log(
        `  it differs from this version's template; ` +
          `run \`llm-audit init --force\` to update it.`
      );
      return;
    }

    if (state === "foreign" && !force) {
      console.error(`refusing to overwrite ${shown}`);
      console.error(
        "  that file was not written by llm-audit. " +
          "back it up and pass --force, or merge the two by hand."
      );
      process.exit(1);
    }

    copyFileSync(srcAbsPath, destPath);
    if (exec) spawnSync("chmod", ["+x", destPath]);
    console.log(`wrote ${shown}`);
  }

  if (!skillOnly) {
    // Husky pre-commit (gated on the consent prompt above).
    if (installHook) {
      const huskyDir = join(cwd, ".husky");
      if (!existsSync(huskyDir) && !dryRun) {
        mkdirSync(huskyDir, { recursive: true });
      }
      writeOrRefuse(
        join(TEMPLATES_DIR, "husky-pre-commit"),
        join(huskyDir, "pre-commit"),
        true
      );
    }

    // GitHub Action: project-wide CI, always written.
    const ghDir = join(cwd, ".github", "workflows");
    if (!existsSync(ghDir) && !dryRun) {
      mkdirSync(ghDir, { recursive: true });
    }
    writeOrRefuse(
      join(TEMPLATES_DIR, "github-action.yml"),
      join(ghDir, "llm-audit.yml")
    );
  }

  // Claude Code skill (project-local). Off by default; opt in with
  // --skill (writes the hook + workflow + skill) or --skill-only
  // (writes just the skill).
  if (installSkill) {
    const skillDir = join(cwd, ".claude", "skills", "llm-audit");
    if (!existsSync(skillDir) && !dryRun) {
      mkdirSync(skillDir, { recursive: true });
    }
    writeOrRefuse(
      join(SKILLS_DIR, "llm-audit", "SKILL.md"),
      join(skillDir, "SKILL.md")
    );
  }

  if (dryRun) {
    console.log("");
    console.log(
      "dry-run: nothing was written. re-run without --dry-run to apply."
    );
    return;
  }

  if (skillOnly) {
    console.log("");
    console.log(
      "✓ Claude Code skill installed at .claude/skills/llm-audit/SKILL.md"
    );
    console.log(
      "  Claude Code (and any tool that reads the .claude/skills/ format)"
    );
    console.log(
      "  will pick it up automatically next session. The skill autoloads"
    );
    console.log(
      "  when the agent edits LLM-integrated code or before commits that"
    );
    console.log("  touch it.");
    return;
  }

  console.log("");
  if (installSkill) {
    console.log(
      "✓ Claude Code skill installed at .claude/skills/llm-audit/SKILL.md"
    );
    console.log("");
  }
  if (!installHook) {
    console.log(
      "✓ GitHub Action workflow installed at .github/workflows/llm-audit.yml"
    );
    console.log(
      "  no pre-commit hook was written. CI will still run llm-audit on PRs."
    );
    console.log("");
    console.log("other things to verify:");
    console.log("  - semgrep installed:    `semgrep --version`  (else `brew install semgrep`)");
    console.log("  - try a clean scan:     `npx llm-audit scan`");
    console.log("  - see the demo:         `npx llm-audit demo`");
    return;
  }

  const husky = detectHuskyState(cwd);

  if (husky.inDeps && husky.initialized) {
    console.log("✓ husky is installed and initialized.");
    console.log("  the pre-commit hook will run on your next commit.");
  } else if (husky.inDeps && !husky.initialized) {
    console.log("husky is installed but not initialized in this clone.");
    if (husky.hasPrepare) {
      console.log("  finish setup with:  npm run prepare");
    } else {
      console.log(
        "  finish setup with:  npm pkg set scripts.prepare='husky' && npm run prepare"
      );
    }
  } else {
    console.log("husky isn't installed yet, so the pre-commit hook won't run.");
    console.log("  to wire it up:");
    console.log("    npm i -D husky");
    console.log("    npm pkg set scripts.prepare='husky'");
    console.log("    npm run prepare");
    console.log(
      "  (avoid `npx husky init` here — it conflicts with the pre-commit hook just written.)"
    );
  }

  console.log("");
  console.log("other things to verify:");
  console.log("  - semgrep installed:    `semgrep --version`  (else `brew install semgrep`)");
  console.log("  - try a clean scan:     `npx llm-audit scan`");
  console.log("  - see the demo:         `npx llm-audit demo`");
}

// The counterpart to init. Somebody who runs `init` will eventually want it
// gone, and reaching for `llm-audit delete` and getting "unknown subcommand"
// is a dead end — the files are ours, so removing them should be ours too.
async function cmdUninstall(args) {
  const cwd = process.cwd();
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");

  const candidates = [
    {
      path: join(cwd, ".husky", "pre-commit"),
      template: join(TEMPLATES_DIR, "husky-pre-commit"),
      label: "pre-commit hook",
    },
    {
      path: join(cwd, ".github", "workflows", "llm-audit.yml"),
      template: join(TEMPLATES_DIR, "github-action.yml"),
      label: "CI workflow",
    },
    {
      path: join(cwd, ".claude", "skills", "llm-audit", "SKILL.md"),
      template: join(SKILLS_DIR, "llm-audit", "SKILL.md"),
      label: "coding-agent skill",
    },
  ];

  const removable = [];
  const kept = [];
  for (const item of candidates) {
    const state = classifyExisting(item.path, item.template);
    if (state === "absent") continue;
    // Only ever delete a file we can prove is ours. Anything edited beyond
    // recognition stays, and we say why.
    if (state === "same" || state === "ours") removable.push({ ...item, state });
    else kept.push(item);
  }

  if (removable.length === 0 && kept.length === 0) {
    console.log("Nothing to remove. llm-audit isn't installed in this project.");
    return;
  }

  if (removable.length) {
    console.log(dryRun ? "Would remove:" : "Will remove:");
    for (const item of removable) {
      console.log(
        `  ${displayPath(item.path)}  ${c.dim}(${item.label})${c.reset}`
      );
    }
  }
  for (const item of kept) {
    console.log("");
    console.log(`Leaving ${displayPath(item.path)} alone.`);
    console.log("  it's been edited since llm-audit wrote it. remove it by hand if you want it gone.");
  }

  if (dryRun || removable.length === 0) return;

  console.log("");
  const go = yes || (await promptYesNo("Remove these files?", true));
  if (!go) {
    console.log("Nothing removed.");
    return;
  }

  for (const item of removable) {
    try {
      rmSync(item.path, { force: true });
      console.log(`removed ${displayPath(item.path)}`);
    } catch (err) {
      console.error(`error: could not remove ${displayPath(item.path)}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  // Clean up the skill directory if it is now empty; leave .husky and
  // .github alone, since other tools live there.
  const skillDir = join(cwd, ".claude", "skills", "llm-audit");
  try {
    if (existsSync(skillDir) && readdirSync(skillDir).length === 0) {
      rmSync(skillDir, { recursive: true, force: true });
    }
  } catch {
    // a leftover empty directory is not worth failing over
  }

  console.log("");
  console.log("Done. The package itself is still installed;");
  console.log("`npm remove llm-audit` if you want that gone too.");
}

async function cmdDoctor() {
  const cwd = process.cwd();
  let warnings = 0;
  let failures = 0;

  function status(label, kind, fix = "") {
    const tag =
      kind === "ok"
        ? "[ok]  "
        : kind === "note"
          ? "[note]"
          : kind === "warn"
            ? "[warn]"
            : "[fail]";
    if (kind === "warn") warnings++;
    if (kind === "fail") failures++;
    console.log(`  ${tag}  ${label}`);
    if (fix) console.log(`         ${fix}`);
  }

  const current = getVersion();
  console.log(`llm-audit doctor (${current})`);
  console.log("");

  console.log("Updates");
  const latest = await fetchLatestVersion();
  if (latest === null) {
    status(
      "version check",
      "warn",
      "could not reach the npm registry (offline, rate-limited, or behind a proxy)"
    );
  } else if (compareSemver(current, latest) >= 0) {
    status(`llm-audit ${current} is up to date`, "ok");
  } else {
    status(
      `llm-audit ${current} is out of date (latest is ${latest})`,
      "warn",
      "fix: npm i llm-audit@latest"
    );
  }

  console.log("");
  console.log("Engine");
  // semgrep
  const sg = spawnSync("semgrep", ["--version"], { encoding: "utf8" });
  if (sg.status !== 0) {
    status(
      "semgrep installed",
      "fail",
      "fix: brew install semgrep   (or: pipx install semgrep)"
    );
  } else {
    const version = (sg.stdout || "").trim().split("\n")[0];
    status(`semgrep installed (${version})`, "ok");
  }
  // rules pack
  if (existsSync(RULES_DIR)) {
    const ruleCount = readdirSync(RULES_DIR).filter((f) =>
      f.endsWith(".yaml")
    ).length;
    status(`rules pack readable (${ruleCount} rules)`, "ok");
  } else {
    status("rules pack readable", "fail", `expected at ${RULES_DIR}`);
  }
  // demo fixtures
  const FIXTURES_DIR = join(PKG_ROOT, "test", "fixtures");
  if (existsSync(FIXTURES_DIR)) {
    status("demo fixtures bundled", "ok");
  } else {
    status(
      "demo fixtures bundled",
      "warn",
      "`llm-audit demo` won't work; reinstall the package"
    );
  }
  // templates
  if (existsSync(TEMPLATES_DIR)) {
    status("templates bundled", "ok");
  } else {
    status(
      "templates bundled",
      "warn",
      "`llm-audit init` won't work; reinstall the package"
    );
  }

  console.log("");
  console.log("Project");
  // git repo
  if (existsSync(join(cwd, ".git"))) {
    status("git repository detected", "ok");
  } else {
    status(
      "git repository detected",
      "warn",
      "the pre-commit hook requires git; run `git init` if this is a new project"
    );
  }
  // husky
  const husky = detectHuskyState(cwd);
  if (husky.inDeps && husky.initialized) {
    status("husky installed and initialized", "ok");
  } else if (husky.inDeps) {
    status(
      "husky installed but not initialized",
      existsSync(join(cwd, ".husky", "pre-commit")) ? "warn" : "note",
      husky.hasPrepare
        ? "fix: npm run prepare"
        : "fix: npm pkg set scripts.prepare='husky' && npm run prepare"
    );
  } else if (existsSync(join(cwd, ".husky", "pre-commit"))) {
    status(
      "husky isn't installed, but a pre-commit hook is",
      "warn",
      "the hook won't run: npm i -D husky && " +
        "npm pkg set scripts.prepare='husky' && npm run prepare"
    );
  } else {
    status("husky not installed", "note", "only needed for the pre-commit hook");
  }

  // A hook that cannot run is a fault. No hook at all is a project that has
  // not adopted the pre-commit path, which is allowed — warning about a choice
  // teaches people to ignore warnings.
  const hookPath = join(cwd, ".husky", "pre-commit");
  if (existsSync(hookPath)) {
    status(".husky/pre-commit hook installed", "ok");
  } else {
    status(
      ".husky/pre-commit hook not installed",
      "note",
      "optional; `npx llm-audit init` sets it up"
    );
  }
  const wfPath = join(cwd, ".github", "workflows", "llm-audit.yml");
  if (existsSync(wfPath)) {
    status(".github/workflows/llm-audit.yml installed", "ok");
  } else {
    status(
      ".github/workflows/llm-audit.yml not installed",
      "note",
      "optional; `npx llm-audit init` sets it up"
    );
  }

  console.log("");
  console.log("Runtime");
  status(`node ${process.version}`, "ok");

  console.log("");
  if (failures === 0 && warnings === 0) {
    console.log("All checks passed. Notes are optional setup, not problems.");
  } else if (failures === 0) {
    console.log(`${warnings} warning${warnings === 1 ? "" : "s"}.`);
  } else {
    console.log(
      `${failures} failure${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`
    );
  }
  process.exit(failures > 0 ? 1 : 0);
}

function helpText({ withTitle = true } = {}) {
  const v = getVersion();
  // On a TTY the wordmark above already carries the name, version, and
  // tagline; repeating them here would just be noise.
  const title = withTitle
    ? `llm-audit ${v}
Static analysis for TypeScript and JavaScript LLM applications.
OWASP LLM Top 10 at commit time.
`
    : "";
  return `${title}

START HERE
  llm-audit demo                  Watch all twelve rules fire on bundled
                                  vulnerable code
  llm-audit scan                  Mistakes grouped worst first, every place
                                  they occur
  llm-audit learn                 Each mistake explained, with your code and
                                  the attack
  llm-audit prompt 1              Copy a fix prompt that lists every place to
                                  change
  llm-audit init --skill          Pre-commit hook, CI workflow, and the
                                  coding-agent skill
  llm-audit doctor                Dependencies, project setup, and whether
                                  you are current

USAGE
  llm-audit <command> [options]

COMMANDS
  demo [--open]                   Run the rule pack against bundled fixtures
  scan [paths...] [flags]         Run the rule pack against given paths (default: .)
  learn [--link]                  Open lessons for this project's last scan
                                  (or the lesson library if there is none);
                                  --link prints a shareable URL instead
  prompt [n] [--check]            Print and copy lesson n's fix prompt;
                                  --check gives the check-the-rest prompt
  rules [rule-id]                 List every rule, or explain one in full
  doctor                          Diagnose dependencies and project setup
  init [flags]                    Install pre-commit hook + CI workflow + optional skill
  uninstall [--dry-run] [-y]      Remove what init installed

SCAN FLAGS
  --by <lesson|file|rule>         Group by kind of mistake (default at a terminal),
                                  by file with code (default in hooks and CI), or by rule
  --compact                       One line per finding
  --verbose                       Full rationale for every finding
  --rule <id>                     Only this rule (repeatable, or comma-separated)
  --severity <level>              Only this severity or worse (error|warning|info)
  --fail-on <level>               Exit 1 only at or above this severity
                                  any (default) | error | warning | info | never
  --baseline <git-ref>            Only findings new since that commit (e.g. origin/main)
  --no-baseline                   Ignore a baseline set in the project config
  --no-github                     In GitHub Actions, skip annotations and the job summary
  --open                          Open the lessons for this scan right away
  --link                          Also print a shareable URL (results ride in the #)
  --no-link                       Don't save the scan for learn/prompt, no hints
  --learn-url <url>               Where share links point, if you host the page
  --json                          Emit findings as JSON (versioned envelope)
  --sarif                         Emit findings as SARIF 2.1.0 (GitHub Code Scanning)
  --html <file>                   Write a standalone HTML report you can share

PROJECT POLICY
  .llm-audit.json                 Or an "llm-audit" key in package.json. Keys:
                                  failOn, severity, disable (rule ids),
                                  ignore (path globs), baseline (git ref)
  // llm-audit-ignore <rule-id> -- <reason>
                                  On the flagged line or the line above it.
                                  A reason is required; suppressions are
                                  counted in the output and listed in --json

EXIT CODES
  0  nothing at or above --fail-on    1  findings at or above --fail-on
  2  usage or config error            127  semgrep is not installed

INIT FLAGS
  --force                         Overwrite existing files
  --dry-run                       Preview without writing
  -y, --yes                       Skip the pre-commit hook prompt (accept the default)
  --skill                         Also install the Claude Code skill (.claude/skills/llm-audit/)
  --skill-only                    Install only the skill, not the hook or workflow

FLAGS
  --version                       Print version and exit
  -h, --help                      Show this message

NOT ON YOUR PATH?
  Every command works through npx without installing anything:
  \`npx llm-audit scan\`. For a bare \`llm-audit\`, install it globally
  with \`npm i -g llm-audit\`, or add it to a project with
  \`npm i -D llm-audit\` and call it from a package.json script.

LEARN MORE
  Website         https://llm-audit.luislozoya.com
  Repo            https://github.com/Javierlozo/llm-audit
  npm             https://www.npmjs.com/package/llm-audit
  Issues / bugs   https://github.com/Javierlozo/llm-audit/issues
`;
}

const [, , sub, ...rest] = process.argv;
switch (sub) {
  case "scan":
    cmdScan(rest);
    break;
  case "init":
    await cmdInit(rest);
    break;
  case "rules":
    cmdRules(rest);
    break;
  case "uninstall":
    await cmdUninstall(rest);
    break;
  case "demo":
    cmdDemo(rest);
    break;
  case "learn":
    cmdLearn(rest);
    break;
  case "prompt":
    cmdPrompt(rest);
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "--version":
  case "-v":
    console.log(`llm-audit ${getVersion()}`);
    break;
  case undefined:
  case "help":
  case "-h":
  case "--help":
    // Help requested explicitly: print to stdout per clig.dev. The wordmark
    // only appears on a TTY, so `llm-audit --help | less` stays plain text.
    banner("OWASP LLM Top 10 for TypeScript, at commit time.");
    process.stdout.write(
      helpText({ withTitle: !process.stdout.isTTY && !process.env.FORCE_COLOR })
    );
    break;
  default:
    // Misuse: print the error and a "did you mean" hint to stderr per
    // clig.dev. Don't dump the full help; point to it.
    process.stderr.write(`unknown subcommand: ${sub}\n`);
    {
      const guess = suggestSubcommand(sub);
      if (guess) {
        process.stderr.write(`did you mean: ${guess}?\n`);
      }
    }
    process.stderr.write("run `llm-audit --help` to see available commands.\n");
    process.exit(2);
}
