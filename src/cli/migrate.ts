/**
 * `switchroom migrate cron-unit-names` (#1163 Phase D).
 *
 * Hard-cut rename of legacy index-based cron scripts
 * (`telegram/cron-<digits>.sh`) to the new content-hash scheme
 * (`telegram/cron-<sha12>.sh`). Idempotent: re-runs after a clean
 * migration are no-ops.
 *
 * No systemd is involved — switchroom cron runs as in-container
 * node-cron, so this is `.sh`-only (plus the `.source` sidecar that
 * Phase D's scaffold writes alongside each script).
 *
 * The migration is order-aware: we recompute the canonical filename
 * for each agent's `schedule[*]` entry using `cronScriptFilename`,
 * pair the legacy `cron-<i>.sh` with the entry at index `i`, and
 * rename in place. Anything that doesn't match an entry index is
 * left alone (it'll be swept by the next `reconcileAgent` cleanup pass).
 */
import type { Command } from "commander";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import chalk from "chalk";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  cronScriptFilename,
  LEGACY_CRON_SCRIPT_BASENAME_RE,
} from "../agents/cron-unit-name.js";
import { applyCronTelegramGuidance } from "../agents/sub-agent-telegram-prompt.js";

interface MigrateOptions {
  dryRun?: boolean;
  strict?: boolean;
}

interface RenamePlan {
  agent: string;
  from: string;
  to: string;
  /** index in schedule[] used to resolve canonical name; needed for drift check */
  scheduleIdx: number;
  /** the current schedule entry (post-edit) the legacy file is being renamed to */
  entry: { cron: string; prompt: string };
}

export function planCronUnitRenames(
  agentsDir: string,
  agents: Record<string, { schedule?: Array<{ cron: string; prompt: string }> }>,
): RenamePlan[] {
  const plans: RenamePlan[] = [];
  for (const [agentName, agentConfig] of Object.entries(agents)) {
    const schedule = agentConfig.schedule ?? [];
    if (schedule.length === 0) continue;
    const telegramDir = join(agentsDir, agentName, "telegram");
    if (!existsSync(telegramDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(telegramDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      const m = file.match(LEGACY_CRON_SCRIPT_BASENAME_RE);
      if (!m) continue;
      const idx = Number.parseInt(m[1]!, 10);
      const entry = schedule[idx];
      if (!entry) continue;
      const canonical = cronScriptFilename(entry.cron, entry.prompt);
      if (canonical === file) continue; // already migrated
      plans.push({
        agent: agentName,
        from: join(telegramDir, file),
        to: join(telegramDir, canonical),
        scheduleIdx: idx,
        entry,
      });
    }
  }
  return plans;
}

/** Status from a single rename attempt. Lets the caller log accurately
 * instead of always claiming "renamed". */
export type RenameStatus =
  | { kind: "renamed" }
  | { kind: "deduped"; legacy: string } // target existed, identical content, legacy deleted
  | { kind: "skipped"; reason: string; legacy: string }; // target existed, content differs, legacy preserved

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Rename `from` -> `to`, with safety checks when the target already exists.
 *
 *   - target absent: plain rename, returns { kind: "renamed" }.
 *   - target present, contents identical (sha256): delete legacy, returns "deduped".
 *   - target present, contents differ: leave both files alone, returns "skipped"
 *     so the caller can surface the divergence.
 */
export function renamePair(from: string, to: string, opts: { dryRun?: boolean } = {}): RenameStatus {
  if (existsSync(to)) {
    let identical = false;
    try {
      identical = sha256File(from) === sha256File(to);
    } catch {
      identical = false;
    }
    if (identical) {
      if (!opts.dryRun) {
        try {
          unlinkSync(from);
        } catch {
          // best-effort — leave the legacy file if unlink fails
        }
      }
      return { kind: "deduped", legacy: from };
    }
    return { kind: "skipped", reason: "target exists, legacy preserved", legacy: from };
  }
  if (!opts.dryRun) renameSync(from, to);
  return { kind: "renamed" };
}

/**
 * Extract the prompt argument that buildCronScript embedded in a legacy
 * script. Scripts use `claude -p '<shell-single-quoted prompt>' \` —
 * we locate that line and decode the single-quoted form.
 *
 * Returns null if the script doesn't look like one our scaffold wrote
 * (e.g. truncated, hand-edited, or pre-Phase-D shape we don't recognise).
 */
export function extractPromptFromLegacyScript(path: string): string | null {
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  // Match: claude -p '<...>' \   (the prompt may span multiple lines because
  // it can contain literal newlines; shellSingleQuote preserves them inside ').
  const idx = body.indexOf("\nclaude -p '");
  if (idx < 0) return null;
  // Walk from just past the opening quote, decoding the shell-single-quote
  // escape sequence `'"'"'` back into a literal single quote.
  let i = idx + "\nclaude -p '".length;
  let out = "";
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "'") {
      // Either end of the quoted string, or the start of a `'"'"'` splice.
      if (body.startsWith(`'"'"'`, i)) {
        out += "'";
        i += 5;
        continue;
      }
      return out;
    }
    out += ch;
    i++;
  }
  return null; // unterminated
}

export interface DriftReport {
  drifted: boolean;
  /** wrapped prompt actually embedded in the legacy script, if recoverable */
  embedded: string | null;
  /** wrapped prompt the CURRENT schedule entry would produce */
  expected: string;
}

/**
 * Compare the prompt embedded in `legacyPath` against what `entry` would
 * produce today. The on-disk prompt is the OUTPUT of
 * `applyCronTelegramGuidance` — we re-wrap the current entry the same
 * way so the comparison is apples-to-apples.
 *
 * `chatId` and `jobSlug` affect the wrapping; we pass them in so the test
 * harness can pin them. In production the same chatId is used at scaffold
 * and re-scaffold time, so a mismatch genuinely means the operator edited
 * the prompt (not that the wrapper input changed).
 */
export function detectPromptDrift(
  legacyPath: string,
  entry: { cron: string; prompt: string },
  ctx: { chatId: string; jobSlug: string },
): DriftReport {
  const embedded = extractPromptFromLegacyScript(legacyPath);
  const expected = applyCronTelegramGuidance(entry.prompt, ctx);
  return {
    drifted: embedded !== null && embedded !== expected,
    embedded,
    expected,
  };
}

export function registerMigrateCommand(program: Command): void {
  const cmd = program
    .command("migrate")
    .description("One-shot config/state migrations.");

  cmd
    .command("cron-unit-names")
    .description(
      "Rename legacy cron-<index>.sh scripts to the Phase D content-hash " +
      "form (cron-<sha12>.sh). Idempotent.",
    )
    .option("--dry-run", "Print the renames without performing them", false)
    .option(
      "--strict",
      "Treat drift (legacy script content disagrees with current schedule entry) as a hard error",
      false,
    )
    .action(
      withConfigError(async (opts: MigrateOptions) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const plans = planCronUnitRenames(
          agentsDir,
          config.agents as Record<string, { schedule?: Array<{ cron: string; prompt: string }> }>,
        );
        if (plans.length === 0) {
          console.log(chalk.green("Nothing to migrate — all cron scripts already use the content-hash scheme."));
          return;
        }
        let driftErrors = 0;
        for (const p of plans) {
          // Drift check first — we want the warning to be emitted even
          // when --dry-run is set, since drift is exactly the kind of
          // thing an operator running --dry-run wants to learn about.
          const drift = detectPromptDrift(p.from, p.entry, {
            chatId: "-",
            jobSlug: p.to.split("/").pop()!.replace(/\.sh$/, ""),
          });
          if (drift.drifted) {
            const msg = `DRIFT: ${p.from} was scaffolded with a prompt that differs from the current schedule[${p.scheduleIdx}] entry (cron=${JSON.stringify(p.entry.cron)}); renaming to ${p.to} — verify intent`;
            if (opts.strict) {
              console.error(chalk.red(`error: ${msg}`));
              driftErrors++;
              continue; // skip this plan in --strict
            }
            console.error(chalk.yellow(msg));
          }

          if (opts.dryRun) {
            console.log(chalk.cyan(`[dry-run] ${p.agent}: ${p.from} → ${p.to}`));
            continue;
          }

          try {
            const status = renamePair(p.from, p.to);
            const fromSidecar = p.from.replace(/\.sh$/, ".source");
            const toSidecar = p.to.replace(/\.sh$/, ".source");
            let sidecarStatus: RenameStatus | null = null;
            if (existsSync(fromSidecar) && statSync(fromSidecar).isFile()) {
              sidecarStatus = renamePair(fromSidecar, toSidecar);
            }
            switch (status.kind) {
              case "renamed":
                console.log(chalk.green(`renamed: ${p.agent}: ${p.from} → ${p.to}`));
                break;
              case "deduped":
                console.log(chalk.green(`deduped: ${p.agent}: target already present with identical contents, legacy ${p.from} removed`));
                break;
              case "skipped":
                console.log(chalk.yellow(`skipped: target exists, legacy preserved at ${p.from}`));
                break;
            }
            if (sidecarStatus && sidecarStatus.kind === "skipped") {
              console.log(chalk.yellow(`skipped: target exists, legacy preserved at ${fromSidecar}`));
            } else if (sidecarStatus && sidecarStatus.kind === "deduped") {
              console.log(chalk.green(`deduped: sidecar ${fromSidecar} removed (identical to target)`));
            }
          } catch (err) {
            console.error(chalk.red(`failed: ${p.agent}: ${p.from} → ${p.to}: ${(err as Error).message}`));
          }
        }
        if (opts.strict && driftErrors > 0) {
          process.exitCode = 1;
        }
      }),
    );
}
