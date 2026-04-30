import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join, sep as pathSep } from "node:path";
import Handlebars from "handlebars";

/**
 * Root of the filesystem profiles directory (project-level). Each
 * subdirectory is a named profile containing `CLAUDE.md.hbs`,
 * optional `SOUL.md.hbs`, and an optional `skills/` subdir. The
 * `_base/` sibling holds framework-level render templates
 * (start.sh.hbs, settings.json.hbs) that every agent uses regardless
 * of their `extends:` choice.
 */
const PROFILES_ROOT = resolve(import.meta.dirname, "../../profiles");

/**
 * Resolve the filesystem path for a named profile. Falls back to
 * `default` if the requested profile directory doesn't exist. Rejects
 * names that would escape PROFILES_ROOT via `..`, absolute paths, or
 * symlinks pointing outside the root.
 */
export function getProfilePath(profileName: string): string {
  const requested = resolve(PROFILES_ROOT, profileName);

  // Lexical boundary check — `resolve()` normalizes `..` segments so a
  // traversal like `"../etc"` ends up as a string that does NOT start
  // with PROFILES_ROOT + sep. Use `path.sep` (not a hardcoded "/") so
  // the comparison is correct on Windows too.
  if (requested !== PROFILES_ROOT && !requested.startsWith(PROFILES_ROOT + pathSep)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  // Symlink boundary check — same pattern as `memory-search.ts:274` and
  // `web/server.ts:302`. `path.resolve()` does NOT follow symlinks, so a
  // profile dir under PROFILES_ROOT that's actually a symlink to /etc
  // would pass the lexical check above and let `existsSync` /
  // `readFileSync` operate on the symlink target. Re-check after
  // realpath to close the gap. The `try { realpathSync } catch` is for
  // ENOENT — non-existent paths fall through to the existsSync branch
  // below where `hasProfileFiles` returns false and we use the fallback.
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    real = requested;
  }
  if (real !== PROFILES_ROOT && !real.startsWith(PROFILES_ROOT + pathSep)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  if (existsSync(requested) && hasProfileFiles(requested)) {
    return requested;
  }
  const fallback = resolve(PROFILES_ROOT, "default");
  if (existsSync(fallback)) {
    return fallback;
  }
  throw new Error(`Profile not found: ${profileName} (searched ${PROFILES_ROOT})`);
}

function hasProfileFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".hbs") || f === "skills");
  } catch {
    return false;
  }
}

/**
 * List the filesystem profiles under PROFILES_ROOT that a user can
 * pass to `switchroom agent create --profile <name>`. Skips the
 * framework-internal `_base/` profile (underscore-prefixed by
 * convention — users aren't meant to pick it) and any entry that
 * doesn't look like a real profile directory.
 */
export function listAvailableProfiles(): string[] {
  try {
    return readdirSync(PROFILES_ROOT)
      .filter((name) => !name.startsWith("_"))
      .filter((name) => {
        const p = resolve(PROFILES_ROOT, name);
        try {
          return statSync(p).isDirectory() && hasProfileFiles(p);
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Path to the `_base/` profile directory. Contains framework-level
 * render templates (start.sh.hbs, settings.json.hbs) that every
 * agent uses regardless of their `extends:` choice. Hardcoded name,
 * not user input, so no traversal check needed.
 */
export function getBaseProfilePath(): string {
  return resolve(PROFILES_ROOT, "_base");
}

/**
 * Read a .hbs file and render it with the given context.
 *
 * noEscape: our templates are markdown (*.md.hbs), shell (start.sh.hbs),
 * and JSON (settings.json.hbs). None are HTML. Handlebars' default HTML
 * escaping turns apostrophes into `&#x27;` and quotes into `&quot;`,
 * which is wrong everywhere it fires: markdown gets literal entity refs
 * in prompts the model sees (`Ken&#x27;s` instead of `Ken's`), and JSON
 * output breaks JSON-literal expectations. Disable escaping globally;
 * author templates defensively (no raw user HTML in contexts).
 */
export function renderTemplate(
  templatePath: string,
  context: Record<string, unknown>,
): string {
  const source = readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context);
}

/**
 * Recursively copy files from a profile's `skills/` directory into
 * the destination. Skips files that already exist at the destination
 * (idempotent). Used for bundled profile skills; user-selected global
 * skills come through a separate symlink path in scaffold.ts.
 */
export function copyProfileSkills(profilePath: string, destPath: string): void {
  const skillsSrc = join(profilePath, "skills");
  if (!existsSync(skillsSrc)) {
    return;
  }
  copyDirRecursive(skillsSrc, destPath);
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      // Idempotent: don't overwrite existing files
      if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Register a "json" helper for Handlebars to emit raw JSON
Handlebars.registerHelper("json", (value: unknown) => {
  return new Handlebars.SafeString(JSON.stringify(value, null, 2));
});

// Register an "isNumber" helper. Plain `{{#if value}}` treats 0 as
// falsy, but several config knobs (like memory.recall.max_memories)
// use 0 as a meaningful "disable cap" sentinel — rendering must
// distinguish "operator set 0" from "operator left it unset". This
// helper returns true for any finite number, including 0.
Handlebars.registerHelper("isNumber", (value: unknown) => {
  return typeof value === "number" && Number.isFinite(value);
});

// Register shared profile fragments as Handlebars partials so any profile
// template can use {{> fragment-name}} instead of copy-pasting the content.
// The _shared/ directory is underscore-prefixed (like _base/) and is not
// listed by listAvailableProfiles() — it's framework-internal.
const SHARED_FRAGMENTS_DIR = resolve(PROFILES_ROOT, "_shared");
const SHARED_FRAGMENTS = ["telegram-style"] as const;
for (const name of SHARED_FRAGMENTS) {
  const fragPath = join(SHARED_FRAGMENTS_DIR, `${name}.md.hbs`);
  if (existsSync(fragPath)) {
    Handlebars.registerPartial(name, readFileSync(fragPath, "utf-8"));
  }
}

/**
 * Render `profiles/<profileName>/CLAUDE.md.hbs` into
 * `profiles/<profileName>/CLAUDE.md` using the profile-level context
 * (no agent-specific values — those belong in the per-agent layer).
 *
 * Returns `{ wrote: true, path }` when the template was found and the
 * output file was written, or `{ wrote: false, path }` when the .hbs
 * source doesn't exist (caller can skip gracefully).
 */
export function renderProfileClaudeTemplate(
  profileName: string,
  /** Override the profiles root; used by tests to avoid touching real profiles. */
  profilesRoot: string = PROFILES_ROOT,
): { wrote: boolean; path: string } {
  const profileDir = resolve(profilesRoot, profileName);
  const hbsPath = join(profileDir, "CLAUDE.md.hbs");
  const outPath = join(profileDir, "CLAUDE.md");

  if (!existsSync(hbsPath)) {
    return { wrote: false, path: outPath };
  }

  const source = readFileSync(hbsPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  const rendered = template({ profile: profileName });
  writeFileSync(outPath, rendered, "utf-8");
  return { wrote: true, path: outPath };
}
