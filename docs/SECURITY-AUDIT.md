# `llm-audit` — Self-Audit

> A static-analysis tool for OWASP LLM Top 10 should not itself be sloppy
> about its own threat surface. This document is the self-review of the
> `llm-audit` codebase: what was found, what was fixed, what was deemed
> acceptable, and the reasoning. Conducted at version `0.0.1`, fixes
> shipped in `0.0.2`.

## Threat surface

`llm-audit` is a small npm package with a CLI that:

1. Reads YAML rule files bundled in the package.
2. Spawns the `semgrep` binary as a peer dependency.
3. Writes two template files into the user's repo on `init` (a husky
   pre-commit hook and a GitHub Action workflow).

There is no network I/O at runtime, no `postinstall` script, no remote
configuration, no telemetry. The risk surface is therefore narrow:

- **Argument-handling in the CLI**: how user-supplied paths flow into
  the spawned `semgrep` invocation.
- **Filesystem writes during `init`**: what gets overwritten and
  whether files can be written outside the user's repo.
- **The bundled templates themselves**: shell quoting in the husky hook,
  pinning of GitHub Actions, default permissions in the workflow.
- **Trust in `PATH`**: `semgrep` is invoked by name, so the tool trusts
  the user's `PATH`. This is the standard developer-tool assumption and
  not addressed here.
- **Supply chain**: dependencies, install scripts, files manifest.

## Findings

### 1. `cmdInit` overwrote existing files silently

**Severity:** Medium
**Location:** `src/cli.mjs` `cmdInit`
**Status:** Fixed in `0.0.2`

Original behavior: `npx llm-audit init` ran `copyFileSync` against
`.husky/pre-commit` and `.github/workflows/llm-audit.yml` unconditionally.
A user who already had a custom `.husky/pre-commit` (e.g., from
`lint-staged`, `commitlint`, or another pre-commit hook) would lose it
without warning.

**Fix:** Both writes now check `existsSync` first and refuse to proceed
unless `--force` is passed. Error output points to the `--force` flag
and explains the recovery path.

### 2. Missing `--` separator before user-controlled paths in `spawnSync`

**Severity:** Low
**Location:** `src/cli.mjs` `cmdScan`
**Status:** Fixed in `0.0.2`

`spawnSync("semgrep", [..., ...paths])` interpolated user paths
positionally. A path beginning with `-` would be parsed by `semgrep` as
a flag rather than a target, which in turn could let a wrapper script
or a piped-in filename inject arbitrary `semgrep` flags.

The exploit shape would be: a downstream script that produces filenames
from an attacker-influenced source (e.g., a CI step that lists
attacker-controlled directory entries) pipes those into `llm-audit
scan`. An entry like `--config=/path/to/malicious.yaml` would replace
our rule pack with the attacker's rules at scan time.

**Fix:** Inserted `"--"` between `llm-audit`'s own flags and the
user-supplied paths. After `--`, every subsequent arg is treated as a
target by `semgrep`.

### 3. Pre-commit hook used unquoted variable expansion

**Severity:** Low to Medium
**Location:** `templates/husky-pre-commit`
**Status:** Fixed in `0.0.2`

The original hook collected staged filenames into `$staged` and called
`npx --no-install llm-audit scan $staged`, with a `# shellcheck disable=SC2086`
to acknowledge the unquoted expansion. The intent was word-splitting
filenames into separate arguments, but the shell also performs glob
expansion at that step.

A staged filename like `*.ts` (which is legal in Unix filesystems)
would expand to every matching file in the working directory,
silently changing the scan target. Filenames with spaces would split
into multiple arguments.

**Fix:** Switched to a null-delimited pipeline:

```sh
git diff --cached --name-only --diff-filter=ACMR -z |
  grep -zE '\.(js|jsx|ts|tsx|mjs|cjs)$' |
  xargs -0 -r npx --no-install llm-audit scan --
```

NUL bytes cannot appear in filenames, so the pipeline is closed against
filename-injection edge cases. The `--` at the end pairs with finding
#2 to lock semgrep flag interpretation.

### 4. GitHub Action template used major-version tags instead of SHA pins

**Severity:** Low
**Location:** `templates/github-action.yml`
**Status:** Fixed in `0.0.2`

The template used `actions/checkout@v6` and `actions/setup-node@v6`.
Major-version tags resolve at workflow run time and depend on the
maintainer's tagging hygiene. If the action's repository or tag pointer
is compromised, a malicious revision can land in user CI without any
visible change to the workflow file.

GitHub's own
[security hardening guide](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)
recommends pinning to a full commit SHA for security-sensitive
workflows. A security tool's own template should set this example.

**Fix:** Pinned both actions to commit SHAs with the human-readable
version as a comment. Added an explicit `permissions: contents: read`
block to override GitHub's default workflow token scope, which is
broader than this workflow needs.

### 5. `JSON.parse` on subprocess output without shape validation

**Severity:** Informational
**Location:** `test/run-fixtures.mjs`
**Status:** Fixed in `0.0.2`

The internal test runner parsed `semgrep --json` output with bare
`JSON.parse`, which is the same shape that `llm-audit`'s own
`model-output-parsed-without-schema` rule (LLM02) flags in user code.
The source here is trusted (semgrep's documented JSON schema, not LLM
output), so this is informational rather than a real vulnerability.
But a security tool whose internal code triggers its own rules
optically undermines the rule pack.

**Fix:** Added a minimal shape check (`Array.isArray(parsed.results)`)
after parse. Logs a clear error and skips the file if the shape is
unexpected.

### 6. README install instructions did not warn about `init` overwrite

**Severity:** Informational
**Location:** `README.md`
**Status:** Fixed in `0.0.2`

The "Use" section showed `npx llm-audit init` without noting that the
command modifies the user's `.husky/` and `.github/workflows/`. With
finding #1 fixed, the warning is no longer load-bearing for safety,
but documenting the behavior is still a courtesy to adopters.

**Fix:** Added a one-paragraph callout under the install command in
the README and a link to this audit.

## Findings considered and not fixed

### Trust in `PATH` for the `semgrep` binary

`spawnSync("semgrep", ...)` resolves through the user's `PATH`. A user
with a malicious binary earlier on their `PATH` would have that binary
run instead of the real semgrep. This is the standard
developer-tool trust model. Fixing it would mean shipping a vendored
semgrep or requiring an absolute path, which trades developer
ergonomics for marginal protection against an attacker who already
controls the user's `PATH`. Not addressed.

### No timeout on `spawnSync` invocations

A pathological semgrep run could hang indefinitely. In CI this would
eventually be killed by the runner's job timeout, and locally the user
can `Ctrl-C`. Adding an explicit timeout adds complexity without a
clear win. Reconsider if real-world reports of CI hangs surface.

### `console.log` exposes absolute filesystem paths in `--help`

The `--help` output prints `RULES_DIR` and the docs path, which
leak the location of the package on disk. This is benign locally and
the user already controls their filesystem. Not changed.

## What the project does right

- **Zero direct dependencies.** `package.json` lists only an optional
  peer dependency on `semgrep`. There is no transitive npm dependency
  tree to compromise.
- **No `postinstall` / `preinstall` / `prepare` scripts.** Installing
  the package does not execute any of the package's code.
- **`spawnSync` with array arguments.** All subprocess invocations use
  the array form, never the shell form. There is no shell
  interpolation in any subprocess invocation made by the CLI.
- **Restrictive `files` manifest.** The published tarball includes
  only `src/`, `rules/`, `templates/`, `README.md`, and `LICENSE`.
  Test fixtures, docs, `.git`, and node_modules are excluded.
- **No HTTP I/O at runtime.** The CLI does not fetch anything. No
  SSRF, no exfiltration vector, no remote-config trust assumption.
- **2FA + WebAuthn passkey on npm publishing.** Account-takeover via
  password leak is closed; publishing requires a hardware-bound
  passkey approval per release.
- **Short, MIT-licensed surface.** The CLI is one ~120-line file. The
  templates are two short files. A determined reviewer can read the
  entire codebase in fifteen minutes.

## Reproducing this audit

```sh
git clone https://github.com/Javierlozo/llm-audit
cd llm-audit
npm test                              # rule pack still passes its fixtures

# CLI behavior
node src/cli.mjs --help
node src/cli.mjs rules
node src/cli.mjs scan ../some-target

# Init behavior
mkdir -p /tmp/llm-audit-init && cd /tmp/llm-audit-init && git init -q
node /path/to/llm-audit/src/cli.mjs init
node /path/to/llm-audit/src/cli.mjs init    # should refuse
node /path/to/llm-audit/src/cli.mjs init --force  # should overwrite
```

If a finding looks wrong or a new one surfaces, open an issue at
[github.com/Javierlozo/llm-audit/issues](https://github.com/Javierlozo/llm-audit/issues).
