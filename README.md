# skill-shelf

A Claude Code plugin that keeps rarely used skills out of Claude's context without uninstalling them.

Every installed skill puts its name and description in the context of every turn. Large skill packs (GSD alone ships dozens) crowd the listing, and Claude Code starts cutting descriptions short. skill-shelf hides the skills you rarely use and leaves one small index skill in their place, so Claude can still find a shelved skill and read it when a task needs it.

## How it works

- Shelving a skill sets it to `"off"` in [`skillOverrides`](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings), the setting the native `/skills` menu also writes. `--name-only` writes `"name-only"` instead. No files are moved, so everything is reversible.
- The `skill-shelf:index` skill points Claude to a pre-rendered list of every hidden skill with the path of its `SKILL.md`. Claude reads the file and follows it. The list is written per session by a `SessionStart` hook and rewritten on every shelve and unshelve, so it needs no shell command when the skill is invoked (see [Headless and restricted sessions](#headless-and-restricted-sessions)).
- A glob such as `gsd-*` is saved as a pattern, with its level. The `SessionStart` hook shelves skills installed later that match it. A skill the hook has already seen is never shelved again, so turning one back on, here or in `/skills`, sticks.
- `suggest` reads your local transcripts and proposes a level for each skill from how often it was used.

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
| `/skill-shelf:shelve grill-me humanizer` | Hide these skills |
| `/skill-shelf:shelve doc-* --name-only` | Keep the names listed, drop the descriptions |
| `/skill-shelf:unshelve gsd-plan` | Bring one back (writes `"on"`) |
| `/skill-shelf:unshelve gsd-* --project` | Bring them back only in the current project |
| `/skill-shelf:list` | Show patterns, shelved and name-only skills |
| `/skill-shelf:suggest` | Propose a level per skill from the last 30 days of use |

`--project` writes `.claude/settings.local.json` in the current directory, which takes precedence over `~/.claude/settings.json` for each skill name. Without it, changes go to `~/.claude/settings.json`.

The same commands work from a shell: `node bin/skill-shelf.js shelve 'gsd-*'`.

The native `/skills` menu works as well. The index reflects whatever `skillOverrides` says, so a skill you set to `off` or `user-only` there shows up in the index and one you turn back on leaves it.

### suggest

```
node bin/skill-shelf.js suggest [--days 30] [--often 3] [--apply] [--project]
```

It scans `~/.claude/projects/**/*.jsonl` (subagent transcripts included) modified in the window and counts, per personal and project skill:

- Skill tool calls (`tool`)
- `/name` commands you typed (`slash`)
- Reads of the skill's `SKILL.md` (`read`), which is how a shelved skill gets used through the index. Opening the file to edit it also counts.

A skill with `--often` uses or more is proposed `on`, one with fewer than that but at least one `name-only`, and one with none `off`. It prints a table, a rough listing estimate before and after, and the exact `shelve`/`unshelve` commands; `--apply` runs them. Nothing leaves the machine. File dates are not used, so a skill you installed last week and have not used yet is proposed `off`; check the list before applying. Skills with `disable-model-invocation: true` are left out, since they are not in Claude's listing anyway.

## Personal skills

skill-shelf is for people who keep dozens or hundreds of personal skills in `~/.claude/skills` (or project skills in `.claude/skills`): skill packs installed by copying, skills synced from a shared repo, one-off skills written for a single task. Plugin skills are not affected by `skillOverrides`; to drop those from the listing, disable the plugin.

Each skill can sit at one of three levels:

| Level | In Claude's listing | Claude can invoke it | Cost per turn |
| :- | :- | :- | :- |
| `on` | name and description | yes, directly | full description |
| `name-only` | name only | yes, directly | a few tokens |
| `off` + index | not listed | through the index: Claude reads its `SKILL.md` | nothing, plus one index entry for all of them |

`name-only` keeps a skill one call away and relies on its name alone for Claude to pick it; good for skills with self-explanatory names. `off` saves the most; Claude only finds the skill when it opens the index, and the skill runs from a plain Read, so `!` command injection and `$ARGUMENTS` in it are lost.

How this compares with the built-in tools:

- **`/skills` menu.** Writes the same `skillOverrides` states one skill at a time. It has no globs, does not handle skills installed later, and has no index, so an `off` skill is unreachable for Claude.
- **`/skill-doctor`.** Reports what each skill costs and how often it was used, and tells you where to turn it off. It does not change anything. `suggest` gives a similar answer from your transcripts and can apply it; `/skill-doctor` is the authoritative number for cost.
- **`name-only` on its own.** Already built in and often enough. The listing also drops descriptions by itself when it overflows its budget (1% of the context window), starting with the skills you invoke least. skill-shelf adds a tier below that (`off` with an index) and patterns that keep new installs in place.

## Measured example

Estimate on the author's machine, from the descriptions on disk (`name + description` characters, capped at 1,536 per entry, divided by 4). It is not the exact count; run `/context` before and after to see the real figure for your setup.

114 personal skills that Claude can invoke; 93 of them shelved by the patterns `gsd-*` and `paseo-*` plus a few by name:

| The 93 shelved skills as | Listing characters | ≈ tokens per turn |
| :- | -: | -: |
| `on` | 13,662 | 3,416 |
| `name-only` | 1,518 | 380 |
| `off` + the index skill's own entry | 284 | 71 |

The other 21 skills add about 10,790 characters (≈ 2,700 tokens) at `on`, and plugin skills come on top. When the whole listing is over its budget (1% of the context window), descriptions are already being dropped, so the real saving is smaller than the first row suggests; the effect you then notice is that the skills you do use keep their full descriptions. Reading the index when it is needed costs about 17,800 characters (≈ 4,400 tokens) once, in that turn only.

## Headless and restricted sessions

The index skill used to inject its list with `` !`command` ``. In a `-p` run, an injected command that the permission rules do not allow aborts the whole skill invocation, so Claude never saw the fallback text either and searched the disk by hand. The index now has no injected command:

1. The `SessionStart` hook (startup, resume, clear and compact) writes `${CLAUDE_PLUGIN_DATA}/sessions/<session id>.md` for the session's directory. `shelve`, `unshelve` and the hook itself rewrite every such file, so a change shows up in sessions already open. Files of sessions started more than 30 days ago are removed.
2. The skill tells Claude to Read `${CLAUDE_PLUGIN_DATA}/sessions/${CLAUDE_SESSION_ID}.md`. Both variables are plain text substitutions, which work with `disableSkillShellExecution` on.
3. If the file is missing (the hook did not run, or the session is older than 30 days), Claude runs `node ${CLAUDE_PLUGIN_ROOT}/bin/skill-shelf.js index` with Bash. The skill's `allowed-tools` pre-approve that exact command, plus Read of the plugin data folder and `~/.claude/skills`.

## Files

| Path | Content |
| :- | :- |
| `~/.claude/settings.json`, `.claude/settings.local.json` | `skillOverrides` entries; other keys are kept as they are |
| `~/.claude/skill-shelf.json` | `{"patterns": ["gsd-*", {"pattern": "doc-*", "level": "name-only"}]}` |
| `~/.claude/skill-shelf.state.json` | Skills the hook has already seen, and where the plugin data folder is |
| `~/.claude/plugins/data/skill-shelf-*/sessions/*.md` | Pre-rendered index, one per session |

Settings files are written atomically and through symlinks. A settings file that is not valid JSON is never rewritten.

## Limits

- Only personal (`~/.claude/skills`) and project (`.claude/skills`) skills can be shelved. Claude Code does not apply `skillOverrides` to plugin skills; disable the plugin instead.
- Invoking a shelved skill with the Skill tool or `/name` fails by design. Claude reads its `SKILL.md` through the index instead, so a skill that depends on `!` command injection or `$ARGUMENTS` substitution loses those while shelved. Use `name-only` for those.
- Project skills are read from `.claude/skills` in the current directory only, not from parent directories.
- `suggest` counts what the transcripts record. Skills used from other machines, or in transcripts already cleaned up (`cleanupPeriodDays`), are not counted.

## Related projects

- [jev-skill-gate](https://github.com/ShivamPansuriya/jev-skill-gate) (MIT) scores every skill against the current project at session start, with TypeSafe's Jev or a local TF-IDF scorer, and writes `skillOverrides` (`on`, `name-only`, `user-invocable-only`, never `off`), project-local by default. It answers "is this skill relevant here?"; skill-shelf answers "do I use this skill at all?" and keeps the hidden ones reachable. They can run together with care: jev-skill-gate does not touch overrides it did not write, skill-shelf's hook skips skills that already have an entry, and skills jev-skill-gate sets to `user-invocable-only` show up in skill-shelf's index. A skill both tools manage ends up with whatever was written last, and jev-skill-gate's project-local entries win over skill-shelf's user-level ones, so give each skill to one tool.
- [SkillPort](https://github.com/gotalab/skillport) (MIT) installs and validates skills and serves them through an MCP server with search and load tools, so the agent only holds metadata until it loads a skill. It replaces the native listing instead of trimming it.

## License

Apache-2.0. See LICENSE and NOTICE.
