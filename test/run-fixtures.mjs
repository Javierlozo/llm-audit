#!/usr/bin/env node
// Fixture runner for the llm-audit rule pack.
//
// For each rule in rules/<id>.yaml, runs semgrep against the matching
// fixture directory test/fixtures/<id>/ and asserts:
//   - vulnerable.* triggers the rule at every `// ruleid: <id>` marker
//   - safe.* triggers no findings
//
// Exits 0 on success, 1 on assertion failure, 127 if semgrep is missing.

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RULES_DIR = join(ROOT, "rules");
const FIXTURES_DIR = join(ROOT, "test", "fixtures");

function ensureSemgrep() {
  const r = spawnSync("semgrep", ["--version"], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error("semgrep not found. install with: brew install semgrep");
    process.exit(127);
  }
}

function runSemgrep(ruleFile, target) {
  const r = spawnSync(
    "semgrep",
    ["--config", ruleFile, "--json", "--metrics=off", "--quiet", target],
    { encoding: "utf8" }
  );
  if (r.status !== 0 && r.status !== 1) {
    console.error(`semgrep error on ${target}:`, r.stderr);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    console.error(`could not parse semgrep output for ${target}`);
    return null;
  }
  // Defense-in-depth: validate the shape we depend on. Same pattern our
  // own model-output-parsed-without-schema rule warns against, but the
  // source here is trusted (semgrep's documented JSON schema).
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.results)) {
    console.error(`unexpected semgrep output shape for ${target}`);
    return null;
  }
  return parsed;
}

function countMarkers(filePath, ruleId) {
  const text = readFileSync(filePath, "utf8");
  const re = new RegExp(`//\\s*ruleid:\\s*${ruleId}\\b`, "g");
  return (text.match(re) || []).length;
}

function main() {
  ensureSemgrep();
  const ruleFiles = readdirSync(RULES_DIR).filter((f) => f.endsWith(".yaml"));
  let failed = 0;

  for (const ruleFile of ruleFiles) {
    const ruleId = ruleFile.replace(/\.yaml$/, "");
    const fixtureDir = join(FIXTURES_DIR, ruleId);
    if (!existsSync(fixtureDir)) {
      console.log(`SKIP ${ruleId} (no fixtures at ${fixtureDir})`);
      continue;
    }

    const vulnerablePath = ["vulnerable.ts", "vulnerable.tsx", "vulnerable.js"]
      .map((n) => join(fixtureDir, n))
      .find(existsSync);
    const safePath = ["safe.ts", "safe.tsx", "safe.js"]
      .map((n) => join(fixtureDir, n))
      .find(existsSync);

    if (!vulnerablePath || !safePath) {
      console.log(`FAIL ${ruleId}: missing vulnerable.* or safe.* fixture`);
      failed++;
      continue;
    }

    const expected = countMarkers(vulnerablePath, ruleId);
    const vulnRes = runSemgrep(join(RULES_DIR, ruleFile), vulnerablePath);
    const safeRes = runSemgrep(join(RULES_DIR, ruleFile), safePath);
    if (!vulnRes || !safeRes) {
      failed++;
      continue;
    }

    const vulnHits = vulnRes.results.length;
    const safeHits = safeRes.results.length;

    if (vulnHits >= expected && safeHits === 0) {
      console.log(`PASS ${ruleId}  vulnerable=${vulnHits}/${expected}  safe=${safeHits}`);
    } else {
      console.log(
        `FAIL ${ruleId}  vulnerable=${vulnHits}/${expected}  safe=${safeHits}`
      );
      failed++;
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} rule(s) failed.`);
    process.exit(1);
  }
  console.log("\nall fixtures passed.");
}

main();
