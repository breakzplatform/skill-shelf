import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HIDDEN_STATES = new Set(["off", "user-invocable-only"]);
const VALID_STATES = new Set(["on", "name-only", "user-invocable-only", "off"]);
const NAME_PATTERN = /^[A-Za-z0-9._:*?-]+$/;
const DESCRIPTION_LIMIT = 240;

export function paths({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const claude = path.join(home, ".claude");
  return {
    userSkills: path.join(claude, "skills"),
    userSettings: path.join(claude, "settings.json"),
    config: path.join(claude, "skill-shelf.json"),
    state: path.join(claude, "skill-shelf.state.json"),
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

// Reads only the top-level `name` and `description` keys, including folded (>) and
// literal (|) block scalars; a full YAML parser would be a dependency for two fields.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result = {};
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[i]);
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

// Writes through symlinks (dotfile setups often link settings.json) and swaps the file
// in with a rename, so a crash never leaves half-written settings behind.
export function writeJsonAtomic(file, data) {
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
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode });
  fs.renameSync(temporary, target);
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

export function loadConfig(file) {
  const config = readJson(file, {});
  return { patterns: Array.isArray(config.patterns) ? config.patterns.filter((p) => typeof p === "string") : [] };
}

function allSkills(locations) {
  return [
    ...discoverSkills(locations.userSkills, "user"),
    ...discoverSkills(locations.projectSkills, "project"),
  ];
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

export function shelve(locations, name, { project = false } = {}) {
  assertValidName(name);
  const skills = allSkills(locations);
  const targets = resolveTargets(skills, name);
  if (targets.length === 0 && !isPattern(name)) throw new Error(`no installed skill named ${name}`);
  const changes = Object.fromEntries(targets.map((skill) => [skill.name, "off"]));
  setOverrides(project ? locations.projectLocalSettings : locations.userSettings, changes);
  if (isPattern(name) && !project) {
    const config = readJson(locations.config, {});
    const patterns = new Set(loadConfig(locations.config).patterns);
    patterns.add(name);
    writeJsonAtomic(locations.config, { ...config, patterns: [...patterns].sort() });
  }
  markSeen(locations, skills);
  return targets.map((skill) => skill.name);
}

export function unshelve(locations, name, { project = false } = {}) {
  assertValidName(name);
  const targets = resolveTargets(allSkills(locations), name);
  if (targets.length === 0 && !isPattern(name)) throw new Error(`no installed skill named ${name}`);
  // An explicit "on" (not a deleted key) keeps a later pattern from shelving it again.
  const changes = Object.fromEntries(targets.map((skill) => [skill.name, "on"]));
  setOverrides(project ? locations.projectLocalSettings : locations.userSettings, changes);
  if (isPattern(name) && !project) {
    const config = readJson(locations.config, {});
    const { patterns } = loadConfig(locations.config);
    if (patterns.includes(name)) {
      writeJsonAtomic(locations.config, { ...config, patterns: patterns.filter((p) => p !== name) });
    }
  }
  return targets.map((skill) => skill.name);
}

function markSeen(locations, skills) {
  const state = readJson(locations.state, {});
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const before = seen.size;
  for (const skill of skills) seen.add(skill.file);
  if (seen.size !== before) writeJsonAtomic(locations.state, { ...state, seen: [...seen].sort() });
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
      if (patterns.some((pattern) => matches(pattern, skill.name))) {
        changes[skill.name] = "off";
        shelved.push(skill.name);
      }
    }
    if (Object.keys(changes).length > 0) setOverrides(file, changes);
  }
  markSeen(locations, skills);
  return shelved;
}

export function shelvedSkills(locations) {
  const overrides = effectiveOverrides(locations);
  const byName = new Map();
  // Claude Code runs the personal skill when a project skill has the same name, and
  // allSkills lists personal ones first.
  for (const skill of allSkills(locations)) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].filter((skill) => HIDDEN_STATES.has(overrides[skill.name]));
}

function shorten(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_LIMIT ? `${flat.slice(0, DESCRIPTION_LIMIT - 1)}…` : flat;
}

export function renderIndex(locations) {
  const skills = shelvedSkills(locations);
  if (skills.length === 0) return "No skills are shelved.";
  const lines = skills.map((skill) => `- **${skill.name}**: ${shorten(skill.description) || "(no description)"} — \`${skill.file}\``);
  return [`${skills.length} shelved skills. Read the SKILL.md of the one that fits and follow it:`, "", ...lines].join("\n");
}

export function renderList(locations) {
  const skills = shelvedSkills(locations);
  const { patterns } = loadConfig(locations.config);
  const overrides = effectiveOverrides(locations);
  const out = [`Patterns: ${patterns.length ? patterns.join(", ") : "(none)"}`, `Shelved: ${skills.length}`];
  for (const skill of skills) out.push(`  ${skill.name} [${overrides[skill.name]}, ${skill.scope}]`);
  return out.join("\n");
}
