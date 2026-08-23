# Changelog

All notable changes to `llm-audit`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `scan --json` envelope carries its own `schemaVersion`, versioned
independently of the package. It is at `1` and has not changed.

## [Unreleased]

## [0.4.0] — 2026-08-22

### Added

- **`scan --html <file>`** writes a standalone, shareable HTML report: findings
  grouped under the rule that explains them, with what the rule catches, why an
  AI assistant writes the pattern, how to fix it, and the pack's own `safe.*`
  fixture as a worked example of the fix. One self-contained file — no assets,
  no scripts, no network — so it works as a CI artifact or an email attachment.
  A filtered run says so inside the document.
- **`rules <rule-id>`** explains a single rule in the terminal, ending with the
  verified safe implementation.
- `scan --rule <id>` (repeatable / comma-separated) and `scan --severity
  <level>` narrow a run. Filtered output is labelled as filtered so it is never
  mistaken for a clean bill of health.
- `scan --compact` / `--verbose`. Past 15 findings the human renderer switches
  to one line per finding on its own and tells you how to get the detail back.
- `scan --fail-on <any|error|warning|info|never>` separates the report from
  the exit code, so a repo with an existing backlog can adopt the pack
  without a red pipeline on day one.
- `npm run demo:svg` (`tools/make-scan-demo.mjs`) regenerates the README hero
  by scanning a real sample app with the real CLI and rendering the live ANSI
  output as an animated terminal SVG. The asset is reproducible byte-for-byte
  and honours `prefers-reduced-motion`.
- `FORCE_COLOR` opts non-TTY consumers into coloured output, and `COLUMNS`
  pins the wrap width — both standard conventions, and what makes the hero
  reproducible without a pty.
- `--help` and `demo` open with a one-line identity (name, version, what the
  tool is). TTY-gated: piped and captured output stays plain text.

### Changed

- Human output leads with severity. Findings are grouped by file, the files
  holding the worst finding come first, each finding carries a coloured
  severity tag, and the summary breaks the total down by severity and by how
  many rules actually fired.
- A rule that fires repeatedly explains itself once. Later occurrences keep
  their line number and source snippet but point back to the first.

## [0.3.0] — 2026-08-22

### Changed

- **`scan` and `demo` render their own human output** instead of passing
  Semgrep's text formatter through. Semgrep derives the displayed rule ID from
  the config path, so an installed package rendered every finding as
  `Users.you..npm._npx.<hash>.node_modules.llm-audit.rules.hardcoded-llm-api-key`
  — unreadable, and it disclosed the user's home directory in terminal output,
  screenshots, and CI logs. Findings now print the bare rule ID with its OWASP
  mapping, the risk, the fix as a list, and the matched source. Colour is
  suppressed when stdout is not a terminal and when `NO_COLOR` is set.

### Fixed

- Findings no longer report the matched source as the literal string
  `requires login`. Semgrep substitutes that for callers with no semgrep.dev
  account; the span is now read from disk. Affects `--json` too.
- Identical findings (one rule, one file, one span, matched by two patterns of
  the same rule) are collapsed. The fixture set reports 42 findings rather than
  44; no rule changed.
- `demo` prints fixture paths relative to the package root instead of absolute
  paths from the install location.

### Added

- CLI test suite (`npm run test:cli`, 22 tests): exit codes, the `--json`
  envelope contract field by field, SARIF validity, and `init`'s
  refuse-to-overwrite and stay-inside-cwd behavior. `npm test` runs the rule
  fixtures and the CLI suite.
- `tests` workflow — fixture suite on Node 18 and 22 for every push and PR.
- `self-scan` workflow — `llm-audit` scans its own `src/` with its own rule
  pack and uploads SARIF to GitHub Code Scanning, weekly and on every push.
- `SECURITY.md` (private disclosure policy, scope) and `CONTRIBUTING.md` (the
  four-part shape of a rule contribution).
- README: comparison table against `p/ai-best-practices`, a badge and nav
  header, the twelve-rule table (it listed five), and a real capture of `demo`.
- A visual identity: `assets/logo.svg` and `assets/banner.svg` draw the
  authority boundary the whole rule pack defends.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates,
  dependabot for the SHA-pinned actions.

### Fixed

- `docs/COMPETITIVE-LANDSCAPE.md` reported 37 and 21 fixture matches in
  different sections. The correct figure for the twelve shipped rules is 40.

## [0.2.0] — 2026-08-21

### Added

Four rules complete the v1 set (twelve total):

- `system-prompt-leakage-in-client-bundle` (LLM07) — prompt-shaped constants or
  literal `system` fields inside a `'use client'` module, which ship them to
  the browser.
- `untrusted-retrieval-context-in-system-role` (LLM01) — retrieval-shaped
  variables or a joined result set interpolated into the system role. Indexed
  documents are untrusted input; giving them system authority is indirect
  prompt injection.
- `model-output-rendered-as-markdown-without-sanitization` (LLM02) —
  `rehype-raw` without `rehype-sanitize`, `allowDangerousHtml`, `marked`
  `sanitize: false`, `markdown-it` `html: true`.
- `streaming-response-without-abort-handling` (LLM10) — a streaming call in a
  request handler with no `signal` forwarded. Caught a live bug in the author's
  own portfolio chat endpoint on its first run: a client disconnect left
  generation running and billing tokens nobody would read.

## [0.1.1] — 2026-08-21

### Fixed

- The bundled `skills/llm-audit/SKILL.md` still documented only the original
  five rules. It is what an assistant reads to remediate a finding, so the
  three rules added in 0.1.0 were invisible to agents.

## [0.1.0] — 2026-08-21

### Added

- `secrets-in-prompt-context` (LLM06), `request-body-to-llm-without-schema`
  (LLM08), `tool-call-dispatch-without-allowlist` (LLM08).
- Publishing via GitHub OIDC trusted publishing. No long-lived npm token exists
  in the repo or on any machine, and every release carries provenance — the
  point for a supply-chain security tool.
- `repository` metadata required for provenance attestation.

## [0.0.10] — 2026-04-30

### Fixed

- Three findings from a self-audit, plus repository hygiene.

## [0.0.9] — 2026-04-30

### Changed

- README revisions.

## [0.0.8] — 2026-04-29

### Changed

- `init` now asks before installing the pre-commit hook. Non-interactive
  callers (CI, piped stdin) accept the default rather than hanging.
- Author attribution corrected.

## [0.0.7] — 2026-04-29

### Added

- Ships a Claude Code skill; `init --skill` and `init --skill-only`. Any agent
  reading the universal skill format picks it up.

## [0.0.6] — 2026-04-28

### Added

- `doctor` checks the npm registry for a newer version, on demand only. No
  background network calls and no cache files on ordinary runs.

## [0.0.5] — 2026-04-28

### Added

- `doctor` command; `scan --json` (versioned envelope) and `scan --sarif`
  (SARIF 2.1.0); `init --dry-run`.

## [0.0.4] — 2026-04-28

### Changed

- CLI reworked along [clig.dev](https://clig.dev) lines, with adoption-friction
  fixes taken from real install transcripts.

## [0.0.3] — 2026-04-28

### Added

- `demo` subcommand; fixtures ship in the published tarball so `demo` works
  with no repo setup.

## [0.0.2] — 2026-04-28

### Fixed

- Six findings from a self-audit; `docs/SECURITY-AUDIT.md` records the threat
  model for the files `init` writes.

## [0.0.1] — 2026-04-28

### Added

- Initial release: five rules, vulnerable + safe fixtures, `scan` and `init`.
  Renamed from `@iberiatech/llm-audit` and repositioned as a TS/JS complement
  to Semgrep's `p/ai-best-practices`.

[Unreleased]: https://github.com/Javierlozo/llm-audit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Javierlozo/llm-audit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Javierlozo/llm-audit/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Javierlozo/llm-audit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Javierlozo/llm-audit/compare/v0.0.10...v0.1.0
[0.0.10]: https://github.com/Javierlozo/llm-audit/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/Javierlozo/llm-audit/releases/tag/v0.0.9
