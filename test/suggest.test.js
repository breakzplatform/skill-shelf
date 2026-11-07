import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { paths, readOverrides, writeJsonAtomic } from "../lib/shelf.js";
import { changeCommands, collectUsage, plannedChanges, renderSuggestion, suggest } from "../lib/suggest.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "skill-shelf.js");
const DAY = 24 * 60 * 60 * 1000;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-shelf-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return { home, cwd, locations: paths({ home, cwd }) };
}

function addSkill(directory, folder, frontmatter, { ageDays = 90 } = {}) {
  const file = path.join(directory, folder, "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\nbody\n`);
  const time = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(file, time, time);
  return file;
}

const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

function skillCall(id, skill, daysAgo = 1) {
  return {
    type: "assistant",
    timestamp: iso(daysAgo),
    message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] },
  };
}

function readCall(id, file, daysAgo = 1) {
  return {
    type: "assistant",
    timestamp: iso(daysAgo),
    message: { content: [{ type: "text", text: "reading" }, { type: "tool_use", id, name: "Read", input: { file_path: file } }] },
  };
}

function slash(uuid, name, daysAgo = 1) {
  return {
    type: "user",
    uuid,
    timestamp: iso(daysAgo),
    message: { content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>` },
  };
}

function writeTranscript(locations, relative, entries) {
  const file = path.join(locations.transcripts, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")}\n`);
  return file;
}

function fixture() {
  const box = sandbox();
  const { locations } = box;
  addSkill(locations.userSkills, "daily", "name: daily\ndescription: Used every day");
  addSkill(locations.userSkills, "sometimes", "name: sometimes\ndescription: Used once in a while");
  const shelvedFile = addSkill(locations.userSkills, "shelved-used", "name: shelved-used\ndescription: Read through the index");
  addSkill(locations.userSkills, "never", "name: never\ndescription: Never used");
  addSkill(locations.userSkills, "fresh", "name: fresh\ndescription: Installed yesterday", { ageDays: 1 });
  addSkill(locations.userSkills, "manual", "name: manual\ndescription: Typed only\ndisable-model-invocation: true");
  addSkill(locations.projectSkills, "local-tool", "name: local-tool\ndescription: Project skill");
  writeJsonAtomic(locations.userSettings, { skillOverrides: { "shelved-used": "off", sometimes: "off" } });

  writeTranscript(locations, "-proj-a/s1.jsonl", [
    skillCall("t1", "daily"),
    skillCall("t1", "daily"), // the same tool_use repeated (streamed twice) counts once
    skillCall("t2", "/daily"),
    slash("u1", "daily"),
    slash("u2", "sometimes"),
    readCall("t3", shelvedFile),
    readCall("t4", "/elsewhere/.claude/skills/shelved-used/SKILL.md"),
    readCall("t5", "/tmp/not-a-skill.md"),
    skillCall("t6", "never", 45), // outside the 30-day window
    skillCall("t7", "plugin:never"), // a plugin skill with the same short name
    { type: "api-request-shape", timestamp: iso(1), shape: { tools: [{ name: "Skill", description: "tool_use SKILL.md never" }] } },
    "{ not json tool_use Skill",
    { type: "user", uuid: "u3", timestamp: iso(1), message: { content: [{ type: "tool_result", content: "<command-name>/never</command-name>" }] } },
  ]);
  // A resumed session copies earlier entries: the same ids must not count twice.
  writeTranscript(locations, "-proj-a/s2.jsonl", [skillCall("t1", "daily"), slash("u1", "daily")]);
  writeTranscript(locations, "-proj-b/s3/subagents/agent-1.jsonl", [skillCall("t8", "local-tool")]);
  const stale = writeTranscript(locations, "-proj-c/old.jsonl", [skillCall("t9", "never", 1)]);
  fs.utimesSync(stale, new Date(Date.now() - 60 * DAY), new Date(Date.now() - 60 * DAY));
  return box;
}

test("collectUsage counts Skill calls, slash commands and SKILL.md reads once each", () => {
  const { locations } = fixture();
  const skills = ["daily", "sometimes", "shelved-used", "never", "local-tool"].map((name) => ({
    name,
    file: path.join(name === "local-tool" ? locations.projectSkills : locations.userSkills, name, "SKILL.md"),
  }));
  const usage = collectUsage(skills, { transcripts: locations.transcripts, since: Date.now() - 30 * DAY });
  assert.deepEqual(usage.get("daily"), { skill: 2, slash: 1, read: 0 });
  assert.deepEqual(usage.get("sometimes"), { skill: 0, slash: 1, read: 0 });
  assert.deepEqual(usage.get("shelved-used"), { skill: 0, slash: 0, read: 2 }, "by path, then by folder name");
  assert.deepEqual(usage.get("never"), { skill: 0, slash: 0, read: 0 });
  assert.deepEqual(usage.get("local-tool"), { skill: 1, slash: 0, read: 0 }, "subagent transcripts count");
});

test("suggest proposes tiers and skips manual skills", () => {
  const { locations } = fixture();
  const result = suggest(locations, { days: 30, often: 3 });
  const byName = Object.fromEntries(result.rows.map((row) => [row.name, row]));
  assert.equal(byName.manual, undefined, "disable-model-invocation skills are not in the listing");
  assert.equal(byName.daily.proposed, "on");
  assert.equal(byName.sometimes.proposed, "name-only");
  assert.equal(byName["shelved-used"].proposed, "name-only");
  assert.equal(byName["local-tool"].proposed, "name-only");
  assert.equal(byName.never.proposed, "off");
  assert.equal(byName.fresh.proposed, "off", "file dates are not trusted: copies and syncs reset them");

  const groups = plannedChanges(result);
  assert.deepEqual(groups, { off: ["fresh", "never"], "name-only": ["local-tool", "shelved-used", "sometimes"], on: [] });
  assert.deepEqual(changeCommands(groups), [
    "skill-shelf shelve fresh never",
    "skill-shelf shelve local-tool shelved-used sometimes --name-only",
  ]);
  assert.ok(result.listing.after < result.listing.before);

  const text = renderSuggestion(result);
  assert.match(text, /^Usage over the last 30 days/);
  assert.match(text, /daily\s+2\s+1\s+0\s+on\s+on/);
  assert.equal(renderSuggestion(result), text, "deterministic");
  assert.deepEqual(plannedChanges(suggest(locations, { often: 1 })).on, ["shelved-used", "sometimes"], "often 1 turns every used skill on");
});

test("CLI suggest prints without writing; --apply writes the plan", () => {
  const { home, cwd, locations } = fixture();
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
  const before = fs.readFileSync(locations.userSettings, "utf8");
  const preview = run(["suggest"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /skill-shelf shelve fresh never\n/);
  assert.equal(fs.readFileSync(locations.userSettings, "utf8"), before, "no --apply, no write");

  const applied = run(["suggest", "--apply", "--days", "30"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Applied\./);
  assert.deepEqual(readOverrides(locations.userSettings), {
    "shelved-used": "name-only",
    sometimes: "name-only",
    never: "off",
    fresh: "off",
    "local-tool": "name-only",
  });
  assert.match(run(["suggest"]).stdout, /Nothing to change\./);
});
