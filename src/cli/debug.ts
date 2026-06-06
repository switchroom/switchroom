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
import { isHindsightEnabled } from "../memory/hindsight.js";

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

export function estimateTokens(bytes: number): number {
  // ~3.7 chars/token for switchroom's mixed prose+markdown prompts (the ratio
  // used by the 2026-06 context audit). The Claude tokenizer is not public and
  // the API count_tokens endpoint is off-limits (compliance), so this is an
  // estimate (±~15%), not an exact count.
  return Math.round(bytes / 3.7);
}

/**
 * Sum the per-server tool-schema BYTES from a cached MCP tools snapshot, if one
 * exists. The dominant per-turn cost (the audit: ~31k tok across ~10 servers)
 * is the MCP tool-schema surface, which `debug turn` historically omitted —
 * understating the true floor ~3x. We do NOT spawn the servers here (that would
 * touch live processes from a read-only command); we count the server ENTRIES
 * in .mcp.json and annotate the surface as estimated/unmeasured unless a
 * captured snapshot is present. Returns server names for the annotation.
 */
export function readMcpServerNames(agentDir: string): string[] | null {
  const mcpPath = join(agentDir, ".mcp.json");
  if (!existsSync(mcpPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Object.keys(parsed.mcpServers ?? {});
  } catch {
    // .mcp.json is 0600 agent-private (it can carry per-server env/paths), so
    // a running agent's file is unreadable from the operator account. Signal
    // null (unknown) rather than a misleading 0.
    return null;
  }
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
    .command("debug", { hidden: true })
    .description("Observability tools for inspecting agent prompt layering [advanced]");

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
          isHindsightEnabled(config) &&
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
        // SOUL.md is ALREADY inside stableResult.concatenated (it is one of the
        // STABLE_BOOTSTRAP_FILENAMES), so it must NOT be added to the total
        // again — the prior code double-counted it. Shown below as an
        // informational sub-line only.
        const soulMdBytes = soulMdContent.length;
        const perTurnBytes = dynamicResult.concatenated.length;
        const userBytes = userMessage?.text.length ?? 0;

        // --add-dir fleet invariants (switchroom-invariants.md + fleet/CLAUDE.md)
        // are loaded on EVERY turn via the --add-dir flag but were omitted here.
        const fleetDir = join(agentsDir, "..", "fleet");
        const fleetInvPath = join(fleetDir, "switchroom-invariants.md");
        const fleetClaudePath = join(fleetDir, "CLAUDE.md");
        const fleetInvBytes = existsSync(fleetInvPath)
          ? readFileSync(fleetInvPath, "utf-8").length
          : 0;
        const fleetClaudeBytes = existsSync(fleetClaudePath)
          ? readFileSync(fleetClaudePath, "utf-8").length
          : 0;
        const fleetBytes = fleetInvBytes + fleetClaudeBytes;

        const totalBytes =
          stableBytes +
          perSessionBytes +
          claudeMdBytes +
          fleetBytes +
          perTurnBytes +
          userBytes;

        console.log(
          `Stable prefix:     ${formatBytes(stableBytes).padEnd(20)} (cache-hot; includes SOUL.md ${soulMdBytes.toLocaleString()}B)`,
        );
        console.log(
          `Per-session:       ${formatBytes(perSessionBytes).padEnd(20)} (cache-warm until next session)`,
        );
        console.log(
          `CLAUDE.md (cwd):   ${formatBytes(claudeMdBytes).padEnd(20)} (cache-hot)`,
        );
        console.log(
          `Fleet invariants:  ${formatBytes(fleetBytes).padEnd(20)} (--add-dir, cache-hot)`,
        );
        console.log(
          `Per-turn:          ${formatBytes(perTurnBytes).padEnd(20)} (never cached — the real per-turn $ cost)`,
        );
        console.log(
          `User message:      ${formatBytes(userBytes).padEnd(20)}`,
        );
        console.log(
          `Authored text:     ${formatBytes(totalBytes).padEnd(20)} (~${estimateTokens(totalBytes).toLocaleString()} tokens est.)`,
        );

        // The MCP tool-schema surface is the DOMINANT per-turn cost (audit:
        // ~31k tok across ~10 servers, larger than all authored text) but is
        // not measured inline — it lives in the claude-CLI tools[] prefix, not
        // these files. With tool search (ENABLE_TOOL_SEARCH) the heavy servers
        // defer, so this surface mostly leaves the window.
        const mcpServers = readMcpServerNames(agentDir);
        const mcpCount = mcpServers?.length ?? null;
        const mcpEstK = mcpCount != null ? mcpCount * 3 : null;
        const mcpLabel =
          mcpCount != null
            ? `${mcpCount} servers`
            : "(unreadable — agent-private .mcp.json)";
        const mcpEstLabel = mcpEstK != null ? `~${mcpEstK.toLocaleString()}k tok` : "~30k tok (audit est.)";
        console.log(
          `MCP tool surface:  ${mcpLabel.padEnd(20)} (NOT counted above; ~3k tok/server ≈ ${mcpEstLabel} — deferred under tool search)`,
        );
        if (mcpServers && mcpServers.length > 0) {
          console.log(`                   [${mcpServers.join(", ")}]`);
        }
        const floorMcp = mcpEstK != null ? `~${mcpEstK.toLocaleString()}k` : "~30k";
        console.log(
          `Per-turn FLOOR:    ${`~${estimateTokens(totalBytes).toLocaleString()} + ${floorMcp} MCP + ~13k CLI-base`.padEnd(20)} tokens est. (before the user msg, recall, or tool results)`,
        );

        const stableCacheInput =
          stableResult.concatenated + progressGuidance + baseSystemPromptAppend;
        const stableHash = sha256(stableCacheInput);
        console.log(`Cache stable hash: sha256:${stableHash}`);
        console.log();
      }),
    );
}
