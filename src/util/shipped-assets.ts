import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolution of a directory the switchroom CLI *ships* — `profiles/`,
 * `skills/`, `vendor/hindsight-memory/`. One helper, used by every call
 * site, because these sites have drifted apart three times now and each
 * drift stranded a fleet:
 *
 *   - #3346  the agent Docker image: `resolve(import.meta.dirname,
 *            "../../profiles")` → `/profiles`, a path the image never
 *            shipped. Fixed by probing a second, image-shaped candidate.
 *   - #3492  the same shape for `skills/` in the hostd image.
 *   - #4160 / #4161  the published SEA (`bun build --compile`) binary.
 *            `import.meta.dirname` inside a compiled binary is the bunfs
 *            virtual root `/$bunfs/root` (verified: `resolve("/$bunfs/root",
 *            "../../profiles") === "/profiles"`), so BOTH existing
 *            candidates miss and `switchroom apply` failed for every agent
 *            with `Profile not found: default (searched /profiles)` while
 *            `sync-bundled-skills` silently no-op'd and still reported
 *            success.
 *
 * The layouts, and the candidate each one needs:
 *
 *   npm / dev      bundle at `<pkg>/dist/cli/switchroom.js`  → `../../<asset>`
 *   agent/hostd    bundle at `/opt/switchroom/switchroom.js` → `./<asset>`
 *     Docker image
 *   SEA binary     bundle at `/$bunfs/root` (virtual); the REAL file is
 *                  `process.execPath`, so probe FHS share dirs next to it.
 *
 * Nothing here writes; it only probes. When every candidate misses, the
 * caller gets the full candidate list so its error can name every path
 * that was actually tried — the old fall-through returned `candidates[0]`
 * and the operator was told switchroom "searched /profiles", a path no
 * install has ever used.
 */

/** Absolute FHS locations a packaged install may stage shipped assets in. */
export const FHS_SHARE_ROOTS: readonly string[] = [
  "/usr/local/share/switchroom",
  "/usr/share/switchroom",
];

/** Identifies one shipped asset directory and its operator escape hatch. */
export interface ShippedAssetSpec {
  /** Path of the asset relative to the package root, e.g. `"profiles"`. */
  readonly asset: string;
  /** Env var that, when set, wins outright (tests + operator escape hatch). */
  readonly envVar: string;
}

export const PROFILES_ASSET: ShippedAssetSpec = {
  asset: "profiles",
  envVar: "SWITCHROOM_PROFILES_ROOT",
};

export const SKILLS_ASSET: ShippedAssetSpec = {
  asset: "skills",
  envVar: "SWITCHROOM_SKILLS_ROOT",
};

export const HINDSIGHT_VENDOR_ASSET: ShippedAssetSpec = {
  asset: "vendor/hindsight-memory",
  envVar: "SWITCHROOM_HINDSIGHT_VENDOR_ROOT",
};

/** Runtime facts the probe needs. Every field is injectable so a test can
 *  simulate a layout it is not running under (that is the whole point —
 *  the SEA layout is unreachable from vitest otherwise). */
export interface ShippedAssetProbe {
  /** `import.meta.dirname` of the CALLING bundle. */
  bundleDir: string;
  /** `process.execPath`. Empty/undefined disables the SEA-sibling candidate. */
  execPath?: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `fs.existsSync`. */
  exists?: (p: string) => boolean;
}

/** Which layout produced the resolved path. `"none"` when nothing existed. */
export type ShippedAssetSource =
  | "env"
  | "npm"
  | "image"
  | "sea-sibling"
  | "fhs"
  | "none";

export interface ShippedAssetResolution {
  /** First candidate that exists on disk, else null. */
  path: string | null;
  /** EVERY path probed, in probe order. Never empty. */
  candidates: readonly string[];
  source: ShippedAssetSource;
}

interface Candidate {
  path: string;
  source: ShippedAssetSource;
}

/**
 * The ordered candidate list for `spec`, ignoring the env override and
 * without touching the filesystem. Exported for error messages and tests.
 */
export function shippedAssetCandidates(
  spec: ShippedAssetSpec,
  probe: ShippedAssetProbe,
): readonly string[] {
  return orderedCandidates(spec, probe).map((c) => c.path);
}

function orderedCandidates(
  spec: ShippedAssetSpec,
  probe: ShippedAssetProbe,
): Candidate[] {
  const out: Candidate[] = [];
  const push = (path: string, source: ShippedAssetSource): void => {
    if (!out.some((c) => c.path === path)) out.push({ path, source });
  };

  if (probe.bundleDir) {
    // npm / dev: <pkg>/dist/cli -> <pkg>/<asset>
    push(resolve(probe.bundleDir, "../..", spec.asset), "npm");
    // agent + hostd Docker images: /opt/switchroom -> /opt/switchroom/<asset>
    push(resolve(probe.bundleDir, spec.asset), "image");
  }

  // SEA: the bundle dir is virtual, so anchor on the real binary instead.
  // `/usr/local/bin/switchroom` -> `/usr/local/share/switchroom/<asset>`.
  if (probe.execPath) {
    push(
      resolve(dirname(probe.execPath), "../share/switchroom", spec.asset),
      "sea-sibling",
    );
  }
  for (const root of FHS_SHARE_ROOTS) {
    push(resolve(root, spec.asset), "fhs");
  }

  return out;
}

/**
 * Resolve a shipped asset directory.
 *
 * The env override wins outright and is NOT existence-checked — an
 * operator or test pointing at a specific root wants exactly that root,
 * and a silent fall-through to a bundled copy would hide their typo.
 * (This preserves `resolveProfilesRoot`'s pre-#4160 behaviour.)
 */
export function resolveShippedAsset(
  spec: ShippedAssetSpec,
  probe: ShippedAssetProbe,
): ShippedAssetResolution {
  const env = probe.env ?? process.env;
  const override = env[spec.envVar]?.trim();
  if (override) {
    const path = resolve(override);
    return { path, candidates: [path], source: "env" };
  }

  const exists = probe.exists ?? existsSync;
  const candidates = orderedCandidates(spec, probe);
  for (const c of candidates) {
    if (exists(c.path)) {
      return { path: c.path, candidates: candidates.map((x) => x.path), source: c.source };
    }
  }
  return { path: null, candidates: candidates.map((x) => x.path), source: "none" };
}

/**
 * Human-readable "here is everything I tried" clause for an error message.
 * Report every path — naming only the first candidate is what made #4160
 * unactionable.
 */
export function describeShippedAssetSearch(
  resolution: Pick<ShippedAssetResolution, "candidates">,
): string {
  return `searched ${resolution.candidates.length} location(s): ${resolution.candidates.join(", ")}`;
}
