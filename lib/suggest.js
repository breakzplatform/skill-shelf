import fs from "node:fs";
import path from "node:path";
import { effectiveOverrides, HIDDEN_STATES, uniqueSkills } from "./shelf.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Subagent transcripts live one or two folders below the project folder.
const MAX_TRANSCRIPT_DEPTH = 3;
const SLASH_COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/g;
// Mirrors the per-entry cap on description + when_to_use in the listing.
const LISTING_DESCRIPTION_CAP = 1536;

function transcriptFiles(directory, since, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_TRANSCRIPT_DEPTH) files.push(...transcriptFiles(full, since, depth + 1));
    } else if (entry.name.endsWith(".jsonl")) {
      try {
        if (fs.statSync(full).mtimeMs >= since) files.push(full);
      } catch {}
    }
  }
  return files.sort();
}

function userText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text").map((block) => block.text).join("\n");
}

// Counts, per skill name, Skill tool calls, /name commands the user typed, and Reads of the
// skill's SKILL.md (how a shelved skill is used through the index). Lines are pre-filtered
// with plain substring checks, since transcripts run to gigabytes and most lines are
// irrelevant; request-shape lines carry the tool schemas, so they are skipped by type.
export function collectUsage(skills, { transcripts, since }) {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const byFile = new Map(skills.map((skill) => [path.resolve(skill.file), skill]));
  const byFolder = new Map();
  for (const skill of skills) {
    const folder = path.basename(path.dirname(skill.file));
    if (!byFolder.has(folder)) byFolder.set(folder, skill);
  }
  const usage = new Map(skills.map((skill) => [skill.name, { skill: 0, slash: 0, read: 0 }]));
  const counted = new Set();
  const count = (skill, kind, key) => {
    if (!skill || counted.has(key)) return;
    counted.add(key);
    usage.get(skill.name)[kind]++;
  };
  const skillForFile = (file) => {
    if (typeof file !== "string" || !file.endsWith("SKILL.md")) return null;
    return byFile.get(path.resolve(file)) || byFolder.get(path.basename(path.dirname(file))) || null;
  };

  for (const file of transcriptFiles(transcripts, since)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const toolCall = line.includes('"tool_use"') && (line.includes('"Skill"') || line.includes("SKILL.md"));
      const command = line.includes("<command-name>");
      if (!toolCall && !command) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (Date.parse(entry.timestamp) < since) continue;
      const content = entry.message && entry.message.content;
      if (entry.type === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (!block || block.type !== "tool_use" || !block.input) continue;
          if (block.name === "Skill") {
            const name = String(block.input.skill || "").replace(/^\//, "");
            count(byName.get(name), "skill", `tool:${block.id}`);
          } else if (block.name === "Read") {
            count(skillForFile(block.input.file_path), "read", `tool:${block.id}`);
          }
        }
      } else if (entry.type === "user") {
        let match;
        let position = 0;
        SLASH_COMMAND.lastIndex = 0;
        while ((match = SLASH_COMMAND.exec(userText(content)))) {
          count(byName.get(match[1]), "slash", `slash:${entry.uuid || file}:${position++}`);
        }
      }
    }
  }
  return usage;
}

function listingChars(skill, level) {
  if (level === "off" || level === "user-invocable-only" || skill.manual) return 0;
  const name = `- ${skill.name}`.length;
  if (level === "name-only") return name;
  return name + 2 + Math.min(skill.description.replace(/\s+/g, " ").trim().length, LISTING_DESCRIPTION_CAP);
}

// Roughly four characters per token; a ballpark for comparing levels, not a tokenizer.
export function estimateTokens(chars) {
  return Math.round(chars / 4);
}

export function suggest(locations, { days = 30, often = 3, now = Date.now() } = {}) {
  const since = now - days * DAY_MS;
  const overrides = effectiveOverrides(locations);
  const skills = uniqueSkills(locations).filter((skill) => !skill.manual);
  const usage = collectUsage(skills, { transcripts: locations.transcripts, since });
  const rows = skills.map((skill) => {
    const counts = usage.get(skill.name);
    const total = counts.skill + counts.slash + counts.read;
    const current = overrides[skill.name] || "on";
    const proposed = total >= often ? "on" : total > 0 ? "name-only" : "off";
    return { name: skill.name, scope: skill.scope, ...counts, total, current, proposed, skillRecord: skill };
  });
  const tierOrder = { on: 0, "name-only": 1, "user-invocable-only": 2, off: 3 };
  rows.sort((a, b) => tierOrder[a.proposed] - tierOrder[b.proposed] || b.total - a.total || a.name.localeCompare(b.name));
  const before = rows.reduce((sum, row) => sum + listingChars(row.skillRecord, row.current), 0);
  const after = rows.reduce((sum, row) => sum + listingChars(row.skillRecord, row.proposed), 0);
  return { days, often, rows, listing: { before, after } };
}

function sameTier(current, proposed) {
  if (proposed === "off") return HIDDEN_STATES.has(current);
  return current === proposed;
}

export function plannedChanges(result) {
  const groups = { off: [], "name-only": [], on: [] };
  for (const row of result.rows) {
    if (!sameTier(row.current, row.proposed)) groups[row.proposed].push(row.name);
  }
  for (const names of Object.values(groups)) names.sort((a, b) => a.localeCompare(b));
  return groups;
}

export function changeCommands(groups, { project = false } = {}) {
  const suffix = project ? " --project" : "";
  const commands = [];
  if (groups.off.length) commands.push(`skill-shelf shelve ${groups.off.join(" ")}${suffix}`);
  if (groups["name-only"].length) commands.push(`skill-shelf shelve ${groups["name-only"].join(" ")} --name-only${suffix}`);
  if (groups.on.length) commands.push(`skill-shelf unshelve ${groups.on.join(" ")}${suffix}`);
  return commands;
}

export function renderSuggestion(result, { project = false } = {}) {
  const header = ["skill", "tool", "slash", "read", "now", "proposed"];
  const table = result.rows.map((row) => [
    row.name,
    String(row.skill),
    String(row.slash),
    String(row.read),
    row.current,
    row.proposed,
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...table.map((cells) => cells[column].length)));
  const format = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  const groups = plannedChanges(result);
  const commands = changeCommands(groups, { project });
  const { before, after } = result.listing;
  return [
    `Usage over the last ${result.days} days (on: ${result.often}+ uses, name-only: 1-${result.often - 1}, off: none).`,
    "",
    format(header),
    ...table.map(format),
    "",
    `Listing estimate for these skills: ~${estimateTokens(before)} tokens now, ~${estimateTokens(after)} after.`,
    "",
    commands.length ? ["Commands:", ...commands.map((command) => `  ${command}`)].join("\n") : "Nothing to change.",
  ].join("\n");
}
