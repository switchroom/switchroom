import type { Command } from "commander";
import { resolve } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  buildHandoff,
  findLatestSessionJsonl,
  DEFAULT_MAX_TURNS,
} from "../agents/handoff-summarizer.js";

/**
 * `switchroom handoff <agent>` — build the agent's session handoff
 * sidecars (.handoff.md transcript tail + .handoff-topic line) from
 * its most recent session JSONL. Invoked by the Stop hook and by
 * start.sh's lazy fallback. Pure + deterministic — no `claude -p`
 * (RFC #1620). Exits 0 on every failure mode (no JSONL, write error)
 * — the Stop hook must never block agent shutdown.
 */
export function registerHandoffCommand(program: Command): void {
  program
    .command("handoff <agent>", { hidden: true })
    .description(
      "Build the agent's session handoff sidecars — a transcript-tail " +
      "briefing (.handoff.md) and topic line (.handoff-topic). " +
      "[internal — used by the Stop hook]",
    )
    .option(
      "--max-turns <n>",
      "Max turns kept in the handoff transcript tail",
      String(DEFAULT_MAX_TURNS),
    )
    .action(
      withConfigError(
        async (agentName: string, opts: { maxTurns: string }) => {
          const config = getConfig(program);
          const agentConfig = config.agents[agentName];
          if (!agentConfig) {
            process.stderr.write(
              `handoff: agent "${agentName}" not defined in switchroom.yaml\n`,
            );
            return;
          }
          const continuity = agentConfig.session_continuity;
          if (continuity?.enabled === false) {
            process.stderr.write(
              `handoff: session_continuity.enabled=false for "${agentName}"; skipping\n`,
            );
            return;
          }

          const agentsDir = resolveAgentsDir(config);
          const agentDir = resolve(agentsDir, agentName);
          const claudeConfigDir = resolve(agentDir, ".claude");
          const jsonl = findLatestSessionJsonl(claudeConfigDir);
          if (!jsonl) {
            process.stderr.write(
              `handoff: no session JSONL under ${claudeConfigDir}/projects; skipping\n`,
            );
            return;
          }

          const maxTurns = Math.max(1, parseInt(opts.maxTurns, 10));
          const cappedMaxTurns = continuity?.max_turns_in_briefing ?? maxTurns;

          const status = await buildHandoff({
            jsonlPath: jsonl,
            agentDir,
            agentName,
            maxTurns: cappedMaxTurns,
          });
          process.stderr.write(`handoff: ${status}\n`);
        },
      ),
    );
}
