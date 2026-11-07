---
name: unshelve
description: Bring shelved skills, or every skill matching a glob, back into Claude's context.
disable-model-invocation: true
argument-hint: <name|glob>... [--project]
---

Run this with Bash, passing the arguments exactly as given, each one quoted as a single shell word:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js" unshelve $ARGUMENTS
```

Arguments: `$ARGUMENTS`. If they are empty, ask which skill to unshelve. Report the command's output in one line.
