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
import { readdirSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");
const RULES_DIR = join(PKG_ROOT, "rules");
const TEMPLATES_DIR = join(PKG_ROOT, "templates");
const SKILLS_DIR = join(PKG_ROOT, "skills");

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

const KNOWN_SUBCOMMANDS = ["demo", "scan", "init", "rules", "doctor"];

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

function suggestSubcommand(input) {
  const ranked = KNOWN_SUBCOMMANDS
    .map((c) => [c, levenshtein(input, c)])
    .filter(([, d]) => d <= 3)
    .sort((a, b) => a[1] - b[1]);
  return ranked.length ? ranked[0][0] : null;
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
    console.error("error: `semgrep` is not installed or not on PATH.");
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

function runSemgrepJson(targetPaths) {
  // `--` locks interpretation: any path starting with `-` is a path, not a
  // semgrep flag. Defends against a wrapper or piped input injecting flags
  // via path arguments.
  const r = spawnSync(
    "semgrep",
    [
      "--config", RULES_DIR,
      "--json",
      "--metrics=off",
      "--quiet",
      "--",
      ...targetPaths,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );

  if (r.status !== 0 && r.status !== 1) {
    process.stderr.write(r.stderr || "");
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
function readSnippet(path, startLine, endLine, fallback) {
  const given = (fallback || "").trim();
  if (given && given !== "requires login") return fallback;
  if (!path || !startLine) return "";
  try {
    const all = readFileSync(path, "utf8").split("\n");
    return all.slice(startLine - 1, (endLine ?? startLine)).join("\n");
  } catch {
    return "";
  }
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
    });
  }

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: "llm-audit", version: getVersion() },
    scannedPaths: targetPaths,
    summary: { findings: findings.length },
    findings,
  };
}

// Colour only when writing to a terminal, and honour the NO_COLOR convention
// (https://no-color.org). Piped output stays plain so it greps and diffs.
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
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

function renderHuman(envelope, meta = {}) {
  const width = Math.min(Math.max(process.stdout.columns || 80, 60), 100);
  const { findings } = envelope;

  if (findings.length === 0) {
    console.log("");
    console.log(`${c.green}✓ 0 findings${c.reset} — clean.`);
    console.log("");
    console.log(
      `${c.dim}To see what these rules catch on intentionally vulnerable code:${c.reset}`
    );
    console.log("  npx llm-audit demo");
    return;
  }

  // Group by file so a reader fixes one file at a time.
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.path)) byFile.set(f.path, []);
    byFile.get(f.path).push(f);
  }

  for (const [path, fileFindings] of byFile) {
    console.log("");
    console.log(`${c.bold}${displayPath(path, meta.stripPrefix)}${c.reset}`);

    for (const f of fileFindings.sort((a, b) => a.startLine - b.startLine)) {
      const owasp = f.owasp ? `  ${c.yellow}${f.owasp}${c.reset}` : "";
      console.log("");
      console.log(
        `  ${c.red}✗${c.reset} ${c.bold}${f.ruleId}${c.reset}${owasp}` +
          `${c.dim}  line ${f.startLine}${c.reset}`
      );

      // The message carries the risk and the canonical fix. It is the whole
      // product for a reader who has never seen this rule before.
      const [risk, ...rest] = f.message.split(/\n(?=Fix:)/);
      console.log(wrap(risk, width - 6, "      "));
      for (const block of rest) {
        console.log("");
        console.log(`${c.blue}${wrap(block, width - 6, "      ")}${c.reset}`);
      }

      if (f.lines) {
        console.log("");
        const codeLines = f.lines.replace(/\n+$/, "").split("\n");
        codeLines.forEach((line, i) => {
          const n = String((f.startLine ?? 1) + i).padStart(5);
          console.log(`  ${c.dim}${n} │${c.reset} ${c.magenta}${line}${c.reset}`);
        });
      }
    }
  }

  const fileCount = byFile.size;
  const ruleCount =
    meta.ruleCount ??
    readdirSync(RULES_DIR).filter((f) => f.endsWith(".yaml")).length;

  console.log("");
  console.log(
    `${c.red}${findings.length} finding${findings.length === 1 ? "" : "s"}${c.reset}` +
      ` in ${fileCount} file${fileCount === 1 ? "" : "s"}` +
      `${c.dim} · ${ruleCount} rules run${c.reset}`
  );
}

function cmdScan(args) {
  ensureSemgrep();

  // Parse our recognized flags out of args; everything else is a path.
  // We accept `--json` and `--sarif` as output-format selectors, plus
  // a defensive `--` literal that some users include explicitly.
  let outputFormat = "human"; // "human" | "json" | "sarif"
  const paths = [];
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--json") {
      outputFormat = "json";
    } else if (arg === "--sarif") {
      outputFormat = "sarif";
    } else if (arg.startsWith("-")) {
      process.stderr.write(`unknown flag: ${arg}\n`);
      process.stderr.write(
        "supported: --json, --sarif. run `llm-audit --help` for usage.\n"
      );
      process.exit(2);
    } else {
      paths.push(arg);
    }
  }
  const targetPaths = paths.length ? paths : ["."];

  if (outputFormat === "human") {
    const envelope = buildEnvelope(runSemgrepJson(targetPaths), targetPaths);
    renderHuman(envelope);
    process.exit(envelope.findings.length === 0 ? 0 : 1);
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
        "--",
        ...targetPaths,
      ],
      { stdio: "inherit" }
    );
    process.exit(r.status === 1 ? 1 : r.status ?? 1);
  }

  // outputFormat === "json": wrap the findings in our versioned envelope.
  // Exit 0 on no findings, 1 on findings — same convention as human mode.
  const envelope = buildEnvelope(runSemgrepJson(targetPaths), targetPaths);

  process.stdout.write(JSON.stringify(envelope, null, 2));
  process.stdout.write("\n");
  process.exit(envelope.findings.length === 0 ? 0 : 1);
}

function cmdDemo() {
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

  console.log("");
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
  renderHuman(envelope, { ruleCount: ruleIds.length, stripPrefix: PKG_ROOT });

  console.log("");
  console.log("Next steps:");
  console.log("  - run on your own repo:        `npx llm-audit scan`");
  console.log("  - wire up pre-commit + CI:     `npx llm-audit init`");
  console.log("  - read the rule rationale:     https://github.com/Javierlozo/llm-audit/blob/main/docs/RULES.md");
  console.log("  - read the project brief:      https://luislozoya.com/llm-audit");
  // Always exit 0: finding things is the point of demo, not a failure.
  process.exit(0);
}

function cmdRules() {
  const files = readdirSync(RULES_DIR).filter((f) => f.endsWith(".yaml"));
  for (const f of files) {
    const text = readFileSync(join(RULES_DIR, f), "utf8");
    const idMatch = text.match(/^\s*-\s*id:\s*(\S+)/m);
    const sevMatch = text.match(/^\s*severity:\s*(\S+)/m);
    const owaspMatch = text.match(/owasp-llm:\s*(\S+)/);
    console.log(
      `${idMatch ? idMatch[1] : f.replace(/\.yaml$/, "")}` +
        `\t${sevMatch ? sevMatch[1] : ""}` +
        `\t${owaspMatch ? owaspMatch[1] : ""}`
    );
  }
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
    if (dryRun) {
      const exists = existsSync(destPath);
      console.log(
        `[dry-run] would write ${destPath}${exists ? " (already exists, would refuse without --force)" : ""}`
      );
      return;
    }
    if (existsSync(destPath) && !force) {
      console.error(
        `refusing to overwrite ${destPath} (use --force to override)`
      );
      console.error(
        `  hint: if this file came from a previous llm-audit init, ` +
          `delete it first or pass --force.`
      );
      process.exit(1);
    }
    copyFileSync(srcAbsPath, destPath);
    if (exec) spawnSync("chmod", ["+x", destPath]);
    console.log(`wrote ${destPath}`);
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
    console.log("husky is NOT installed. The pre-commit hook will not run yet.");
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

async function cmdDoctor() {
  const cwd = process.cwd();
  let warnings = 0;
  let failures = 0;

  function status(label, kind, fix = "") {
    const tag =
      kind === "ok" ? "[ok]  " : kind === "warn" ? "[warn]" : "[fail]";
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
      "`llm-audit demo` will not work; reinstall the package"
    );
  }
  // templates
  if (existsSync(TEMPLATES_DIR)) {
    status("templates bundled", "ok");
  } else {
    status(
      "templates bundled",
      "warn",
      "`llm-audit init` will not work; reinstall the package"
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
      "warn",
      husky.hasPrepare
        ? "fix: npm run prepare"
        : "fix: npm pkg set scripts.prepare='husky' && npm run prepare"
    );
  } else {
    status(
      "husky is not installed",
      "warn",
      "the pre-commit hook will not run until husky is set up; fix: " +
        "npm i -D husky && npm pkg set scripts.prepare='husky' && npm run prepare"
    );
  }
  // hook + workflow files presence
  const hookPath = join(cwd, ".husky", "pre-commit");
  if (existsSync(hookPath)) {
    status(".husky/pre-commit hook present", "ok");
  } else {
    status(
      ".husky/pre-commit hook present",
      "warn",
      "run `npx llm-audit init` to install"
    );
  }
  const wfPath = join(cwd, ".github", "workflows", "llm-audit.yml");
  if (existsSync(wfPath)) {
    status(".github/workflows/llm-audit.yml present", "ok");
  } else {
    status(
      ".github/workflows/llm-audit.yml present",
      "warn",
      "run `npx llm-audit init` to install"
    );
  }

  console.log("");
  console.log("Runtime");
  status(`node ${process.version}`, "ok");

  console.log("");
  if (failures === 0 && warnings === 0) {
    console.log("All checks passed.");
  } else if (failures === 0) {
    console.log(`${warnings} warning${warnings === 1 ? "" : "s"}.`);
  } else {
    console.log(
      `${failures} failure${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`
    );
  }
  process.exit(failures > 0 ? 1 : 0);
}

function helpText() {
  const v = getVersion();
  return `llm-audit ${v}
Static analysis for TypeScript and JavaScript LLM applications.
OWASP LLM Top 10 at commit time.

EXAMPLES
  llm-audit demo                  See the rules fire on bundled fixtures
  llm-audit doctor                Check semgrep, husky, and project state
  llm-audit scan src              Scan a directory (human-readable)
  llm-audit scan --json src       Scan and emit findings as JSON for agents/CI
  llm-audit scan --sarif src      Scan and emit SARIF 2.1.0 for GitHub Code Scanning
  llm-audit init --skill          Install pre-commit hook + CI + Claude Code skill
  llm-audit init --skill-only     Install just the Claude Code skill
  llm-audit init --dry-run        Preview files \`init\` would write

USAGE
  llm-audit <command> [options]

COMMANDS
  demo                            Run the rule pack against bundled fixtures
  doctor                          Diagnose dependencies and project setup
  scan [paths...] [flags]         Run the rule pack against given paths (default: .)
  init [flags]                    Install pre-commit hook + CI workflow + optional skill
  rules                           List rule IDs, severities, and OWASP mappings

SCAN FLAGS
  --json                          Emit findings as JSON (versioned envelope)
  --sarif                         Emit findings as SARIF 2.1.0 (GitHub Code Scanning)

INIT FLAGS
  --force                         Overwrite existing files
  --dry-run                       Preview without writing
  -y, --yes                       Skip the pre-commit hook prompt (accept the default)
  --skill                         Also install the Claude Code skill (.claude/skills/llm-audit/)
  --skill-only                    Install only the skill, not the hook or workflow

FLAGS
  --version                       Print version and exit
  -h, --help                      Show this message

LEARN MORE
  Project page    https://luislozoya.com/llm-audit
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
    cmdRules();
    break;
  case "demo":
    cmdDemo();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "--version":
  case "-v":
    console.log(`llm-audit ${getVersion()}`);
    break;
  case undefined:
  case "-h":
  case "--help":
    // Help requested explicitly: print to stdout per clig.dev.
    process.stdout.write(helpText());
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
