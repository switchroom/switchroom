/**
 * `switchroom host repair-mounts` — repair well-known auto-dir artifacts
 * left by a container-context deploy.
 *
 * The 2026-06-23 outage: a generated compose ran inside the hostd container
 * and its bind sources (e.g. `~/.docker/cli-plugins/docker-compose`,
 * `/state/agent/home/.switchroom/...`) didn't exist on the host, so Docker
 * silently auto-created them as root-owned DIRECTORIES. The result:
 *   - `~/.docker/cli-plugins/docker-compose` was a directory shadowing the
 *     real docker-compose v2 plugin — `docker compose` broke host-wide.
 *   - `/state` tree: empty `/state/agent/home/.switchroom/...` dirs that
 *     should have been real file bind-sources.
 *
 * Recovery was manual (`sudo rmdir ~/.docker/cli-plugins/docker-compose` +
 * `sudo rm -rf /state`). This verb automates the EXACT same set of removals,
 * with strict safety guards:
 *
 *   1. NEVER a glob, NEVER a wildcard, NEVER recursive on a real-data path.
 *   2. `~/.docker/cli-plugins/docker-compose` — only if it is an EMPTY
 *      DIRECTORY (rmdir semantics). If it is a file, a symlink, or a
 *      non-empty directory, refuse and report.
 *   3. `/state` — only if root-owned AND it contains ONLY the known-bogus
 *      auto-dir shape (`agent/home/.switchroom/...`), with no real content.
 *      Required `--yes` flag; default is dry-run that prints what it would do.
 *
 * Core logic (`planMountRepairs` / `applyMountRepairs`) is pure +
 * dependency-injected for fs probes, making it trivially unit-testable.
 * The CLI wires real fs and the --yes gate.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Pure probe types
// ---------------------------------------------------------------------------

export interface FsProbe {
  /** `lstat` the path (does not follow symlinks). Returns null if ENOENT. */
  lstat(
    path: string,
  ): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; uid: number } | null;
  /** List directory entries. Returns null if path doesn't exist or isn't a dir. */
  readdir(path: string): string[] | null;
}

// ---------------------------------------------------------------------------
// Repair item shape
// ---------------------------------------------------------------------------

export type RemovalAction =
  | "rmdir" // remove a single EMPTY directory (never recursive)
  | "rm-rf-state"; // remove /state with a recursive rm (only the bogus auto-dir shape)

export interface RepairItem {
  path: string;
  action: RemovalAction;
  reason: string;
  safe: boolean; // false = refuse (report only, do not remove even with --yes)
}

// ---------------------------------------------------------------------------
// Known-bad artifact allowlist
// ---------------------------------------------------------------------------

/**
 * The EXACT, LITERAL set of paths we are willing to remove.
 * - No globs. No wildcards. No recursive on user-data paths.
 * - Anything not on this list is never touched, regardless of --yes.
 */
export const ARTIFACT_ALLOWLIST = {
  dockerComposePluginDir: (home: string) =>
    join(home, ".docker", "cli-plugins", "docker-compose"),
  stateSentinel: "/state",
} as const;

/**
 * Return true iff the /state tree looks like the bogus auto-dir artifact:
 * all paths under /state are EMPTY directories following the pattern
 * `agent/home/.switchroom/...`, with no real files anywhere.
 *
 * If /state contains ANY file, or ANY directory that doesn't fit the known
 * bogus shape, we return false (refuse to touch it).
 *
 * The allowlist for intermediate dirs is deliberately narrow:
 *   /state
 *   /state/agent
 *   /state/agent/home
 *   /state/agent/home/.switchroom
 *   /state/agent/home/.switchroom/<anything>   (only empty dirs, no files)
 */
export function isStateBogusAutoDir(probe: FsProbe): boolean {
  const root = probe.lstat("/state");
  if (!root || !root.isDirectory()) return false;

  const level1 = probe.readdir("/state");
  if (!level1) return false;
  // Must contain ONLY "agent" (the deploy artifact shape)
  if (level1.length === 0) return true; // empty /state is also bogus
  if (level1.length !== 1 || level1[0] !== "agent") return false;

  const level2 = probe.readdir("/state/agent");
  if (!level2) return false;
  if (level2.length === 0) return true;
  if (level2.length !== 1 || level2[0] !== "home") return false;

  const level3 = probe.readdir("/state/agent/home");
  if (!level3) return false;
  if (level3.length === 0) return true;
  if (level3.length !== 1 || level3[0] !== ".switchroom") return false;

  const level4 = probe.readdir("/state/agent/home/.switchroom");
  if (!level4) return false;
  if (level4.length === 0) return true;

  // At this depth we allow any number of empty subdirectories (e.g. the
  // auto-created agent name dirs), but NOTHING with real content.
  for (const entry of level4) {
    const entryPath = `/state/agent/home/.switchroom/${entry}`;
    const st = probe.lstat(entryPath);
    if (!st) return false;
    if (!st.isDirectory()) return false; // a file here means real content
    const children = probe.readdir(entryPath);
    if (!children) return false;
    if (children.length !== 0) return false; // non-empty = real content
  }

  return true;
}

// ---------------------------------------------------------------------------
// planMountRepairs — pure function, fully injectable
// ---------------------------------------------------------------------------

export interface PlanOptions {
  hostHome?: string; // override ~ expansion (for tests)
}

/**
 * Inspect the host and return a list of repair items describing what
 * WOULD be done. Does not touch the filesystem.
 *
 * Safety contract:
 *  - Every path is literal (no globs, no expansion beyond home resolution).
 *  - `safe: false` means the check found the path but the conditions for
 *    safe removal are NOT met — the caller must report and skip.
 *  - Only paths on the ARTIFACT_ALLOWLIST are ever returned.
 */
export function planMountRepairs(probe: FsProbe, opts: PlanOptions = {}): RepairItem[] {
  const home = opts.hostHome ?? homedir();
  const items: RepairItem[] = [];

  // ── Artifact 1: ~/.docker/cli-plugins/docker-compose ──────────────────────
  const dockerComposePath = ARTIFACT_ALLOWLIST.dockerComposePluginDir(home);
  const dockerComposeSt = probe.lstat(dockerComposePath);
  if (dockerComposeSt !== null) {
    if (dockerComposeSt.isSymbolicLink()) {
      items.push({
        path: dockerComposePath,
        action: "rmdir",
        reason: "is a symlink — expected a directory from auto-dir artifact; refusing to touch symlinks",
        safe: false,
      });
    } else if (dockerComposeSt.isFile()) {
      items.push({
        path: dockerComposePath,
        action: "rmdir",
        reason: "is a regular file — the real docker-compose plugin; refusing to remove",
        safe: false,
      });
    } else if (dockerComposeSt.isDirectory()) {
      const contents = probe.readdir(dockerComposePath);
      if (contents === null) {
        items.push({
          path: dockerComposePath,
          action: "rmdir",
          reason: "directory exists but could not be read — refusing to remove",
          safe: false,
        });
      } else if (contents.length !== 0) {
        items.push({
          path: dockerComposePath,
          action: "rmdir",
          reason: `non-empty directory (${contents.length} entries) — not an empty auto-dir artifact; refusing to remove`,
          safe: false,
        });
      } else {
        items.push({
          path: dockerComposePath,
          action: "rmdir",
          reason: "empty directory shadowing docker-compose v2 plugin (2026-06-23 auto-dir artifact)",
          safe: true,
        });
      }
    }
  }

  // ── Artifact 2: /state (bogus auto-dir tree) ───────────────────────────────
  const stateSt = probe.lstat(ARTIFACT_ALLOWLIST.stateSentinel);
  if (stateSt !== null) {
    if (!stateSt.isDirectory()) {
      items.push({
        path: ARTIFACT_ALLOWLIST.stateSentinel,
        action: "rm-rf-state",
        reason: "exists but is not a directory — unexpected; refusing to remove",
        safe: false,
      });
    } else if (stateSt.uid !== 0) {
      items.push({
        path: ARTIFACT_ALLOWLIST.stateSentinel,
        action: "rm-rf-state",
        reason: `not root-owned (uid=${stateSt.uid}) — may be a real /state path; refusing to remove`,
        safe: false,
      });
    } else if (!isStateBogusAutoDir(probe)) {
      items.push({
        path: ARTIFACT_ALLOWLIST.stateSentinel,
        action: "rm-rf-state",
        reason: "root-owned but does not match the known bogus auto-dir shape — may contain real data; refusing to remove",
        safe: false,
      });
    } else {
      items.push({
        path: ARTIFACT_ALLOWLIST.stateSentinel,
        action: "rm-rf-state",
        reason: "root-owned, matches bogus agent/home/.switchroom auto-dir shape (2026-06-23 artifact)",
        safe: true,
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// applyMountRepairs — executes ONLY safe items
// ---------------------------------------------------------------------------

export interface ApplyResult {
  path: string;
  action: RemovalAction;
  ok: boolean;
  error?: string;
}

export interface ApplyDeps {
  rmdir(path: string): void;
  rmRf(path: string): void;
}

/**
 * Execute the removals for items where `safe === true`.
 * Items with `safe === false` are skipped (callers should have already
 * reported them).
 */
export function applyMountRepairs(items: RepairItem[], deps: ApplyDeps): ApplyResult[] {
  const results: ApplyResult[] = [];
  for (const item of items) {
    if (!item.safe) continue;
    try {
      if (item.action === "rmdir") {
        deps.rmdir(item.path);
      } else if (item.action === "rm-rf-state") {
        deps.rmRf(item.path);
      }
      results.push({ path: item.path, action: item.action, ok: true });
    } catch (err) {
      results.push({
        path: item.path,
        action: item.action,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

export function registerHostCommand(program: Command): void {
  const host = program
    .command("host")
    .description("Host-level maintenance operations for switchroom");

  host
    .command("repair-mounts")
    .description(
      "Detect and remove known auto-dir artifacts left by a container-context deploy " +
        "(2026-06-23 outage class). Default: dry-run. Pass --yes to apply.",
    )
    .option("--yes", "Actually perform the removals (default is dry-run)")
    .action(async (opts: { yes?: boolean }) => {
      const { rmdirSync, rmSync, lstatSync, readdirSync } = await import("node:fs");

      const probe: FsProbe = {
        lstat(path) {
          try {
            return lstatSync(path);
          } catch {
            return null;
          }
        },
        readdir(path) {
          try {
            return readdirSync(path);
          } catch {
            return null;
          }
        },
      };

      const items = planMountRepairs(probe);

      if (items.length === 0) {
        console.log(chalk.green("✓ No known auto-dir artifacts detected. Nothing to repair."));
        return;
      }

      const dryRun = !opts.yes;

      if (dryRun) {
        console.log(
          chalk.bold("DRY-RUN — pass --yes to apply. Would perform the following:\n"),
        );
      }

      let hasUnsafe = false;
      const safeItems = items.filter((i) => i.safe);
      const unsafeItems = items.filter((i) => !i.safe);

      for (const item of safeItems) {
        const cmd = item.action === "rmdir" ? `rmdir "${item.path}"` : `rm -rf "${item.path}"`;
        if (dryRun) {
          console.log(`  ${chalk.cyan(cmd)}`);
          console.log(chalk.dim(`    reason: ${item.reason}`));
        } else {
          console.log(`  Removing ${chalk.cyan(item.path)} …`);
        }
      }

      for (const item of unsafeItems) {
        hasUnsafe = true;
        console.log(
          `  ${chalk.yellow("SKIP")} ${chalk.cyan(item.path)}: ${item.reason}`,
        );
      }

      if (dryRun) {
        if (safeItems.length === 0) {
          console.log(
            chalk.yellow("\nAll detected artifacts are unsafe to remove automatically."),
          );
          console.log("Review the reasons above and remediate manually.");
        } else {
          console.log(
            chalk.dim(
              `\n${safeItems.length} item(s) would be removed. Run with --yes to apply.`,
            ),
          );
        }
        return;
      }

      // --yes path: apply safe removals
      const applyDeps: ApplyDeps = {
        rmdir(path) {
          rmdirSync(path);
        },
        rmRf(path) {
          rmSync(path, { recursive: true, force: true });
        },
      };

      const results = applyMountRepairs(safeItems, applyDeps);
      for (const r of results) {
        if (r.ok) {
          console.log(chalk.green(`  ✓ Removed ${r.path}`));
        } else {
          console.error(chalk.red(`  ✗ Failed to remove ${r.path}: ${r.error}`));
        }
      }

      if (hasUnsafe) {
        console.log(
          chalk.yellow("\nSome artifacts were skipped (see above). Remediate them manually."),
        );
      }

      if (results.some((r) => r.ok)) {
        console.log(
          chalk.dim(
            "\nNext step: run `switchroom apply` from the host shell to regenerate the compose " +
              "file and bind sources with the correct host paths.",
          ),
        );
      }

      if (results.some((r) => !r.ok)) {
        process.exit(1);
      }
    });
}
