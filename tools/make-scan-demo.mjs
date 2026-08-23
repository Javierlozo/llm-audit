#!/usr/bin/env node
// Regenerates assets/scan-demo.svg — the animated terminal hero in the README.
//
// The frames are not hand-drawn. This script writes a small, genuinely
// vulnerable sample app to a temp directory, runs the real CLI against it,
// and renders the real ANSI output as an animated SVG. If the formatter
// changes, re-run `npm run demo:svg` and the hero follows.
//
//   node tools/make-scan-demo.mjs [--out assets/scan-demo.svg]

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

// Fixed so the asset is reproducible: the same input always renders the same
// SVG, which keeps the diff meaningful when someone re-runs this.
const COLUMNS = 84;

const ESC = "\u001b";
const ANSI_RE = new RegExp(ESC + "\\[(\\d+)m", "g");
const ANSI_STRIP = new RegExp(ESC + "\\[\\d+m", "g");

// ── The sample app ──────────────────────────────────────────────────────────
// Real code with real bugs, in the shape people actually write them: a chat
// route handler that hardcodes a key and trusts the model's JSON.
const SAMPLE = `import OpenAI from "openai";

const openai = new OpenAI({ apiKey: "sk-proj-AAAA1111BBBB2222CCCC3333DDDD4444" });

export async function POST(req: Request) {
  const { question } = await req.json();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: question }],
  });

  const profile = JSON.parse(completion.choices[0].message.content as string);
  return Response.json({ name: profile.name, tier: profile.tier });
}
`;

function captureScan() {
  const dir = mkdtempSync(join(tmpdir(), "llm-audit-demo-"));
  try {
    const file = join(dir, "src", "app", "api", "chat", "route.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SAMPLE);

    const r = spawnSync(
      process.execPath,
      [join(PKG_ROOT, "src", "cli.mjs"), "scan", "src"],
      {
        cwd: dir,
        encoding: "utf8",
        // FORCE_COLOR gets us the coloured human renderer without a pty;
        // COLUMNS pins the wrap width so the SVG box size is stable.
        env: {
          ...process.env,
          FORCE_COLOR: "1",
          COLUMNS: String(COLUMNS),
          NO_COLOR: "",
        },
      }
    );
    if (r.error) throw r.error;
    // scan exits 1 on findings — that is the expected path here.
    if (r.status !== 1) {
      throw new Error(
        `expected findings from the sample app (exit 1), got ${r.status}\n${r.stderr}`
      );
    }
    return r.stdout.replace(/\n+$/, "").split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── ANSI → spans ────────────────────────────────────────────────────────────
// Palette matches assets/banner.svg so the README reads as one surface.
const FG = {
  default: "#e8edf4",
  dim: "#8b98a9",
  31: "#f2777a", // error
  32: "#4ec9a5", // clean
  33: "#f0b429", // warning / OWASP id
  34: "#6aa9ff", // the fix block
  35: "#c792ea", // matched source
};

function parseAnsi(line) {
  const spans = [];
  let state = { bold: false, dim: false, color: null };
  let index = 0;
  let m;
  ANSI_RE.lastIndex = 0;
  const push = (text) => {
    if (text) spans.push({ text, ...state });
  };
  while ((m = ANSI_RE.exec(line))) {
    push(line.slice(index, m.index));
    const code = Number(m[1]);
    if (code === 0) state = { bold: false, dim: false, color: null };
    else if (code === 1) state = { ...state, bold: true };
    else if (code === 2) state = { ...state, dim: true };
    else state = { ...state, color: code };
    index = m.index + m[0].length;
  }
  push(line.slice(index));
  return spans;
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Layout ──────────────────────────────────────────────────────────────────
const CHAR_W = 6.62; // ui-monospace at 11px
const LINE_H = 16;
const FONT = 11;
const PAD_X = 22;
const PAD_TOP = 60; // room for the window chrome
const PAD_BOTTOM = 18;
const PROMPT = "$ ";
// A hero has to fit above the fold. Keep the first finding whole — the
// rationale is the product — then elide the middle and land on the summary,
// with a visible marker so nobody mistakes the crop for the whole report.
const HEAD_LINES = 21;
const TAIL_LINES = 4;
const COMMAND = "npx llm-audit scan src";

// Returns the display lines, with an explicit marker where output was cut.
function crop(lines) {
  if (lines.length <= HEAD_LINES + TAIL_LINES + 1) return lines;
  const hidden = lines.length - HEAD_LINES - TAIL_LINES;
  const DIM = `${ESC}[2m`;
  const RESET = `${ESC}[0m`;
  return [
    ...lines.slice(0, HEAD_LINES),
    "",
    `${DIM}      \u22ee  ${hidden} more lines \u2014 the rest of the report, then the summary${RESET}`,
    ...lines.slice(-TAIL_LINES),
  ];
}

function render(lines) {
  const cols = Math.max(
    COLUMNS,
    (PROMPT + COMMAND).length,
    ...lines.map((l) => l.replace(ANSI_STRIP, "").length)
  );
  const width = Math.round(PAD_X * 2 + cols * CHAR_W);
  // +1 command line, +1 blank line after it
  const rows = lines.length + 2;
  const height = PAD_TOP + rows * LINE_H + PAD_BOTTOM;

  // Timing. The hero sits below the fold, so a play-once animation is over
  // before most readers scroll to it. The whole timeline loops instead: type,
  // stream the report, then hold the finished frame long enough that the loop
  // reads as a pause rather than a flicker.
  const TYPE_MS = 900;
  const THINK_MS = 700;
  const LINE_MS = 55;
  const HOLD_MS = 9000;
  const startOutput = TYPE_MS + THINK_MS;
  const CYCLE_MS = startOutput + lines.length * LINE_MS + HOLD_MS;
  const pct = (ms) => ((ms / CYCLE_MS) * 100).toFixed(3);
  // A hair of separation so the "off" and "on" stops never collapse.
  const STEP = 0.01;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" ` +
      `aria-label="Running npx llm-audit scan src: two findings in a chat route handler, a hardcoded provider key and model output parsed without a schema" ` +
      `font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">`
  );
  out.push(`<title>npx llm-audit scan src</title>`);

  // Motion is decoration here; readers who ask for less get the finished frame.
  // One keyframe set per line: animation-delay only applies to the first
  // iteration, so a looping reveal has to carry its timing as percentages.
  const lineRules = lines
    .map((_, i) => {
      const at = pct(startOutput + i * LINE_MS);
      return (
        `.l${i}{animation:k${i} ${CYCLE_MS}ms linear infinite}` +
        `@keyframes k${i}{0%,${at}%{opacity:0}${(Number(at) + STEP).toFixed(3)}%,100%{opacity:1}}`
      );
    })
    .join("\n");

  // Motion is decoration here; readers who ask for less get the finished frame.
  out.push(`<style>
/* Base state is the FINISHED frame, not a blank one: a renderer that does not
   run CSS animations (thumbnailers, previews, older readers) then shows the
   whole report instead of an empty terminal. The animation overrides this
   while it runs. */
.ln{opacity:1}
${lineRules}
.cur{animation:blink 1s steps(1,end) infinite}
.type{transform:scaleX(0);transform-origin:0 0;
  animation:type ${CYCLE_MS}ms steps(${COMMAND.length},end) infinite}
@keyframes type{0%{transform:scaleX(0)}${pct(TYPE_MS)}%,100%{transform:scaleX(1)}}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){
.ln{opacity:1;animation:none}
.cur{animation:none;opacity:0}
.type{transform:scaleX(1);animation:none}
}
</style>`);

  out.push(`<rect width="${width}" height="${height}" rx="10" fill="#12161c"/>`);
  out.push(
    `<rect x="0.75" y="0.75" width="${width - 1.5}" height="${height - 1.5}" rx="9.25" ` +
      `fill="none" stroke="#242b35" stroke-width="1.5"/>`
  );

  // Title bar, no traffic lights: the macOS chrome is a convention this
  // project deliberately dropped (ff24b0e). The bar carries the tool's name
  // and nothing else.
  out.push(
    `<text x="${PAD_X}" y="25" fill="#8b98a9" font-size="11" ` +
      `font-weight="600" xml:space="preserve">llm-audit</text>`
  );
  out.push(
    `<text x="${width - PAD_X}" y="25" fill="#6b7789" font-size="10" ` +
      `text-anchor="end">OWASP LLM Top 10 \u00b7 TypeScript</text>`
  );
  out.push(
    `<line x1="0" y1="37" x2="${width}" y2="37" stroke="#242b35" stroke-width="1"/>`
  );

  const y = (row) => PAD_TOP + row * LINE_H;

  // The command types itself in behind a clip that widens one character at a time.
  const cmdX = PAD_X + PROMPT.length * CHAR_W;
  const cmdW = COMMAND.length * CHAR_W;
  out.push(
    `<clipPath id="typing"><rect class="type" x="${cmdX.toFixed(2)}" ` +
      `y="${y(0) - FONT}" width="${cmdW.toFixed(2)}" height="${LINE_H}"/></clipPath>`
  );
  out.push(
    `<text x="${PAD_X}" y="${y(0)}" fill="#4ec9a5" font-size="${FONT}" ` +
      `textLength="${(PROMPT.length * CHAR_W).toFixed(2)}" lengthAdjust="spacingAndGlyphs" ` +
      `xml:space="preserve">${PROMPT}</text>`
  );
  out.push(
    `<text x="${cmdX.toFixed(2)}" y="${y(0)}" fill="#e8edf4" font-size="${FONT}" ` +
      `textLength="${cmdW.toFixed(2)}" lengthAdjust="spacingAndGlyphs" ` +
      `clip-path="url(#typing)" xml:space="preserve">${esc(COMMAND)}</text>`
  );
  out.push(
    `<rect class="cur" x="${(cmdX + cmdW + 3).toFixed(2)}" ` +
      `y="${y(0) - FONT + 1}" width="${CHAR_W.toFixed(2)}" height="${FONT + 2}" ` +
      `fill="#4ec9a5"/>`
  );

  lines.forEach((line, i) => {
    const row = i + 2;
    const spans = parseAnsi(line);
    if (!spans.length) return;
    const chunks = [];
    let col = 0;
    for (const s of spans) {
      const fill = s.color ? FG[s.color] || FG.default : s.dim ? FG.dim : FG.default;
      const weight = s.bold ? ' font-weight="600"' : "";
      const opacity = s.dim && s.color ? ' opacity="0.75"' : "";
      // textLength pins each run to the character grid, so the layout holds
      // on whatever monospace font the viewer's platform resolves.
      chunks.push(
        `<tspan x="${(PAD_X + col * CHAR_W).toFixed(2)}" ` +
          `textLength="${(s.text.length * CHAR_W).toFixed(2)}" lengthAdjust="spacingAndGlyphs" ` +
          `fill="${fill}"${weight}${opacity}>${esc(s.text)}</tspan>`
      );
      col += s.text.length;
    }
    out.push(
      `<text class="ln l${i}" y="${y(row)}" font-size="${FONT}" ` +
        `xml:space="preserve">${chunks.join("")}</text>`
    );
  });

  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

const outIndex = process.argv.indexOf("--out");
const outPath =
  outIndex !== -1 && process.argv[outIndex + 1]
    ? resolve(process.argv[outIndex + 1])
    : join(PKG_ROOT, "assets", "scan-demo.svg");

const lines = crop(captureScan());
writeFileSync(outPath, render(lines));
console.log(`wrote ${outPath} — ${lines.length} output lines, ${COLUMNS} columns`);
