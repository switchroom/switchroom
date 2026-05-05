/**
 * Pure text generators for the bot's welcome / help / status surfaces.
 *
 * Extracted from gateway.ts and server.ts so the wording is:
 *   1. single-sourced (no drift between gateway mode and monolith mode)
 *   2. unit-testable without needing a grammy Context
 *
 * All functions return HTML-safe strings with <b>/<i>/<code> markup ready
 * for Telegram's parse_mode=HTML. The <code>…</code> wrapper is deliberate
 * for things like command names and agent identifiers, which render as
 * monospace inline and avoid Telegram treating them as markdown.
 */

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

export type AgentMetadata = {
  agentName: string;
  model: string | null;
  extendsProfile: string | null;
  topicName: string | null;
  topicEmoji: string | null;
  uptime: string | null;
  status: string | null;
  auth: AuthSummary | null;
  /** Live audit details — present only when switchroom.yaml loaded cleanly. */
  audit?: AgentAudit;
};

// Tiny escaper — duplicates the one in gateway.ts / server.ts so this
// module stays dependency-free and easy to test.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  return `<b>${escapeHtml(meta.agentName)}</b> · model: <code>${escapeHtml(m)}</code>${topic}`;
}

/**
 * Welcome text for `/start`. Called when the user DMs a fresh bot.
 * We deliberately name Switchroom (not "Claude Code") to match product
 * reality — the bot is one persona out of a fleet on your subscription.
 */
export function startText(agentName: string, dmDisabled: boolean): string {
  if (dmDisabled) return "This bot isn't accepting new connections.";
  return [
    `<b>Switchroom</b> — Telegram on your Claude Pro or Max subscription.`,
    ``,
    `This bot is the <b>${escapeHtml(agentName)}</b> agent. Pair first, then send messages here and they reach the agent; replies and reactions come back.`,
    ``,
    `<b>To pair:</b>`,
    `1. DM me anything — you'll get a 6-char code`,
    `2. In Claude Code: <code>/telegram:access pair &lt;code&gt;</code>`,
    ``,
    `After pairing, try <code>/status</code> or <code>/commands</code>.`,
  ].join("\n");
}

/**
 * Concise help — points at /commands for the full catalogue.
 * Deliberately short because Telegram truncates /help popovers.
 */
export function helpText(agentName: string): string {
  return [
    `<b>Switchroom</b> — your Pro/Max subscription, wired to Telegram.`,
    ``,
    `This bot is the <b>${escapeHtml(agentName)}</b> agent. Text and photos route through to it; replies, reactions and progress cards come back.`,
    ``,
    `Tool approvals surface as inline buttons (✅ / ❌) or via <code>/approve</code>, <code>/deny</code>, <code>/pending</code>. Start a fresh session with <code>/new</code> or <code>/reset</code>.`,
    ``,
    `<code>/start</code> — pairing instructions`,
    `<code>/status</code> — agent, model, auth`,
    `<code>/commands</code> — full command list`,
  ].join("\n");
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
export function statusPairedText(params: {
  user: string;
  meta: AgentMetadata;
}): string {
  const { user, meta } = params;
  const lines = [
    `Paired as ${escapeHtml(user)}.`,
    ``,
    `Agent: ${formatAgentLine(meta)}`,
    `Auth: ${formatAuthLine(meta.auth)}`,
  ];
  if (meta.status) lines.push(`Status: <code>${escapeHtml(meta.status)}</code>${meta.uptime ? ` · up ${escapeHtml(meta.uptime)}` : ""}`);

  const audit = meta.audit;
  if (audit) {
    // Blank separator before the audit block so the reply reads as two
    // sections: live state up top, config audit below.
    lines.push("");
    if (audit.version) lines.push(`<b>Version</b> ${escapeHtml(audit.version)}`);
    if (meta.extendsProfile) lines.push(`<b>Profile</b> ${escapeHtml(meta.extendsProfile)}`);
    if (audit.tools) lines.push(`<b>Tools</b> ${escapeHtml(audit.tools)}`);
    if (audit.toolsDeny) lines.push(`<b>Deny</b> ${escapeHtml(audit.toolsDeny)}`);
    if (audit.skills) lines.push(`<b>Skills</b> ${escapeHtml(audit.skills)}`);
    if (audit.limits) lines.push(`<b>Limits</b> ${escapeHtml(audit.limits)}`);
    if (audit.channel) lines.push(`<b>Channel</b> ${escapeHtml(audit.channel)}`);
    if (audit.memoryBank) lines.push(`<b>Memory</b> ${escapeHtml(audit.memoryBank)}`);
  }

  return lines.join("\n");
}

/**
 * `/status` when the sender isn't paired yet but has a pending code.
 */
export function statusPendingText(code: string): string {
  return `Pending pairing — run in Claude Code:\n\n<code>/telegram:access pair ${escapeHtml(code)}</code>`;
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
  "new", "reset", "approve", "deny", "pending", "interrupt",
  // Agents
  "agents", "agentstart", "stop", "restart", "logs", "memory",
  // Auth & config. /authfallback was removed in v0.6.12 — the
  // dashboard's Switch primary picker is the only operator-facing
  // surface; the auto-fallback poller still handles the
  // automatic-on-quota-wall case transparently.
  "auth", "reauth",
  "topics", "update", "version",
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
  { command: "reset", description: "Alias of /new" },
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
  { command: "doctor", description: "Health check (deps, services, MCP)" },
  { command: "usage", description: "Pro/Max plan quota (5h + 7d windows)" },
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
  { command: "auth", description: "Auth status (add/list/use/rm/reauth/code)" },
  { command: "reauth", description: "Re-auth Claude for this agent" },
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
  return [
    `<b>Switchroom bot</b> — commands for the <b>${escapeHtml(agentName)}</b> agent.`,
    ``,
    `<b>Session &amp; approvals</b>`,
    `<code>/new</code> — fresh session (flush handoff, restart)`,
    `<code>/reset</code> — alias of /new`,
    `<code>/approve [id]</code> — approve pending tool permission`,
    `<code>/deny [id]</code> — deny pending tool permission`,
    `<code>/pending</code> — list pending permission prompts`,
    `<code>/interrupt [name]</code> — interrupt an agent turn`,
    ``,
    `<b>Agents</b>`,
    `<code>/agents</code> — list all agents`,
    `<code>/agentstart [name]</code> — start an agent`,
    `<code>/stop [name]</code> — stop an agent`,
    `<code>/logs [name] [lines]</code> — show agent logs`,
    `<code>/memory &lt;query&gt;</code> — search agent memory`,
    ``,
    `<b>Fleet management</b>`,
    `<code>/update</code> — pull latest code, reconcile, restart everything`,
    `<code>/restart [name|all]</code> — bounce agent (drains in-flight turn by default)`,
    `<code>/version</code> — show versions + running agent health summary`,
    ``,
    `<b>Auth &amp; config</b>`,
    `<code>/auth</code> — auth status or actions`,
    `<code>/auth add [agent]</code> — add a new account slot (fallback pool)`,
    `<code>/auth list [agent]</code> — list account slots and health`,
    `<code>/auth use [agent] &lt;slot&gt;</code> — switch active slot and restart`,
    `<code>/auth rm [agent] &lt;slot&gt; [--force]</code> — remove a slot`,
    `<code>/reauth [agent]</code> — start Claude browser auth`,
    `<code>/topics</code> — topic-to-agent mappings`,
    `<code>/permissions [agent]</code> — show agent permissions`,
    `<code>/grant &lt;tool&gt;</code> — grant a tool permission`,
    `<code>/dangerous [off]</code> — toggle full tool access`,
    `<code>/vault list|get|set|delete</code> — manage encrypted secrets`,
    `<code>/vault status</code> — show broker state (locked/unlocked, uptime, key count)`,
    `<code>/vault unlock</code> — unlock the broker (prompts for passphrase via Telegram)`,
    `<code>/vault lock</code> — lock the broker`,
    `<code>/vault grants [agent]</code> — list active capability grants (tap to revoke)`,
    `<code>/doctor</code> — health check (deps, services, MCP)`,
    `<code>/usage</code> — Pro/Max plan quota (5h + 7d windows)`,
    `<code>/commands</code> — this help`,
    ``,
    `<i>Tip: <code>/update</code> picks up new code; <code>/restart</code> bounces a stuck agent; <code>/version</code> checks what's running.</i>`,
  ].join("\n");
}

/**
 * Ack shown when a self-targeting /restart (or /new, /reset) kicks off.
 * Centralized so gateway and monolith agree on wording.
 */
export function restartAckText(agentName: string): string {
  return `🔄 Restarting <b>${escapeHtml(agentName)}</b>…`;
}

export function newSessionAckText(agentName: string, flushedHandoff: boolean): string {
  const tail = flushedHandoff ? " · flushed handoff" : "";
  return `🆕 Started fresh session for <b>${escapeHtml(agentName)}</b>${tail} · restarting…`;
}

export function resetSessionAckText(agentName: string, flushedHandoff: boolean): string {
  const tail = flushedHandoff ? " · flushed handoff" : "";
  return `🔄 Reset session for <b>${escapeHtml(agentName)}</b>${tail} · restarting…`;
}
