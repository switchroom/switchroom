/**
 * CLI: `switchroom vault backup`
 *
 * Writes a dated, encrypted copy of `~/.switchroom/vault/vault.enc` to a
 * configured destination directory, with rotation + a manifest. Companion
 * to the proven manual recovery flow (`cp <bak> vault/vault.enc + docker
 * restart switchroom-vault-broker`), turning the lucky `vault.enc.divergent.bak`
 * survival from the 2026-05-20 incident into a deliberate operator capability.
 *
 * v1 scope (this CLI verb): backup only. `vault restore` is a separate v2
 * design+PR — the reviewer raised genuine restore-safety questions (broker
 * quiesce mid-mint, force-flag semantics, pre-restore-bak rotation) that
 * deserve their own pass. Manual `cp + restart` recovery remains the
 * intermediate path and was proven on the incident host.
 *
 * Trust model: the file copied is the AES-256-GCM-encrypted vault envelope
 * — the operator's passphrase is the gate, not "is the file on this host".
 * Storing it in a private GitHub repo (the operator's existing
 * `~/.switchroom-config/` pattern) extends durability without weakening
 * encryption, IFF the auto-unlock blob is never co-located. The
 * `findAutoUnlockSibling` defense-in-depth check in
 * `src/vault/backup.ts` refuses to write a backup into any directory
 * that already contains an `*auto-unlock*` sibling — closing the foot-gun.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, resolvePath } from "../config/loader.js";
import {
  backupVault,
  DEFAULT_RETAIN,
  defaultHome,
  resolveBackupDestination,
} from "../vault/backup.js";

interface BackupOptions {
  to?: string;
  retain?: string; // commander gives us a string; parsed below
}

/** Resolve where the live vault file lives. Matches the precedence used
 *  by the other `vault` subcommands (config → default), so a custom
 *  `vault.path` in switchroom.yaml is honoured. */
function getLiveVaultPath(configPath: string | undefined): string {
  try {
    const cfg = loadConfig(configPath);
    if (cfg.vault?.path) return resolvePath(cfg.vault.path);
  } catch {
    /* fall through to default */
  }
  // Default per src/vault/vault.ts: ~/.switchroom/vault/vault.enc (post-migration).
  // We deliberately do NOT use the legacy `~/.switchroom/vault.enc` symlink
  // path because newer installs follow the migrated subdir shape and
  // `resolvePath` doesn't expand `~` here — caller passes already-resolved.
  return resolvePath("~/.switchroom/vault/vault.enc");
}

export function registerVaultBackupCommand(vault: Command, program: Command): void {
  vault
    .command("backup")
    .description(
      "Write a dated, encrypted backup of the vault to a configured directory. " +
      "Default destination: ~/.switchroom-config/vault-backups/ if that operator " +
      "config repo exists, else ~/.switchroom/vault-backups/. Rotated to the last " +
      "30 backups by default."
    )
    .option(
      "--to <path>",
      "Destination directory for the backup. Overrides config and default. " +
      "MUST NOT be ~/.switchroom/vault/ (the broker's bind-mounted dir, " +
      "validated by `switchroom apply` against an allowlist). Created with mode 0700.",
    )
    .option(
      "--retain <n>",
      `Keep only the N most recent backups in the destination dir (default ${DEFAULT_RETAIN}). ` +
      `Older ones are pruned after the new backup is written.`,
    )
    .action(async (opts: BackupOptions) => {
      try {
        const parentOpts = program.opts();
        const vaultPath = getLiveVaultPath(parentOpts.config);

        // Read config (optional) to honour `vault.backup.destination` if set.
        let configDestination: string | undefined;
        try {
          const cfg = loadConfig(parentOpts.config);
          // The schema entry is added under vault.backup; consume it
          // defensively so older configs without the block continue to work.
          const backupCfg = (cfg.vault as { backup?: { destination?: string } } | undefined)?.backup;
          if (backupCfg?.destination) {
            configDestination = resolvePath(backupCfg.destination);
          }
        } catch {
          /* tolerate missing/malformed config */
        }

        const home = defaultHome();
        const hasSwitchroomConfigRepo = existsSync(join(home, ".switchroom-config"));

        const destDir = resolveBackupDestination({
          cliToFlag: opts.to ? resolvePath(opts.to) : undefined,
          configDestination,
          home,
          hasSwitchroomConfigRepo,
        });

        // Parse --retain (commander gives string; we want a number). Reject
        // anything not a non-negative integer at the CLI boundary.
        let retain = DEFAULT_RETAIN;
        if (opts.retain !== undefined) {
          const n = Number(opts.retain);
          if (!Number.isInteger(n) || n < 0) {
            console.error(chalk.red(
              `Error: --retain must be a non-negative integer (got ${JSON.stringify(opts.retain)})`,
            ));
            process.exit(1);
          }
          retain = n;
        }

        const result = backupVault({ vaultPath, destDir, retain });

        // Operator-facing summary. Never prints any vault content;
        // the sha256 + size are properties of the encrypted ciphertext.
        console.log(`${chalk.green("✓")} vault backup written`);
        console.log(`  ${chalk.dim("path:")}   ${result.fullPath}`);
        console.log(`  ${chalk.dim("size:")}   ${result.bytes} bytes`);
        console.log(`  ${chalk.dim("sha256:")} ${result.sha256}`);
        if (result.pruned.length > 0) {
          console.log(`  ${chalk.dim("pruned:")} ${result.pruned.length} older backup(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });
}
