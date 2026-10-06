#!/usr/bin/env node
// Build the hosted learn page: `site/index.html`, a static file with no scan
// embedded, which reads one from the URL fragment. The Pages workflow runs
// this and publishes the directory; nothing in it is committed.
//
//   node tools/build-site.mjs [outDir]

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLearnPage } from "../src/learn.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] || join(root, "site"));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), renderLearnPage({ version }));
console.log(`wrote ${join(out, "index.html")}`);
