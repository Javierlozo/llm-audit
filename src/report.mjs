// Standalone HTML report — the long-form surface.
//
// The terminal is for triage: what broke, where, how bad. The report is for
// understanding and for sharing — it carries the full teaching material for
// every rule that fired, groups occurrences under the rule that explains
// them, and is a single self-contained file, so it works as a CI artifact, an
// email attachment, or something a reviewer opens from disk with no server.

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Docs prose uses `backticks` for code. Render those as real code spans, and
// escape everything else — the text is ours, but it is still text.
function prose(text) {
  if (!text) return "";
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const SEV_RANK = { ERROR: 0, WARNING: 1, INFO: 2 };
const rank = (s) => SEV_RANK[s] ?? SEV_RANK.INFO;

const STYLE = `
:root{
  --bg:#f7f8fa; --panel:#ffffff; --ink:#12161c; --muted:#5b6675; --line:#e2e6ec;
  --error:#c0392b; --warning:#8a6100; --info:#1f5fa8; --code:#f2f4f7; --accent:#1f6feb;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1116; --panel:#12161c; --ink:#e8edf4; --muted:#8b98a9; --line:#242b35;
    --error:#f2777a; --warning:#f0b429; --info:#6aa9ff; --code:#171c24; --accent:#6aa9ff;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:40px 24px 80px}
header{border-bottom:1px solid var(--line);padding-bottom:24px;margin-bottom:32px}
h1{font-size:24px;margin:0 0 6px;letter-spacing:-0.01em}
h2{font-size:18px;margin:40px 0 12px;letter-spacing:-0.01em}
h3{font-size:15px;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sub{color:var(--muted);font-size:13px;margin:0}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0 8px}
.card{flex:1 1 140px;background:var(--panel);border:1px solid var(--line);
  border-radius:10px;padding:14px 16px}
.card .n{font-size:26px;font-weight:600;line-height:1.1}
.card .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.rule{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:20px 22px;margin:16px 0}
.rule-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-bottom:14px}
.badge{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  border:1px solid currentColor;border-radius:999px;padding:2px 9px}
.error{color:var(--error)} .warning{color:var(--warning)} .info{color:var(--info)}
.count{color:var(--muted);font-size:13px;margin-left:auto}
dl{margin:0}
dt{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
  margin-top:14px}
dd{margin:4px 0 0}
code{background:var(--code);border-radius:4px;padding:1px 5px;
  font:13px/1.5 ui-mono,ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;
  padding:12px 14px;overflow-x:auto;margin:8px 0 0}
pre code{background:none;padding:0;font-size:12.5px;white-space:pre}
.hit{border-top:1px solid var(--line);margin-top:16px;padding-top:14px}
.gutter{color:var(--muted);user-select:none}
a{color:var(--accent)}
ul.files{list-style:none;padding:0;margin:8px 0 0;
  font:13px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace}
ul.files .n{color:var(--muted)}
footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);
  color:var(--muted);font-size:13px}
.card.zero .n{color:var(--muted);opacity:.55}
.card.zero .l{opacity:.7}
.summary{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:18px 20px;margin:24px 0 0}
.summary h2{margin:0 0 10px;font-size:15px}
.summary ol{margin:0;padding-left:20px}
.summary li{margin:6px 0}
.summary .why{color:var(--muted)}
.nav{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0;font-size:12.5px}
.nav a{display:inline-block;border:1px solid var(--line);border-radius:999px;
  padding:3px 11px;text-decoration:none;color:var(--muted)}
.hit-loc{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
  font-weight:600}
.hit-loc .ln{color:var(--muted);font-weight:400}
.ctx{color:var(--muted);opacity:.75}
.match{color:var(--ink)}
.note{background:var(--code);border:1px solid var(--line);border-left:3px solid var(--warning);
  border-radius:8px;padding:12px 14px;margin:24px 0 0;font-size:13.5px}
.clean{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:28px;text-align:center}
@media print{
  body{background:#fff}
  .rule,.card,.clean{break-inside:avoid;border-color:#ccc}
  a{color:inherit;text-decoration:none}
}
`;

// What code does this describe? A report without an answer is a screenshot.
function provenanceLine(repo) {
  if (!repo) {
    return `<p class="sub">Not a git checkout — this report cannot name the ` +
      `revision it describes.</p>`;
  }
  const dirty = repo.dirty
    ? ` <b>· uncommitted changes present</b>, so this describes a working tree, ` +
      `not a commit`
    : "";
  return (
    `<p class="sub">${esc(repo.branch || "detached")} @ ` +
    `<code>${esc(repo.shortCommit || "")}</code>${dirty}</p>`
  );
}

// One ordered list of what to do, worst-and-largest first. A reader who does
// only the first item should have removed the most risk available per unit of
// work; a reader who reads nothing else should still know where to start.
function executiveSummary(findings, anchorFor) {
  const groups = new Map();
  for (const f of findings) {
    const g = groups.get(f.ruleId) || { ruleId: f.ruleId, severity: f.severity, n: 0, files: new Set() };
    g.n++;
    g.files.add(f.path);
    if (rank(f.severity) < rank(g.severity)) g.severity = f.severity;
    groups.set(f.ruleId, g);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.n - a.n || a.ruleId.localeCompare(b.ruleId))
    .slice(0, 3);

  return `<div class="summary">
  <h2>What to fix first</h2>
  <ol>
${ordered
  .map(
    (g) =>
      `    <li><a href="#${esc(anchorFor(g.ruleId))}"><code>${esc(g.ruleId)}</code></a>` +
      ` <span class="why">— ${g.n} ${esc(g.severity.toLowerCase())}` +
      `${g.n === 1 ? "" : "s"} across ${g.files.size} file${g.files.size === 1 ? "" : "s"}</span></li>`
  )
  .join("\n")}
  </ol>
</div>`;
}

function severityCards(counts, total, fileCount) {
  const cells = [
    { n: total, l: total === 1 ? "finding" : "findings", cls: "" },
    { n: counts.ERROR || 0, l: "error", cls: "error" },
    { n: counts.WARNING || 0, l: "warning", cls: "warning" },
    { n: counts.INFO || 0, l: "info", cls: "info" },
    { n: fileCount, l: fileCount === 1 ? "file" : "files", cls: "" },
  ];
  return `<div class="cards">${cells
    .map(
      (c) =>
        `<div class="card${c.n === 0 ? " zero" : ""}"><div class="n ${c.cls}">${c.n}</div>` +
        `<div class="l">${esc(c.l)}</div></div>`
    )
    .join("")}</div>`;
}

function codeBlock(code) {
  return `<pre><code>${esc(code)}</code></pre>`;
}

function snippet(finding) {
  if (!finding.lines) return "";
  const lines = finding.lines.replace(/\n+$/, "").split("\n");
  const body = lines
    .map((line, i) => {
      const n = String((finding.startLine ?? 1) + i).padStart(4);
      return `<span class="gutter">${n} │ </span>${esc(line)}`;
    })
    .join("\n");
  return `<pre><code>${body}</code></pre>`;
}

/**
 * Render a full HTML report for one scan.
 *
 * @param {object} envelope   the same JSON envelope `scan --json` emits
 * @param {object} opts       { docs, ruleMeta, ruleCount, generatedAt, displayPath }
 */
export function renderHtmlReport(envelope, opts = {}) {
  const {
    docs = {},
    ruleMeta = {},
    ruleCount = 0,
    generatedAt = new Date().toISOString(),
    displayPath = (p) => p,
    version = envelope?.tool?.version ?? "",
    readContext = null,
  } = opts;
  const repo = envelope?.repo || null;

  const findings = envelope.findings || [];
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const files = new Set(findings.map((f) => f.path));
  const targets = (envelope.scannedPaths || []).join(", ") || ".";
  const when = new Date(generatedAt);
  const stamp = isNaN(when) ? generatedAt : when.toISOString().replace("T", " ").slice(0, 16) + " UTC";

  // Group by rule: the rationale is per rule, so the rule is the unit that
  // teaches. Occurrences hang underneath it.
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
    byRule.get(f.ruleId).push(f);
  }
  const rules = [...byRule.entries()].sort(
    (a, b) =>
      rank(a[1][0].severity) - rank(b[1][0].severity) ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0])
  );

  const claimedFileAnchors = new Set();

  const fileIndex = [...files]
    .map((p) => ({ p, n: findings.filter((f) => f.path === p).length }))
    .sort((a, b) => b.n - a.n || a.p.localeCompare(b.p));

  // A filtered run is not a full audit. The report says so in the document
  // itself, because the report is the artifact that gets forwarded — long
  // after the terminal caveat has scrolled away.
  const filters = opts.filters || {};
  const filterNote =
    filters.rules?.length || filters.severity
      ? `<p class="note"><b>Filtered run.</b> This report covers ` +
        (filters.rules?.length
          ? `only ${filters.rules.map((r) => `<code>${esc(r)}</code>`).join(", ")}`
          : `only findings of severity <code>${esc(String(filters.severity).toLowerCase())}</code> or worse`) +
        `. Other rules may still have findings in this codebase.</p>`
      : "";

  // Stable, collision-free anchors: rule ids are already slug-shaped, file
  // paths are not, so files are addressed by index.
  const anchorFor = (ruleId) => `rule-${ruleId}`;
  const fileAnchor = new Map(fileIndex.map((f, i) => [f.p, `file-${i + 1}`]));

  const body = findings.length
    ? `
${filterNote}
${executiveSummary(findings, anchorFor)}
${severityCards(counts, findings.length, files.size)}

<h2>Files</h2>
<ul class="files">
${fileIndex
  .map(
    (f) =>
      `<li><a href="#${esc(fileAnchor.get(f.p))}">${esc(displayPath(f.p))}</a> ` +
      `<span class="n">— ${f.n} finding${f.n === 1 ? "" : "s"}</span></li>`
  )
  .join("\n")}
</ul>

<h2>Findings by rule</h2>
<nav class="nav" aria-label="Jump to a rule">
${rules
  .map(
    ([ruleId, hits]) =>
      `  <a href="#${esc(anchorFor(ruleId))}">${esc(ruleId)} <b>${hits.length}</b></a>`
  )
  .join("\n")}
</nav>

${rules
  .map(([ruleId, hits]) => {
    const doc = docs[ruleId] || {};
    const meta = ruleMeta[ruleId] || {};
    const sev = (hits[0].severity || "INFO").toLowerCase();
    const example = (opts.examples || {})[ruleId];
    const owasp = hits[0].owasp || meta.owasp;
    const cwe = (hits[0].cwe && hits[0].cwe.length ? hits[0].cwe : meta.cwe) || [];
    return `<section class="rule" id="${esc(anchorFor(ruleId))}">
  <div class="rule-head">
    <span class="badge ${esc(sev)}">${esc(sev)}</span>
    <h3>${esc(ruleId)}</h3>
    ${owasp ? `<span class="badge">${esc(owasp)}</span>` : ""}
    ${cwe.map((c) => `<span class="badge">${esc(c)}</span>`).join("")}
    <span class="count">${hits.length} occurrence${hits.length === 1 ? "" : "s"}</span>
  </div>
  <dl>
    ${doc.catches ? `<dt>What it catches</dt><dd>${prose(doc.catches)}</dd>` : ""}
    ${doc.whyAi ? `<dt>Why an AI assistant writes this</dt><dd>${prose(doc.whyAi)}</dd>` : ""}
    ${doc.fix ? `<dt>How to fix it</dt><dd>${prose(doc.fix)}</dd>` : ""}
    ${
      example
        ? `<dt>The fixed shape, verified</dt><dd>This is the pack's own
           <code>${esc(example.name)}</code> fixture. Every commit asserts it
           produces zero findings, so it is a fix that is checked, not a fix
           that is asserted.${codeBlock(example.code)}</dd>`
        : ""
    }
    ${
      meta.references && meta.references.length
        ? `<dt>References</dt><dd>${meta.references
            .map((r) => `<a href="${esc(r)}">${esc(r)}</a>`)
            .join("<br/>")}</dd>`
        : ""
    }
  </dl>
${hits
  .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
  .map((f) => {
    // The first occurrence of a file inside the whole report owns that file's
    // anchor, so the Files index lands somewhere real.
    const anchor = fileAnchor.get(f.path);
    const owns = anchor && !claimedFileAnchors.has(f.path);
    if (owns) claimedFileAnchors.add(f.path);
    return `  <div class="hit"${owns ? ` id="${esc(anchor)}"` : ""}>
    <div class="hit-loc">${esc(displayPath(f.path))}<span class="ln">:${esc(f.startLine)}</span></div>
    ${snippet(f, readContext)}
  </div>`;
  })
  .join("\n")}
</section>`;
  })
  .join("\n")}
`
    : `<div class="clean"><div class="n" style="font-size:26px">No findings</div>
<p class="sub">${ruleCount} rules ran against ${esc(targets)} and matched nothing.</p></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>llm-audit report — ${esc(targets)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>llm-audit report</h1>
  <p class="sub">${esc(targets)} · ${ruleCount} rules · llm-audit ${esc(version)} · ${esc(stamp)}</p>
  ${provenanceLine(repo)}
</header>
${body}
<footer>
  Every finding above is a static match, not a proven exploit — read the rule,
  then decide. Regenerate this report with
  <code>npx llm-audit scan --html report.html ${esc(targets)}</code>.
  <br/>
  Rule reference:
  <a href="https://github.com/Javierlozo/llm-audit/blob/main/docs/RULES.md">docs/RULES.md</a>
  · <a href="https://owasp.org/www-project-top-10-for-large-language-model-applications/">OWASP Top 10 for LLM Applications</a>
</footer>
</div>
</body>
</html>
`;
}
