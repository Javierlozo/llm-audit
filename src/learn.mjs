// The learn page: one self-contained HTML file.
//
// The same file serves two ways. Hosted as a static page, it reads a scan
// from the URL fragment (see share.mjs). Written to disk by `scan --open`, it
// carries the scan inline instead. Either way it makes no network requests:
// the CSP below allows nothing but its own inline script and style, by hash,
// so a crafted link cannot make it load or send anything.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LESSONS, fixPrompt, where, groupFindings } from "./lessons.mjs";
import { readSafeExample } from "./rule-docs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

const sha256 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

// JSON inside a <script> element ends at the first `</script`, whatever the
// JSON means. Escaping every `<` keeps it data. U+2028 and U+2029 are legal in JSON and
// were not legal in JS strings before ES2019; escaping them costs nothing.
function dataBlock(id, value) {
  const text = JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/json" id="${id}">${text}</script>`;
}

function safeExamples() {
  const examples = {};
  const fixtures = join(PKG_ROOT, "test", "fixtures");
  const rulesDir = join(PKG_ROOT, "rules");
  if (!existsSync(rulesDir)) return examples;
  for (const f of readdirSync(rulesDir).filter((f) => f.endsWith(".yaml"))) {
    const id = f.replace(/\.yaml$/, "");
    const ex = readSafeExample(fixtures, id);
    if (ex) examples[id] = ex;
  }
  return examples;
}

export const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><rect width="56" height="56" rx="13" fill="#1b222c"/><g transform="translate(28 28) scale(0.9) translate(-24 -24)"><path d="M14 13.5 24.5 24 14 34.5" fill="none" stroke="#e8edf4" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="30.5" y="9" width="6" height="30" rx="3" fill="#f0b429"/></g></svg>`
  );

/**
 * @param opts.scan     a share payload (share.mjs buildPayload) to embed, or
 *                      null for the hosted page, which reads the fragment
 * @param opts.version  llm-audit version, shown in the footer
 * @param opts.base     where "Copy share link" points from a local file
 */
export function renderLearnPage({ scan = null, version = "", base = "" } = {}) {
  // Fonts ride along as data: URIs, so the page stays one file and the CSP
  // can keep refusing every network request.
  const font = (name) =>
    `data:font/woff2;base64,${readFileSync(join(HERE, "learn", "fonts", `${name}.woff2`)).toString("base64")}`;
  const css = readFileSync(join(HERE, "learn", "style.css"), "utf8")
    .replace("@@FONT_LITERATA@@", font("literata"))
    .replace("@@FONT_ARCHIVO@@", font("archivo"));
  const js = readFileSync(join(HERE, "learn", "app.js"), "utf8").replace(
    "/* @@PROMPT@@ */",
    [where, fixPrompt, groupFindings].map((fn) => fn.toString()).join("\n  ")
  );

  const csp = [
    "default-src 'none'",
    `script-src ${sha256(js)}`,
    `style-src ${sha256(css)}`,
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="referrer" content="no-referrer"/>
<meta name="robots" content="${scan ? "noindex" : "index"}"/>
<meta name="description" content="Lessons for the security mistakes AI coding tools write into LLM apps: what is wrong, how it gets exploited, and a prompt to fix it."/>
<title>llm-audit learn</title>
<link rel="icon" href="${FAVICON}"/>
<style>${css}</style>
</head>
<body>
<main id="app"><noscript><p>This page needs JavaScript to read the scan results. Nothing is sent anywhere; it all runs in your browser.</p></noscript></main>
${dataBlock("lessons", LESSONS)}
${dataBlock("examples", safeExamples())}
${dataBlock("meta", { version, base })}
${scan ? dataBlock("scan", scan) : ""}
<script>${js}</script>
</body>
</html>
`;
}
