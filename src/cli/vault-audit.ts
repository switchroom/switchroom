/**
 * CLI: `switchroom vault audit`
 *
 * Tail and filter the vault audit log (~/.switchroom/vault-audit.log).
 *
 * Usage:
 *   switchroom vault audit                    # last 50 lines, formatted
 *   switchroom vault audit --who <caller>     # filter by caller substring
 *   switchroom vault audit --key <pattern>    # filter by key name (regex/glob)
 *   switchroom vault audit --denied           # only denied attempts
 *   switchroom vault audit --tail 100         # last N lines (default 50)
 *
 * Flags are combinable.
 *
 * NEVER logs secret values — the audit log itself never contains them, and
 * this formatter does not reintroduce them.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { defaultAuditLogPath } from "../vault/broker/audit-log.js";
import { formatAuditLines } from "../vault/audit-reader.js";

export function registerVaultAuditCommand(vault: Command, _program: Command): void {
  vault
    .command("audit")
    .description(
      "Tail and filter the vault audit log (~/.switchroom/vault-audit.log)"
    )
    .option("--who <caller>", "Filter by caller substring (unit name or pid)")
    .option("--key <pattern>", "Filter by key name (regex or substring)")
    .option("--denied", "Show only denied access attempts")
    .option(
      "--tail <n>",
      "Number of matching entries to show (default: 50)",
      "50"
    )
    .option("--path <file>", "Override audit log path (for debugging)")
    .action(
      (opts: {
        who?: string;
        key?: string;
        denied?: boolean;
        tail?: string;
        path?: string;
      }) => {
        const logPath = opts.path ?? defaultAuditLogPath();

        if (!existsSync(logPath)) {
          console.error(
            chalk.yellow(`Audit log not found at ${logPath}.`) +
            chalk.gray(
              "\nThe log is created when the vault broker handles its first request."
            )
          );
          process.exit(0);
        }

        const raw = readFileSync(logPath, "utf-8");
        const rawLines = raw.split("\n");

        const limit = Math.max(1, parseInt(opts.tail ?? "50", 10) || 50);

        const filters = {
          who: opts.who,
          key: opts.key,
          denied: opts.denied,
        };

        const formatted = formatAuditLines(rawLines, filters, limit);

        if (formatted.length === 0) {
          const parts: string[] = [];
          if (opts.who) parts.push(`caller containing '${opts.who}'`);
          if (opts.key) parts.push(`key matching '${opts.key}'`);
          if (opts.denied) parts.push("denied results");
          const filterDesc =
            parts.length > 0 ? ` matching ${parts.join(", ")}` : "";
          console.log(chalk.dim(`No audit entries${filterDesc}.`));
          process.exit(0);
        }

        // Print header
        const headerTs = "Timestamp (UTC)    ".padEnd(21);
        const headerOp = "Op      ".padEnd(10);
        const headerKey = "Key                         ".padEnd(30);
        const headerCaller = "Caller                                              ".padEnd(54);
        const headerResult = "Result";
        console.log(
          chalk.dim(`  ${headerTs} ${headerOp} ${headerKey} ${headerCaller} ${headerResult}`)
        );
        console.log(chalk.dim("  " + "─".repeat(130)));

        for (const line of formatted) {
          // Colour-code based on result
          if (line.includes("  allowed")) {
            console.log(chalk.green("  " + line));
          } else if (line.includes("  denied")) {
            console.log(chalk.red("  " + line));
          } else if (line.includes("  error:")) {
            console.log(chalk.yellow("  " + line));
          } else {
            console.log("  " + line);
          }
        }

        console.log();
        console.log(
          chalk.dim(
            `  ${formatted.length} entr${formatted.length === 1 ? "y" : "ies"} shown` +
              (formatted.length === limit && limit > 0
                ? ` (limit ${limit} — use --tail N to see more)`
                : "") +
              `  ·  log: ${logPath}`
          )
        );
      }
    );
}
