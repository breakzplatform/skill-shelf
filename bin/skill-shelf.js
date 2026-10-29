#!/usr/bin/env node
import fs from "node:fs";
import { paths, reconcile, renderIndex, renderList, shelve, unshelve } from "../lib/shelf.js";

const USAGE = `Usage:
  skill-shelf shelve <name|glob> [--project]    hide skills from Claude (skillOverrides "off")
  skill-shelf unshelve <name|glob> [--project]  bring them back (skillOverrides "on")
  skill-shelf list                              patterns and shelved skills
  skill-shelf index                             markdown index of shelved skills
  skill-shelf hook                              SessionStart: shelve new installs matching patterns

--project writes .claude/settings.local.json of the current directory instead of
~/.claude/settings.json. A glob without --project is also saved as a pattern, so
skills installed later that match it start shelved.`;

function readHookInput() {
  try {
    const text = fs.readFileSync(0, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function main(argv) {
  const project = argv.includes("--project");
  const [command, name] = argv.filter((arg) => arg !== "--project");
  switch (command) {
    case "shelve":
    case "unshelve": {
      if (!name) throw new Error(USAGE);
      const action = command === "shelve" ? shelve : unshelve;
      const names = action(paths(), name, { project });
      const scope = project ? "project" : "user";
      console.log(names.length ? `${command}d (${scope}): ${names.join(", ")}` : `no installed skill matches ${name}`);
      return;
    }
    case "list":
      console.log(renderList(paths()));
      return;
    case "index":
      console.log(renderIndex(paths()));
      return;
    case "hook": {
      const input = readHookInput();
      const shelved = reconcile(paths({ cwd: input.cwd || process.cwd() }));
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
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`skill-shelf: ${error.message}`);
  // The hook must never block a session from starting.
  process.exitCode = process.argv[2] === "hook" ? 0 : 1;
}
