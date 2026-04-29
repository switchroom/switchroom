/**
 * Pinned dependency manifest (BOM) — Phase 0 of issue #360.
 *
 * The manifest lives at the switchroom repo root as `dependencies.json`.
 * It records the exact versions that were tested together so that
 * `switchroom doctor` can detect when installed versions have drifted
 * from what was tested. Phase 2 (issue #363) will consume this to
 * replace `@latest` installs in update.ts with pinned versions.
 */

import { z } from "zod";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

// ─── Schema ────────────────────────────────────────────────────────────────

export const ManifestSchema = z.object({
  switchroom_version: z.string().min(1),
  tested_at: z.string().min(1),
  runtime: z.object({
    bun: z.string().min(1),
    node: z.string().min(1),
  }),
  claude: z.object({
    cli: z.string().min(1),
  }),
  playwright_mcp: z.string().min(1),
  hindsight: z.object({
    backend: z.string().nullable(),
    client: z.string().nullable(),
  }),
  vault_broker: z.object({
    protocol: z.union([z.number().int(), z.string()]).nullable(),
  }),
});

export type Manifest = z.infer<typeof ManifestSchema>;

// ─── Loader ────────────────────────────────────────────────────────────────

/**
 * Walk up the directory tree from src/ to find the repo root containing
 * `dependencies.json`. Returns null if not found within 10 levels.
 */
function locateManifestPath(): string | null {
  let dir: string | undefined = import.meta.dirname;
  for (let i = 0; i < 10 && dir && dir !== "/"; i++) {
    const candidate = join(dir, "dependencies.json");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Load and validate the pinned dependency manifest from `dependencies.json`
 * at the switchroom repo root.
 *
 * Throws a descriptive Error if the file is missing or fails schema
 * validation. Callers should surface this to the user rather than
 * silently swallowing it.
 *
 * @param manifestPath - Override the auto-discovered path (useful in tests).
 */
export function loadManifest(manifestPath?: string): Manifest {
  const path = manifestPath ?? locateManifestPath();
  if (!path) {
    throw new Error(
      "dependencies.json not found — run `git status` from the switchroom root " +
      "or reinstall switchroom to restore the manifest",
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read manifest at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `dependencies.json at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `dependencies.json schema validation failed:\n${issues}`,
    );
  }

  return result.data;
}

// ─── Version probers ────────────────────────────────────────────────────────

/**
 * Run a shell command and return trimmed stdout, or null on error/timeout.
 */
function probe(cmd: string, timeoutMs = 5000): string | null {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Strip a leading "v" from a version string (e.g. "v22.22.2" → "22.22.2").
 */
function stripV(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

/**
 * Parse a major version number from a semver-ish string.
 * Returns null if parsing fails.
 */
function parseMajor(v: string | null): number | null {
  if (!v) return null;
  const m = stripV(v).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Read the installed bun version. Returns null if not found.
 * @internal exported for testing
 */
export function probeBunVersion(): string | null {
  const out = probe("bun --version");
  return out ? stripV(out) : null;
}

/**
 * Read the installed node version. Returns null if not found.
 * @internal exported for testing
 */
export function probeNodeVersion(): string | null {
  const out = probe("node --version");
  return out ? stripV(out) : null;
}

/**
 * Read the installed claude CLI version. Returns null if not installed.
 * @internal exported for testing
 */
export function probeClaudeVersion(): string | null {
  const out = probe("claude --version");
  if (!out) return null;
  // `claude --version` prints "2.1.123 (Claude Code)" or similar
  const m = out.match(/^(\S+)/);
  return m ? m[1] : out;
}

/**
 * Read the installed @playwright/mcp version from the npx cache.
 * Returns null if the package is not cached — absence is not an error;
 * it just means the user hasn't run a playwright skill yet.
 * @internal exported for testing
 */
export function probePlaywrightMcpVersion(): string | null {
  const home = process.env.HOME ?? "";
  const npxCache = join(home, ".npm/_npx");
  if (!existsSync(npxCache)) return null;

  try {
    const entries = readdirSync(npxCache);
    for (const entry of entries) {
      const pkgPath = join(
        npxCache,
        entry,
        "node_modules/@playwright/mcp/package.json",
      );
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
            version?: string;
          };
          if (pkg.version) return pkg.version;
        } catch {
          /* skip corrupt package.json */
        }
      }
    }
  } catch {
    /* unreadable npx cache — treat as not installed */
  }

  return null;
}

// ─── Drift detection ───────────────────────────────────────────────────────

export interface DriftItem {
  component: string;
  declared: string;
  installed: string | null;
}

export interface DriftReport {
  ok: boolean;
  drift: DriftItem[];
}

/**
 * Injectable probers for `detectDrift`. Providing these in tests lets you
 * avoid shelling out and avoids module-mock fragility.
 */
export interface DriftProbers {
  bun?: () => string | null;
  node?: () => string | null;
  claude?: () => string | null;
  playwrightMcp?: () => string | null;
}

/**
 * Components where drift is warn-only (does not flip `ok` to false).
 * Required components (bun, node, claude CLI) fail on major-version
 * mismatch or when not installed.
 */
const WARN_ONLY_COMPONENTS = new Set([
  "@playwright/mcp",
  "hindsight.backend",
  "hindsight.client",
  "vault_broker.protocol",
]);

/**
 * Probe all installed dependency versions and compare against the manifest.
 *
 * - bun, node, claude CLI: major-version mismatch → `ok: false`
 * - @playwright/mcp: version mismatch → warn only (not installed → skip)
 * - hindsight.*, vault_broker.protocol: warn only
 *
 * @param manifest - The pinned manifest to compare against.
 * @param probers - Optional overrides for version probers (useful in tests).
 */
export async function detectDrift(
  manifest: Manifest,
  probers: DriftProbers = {},
): Promise<DriftReport> {
  const drift: DriftItem[] = [];

  const bunProbe = probers.bun ?? probeBunVersion;
  const nodeProbe = probers.node ?? probeNodeVersion;
  const claudeProbe = probers.claude ?? probeClaudeVersion;
  const playwrightProbe = probers.playwrightMcp ?? probePlaywrightMcpVersion;

  // --- bun ---
  const bunInstalled = bunProbe();
  if (manifest.runtime.bun !== (bunInstalled ?? "")) {
    drift.push({
      component: "bun",
      declared: manifest.runtime.bun,
      installed: bunInstalled,
    });
  }

  // --- node ---
  const nodeInstalled = nodeProbe();
  if (manifest.runtime.node !== (nodeInstalled ?? "")) {
    drift.push({
      component: "node",
      declared: manifest.runtime.node,
      installed: nodeInstalled,
    });
  }

  // --- claude CLI ---
  const claudeInstalled = claudeProbe();
  if (manifest.claude.cli !== claudeInstalled) {
    // null installed is always reported as drift — claude CLI is required
    drift.push({
      component: "claude CLI",
      declared: manifest.claude.cli,
      installed: claudeInstalled,
    });
  }

  // --- @playwright/mcp (optional — warn only, skip if not cached) ---
  const playwrightInstalled = playwrightProbe();
  if (
    playwrightInstalled !== null &&
    manifest.playwright_mcp !== playwrightInstalled
  ) {
    drift.push({
      component: "@playwright/mcp",
      declared: manifest.playwright_mcp,
      installed: playwrightInstalled,
    });
  }
  // If playwrightInstalled === null → not yet cached, not a problem

  // Determine overall ok:
  // - warn-only components never fail
  // - required components fail on: null installed, or major-version mismatch
  const ok = drift.every((item) => {
    if (WARN_ONLY_COMPONENTS.has(item.component)) return true;

    // Not installed → fail
    if (item.installed === null) return false;

    // Major-version mismatch → fail
    const dMajor = parseMajor(item.declared);
    const iMajor = parseMajor(item.installed);
    if (dMajor !== null && iMajor !== null) {
      return dMajor === iMajor;
    }

    // Can't parse → literal equality
    return item.declared === item.installed;
  });

  return { ok, drift };
}
