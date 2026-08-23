# Changelog

All notable changes to `llm-audit`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `scan --json` envelope carries its own `schemaVersion`, versioned
independently of the package. It is at `1` and has not changed.

## [Unreleased]

### Fixed

- The installed GitHub Action ran `npm ci` before scanning. A static scan reads
  source files and never needs the application's dependency tree, so that step
  only added ways for a security job to fail for reasons that are not security.
  It failed on a real repo within a minute of being enabled, on a lock file
  inconsistency that had nothing to do with llm-audit. The step is gone, and a
  test keeps it gone.

### Fixed

- The GitHub Action `init` installs carried the same mislabeled SHA pin this
  repo had: `actions/checkout` commented `# v6.0.2` while the SHA was v4.3.1
  upstream. Anyone who ran `init` got that comment in their repository. Both
  actions now pin v7.0.1 and v7.0.0 with comments that match, and a test checks
  every pin in the template against the upstream tag refs, so a pin that names
  the wrong version fails the build.

### Changed

- Every document is in the author's own voice now, the README first. 135 em
  dashes across the project and not one contraction, which reads as generated.
  Same facts, same commands; shorter sentences and the balanced-clause
  constructions removed. `docs/RULES.md` matters most, since the CLI reads it at
  run time and both `rules <id>` and the HTML report render that prose.
- CI actions moved to `actions/checkout` v7.0.1 and `actions/setup-node` v7.0.0,
  with the version comments corrected. The pinned SHA said `# v6.0.2` and was
  actually v4.3.1 upstream. For a project that pins by SHA on purpose, the
  comment is the only reviewable part of the pin.

### Added

- `llm-audit uninstall` removes the pre-commit hook, the CI workflow, and the
  skill that `init` wrote. It only deletes files it can prove are its own, and
  says which ones it is leaving alone. Reaching for `llm-audit delete` and
  getting "unknown subcommand" was a dead end with no way out.
- Common wrong words now point at the right command: `delete`, `remove`, and
  `rm` suggest `uninstall`; `setup` and `install` suggest `init`; `check`,
  `run`, and `lint` suggest `scan`. Edit distance was never going to connect
  "delete" to "uninstall".
- `--help` explains that the CLI runs through `npx` unless it is installed
  globally, since a bare `llm-audit` is not on PATH after a local install.

### Changed

- The compact view collapses a rule's repeats within a file onto one row:
  `hardcoded-llm-api-key LLM06  lines 18, 22, 27` instead of three near
  identical rows. On the bundled fixtures that is 42 findings in 24 lines
  rather than 60. Past six occurrences it prints a count instead of a list.
- `doctor` distinguishes optional setup from problems. A project with no
  pre-commit hook gets `[note]`, not `[warn]` — warning about a choice teaches
  people to ignore warnings. A hook installed with no husky to run it is still
  a warning, because that one is broken.

### Fixed

- `init` refused to overwrite files it had written itself, so running it twice
  ended in an error. It now recognises its own work: identical files report
  "already installed", files from an older version say how to update, and only
  a file llm-audit did not write is refused. It also checks the disk before
  prompting, instead of asking a question and then announcing there was
  nothing to do.

### Fixed

- `scan` on a path that does not exist printed nothing at all and exited 2.
  Semgrep fails silently under `--quiet`, so the user got a status code and no
  explanation. Paths are checked before the scan runs, and a semgrep failure
  with an empty stderr now says so instead of exiting mute.
- `doctor` reported a missing pre-commit hook and a missing CI workflow as
  "present", because both branches shared one label. It now says "missing",
  which is what the accompanying "run `llm-audit init` to install" always
  implied.

### Fixed

- The README hero cropped mid-snippet once findings gained context lines, so
  it showed the two lines *above* the offending code and not the code itself —
  an advertisement for the tool finding nothing. The crop extends to a block
  boundary now, and the tail covers the whole summary again.
- `LLM_AUDIT_DETERMINISTIC=1` suppresses volatile output (elapsed time) so a
  rendered artifact is reproducible byte-for-byte. The generated hero sets it;
  without it the elapsed time had started changing the asset on every run.

### Added

- The JSON envelope and the HTML report now record **which revision was
  scanned** — branch, commit, and whether the working tree was dirty. A report
  that cannot name the code it describes is a screenshot, not a record.
- The HTML report opens with **what to fix first**: the three worst-and-largest
  rule clusters, linked. It also has working navigation — the file index links
  into the findings, and a jump-nav lists every rule that fired.
- `scan --by <file|rule>` groups findings by file (default) or by rule. Under
  rule grouping the rationale is stated once by construction.
- Findings carry **context lines** either side of the match, in the terminal
  and in the report. A single matched line locates a finding; its neighbours
  are what let a reader judge one without opening an editor.
- The terminal summary names **one place to start** — the worst rule with the
  most occurrences, with the command to learn it.
- A progress indicator while semgrep runs, and the elapsed time in the summary.
  TTY only; piped output is unchanged.

### Fixed

- A misspelled `--rule` id filtered every real finding away and printed
  `0 findings — clean` with exit 0. On a file with three hardcoded keys,
  `--rule hardcoded-llm-api-kye` was a silent pass. Unknown rule ids are now
  refused with a suggestion and exit 2.
- A filtered run that finds nothing no longer describes the codebase as
  "clean" — it names the filter that was applied and points at the unfiltered
  command. Only part of the pack was allowed to speak; saying "clean" overclaims.

## [0.4.2] — 2026-08-22

### Added

- `assets/commands.svg` — a card of all six commands in the README, ordered by
  the moment you would reach for each one. Generated from `--help` by
  `npm run commands:svg`, which refuses to render a command the CLI does not
  list.

### Fixed

- `scan` validated flags only after checking for semgrep, so a typo like
  `--sarrif` on a machine without the engine reported the missing engine
  instead of the typo. Arguments are checked first now: a usage error is the
  user's mistake and should be named as such.
- The docs-claim test called `demo`, which needs semgrep, from outside the
  suite's semgrep guard — so `npm test` failed rather than skipped on a machine
  without it. Both defects were found by running the suite with semgrep off
  PATH, which now also has a regression test.

## [0.4.1] — 2026-08-22

### Fixed

- The finding count claimed against the bundled fixtures said 40 (README,
  `COMPETITIVE-LANDSCAPE.md`, `POST-ZERO-HITS.md`) or 37 (`BRIEF.md`). The pack
  produces 42. Rules added after those documents were written moved the number
  and nothing pulled the claim along. Corrected, and now asserted by a test that
  reads the count out of `demo` and compares it against every claim in the docs.
- The README's "vs. Semgrep" navigation link had never resolved — it pointed at
  `#why-not-just-paibest-practices`; GitHub renders that heading as
  `#why-not-just-pai-best-practices`.

### Changed

- README restructured around what a first-time reader decides in five seconds:
  pitch, install-and-run, the terminal recording, then navigation. Badges cut
  from nine to four; the comparison table from ten rows to four, with the full
  version in `COMPETITIVE-LANDSCAPE.md`.
- `BRIEF.md` no longer describes the CLI as "convenience"; its roadmap now
  names the taint-mode and baseline work.

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
