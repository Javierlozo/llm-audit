#!/usr/bin/env node
// llm-audit — CLI entry
//
// Subcommands:
//   scan [paths...]   Run the rule pack with semgrep against given paths (default: .)
//   init              Install a husky pre-commit hook + a GitHub Action workflow
//   rules             List the rule IDs in this pack
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
  process.exit(r.status ?? 1);
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
  console.log("next steps:");
  console.log("  - install husky if you haven't: `npm i -D husky && npx husky init`");
  console.log("  - install semgrep: `brew install semgrep`");
  console.log("  - try a scan: `npx llm-audit scan`");
}

function help() {
  console.log(
`llm-audit — static analysis for LLM-application code

usage:
  llm-audit scan [paths...]   run the rule pack against given paths (default: .)
  llm-audit init              install pre-commit hook + CI workflow
  llm-audit rules             list rule IDs, severities, and OWASP mappings
  llm-audit --help            show this message

rules: ${RULES_DIR}
docs:  ${join(PKG_ROOT, "docs")}`
  );
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
  case undefined:
  case "-h":
  case "--help":
    help();
    break;
  default:
    console.error(`unknown subcommand: ${sub}`);
    help();
    process.exit(2);
}
