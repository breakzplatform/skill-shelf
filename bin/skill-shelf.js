#!/usr/bin/env node
import fs from "node:fs";
import { paths, reconcile, registerSession, renderIndex, renderList, shelve, unshelve } from "../lib/shelf.js";
import { changeCommands, plannedChanges, renderSuggestion, suggest } from "../lib/suggest.js";

const USAGE = `Usage:
  skill-shelf shelve <name|glob>... [--name-only] [--project]
      hide skills from Claude (skillOverrides "off"); --name-only keeps the name
      listed and drops the description ("name-only")
  skill-shelf unshelve <name|glob>... [--project]
      bring them back (skillOverrides "on")
  skill-shelf list                 patterns, shelved and name-only skills
  skill-shelf index                markdown index of shelved skills
  skill-shelf suggest [--days N] [--often N] [--apply] [--project]
      propose a level per skill from your transcripts (default: last 30 days;
      3+ uses on, 1-2 name-only, none off); --apply makes the changes
  skill-shelf hook                 SessionStart: shelve new installs matching
                                   patterns and write this session's index

--project writes .claude/settings.local.json of the current directory instead of
~/.claude/settings.json. A glob without --project is also saved as a pattern, with
its level, so skills installed later that match it start shelved.`;

const FLAGS = new Set(["--project", "--name-only", "--apply"]);
const VALUE_OPTIONS = new Set(["--days", "--often"]);

function parseArguments(argv) {
  const flags = new Set();
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.has(arg)) flags.add(arg);
    else if (VALUE_OPTIONS.has(arg)) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} needs a positive whole number`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    else positional.push(arg);
  }
  return { command: positional[0], names: positional.slice(1), flags, options };
}

function readHookInput() {
  try {
    const text = fs.readFileSync(0, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function main(argv) {
  const { command, names, flags, options } = parseArguments(argv);
  const project = flags.has("--project");
  switch (command) {
    case "shelve":
    case "unshelve": {
      if (names.length === 0) throw new Error(USAGE);
      const level = flags.has("--name-only") ? "name-only" : "off";
      if (command === "unshelve" && flags.has("--name-only")) throw new Error("--name-only only applies to shelve");
      const scope = project ? "project" : "user";
      for (const name of names) {
        const changed = command === "shelve"
          ? shelve(paths(), name, { project, level })
          : unshelve(paths(), name, { project });
        const verb = command === "shelve" && level === "name-only" ? "set to name-only" : `${command}d`;
        console.log(changed.length ? `${verb} (${scope}): ${changed.join(", ")}` : `no installed skill matches ${name}`);
      }
      return;
    }
    case "list":
      console.log(renderList(paths()));
      return;
    case "index":
      console.log(renderIndex(paths()));
      return;
    case "suggest": {
      const locations = paths();
      const result = suggest(locations, options);
      console.log(renderSuggestion(result, { project }));
      if (!flags.has("--apply")) return;
      const groups = plannedChanges(result);
      for (const name of groups.off) shelve(locations, name, { project });
      for (const name of groups["name-only"]) shelve(locations, name, { project, level: "name-only" });
      for (const name of groups.on) unshelve(locations, name, { project });
      if (changeCommands(groups, { project }).length > 0) {
        console.log("\nApplied. Sessions started from now on see the new listing.");
      }
      return;
    }
    case "hook": {
      const input = readHookInput();
      const locations = paths({ cwd: input.cwd || process.cwd() });
      let shelved = [];
      // Each step runs even when the other fails, so a broken settings file elsewhere
      // still leaves this session an index to read.
      try {
        shelved = reconcile(locations);
      } catch (error) {
        console.error(`skill-shelf: ${error.message}`);
      }
      try {
        registerSession(locations, {
          sessionId: input.session_id,
          dataDir: process.env.CLAUDE_PLUGIN_DATA,
          cwd: input.cwd || process.cwd(),
        });
      } catch (error) {
        console.error(`skill-shelf: ${error.message}`);
      }
      if (shelved.length > 0) {
        console.log(JSON.stringify({
          systemMessage: `skill-shelf: shelved ${shelved.length} new skill(s): ${shelved.join(", ")}`,
          hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true },
        }));
      }
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== "help") process.exitCode = 1;
  }
}

try {
  if (process.argv[2] === "--help") console.log(USAGE);
  else main(process.argv.slice(2));
} catch (error) {
  console.error(`skill-shelf: ${error.message}`);
  // The hook must never block a session from starting.
  process.exitCode = process.argv[2] === "hook" ? 0 : 1;
}
