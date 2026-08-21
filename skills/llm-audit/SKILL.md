---
name: llm-audit
description: Run OWASP LLM Top 10 static analysis on TypeScript/JavaScript code that integrates with LLMs. Use this skill whenever you edit files that import openai, @anthropic-ai/sdk, ai, or @ai-sdk/*; whenever a file calls chat.completions.create, messages.create, generateText, streamText, generateObject, or responses.create; or before any commit that touches LLM-integrated code. Returns structured findings mapped to OWASP LLM Top 10 with explicit fix guidance.
---

# llm-audit

Static analysis for TypeScript and JavaScript LLM-application code,
mapped to the OWASP Top 10 for LLM Applications. Catches the security
failure modes AI coding assistants quietly introduce when integrating
LLM features.

## When to invoke this skill

Run an `llm-audit` scan when **any** of these are true:

- The user is writing or modifying code that calls an LLM provider
  (OpenAI, Anthropic, Cohere, Gemini, Mistral, HuggingFace, AI Gateway)
- A changed file imports from `openai`, `@anthropic-ai/sdk`, `ai`,
  `@ai-sdk/openai`, `@ai-sdk/anthropic`, or any other AI SDK provider
- A file calls `chat.completions.create`, `messages.create`,
  `generateText`, `streamText`, `generateObject`, or `responses.create`
- The user is about to commit changes that touch LLM-integrated code
- The user explicitly asks for a security audit, prompt-injection
  check, or OWASP LLM Top 10 review

If you are uncertain whether code is LLM-integrated, scan it anyway.
The scan is fast and the cost of a false negative (shipping a real
prompt-injection vulnerability) is much higher than the cost of an
extra scan.

## How to invoke

Run the scan with JSON output. The `--json` envelope is a stable
contract (`schemaVersion: 1`) you can rely on:

```bash
npx llm-audit scan --json <changed-paths>
```

If `llm-audit` is not yet installed in the project:

```bash
npm i -D llm-audit
```

Semgrep is a peer dependency and must be on PATH. If `semgrep` is
missing, the scan will print an install hint (`brew install semgrep`
or `pipx install semgrep`).

## Output shape

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "llm-audit", "version": "0.0.X" },
  "scannedPaths": ["src/app/api/chat/route.ts"],
  "summary": { "findings": 1 },
  "findings": [
    {
      "ruleId": "model-output-parsed-without-schema",
      "owasp": "LLM02",
      "severity": "WARNING",
      "cwe": ["CWE-20"],
      "path": "src/app/api/chat/route.ts",
      "startLine": 61,
      "endLine": 61,
      "message": "Model output is being parsed with `JSON.parse` ...",
      "lines": "..."
    }
  ]
}
```

`scan` exits **0** on no findings and **1** on findings, regardless of
output format.

## How to interpret and fix findings

Treat the `findings` array as the authoritative list of issues to
address. For each entry:

1. Read the `message`. It contains a description of the failure mode
   and a `Fix:` section with the canonical remediation.
2. Apply the canonical fix per the rule. The eight rules currently
   shipped, with their canonical fixes:

   | `ruleId` | OWASP | Canonical fix |
   |---|---|---|
   | `untrusted-input-in-system-prompt` | LLM01 | Keep `system` static. Move user input to the `user` role. Validate input shape with `zod` / `valibot` at the request boundary. |
   | `untrusted-input-concatenated-into-prompt-template` | LLM01 | Replace single-string `prompt:` with the `messages: [...]` API and explicit role boundaries. Static `system`, untrusted text only in `user`. |
   | `llm-output-insecure-handling` | LLM02 | Validate output against a schema (zod). Sanitize before rendering as HTML (`DOMPurify`). Never pass model output to `eval`, `Function`, or a shell sink. |
   | `model-output-parsed-without-schema` | LLM02 | Wrap `JSON.parse(modelOutput)` directly in `Schema.safeParse(...)` or `Schema.parse(...)`. Or use `generateObject` / `responseFormat: json_schema` so the model is constrained at the API. |
   | `hardcoded-llm-api-key` | LLM06 | Read keys from `process.env`, validated at startup with `zod`. Use OIDC / workload identity where the platform supports it. |
   | `tool-call-dispatch-without-allowlist` | LLM08 | Switch on a closed set of literal tool names, or check membership in an explicit allowlist before dispatch. Validate tool arguments with a schema before the handler runs. |
   | `secrets-in-prompt-context` | LLM06 | Keep credentials in the SDK client config or request headers, never in prompt text. Reference resources by opaque id and resolve them server-side after the model responds. |
   | `request-body-to-llm-without-schema` | LLM01 | Parse the request body with `zod` / `valibot` before use, with an explicit max length on free-text fields. Pass validated values into the `user` role only. Rate limit the endpoint. |

3. Re-run the scan against the same paths until the `findings` array
   is empty.

## What NOT to do

- **Do not** suppress the rule by adding a `nosemgrep` or skip
  comment to the file
- **Do not** modify the rule pack to make findings disappear
- **Do not** wrap untrusted input in a token, hash, or "sanitizer"
  function unless you can show why it neutralizes the specific failure
  mode the rule names. The canonical fixes above are the validated
  remediations.
- **Do not** ignore an `LLM01` or `LLM02` finding because "the catch
  block handles it." That's the exact pattern the rule warns about.

## Useful adjacent commands

| Command | What it does |
|---|---|
| `npx llm-audit demo` | Runs all rules against bundled vulnerable fixtures so you can see what each rule catches. Use this if the user wants to understand a specific rule. |
| `npx llm-audit doctor` | Diagnostic checklist (semgrep on PATH, husky state, version freshness). Use this when troubleshooting setup. |
| `npx llm-audit scan --sarif` | SARIF 2.1.0 output for GitHub Code Scanning. Use this when the user wants to upload findings to their security dashboard. |
| `npx llm-audit init --dry-run` | Preview what `init` would write to `.husky/` and `.github/workflows/` without writing. |

## Stable schema guarantee

The `--json` envelope is versioned. `schemaVersion: 1` will not
break in future minor releases of `llm-audit`. If we change the
shape, `schemaVersion` will increment and the README will document
the migration. Build downstream automation against the documented
fields confidently.

## Documentation

- Project page: <https://luislozoya.com/llm-audit>
- Rule rationale: <https://github.com/Javierlozo/llm-audit/blob/main/docs/RULES.md>
- Why AI assistants reproduce these patterns: <https://github.com/Javierlozo/llm-audit/blob/main/docs/AI-FAILURE-MODES.md>
- Competitive landscape: <https://github.com/Javierlozo/llm-audit/blob/main/docs/COMPETITIVE-LANDSCAPE.md>
- Self-audit: <https://github.com/Javierlozo/llm-audit/blob/main/docs/SECURITY-AUDIT.md>
