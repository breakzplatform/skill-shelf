---
name: index
description: Index of installed skills that are shelved (hidden from your skill list to save context). Before a task that no listed skill covers, or when the user names a skill or /command you do not see, read this index, then Read the matching SKILL.md by path and follow it.
allowed-tools: Bash(node *skill-shelf.js* index)
---

# Shelved skills

These skills are installed but hidden from your skill list by `skillOverrides`. Invoking one through the Skill tool fails, so open its `SKILL.md` with Read and follow it as if it had been invoked. Paths in it that are relative resolve against that file's directory.

!`node "${CLAUDE_SKILL_DIR}/../../bin/skill-shelf.js" index`

If the list above did not render (shell execution disabled), run `node "${CLAUDE_SKILL_DIR}/../../bin/skill-shelf.js" index` with Bash.
