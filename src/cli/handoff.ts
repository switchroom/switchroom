import type { Command } from "commander";
import { resolve } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  summarize,
  findLatestSessionJsonl,
  DEFAULT_SUMMARIZER_MODEL,
  DEFAULT_MAX_TURNS,
} from "../agents/handoff-summarizer.js";

/**
 * `clerk handoff <agent>` — summarize the agent's most recent session
 * and write the .handoff.md + .handoff-topic sidecars. Invoked by the
 * Stop hook and by start.sh's lazy fallback. Exits 0 on every failure
 * mode (missing API key, no JSONL, API error) — the Stop hook must
 * never block agent shutdown.
 */
export function registerHandoffCommand(program: Command): void {
  program
    .command("handoff <agent>")
    .description(
      "Summarize the agent's last session into a handoff briefing " +
      "(.handoff.md) and topic line (.handoff-topic)",
    )
    .option("--timeout <secs>", "API call timeout in seconds", "30")
    .option("--max-turns <n>", "Max turns fed to the summarizer", String(DEFAULT_MAX_TURNS))
    .option("--model <id>", "Anthropic model for the summarizer", DEFAULT_SUMMARIZER_MODEL)
    .action(
      withConfigError(
        async (
          agentName: string,
          opts: { timeout: string; maxTurns: string; model: string },
        ) => {
          const config = getConfig(program);
          const agentConfig = config.agents[agentName];
          if (!agentConfig) {
            process.stderr.write(
              `handoff: agent "${agentName}" not defined in clerk.yaml\n`,
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

          const timeoutMs = Math.max(1, parseInt(opts.timeout, 10)) * 1000;
          const maxTurns = Math.max(1, parseInt(opts.maxTurns, 10));
          const model = continuity?.summarizer_model ?? opts.model;
          const cappedMaxTurns = continuity?.max_turns_in_briefing ?? maxTurns;

          const status = await summarize({
            jsonlPath: jsonl,
            agentDir,
            agentName,
            model,
            maxTurns: cappedMaxTurns,
            timeoutMs,
          });
          process.stderr.write(`handoff: ${status}\n`);
        },
      ),
    );
}
