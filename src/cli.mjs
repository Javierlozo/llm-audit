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
import { dirname, join, resolve } from "node:path";

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
    // Human-readable run via semgrep's default formatter.
    // `--` locks interpretation: any path starting with `-` is a path,
    // not a semgrep flag. Defends against scenarios where a wrapper or
    // piped input could inject semgrep flags via path arguments.
    const r = spawnSync(
      "semgrep",
      ["--config", RULES_DIR, "--error", "--metrics=off", "--", ...targetPaths],
      { stdio: "inherit" }
    );
    // `semgrep --error` exits 0 when nothing fires, 1 when at least one
    // rule hit. A clean scan can feel anticlimactic; nudge first-time
    // users toward `demo` so they can see what the rules look like when
    // they fire.
    if (r.status === 0) {
      console.log("");
      console.log(
        "0 findings — clean. To see what these rules catch on intentionally"
      );
      console.log("vulnerable code, try: `npx llm-audit demo`");
    }
    process.exit(r.status ?? 1);
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

  // outputFormat === "json": run semgrep with --json, capture stdout,
  // wrap in our versioned envelope, emit to stdout. Exit 0 on no
  // findings, 1 on findings, mirrors human-mode convention.
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
    { encoding: "utf8" }
  );

  if (r.status !== 0 && r.status !== 1) {
    process.stderr.write(r.stderr || "");
    process.exit(r.status ?? 1);
  }

  let semgrepOut;
  try {
    semgrepOut = JSON.parse(r.stdout);
  } catch (e) {
    process.stderr.write(
      `error: could not parse semgrep output: ${e.message}\n`
    );
    process.exit(1);
  }
  if (
    !semgrepOut ||
    typeof semgrepOut !== "object" ||
    !Array.isArray(semgrepOut.results)
  ) {
    process.stderr.write("error: unexpected semgrep output shape\n");
    process.exit(1);
  }

  const envelope = {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: "llm-audit", version: getVersion() },
    scannedPaths: targetPaths,
    summary: {
      findings: semgrepOut.results.length,
    },
    findings: semgrepOut.results.map((f) => ({
      ruleId: ((f.check_id || "") + "").split(".").pop(),
      severity: f.extra?.severity || "INFO",
      owasp: f.extra?.metadata?.["owasp-llm"] || null,
      cwe: Array.isArray(f.extra?.metadata?.cwe) ? f.extra.metadata.cwe : [],
      path: f.path,
      startLine: f.start?.line,
      endLine: f.end?.line,
      message: ((f.extra?.message || "") + "").trim(),
      lines: f.extra?.lines || "",
    })),
  };

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

  // Run all rules against all vulnerable fixtures in one pass.
  const r = spawnSync(
    "semgrep",
    ["--config", RULES_DIR, "--metrics=off", "--", ...vulnerableFiles],
    { stdio: "inherit" }
  );

  console.log("");
  console.log("Next steps:");
  console.log("  - run on your own repo:        `npx llm-audit scan`");
  console.log("  - wire up pre-commit + CI:     `npx llm-audit init`");
  console.log("  - read the rule rationale:     https://github.com/Javierlozo/llm-audit/blob/main/docs/RULES.md");
  console.log("  - read the project brief:      https://luislozoya.com/llm-audit");
  // Always exit 0: finding things is the point of demo, not a failure.
  process.exit(r.status === 0 || r.status === 1 ? 0 : (r.status ?? 1));
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

function cmdInit(args) {
  const cwd = process.cwd();
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const installSkill = args.includes("--skill") || args.includes("--skill-only");
  const skillOnly = args.includes("--skill-only");

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
    // Husky pre-commit
    const huskyDir = join(cwd, ".husky");
    if (!existsSync(huskyDir) && !dryRun) {
      mkdirSync(huskyDir, { recursive: true });
    }
    writeOrRefuse(
      join(TEMPLATES_DIR, "husky-pre-commit"),
      join(huskyDir, "pre-commit"),
      true
    );

    // GitHub Action
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
    cmdInit(rest);
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
