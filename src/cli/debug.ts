import type { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  buildStableBootstrapPrompt,
  buildDynamicBootstrapPrompt,
  resolveAgentWorkspaceDir,
} from "../agents/workspace.js";
import { resolveAgentConfig, usesSwitchroomTelegramPlugin } from "../config/merge.js";

/**
 * `switchroom debug` commands for observability into what the model sees.
 *
 * Commands:
 * - `turn <agent> [--last=N]`: dump the exact prompt layering that went to
 *   the model on the most recent (or N-th most recent) completed turn
 */

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString()} bytes`;
}

function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Find the most recent JSONL transcript file for an agent by scanning the
 * .claude/projects/ directory and sorting by mtime.
 */
function findLatestTranscriptJsonl(claudeConfigDir: string): string | undefined {
  const projectsDir = join(claudeConfigDir, "projects");
  if (!existsSync(projectsDir)) return undefined;

  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });
    let latest: { path: string; mtime: number } | undefined;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = join(projectsDir, entry.name);
      const transcriptPath = join(projectPath, "transcript.jsonl");
      if (!existsSync(transcriptPath)) continue;

      const stat = statSync(transcriptPath);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { path: transcriptPath, mtime: stat.mtimeMs };
      }
    }

    return latest?.path;
  } catch {
    return undefined;
  }
}

/**
 * Extract the most recent user message from a JSONL transcript. Returns the
 * message text and the turn timestamp.
 */
function extractLatestUserMessage(
  transcriptPath: string,
): { text: string; timestamp: string } | undefined {
  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      try {
        const event = JSON.parse(line);
        if (
          event.type === "message" &&
          event.role === "user" &&
          typeof event.content === "string"
        ) {
          const timestamp = event.timestamp
            ? new Date(event.timestamp).toLocaleString()
            : "unknown";
          return { text: event.content, timestamp };
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
}

/**
 * Build the progress_update guidance block that's appended to the system
 * prompt for agents using the switchroom telegram plugin. Extracted from
 * scaffold.ts to keep it DRY.
 */
function buildProgressUpdateGuidance(): string {
  return `## Progress updates (human-style check-ins)

You're talking to a human colleague on Telegram. Alongside the emoji status
ladder, send a short \`progress_update\` at inflection points, the moments a
senior colleague would ping the person who asked them to do something:

- **Plan formed:** "Got it. Going to do X first, then Y, then Z."
- **Pivot or blocker:** "First approach didn't work because <reason>. Trying
  <alternative> instead."
- **Chunk finished:** "Done with X. Starting Y now."

Keep them short (one or two sentences). Don't narrate every step, the pinned
progress card shows that for free. Don't send an update on a trivial one-shot
task. Send them when a colleague would genuinely want to know what's happening.

Final answers still go through \`stream_reply\` with done=true as usual,
\`progress_update\` is only for mid-turn check-ins.`;
}

export function registerDebugCommand(program: Command): void {
  const cmd = program
    .command("debug")
    .description("Observability tools for inspecting agent prompt layering");

  cmd
    .command("turn <agent>")
    .description(
      "Dump the exact prompt layering the model saw on the most recent turn",
    )
    .option("--last <n>", "Show N-th most recent turn instead of latest", "1")
    .action(
      withConfigError(async (agentName: string, opts: { last: string }) => {
        const config = getConfig(program);
        const agentConfig = config.agents[agentName];

        if (!agentConfig) {
          console.error(`Agent '${agentName}' not found in switchroom.yaml`);
          process.exit(1);
        }

        const agentsDir = resolveAgentsDir(config);
        const agentDir = resolve(agentsDir, agentName);

        if (!existsSync(agentDir)) {
          console.error(`Agent directory not found: ${agentDir}`);
          process.exit(1);
        }

        const workspaceDir = resolveAgentWorkspaceDir(agentDir);
        const claudeConfigDir = join(agentDir, ".claude");
        const claudeMdPath = join(agentDir, "CLAUDE.md");
        // Phase 2: SOUL.md lives at workspace/SOUL.md (authoritative), with a
        // symlink at <agentDir>/SOUL.md for Claude Code auto-discovery.
        const soulMdPath = join(agentDir, "SOUL.md");
        const workspaceSoulMdPath = join(workspaceDir, "SOUL.md");
        const handoffPath = join(agentDir, ".handoff.md");

        const lastN = parseInt(opts.last, 10);
        if (isNaN(lastN) || lastN < 1) {
          console.error("--last must be a positive integer");
          process.exit(1);
        }

        if (lastN > 1) {
          console.error(
            "Note: --last N where N > 1 not yet implemented (only latest turn supported)",
          );
          process.exit(1);
        }

        console.log(`=== Debug Turn Dump: ${agentName} ===\n`);

        // 1. Stable system prompt content
        console.log("=== Append System Prompt (stable) ===\n");

        const resolved = resolveAgentConfig(
          config.defaults,
          config.profiles,
          agentConfig,
        );
        const useHotReloadStable = resolved.channels?.telegram?.hotReloadStable === true;

        const stableResult = await buildStableBootstrapPrompt({
          workspaceDir,
          budget: { warningMode: "off" },
        });

        if (useHotReloadStable) {
          console.log(
            `-- Workspace Stable Render (not used — stable content is in per-turn hook) --`,
          );
          console.log();
        } else if (stableResult.concatenated.trim().length > 0) {
          console.log(
            `-- Workspace Stable Render (${formatBytes(stableResult.concatenated.length)}) --`,
          );
          console.log(stableResult.concatenated);
          console.log();
        } else {
          console.log("-- Workspace Stable Render (0 bytes, not set up) --");
          console.log();
        }

        // Progress updates guidance
        const useSwitchroomPlugin = usesSwitchroomTelegramPlugin(resolved);
        const progressGuidance = useSwitchroomPlugin
          ? buildProgressUpdateGuidance()
          : "";

        if (progressGuidance.length > 0) {
          console.log(
            `-- Progress Updates Guidance (${formatBytes(progressGuidance.length)}) --`,
          );
          console.log(progressGuidance);
          console.log();
        }

        const baseSystemPromptAppend = resolved.system_prompt_append ?? "";
        if (baseSystemPromptAppend.trim().length > 0) {
          console.log(
            `-- User System Prompt Append (${formatBytes(baseSystemPromptAppend.length)}) --`,
          );
          console.log(baseSystemPromptAppend);
          console.log();
        }

        // 2. Per-session system prompt content
        console.log("=== Append System Prompt (per-session) ===\n");

        const handoffContent = existsSync(handoffPath)
          ? readFileSync(handoffPath, "utf-8")
          : "";

        if (handoffContent.trim().length > 0) {
          console.log(
            `-- Handoff Briefing (${formatBytes(handoffContent.length)}) --`,
          );
          console.log(handoffContent);
          console.log();
        } else {
          console.log("-- Handoff Briefing (0 bytes, no prior session) --");
          console.log();
        }

        // 3. CLAUDE.md (auto-loaded by Claude Code)
        console.log(
          "=== CLAUDE.md (auto-loaded by Claude Code) ===\n",
        );

        const claudeMdContent = existsSync(claudeMdPath)
          ? readFileSync(claudeMdPath, "utf-8")
          : "";

        if (claudeMdContent.trim().length > 0) {
          console.log(`(${formatBytes(claudeMdContent.length)})`);
          console.log(claudeMdContent);
          console.log();
        } else {
          console.log("(0 bytes, not present)");
          console.log();
        }

        // 4. SOUL.md (authoritative persona source from workspace/, symlinked
        //    to agent root for Claude Code auto-discovery)
        console.log(
          "=== Persona (SOUL.md) ===\n",
        );

        // Read from symlink path first (agent root), fall back to workspace
        const soulMdContent = existsSync(soulMdPath)
          ? readFileSync(soulMdPath, "utf-8")
          : existsSync(workspaceSoulMdPath)
          ? readFileSync(workspaceSoulMdPath, "utf-8")
          : "";

        if (soulMdContent.trim().length > 0) {
          console.log(`(${formatBytes(soulMdContent.length)})`);
          console.log(soulMdContent);
          console.log();
        } else {
          console.log(
            "(0 bytes, stale placeholder — Phase 2 item: single source of truth for persona)",
          );
          console.log();
        }

        // 5. Per-turn injections (UserPromptSubmit hooks)
        console.log("=== Per-Turn Injections (UserPromptSubmit) ===\n");

        // Stable workspace render (when hot-reload mode is enabled)
        if (useHotReloadStable) {
          if (stableResult.concatenated.trim().length > 0) {
            console.log(
              `-- Workspace Stable (hot-reload hook): ${formatBytes(stableResult.concatenated.length)} --`,
            );
            console.log(stableResult.concatenated);
            console.log();
          } else {
            console.log(
              "-- Workspace Stable (hot-reload hook): 0 bytes, not set up --",
            );
            console.log();
          }
        }

        // Dynamic workspace render
        const dynamicResult = await buildDynamicBootstrapPrompt({
          workspaceDir,
          budget: { warningMode: "off" },
        });

        if (dynamicResult.concatenated.trim().length > 0) {
          console.log(
            `-- Workspace Dynamic: fired, ${formatBytes(dynamicResult.concatenated.length)} --`,
          );
          console.log(dynamicResult.concatenated);
          console.log();
        } else {
          console.log(
            "-- Workspace Dynamic: no content (MEMORY.md and daily notes empty or missing) --",
          );
          console.log();
        }

        // Hindsight recall (we can't recover the exact recall from logs easily,
        // so we just note whether it would have fired)
        const hindsightEnabled =
          config.memory?.backend === "hindsight" &&
          agentConfig.memory?.auto_recall !== false;

        if (hindsightEnabled) {
          console.log(
            "-- Hindsight Recall: enabled (exact content unavailable, check hindsight logs) --",
          );
          console.log();
        } else {
          console.log("-- Hindsight Recall: disabled --");
          console.log();
        }

        // 6. User message (from transcript)
        console.log("=== User Message (latest turn) ===\n");

        const transcriptPath = findLatestTranscriptJsonl(claudeConfigDir);
        const userMessage = transcriptPath
          ? extractLatestUserMessage(transcriptPath)
          : undefined;

        if (userMessage) {
          console.log(`(Turn timestamp: ${userMessage.timestamp})`);
          console.log(userMessage.text);
          console.log();
        } else {
          console.log(
            "(unavailable: no transcript found or transcript empty)",
          );
          console.log();
        }

        // 7. Totals and cache hash
        console.log("=== Totals ===\n");

        const stableBytes =
          stableResult.concatenated.length +
          progressGuidance.length +
          baseSystemPromptAppend.length;
        const perSessionBytes = handoffContent.length;
        const claudeMdBytes = claudeMdContent.length;
        const soulMdBytes = soulMdContent.length;
        const perTurnBytes = dynamicResult.concatenated.length;
        const userBytes = userMessage?.text.length ?? 0;
        const totalBytes =
          stableBytes +
          perSessionBytes +
          claudeMdBytes +
          soulMdBytes +
          perTurnBytes +
          userBytes;

        console.log(
          `Stable prefix:     ${formatBytes(stableBytes).padEnd(20)} (cache-hot)`,
        );
        console.log(
          `Per-session:       ${formatBytes(perSessionBytes).padEnd(20)} (cache-warm until next session)`,
        );
        console.log(
          `CLAUDE.md:         ${formatBytes(claudeMdBytes).padEnd(20)}`,
        );
        console.log(
          `SOUL.md:           ${formatBytes(soulMdBytes).padEnd(20)}`,
        );
        console.log(
          `Per-turn:          ${formatBytes(perTurnBytes).padEnd(20)} (never cached)`,
        );
        console.log(
          `User message:      ${formatBytes(userBytes).padEnd(20)}`,
        );
        console.log(
          `Total:             ${formatBytes(totalBytes).padEnd(20)} (~${estimateTokens(totalBytes).toLocaleString()} tokens est.)`,
        );

        const stableCacheInput =
          stableResult.concatenated + progressGuidance + baseSystemPromptAppend;
        const stableHash = sha256(stableCacheInput);
        console.log(`Cache stable hash: sha256:${stableHash}`);
        console.log();
      }),
    );
}
