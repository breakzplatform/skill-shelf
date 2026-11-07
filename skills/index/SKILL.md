---
name: index
description: Index of installed skills that are shelved (hidden from your skill list to save context). Before a task that no listed skill covers, or when the user names a skill or /command you do not see, read this index, then Read the matching SKILL.md by path and follow it.
allowed-tools: Read(~/.claude/plugins/data/skill-shelf-*/**) Read(~/.claude/skills/**) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js index)
---

# Shelved skills

These skills are installed but hidden from your skill list by `skillOverrides`. Invoking one through the Skill tool fails, so open its `SKILL.md` with Read and follow it as if it had been invoked. Paths in it that are relative resolve against that file's directory.

1. Read `${CLAUDE_PLUGIN_DATA}/sessions/${CLAUDE_SESSION_ID}.md`. It lists every shelved skill with the path of its `SKILL.md`, and is kept current for this session.
2. Only if that file does not exist, run exactly this command with Bash and use its output as the list: `node ${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js index`
3. Read the `SKILL.md` of the skill that fits and follow it.

Use only this list to find shelved skills. Do not search the disk for them.
