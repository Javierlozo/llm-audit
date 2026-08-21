# `llm-audit` — Project Brief

> Static analysis for **TypeScript and JavaScript** LLM-application code. OWASP
> LLM Top 10, at commit time. A complement to Semgrep's `p/ai-best-practices`
> for the TS/JS ecosystem the upstream pack does not cover.

## Problem

AI coding assistants (Claude, Cursor, Kiro, Copilot) now write a substantial
share of new application code. They reproduce a predictable set of security
failures that existing SAST tools were not built to catch in TypeScript or
JavaScript LLM apps:

- User input flowing into the LLM `system` role (Anthropic, OpenAI, Vercel AI SDK)
- Model output piped into `eval` / `dangerouslySetInnerHTML` / `child_process.exec`
- `JSON.parse` on raw model output with no schema validator on the path
- Hardcoded LLM API keys in `new OpenAI({ apiKey: "sk-..." })` constructors
- Server Actions and Next.js route handlers that forward `request.json()` to a
  model with no zod / valibot at the boundary
- Tool-calling handlers that dispatch on `toolCall.name` without an allowlist
- Retrieval-augmented contexts that mix untrusted document text into the
  `system` role

The most relevant existing rule pack — Semgrep's official
[`p/ai-best-practices`](https://github.com/semgrep/semgrep-rules/tree/develop/ai/ai-best-practices) —
is **Python-only for LLM-app code**. Its 27 rules break down as 13 Python rules
(LangChain + Python provider SDKs), 11 generic config rules (MCP, Claude Code
settings, IDE configs), and 3 Bash hook rules. **Zero JavaScript or TypeScript
rules.** Run it against a Next.js + Vercel AI SDK repo and it returns nothing.

The TypeScript / JavaScript LLM-app ecosystem (Vercel AI SDK, OpenAI / Anthropic
JS SDKs, Next.js route handlers and Server Actions, AI Gateway) is genuinely
underweighted in the static-analysis tooling that exists today. That gap is the
problem `llm-audit` addresses.

## Solution

A focused Semgrep rule pack plus thin CLI wrapper, **scoped to TypeScript and
JavaScript LLM-application code** and mapped to OWASP LLM Top 10. One install,
opinionated defaults, sub-5 second pre-commit on changed files, full scan in CI.

Positioned as a **complement** to Semgrep's `p/ai-best-practices`, not a
replacement: that pack handles Python LLM apps and AI infrastructure configs
(MCP, Claude Code hooks); `llm-audit` handles TS/JS LLM apps. Run both in the
same repo and you cover the LLM Top 10 across both halves of the ecosystem.

The rule pack is the product. The CLI is convenience. Generic security concerns
(generic XSS, SQLi, secret scanning, dependency CVEs) are explicitly delegated
to the tools that already do them well (Semgrep `p/owasp-top-ten`, gitleaks,
npm audit, Socket.dev). We do not reimplement those.

For the full empirical comparison against `p/ai-best-practices` and other tools,
see [`COMPETITIVE-LANDSCAPE.md`](./COMPETITIVE-LANDSCAPE.md).

## v1 Scope (10 to 12 rules)

Each rule maps to an OWASP LLM Top 10 entry, ships with a vulnerable + safe
fixture, and includes a "why an AI assistant tends to write this" note in
`docs/RULES.md`.

1. **LLM01 — Prompt Injection: untrusted input in `system` role** (v0 ✅)
2. **LLM01 — User input concatenated into a prompt template without separator** (v0 ✅)
3. **LLM02 — Insecure Output Handling: model output to dangerous sink** (v0 ✅)
4. **LLM02 — `JSON.parse` on raw model output without schema validation** (v0 ✅)
5. **LLM06 — Hardcoded LLM API keys in source** (v0 ✅)
6. **LLM08 — Excessive Agency: tool-calling dispatch without an allowlist** (v0.1 ✅)
7. **LLM06 — Sensitive context (env, secrets) interpolated into prompt text** (v0.1 ✅)
8. **LLM01 — Route handler forwards request body to a model without a schema** (v0.1 ✅)
9. **LLM07 — System prompt leakage: system text inlined in client-visible code** (v1 ✅)
10. **LLM01 — Retrieval context: untrusted document text mixed into a `system` role** (v1 ✅)
11. **LLM09 — Overreliance: model output rendered as code or markdown without sanitization** (v1 ✅)
12. **AI-CODE-SMELL — Streaming response without backpressure / abort handling** (v1 ✅)

## Differentiation

- **TypeScript and JavaScript depth, empirically validated.** Semgrep's official
  `p/ai-best-practices` (the strongest existing alternative) ships 27 rules
  across Python, generic configs, and Bash, with **zero JS/TS coverage**. Run
  it against the `llm-audit` fixtures and it produces 0 findings on the same
  files where `llm-audit` flags 37 violations across 12 rules. This is the
  empirical gap: TypeScript Vercel AI SDK / OpenAI / Anthropic JS / Next.js
  Server Action shapes are simply not covered upstream.
- **Explicit OWASP LLM Top 10 mapping** in every rule's `metadata.owasp-llm`
  field, so findings can be aggregated, gated, or surfaced as a compliance
  artifact. Existing packs are organized as "best practices," not as an
  OWASP-mapped audit surface.
- **Research-flavored rationale.** Each rule documents the AI-assistant failure
  mode it catches. `docs/RULES.md` and `docs/AI-FAILURE-MODES.md` are the
  portfolio assets, not just the code.
- **Distribution leverage.** Ships as a Semgrep pack first; the CLI is a thin
  convenience wrapper around `semgrep --config <pack>`. Lower maintenance than
  building a SAST engine from scratch, and Semgrep is already trusted in the
  ecosystem.

## Non-goals (v1)

- Reinventing generic SAST — Semgrep `p/owasp-top-ten` already does it
- Slopsquatting / dependency CVE detection — Socket.dev, npq, npm audit own this
- Runtime LLM red-teaming — Garak, PyRIT, Promptfoo own this
- Secret scanning — gitleaks owns this; we provide a hook to run it alongside

## Roadmap (post v1)

- VSCode extension for in-editor rule feedback
- GitHub App for org-wide posture reporting (which rules fire across which repos)
- Framework-specific rule packs (Next.js Server Actions, Express middleware, FastAPI deps)
- Block-at-generation-time integration with assistants (an MCP server that
  refuses to write code that would fail the rule pack)

## Status

Shipped. Twelve rules, the full v1 set, implemented with passing fixtures. Available on
npm as [`llm-audit`](https://www.npmjs.com/package/llm-audit) and on
GitHub at
[`github.com/Javierlozo/llm-audit`](https://github.com/Javierlozo/llm-audit).
