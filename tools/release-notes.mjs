#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md as GitHub release notes.
// The release workflow uses it, so npm and GitHub Releases get the same
// words for every tag. Hard-wrapped lines are joined, because GitHub renders
// a single newline in release notes as a line break.
//
//   node tools/release-notes.mjs 0.10.2

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] || "").replace(/^v/, "");
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}
const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md"), "utf8");

const lines = changelog.split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Rename [Unreleased] before tagging.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
if (end === -1) end = lines.length;

const out = [];
for (const line of lines.slice(start + 1, end)) {
  const prev = out[out.length - 1];
  if (prev?.trim() && /^ {2,}\S/.test(line) && !/^\s*- /.test(line)) out[out.length - 1] = `${prev} ${line.trim()}`;
  else out.push(line);
}
const body = out.join("\n").trim();
if (!body) {
  console.error(`CHANGELOG.md's [${version}] section is empty.`);
  process.exit(1);
}
process.stdout.write(`${body}\n\nnpm: https://www.npmjs.com/package/llm-audit/v/${version}\n`);
