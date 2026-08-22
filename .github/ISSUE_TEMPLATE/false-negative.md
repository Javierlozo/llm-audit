---
name: False negative / new rule
about: Vulnerable code a rule should have caught, or a pattern worth a new rule
title: "missed: <short description>"
labels: ["rule"]
---

A missed pattern is a rule bug, not a security vulnerability — see
[SECURITY.md](../../SECURITY.md). Snippets posted here often become fixtures, so
please make them self-contained.

**The vulnerable code**

```ts
// paste here
```

**Why it is dangerous**

<!-- What can an attacker do? Which OWASP LLM Top 10 entry does it map to? -->

**Existing rule that should have caught it, if any**

<!-- Leave blank if you are proposing a new rule. -->

**The corrected version**

```ts
// the safe fixture: same code, fixed. The rule must produce zero findings here.
```

**Versions**

```
npx llm-audit --version
semgrep --version
```
