---
name: list
description: Show the shelf patterns and which skills are shelved or name-only.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js list)
---

Run exactly this command with Bash and show its output to the user as is:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js list
```
