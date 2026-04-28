# llm-audit

> Static analysis for **TypeScript and JavaScript** LLM-application code.
> OWASP LLM Top 10 at commit time. A complement to Semgrep's
> [`p/ai-best-practices`](https://github.com/semgrep/semgrep-rules/tree/develop/ai/ai-best-practices)
> for the TS/JS ecosystem the upstream pack does not cover.

A focused Semgrep rule pack and CLI for catching the security failure modes
that appear in TypeScript and JavaScript code shipped by AI coding assistants
(and humans) when integrating LLM features. Runs locally before commits and
in CI.

**Status:** v0 scaffold. Five rules implemented with vulnerable + safe
fixtures, all green against `npm test`. See [`docs/RULES.md`](docs/RULES.md)
for what's shipped and what's planned, [`docs/BRIEF.md`](docs/BRIEF.md) for
the project pitch, [`docs/AI-FAILURE-MODES.md`](docs/AI-FAILURE-MODES.md) for
the long-form rationale behind each rule, and
[`docs/COMPETITIVE-LANDSCAPE.md`](docs/COMPETITIVE-LANDSCAPE.md) for the
empirical comparison against `p/ai-best-practices` and other LLM-security
tooling.

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

That's enough to evaluate whether `llm-audit` is worth adopting. To make
it permanent, see **Adopt in your project** below.

## Machine-readable output (CI, agents, dashboards)

`scan` supports two structured output formats for non-human consumers:

```bash
# Versioned JSON envelope (stable schema, schemaVersion: 1).
# Useful for AI agents (Claude Code, Cursor) and custom dashboards.
npx llm-audit scan --json src > findings.json

# SARIF 2.1.0, the standard for security-tool output.
# Upload directly to GitHub Code Scanning via codeql-action/upload-sarif.
npx llm-audit scan --sarif src > findings.sarif
```

JSON envelope shape:

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "llm-audit", "version": "0.0.5" },
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

`scan` exits **0** when there are no findings, **1** when there are, regardless
of output format.

## Versions and updates

`llm-audit` does **not** check for updates on every run. No background
network calls, no daily cache files, no surprise. The trade-off: you
won't be notified of new versions automatically.

To check whether you're current, run:

```bash
npx llm-audit doctor
```

`doctor` makes one on-demand request to the npm registry and prints
either `is up to date` or `is out of date (latest is N.N.N)` with the
upgrade command. Same network call you'd make manually with
`npm view llm-audit version`, just packaged into the diagnostic.

To upgrade:

```bash
npm i llm-audit@latest
```

## Adopt in your project

`llm-audit init` drops a husky pre-commit hook and a GitHub Action into
your repo. The hook only runs once husky is installed and initialized:

```bash
npx llm-audit init                     # writes .husky/pre-commit + GH Action

# If husky isn't already in this project, finish the setup:
npm i -D husky
npm pkg set scripts.prepare='husky'
npm run prepare
```

Don't run `npx husky init` after `llm-audit init`: it conflicts with the
pre-commit file `llm-audit init` just wrote. The three lines above use
husky v9's manual setup, which doesn't have that conflict.

`llm-audit init` refuses to overwrite existing files; pass `--force` if
you really mean it. Threat model and rationale in
[`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md).

## Why

The strongest existing rule pack — Semgrep's official
[`p/ai-best-practices`](https://github.com/semgrep/semgrep-rules/tree/develop/ai/ai-best-practices) —
ships 27 rules: 13 Python, 11 generic configs (MCP, Claude Code settings),
3 Bash hook rules, and **zero JavaScript or TypeScript rules**. Run it
against a Next.js + Vercel AI SDK repo and it returns nothing.

The TypeScript / JavaScript LLM-app ecosystem (Vercel AI SDK, OpenAI /
Anthropic JS SDKs, Next.js route handlers, Server Actions, AI Gateway) is
genuinely underweighted in the static-analysis tooling that exists today.
`llm-audit` fills that gap, with each rule mapped explicitly to an
[OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
category.

Patterns covered:

- User input flowing into an LLM `system` role or prompt template
- Model output piped into `eval`, `dangerouslySetInnerHTML`, or shell
- `JSON.parse` on raw model output without a schema validator
- Hardcoded LLM API keys in source

The full rule list is in [`docs/RULES.md`](docs/RULES.md).

## Run rules directly with Semgrep (no install needed)

If you don't want to install the package, the rule pack itself is a
plain Semgrep configuration:

```bash
semgrep --config node_modules/llm-audit/rules .
```

## Rules in v0

| ID | OWASP | Summary |
|---|---|---|
| `untrusted-input-in-system-prompt` | LLM01 | User input placed into the LLM `system` role |
| `untrusted-input-concatenated-into-prompt-template` | LLM01 | User input interpolated into a single-string prompt with no role boundary |
| `llm-output-insecure-handling` | LLM02 | Model output flows into `eval`, raw HTML, or shell |
| `model-output-parsed-without-schema` | LLM02 | `JSON.parse` on model output without a schema validator on the path |
| `hardcoded-llm-api-key` | LLM06 | Inline LLM provider API key in source |

The full v1 plan and the rationale for each shipped rule is tracked in
[`docs/RULES.md`](docs/RULES.md). The long-form "why AI assistants reproduce
these patterns" writeup lives in [`docs/AI-FAILURE-MODES.md`](docs/AI-FAILURE-MODES.md).

## Project layout

```
rules/      Semgrep YAML rules, one per file
src/cli.mjs CLI entry: scan, init
templates/  Files installed by `llm-audit init` (husky hook, GH Action)
test/       Vulnerable + safe fixtures per rule
docs/       BRIEF.md (pitch), RULES.md (rule plan)
```

## License

MIT. See [LICENSE](LICENSE).
