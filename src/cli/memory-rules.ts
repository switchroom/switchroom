/**
 * `switchroom memory rule ...` — Memory v2 M1 CLI surface (carve-M1.md §1).
 *
 * Thin over `src/memory/rules-store.ts`: resolves `<agent>` to its
 * scaffolded directory the same way `memory recall-log` does
 * (`resolveAgentsDir` + `join(agentsDir, name)`), then delegates. No
 * business logic lives here — every outcome asserted by the T8 CLI tests
 * is really asserting `rules-store.ts` plumbed through argv correctly.
 *
 * This is the same CLI surface the four `agent-config` MCP tools
 * (`memory_rule_add`, `memory_rule_retire`, `memory_rule_list`,
 * `memory_edit_yours`) shell out to — one behavior, two callers.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  createRule,
  retireRule,
  editYoursContent,
  listRules,
  verifyIntegrity,
  BudgetExceededError,
  NoYoursMarkerError,
  MarkerBlockOverlapError,
} from "../memory/rules-store.js";

function resolveAgentDir(program: Command, agent: string): string {
  const config = getConfig(program);
  if (!config.agents[agent]) {
    console.error(chalk.red(`Agent "${agent}" is not defined in switchroom.yaml`));
    process.exit(1);
  }
  return join(resolveAgentsDir(config), agent);
}

export function registerMemoryRuleCommand(memory: Command, program: Command): void {
  const rule = memory
    .command("rule")
    .description(
      "Manage an agent's standing rules block (Memory v2 M1 — sanctioned, " +
        "hash-chained edits to the marker-delimited rules section of CLAUDE.md)",
    );

  rule
    .command("add <agent> <text...>")
    .description("Add a new standing rule for <agent>")
    .option("--source <source>", "Where the rule came from (e.g. telegram)", "cli")
    .option("--actor <actor>", "Who authored this rule", "operator")
    .option("--supersedes <ruleId>", "Retire this rule id as part of the same mutation")
    .option("--json", "Machine-readable output (agent-config MCP shim)")
    .action(
      withConfigError(
        async (
          agent: string,
          textWords: string[],
          opts: { source: string; actor: string; supersedes?: string; json?: boolean },
        ) => {
          const agentDir = resolveAgentDir(program, agent);
          const text = textWords.join(" ").trim();
          if (text.length === 0) {
            console.error(chalk.red("Rule text must not be empty."));
            process.exit(1);
          }
          try {
            const { rule: newRule, possibleDuplicateOf } = createRule(agentDir, {
              text,
              source: opts.source,
              actor: opts.actor,
              supersedes: opts.supersedes,
            });
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, rule: newRule, possibleDuplicateOf }));
              return;
            }
            // T8: exact announcement string surfaced to chat callers.
            console.log(
              chalk.green(`✓ added standing rule ${newRule.id}: ${newRule.text}`),
            );
            if (possibleDuplicateOf) {
              console.log(
                chalk.yellow(
                  `  ⚠ possible duplicate of ${possibleDuplicateOf} (not blocked — review manually)`,
                ),
              );
            }
          } catch (e) {
            if (e instanceof BudgetExceededError || e instanceof NoYoursMarkerError) {
              if (opts.json) {
                console.error(JSON.stringify({ ok: false, error: e.message }));
              } else {
                console.error(chalk.red(`✗ ${e.message}`));
              }
              process.exit(1);
            }
            throw e;
          }
        },
      ),
    );

  rule
    .command("retire <agent> <ruleId>")
    .description("Retire a standing rule, archiving it (never re-loaded)")
    .option("--actor <actor>", "Who retired this rule", "operator")
    .option("--superseded-by <ruleId>", "Rule id this retirement was superseded by")
    .option("--json", "Machine-readable output (agent-config MCP shim)")
    .action(
      withConfigError(
        async (
          agent: string,
          ruleId: string,
          opts: { actor: string; supersededBy?: string; json?: boolean },
        ) => {
          const agentDir = resolveAgentDir(program, agent);
          try {
            retireRule(agentDir, ruleId, {
              actor: opts.actor,
              supersededBy: opts.supersededBy,
            });
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, ruleId }));
              return;
            }
            console.log(chalk.green(`✓ retired rule ${ruleId}`));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (opts.json) {
              console.error(JSON.stringify({ ok: false, error: msg }));
            } else {
              console.error(chalk.red(`✗ ${msg}`));
            }
            process.exit(1);
          }
        },
      ),
    );

  rule
    .command("list <agent>")
    .description("List active standing rules for <agent>")
    .option("--json", "Machine-readable output (agent-config MCP shim)")
    .action(
      withConfigError(async (agent: string, opts: { json?: boolean }) => {
        const agentDir = resolveAgentDir(program, agent);
        try {
          const rules = listRules(agentDir);
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, agent, rules }));
            return;
          }
          if (rules.length === 0) {
            console.log(chalk.gray(`  No active rules for "${agent}".`));
            return;
          }
          console.log(chalk.bold(`\n  Standing rules — ${agent}\n`));
          for (const r of rules) {
            console.log(`  ${chalk.cyan(r.id)} (${r.source}, ${r.created_at}): ${r.text}`);
          }
          console.log();
        } catch (e) {
          if (e instanceof NoYoursMarkerError) {
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, agent, rules: [] }));
              return;
            }
            console.log(chalk.gray(`  No active rules for "${agent}" (not scaffolded).`));
            return;
          }
          throw e;
        }
      }),
    );

  rule
    .command("edit-yours <agent> <text...>")
    .description(
      "Replace the free-text Yours content for <agent> (never overlaps a rules/index block)",
    )
    .option("--actor <actor>", "Who made this edit", "operator")
    .option("--json", "Machine-readable output (agent-config MCP shim)")
    .action(
      withConfigError(
        async (
          agent: string,
          textWords: string[],
          opts: { actor: string; json?: boolean },
        ) => {
          const agentDir = resolveAgentDir(program, agent);
          const text = textWords.join(" ").trim();
          try {
            editYoursContent(agentDir, text, { actor: opts.actor });
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, agent }));
              return;
            }
            console.log(chalk.green(`✓ updated Yours content for "${agent}"`));
          } catch (e) {
            if (e instanceof MarkerBlockOverlapError || e instanceof NoYoursMarkerError) {
              if (opts.json) {
                console.error(JSON.stringify({ ok: false, error: e.message }));
              } else {
                console.error(chalk.red(`✗ ${e.message}`));
              }
              process.exit(1);
            }
            throw e;
          }
        },
      ),
    );

  rule
    .command("verify <agent>")
    .description("Verify the rules block sentinel + mutation-log hash chain for <agent>")
    .action(
      withConfigError(async (agent: string) => {
        const agentDir = resolveAgentDir(program, agent);
        const result = verifyIntegrity(agentDir);
        if (result.ok) {
          console.log(chalk.green(`✓ ${result.detail}`));
        } else {
          console.error(chalk.red(`✗ ${result.detail}`));
          process.exit(1);
        }
      }),
    );
}
