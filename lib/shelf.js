import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HIDDEN_STATES = new Set(["off", "user-invocable-only"]);
export const SHELF_LEVELS = new Set(["off", "name-only"]);
const VALID_STATES = new Set(["on", "name-only", "user-invocable-only", "off"]);
// How much of a skill each state keeps out of Claude's listing; a pattern match never lowers it.
const RESTRICTIVENESS = { on: 0, "name-only": 1, "user-invocable-only": 2, off: 3 };
const NAME_PATTERN = /^[A-Za-z0-9._:*?-]+$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]+$/;
const DESCRIPTION_LIMIT = 240;
const SESSION_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FRONTMATTER_KEYS = /^(name|description|disable-model-invocation):\s*(.*)$/;

export function paths({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const claude = path.join(home, ".claude");
  return {
    home,
    userSkills: path.join(claude, "skills"),
    userSettings: path.join(claude, "settings.json"),
    config: path.join(claude, "skill-shelf.json"),
    state: path.join(claude, "skill-shelf.state.json"),
    transcripts: path.join(claude, "projects"),
    projectSkills: path.join(cwd, ".claude", "skills"),
    projectSettings: path.join(cwd, ".claude", "settings.json"),
    projectLocalSettings: path.join(cwd, ".claude", "settings.local.json"),
  };
}

export function assertValidName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(`invalid skill name or pattern: ${JSON.stringify(name)}`);
  }
}

export function isPattern(name) {
  return /[*?]/.test(name);
}

export function matches(pattern, name) {
  const source = pattern
    .split("")
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`).test(name);
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(["']).*\1$/s.test(trimmed)) {
    const inner = trimmed.slice(1, -1);
    return trimmed[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return trimmed;
}

// Reads only the few top-level keys skill-shelf needs, including folded (>) and literal (|)
// block scalars; a full YAML parser would be a dependency for three fields.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result = {};
  for (let i = 0; i < lines.length; i++) {
    const field = FRONTMATTER_KEYS.exec(lines[i]);
    if (!field) continue;
    const [, key, rest] = field;
    if (/^[>|][+-]?\s*$/.test(rest)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        block.push(lines[++i].trim());
      }
      result[key] = block.join(rest.startsWith(">") ? " " : "\n").trim();
    } else {
      result[key] = unquote(rest);
    }
  }
  return result;
}

export function discoverSkills(directory, scope) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const file = path.join(directory, entry.name, "SKILL.md");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const meta = parseFrontmatter(text);
    skills.push({
      name: meta.name || entry.name,
      description: meta.description || "",
      // Left out of the listing anyway, so shelving them saves nothing.
      manual: meta["disable-model-invocation"] === "true",
      file,
      scope,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  if (text.trim() === "") return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON, refusing to touch it: ${error.message}`);
  }
}

function writeFileAtomic(file, content) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.skill-shelf-${process.pid}.tmp`;
  let mode = 0o644;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {}
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, target);
}

// Writes through symlinks (dotfile setups often link settings.json) and swaps the file
// in with a rename, so a crash never leaves half-written settings behind.
export function writeJsonAtomic(file, data) {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readOverrides(file) {
  const settings = readJson(file, {});
  const overrides = settings.skillOverrides;
  return overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
}

export function setOverrides(file, changes) {
  const settings = readJson(file, {});
  const overrides = { ...(settings.skillOverrides || {}) };
  let changed = false;
  for (const [name, state] of Object.entries(changes)) {
    if (!VALID_STATES.has(state)) throw new Error(`invalid state ${state}`);
    if (overrides[name] !== state) {
      overrides[name] = state;
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(file, { ...settings, skillOverrides: overrides });
  return changed;
}

// A pattern is stored as a plain string when its level is "off" (the 0.1 format) and as
// {pattern, level} otherwise.
function normalizePattern(entry) {
  if (typeof entry === "string") return { pattern: entry, level: "off" };
  if (entry && typeof entry.pattern === "string" && SHELF_LEVELS.has(entry.level)) {
    return { pattern: entry.pattern, level: entry.level };
  }
  return null;
}

export function loadConfig(file) {
  const config = readJson(file, {});
  const patterns = Array.isArray(config.patterns) ? config.patterns.map(normalizePattern).filter(Boolean) : [];
  return { patterns };
}

function savePatterns(file, patterns) {
  const config = readJson(file, {});
  const sorted = [...patterns].sort((a, b) => a.pattern.localeCompare(b.pattern));
  const stored = sorted.map(({ pattern, level }) => (level === "off" ? pattern : { pattern, level }));
  writeJsonAtomic(file, { ...config, patterns: stored });
}

// Run from the home folder, the project skills folder is the user one.
export function allSkills(locations) {
  const user = discoverSkills(locations.userSkills, "user");
  if (path.resolve(locations.projectSkills) === path.resolve(locations.userSkills)) return user;
  return [...user, ...discoverSkills(locations.projectSkills, "project")];
}

// When a personal and a project skill share a name, the personal one runs, and
// allSkills lists personal ones first.
export function uniqueSkills(locations) {
  const byName = new Map();
  for (const skill of allSkills(locations)) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

// Later files win per skill name, mirroring user < project < local settings precedence.
export function effectiveOverrides(locations) {
  return {
    ...readOverrides(locations.userSettings),
    ...readOverrides(locations.projectSettings),
    ...readOverrides(locations.projectLocalSettings),
  };
}

function settingsFor(locations, scope) {
  return scope === "project" ? locations.projectLocalSettings : locations.userSettings;
}

function resolveTargets(skills, name) {
  return skills.filter((skill) => matches(name, skill.name));
}

export function shelve(locations, name, { project = false, level = "off" } = {}) {
  assertValidName(name);
  if (!SHELF_LEVELS.has(level)) throw new Error(`invalid shelf level ${level}`);
  const skills = allSkills(locations);
  const targets = resolveTargets(skills, name);
  if (targets.length === 0 && !isPattern(name)) throw new Error(`no installed skill named ${name}`);
  const changes = Object.fromEntries(targets.map((skill) => [skill.name, level]));
  setOverrides(settingsFor(locations, project ? "project" : "user"), changes);
  if (isPattern(name) && !project) {
    const { patterns } = loadConfig(locations.config);
    savePatterns(locations.config, [...patterns.filter((entry) => entry.pattern !== name), { pattern: name, level }]);
  }
  markSeen(locations, skills);
  refreshIndexes(locations);
  return targets.map((skill) => skill.name);
}

export function unshelve(locations, name, { project = false } = {}) {
  assertValidName(name);
  const targets = resolveTargets(allSkills(locations), name);
  if (targets.length === 0 && !isPattern(name)) throw new Error(`no installed skill named ${name}`);
  // An explicit "on" (not a deleted key) keeps a later pattern from shelving it again.
  const changes = Object.fromEntries(targets.map((skill) => [skill.name, "on"]));
  setOverrides(settingsFor(locations, project ? "project" : "user"), changes);
  if (isPattern(name) && !project) {
    const { patterns } = loadConfig(locations.config);
    if (patterns.some((entry) => entry.pattern === name)) {
      savePatterns(locations.config, patterns.filter((entry) => entry.pattern !== name));
    }
  }
  refreshIndexes(locations);
  return targets.map((skill) => skill.name);
}

function markSeen(locations, skills) {
  const state = readJson(locations.state, {});
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const before = seen.size;
  for (const skill of skills) seen.add(skill.file);
  if (seen.size !== before) writeJsonAtomic(locations.state, { ...state, seen: [...seen].sort() });
}

function strictestLevel(patterns, name) {
  let level = null;
  for (const entry of patterns) {
    if (!matches(entry.pattern, name)) continue;
    if (level === null || RESTRICTIVENESS[entry.level] > RESTRICTIVENESS[level]) level = entry.level;
  }
  return level;
}

// Shelves skills that appeared since the last run and match a pattern. A skill that was
// already seen is left alone, so turning it back on in /skills sticks.
export function reconcile(locations) {
  const skills = allSkills(locations);
  const { patterns } = loadConfig(locations.config);
  if (patterns.length === 0) return [];
  const state = readJson(locations.state, {});
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const shelved = [];
  for (const scope of ["user", "project"]) {
    const file = settingsFor(locations, scope);
    const existing = readOverrides(file);
    const changes = {};
    for (const skill of skills) {
      if (skill.scope !== scope || seen.has(skill.file) || skill.name in existing) continue;
      const level = strictestLevel(patterns, skill.name);
      if (level) {
        changes[skill.name] = level;
        shelved.push(skill.name);
      }
    }
    if (Object.keys(changes).length > 0) setOverrides(file, changes);
  }
  markSeen(locations, skills);
  if (shelved.length > 0) refreshIndexes(locations);
  return shelved;
}

export function shelvedSkills(locations) {
  const overrides = effectiveOverrides(locations);
  return uniqueSkills(locations).filter((skill) => HIDDEN_STATES.has(overrides[skill.name]));
}

function shorten(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_LIMIT ? `${flat.slice(0, DESCRIPTION_LIMIT - 1)}…` : flat;
}

// Only hidden skills: a name-only skill is still in Claude's listing and invocable as is.
export function renderIndex(locations) {
  const skills = shelvedSkills(locations);
  if (skills.length === 0) return "No skills are shelved.";
  const lines = skills.map((skill) => `- **${skill.name}**: ${shorten(skill.description) || "(no description)"} — \`${skill.file}\``);
  return [`${skills.length} shelved skills. Read the SKILL.md of the one that fits and follow it:`, "", ...lines].join("\n");
}

export function renderList(locations) {
  const overrides = effectiveOverrides(locations);
  const skills = uniqueSkills(locations).filter((skill) => overrides[skill.name] && overrides[skill.name] !== "on");
  const { patterns } = loadConfig(locations.config);
  const shown = patterns.map(({ pattern, level }) => (level === "off" ? pattern : `${pattern} (${level})`));
  const hidden = skills.filter((skill) => HIDDEN_STATES.has(overrides[skill.name])).length;
  const out = [
    `Patterns: ${shown.length ? shown.join(", ") : "(none)"}`,
    `Shelved: ${hidden}`,
    `Name-only: ${skills.length - hidden}`,
  ];
  for (const skill of skills) out.push(`  ${skill.name} [${overrides[skill.name]}, ${skill.scope}]`);
  return out.join("\n");
}

// Pre-rendered index files, one per session, under the plugin's data directory. The index
// skill Reads ${CLAUDE_PLUGIN_DATA}/sessions/${CLAUDE_SESSION_ID}.md, so it works where `!`
// command injection does not: shell execution disabled, or a -p run in which an injected
// command that is not pre-approved aborts the whole skill invocation.
const SESSION_HEADER = /^<!-- skill-shelf (\{.*\}) -->\n/;

function sessionsDirectory(locations) {
  const { dataDir } = readJson(locations.state, {});
  return typeof dataDir === "string" && dataDir ? path.join(dataDir, "sessions") : null;
}

export function sessionIndexFile(dataDir, sessionId) {
  return path.join(dataDir, "sessions", `${sessionId}.md`);
}

function writeSessionIndex(file, home, session) {
  const content = renderIndex(paths({ home, cwd: session.cwd }));
  writeFileAtomic(file, `<!-- skill-shelf ${JSON.stringify(session)} -->\n${content}\n`);
}

export function registerSession(locations, { sessionId, dataDir, cwd, now = Date.now() }) {
  if (!dataDir || !sessionId || !SESSION_PATTERN.test(sessionId)) return null;
  const state = readJson(locations.state, {});
  if (state.dataDir !== dataDir) writeJsonAtomic(locations.state, { ...state, dataDir });
  const file = sessionIndexFile(dataDir, sessionId);
  let started = now;
  try {
    started = JSON.parse(SESSION_HEADER.exec(fs.readFileSync(file, "utf8"))[1]).started ?? now;
  } catch {}
  writeSessionIndex(file, locations.home, { cwd, started });
  return file;
}

// Rewrites every session's index after a change. Best effort: an unreadable index file
// must never make shelve or the hook fail. Sessions older than 30 days are dropped; the
// index skill then falls back to running the CLI.
export function refreshIndexes(locations, { now = Date.now() } = {}) {
  let directory;
  let entries;
  try {
    directory = sessionsDirectory(locations);
    if (!directory) return 0;
    entries = fs.readdirSync(directory).filter((entry) => entry.endsWith(".md"));
  } catch {
    return 0;
  }
  let refreshed = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry);
    try {
      const session = JSON.parse(SESSION_HEADER.exec(fs.readFileSync(file, "utf8"))[1]);
      if (typeof session.cwd !== "string" || !(now - session.started <= SESSION_INDEX_MAX_AGE_MS)) {
        fs.unlinkSync(file);
        continue;
      }
      writeSessionIndex(file, locations.home, session);
      refreshed++;
    } catch {}
  }
  return refreshed;
}
