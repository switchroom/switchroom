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

export type SlotHealth = "healthy" | "expired" | "quota-exhausted" | "missing";

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
  slots: DashboardSlot[];
  /** True when at least one slot shows >= 90% utilization on either
   *  window. Toggles the [Fall back now] button's visibility. */
  quotaHot: boolean;
  /** ISO timestamp of the snapshot, shown in the header. */
  generatedAt?: string;
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

export type CallbackAction =
  | { kind: "refresh"; agent: string }
  | { kind: "reauth"; agent: string; slot?: string }
  | { kind: "add"; agent: string }
  | { kind: "use"; agent: string; slot: string }
  | { kind: "rm"; agent: string; slot: string }
  | { kind: "confirm-rm"; agent: string; slot: string }
  | { kind: "fallback"; agent: string }
  | { kind: "usage"; agent: string }
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
    case "noop":
      return `${CALLBACK_PREFIX}noop`;
  }
}

/** Parse the gateway's inbound callback_data into an action. Returns
 *  `{kind: 'noop'}` for anything that doesn't match our shape — the
 *  caller should still answerCallbackQuery() but otherwise drop. */
export function parseCallbackData(data: string): CallbackAction {
  if (!data.startsWith(CALLBACK_PREFIX)) return { kind: "noop" };
  const rest = data.slice(CALLBACK_PREFIX.length);
  const parts = rest.split(":");
  const [verb, agent, slot] = parts;
  if (!isSafeAgentName(agent ?? "")) return { kind: "noop" };
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
  const planLine = state.plan
    ? `Bank: <code>${escapeHtml(state.bankId)}</code> · Plan: <b>${escapeHtml(state.plan)}</b>`
    : `Bank: <code>${escapeHtml(state.bankId)}</code>`;
  lines.push(planLine);
  lines.push("");

  if (state.slots.length === 0) {
    lines.push("<i>No account slots. Tap [➕ Add slot] to attach a subscription.</i>");
    return lines.join("\n");
  }

  for (const slot of state.slots) {
    const marker = slot.active ? "●" : "○";
    const badge = healthBadge(slot.health);
    lines.push(
      `${marker} <code>${escapeHtml(slot.slot)}</code>${slot.active ? " (active)" : ""}  ${badge} ${slot.health}`,
    );
    const detail = slotDetailLine(slot);
    if (detail) lines.push(`  └ ${detail}`);
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━");
  if (state.generatedAt) {
    lines.push(`<i>Updated ${escapeHtml(state.generatedAt)}</i>`);
  }

  return lines.join("\n");
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

export function buildDashboardKeyboard(state: DashboardState): InlineKeyboard {
  const kb = new InlineKeyboard();
  const activeSlot = state.slots.find((s) => s.active);

  // Row 1: primary auth actions. Reauth the active slot; add a new one.
  if (activeSlot) {
    kb.text(`🔄 Reauth ${activeSlot.slot}`, encodeCallbackData({ kind: "reauth", agent: state.agent, slot: activeSlot.slot }));
  } else {
    kb.text("🔄 Reauth", encodeCallbackData({ kind: "reauth", agent: state.agent }));
  }
  kb.text("➕ Add slot", encodeCallbackData({ kind: "add", agent: state.agent }));
  kb.row();

  // Row 2: non-active slots — one "Use" button per, up to 3 to avoid
  // runaway rows. Over 3 slots, user sees an overflow message.
  const nonActiveSlots = state.slots.filter((s) => !s.active).slice(0, 3);
  for (const slot of nonActiveSlots) {
    kb.text(`Use: ${slot.slot}`, encodeCallbackData({ kind: "use", agent: state.agent, slot: slot.slot }));
  }
  if (nonActiveSlots.length > 0) kb.row();

  // Row 3: remove buttons (only for non-active slots; removing the
  // active slot is blocked by auth-slot-parser's checkRemoveSafety).
  const removableSlots = state.slots.filter((s) => !s.active).slice(0, 3);
  for (const slot of removableSlots) {
    kb.text(`🗑 Remove: ${slot.slot}`, encodeCallbackData({ kind: "rm", agent: state.agent, slot: slot.slot }));
  }
  if (removableSlots.length > 0) kb.row();

  // Row 4: quota actions. [Fall back now] only when the dashboard
  // flagged quotaHot; always show [Full quota] as the escape hatch.
  if (state.quotaHot) {
    kb.text("⚠️ Fall back now", encodeCallbackData({ kind: "fallback", agent: state.agent }));
  }
  kb.text("📊 Full quota", encodeCallbackData({ kind: "usage", agent: state.agent }));
  kb.row();

  // Row 5: refresh
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
