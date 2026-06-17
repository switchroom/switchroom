/**
 * `switchroom skill {init,edit,remove,list}-personal` — agent-self-service
 * primitives for personal-skill authoring (PR-3 of RFC #1814, closes #1819).
 *
 * Each agent has its own personal-skill workspace at
 * `<agentDir>/.claude/skills/personal-<name>/`. Owned by the agent UID
 * mode 0755 dir / 0600 files / 0755 scripts. Writes don't go through
 * the operator's approval card — the agent's own workspace IS the
 * approval boundary.
 *
 * Per Phase 0 spike findings (`reference/rfcs/agent-managed-skills-phase0-findings.md`):
 *   - Personal skills live at `.claude/skills/personal-<name>/` (flat
 *     path, `personal-` name prefix). Claude-code's depth-1 discovery
 *     scans this without modification.
 *   - Removed skills move to `.claude/skills-trash/<name>-<unix-ts>/`
 *     (sibling to skills/, outside discovery root). 24h recovery
 *     window enforced by lazy sweep on every personal-skill op + a
 *     scaffold boot-time sweep.
 *   - No host-side cron involved (Phase 4 retired host scheduling).
 *
 * Validation reuses the bundle validator from `skill-common.ts`
 * (`validateSkillBundle` covers name regex, path allowlist, SKILL.md
 * frontmatter, bundle size caps, and the `claude -p` content scan).
 *
 * Behavioural validation (`bash -n`, `python -m py_compile`) runs
 * synchronously per file; failures surface as structured CLI errors
 * the MCP wrapper renders back to the calling agent.
 *
 * Symlink safety: every write uses `O_CREAT|O_EXCL` ('wx') so any
 * pre-existing path (file OR symlink) at the staging slot errors. The
 * target dir is checked with `lstatSync` before write — never
 * `existsSync` (which follows symlinks and misses dangling).
 */

import { Command, Option } from "commander";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  PY_SCRIPT_RE,
  SH_SCRIPT_RE,
  SKILL_SLUG_RE,
  type SkillFileMap,
  validateRelPath,
  validateSkillBundle,
} from "./skill-common.js";
import { withConfigError } from "./helpers.js";
import { appendAudit } from "./agent-config.js";
import chalk from "chalk";

// ─── Constants ─────────────────────────────────────────────────────

/** Sub-path under `.claude/skills/` for personal skills. The `personal-`
 *  PREFIX, not a subdir — claude-code's depth-1 discovery doesn't recurse. */
const PERSONAL_PREFIX = "personal-";

/** Sibling-of-`skills/` location for soft-removed skills. */
const TRASH_DIRNAME = "skills-trash";

/** Recovery window: trash entries older than this get swept. */
const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Config-repo mirror (versioned personal skills) ──────────────────

/**
 * Personal skills are *runtime state* at
 * `<agentDir>/.claude/skills/personal-<name>/` so claude-code's
 * depth-1 discovery finds them without a custom mount. Runtime state
 * survives container recreate (the agent dir is bind-mounted) but is
 * NOT git-tracked — a host rebuild loses every agent's personal-skill
 * workspace.
 *
 * The fix: after every successful personal-skill write, opportunistically
 * mirror the dir into
 * `~/.switchroom-config/agents/<agent>/personal-skills/<name>/`
 * if the operator has the config repo set up. Mirror is best-effort:
 *
 *   - If `~/.switchroom-config/` doesn't exist, skip silently (operator
 *     hasn't opted in to the versioned-skill pattern).
 *   - If mirroring fails (EACCES, ENOSPC, etc.), warn on stderr and
 *     continue. The live copy still works; just not version-controlled
 *     until the next successful sync.
 *   - No auto-commit. Operator decides commit cadence (`cd
 *     ~/.switchroom-config && git status` shows the changes).
 *
 * Override `SWITCHROOM_CONFIG_DIR` to point at an alternate config repo
 * (e.g. Lisa's `~lisa/.switchroom-config/` for her fleet, or a tmpdir
 * in tests).
 */
const PERSONAL_SKILLS_SUBPATH = "personal-skills";

function resolveConfigSkillsDir(agent: string): string | null {
  const override = process.env.SWITCHROOM_CONFIG_DIR;
  const candidate = override
    ? resolve(override)
    : join(homedir(), ".switchroom-config");
  if (!existsSync(candidate)) return null;
  return join(candidate, "agents", agent, PERSONAL_SKILLS_SUBPATH);
}

/**
 * Mirror a successfully-written personal-skill dir into the operator's
 * config repo, if one exists. Best-effort: errors logged to stderr and
 * swallowed so a broken config-repo path never blocks a live write.
 *
 * Pass `liveSkillDir = null` to mirror a REMOVAL — the existing mirror
 * (if any) is moved to a `.<name>-trash-<ts>` sibling so a stray
 * `git status` still shows the deletion.
 */
/**
 * `.prior-<ts>/` and `.trash-<ts>/` siblings retention: lazy sweep at
 * the start of each mirror op deletes entries older than 24h. Without
 * this, every edit leaves a permanent stale copy in the config repo —
 * 100 edits = 100 dirs of stale skill content (#1844 reviewer flag).
 * Same TTL as the live skills-trash sweep so the operator's mental
 * model is uniform.
 */
const MIRROR_PRIOR_TTL_MS = 24 * 60 * 60 * 1000;
function sweepMirrorPriors(configSkillsRoot: string): void {
  try {
    if (!existsSync(configSkillsRoot)) return;
    const now = Date.now();
    for (const ent of readdirSync(configSkillsRoot)) {
      const m = /^\.(?:.+)-(?:prior|trash)-(\d+)$/.exec(ent);
      if (!m) continue;
      const ts = Number(m[1]!);
      if (!Number.isFinite(ts)) continue;
      if (now - ts < MIRROR_PRIOR_TTL_MS) continue;
      try {
        rmSync(join(configSkillsRoot, ent), { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

function mirrorToConfigRepo(
  agent: string,
  name: string,
  liveSkillDir: string | null,
): void {
  const configSkillsRoot = resolveConfigSkillsDir(agent);
  if (!configSkillsRoot) return; // operator hasn't opted in
  const dest = join(configSkillsRoot, name);

  try {
    // Defense in depth: liveSkillDir should be a canonical path under
    // <agentDir>/.claude/skills, but if it were ever a symlink (future
    // redirect mode, misconfigured scaffold), don't follow it across
    // the file system.
    if (liveSkillDir !== null) {
      try {
        const st = lstatSync(liveSkillDir);
        if (st.isSymbolicLink()) {
          process.stderr.write(
            chalk.yellow(
              `warning: refusing to mirror ${liveSkillDir} — source is a symlink\n`,
            ),
          );
          return;
        }
      } catch {
        // Fall through; readdirSync below will surface a useful error.
      }
    }

    if (liveSkillDir === null) {
      sweepMirrorPriors(configSkillsRoot);
      if (existsSync(dest)) {
        const trash = join(
          configSkillsRoot,
          `.${name}-trash-${Date.now()}`,
        );
        renameSync(dest, trash);
      }
      return;
    }

    mkdirSync(configSkillsRoot, { recursive: true, mode: 0o755 });
    sweepMirrorPriors(configSkillsRoot);
    // Atomic-ish: stage under a sibling, swap, remove old.
    const staging = mkdtempSync(join(configSkillsRoot, `.${name}-staging-`));
    const walk = (src: string, dst: string): void => {
      mkdirSync(dst, { recursive: true, mode: 0o755 });
      for (const ent of readdirSync(src, { withFileTypes: true })) {
        const s = join(src, ent.name);
        const d = join(dst, ent.name);
        if (ent.isSymbolicLink()) continue; // skip — same defense as readSourceFiles
        if (ent.isDirectory()) walk(s, d);
        else if (ent.isFile()) {
          writeFileSync(d, readFileSync(s));
        }
      }
    };
    walk(liveSkillDir, staging);

    if (existsSync(dest)) {
      const prior = join(configSkillsRoot, `.${name}-prior-${Date.now()}`);
      renameSync(dest, prior);
      // .prior- siblings: bounded by sweepMirrorPriors above (24h TTL).
    }
    renameSync(staging, dest);
  } catch (err) {
    process.stderr.write(
      chalk.yellow(
        `warning: mirror to ${dest} failed (${(err as Error).message ?? err}); ` +
          `live copy still works, but this skill is not version-controlled until next successful sync.\n`,
      ),
    );
  }
}

// ─── Types ─────────────────────────────────────────────────────────

interface AgentOpts {
  agent?: string;
}

interface InitEditOpts extends AgentOpts {
  from?: string;
  root?: string; // test-only override for agents dir
}

interface RemoveOpts extends AgentOpts {
  root?: string; // test-only
}

interface ListOpts extends AgentOpts {
  root?: string; // test-only
  json?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────

function fail(msg: string, exit = 2): never {
  console.error(chalk.red(`error: ${msg}`));
  process.exit(exit);
}

function resolveAgent(opts: AgentOpts): string {
  const fromEnv = process.env.SWITCHROOM_AGENT_NAME;
  const agent = opts.agent ?? fromEnv;
  if (!agent) {
    fail(
      "agent name required: pass --agent <name>, or set SWITCHROOM_AGENT_NAME " +
      "in the calling environment (set by switchroom for in-container agents).",
    );
  }
  if (!SKILL_SLUG_RE.test(agent)) {
    fail(`agent name has invalid shape: ${JSON.stringify(agent)}`);
  }
  return agent;
}

function resolveAgentsRoot(opts: { root?: string }): string {
  if (opts.root) return resolve(opts.root);
  return join(homedir(), ".switchroom", "agents");
}

function personalSkillDir(
  agentsRoot: string,
  agent: string,
  name: string,
): string {
  return join(agentsRoot, agent, ".claude", "skills", PERSONAL_PREFIX + name);
}

function trashDir(agentsRoot: string, agent: string): string {
  return join(agentsRoot, agent, ".claude", TRASH_DIRNAME);
}

function readStdinSync(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let n = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "EAGAIN") continue;
      break;
    }
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Load file map from `--from <dir>`. Refuses to read symlinks.
 */
function loadFromDir(dir: string): SkillFileMap {
  const abs = resolve(dir);
  if (!statSync(abs).isDirectory()) {
    fail(`--from path is not a directory: ${dir}`);
  }
  const files: SkillFileMap = {};
  const walk = (sub: string): void => {
    for (const ent of readdirSync(sub, { withFileTypes: true })) {
      const full = join(sub, ent.name);
      if (ent.isSymbolicLink()) {
        fail(`refusing to read symlink in --from dir: ${relative(abs, full)}`);
      }
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (ent.isFile()) {
        const rel = relative(abs, full).replace(/\\/g, "/");
        files[rel] = readFileSync(full, "utf-8");
      }
    }
  };
  walk(abs);
  return files;
}

/**
 * Load files from stdin. Two formats accepted:
 *   - JSON object `{"path": "content", ...}` — multi-file payload (the
 *     primary MCP wire shape; agents construct in-memory).
 *   - Plain text — treated as single-file SKILL.md (operator convenience
 *     for one-shot edits).
 */
function loadFromStdin(): SkillFileMap {
  const raw = readStdinSync();
  if (raw.length === 0) {
    fail("no content on stdin; pipe a SKILL.md or JSON file-map");
  }
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fail(`stdin starts with '{' but is not valid JSON: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("stdin JSON must be an object of {path: content, ...}");
    }
    const files: SkillFileMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") {
        fail(`stdin JSON: value for ${JSON.stringify(k)} must be a string`);
      }
      files[k] = v;
    }
    return files;
  }
  return { "SKILL.md": raw };
}

/**
 * Run `bash -n` / `python3 -m py_compile` on every applicable script
 * in the bundle. Returns the list of error strings; empty list = OK.
 */
function behavioralValidate(files: SkillFileMap): string[] {
  const errors: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (SH_SCRIPT_RE.test(path)) {
      const r = spawnSync("bash", ["-n"], { input: content, encoding: "utf-8" });
      if (r.status !== 0) {
        errors.push(
          `${path} fails \`bash -n\`: ${(r.stderr ?? "").trim()}`,
        );
      }
    } else if (PY_SCRIPT_RE.test(path)) {
      const tmp = mkdtempSync(join(tmpdir(), "skill-personal-py-"));
      const tmpPy = join(tmp, "check.py");
      try {
        writeFileSync(tmpPy, content);
        const r = spawnSync("python3", ["-m", "py_compile", tmpPy], {
          encoding: "utf-8",
        });
        if (r.status !== 0) {
          errors.push(
            `${path} fails \`python3 -m py_compile\`: ${(r.stderr ?? "").trim()}`,
          );
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
  return errors;
}

/**
 * Lazy trash-dir sweep — unlinks any entry older than TRASH_TTL_MS.
 * Called at the start of every personal-skill op so the 24h recovery
 * window is enforced without a separate cron.
 *
 * Lazy + scaffold-boot is the hybrid mechanism Phase 0 picked (Q6) —
 * see findings doc.
 */
function sweepTrash(agentsRoot: string, agent: string): void {
  const trash = trashDir(agentsRoot, agent);
  if (!existsSync(trash)) return;
  const now = Date.now();
  for (const ent of readdirSync(trash, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const entPath = join(trash, ent.name);
    try {
      const st = statSync(entPath);
      if (now - st.mtimeMs > TRASH_TTL_MS) {
        rmSync(entPath, { recursive: true, force: true });
      }
    } catch {
      /* benign — concurrent op may have already swept this entry */
    }
  }
}

/**
 * Write the bundle into a staging dir, then atomic-rename into the
 * target. If the target already exists (a non-symlink), rotate it
 * aside first so the swap is atomic from a reader's perspective.
 *
 * Symlink at target → refuse (operator must investigate manually).
 * Dangling symlink → refuse (use lstat, not existsSync).
 */
function writePersonalSkill(
  targetDir: string,
  files: SkillFileMap,
): void {
  // Pre-flight: refuse if target slot is a symlink (live OR dangling).
  // existsSync follows symlinks; lstatSync doesn't. Same defense as
  // PR-1's writer.
  let targetIsSymlink = false;
  try {
    const st = lstatSync(targetDir);
    if (st.isSymbolicLink()) {
      targetIsSymlink = true;
    }
  } catch {
    // ENOENT — target doesn't exist; that's fine.
  }
  if (targetIsSymlink) {
    fail(
      `refusing to overwrite symlink at ${targetDir}; investigate manually`,
    );
  }

  // Ensure parent dir exists.
  mkdirSync(dirname(targetDir), { recursive: true, mode: 0o755 });

  const staging = mkdtempSync(
    join(dirname(targetDir), `.skill-personal-stage-`),
  );
  let oldRename: string | null = null;
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(staging, path);
      mkdirSync(dirname(full), { recursive: true, mode: 0o755 });
      // 'wx' = O_CREAT | O_EXCL — refuses pre-existing files / symlinks
      // at the staging slot. Staging dir was just mkdtemp'd so any
      // pre-existing file would only happen via a TOCTOU race; wx closes it.
      const fd = openSync(full, "wx");
      try {
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
      if (SH_SCRIPT_RE.test(path) || PY_SCRIPT_RE.test(path)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        fs.chmodSync(full, 0o755);
      }
    }
    // Atomic swap.
    let targetExists = false;
    try {
      lstatSync(targetDir);
      targetExists = true;
    } catch { /* ENOENT — proceed */ }
    if (targetExists) {
      oldRename = `${targetDir}.personal-old-${Date.now()}`;
      renameSync(targetDir, oldRename);
    }
    renameSync(staging, targetDir);
    if (oldRename) {
      rmSync(oldRename, { recursive: true, force: true });
      oldRename = null;
    }
  } catch (err) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /**/ }
    if (oldRename && existsSync(oldRename)) {
      try {
        if (existsSync(targetDir)) {
          rmSync(targetDir, { recursive: true, force: true });
        }
        renameSync(oldRename, targetDir);
      } catch { /**/ }
    }
    throw err;
  }
}

/**
 * Load + validate + write — the shared pipeline for init + edit.
 * `ensureNew=true` refuses if the target already exists (init);
 * `ensureNew=false` requires the target to exist (edit).
 */
function loadValidateWrite(
  agentsRoot: string,
  agent: string,
  name: string,
  files: SkillFileMap,
  ensureNew: boolean,
): void {
  sweepTrash(agentsRoot, agent);

  if (!SKILL_SLUG_RE.test(name)) {
    fail(`skill name must match ${SKILL_SLUG_RE.source}: got ${JSON.stringify(name)}`);
  }
  const target = personalSkillDir(agentsRoot, agent, name);
  const exists = (() => {
    try { lstatSync(target); return true; } catch { return false; }
  })();
  if (ensureNew && exists) {
    fail(
      `personal skill ${JSON.stringify(name)} already exists for agent ${JSON.stringify(agent)}. ` +
      `Use \`skill edit-personal\` to overwrite, or \`skill remove-personal\` first.`,
      9,
    );
  }
  if (!ensureNew && !exists) {
    fail(
      `personal skill ${JSON.stringify(name)} does not exist for agent ${JSON.stringify(agent)}. ` +
      `Use \`skill init-personal\` to create it.`,
      9,
    );
  }

  const v = validateSkillBundle(name, files);
  if (!v.ok) {
    console.error(chalk.red("Validation failed:"));
    for (const e of v.errors) {
      console.error(chalk.red(`  - ${e}`));
    }
    process.exit(3);
  }

  const behavioral = behavioralValidate(files);
  if (behavioral.length > 0) {
    console.error(chalk.red("Behavioural validation failed:"));
    for (const e of behavioral) {
      console.error(chalk.red(`  - ${e}`));
    }
    process.exit(3);
  }

  writePersonalSkill(target, files);
}

// ─── Public entry points (CLI command actions) ─────────────────────

function loadFiles(opts: InitEditOpts): SkillFileMap {
  if (opts.from === undefined) {
    return loadFromStdin();
  }
  const p = resolve(opts.from);
  if (!existsSync(p)) {
    fail(`--from path does not exist: ${opts.from}`);
  }
  const st = statSync(p);
  if (st.isDirectory()) {
    return loadFromDir(p);
  }
  if (p.endsWith(".md")) {
    return { "SKILL.md": readFileSync(p, "utf-8") };
  }
  fail(`--from must be a directory or a .md file. Got: ${opts.from}`);
}

export function initPersonalAction(name: string, opts: InitEditOpts): void {
  const agent = resolveAgent(opts);
  const agentsRoot = resolveAgentsRoot(opts);
  const files = loadFiles(opts);
  loadValidateWrite(agentsRoot, agent, name, files, /*ensureNew=*/ true);
  const skillDir = personalSkillDir(agentsRoot, agent, name);
  mirrorToConfigRepo(agent, name, skillDir);
  console.log(
    JSON.stringify({
      ok: true,
      action: "init",
      agent,
      name,
      path: skillDir,
      files: Object.keys(files).length,
    }),
  );
  // Audit row on success only (failure paths exit via fail() before this).
  // Used by scripts/observe-personal-skills.mjs for adoption telemetry.
  appendAudit(agent, "skill.init_personal", { name, files: Object.keys(files).length }, 0);
}

export function editPersonalAction(name: string, opts: InitEditOpts): void {
  const agent = resolveAgent(opts);
  const agentsRoot = resolveAgentsRoot(opts);
  const files = loadFiles(opts);
  loadValidateWrite(agentsRoot, agent, name, files, /*ensureNew=*/ false);
  const skillDir = personalSkillDir(agentsRoot, agent, name);
  mirrorToConfigRepo(agent, name, skillDir);
  console.log(
    JSON.stringify({
      ok: true,
      action: "edit",
      agent,
      name,
      path: skillDir,
      files: Object.keys(files).length,
    }),
  );
  appendAudit(agent, "skill.edit_personal", { name, files: Object.keys(files).length }, 0);
}

// ─── Clone-to-personal ─────────────────────────────────────────────

interface CloneOpts extends AgentOpts {
  /** Optional override slug. Defaults to the source slug. */
  name?: string;
  /** Test hooks. */
  root?: string;
  sharedRoot?: string;
  bundledRoot?: string;
}

/** Source allow-list: `shared:<name>` or `bundled:<name>`. */
const CLONE_SOURCE_RE = /^(shared|bundled):([a-z0-9][a-z0-9_-]{0,62})$/;

function defaultSharedRoot(): string {
  return join(homedir(), ".switchroom", "skills");
}

function defaultBundledRoot(): string {
  return join(homedir(), ".switchroom", "skills", "_bundled");
}

function resolveCloneSource(
  source: string,
  opts: CloneOpts,
): { tier: "shared" | "bundled"; slug: string; dir: string } {
  const m = CLONE_SOURCE_RE.exec(source);
  if (!m) {
    fail(
      `source must be \`shared:<name>\` or \`bundled:<name>\` (got ${JSON.stringify(source)})`,
    );
  }
  const tier = m[1] as "shared" | "bundled";
  const slug = m[2]!;
  const root =
    tier === "bundled"
      ? (opts.bundledRoot ?? defaultBundledRoot())
      : (opts.sharedRoot ?? defaultSharedRoot());
  const dir = join(root, slug);
  if (!existsSync(dir)) {
    fail(
      `clone source ${JSON.stringify(source)} not found at ${dir}; ` +
        `check \`switchroom skill search --tier ${tier}\``,
      1,
    );
  }
  // Symlink-safety: refuse to read through a symlinked source dir. The
  // bundled tier uses symlinks (see reconcileAgentDefaultSkills) but
  // those point INTO the shared pool — we want the canonical pool path.
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) {
    fail(
      `clone source ${JSON.stringify(source)} is a symlink at ${dir}; ` +
        `point clone at the canonical pool path instead`,
    );
  }
  return { tier, slug, dir };
}

/**
 * Read all files from a source skill dir into a SkillFileMap. Same
 * walk as `loadFromDir` but doesn't fail on the inner symlink check —
 * it operates on the canonical pool path resolved above.
 *
 * Skips internal symlinks (defence in depth) and refuses to read any
 * individual file > 1 MiB. Both `validateSkillBundle` and the
 * `MAX_FILE_BYTES` gate downstream would catch giant files, but
 * declining to read them upfront avoids OOM on a pathological source.
 */
const CLONE_MAX_FILE_BYTES = 1024 * 1024;

interface CloneReadResult {
  files: SkillFileMap;
  /** Paths that existed in the source but didn't pass the allowlist. */
  skipped: string[];
}

function readSourceFiles(dir: string): CloneReadResult {
  const files: SkillFileMap = {};
  const skipped: string[] = [];
  const walk = (sub: string): void => {
    for (const ent of readdirSync(sub, { withFileTypes: true })) {
      const full = join(sub, ent.name);
      if (ent.isSymbolicLink()) {
        // Skip internal symlinks (e.g. operator drop-ins) — clone is a
        // self-contained copy, not a symlink-preserving mirror.
        continue;
      }
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (ent.isFile()) {
        const rel = relative(dir, full).replace(/\\/g, "/");
        // Allowlist gate (closes #1847): bundled skills ship with
        // operator-relevant files at root (LICENSE, VENDORED.md,
        // reference.md, scripts/requirements.txt, etc.) that aren't
        // in the agent-authored-skill path allowlist. Skipping them
        // here keeps the personal fork shape-clean and the publish-
        // side validator strict — the agent never sees these files
        // in their workspace, which is correct.
        if (!validateRelPath(rel)) {
          skipped.push(rel);
          continue;
        }
        // Pre-flight size check via lstat (no need to open).
        try {
          const st = lstatSync(full);
          if (st.size > CLONE_MAX_FILE_BYTES) {
            fail(
              `clone source has oversized file ${rel} (${st.size} bytes > ${CLONE_MAX_FILE_BYTES}); ` +
                `refuse to read`,
              3,
            );
          }
        } catch {
          // Stat failure on a regular file is unusual; let readFileSync surface it.
        }
        files[rel] = readFileSync(full, "utf-8");
      }
    }
  };
  walk(dir);
  return { files, skipped };
}

/**
 * Patch the SKILL.md `name:` frontmatter field so the cloned copy is
 * internally consistent with its new slug. Without this, validation
 * would fail when the source's name and the personal-tier slug differ.
 */
function rewriteSkillMdName(content: string, newName: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return content;
  }
  const rest = content.slice(content.indexOf("\n") + 1);
  const endIdx = rest.indexOf("\n---");
  if (endIdx < 0) return content;
  const fm = rest.slice(0, endIdx);
  const body = rest.slice(endIdx);
  // Replace the first `name:` line; preserve other frontmatter as-is.
  const patched = fm.replace(
    /^(\s*name\s*:)[ \t]*\S.*$/m,
    `$1 ${newName}`,
  );
  return "---\n" + patched + body;
}

export function clonePersonalAction(source: string, opts: CloneOpts): void {
  const agent = resolveAgent(opts);
  const agentsRoot = resolveAgentsRoot(opts);
  const src = resolveCloneSource(source, opts);
  const newName = opts.name ?? src.slug;
  if (!SKILL_SLUG_RE.test(newName)) {
    fail(`destination name must match ${SKILL_SLUG_RE.source}: got ${JSON.stringify(newName)}`);
  }

  // Read source files, rewrite SKILL.md name to match the new slug so
  // the personal-tier validator (which enforces name == slug) accepts
  // the bundle.
  const { files, skipped } = readSourceFiles(src.dir);
  if (!files["SKILL.md"]) {
    fail(`source ${JSON.stringify(source)} has no SKILL.md at ${src.dir}`);
  }
  if (newName !== src.slug) {
    files["SKILL.md"] = rewriteSkillMdName(files["SKILL.md"]!, newName);
  }

  // Surface skipped paths to the operator/agent on stderr so the fork
  // is honest about what landed (LICENSE, VENDORED.md, README, etc.
  // — see #1847). Single line, not per-file noise.
  if (skipped.length > 0) {
    process.stderr.write(
      chalk.yellow(
        `note: skipped ${skipped.length} non-allowlisted path${skipped.length === 1 ? "" : "s"} from source: ${skipped.join(", ")}\n`,
      ),
    );
  }

  // Same validate+write pipeline as init_personal: ensureNew=true so a
  // pre-existing personal copy isn't silently clobbered.
  loadValidateWrite(agentsRoot, agent, newName, files, /*ensureNew=*/ true);
  const skillDir = personalSkillDir(agentsRoot, agent, newName);
  mirrorToConfigRepo(agent, newName, skillDir);

  console.log(
    JSON.stringify({
      ok: true,
      action: "clone_to_personal",
      agent,
      source,
      source_tier: src.tier,
      source_slug: src.slug,
      name: newName,
      path: skillDir,
      files: Object.keys(files).length,
      // Empty array when nothing was skipped — explicit so MCP callers
      // can distinguish "shape-clean source" from "we silently dropped
      // something you might care about".
      skipped,
    }),
  );
  appendAudit(
    agent,
    "skill.clone_to_personal",
    {
      source,
      source_tier: src.tier,
      source_slug: src.slug,
      name: newName,
      files: Object.keys(files).length,
      skipped_count: skipped.length,
    },
    0,
  );
}

export function removePersonalAction(name: string, opts: RemoveOpts): void {
  const agent = resolveAgent(opts);
  const agentsRoot = resolveAgentsRoot(opts);
  sweepTrash(agentsRoot, agent);

  if (!SKILL_SLUG_RE.test(name)) {
    fail(`skill name must match ${SKILL_SLUG_RE.source}: got ${JSON.stringify(name)}`);
  }
  const target = personalSkillDir(agentsRoot, agent, name);
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      fail(`refusing to remove symlink at ${target}; investigate manually`);
    }
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") {
      fail(
        `personal skill ${JSON.stringify(name)} does not exist for agent ${JSON.stringify(agent)}`,
        1,
      );
    }
    throw err;
  }

  // Soft-undo: move to <trash>/<name>-<unix-ts>/.
  const trashRoot = trashDir(agentsRoot, agent);
  mkdirSync(trashRoot, { recursive: true, mode: 0o755 });
  const ts = Date.now();
  const trashTarget = join(trashRoot, `${name}-${ts}`);
  renameSync(target, trashTarget);
  // Refresh mtime so the sweep TTL counts from the rename, not the
  // original file mtime (which might be ancient).
  const now = new Date(ts);
  utimesSync(trashTarget, now, now);

  // Mirror the removal into the config repo (null signals delete).
  mirrorToConfigRepo(agent, name, null);
  console.log(
    JSON.stringify({
      ok: true,
      action: "remove",
      agent,
      name,
      trash_path: trashTarget,
      recoverable_until: new Date(ts + TRASH_TTL_MS).toISOString(),
    }),
  );
  appendAudit(agent, "skill.remove_personal", { name }, 0);
}

export function listPersonalAction(opts: ListOpts): void {
  const agent = resolveAgent(opts);
  const agentsRoot = resolveAgentsRoot(opts);
  sweepTrash(agentsRoot, agent);

  const skillsDir = join(agentsRoot, agent, ".claude", "skills");
  const personal: { name: string; path: string; files: number; size_bytes: number }[] = [];

  if (existsSync(skillsDir)) {
    for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (!ent.name.startsWith(PERSONAL_PREFIX)) continue;
      const skillName = ent.name.slice(PERSONAL_PREFIX.length);
      const skillPath = join(skillsDir, ent.name);
      let fileCount = 0;
      let totalBytes = 0;
      const walk = (sub: string): void => {
        for (const e of readdirSync(sub, { withFileTypes: true })) {
          if (e.isFile()) {
            fileCount += 1;
            try {
              totalBytes += statSync(join(sub, e.name)).size;
            } catch { /**/ }
          } else if (e.isDirectory()) {
            walk(join(sub, e.name));
          }
        }
      };
      try { walk(skillPath); } catch { /**/ }
      personal.push({
        name: skillName,
        path: skillPath,
        files: fileCount,
        size_bytes: totalBytes,
      });
    }
  }

  console.log(JSON.stringify({ ok: true, agent, personal }, null, 2));
}

// ─── Command registration ─────────────────────────────────────────

/**
 * Find-or-create the `skill` parent command (multiple files attach
 * subcommands; the parent is shared between `skill.ts` (apply) and
 * `agent-config-skill-write.ts` (install/remove)).
 */
export function registerSkillPersonalCommands(program: Command): void {
  const parent =
    program.commands.find((c) => c.name() === "skill") ??
    program.command("skill").description("Skill pool management.");

  parent
    .command("init-personal <name>")
    .description(
      "Create a personal skill in this agent's writable workspace " +
      "(<agentDir>/.claude/skills/personal-<name>/). Reads SKILL.md from " +
      "stdin, or multi-file JSON {path: content} from stdin, or a single " +
      "SKILL.md file via --from, or a directory via --from. No operator " +
      "approval — agent's own workspace.",
    )
    .option("--agent <name>", "Agent name (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--from <path>", "Source path: .md file or directory")
    .option("--root <path>", "Test-only override for agents-root dir")
    .action(withConfigError(async (name: string, opts: InitEditOpts) => {
      initPersonalAction(name, opts);
    }));

  parent
    .command("edit-personal <name>")
    .description(
      "Overwrite an existing personal skill. Same input modes as " +
      "init-personal. Fails if the skill doesn't already exist.",
    )
    .option("--agent <name>", "Agent name (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--from <path>", "Source path: .md file or directory")
    .option("--root <path>", "Test-only override for agents-root dir")
    .action(withConfigError(async (name: string, opts: InitEditOpts) => {
      editPersonalAction(name, opts);
    }));

  parent
    .command("remove-personal <name>")
    .description(
      "Soft-remove a personal skill. Moves the dir to " +
      "<agentDir>/.claude/skills-trash/<name>-<unix-ts>/ for 24h " +
      "recoverability. Lazy sweep on next op deletes entries older " +
      "than 24h.",
    )
    .option("--agent <name>", "Agent name (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--root <path>", "Test-only override for agents-root dir")
    .action(withConfigError(async (name: string, opts: RemoveOpts) => {
      removePersonalAction(name, opts);
    }));

  parent
    .command("list-personal")
    .description(
      "List personal skills owned by this agent. JSON output by default.",
    )
    .option("--agent <name>", "Agent name (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--root <path>", "Test-only override for agents-root dir")
    .action(withConfigError(async (opts: ListOpts) => {
      listPersonalAction(opts);
    }));

  parent
    .command("clone-to-personal <source>")
    .description(
      "Fork a shared or bundled skill into this agent's writable workspace. " +
      "Source format: `shared:<name>` or `bundled:<name>`. The personal copy " +
      "becomes mutable via edit-personal; the upstream source is untouched. " +
      "Use --name to give the fork a different slug. No operator approval — " +
      "agent's own workspace.",
    )
    .option("--agent <name>", "Agent name (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--name <slug>", "Override destination slug (default: source slug)")
    .addOption(new Option("--root <path>").hideHelp())
    .addOption(new Option("--shared-root <path>").hideHelp())
    .addOption(new Option("--bundled-root <path>").hideHelp())
    .action(withConfigError(async (source: string, opts: CloneOpts) => {
      clonePersonalAction(source, opts);
    }));
}
