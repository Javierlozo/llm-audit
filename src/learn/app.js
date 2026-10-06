// The learn page. Runs in the browser, with no network access (see the CSP
// in learn.mjs) and no dependencies.
//
// Its input is untrusted: anyone can craft a link with any fragment. So the
// payload is validated field by field, and every piece of it reaches the page
// through textContent or a class name, never through innerHTML or a URL.

(() => {
  "use strict";

  const json = (id) => {
    const el = document.getElementById(id);
    return el && el.textContent.trim() ? JSON.parse(el.textContent) : null;
  };
  const LESSONS = json("lessons") || [];
  const EXAMPLES = json("examples") || {};
  const VERSION = json("meta")?.version || "";

  /* @@PROMPT@@ */

  // ── tiny DOM helper ──────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // ── payload ──────────────────────────────────────────────────────────────
  const SEVERITIES = ["ERROR", "WARNING", "INFO"];
  const SEV_RANK = { ERROR: 0, WARNING: 1, INFO: 2 };
  const RULE_ID = /^[a-z0-9-]{1,100}$/;
  const isInt = (n) => Number.isInteger(n) && n >= 0 && n < 1e7;

  async function inflate(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }

  function validate(raw) {
    if (!raw || raw.v !== 1 || !Array.isArray(raw.f)) throw new Error("it comes from a version of llm-audit this page does not know");
    const str = (s, max) => (typeof s === "string" ? s.slice(0, max) : null);
    const findings = [];
    for (const row of raw.f.slice(0, 2000)) {
      if (!Array.isArray(row)) continue;
      const [ruleId, severity, path, startLine, endLine, from, lines] = row;
      if (typeof ruleId !== "string" || !RULE_ID.test(ruleId)) continue;
      if (!SEVERITIES.includes(severity) || typeof path !== "string") continue;
      if (![startLine, endLine, from].every(isInt)) continue;
      findings.push({
        ruleId,
        severity,
        path: path.slice(0, 500),
        startLine,
        endLine: Math.max(endLine, startLine),
        from,
        lines: Array.isArray(lines)
          ? lines.slice(0, 60).map((l) => (typeof l === "string" ? l.slice(0, 400) : ""))
          : [],
      });
    }
    const repo =
      raw.repo && typeof raw.repo === "object"
        ? {
            branch: str(raw.repo.branch, 200),
            shortCommit: str(raw.repo.shortCommit, 40),
            dirty: raw.repo.dirty === true,
          }
        : null;
    return {
      tool: str(raw.tool, 40),
      repo,
      paths: Array.isArray(raw.paths) ? raw.paths.slice(0, 20).map((p) => str(p, 200)).filter(Boolean) : [],
      filtered: raw.filtered === true,
      findings,
    };
  }

  async function readScan() {
    const embedded = json("scan");
    if (embedded) return { scan: validate(embedded), key: "local" };
    const params = new URLSearchParams(location.hash.slice(1));
    const r = params.get("r");
    if (!r) return { scan: null };
    if (r.length > 200000) throw new Error("it is longer than any scan link should be");
    let raw;
    try {
      raw = JSON.parse(await inflate(r));
    } catch {
      throw new Error("the data in it is incomplete or damaged");
    }
    return { scan: validate(raw), key: r };
  }

  // ── progress, kept per scan in this browser only ─────────────────────────
  function hash(s) {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
    return (x >>> 0).toString(36);
  }
  function store(key) {
    const k = `llm-audit:fixed:${hash(key)}`;
    let set = new Set();
    try {
      set = new Set(JSON.parse(localStorage.getItem(k) || "[]"));
    } catch {}
    return {
      has: (slug) => set.has(slug),
      toggle(slug) {
        set.has(slug) ? set.delete(slug) : set.add(slug);
        try {
          localStorage.setItem(k, JSON.stringify([...set]));
        } catch {}
      },
      size: () => set.size,
    };
  }

  // ── grouping: one lesson per class of mistake ────────────────────────────
  function group(findings) {
    const byLesson = new Map();
    const unknown = [];
    for (const f of findings) {
      const lesson = LESSONS.find((l) => l.rules.includes(f.ruleId));
      if (!lesson) {
        unknown.push(f);
        continue;
      }
      const g = byLesson.get(lesson.slug) || { lesson, hits: [], severity: f.severity };
      g.hits.push(f);
      if (SEV_RANK[f.severity] < SEV_RANK[g.severity]) g.severity = f.severity;
      byLesson.set(lesson.slug, g);
    }
    const groups = [...byLesson.values()].sort(
      (a, b) =>
        SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
        b.hits.length - a.hits.length ||
        a.lesson.title.localeCompare(b.lesson.title)
    );
    for (const g of groups) {
      g.hits.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
    }
    return { groups, unknown };
  }

  // ── pieces ───────────────────────────────────────────────────────────────
  async function copy(text, button) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = h("textarea", { class: "offscreen", readonly: true });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {}
      ta.remove();
    }
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    button.textContent = ok ? "Copied" : "Select and copy it";
    button.classList.toggle("done", ok);
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("done");
    }, 1600);
  }

  function promptBlock(text, label) {
    const btn = h("button", { class: "btn", type: "button" }, "Copy");
    btn.addEventListener("click", () => copy(text, btn));
    return h(
      "div",
      { class: "prompt" },
      h("div", { class: "prompt-bar" }, h("div", { class: "label" }, label), btn),
      h("pre", {}, h("code", {}, text))
    );
  }

  function codeBlock(lines, from, matchFrom, matchTo) {
    const rows = lines.map((line, i) => {
      const n = from + i;
      const hit = matchFrom != null && n >= matchFrom && n <= matchTo;
      return h("span", { class: hit ? "row hit" : "row" }, h("span", { class: "ln" }, String(n)), h("span", { class: "src" }, line || " "));
    });
    return h("pre", { class: "code" }, h("code", {}, rows));
  }

  function plainCode(text) {
    return codeBlock(text.split("\n"), 1, null, null);
  }

  // A part of a lesson: its label sits in the margin, the content beside it.
  function part(title, ...body) {
    return h("section", { class: "part" }, h("h3", {}, title), h("div", { class: "part-body" }, body));
  }

  function occurrence(f) {
    const loc = f.endLine !== f.startLine ? `lines ${f.startLine}–${f.endLine}` : `line ${f.startLine}`;
    return h(
      "div",
      { class: "occ" },
      h("div", { class: "occ-loc" }, h("span", { class: "path" }, f.path), h("span", { class: "where" }, loc), h("span", { class: "rule-id" }, f.ruleId)),
      f.lines.length ? codeBlock(f.lines, f.from, f.startLine, f.endLine) : h("p", { class: "muted small" }, "The code was left out of this link to keep it short. Run with --open to see it.")
    );
  }

  function occurrences(hits) {
    const SHOW = 3;
    const wrap = h("div", { class: "occs" }, hits.slice(0, SHOW).map(occurrence));
    if (hits.length > SHOW) {
      const more = h("button", { class: "btn quiet", type: "button" }, `Show the other ${plural(hits.length - SHOW, "place")}`);
      more.addEventListener("click", () => {
        more.replaceWith(...hits.slice(SHOW).map(occurrence));
      });
      wrap.append(more);
    }
    return wrap;
  }

  // ── the lesson view ──────────────────────────────────────────────────────
  function lessonView(lesson, ctx) {
    const { g, index, total, fixed, onToggle, onNext, nextTitle } = ctx;
    const hits = g ? g.hits : [];
    const example = lesson.rules.map((r) => EXAMPLES[r]).find(Boolean);

    const meta = [
      g ? h("b", { class: `sev-${g.severity.toLowerCase()}` }, g.severity.toLowerCase()) : null,
      lesson.owasp,
      lesson.cwe.join(", "),
    ].filter(Boolean);

    const head = h(
      "header",
      {},
      h("p", { class: "lesson-no" }, `Lesson ${index + 1} of ${total}`),
      h("h2", { tabindex: "-1", id: "lesson-title" }, lesson.title),
      h("p", { class: "lede" }, lesson.summary),
      h("p", { class: "meta" }, meta.flatMap((m, i) => (i ? [" — ", m] : [m])))
    );

    const yours = g
      ? part(hits.length === 1 ? "In your code" : `In your code, ${hits.length} places`, occurrences(hits))
      : null;

    const what = part("What is going on", lesson.explanation.map((p) => h("p", {}, p)));

    const attack = part(
      "How it is used against you",
      h("p", {}, lesson.exploit.setup),
      plainCode(lesson.exploit.vulnerableExample),
      h("ol", { class: "attack" }, lesson.exploit.steps.map((s) => h("li", {}, h("span", {}, s)))),
      h("p", { class: "cost" }, h("b", {}, "Cost"), lesson.exploit.impact)
    );

    const fix = part(
      "The fix",
      h("p", {}, g ? "Paste this into Claude Code, Cursor, or whatever wrote the code. It already lists every place above." : "Paste this into Claude Code, Cursor, or whatever you build with."),
      promptBlock(fixPrompt(lesson, hits), "Fix prompt"),
      example
        ? h(
            "details",
            { class: "safe" },
            h("summary", {}, "What the fixed code looks like"),
            h("p", { class: "muted small" }, `From llm-audit's test suite (${example.name}). Every release checks that it produces zero findings.`),
            plainCode(example.code)
          )
        : null
    );

    const never = part(
      "Keeping it out",
      h("div", { class: "label" }, "How to spot it"),
      h("ul", { class: "spot" }, lesson.spotIt.map((s) => h("li", {}, s))),
      h("div", { class: "label" }, "The rest of your project"),
      h("p", {}, "A pattern match misses some shapes. This prompt asks your AI tool to look for them and report back before it changes anything."),
      promptBlock(lesson.askPrompt, "Check prompt")
    );

    const foot = h("footer", { class: "lesson-foot" });
    if (g) {
      const done = fixed.has(lesson.slug);
      foot.append(
        h(
          "button",
          { class: done ? "btn check on" : "btn check", type: "button", "aria-pressed": String(done), onclick: onToggle },
          done ? "Fixed" : "Mark as fixed"
        )
      );
    } else {
      foot.append(h("span", {}));
    }
    if (index < total - 1) {
      foot.append(h("button", { class: "next", type: "button", onclick: onNext }, h("span", {}, "Next"), `${nextTitle} →`));
    } else if (g) {
      foot.append(h("span", { class: "muted small" }, "That was the last one. Run the scan again to confirm the fixes."));
    }

    return h("article", { class: "lesson" }, head, yours, what, attack, fix, never, foot);
  }

  // ── the page ─────────────────────────────────────────────────────────────
  function masthead() {
    return h(
      "div",
      { class: "masthead" },
      h("span", { class: "word" }, "llm-audit ", h("span", {}, "/ lessons")),
      h("span", { class: "masthead-note" }, "A static page. Your results never leave this browser.")
    );
  }

  function summary(scan, groups, fixed) {
    const counts = { ERROR: 0, WARNING: 0, INFO: 0 };
    for (const f of scan.findings) counts[f.severity]++;
    const files = new Set(scan.findings.map((f) => f.path)).size;
    const where = scan.paths.length ? scan.paths.join(", ") : ".";
    const prov = scan.repo
      ? [
          " · ",
          `${scan.repo.branch || "detached"} @ `,
          h("code", {}, scan.repo.shortCommit || ""),
          scan.repo.dirty ? h("span", { class: "warn" }, " · uncommitted changes") : null,
        ]
      : null;

    const sev = SEVERITIES.filter((s) => counts[s]).map((s) =>
      h("b", { class: `sev-${s.toLowerCase()}` }, plural(counts[s], s.toLowerCase()))
    );
    const sevText = sev.flatMap((el, i) => (i === 0 ? [el] : [i === sev.length - 1 ? " and " : ", ", el]));

    const done = groups.filter((g) => fixed.has(g.lesson.slug)).length;
    const n = scan.findings.length;

    return h(
      "div",
      { class: "head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, `Scan of ${where}`, prov),
        h("h1", {}, `${plural(groups.length, "mistake")} in ${plural(n, "place")}`),
        h("p", { class: "standfirst" }, sevText, ` across ${plural(files, "file")}. Worst first. Each lesson shows every place it occurs and gives you a prompt that fixes them.`),
        scan.filtered ? h("p", { class: "note" }, "This was a filtered scan, so other rules may still have findings. Run llm-audit scan without --rule or --severity for the whole picture.") : null
      ),
      h(
        "div",
        { class: "tally", "aria-label": `${done} of ${groups.length} fixed` },
        h("span", { class: "tally-label" }, `${done} of ${groups.length} fixed`),
        h("div", { class: "tally-boxes", "aria-hidden": "true" }, groups.map((g) => h("i", { class: fixed.has(g.lesson.slug) ? "on" : null })))
      )
    );
  }

  function nav(items, current, fixed, onPick) {
    return h(
      "nav",
      { class: "toc", "aria-label": "Lessons" },
      h("p", { class: "label" }, "Contents"),
      h(
        "ol",
        {},
        items.map((it, i) => {
          const isFixed = fixed && fixed.has(it.lesson.slug);
          return h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: `toc-item${i === current ? " current" : ""}${isFixed ? " fixed" : ""}`,
                "aria-current": i === current ? "true" : null,
                onclick: () => onPick(i),
              },
              h("span", { class: "toc-no" }, isFixed ? "✓" : String(i + 1)),
              h("span", { class: "toc-title" }, it.lesson.title),
              it.hits ? h("span", { class: `toc-n sev-${it.severity.toLowerCase()}`, title: plural(it.hits.length, "place") }, String(it.hits.length)) : h("span", {})
            )
          );
        })
      )
    );
  }

  function libraryIntro() {
    return h(
      "div",
      { class: "head library" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, `${LESSONS.length} lessons`),
        h("h1", {}, "Security mistakes AI tools write into LLM apps"),
        h(
          "p",
          { class: "standfirst" },
          "What each one is, how someone would use it against you, and a prompt to fix it. Run llm-audit on your project and it sends you here with your own code in every lesson."
        )
      ),
      h("div", { class: "install" }, promptBlock("brew install semgrep\nnpx llm-audit scan", "Try it on your code"))
    );
  }

  function cleanView(scan) {
    return h(
      "div",
      { class: "head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, `Scan of ${scan.paths.join(", ") || "."}`),
        h("h1", {}, "Nothing to fix"),
        h("p", { class: "standfirst" }, "No rule matched. That means no obvious holes, not proof there are none. The lessons below are what was checked.")
      )
    );
  }

  function errorView(message) {
    return h(
      "div",
      { class: "head" },
      h(
        "div",
        {},
        h("h1", {}, "This link could not be read"),
        h("p", { class: "standfirst" }, `It may have been cut off when it was pasted: ${message}. Run the scan again, or use llm-audit scan --open to read the results from a local file.`)
      )
    );
  }

  // ── main ─────────────────────────────────────────────────────────────────
  async function main() {
    const root = document.getElementById("app");
    let scan = null;
    let key = null;
    let error = null;
    try {
      ({ scan, key } = await readScan());
    } catch (err) {
      error = (err && err.message) || "unknown error";
    }

    const report = scan && scan.findings.length > 0;
    const { groups, unknown } = report ? group(scan.findings) : { groups: [], unknown: [] };
    const items = report ? groups : LESSONS.map((lesson) => ({ lesson }));
    const fixed = report ? store(key) : null;

    // Which lesson is open is kept in the fragment next to the data, so a
    // reload or a shared link lands on the same one.
    const params = new URLSearchParams(location.hash.slice(1));
    let current = Math.max(0, items.findIndex((it) => it.lesson.slug === params.get("l")));

    const view = h("div", { class: "view" });
    const side = h("aside", { class: "side" });
    const top = h("div", { class: "top" });

    function remember() {
      const p = new URLSearchParams(location.hash.slice(1));
      p.set("l", items[current].lesson.slug);
      history.replaceState(null, "", `#${p.toString()}`);
    }

    function render(focus) {
      top.replaceChildren(
        error ? errorView(error) : report ? summary(scan, groups, fixed) : scan ? cleanView(scan) : libraryIntro()
      );
      side.replaceChildren(
        ...[
        nav(items, current, fixed, (i) => {
          current = i;
          remember();
          render(true);
          view.scrollIntoView({ block: "start" });
        }),
        unknown.length
          ? h("p", { class: "muted small" }, `${plural(unknown.length, "finding")} from rules this page has no lesson for. Update llm-audit for those.`)
          : null,
        ].filter(Boolean)
      );
      const it = items[current];
      view.replaceChildren(
        lessonView(it.lesson, {
          g: report ? it : null,
          index: current,
          total: items.length,
          nextTitle: items[current + 1]?.lesson.title,
          fixed,
          onToggle: () => {
            fixed.toggle(it.lesson.slug);
            render(false);
          },
          onNext: () => {
            current = Math.min(items.length - 1, current + 1);
            remember();
            render(true);
            view.scrollIntoView({ block: "start" });
          },
        })
      );
      if (focus) document.getElementById("lesson-title")?.focus({ preventScroll: true });
    }

    root.replaceChildren(masthead(), top, h("div", { class: "layout" }, side, view), h(
      "footer",
      { class: "page-foot muted small" },
      `llm-audit ${scan?.tool || VERSION}`,
      " · Every finding is a static match, not a proven exploit. Read the lesson, then decide."
    ));
    render(false);

    // A different link pasted into the same tab.
    addEventListener("hashchange", () => {
      const next = new URLSearchParams(location.hash.slice(1)).get("r");
      if (next !== key && !(key === "local")) location.reload();
    });
  }

  main();
})();
