/**
 * Per-agent scratch volume — relocating build/package caches off the
 * container root disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every agent's HOME is `~/.switchroom/agents/<name>/home` on the operator's
 * ROOT disk (bind-mounted into the container at `/state/agent/home`). Every
 * package manager an agent reaches for writes its cache under that HOME:
 * `~/.cache/uv`, `~/.npm`, `~/.bun/install/cache`, `~/.cache/puppeteer`,
 * `~/.cache/ms-playwright`, `~/.local/lib/pythonX.Y/site-packages`. On the
 * reference fleet those caches were measured at ~20 GiB across the agents and
 * pushed the root filesystem to 85% full; a manual sweep reclaimed 32 GiB and
 * the caches regrew within hours. Sweeping does not hold — the caches have to
 * live somewhere else.
 *
 * Most hosts that run a fleet have a second, large device (the reference host
 * has 1.8 TiB at `/mnt/bulkdata`). This module gives every agent a per-agent
 * directory on that device, bind-mounted at `/scratch` inside the container,
 * plus the environment redirects that make the package managers actually write
 * there.
 *
 * WHY NOT `bind_mounts:`
 * ----------------------
 * The operator-facing `bind_mounts:` key is an ADMIN-ONLY escalation —
 * `emitAgentService` throws for any agent that declares it without
 * `admin: true` (see the `bind_mounts is an admin-only escalation` guard in
 * compose.ts, issue #1164). The biggest cache consumers on a real fleet are
 * ordinary non-admin agents, so routing this through `bind_mounts:` would
 * either break them at apply time or force a privilege grant nobody wants.
 * The scratch mount is therefore FRAMEWORK-INJECTED, exactly like the shared
 * `skills/` mount and the root-tier mount set: emitted by the generator itself
 * and deliberately outside the `bind_mounts` denylist, because the framework
 * — not the operator's yaml — chose both the source and the target.
 *
 * DEGRADATION
 * -----------
 * A dev machine has no second volume. The feature is a hard no-op when the
 * configured volume root does not exist: no mount line, no env redirects, and
 * agents keep using their HOME caches exactly as before. That is a
 * per-generate probe of the real filesystem, not a config assertion.
 */

import { chownSync, existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { allocateAgentUid } from "./agent-uid.js";

/**
 * Host directory that must already exist for the feature to engage — the
 * mountpoint of the operator's bulk device. Chosen to match the documented
 * fleet layout; override with `scratch.volume` in switchroom.yaml.
 */
export const DEFAULT_SCRATCH_VOLUME = "/mnt/bulkdata";

/** Relative path under the volume that holds the per-agent scratch dirs. */
export const DEFAULT_SCRATCH_SUBDIR = "switchroom/scratch";

/** In-container mount target. Same for every agent (each sees only its own). */
export const SCRATCH_CONTAINER_DIR = "/scratch";

/**
 * Subdirectories pre-created (and chowned to the agent uid) inside each
 * agent's scratch dir at apply time.
 *
 * `tmp` and `python` are load-bearing: `TMPDIR` pointing at a missing
 * directory breaks `mkdtemp` in most tooling, and pip wants `PYTHONUSERBASE`
 * to be creatable. `cache` is the XDG root every other redirect nests under —
 * npm/bun/playwright create their own leaf dirs, but only if the parent is
 * traversable by the agent uid.
 */
export const SCRATCH_SUBDIRS = ["cache", "tmp", "python"] as const;

export interface ResolvedScratchConfig {
  enabled: boolean;
  /** Absolute host path that must exist for the feature to engage. */
  volume: string;
  /** Relative path under {@link volume} holding the per-agent dirs. */
  subdir: string;
  /** True when the operator wrote an explicit `scratch:` block. */
  explicit: boolean;
}

/**
 * Resolve the `scratch:` block (or its defaults) from a parsed config.
 *
 * Accepts a partial config so callers that only hold a fragment (tests, the
 * doctor probe) don't have to build a whole `SwitchroomConfig`.
 */
export function resolveScratchConfig(
  config: Pick<SwitchroomConfig, "scratch"> | { scratch?: unknown },
): ResolvedScratchConfig {
  const raw = (config as { scratch?: Record<string, unknown> | undefined })
    .scratch;
  const volume =
    typeof raw?.volume === "string" && raw.volume.length > 0
      ? raw.volume
      : DEFAULT_SCRATCH_VOLUME;
  const subdir =
    typeof raw?.subdir === "string" && raw.subdir.length > 0
      ? raw.subdir
      : DEFAULT_SCRATCH_SUBDIR;
  return {
    enabled: raw?.enabled !== false,
    volume,
    subdir,
    explicit: raw !== undefined,
  };
}

/**
 * Is the bulk volume actually present on this machine?
 *
 * Probes the real filesystem — a symlink to a live directory counts (statSync
 * follows), a dangling symlink or a plain file does not. This is the single
 * gate that makes the whole feature a no-op on a dev box.
 */
export function scratchVolumeAvailable(volume: string): boolean {
  if (!isAbsolute(volume)) return false;
  try {
    return existsSync(volume) && statSync(volume).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Host-side scratch directory for one agent, or null when the feature is off
 * (disabled in config, or the volume isn't mounted on this host).
 *
 * `agentName` is already constrained to `[a-z0-9][a-z0-9_-]*` by the config
 * schema, so it cannot escape the volume via `..`; the guard below is a
 * belt-and-braces check because the return value is interpolated into a
 * docker bind source.
 */
export function agentScratchHostDir(
  cfg: ResolvedScratchConfig,
  agentName: string,
): string | null {
  if (!cfg.enabled) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(agentName)) return null;
  if (!scratchVolumeAvailable(cfg.volume)) return null;
  return join(cfg.volume, cfg.subdir, agentName);
}

/**
 * Create each agent's scratch directory (and its fixed subdirs) on the bulk
 * volume, owned by that agent's container uid.
 *
 * OWNERSHIP IS THE POINT. Agent containers run as a deterministic per-agent
 * non-root uid (`allocateAgentUid`, 10001–10999) on a `read_only: true` root
 * fs. If docker auto-creates the bind source it is `root:root 0755` and every
 * write from inside the container EACCESes — which for a cache directory
 * means `npm install` / `uv sync` / `pip install` fail at the first write,
 * not gracefully fall back. Worse, `apply` self-elevates to root, so even the
 * pre-create would land root-owned without an explicit chown. Same trap and
 * the same remedy as the per-agent `.vault-token` and audit dirs (apply.ts's
 * `chownSync(allocateAgentUid(name))` / `alignAgentUid`'s chown sweep).
 *
 * Non-recursive by design: we create these directories, and everything below
 * them is written by the agent uid itself, so a recursive sweep over a
 * multi-gigabyte cache tree on every apply would be pure cost.
 *
 * Best-effort per agent: a dev host where the operator lacks CAP_CHOWN gets
 * the directories with operator ownership rather than a failed apply. Returns
 * the directories it created or aligned, for callers that want to report.
 */
export function ensureAgentScratchDirs(
  cfg: ResolvedScratchConfig,
  agentNames: readonly string[],
  /**
   * chown seam. Defaults to `chownSync`; tests inject a recorder so the
   * ownership contract is asserted without needing CAP_CHOWN on the runner.
   */
  chown: (path: string, uid: number, gid: number) => void = chownSync,
): string[] {
  const touched: string[] = [];
  for (const name of agentNames) {
    const dir = agentScratchHostDir(cfg, name);
    if (dir === null) continue;
    try {
      const uid = allocateAgentUid(name);
      const paths = [dir, ...SCRATCH_SUBDIRS.map((s) => join(dir, s))];
      for (const p of paths) {
        mkdirSync(p, { recursive: true });
        try {
          chown(p, uid, uid);
        } catch {
          /* dev host without CAP_CHOWN — leave existing ownership */
        }
      }
      touched.push(dir);
    } catch {
      /* best-effort: never fail an apply over a cache directory */
    }
  }
  return touched;
}

/**
 * Environment redirects that point every package manager's cache at the
 * scratch mount. Emitted into the agent service ONLY when the mount is.
 *
 * Per variable:
 *   - `SWITCHROOM_AGENT_SCRATCH` — the contract itself: how an agent, a skill,
 *     or a sub-agent discovers it has a big scratch disk (and its absence
 *     tells them it doesn't).
 *   - `XDG_CACHE_HOME` — the umbrella redirect. `uv` (the single largest
 *     offender measured), pip's HTTP cache, `go`, `deno`, and most XDG-aware
 *     tooling derive their cache dir from it.
 *   - `TMPDIR` — big unpack/extract temporaries. NOTE: `/tmp` in an agent is a
 *     RAM-backed tmpfs charged against the container's `mem_limit`
 *     (compose.ts's `tmpfs: - /tmp:size=…`), so this one is not a root-disk
 *     saving — it moves multi-GiB unpacks off RAM and out from under the
 *     tmpfs size ceiling, which is why an npm/bun install of a large tree
 *     stops failing with a confusing ENOSPC.
 *   - `npm_config_cache` — npm ignores `XDG_CACHE_HOME` and defaults to
 *     `~/.npm`. Spelled lowercase because that is npm's canonical env form;
 *     the existing `NPM_CONFIG_PREFIX` (a different knob — global INSTALL
 *     prefix, deliberately left on the persistent HOME) is unaffected.
 *   - `BUN_INSTALL_CACHE_DIR` — bun ignores XDG too, defaults to
 *     `~/.bun/install/cache`.
 *   - `PYTHONUSERBASE` — the user-site tree `PIP_USER=1` installs into
 *     (`~/.local` by default). Packages, not a cache, but numpy/pandas/polars
 *     are among the largest single consumers on the root disk. BEHAVIOUR
 *     CHANGE: python's user-site moves with it, so packages installed before
 *     this landed are no longer importable and must be reinstalled once.
 *   - `PLAYWRIGHT_BROWSERS_PATH` — overrides the Dockerfile's bake of
 *     `/state/agent/home/.cache/ms-playwright`. Safe because the boot seeding
 *     in `profiles/_base/start.sh.hbs` reads
 *     `${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}` — it follows
 *     this env rather than hard-coding the HOME path.
 *   - `PUPPETEER_CACHE_DIR` — puppeteer resolves `os.homedir()/.cache/
 *     puppeteer` directly and does NOT honour `XDG_CACHE_HOME`, so the
 *     umbrella redirect alone would leave its ~200 MiB Chromium downloads on
 *     the root disk.
 *
 * Keys are returned unsorted; the compose emitter sorts the merged env map.
 */
export function scratchEnv(
  containerDir: string = SCRATCH_CONTAINER_DIR,
): Record<string, string> {
  const cache = `${containerDir}/cache`;
  return {
    SWITCHROOM_AGENT_SCRATCH: containerDir,
    XDG_CACHE_HOME: cache,
    TMPDIR: `${containerDir}/tmp`,
    npm_config_cache: `${cache}/npm`,
    BUN_INSTALL_CACHE_DIR: `${cache}/bun`,
    PYTHONUSERBASE: `${containerDir}/python`,
    PLAYWRIGHT_BROWSERS_PATH: `${cache}/ms-playwright`,
    PUPPETEER_CACHE_DIR: `${cache}/puppeteer`,
  };
}
