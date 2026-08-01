/**
 * Seed `~/.switchroom/skills/_bundled/` from the shipped `skills/` payload
 * when the pool does not exist yet (#4163).
 *
 * The pool is populated by the `sync-bundled-skills` step of `switchroom
 * update`. On a host that has only ever run `curl -fsSL … | sh`, that step has
 * never run, so the FIRST `switchroom apply` scaffolds every agent against an
 * empty pool: `installSwitchroomSkills` and `reconcileAgentDefaultSkills` each
 * print "bundled skills pool dir not found … run `switchroom update`" and skip
 * every skill. Observed end-to-end on a fresh Debian container: 10 skills
 * skipped on the only agent in the example config. Hand-syncing the pool was
 * the operator stopgap this issue exists to remove.
 *
 * Deliberately BOOTSTRAP-ONLY: this runs iff the pool directory is absent.
 * Once it exists, `switchroom update` owns it — its manifest tracks which
 * names switchroom shipped so it can retire them without wiping hand-added
 * skills, and apply must not race that ownership model. The sync itself is the
 * same additive, manifest-writing `syncBundledSkills`, so the pool apply
 * creates is indistinguishable from the one update would have created.
 *
 * Soft-fails: a missing payload (source checkout, unusual layout) or a copy
 * error must not fail `apply`. The pre-existing per-skill warnings still fire
 * downstream, which is exactly the behaviour before this module existed.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SKILLS_ASSET, resolveShippedAsset, type ShippedAssetProbe } from "../util/shipped-assets.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";
import { syncBundledSkills } from "./sync-bundled-skills.js";

export interface BootstrapSkillsPoolOptions {
  /** Pool dir. Defaults to `~/.switchroom/skills/_bundled`. */
  poolDir?: string;
  /** Asset probe. Defaults to the running bundle / executable. */
  probe?: ShippedAssetProbe;
  /** Version stamped into the pool manifest. */
  version?: string;
  /** Diagnostics sink. Defaults to stderr. */
  warn?: (msg: string) => void;
}

export type BootstrapSkillsPoolResult =
  /** Pool already present — update owns it from here. */
  | { status: "exists"; poolDir: string }
  /** Pool created and populated from the shipped payload. */
  | { status: "seeded"; poolDir: string; source: string; skills: number }
  /** No shipped skills/ payload could be resolved. */
  | { status: "no-payload"; poolDir: string; candidates: readonly string[] }
  /** The copy failed. Apply continues; downstream warnings still fire. */
  | { status: "failed"; poolDir: string; error: string };

export function bootstrapBundledSkillsPool(
  opts: BootstrapSkillsPoolOptions = {},
): BootstrapSkillsPoolResult {
  const poolDir = opts.poolDir ?? join(homedir(), ".switchroom", "skills", "_bundled");
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  if (existsSync(poolDir)) return { status: "exists", poolDir };

  const resolution = resolveShippedAsset(
    SKILLS_ASSET,
    opts.probe ?? { bundleDir: import.meta.dirname, execPath: process.execPath },
  );
  if (resolution.path === null) {
    return { status: "no-payload", poolDir, candidates: resolution.candidates };
  }

  try {
    mkdirSync(dirname(poolDir), { recursive: true });
    const r = syncBundledSkills({
      source: resolution.path,
      dest: poolDir,
      version: opts.version ?? SWITCHROOM_VERSION,
    });
    return {
      status: "seeded",
      poolDir,
      source: resolution.path,
      skills: r.added.length + r.updated.length,
    };
  } catch (err) {
    const error = (err as Error).message;
    warn(
      `switchroom: could not seed the bundled skills pool at ${poolDir} from ` +
        `${resolution.path} (${error}) — agents will scaffold without bundled ` +
        `skills. Run \`switchroom update\` to repair.`,
    );
    return { status: "failed", poolDir, error };
  }
}
