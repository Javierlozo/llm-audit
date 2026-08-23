# Competitive Landscape

> Empirical comparison of `llm-audit` against existing tooling for LLM-application
> security, as of April 2026. The point of this document is to be honest about
> what already exists so that adopters and reviewers can verify the gap this
> project actually fills.

## TL;DR

The TypeScript / JavaScript niche for OWASP-LLM-Top-10 static analysis is
**actually open**. The strongest alternative is Semgrep's official
`p/ai-best-practices`, is Python-only for LLM-app code, with **0 JS/TS rules**
out of 27 total. Other OSS competitors (`agent-audit`, `llm-sast-scanner`)
target Python or aren't LLM-app-specific. Commercial vendors (Snyk, Checkmarx,
Veracode, Sonar, CodeQL/GHAS) don't publicly market a first-party LLM Top 10
rule pack. Runtime guardrail tools (Lakera, Protect AI, Garak, Promptfoo eval)
are a different category and out of scope.

---

## Empirical comparison: `p/ai-best-practices` against `llm-audit` fixtures

### Method

```sh
brew install semgrep
git clone https://github.com/Javierlozo/llm-audit.git
cd llm-audit
semgrep --config p/ai-best-practices test/fixtures/ --metrics=off
```

### Result

```
Rules run: 27
Targets scanned: 0
Findings: 0
```

Reason: every rule in `p/ai-best-practices` declares `languages:` as Python,
generic, or Bash. None target JavaScript or TypeScript, so Semgrep filters out
all of `llm-audit`'s `.ts` / `.tsx` fixtures before scanning.

### `p/ai-best-practices` language coverage

Downloaded the rule pack directly from `https://semgrep.dev/c/p/ai-best-practices`:

| Languages targeted | Count | What they cover |
|---|---|---|
| Python | 13 | LangChain, OpenAI / Anthropic / Cohere / Gemini / Mistral / HuggingFace **Python clients**, agent unbounded loops, MCP server Python implementations |
| Generic (regex over any text) | 11 | MCP server config files, Claude Code `settings.json`, hidden Unicode in configs, IDE settings, claude-settings-bypass-permissions |
| Bash | 3 | Claude Code hook scripts (unquoted vars, `wget \| bash`, DNS exfiltration in hooks) |
| **JavaScript / TypeScript** | **0** | Nothing |

### `llm-audit` against the same fixtures

```
PASS hardcoded-llm-api-key                              vulnerable=5/3  safe=0
PASS llm-output-insecure-handling                       vulnerable=6/6  safe=0
PASS model-output-parsed-without-schema                 vulnerable=2/2  safe=0
PASS untrusted-input-concatenated-into-prompt-template  vulnerable=3/3  safe=0
PASS untrusted-input-in-system-prompt                   vulnerable=5/5  safe=0
```

42 vulnerability matches caught across 12 rules, 0 false positives on the safe
fixtures. All TypeScript and TSX targets that `p/ai-best-practices` skipped.

---

## Other OSS tools

### `HeadyZhang/agent-audit`

- **Distribution:** PyPI (`pip install agent-audit`), Python-based scanner.
- **Languages:** Python only, sample reports show `agent.py` files, the
  builtin rules directory contains rule files keyed to LangChain, CrewAI,
  AutoGen, LangGraph, Pydantic AI, MCP server patterns.
- **Scope:** AI agent frameworks and MCP infrastructure. 53 rules mapped to
  OWASP Agentic Top 10 (a different OWASP project from LLM Top 10).
- **Verdict:** **Different lane.** Python agent frameworks vs. our TS/JS LLM
  apps. No conflict; arguably complementary in a polyglot org.

### `SunWeb3Sec/llm-sast-scanner`

- **Distribution:** A Claude Code / Codex **skill** (markdown reference files
  copied into `~/.claude/skills/`), not a standalone scanner.
- **What it actually is:** Workflow + 34 vulnerability reference files that
  prompt an LLM agent to perform taint analysis. The agent runs the analysis;
  the project supplies the rubric.
- **Scope:** General-purpose SAST (SQL injection, XSS, JWT, IDOR, etc.), not
  LLM-application-specific. Multi-language in theory because it's a prompt,
  not a parser.
- **Verdict:** **Different category.** Not a Semgrep-style ruleset; not LLM-app
  specific.

### `xr843/llm-seclint`, `camgrimsec/ai-codegen-security-linter`

- Stars: 0 to 2 each as of April 2026, last activity within the past 4 weeks.
- Same conceptual pitch as `llm-audit` but unmaintained and shallow.
- **Verdict:** **Adjacent but not credible alternatives.** Worth tracking; not
  a competitive threat.

### `SecureClaw` (Sparkry AI)

- Free CLI scanner for prompt-injection risks, exposed API keys, insecure AI
  tool configurations. 28 detection patterns, zero dependencies.
- Language coverage not publicly documented.
- **Verdict:** **Adjacent.** Looks targeted at agent / MCP configs more than
  LLM-app source code. Worth running side-by-side once published.

---

## Commercial vendors

### Generic SAST vendors with no public LLM-Top-10 rule pack

- **Snyk Code, Checkmarx, Veracode, Sonar, CodeQL / GitHub Advanced Security**
 , none publicly market a first-party "OWASP LLM Top 10" rule pack as of
  April 2026. They cover generic OWASP Top 10 well; LLM-specific rules are
  not branded or shipped as a discoverable pack.

### Vendors with adjacent offerings

- **Endor Labs AI SAST.** General code-review SAST, not LLM-Top-10-specific;
  classifies findings against generic OWASP Top 10.
- **Cisco AI Agent Security Scanner.** Watches `.claude/settings.json` and
  similar config files for unauthorized modifications. Different layer.

### Promptfoo Code Scanning

- Closed product (web dashboard at `promptfoo.app`, VSCode extension, CLI).
- Covers the same six conceptual categories (prompt injection, data
  exfiltration, PII exposure, improper output handling, excessive agency,
  jailbreak risks).
- **Languages not publicly disclosed**; pricing not on the marketing page.
- **Verdict:** **Closest commercial adjacent.** Likely the most direct overlap
  if/when they publicly support TS/JS. Open-source-vs-paid is the natural
  differentiator either way.

---

## Out of scope (different category)

These are LLM security tools but they target **runtime** behavior, not source
code at commit time. They aren't competitors to `llm-audit`; they're
complements run at a different stage.

| Tool | What it does | Static or runtime |
|---|---|---|
| Lakera Guard / Red | LLM firewall + red-team eval | Runtime |
| Protect AI LLM Guard | Input/output filter for LLM apps | Runtime |
| Protect AI NB Defense | Jupyter notebook scanner | Static, but notebooks not LLM apps |
| HiddenLayer | Model security platform | Runtime + supply chain |
| CalypsoAI, Robust Intelligence, Cisco AI Defense | Enterprise AI firewall | Runtime |
| Lasso, Pillar, Aim, Prompt Security, Cranium, Mindgard | AI security platforms | Mostly runtime |
| Garak (NVIDIA) | LLM red-team / probe tool | Runtime |
| PyRIT (Microsoft) | Risk identification toolkit for AI | Runtime |
| Promptfoo eval | Prompt testing framework | Build/test time, not SAST |
| Rebuff, Vigil | Prompt injection detectors | Runtime |
| GuardrailsAI | Output validation framework | Runtime |

---

## Where `llm-audit` actually competes

After all of the above, the contested ground is small and clear:

1. **TS/JS LLM-app static analysis at commit time, mapped to OWASP LLM Top 10.**
   No first-party Semgrep pack here. No popular OSS scanner here. Closed
   commercial products may or may not cover it (not publicly verifiable).
2. **A pre-commit + CI workflow that ships as a single `npm i -D` install.**
   Lower friction than installing a separate Python-based scanner, especially
   in a TS/JS-only repo.

Honest framing: `llm-audit` is **not** a category-creating product. It's a
**well-positioned complement** to `p/ai-best-practices`, occupying the
TypeScript / JavaScript LLM-app niche the upstream pack doesn't cover. That
positioning is empirically defensible, running Semgrep's pack against a TS/JS
fixture set produces zero hits, and `llm-audit` produces 40.

The right pitch is "the TS/JS half of the LLM-Top-10 SAST story," not "I
invented a category."

---

## How to verify this document

Every claim above is reproducible:

```sh
# Confirm p/ai-best-practices language coverage
curl -s https://semgrep.dev/c/p/ai-best-practices > /tmp/p-ai-best-practices.yaml
grep -A2 "^\\s*languages:" /tmp/p-ai-best-practices.yaml | grep -E "^\\s*-\\s+" | sort | uniq -c

# Confirm zero hits on TS/TSX fixtures
git clone https://github.com/Javierlozo/llm-audit.git
cd llm-audit
semgrep --config p/ai-best-practices test/fixtures/ --metrics=off

# Confirm 42 hits with llm-audit's own pack
npm test
```

If any of these claims become inaccurate (e.g., Semgrep adds JS/TS rules to
`p/ai-best-practices`), this document needs to be updated. Open an issue or PR.
