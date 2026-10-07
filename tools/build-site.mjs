#!/usr/bin/env node
// Build the llm-audit website into site/ (or the directory given):
//
//   /           the product page, from web/index.html and web/site.css
//   /learn/     the lessons page, the same file `llm-audit learn` opens
//   /lessons/   one static, crawlable page per lesson, plus an index
//   /fonts/     the subset fonts both pages use
//   /images/    README screenshots and the terminal recording
//
// Content that describes the tool (version, rule count, lessons) is read from
// the package itself, so the site cannot drift from what ships. The Pages
// workflow runs this; nothing in site/ is committed.
//
//   node tools/build-site.mjs [outDir]

import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLearnPage, FAVICON } from "../src/learn.mjs";
import { LESSONS } from "../src/lessons.mjs";
import { readRuleMeta } from "../src/rule-docs.mjs";
import { renderLessonPage, renderLessonsIndex, severityOf } from "./site-lessons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] || join(root, "site"));
const DOMAIN = process.env.SITE_DOMAIN || "llm-audit.luislozoya.com";
const ORIGIN = `https://${DOMAIN}`;
const REPO = "https://github.com/Javierlozo/llm-audit";
const NPM = "https://www.npmjs.com/package/llm-audit";
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const meta = readRuleMeta(join(root, "rules"));

// The four ways these mistakes go wrong, as the CLI's `rules` and the
// README group them. Every lesson must appear exactly once.
const GROUPS = [
  ["Someone else gives your model orders", ["user-text-in-system-prompt", "retrieved-text-as-instructions", "unchecked-request-body"]],
  ["The model's output is trusted", ["text-run-as-code", "unchecked-model-json", "unescaped-html"]],
  ["Secrets leak", ["hardcoded-api-key", "secret-in-prompt", "prompt-in-browser-bundle"]],
  ["Too much power, or too much cost", ["tool-call-without-allowlist", "stream-without-abort"]],
];
const grouped = GROUPS.flatMap(([, slugs]) => slugs);
for (const l of LESSONS) {
  if (grouped.filter((s) => s === l.slug).length !== 1) {
    throw new Error(`lesson ${l.slug} must be in exactly one site group (tools/build-site.mjs)`);
  }
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// `prefix` leads from the page to /lessons/: "lessons/" from the home page,
// "" from the lessons index.
const groupsHtml = (prefix) => `<div class="groups">${GROUPS.map(
  ([title, slugs]) => `
    <div class="group"><h3>${esc(title)}</h3><ul>${slugs
      .map((slug) => {
        const l = LESSONS.find((x) => x.slug === slug);
        const sev = severityOf(l, meta).toLowerCase();
        return `<li><a href="${prefix}${esc(slug)}/"><b>${esc(l.title)}<span class="sev ${sev}">${sev}</span></b><span>${esc(l.summary)}</span></a></li>`;
      })
      .join("")}</ul></div>`
).join("")}
    </div>`;

const sha = (t) => `'sha256-${createHash("sha256").update(t, "utf8").digest("base64")}'`;
const css = readFileSync(join(root, "web", "site.css"), "utf8");
// Old share links point at the Pages root (github.io/llm-audit/#r=…), which
// GitHub redirects here. Send any link carrying a scan on to the lessons.
// Links are relative so the site also works from the github.io project path.
const js = `(() => {
  if (/(^#|&)r=/.test(location.hash)) location.replace("learn/" + location.hash);
  for (const b of document.querySelectorAll("[data-copy]")) {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = "Copied";
        b.classList.add("done");
        setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1500);
      } catch {}
    });
  }
})();`;
const csp = [
  "default-src 'none'",
  `script-src ${sha(js)}`,
  `style-src ${sha(css)}`,
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const ruleCount = Object.keys(meta).length;
const home = readFileSync(join(root, "web", "index.html"), "utf8")
  .replace("@@CSP@@", csp)
  .replace("@@CSS@@", css)
  .replace("@@JS@@", js)
  .replace("@@GROUPS@@", groupsHtml("lessons/"))
  .replace("@@FAVICON@@", FAVICON)
  .replaceAll("@@ORIGIN@@", ORIGIN)
  .replaceAll("@@REPO@@", REPO)
  .replaceAll("@@NPM@@", NPM)
  .replaceAll("@@VERSION@@", esc(version))
  .replaceAll("@@RULES@@", String(ruleCount))
  .replaceAll("@@LESSONS@@", String(LESSONS.length));
if (/@@[A-Z]+@@/.test(home)) throw new Error(`unfilled placeholder in web/index.html: ${home.match(/@@[A-Z]+@@/)[0]}`);

rmSync(out, { recursive: true, force: true });
for (const d of ["learn", "fonts", "images"]) mkdirSync(join(out, d), { recursive: true });
writeFileSync(join(out, "index.html"), home);
writeFileSync(join(out, "learn", "index.html"), renderLearnPage({ version, base: `${ORIGIN}/learn/` }));

// Lesson pages sit deeper, so their stylesheet reaches the fonts with ../
// and needs its own hash in the CSP.
const fill = (html, up) => {
  const pageCss = css.replaceAll("url(fonts/", `url(${up}fonts/`);
  const pageCsp = csp.replace(sha(css), sha(pageCss));
  return html.replace("@@CSP@@", pageCsp).replace("@@CSS@@", pageCss).replace("@@JS@@", js);
};
const ctx = { origin: ORIGIN, repo: REPO, npm: NPM, favicon: FAVICON, meta };
mkdirSync(join(out, "lessons"), { recursive: true });
writeFileSync(join(out, "lessons", "index.html"), fill(renderLessonsIndex(groupsHtml(""), ctx), "../"));
for (const l of LESSONS) {
  mkdirSync(join(out, "lessons", l.slug), { recursive: true });
  writeFileSync(join(out, "lessons", l.slug, "index.html"), fill(renderLessonPage(l, ctx), "../../"));
}
for (const f of ["literata.woff2", "archivo.woff2"]) {
  copyFileSync(join(root, "src", "learn", "fonts", f), join(out, "fonts", f));
}
for (const f of ["learn-light.png", "learn-dark.png", "learn-fix.png", "learn-fix-dark.png", "social-preview.png"]) {
  copyFileSync(join(root, "docs", "images", f), join(out, "images", f));
}
// The README links these by absolute URL, so they also render where relative
// paths do not resolve, like the GitHub Marketplace listing.
for (const f of ["scan-demo.svg", "banner.svg", "commands.svg"]) {
  copyFileSync(join(root, "assets", f), join(out, "images", f));
}
writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
writeFileSync(
  join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [`${ORIGIN}/`, `${ORIGIN}/lessons/`, ...LESSONS.map((l) => `${ORIGIN}/lessons/${l.slug}/`), `${ORIGIN}/learn/`]
      .map((u) => `  <url><loc>${u}</loc></url>\n`)
      .join("") +
    `</urlset>\n`
);
console.log(`wrote ${out} for ${ORIGIN}`);
