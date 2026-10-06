// Ignore comments that have to say why.
//
//   // llm-audit-ignore hardcoded-llm-api-key -- test fixture, key is fake
//   const client = new OpenAI({ apiKey: "sk-..." });
//
// The comment goes on the flagged line or the line above it, names the rule
// (or several, comma-separated), and gives a reason after `--`. A comment
// without a reason or with an unknown rule is not applied: the finding stays,
// and the scan says what is wrong with the comment. For a security tool, a
// silent dismissal is worse than none, so suppressed findings are counted in
// the output and listed in --json.
//
// Semgrep's own `// nosemgrep` still works, without a reason, because the
// engine applies it before we ever see the finding.

import { readFileSync } from "node:fs";

const COMMENT = /llm-audit-ignore\s+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*(?:--\s*(.*?))?\s*(?:\*\/|-->)?\s*$/;

/**
 * Split findings into kept and suppressed.
 * Returns { findings, suppressed: [{ ruleId, path, startLine, reason }],
 *           problems: [{ path, line, message }] }.
 */
export function applySuppressions(findings, knownRules) {
  const files = new Map();
  const linesOf = (path) => {
    if (!files.has(path)) {
      try {
        files.set(path, readFileSync(path, "utf8").split("\n"));
      } catch {
        files.set(path, []);
      }
    }
    return files.get(path);
  };

  const kept = [];
  const suppressed = [];
  const problems = new Map(); // one report per comment, however many findings it touches

  for (const f of findings) {
    const lines = linesOf(f.path);
    let applied = false;
    // The flagged line itself, then the line above it.
    for (const n of [f.startLine, f.startLine - 1]) {
      const m = (lines[n - 1] || "").match(COMMENT);
      if (!m) continue;
      const rules = m[1].split(",").map((r) => r.trim());
      const reason = (m[2] || "").trim();
      const where = `${f.path}:${n}`;
      const unknown = rules.filter((r) => !knownRules.includes(r));
      if (unknown.length) {
        problems.set(where, { path: f.path, line: n, message: `names unknown rule ${unknown.map((r) => `"${r}"`).join(", ")}, so it was not applied.` });
        continue;
      }
      if (!rules.includes(f.ruleId)) continue;
      if (!reason) {
        problems.set(where, { path: f.path, line: n, message: "has no reason, so it was not applied. Add one after --, like: -- test fixture, key is fake" });
        continue;
      }
      suppressed.push({ ruleId: f.ruleId, path: f.path, startLine: f.startLine, reason });
      applied = true;
      break;
    }
    if (!applied) kept.push(f);
  }
  return { findings: kept, suppressed, problems: [...problems.values()] };
}
