/**
 * `switchroom versions` — print the pinned manifest + installed versions
 * side-by-side, highlighting any drift.
 *
 * Phase 0 of issue #360: reads `dependencies.json` at the repo root and
 * compares it against what's actually installed, matching the style of
 * `printHealthSummary` in version.ts.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loadManifest, detectDrift } from "../manifest.js";
import type { DriftItem } from "../manifest.js";

function formatRow(
  component: string,
  declared: string,
  installed: string | null,
  isDrift: boolean,
  warnOnly: boolean,
): string {
  const installedStr = installed ?? chalk.red("(not installed)");

  if (!isDrift) {
    return chalk.green(`✓ ${component}`) + chalk.gray(`  ${declared}`);
  }

  if (warnOnly) {
    return (
      chalk.yellow(`! ${component}`) +
      chalk.gray(`  manifest: ${declared}`) +
      "  →  " +
      chalk.yellow(installedStr) +
      chalk.gray("  (warn-only)")
    );
  }

  return (
    chalk.red(`✗ ${component}`) +
    chalk.gray(`  manifest: ${declared}`) +
    "  →  " +
    chalk.red(installedStr)
  );
}

const WARN_ONLY = new Set([
  "@playwright/mcp",
  "hindsight.backend",
  "hindsight.client",
  "vault_broker.protocol",
]);

export function registerVersionsCommand(program: Command): void {
  program
    .command("versions", { hidden: true })
    .description(
      "Show pinned manifest versions vs installed, highlighting drift " +
        "(hidden — confusable with `version`; follow-up: rename to `drift` or fold into `doctor`)",
    )
    .action(async () => {
      let manifest;
      try {
        manifest = loadManifest();
      } catch (err) {
        console.error(chalk.red(`✗ ${(err as Error).message}`));
        process.exit(1);
      }

      const report = await detectDrift(manifest);

      // Build a lookup of drifted components for quick access
      const driftMap = new Map<string, DriftItem>(
        report.drift.map((d) => [d.component, d]),
      );

      console.log(chalk.bold("\nDependency manifest"));
      console.log(chalk.gray(`  switchroom ${manifest.switchroom_version}  ·  tested ${manifest.tested_at}`));
      console.log();

      // --- runtime ---
      const bunDrift = driftMap.get("bun");
      console.log(
        formatRow(
          "bun",
          manifest.runtime.bun,
          bunDrift ? bunDrift.installed : manifest.runtime.bun,
          !!bunDrift,
          false,
        ),
      );

      const nodeDrift = driftMap.get("node");
      console.log(
        formatRow(
          "node",
          manifest.runtime.node,
          nodeDrift ? nodeDrift.installed : manifest.runtime.node,
          !!nodeDrift,
          false,
        ),
      );

      // --- claude CLI ---
      const claudeDrift = driftMap.get("claude CLI");
      console.log(
        formatRow(
          "claude CLI",
          manifest.claude.cli,
          claudeDrift ? claudeDrift.installed : manifest.claude.cli,
          !!claudeDrift,
          false,
        ),
      );

      // --- @playwright/mcp ---
      const playwrightDrift = driftMap.get("@playwright/mcp");
      if (playwrightDrift) {
        console.log(
          formatRow(
            "@playwright/mcp",
            manifest.playwright_mcp,
            playwrightDrift.installed,
            true,
            true,
          ),
        );
      } else {
        console.log(
          chalk.green("✓ @playwright/mcp") +
          chalk.gray(`  ${manifest.playwright_mcp}`) +
          (manifest.playwright_mcp
            ? ""
            : chalk.gray("  (not cached — ok)")),
        );
      }

      // --- hindsight ---
      const hintDetail =
        manifest.hindsight.backend ?? manifest.hindsight.client
          ? `backend: ${manifest.hindsight.backend ?? "null"}  client: ${manifest.hindsight.client ?? "null"}`
          : "not pinned";
      console.log(chalk.gray(`  hindsight  ${hintDetail}`));

      // --- vault_broker.protocol ---
      const proto =
        manifest.vault_broker.protocol !== null
          ? String(manifest.vault_broker.protocol)
          : "null";
      console.log(chalk.gray(`  vault_broker.protocol  ${proto}`));

      console.log();

      if (!report.ok) {
        console.log(
          chalk.red("  Drift detected — run `switchroom doctor` for details"),
        );
        process.exit(1);
      } else if (report.drift.length > 0) {
        console.log(
          chalk.yellow("  Minor drift (warn-only) — no action required"),
        );
      } else {
        console.log(chalk.green("  All versions match the manifest"));
      }

      console.log();
    });
}
