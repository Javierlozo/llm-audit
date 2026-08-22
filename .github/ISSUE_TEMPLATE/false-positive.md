---
name: False positive
about: A rule flagged code that is actually safe
title: "false positive: <rule-id>"
labels: ["false-positive"]
---

False positives are treated as bugs. `llm-audit` runs in a pre-commit hook, so a
noisy rule gets the whole tool uninstalled.

**Rule ID**

<!-- e.g. untrusted-input-in-system-prompt -->

**The smallest snippet that misfires**

```ts
// paste here — minimal, self-contained, no proprietary code
```

**Why this code is safe**

<!-- What validation, sanitization, or boundary makes the flagged pattern correct here? -->

**Versions**

```
npx llm-audit --version
semgrep --version
```
