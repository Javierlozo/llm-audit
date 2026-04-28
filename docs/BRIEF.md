# `llm-audit` — Project Brief

> Static analysis for LLM-application code. OWASP LLM Top 10, at commit time.

## Problem

AI coding assistants (Claude, Cursor, Kiro, Copilot) now write a substantial
share of new application code. They produce a predictable, repeatable set of
security failures that existing SAST tools were not built to catch:

- Hallucinated or typosquatted dependencies (slopsquatting)
- Hardcoded secrets baked into example-shaped code
- Permissive defaults: `cors: '*'`, missing cookie flags, unbounded request bodies
- Unsafe `dangerouslySetInnerHTML` and untrusted templating
- Server Actions and route handlers that trust `request.json()` blindly
- **LLM-specific sinks:** user input flowing directly into a system prompt, model
  output piped into `eval` / raw HTML / shell, tool-calling handlers without
  allowlists, retrieval contexts that mix untrusted text with system instructions

Generic SAST (Semgrep, Snyk, ESLint security plugins) covers the first few
categories well. The LLM-specific category has effectively no curated, maintained
ruleset shipped as a one-install package.

## Solution

A focused Semgrep rule pack plus thin CLI wrapper. Targets the OWASP Top 10 for
LLM Applications at static-analysis time. One install, opinionated defaults,
sub-5 second pre-commit on changed files, full scan in CI.

The rule pack is the product. The CLI is convenience. Generic security concerns
(generic XSS, SQLi, secret scanning, dependency CVEs) are explicitly delegated
to the tools that already do them well (Semgrep packs, gitleaks, npm audit,
Socket.dev). We do not reimplement those.

## v1 Scope (10 to 12 rules)

Each rule maps to an OWASP LLM Top 10 entry, ships with a vulnerable + safe
fixture, and includes a "why an AI assistant tends to write this" note in
`docs/RULES.md`.

1. **LLM01 — Prompt Injection: untrusted input in `system` role** (v0 ✅)
2. **LLM01 — User input concatenated into a prompt template without separator** (v0 ✅)
3. **LLM02 — Insecure Output Handling: model output to dangerous sink** (v0 ✅)
4. **LLM02 — `JSON.parse` on raw model output without schema validation** (v0 ✅)
5. **LLM06 — Hardcoded LLM API keys in source** (v0 ✅)
6. **LLM07 — System prompt leakage: system text inlined in client-visible code**
7. **LLM08 — Excessive Agency: tool-calling handler without allowlist on tool name or args**
8. **LLM01 — Retrieval context: untrusted document text mixed into a `system` role**
9. **LLM06 — Sensitive context (env, secrets, user PII) included in prompt**
10. **LLM09 — Overreliance: model output rendered as code or markdown without sanitization**
11. **AI-CODE-SMELL — Route handler that forwards arbitrary string to LLM without zod/valibot**
12. **AI-CODE-SMELL — Streaming response without backpressure / abort handling**

## Differentiation

- **Category nobody owns yet** at the static-analysis layer. Confirmed via npm
  search: `eslint-plugin-security` is generic JS, `klg-llm-audit` is runtime
  audit-logging, `secaudit` (the only existing package on that name) is an SEC
  10-K analyzer. No competitor ships a maintained Semgrep pack for LLM Top 10.
- **Research-flavored rationale.** Each rule documents the AI-assistant failure
  mode it catches. `docs/RULES.md` and `docs/AI-FAILURE-MODES.md` (planned) are
  the portfolio assets, not just the code.
- **Distribution leverage.** Ships as a Semgrep pack first; the CLI is a
  convenience wrapper. Lower maintenance than building a SAST engine from
  scratch, and Semgrep is already trusted in the ecosystem.

## Pitch for g/d/n/a

- MIT, no infra to operate, drops into any repo with `npm i -D` and `brew install semgrep`
- Catches a class of bugs AI assistants are actively introducing across teams
- Pre-commit + CI share the same rule pack; same config in both places
- Could become the internal "before-you-push" standard across all g/d/n/a repos
- Aligns with shift-left and secure-by-default posture

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

v0 scaffold. Five rules implemented with passing/failing fixtures.
Repository: `github.com/<your-handle>/llm-audit` (not yet created).
npm: `llm-audit` (not yet published).
