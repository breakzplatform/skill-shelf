import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  paths,
  readOverrides,
  reconcile,
  refreshIndexes,
  registerSession,
  renderIndex,
  renderList,
  sessionIndexFile,
  shelve,
  unshelve,
  writeJsonAtomic,
} from "../lib/shelf.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "skill-shelf.js");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-shelf-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const data = path.join(root, "plugin-data");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return { root, home, cwd, data, locations: paths({ home, cwd }) };
}

function addSkill(directory, folder, frontmatter) {
  fs.mkdirSync(path.join(directory, folder), { recursive: true });
  fs.writeFileSync(path.join(directory, folder, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function cli(home, cwd, args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: "utf8", env: { ...process.env, HOME: home, ...env },
  });
}

test("name-only: writes the level, remembers it on the pattern, stays out of the index", () => {
  const { locations } = sandbox();
  addSkill(locations.userSkills, "doc-a", "name: doc-a\ndescription: A");
  addSkill(locations.userSkills, "doc-b", "name: doc-b\ndescription: B");
  addSkill(locations.userSkills, "gone", "name: gone\ndescription: G");
  assert.deepEqual(shelve(locations, "doc-*", { level: "name-only" }), ["doc-a", "doc-b"]);
  shelve(locations, "gone");
  assert.deepEqual(readOverrides(locations.userSettings), { "doc-a": "name-only", "doc-b": "name-only", gone: "off" });
  assert.deepEqual(readJson(locations.config).patterns, [{ pattern: "doc-*", level: "name-only" }]);

  const index = renderIndex(locations);
  assert.match(index, /^1 shelved skills/);
  assert.ok(!index.includes("doc-a"), "name-only skills are already listed and invocable");

  const list = renderList(locations);
  assert.match(list, /Patterns: doc-\* \(name-only\)\nShelved: 1\nName-only: 2/);
  assert.match(list, /doc-a \[name-only, user\]/);
  assert.match(list, /gone \[off, user\]/);

  shelve(locations, "doc-*");
  assert.deepEqual(readJson(locations.config).patterns, ["doc-*"], "shelving the same glob again replaces its level");
  unshelve(locations, "doc-*");
  assert.deepEqual(readJson(locations.config).patterns, []);
  assert.throws(() => shelve(locations, "gone", { level: "user-invocable-only" }), /invalid shelf level/);
});

test("reconcile applies each pattern's level, the strictest one when several match", () => {
  const { locations } = sandbox();
  writeJsonAtomic(locations.config, {
    patterns: ["gsd-ship*", { pattern: "gsd-*", level: "name-only" }, { pattern: "bad" }, 7],
  });
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan");
  addSkill(locations.userSkills, "gsd-ship", "name: gsd-ship\ndescription: Ship");
  assert.deepEqual(reconcile(locations).sort(), ["gsd-plan", "gsd-ship"]);
  assert.deepEqual(readOverrides(locations.userSettings), { "gsd-plan": "name-only", "gsd-ship": "off" });
});

test("hook writes this session's index where the index skill reads it", () => {
  const { home, cwd, data, locations } = sandbox();
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan a phase");
  addSkill(locations.projectSkills, "local-only", "name: local-only\ndescription: Project skill");
  writeJsonAtomic(locations.userSettings, { skillOverrides: { "gsd-plan": "off" } });
  writeJsonAtomic(locations.projectLocalSettings, { skillOverrides: { "local-only": "off" } });

  const hook = cli(home, cwd, ["hook"], {
    input: JSON.stringify({ session_id: "abc-123", cwd, hook_event_name: "SessionStart" }),
    env: { CLAUDE_PLUGIN_DATA: data },
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "", "nothing new to shelve, so no output");

  // The same substitution the CLI applies to the skill body.
  const body = fs.readFileSync(path.join(ROOT, "skills", "index", "SKILL.md"), "utf8");
  const rendered = body.replaceAll("${CLAUDE_PLUGIN_DATA}", data).replaceAll("${CLAUDE_SESSION_ID}", "abc-123");
  const indexFile = /Read `([^`]+\.md)`/.exec(rendered)[1];
  assert.equal(indexFile, sessionIndexFile(data, "abc-123"));
  const index = fs.readFileSync(indexFile, "utf8");
  assert.match(index, /2 shelved skills/);
  assert.ok(index.includes(path.join(locations.userSkills, "gsd-plan", "SKILL.md")));
  assert.ok(index.includes("**local-only**"), "the session's project overrides count");

  const shelved = cli(home, path.join(home), ["unshelve", "gsd-plan"]);
  assert.equal(shelved.status, 0, shelved.stderr);
  const after = fs.readFileSync(indexFile, "utf8");
  assert.match(after, /1 shelved skills/, "unshelve from any directory refreshes every session index");
  assert.ok(after.includes("**local-only**"), "each session keeps its own project");
});

test("index skill does not depend on shell command injection", () => {
  const body = fs.readFileSync(path.join(ROOT, "skills", "index", "SKILL.md"), "utf8");
  assert.ok(!/(^|\s)!`/.test(body), "no inline injection");
  assert.ok(!body.includes("```!"), "no fenced injection");
  const [, frontmatter] = /^---\n([\s\S]*?)\n---/.exec(body);
  const command = /run exactly this command with Bash[^`]*`([^`]+)`/.exec(body)[1];
  assert.ok(frontmatter.includes(`Bash(${command})`), "the fallback command is pre-approved verbatim");
});

test("session index: invalid ids are ignored, old sessions pruned, broken files skipped", () => {
  const { data, locations } = sandbox();
  assert.equal(registerSession(locations, { sessionId: "../evil", dataDir: data, cwd: "/" }), null);
  assert.equal(registerSession(locations, { sessionId: "s1", dataDir: undefined, cwd: "/" }), null);
  assert.ok(!fs.existsSync(path.join(data, "sessions")));

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const old = registerSession(locations, { sessionId: "old", dataDir: data, cwd: locations.home, now: now - 31 * day });
  const fresh = registerSession(locations, { sessionId: "fresh", dataDir: data, cwd: locations.home, now });
  fs.writeFileSync(path.join(data, "sessions", "junk.md"), "not ours");
  assert.equal(refreshIndexes(locations, { now }), 1);
  assert.ok(!fs.existsSync(old), "a session older than 30 days is dropped");
  assert.ok(fs.existsSync(fresh));

  registerSession(locations, { sessionId: "fresh", dataDir: data, cwd: locations.home, now: now + day });
  assert.match(fs.readFileSync(fresh, "utf8"), new RegExp(`"started":${now}`), "re-registering keeps the start time");
});

test("CLI: several names at once, --name-only, and option errors", () => {
  const { home, cwd, locations } = sandbox();
  addSkill(locations.userSkills, "one", "name: one\ndescription: 1");
  addSkill(locations.userSkills, "two", "name: two\ndescription: 2");
  const result = cli(home, cwd, ["shelve", "one", "two", "--name-only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /set to name-only \(user\): one\nset to name-only \(user\): two/);
  assert.deepEqual(readOverrides(locations.userSettings), { one: "name-only", two: "name-only" });
  assert.equal(cli(home, cwd, ["unshelve", "one", "--name-only"]).status, 1);
  assert.match(cli(home, cwd, ["shelve", "one", "--light"]).stderr, /unknown option --light/);
  assert.match(cli(home, cwd, ["suggest", "--days", "zero"]).stderr, /positive whole number/);
});
