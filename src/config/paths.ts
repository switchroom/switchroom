import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Dual-read path resolution for the project rename `clerk` -> `switchroom`.
 *
 * Historically we stored state under `~/.clerk/`. New installs use
 * `~/.switchroom/`. To avoid an outage at rename time, resolvers default to
 * `~/.switchroom/<fragment>` but transparently fall back to
 * `~/.clerk/<fragment>` when only the legacy path exists on disk.
 *
 * Once the filesystem is migrated (`mv ~/.clerk ~/.switchroom`), the fallback
 * is a no-op. Remove this shim in a future release.
 */

export const DEFAULT_STATE_DIR = ".switchroom";
export const LEGACY_STATE_DIR = ".clerk";

function home(): string {
  return process.env.HOME ?? "/root";
}

/**
 * Resolve a state-path fragment like `agents` or `vault.enc` under the user's
 * home directory, preferring `~/.switchroom/<frag>` and falling back to
 * `~/.clerk/<frag>` if only the legacy path exists.
 *
 * Returns the `~/.switchroom/...` path for new installs (even if nothing
 * exists yet) so callers can create new files in the canonical location.
 */
export function resolveStatePath(fragment: string): string {
  const h = home();
  const primary = resolve(h, DEFAULT_STATE_DIR, fragment);
  const legacy = resolve(h, LEGACY_STATE_DIR, fragment);
  if (!existsSync(primary) && existsSync(legacy)) {
    return legacy;
  }
  return primary;
}

/**
 * Expand a user-supplied path string (which may use `~/`, `~/.switchroom/` or
 * `~/.clerk/` prefixes) to an absolute path, applying the dual-read fallback
 * if the literal string points at the default `~/.switchroom/<frag>` location
 * but only the legacy `~/.clerk/<frag>` copy exists on disk.
 */
export function resolveDualPath(pathStr: string): string {
  const h = home();
  if (pathStr.startsWith("~/")) {
    const rest = pathStr.slice(2);
    const absolute = resolve(h, rest);
    // If the caller targeted the new ~/.switchroom/... tree and it's absent
    // but the legacy ~/.clerk/... equivalent exists, redirect.
    if (rest.startsWith(`${DEFAULT_STATE_DIR}/`)) {
      const frag = rest.slice(DEFAULT_STATE_DIR.length + 1);
      if (!existsSync(absolute)) {
        const legacy = resolve(h, LEGACY_STATE_DIR, frag);
        if (existsSync(legacy)) return legacy;
      }
    }
    return absolute;
  }
  return resolve(pathStr);
}
