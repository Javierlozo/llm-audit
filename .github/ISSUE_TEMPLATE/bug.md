---
name: Bug
about: The CLI crashed, produced wrong output, or wrote the wrong files
title: "bug: <short description>"
labels: ["bug"]
---

For issues with the *rules*, use the false positive or false negative template
instead. This one is for `scan`, `init`, `doctor`, `demo`, and the files `init`
writes.

**What you ran**

```sh
npx llm-audit ...
```

**What happened**

<!-- Full output, including the error. Redact paths and secrets. -->

**What you expected**

**Environment**

```
npx llm-audit --version
semgrep --version
node --version
```

OS:

<!--
If this is a security vulnerability — code execution, path traversal, or data
exfiltration — do NOT open a public issue. See SECURITY.md.
-->
