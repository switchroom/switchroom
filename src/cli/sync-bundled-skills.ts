/**
 * Manifest-owned, additive bundled-skill sync (footgun B).
 *
 * `switchroom update` mirrors the shipped `skills/` payload into the
 * host-stable pool `~/.switchroom/skills/_bundled/`. The historical
 * implementation did `rm -rf <pool>` then `cp -R` — which WIPES any skill
 * an operator hand-added into the pool. This module replaces that with an
 * additive, manifest-owned sync:
 *
 *   - A manifest `_bundled/.switchroom-manifest.json` records the set of
 *     skill names switchroom shipped, plus the CLI version that wrote it.
 *     It is the ownership boundary: switchroom only ever deletes names it
 *     previously shipped (present in the prior manifest) and no longer
 *     ships. A dir with no manifest record is NEVER touched.
 *   - Each shipped skill is staged into a temp sibling and atomically
 *     renamed over its pool entry, so a crash mid-sync never leaves a
 *     half-copied skill dir.
 *   - First run (no prior manifest) deletes NOTHING — every pre-manifest
 *     dir already in the pool is adopted, not wiped (bootstrap, Open-Risk #3).
 *   - A corrupt/unreadable manifest FAILS CLOSED for deletion: parse
 *     failure is never read as "everything was removed"; we copy the
 *     shipped skills, delete nothing, and rewrite a clean manifest
 *     (review missing-footgun #3).
 *
 * The manifest itself is written last, via temp + atomic rename, so an
 * interrupted run either keeps the old manifest or lands the complete new
 * one — never a truncated file.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const BUNDLED_SKILL_MANIFEST_NAME = ".switchroom-manifest.json";

export interface BundledSkillManifest {
  /** CLI version that wrote this manifest (provenance / debugging). */
  version: string;
  /** Sorted set of skill directory names switchroom shipped. */
  skills: string[];
  /** ISO timestamp of the write. */
  updatedAt: string;
}

export interface SyncBundledSkillsResult {
  /** Shipped skills newly present in the pool (were not in the prior manifest). */
  added: string[];
  /** Shipped skills that already existed and were refreshed. */
  updated: string[];
  /** Previously-shipped skills, no longer shipped, that were removed. */
  removed: string[];
  /** Pool dirs left untouched because they are not switchroom-owned
   *  (never appeared in a manifest) — hand-added skills survive. */
  preserved: string[];
  /** Shipped skill names that COLLIDED with a pre-existing, switchroom-unowned
   *  pool dir (a hand-added skill of the same name). Rather than silently wipe
   *  the operator's content (which would violate the footgun-B guarantee), the
   *  existing dir is preserved as a timestamped `<name>.operator-backup-<ts>`
   *  sibling, a loud stderr warning is emitted, and the shipped skill takes
   *  over the canonical name (a deliberate, visible ownership transfer). */
  ownershipTransferred: string[];
  /** True when there was no prior manifest (bootstrap: delete nothing). */
  firstRun: boolean;
  /** True when a prior manifest existed but could not be parsed
   *  (fail-closed: delete nothing this run). */
  manifestCorrupt: boolean;
}

/** List immediate subdirectory names of `dir` (skill dirs). Non-dirs and
 *  the manifest file are excluded. Returns [] if the dir is absent. */
function listSkillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Read the prior manifest. Returns:
 *   - `{ manifest }` when present and valid,
 *   - `{ firstRun: true }` when absent (bootstrap),
 *   - `{ corrupt: true }` when present but unparseable / wrong shape.
 */
export function readBundledSkillManifest(poolDir: string):
  | { manifest: BundledSkillManifest }
  | { firstRun: true }
  | { corrupt: true } {
  const path = join(poolDir, BUNDLED_SKILL_MANIFEST_NAME);
  if (!existsSync(path)) return { firstRun: true };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as BundledSkillManifest).skills) ||
      !(parsed as BundledSkillManifest).skills.every((s) => typeof s === "string")
    ) {
      return { corrupt: true };
    }
    const m = parsed as BundledSkillManifest;
    return { manifest: { version: String(m.version ?? ""), skills: m.skills, updatedAt: String(m.updatedAt ?? "") } };
  } catch {
    return { corrupt: true };
  }
}

/** Atomically copy one skill dir from `srcSkill` over `destSkill` via a
 *  temp sibling + rename, so a crash never leaves a half-copied dir. */
function stageAndSwap(srcSkill: string, destSkill: string, poolDir: string, name: string): void {
  const staging = join(poolDir, `.tmp-${name}-${process.pid}-${Date.now()}`);
  try {
    rmSync(staging, { recursive: true, force: true });
    cpSync(srcSkill, staging, { recursive: true, dereference: false });
    // Replace atomically: remove the old managed dir, then rename staging in.
    // (rename over an existing non-empty dir is not atomic on POSIX, so we
    // rm first — the window is a single skill dir, and a crash here is
    // healed on the next update since the manifest is written last.)
    rmSync(destSkill, { recursive: true, force: true });
    renameSync(staging, destSkill);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Perform the additive, manifest-owned sync from `source` (the shipped
 * `skills/` dir) into `dest` (the `_bundled` pool dir).
 *
 * Deletion rule (the ownership boundary): a pool dir is removed ONLY when
 * it was in the PRIOR manifest AND is no longer shipped. Names absent from
 * the prior manifest are never deleted — hand-added skills survive, and the
 * first run (no manifest) deletes nothing.
 */
export function syncBundledSkills(opts: {
  source: string;
  dest: string;
  version: string;
}): SyncBundledSkillsResult {
  const { source, dest, version } = opts;
  const result: SyncBundledSkillsResult = {
    added: [],
    updated: [],
    removed: [],
    preserved: [],
    ownershipTransferred: [],
    firstRun: false,
    manifestCorrupt: false,
  };

  mkdirSync(dest, { recursive: true });

  const prior = readBundledSkillManifest(dest);
  const priorSkills = new Set<string>(
    "manifest" in prior ? prior.manifest.skills : [],
  );
  result.firstRun = "firstRun" in prior;
  result.manifestCorrupt = "corrupt" in prior;

  const shipped = listSkillDirs(source).sort();
  const shippedSet = new Set(shipped);

  // 1. Copy every shipped skill (add or update), atomically per skill.
  for (const name of shipped) {
    const destSkill = join(dest, name);
    const existed = existsSync(destSkill);

    // Ownership-collision guard (footgun-B guarantee: NEVER silently wipe a
    // hand-added skill). A shipped name colliding with a pre-existing pool dir
    // that switchroom does NOT own — i.e. it exists, is absent from the prior
    // manifest, and we are NOT on the first-run bootstrap (where every
    // pre-manifest dir is legitimately adopted) — is an operator hand-add of
    // the same name. Preserve its content as a timestamped backup, warn
    // loudly, and record the transfer, rather than overwriting silently. A
    // corrupt manifest (priorSkills empty, but not firstRun) also lands here:
    // we cannot prove ownership, so we fail safe and back up before overwrite.
    let transferred = false;
    if (existed && !priorSkills.has(name) && !result.firstRun) {
      const backup = join(dest, `${name}.operator-backup-${process.pid}-${Date.now()}`);
      try {
        renameSync(destSkill, backup);
        transferred = true;
        result.ownershipTransferred.push(name);
        process.stderr.write(
          `switchroom: WARNING — a shipped skill "${name}" collides with an ` +
            `operator-added pool dir of the same name. Preserved the existing ` +
            `content as "${backup}" and installed the shipped skill under "${name}". ` +
            `If you meant to keep your version, rename it to a distinct skill name.\n`,
        );
      } catch {
        // Backup failed — do NOT overwrite blindly; skip this name so operator
        // content survives, and record the unresolved collision.
        result.ownershipTransferred.push(name);
        process.stderr.write(
          `switchroom: WARNING — shipped skill "${name}" collides with an ` +
            `operator-added pool dir and the preservation backup failed; left the ` +
            `existing dir in place and did NOT install the shipped skill. Resolve ` +
            `the name collision manually.\n`,
        );
        continue;
      }
    }

    stageAndSwap(join(source, name), destSkill, dest, name);
    // After a transfer the old content was moved aside, so the shipped skill
    // is a fresh install under that name (added), not an update of an owned one.
    if (!transferred && (priorSkills.has(name) || existed)) result.updated.push(name);
    else result.added.push(name);
  }

  // 2. Delete ONLY names that were previously shipped and no longer are.
  //    Never on first run, never on a corrupt manifest (fail closed).
  if (!result.firstRun && !result.manifestCorrupt) {
    for (const name of priorSkills) {
      if (shippedSet.has(name)) continue; // still shipped
      const target = join(dest, name);
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        result.removed.push(name);
      }
    }
  }

  // 3. Record pool dirs that are neither shipped nor previously-owned —
  //    hand-added skills that we deliberately leave in place.
  for (const name of listSkillDirs(dest)) {
    if (!shippedSet.has(name) && !priorSkills.has(name)) {
      result.preserved.push(name);
    }
  }
  result.removed.sort();
  result.preserved.sort();

  // 4. Write the new manifest LAST, atomically (temp + rename), so an
  //    interrupted run never leaves a truncated manifest.
  const manifest: BundledSkillManifest = {
    version,
    skills: shipped,
    updatedAt: new Date().toISOString(),
  };
  const manifestPath = join(dest, BUNDLED_SKILL_MANIFEST_NAME);
  const manifestTmp = join(dest, `${BUNDLED_SKILL_MANIFEST_NAME}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(manifestTmp, manifestPath);

  return result;
}
