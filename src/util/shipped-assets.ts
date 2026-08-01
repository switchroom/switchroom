import { existsSync, readFileSync, realpathSync } from "node:fs";
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

/**
 * Web dashboard static assets. `npm run build` copies `src/web/ui` to
 * `dist/cli/ui`, so the npm/dev layout finds it as the "image"-shaped
 * `<bundleDir>/ui` candidate; a source checkout finds `src/web/ui` the same
 * way. The compiled binary has no sibling `ui/` at all — `switchroom web`
 * from a static-binary install served a dashboard whose every static route
 * 404'd (#4163).
 */
export const WEB_UI_ASSET: ShippedAssetSpec = {
  asset: "ui",
  envVar: "SWITCHROOM_WEB_UI_ROOT",
};

/**
 * Version manifest written at the root of the shipped-asset payload by
 * `scripts/build-asset-payload.mjs`. Resolved through the SAME probe as the
 * asset directories, so "which payload am I using" can never answer a
 * different location than "which profiles am I using".
 */
export const ASSET_MANIFEST_FILENAME = "switchroom-assets.json";

export const ASSET_MANIFEST_ASSET: ShippedAssetSpec = {
  asset: ASSET_MANIFEST_FILENAME,
  envVar: "SWITCHROOM_ASSET_MANIFEST",
};

/**
 * Where a static-binary install stages its payload, derived from the real
 * binary path: `/usr/local/bin/switchroom` → `/usr/local/share/switchroom`.
 * This is the FIRST SEA candidate `orderedCandidates` probes, so the
 * installer and the resolver cannot disagree about the destination.
 */
export function payloadInstallRoot(execPath: string): string {
  return resolve(dirname(execPath), "../share/switchroom");
}

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
  /** Defaults to `fs.realpathSync`. See `canonicalise` for why it exists. */
  realpath?: (p: string) => string;
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
    const path = canonicalise(resolve(override), probe);
    return { path, candidates: [path], source: "env" };
  }

  const exists = probe.exists ?? existsSync;
  const candidates = orderedCandidates(spec, probe);
  for (const c of candidates) {
    if (exists(c.path)) {
      return {
        path: canonicalise(c.path, probe),
        candidates: candidates.map((x) => x.path),
        source: c.source,
      };
    }
  }
  return { path: null, candidates: candidates.map((x) => x.path), source: "none" };
}

/**
 * Resolve symlinks in a hit before handing it back.
 *
 * Load-bearing for the SEA layout (#4163): the asset payload is published as
 * `<prefix>/share/switchroom -> switchroom-<version>`, a SYMLINK, because
 * swapping a symlink is the only atomic way to replace a directory. Callers
 * that do a containment check against the resolved root then compare a
 * `realpath`'d child (`…/share/switchroom-0.19.44/profiles/default`) against an
 * un-realpath'd root (`…/share/switchroom/profiles`), decide the child escapes
 * the root, and refuse. Observed as `Invalid profile name: default` from
 * `getProfilePath` on a real `curl | sh` install — every agent failed to
 * scaffold, i.e. the exact #4160 symptom with a new cause.
 *
 * Canonicalising HERE fixes every consumer at once instead of asking each one
 * to remember. The probe list is deliberately left un-canonicalised: it is a
 * record of what was searched, and an operator needs to see the paths that were
 * actually probed.
 *
 * Falls back to the input on any error — a resolvable-but-unreadable path
 * should behave as it did before, not throw out of a resolver.
 */
function canonicalise(path: string, probe: ShippedAssetProbe): string {
  const realpath = probe.realpath ?? realpathSync;
  try {
    return realpath(path);
  } catch {
    return path;
  }
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

// ── payload version skew (#4163) ─────────────────────────────────────────
//
// The binary and the payload are two artifacts. Nothing at the filesystem
// level can swap both in one syscall, so instead of hoping they stay
// together we make disagreement DETECTABLE and REPAIRABLE:
//
//   - the installer and self-update fetch both from ONE release tag and
//     verify both against that release's switchroom-checksums.txt;
//   - the payload lands BEFORE the binary, so an interrupted update leaves
//     new-payload/old-binary, never new-binary/old-templates;
//   - `switchroom update` re-checks the manifest on EVERY run — including
//     the run where the binary is already current — and reinstalls a skewed
//     or missing payload, so an interrupted update converges on the next one;
//   - `switchroom doctor` reports skew with the repair command.
//
// Anything that reads a payload version goes through here, so the four
// sites above cannot drift in what "skewed" means.

/** Parsed `switchroom-assets.json`. */
export interface AssetPayloadManifest {
  /** The release tag the payload was cut from, normalised to `vX.Y.Z`. */
  version: string;
  entries?: readonly string[];
}

/**
 * Parse a manifest body. Returns null for anything that is not a manifest
 * with a usable version — a corrupt manifest must read as "unknown", which
 * `assetPayloadSkew` treats as skew, never as agreement.
 */
export function parseAssetPayloadManifest(
  body: string,
): AssetPayloadManifest | null {
  try {
    const parsed = JSON.parse(body) as { version?: unknown; entries?: unknown };
    const version = parsed?.version;
    if (typeof version !== "string" || !/^v?\d+\.\d+\.\d+/.test(version.trim())) {
      return null;
    }
    return {
      version: normaliseVersion(version),
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.filter((e): e is string => typeof e === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

function normaliseVersion(v: string): string {
  return `v${v.trim().replace(/^v/, "")}`;
}

export type AssetPayloadSkewStatus =
  /** No payload manifest was found at any probed location. */
  | "missing"
  /** A payload exists but its version could not be read. */
  | "unreadable"
  /** Payload version differs from the running CLI's. */
  | "skewed"
  /** Payload and CLI agree. */
  | "matched";

export interface AssetPayloadSkew {
  status: AssetPayloadSkewStatus;
  cliVersion: string;
  payloadVersion: string | null;
  /** Where the manifest was found, when it was. */
  manifestPath: string | null;
  /** Every path probed for the manifest. */
  candidates: readonly string[];
  /** True when the CLI must not be trusted to render current scaffolds. */
  ok: boolean;
  /** Operator-facing one-liner. */
  message: string;
}

/**
 * Compare the running CLI's version against the installed payload's.
 *
 * `readText` is injected so this is testable without a fixture tree; it must
 * return the file body or null/throw when unreadable.
 */
export function assetPayloadSkew(opts: {
  cliVersion: string;
  probe: ShippedAssetProbe;
  readText?: (path: string) => string | null;
}): AssetPayloadSkew {
  const cliVersion = normaliseVersion(opts.cliVersion);
  const resolution = resolveShippedAsset(ASSET_MANIFEST_ASSET, opts.probe);
  const base = {
    cliVersion,
    candidates: resolution.candidates,
  };
  if (resolution.path === null) {
    return {
      ...base,
      status: "missing",
      payloadVersion: null,
      manifestPath: null,
      ok: false,
      message:
        `no shipped-asset payload found for switchroom ${cliVersion} ` +
        `(${describeShippedAssetSearch(resolution)}). Agent scaffolding needs ` +
        `profiles/, skills/ and vendor/ on disk; re-run the installer or ` +
        `\`switchroom update\` to fetch the payload for this release.`,
    };
  }
  const readText =
    opts.readText ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    });
  let body: string | null = null;
  try {
    body = readText(resolution.path);
  } catch {
    body = null;
  }
  const manifest = body === null ? null : parseAssetPayloadManifest(body);
  if (!manifest) {
    return {
      ...base,
      status: "unreadable",
      payloadVersion: null,
      manifestPath: resolution.path,
      ok: false,
      message:
        `the shipped-asset payload at ${resolution.path} has no readable ` +
        `version. Treating it as skewed from switchroom ${cliVersion} — ` +
        `re-run \`switchroom update\` to reinstall it.`,
    };
  }
  if (manifest.version !== cliVersion) {
    return {
      ...base,
      status: "skewed",
      payloadVersion: manifest.version,
      manifestPath: resolution.path,
      ok: false,
      message:
        `shipped-asset payload is ${manifest.version} but the CLI is ` +
        `${cliVersion} (${resolution.path}). The CLI renders agent scaffolds ` +
        `from these templates, so a mismatched pair ships a new CLI against ` +
        `old templates — re-run \`switchroom update\` to bring them together.`,
    };
  }
  return {
    ...base,
    status: "matched",
    payloadVersion: manifest.version,
    manifestPath: resolution.path,
    ok: true,
    message: `shipped-asset payload ${manifest.version} matches the CLI (${resolution.path})`,
  };
}
