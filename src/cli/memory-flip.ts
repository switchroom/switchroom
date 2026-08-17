/**
 * `switchroom memory flip-preflight <agent> [--json]` — Memory v2 M3
 * (Surface-A) deterministic readiness gate CLI surface.
 *
 * This is the missing entry point for the ALREADY-EXISTING but previously
 * un-wired flip-readiness library in `src/memory/directive-flip.ts`:
 * {@link measureLiveResidue} (measures the agent's live post-triage residue
 * from its current bank state), {@link evaluateFlipReadiness} (the two-hard-
 * precondition gate — rules_block ON + residue ≤ 6144B), and
 * {@link flipConfigStanza} (the exact operator stanza to apply). None of them
 * had a callable surface until now; this verb wires them.
 *
 * It follows the exact registration + `<agent>`-resolves-to-its-own-bank
 * pattern of `registerMemoryDirectiveCommand` in `memory-directive.ts` — the
 * same REST-base derivation, the same `DirectiveAdmin` construction. It never
 * mutates switchroom.yaml (that flip is an operator-gated edit): it reports
 * "is this agent safe to flip yet?" and prints the exact stanza when it is.
 *
 * The `rulesBlockEnabled` half of the gate reads the agent's
 * `memory.rules_block` flag from the resolved switchroom.yaml — the same field
 * `scaffold.ts` keys the M1 rules-block toolchain off (`agentConfig.memory
 * ?.rules_block === true`). The residue half is measured live against the bank
 * at command time, never a stale `m2-residue.md` artifact row.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { withConfigError, getConfig } from "./helpers.js";
import { isHindsightEnabled } from "../memory/hindsight.js";
import { HINDSIGHT_DEFAULT_MCP_URL } from "../setup/hindsight.js";
import { DirectiveAdmin } from "../memory/hindsight-directive-admin.js";
import {
  evaluateFlipReadiness,
  measureLiveResidue,
  flipConfigStanza,
  type FlipReadiness,
} from "../memory/directive-flip.js";

/**
 * Resolve `<agent>` to a `DirectiveAdmin` pinned to that agent's own bank.
 *
 * Byte-for-byte the same derivation `resolveDirectiveAdmin` uses in
 * `memory-directive.ts` — REST base from `memory.config.url` (default
 * {@link HINDSIGHT_DEFAULT_MCP_URL}), the trailing `/mcp/` the MCP surface
 * needs stripped off for the REST surface, bank id from the agent's
 * `memory.collection` (default: the agent name). Kept as a small standalone
 * helper (not shared out of `memory-directive.ts`) so the two commands stay
 * independently readable; the shape is pinned by both files' tests.
 */
function resolveFlipAdmin(program: Command, agent: string): DirectiveAdmin {
  const config = getConfig(program);
  if (!config.agents[agent]) {
    console.error(chalk.red(`Agent "${agent}" is not defined in switchroom.yaml`));
    process.exit(1);
  }
  if (!isHindsightEnabled(config)) {
    console.error(chalk.red("Hindsight memory is not enabled in this switchroom.yaml."));
    process.exit(1);
  }
  const agentConfig = config.agents[agent];
  const mcpBaseUrl =
    (config.memory?.config?.url as string | undefined) ?? HINDSIGHT_DEFAULT_MCP_URL;
  const apiBaseUrl = mcpBaseUrl.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  const bankId = agentConfig?.memory?.collection ?? agent;
  return new DirectiveAdmin({ apiBaseUrl, bankId });
}

/** True iff the agent's `memory.rules_block` (M1) flag is explicitly on. */
function readRulesBlockEnabled(program: Command, agent: string): boolean {
  const config = getConfig(program);
  return config.agents[agent]?.memory?.rules_block === true;
}

/** The machine-readable envelope `--json` prints. Stable field set: readers
 *  branch on `ready`, gate on `fits_budget`/`rules_block`. */
export interface FlipPreflightJson {
  ok: true;
  agent: string;
  ready: boolean;
  rules_block: boolean;
  residue_bytes: number;
  budget_bytes: number;
  fits_budget: boolean;
  residue_directive_count: number;
  reasons: string[];
}

/**
 * Shape the JSON envelope from a {@link FlipReadiness}. Pure — no IO, no
 * process state — so a test can assert the exact field set without a live
 * bank. `fits_budget` is derived from the same `>` boundary the gate uses
 * (inclusive budget: exactly-budget fits), so the two can never disagree.
 */
export function buildFlipPreflightJson(
  readiness: FlipReadiness,
  rulesBlockEnabled: boolean,
): FlipPreflightJson {
  return {
    ok: true,
    agent: readiness.agent,
    ready: readiness.ready,
    rules_block: rulesBlockEnabled,
    residue_bytes: readiness.residueBytes,
    budget_bytes: readiness.budgetBytes,
    fits_budget: readiness.residueBytes <= readiness.budgetBytes,
    residue_directive_count: readiness.residueDirectiveCount,
    reasons: readiness.reasons,
  };
}

/**
 * Render the human-readable preflight report. Pure (returns a string) so the
 * layout is unit-testable. When ready, appends the exact flip stanza; when
 * not, lists every blocking reason.
 */
export function renderFlipPreflight(
  readiness: FlipReadiness,
  rulesBlockEnabled: boolean,
): string {
  const fits = readiness.residueBytes <= readiness.budgetBytes;
  const lines: string[] = [];
  const verdict = readiness.ready
    ? chalk.green("READY")
    : chalk.red("NOT-READY");
  lines.push(`${verdict} — ${readiness.agent} M3 flip preflight`);
  lines.push("");
  lines.push(
    `  residue:      ${readiness.residueBytes}B / ${readiness.budgetBytes}B budget ` +
      `(${readiness.residueDirectiveCount} active residue directive(s)) ` +
      (fits ? chalk.green("fits") : chalk.red("OVER budget")),
  );
  lines.push(
    `  rules_block:  ${rulesBlockEnabled ? chalk.green("on") : chalk.red("off")}`,
  );
  if (readiness.ready) {
    lines.push("");
    lines.push("  Apply this per-agent stanza to switchroom.yaml, then restart:");
    lines.push("");
    for (const l of flipConfigStanza(readiness.agent).split("\n")) {
      lines.push(`    ${l}`);
    }
  } else {
    lines.push("");
    lines.push(chalk.red("  Blocked:"));
    for (const reason of readiness.reasons) {
      lines.push(`    - ${reason}`);
    }
  }
  return lines.join("\n");
}

/** Optional injection seam for tests — lets a unit test drive the real
 *  Commander wiring against a fake, in-memory bank without a live Hindsight. */
export interface FlipCommandDeps {
  makeAdmin?: (program: Command, agent: string) => DirectiveAdmin;
}

export function registerMemoryFlipCommand(
  memory: Command,
  program: Command,
  deps: FlipCommandDeps = {},
): void {
  const makeAdmin = deps.makeAdmin ?? resolveFlipAdmin;

  memory
    .command("flip-preflight <agent>")
    .description(
      "Deterministic M3 (Surface-A) flip-readiness gate for <agent>: measure " +
        "the live post-triage directive residue, check it fits the 6144B " +
        "rules-block budget AND that memory.rules_block is already on, and " +
        "print READY + the exact switchroom.yaml stanza, or NOT-READY + why. " +
        "Never mutates config — the flip itself is an operator-gated edit.",
    )
    .option("--json", "Machine-readable output")
    .action(
      withConfigError(async (agent: string, opts: { json?: boolean }) => {
        const admin = makeAdmin(program, agent);
        const rulesBlockEnabled = readRulesBlockEnabled(program, agent);
        let ready: boolean;
        try {
          const measurement = await measureLiveResidue(admin, agent);
          const readiness = evaluateFlipReadiness(measurement, { rulesBlockEnabled });
          ready = readiness.ready;
          if (opts.json) {
            console.log(JSON.stringify(buildFlipPreflightJson(readiness, rulesBlockEnabled)));
          } else {
            console.log(renderFlipPreflight(readiness, rulesBlockEnabled));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }));
          } else {
            console.error(chalk.red(`✗ flip preflight for ${agent} failed: ${msg}`));
          }
          process.exit(1);
          return;
        }
        // Non-zero exit on NOT-READY — outside the try so it can never be
        // swallowed by the catch — so the preflight is scriptable as a gate
        // (`&&`-chainable) without parsing stdout. Exit 0 (implicit) on READY.
        if (!ready) process.exit(2);
      }),
    );
}
