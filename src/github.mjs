// GitHub Actions output: inline annotations and a job summary.
//
// Inside a GitHub Actions job, findings are also written as workflow commands
// (`::error file=…,line=…::…`), which GitHub shows on the pull request's
// changed lines, and as a markdown summary on the job page. No token, no API
// call, no code scanning setup: both are plain output the runner picks up.

import { appendFileSync } from "node:fs";

// https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
const escData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

const LEVEL = { ERROR: "error", WARNING: "warning", INFO: "notice" };

export function inGitHubActions() {
  return process.env.GITHUB_ACTIONS === "true";
}

/**
 * @param groups    groupFindings() output: [{ lesson, hits, severity }]
 * @param opts.docs (ruleId) => docs URL
 */
export function writeAnnotations(groups, { docs, write = (s) => process.stdout.write(s) } = {}) {
  for (const g of groups) {
    for (const f of g.hits) {
      const level = LEVEL[f.severity] || "notice";
      const props = [
        `file=${escProp(f.path)}`,
        `line=${f.startLine}`,
        f.endLine && f.endLine !== f.startLine ? `endLine=${f.endLine}` : null,
        `title=${escProp(`llm-audit: ${g.lesson.title}`)}`,
      ].filter(Boolean);
      const message = `${g.lesson.summary || ""} (${f.ruleId})${docs ? `\n${docs(f.ruleId)}` : ""}`;
      write(`::${level} ${props.join(",")}::${escData(message.trim())}\n`);
    }
  }
}

const mdEsc = (s) => String(s).replace(/[|\\`*_[\]<>]/g, (c) => `\\${c}`);

/** Append a markdown summary to $GITHUB_STEP_SUMMARY, if the runner set one. */
export function writeStepSummary(groups, { total, suppressed = 0, baseline = null, learnUrl, version } = {}) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const out = [];
  out.push(`## llm-audit`);
  out.push("");
  if (!groups.length) {
    out.push(`No mistakes found.${baseline ? ` (Compared with \`${mdEsc(baseline.ref)}\`: ${plural(baseline.hidden, "existing finding")} left out.)` : ""}`);
  } else {
    out.push(`**${plural(groups.length, "mistake")} in ${plural(total, "place")}**`);
    out.push("");
    out.push("| # | Mistake | Severity | Places |");
    out.push("|---|---|---|---|");
    groups.forEach((g, i) => {
      out.push(`| ${i + 1} | ${mdEsc(g.lesson.title)} | ${g.severity.toLowerCase()} | ${g.hits.length} |`);
    });
    out.push("");
    groups.forEach((g, i) => {
      out.push(`<details><summary>${i + 1}. ${mdEsc(g.lesson.title)}</summary>`);
      out.push("");
      for (const f of g.hits) out.push(`- \`${mdEsc(f.path)}\` line ${f.startLine}`);
      out.push("");
      out.push("</details>");
    });
    out.push("");
    if (baseline) out.push(`Only findings new since \`${mdEsc(baseline.ref)}\`; ${plural(baseline.hidden, "existing finding")} left out.`);
  }
  if (suppressed) out.push(`${plural(suppressed, "finding")} suppressed by \`llm-audit-ignore\` comments with a reason.`);
  out.push("");
  out.push(
    `Run \`npx llm-audit scan\` locally, then \`npx llm-audit learn\` for the lessons` +
      (learnUrl ? ` ([what each mistake means](${learnUrl}))` : "") +
      `.${version ? ` llm-audit ${version}.` : ""}`
  );
  try {
    appendFileSync(file, out.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}
