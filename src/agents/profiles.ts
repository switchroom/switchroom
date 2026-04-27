import { readFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
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
 * names that would escape PROFILES_ROOT via `..` or absolute paths.
 */
export function getProfilePath(profileName: string): string {
  const requested = resolve(PROFILES_ROOT, profileName);
  // Prevent path traversal — resolved path must stay within PROFILES_ROOT.
  // Use the platform separator so the boundary check works on Windows
  // (where `resolve` returns backslash-separated paths) as well as POSIX.
  if (requested !== PROFILES_ROOT && !requested.startsWith(PROFILES_ROOT + pathSep)) {
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
