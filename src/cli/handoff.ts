import type { Command } from "commander";
import { resolve } from "node:path";
import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir, ConfigError } from "../config/loader.js";
import {
  buildHandoff,
  findLatestSessionJsonl,
  DEFAULT_MAX_TURNS,
} from "../agents/handoff-summarizer.js";
import { resolveAgentConfig } from "../config/merge.js";
import {
  pruneSessionJsonl,
  DEFAULT_SESSION_RETENTION_MAX_COUNT,
  DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
} from "../agents/session-retention.js";

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
 *
 * This command writes ONLY the on-disk sidecars. It used to also mirror
 * the transcript tail into Hindsight (`document_id: "session_handoff"`);
 * that mirror was removed because it re-ingested the assistant's own
 * prior output as extractable facts — memory poisoning (see the module
 * header in `src/agents/handoff-summarizer.ts`).
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
          let agentConfig: { session_continuity?: { enabled?: boolean; max_turns_in_briefing?: number; session_retention_max_count?: number; session_retention_max_age_days?: number } } | undefined;
          let agentDir: string;
          try {
            const config = getConfig(program);
            const rawAgent = config.agents[agentName];
            if (!rawAgent) {
              process.stderr.write(
                `handoff: agent "${agentName}" not defined in switchroom.yaml\n`,
              );
              return;
            }
            // Through the cascade, not the raw entry: `session_continuity.*`
            // keys are accepted at the defaults/profile tier too, so reading
            // `config.agents[name]` directly would miss a fleet-wide value.
            agentConfig = resolveAgentConfig(
              config.defaults,
              config.profiles,
              rawAgent,
            );
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

          // Session-JSONL retention (#2792). Runs after the briefing is
          // built so the newest transcript — the handoff source — is
          // never pruned. Best-effort; never blocks shutdown.
          const retention = pruneSessionJsonl(claudeConfigDir, {
            maxCount:
              continuity?.session_retention_max_count ??
              DEFAULT_SESSION_RETENTION_MAX_COUNT,
            maxAgeDays:
              continuity?.session_retention_max_age_days ??
              DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
            keepPath: jsonl,
          });
          if (retention.deleted > 0) {
            process.stderr.write(
              `handoff: pruned ${retention.deleted} old session transcript(s)\n`,
            );
          }
        },
      ),
    );
}
