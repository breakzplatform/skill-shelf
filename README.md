# skill-shelf

A Claude Code plugin that keeps rarely used skills out of Claude's context without uninstalling them.

Every installed skill puts its name and description in the context of every turn. Large skill packs (GSD alone ships dozens) crowd the listing, and Claude Code starts cutting descriptions short. skill-shelf hides the skills you rarely use and leaves one small index skill in their place, so Claude can still find a shelved skill and read it when a task needs it.

## How it works

- Shelving a skill sets it to `"off"` in [`skillOverrides`](https://code.claude.com/docs/en/skills.md#override-skill-visibility-from-settings), the setting the native `/skills` menu also writes. No files are moved, so other open sessions are unaffected and everything is reversible.
- The `skill-shelf:index` skill lists every hidden skill with the path of its `SKILL.md`, generated when it is invoked. Claude reads the file and follows it.
- A glob such as `gsd-*` is saved as a pattern. A `SessionStart` hook shelves skills installed later that match it. A skill the hook has already seen is never shelved again, so turning one back on, here or in `/skills`, sticks.

## Install

```
/plugin marketplace add breakzplatform/skill-shelf
/plugin install skill-shelf@skill-shelf
```

Requires Node.js 18 or later. No dependencies.

## Use

| Command | Effect |
| :- | :- |
| `/skill-shelf:shelve gsd-*` | Hide every matching skill and keep the pattern for future installs |
| `/skill-shelf:shelve grill-me` | Hide one skill |
| `/skill-shelf:unshelve gsd-plan` | Bring one back (writes `"on"`) |
| `/skill-shelf:unshelve gsd-* --project` | Bring them back only in the current project |
| `/skill-shelf:list` | Show patterns and shelved skills |

`--project` writes `.claude/settings.local.json` in the current directory, which takes precedence over `~/.claude/settings.json` for each skill name. Without it, changes go to `~/.claude/settings.json`.

The same commands work from a shell: `node bin/skill-shelf.js shelve 'gsd-*'`.

The native `/skills` menu works as well. The index reflects whatever `skillOverrides` says, so a skill you set to `off` there shows up in the index and one you turn back on leaves it.

## Files

| Path | Content |
| :- | :- |
| `~/.claude/settings.json`, `.claude/settings.local.json` | `skillOverrides` entries; other keys are kept as they are |
| `~/.claude/skill-shelf.json` | `{"patterns": [...]}` |
| `~/.claude/skill-shelf.state.json` | Skills the hook has already seen |

Settings files are written atomically and through symlinks. A settings file that is not valid JSON is never rewritten.

## Limits

- Only personal (`~/.claude/skills`) and project (`.claude/skills`) skills can be shelved. Claude Code does not apply `skillOverrides` to plugin skills; disable the plugin instead.
- Invoking a shelved skill with the Skill tool or `/name` fails by design. Claude reads its `SKILL.md` through the index instead, so a skill that depends on `!` command injection or `$ARGUMENTS` substitution loses those while shelved.
- The index uses `!` command injection. With `disableSkillShellExecution` on, the index skill tells Claude to run the same command with Bash.

## License

Apache-2.0. See LICENSE and NOTICE.
