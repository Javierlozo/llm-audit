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

## v0.1 (shipped)

### `tool-call-dispatch-without-allowlist`

- **OWASP:** LLM08 — Excessive Agency
- **CWE:** CWE-470, CWE-77
- **Catches:** a model-supplied tool name used as a dynamic index into a handler
  map (`handlers[call.toolName](args)`, `handlers[call.function.name](...)`,
  and the resolve-then-invoke variant), with no membership check in the
  enclosing function.
- **Why AI writes this:** a lookup table is the shortest correct-looking way to
  wire up tool calling, and every provider example shows the tool name coming
  back off the response object. The dispatch reads as plumbing rather than as a
  trust boundary.
- **Fix:** switch on literal tool names, or check an explicit allowlist before
  dispatch, and validate the arguments with a schema before the handler runs.

### `secrets-in-prompt-context`

- **OWASP:** LLM06 — Sensitive Information Disclosure
- **CWE:** CWE-200, CWE-532
- **Catches:** `process.env.*` interpolated into a `system`, `prompt`, or
  `instructions` field, or into the content of a message entry.
- **Why AI writes this:** when the task is "let the model use our API," inlining
  the key into the instructions is the most direct reading of the request. The
  code works, so nothing signals that the context is readable output.
- **Fix:** keep credentials in the client config or request headers, reference
  resources by opaque id, and resolve them server-side after the model responds.

### `request-body-to-llm-without-schema`

- **OWASP:** LLM01 — Prompt Injection
- **CWE:** CWE-20, CWE-77
- **Catches:** taint from `await request.json()` / `.text()` / `.formData()`
  into an LLM call with no zod / valibot parse on the path.
- **Why AI writes this:** route-handler examples destructure the body and use it
  immediately. Validation is a separate concern that the prompt for the feature
  never mentions, so it never appears.
- **Fix:** parse the body with an explicit schema and a max length on free-text
  fields, pass validated values into the `user` role only, and rate limit the
  endpoint.
- **Known limitation:** the sanitizer list matches on *name*, so a function
  called `sanitizeInput()` that returns its argument unchanged will silence the
  rule. This is the deliberate trade: name-based sanitizers are what keep the
  rule off correct code, and Semgrep cannot prove a helper actually validates.
  Treat a passing scan as "no obvious hole," not as a proof.
- **Not flagged:** hand-rolled validation counts. A named `sanitize*` /
  `validate*` helper, an explicit length clamp (`slice(0, MAX)`), or a
  per-element `.map()` callback that type-checks and clamps all sanitize the
  taint. This came directly out of dogfooding: the first draft flagged two
  endpoints that validate correctly without a schema library, and a rule that
  fires on correct code is a rule people turn off.

## v1 plan (not yet shipped)

### `system-prompt-leakage-in-client-bundle`

- **OWASP:** LLM07 — System Prompt Leakage
- **Catches:** static system prompts referenced in client-side files (e.g.
  imported into a `'use client'` module, or an Edge / Routing Middleware that
  ships text to the browser).

### `model-output-rendered-as-markdown-without-sanitization`

- **OWASP:** LLM09 — Overreliance
- **Catches:** model output passed to a markdown renderer with HTML enabled and
  no sanitizer.

### `untrusted-retrieval-context-in-system-role`

- **OWASP:** LLM01
- **Catches:** RAG pipelines that concatenate retrieved document text into the
  `system` role rather than a separate `user` or tagged context block.

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
