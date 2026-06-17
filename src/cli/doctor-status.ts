/**
 * Canonical health-check status + glyph for `switchroom doctor`.
 *
 * Pure leaf module: imports only `chalk`, never any `doctor*.ts`
 * sibling. Every doctor check module imports `CheckStatus` from here
 * (the type used to be copy-pasted into 9 files).
 *
 * - `ok`   — verified good.
 * - `warn` — verified, and something the operator should look at.
 * - `fail` — verified bad; sets a non-zero exit.
 * - `skip` — NOT a problem and NOT verified from here: the check
 *   can't run from the operator's vantage point by design — e.g. the
 *   host operator UID cannot read an agent-private 0600 file (WS6-F2),
 *   or a required input like `SWITCHROOM_VAULT_PASSPHRASE` isn't set.
 *
 *   `skip` is deliberately distinct from `warn` so that `warn` keeps
 *   meaning "look at this" and the operator never learns to ignore
 *   the column (the "cosmetic summary the user learns to distrust"
 *   anti-pattern in reference/jobs/restart-and-know-what-im-running.md).
 *   It never affects the exit code, and it STILL prints its
 *   how-to-verify line — honest, not hidden (avoids "lying by
 *   omission").
 */

import chalk from "chalk";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export function statusGlyph(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return chalk.green("✓");
    case "warn":
      return chalk.yellow("!");
    case "fail":
      return chalk.red("✗");
    case "skip":
      // en-dash, dim: "not checked from here" — visually quiet so it
      // doesn't read as a problem.
      return chalk.gray("–");
  }
}
