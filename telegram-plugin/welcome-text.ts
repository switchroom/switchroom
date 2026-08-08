/**
 * Pure text generators for the bot's welcome / help / status surfaces.
 *
 * Extracted from gateway.ts and server.ts so the wording is:
 *   1. single-sourced (no drift between gateway mode and monolith mode)
 *   2. unit-testable without needing a grammy Context
 *
 * All functions return GFM markdown strings (bold, italic, inline code)
 * ready for the rich-message path (#2669). The code-span wrapper is
 * deliberate for command names and agent identifiers, which render as
 * monospace inline (and inside a code span, characters are literal so no
 * escaping is needed).
 */

import { maskUsername } from "./demo-mask.js";
import { escapeMarkdown, stackCardLines } from "./card-format.js";

export type AuthSummary = {
  authenticated: boolean;
  subscription_type: string | null;
  expires_in: string | null;
  auth_source: string | null;
};

/**
 * Optional audit details surfaced on `/status` for a paired user. Populated
 * from switchroom.yaml at request time so the values reflect the live
 * config, not what was baked at scaffold time. Pre-#142 this content
 * lived in the SessionStart greeting card written by `scaffold.ts`; that
 * surface was deleted in #142 PR 1, and the content is reincarnated here
 * as on-demand server-side rendering instead of pushed-on-every-restart
 * client-side curl.
 *
 * All fields are optional — gateway only populates them when the yaml
 * load succeeds. A failure to read the config produces the previous
 * (auth + uptime + agent name) shape.
 */
export type AgentAudit = {
  /** Pre-formatted version string from build-info, e.g. "v0.3.0+44 · 2h ago". */
  version?: string;
  /** Tools allowlist preview — `["all"]` or up to 5 names plus `"+N more"`. */
  tools?: string;
  /** Tools denylist as a comma-joined string, or null. */
  toolsDeny?: string | null;
  /** Skills bundle preview — up to 6 names + `"…+N more"`, or null. */
  skills?: string | null;
  /** Session limits — `"idle 30m, 50 turns"` or `"unlimited (default)"`. */
  limits?: string;
  /** Channel plugin name, e.g. `"switchroom (default)"`. */
  channel?: string;
  /** Hindsight bank id for memory recall, defaults to agent name. */
  memoryBank?: string;
};

/**
 * One live probe row for the `/status` health block. Mirrors the
 * `ProbeResult` shape used by the boot card without dragging the
 * boot-probes module into welcome-text — keeps welcome-text dependency-
 * free for unit tests.
 */
export type StatusProbeRow = {
  /** ProbeStatus shape from boot-probes: ok / degraded / fail. */
  status: 'ok' | 'degraded' | 'fail';
  /** Display label, e.g. "Broker", "Scheduler". */
  label: string;
  /** Free-text detail, e.g. "running (pid 23) · last fire 4m ago". */
  detail: string;
};

export type AgentMetadata = {
  agentName: string;
  model: string | null;
  /**
   * Live session-model override set via the `/model` picker (session-only,
   * resets on restart). When present it's what the agent is ACTUALLY running
   * right now, distinct from `model` (the persistent configured model). Null
   * when no session switch is active — then `/status` just shows `model`.
   * Surfaced so `/status` and `/model` never silently disagree.
   */
  sessionModel?: string | null;
  extendsProfile: string | null;
  topicName: string | null;
  topicEmoji: string | null;
  uptime: string | null;
  status: string | null;
  auth: AuthSummary | null;
  /** Live audit details — present only when switchroom.yaml loaded cleanly. */
  audit?: AgentAudit;
  /**
   * Live probe results gathered at request time. Same probe set as the
   * boot card. Unlike the boot card (silent-when-healthy), `/status`
   * shows EVERY row including the green ones — the user explicitly
   * asked for current state, so terseness loses to completeness here.
   */
  live?: StatusProbeRow[];
  /**
   * Send-gate state (#3084 PR 3, part3-design §6). Present only when the gate
   * feature flag is ON; omitted entirely when off so `/status` looks exactly
   * as it did before the gate existed.
   */
  sendGate?: SendGateStatus;
};

/**
 * `/status` view of the deterministic send gate (#3084). Queued / shed totals
 * plus any open flood windows with their expiry. Only populated when the gate
 * is enabled.
 */
export type SendGateStatus = {
  queued: number;
  shed: number;
  expired: number;
  failedFast: number;
  dropped: number;
  /** Currently-open flood windows (expired already pruned). */
  openWindows: { scopeKey: string; untilTs: number }[];
};

// Markdown escaper for dynamic values interpolated into bold/plain card
// text (#2669). Kept under the legacy `escapeHtml` name so existing imports
// don't churn; it now escapes GFM-markdown specials.
export function escapeHtml(text: string): string {
  return escapeMarkdown(text);
}

/**
 * Compact one-line auth status suitable for the `/status` reply.
 * Examples:
 *   "✓ Max · expires in 29 days"
 *   "✓ Pro · oauth"
 *   "… pending auth"
 *   "✗ not authenticated"
 */
export function formatAuthLine(auth: AuthSummary | null): string {
  if (!auth) return "— auth state unknown";
  if (!auth.authenticated) {
    if (auth.auth_source === "pending") return "… pending auth";
    return "✗ not authenticated";
  }
  const sub = auth.subscription_type ?? "subscription";
  const expires = auth.expires_in ? ` · expires ${escapeHtml(auth.expires_in)}` : "";
  return `✓ ${escapeHtml(sub)}${expires}`;
}

/**
 * Agent / model one-liner. Model falls back to "inherited" when the
 * agent config doesn't pin one — Claude Code will pick the system
 * default.
 */
export function formatAgentLine(meta: AgentMetadata): string {
  const m = meta.model && meta.model.length > 0 ? meta.model : "default";
  const topic = meta.topicName
    ? ` · topic: ${escapeHtml([meta.topicEmoji, meta.topicName].filter(Boolean).join(" "))}`
    : "";
  // A live `/model` session switch overrides what's running. Show it next to
  // the configured model so the two surfaces agree (the override resets on
  // restart, when the session reverts to the configured model).
  const session =
    meta.sessionModel && meta.sessionModel.length > 0
      ? ` · live session: \`${meta.sessionModel}\``
      : "";
  return `**${escapeHtml(meta.agentName)}** · model: \`${m}\`${session}${topic}`;
}

/**
 * Welcome text for `/start`. Called when the user DMs a fresh bot.
 * We deliberately name Switchroom (not "Claude Code") to match product
 * reality — the bot is one persona out of a fleet on your subscription.
 */
export function startText(agentName: string, dmDisabled: boolean): string {
  if (dmDisabled) return "This bot isn't accepting new connections.";
  return stackCardLines([
    `**Switchroom** — Telegram on your Claude Pro or Max subscription.`,
    ``,
    `This bot is the **${escapeHtml(agentName)}** agent. Pair first, then send messages here and they reach the agent; replies and reactions come back.`,
    ``,
    `**To pair:**`,
    `1. DM me anything — you'll get a 6-char code`,
    `2. In Claude Code: \`/telegram:access pair <code>\``,
    ``,
    `After pairing, try \`/status\` or \`/commands\`.`,
  ]);
}

/**
 * Concise help — points at /commands for the full catalogue.
 * Deliberately short because Telegram truncates /help popovers.
 */
export function helpText(agentName: string): string {
  return stackCardLines([
    `**Switchroom** — your Pro/Max subscription, wired to Telegram.`,
    ``,
    `This bot is the **${escapeHtml(agentName)}** agent. Text and photos route through to it; replies, reactions and progress cards come back.`,
    ``,
    `Tool approvals surface as inline buttons (✅ / ❌) or via \`/approve\`, \`/deny\`, \`/pending\`. Start a fresh session with \`/new\`, or trim/clear context with \`/compact\` / \`/clear\`.`,
    ``,
    `\`/start\` — pairing instructions`,
    `\`/status\` — agent, model, auth`,
    `\`/vault audit <agent>\` — admin: review agent's vault access + one-tap [🔓 Allow] on recent denials`,
    `\`/commands\` — full command list`,
  ]);
}

/**
 * Rich `/status` output for a paired user. Includes agent, model,
 * auth state, and optional uptime / topic info.
 *
 * When `meta.audit` is populated (gateway successfully loaded
 * switchroom.yaml at request time), the reply also surfaces the full
 * config audit — Profile, Tools, Skills, Limits, Channel, Memory bank,
 * Version. This is the on-demand reincarnation of the SessionStart
 * greeting card deleted in #142 PR 1.
 */
const STATUS_DOT: Record<StatusProbeRow['status'], string> = {
  ok: '🟢',
  degraded: '🟡',
  fail: '🔴',
};

export function statusPairedText(params: {
  user: string;
  meta: AgentMetadata;
  /**
   * Demo mode (the `/status demo` suffix). When true the paired-user tag
   * (`@handle` or numeric sender id) is run through `maskUsername` so a
   * screen recording shows a stable fake `@demo_user…` handle instead of
   * the operator's real Telegram identity. Off by default — the agent /
   * model / health / audit topology below is NOT masked (out of scope).
   */
  demo?: boolean;
}): string {
  const { user, meta } = params;
  const shownUser = params.demo ? maskUsername(user) : user;
  const lines = [
    `Paired as ${escapeHtml(shownUser)}.`,
    ``,
    `Agent: ${formatAgentLine(meta)}`,
    `Auth: ${formatAuthLine(meta.auth)}`,
  ];
  if (meta.status) lines.push(`Status: \`${meta.status}\`${meta.uptime ? ` · up ${escapeHtml(meta.uptime)}` : ""}`);

  // Live health block — every probe (green and otherwise) so the user
  // can see at a glance what's working AND what isn't. This is the
  // `/status`-specific opposite of the boot card's silent-when-healthy
  // contract: the boot card is a quiet ack, /status is the dashboard.
  if (meta.live && meta.live.length > 0) {
    lines.push("");
    lines.push("**Health**");
    for (const row of meta.live) {
      const dot = STATUS_DOT[row.status] ?? STATUS_DOT.fail;
      lines.push(`${dot} **${escapeHtml(row.label)}**  ${escapeHtml(row.detail)}`);
    }
  }

  // Send-gate block (#3084 PR 3) — only when the gate flag is on, so a fleet
  // running with the gate OFF sees the identical pre-gate /status.
  if (meta.sendGate) {
    const sg = meta.sendGate;
    lines.push("");
    lines.push("**Send gate**");
    lines.push(
      `queued ${sg.queued} · shed ${sg.shed} · expired ${sg.expired} · ` +
        `fail-fast ${sg.failedFast} · dropped ${sg.dropped}`,
    );
    if (sg.openWindows.length > 0) {
      const now = Date.now();
      for (const w of sg.openWindows) {
        const secs = Math.max(0, Math.round((w.untilTs - now) / 1000));
        lines.push(`⏳ flood window \`${escapeHtml(w.scopeKey)}\` — clears in ${secs}s`);
      }
    } else {
      lines.push("no open flood windows");
    }
  }

  const audit = meta.audit;
  if (audit) {
    // Blank separator before the audit block so the reply reads as two
    // sections: live state up top, config audit below.
    lines.push("");
    if (audit.version) lines.push(`**Version** ${escapeHtml(audit.version)}`);
    if (meta.extendsProfile) lines.push(`**Profile** ${escapeHtml(meta.extendsProfile)}`);
    if (audit.tools) lines.push(`**Tools** ${escapeHtml(audit.tools)}`);
    if (audit.toolsDeny) lines.push(`**Deny** ${escapeHtml(audit.toolsDeny)}`);
    if (audit.skills) lines.push(`**Skills** ${escapeHtml(audit.skills)}`);
    if (audit.limits) lines.push(`**Limits** ${escapeHtml(audit.limits)}`);
    if (audit.channel) lines.push(`**Channel** ${escapeHtml(audit.channel)}`);
    if (audit.memoryBank) lines.push(`**Memory** ${escapeHtml(audit.memoryBank)}`);
  }

  return stackCardLines(lines);
}

/**
 * `/status` when the sender isn't paired yet but has a pending code.
 */
export function statusPendingText(code: string): string {
  return stackCardLines([
    `Pending pairing — run in Claude Code:`,
    ``,
    `\`/telegram:access pair ${code}\``,
  ]);
}

/**
 * `/status` when the sender is completely new.
 */
export function statusUnpairedText(): string {
  return "Not paired. Send me a message to get a pairing code.";
}

/**
 * The grouped /commands catalogue. Groups the commands so the list is
 * scannable rather than one flat 25-item dump.
 *
 * When this file changes, the switchroomCommands array in
 * registerSwitchroomBotCommands() (in both gateway.ts and server.ts)
 * must be kept in sync — the autocomplete menu is registered from
 * that array, not from this text. The `switchroomHelpCommandNames`
 * export lets a test pin the two together.
 */
export const switchroomHelpCommandNames = [
  // Session & approvals
  "new", "compact", "clear", "approve", "deny", "pending", "interrupt", "stop",
  // Agents
  "agents", "agentstart", "agentstop", "restart", "logs", "memory",
  // Auth & config — consolidated onto the `/auth` dashboard.
  "auth", "model",
  "topics", "update", "version", "whoami",
  "permissions", "grant", "dangerous", "vault", "doctor",
  "commands",
  // Note: "reconcile" is a deprecated alias still handled as a bot command
  // but intentionally omitted from this autocomplete/help array so it
  // doesn't appear in /commands or the Telegram command palette.
] as const;

/**
 * Trimmed slash-menu registered with Telegram via setMyCommands.
 *
 * This is deliberately NOT the full command catalogue — only the
 * commands a mobile user actually wants one tap away. Everything in
 * `switchroomHelpCommandNames` remains typable and working; the
 * autocomplete popup just doesn't clutter with ops primitives like
 * /vault, /grant, /dangerous, /permissions, /topics, /memory, and
 * /agentstart that are better driven from the terminal.
 *
 * Ordering matters — Telegram renders them in array order, so the
 * most-likely-to-be-used commands come first.
 */
export const TELEGRAM_MENU_COMMANDS = [
  // Pairing / welcome (baseCommands, not switchroom-owned but listed for completeness)
  { command: "start", description: "Pairing instructions" },
  { command: "help", description: "What this bot can do" },
  { command: "status", description: "Agent, model, auth" },
  // Session control (most-used)
  { command: "new", description: "Fresh session (flush handoff, restart)" },
  { command: "compact", description: "Compact context (summarize, keep the thread)" },
  { command: "clear", description: "Clear context (fresh slate; memory in Hindsight)" },
  // Privacy — pause/resume Hindsight auto-retain for this session
  // (session-start resets to public). Handlers shipped in #4445;
  // these entries only add them to the autocomplete menu.
  { command: "private", description: "Pause saving this session to memory" },
  { command: "public", description: "Resume saving this session to memory" },
  // Inline approvals
  { command: "approve", description: "Approve pending tool permission" },
  { command: "deny", description: "Deny pending tool permission" },
  { command: "pending", description: "List pending permission prompts" },
  // Agent lifecycle — three verbs only
  { command: "update", description: "Pull latest code + reconcile + restart" },
  { command: "restart", description: "Restart the agent (drain by default)" },
  { command: "version", description: "Show versions + running agent health" },
  // Quick diagnostic
  { command: "logs", description: "Show recent agent logs" },
  // #725 Phase 2 — inject a Claude Code REPL slash command into the agent's
  // tmux pane (allowlisted: /cost, /status, /model, /clear, /compact,
  // /memory, /hooks). Requires the tmux supervisor (the default — refused
  // when the agent has experimental.legacy_pty=true). NOT in the slash-menu
  // (kept the 20-entry mobile cap; the common injects /compact, /clear,
  // /model, /effort are first-class menu commands). Still typable + in
  // /commands.
  // /model — show or switch the Claude model (session-scoped; rides the
  // same inject primitive as `/inject /model` but with a typed argument,
  // so it never opens the undriveable no-arg picker modal).
  { command: "model", description: "Show or switch the Claude model" },
  // /effort — show or switch the reasoning effort (low→max, faster→smarter).
  // Same Claude-native inject mechanism as /model; session-scoped, reverts
  // to the configured `thinking_effort` default on restart.
  { command: "effort", description: "Show or switch the reasoning effort" },
  { command: "doctor", description: "Health check (deps, services, MCP)" },
  { command: "usage", description: "Pro/Max plan quota (5h + 7d windows)" },
  { command: "whoami", description: "This agent's sandbox: tools, MCP, vault key-names" },
  // Vault — secrets + capability grants. /vault is a top-level command
  // dispatching subcommands (list, get, set, delete, status, unlock, lock,
  // grant, grants). Surfaced in the menu so mobile users can tap-to-pick
  // instead of needing to know the verb (PR #221 added the handlers but
  // forgot the menu entry, so /vault was effectively invisible).
  { command: "vault", description: "Manage vault secrets + capability grants" },
  // Auth / subscription management. These are deliberately in the menu
  // rather than only typable — the whole point of the auth surface is
  // that it has to work from mobile without any other tooling
  // ("keep my subscription the only thing I'm paying for" JTBD: "the
  // user can state in one sentence what they're paying for"). A one-tap
  // menu entry for each action is the mobile-native behaviour.
  { command: "auth", description: "Auth dashboard — accounts, quota, reauth, switch primary" },
  // Escape hatch — shows the full catalogue including CLI-only commands
  { command: "commands", description: "Full command list" },
] as const;

/**
 * The three baseCommands split out — gateway.ts and server.ts need
 * to register them under a different scope (private chats only).
 * Provided here for parity; most callers should use the full
 * TELEGRAM_MENU_COMMANDS above which already includes these.
 */
export const TELEGRAM_BASE_COMMANDS = TELEGRAM_MENU_COMMANDS.slice(0, 3);
export const TELEGRAM_SWITCHROOM_COMMANDS = TELEGRAM_MENU_COMMANDS.slice(3);

export function switchroomHelpText(agentName: string): string {
  return stackCardLines([
    `**Switchroom bot** — commands for the **${escapeHtml(agentName)}** agent.`,
    ``,
    `**Session & approvals**`,
    `\`/new\` — fresh session (flush handoff, restart)`,
    `\`/compact\` — compact context (summarize, keep the thread)`,
    `\`/clear\` — clear context (fresh slate; memory in Hindsight)`,
    `\`/private\` — pause saving this session to memory`,
    `\`/public\` — resume saving this session to memory`,
    `\`/approve [id]\` — approve pending tool permission`,
    `\`/deny [id]\` — deny pending tool permission`,
    `\`/pending\` — list pending permission prompts`,
    `\`/interrupt [name]\` — interrupt an agent turn`,
    `\`/stop\` — cancel my in-flight turn (bare "stop" works too)`,
    ``,
    `**Agents**`,
    `\`/agents\` — list all agents`,
    `\`/agentstart [name]\` — start an agent`,
    `\`/agentstop [name]\` — stop an agent's container`,
    `\`/logs [name] [lines]\` — show agent logs`,
    `\`/memory <query>\` — search agent memory`,
    ``,
    `**Fleet management**`,
    `\`/upgradestatus\` — read-only: CLI version, image age, container age per service`,
    `\`/update\` — dry-run plan; \`/update apply\` — actually pull images, reconcile, restart`,
    `\`/restart [name|all]\` — bounce agent (drains in-flight turn by default)`,
    `\`/version\` — show versions + running agent health summary`,
    `\`/whoami\` — this agent's sandbox: tools, MCP, vault key-names, powers`,
    ``,
    `**Auth & config**`,
    `\`/auth\` — auth status or actions`,
    `\`/auth add [agent]\` — add a new account slot (fallback pool)`,
    `\`/auth list [agent]\` — list account slots and health`,
    `\`/auth use [agent] <slot>\` — switch active slot and restart`,
    `\`/auth rm [agent] <slot> [--force]\` — remove a slot`,
    `\`/model\` — show the configured Claude model`,
    `\`/model <name>\` — switch the live session's model (opus · sonnet · haiku or a full id; until restart)`,
    `\`/effort\` — show or switch reasoning effort (low · medium · high · xhigh · max; until restart)`,
    `\`/topics\` — topic-to-agent mappings`,
    `\`/permissions [agent]\` — show agent permissions`,
    `\`/grant <tool>\` — grant a tool permission`,
    `\`/dangerous [off]\` — toggle full tool access`,
    `\`/vault list|get|set|delete\` — manage encrypted secrets`,
    `\`/vault status\` — show broker state (locked/unlocked, uptime, key count)`,
    `\`/vault unlock\` — unlock the broker (prompts for passphrase via Telegram)`,
    `\`/vault lock\` — lock the broker`,
    `\`/vault grants [agent]\` — list active capability grants (tap to revoke)`,
    `\`/doctor\` — health check (deps, services, MCP)`,
    `\`/usage\` — Pro/Max plan quota (5h + 7d windows)`,
    `\`/inject <slash>\` — inject a Claude Code REPL slash command (e.g. \`/inject /cost\`; allowlisted)`,
    `\`/commands\` — this help`,
    ``,
    `_Tip: \`/update\` shows the plan; \`/update apply\` executes it; \`/restart\` bounces a stuck agent; \`/version\` checks what's running._`,
  ]);
}

/**
 * Ack shown when a self-targeting /restart (or /new) kicks off.
 * Centralized so gateway and monolith agree on wording.
 */
export function restartAckText(agentName: string): string {
  return `🔄 Restarting **${escapeHtml(agentName)}**…`;
}

export function newSessionAckText(agentName: string, flushedHandoff: boolean): string {
  const tail = flushedHandoff ? " · flushed handoff" : "";
  return `🆕 Started fresh session for **${escapeHtml(agentName)}**${tail} · restarting…`;
}
