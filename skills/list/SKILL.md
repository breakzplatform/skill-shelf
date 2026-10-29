---
name: list
description: Show the shelf patterns and which skills are shelved.
disable-model-invocation: true
allowed-tools: Bash(node *skill-shelf.js* list)
---

!`node "${CLAUDE_SKILL_DIR}/../../bin/skill-shelf.js" list`

Show the output above to the user as is.
