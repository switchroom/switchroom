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
 * Per Phase 0 spike findings (`docs/rfcs/agent-managed-skills-phase0-findings.md`):
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

import { Command } from "commander";
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
  console.log(
    JSON.stringify({
      ok: true,
      action: ensureNew ? "init" : "edit",
      agent,
      name,
      path: target,
      files: Object.keys(files).length,
    }),
  );
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
  // Audit row on success only (failure paths exit via fail() before this).
  // Used by scripts/observe-personal-skills.mjs for adoption telemetry.
  appendAudit(agent, "skill.init_personal", { name, files: Object.keys(files).length }, 0);
}

export function editPersonalAction(name: string, opts: InitEditOpts): void {
  const agent = resolveAgent(opts);
  const agentsRoot = resolveAgentsRoot(opts);
  const files = loadFiles(opts);
  loadValidateWrite(agentsRoot, agent, name, files, /*ensureNew=*/ false);
  appendAudit(agent, "skill.edit_personal", { name, files: Object.keys(files).length }, 0);
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
}
