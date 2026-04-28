# llm-audit

> Static analysis for LLM-application code. OWASP LLM Top 10 at commit time.

A focused Semgrep rule pack and CLI for catching the security failure modes that
appear in code shipped by AI coding assistants (and humans) when integrating
LLM features. Runs locally before commits and in CI.

**Status:** v0 scaffold. Five rules implemented with vulnerable + safe fixtures.
See [`docs/RULES.md`](docs/RULES.md) for what's shipped and what's planned,
[`docs/BRIEF.md`](docs/BRIEF.md) for the project pitch, and
[`docs/AI-FAILURE-MODES.md`](docs/AI-FAILURE-MODES.md) for the long-form rationale
behind each rule.

## Why

Existing SAST tools (Semgrep, Snyk, ESLint security plugins) cover generic web
vulnerabilities well. None of them ship a curated, maintained ruleset for the
patterns specific to LLM-integrated applications:

- User input flowing into an LLM `system` role or prompt template
- Model output piped into `eval`, `dangerouslySetInnerHTML`, or shell
- Tool-calling handlers that execute model-chosen tools without an allowlist
- Retrieval contexts that mix untrusted documents with system instructions
- Server Actions / route handlers that forward arbitrary strings to a model

This pack targets that gap. Rules map to the [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/).

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
