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

const KNOWN_SUBCOMMANDS = ["demo", "scan", "init", "rules"];

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

function ensureSemgrep() {
  const r = spawnSync("semgrep", ["--version"], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error("error: `semgrep` is not installed or not on PATH.");
    console.error("install: `brew install semgrep` or `pipx install semgrep`");
    process.exit(127);
  }
}

function cmdScan(args) {
  ensureSemgrep();
  const paths = args.length ? args : ["."];
  // Use `--` to lock interpretation: any path starting with `-` is a path,
  // not a semgrep flag. Defends against scenarios where a wrapper or piped
  // input could otherwise inject semgrep flags via path arguments.
  const r = spawnSync(
    "semgrep",
    ["--config", RULES_DIR, "--error", "--metrics=off", "--", ...paths],
    { stdio: "inherit" }
  );
  // `semgrep --error` exits 0 when nothing fires, 1 when at least one rule
  // hit. A clean scan can feel anticlimactic; nudge first-time users toward
  // `demo` so they can see what the rules look like when they fire.
  if (r.status === 0) {
    console.log("");
    console.log(
      "0 findings — clean. To see what these rules catch on intentionally"
    );
    console.log("vulnerable code, try: `npx llm-audit demo`");
  }
  process.exit(r.status ?? 1);
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

  function writeOrRefuse(srcRelTemplate, destPath, exec = false) {
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
    copyFileSync(join(TEMPLATES_DIR, srcRelTemplate), destPath);
    if (exec) spawnSync("chmod", ["+x", destPath]);
    console.log(`wrote ${destPath}`);
  }

  // Husky pre-commit
  const huskyDir = join(cwd, ".husky");
  if (!existsSync(huskyDir)) mkdirSync(huskyDir, { recursive: true });
  writeOrRefuse("husky-pre-commit", join(huskyDir, "pre-commit"), true);

  // GitHub Action
  const ghDir = join(cwd, ".github", "workflows");
  if (!existsSync(ghDir)) mkdirSync(ghDir, { recursive: true });
  writeOrRefuse("github-action.yml", join(ghDir, "llm-audit.yml"));

  console.log("");
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

function helpText() {
  const v = getVersion();
  return `llm-audit ${v}
Static analysis for TypeScript and JavaScript LLM applications.
OWASP LLM Top 10 at commit time.

EXAMPLES
  llm-audit demo                  See the rules fire on bundled fixtures
  llm-audit scan src              Scan a directory in your project
  llm-audit init                  Wire up pre-commit hook + CI workflow

USAGE
  llm-audit <command> [options]

COMMANDS
  demo                            Run the rule pack against bundled fixtures
  scan [paths...]                 Run the rule pack against given paths (default: .)
  init [--force]                  Install pre-commit hook + CI workflow
  rules                           List rule IDs, severities, and OWASP mappings

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
