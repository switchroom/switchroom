/**
 * CLI: `switchroom vault doctor`
 *
 * Health check for the vault security model.  Reports:
 *   - fail: broker configured but not running
 *   - fail: crons referencing vault keys that don't exist
 *   - warn: sensitive-looking keys without a per-key ACL scope
 *   - info: vault keys not referenced in any cron's secrets[]
 *
 * Exit codes:
 *   0 = ok (no fails, no warns)
 *   1 = fail (at least one fail-level diagnostic)
 *   2 = warn (no fails, but at least one warn)
 *
 * Implements the pure-functional shape from src/vault/doctor.ts, with I/O
 * loading done here so the core logic is testable without mocking.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { analyseVaultHealth, type Diagnostic, type DiagnosticLevel } from "../vault/doctor.js";
import { openVault, VaultError } from "../vault/vault.js";
import { loadConfig, resolvePath } from "../config/loader.js";
import { statusViaBroker } from "../vault/broker/client.js";

function levelGlyph(level: DiagnosticLevel): string {
  switch (level) {
    case "ok":
      return chalk.green("✓");
    case "warn":
      return chalk.yellow("!");
    case "fail":
      return chalk.red("✗");
    case "info":
      return chalk.cyan("i");
  }
}

function levelLabel(level: DiagnosticLevel): string {
  switch (level) {
    case "ok":
      return chalk.green("ok  ");
    case "warn":
      return chalk.yellow("warn");
    case "fail":
      return chalk.red("fail");
    case "info":
      return chalk.cyan("info");
  }
}

function printDiagnostic(d: Diagnostic): void {
  const glyph = levelGlyph(d.level);
  const label = levelLabel(d.level);
  const firstLine = d.message.split("\n")[0];
  const rest = d.message.split("\n").slice(1);

  console.log(`  ${glyph} [${label}] ${firstLine}`);
  for (const line of rest) {
    console.log(`          ${chalk.gray(line)}`);
  }
  if (d.fix && d.level !== "ok") {
    console.log(chalk.gray(`          → ${d.fix}`));
  }
}

export function registerVaultDoctorCommand(vault: Command, program: Command): void {
  vault
    .command("doctor")
    .description(
      "Health check for vault security: missing keys, unscoped secrets, broker status"
    )
    .option("--json", "Output diagnostics as JSON")
    .action(async (opts: { json?: boolean }) => {
      const parentOpts = program.opts();

      // ── Load config ────────────────────────────────────────────────
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(parentOpts.config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error loading config: ${msg}`));
        process.exit(1);
      }

      // ── Resolve vault path ─────────────────────────────────────────
      const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");

      // ── Open vault (if passphrase available) ───────────────────────
      const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
      let vaultKeys:
        | Record<string, { scope?: { allow?: string[]; deny?: string[] } }>
        | undefined = undefined;

      if (passphrase && existsSync(vaultPath)) {
        try {
          const entries = openVault(passphrase, vaultPath);
          vaultKeys = {};
          for (const [name, entry] of Object.entries(entries)) {
            vaultKeys[name] = {
              scope:
                "scope" in entry && entry.scope
                  ? (entry.scope as { allow?: string[]; deny?: string[] })
                  : undefined,
            };
          }
        } catch (err) {
          if (err instanceof VaultError) {
            console.error(
              chalk.yellow(
                `Warning: could not open vault (${err.message}). ` +
                  "Skipping key-level checks. Verify SWITCHROOM_VAULT_PASSPHRASE."
              )
            );
          } else {
            throw err;
          }
        }
      } else if (!passphrase) {
        console.error(
          chalk.dim(
            "Note: SWITCHROOM_VAULT_PASSPHRASE not set — skipping per-key checks. " +
              "Set it to enable missing-key and scope analysis."
          )
        );
      }

      // ── Build agentSchedules from config ───────────────────────────
      const agentSchedules: Record<string, Array<{ secrets?: string[] }>> = {};
      for (const [agentName, agentConfig] of Object.entries(config.agents ?? {})) {
        agentSchedules[agentName] = (agentConfig.schedule ?? []).map((s) => ({
          secrets: s.secrets,
        }));
      }

      // ── Probe broker ───────────────────────────────────────────────
      const brokerConfigured = config.vault?.broker?.enabled !== false;
      let brokerRunning: boolean | undefined = undefined;

      if (brokerConfigured) {
        const socketPath = resolvePath(
          config.vault?.broker?.socket ?? "~/.switchroom/vault-broker.sock"
        );
        const status = await statusViaBroker({ socket: socketPath, timeoutMs: 1500 });
        brokerRunning = status !== null;
      }

      // ── Analyse ───────────────────────────────────────────────────
      const diagnostics = analyseVaultHealth({
        vaultKeys,
        agentSchedules,
        brokerConfigured,
        brokerRunning,
      });

      // Reviewer-fix: when SWITCHROOM_VAULT_PASSPHRASE is unset, key-level
      // checks (missing-keys, sensitive-without-scope, unreferenced) all
      // skip. In --json mode the previous output was a clean
      // `{ diagnostics: [] }` (or just broker-state), which a CI runner
      // would interpret as "all good" — falsely. Surface the skipped-checks
      // as an explicit info-level diagnostic so callers can detect it.
      if (vaultKeys === undefined) {
        diagnostics.unshift({
          check: "passphrase-not-available",
          level: "info",
          message:
            "Per-key checks skipped: SWITCHROOM_VAULT_PASSPHRASE not set or vault could not be opened.",
          fix: "Set SWITCHROOM_VAULT_PASSPHRASE to enable missing-key, sensitive-key, and unreferenced-key analysis.",
        });
      }

      // ── Output ────────────────────────────────────────────────────
      if (opts.json) {
        console.log(JSON.stringify({ diagnostics }, null, 2));
        const hasFail = diagnostics.some((d) => d.level === "fail");
        const hasWarn = diagnostics.some((d) => d.level === "warn");
        if (hasFail) process.exit(1);
        if (hasWarn) process.exit(2);
        process.exit(0);
      }

      console.log(chalk.bold("\nVault Doctor"));
      console.log();

      for (const d of diagnostics) {
        printDiagnostic(d);
      }

      const fails = diagnostics.filter((d) => d.level === "fail").length;
      const warns = diagnostics.filter((d) => d.level === "warn").length;
      const infos = diagnostics.filter((d) => d.level === "info").length;

      console.log();
      const summary = [
        chalk.red(`${fails} fail`),
        chalk.yellow(`${warns} warn`),
        chalk.cyan(`${infos} info`),
      ].join(" · ");
      console.log(`  ${summary}`);
      console.log();

      if (fails > 0) process.exit(1);
      if (warns > 0) process.exit(2);
      process.exit(0);
    });
}
