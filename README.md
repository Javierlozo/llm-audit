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

## Install

```bash
npm i -D llm-audit
brew install semgrep   # or: pipx install semgrep
```

## Use

```bash
# Scan the current repo
npx llm-audit scan

# Wire up a husky pre-commit hook + a GitHub Action
npx llm-audit init
```

Or run the rules directly with Semgrep:

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
