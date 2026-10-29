import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  matches,
  parseFrontmatter,
  paths,
  readOverrides,
  reconcile,
  renderIndex,
  setOverrides,
  shelve,
  shelvedSkills,
  unshelve,
  writeJsonAtomic,
} from "../lib/shelf.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "skill-shelf.js");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-shelf-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return { root, home, cwd, locations: paths({ home, cwd }) };
}

function addSkill(directory, folder, frontmatter) {
  fs.mkdirSync(path.join(directory, folder), { recursive: true });
  fs.writeFileSync(path.join(directory, folder, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("glob matching", () => {
  assert.ok(matches("gsd-*", "gsd-plan"));
  assert.ok(matches("gsd-*", "gsd-"));
  assert.ok(!matches("gsd-*", "my-gsd-plan"));
  assert.ok(matches("paseo-?", "paseo-a"));
  assert.ok(!matches("paseo-?", "paseo-ab"));
  assert.ok(matches("a.b", "a.b"));
  assert.ok(!matches("a.b", "axb"), "dots are literal");
  assert.ok(matches("exact", "exact"));
  assert.ok(!matches("exact", "exactly"));
});

test("frontmatter: plain, quoted and block scalars", () => {
  assert.deepEqual(parseFrontmatter("---\nname: one\ndescription: Does one thing\n---\n"), {
    name: "one",
    description: "Does one thing",
  });
  assert.equal(parseFrontmatter('---\ndescription: "Say \\"hi\\": now"\n---').description, 'Say "hi": now');
  assert.equal(parseFrontmatter("---\ndescription: 'it''s'\n---").description, "it's");
  assert.equal(
    parseFrontmatter("---\ndescription: >\n  first line\n  second line\nname: x\n---").description,
    "first line second line",
  );
  assert.deepEqual(parseFrontmatter("no frontmatter"), {});
});

test("setOverrides keeps unrelated settings and existing overrides", () => {
  const { locations } = sandbox();
  writeJsonAtomic(locations.userSettings, {
    model: "opus",
    permissions: { allow: ["Bash(ls)"] },
    skillOverrides: { kept: "name-only" },
  });
  assert.equal(setOverrides(locations.userSettings, { foo: "off" }), true);
  assert.equal(setOverrides(locations.userSettings, { foo: "off" }), false, "no write when nothing changes");
  assert.deepEqual(readJson(locations.userSettings), {
    model: "opus",
    permissions: { allow: ["Bash(ls)"] },
    skillOverrides: { kept: "name-only", foo: "off" },
  });
});

test("refuses to rewrite a settings file that is not valid JSON", () => {
  const { locations } = sandbox();
  fs.mkdirSync(path.dirname(locations.userSettings), { recursive: true });
  fs.writeFileSync(locations.userSettings, "{ broken");
  assert.throws(() => setOverrides(locations.userSettings, { foo: "off" }), /not valid JSON/);
  assert.equal(fs.readFileSync(locations.userSettings, "utf8"), "{ broken");
});

test("atomic write goes through a symlink and leaves no temp file", () => {
  const { root, locations } = sandbox();
  const real = path.join(root, "dotfiles-settings.json");
  fs.writeFileSync(real, "{}\n");
  fs.mkdirSync(path.dirname(locations.userSettings), { recursive: true });
  fs.symlinkSync(real, locations.userSettings);
  setOverrides(locations.userSettings, { foo: "off" });
  assert.ok(fs.lstatSync(locations.userSettings).isSymbolicLink(), "symlink preserved");
  assert.deepEqual(readJson(real).skillOverrides, { foo: "off" });
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith(".tmp")), []);
});

test("shelve a glob in user scope saves the pattern; unshelve restores and drops it", () => {
  const { locations } = sandbox();
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan a phase");
  addSkill(locations.userSkills, "gsd-ship", "name: gsd-ship\ndescription: Ship it");
  addSkill(locations.userSkills, "other", "name: other\ndescription: Stays");
  assert.deepEqual(shelve(locations, "gsd-*"), ["gsd-plan", "gsd-ship"]);
  assert.deepEqual(readOverrides(locations.userSettings), { "gsd-plan": "off", "gsd-ship": "off" });
  assert.deepEqual(readJson(locations.config).patterns, ["gsd-*"]);

  assert.deepEqual(unshelve(locations, "gsd-*"), ["gsd-plan", "gsd-ship"]);
  assert.deepEqual(readOverrides(locations.userSettings), { "gsd-plan": "on", "gsd-ship": "on" });
  assert.deepEqual(readJson(locations.config).patterns, []);
});

test("shelve rejects unknown exact names and unsafe input", () => {
  const { locations } = sandbox();
  assert.throws(() => shelve(locations, "missing"), /no installed skill/);
  assert.throws(() => shelve(locations, "a b"), /invalid/);
  assert.throws(() => shelve(locations, "$(rm -rf ~)"), /invalid/);
});

test("--project writes settings.local.json and wins over user scope", () => {
  const { locations } = sandbox();
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan");
  shelve(locations, "gsd-*");
  unshelve(locations, "gsd-*", { project: true });
  assert.deepEqual(readOverrides(locations.projectLocalSettings), { "gsd-plan": "on" });
  assert.deepEqual(readOverrides(locations.userSettings), { "gsd-plan": "off" }, "user scope untouched");
  assert.deepEqual(readJson(locations.config).patterns, ["gsd-*"], "project unshelve keeps the global pattern");
  assert.deepEqual(shelvedSkills(locations), []);
});

test("reconcile shelves only new skills matching a pattern, once", () => {
  const { locations } = sandbox();
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan");
  shelve(locations, "gsd-*");
  unshelve(locations, "gsd-plan");
  fs.writeFileSync(locations.userSettings, JSON.stringify({ skillOverrides: {} }));

  addSkill(locations.userSkills, "gsd-new", "name: gsd-new\ndescription: New one");
  addSkill(locations.projectSkills, "gsd-local", "name: gsd-local\ndescription: Project one");
  addSkill(locations.userSkills, "unrelated", "name: unrelated\ndescription: x");
  assert.deepEqual(reconcile(locations).sort(), ["gsd-local", "gsd-new"]);
  assert.deepEqual(readOverrides(locations.userSettings), { "gsd-new": "off" },
    "gsd-plan was seen before, so a key removed by /skills is not re-shelved");
  assert.deepEqual(readOverrides(locations.projectLocalSettings), { "gsd-local": "off" });

  setOverrides(locations.userSettings, { "gsd-new": "on" });
  assert.deepEqual(reconcile(locations), [], "second run is a no-op");
});

test("reconcile writes nothing when no pattern is configured", () => {
  const { locations } = sandbox();
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan");
  assert.deepEqual(reconcile(locations), []);
  assert.ok(!fs.existsSync(locations.state));
  assert.ok(!fs.existsSync(locations.userSettings));
});

test("reconcile respects an explicit entry set before the skill was seen", () => {
  const { locations } = sandbox();
  writeJsonAtomic(locations.config, { patterns: ["gsd-*"] });
  writeJsonAtomic(locations.userSettings, { skillOverrides: { "gsd-plan": "name-only" } });
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan");
  assert.deepEqual(reconcile(locations), []);
  assert.deepEqual(readOverrides(locations.userSettings), { "gsd-plan": "name-only" });
});

test("index lists hidden skills with paths, truncating long descriptions", () => {
  const { locations } = sandbox();
  addSkill(locations.userSkills, "folder-name", `description: ${"x".repeat(400)}`);
  addSkill(locations.userSkills, "visible", "name: visible\ndescription: shown");
  addSkill(locations.userSkills, "user-only", "name: user-only\ndescription: typed by hand");
  writeJsonAtomic(locations.userSettings, {
    skillOverrides: { "folder-name": "off", visible: "name-only", "user-only": "user-invocable-only" },
  });
  const index = renderIndex(locations);
  assert.match(index, /^2 shelved skills/);
  assert.match(index, /\*\*folder-name\*\*: x+…/, "name falls back to the folder");
  assert.ok(index.includes(path.join(locations.userSkills, "folder-name", "SKILL.md")));
  assert.ok(index.includes("**user-only**"));
  assert.ok(!index.includes("**visible**"), "name-only stays in Claude's list, so not indexed");
  assert.equal(renderIndex(sandbox().locations), "No skills are shelved.");
});

test("CLI: shelve, list and hook with a temp HOME", () => {
  const { home, cwd, locations } = sandbox();
  addSkill(locations.userSkills, "gsd-plan", "name: gsd-plan\ndescription: Plan");
  const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: "utf8", env: { ...process.env, HOME: home },
  });
  const shelved = run(["shelve", "gsd-*"]);
  assert.equal(shelved.status, 0, shelved.stderr);
  assert.match(shelved.stdout, /shelved \(user\): gsd-plan/);
  assert.match(run(["list"]).stdout, /Patterns: gsd-\*\nShelved: 1/);

  addSkill(locations.userSkills, "gsd-next", "name: gsd-next\ndescription: Next");
  const hook = run(["hook"], JSON.stringify({ cwd, hook_event_name: "SessionStart" }));
  assert.equal(hook.status, 0, hook.stderr);
  const output = JSON.parse(hook.stdout);
  assert.equal(output.hookSpecificOutput.reloadSkills, true);
  assert.match(output.systemMessage, /gsd-next/);
  assert.equal(run(["hook"], "{}").stdout, "", "quiet when nothing changed");

  fs.writeFileSync(locations.userSettings, "{ broken");
  const broken = run(["hook"], "{}");
  assert.equal(broken.status, 0, "hook never blocks a session");
  assert.match(broken.stderr, /not valid JSON/);
  assert.equal(run(["shelve", "gsd-next"]).status, 1);
});
