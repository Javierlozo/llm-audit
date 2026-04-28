# Rules

Each rule in `rules/` maps to an entry in the [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/),
ships with a vulnerable + safe fixture in `test/fixtures/<rule-id>/`, and includes
a short note on **why an AI coding assistant tends to write this pattern**.

That last note is intentional. The rules exist because AI assistants reproduce
these shapes regularly, and naming the failure mode is part of the value.

## v0 (shipped)

### `untrusted-input-in-system-prompt`

- **OWASP:** LLM01 — Prompt Injection
- **CWE:** CWE-77, CWE-94
- **Catches:** user-controlled input (`req.body.*`, `req.query.*`, `await req.json()`)
  flowing into the `system` role of an Anthropic, OpenAI, or AI SDK call, either
  directly or via a template literal.
- **Why AI writes this:** assistants frequently lift the user's "instructions"
  into the system prompt to "make the model follow them." This breaks the
  authority boundary between developer and user.
- **Fix:** keep the system prompt static, place untrusted input only in the
  `user` role, and validate the input shape with zod / valibot at the boundary.

### `llm-output-insecure-handling`

- **OWASP:** LLM02 — Insecure Output Handling
- **CWE:** CWE-79, CWE-94, CWE-78
- **Catches:** the result of an LLM call (`generateText`, `chat.completions.create`,
  `messages.create`) being passed into `eval`, `new Function`, `child_process.exec`,
  `dangerouslySetInnerHTML`, or `element.innerHTML`.
- **Why AI writes this:** assistants happily round-trip "ask the model for HTML
  / code / a shell command and then run it." This treats model output as trusted
  when it is, by definition, untrusted.
- **Fix:** validate model output against a schema (zod), escape before rendering,
  never pass it to a code-execution sink.

### `untrusted-input-concatenated-into-prompt-template`

- **OWASP:** LLM01 — Prompt Injection
- **CWE:** CWE-77
- **Catches:** template-literal prompts (`prompt: \`... ${req.body.x} ...\``)
  passed to `generateText` / `streamText` / `generateObject` / `streamObject`,
  with no structural separator and no role boundary between instructions and
  user input.
- **Why AI writes this:** every prompt-engineering tutorial uses template
  literals as the ergonomic default. The shape is the path of least resistance
  and assistants reproduce it.
- **Fix:** use the `messages` API with explicit role boundaries, place user
  input only in `user`, keep `system` static.

### `model-output-parsed-without-schema`

- **OWASP:** LLM02 — Insecure Output Handling
- **CWE:** CWE-20
- **Catches:** `JSON.parse` invoked on model output (`generateText().text`,
  `chat.completions.create()...content`, etc.) without a zod / valibot schema
  validator on the path. Taint mode.
- **Why AI writes this:** prompts that say "respond in JSON" are treated as
  authoritative. `JSON.parse` is the reflex move; schema validation is extra
  ceremony that demos skip.
- **Fix:** prefer `generateObject` / structured outputs / `responseFormat:
  json_schema`, or run results through `Schema.parse` before property access.

### `hardcoded-llm-api-key`

- **OWASP:** LLM06 (overlap with secret-scanning category)
- **CWE:** CWE-798
- **Catches:** inline string in `apiKey:` field of `new OpenAI(...)`,
  `new Anthropic(...)`, `createOpenAI(...)`, `createAnthropic(...)`, plus a
  regex fallback for `sk-...` / `sk-proj-...` / `sk-ant-...` shapes.
- **Why AI writes this:** quickstart examples show inline keys for brevity.
  Assistants regress to the shape under "make it self-contained."
- **Fix:** load keys from `process.env`, validated with a schema at startup;
  prefer OIDC / workload identity where supported. Run `gitleaks` in CI as
  a backstop.

## v1 plan (not yet shipped)

### `system-prompt-leakage-in-client-bundle`

- **OWASP:** LLM07 — System Prompt Leakage
- **Catches:** static system prompts referenced in client-side files (e.g.
  imported into a `'use client'` module, or an Edge / Routing Middleware that
  ships text to the browser).

### `tool-call-without-allowlist`

- **OWASP:** LLM08 — Excessive Agency
- **Catches:** a tool-calling handler that dispatches on `toolCall.name` without
  matching against a known list, or that forwards `toolCall.arguments` to a
  privileged sink without validation.

### `model-output-parsed-without-schema`

- **OWASP:** LLM02
- **Catches:** `JSON.parse(modelResponse)` followed by property access, with no
  schema validation in between.

### `sensitive-context-in-prompt`

- **OWASP:** LLM06 — Sensitive Information Disclosure
- **Catches:** environment variables, secrets, or PII fields being inlined into
  prompt text or system instructions.

### `model-output-rendered-as-markdown-without-sanitization`

- **OWASP:** LLM09 — Overreliance
- **Catches:** model output passed to a markdown renderer with HTML enabled and
  no sanitizer.

### `untrusted-retrieval-context-in-system-role`

- **OWASP:** LLM01
- **Catches:** RAG pipelines that concatenate retrieved document text into the
  `system` role rather than a separate `user` or tagged context block.

### `hardcoded-llm-api-key`

- **Category:** AI code smell
- **Catches:** `sk-...` / `sk-ant-...` / Anthropic / OpenAI key shapes adjacent
  to imports of `openai`, `@anthropic-ai/sdk`, or `ai`.

### `llm-route-without-input-validation`

- **Category:** AI code smell
- **Catches:** a Next.js route handler or Server Action that takes a string
  from `request.json()` and forwards it to an LLM call without zod / valibot
  on the path.

### `streaming-response-without-abort-handling`

- **Category:** AI code smell
- **Catches:** `streamText` / `streamObject` returned from a route handler
  without wiring a request abort signal to the underlying call.

## Authoring conventions

- **One rule per file** in `rules/<rule-id>.yaml`.
- **One pair of fixtures** in `test/fixtures/<rule-id>/{vulnerable,safe}.ts`.
- **Metadata required:**
  - `owasp-llm` — the LLM Top 10 entry (e.g. `LLM01`)
  - `category` — short slug
  - `cwe` — list of CWE IDs
  - `references` — OWASP / vendor docs
- **Severity:** `ERROR` for OWASP LLM Top 10 sinks, `WARNING` for AI code smells.
- **Message:** lead with the failure mode, then a Fix paragraph.
