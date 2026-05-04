/**
 * `/auth` dashboard — pure logic for the inline-keyboard auth surface.
 *
 * When a user sends `/auth` with no args, the gateway renders a mobile-
 * native dashboard: slot list with health badges, utilization bars,
 * and a button grid for the common actions (reauth, add, use, rm,
 * fallback). Tapping a button fires a `callback_query` with a
 * structured `auth:<action>:<agent>[:<slot>]` payload that the gateway
 * routes back to the matching CLI handler.
 *
 * This module holds only the pure parts — dashboard text generator,
 * keyboard builder, and the callback-data parser. Side effects (CLI
 * execs, Telegram API calls) live in gateway.ts so tests run without
 * a bot process or a live filesystem.
 *
 * JTBD rationale:
 *   - keep-my-subscription-honest: "user can state in one sentence
 *     what they're paying for" — dashboard header lists it in 2 lines
 *     (Plan + bank). "When the user hits a plan limit, the product
 *     says so honestly" — quota badges + [Fall back] button only
 *     visible when hot.
 *   - restart-and-know-what-im-running: "auth state is part of the
 *     picture" — the dashboard IS the auth picture, tappable.
 */

import { InlineKeyboard } from "grammy";

/**
 * Slot-health values emitted by `switchroom auth list --json`.
 *
 * The CLI distinguishes 'active' (the currently-active slot, which is
 * also healthy) from 'healthy' (a non-active slot with a valid token).
 * Dashboard treats both as healthy for the badge — 'active' is already
 * surfaced via the ● marker and the '(active)' label; duplicating it
 * in the health badge would be noisy.
 *
 * Source: src/auth/accounts.ts SlotHealth enum.
 */
export type SlotHealth = "active" | "healthy" | "expired" | "quota-exhausted" | "missing";

export interface DashboardSlot {
  slot: string;
  active: boolean;
  health: SlotHealth;
  /** Epoch ms at which the quota window resets (for quota-exhausted). */
  quotaExhaustedUntil?: number | null;
  /** 5-hour utilization as a percentage 0-100, if known. */
  fiveHourPct?: number | null;
  /** 7-day utilization as a percentage 0-100, if known. */
  sevenDayPct?: number | null;
}

export interface DashboardState {
  agent: string;
  bankId: string;
  plan?: string | null;
  /**
   * Anthropic's `rateLimitTier` from the active slot's credentials
   * — e.g. `default_claude_max_5x` vs `default_claude_max_20x`. The
   * tier is the easiest human-visible signal that "the account I
   * meant to authorize with got authorized". Without this, the
   * dashboard just shows `Plan: max` for both tiers and an account
   * mismatch is silent until the agent hits quota.
   */
  rateLimitTier?: string | null;
  slots: DashboardSlot[];
  /** True when at least one slot shows >= 90% utilization on either
   *  window. Toggles the [Fall back now] button's visibility. */
  quotaHot: boolean;
  /** ISO timestamp of the snapshot, shown in the header. */
  generatedAt?: string;
  /**
   * Slot name of the currently-pending auth session, if any.
   *
   * Populated by the gateway from the agent's
   * `.claude/.setup-token.session.json` when present. When non-null,
   * the dashboard renders a `[♻️ Restart flow]` button so the user
   * can explicitly kill + restart the flow if it's gone sideways
   * (browser took too long, claude setup-token crashed, etc.).
   *
   * Complements the automatic stale-session detection in
   * startAuthSession — catches the cases where the user wants to
   * start over BEFORE the challenge actually drifts.
   */
  pendingSessionSlot?: string | null;
  /**
   * Per-account summaries derived from `switchroom auth account list
   * --json`. Optional: undefined when the gateway can't reach the CLI
   * or the CLI is older than v0.6.x (no --json flag). When present
   * (even as an empty array), the dashboard renders the accounts
   * section. The `enabledHere` flag drives the ✓/○ marker — `agents`
   * field from the JSON, with `agents.includes(state.agent)` mapped
   * into this struct by the gateway.
   */
  accounts?: ReadonlyArray<AccountSummary>;
  /** True when more accounts exist than `ACCOUNTS_DISPLAY_CAP` — the
   *  render appends a noop "more accounts (use CLI)" row. */
  accountsTruncated?: boolean;
  /**
   * True when this agent has slot credentials we could promote into a
   * shared account via `auth share`. Drives the bootstrap "🌐 Share to
   * fleet" button visibility — only useful when no accounts exist yet.
   */
  canBootstrapShare?: boolean;
}

/**
 * Per-account summary for the inline-keyboard dashboard's accounts
 * section. Mirrors the JSON shape `auth account list --json` emits,
 * collapsed to the fields the renderer needs. Pure data — no behaviour.
 */
export type AccountHealth =
  | "healthy"
  | "quota-exhausted"
  | "expired"
  | "missing-credentials"
  | "missing-refresh-token";

export interface AccountSummary {
  readonly label: string;
  readonly health: AccountHealth;
  /** True when this agent appears in the account's `agents` list. */
  readonly enabledHere: boolean;
  readonly subscriptionType?: string;
  readonly expiresAt?: number;
}

/**
 * Thresholds that govern what counts as "quota hot" — the boundary at
 * which we surface the [Fall back now] button without the user asking.
 * Aligned with the auto-fallback poller's trigger point in
 * telegram-plugin/auto-fallback.ts (DEFAULT_TRIGGER_UTILIZATION_PCT
 * = 99.5) but relaxed a little for the "you might want to act" UX
 * affordance on the dashboard — the button appearing at 90% gives the
 * user agency before the automatic fallback takes over.
 */
export const QUOTA_HOT_THRESHOLD_PCT = 90;

/** Max account rows rendered inline. Beyond this, the dashboard adds a
 *  truncated-noop row pointing the user to the CLI for the rest. Five
 *  is enough for typical fleets without overflowing a mobile screen. */
export const ACCOUNTS_DISPLAY_CAP = 5;

/** Telegram caps callback_data at 64 bytes. Render-time guard rejects
 *  encoded payloads beyond this and renders a noop fallback button. */
export const CALLBACK_BUDGET_BYTES = 64;

export type CallbackAction =
  | { kind: "refresh"; agent: string }
  | { kind: "reauth"; agent: string; slot?: string }
  | { kind: "add"; agent: string }
  | { kind: "use"; agent: string; slot: string }
  | { kind: "rm"; agent: string; slot: string }
  | { kind: "confirm-rm"; agent: string; slot: string }
  | { kind: "fallback"; agent: string }
  | { kind: "usage"; agent: string }
  | { kind: "restart-flow"; agent: string; slot: string }
  // Account-level (#per-agent-cards / #share-auth-across-the-fleet).
  // Single-character verbs (ae/ad/cae/cad/sf) maximise label headroom
  // inside the 64-byte callback_data cap.
  | { kind: "account-enable"; agent: string; label: string }
  | { kind: "account-disable"; agent: string; label: string }
  | { kind: "confirm-account-enable"; agent: string; label: string }
  | { kind: "confirm-account-disable"; agent: string; label: string }
  | { kind: "share-fleet"; agent: string }
  // v3a: per-account drill-down sub-view (accounts-first redesign).
  // Short verbs (av/arm/armc/ara) preserve label headroom in 64-byte cap.
  | { kind: "account-view"; agent: string; label: string }
  | { kind: "account-rm"; agent: string; label: string }
  | { kind: "account-rm-confirm"; agent: string; label: string }
  | { kind: "account-reauth"; agent: string; label: string }
  | { kind: "noop" };

const CALLBACK_PREFIX = "auth:";

/** Encode an action into the <=64-byte callback_data string Telegram
 *  allows. Keep the shape `auth:<verb>:<agent>[:<slot>]` — single-level
 *  parser, no JSON, no escaping headaches. */
export function encodeCallbackData(action: CallbackAction): string {
  switch (action.kind) {
    case "refresh":
      return `${CALLBACK_PREFIX}refresh:${action.agent}`;
    case "reauth":
      return action.slot
        ? `${CALLBACK_PREFIX}reauth:${action.agent}:${action.slot}`
        : `${CALLBACK_PREFIX}reauth:${action.agent}`;
    case "add":
      return `${CALLBACK_PREFIX}add:${action.agent}`;
    case "use":
      return `${CALLBACK_PREFIX}use:${action.agent}:${action.slot}`;
    case "rm":
      return `${CALLBACK_PREFIX}rm:${action.agent}:${action.slot}`;
    case "confirm-rm":
      return `${CALLBACK_PREFIX}confirm-rm:${action.agent}:${action.slot}`;
    case "fallback":
      return `${CALLBACK_PREFIX}fallback:${action.agent}`;
    case "usage":
      return `${CALLBACK_PREFIX}usage:${action.agent}`;
    case "restart-flow":
      return `${CALLBACK_PREFIX}restart-flow:${action.agent}:${action.slot}`;
    case "account-enable":
      return `${CALLBACK_PREFIX}ae:${action.agent}:${action.label}`;
    case "account-disable":
      return `${CALLBACK_PREFIX}ad:${action.agent}:${action.label}`;
    case "confirm-account-enable":
      return `${CALLBACK_PREFIX}cae:${action.agent}:${action.label}`;
    case "confirm-account-disable":
      return `${CALLBACK_PREFIX}cad:${action.agent}:${action.label}`;
    case "share-fleet":
      return `${CALLBACK_PREFIX}sf:${action.agent}`;
    case "account-view":
      return `${CALLBACK_PREFIX}av:${action.agent}:${action.label}`;
    case "account-rm":
      return `${CALLBACK_PREFIX}arm:${action.agent}:${action.label}`;
    case "account-rm-confirm":
      return `${CALLBACK_PREFIX}armc:${action.agent}:${action.label}`;
    case "account-reauth":
      return `${CALLBACK_PREFIX}ara:${action.agent}:${action.label}`;
    case "noop":
      return `${CALLBACK_PREFIX}noop`;
  }
}

/** Parse the gateway's inbound callback_data into an action. Returns
 *  `{kind: 'noop'}` for anything that doesn't match our shape — the
 *  caller should still answerCallbackQuery() but otherwise drop. */
export function parseCallbackData(data: string): CallbackAction {
  if (!data.startsWith(CALLBACK_PREFIX)) return { kind: "noop" };
  // Reject payloads beyond Telegram's 64-byte cap. Telegram itself
  // refuses to deliver those, but the parser stays defensive in case
  // a test or fuzzer hands us one.
  if (Buffer.byteLength(data, "utf8") > CALLBACK_BUDGET_BYTES) {
    return { kind: "noop" };
  }
  const rest = data.slice(CALLBACK_PREFIX.length);
  const parts = rest.split(":");
  const [verb, agent, third] = parts;
  // Account-level verbs (single-char) accept a label as the third
  // segment instead of a slot. We branch on verb first so each segment
  // is validated against its own regex.
  if (verb === "ae" || verb === "ad" || verb === "cae" || verb === "cad" ||
      verb === "av" || verb === "arm" || verb === "armc" || verb === "ara") {
    if (!isSafeAgentName(agent ?? "")) return { kind: "noop" };
    if (!third || !isSafeAccountLabel(third)) return { kind: "noop" };
    const label = third;
    if (verb === "ae") return { kind: "account-enable", agent, label };
    if (verb === "ad") return { kind: "account-disable", agent, label };
    if (verb === "cae") return { kind: "confirm-account-enable", agent, label };
    if (verb === "cad") return { kind: "confirm-account-disable", agent, label };
    if (verb === "av") return { kind: "account-view", agent, label };
    if (verb === "arm") return { kind: "account-rm", agent, label };
    if (verb === "armc") return { kind: "account-rm-confirm", agent, label };
    // verb === "ara"
    return { kind: "account-reauth", agent, label };
  }
  if (verb === "sf") {
    if (!isSafeAgentName(agent ?? "")) return { kind: "noop" };
    return { kind: "share-fleet", agent };
  }
  if (!isSafeAgentName(agent ?? "")) return { kind: "noop" };
  const slot = third;
  switch (verb) {
    case "refresh":
      return { kind: "refresh", agent };
    case "reauth":
      return slot && isSafeSlotName(slot)
        ? { kind: "reauth", agent, slot }
        : { kind: "reauth", agent };
    case "add":
      return { kind: "add", agent };
    case "use":
      if (!slot || !isSafeSlotName(slot)) return { kind: "noop" };
      return { kind: "use", agent, slot };
    case "rm":
      if (!slot || !isSafeSlotName(slot)) return { kind: "noop" };
      return { kind: "rm", agent, slot };
    case "confirm-rm":
      if (!slot || !isSafeSlotName(slot)) return { kind: "noop" };
      return { kind: "confirm-rm", agent, slot };
    case "fallback":
      return { kind: "fallback", agent };
    case "usage":
      return { kind: "usage", agent };
    case "restart-flow":
      if (!slot || !isSafeSlotName(slot)) return { kind: "noop" };
      return { kind: "restart-flow", agent, slot };
    default:
      return { kind: "noop" };
  }
}

function isSafeAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

function isSafeSlotName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

/**
 * Account labels match the CLI's `validateAccountLabel` regex
 * (`src/auth/account-store.ts`): `[A-Za-z0-9._-]{1,64}`. The `.` is
 * the only delta from `isSafeSlotName` and is what makes labels like
 * `acme.team` legal. Dashboard-side validator so the parser doesn't
 * need to import from `src/`.
 *
 * The `.` and `..` reservations match the CLI's defensive guards
 * — those tokens are valid characters but are reserved as filesystem
 * lookalikes and would create ambiguous on-disk paths under
 * `~/.switchroom/accounts/`.
 */
export function isSafeAccountLabel(name: string): boolean {
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

/**
 * Build the dashboard message text + inline keyboard. Pure — no side
 * effects. The gateway sends the result via ctx.reply or editMessageText.
 */
export function buildDashboard(state: DashboardState): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text: buildDashboardText(state),
    keyboard: buildDashboardKeyboard(state),
  };
}

export function buildDashboardText(state: DashboardState): string {
  const lines: string[] = [];
  lines.push(`━━━ <b>Auth • ${escapeHtml(state.agent)}</b> ━━━`);
  // Show the full rate-limit tier when we have it — e.g. 'max_5x' vs
  // 'max_20x' lets the user tell at a glance whether the correct
  // Anthropic account got authorized during reauth. Otherwise fall
  // back to the plain plan name.
  const tierLabel = state.rateLimitTier
    ? formatRateLimitTier(state.rateLimitTier)
    : state.plan
    ? state.plan
    : null;
  const planLine = tierLabel
    ? `Bank: <code>${escapeHtml(state.bankId)}</code> · Plan: <b>${escapeHtml(tierLabel)}</b>`
    : `Bank: <code>${escapeHtml(state.bankId)}</code>`;
  lines.push(planLine);
  lines.push("");

  // v3a: accounts appear above slots — accounts are first-class, slots
  // are an implementation detail of how credentials attach to a process.
  if (state.accounts != null && state.accounts.length > 0) {
    lines.push(`<b>Anthropic accounts (${state.accounts.length})</b>`);
    const visible = state.accounts.slice(0, ACCOUNTS_DISPLAY_CAP);
    for (const acc of visible) {
      const badge = accountHealthBadge(acc.health);
      const suffix = healthSuffix(acc.health);
      lines.push(`  • <code>${escapeHtml(acc.label)}</code>  ${badge}${suffix}`);
    }
    if (state.accountsTruncated) {
      lines.push(`  … ${state.accounts.length - ACCOUNTS_DISPLAY_CAP} more (use CLI)`);
    }
    lines.push("");
  }

  if (state.slots.length === 0) {
    lines.push("<i>No account slots. Tap [➕ Add slot] to attach a subscription.</i>");
  } else {
    lines.push(`<b>Slots (${state.slots.length})</b>`);
    for (const slot of state.slots) {
      const marker = slot.active ? "●" : "○";
      const badge = healthBadge(slot.health);
      const label = healthLabel(slot.health);
      lines.push(
        `  ${marker} <code>${escapeHtml(slot.slot)}</code>${slot.active ? " (active)" : ""}  ${badge} ${label}`,
      );
      const detail = slotDetailLine(slot);
      if (detail) lines.push(`    └ ${detail}`);
    }
  }

  // Pool / fallback summary — show when accounts exist, so the user
  // understands how slots and accounts relate.
  if (state.accounts != null && state.accounts.length > 0 && state.slots.length > 0) {
    const activeSlot = state.slots.find((s) => s.active);
    if (activeSlot) {
      lines.push(`  Pool: slot <code>${escapeHtml(activeSlot.slot)}</code> is active`);
    }
  }

  lines.push("");
  if (state.pendingSessionSlot) {
    lines.push(
      `<i>⏳ Auth flow pending for slot <code>${escapeHtml(state.pendingSessionSlot)}</code>. If it's stuck, tap ♻️ below to restart.</i>`,
    );
  }
  lines.push("━━━━━━━━━━━━━━━━━━━");
  if (state.generatedAt) {
    lines.push(`<i>Updated ${escapeHtml(state.generatedAt)}</i>`);
  }

  return lines.join("\n");
}

/** Health badge for an account (not a slot). */
function accountHealthBadge(health: AccountHealth): string {
  switch (health) {
    case "healthy":
      return "✓";
    case "quota-exhausted":
      return "⚠️";
    case "expired":
    case "missing-refresh-token":
      return "⌛";
    case "missing-credentials":
      return "✗";
  }
}

function slotDetailLine(slot: DashboardSlot): string | null {
  const bits: string[] = [];
  if (slot.fiveHourPct != null) bits.push(`5h: ${Math.round(slot.fiveHourPct)}%`);
  if (slot.sevenDayPct != null) bits.push(`7d: ${Math.round(slot.sevenDayPct)}%`);
  if (slot.health === "quota-exhausted" && slot.quotaExhaustedUntil) {
    const mins = Math.max(0, Math.round((slot.quotaExhaustedUntil - Date.now()) / 60_000));
    bits.push(`resets in ~${mins}m`);
  } else if (slot.health === "expired") {
    bits.push("run reauth");
  }
  return bits.length > 0 ? bits.join(" · ") : null;
}

function healthBadge(health: SlotHealth): string {
  switch (health) {
    case "active":
    case "healthy":
      return "✓";
    case "quota-exhausted":
      return "⚠️";
    case "expired":
      return "⌛";
    case "missing":
      return "✗";
  }
}

/**
 * Human-readable label for a slot's health. 'active' collapses to
 * 'healthy' — the ● + '(active)' markers already carry the active-slot
 * signal; rendering 'active active' is redundant.
 */
function healthLabel(health: SlotHealth): string {
  return health === "active" ? "healthy" : health;
}

export function buildDashboardKeyboard(state: DashboardState): InlineKeyboard {
  const kb = new InlineKeyboard();
  const activeSlot = state.slots.find((s) => s.active);

  // v3a: Row 1+ — account rows. Each account is a tappable button that
  // drills into the per-account sub-view. No inline ✓/○ toggles on the
  // main board — the toggles are an implementation detail; the sub-view
  // surface is the right place for per-account actions.
  if (state.accounts != null && state.accounts.length > 0) {
    const visible = state.accounts.slice(0, ACCOUNTS_DISPLAY_CAP);
    for (const acc of visible) {
      const action: CallbackAction = { kind: "account-view", agent: state.agent, label: acc.label };
      const encoded = encodeCallbackData(action);
      // Render-time guard: if the synthesised payload exceeds the
      // 64-byte cap (pathological agent + label lengths), fall back
      // to a noop button labelled with the raw account name so the
      // row is visible-but-inert. Operator can fall back to the CLI.
      if (Buffer.byteLength(encoded, "utf8") > CALLBACK_BUDGET_BYTES) {
        kb.text(
          `⚠ ${truncateLabel(acc.label)} (use CLI)`,
          encodeCallbackData({ kind: "noop" }),
        );
      } else {
        kb.text(`${acc.label}${healthSuffix(acc.health)}`, encoded);
      }
      kb.row();
    }
    if (state.accountsTruncated) {
      kb.text(
        `… ${state.accounts.length - ACCOUNTS_DISPLAY_CAP} more (use CLI)`,
        encodeCallbackData({ kind: "noop" }),
      );
      kb.row();
    }
  } else if (state.accounts != null && state.accounts.length === 0 && state.canBootstrapShare) {
    // Bootstrap one-tap: zero accounts exist, but this agent has
    // healthy slot creds we could promote. Synthesises label="default"
    // at the gateway so the user gets a reasonable starting state in
    // one tap; rename via CLI later if "default" doesn't suit.
    kb.text(
      "🌐 Share to fleet",
      encodeCallbackData({ kind: "share-fleet", agent: state.agent }),
    );
    kb.row();
  }

  // Slot rows — existing Reauth/Add/Use/Remove behavior, unchanged.
  // Slots are still real and operators still need to manage them;
  // they're just demoted below accounts in the v3a layout.

  // Slot row A: primary auth actions. Reauth the active slot; add a new one.
  if (activeSlot) {
    kb.text(`🔄 Reauth ${activeSlot.slot}`, encodeCallbackData({ kind: "reauth", agent: state.agent, slot: activeSlot.slot }));
  } else {
    kb.text("🔄 Reauth", encodeCallbackData({ kind: "reauth", agent: state.agent }));
  }
  kb.text("➕ Add slot", encodeCallbackData({ kind: "add", agent: state.agent }));
  kb.row();

  // Slot row B: non-active slots — one "Use" button per, up to 3 to
  // avoid runaway rows. Over 3 slots, user sees an overflow message.
  const nonActiveSlots = state.slots.filter((s) => !s.active).slice(0, 3);
  for (const slot of nonActiveSlots) {
    kb.text(`Use: ${slot.slot}`, encodeCallbackData({ kind: "use", agent: state.agent, slot: slot.slot }));
  }
  if (nonActiveSlots.length > 0) kb.row();

  // Slot row C: remove buttons (only for non-active slots; removing the
  // active slot is blocked by auth-slot-parser's checkRemoveSafety).
  const removableSlots = state.slots.filter((s) => !s.active).slice(0, 3);
  for (const slot of removableSlots) {
    kb.text(`🗑 Remove: ${slot.slot}`, encodeCallbackData({ kind: "rm", agent: state.agent, slot: slot.slot }));
  }
  if (removableSlots.length > 0) kb.row();

  // Pending-flow recovery. Shown ONLY when an auth flow is
  // pending (session meta file on disk). Lets the user explicitly
  // kill + restart the flow.
  if (state.pendingSessionSlot) {
    kb.text(
      `♻️ Restart ${state.pendingSessionSlot} flow`,
      encodeCallbackData({ kind: "restart-flow", agent: state.agent, slot: state.pendingSessionSlot }),
    );
    kb.row();
  }

  // Quota row. [Fall back now] only when the dashboard flagged
  // quotaHot; always show [Full quota] as the escape hatch.
  if (state.quotaHot) {
    kb.text("⚠️ Fall back now", encodeCallbackData({ kind: "fallback", agent: state.agent }));
  }
  kb.text("📊 Full quota", encodeCallbackData({ kind: "usage", agent: state.agent }));
  kb.row();

  // Refresh
  kb.text("🔁 Refresh", encodeCallbackData({ kind: "refresh", agent: state.agent }));

  return kb;
}

/** Derive the `quotaHot` flag from a slot set. Used by the gateway
 *  at dashboard-build time and by tests. */
export function isQuotaHot(slots: DashboardSlot[]): boolean {
  for (const s of slots) {
    if (s.health === "quota-exhausted") return true;
    if ((s.fiveHourPct ?? 0) >= QUOTA_HOT_THRESHOLD_PCT) return true;
    if ((s.sevenDayPct ?? 0) >= QUOTA_HOT_THRESHOLD_PCT) return true;
  }
  return false;
}

/**
 * Shorten Anthropic's verbose tier strings into something readable in a
 * one-line dashboard header.
 *
 *   default_claude_max_5x   → max_5x
 *   default_claude_max_20x  → max_20x
 *   default_claude_pro      → pro
 *   anything else           → passthrough (we don't pretend to
 *                             understand every future tier string)
 */
export function formatRateLimitTier(tier: string): string {
  if (!tier) return tier;
  return tier.replace(/^default_claude_/, "");
}

/** Tiny HTML escaper — same shape as welcome-text.ts's escapeHtml so
 *  this module stays dependency-free. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the confirmation keyboard shown when the user taps Remove.
 *  Two-step confirm prevents accidental slot deletion on mobile. */
export function buildRemoveConfirmKeyboard(agent: string, slot: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(`⚠️ Confirm remove: ${slot}`, encodeCallbackData({ kind: "confirm-rm", agent, slot }))
    .row()
    .text("↩️ Cancel", encodeCallbackData({ kind: "refresh", agent }));
}

/**
 * Two-stage confirmation for account toggles. Mirrors
 * `buildRemoveConfirmKeyboard`'s shape — one confirm row + a cancel
 * that re-renders the dashboard. `kind` selects enable vs disable so
 * one helper covers both directions.
 */
export function buildAccountConfirmKeyboard(
  agent: string,
  label: string,
  kind: "enable" | "disable",
): InlineKeyboard {
  const action: CallbackAction = kind === "enable"
    ? { kind: "confirm-account-enable", agent, label }
    : { kind: "confirm-account-disable", agent, label };
  const verb = kind === "enable" ? "enable" : "disable";
  return new InlineKeyboard()
    .text(`⚠️ Confirm ${verb}: ${label}`, encodeCallbackData(action))
    .row()
    .text("↩️ Cancel", encodeCallbackData({ kind: "refresh", agent }));
}

/**
 * Health affix for the account button label. Keeps healthy accounts
 * unadorned (the ✓/○ marker carries the enabled-here signal) and
 * surfaces the failure modes that need operator attention. Quota and
 * expiry use distinct icons so the user can tell which boundary the
 * account hit.
 */
function healthSuffix(health: AccountHealth): string {
  switch (health) {
    case "quota-exhausted":
      return " ⚠️";
    case "expired":
    case "missing-refresh-token":
      return " ⌛";
    case "missing-credentials":
      return " ❌";
    case "healthy":
    default:
      return "";
  }
}

/** Trim long labels in the noop fallback button so the row stays
 *  readable on a narrow mobile screen. */
function truncateLabel(label: string): string {
  if (label.length <= 32) return label;
  return label.slice(0, 31) + "…";
}

// ─── v3a: Per-account sub-view ────────────────────────────────────────────

/**
 * Build the per-account drill-down sub-view text. Shown when the user
 * taps an account row on the main dashboard.
 */
export function buildAccountSubViewText(agent: string, acc: AccountSummary): string {
  const lines: string[] = [];
  lines.push(`━━━ <b>Account • ${escapeHtml(acc.label)}</b> ━━━`);
  lines.push(`Agent: <code>${escapeHtml(agent)}</code>`);
  const badge = accountHealthBadge(acc.health);
  const suffix = healthSuffix(acc.health);
  lines.push(`Health: ${badge} ${acc.health}${suffix}`);
  if (acc.subscriptionType) {
    lines.push(`Type: <b>${escapeHtml(acc.subscriptionType)}</b>`);
  }
  if (acc.expiresAt) {
    const expiresDate = new Date(acc.expiresAt).toISOString().slice(0, 10);
    lines.push(`Expires: <code>${escapeHtml(expiresDate)}</code>`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

/**
 * Build the per-account drill-down keyboard.
 *
 * Reauth is visible-but-inert in v3a — no `auth account reauth` CLI
 * verb exists yet. The button is surfaced so the layout is complete;
 * the gateway handler returns a toast noting it'll land in v3b.
 */
export function buildAccountSubViewKeyboard(agent: string, label: string): InlineKeyboard {
  const reauthAction: CallbackAction = { kind: "account-reauth", agent, label };
  const rmAction: CallbackAction = { kind: "account-rm", agent, label };
  const reauthEncoded = encodeCallbackData(reauthAction);
  const rmEncoded = encodeCallbackData(rmAction);
  const kb = new InlineKeyboard();
  // Reauth — inert in v3a (no CLI verb). Still wired so the layout is
  // complete; the gateway emits a "coming in v3b" toast.
  if (Buffer.byteLength(reauthEncoded, "utf8") <= CALLBACK_BUDGET_BYTES) {
    kb.text("🔁 Reauth", reauthEncoded);
  } else {
    kb.text("🔁 Reauth (use CLI)", encodeCallbackData({ kind: "noop" }));
  }
  kb.row();
  // Remove — triggers confirm sub-view.
  if (Buffer.byteLength(rmEncoded, "utf8") <= CALLBACK_BUDGET_BYTES) {
    kb.text("🗑 Remove", rmEncoded);
  } else {
    kb.text("🗑 Remove (use CLI)", encodeCallbackData({ kind: "noop" }));
  }
  kb.row();
  // Back to main dashboard.
  kb.text("← Accounts", encodeCallbackData({ kind: "refresh", agent }));
  return kb;
}

/**
 * Build the remove-confirm sub-view for a per-account removal.
 * Ports the slot-remove confirm pattern.
 */
export function buildAccountRemoveConfirmKeyboard(agent: string, label: string): InlineKeyboard {
  const confirmAction: CallbackAction = { kind: "account-rm-confirm", agent, label };
  const confirmEncoded = encodeCallbackData(confirmAction);
  return new InlineKeyboard()
    .text(
      `✓ Yes, remove`,
      Buffer.byteLength(confirmEncoded, "utf8") <= CALLBACK_BUDGET_BYTES
        ? confirmEncoded
        : encodeCallbackData({ kind: "noop" }),
    )
    .text(
      "✗ Cancel",
      encodeCallbackData({ kind: "account-view", agent, label }),
    );
}
