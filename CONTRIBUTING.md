# Contributing

The rule pack is the product. The most useful thing you can contribute is a
new rule, or a fix to one that misfires.

## The shape of a rule contribution

Every rule ships as four things. A PR missing any of them will be asked for the
rest before review.

1. **`rules/<rule-id>.yaml`**, one rule per file, filename matching the rule
   ID. `languages` must include `typescript` and `javascript`.
2. **`test/fixtures/<rule-id>/vulnerable.ts`**, code the rule must flag, with a
   comment on each match explaining why it's dangerous.
3. **`test/fixtures/<rule-id>/safe.ts`**, the corrected version of the same
   code. The rule must produce **zero** findings here. This file is what keeps
   the pack usable; a rule without a safe fixture is a rule nobody can trust.
4. **A row in [`docs/RULES.md`](docs/RULES.md)** with the OWASP LLM Top 10
   mapping and the canonical fix.

Then:

```sh
npm test    # every rule fires on vulnerable/, stays silent on safe/
```

Green suite, or it doesn't merge.

## What makes a good rule here

`llm-audit` runs in a pre-commit hook. A noisy rule gets the whole tool
uninstalled, so the bar is deliberately conservative:

- **Map it to an OWASP LLM Top 10 entry.** If it doesn't map, it probably
  belongs in a general-purpose SAST pack instead.
- **Prefer false negatives to false positives.** Missing a variant is
  recoverable. Flagging correct code trains people to ignore the output.
- **Target TypeScript and JavaScript.** Python LLM code is already covered by
  Semgrep's `p/ai-best-practices`; see
  [`docs/COMPETITIVE-LANDSCAPE.md`](docs/COMPETITIVE-LANDSCAPE.md).
- **Match real shapes.** Rules are written against patterns that actually
  appear in Vercel AI SDK, OpenAI / Anthropic JS SDK, and Next.js route handler
  code, not hypotheticals.
- **Write a `message` that fixes the bug.** State the risk, then the concrete
  remediation. It's read by humans in a terminal and by agents through
  `--json`, and it's often the only documentation anyone sees.

The reasoning behind the existing rules is in
[`docs/AI-FAILURE-MODES.md`](docs/AI-FAILURE-MODES.md). Read it before
proposing a new one, it explains why each pattern keeps getting generated.

## Reporting a false positive

Open an issue with the smallest snippet that misfires, the rule ID, and the
`llm-audit --version` / `semgrep --version` output. False positives are treated
as bugs, not as tuning requests.

## False negatives

Also an issue, not a security report, see [`SECURITY.md`](SECURITY.md). A
snippet the rule *should* have caught is ideal, since it becomes a fixture.

## Changing the JSON envelope

`scan --json` is a stable contract (`schemaVersion: 1`) that agents and
dashboards consume. Additive fields are fine. Renaming or removing a field
requires bumping `schemaVersion` and a note in
[`CHANGELOG.md`](CHANGELOG.md).

## Commits and PRs

- Conventional-ish subjects (`feat:`, `fix:`, `docs:`, `ci:`) or a version
  subject for releases. Explain *why* in the body; the existing history is the
  style guide.
- One rule per PR. It keeps the fixture diff reviewable.
- CI must be green: `tests` (fixture suite on Node 18 and 22) and `self-scan`
  (llm-audit against its own `src/`).

## Local setup

```sh
brew install semgrep        # or: pipx install semgrep
git clone https://github.com/Javierlozo/llm-audit.git
cd llm-audit
npm test
node src/cli.mjs demo       # see the whole pack fire against the fixtures
```

No build step and no runtime dependencies. Semgrep is an optional peer
dependency, installed separately.

## License

Contributions are accepted under the [MIT License](LICENSE).
