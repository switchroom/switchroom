/**
 * skill-search.ts — Phase 3 of #1819 (RFC v3 §6.3).
 *
 * Read-only enumeration across the three skill tiers an agent can see:
 *
 *   personal:  <agentDir>/.claude/skills/personal-<name>/SKILL.md
 *              (the per-agent workspace authored via Phase 1 ops)
 *   shared:    ~/.switchroom/skills/<name>/SKILL.md
 *              (operator-curated pool; `switchroom skill apply` lands here)
 *   bundled:   ~/.switchroom/skills/_bundled/<name>/SKILL.md
 *              (shipped with switchroom, mirrored on every `switchroom update`)
 *
 * No write. No approval. Pure `readdirSync` + frontmatter parse. The
 * RFC's optional `installed_by` filter (cross-agent enumeration) is
 * deliberately deferred to a follow-up — the current op returns enough
 * for "should I author X, or does it already exist?" which is the
 * dominant use case.
 *
 * Surface
 *   CLI:  switchroom skill search [--agent <a>] [--query <q>] [--tier <t>] [--json] [--limit N]
 *   MCP:  skill_search { agent?, query?, tier?, limit? }
 */

import { Command, Option } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { withConfigError } from "./helpers.js";

// ─── Tier paths ──────────────────────────────────────────────────────

const PERSONAL_PREFIX = "personal-";
const BUNDLED_SUBDIR = "_bundled";

/**
 * Agent name regex — same shape used by `src/agents/lifecycle.ts` for
 * the live fleet. Rejects path-traversal sequences (e.g. `..`, `/`, `\`)
 * BEFORE the value is joined into a filesystem path. Same defence the
 * personal-skill writer applies in PR-3.
 */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

function defaultAgentsRoot(): string {
  return resolve(homedir(), ".switchroom/agents");
}

function defaultSharedRoot(): string {
  return resolve(homedir(), ".switchroom/skills");
}

function defaultBundledRoot(): string {
  return resolve(homedir(), ".switchroom/skills/_bundled");
}

// ─── Frontmatter reader (lenient) ────────────────────────────────────

/**
 * Read + parse SKILL.md frontmatter without enforcing the strict
 * `validateSkillMd` rules (which require `name` to equal a specific
 * slug). For search we want to ENUMERATE — a malformed skill should
 * still surface in the result so the operator can find + fix it.
 *
 * Returns null only if the file is unreadable. Returns a result with
 * `error: <reason>` if the frontmatter is structurally broken, so the
 * caller can render it as `<broken: ...>` in the listing.
 */
export interface FrontmatterRead {
  /** Parsed top-level keys (best-effort, only present on success). */
  fm?: Record<string, unknown>;
  /** Reason the SKILL.md couldn't be parsed (only on failure). */
  error?: string;
}

export function readSkillFrontmatter(skillDir: string): FrontmatterRead | null {
  const mdPath = join(skillDir, "SKILL.md");
  if (!existsSync(mdPath)) return null;
  let content: string;
  try {
    content = readFileSync(mdPath, "utf-8");
  } catch {
    return null;
  }
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { error: "no leading `---` frontmatter delimiter" };
  }
  const rest = content.slice(content.indexOf("\n") + 1);
  const endIdx = rest.indexOf("\n---");
  if (endIdx < 0) return { error: "no closing `---` delimiter" };
  const fmText = rest.slice(0, endIdx);
  let parsed: unknown;
  try {
    parsed = parseYaml(fmText);
  } catch (e) {
    return { error: `yaml parse: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "frontmatter is not a mapping" };
  }
  return { fm: parsed as Record<string, unknown> };
}

// ─── Tier enumeration ────────────────────────────────────────────────

export type Tier = "personal" | "shared" | "bundled";

export interface SkillSearchEntry {
  /** Skill slug as it appears in the directory name (after the `personal-` strip for personal tier). */
  name: string;
  tier: Tier;
  /** Absolute path to the skill directory. */
  path: string;
  /** SKILL.md file size in bytes. */
  size: number;
  /** SKILL.md mtime (ISO-8601, UTC). */
  mtime: string;
  /** Best-effort frontmatter. Empty object on parse failure. */
  frontmatter: Record<string, unknown>;
  /** Parse error if the frontmatter was malformed. */
  error?: string;
  /** Agent name if tier=personal, else undefined. */
  agent?: string;
}

function statSkillMd(skillDir: string): { size: number; mtime: string } | null {
  const mdPath = join(skillDir, "SKILL.md");
  try {
    const st = statSync(mdPath);
    return { size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** List personal skills for a single agent. */
export function listPersonalSkills(
  agent: string,
  agentsRoot = defaultAgentsRoot(),
): SkillSearchEntry[] {
  // Refuse path-traversal in the agent slug BEFORE it's joined into
  // `agentsRoot`. Otherwise an MCP caller passing `agent="../../etc"`
  // would read frontmatter from arbitrary dirs under the home UID.
  if (!AGENT_NAME_RE.test(agent)) return [];
  const skillsDir = join(agentsRoot, agent, ".claude/skills");
  if (!existsSync(skillsDir)) return [];
  const out: SkillSearchEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.startsWith(PERSONAL_PREFIX)) continue;
    const dirPath = join(skillsDir, ent);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const name = ent.slice(PERSONAL_PREFIX.length);
    const fmr = readSkillFrontmatter(dirPath);
    const stat = statSkillMd(dirPath);
    if (!stat) continue;
    out.push({
      name,
      tier: "personal",
      path: dirPath,
      size: stat.size,
      mtime: stat.mtime,
      frontmatter: fmr?.fm ?? {},
      error: fmr?.error,
      agent,
    });
  }
  return out;
}

/** List skills from the shared operator-curated pool (excludes `_bundled/`). */
export function listSharedSkills(
  sharedRoot = defaultSharedRoot(),
): SkillSearchEntry[] {
  if (!existsSync(sharedRoot)) return [];
  const out: SkillSearchEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(sharedRoot);
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (ent === BUNDLED_SUBDIR) continue;
    if (ent.startsWith(".")) continue;
    const dirPath = join(sharedRoot, ent);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const fmr = readSkillFrontmatter(dirPath);
    const stat = statSkillMd(dirPath);
    if (!stat) continue;
    out.push({
      name: ent,
      tier: "shared",
      path: dirPath,
      size: stat.size,
      mtime: stat.mtime,
      frontmatter: fmr?.fm ?? {},
      error: fmr?.error,
    });
  }
  return out;
}

/** List bundled skills (shipped with switchroom). */
export function listBundledSkills(
  bundledRoot = defaultBundledRoot(),
): SkillSearchEntry[] {
  if (!existsSync(bundledRoot)) return [];
  const out: SkillSearchEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(bundledRoot);
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (ent.startsWith(".")) continue;
    const dirPath = join(bundledRoot, ent);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const fmr = readSkillFrontmatter(dirPath);
    const stat = statSkillMd(dirPath);
    if (!stat) continue;
    out.push({
      name: ent,
      tier: "bundled",
      path: dirPath,
      size: stat.size,
      mtime: stat.mtime,
      frontmatter: fmr?.fm ?? {},
      error: fmr?.error,
    });
  }
  return out;
}

// ─── Search filter ───────────────────────────────────────────────────

/**
 * Case-insensitive substring match against (in order):
 *   - skill name
 *   - frontmatter.description
 *   - frontmatter.jtbd (RFC §6.4 extension)
 *
 * No fuzzy / no regex / no tokenisation. The corpus is small (10s of
 * entries) and the caller is an LLM that can pre-tokenise its own query.
 */
function matchesQuery(entry: SkillSearchEntry, q: string): boolean {
  const needle = q.toLowerCase();
  if (entry.name.toLowerCase().includes(needle)) return true;
  const desc = entry.frontmatter["description"];
  if (typeof desc === "string" && desc.toLowerCase().includes(needle)) {
    return true;
  }
  const jtbd = entry.frontmatter["jtbd"];
  if (typeof jtbd === "string" && jtbd.toLowerCase().includes(needle)) {
    return true;
  }
  return false;
}

export interface SearchOpts {
  agent?: string;
  query?: string;
  tier?: Tier | "any";
  limit?: number;
  // Test hooks.
  agentsRoot?: string;
  sharedRoot?: string;
  bundledRoot?: string;
}

export function searchSkills(opts: SearchOpts): SkillSearchEntry[] {
  const tier = opts.tier ?? "any";
  const wanted: Tier[] =
    tier === "any" ? ["personal", "shared", "bundled"] : [tier];

  let results: SkillSearchEntry[] = [];

  if (wanted.includes("personal")) {
    if (opts.agent) {
      results.push(
        ...listPersonalSkills(opts.agent, opts.agentsRoot),
      );
    }
    // No agent → personal tier yields zero (the caller scope is implicit).
  }
  if (wanted.includes("shared")) {
    results.push(...listSharedSkills(opts.sharedRoot));
  }
  if (wanted.includes("bundled")) {
    results.push(...listBundledSkills(opts.bundledRoot));
  }

  if (opts.query && opts.query.length > 0) {
    results = results.filter((e) => matchesQuery(e, opts.query!));
  }

  // Stable sort: tier (personal first, then shared, then bundled), then name.
  const tierOrder: Record<Tier, number> = {
    personal: 0,
    shared: 1,
    bundled: 2,
  };
  results.sort((a, b) => {
    const t = tierOrder[a.tier] - tierOrder[b.tier];
    if (t !== 0) return t;
    return a.name.localeCompare(b.name);
  });

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  return results.slice(0, limit);
}

// ─── CLI action ──────────────────────────────────────────────────────

interface CliOpts {
  agent?: string;
  query?: string;
  tier?: string;
  limit?: string;
  json?: boolean;
  // Test hooks (hidden options would be cleaner, but Commander loses them; pass via env in tests).
  root?: string;
  sharedRoot?: string;
  bundledRoot?: string;
}

export function searchAction(opts: CliOpts): void {
  let tier: SearchOpts["tier"] = "any";
  if (opts.tier) {
    if (
      opts.tier !== "personal" &&
      opts.tier !== "shared" &&
      opts.tier !== "bundled" &&
      opts.tier !== "any"
    ) {
      process.stderr.write(
        `error: --tier must be one of personal|shared|bundled|any (got ${opts.tier})\n`,
      );
      process.exit(2);
    }
    tier = opts.tier as SearchOpts["tier"];
  }

  let limit: number | undefined;
  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isFinite(n) || n < 1) {
      process.stderr.write(`error: --limit must be a positive integer\n`);
      process.exit(2);
    }
    limit = Math.floor(n);
  }

  // Default --agent to $SWITCHROOM_AGENT_NAME so an in-container agent
  // sees its own personal tier without having to pass --agent explicitly.
  // Mirrors the resolveAgent() helper in skill-personal.ts — but stays
  // optional here (no agent → personal tier yields zero, caller still gets
  // shared + bundled results). Closes #1827.
  const resolvedAgent =
    opts.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? undefined;

  const results = searchSkills({
    agent: resolvedAgent,
    query: opts.query,
    tier,
    limit,
    agentsRoot: opts.root,
    sharedRoot: opts.sharedRoot,
    bundledRoot: opts.bundledRoot,
  });

  if (opts.json !== false) {
    // MCP-friendly: always JSON. Human-readable mode is `--no-json`.
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Human-readable table.
  if (results.length === 0) {
    console.log("(no skills matched)");
    return;
  }
  for (const r of results) {
    const desc =
      typeof r.frontmatter["description"] === "string"
        ? (r.frontmatter["description"] as string).slice(0, 80)
        : r.error
          ? `<broken: ${r.error}>`
          : "";
    const where = r.agent ? `${r.tier}/${r.agent}` : r.tier;
    console.log(`${r.name.padEnd(40)} ${where.padEnd(16)} ${desc}`);
  }
}

// ─── CLI registration ────────────────────────────────────────────────

export function registerSkillSearchCommand(program: Command): void {
  // Find or create the `skill` parent (same pattern as skill-personal).
  let skill = program.commands.find((c) => c.name() === "skill");
  if (!skill) {
    skill = program.command("skill").description("Manage switchroom skills.");
  }

  skill
    .command("search")
    .description(
      "Enumerate skills across personal (per-agent), shared (operator pool), " +
        "and bundled (shipped) tiers. Read-only. Returns JSON by default " +
        "(stable shape for MCP callers); use --no-json for a human table.",
    )
    .option("-a, --agent <name>", "Caller agent (required for personal tier).")
    .option(
      "-q, --query <text>",
      "Case-insensitive substring match against name, description, jtbd.",
    )
    .option(
      "-t, --tier <tier>",
      "Filter to one tier: personal | shared | bundled | any (default any).",
    )
    .option(
      "-l, --limit <n>",
      "Cap result count (default 50, max 500).",
    )
    .option("--no-json", "Render as human table instead of JSON.")
    // Hidden test-only roots — never surface in --help.
    .addOption(new Option("--root <path>").hideHelp())
    .addOption(new Option("--shared-root <path>").hideHelp())
    .addOption(new Option("--bundled-root <path>").hideHelp())
    .action(withConfigError(async (opts: CliOpts) => {
      searchAction(opts);
    }));
}
