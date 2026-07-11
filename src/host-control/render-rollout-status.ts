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
 *
 * The render is a MULTI-LINE progress-card-style checklist (GFM: `-` lists,
 * bold, code spans — matching the telegram-plugin progress-card vocabulary):
 * a header (version → version, short request id, phase), one checklist line
 * per known agent (✓ done / ⏳ in progress / · pending / ✗ failed, with
 * durations), a rough ETA once at least one agent finished, and a terminal
 * summary incl. elapsed total and the deferred host-side components.
 */

/** Per-agent progress an accumulator (the narrator) feeds the renderer. */
export type AgentRollStatus = "pending" | "running" | "done" | "failed";

export interface AgentRollProgress {
  name: string;
  status: AgentRollStatus;
  /** True for the canary agent (rolled first, gates the rest). */
  canary?: boolean;
  /** Restart wall-time once the agent finished (done/failed). */
  durationMs?: number;
  /** ms-since-epoch the agent's restart began (accumulator bookkeeping). */
  startedAtMs?: number;
}

/** The rollout progress state a renderer needs — a projection of the latest
 *  durable rollout row / status payload. */
export interface RolloutRenderState {
  target: string;
  /** Version that was running before this roll (prior pin), when known. */
  fromVersion?: string;
  /** hostd request_id — rendered shortened so the operator can `get_status` it. */
  requestId?: string;
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
  /** Per-agent checklist state, in roll order (accumulated by the narrator). */
  agents?: AgentRollProgress[];
  /** ms since epoch the roll started (for the elapsed line). */
  startedAtMs?: number;
  /** ms since epoch "now" at render time (clock seam — keeps the fn pure). */
  nowMs?: number;
  /** Total elapsed ms (terminal rows, where finished_at is known). */
  elapsedMs?: number;
  /** True once the hostd/web refresh was deferred to a host-side run. */
  deferred?: boolean;
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
    case "self-bump":
      return "hostd refreshing itself to the target (brief control blip)…";
    case "self-bump-done":
      return "hostd refreshed — resuming the roll";
    default:
      return "starting";
  }
}

/** Compact human duration: 42s / 3m 10s / 1h 5m. */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr}h ${min}m` : `${hr}h`;
}

/** Shorten a hostd request_id for the header (still get_status-able by prefix
 *  recall — the full id lives in the durable audit row). */
function shortRequestId(id: string): string {
  return id.length > 16 ? id.slice(0, 16) + "…" : id;
}

/** Header line: icon + version → version + short request id. */
function headerLine(s: RolloutRenderState, icon: string): string {
  const arrow = s.fromVersion
    ? `\`${s.fromVersion}\` → \`${s.target}\``
    : `→ \`${s.target}\``;
  const req = s.requestId ? ` · req \`${shortRequestId(s.requestId)}\`` : "";
  return `${icon} **Rollout** ${arrow}${req}`;
}

/** One `- <glyph> agent` checklist line per known agent, in roll order. */
function checklistLines(s: RolloutRenderState): string[] {
  const agents = s.agents ?? [];
  const lines: string[] = [];
  for (const a of agents) {
    const canary = a.canary ? " (canary)" : "";
    const dur = a.durationMs !== undefined ? ` — ${formatDurationMs(a.durationMs)}` : "";
    switch (a.status) {
      case "done":
        lines.push(`- ✓ \`${a.name}\`${canary}${dur}`);
        break;
      case "running":
        lines.push(`- ⏳ \`${a.name}\`${canary} — restarting…`);
        break;
      case "failed":
        lines.push(`- ✗ \`${a.name}\`${canary} — failed${dur}`);
        break;
      default:
        lines.push(`- · \`${a.name}\`${canary}`);
    }
  }
  // Agents we haven't seen a phase for yet (names unknown until their
  // agent-start row): collapse into one pending line.
  const remaining = s.m !== undefined ? s.m - agents.length : 0;
  if (remaining > 0 && agents.length > 0) {
    lines.push(`- · ${remaining} more pending`);
  }
  return lines;
}

/** Rough ETA from the mean per-agent duration so far. */
function etaLine(s: RolloutRenderState): string | null {
  if (s.m === undefined) return null;
  const done = (s.agents ?? []).filter(
    (a) => a.status === "done" && a.durationMs !== undefined,
  );
  if (done.length === 0) return null;
  const remaining = s.m - done.length;
  if (remaining <= 0) return null;
  const meanMs = done.reduce((t, a) => t + (a.durationMs ?? 0), 0) / done.length;
  return `~${formatDurationMs(meanMs * remaining)} left (rough est.)`;
}

/** What stays on the prior version after an agent-invoked (hostd) roll, and
 *  the host-side commands that update each. */
function deferredLines(target: string): string[] {
  const bare = target.trim().replace(/^v/, "");
  return [
    `**Deferred (still on the prior version — run host-side):**`,
    `- \`switchroom-web\` — \`switchroom webd install --tag ${target}\``,
    `- host operator CLI — \`sudo npm i -g switchroom@${bare}\``,
    `- hostd template regen (only if the release changed hostd mounts/env) — \`switchroom hostd install --tag ${target}\``,
  ];
}

/**
 * Render the full status message body. When `terminal` is set, renders the
 * final ✅/❌ summary; otherwise the in-flight progress checklist. Always leads
 * with the target so the message is self-describing when scrolled back to.
 */
export function renderRolloutStatus(s: RolloutRenderState): string {
  const rolled = s.rolled ?? [];
  const rolledCount = rolled.length;
  const checklist = checklistLines(s);
  const elapsedMs =
    s.elapsedMs ??
    (s.startedAtMs !== undefined && s.nowMs !== undefined
      ? s.nowMs - s.startedAtMs
      : undefined);

  if (s.terminal === "completed") {
    const parts = [headerLine(s, "✅")];
    let summary = `**Done** — rolled ${rolledCount}${s.m !== undefined ? `/${s.m}` : ""} agent(s)`;
    if (elapsedMs !== undefined) summary += ` in ${formatDurationMs(elapsedMs)}`;
    summary += `: ${rolled.join(", ") || "none"}.`;
    parts.push(summary);
    if (checklist.length > 0) parts.push("", ...checklist);
    if (s.deferred !== false) parts.push("", ...deferredLines(s.target));
    return parts.join("\n");
  }

  if (s.terminal === "error") {
    const where = s.failedStep
      ? ` at \`${s.failedStep}\`${s.failedAgent ? ` (\`${s.failedAgent}\` → ${s.got ?? "unreachable"})` : ""}`
      : "";
    const parts = [headerLine(s, "❌")];
    let summary = `**STOPPED**${where}`;
    if (elapsedMs !== undefined) summary += ` after ${formatDurationMs(elapsedMs)}`;
    summary += `. Rolled before stop: ${rolled.join(", ") || "none"}.`;
    parts.push(summary);
    if (checklist.length > 0) parts.push("", ...checklist);
    return parts.join("\n");
  }

  // In-flight.
  const parts = [headerLine(s, "⏳"), `**Phase:** ${phaseLine(s)}`];
  if (checklist.length > 0) parts.push("", ...checklist);
  const footer: string[] = [];
  if (s.m !== undefined) footer.push(`${rolledCount}/${s.m} rolled`);
  else if (rolledCount > 0) footer.push(`${rolledCount} rolled`);
  if (elapsedMs !== undefined) footer.push(`elapsed ${formatDurationMs(elapsedMs)}`);
  const eta = etaLine(s);
  if (eta) footer.push(eta);
  if (footer.length > 0) parts.push("", footer.join(" · "));
  return parts.join("\n");
}
