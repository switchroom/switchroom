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
  /**
   * Per-account 5h-window utilization, 0–100. Populated by the
   * gateway's account-level quota probe — mirrored from the
   * `anthropic-ratelimit-unified-5h-utilization` header on the
   * Anthropic API response. Undefined means "not probed yet" (the
   * dashboard renders a placeholder rather than 0%).
   */
  readonly fiveHourPct?: number;
  /**
   * Per-account 7d-window utilization. Same source as
   * {@link fiveHourPct} — `anthropic-ratelimit-unified-7d-utilization`.
   */
  readonly sevenDayPct?: number;
  /** Unix ms when the 5h cap resets, when known. */
  readonly fiveHourResetAt?: number;
  /** Unix ms when the 7d cap resets, when known. */
  readonly sevenDayResetAt?: number;
  /**
   * Unix ms when the account is expected to come back from a
   * quota-exhausted state. Populated when the cached probe says the
   * account is exhausted (server-side `quota-exhausted` or local
   * 5h utilization == 100%). Render shows "exhausted · resets in
   * Nh Mm" rather than the percentage row.
   */
  readonly quotaExhaustedUntil?: number;
  /**
   * True when this account sits at index 0 of THIS agent's
   * `auth.accounts:` list — i.e. it's the post-fanout active for this
   * agent. Drives the `▶` glyph + "Active" framing in the dashboard
   * render and suppresses the per-account `⤴ Promote` button (you
   * can't promote what's already primary).
   *
   * Populated by the gateway from the new `primaryForAgents` field on
   * `auth account list --json` (added v0.6.9). Optional: undefined
   * means "old CLI without the field" — render falls back to the
   * pre-v3 unmarked layout.
   */
  readonly activeForThisAgent?: boolean;
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
  // v3b: in-place promote — moves a fallback to primary without leaving
  // the dashboard. Two-stage confirm mirrors enable/disable. Verbs `apr`
  // / `cpr` are 3 chars max so a 40-char agent + 64-char label still
  // fits the 64-byte callback_data cap (auth:cpr:agent:label = 12 +
  // agent + label ≤ 64).
  | { kind: "account-promote"; agent: string; label: string }
  | { kind: "confirm-account-promote"; agent: string; label: string }
  // v3c: switch-primary picker. Replaces the per-fallback `⤴ Promote`
  // buttons that flooded the main board with a single `🔀 Switch
  // primary →` button. Tapping it edits the keyboard in-place to a
  // picker view (one row per fallback → tap → confirm-account-promote).
  // Cancel returns to the main dashboard via a refresh.
  | { kind: "switch-primary-view"; agent: string }
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
    case "account-promote":
      return `${CALLBACK_PREFIX}apr:${action.agent}:${action.label}`;
    case "confirm-account-promote":
      return `${CALLBACK_PREFIX}cpr:${action.agent}:${action.label}`;
    case "switch-primary-view":
      return `${CALLBACK_PREFIX}spv:${action.agent}`;
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
      verb === "av" || verb === "arm" || verb === "armc" || verb === "ara" ||
      verb === "apr" || verb === "cpr") {
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
    if (verb === "ara") return { kind: "account-reauth", agent, label };
    if (verb === "apr") return { kind: "account-promote", agent, label };
    // verb === "cpr"
    return { kind: "confirm-account-promote", agent, label };
  }
  if (verb === "sf") {
    if (!isSafeAgentName(agent ?? "")) return { kind: "noop" };
    return { kind: "share-fleet", agent };
  }
  if (verb === "spv") {
    if (!isSafeAgentName(agent ?? "")) return { kind: "noop" };
    return { kind: "switch-primary-view", agent };
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
 * (`src/auth/account-store.ts`): `[A-Za-z0-9._@+-]{1,64}`. The label
 * accepts email-shaped strings (`pixsoul@gmail.com`) and gmail-tag
 * forms (`ken+work@example.com`) so operators can label accounts by
 * the Anthropic email they signed up with — the JTBD's "the user
 * manages accounts" works best when the labels read like the
 * identities the user already knows.
 *
 * Dashboard-side validator so the parser doesn't need to import
 * from `src/`. Keep in sync with `LABEL_RE` in account-store.ts and
 * `ACCOUNT_LABEL_RE` in auth-slot-parser.ts.
 *
 * The `.` and `..` reservations match the CLI's defensive guards —
 * those tokens are valid characters but reserved as filesystem
 * lookalikes that would create ambiguous on-disk paths under
 * `~/.switchroom/accounts/`. `:` is omitted on purpose because it
 * would corrupt callback_data parsing in the Telegram dashboard.
 */
export function isSafeAccountLabel(name: string): boolean {
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9._@+-]{1,64}$/.test(name);
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
  // v3b: active account (the one at this agent's auth.accounts[0])
  // floats to the top with a `▶` glyph; remaining rows render under a
  // "Fallback:" subhead in agent-list order. When `activeForThisAgent`
  // is unset on every entry (older CLI without primaryForAgents in
  // --json), we fall back to the v3a layout — bullets only, no header.
  if (state.accounts != null && state.accounts.length > 0) {
    lines.push(`<b>Anthropic accounts (${state.accounts.length})</b>`);
    const visible = state.accounts.slice(0, ACCOUNTS_DISPLAY_CAP);
    const active = visible.find((a) => a.activeForThisAgent === true);
    const fallbacks = visible.filter((a) => a !== active);
    const haveActiveSignal = active != null;
    if (haveActiveSignal && active != null) {
      lines.push(renderActiveAccountRow(active));
    }
    if (fallbacks.length > 0) {
      // Only emit the subhead when there's a distinguished active row;
      // otherwise the list is just "all accounts, no opinion" and a
      // header would be misleading.
      if (haveActiveSignal) lines.push(`  <i>Fallback ↓:</i>`);
      for (const acc of fallbacks) {
        lines.push(renderFallbackAccountRow(acc, haveActiveSignal));
        const quotaLine = formatAccountQuotaLine(acc);
        if (quotaLine) lines.push(`    └ ${quotaLine}`);
      }
    }
    if (state.accountsTruncated) {
      lines.push(`  … ${state.accounts.length - ACCOUNTS_DISPLAY_CAP} more (use CLI)`);
    }
    lines.push("");
  }

  // Slot ID lookup: under the new account model, slot IDs (`default`,
  // etc.) are an internal mount-point identifier — not what the
  // operator authorized. When we know which account is the post-fanout
  // active for THIS agent, the active slot row would render as
  // `● pixsoul@gmail.com (active) ✓ healthy` and the Pool line would
  // say `Pool: pixsoul@gmail.com is active` — both 1:1 duplicates of
  // the ▶ active-account row above. So we hide both sections when an
  // active-account signal is present. Keep them visible only when:
  //   - No accounts data at all (older CLI without --json), OR
  //   - Accounts exist but no entry has activeForThisAgent set (older
  //     CLI without primaryForAgents), OR
  //   - Empty fleet (no accounts) — slots are still the bootstrap
  //     surface for the operator's first reauth/add taps.
  const activeAccountLabel =
    state.accounts?.find((a) => a.activeForThisAgent === true)?.label ?? null;
  const slotsSectionRedundant =
    activeAccountLabel != null &&
    state.accounts != null &&
    state.accounts.length > 0;

  if (!slotsSectionRedundant) {
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
    // understands how slots and accounts relate. Suppressed alongside
    // the slots section when the active-account row already says it.
    if (state.accounts != null && state.accounts.length > 0 && state.slots.length > 0) {
      const activeSlot = state.slots.find((s) => s.active);
      if (activeSlot) {
        lines.push(`  Pool: slot <code>${escapeHtml(activeSlot.slot)}</code> is active`);
      }
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

/**
 * Render the active account row — the post-fanout primary for this
 * agent. Uses the `▶` glyph + bold label + an inline quota summary
 * carrying mini-bars when both percentages are known. Falls back to
 * the plain `formatAccountQuotaLine` text on the next line if quota
 * isn't probed yet — keeps the row honest about uncertainty.
 */
function renderActiveAccountRow(acc: AccountSummary): string {
  const badge = accountHealthBadge(acc.health);
  const suffix = healthSuffix(acc.health);
  const head = `▶ <b><code>${escapeHtml(acc.label)}</code></b>  ${badge}${suffix}`;
  const inline = formatActiveQuotaInline(acc);
  return inline ? `${head}\n    ${inline}` : head;
}

/**
 * Render an indented fallback account row. `haveActiveSignal` controls
 * the bullet vs. tree-prefix character — when there's a distinguished
 * active row above, we use `↳` to imply ordering; without one we fall
 * back to a plain `•` bullet so the layout matches v3a for older CLIs.
 */
function renderFallbackAccountRow(
  acc: AccountSummary,
  haveActiveSignal: boolean,
): string {
  const badge = accountHealthBadge(acc.health);
  const suffix = healthSuffix(acc.health);
  const prefix = haveActiveSignal ? "  ↳" : "  •";
  return `${prefix} <code>${escapeHtml(acc.label)}</code>  ${badge}${suffix}`;
}

/**
 * Inline quota summary for the active row. When BOTH 5h and 7d are
 * known, emit the mini-bar form (`5h ████░░ 47%  ·  7d █░░░░░ 12%`).
 * When the account is exhausted, defer to the existing
 * `formatAccountQuotaLine` (it has the reset-time copy). Otherwise
 * return null and let the caller skip the line.
 */
function formatActiveQuotaInline(acc: AccountSummary): string | null {
  if (acc.quotaExhaustedUntil != null && acc.quotaExhaustedUntil > Date.now()) {
    return formatAccountQuotaLine(acc);
  }
  if (acc.fiveHourPct == null || acc.sevenDayPct == null) {
    return formatAccountQuotaLine(acc);
  }
  const fiveBar = formatQuotaBar(acc.fiveHourPct);
  const sevenBar = formatQuotaBar(acc.sevenDayPct);
  return (
    `<i>5h</i> <code>${fiveBar}</code> ${formatQuotaPct(acc.fiveHourPct)}  ` +
    `·  <i>7d</i> <code>${sevenBar}</code> ${formatQuotaPct(acc.sevenDayPct)}`
  );
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

  // v3c: single `🔀 Switch primary →` entry replaces the v3b
  // per-fallback `⤴ Promote` buttons + per-account drill-downs that
  // flooded the main board. The text already names every account
  // (`▶ active` + indented `↳ fallback` rows), so the keyboard's job
  // is *actions*, not navigation. One button, one tap → picker.
  //
  // Visibility rules:
  //   - hidden when there are no fallbacks (single account = nothing
  //     to switch to)
  //   - hidden when no account claims active (older CLI without
  //     primaryForAgents — picker target would be ambiguous)
  //   - shown otherwise
  if (state.accounts != null && state.accounts.length > 0) {
    const visible = state.accounts.slice(0, ACCOUNTS_DISPLAY_CAP);
    const active = visible.find((a) => a.activeForThisAgent === true);
    const fallbacks = visible.filter((a) => a !== active);
    if (active != null && fallbacks.length > 0) {
      kb.text(
        "🔀 Switch primary →",
        encodeCallbackData({ kind: "switch-primary-view", agent: state.agent }),
      );
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

  // Quota row. [📊 Full quota] is the escape hatch when the
  // operator wants the live numbers behind the cached mini-bars.
  // The legacy `[⚠️ Fall back now]` button (manual auto-fallback at
  // the slot level) was removed in v0.6.11 — the Switch primary
  // picker is the operator-facing surface for "active is hot, swap
  // to a fallback," and the auto-fallback poller still handles the
  // automatic case when the active hits its quota wall. The
  // `fallback` callback verb stays in the parser/dispatcher for
  // legacy reachability of any pinned messages still bearing the
  // pre-v0.6.11 button, but no new buttons emit it.
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
 * Account-level analogue: derive the `quotaHot` flag from the
 * accounts section of the dashboard. Under the new auth framework
 * accounts (not slots) are the unit of quota, so the [Fall back now]
 * affordance should fire when ANY account in the agent's list is
 * approaching the cap — not just the slot that happens to be the
 * active mirror.
 *
 * Combine with `isQuotaHot(slots)` via `||` at the call site so
 * legacy slot setups still get the warning.
 */
export function isAccountQuotaHot(
  accounts: ReadonlyArray<AccountSummary> | undefined,
): boolean {
  if (!accounts) return false;
  for (const a of accounts) {
    if (a.health === "quota-exhausted") return true;
    if ((a.fiveHourPct ?? 0) >= QUOTA_HOT_THRESHOLD_PCT) return true;
    if ((a.sevenDayPct ?? 0) >= QUOTA_HOT_THRESHOLD_PCT) return true;
  }
  return false;
}

/**
 * Render the per-account quota line shown under each account row in
 * the dashboard. Returns null when no quota data is available — the
 * caller skips the row entirely so a freshly-added (un-probed)
 * account doesn't show a placeholder.
 *
 * Format priority:
 *   - quota-exhausted (server-side or 100% utilization) →
 *     "exhausted · resets in Nh Mm"
 *   - both percentages known → "5h: 47%  · 7d: 12%"
 *   - one percentage known   → that one
 *   - nothing                → null
 *
 * Reset times come straight from the Anthropic response headers via
 * `parseQuotaHeaders` (`fiveHourResetAt`, `sevenDayResetAt` epoch ms).
 */
export function formatAccountQuotaLine(
  acc: AccountSummary,
  now: number = Date.now(),
): string | null {
  if (acc.quotaExhaustedUntil != null && acc.quotaExhaustedUntil > now) {
    const reset = formatRelativeMs(acc.quotaExhaustedUntil - now);
    return `<i>exhausted · resets in ${reset}</i>`;
  }
  const parts: string[] = [];
  if (acc.fiveHourPct != null) {
    parts.push(`<i>5h:</i> ${formatQuotaPct(acc.fiveHourPct)}`);
  }
  if (acc.sevenDayPct != null) {
    parts.push(`<i>7d:</i> ${formatQuotaPct(acc.sevenDayPct)}`);
  }
  if (parts.length === 0) return null;
  return parts.join("  · ");
}

function formatQuotaPct(pct: number): string {
  // Round to integer % for the dashboard. Show "<1%" when the value
  // is positive but rounds to zero, so "0%" is reserved for genuine
  // idle accounts.
  const rounded = Math.round(pct);
  if (pct > 0 && rounded === 0) return "&lt;1%";
  return `${rounded}%`;
}

/**
 * Render a Unicode mini-bar for a 0–100 percentage. Six cells wide —
 * the active row carries two of these (5h + 7d) and they need to fit
 * one mobile line alongside the labels and percentages.
 *
 *   formatQuotaBar(0)   → ░░░░░░
 *   formatQuotaBar(47)  → ███░░░
 *   formatQuotaBar(99)  → █████░  (clamps below full so 99% reads
 *                                  visibly different from 100%)
 *   formatQuotaBar(100) → ██████
 *
 * Used only on the active-account row (the one running quota right
 * now). Fallback rows still render plain percentages because the bars
 * eat horizontal space the indented "↳" rows don't have.
 */
export function formatQuotaBar(pct: number, cells: number = 6): string {
  if (cells <= 0) return "";
  const clamped = Math.max(0, Math.min(100, pct));
  // Math.floor for the filled cell count — 100% gets all cells, 99%
  // gets cells-1, anything below the per-cell threshold gets 0.
  const filled =
    clamped >= 100 ? cells : Math.floor((clamped / 100) * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

function formatRelativeMs(ms: number): string {
  const totalMin = Math.max(1, Math.floor(ms / 60_000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
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
 * Build the switch-primary picker keyboard. One row per non-active
 * account (the candidates the user might promote). Each row is a
 * direct `confirm-account-promote` — single tap fires the change, no
 * second confirm screen, since the picker itself is already an
 * intentional drill-down ("I tapped Switch primary, then I tapped
 * the new primary").
 *
 * Why skip the two-stage confirm here when enable/disable have one:
 *   - The picker IS the confirmation surface. Showing a second
 *     "Confirm promote: foo?" screen on top of "tap the one you
 *     want" is mobile UX cruft.
 *   - The action is reversible — operators can re-promote at will.
 *
 * Cancel returns to the main dashboard via a refresh callback.
 *
 * Signature mirrors `buildAccountConfirmKeyboard` for consistency:
 * `agent` first, then the picker-specific data (the candidates).
 */
export function buildSwitchPrimaryKeyboard(
  agent: string,
  candidates: ReadonlyArray<{ label: string; health: AccountHealth }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const cand of candidates) {
    const action: CallbackAction = {
      kind: "confirm-account-promote",
      agent,
      label: cand.label,
    };
    const encoded = encodeCallbackData(action);
    if (Buffer.byteLength(encoded, "utf8") > CALLBACK_BUDGET_BYTES) {
      // Pathological agent + label combo. Render the row inert so the
      // operator falls back to the CLI rather than us silently
      // dropping the candidate.
      kb.text(
        `⚠ ${truncateLabel(cand.label)} (use CLI)`,
        encodeCallbackData({ kind: "noop" }),
      );
    } else {
      kb.text(`⤴ ${cand.label}${healthSuffix(cand.health)}`, encoded);
    }
    kb.row();
  }
  kb.text("↩️ Cancel", encodeCallbackData({ kind: "refresh", agent }));
  return kb;
}

/**
 * Two-stage confirmation for the account promote action — mirrors
 * `buildAccountConfirmKeyboard` but with the promote-specific verb so
 * the confirm row's callback dispatches to `confirm-account-promote`.
 *
 * Why a separate helper instead of extending the existing one's `kind`
 * parameter: the `enable | disable` discriminant is already in widely-
 * used callsites; threading a third value through them would force
 * cascading test updates. A dedicated helper is cleaner.
 */
export function buildAccountPromoteConfirmKeyboard(
  agent: string,
  label: string,
): InlineKeyboard {
  const action: CallbackAction = { kind: "confirm-account-promote", agent, label };
  return new InlineKeyboard()
    .text(`⚠️ Confirm promote: ${label}`, encodeCallbackData(action))
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
      (() => {
        const cancelEncoded = encodeCallbackData({ kind: "account-view", agent, label });
        return Buffer.byteLength(cancelEncoded, "utf8") <= CALLBACK_BUDGET_BYTES
          ? cancelEncoded
          : encodeCallbackData({ kind: "noop" });
      })(),
    );
}
