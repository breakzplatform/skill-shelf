---
name: suggest
description: Propose a level (on, name-only, off) for each personal and project skill from how often your transcripts used it.
disable-model-invocation: true
argument-hint: [--days N] [--often N] [--apply] [--project]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js suggest)
---

Run this with Bash, passing the arguments exactly as given, each one quoted as a single shell word:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js suggest $ARGUMENTS
```

Arguments: `$ARGUMENTS`. Show the table and the commands as printed. Without `--apply` nothing changes; if the user wants the changes, run the printed commands or the same command with `--apply`, after they confirm.
