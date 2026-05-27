/**
 * Tool-intent surface — lifts the model's already-formed `tool_use`
 * intent (tool name + input) into a brief user-visible Telegram
 * message when the model goes to work without first calling reply.
 *
 * Companion to the PreToolUse ack-first gate (#1921). The gate forces
 * the model to author a brief acknowledgement via the reply tool
 * before any other tool runs. THIS surface is the lower-overhead
 * sibling: when the model's own `tool_use` stream already carries the
 * intent (e.g. `Bash {command: "ls -la /var/log"}`), the gateway can
 * pass that intent through as the user-visible "we're alive and this
 * is what we're doing" beat, without the model having to call any
 * extra tool.
 *
 * Why both. The gate produces MODEL-VOICE acks ("on it — checking the
 * logs") — warmer, persona-driven. The surface produces FRAMEWORK-
 * VOICE pass-throughs ("_running:_ ls -la /var/log") — honest and
 * cheaper. They compose: if the gate fires, the model authors an ack
 * which lands first; the surface stays quiet (already-acked). If the
 * gate fails (kill-switched / regression / hook spawn failure), the
 * surface still lands — defence in depth.
 *
 * Output format: italicised framework verb + colon + the model's own
 * `toolLabel()` output. Italics are the conventional "framework
 * narrating, not the model speaking" marker; the verb signals which
 * lane the work is in. Length capped at ~140 chars by `toolLabel()`
 * already; nothing more is added on top.
 *
 * Privacy posture. The model's `tool_use.input` may contain user-
 * provided strings (web search queries, file paths the user named).
 * Those are already going to land in chat history one way or another
 * (e.g. via the model's reply describing what it did), so surfacing
 * a brief label here doesn't expand the leakage surface materially.
 * `toolLabel()` already truncates and HTML-escapes its output via
 * the renderer.
 */

import { toolLabel } from "./tool-labels.js";

const MAX_LABEL_LEN = 140;

/**
 * Compute the user-facing "framework verb" for a tool. Verbs match
 * the action class so the user reads "running" for Bash, "searching"
 * for WebSearch, etc. Tools without a friendly verb fall back to
 * `using <ToolName>` — better than blanking out.
 */
function frameworkVerbFor(toolName: string): string {
  // Strip "mcp__<server>__" prefix to match suffixes consistently.
  // Most MCP tools surface as `mcp__<server>__<tool>` in the stream.
  const m = /^mcp__[^_]+__(.+)$/.exec(toolName);
  const suffix = (m ? m[1] : toolName).toLowerCase();

  switch (suffix) {
    case "bash":
    case "bashoutput":
    case "killshell":
      return "running";
    case "websearch":
    case "grep":
    case "glob":
      return "searching";
    case "webfetch":
      return "fetching";
    case "read":
      return "reading";
    case "write":
      return "writing";
    case "edit":
    case "multiedit":
    case "notebookedit":
      return "editing";
    case "todowrite":
    case "todoread":
      return "noting";
    case "task":
    case "agent":
      return "dispatching";
    case "toolsearch":
      return "loading tools";
    default:
      // For unknown / MCP tools, prefer a short generic — "using gdrive"
      // is more honest than guessing.
      if (m) return `using ${m[1].replace(/_/g, " ")}`;
      return `using ${toolName}`;
  }
}

/** A tool that surfaces in the chat itself (reply / stream_reply / etc.)
 *  — these tools ARE the user surface, so the gateway never re-surfaces
 *  them. Mirrors `isTelegramSurfaceTool` in `tool-names.ts`. */
function isUserFacingTool(toolName: string): boolean {
  const m = /^mcp__switchroom-telegram__(.+)$/.exec(toolName);
  const suffix = m ? m[1] : toolName;
  return (
    suffix === "reply" ||
    suffix === "stream_reply" ||
    suffix === "edit_message" ||
    suffix === "react" ||
    suffix === "send_typing" ||
    suffix === "pin_message" ||
    suffix === "delete_message" ||
    suffix === "forward_message" ||
    suffix === "download_attachment" ||
    suffix === "get_recent_messages" ||
    suffix === "progress_update"
  );
}

export interface SurfaceTextResult {
  /** Final HTML text the gateway sends to Telegram, or null when the
   *  surface should NOT fire (tool is user-facing, label is empty, etc.) */
  text: string | null;
}

/**
 * Pure decision: given a tool name + input + optional precomputed label
 * (from the existing PreToolUse label hook), return the HTML the
 * gateway should send, or null to stay quiet.
 *
 * Exposed for unit tests; the gateway wires this into the `tool_use`
 * session-event handler.
 */
export function deriveIntentSurface(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  precomputedLabel?: string,
): SurfaceTextResult {
  if (!toolName) return { text: null };
  if (isUserFacingTool(toolName)) return { text: null };

  const label = toolLabel(toolName, toolInput, undefined, precomputedLabel);
  if (!label || !label.trim()) {
    // No label available for this tool/input shape — fall back to just
    // the verb so the user at least sees "_running_" rather than
    // nothing. Keeps the beat reliable on weird inputs.
    return {
      text: `<i>${escapeHtml(frameworkVerbFor(toolName))}</i>`,
    };
  }

  const verb = frameworkVerbFor(toolName);
  // `toolLabel()` may include backticks / quotes — let those through
  // (Telegram HTML doesn't choke on them) but escape any stray inline
  // HTML markers so a malicious or odd input can't inject markup.
  const safeLabel = escapeHtml(label).slice(0, MAX_LABEL_LEN);
  return { text: `<i>${escapeHtml(verb)}:</i> ${safeLabel}` };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
