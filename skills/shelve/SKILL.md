---
name: shelve
description: Hide a skill, or every skill matching a glob, from Claude's context.
disable-model-invocation: true
argument-hint: <name|glob> [--project]
---

Run this with Bash, passing the arguments exactly as given, each one quoted as a single shell word:

```
node "${CLAUDE_SKILL_DIR}/../../bin/skill-shelf.js" shelve $ARGUMENTS
```

Arguments: `$ARGUMENTS`. If they are empty, ask which skill to shelve. Report the command's output in one line.
