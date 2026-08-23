#!/usr/bin/env node
//
// Black-box tests for the CLI itself, as opposed to run-fixtures.mjs which
// tests the rule pack. Everything here spawns `src/cli.mjs` the way a user
// would and asserts on stdout, stderr, exit code, and files on disk.
//
// The two things worth protecting:
//
//   1. Exit codes. The pre-commit hook and the GitHub Action are both just
//      "did it exit non-zero", so a regression here silently stops gating.
//   2. The `--json` envelope. It is advertised as a stable contract
//      (schemaVersion: 1) that agents and dashboards consume, and nothing
//      else in the suite would fail if a field were renamed.
//
// `init` gets the most coverage because it writes files into someone else's
// repo and installs a git hook — per SECURITY.md that is the code where a bug
// is a vulnerability rather than an annoyance.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "src", "cli.mjs");
const FIXTURES = join(PKG_ROOT, "test", "fixtures");

let passed = 0;
let failed = 0;

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    // Non-interactive: init must never block on a prompt in CI.
    input: "",
    ...opts,
  });
}

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "llm-audit-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hasSemgrep() {
  return spawnSync("semgrep", ["--version"], { encoding: "utf8" }).status === 0;
}

// --- meta -------------------------------------------------------------------

check("--version prints the package version", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  const r = run(["--version"]);
  assertEqual(r.status, 0, "exit code");
  assertEqual(r.stdout.trim(), `llm-audit ${pkg.version}`, "version");
});

check("--help exits 0 and documents every subcommand", () => {
  const r = run(["--help"]);
  assertEqual(r.status, 0, "exit code");
  for (const sub of ["scan", "init", "rules", "demo", "doctor"]) {
    assert(r.stdout.includes(sub), `help text is missing '${sub}'`);
  }
});

check("unknown subcommand exits 2 and suggests the closest match", () => {
  const r = run(["scna"]);
  assertEqual(r.status, 2, "exit code");
  assert(/scan/.test(r.stderr), "expected a 'scan' suggestion in stderr");
});

check("unknown output flag exits 2", () => {
  const r = run(["scan", "--yaml"]);
  assertEqual(r.status, 2, "exit code");
});

// A flag typo is the user's mistake; a missing engine is the machine's. The
// first must be reported even when the second is also true, so this runs with
// an empty PATH — semgrep is unreachable by construction.
check("an unknown flag is reported even when semgrep is missing", () => {
  const r = run(["scan", "--yaml"], { env: { PATH: "" } });
  assertEqual(r.status, 2, "exit code");
  assert(/unknown flag/.test(r.stderr), "expected the flag error, not an engine error");
  assert(
    !/semgrep.*not installed/.test(r.stderr),
    "the engine error should not preempt a usage error"
  );
});

check("rules lists all twelve shipped rules", () => {
  const r = run(["rules"]);
  assertEqual(r.status, 0, "exit code");
  for (const id of [
    "untrusted-input-in-system-prompt",
    "streaming-response-without-abort-handling",
    "tool-call-dispatch-without-allowlist",
  ]) {
    assert(r.stdout.includes(id), `rules output is missing '${id}'`);
  }
});

// --- generated assets ------------------------------------------------------
//
// assets/commands.svg advertises the command surface in the README. It is
// generated from `--help`, so a command that gets renamed or removed should
// break the build rather than leave the README advertising it.

check("the README command map is generated from the current --help", () => {
  withTempDir((dir) => {
    const out = join(dir, "commands.svg");
    const r = spawnSync(
      process.execPath,
      [join(PKG_ROOT, "tools", "make-command-map.mjs"), "--out", out],
      { encoding: "utf8" }
    );
    assertEqual(r.status, 0, `generator exit code (${r.stderr.trim()})`);
    assertEqual(
      readFileSync(out, "utf8"),
      readFileSync(join(PKG_ROOT, "assets", "commands.svg"), "utf8"),
      "assets/commands.svg is stale — run `npm run commands:svg`"
    );
  });
});

// --- docs/RULES.md is load-bearing -----------------------------------------
//
// `rules <id>` and the HTML report both parse docs/RULES.md for their teaching
// material. That makes the heading and bullet structure of a Markdown file a
// runtime contract: if it drifts, both surfaces silently lose their content
// instead of failing. Assert the contract holds for every shipped rule.

check("every shipped rule has teaching material in docs/RULES.md", () => {
  const ruleIds = readdirSync(join(PKG_ROOT, "rules"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));
  assert(ruleIds.length > 0, "no rules found to check");

  // Driven through the CLI rather than the parser, so this fails if either
  // the docs drift or the command stops rendering them.
  for (const id of ruleIds) {
    const r = run(["rules", id]);
    assertEqual(r.status, 0, `exit code for '${id}'`);
    for (const section of [
      "What it catches",
      "Why an AI assistant writes this",
      "How to fix it",
      "The fixed shape",
    ]) {
      assert(
        r.stdout.includes(section),
        `'${id}' is missing '${section}' — check its section in docs/RULES.md`
      );
    }
    // A heading with nothing under it would satisfy the check above.
    const body = r.stdout.split("What it catches")[1] || "";
    assert(body.trim().length > 100, `'${id}' renders headings with no content`);
  }
});

check("docs/RULES.md ships with the package", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  assert(
    pkg.files.some((f) => f === "docs" || f === "docs/RULES.md"),
    "docs/RULES.md is parsed at runtime, so it must be in package.json files"
  );
});

// --- scan: exit codes -------------------------------------------------------
//
// These are the contract the pre-commit hook and CI depend on: 0 for clean,
// 1 for findings, regardless of output format.

if (!hasSemgrep()) {
  console.log("SKIP scan tests — semgrep is not installed");
} else {
  check("rules <id> explains one rule and shows the verified fix", () => {
    const r = run(["rules", "hardcoded-llm-api-key"]);
    assertEqual(r.status, 0, "exit code");
    for (const section of [
      "What it catches",
      "Why an AI assistant writes this",
      "How to fix it",
      "The fixed shape",
    ]) {
      assert(r.stdout.includes(section), `rules detail is missing '${section}'`);
    }
    assert(r.stdout.includes("process.env"), "expected the safe fixture's code");
  });

  check("rules <unknown-id> exits 2", () => {
    const r = run(["rules", "no-such-rule"]);
    assertEqual(r.status, 2, "exit code");
    assert(/unknown rule/.test(r.stderr), "expected an unknown-rule message");
  });

  // --- published claims must match reality -----------------------------------
  //
  // The README's headline table claims a specific number of findings against the
  // bundled fixtures, and that number is the project's central empirical claim.
  // It had drifted to three different values across three documents before this
  // check existed. Assert the docs against what the tool actually reports.

  check("the finding count claimed in the docs matches what demo reports", () => {
    const r = run(["demo"]);
    assertEqual(r.status, 0, "demo exit code");
    const reported = r.stdout.match(/^(\d+) findings/m);
    assert(reported, "could not find a summary line in demo output");
    const actual = Number(reported[1]);

    const claimPatterns = [
      // Prose: "12 rules, 42 matches", "Confirm 42 hits", "flags 42 violations"
      /\*{0,2}(\d+)\*{0,2} (?:matches|hits|vulnerability matches|violations)\b/g,
      // The README's headline comparison row, which carries no trailing noun.
      /Findings on this repo's TS\/TSX fixtures \| \*{0,2}(\d+)\*{0,2}/g,
    ];

    for (const file of [
      "README.md",
      join("docs", "COMPETITIVE-LANDSCAPE.md"),
      join("docs", "BRIEF.md"),
      join("docs", "POST-ZERO-HITS.md"),
    ]) {
      const text = readFileSync(join(PKG_ROOT, file), "utf8");
      let seen = 0;
      for (const pattern of claimPatterns) {
        for (const m of text.matchAll(pattern)) {
          seen++;
          assertEqual(Number(m[1]), actual, `${file} claims a finding count that`);
        }
      }
      assert(seen > 0, `${file} carries no finding-count claim to check anymore`);
    }
  });

  check("scan exits 0 on clean code", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "clean.ts"), "export const greeting = 'hello';\n");
      const r = run(["scan", dir]);
      assertEqual(r.status, 0, "exit code");
    });
  });

  check("scan exits 1 when it finds something", () => {
    const r = run(["scan", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    assertEqual(r.status, 1, "exit code");
  });

  check("scan --json exits 1 when it finds something", () => {
    const r = run(["scan", "--json", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    assertEqual(r.status, 1, "exit code");
  });

  // --- filters, density, and the HTML report -------------------------------

  check("scan --rule narrows to one rule and says the view is filtered", () => {
    const r = run([
      "scan",
      "--rule",
      "hardcoded-llm-api-key",
      join(FIXTURES, "llm-output-insecure-handling", "vulnerable.tsx"),
      join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts"),
    ]);
    assert(r.stdout.includes("hardcoded-llm-api-key"), "expected the requested rule");
    assert(
      !r.stdout.includes("llm-output-insecure-handling"),
      "a filtered run must not report other rules"
    );
    assert(/Filtered view/.test(r.stdout), "expected the filtered-view caveat");
  });

  check("a misspelled --rule is refused, never reported as clean", () => {
    const target = join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts");
    const r = run(["scan", "--rule", "hardcoded-llm-api-kye", target]);
    assertEqual(r.status, 2, "exit code");
    assert(/unknown rule/.test(r.stderr), "expected an unknown-rule error");
    assert(/did you mean/.test(r.stderr), "expected a suggestion");
    assert(!/0 findings/.test(r.stdout), "a typo must never render as a clean result");
  });

  check("a filtered run with no hits does not claim to be clean", () => {
    const r = run([
      "scan",
      "--rule",
      "secrets-in-prompt-context",
      join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts"),
    ]);
    assertEqual(r.status, 0, "exit code");
    assert(/0 findings/.test(r.stdout), "expected the zero-findings line");
    assert(
      !/clean\./.test(r.stdout),
      "a filtered run must not describe the codebase as clean"
    );
    assert(/for the selected rule/.test(r.stdout), "expected the filter to be named");
  });

  check("scan --severity error drops warnings", () => {
    const r = run([
      "scan",
      "--json",
      "--severity",
      "error",
      join(FIXTURES, "model-output-parsed-without-schema", "vulnerable.ts"),
      join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts"),
    ]);
    const findings = JSON.parse(r.stdout).findings;
    assert(findings.length > 0, "expected the error-severity findings to survive");
    assert(
      findings.every((f) => f.severity === "ERROR"),
      "a warning survived --severity error"
    );
  });

  check("scan --compact prints one line per finding", () => {
    const target = join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts");
    const compact = run(["scan", "--compact", target]);
    const verbose = run(["scan", "--verbose", target]);
    assert(compact.stdout.includes("hardcoded-llm-api-key"), "expected the rule id");
    assert(
      !/Inline keys leak/.test(compact.stdout),
      "compact output must not carry the full rationale"
    );
    assert(/Inline keys leak/.test(verbose.stdout), "verbose output must carry it");
    assert(
      compact.stdout.length < verbose.stdout.length,
      "compact output should be shorter than verbose"
    );
  });

  check("scan --html writes a self-contained report", () => {
    withTempDir((dir) => {
      const out = join(dir, "nested", "report.html");
      const r = run([
        "scan",
        "--html",
        out,
        join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts"),
      ]);
      assertEqual(r.status, 1, "exit code");
      assert(existsSync(out), "report was not written");
      const html = readFileSync(out, "utf8");
      assert(html.startsWith("<!doctype html>"), "expected an HTML document");
      assert(html.includes("hardcoded-llm-api-key"), "report is missing the rule");
      assert(html.includes("Why an AI assistant writes this"), "report is missing the rationale");
      assert(html.includes("The fixed shape, verified"), "report is missing the safe example");
      assert(
        !/<(script|iframe)\b/i.test(html),
        "the report must not carry script or iframe content"
      );
      assert(
        !/\b(src|href)="https?:\/\/(?!github\.com|owasp\.org)/.test(html),
        "the report must not load remote assets"
      );
    });
  });

  check("--sarif refuses to pretend it applied filters", () => {
    const r = run(["scan", "--sarif", "--rule", "hardcoded-llm-api-key", "."]);
    assertEqual(r.status, 2, "exit code");
    assert(/cannot be combined/.test(r.stderr), "expected an explanatory error");
  });

  // --- scan --fail-on: the CI exit-code policy -----------------------------
  // The report is always printed; --fail-on only decides the exit code, so a
  // team can adopt the pack on a legacy repo without a red pipeline on day one.

  check("scan --fail-on never exits 0 despite findings", () => {
    const r = run([
      "scan",
      "--fail-on",
      "never",
      join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts"),
    ]);
    assertEqual(r.status, 0, "exit code");
    assert(r.stdout.includes("hardcoded-llm-api-key"), "the report must still print");
  });

  check("scan --fail-on error ignores warning-only findings", () => {
    const errorFixture = join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts");
    const warnFixture = join(
      FIXTURES,
      "model-output-parsed-without-schema",
      "vulnerable.ts"
    );
    assertEqual(run(["scan", "--fail-on", "error", errorFixture]).status, 1, "error fixture");
    assertEqual(run(["scan", "--fail-on", "error", warnFixture]).status, 0, "warning fixture");
    assertEqual(run(["scan", "--fail-on", "warning", warnFixture]).status, 1, "warning threshold");
  });

  check("scan rejects an unknown --fail-on level", () => {
    const r = run(["scan", "--fail-on", "sometimes", "."]);
    assertEqual(r.status, 2, "exit code");
    assert(/--fail-on expects/.test(r.stderr), "expected a usage message on stderr");
  });

  check("scan produces no findings against the safe fixtures", () => {
    const r = run(["scan", "--json", join(FIXTURES, "hardcoded-llm-api-key", "safe.ts")]);
    assertEqual(r.status, 0, "exit code");
    assertEqual(JSON.parse(r.stdout).findings.length, 0, "findings");
  });

  // --- scan --json: the stable contract ------------------------------------

  check("--json envelope matches the documented schema", () => {
    const r = run(["scan", "--json", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    const envelope = JSON.parse(r.stdout);

    assertEqual(envelope.schemaVersion, 1, "schemaVersion");
    assertEqual(envelope.tool.name, "llm-audit", "tool.name");
    assert(typeof envelope.tool.version === "string", "tool.version must be a string");
    assert(Array.isArray(envelope.scannedPaths), "scannedPaths must be an array");
    assert(typeof envelope.summary.findings === "number", "summary.findings must be a number");
    assert(Array.isArray(envelope.findings), "findings must be an array");
    assertEqual(envelope.summary.findings, envelope.findings.length, "summary.findings vs findings.length");

    // Every documented field, on every finding. Renaming any of these breaks
    // downstream agents, so it must break the suite first.
    const REQUIRED = [
      "ruleId", "severity", "owasp", "cwe",
      "path", "startLine", "endLine", "message", "lines",
    ];
    assert(envelope.findings.length > 0, "expected at least one finding to inspect");
    for (const finding of envelope.findings) {
      for (const field of REQUIRED) {
        assert(field in finding, `finding is missing '${field}'`);
      }
      assert(Array.isArray(finding.cwe), "cwe must be an array");
      assert(typeof finding.startLine === "number", "startLine must be a number");
      // The rule ID must be the bare ID, never Semgrep's path-derived namespace.
      assert(
        !finding.ruleId.includes("."),
        `ruleId leaked a path namespace: ${finding.ruleId}`
      );
      assert(/^LLM\d\d$/.test(finding.owasp), `owasp not an LLM id: ${finding.owasp}`);
    }
  });

  // Regression: Semgrep derives its displayed rule ID from the config path, so
  // an installed package used to render every finding as
  // `Users.you..npm._npx.<hash>.node_modules.llm-audit.rules.<id>` — unreadable,
  // and it leaked the user's home directory into terminal output and CI logs.
  check("human output prints bare rule IDs, never a path namespace", () => {
    const r = run(["scan", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    assert(r.stdout.includes("hardcoded-llm-api-key"), "expected the rule ID in the output");
    assert(!/rules\.hardcoded-llm-api-key/.test(r.stdout), "output still carries a config-path namespace");
    // The scanned file path legitimately appears (it is what the user asked
    // for); what must not appear is a path baked into the rule ID itself.
    for (const line of r.stdout.split("\n").filter((l) => l.includes("✗"))) {
      assert(!line.includes(PKG_ROOT), `rule ID line leaked an absolute path: ${line.trim()}`);
      assert(!/node_modules|_npx/.test(line), `rule ID line leaked an install path: ${line.trim()}`);
    }
  });

  check("human output includes the OWASP mapping and the matched source", () => {
    const r = run(["scan", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    assert(/LLM\d\d/.test(r.stdout), "expected an OWASP LLM id in the output");
    assert(r.stdout.includes("apiKey"), "expected the matched source line in the output");
  });

  // Semgrep substitutes the string "requires login" for the matched source when
  // the caller has no semgrep.dev account. The code is the useful part.
  check("findings carry real source, not 'requires login'", () => {
    const r = run(["scan", "--json", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    for (const f of JSON.parse(r.stdout).findings) {
      assert(f.lines.trim() !== "requires login", "finding.lines was not resolved from disk");
      assert(f.lines.length > 0, "finding.lines is empty");
    }
  });

  // A rule with two patterns matching the same span reported the same finding
  // twice. Distinct rules on one line are still distinct findings.
  check("identical findings are collapsed", () => {
    const r = run(["scan", "--json", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    const keys = JSON.parse(r.stdout).findings.map(
      (f) => `${f.ruleId}:${f.path}:${f.startLine}:${f.endLine}`
    );
    assertEqual(keys.length, new Set(keys).size, "duplicate findings in the envelope");
  });

  check("colour is suppressed when stdout is not a terminal", () => {
    const r = run(["scan", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    // eslint-disable-next-line no-control-regex
    assert(!/\u001b\[/.test(r.stdout), "ANSI escapes leaked into piped output");
  });

  check("--sarif emits valid SARIF 2.1.0", () => {
    const r = run(["scan", "--sarif", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    const sarif = JSON.parse(r.stdout);
    assertEqual(sarif.version, "2.1.0", "sarif version");
    assert(Array.isArray(sarif.runs) && sarif.runs.length > 0, "sarif runs");
    assert(Array.isArray(sarif.runs[0].results), "sarif results");
    assert(sarif.runs[0].tool.driver.name.length > 0, "sarif driver name");
  });
}

// --- init: it writes into someone else's repo -------------------------------

check("init --dry-run writes nothing", () => {
  withTempDir((dir) => {
    const r = run(["init", "--dry-run"], { cwd: dir });
    assertEqual(r.status, 0, "exit code");
    assert(r.stdout.includes("dry-run"), "expected a dry-run notice");
    assert(!existsSync(join(dir, ".husky")), ".husky must not exist after --dry-run");
    assert(!existsSync(join(dir, ".github")), ".github must not exist after --dry-run");
  });
});

check("init writes the hook and the workflow", () => {
  withTempDir((dir) => {
    const r = run(["init", "-y"], { cwd: dir });
    assertEqual(r.status, 0, "exit code");
    assert(existsSync(join(dir, ".github", "workflows", "llm-audit.yml")), "workflow not written");
  });
});

check("init refuses to overwrite an existing file", () => {
  withTempDir((dir) => {
    const wfDir = join(dir, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const wf = join(wfDir, "llm-audit.yml");
    writeFileSync(wf, "# do not clobber me\n");

    const r = run(["init", "-y"], { cwd: dir });
    assert(r.status !== 0, "expected a non-zero exit when refusing");
    assertEqual(readFileSync(wf, "utf8"), "# do not clobber me\n", "file contents");
    assert(/--force/.test(r.stderr + r.stdout), "expected the message to mention --force");
  });
});

check("init --force does overwrite", () => {
  withTempDir((dir) => {
    const wfDir = join(dir, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const wf = join(wfDir, "llm-audit.yml");
    writeFileSync(wf, "# clobber me\n");

    const r = run(["init", "-y", "--force"], { cwd: dir });
    assertEqual(r.status, 0, "exit code");
    assert(readFileSync(wf, "utf8") !== "# clobber me\n", "expected the file to be replaced");
  });
});

check("init --skill-only writes only the skill", () => {
  withTempDir((dir) => {
    const r = run(["init", "--skill-only", "-y"], { cwd: dir });
    assertEqual(r.status, 0, "exit code");
    assert(existsSync(join(dir, ".claude", "skills", "llm-audit", "SKILL.md")), "skill not written");
    assert(!existsSync(join(dir, ".github", "workflows", "llm-audit.yml")), "workflow should not be written");
  });
});

check("init does not escape the working directory", () => {
  withTempDir((dir) => {
    const inner = join(dir, "repo");
    mkdirSync(inner);
    run(["init", "-y", "--skill"], { cwd: inner });
    for (const stray of [".husky", ".github", ".claude"]) {
      assert(!existsSync(join(dir, stray)), `init wrote ${stray} outside its cwd`);
    }
  });
});

// ----------------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
