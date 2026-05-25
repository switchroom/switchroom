#!/usr/bin/env node
/**
 * observe-personal-skills.mjs
 *
 * Read-only observability for the #1819 agent-managed personal-skills
 * workflow. Run on the host (not in-container) to get a fleet-wide
 * snapshot:
 *
 *   - which agents have authored personal skills (and how many)
 *   - per-skill: name, file count, size, mtime
 *   - trash-dir contents (recently removed)
 *   - agent-config audit-log rows for skill.* commands, if any
 *
 * Purpose: feed the 60-day Phase 2 / shared-pool decision with real data.
 * If after 60 days no agent has authored a personal skill, the demand
 * for Phase 2 propose-publish-to-shared is presumably also low. If most
 * agents are authoring, Phase 2 becomes the priority.
 *
 * Usage:
 *
 *   node scripts/observe-personal-skills.mjs                # text report
 *   node scripts/observe-personal-skills.mjs --json         # machine-readable
 *   node scripts/observe-personal-skills.mjs --since 7d     # filter audit by age
 *
 * No writes. Safe to run any time, by any user (rows from dirs they
 * can't stat are silently skipped — same defensive pattern as the
 * existing src/cli/skill-search.ts helpers).
 */

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const PERSONAL_PREFIX = "personal-";
const TRASH_DIRNAME = "skills-trash";
const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const sinceIdx = args.indexOf("--since");
const sinceFilter = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

const sinceMs = parseSinceArg(sinceFilter);

function parseSinceArg(s) {
  if (!s) return 0;
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) {
    process.stderr.write(`error: --since must be like 7d, 24h, 30m (got ${s})\n`);
    process.exit(2);
  }
  const n = Number(m[1]);
  const unit = m[2];
  const factor = unit === "s" ? 1e3 : unit === "m" ? 60e3 : unit === "h" ? 3600e3 : 86400e3;
  return Date.now() - n * factor;
}

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of safeReaddir(cur)) {
      const sub = join(cur, ent);
      const st = safeStat(sub);
      if (!st) continue;
      if (st.isDirectory()) stack.push(sub);
      else if (st.isFile()) {
        bytes += st.size;
        files += 1;
      }
    }
  }
  return { files, bytes };
}

function enumerateAgent(agentDir) {
  const skillsDir = join(agentDir, ".claude", "skills");
  const trashDir = join(agentDir, ".claude", TRASH_DIRNAME);
  const personal = [];
  for (const ent of safeReaddir(skillsDir)) {
    if (!ent.startsWith(PERSONAL_PREFIX)) continue;
    const p = join(skillsDir, ent);
    const st = safeStat(p);
    if (!st?.isDirectory()) continue;
    const { files, bytes } = dirSize(p);
    personal.push({
      name: ent.slice(PERSONAL_PREFIX.length),
      path: p,
      files,
      bytes,
      mtime: st.mtime.toISOString(),
    });
  }
  const trash = [];
  for (const ent of safeReaddir(trashDir)) {
    const p = join(trashDir, ent);
    const st = safeStat(p);
    if (!st?.isDirectory()) continue;
    // Trash dirname: <name>-<unix-ts>
    const m = /^(.+)-(\d+)$/.exec(ent);
    const removedAt = m ? new Date(Number(m[2])).toISOString() : null;
    trash.push({
      name: m ? m[1] : ent,
      path: p,
      removed_at: removedAt,
    });
  }
  return { personal, trash };
}

function enumerateAuditLog(agent) {
  const audit = join(homedir(), ".switchroom", "audit", agent, "agent-config.jsonl");
  if (!existsSync(audit)) return [];
  let raw;
  try {
    raw = readFileSync(audit, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row.cmd?.startsWith("skill.")) continue;
      const ts = Date.parse(row.ts);
      if (sinceMs && ts < sinceMs) continue;
      rows.push(row);
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

const agentsRoot = join(homedir(), ".switchroom", "agents");
const fleet = safeReaddir(agentsRoot)
  .map((name) => ({ name, dir: join(agentsRoot, name) }))
  .filter((a) => safeStat(a.dir)?.isDirectory());

const report = fleet.map(({ name, dir }) => {
  const { personal, trash } = enumerateAgent(dir);
  const audit = enumerateAuditLog(name);
  return { agent: name, personal, trash, audit };
});

const summary = {
  generated_at: new Date().toISOString(),
  host_agents_root: agentsRoot,
  filter_since: sinceFilter ?? null,
  totals: {
    agents: report.length,
    agents_with_personal: report.filter((r) => r.personal.length > 0).length,
    personal_skills: report.reduce((n, r) => n + r.personal.length, 0),
    trash_entries: report.reduce((n, r) => n + r.trash.length, 0),
    audit_rows_skill_star: report.reduce((n, r) => n + r.audit.length, 0),
  },
  per_agent: report,
};

if (wantJson) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(0);
}

// Text report (operator-readable).
const { totals } = summary;
console.log(`# Personal-skills observability (${summary.generated_at})`);
console.log(``);
console.log(`Agents on host        : ${totals.agents}`);
console.log(`Agents with personals : ${totals.agents_with_personal}`);
console.log(`Personal skills total : ${totals.personal_skills}`);
console.log(`Trashed (recoverable) : ${totals.trash_entries}`);
console.log(`Audit rows (skill.*)  : ${totals.audit_rows_skill_star}${sinceFilter ? ` (since ${sinceFilter})` : ""}`);
console.log(``);

for (const r of report) {
  if (r.personal.length === 0 && r.trash.length === 0 && r.audit.length === 0) continue;
  console.log(`── ${r.agent} ──`);
  if (r.personal.length > 0) {
    console.log(`  personal skills:`);
    for (const p of r.personal) {
      console.log(`    ${p.name.padEnd(28)} files=${String(p.files).padStart(3)}  bytes=${String(p.bytes).padStart(7)}  mtime=${p.mtime}`);
    }
  }
  if (r.trash.length > 0) {
    console.log(`  trash (recoverable, 24h sweep):`);
    for (const t of r.trash) {
      console.log(`    ${t.name.padEnd(28)} removed_at=${t.removed_at ?? "<unknown>"}`);
    }
  }
  if (r.audit.length > 0) {
    const byCmd = new Map();
    for (const row of r.audit) byCmd.set(row.cmd, (byCmd.get(row.cmd) ?? 0) + 1);
    console.log(`  audit rows by cmd:`);
    for (const [cmd, n] of [...byCmd.entries()].sort()) {
      console.log(`    ${cmd.padEnd(28)} count=${n}`);
    }
  }
  console.log(``);
}

console.log(`(no-personal agents omitted from per-agent breakdown)`);
