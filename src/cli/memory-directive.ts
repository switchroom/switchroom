/**
 * `switchroom memory directive ...` — Memory v2 M2 CLI surface (PR #4760
 * review M4).
 *
 * The review flagged that Ken's approved windows-boxes-class fix (Decision
 * 1, path A: create-the-superset-copy-first, deactivate-the-stale-copies-
 * second) had no real entry point — the skill's prose pointed at "an
 * operator or repo-authorized script run" that did not exist anywhere in the
 * repo. This is that entry point: a thin CLI wrapper over
 * `reconcileDirectiveSuperset` (`src/memory/directive-triage-executor.ts`),
 * following the same `<agent>`-resolves-to-its-own-bank pattern as
 * `memory rule` (`src/cli/memory-rules.ts`) and `agent status`
 * (`src/cli/agent.ts`'s `buildStatusInputs`).
 *
 * No business logic lives here — `reconcileDirectiveSuperset` does the work
 * (create-first ordering, idempotent retry, by-id deactivation). This file
 * only resolves `<agent>` to a bank-pinned `DirectiveAdmin` and plumbs argv.
 *
 * `mark-rules-block` (added post-#4760-merge, independent verification pass)
 * closes a second gap the same review left open: `DirectiveAdmin`'s
 * rules-block refusal chokepoint only fires once a directive carries
 * `RULES_BLOCK_MARKER_TAG`, and the ONLY code path that ever stamped that
 * tag was the batch triage executor (`applyDirectiveTriageBatch`). The
 * mental-model-curator skill's interactive triage pass never calls that
 * executor — it drives `list_directives`/`deactivate_directive` directly —
 * so a rules-block directive classified only through the interactive path
 * carried no marker and the chokepoint never armed. This verb is the
 * missing write path: a thin wrapper over
 * `DirectiveAdmin.markRulesBlock` (`src/memory/hindsight-directive-admin.ts`),
 * the exact same method the batch executor calls, so the chokepoint keys
 * off one write path regardless of which caller reaches it.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { withConfigError, getConfig } from "./helpers.js";
import { isHindsightEnabled } from "../memory/hindsight.js";
import { HINDSIGHT_DEFAULT_MCP_URL } from "../setup/hindsight.js";
import { DirectiveAdmin } from "../memory/hindsight-directive-admin.js";
import { reconcileDirectiveSuperset } from "../memory/directive-triage-executor.js";

/**
 * Resolve `<agent>` to a `DirectiveAdmin` pinned to that agent's own bank —
 * mirrors `buildStatusInputs`'s REST-base derivation (`agent.ts:358-384`),
 * stripped of the trailing `/mcp/` the MCP surface needs but the REST
 * surface must not carry.
 */
function resolveDirectiveAdmin(program: Command, agent: string): DirectiveAdmin {
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

export function registerMemoryDirectiveCommand(memory: Command, program: Command): void {
  const directive = memory
    .command("directive")
    .description(
      "Manage an agent's Hindsight directives directly (Memory v2 M2 — " +
        "windows-boxes-class superset reconciliation)",
    );

  directive
    .command("reconcile <agent> <name> <content...>")
    .description(
      "Create-first/deactivate-second: replace every ACTIVE directive named " +
        "<name> in <agent>'s bank with one carrying <content>, retiring the " +
        "stale copies with a superseded-by tag. Idempotent — safe to re-run " +
        "after a partial failure.",
    )
    .option("--priority <n>", "Priority for the new directive copy", (v) => parseInt(v, 10))
    .option("--json", "Machine-readable output")
    .action(
      withConfigError(
        async (
          agent: string,
          name: string,
          contentWords: string[],
          opts: { priority?: number; json?: boolean },
        ) => {
          const content = contentWords.join(" ").trim();
          if (content.length === 0) {
            console.error(chalk.red("Directive content must not be empty."));
            process.exit(1);
          }
          const admin = resolveDirectiveAdmin(program, agent);
          try {
            const result = await reconcileDirectiveSuperset(admin, {
              name,
              newContent: content,
              ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
            });
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, agent, name, ...result }));
              return;
            }
            console.log(
              chalk.green(
                `✓ reconciled "${name}" in ${agent}'s bank — ` +
                  `active copy ${result.createdId}${result.reused ? " (reused existing)" : " (newly created)"}, ` +
                  `retired ${result.deactivatedOldIds.length} stale ` +
                  `cop${result.deactivatedOldIds.length === 1 ? "y" : "ies"} ` +
                  `(${result.deactivatedOldIds.join(", ") || "none"})`,
              ),
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (opts.json) {
              // Machine-readable envelope belongs on stdout, matching the
              // success path above — stderr is for the human-readable `✗`
              // line only. A caller parsing `--json` output should never
              // have to know which stream the outcome landed on.
              console.log(JSON.stringify({ ok: false, error: msg }));
            } else {
              console.error(chalk.red(`✗ ${msg}`));
            }
            process.exit(1);
          }
        },
      ),
    );

  directive
    .command("deactivate <agent> <name>")
    .description(
      "Deactivate every ACTIVE directive named <name> in <agent>'s bank by " +
        "flipping is_active=false — the M3 directive-placement campaign entry " +
        "point for retiring a guardrail's in-bank copy once it has been " +
        "relocated to the agent's always-loaded CLAUDE.md. Matches by NAME " +
        "(mirrors reconcile's 'every ACTIVE directive named <name>' selection); " +
        "if multiple active copies share the name, all are deactivated. " +
        "REVERSIBLE — only is_active is touched, never a delete or a " +
        "content/priority rewrite, so it can be reactivated. Idempotent: a " +
        "re-run over already-inactive copies is a clean no-op, not an error. " +
        "REFUSES any directive carrying the rules-block marker tag (that stays " +
        "active until an M3-flip removes the marker) — the whole call is " +
        "refused if even one active copy carries it, mutating nothing.",
    )
    .option("--dry-run", "Print what WOULD deactivate without mutating anything")
    .option("--json", "Machine-readable output")
    .action(
      withConfigError(
        async (
          agent: string,
          name: string,
          opts: { dryRun?: boolean; json?: boolean },
        ) => {
          const admin = resolveDirectiveAdmin(program, agent);
          try {
            const result = await admin.deactivateAllActiveByName({
              name,
              ...(opts.dryRun ? { dryRun: true } : {}),
            });
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, agent, name, ...result }));
              return;
            }
            const verb = result.dryRun ? "would deactivate" : "deactivated";
            if (result.deactivated.length === 0) {
              console.log(
                chalk.yellow(
                  `• no-op: no ACTIVE directive named "${name}" in ${agent}'s bank ` +
                    `(${result.alreadyInactive.length} already-inactive ` +
                    `cop${result.alreadyInactive.length === 1 ? "y" : "ies"} left ` +
                    `untouched). Nothing to do.`,
                ),
              );
              return;
            }
            for (const d of result.deactivated) {
              console.log(
                chalk.green(
                  `  ${result.dryRun ? "[dry-run] " : "✓ "}${verb} "${d.name}" ` +
                    `(id ${d.id}, prior priority ${d.priority ?? "unset"})`,
                ),
              );
            }
            const n = result.deactivated.length;
            console.log(
              chalk.green(
                `${result.dryRun ? "[dry-run] " : "✓ "}${verb} ${n} directive` +
                  `${n === 1 ? "" : "s"} named "${name}" in ${agent}'s bank` +
                  (result.alreadyInactive.length > 0
                    ? ` (${result.alreadyInactive.length} already-inactive ` +
                      `cop${result.alreadyInactive.length === 1 ? "y" : "ies"} skipped)`
                    : "") +
                  (result.dryRun ? " — nothing was mutated" : ". Reverse with reactivate."),
              ),
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (opts.json) {
              console.log(JSON.stringify({ ok: false, error: msg }));
            } else {
              console.error(chalk.red(`✗ ${msg}`));
            }
            process.exit(1);
          }
        },
      ),
    );

  directive
    .command("mark-rules-block <agent> <id>")
    .description(
      "Stamp the persisted rules-block marker tag on directive <id> in " +
        "<agent>'s bank — the SAME DirectiveAdmin.markRulesBlock write path " +
        "the batch triage executor uses. Once stamped, deactivate_directive " +
        "(and every other DirectiveAdmin deactivation path) refuses this " +
        "directive unconditionally until an M3-flip action removes the " +
        "marker. This is the real entry point the mental-model-curator " +
        "skill's interactive triage pass calls for every directive it " +
        "classifies rules-block, BEFORE presenting the card — that skill " +
        "has no other write path to this marker (no MCP tool exposes it), " +
        "so without this call the code-level refusal never actually " +
        "arms itself on the interactive path (PR #4760 review follow-up).",
    )
    .option("--json", "Machine-readable output")
    .action(
      withConfigError(async (agent: string, id: string, opts: { json?: boolean }) => {
        // Own-agent guard: the marker this verb stamps has no exposed unmark
        // path (recovery needs operator REST surgery), so a confused or
        // prompt-injected curator run must not be able to freeze a PEER
        // agent's directives against retirement. `SWITCHROOM_AGENT_NAME` is
        // set container-wide inside a running agent, so when it's present
        // and disagrees with `<agent>` we positively know this is a
        // cross-agent call and refuse it outright. When the env var is
        // ABSENT (e.g. an operator running this CLI by hand on the host,
        // outside any agent container) we have no self identity to compare
        // against, so we allow the call through unchanged rather than
        // breaking that legitimate operator path.
        const selfAgent = process.env.SWITCHROOM_AGENT_NAME;
        if (selfAgent && selfAgent !== agent) {
          const msg =
            `Refusing: mark-rules-block may only target the running agent's ` +
            `own bank ("${selfAgent}"), not "${agent}". This marker has no ` +
            `unmark path — stamping a peer's bank would freeze their ` +
            `directives against retirement with no in-band recovery.`;
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }));
          } else {
            console.error(chalk.red(`✗ ${msg}`));
          }
          process.exit(1);
        }
        const admin = resolveDirectiveAdmin(program, agent);
        try {
          const message = await admin.markRulesBlock({ id });
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, agent, id, message }));
            return;
          }
          console.log(chalk.green(`✓ ${message}`));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }));
          } else {
            console.error(chalk.red(`✗ ${msg}`));
          }
          process.exit(1);
        }
      }),
    );
}
