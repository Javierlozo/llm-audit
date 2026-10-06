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
import { createHash } from "node:crypto";
import { LESSONS, fixPrompt, groupFindings } from "../src/lessons.mjs";
import { learnLink, unpack, redact } from "../src/share.mjs";
import { renderLearnPage } from "../src/learn.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "src", "cli.mjs");
const FIXTURES = join(PKG_ROOT, "test", "fixtures");

// The suite runs in GitHub Actions too. Scans of deliberately vulnerable
// fixtures must not turn into annotations on this repo's own pull requests,
// so the children never see the runner's variables unless a test sets them.
delete process.env.GITHUB_ACTIONS;
delete process.env.GITHUB_STEP_SUMMARY;

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

check("common wrong words map to the right command", () => {
  for (const [typed, expected] of [["delete", "uninstall"], ["remove", "uninstall"], ["setup", "init"]]) {
    const r = run([typed]);
    assertEqual(r.status, 2, `exit code for '${typed}'`);
    assert(
      r.stderr.includes(expected),
      `'${typed}' should point at '${expected}', got: ${r.stderr.trim()}`
    );
  }
});

check("init is idempotent and says so", () => {
  withTempDir((dir) => {
    const first = run(["init", "-y"], { cwd: dir });
    assertEqual(first.status, 0, "first init");
    const second = run(["init", "-y"], { cwd: dir });
    assertEqual(second.status, 0, "second init must not fail");
    assert(
      /already installed|already installed and up to date/i.test(second.stdout),
      `expected init to report it is already installed, got: ${second.stdout.trim()}`
    );
  });
});

check("uninstall removes what init wrote, and nothing else", () => {
  withTempDir((dir) => {
    run(["init", "-y"], { cwd: dir });
    const hook = join(dir, ".husky", "pre-commit");
    const workflow = join(dir, ".github", "workflows", "llm-audit.yml");
    assert(existsSync(hook) && existsSync(workflow), "init did not write both files");

    // A file we did not write must survive.
    const theirs = join(dir, ".github", "workflows", "their-ci.yml");
    writeFileSync(theirs, "name: theirs\n");

    const r = run(["uninstall", "-y"], { cwd: dir });
    assertEqual(r.status, 0, "exit code");
    assert(!existsSync(hook), "hook was not removed");
    assert(!existsSync(workflow), "workflow was not removed");
    assert(existsSync(theirs), "uninstall removed a file it did not write");
  });
});

check("uninstall leaves a hook it did not write", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, ".husky"), { recursive: true });
    const hook = join(dir, ".husky", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nnpm run lint-staged\n");
    const r = run(["uninstall", "-y"], { cwd: dir });
    assert(existsSync(hook), "somebody else's hook was deleted");
    assert(/Leaving/.test(r.stdout), "expected uninstall to say what it left alone");
  });
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

check("doctor treats optional setup as a note, not a warning", () => {
  withTempDir((dir) => {
    const r = run(["doctor"], { cwd: dir });
    const lines = r.stdout.split("\n").filter((l) => /pre-commit|workflows|husky/.test(l));
    assert(lines.length > 0, "expected doctor to report on the hook and workflow");
    for (const line of lines) {
      // Nothing is wrong in an empty project: it simply has not adopted the
      // hook. Warning about a choice trains people to ignore warnings.
      assert(!/\[warn\]/.test(line), `optional setup reported as a warning: ${line.trim()}`);
      if (/\[note\]/.test(line)) {
        assert(!/present/.test(line), `doctor contradicts itself: ${line.trim()}`);
      }
    }
    // A bare temp directory still warns that it is not a git repository, which
    // is a real finding. What must not warn is the optional hook setup.
    assert(!/husky/.test(r.stdout.match(/\[warn\].*/g)?.join("\n") || ""), "husky warned");
  });
});

check("doctor warns when a hook is installed that cannot run", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, ".husky"), { recursive: true });
    writeFileSync(join(dir, ".husky", "pre-commit"), "npx llm-audit scan\n");
    const r = run(["doctor"], { cwd: dir });
    assert(
      /\[warn\].*husky isn't installed, but a pre-commit hook is/.test(r.stdout),
      "a hook with no husky to run it must warn"
    );
  });
});

// The workflow we install into other people's repositories pins its actions by
// SHA. A pin whose comment names a different version than the SHA is worse than
// no comment: it is an audit trail that lies. This repo shipped one for months.
//
// Synchronous on purpose. `check` does not await, so an async body would report
// PASS before its assertions ran.
check("the installed workflow's action pins match their version comments", () => {
  const workflow = readFileSync(join(PKG_ROOT, "templates", "github-action.yml"), "utf8");
  const pins = [...workflow.matchAll(/uses: (actions\/[\w-]+)@([0-9a-f]{40})\s+# (v[\d.]+)/g)];
  assert(pins.length > 0, "expected SHA-pinned actions in the template");

  for (const [, action, sha, claimed] of pins) {
    const r = spawnSync(
      "curl",
      ["-sS", "--max-time", "10", `https://api.github.com/repos/${action}/git/refs/tags`],
      { encoding: "utf8" }
    );
    // Offline, rate limited, or no curl: skip rather than fail the suite.
    if (r.status !== 0 || !r.stdout) return;
    let tags;
    try {
      tags = JSON.parse(r.stdout);
    } catch {
      return;
    }
    if (!Array.isArray(tags)) return;

    const matching = tags
      .filter((t) => t.object && t.object.sha === sha)
      .map((t) => t.ref.replace("refs/tags/", ""));
    if (matching.length === 0) return;

    assert(
      matching.includes(claimed),
      `${action} is pinned to ${sha.slice(0, 7)} but commented ${claimed}; ` +
        `upstream tags that SHA as ${matching.join(", ")}`
    );
  }
});

// The scan reads source files. Making CI install the project's dependency tree
// first means the security job fails for reasons that are not security: a lock
// file out of sync, a private registry, a postinstall script wanting secrets.
// That happened on a real repo the day this was written.
check("the installed workflow does not depend on the project's dependencies", () => {
  const workflow = readFileSync(join(PKG_ROOT, "templates", "github-action.yml"), "utf8");
  const steps = workflow
    .split("\n")
    .filter((l) => /^\s+run:/.test(l))
    .join("\n");
  assert(!/npm ci\b/.test(steps), "the workflow must not run `npm ci`");
  assert(!/npm i(nstall)?\b(?!.*-g)/.test(steps), "the workflow must not install project deps");
  assert(/npx --yes llm-audit scan/.test(steps), "expected the scan step");
});

// --- the learn page ---------------------------------------------------------
//
// Lessons are the teaching layer, the learn link carries a scan to them, and
// the page renders whatever a link says. The page's input is untrusted (anyone
// can craft a link), so the checks below lean on what it must never do.

check("every rule belongs to exactly one lesson, and every lesson is complete", () => {
  const ruleIds = readdirSync(join(PKG_ROOT, "rules"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));
  for (const id of ruleIds) {
    const owners = LESSONS.filter((l) => l.rules.includes(id));
    assertEqual(owners.length, 1, `lessons teaching '${id}'`);
  }
  for (const l of LESSONS) {
    for (const r of l.rules) assert(ruleIds.includes(r), `lesson '${l.slug}' names unknown rule '${r}'`);
    for (const key of ["slug", "title", "summary", "askPrompt"]) {
      assert(typeof l[key] === "string" && l[key].length > 0, `lesson '${l.slug}' has no ${key}`);
    }
    assert(l.explanation.length && l.spotIt.length && l.exploit.steps.length, `lesson '${l.slug}' has an empty list`);
    assert(l.fix.problem && l.fix.steps.length && l.fix.after, `lesson '${l.slug}' has an incomplete fix`);
  }
  assertEqual(new Set(LESSONS.map((l) => l.slug)).size, LESSONS.length, "unique lesson slugs");
});

check("the fix prompt lists each place once", () => {
  const text = fixPrompt(LESSONS[0], [
    { path: "a.ts", startLine: 3, endLine: 3 },
    { path: "a.ts", startLine: 3, endLine: 3 },
    { path: "b.ts", startLine: 4, endLine: 9 },
  ]);
  assertEqual(text.split("a.ts line 3").length - 1, 1, "a.ts line 3 occurrences");
  assert(text.includes("b.ts lines 4 to 9"), "expected a line range");
});

check("secrets are redacted before they go into a link", () => {
  for (const line of [
    `const client = new OpenAI({ apiKey: "sk-proj-abcdefghijklmnop1234" });`,
    `const k = "sk-ant-api03-abcdefghijklmnopqrstuv";`,
    `aws = "AKIAABCDEFGHIJKLMNOP"`,
    `token: "ghp_abcdefghijklmnopqrstuvwxyz123456"`,
    `password = "correct-horse-battery-staple"`,
  ]) {
    const out = redact(line);
    assert(out.includes("[redacted]"), `not redacted: ${line}`);
    assert(!/abcdefghijklmnop|ABCDEFGHIJKLMNOP|horse-battery/.test(out), `secret survived: ${out}`);
  }
  assertEqual(redact("const x = process.env.OPENAI_API_KEY;"), "const x = process.env.OPENAI_API_KEY;", "env reads untouched");
});

function fakeEnvelope(n, lines = (i) => ["const a = 1;"]) {
  return {
    tool: { version: "0.0.0" },
    repo: { branch: "main", shortCommit: "abcdef12", dirty: true },
    scannedPaths: ["src"],
    findings: Array.from({ length: n }, (_, i) => ({
      ruleId: "hardcoded-llm-api-key",
      severity: "ERROR",
      path: `src/file-${i}.ts`,
      startLine: i + 1,
      endLine: i + 1,
      lines: lines(i).join("\n"),
    })),
  };
}

check("a learn link round-trips its scan in the fragment", () => {
  const { url, detail } = learnLink(fakeEnvelope(3), { base: "https://example.test/learn/" });
  assertEqual(detail, "context", "detail");
  assert(url.startsWith("https://example.test/learn/#r="), `unexpected url: ${url.slice(0, 60)}`);
  const payload = unpack(url.split("#r=")[1]);
  assertEqual(payload.v, 1, "payload version");
  assertEqual(payload.f.length, 3, "findings in payload");
  assertEqual(payload.f[1][2], "src/file-1.ts", "path");
  assertEqual(payload.repo.dirty, true, "provenance");
});

check("a learn link sheds code before it gets too long to paste", () => {
  // Incompressible lines, so size tracks the code and not just the count.
  const noisy = (i) =>
    Array.from({ length: 5 }, (_, j) => createHash("sha256").update(`${i}:${j}`).digest("hex"));
  const big = learnLink(fakeEnvelope(60, noisy));
  assert(big.url && big.detail !== "context", `expected trimmed detail, got ${big.detail}`);
  const huge = learnLink(fakeEnvelope(4000, noisy));
  assertEqual(huge.url, null, "an unpasteable link is not offered");
});

check("the learn page runs only its own hashed code and loads nothing", () => {
  const html = renderLearnPage({ version: "0.0.0" });
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert(csp.includes("default-src 'none'"), "CSP must default to none");
  const hash = (t) => `'sha256-${createHash("sha256").update(t, "utf8").digest("base64")}'`;
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert(csp.includes(hash(style)), "style hash does not match the inline style");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assertEqual(scripts.length, 1, "executable inline scripts");
  assert(csp.includes(hash(scripts[0])), "script hash does not match the inline script");
  assert(!/\b(src|href)="(https?:)?\/\//.test(html), "the page must not reference anything remote");
  assert(!/\sstyle="/.test(html), "inline style attributes are blocked by the CSP");
  assert(scripts[0].includes(fixPrompt.toString()), "the page must use the CLI's fixPrompt, not a copy");
  assert(scripts[0].includes(groupFindings.toString()), "the page must number lessons with the CLI's grouping");
  assert(!scripts[0].includes("@@PROMPT@@"), "fixPrompt placeholder was not replaced");
});

check("scan data cannot break out of the learn page's data block", () => {
  const html = renderLearnPage({
    scan: { v: 1, f: [["x", "ERROR", "a.ts", 1, 1, 1, ["</script><script>alert(1)</script>"]]] },
  });
  assert(!html.includes("</script><script>alert(1)"), "a code line closed the data block");
  assertEqual((html.match(/<\/script>/g) || []).length, 5, "closing script tags (4 data + 1 code)");
});

check("--learn-url must be a plain http(s) URL", () => {
  for (const bad of ["javascript:alert(1)", "https://x.test/#frag", "ftp://x.test/"]) {
    const r = run(["scan", "--learn-url", bad], { env: { PATH: "" } });
    assertEqual(r.status, 2, `exit code for ${bad}`);
  }
});

check("a config file with an unknown key is refused, even without semgrep", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, ".llm-audit.json"), JSON.stringify({ failon: "error" }));
    const r = run(["scan"], { cwd: dir, env: { PATH: "" } });
    assertEqual(r.status, 2, "exit code");
    assert(/unknown key "failon"/.test(r.stderr), `expected the key error, got: ${r.stderr.trim()}`);
    writeFileSync(join(dir, ".llm-audit.json"), JSON.stringify({ disable: ["no-such-rule"] }));
    const bad = run(["scan"], { cwd: dir, env: { PATH: "" } });
    assertEqual(bad.status, 2, "exit code for an unknown rule");
  });
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

  check("compact view collapses a rule's repeats in a file", () => {
    const r = run(["scan", "--compact", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    // Match the finding rows only: the fixture path and the "Start here" line
    // both contain the rule id too.
    const ruleLines = r.stdout
      .split("\n")
      .filter((l) => /^\s+[\u2717!\u00b7]\s/.test(l) && l.includes("hardcoded-llm-api-key"));
    assertEqual(ruleLines.length, 1, "one row per rule per file");
    assert(/lines \d+, \d+, \d+/.test(ruleLines[0]), "expected the line numbers listed");
    // A line matched twice by one rule is one place to look, listed once.
    const nums = (ruleLines[0].match(/\d+/g) || []).filter((n) => n.length <= 4);
    assertEqual(nums.length, new Set(nums).size, "duplicate line numbers in the row");
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

  check("scan --by rule groups occurrences under one rationale", () => {
    const r = run([
      "scan",
      "--by",
      "rule",
      "--verbose",
      join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts"),
    ]);
    assertEqual(r.status, 1, "exit code");
    assert(/3 occurrences/.test(r.stdout), "expected an occurrence count");
    // The rationale belongs to the rule, so it appears exactly once.
    const rationales = r.stdout.split("Inline keys leak").length - 1;
    assertEqual(rationales, 1, "rationale repetitions");
  });

  check("a path that does not exist is named, not silently swallowed", () => {
    const r = run(["scan", "/nonexistent-path-for-tests"]);
    assertEqual(r.status, 2, "exit code");
    assert(/no such file or directory/.test(r.stderr), "expected the path in the error");
    assertEqual(r.stdout.trim(), "", "nothing should be reported as scanned");
  });

  check("scan rejects an unknown --by value", () => {
    const r = run(["scan", "--by", "severity", "."]);
    assertEqual(r.status, 2, "exit code");
    assert(/--by expects/.test(r.stderr), "expected a usage message");
  });

  check("findings carry context lines, not just the matched line", () => {
    const r = run(["scan", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    // The first finding is on line 18; context means its neighbours print too.
    assert(/^\s+16 \u2502/m.test(r.stdout), "expected a line before the match");
    assert(/^\s+20 \u2502/m.test(r.stdout), "expected a line after the match");
  });

  check("LLM_AUDIT_DETERMINISTIC removes volatile output", () => {
    const target = join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts");
    const plain = run(["scan", target]);
    const fixed = run(["scan", target], { env: { ...process.env, LLM_AUDIT_DETERMINISTIC: "1" } });
    assert(/rules fired · \d+\.\ds/.test(plain.stdout), "expected an elapsed time by default");
    assert(!/rules fired · \d/.test(fixed.stdout), "elapsed time must be suppressed");
    // Same input, same bytes — the property the README hero depends on.
    const again = run(["scan", target], { env: { ...process.env, LLM_AUDIT_DETERMINISTIC: "1" } });
    assertEqual(again.stdout, fixed.stdout, "deterministic output");
  });

  check("the summary names one place to start", () => {
    const r = run(["scan", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    assert(/Start here: hardcoded-llm-api-key/.test(r.stdout), "expected a next action");
  });

  check("the envelope records which revision was scanned", () => {
    const r = run(["scan", "--json", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    const envelope = JSON.parse(r.stdout);
    assert("repo" in envelope, "envelope must carry a repo field, even if null");
    if (envelope.repo) {
      assert(/^[0-9a-f]{40}$/.test(envelope.repo.commit), "commit must be a full sha");
      assertEqual(envelope.repo.shortCommit, envelope.repo.commit.slice(0, 8), "shortCommit");
      assertEqual(typeof envelope.repo.dirty, "boolean", "dirty");
    }
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
      assert(html.includes("What to fix first"), "report is missing the executive summary");
      // Every in-page link must land on something that exists.
      const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
      for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
        assert(ids.has(target), `report links to a missing anchor: #${target}`);
      }
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
    assert(/can't be combined/.test(r.stderr), "expected an explanatory error");
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

  check("scan --open writes a private learn page with the scan in it", () => {
    const r = run(["scan", "--open", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")], {
      env: { ...process.env, LLM_AUDIT_NO_BROWSER: "1" },
    });
    assertEqual(r.status, 1, "exit code still reflects the findings");
    const file = (r.stderr.match(/Learn page written to (\S+)/) || [])[1];
    assert(file && existsSync(file), `no learn page reported: ${r.stderr.trim()}`);
    try {
      const html = readFileSync(file, "utf8");
      assert(html.includes('id="scan"'), "the scan is not embedded");
      assert(html.includes("hardcoded-llm-api-key"), "the finding is not in the page");
      assert(!/sk-(proj-|ant-)?[A-Za-z0-9]{20,}/.test(html), "a key from the fixture reached the page");
      if (process.platform !== "win32") {
        const mode = spawnSync("stat", process.platform === "darwin" ? ["-f", "%Lp", file] : ["-c", "%a", file], { encoding: "utf8" }).stdout.trim();
        assertEqual(mode, "600", "file mode");
      }
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  check("the learn link stays out of piped output unless asked for", () => {
    const target = join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts");
    const quiet = run(["scan", target]);
    assert(!quiet.stdout.includes("#r="), "a piped scan printed the learn link");
    const asked = run(["scan", "--link", target]);
    const url = (asked.stdout.match(/https:\/\/\S+#r=\S+/) || [])[0];
    assert(url, "--link did not print a link");
    const payload = unpack(url.split("#r=")[1]);
    assert(payload.f.every((f) => f[0] === "hardcoded-llm-api-key"), "unexpected rule in payload");
    assert(!JSON.stringify(payload).match(/sk-(proj-|ant-)?[A-Za-z0-9]{20,}/), "a key travelled in the link");
  });

  check("--json --link keeps stdout pure JSON and puts the link on stderr", () => {
    const r = run(["scan", "--json", "--link", join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts")]);
    JSON.parse(r.stdout);
    assert(/#r=/.test(r.stderr), "expected the link on stderr");
  });

  // learn and prompt work from the last scan of a project, saved to a cache
  // directory. Each test gets its own, so nothing touches the real one.
  const withCache = (fn) =>
    withTempDir((cache) =>
      fn({ ...process.env, LLM_AUDIT_CACHE_DIR: cache, LLM_AUDIT_NO_BROWSER: "1", CI: "" }, cache)
    );
  const keyFixture = join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts");
  const savedScans = (cache) =>
    existsSync(join(cache, "scans")) ? readdirSync(join(cache, "scans")) : [];

  check("hooks and CI keep the per-file view and save nothing", () => {
    withCache((env, cache) => {
      const r = run(["scan", keyFixture], { env });
      assert(/Start here: hardcoded-llm-api-key/.test(r.stdout), "expected the per-file view");
      assert(!/mistakes? in \d+ place/.test(r.stdout), "the lesson view leaked into piped output");
      assertEqual(savedScans(cache).length, 0, "saved scans after a piped run");
    });
  });

  check("the lesson view groups by mistake and saves the scan privately", () => {
    withCache((env, cache) => {
      const r = run(["scan", "--by", "lesson", keyFixture], { env });
      assertEqual(r.status, 1, "exit code still reflects the findings");
      assert(/1 mistake in \d+ places/.test(r.stdout), `expected a headline, got: ${r.stdout.slice(0, 300)}`);
      assert(r.stdout.includes(" 1  A secret key is written into the code"), "expected lesson 1 by title");
      assert(/llm-audit learn/.test(r.stdout) && /llm-audit prompt 1/.test(r.stdout), "expected the next steps");
      const files = savedScans(cache);
      assertEqual(files.length, 1, "saved scans");
      const file = join(cache, "scans", files[0]);
      if (process.platform !== "win32") {
        const mode = spawnSync("stat", process.platform === "darwin" ? ["-f", "%Lp", file] : ["-c", "%a", file], { encoding: "utf8" }).stdout.trim();
        assertEqual(mode, "600", "saved scan file mode");
      }
      assert(!/sk-(proj-|ant-)?[A-Za-z0-9]{20,}/.test(readFileSync(file, "utf8")), "a key reached the saved scan");
    });
  });

  check("--no-link saves nothing and prints no hints", () => {
    withCache((env, cache) => {
      const r = run(["scan", "--by", "lesson", "--no-link", keyFixture], { env });
      assert(!/llm-audit learn/.test(r.stdout), "printed a learn hint");
      assertEqual(savedScans(cache).length, 0, "saved scans");
    });
  });

  check("prompt prints the fix prompt for a lesson of the last scan", () => {
    withCache((env) => {
      const none = run(["prompt", "1"], { env });
      assertEqual(none.status, 1, "prompt with no saved scan");
      run(["scan", "--by", "lesson", keyFixture], { env });
      const r = run(["prompt", "1"], { env });
      assertEqual(r.status, 0, "exit code");
      assert(r.stdout.startsWith("Fix this in my project:"), "piped output must be the prompt alone");
      assert(r.stdout.includes("vulnerable.ts line"), "expected the fixture's locations");
      const check = run(["prompt", "1", "--check"], { env });
      assert(check.stdout.startsWith("Check this project"), "expected the check prompt");
      assertEqual(run(["prompt", "9"], { env }).status, 2, "out-of-range lesson");
    });
  });

  check("learn opens the last scan, or the library when there is none", () => {
    withCache((env) => {
      const lib = run(["learn"], { env });
      assert(/lesson library/.test(lib.stdout), "expected the library notice");
      const libFile = (lib.stderr.match(/Learn page written to (\S+)/) || [])[1];
      assert(libFile && !readFileSync(libFile, "utf8").includes('id="scan"'), "the library must not embed a scan");
      rmSync(dirname(libFile), { recursive: true, force: true });

      run(["scan", "--by", "lesson", keyFixture], { env });
      const r = run(["learn"], { env });
      const file = (r.stderr.match(/Learn page written to (\S+)/) || [])[1];
      assert(file && readFileSync(file, "utf8").includes('id="scan"'), "the page must embed the saved scan");
      rmSync(dirname(file), { recursive: true, force: true });

      const share = run(["learn", "--link"], { env });
      assert(/^https:\/\/\S+#r=/.test(share.stdout.trim()), "learn --link prints a share URL");
    });
  });

  // A small git repo with real findings, for the policy features.
  const KEY_SRC = join(FIXTURES, "hardcoded-llm-api-key", "vulnerable.ts");
  const JSON_SRC = join(FIXTURES, "model-output-parsed-without-schema", "vulnerable.ts");
  const withRepo = (fn) =>
    withTempDir((dir) => {
      const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "t@example.test");
      git("config", "user.name", "t");
      mkdirSync(join(dir, "src"));
      return fn(dir, git);
    });
  const json = (r) => JSON.parse(r.stdout);

  check("no output shows a hardcoded key in full", () => {
    const human = run(["scan", "--by", "file", "--verbose", KEY_SRC]);
    const data = run(["scan", "--json", KEY_SRC]);
    for (const [name, out] of [["human", human.stdout], ["json", data.stdout]]) {
      assert(!/sk-(proj-|ant-)?[A-Za-z0-9]{20,}/.test(out), `${name} output printed a key`);
      assert(out.includes("[redacted]"), `${name} output should show the redaction`);
    }
  });

  check("an ignore comment with a reason suppresses, one without is refused", () => {
    withRepo((dir) => {
      const lines = readFileSync(KEY_SRC, "utf8").split("\n");
      const at = lines.map((l, i) => (/apiKey/.test(l) ? i : -1)).filter((i) => i >= 0);
      lines.splice(at[1], 0, "// llm-audit-ignore hardcoded-llm-api-key");
      lines.splice(at[0], 0, "// llm-audit-ignore hardcoded-llm-api-key -- fake key in a test");
      writeFileSync(join(dir, "src", "a.ts"), lines.join("\n"));
      const r = run(["scan", "--json", "src"], { cwd: dir });
      const e = json(r);
      assertEqual(e.suppressed.length, 1, "suppressed findings");
      assertEqual(e.suppressed[0].reason, "fake key in a test", "reason");
      assertEqual(e.summary.suppressed, 1, "summary.suppressed");
      assert(e.findings.every((f) => f.docsUrl.includes("#" + f.ruleId)), "every finding links its rule docs");
      assert(/has no reason, so it was not applied/.test(r.stderr), "expected the missing-reason warning");
    });
  });

  check("config turns rules off and sets the exit policy", () => {
    withRepo((dir) => {
      writeFileSync(join(dir, "src", "a.ts"), readFileSync(JSON_SRC, "utf8"));
      writeFileSync(join(dir, ".llm-audit.json"), JSON.stringify({ failOn: "error" }));
      assertEqual(run(["scan", "src"], { cwd: dir }).status, 0, "warnings only, failOn error");
      writeFileSync(join(dir, ".llm-audit.json"), JSON.stringify({ disable: ["model-output-parsed-without-schema"] }));
      const r = run(["scan", "--json", "src"], { cwd: dir });
      assertEqual(json(r).findings.length, 0, "findings from a disabled rule");
      assertEqual(run(["scan", "--fail-on", "any", "src"], { cwd: dir }).status, 0, "nothing left to fail on");
    });
  });

  check("a baseline reports only new findings, with uncommitted changes", () => {
    withRepo((dir, git) => {
      writeFileSync(join(dir, "src", "old.ts"), readFileSync(JSON_SRC, "utf8"));
      git("add", "-A");
      git("commit", "-qm", "base");
      // Old code moves down a line; new code arrives. Neither is committed.
      writeFileSync(join(dir, "src", "old.ts"), "// moved\n" + readFileSync(JSON_SRC, "utf8"));
      writeFileSync(join(dir, "src", "new.ts"), readFileSync(KEY_SRC, "utf8"));
      const e = json(run(["scan", "--json", "--baseline", "HEAD", "src"], { cwd: dir }));
      assert(e.findings.length > 0, "new findings must remain");
      assert(e.findings.every((f) => f.path.endsWith("new.ts")), "only new.ts should remain");
      assert(e.baseline && e.baseline.ref === "HEAD" && e.baseline.hidden > 0, "baseline info in the envelope");
      assertEqual(git("worktree", "list").stdout.trim().split("\n").length, 1, "temporary worktree left behind");
      assertEqual(run(["scan", "--baseline", "no-such-ref", "src"], { cwd: dir }).status, 2, "unknown ref");
    });
  });

  check("inside GitHub Actions, findings become annotations and a summary", () => {
    withTempDir((dir) => {
      const summary = join(dir, "summary.md");
      const env = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary };
      const r = run(["scan", JSON_SRC], { env });
      assert(/^::warning file=.*,line=\d+,title=llm-audit%3A /m.test(r.stdout), "expected warning annotations");
      assert(readFileSync(summary, "utf8").includes("## llm-audit"), "expected a step summary");
      const j = run(["scan", "--json", JSON_SRC], { env });
      JSON.parse(j.stdout);
      assert(/^::warning /m.test(j.stderr), "with --json, annotations go to stderr");
      const off = run(["scan", "--no-github", JSON_SRC], { env: { ...env, GITHUB_STEP_SUMMARY: "" } });
      assert(!/^::/m.test(off.stdout), "--no-github prints no annotations");
    });
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
