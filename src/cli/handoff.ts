import type { Command } from "commander";
import { resolve } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir, ConfigError } from "../config/loader.js";
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
 *
 * Config-load is **non-fatal** (#1745). Inside sandboxed agent
 * containers, `/state/config/switchroom.yaml` is not bind-mounted and
 * the upward walk in `findConfigFile()` returns nothing. The handoff
 * command only consults two yaml-derived fields
 * (`session_continuity.enabled` — already gated at hook-emission time —
 * and `session_continuity.max_turns_in_briefing` — has a default), and
 * the agent dir, which can be recovered from `$CLAUDE_PROJECT_DIR` /
 * cwd. So on `ConfigError` we warn and fall back to defaults rather
 * than exit 1, which used to fire a red issue card on every turn-end.
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
          // Try to load switchroom.yaml. Inside sandboxed agent
          // containers the file isn't mounted — fall back to defaults
          // rather than failing the Stop hook (#1745). Anything other
          // than ConfigError still propagates.
          let agentConfig: { session_continuity?: { enabled?: boolean; max_turns_in_briefing?: number } } | undefined;
          let agentDir: string;
          try {
            const config = getConfig(program);
            agentConfig = config.agents[agentName];
            if (!agentConfig) {
              process.stderr.write(
                `handoff: agent "${agentName}" not defined in switchroom.yaml\n`,
              );
              return;
            }
            const agentsDir = resolveAgentsDir(config);
            agentDir = resolve(agentsDir, agentName);
          } catch (err) {
            if (!(err instanceof ConfigError)) throw err;
            process.stderr.write(
              `handoff: yaml unavailable (${err.message}); using defaults\n`,
            );
            agentConfig = undefined;
            // Hook runs from the agent's cwd; Claude Code also exports
            // CLAUDE_PROJECT_DIR. Either reaches the same place.
            agentDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
          }

          const continuity = agentConfig?.session_continuity;
          if (continuity?.enabled === false) {
            process.stderr.write(
              `handoff: session_continuity.enabled=false for "${agentName}"; skipping\n`,
            );
            return;
          }

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
