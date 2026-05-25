/**
 * `switchroom skill apply <name>` — operator-side CLI verb that writes
 * a skill payload into the global skills pool (`~/.switchroom/skills/`)
 * after running the same validators an agent-proposed publish would.
 *
 * Tactical bridge from the agent-managed-skills RFC v3 (PR-1, #1817).
 * Closes the operator-bottleneck on shared-pool skill maintenance —
 * agents draft the patched content; operator runs this verb once at
 * the terminal instead of nine paste-and-relay steps.
 *
 * Input modes (mutually exclusive):
 *   - stdin (default when --from is omitted): single SKILL.md content
 *   - --from <path-to-.md>: single SKILL.md content from file
 *   - --from <path-to-dir>: multi-file payload from a directory
 *   - --from <path-to-.tar(.gz)>: multi-file payload from a tarball
 *
 * Validation order (every gate must pass before any write lands):
 *   1. Name regex check (`/^[a-z][a-z0-9_-]{0,62}$/`)
 *   2. Per-file `validateRelPath` from `skill-common.ts`
 *   3. `validateSkillMd` on SKILL.md content
 *   4. Multi-file bundle aggregation (`MAX_FILES_PER_SKILL`,
 *      `MAX_SKILL_BYTES`, per-file `MAX_FILE_BYTES`)
 *   5. Pre-publish content scan: every `scripts/*.{sh,py}` grepped
 *      for `\bclaude\s+-p\b` — reject. Closes the CI-guard gap
 *      flagged by both the security and feasibility reviewers in
 *      the v3 plan; the existing `bridge-flap-regression-guard`
 *      scans TS source only, not shell/python scripts.
 *   6. Behavioral validation: `bash -n` on `scripts/*.sh`,
 *      `python3 -m py_compile` on `scripts/*.py`
 *
 * Write: stage to a tmpdir, fsync, then atomic dir-rename into
 * `<skills-pool>/<name>/`. If a prior skill dir exists at that path,
 * it's first renamed aside, then unlinked once the new one is in
 * place (so the swap is atomic from any reader's perspective).
 *
 * On success: runs `switchroom apply --non-interactive` to materialise
 * symlinks for any agent that has the skill in its `skills:[]` list.
 *
 * `--dry-run`: every validator runs; the diff against current pool
 * content is printed; no writes land.
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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_SKILL,
  MAX_SKILL_BYTES,
  validateRelPath,
  validateSkillMd,
} from "./skill-common.js";
import { loadConfig } from "../config/loader.js";
import { withConfigError } from "./helpers.js";
import chalk from "chalk";

// ─── Constants ───────────────────────────────────────────────────────

/** Same shape as `agent-config-skill-write.ts` uses for bundled-skill names. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Patterns matching scripts/*.{sh,py} for behavioral validation + content scan. */
const SH_SCRIPT_RE = /^scripts\/[A-Za-z0-9_.-]+\.sh$/;
const PY_SCRIPT_RE = /^scripts\/[A-Za-z0-9_.-]+\.py$/;

/**
 * Regex catching `claude -p` literally in script content. Conservative
 * by design — matches in comments and string literals too, because the
 * compliance gate is "this script must not invoke claude -p", and the
 * easiest evasion (move it to a comment, then uncomment at runtime) is
 * caught by being aggressive.
 *
 * Line-continuation evasion (`claude \<newline> -p`) is handled by
 * normalising backslash-newline pairs BEFORE the scan; see
 * `scanForClaudeP()` below.
 */
const CLAUDE_P_LITERAL_RE = /\bclaude\s+-p\b/m;

/**
 * Run the `claude -p` evasion-resistant content scan over a script
 * body. Returns true if a match is found.
 *
 * Normalises shell-style line continuations (`\<newline>`) and
 * Python-style line continuations to a single space before scanning,
 * so a payload like:
 *
 *   claude \
 *     -p 'attack'
 *
 * still trips the gate. (Without this, the single-line regex misses.)
 */
function scanForClaudeP(content: string): boolean {
  const normalised = content.replace(/\\\r?\n\s*/g, " ");
  return CLAUDE_P_LITERAL_RE.test(normalised);
}

// ─── Types ───────────────────────────────────────────────────────────

type FileMap = Record<string, string>;

interface ValidateResult {
  ok: boolean;
  errors: string[];
}

interface ApplyOpts {
  from?: string;
  dryRun?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function resolveSkillsPoolDir(override: string | undefined): string {
  const raw = override ?? "~/.switchroom/skills";
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  if (raw === "~") return homedir();
  return resolve(raw);
}

/**
 * Read stdin synchronously to EOF. Used when --from is omitted: the
 * operator pipes SKILL.md content in directly. We use the read(2)-
 * style loop via fs.readSync so behavior is predictable across
 * piped, redirected, and tty-less invocations.
 */
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
 * Detect content type from a sniff of bytes — tarball vs UTF-8 text.
 * Tarballs have a magic at offset 257 (`ustar`), but for our purposes a
 * cheaper sniff is to look for the GNU tar magic and also check if the
 * file extension hints. Cheap-and-correct beats clever here.
 */
function isTarballPath(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz")
  );
}

/**
 * Load file map from --from <path-to-dir>. Walks the dir, builds the
 * map of relpath → content. Refuses if the dir contains symlinks
 * anywhere — the operator should rsync first if symlinks are needed.
 */
function loadFromDir(dir: string): FileMap {
  const abs = realpathSync(dir);
  if (!statSync(abs).isDirectory()) {
    fail(`--from path is not a directory: ${dir}`);
  }
  const files: FileMap = {};
  const walk = (sub: string): void => {
    const entries = readdirSync(sub, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(sub, ent.name);
      const rel = relative(abs, full);
      if (ent.isSymbolicLink()) {
        fail(`refusing to read symlink inside --from dir: ${rel}`);
      }
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (ent.isFile()) {
        const buf = readFileSync(full);
        files[rel.replace(/\\/g, "/")] = buf.toString("utf-8");
      }
      // ignore sockets, fifos, devices — silently skip
    }
  };
  walk(abs);
  return files;
}

/**
 * Load file map from --from <path-to-tarball>. Uses `tar` binary; the
 * extract goes into a mkdtempSync staging dir we then walk via
 * `loadFromDir`. We never trust tar to enforce path safety —
 * `validateRelPath` is the gate.
 */
function loadFromTarball(tarPath: string): FileMap {
  // PRE-EXTRACT VALIDATION: list the tarball entries via `tar -t` first
  // and refuse any entry that fails `validateRelPath`. This closes the
  // window where `tar` would write a path-traversal entry (`../etc/passwd`,
  // absolute `/etc/passwd`) BEFORE validation ever ran. tar handles
  // `--no-absolute-names` for absolute paths, but `../` traversal is
  // historically inconsistent — better to refuse them ourselves.
  const isGz = tarPath.endsWith(".gz") || tarPath.endsWith(".tgz");
  const listFlags = isGz ? ["-tzf"] : ["-tf"];
  const list = spawnSync("tar", [...listFlags, tarPath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (list.status !== 0) {
    fail(`tar list failed (exit ${list.status}): ${(list.stderr ?? "").trim()}`);
  }
  const entries = (list.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith("/")); // ignore dir entries
  for (const entry of entries) {
    if (!validateRelPath(entry)) {
      fail(
        `tarball contains disallowed path: ${JSON.stringify(entry)} — ` +
        `refusing to extract before any file is written`,
      );
    }
  }

  const staging = mkdtempSync(join(tmpdir(), "skill-apply-extract-"));
  try {
    const flags = isGz ? ["-xzf"] : ["-xf"];
    const r = spawnSync(
      "tar",
      [
        ...flags,
        tarPath,
        "-C",
        staging,
        "--no-same-owner",
        "--no-same-permissions",
        "--no-absolute-names",
      ],
      { stdio: "pipe" },
    );
    if (r.status !== 0) {
      const stderr = r.stderr?.toString("utf-8") ?? "(no stderr)";
      fail(`tar extraction failed (exit ${r.status}): ${stderr.trim()}`);
    }
    return loadFromDir(staging);
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Load file map from --from <path-to-md>. Single SKILL.md content.
 */
function loadSingleFile(filePath: string): FileMap {
  const content = readFileSync(filePath, "utf-8");
  return { "SKILL.md": content };
}

/**
 * Load file map from stdin. Single SKILL.md content.
 */
function loadFromStdin(): FileMap {
  const content = readStdinSync();
  if (content.length === 0) {
    fail("no content on stdin; either pipe SKILL.md content in or pass --from");
  }
  return { "SKILL.md": content };
}

/**
 * Validate the full payload against every gate. Returns the list of
 * errors; empty list means valid.
 *
 * Exported for test access — the validator is the bulk of the CLI
 * verb's behavior and the test suite hits it directly with synthetic
 * file maps to avoid filesystem fixtures for the happy-path cases.
 */
export function validatePayload(name: string, files: FileMap): ValidateResult {
  const errors: string[] = [];

  // 1. Name regex.
  if (!SKILL_NAME_RE.test(name)) {
    errors.push(
      `skill name must match ${SKILL_NAME_RE.source}: got ${JSON.stringify(name)}`,
    );
  }

  // 2. Path allowlist.
  for (const path of Object.keys(files)) {
    if (!validateRelPath(path)) {
      errors.push(`disallowed file path: ${JSON.stringify(path)}`);
    }
  }

  // 3. SKILL.md must exist + validate.
  const skillMd = files["SKILL.md"];
  if (skillMd === undefined) {
    errors.push("payload is missing SKILL.md (required)");
  } else {
    const r = validateSkillMd(skillMd, name);
    if (!r.ok) {
      errors.push(`SKILL.md validation failed: ${r.message}`);
    }
  }

  // 4. Bundle aggregation.
  const fileCount = Object.keys(files).length;
  if (fileCount > MAX_FILES_PER_SKILL) {
    errors.push(
      `bundle has ${fileCount} files; max is ${MAX_FILES_PER_SKILL}`,
    );
  }
  let totalBytes = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > MAX_FILE_BYTES) {
      errors.push(
        `${path} is ${bytes} bytes; max per file is ${MAX_FILE_BYTES}`,
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_SKILL_BYTES) {
    errors.push(
      `bundle total ${totalBytes} bytes; max per skill is ${MAX_SKILL_BYTES}`,
    );
  }

  // 5. Pre-publish `claude -p` content scan in scripts.
  //    Uses evasion-resistant scanner that normalises line continuations.
  for (const [path, content] of Object.entries(files)) {
    if (SH_SCRIPT_RE.test(path) || PY_SCRIPT_RE.test(path)) {
      if (scanForClaudeP(content)) {
        errors.push(
          `${path} contains \`claude -p\` literal — banned under Anthropic ` +
          `2026-06-15 policy (programmatic usage). Route via inject_inbound ` +
          `IPC into the live session instead.`,
        );
      }
    }
  }

  // 6. Behavioral validation: bash -n, python -m py_compile.
  // Only runs if other gates passed (otherwise the errors above are noise).
  if (errors.length === 0) {
    for (const [path, content] of Object.entries(files)) {
      if (SH_SCRIPT_RE.test(path)) {
        const r = spawnSync("bash", ["-n"], {
          input: content,
          encoding: "utf-8",
        });
        if (r.status !== 0) {
          errors.push(
            `${path} fails \`bash -n\` syntax check: ${(r.stderr ?? "").trim()}`,
          );
        }
      } else if (PY_SCRIPT_RE.test(path)) {
        // py_compile via stdin: write to a tmpfile, compile, unlink.
        const tmp = mkdtempSync(join(tmpdir(), "skill-apply-py-"));
        const tmpPy = join(tmp, "check.py");
        try {
          writeFileSync(tmpPy, content);
          const r = spawnSync("python3", ["-m", "py_compile", tmpPy], {
            encoding: "utf-8",
          });
          if (r.status !== 0) {
            errors.push(
              `${path} fails \`python3 -m py_compile\` syntax check: ${(r.stderr ?? "").trim()}`,
            );
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Compute a diff summary between the current on-disk skill (if any)
 * and the proposed payload. Used by --dry-run output. Plain-text
 * diff stats; no full content rendered (we trust the operator to
 * inspect the actual content separately if they want).
 */
export function diffSummary(currentDir: string, files: FileMap): string {
  const lines: string[] = [];
  const currentFiles: FileMap = {};
  if (existsSync(currentDir)) {
    // Build the current file map. Mirror loadFromDir without symlink-refuse
    // (the current pool might have arbitrary content from prior installs).
    const walk = (sub: string): void => {
      for (const ent of readdirSync(sub, { withFileTypes: true })) {
        const full = join(sub, ent.name);
        const rel = relative(currentDir, full);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          currentFiles[rel.replace(/\\/g, "/")] = readFileSync(full, "utf-8");
        }
      }
    };
    walk(currentDir);
  }
  const allPaths = new Set([
    ...Object.keys(currentFiles),
    ...Object.keys(files),
  ]);
  for (const path of [...allPaths].sort()) {
    const before = currentFiles[path];
    const after = files[path];
    if (before === undefined && after !== undefined) {
      lines.push(chalk.green(`  + ${path}  (${Buffer.byteLength(after, "utf-8")} bytes)`));
    } else if (before !== undefined && after === undefined) {
      lines.push(chalk.red(`  - ${path}  (was ${Buffer.byteLength(before, "utf-8")} bytes)`));
    } else if (before !== after) {
      lines.push(
        chalk.yellow(
          `  ~ ${path}  (${Buffer.byteLength(before!, "utf-8")} → ${Buffer.byteLength(after!, "utf-8")} bytes)`,
        ),
      );
    }
  }
  if (lines.length === 0) {
    return "  (no changes — payload matches current pool content)";
  }
  return lines.join("\n");
}

/**
 * Stage the new payload into a tmpdir, then atomic-rename it into the
 * pool. If a prior dir exists, rename it aside first, then unlink it
 * after the new one is in place — the swap is atomic from any reader's
 * perspective.
 */
export function writePayload(poolDir: string, name: string, files: FileMap): void {
  if (!existsSync(poolDir)) {
    mkdirSync(poolDir, { recursive: true, mode: 0o755 });
  }
  const target = join(poolDir, name);

  // Pre-flight: refuse if the target slot is a symlink (including dangling
  // symlinks). MUST happen BEFORE the staging dir is created and BEFORE
  // the try/catch — otherwise the rollback path tries to clean up
  // nonexistent state and the symlink would have already been clobbered.
  // existsSync follows symlinks (and returns false on dangling ones), so
  // we use lstatSync inside a try/catch to detect both cases.
  let targetIsSymlink = false;
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      targetIsSymlink = true;
    }
  } catch {
    // ENOENT — target doesn't exist; that's fine, proceed.
  }
  if (targetIsSymlink) {
    fail(`refusing to overwrite symlink at ${target}; investigate manually`);
  }

  const staging = mkdtempSync(join(poolDir, `.skill-apply-stage-${name}-`));
  let oldRename: string | null = null;
  try {
    // Write files into staging with O_CREAT|O_EXCL ('wx') so any
    // pre-existing file or symlink at the staging path errors out
    // rather than getting silently followed/overwritten. The staging
    // dir was just mkdtempSync'd so there can't be pre-existing files
    // unless an attacker raced the rename — the wx flag closes that
    // window too.
    for (const [path, content] of Object.entries(files)) {
      const full = join(staging, path);
      mkdirSync(dirname(full), { recursive: true, mode: 0o755 });
      const fd = openSync(full, "wx");
      try {
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
      // scripts/*.{sh,py} get +x.
      if (SH_SCRIPT_RE.test(path) || PY_SCRIPT_RE.test(path)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        fs.chmodSync(full, 0o755);
      }
    }
    // Atomic swap: rename existing target aside, rename staging → target,
    // then rm old. Use lstatSync (not existsSync) because we already
    // verified above that target isn't a symlink — but a dir could have
    // been created concurrently, and existsSync follows symlinks.
    let targetExists = false;
    try {
      lstatSync(target);
      targetExists = true;
    } catch { /* ENOENT — proceed */ }
    if (targetExists) {
      oldRename = `${target}.skill-apply-old-${Date.now()}`;
      renameSync(target, oldRename);
    }
    renameSync(staging, target);
    if (oldRename) {
      rmSync(oldRename, { recursive: true, force: true });
      oldRename = null;
    }
  } catch (err) {
    // Best-effort rollback.
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* nothing more to do */
    }
    if (oldRename && existsSync(oldRename)) {
      try {
        if (existsSync(target)) {
          rmSync(target, { recursive: true, force: true });
        }
        renameSync(oldRename, target);
      } catch {
        /* nothing more to do */
      }
    }
    throw err;
  }
}

function fail(msg: string): never {
  console.error(chalk.red(`error: ${msg}`));
  process.exit(2);
}

// ─── Command registration ────────────────────────────────────────────

export function registerSkillCommand(program: Command): void {
  const skill = program.command("skill").description("Skill pool management.");

  skill
    .command("apply <name>")
    .description(
      "Apply (write or update) a skill in the global pool. Reads SKILL.md " +
      "content from stdin by default, or a file/dir/tarball via --from. " +
      "Validates against the same gates an agent-proposed publish would " +
      "(name regex, path allowlist, SKILL.md frontmatter, bundle size, " +
      "`bash -n` / `py_compile` script checks, `claude -p` content scan).",
    )
    .option(
      "--from <path>",
      "Source path. Single .md → SKILL.md content; directory → multi-file; " +
      ".tar / .tar.gz / .tgz → extracted multi-file. Omit to read SKILL.md " +
      "from stdin.",
    )
    .option(
      "--dry-run",
      "Validate + show diff vs current pool content. No writes.",
      false,
    )
    .action(
      withConfigError(async (name: string, opts: ApplyOpts) => {
        // Load payload.
        let files: FileMap;
        if (opts.from === undefined) {
          files = loadFromStdin();
        } else {
          const fromPath = resolve(opts.from);
          if (!existsSync(fromPath)) {
            fail(`--from path does not exist: ${opts.from}`);
          }
          const st = statSync(fromPath);
          if (st.isDirectory()) {
            files = loadFromDir(fromPath);
          } else if (isTarballPath(fromPath)) {
            files = loadFromTarball(fromPath);
          } else if (fromPath.endsWith(".md")) {
            files = loadSingleFile(fromPath);
          } else {
            fail(
              `--from must be a directory, a .tar/.tar.gz/.tgz tarball, or a ` +
              `.md file. Got: ${opts.from}`,
            );
          }
        }

        // Validate every gate.
        const v = validatePayload(name, files);
        if (!v.ok) {
          console.error(chalk.red("Validation failed:"));
          for (const e of v.errors) {
            console.error(chalk.red(`  - ${e}`));
          }
          process.exit(3);
        }

        // Resolve pool dir.
        const config = loadConfig();
        const poolDir = resolveSkillsPoolDir(
          config.switchroom?.skills_dir,
        );
        const currentDir = join(poolDir, name);

        // Show diff summary.
        console.log(
          chalk.bold(`Skill: ${name}`) +
          chalk.gray(` (${Object.keys(files).length} files, ${sumBytes(files)} bytes)`),
        );
        console.log(chalk.bold("Diff vs current pool content:"));
        console.log(diffSummary(currentDir, files));

        if (opts.dryRun) {
          console.log(chalk.gray("\n(--dry-run; no writes performed)"));
          return;
        }

        // Write atomically.
        writePayload(poolDir, name, files);
        console.log(chalk.green(`\n✓ Wrote ${name} to ${currentDir}`));

        // Run switchroom apply to materialise symlinks for opt-in agents.
        // Best-effort: failure here doesn't roll back the write (the file
        // is in the pool; the operator can re-run apply manually).
        const applyBin = process.argv[1] ?? "switchroom";
        console.log(chalk.gray(`Running \`switchroom apply --non-interactive\`...`));
        const r = spawnSync(
          process.argv0,
          [applyBin, "apply", "--non-interactive"],
          { stdio: "inherit" },
        );
        if (r.status !== 0) {
          console.error(
            chalk.yellow(
              `(warning: \`switchroom apply\` exited ${r.status} — skill is ` +
              `in the pool but symlinks may not be refreshed. Re-run manually.)`,
            ),
          );
        }
      }),
    );
}

function sumBytes(files: FileMap): number {
  let n = 0;
  for (const c of Object.values(files)) {
    n += Buffer.byteLength(c, "utf-8");
  }
  return n;
}
