<img src="assets/banner.svg" alt="llm-audit — untrusted input stopped at the authority boundary, before commit" width="100%"/>

<p>
  <a href="https://www.npmjs.com/package/llm-audit"><img src="https://img.shields.io/npm/v/llm-audit?style=flat-square&color=CB3837&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/llm-audit"><img src="https://img.shields.io/npm/dm/llm-audit?style=flat-square&color=CB3837&label=downloads" alt="npm downloads"></a>
  <a href="https://github.com/Javierlozo/llm-audit/actions/workflows/tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/Javierlozo/llm-audit/tests.yml?branch=main&style=flat-square&label=tests" alt="Tests"></a>
  <a href="https://github.com/Javierlozo/llm-audit/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT License"></a>
</p>

> Static analysis for **TypeScript and JavaScript** LLM-application code.
> Twelve rules mapped to the OWASP LLM Top 10, run at commit time.

```bash
brew install semgrep     # the engine, one-time (or: pipx install semgrep)
npm i -D llm-audit
npx llm-audit demo       # watch the twelve rules fire on bundled fixtures
```

<p>
  <img src="assets/scan-demo.svg" alt="Terminal recording of npx llm-audit scan src: a chat route handler is flagged for a hardcoded provider key and for parsing model output without a schema, ending in a severity summary" width="820"/>
  <br/>
  <sub>A real run against a real chat route handler. Generated from live CLI output by
  <code>npm run demo:svg</code>, not drawn by hand. Every finding carries its OWASP mapping,
  the risk, and the fix. Motion respects <code>prefers-reduced-motion</code>.</sub>
</p>

<p>
  <img src="assets/commands.svg" alt="What you can run: llm-audit demo before you adopt it, scan while you write, rules for one rule in full, scan --html for a shareable report, init to make it permanent, doctor when something is off" width="820"/>
</p>

<p>
  <a href="#quickstart">Quickstart</a>
  ·
  <a href="#rules">Rules</a>
  ·
  <a href="#why-not-just-pai-best-practices">vs. Semgrep</a>
  ·
  <a href="#a-report-you-can-hand-to-someone-else">Report</a>
  ·
  <a href="#machine-readable-output-ci-agents-dashboards">JSON / SARIF</a>
  ·
  <a href="#adopt-in-your-project">Adopt in CI</a>
  ·
  <a href="#using-with-claude-code-cursor-or-codex-cli">Agents</a>
  ·
  <a href="docs/RULES.md">Rule Docs</a>
</p>

---

A Semgrep rule pack and CLI for the security bugs that show up in TypeScript
and JavaScript when you wire up an LLM. AI assistants write most of these, but
people write them too. It runs before your commits and in CI. Semgrep is the
engine. Output is human-readable, JSON, SARIF 2.1.0, or a standalone HTML
report.

**Status:** the v1 rule set is done. Twelve rules, each with a vulnerable and a
safe fixture, all green against `npm test`.

- [`docs/RULES.md`](docs/RULES.md) - every rule: what it catches, why an AI
  assistant writes the pattern, and the fix
- [`docs/AI-FAILURE-MODES.md`](docs/AI-FAILURE-MODES.md) - the long version of the reasoning
- [`docs/COMPETITIVE-LANDSCAPE.md`](docs/COMPETITIVE-LANDSCAPE.md) - the other
  scanners, and the ones that aren't competitors at all
- [`docs/BRIEF.md`](docs/BRIEF.md) - the pitch

## Why not just `p/ai-best-practices`?

Because it doesn't scan TypeScript. Semgrep's official AI pack is good work.
It's just Python-first. Run both, they don't overlap.

| | `llm-audit` | Semgrep `p/ai-best-practices` |
|---|---|---|
| **JS / TS rules** | **12** | **0** of 27 |
| Language focus | TypeScript, TSX, JavaScript | Python (13), config (11), Bash (3) |
| Findings on this repo's TS/TSX fixtures | **42** | **0**, every target filtered out before scanning |
| Runs at | pre-commit hook + CI | CI |

Reproduce those numbers yourself in under a minute:

```sh
git clone https://github.com/Javierlozo/llm-audit.git && cd llm-audit

# Semgrep's AI pack against the same TypeScript fixtures: 0 targets, 0 findings.
semgrep --config p/ai-best-practices test/fixtures/ --metrics=off

# llm-audit against them: 12 rules, 42 matches, 0 false positives.
npm test
```

The full comparison is in
[`docs/COMPETITIVE-LANDSCAPE.md`](docs/COMPETITIVE-LANDSCAPE.md): false-positive
rates, output formats, licensing, the other OSS scanners, and the commercial
tools.

<sub>Built by <a href="https://www.luislozoya.com">Luis Javier Lozoya</a> ·
<a href="https://www.luislozoya.com/llm-audit">Project page</a> ·
<a href="https://github.com/Javierlozo/llm-audit/issues">Issues</a> ·
<a href="https://www.npmjs.com/package/llm-audit">npm</a></sub>

## Quickstart

You just ran `npm i llm-audit`. Now what?

```bash
# 1. Install the engine (one-time, system-wide).
brew install semgrep        # or: pipx install semgrep

# 2. Sanity-check setup. Lists missing dependencies and how to fix them.
npx llm-audit doctor

# 3. See what the rules catch in 5 seconds. No setup in your repo.
npx llm-audit demo

# 4. Run on your own code.
npx llm-audit scan
```

That's enough to decide if it's worth keeping. To make it stick, see **Adopt in
your project** below.

## Machine-readable output (CI, agents, dashboards)

`scan` has two machine-readable formats, plus the HTML report covered below:

```bash
# Versioned JSON envelope (stable schema, schemaVersion: 1).
# Useful for AI agents (Claude Code, Cursor) and custom dashboards.
npx llm-audit scan --json src > findings.json

# SARIF 2.1.0, the standard for security-tool output.
# Upload directly to GitHub Code Scanning via codeql-action/upload-sarif.
npx llm-audit scan --sarif src > findings.sarif
```

### A report you can hand to someone else

```bash
npx llm-audit scan --html llm-audit-report.html src
```

One HTML file. No scripts, no network, no external assets. It opens from disk,
prints cleanly, and survives being attached to a PR or kept as a CI artifact.

It opens with what to fix first and records the branch and commit it's
describing, including whether the tree was dirty when you ran it. Findings are
grouped under the rule that explains them, and each rule carries what it
catches, **why an AI assistant tends to write that pattern**, how to fix it, and
the pack's own `safe.*` fixture as the worked example.

That last part is the one I'd point at. The fixture isn't an illustration.
`npm test` asserts on every commit that it produces zero findings, so the fix in
the report is one that's been checked.

The same material is one command away in the terminal:

```bash
npx llm-audit rules hardcoded-llm-api-key
```

### Focusing a run

```bash
npx llm-audit scan --rule hardcoded-llm-api-key src   # one rule
npx llm-audit scan --severity error src               # errors only
npx llm-audit scan --by rule src                      # group by rule, not file
npx llm-audit scan --compact src                      # one line per finding
```

Past 15 findings the terminal switches to compact on its own. The full
rationale for every hit stops teaching and starts scrolling. Compact also folds
a rule's repeats in a file onto one row, so you get `lines 18, 22, 27` instead
of three near-identical rows.

Filtered output always says it's filtered, in the terminal and in the HTML
report. A narrow pass should never read like a clean bill of health.

Adopting on a repo that already has findings? Print everything, but only fail
the build on what you're ready to enforce. Tighten it as you burn the backlog
down:

```bash
npx llm-audit scan --fail-on error src   # report all, exit 1 only on errors
npx llm-audit scan --fail-on never src   # report all, never fail the build
```

JSON envelope shape:

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "llm-audit", "version": "0.5.0" },
  "repo": { "commit": "…", "shortCommit": "01d9ff30", "branch": "main", "dirty": false },
  "scannedPaths": ["src"],
  "summary": { "findings": 0 },
  "findings": [
    {
      "ruleId": "model-output-parsed-without-schema",
      "severity": "WARNING",
      "owasp": "LLM02",
      "cwe": ["CWE-20"],
      "path": "src/app/api/route.ts",
      "startLine": 61,
      "endLine": 61,
      "message": "Model output is being parsed with `JSON.parse`...",
      "lines": "..."
    }
  ]
}
```

By default `scan` exits **0** with no findings and **1** with any, whatever the
output format. `--fail-on <level>` moves that threshold without changing what
gets reported.

## Using with Claude Code, Cursor, or Codex CLI

Assistants write most of the code these rules were written for, so the best
place to run this is inside the assistant. Two ways to do it.

### 1. Install the Claude Code skill (recommended)

Drop a project-local `SKILL.md` into `.claude/skills/llm-audit/`. Any agent
that reads the universal skill format picks it up on its own: Claude Code,
Cursor, Codex CLI, Antigravity, Gemini CLI.

```bash
npx llm-audit init --skill        # hook + workflow + skill
npx llm-audit init --skill-only   # just the skill
```

The skill tells the agent **when** to run it (editing files that import
`openai`, `@anthropic-ai/sdk`, `ai`, `@ai-sdk/*`), **how** to run it
(`npx llm-audit scan --json`), and how to read each rule's findings with the
right fix per OWASP entry.

### 2. Manual rule for users who don't want the skill file

If you'd rather not commit a `.claude/skills/` file, paste this into your agent
rules instead (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, or whatever your tool
uses):

> Before committing any change that touches LLM-integrated code (imports
> from `openai`, `@anthropic-ai/sdk`, `ai`, `@ai-sdk/*`, or any file
> calling `chat.completions.create` / `messages.create` / `generateText` /
> `streamText`), run `npx llm-audit scan --json` against the changed
> paths. Treat the `findings` array as the authoritative list of issues
> to fix. Each finding has `ruleId`, `owasp`, `severity`, `path`,
> `startLine`, `endLine`, and `message`. Fix the code per the message,
> then re-run until the array is empty. Never bypass the rule by
> suppressing the finding.

Either works. The skill gives the agent more context and loads on its own, but
the file has to live in your repo.

The JSON envelope is a stable contract (`schemaVersion: 1`), so agents can rely
on the field names without breaking on a future release.

## Versions and updates

It doesn't check for updates on every run. No background network calls, no
daily cache files, nothing you didn't ask for. The trade-off is that you won't
hear about a new version on your own.

To check where you are:

```bash
npx llm-audit doctor
```

`doctor` makes one request to the npm registry and prints either
`is up to date` or `is out of date (latest is N.N.N)` with the upgrade command.
It's the same call you'd make yourself with `npm view llm-audit version`.

To upgrade:

```bash
npm i llm-audit@latest
```

## Adopt in your project

`llm-audit init` writes two things: a husky pre-commit hook that runs on every
commit, and a GitHub Action workflow that runs on PRs and pushes. It asks before
writing the hook, since that one lands in your local commit flow. Press Enter to
accept, type `n` to skip the hook and keep just the workflow.

```bash
npx llm-audit init                     # prompts: Install pre-commit hook? [Y/n]
npx llm-audit init -y                  # skip the prompt, accept default
npx llm-audit init --skill             # also install the Claude Code skill

# If husky isn't already in this project, finish the setup:
npm i -D husky
npm pkg set scripts.prepare='husky'
npm run prepare
```

CI, scripts, and piped stdin skip the prompt and take the default, so nothing
hangs.

Don't run `npx husky init` afterwards. It conflicts with the pre-commit file
`llm-audit init` just wrote. The three lines above are husky v9's manual setup,
which doesn't have that problem.

Run `init` twice and it tells you everything's already installed instead of
failing. It only refuses to overwrite a file it didn't write, and `--force`
reinstalls from the templates either way. Threat model in
[`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md).

Want it gone? `npx llm-audit uninstall` removes the hook, the workflow, and the
skill. It only deletes files it can prove it wrote, and tells you what it left
behind.

### Pinning the version in CI

The bundled workflow runs `npx llm-audit scan`, which pulls the latest
published version at run time unless `llm-audit` is in your `devDependencies`.
The pre-commit hook uses `npx --no-install`, so it never fetches the package
behind your back.

If you want CI on a version you've reviewed, either add it to your dev
dependencies:

```bash
npm i -D llm-audit
```

…or pin a version directly in the workflow file:

```yaml
- run: npx llm-audit@0.5.0 scan
```

## Why

The best rule pack out there is Semgrep's official
[`p/ai-best-practices`](https://github.com/semgrep/semgrep-rules/tree/develop/ai/ai-best-practices).
It ships 27 rules: 13 Python, 11 config files (MCP, Claude Code settings),
3 Bash hooks, and **zero JavaScript or TypeScript**. Point it at a Next.js +
Vercel AI SDK repo and it comes back with nothing.

The TS/JS side of this ecosystem is where a lot of LLM code actually ships:
Vercel AI SDK, the OpenAI and Anthropic JS SDKs, Next.js route handlers, Server
Actions, AI Gateway. The static-analysis tooling hasn't caught up. That's the
gap this fills, with every rule mapped to an
[OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
entry.

Some of what it catches:

- User input flowing into an LLM `system` role or prompt template
- Model output piped into `eval`, `dangerouslySetInnerHTML`, or shell
- `JSON.parse` on raw model output without a schema validator
- Hardcoded LLM API keys in source

The full rule list is in [`docs/RULES.md`](docs/RULES.md).

## Run rules directly with Semgrep (no install needed)

Don't want the package? The rule pack is a plain Semgrep config:

```bash
semgrep --config node_modules/llm-audit/rules .
```

## Rules

Twelve rules, each mapped to an [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
entry and backed by a vulnerable + safe fixture in `test/fixtures/<rule-id>/`.

| ID | OWASP | Summary |
|---|---|---|
| `untrusted-input-in-system-prompt` | LLM01 | User input placed into the LLM `system` role |
| `untrusted-input-concatenated-into-prompt-template` | LLM01 | User input interpolated into a single-string prompt with no role boundary |
| `untrusted-retrieval-context-in-system-role` | LLM01 | Retrieved documents given system authority (indirect prompt injection) |
| `request-body-to-llm-without-schema` | LLM01 | Raw request body reaching an LLM call with no schema validation at the boundary |
| `llm-output-insecure-handling` | LLM02 | Model output flows into `eval`, raw HTML, or shell |
| `model-output-parsed-without-schema` | LLM02 | `JSON.parse` on model output without a schema validator on the path |
| `model-output-rendered-as-markdown-without-sanitization` | LLM02 | Markdown renderer with HTML enabled or sanitization disabled on model output |
| `hardcoded-llm-api-key` | LLM06 | Inline LLM provider API key in source |
| `secrets-in-prompt-context` | LLM06 | Environment secrets interpolated into prompt text sent to the provider |
| `system-prompt-leakage-in-client-bundle` | LLM07 | Prompt-shaped constants inside a `'use client'` module, shipped to the browser |
| `tool-call-dispatch-without-allowlist` | LLM08 | Model-chosen tool name dispatched without an allowlist |
| `streaming-response-without-abort-handling` | LLM10 | Streaming call in a request handler with no `signal` forwarded |

[`docs/RULES.md`](docs/RULES.md) has the full reasoning for each one: what it
catches, **why an AI assistant tends to write that pattern**, and the fix. The
long version is in [`docs/AI-FAILURE-MODES.md`](docs/AI-FAILURE-MODES.md).

## Project layout

```
rules/          Semgrep YAML rules, one per file
src/cli.mjs     CLI entry: scan, demo, doctor, rules, init, uninstall
src/report.mjs  The standalone HTML report
src/rule-docs.mjs
                Parses docs/RULES.md, the material that both the
                `rules <id>` command and the report render
templates/      Files installed by `llm-audit init` (husky hook, GH Action)
test/           Vulnerable + safe fixtures per rule, plus the CLI suite
tools/          Dev only: regenerates the README hero and command map
docs/           RULES.md (rule reference, read at runtime), BRIEF.md (pitch),
                AI-FAILURE-MODES.md, COMPETITIVE-LANDSCAPE.md, SECURITY-AUDIT.md
```

## Author

Built by [Luis Javier Lozoya](https://www.luislozoya.com).

## License

MIT. See [LICENSE](LICENSE).

## Trademarks

llm-audit is an independent project. It isn't affiliated with or endorsed by
Semgrep, Inc. Semgrep is a trademark of Semgrep, Inc. References to the Semgrep
CLI and the `p/ai-best-practices` ruleset are nominative: they name the engine
this runs on and the public ruleset it complements.
