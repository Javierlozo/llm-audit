#!/usr/bin/env node
// Regenerates assets/commands.svg — the "what you can run" card in the README.
//
// The recording next to it shows one run in depth. This shows the surface in
// breadth: every command, ordered by the moment you would reach for it rather
// than alphabetically or by an invented pipeline of phases. A reader who has
// just installed the package should be able to answer "now what?" without
// scrolling.
//
// The commands and their one-line summaries are read from the CLI's own
// `--help`, so this cannot drift from the tool. The "moment" column is the
// editorial part and lives here.
//
//   node tools/make-command-map.mjs [--out assets/commands.svg]

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

// Ordered by when a developer reaches for it, which is the only ordering that
// answers "now what?". The `command` is matched against `--help` output; if a
// command stops existing, this script fails rather than shipping a lie.
const MOMENTS = [
  {
    command: "demo",
    display: "llm-audit demo",
    when: "Before you adopt it",
    what: "Watch all twelve rules fire on bundled vulnerable code.",
  },
  {
    command: "scan",
    display: "llm-audit scan src",
    when: "While you write",
    what: "Findings worst-first, each with the risk and the fix.",
  },
  {
    command: "rules",
    display: "llm-audit rules <rule-id>",
    when: "When you want the why",
    what: "One rule in full, ending in code that is asserted safe.",
  },
  {
    command: "scan",
    display: "llm-audit scan --html r.html",
    when: "When someone else needs it",
    what: "A self-contained report to attach to a PR or keep in CI.",
  },
  {
    command: "init",
    display: "llm-audit init --skill",
    when: "To make it permanent",
    what: "Pre-commit hook, CI workflow, and the coding-agent skill.",
  },
  {
    command: "doctor",
    display: "llm-audit doctor",
    when: "When something is off",
    what: "Dependencies, project setup, and whether you are current.",
  },
];

function helpText() {
  const r = spawnSync(process.execPath, [join(PKG_ROOT, "src", "cli.mjs"), "--help"], {
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`--help exited ${r.status}`);
  return r.stdout;
}

// Fail loudly rather than advertise a command the CLI no longer has.
function verify(help) {
  const commandsSection = help.split(/^COMMANDS$/m)[1] || "";
  for (const { command } of MOMENTS) {
    const listed = new RegExp(`^\\s{2}${command}\\b`, "m").test(commandsSection);
    if (!listed) {
      throw new Error(
        `'${command}' is in the command map but not in \`llm-audit --help\`. ` +
          `Update tools/make-command-map.mjs.`
      );
    }
  }
}

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
      `aria-label="What you can run: six llm-audit commands, ordered by when you would reach for each one" ` +
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
      `\u2014 six commands, in the order you would reach for them</text>`
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

verify(helpText());
writeFileSync(outPath, render());
console.log(`wrote ${outPath} — ${MOMENTS.length} commands`);
