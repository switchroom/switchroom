/**
 * `switchroom skill create|edit|read|delete` — the AUTHOR half of the
 * agent-config broker's skill self-service surface (PR A of the
 * agent-skill-authoring feature).
 *
 * Agent scope ONLY in this PR. Writes land in
 *   `~/.switchroom/agents/<agent>/.claude/skills/<slug>/`
 * via atomic temp-dir → rename for create, single-file atomic
 * write for edit. Global scope ("/usr/share/skills/" / the bundled
 * pool) is a PR-B concern with operator-overwrite gating.
 *
 * Error codes (constants in `skill-common.ts`):
 *   - E_SKILL_AUTHOR_REQUIRES_INTERACTIVE (exit 11)
 *   - E_SKILL_VERSION_STALE               (exit 12)
 *   - E_SKILL_ALREADY_EXISTS              (exit 13)
 *   - E_SKILL_NOT_FOUND                   (exit 14)
 *   - E_SKILL_FILE_TOO_LARGE              (exit 15)
 *   - E_SKILL_BUNDLE_TOO_LARGE            (exit 15)
 *   - E_SKILL_INVALID_NAME                (exit 9)
 *   - E_SKILL_INVALID_PATH                (exit 9)
 *   - E_SKILL_INVALID_FRONTMATTER         (exit 9)
 *   - E_SKILL_SCOPE_DENIED                (exit 9)
 */

import type { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import {
  agentScopeSkillDir,
  agentScopeSkillsRoot,
  appendAudit,
  authorErr,
  authorExitCodeFor,
  authorshipMarkerName,
  ensureSkillsRoot,
  globalScopeSkillDir,
  globalScopeSkillsRoot,
  hasAuthorshipMarker,
  isCronTurn,
  listSkillFiles,
  MAX_FILES_PER_SKILL,
  MAX_SKILL_BYTES,
  readSkillFrontmatter,
  resolveGlobalScopeRoot,
  safeWriteFile,
  skillVersionToken,
  totalSkillBytes,
  validateRelPath,
  validateSkillMd,
  validateSkillName,
  type SkillAuthorError,
} from "./skill-common.js";
import { existsSync as fsExistsSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config/loader.js";

export type SkillScope = "agent" | "global";

/** Resolve whether `agent` is `admin: true` in the merged switchroom
 *  config. Used to gate global-scope writes (PR B).
 *
 *  Tests can inject `isAdminOverride` to bypass disk-loading the yaml. */
export function defaultIsAdmin(agent: string): boolean {
  try {
    const cfg = loadConfig();
    const slice = cfg.agents?.[agent] as { admin?: boolean } | undefined;
    return slice?.admin === true;
  } catch {
    return false;
  }
}

interface ScopeContext {
  scope: SkillScope;
  /** Absolute root dir for this scope (parent of all skill dirs). */
  rootDir: string;
  /** Absolute path to this specific skill's dir. */
  skillDir: string;
}

function resolveScope(
  agent: string,
  slug: string,
  scope: SkillScope | undefined,
  perAgentRoot: string | undefined,
  globalRoot: string | undefined,
  isAdminFn: (a: string) => boolean,
): ScopeContext | SkillAuthorError {
  const s: SkillScope = scope ?? "agent";
  if (s === "agent") {
    return {
      scope: "agent",
      rootDir: agentScopeSkillsRoot(agent, perAgentRoot),
      skillDir: agentScopeSkillDir(agent, slug, perAgentRoot),
    };
  }
  if (s === "global") {
    if (!isAdminFn(agent)) {
      return authorErr(
        "E_SKILL_SCOPE_DENIED",
        `global-scope skill authoring requires admin: true on agent "${agent}"`,
      );
    }
    const root = globalRoot ?? resolveGlobalScopeRoot();
    if (!fsExistsSync(root)) {
      return authorErr(
        "E_SKILL_GLOBAL_MOUNT_UNCONFIGURED",
        `global scope root ${root} is not present — the /skills-rw bind mount is missing (rebuild compose with admin: true)`,
      );
    }
    return {
      scope: "global",
      rootDir: globalScopeSkillsRoot(root),
      skillDir: globalScopeSkillDir(slug, root),
    };
  }
  return authorErr(
    "E_SKILL_SCOPE_DENIED",
    `unknown scope ${JSON.stringify(s)} — must be "agent" or "global"`,
  );
}

/**
 * Identity-pin enforcement.
 *
 * The original implementation only rejected cross-agent writes when
 * the env-pin was both set AND mismatched. That left a bypass: with
 * SWITCHROOM_AGENT_NAME unset, an attacker could pass --agent victim
 * and write into a peer's overlay. Fix: any explicit `agent` arg
 * REQUIRES the env-pin to be set AND to match. If `agent` is omitted
 * and the env-pin is unset, we also refuse (we have no idea who's
 * calling). Returns a sentinel-tagged object on failure so callers
 * can map to the right error code (E_AGENT_PIN_REQUIRED, exit 16).
 */
class AgentPinRequiredError extends Error {
  readonly kind = "pin-required" as const;
}

function resolveAgent(agent: string | undefined): string {
  const pinned = process.env.SWITCHROOM_AGENT_NAME;
  if (agent !== undefined) {
    if (!pinned) {
      throw new AgentPinRequiredError(
        `cross-agent skill writes require SWITCHROOM_AGENT_NAME to be set ` +
        `(got --agent=${agent} with no env-pin)`,
      );
    }
    if (agent !== pinned) {
      throw new AgentPinRequiredError(
        `cross-agent skill writes are denied: agent=${agent} but identity is pinned to ${pinned}`,
      );
    }
    return agent;
  }
  // No explicit agent → must have the env-pin to know who's calling.
  if (!pinned) {
    throw new AgentPinRequiredError(
      "agent name required: pass --agent (which must match SWITCHROOM_AGENT_NAME) or set SWITCHROOM_AGENT_NAME",
    );
  }
  return pinned;
}

function agentErrCode(e: unknown): SkillAuthorError {
  if (e instanceof AgentPinRequiredError) {
    return authorErr("E_AGENT_PIN_REQUIRED", e.message);
  }
  return authorErr("E_SKILL_SCOPE_DENIED", (e as Error).message);
}

function denyIfCron(env: NodeJS.ProcessEnv = process.env):
  | SkillAuthorError
  | null {
  if (isCronTurn(env)) {
    return authorErr(
      "E_SKILL_AUTHOR_REQUIRES_INTERACTIVE",
      "skill authoring is disabled in cron-fired turns — re-run the action from an interactive turn (DM the agent)",
    );
  }
  return null;
}

// ─── skillCreate ─────────────────────────────────────────────────────

export interface SkillCreateOpts {
  agent?: string;
  name: string;
  /** Map of skill-relative path → file content. MUST include SKILL.md. */
  files: Record<string, string>;
  /** Per-agent test root override (agent scope only). */
  root?: string;
  /** Scope: "agent" (default) or "global" (admin only, PR B). */
  scope?: SkillScope;
  /** Global-scope root override (defaults to /skills-rw via env). */
  globalRoot?: string;
  /** Admin lookup override (defaults to merged-config check). */
  isAdmin?: (agent: string) => boolean;
}

export interface SkillCreateResult {
  ok: true;
  slug: string;
  path: string;
  files: string[];
  version: string;
}

export function skillCreate(
  opts: SkillCreateOpts,
): SkillCreateResult | SkillAuthorError {
  const cronDeny = denyIfCron();
  if (cronDeny) return cronDeny;

  let agent: string;
  try { agent = resolveAgent(opts.agent); }
  catch (e) { return agentErrCode(e); }

  if (!validateSkillName(opts.name)) {
    return authorErr(
      "E_SKILL_INVALID_NAME",
      `skill name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(opts.name)}`,
    );
  }
  if (!opts.files || typeof opts.files !== "object") {
    return authorErr(
      "E_SKILL_INVALID_PATH",
      "files map is required (must include SKILL.md)",
    );
  }
  const relPaths = Object.keys(opts.files);
  if (relPaths.length === 0) {
    return authorErr(
      "E_SKILL_INVALID_PATH",
      "files map cannot be empty",
    );
  }
  if (relPaths.length > MAX_FILES_PER_SKILL) {
    return authorErr(
      "E_SKILL_BUNDLE_TOO_LARGE",
      `skill has ${relPaths.length} files (max ${MAX_FILES_PER_SKILL})`,
    );
  }
  if (!relPaths.includes("SKILL.md")) {
    return authorErr(
      "E_SKILL_INVALID_PATH",
      "files map must include SKILL.md at the root",
    );
  }
  for (const rel of relPaths) {
    if (!validateRelPath(rel)) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `path not in allowlist or unsafe: ${JSON.stringify(rel)}`,
      );
    }
  }
  // Aggregate-byte cap.
  let total = 0;
  for (const rel of relPaths) {
    total += Buffer.byteLength(opts.files[rel]!, "utf-8");
    if (total > MAX_SKILL_BYTES) {
      return authorErr(
        "E_SKILL_BUNDLE_TOO_LARGE",
        `aggregate skill size exceeds ${MAX_SKILL_BYTES} bytes`,
      );
    }
  }
  // SKILL.md frontmatter check.
  const fmCheck = validateSkillMd(opts.files["SKILL.md"]!, opts.name);
  if ("ok" in fmCheck && fmCheck.ok === false) return fmCheck;

  // Resolve scope (agent | global). Global requires admin + mount.
  const isAdminFn = opts.isAdmin ?? defaultIsAdmin;
  const sc = resolveScope(
    agent, opts.name, opts.scope, opts.root, opts.globalRoot, isAdminFn,
  );
  if ("ok" in sc && sc.ok === false) return sc;
  const ctx = sc as ScopeContext;
  // Refuse if the destination dir already exists.
  const destDir = ctx.skillDir;
  if (existsSync(destDir)) {
    return authorErr(
      "E_SKILL_ALREADY_EXISTS",
      `skill dir already exists: ${destDir}`,
    );
  }
  // Defensive: refuse if a stale symlink sits at the target path.
  // existsSync() above follows symlinks (so a dangling symlink reports
  // false), but we want to catch any leftover symlink whether dangling
  // or live. Only trigger on `isSymbolicLink()` — any other lstat hit
  // would have been caught by the existsSync check above (or is an
  // ENOENT race that's harmless).
  try {
    const st = lstatSync(destDir);
    if (st && st.isSymbolicLink()) {
      return authorErr(
        "E_SKILL_ALREADY_EXISTS",
        `symlink exists at ${destDir} — refuse to overwrite`,
      );
    }
  } catch {
    /* ENOENT — good, we want it absent */
  }

  if (ctx.scope === "agent") {
    ensureSkillsRoot(agent, opts.root);
  } else {
    // /skills-rw already exists (we checked above); create the slug parent.
    mkdirSync(ctx.rootDir, { recursive: true });
  }

  // B2 defence: refuse if any path component leading to skillsRoot is
  // itself a symlink. This catches the "swap .claude/skills for a
  // symlink to /tmp" attack BEFORE we materialize a stage dir under
  // the attacker-controlled location. Best-effort vs full TOCTOU; see
  // safeWriteFile() for the parent-walk invariant + O_EXCL pairing.
  const rootDir = ctx.rootDir;
  {
    // Walk every component of rootDir. lstatSync each one; refuse on
    // any symlink hit.
    const segs = rootDir.split(sep).filter((s) => s.length > 0);
    let cur = rootDir.startsWith(sep) ? sep : "";
    for (const seg of segs) {
      cur = cur === sep ? sep + seg : cur + sep + seg;
      try {
        const st = lstatSync(cur);
        if (st.isSymbolicLink()) {
          return authorErr(
            "E_SKILL_INVALID_PATH",
            `refuse to create under symlinked path component: ${cur}`,
          );
        }
      } catch {
        // Component doesn't exist yet — that's fine for the not-yet-
        // created tail of the path. Continue walking.
      }
    }
  }
  const stageDir = join(rootDir, `.staging-${opts.name}.${process.pid}.${Date.now()}`);
  mkdirSync(stageDir, { recursive: true });
  try {
    // Pre-create subdirs.
    const subdirs = new Set<string>();
    for (const rel of relPaths) {
      const d = dirname(rel);
      if (d !== ".") subdirs.add(d);
    }
    for (const sd of subdirs) {
      mkdirSync(join(stageDir, sd), { recursive: true });
    }
    for (const rel of relPaths) {
      const abs = join(stageDir, rel);
      const r = safeWriteFile(abs, stageDir, opts.files[rel]!, "create");
      if (r && "ok" in r && r.ok === false) {
        return r;
      }
    }
    renameSync(stageDir, destDir);
    // PR B operator-overwrite guard: drop an authorship marker on
    // global-scope creates so future edit/delete can verify ownership.
    // Agent-scope skills don't need a marker — the dir is already
    // per-agent.
    if (ctx.scope === "global") {
      try {
        writeFileSync(
          join(destDir, authorshipMarkerName(agent)),
          "",
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        // best-effort: even if marker write fails, the skill exists.
        // Surfacing this as a hard error would leave an orphan dir.
      }
    }
  } catch (e) {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
    return authorErr(
      "E_SKILL_INVALID_PATH",
      `failed to materialize skill: ${(e as Error).message}`,
    );
  }

  return {
    ok: true,
    slug: opts.name,
    path: destDir,
    files: relPaths,
    version: skillVersionToken(destDir),
  };
}

// ─── skillEdit ────────────────────────────────────────────────────────

export interface SkillEditOpts {
  agent?: string;
  name: string;
  file: string;
  content: string;
  /** Optimistic-concurrency token from a prior skillRead. */
  version: string;
  root?: string;
  scope?: SkillScope;
  globalRoot?: string;
  isAdmin?: (agent: string) => boolean;
}

export interface SkillEditResult {
  ok: true;
  slug: string;
  file: string;
  path: string;
  version: string;
}

export function skillEdit(
  opts: SkillEditOpts,
): SkillEditResult | SkillAuthorError {
  const cronDeny = denyIfCron();
  if (cronDeny) return cronDeny;

  let agent: string;
  try { agent = resolveAgent(opts.agent); }
  catch (e) { return agentErrCode(e); }

  if (!validateSkillName(opts.name)) {
    return authorErr(
      "E_SKILL_INVALID_NAME",
      `skill name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(opts.name)}`,
    );
  }
  if (!validateRelPath(opts.file)) {
    return authorErr(
      "E_SKILL_INVALID_PATH",
      `file path not in allowlist: ${JSON.stringify(opts.file)}`,
    );
  }
  if (typeof opts.content !== "string") {
    return authorErr("E_SKILL_INVALID_PATH", "content must be a string");
  }
  if (typeof opts.version !== "string" || opts.version.length === 0) {
    return authorErr(
      "E_SKILL_VERSION_STALE",
      "version token required (call skillRead first)",
    );
  }

  const isAdminFn = opts.isAdmin ?? defaultIsAdmin;
  const sc = resolveScope(
    agent, opts.name, opts.scope, opts.root, opts.globalRoot, isAdminFn,
  );
  if ("ok" in sc && sc.ok === false) return sc;
  const ctx = sc as ScopeContext;
  const destDir = ctx.skillDir;
  if (!existsSync(destDir)) {
    return authorErr(
      "E_SKILL_NOT_FOUND",
      `skill ${opts.name} does not exist for agent ${agent}`,
    );
  }
  // Defensive: refuse if dest dir is a symlink.
  try {
    const st = lstatSync(destDir);
    if (st.isSymbolicLink()) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `refuse to edit through symlink at ${destDir}`,
      );
    }
  } catch {
    return authorErr("E_SKILL_NOT_FOUND", `${destDir} missing`);
  }

  // PR B operator-overwrite guard: global-scope edits are denied
  // unless the agent's own authorship marker is present.
  if (ctx.scope === "global" && !hasAuthorshipMarker(destDir, agent)) {
    return authorErr(
      "E_SKILL_OPERATOR_OWNED",
      `global skill ${opts.name} is not authored by ${agent} (no ${authorshipMarkerName(agent)} marker) — operator-curated or peer-authored skills are immutable`,
    );
  }

  const currentToken = skillVersionToken(destDir);
  if (currentToken !== opts.version) {
    return authorErr(
      "E_SKILL_VERSION_STALE",
      `version mismatch: passed ${opts.version}, current ${currentToken}`,
    );
  }

  // If editing SKILL.md, validate frontmatter.
  if (opts.file === "SKILL.md") {
    const fmCheck = validateSkillMd(opts.content, opts.name);
    if ("ok" in fmCheck && fmCheck.ok === false) return fmCheck;
  }

  // Aggregate-size projection: subtract existing file's size (if any)
  // and add the new content's size.
  const absFile = join(destDir, opts.file);
  let existingSize = 0;
  if (existsSync(absFile)) {
    try { existingSize = lstatSync(absFile).size; } catch { /* */ }
  }
  const newSize = Buffer.byteLength(opts.content, "utf-8");
  const projected = totalSkillBytes(destDir) - existingSize + newSize;
  if (projected > MAX_SKILL_BYTES) {
    return authorErr(
      "E_SKILL_BUNDLE_TOO_LARGE",
      `edit would push skill to ${projected} bytes (cap ${MAX_SKILL_BYTES})`,
    );
  }
  // File count cap (only relevant if adding a new file).
  const fileCount = listSkillFiles(destDir).length;
  if (!existsSync(absFile) && fileCount + 1 > MAX_FILES_PER_SKILL) {
    return authorErr(
      "E_SKILL_BUNDLE_TOO_LARGE",
      `skill has ${fileCount} files (max ${MAX_FILES_PER_SKILL})`,
    );
  }

  // Ensure parent dir.
  mkdirSync(dirname(absFile), { recursive: true });

  const mode: "create" | "overwrite" = existsSync(absFile)
    ? "overwrite"
    : "create";
  const r = safeWriteFile(absFile, destDir, opts.content, mode);
  if (r && "ok" in r && r.ok === false) return r;

  return {
    ok: true,
    slug: opts.name,
    file: opts.file,
    path: absFile,
    version: skillVersionToken(destDir),
  };
}

// ─── skillRead ────────────────────────────────────────────────────────

export interface SkillReadOpts {
  agent?: string;
  name: string;
  file?: string;
  root?: string;
  scope?: SkillScope;
  globalRoot?: string;
  isAdmin?: (agent: string) => boolean;
}

export type SkillReadResult =
  | {
      ok: true;
      slug: string;
      path: string;
      version: string;
      file: string;
      content: string;
    }
  | {
      ok: true;
      slug: string;
      path: string;
      version: string;
      files: string[];
      frontmatter: Record<string, unknown> | null;
    };

export function skillRead(
  opts: SkillReadOpts,
): SkillReadResult | SkillAuthorError {
  let agent: string;
  try { agent = resolveAgent(opts.agent); }
  catch (e) { return agentErrCode(e); }

  if (!validateSkillName(opts.name)) {
    return authorErr(
      "E_SKILL_INVALID_NAME",
      `skill name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(opts.name)}`,
    );
  }
  const isAdminFn = opts.isAdmin ?? defaultIsAdmin;
  const sc = resolveScope(
    agent, opts.name, opts.scope, opts.root, opts.globalRoot, isAdminFn,
  );
  if ("ok" in sc && sc.ok === false) return sc;
  const ctx = sc as ScopeContext;
  const destDir = ctx.skillDir;
  if (!existsSync(destDir)) {
    return authorErr(
      "E_SKILL_NOT_FOUND",
      `skill ${opts.name} does not exist for agent ${agent}`,
    );
  }
  // Defensive: don't read through a symlink dir.
  try {
    if (lstatSync(destDir).isSymbolicLink()) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `refuse to read through symlink at ${destDir}`,
      );
    }
  } catch {
    return authorErr("E_SKILL_NOT_FOUND", `${destDir} missing`);
  }
  const version = skillVersionToken(destDir);
  if (opts.file) {
    if (!validateRelPath(opts.file)) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `file path not in allowlist: ${JSON.stringify(opts.file)}`,
      );
    }
    const abs = join(destDir, opts.file);
    if (!existsSync(abs)) {
      return authorErr("E_SKILL_NOT_FOUND", `${opts.file} not found in skill`);
    }
    // Refuse if the file is a symlink.
    try {
      if (lstatSync(abs).isSymbolicLink()) {
        return authorErr(
          "E_SKILL_INVALID_PATH",
          `refuse to read symlink ${opts.file}`,
        );
      }
    } catch {
      return authorErr("E_SKILL_NOT_FOUND", `${opts.file} not found`);
    }
    const content = readFileSync(abs, "utf-8");
    return {
      ok: true,
      slug: opts.name,
      path: destDir,
      version,
      file: opts.file,
      content,
    };
  }
  // Tree summary mode.
  const files = listSkillFiles(destDir);
  return {
    ok: true,
    slug: opts.name,
    path: destDir,
    version,
    files,
    frontmatter: readSkillFrontmatter(destDir),
  };
}

// ─── skillDelete ──────────────────────────────────────────────────────

export interface SkillDeleteOpts {
  agent?: string;
  name: string;
  root?: string;
  scope?: SkillScope;
  globalRoot?: string;
  isAdmin?: (agent: string) => boolean;
}

export interface SkillDeleteResult {
  ok: true;
  slug: string;
  path: string;
}

export function skillDelete(
  opts: SkillDeleteOpts,
): SkillDeleteResult | SkillAuthorError {
  const cronDeny = denyIfCron();
  if (cronDeny) return cronDeny;

  let agent: string;
  try { agent = resolveAgent(opts.agent); }
  catch (e) { return agentErrCode(e); }

  if (!validateSkillName(opts.name)) {
    return authorErr(
      "E_SKILL_INVALID_NAME",
      `skill name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(opts.name)}`,
    );
  }
  const isAdminFn = opts.isAdmin ?? defaultIsAdmin;
  const sc = resolveScope(
    agent, opts.name, opts.scope, opts.root, opts.globalRoot, isAdminFn,
  );
  if ("ok" in sc && sc.ok === false) return sc;
  const ctx = sc as ScopeContext;
  const destDir = ctx.skillDir;
  if (!existsSync(destDir)) {
    return authorErr(
      "E_SKILL_NOT_FOUND",
      `skill ${opts.name} does not exist for agent ${agent}`,
    );
  }
  // Refuse if dest path is a symlink — that's a bundled-skill install
  // (managed by reconcile-default-skills), not an agent-authored dir.
  try {
    if (lstatSync(destDir).isSymbolicLink()) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `refuse to delete bundled-skill symlink at ${destDir} — use 'skill remove' for overlay-installed skills`,
      );
    }
  } catch {
    return authorErr("E_SKILL_NOT_FOUND", `${destDir} missing`);
  }
  // PR B operator-overwrite guard.
  if (ctx.scope === "global" && !hasAuthorshipMarker(destDir, agent)) {
    return authorErr(
      "E_SKILL_OPERATOR_OWNED",
      `global skill ${opts.name} is not authored by ${agent} (no ${authorshipMarkerName(agent)} marker) — refuse to delete operator-curated or peer-authored skill`,
    );
  }
  rmSync(destDir, { recursive: true, force: true });
  return { ok: true, slug: opts.name, path: destDir };
}

// ─── CLI registration ────────────────────────────────────────────────

interface AuthorCliOpts {
  agent?: string;
  name: string;
  file?: string;
  content?: string;
  fromStdin?: boolean;
  version?: string;
  scope?: string;
}

function parseScope(raw: string | undefined): SkillScope | SkillAuthorError {
  if (raw == null || raw === "agent") return "agent";
  if (raw === "global") return "global";
  return authorErr(
    "E_SKILL_SCOPE_DENIED",
    `--scope must be "agent" or "global" (got ${JSON.stringify(raw)})`,
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

export function registerAgentConfigSkillAuthorCommands(program: Command): void {
  const skill = program.commands.find((c) => c.name() === "skill")
    ?? program.command("skill").description(
      "Author / inspect agent-scope skills (PR A of agent-skill-authoring).",
    );

  function emit<T>(r: T): never | void {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
  function fail(r: SkillAuthorError, agent: string, cmd: string, args: object): never {
    process.stderr.write(JSON.stringify({ code: r.code, message: r.message }) + "\n");
    try { appendAudit(agent, cmd, { ...args, ok: false, code: r.code }, r.exit); }
    catch { /* ignore */ }
    process.exit(r.exit);
  }

  skill
    .command("create")
    .description(
      "Create an agent-scope skill from a JSON files-map on stdin. " +
      "Atomic temp-dir → rename. Refuses if the target dir already exists.",
    )
    .requiredOption("--name <slug>", "Skill slug (must match [a-z0-9][a-z0-9_-]{0,62})")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--scope <agent|global>", "Authoring scope (default: agent)")
    .option("--from-stdin", "Read {path: content} JSON map from stdin", false)
    .action(async (opts: AuthorCliOpts) => {
      const resolvedAgent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "<unknown>";
      if (!opts.fromStdin) {
        process.stderr.write("--from-stdin is required for skill create\n");
        process.exit(2);
      }
      const sp = parseScope(opts.scope);
      if (typeof sp !== "string") fail(sp, resolvedAgent, "skill.create", { name: opts.name, scope: opts.scope });
      const raw = await readStdin();
      let files: Record<string, string>;
      try {
        files = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`failed to parse stdin JSON: ${(e as Error).message}\n`);
        process.exit(2);
      }
      const r = skillCreate({ agent: opts.agent, name: opts.name, files, scope: sp as SkillScope });
      if (!r.ok) fail(r, resolvedAgent, "skill.create", { name: opts.name, scope: sp });
      emit(r);
      try {
        appendAudit(resolvedAgent, "skill.create",
          { name: opts.name, file_count: r.files.length }, 0);
      } catch { /* */ }
    });

  skill
    .command("edit")
    .description(
      "Edit a single file in an agent-scope skill. Atomic write. " +
      "Requires --version (from skillRead) for optimistic concurrency.",
    )
    .requiredOption("--name <slug>", "Skill slug")
    .requiredOption("--file <relpath>", "File within the skill (e.g. SKILL.md)")
    .requiredOption("--version <token>", "Version token from skillRead")
    .option("--content <string>", "New file content (or use --from-stdin)")
    .option("--from-stdin", "Read raw content from stdin", false)
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--scope <agent|global>", "Authoring scope (default: agent)")
    .action(async (opts: AuthorCliOpts) => {
      const resolvedAgent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "<unknown>";
      let content = opts.content;
      if (opts.fromStdin) content = await readStdin();
      if (content == null) {
        process.stderr.write("--content or --from-stdin required\n");
        process.exit(2);
      }
      const sp = parseScope(opts.scope);
      if (typeof sp !== "string") fail(sp, resolvedAgent, "skill.edit", { name: opts.name, scope: opts.scope });
      const r = skillEdit({
        agent: opts.agent,
        name: opts.name,
        file: opts.file!,
        content,
        version: opts.version!,
        scope: sp as SkillScope,
      });
      if (!r.ok) fail(r, resolvedAgent, "skill.edit",
        { name: opts.name, file: opts.file });
      emit(r);
      try {
        appendAudit(resolvedAgent, "skill.edit",
          { name: opts.name, file: opts.file }, 0);
      } catch { /* */ }
    });

  skill
    .command("read")
    .description(
      "Read a skill file or list the skill's tree + frontmatter. " +
      "Returns a version token for use with `skill edit`.",
    )
    .requiredOption("--name <slug>", "Skill slug")
    .option("--file <relpath>", "Specific file to read (omit for tree summary)")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--scope <agent|global>", "Read scope (default: agent)")
    .action(async (opts: AuthorCliOpts) => {
      const resolvedAgent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "<unknown>";
      const sp = parseScope(opts.scope);
      if (typeof sp !== "string") fail(sp, resolvedAgent, "skill.read", { name: opts.name, scope: opts.scope });
      const r = skillRead({
        agent: opts.agent,
        name: opts.name,
        file: opts.file,
        scope: sp as SkillScope,
      });
      if (!("ok" in r) || r.ok !== true) {
        fail(r, resolvedAgent, "skill.read", { name: opts.name, file: opts.file });
      }
      emit(r);
      try {
        appendAudit(resolvedAgent, "skill.read",
          { name: opts.name, file: opts.file ?? null }, 0);
      } catch { /* */ }
    });

  skill
    .command("delete")
    .description(
      "Delete an agent-scope skill dir. Refuses if the path is a symlink " +
      "(bundled-skill install — use `skill remove` instead).",
    )
    .requiredOption("--name <slug>", "Skill slug")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--scope <agent|global>", "Delete scope (default: agent)")
    .action(async (opts: AuthorCliOpts) => {
      const resolvedAgent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "<unknown>";
      const sp = parseScope(opts.scope);
      if (typeof sp !== "string") fail(sp, resolvedAgent, "skill.delete", { name: opts.name, scope: opts.scope });
      const r = skillDelete({ agent: opts.agent, name: opts.name, scope: sp as SkillScope });
      if (!r.ok) fail(r, resolvedAgent, "skill.delete", { name: opts.name });
      emit(r);
      try {
        appendAudit(resolvedAgent, "skill.delete", { name: opts.name }, 0);
      } catch { /* */ }
    });

  // Re-export for symmetry with the install/remove helpers.
  void authorExitCodeFor;
}
