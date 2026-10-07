#!/usr/bin/env node
// Regenerates assets/commands.svg — the "what you can run" card in the README.
//
// The recording next to it shows one run in depth. This shows the surface in
// breadth: every command, ordered by the moment you would reach for it rather
// than alphabetically or by an invented pipeline of phases. A reader who has
// just installed the package should be able to answer "now what?" without
// scrolling.
//
// The commands and their one-line summaries are read from the START HERE block
// of the CLI's own `--help`, so this cannot drift from the tool. The "moment"
// column is the editorial part and lives here.
//
//   node tools/make-command-map.mjs [--out assets/commands.svg]

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

// The commands and what each one does come from the START HERE block of
// `--help`, so the card and the terminal say the same thing. Only the moment
// you would reach for each one is editorial, and it lives here.
const WHEN = {
  demo: "Before you adopt it",
  scan: "While you write",
  learn: "When you want the why",
  prompt: "When you are ready to fix",
  init: "To make it permanent",
  doctor: "When something is off",
};

function helpText() {
  const r = spawnSync(process.execPath, [join(PKG_ROOT, "src", "cli.mjs"), "--help"], {
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`--help exited ${r.status}`);
  return r.stdout;
}

// Each entry is "  llm-audit <command...>   <summary>", with the summary
// wrapping onto lines indented to the same column.
function startHere(help) {
  const block = (help.split(/^START HERE$/m)[1] || "").split(/^\S/m)[0];
  const moments = [];
  for (const line of block.split("\n")) {
    const entry = /^ {2}(llm-audit \S+(?: \S+)*?) {2,}(\S.*)$/.exec(line);
    if (entry) {
      const command = entry[1].split(" ")[1];
      if (!WHEN[command]) {
        throw new Error(
          `'${command}' is in START HERE but has no moment. Add it to WHEN in tools/make-command-map.mjs.`
        );
      }
      moments.push({ command, display: entry[1], when: WHEN[command], what: entry[2] });
    } else if (line.trim() && moments.length) {
      moments[moments.length - 1].what += " " + line.trim();
    }
  }
  if (moments.length === 0) throw new Error("no START HERE block in `llm-audit --help`");
  for (const m of moments) m.what += ".";
  return moments;
}

const MOMENTS = startHere(helpText());

const NUMBER = { 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight" };

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Palette and type stack are lifted from assets/banner.svg so the README reads
// as one surface rather than a scrapbook.
const INK = "#e8edf4";
const MUTED = "#8b98a9";
const FAINT = "#6c7889";
const ACCENT = "#f0b429";
const LINE = "#242b35";
const BG = "#12161c";
const SANS = "ui-sans-serif,-apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const WIDTH = 820;
const PAD = 32;
const HEAD = 74;
const ROW = 62;
const SPINE = PAD + 4; // the vertical rule the rows hang off

function render() {
  const height = HEAD + (MOMENTS.length - 1) * ROW + 34;
  const out = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" ` +
      `viewBox="0 0 ${WIDTH} ${height}" role="img" ` +
      `aria-label="What you can run: ${NUMBER[MOMENTS.length] || MOMENTS.length} llm-audit commands, ordered by when you would reach for each one" ` +
      `font-family="${SANS}">`
  );
  out.push(`<title>llm-audit — what you can run</title>`);
  out.push(`<rect width="${WIDTH}" height="${height}" rx="14" fill="${BG}"/>`);
  out.push(
    `<rect x="0.75" y="0.75" width="${WIDTH - 1.5}" height="${height - 1.5}" rx="13.25" ` +
      `fill="none" stroke="${LINE}" stroke-width="1.5"/>`
  );

  out.push(
    `<text x="${PAD}" y="${PAD + 10}" fill="${INK}" font-size="15" font-weight="600">` +
      `What you can run</text>`
  );
  out.push(
    `<text x="${PAD + 152}" y="${PAD + 10}" fill="${FAINT}" font-size="12.5">` +
      `\u2014 ${NUMBER[MOMENTS.length] || MOMENTS.length} commands, in the order you would reach for them</text>`
  );

  // One continuous rule down the left, echoing the boundary line in the
  // project's mark. The rows hang off it; it is not terminal chrome.
  const spineTop = HEAD - 26;
  const spineBottom = HEAD + (MOMENTS.length - 1) * ROW + 2;
  out.push(
    `<line x1="${SPINE}" y1="${spineTop}" x2="${SPINE}" y2="${spineBottom}" ` +
      `stroke="${LINE}" stroke-width="2"/>`
  );

  MOMENTS.forEach((m, i) => {
    const y = HEAD + i * ROW;
    out.push(
      `<circle cx="${SPINE}" cy="${y - 8}" r="3.5" fill="${ACCENT}" opacity="0.9"/>`
    );
    out.push(
      `<text x="${SPINE + 18}" y="${y - 12}" fill="${FAINT}" font-size="11" ` +
        `letter-spacing="0.08em">${esc(m.when.toUpperCase())}</text>`
    );
    out.push(
      `<text x="${SPINE + 18}" y="${y + 8}" fill="${ACCENT}" font-size="13.5" ` +
        `font-family="${MONO}">${esc(m.display)}</text>`
    );
    out.push(
      `<text x="${SPINE + 300}" y="${y + 8}" fill="${MUTED}" font-size="13">` +
        `${esc(m.what)}</text>`
    );
  });

  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

const outIndex = process.argv.indexOf("--out");
const outPath =
  outIndex !== -1 && process.argv[outIndex + 1]
    ? resolve(process.argv[outIndex + 1])
    : join(PKG_ROOT, "assets", "commands.svg");

writeFileSync(outPath, render());
console.log(`wrote ${outPath} — ${MOMENTS.length} commands`);
