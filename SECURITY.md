# Security Policy

`llm-audit` is a static-analysis tool that people run against their own source
code, usually in a pre-commit hook or CI. That places it inside the developer
trust boundary, so vulnerabilities here matter more than the size of the
project suggests.

## Supported versions

Only the latest published minor is supported. Fixes ship as a new release on
npm rather than as patches to older lines.

| Version | Supported |
|---|---|
| 0.2.x | ✅ |
| < 0.2 | ❌ |

## Reporting a vulnerability

**Don't open a public issue for a security report.**

Use GitHub's private reporting:
[**Report a vulnerability**](https://github.com/Javierlozo/llm-audit/security/advisories/new).
If that's unavailable to you, reach out via [luislozoya.com](https://www.luislozoya.com).

Please include:

- what an attacker can do, and what they need in order to do it
- a minimal reproduction, ideally a repo or file that triggers the behavior
- the `llm-audit` version (`npx llm-audit --version`) and Semgrep version

You will get an acknowledgement within 72 hours and an assessment within 7
days. If a fix is warranted, it ships as a patch release with a GitHub Security
Advisory. Credit is given by default; say so if you would rather not be named.

## What is in scope

- Arbitrary code or command execution triggered by scanning attacker-controlled
  source, rule files, or configuration
- Path traversal or file writes outside the target directory, including via
  `llm-audit init` and the pre-commit hook it installs
- Exfiltration of scanned source, environment variables, or credentials
- Supply-chain issues in how the package is built, published, or verified
- Privilege escalation through the installed git hook

## What isn't in scope

These are real feedback, and welcome, as normal public issues, not security
reports:

- **False negatives.** A rule missing a vulnerable pattern is a rule bug. It's
  the expected state of any SAST tool, not a vulnerability in this one.
- **False positives.** Same: open an issue with the code that misfired.
- Vulnerabilities in Semgrep itself, report those to
  [Semgrep](https://github.com/semgrep/semgrep/security).
- Findings that require an attacker to already control the machine running the
  scan.

## Scope of the guarantee

`llm-audit` is a lint pass, not a proof of security. A clean scan means the
twelve shipped rules found nothing, not that the code is free of LLM-related
vulnerabilities. It's one layer among code review, dependency scanning, secret
scanning, and runtime guardrails. Don't represent a green run as an audit.
