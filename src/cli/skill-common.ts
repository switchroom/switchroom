/**
 * Shared helpers for skill self-service (install/remove + author).
 *
 * PR A of the agent-skill-authoring feature: extracted from
 * `agent-config-skill-write.ts` so the new authoring CLI
 * (`agent-config-skill-author.ts`) can share validators, error codes,
 * audit append, and the per-agent skill-dir resolution without
 * copy-paste drift.
 *
 * Scope of authoring rails (this PR):
 *   - Agent-scope ONLY. Global scope ("/usr/share/.../skills" or the
 *     bundled-pool) is a PR-B concern.
 *   - Per-file 256 KiB cap, per-skill 2 MiB cap, max 50 files per skill.
 *   - Path allowlist: SKILL.md, scripts/*.{sh,py}, assets/*,
 *     README.md, reference/*.md. Max depth 3.
 *   - Symlink TOCTOU: refuse anything whose realpath escapes the
 *     skill's scope root. New files opened O_EXCL ("wx"); edits
 *     resolve-then-check.
 *   - Cron-source denial: any author CLI call from a cron-triggered
 *     turn is rejected with E_SKILL_AUTHOR_REQUIRES_INTERACTIVE.
 *     Detection: `SWITCHROOM_TURN_SOURCE=cron` env var (the gateway
 *     pins this when a cron-fired prompt enters the agent).
 *
 * No quota enforcement in PR A per Ken.
 */

import { homedir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";
import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  realpathSync,
  readFileSync,
  statSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { parse as parseYaml } from "yaml";

/** Per-agent skill cap (matches install cap). Not enforced in PR A. */
export const MAX_SKILLS_PER_AGENT = 20;

/** Per-file size cap for authored skill files. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Per-skill aggregate cap. */
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;

/** Per-skill file count cap. */
export const MAX_FILES_PER_SKILL = 50;

/** Max path depth (number of segments) for a skill-relative path. */
export const MAX_PATH_DEPTH = 3;

/** Max length of the YAML `description:` field in SKILL.md. */
export const MAX_DESCRIPTION_LEN = 1024;

export type SkillAuthorErrorCode =
  | "E_SKILL_SCOPE_DENIED"
  | "E_SKILL_INVALID_NAME"
  | "E_SKILL_INVALID_PATH"
  | "E_SKILL_INVALID_FRONTMATTER"
  | "E_SKILL_FILE_TOO_LARGE"
  | "E_SKILL_BUNDLE_TOO_LARGE"
  | "E_SKILL_ALREADY_EXISTS"
  | "E_SKILL_VERSION_STALE"
  | "E_SKILL_AUTHOR_REQUIRES_INTERACTIVE"
  | "E_SKILL_NOT_FOUND"
  | "E_AGENT_PIN_REQUIRED";

export interface SkillAuthorError {
  ok: false;
  code: SkillAuthorErrorCode;
  message: string;
  exit: number;
}

export function authorExitCodeFor(code: SkillAuthorErrorCode): number {
  switch (code) {
    case "E_SKILL_AUTHOR_REQUIRES_INTERACTIVE":
      return 11;
    case "E_SKILL_VERSION_STALE":
      return 12;
    case "E_SKILL_ALREADY_EXISTS":
      return 13;
    case "E_SKILL_NOT_FOUND":
      return 14;
    case "E_SKILL_FILE_TOO_LARGE":
    case "E_SKILL_BUNDLE_TOO_LARGE":
      return 15;
    case "E_SKILL_INVALID_NAME":
    case "E_SKILL_INVALID_PATH":
    case "E_SKILL_INVALID_FRONTMATTER":
    case "E_SKILL_SCOPE_DENIED":
      return 9;
    case "E_AGENT_PIN_REQUIRED":
      return 16;
  }
}

export function authorErr(
  code: SkillAuthorErrorCode,
  message: string,
): SkillAuthorError {
  return { ok: false, code, message, exit: authorExitCodeFor(code) };
}

/** Validate the agent slug / skill name against the canonical pattern. */
export function validateSkillName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(name);
}

/** Lowercase + dash-collapse a free-form string into a slug.
 *
 *  Defensive only — the broker still validates the result with
 *  `validateSkillName`. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Resolve the on-disk root for an agent-scope skill.
 *
 *  Layout: `~/.switchroom/agents/<agent>/.claude/skills/<slug>/`.
 *  This is the same dir that `reconcile-default-skills.ts` materializes
 *  symlinks into for bundled defaults. The reconciler explicitly leaves
 *  non-symlink directories alone, so agent-authored real dirs coexist
 *  with bundled-symlink siblings.
 */
export function agentScopeSkillsRoot(agent: string, root?: string): string {
  const base = root
    ? resolve(root, agent)
    : resolve(homedir(), ".switchroom", "agents", agent);
  return join(base, ".claude", "skills");
}

export function agentScopeSkillDir(
  agent: string,
  slug: string,
  root?: string,
): string {
  return join(agentScopeSkillsRoot(agent, root), slug);
}

/** Detect whether the current turn was fired by cron.
 *
 *  The gateway sets `SWITCHROOM_TURN_SOURCE` per turn; cron-fired turns
 *  get `cron`. Authoring from cron is a footgun (the operator isn't
 *  watching to catch a hostile prompt-injection-driven rewrite of the
 *  agent's own skills) so we hard-deny.
 */
export function isCronTurn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWITCHROOM_TURN_SOURCE === "cron";
}

/** Validate a skill-relative path.
 *
 *  Allowlist:
 *    - SKILL.md (root)
 *    - README.md (root)
 *    - scripts/<file>.{sh,py}
 *    - assets/<...>            (max-depth 3 incl. assets/)
 *    - reference/<file>.md
 *
 *  Rejected: absolute paths, `..` segments, leading `/`, NUL,
 *  windows-style drive letters, depth > 3, empty segments.
 */
export function validateRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false; // C:\ etc.
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/");
  if (parts.length > MAX_PATH_DEPTH) return false;
  for (const seg of parts) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.startsWith(".")) return false; // no dotfiles
  }
  // Allowlist check.
  if (parts.length === 1) {
    return parts[0] === "SKILL.md" || parts[0] === "README.md";
  }
  if (parts.length === 2) {
    const [dir, file] = parts;
    if (dir === "scripts") return /^[A-Za-z0-9_.-]+\.(sh|py)$/.test(file!);
    if (dir === "assets") return /^[A-Za-z0-9_.-]+$/.test(file!);
    if (dir === "reference") return /^[A-Za-z0-9_.-]+\.md$/.test(file!);
    return false;
  }
  if (parts.length === 3) {
    // Only assets/<subdir>/<file> permitted at depth 3.
    if (parts[0] !== "assets") return false;
    if (!/^[A-Za-z0-9_.-]+$/.test(parts[1]!)) return false;
    if (!/^[A-Za-z0-9_.-]+$/.test(parts[2]!)) return false;
    return true;
  }
  return false;
}

/**
 * Parse YAML frontmatter from SKILL.md and validate the required keys.
 *
 *  Returns the parsed frontmatter object on success, or an error result.
 *  Required keys: `name` (must equal `expectedName`) and `description`
 *  (1..MAX_DESCRIPTION_LEN chars). Rejects duplicate top-level keys
 *  by re-parsing the frontmatter block as text.
 */
export function validateSkillMd(
  content: string,
  expectedName: string,
):
  | { ok: true; frontmatter: Record<string, unknown> }
  | SkillAuthorError {
  if (typeof content !== "string" || content.length === 0) {
    return authorErr("E_SKILL_INVALID_FRONTMATTER", "SKILL.md is empty");
  }
  // Frontmatter must start at byte 0 with `---\n`.
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      "SKILL.md must begin with YAML frontmatter delimited by `---`",
    );
  }
  const rest = content.slice(content.indexOf("\n") + 1);
  const endIdx = rest.indexOf("\n---");
  if (endIdx < 0) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      "SKILL.md frontmatter has no closing `---`",
    );
  }
  const fmText = rest.slice(0, endIdx);

  // Duplicate-key detection: cheap line scan of top-level `key:` lines.
  const seen = new Set<string>();
  for (const line of fmText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (seen.has(key)) {
      return authorErr(
        "E_SKILL_INVALID_FRONTMATTER",
        `duplicate frontmatter key: ${key}`,
      );
    }
    seen.add(key);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fmText);
  } catch (e) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      `frontmatter is not valid YAML: ${(e as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      "frontmatter must be a YAML mapping",
    );
  }
  const fm = parsed as Record<string, unknown>;
  if (fm.name !== expectedName) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      `frontmatter name=${JSON.stringify(fm.name)} must equal the skill slug ${JSON.stringify(expectedName)}`,
    );
  }
  const desc = fm.description;
  if (
    typeof desc !== "string" ||
    desc.length < 1 ||
    desc.length > MAX_DESCRIPTION_LEN
  ) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      `frontmatter description must be a string 1..${MAX_DESCRIPTION_LEN} chars`,
    );
  }
  return { ok: true, frontmatter: fm };
}

/**
 * Atomically write `content` to `absPath`, guaranteed to stay under
 * `scopeRoot`. Defends against symlink TOCTOU two ways:
 *   - On create (`mode: "create"`), opens with O_EXCL ("wx") so an
 *     attacker can't have pre-planted a symlink at the target path.
 *   - On edit (`mode: "overwrite"`), realpaths the existing file and
 *     refuses if it escapes `scopeRoot`. Also refuses if the existing
 *     path is a symlink (we never follow a symlink to write).
 *
 *  Caller is responsible for `validateRelPath` and aggregate size
 *  checks. Caller must also ensure `absPath`'s parent dir exists.
 */
export function safeWriteFile(
  absPath: string,
  scopeRoot: string,
  content: string | Buffer,
  mode: "create" | "overwrite" = "create",
): void | SkillAuthorError {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  if (buf.byteLength > MAX_FILE_BYTES) {
    return authorErr(
      "E_SKILL_FILE_TOO_LARGE",
      `${absPath} exceeds per-file cap ${MAX_FILE_BYTES} bytes (got ${buf.byteLength})`,
    );
  }
  // Defensive: realpath the scope root once; all writes must resolve
  // under it. (scopeRoot itself may not yet exist on first-create — in
  // that case we fall back to the unresolved string and trust the
  // caller created it.)
  let rootReal: string;
  try {
    rootReal = realpathSync(scopeRoot);
  } catch {
    rootReal = scopeRoot;
  }

  if (mode === "overwrite") {
    // The file should already exist. Realpath it and verify the
    // resolved path is still inside scopeRoot.
    let real: string;
    try {
      const st = lstatSync(absPath);
      if (st.isSymbolicLink()) {
        return authorErr(
          "E_SKILL_INVALID_PATH",
          `refuse to follow symlink at ${absPath}`,
        );
      }
      real = realpathSync(absPath);
    } catch {
      return authorErr("E_SKILL_NOT_FOUND", `${absPath} does not exist`);
    }
    if (real !== absPath && !real.startsWith(rootReal + sep)) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `${absPath} resolves outside scope root`,
      );
    }
    if (!real.startsWith(rootReal + sep) && real !== rootReal) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `${absPath} resolves outside scope root`,
      );
    }
  }

  // Also verify the parent dir realpath stays inside scopeRoot — the
  // create path can't rely on file existence yet.
  const parent = dirname(absPath);
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
  } catch {
    parentReal = parent;
  }
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    return authorErr(
      "E_SKILL_INVALID_PATH",
      `parent dir ${parent} resolves outside scope root`,
    );
  }

  // Per-component symlink walk from scopeRoot → parent(absPath).
  // realpathSync() collapses the chain but doesn't tell us whether any
  // intermediate dir is itself a symlink — and Node doesn't expose
  // openat(2)/O_NOFOLLOW per-segment from JS. Walking with lstatSync
  // catches the "swap a parent dir for a symlink to /tmp" attack.
  //
  // Best-effort caveat: this is racy against an attacker swapping a
  // parent inode between the walk and the openSync() below (true
  // TOCTOU window). The tighter invariant that closes that gap: the
  // temp file is opened with O_EXCL ("wx") in `parent` and immediately
  // renameSync()'d onto `absPath` in the SAME parent. If the parent
  // inode is swapped post-walk, either (a) open and rename both
  // resolve against the kernel's current dirent for `parent` (so the
  // swap is the attacker's problem — the data lands wherever the new
  // parent points, but the caller never sees a success path that
  // promises otherwise), or (b) open fails. Crucially we never follow
  // a stale realpath result after walking.
  // Walk the UNRESOLVED `parent` path (not parentReal, which already
  // followed every symlink): start at scopeRoot and lstat each
  // intermediate component.
  if (parent === scopeRoot || parent.startsWith(scopeRoot + sep)) {
    const relFromRoot = parent === scopeRoot
      ? ""
      : parent.slice(scopeRoot.length + 1);
    if (relFromRoot.length > 0) {
      const segs = relFromRoot.split(sep);
      let cur = scopeRoot;
      for (const seg of segs) {
        cur = join(cur, seg);
        try {
          const st = lstatSync(cur);
          if (st.isSymbolicLink()) {
            return authorErr(
              "E_SKILL_INVALID_PATH",
              `refuse to write under symlinked parent component: ${cur}`,
            );
          }
        } catch {
          // Missing intermediate dir is a caller bug, but defer the
          // failure to openSync below for a clearer error.
        }
      }
    }
  }

  // Atomic write via O_EXCL temp + rename for both modes.
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  let fd: number;
  try {
    fd = openSync(tmp, "wx", 0o600);
  } catch (e) {
    return authorErr(
      "E_SKILL_INVALID_PATH",
      `failed to open temp ${tmp}: ${(e as Error).message}`,
    );
  }
  try {
    writeSync(fd, buf);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  // For create mode, target must not exist (O_EXCL semantics).
  if (mode === "create" && existsSync(absPath)) {
    try {
      // Clean up the staged temp.
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(tmp);
    } catch { /* ignore */ }
    return authorErr(
      "E_SKILL_ALREADY_EXISTS",
      `${absPath} already exists`,
    );
  }
  const { renameSync } = require("node:fs") as typeof import("node:fs");
  renameSync(tmp, absPath);
}

/** Compute a "version token" for a skill dir — the dir's mtime in ms.
 *  Bumps on any file rename/create/delete inside the dir (POSIX
 *  semantics). Used as the optimistic-concurrency token for edit. */
export function skillVersionToken(skillDir: string): string {
  const st = statSync(skillDir);
  return String(st.mtimeMs);
}

/** Recursively enumerate files under `dir`, returning paths relative
 *  to it. Used by `skillRead({file: undefined})` to enumerate the
 *  tree and by aggregate-size enforcement. */
export function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(sub: string, rel: string) {
    const entries = readdirSync(sub, { withFileTypes: true });
    for (const e of entries) {
      const childAbs = join(sub, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(childAbs, childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
      // Symlinks are intentionally skipped — the author surface never
      // emits them, and listing them would be misleading.
    }
  }
  walk(dir, "");
  return out;
}

/** Aggregate byte count of all files in `dir`. */
export function totalSkillBytes(dir: string): number {
  let total = 0;
  for (const rel of listSkillFiles(dir)) {
    try {
      total += statSync(join(dir, rel)).size;
    } catch { /* ignore */ }
  }
  return total;
}

/** Re-export the existing audit-append helper at a stable shared path so
 *  the new author CLI doesn't have to import from `agent-config.ts`
 *  directly (and so a future refactor can swap the backend in one
 *  place). */
export { appendAudit } from "./agent-config.js";

/** Read a SKILL.md file from disk and return its frontmatter, or null
 *  if it doesn't exist / can't be parsed. Used by `skillRead` for the
 *  no-`file` summary mode. */
export function readSkillFrontmatter(
  skillDir: string,
): Record<string, unknown> | null {
  const p = join(skillDir, "SKILL.md");
  if (!existsSync(p)) return null;
  try {
    const content = readFileSync(p, "utf-8");
    if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
      return null;
    }
    const rest = content.slice(content.indexOf("\n") + 1);
    const endIdx = rest.indexOf("\n---");
    if (endIdx < 0) return null;
    const fm = parseYaml(rest.slice(0, endIdx));
    return fm && typeof fm === "object" && !Array.isArray(fm)
      ? (fm as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Ensure `~/.switchroom/agents/<agent>/.claude/skills/` exists.
 *  Used by `skillCreate`. */
export function ensureSkillsRoot(agent: string, root?: string): string {
  const dir = agentScopeSkillsRoot(agent, root);
  mkdirSync(dir, { recursive: true });
  return dir;
}
