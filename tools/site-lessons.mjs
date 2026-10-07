// One static page per lesson, plus an index, for the website.
//
// The learn page is an app: it reads a scan from the address after the #, and
// search engines never see past the #. These pages carry the same lesson text
// as plain HTML at /lessons/<slug>/, so someone searching for "prompt
// injection in a Next.js route handler" can land on the lesson, and the home
// page has real links to follow. The text comes from src/lessons.mjs, the
// same data the CLI and the learn page use, so the three cannot drift.

import { LESSONS, fixPrompt } from "../src/lessons.mjs";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
export const severityOf = (lesson, meta) =>
  lesson.rules.map((r) => meta[r]?.severity || "INFO").sort((a, b) => rank[a] - rank[b])[0];

function copyBlock(text, label) {
  return `<div class="prompt"><pre><code>${esc(text)}</code></pre>` +
    `<button class="btn" type="button" data-copy="${esc(text)}" aria-label="${esc(label)}">Copy</button></div>`;
}

// `up` is the path back to the site root ("../../" from a lesson), so the
// pages also work from a project path like github.io/llm-audit/.
function shell({ up, title, description, canonical, body, head }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="@@CSP@@"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<link rel="canonical" href="${esc(canonical)}"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(canonical)}"/>
<meta property="og:type" content="article"/>
<meta property="og:image" content="${head.origin}/images/social-preview.png"/>
<meta name="twitter:card" content="summary_large_image"/>
<link rel="icon" href="${head.favicon}"/>
<style>@@CSS@@</style>
</head>
<body>
<div class="page">

<nav class="nav" aria-label="Site">
  <span class="brand"><a class="word" href="${up}">llm-audit</a><a class="by" href="https://www.luislozoya.com">by Luis Javier Lozoya</a></span>
  <span class="nav-links">
    <a href="${up}#catches">Rules</a>
    <a href="${up}lessons/">Lessons</a>
    <a href="${head.repo}">GitHub</a>
    <a href="${head.npm}">npm</a>
  </span>
</nav>
${body}
<footer class="foot">
  <p>llm-audit is MIT licensed and built by <a href="https://www.luislozoya.com">Luis Javier Lozoya</a>.</p>
  <p><a href="${head.repo}">GitHub</a><a href="${head.npm}">npm</a><a href="${head.repo}/blob/main/docs/RULES.md">Rule reference</a><a href="${up}lessons/">All lessons</a></p>
</footer>

</div>
<script>@@JS@@</script>
</body>
</html>
`;
}

export function renderLessonPage(lesson, { origin, repo, npm, favicon, meta }) {
  const sev = severityOf(lesson, meta).toLowerCase();
  const i = LESSONS.indexOf(lesson);
  const next = LESSONS[(i + 1) % LESSONS.length];
  const ruleLinks = lesson.rules
    .map((r) => `<a href="${repo}/blob/main/docs/RULES.md#${esc(r)}"><code>${esc(r)}</code></a>`)
    .join(" ");
  const x = lesson.exploit;

  const body = `
<header class="lesson-head">
  <p class="eyebrow"><a href="../">Lessons</a> · ${esc(lesson.owasp)} · <span class="sev ${sev}">${sev}</span></p>
  <h1>${esc(lesson.title)}</h1>
  <p class="standfirst">${esc(lesson.summary)}</p>
  <p class="small muted">Caught by ${ruleLinks}${lesson.cwe.length ? ` · ${lesson.cwe.map(esc).join(", ")}` : ""}</p>
</header>

<section class="part">
  <h2>What is wrong</h2>
  <div class="part-body prose">${lesson.explanation.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
</section>

<section class="part">
  <h2>How it is used against you</h2>
  <div class="part-body prose">
    <p>${esc(x.setup)}</p>
    <pre class="code"><code>${esc(x.vulnerableExample)}</code></pre>
    <ol class="attack">${x.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    <p><b>The cost:</b> ${esc(x.impact)}</p>
  </div>
</section>

<section class="part">
  <h2>How to spot it</h2>
  <div class="part-body"><ul class="points">${lesson.spotIt.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
</section>

<section class="part">
  <h2>The fix</h2>
  <div class="part-body prose">
    <p>Paste this into Claude Code, Cursor, or whatever wrote the code. When llm-audit finds the mistake in your project, <code>npx llm-audit prompt</code> gives you the same prompt with every file and line filled in.</p>
    ${copyBlock(fixPrompt(lesson), "Copy the fix prompt")}
  </div>
</section>

<section class="part">
  <h2>Check the rest</h2>
  <div class="part-body prose">
    <p>A prompt that looks for the same mistake everywhere else, without changing anything yet.</p>
    ${copyBlock(lesson.askPrompt, "Copy the check prompt")}
  </div>
</section>

<section class="part">
  <h2>Find it in your code</h2>
  <div class="part-body">
    <div class="install">
      <code>npx llm-audit scan</code>
      <button class="btn" type="button" data-copy="npx llm-audit scan">Copy</button>
    </div>
    <p class="small muted">Runs on your machine with Semgrep. Nothing is uploaded.</p>
    <p class="hero-links"><a href="../${esc(next.slug)}/">Next: ${esc(next.title)}</a></p>
  </div>
</section>
`;
  return shell({
    up: "../../",
    title: `${lesson.title} · ${lesson.owasp.split(":")[0]} · llm-audit`,
    description: `${lesson.summary} How the attack works, how to spot it in TypeScript and JavaScript LLM code, and a prompt to fix it.`,
    canonical: `${origin}/lessons/${lesson.slug}/`,
    body,
    head: { origin, repo, npm, favicon },
  });
}

export function renderLessonsIndex(groups, { origin, repo, npm, favicon, meta }) {
  const body = `
<header class="lesson-head">
  <p class="eyebrow">${LESSONS.length} lessons · OWASP LLM Top 10</p>
  <h1>The security mistakes AI writes into LLM apps.</h1>
  <p class="standfirst">One lesson per mistake: what is wrong, how someone would use it against you, how to spot it, and a prompt to fix it.</p>
</header>
<section class="part">
  <h2>Lessons</h2>
  <div class="part-body">${groups}</div>
</section>
`;
  return shell({
    up: "../",
    title: "Lessons: LLM app security mistakes, explained · llm-audit",
    description:
      "Prompt injection, trusted model output, leaked secrets, and runaway tools in TypeScript and JavaScript LLM apps. Each lesson walks through the attack and gives a prompt to fix it.",
    canonical: `${origin}/lessons/`,
    body,
    head: { origin, repo, npm, favicon },
  });
}
