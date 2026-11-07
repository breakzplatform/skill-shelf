---
name: shelve
description: Hide skills, or every skill matching a glob, from Claude's context, or keep only their names listed.
disable-model-invocation: true
argument-hint: <name|glob>... [--name-only] [--project]
---

Run this with Bash, passing the arguments exactly as given, each one quoted as a single shell word:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js" shelve $ARGUMENTS
```

Arguments: `$ARGUMENTS`. If they are empty, ask which skill to shelve. Report the command's output in one line.
