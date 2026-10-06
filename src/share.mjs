// The learn link: a scan's findings packed into a URL fragment.
//
// Everything after `#` stays in the browser. It is never sent to the server
// that hosts the learn page, never logged by it, and never in a Referer
// header. So the page can be a static file, and a link can carry the code
// around each finding without anyone uploading that code anywhere.
//
// The link is still a copy of that code, though, and links get pasted into
// chats and tickets. Two rules follow:
//   - Secret-shaped strings are redacted before they go in. The finding that
//     most needs a lesson, a hardcoded key, is exactly the one whose snippet
//     must not travel.
//   - The link is printed for a person at a terminal, not into CI logs,
//     unless someone asks for it with --link.
//
// Payload format (version 1), JSON, deflate-raw, base64url:
//   { v: 1, tool, repo: { branch, shortCommit, dirty } | null, paths, filtered,
//     f: [[ruleId, severity, path, startLine, endLine, ctxFrom, ctxLines]] }
// Arrays instead of objects per finding because they repeat, and every byte
// of the fragment is a byte in someone's chat message.

import { deflateRawSync, inflateRawSync } from "node:zlib";

export const SHARE_VERSION = 1;
export const DEFAULT_LEARN_URL = "https://llm-audit.luislozoya.com/learn/";

// Past these sizes the link gets dropped by chat apps or becomes unpleasant
// to paste. Step down: full context, then matched lines only, then locations.
const SOFT_LIMIT = 6000;
const HARD_LIMIT = 24000;

// Shapes worth hiding even inside a link that is never uploaded. Provider key
// prefixes first, then any long quoted value assigned to a secret-named key.
const SECRET_SHAPES = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{8,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
const NAMED_SECRET =
  /((?:api[_-]?key|secret|token|password|passwd|auth)["']?\s*[:=]\s*)(["'`])([^"'`\s]{12,})\2/gi;

export function redact(line) {
  let out = line;
  for (const re of SECRET_SHAPES) out = out.replace(re, (m) => `${m.slice(0, 4)}…[redacted]`);
  out = out.replace(NAMED_SECRET, (_, lhs, q) => `${lhs}${q}[redacted]${q}`);
  return out;
}

function pack(payload) {
  return deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 }).toString(
    "base64url"
  );
}

export function unpack(fragment) {
  return JSON.parse(inflateRawSync(Buffer.from(fragment, "base64url")).toString("utf8"));
}

/**
 * Build the payload for one scan.
 *
 * @param envelope     the scan --json envelope
 * @param opts.context (finding) => { from, lines } | null, the snippet with a
 *                     couple of lines either side
 * @param opts.display (path) => string, the path as shown to the user
 * @param opts.detail  "context" | "match" | "none"
 */
export function buildPayload(envelope, { context, display = (p) => p, detail = "context", filtered = false } = {}) {
  const repo = envelope.repo
    ? {
        branch: envelope.repo.branch || null,
        shortCommit: envelope.repo.shortCommit || null,
        dirty: Boolean(envelope.repo.dirty),
      }
    : null;
  const f = envelope.findings.map((x) => {
    let from = x.startLine ?? 1;
    let lines = [];
    if (detail === "context") {
      const ctx = context?.(x);
      if (ctx) {
        from = ctx.from;
        lines = ctx.lines;
      } else if (x.lines) {
        lines = x.lines.replace(/\n+$/, "").split("\n");
      }
    } else if (detail === "match" && x.lines) {
      lines = x.lines.replace(/\n+$/, "").split("\n");
    }
    // Long minified lines carry no lesson and blow the size budget.
    lines = lines.map((l) => redact(l.length > 240 ? l.slice(0, 240) + "…" : l));
    return [x.ruleId, x.severity, display(x.path), x.startLine, x.endLine ?? x.startLine, from, lines];
  });
  return {
    v: SHARE_VERSION,
    tool: envelope.tool?.version || null,
    repo,
    paths: envelope.scannedPaths || [],
    filtered: Boolean(filtered),
    f,
  };
}

/**
 * The learn link for a scan, sized to travel. Returns { url, detail }, where
 * detail says how much code made it in, so the CLI can be honest about it.
 */
export function learnLink(envelope, opts = {}) {
  const base = opts.base || DEFAULT_LEARN_URL;
  const sized = ["context", "match", "none"].map((detail) => ({
    detail,
    fragment: pack(buildPayload(envelope, { ...opts, detail })),
  }));
  // The most code that fits comfortably; failing that, the most that fits at all.
  const pick =
    sized.find((s) => s.fragment.length <= SOFT_LIMIT) ||
    sized.find((s) => s.fragment.length <= HARD_LIMIT);
  if (!pick) return { url: null, detail: "too-large" };
  return { url: `${base}#r=${pick.fragment}`, detail: pick.detail };
}
