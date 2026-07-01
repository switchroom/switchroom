/**
 * Pure renderers for the rollout status message (#2726).
 *
 * The rollout narration is an ORDINARY operator-DM message the operator can
 * scroll to — NOT a pinned card, NOT a bespoke widget. It reads like the
 * framework speaking a plain progress line in the chat, which is exactly the
 * remedy the `chat-is-the-single-source-of-truth` invariant prescribes (in-chat
 * narration, never a parallel pinned mirror).
 *
 * These functions are pure (input → string) so both the terminal push (Part 1)
 * and the log-tailed narration surface (Part 2) render identically and can be
 * unit-tested without a gateway.
 */

/** The rollout progress state a renderer needs — a projection of the latest
 *  durable rollout row / status payload. */
export interface RolloutRenderState {
  target: string;
  /** Current phase name from the latest phase row, or "terminal". */
  phase?: string;
  /** Agents confirmed on the target, in order. */
  rolled?: string[];
  /** Roll-order position (1-based) of the agent in the current phase. */
  n?: number;
  /** Total agents this roll restarts. */
  m?: number;
  /** Agent named in the current phase. */
  agent?: string;
  /** Terminal outcome — set only once the roll finished. */
  terminal?: "completed" | "error";
  /** Step that stopped a failed roll. */
  failedStep?: string;
  /** Agent that failed the version assert. */
  failedAgent?: string;
  /** Version detected on the failed agent (null = unreachable). */
  got?: string | null;
}

/** Human-readable one-liner for the current phase. */
function phaseLine(s: RolloutRenderState): string {
  switch (s.phase) {
    case "apply":
      return "applying — regenerating compose";
    case "canary-start":
      return `canary — restarting ${s.agent ?? "canary agent"}`;
    case "canary-pass":
      return `canary passed (${s.agent ?? "canary"}) — rolling the rest`;
    case "canary-fail":
      return `canary failed (${s.agent ?? "canary"})`;
    case "agent-start":
      return `agent ${s.n ?? "?"}/${s.m ?? "?"} — restarting ${s.agent ?? ""}`.trim();
    case "agent-done":
      return `agent ${s.n ?? "?"}/${s.m ?? "?"} — ${s.agent ?? ""} done`.trim();
    case "persist-pin":
      return "persisting pin";
    case "hostd-web-deferred":
      return "hostd/web refresh deferred (run host-side)";
    default:
      return "starting";
  }
}

/**
 * Render the full status message body. When `terminal` is set, renders the
 * final ✅/❌ line; otherwise the in-flight progress line. Always leads with the
 * target so the message is self-describing when scrolled back to.
 */
export function renderRolloutStatus(s: RolloutRenderState): string {
  const head = `Rollout → ${s.target}`;
  const rolledCount = s.rolled?.length ?? 0;
  if (s.terminal === "completed") {
    return `✅ ${head} — done. Rolled ${rolledCount} agent(s): ${(s.rolled ?? []).join(", ") || "none"}.`;
  }
  if (s.terminal === "error") {
    const where = s.failedStep
      ? ` at ${s.failedStep}${s.failedAgent ? ` (${s.failedAgent} → ${s.got ?? "unreachable"})` : ""}`
      : "";
    return (
      `❌ ${head} — STOPPED${where}. ` +
      `Rolled before stop: ${(s.rolled ?? []).join(", ") || "none"}.`
    );
  }
  // In-flight.
  const progress = rolledCount > 0 ? ` · ${rolledCount} rolled` : "";
  return `⏳ ${head} — ${phaseLine(s)}${progress}`;
}
