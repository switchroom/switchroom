// Mid-session wedge watchdog — defense-in-depth for blocking interactive
// TUI prompts that no human is present to answer.
//
// The boot-time autoaccept poller (`runAutoaccept`, autoaccept.ts) is a
// one-shot: it dispatches the small set of first-run prompts (theme, MCP
// trust, dev-channels) and exits after ~30s. It cannot catch a prompt that
// claude renders LATER, mid-session. The dominant such case is a blocking
// modal selector (e.g. claude's `AskUserQuestion`, or `ExitPlanMode`'s
// menu): a full-screen multiple-choice list with the footer
//   "❯ 1. … · Enter to select · ↑/↓ to navigate · Esc to cancel".
// With no human at the terminal it blocks forever — the turn never
// completes and queued Telegram inbounds pile up behind it until the agent
// looks mute (real incident: klanker, 2026-06-01, recovered only by a
// manual tmux `Esc`).
//
// Layer 1 of the fix denies `AskUserQuestion` fleet-wide so claude degrades
// to plain text (see scaffold.ts:INTERACTIVE_TUI_FLEET_DENY_TOOLS). This
// watchdog is Layer 2: a conservative, continuous safety net that catches
// ANY stuck blocking selector — including ones Layer 1 can't reach (a
// settings_raw override, a not-yet-reconciled agent, a future selector tool
// claude introduces, or ExitPlanMode). It sends `Esc`, which claude treats
// as "user declined" — non-destructive.
//
// Hard contracts (inherited from autoaccept.ts):
//   * Soft-fail throughout. Never throw out of `runWedgeWatchdog`.
//   * Only ever inject `Escape` via tmux send-keys. No destructive verbs.
//   * False positives are worse than false negatives — interrupting a live
//     turn is a regression, a missed wedge is just the pre-watchdog status
//     quo. So we require BOTH a precise blocking-modal signature AND
//     multi-poll stability before acting, and a cooldown after firing.

import {
  capturePane,
  sendKeys,
  PROMPTS,
  ruleMatches,
  FABLE_CONSENT_SIGNATURE,
  fableConsentNav,
  type PromptRule,
} from "./autoaccept.js";
import {
  queryPendingPermission as defaultQueryPendingPermission,
  type PendingPermissionQueryResult,
} from "./permission-pending-query.js";
import { readFloodPressure, type FloodPressure } from "./flood-pressure-probe.js";

/**
 * Blocking-modal footer signature. Deliberately strict: requires BOTH
 *   (a) an "Esc … cancel" affordance — the modal-cancel footer, which is
 *       distinct from the working-turn footer ("esc to interrupt") and the
 *       idle REPL footer, AND
 *   (b) a selection / navigation affordance ("to select" / "to navigate" /
 *       the ↑/↓ glyphs).
 * Only a blocking multiple-choice selector shows both at once. A streaming
 * turn, an idle REPL, or a plain confirmation prompt fails at least one
 * branch, so the watchdog leaves them alone.
 */
export const WEDGE_FOOTER_SIGNATURE =
  /(?=[\s\S]*[Ee]sc(?:ape)?[^\n]*cancel)(?=[\s\S]*(?:to select|to navigate|↑\/↓))/;

/**
 * The claude CLI's WEEKLY-quota wall surfaces as an interactive
 * `/rate-limit-options` chooser, NOT as a stderr 429 — so the gateway's
 * inference-path 429 detection never sees it and none of the failover/alert
 * machinery (markExhausted → roll → quota-watch) ever engages. A headless
 * agent then sits silently dead on a menu no human will answer (real incident:
 * finn, 2026-06-07 — wedged for hours, unrecovered).
 *
 * Crucially the generic WEDGE_FOOTER_SIGNATURE above does NOT match this menu:
 * its footer is "Enter to confirm · Esc to cancel" with NO "to select" /
 * "to navigate" / ↑↓ affordance, so the generic branch leaves it untouched.
 * Hence a dedicated detector.
 *
 * Two INDEPENDENT anchors, both required, so it can never false-positive on
 * normal model output (verified against the live wedged panes, 2026-06-07):
 *   (a) the interactive selector's option-1 row, which sits at the BOTTOM of
 *       the pane (where the cursor is) and is therefore always inside the
 *       captured viewport: "Stop and wait for …";
 *   (b) an option string ONLY this menu shows: "usage credits" (covers both
 *       "Switch to usage credits" and the newer "Add funds to continue with
 *       usage credits" wording), "Upgrade your plan", or the literal
 *       `/rate-limit-options` slash-command claude prints for the menu.
 *
 * v0.14.84 (#2218) anchored (a) on `/rate-limit-options` itself — but that
 * line is printed ABOVE the menu options, so on a pane with enough preceding
 * output it scrolls OFF the top of the `tmux capture-pane -p` viewport (which
 * grabs only the visible ~50 lines, no scrollback). clerk wedged exactly this
 * way on 2026-06-07 and the detector stayed silent (zero log fires). The fix
 * re-anchors (a) on the option-1 row, which is pinned to the bottom of the
 * pane and cannot scroll off; `/rate-limit-options` survives only as one of
 * the (b) alternatives. "Stop and wait for" (not the full "…limit to reset")
 * absorbs minor CLI wording drift (e.g. "…for your limit to reset").
 * (Grep of the repo confirmed zero pre-existing occurrences of these.)
 */
export const RATE_LIMIT_MENU_SIGNATURE =
  /(?=[\s\S]*Stop and wait for)(?=[\s\S]*(?:usage credits|Upgrade your plan|\/rate-limit-options))/;

/**
 * Compute the keystroke sequence that selects the "usage credits" option in
 * claude's `/rate-limit-options` menu, from a captured pane. The menu shape:
 *
 *     ❯ 1. Stop and wait for limit to reset
 *       2. Switch to usage credits          (or "Add funds to continue with…")
 *       3. Upgrade your plan
 *
 * The cursor (❯) defaults to option 1. We locate both the currently-selected
 * numbered row and the row whose label contains "usage credits", and return
 * `N × Down` then `Enter`.
 *
 * Returns `null` when the usage-credits row cannot be UNAMBIGUOUSLY located —
 * no numbered options parse, no row contains "usage credits", or it sits at/above
 * the cursor (never expected). `null` is the airtight FAIL-SAFE: the caller MUST
 * fall back to Esc-park rather than blind-navigate, so this can never accidentally
 * land on "Stop and wait" or "Upgrade your plan". This selector is invoked ONLY
 * after the broker has separately authorized overage for the active account.
 */
export function usageCreditsMenuNav(text: string): string[] | null {
  const options: { selected: boolean; label: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(❯)?\s*(\d+)\.\s+(.*\S)\s*$/);
    if (!m) continue;
    options.push({ selected: !!m[1], label: m[3] });
  }
  if (options.length === 0) return null;
  const creditIdx = options.findIndex((o) => /usage credits/i.test(o.label));
  if (creditIdx === -1) return null;
  let selIdx = options.findIndex((o) => o.selected);
  if (selIdx === -1) selIdx = 0; // menu default cursor is option 1
  const down = creditIdx - selIdx;
  if (down <= 0) return null; // credits at/above the cursor — fail safe to Esc.
  return [...Array(down).fill("Down"), "Enter"];
}

/**
 * #2471 — generic confirmation-MODAL signature, detected by SHAPE rather
 * than by the strict model-picker footer (`WEDGE_FOOTER_SIGNATURE`). The
 * dominant case is claude's `/effort` confirmation modal:
 *   Change effort level?
 *   ❯ 1. Yes, switch to high
 *     2. No, go back
 * which carries NO "to select" / "to navigate" / ↑↓ affordance, so the
 * generic `WEDGE_FOOTER_SIGNATURE` leaves it untouched — exactly the gap
 * that wedged overlord on 2026-06-20.
 *
 * Two alternative anchors, either sufficient:
 *   (a) the specific "Change effort level" wording (robust to re-wording
 *       of the option rows), OR
 *   (b) a generic "1. Yes … / 2. No …" numbered yes/no selector, which is
 *       the shape every effort-style confirmation shares.
 *
 * Critically, this signature is matched with SHAPE-persistence (the modal
 * has been continuously PRESENT across N polls) NOT byte-stability — a
 * modal whose pane re-renders (the manifest timer resetting to 0s, Ink
 * repaints) never reads byte-identical, which is precisely why the
 * byte-stability gate missed #2471. See `runWedgeWatchdog`.
 */
export const CONFIRM_MODAL_SIGNATURE =
  /Change\s+effort\s+level|(?=[\s\S]*\b1\.\s*Yes\b)(?=[\s\S]*\b2\.\s*No\b)/i;

/**
 * Per-tool PERMISSION-PROMPT TUI signature (config_propose_edit / hostd
 * mutating-verb freeze).
 *
 * When a non-pre-approved MCP tool's permission prompt renders as Claude
 * Code's INTERACTIVE confirmation TUI instead of emitting the channel
 * notification that becomes a Telegram approval card, nothing arms the
 * gateway's TTL auto-deny and the turn parks FOREVER — fleet-wide freeze
 * (real incident: carrie froze indefinitely on a `config_propose_edit`
 * permission prompt until a manual restart, 2026-06). The pane looks like:
 *
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again this session
 *     3. No, and tell Claude what to do differently (esc)
 *
 * Critically, none of the existing signatures match this:
 *   - WEDGE_FOOTER_SIGNATURE wants "to select"/"to navigate"/↑↓ in the
 *     footer — this prompt has none.
 *   - CONFIRM_MODAL_SIGNATURE wants a "1. Yes … / 2. No …" pair — here
 *     option 2 is "Yes, and don't ask again", so `2.\s*No` never matches.
 *
 * Two INDEPENDENT anchors, both required, so it can never false-positive on
 * normal model output:
 *   (a) the "Do you want to proceed?" question Claude Code prints for every
 *       per-tool permission prompt, AND
 *   (b) a "don't ask again" affordance (the option-2 row unique to this
 *       prompt family) — the load-bearing discriminator that separates a
 *       permission prompt from any other yes/no modal.
 *
 * Remedy is Esc, which Claude Code treats as "decline" (== a safe DENY) —
 * it can NEVER auto-select option 1 ("Yes") or 2 ("Yes, and don't ask
 * again"), preserving the human-in-the-loop boundary for the hostd verbs.
 */
export const PERMISSION_PROMPT_SIGNATURE =
  /(?=[\s\S]*Do you want to proceed\?)(?=[\s\S]*don['’]t ask again)/i;

/**
 * #2471 — semantic NO-PROGRESS signature. A turn that is "Manifesting"
 * (or otherwise spinning under the working footer) AND has a Stop-hook
 * error visible ("Stop hook error occurred" / "running stop hooks 0/N")
 * is wedged DESPITE emitting terminal activity: the manifest timer keeps
 * resetting to 0s, no tool calls land, and the Stop hook never completes,
 * so the turn never cleanly ends. Naive no-output watchdogs miss this
 * because the pane is still repainting. Both anchors are required so a
 * healthy mid-turn spinner (no stop-hook error) never trips it.
 */
export const STOP_HOOK_ERROR_SIGNATURE =
  /Stop hook error|running stop hooks\s+0\/\d+/i;

/** Whether a pane is in the "Manifesting"/spinning working state. */
export const MANIFESTING_SIGNATURE = /Manifesting|esc to interrupt/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse claude's weekly-reset line ("… resets Jun 9, 5am (Australia/Melbourne)")
 * into an epoch-ms timestamp, tz-aware. Returns null on ANY parse failure — the
 * caller MUST substitute a weekly-scale fallback (now + 7d), never `undefined`:
 * markExhausted's default `until` is ~5h, which would un-exhaust a WEEKLY-walled
 * account after 5h and re-wedge it. A wrong reset time only changes WHEN the
 * broker re-probes the account, never compliance or correctness.
 */
export function parseWeeklyReset(text: string, nowMs: number = Date.now()): number | null {
  // "resets Jun 9, 5am (Australia/Melbourne)" / "... 5pm (...)" / "... 11:30am"
  const m = text.match(
    /resets\s+([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*(?:\(([^)]+)\))?/i,
  );
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    // A leading word that ISN'T a month (e.g. "resets at 5pm" would never reach
    // here because of the \d requirement; but "resets soon 5pm" would) → fall
    // through to the time-only branch rather than returning null.
    if (mon !== undefined) {
      const day = Number(m[2]);
      let hour = Number(m[3]);
      const minute = m[4] ? Number(m[4]) : 0;
      const ampm = m[5]?.toLowerCase();
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      if (Number.isFinite(day) && Number.isFinite(hour) && day >= 1 && day <= 31 && hour <= 23) {
        const tz = m[6]?.trim();
        // Resolve the year as the next occurrence (roll forward if M/D already passed).
        const probeYear = new Date(nowMs).getUTCFullYear();
        for (const year of [probeYear, probeYear + 1]) {
          const epoch = wallClockToEpoch(year, mon, day, hour, minute, tz);
          if (epoch != null && epoch > nowMs - 60_000) return epoch;
        }
        return null;
      }
    }
  }

  // SESSION-cap wording: a bare time of day with NO month/day —
  // "resets 5pm (Australia/Melbourne)" / "resets 8:50am" / "resets 17:00".
  // This frees in HOURS, so it MUST resolve to the next occurrence of that
  // wall-clock time, NOT the weekly fallback. Without this branch the caller
  // substitutes now+7d and benches a session-capped account for a full week.
  // The negative lookahead rejects a month name so a date-bearing string can
  // never reach here (it's handled above).
  const tm = text.match(
    /resets\s+(?:at\s+)?(?!(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*(?:\(([^)]+)\))?/i,
  );
  if (tm) {
    let hour = Number(tm[1]);
    const minute = tm[2] ? Number(tm[2]) : 0;
    const ampm = tm[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (!Number.isFinite(hour) || hour > 23 || hour < 0 || !Number.isFinite(minute) || minute > 59) {
      return null;
    }
    const tz = tm[4]?.trim();
    // Walk today + the next two days (DST-safe) IN THE TARGET TZ and pick the
    // first occurrence strictly in the future.
    for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
      const dp = tzDateParts(new Date(nowMs + dayOffset * 86_400_000), tz);
      if (dp == null) return null;
      const epoch = wallClockToEpoch(dp.year, dp.month, dp.day, hour, minute, tz);
      if (epoch != null && epoch > nowMs) return epoch;
    }
    return null;
  }

  return null;
}

/** The y/m/d of `d` as seen in `tz` (UTC when tz omitted). Null on bad tz. */
function tzDateParts(
  d: Date,
  tz: string | undefined,
): { year: number; month: number; day: number } | null {
  if (!tz) {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
    );
    return {
      year: Number(parts.year),
      month: Number(parts.month) - 1,
      day: Number(parts.day),
    };
  } catch {
    return null;
  }
}

/**
 * Convert a wall-clock time in an IANA tz to epoch-ms (null if the tz is
 * unknown). Resolves the tz's offset AT that date via Intl, so it is correct
 * across DST — NOT `new Date(localString)`, which assumes the container TZ.
 */
function wallClockToEpoch(
  year: number, month: number, day: number, hour: number, minute: number, tz: string | undefined,
): number | null {
  const asUtc = Date.UTC(year, month, day, hour, minute, 0);
  if (!tz) return asUtc; // no tz given → best-effort UTC
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(asUtc)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
    );
    const shown = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    const offset = shown - asUtc; // how far ahead the tz wall clock is of UTC
    return asUtc - offset;
  } catch {
    return null; // unknown tz
  }
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_STABILITY_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

// #2471 — shape-persistence + semantic-stall defaults. Configurable via
// env where the codebase already does this (`SWITCHROOM_WEDGE_*`).
//
//   * CONFIRM_MODAL: a confirmation modal must be PRESENT (not
//     byte-stable) for this many consecutive polls before we Esc it. With
//     the default 5s cadence, 3 polls ≈ 15s of continuous-present modal.
//   * MANIFEST_STALL: a Manifesting + stop-hook-error state must persist
//     for this many consecutive polls before we escalate to kill+restart.
//     Default 60 polls ≈ 5 min @ 5s — matches the ~27-min overlord wedge
//     while staying clear of any healthy long turn (which won't carry a
//     stop-hook error anyway).
const DEFAULT_CONFIRM_MODAL_POLLS = 3;
const DEFAULT_MANIFEST_STALL_POLLS = 60;
// The Fable-5 usage-credits consent modal must be PRESENT for this many
// consecutive polls before we answer it. Same shape-persistence rationale as
// CONFIRM_MODAL (the Ink modal repaints, so it is never byte-stable).
const DEFAULT_FABLE_CONSENT_POLLS = 3;
// A per-tool permission prompt must be PRESENT for this many consecutive
// polls before Esc. Same shape-persistence rationale as CONFIRM_MODAL:
// the Ink-rendered prompt repaints so it's not byte-stable. 3 polls ≈ 15s
// @ 5s — a wedged permission prompt never clears on its own (no human),
// so even a short streak is conclusive while staying clear of a transient.
const DEFAULT_PERMISSION_PROMPT_POLLS = 3;
// The card-LESS streak: how many consecutive polls a permission prompt must be
// present before Esc when the gateway has affirmatively answered
// `{ ok: true, pending: false }` ("no approval card exists for this agent").
//
// This is deliberately MUCH longer than DEFAULT_PERMISSION_PROMPT_POLLS,
// because `pending: false` has two very different meanings that the answer
// itself cannot distinguish:
//
//   1. genuinely card-less — the bridge is down, or the tool is
//      `requiresUserInteraction`, so no card will EVER exist. Esc is correct.
//   2. not card-less YET — Claude Code emitted the `permission_request`
//      channel notification, but the gateway has not managed to POST the card
//      to Telegram, because a 429 flood window / the edit-flood-fuse is
//      holding it (`edit-flood-fuse deferred method=sendRichMessage
//      key=t:<chat> class=critical`). A card IS coming. Esc is a permanent
//      deny of a request the operator is about to approve.
//
// Before this split, both shared the 3-poll (~15s) gate and case 2 lost the
// race routinely (clerk, 2026-07-28: three separate `dismissing stuck per-tool
// permission prompt … gateway reports no pending permission` lines at 3, 3 and
// 15 polls, interleaved with `has live card … deferring` lines for the same
// agent minutes apart).
//
// 24 polls ≈ 120s @ 5s. Chosen to comfortably exceed a realistic flood-wait
// plus card-post latency: the flood ledger's calibration data (16 days of live
// gateway logs, `flood-429-ledger.ts`) puts EVERY benign `retry_after` at
// ≤ 5s and classifies anything ≤ 60s as a rate nudge that `retryApiCall`
// simply sleeps and retries — so 120s is 2x the top of the entire
// sleep-and-succeed band, on top of which the observed edit-flood-fuse defer
// tail for the clerk incident was ~47s. It is also still an order of magnitude
// below the #2724 card TTL, so a genuinely wedged card-less prompt is denied
// in ~2 minutes rather than hanging.
const DEFAULT_PERMISSION_CARDLESS_POLLS = 24;
// Absolute ceiling on flood-pressure suppression: once a permission prompt has
// been present for this many consecutive polls, Esc fires even if Telegram is
// still throttling. 120 polls ≈ 10 min @ 5s.
//
// Bounded patience is a hard requirement — a multi-hour flood ban (the
// 2026-07-27 `retry_after=15908` incident) must not park a wedged turn
// forever. At that point the card cannot realistically reach the operator in
// time anyway, and Esc is the safe DENY.
const DEFAULT_PERMISSION_FLOOD_MAX_POLLS = 120;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface WedgeWatchdogOptions {
  agentName: string;
  /** Poll cadence in ms. Default 5000. */
  pollIntervalMs?: number;
  /**
   * Number of CONSECUTIVE identical-and-wedged captures required before
   * sending Esc. Default 3. The pane of a working agent (spinner, token
   * stream, elapsed timer) changes between polls, so a static blocking
   * selector is the only thing that stays byte-identical across this many
   * polls. With the default 5s cadence that's ~15s of confirmed-stuck.
   */
  stabilityThreshold?: number;
  /**
   * After firing Esc, suppress further fires for this long so we don't
   * tight-loop Esc into a prompt that re-renders. Default 60000.
   */
  cooldownMs?: number;
  /**
   * First-run prompts to DEFER to: if the pane matches one of these, the
   * boot autoaccept poller owns it (it wants Enter, not Esc), so the
   * watchdog must not fire. Default: the autoaccept PROMPTS set.
   */
  deferToPrompts?: PromptRule[];
  /** Override the blocking-modal signature (tests / tuning). */
  wedgeSignature?: RegExp;
  /**
   * Rate-limit (weekly-quota) menu detection. When the pane shows claude's
   * `/rate-limit-options` chooser, the agent is quota-walled and headless — no
   * 429 reached the gateway, so failover never fired. On a stable match the
   * watchdog (a) signals the gateway to trigger the EXISTING account-failover
   * (markExhausted → roll, or the all-exhausted alert) via `onRateLimitMenu`,
   * then (b) parks the menu with `Esc` (the SAME compliant verb — Esc cancels
   * without selecting any option, so it can never pick "Switch to usage
   * credits" = off-subscription). Disabled when `rateLimitSignature` is null.
   */
  rateLimitSignature?: RegExp | null;
  /**
   * Called on a stability-confirmed rate-limit menu, with the parsed weekly
   * reset (epoch-ms, or null when unparseable). Default: signal the gateway
   * over its UDS. Soft-fail — must never throw. Set to undefined to detect +
   * park WITHOUT signalling (e.g. tests).
   */
  onRateLimitMenu?: (agentName: string, resetAt: number | null) => void;
  /**
   * Opt-in OVERAGE carve-out (the ONLY path that may select a paid option).
   * Consulted on a stability-confirmed rate-limit menu, BEFORE any keystroke.
   * Must return whether the broker — the single audited authority for spending
   * money — currently authorizes Anthropic overage for THIS agent's active
   * account (in `allow_overage_accounts`, `overageStatus:"allowed"`, not
   * `out_of_credits`, no active 429 mark). When it resolves `true`, the watchdog
   * SELECTS the "usage credits" menu option (nav + Enter) and does NOT signal
   * failover. When `false`, undefined, or it throws, the watchdog falls back to
   * the DEFAULT (signal failover + Esc-park) — so default-off is airtight: with
   * no decision seam wired (or no flagged account), behaviour is byte-identical
   * to Esc-only. The watchdog NEVER reads config and NEVER decides to spend on
   * its own. Soft-fail — a throw here defaults to Esc-park.
   */
  overageDecision?: (agentName: string) => boolean | Promise<boolean>;
  /** Test seam: clock-injected weekly-reset parser. Default: parseWeeklyReset. */
  parseReset?: (text: string, nowMs: number) => number | null;
  /**
   * #2471 — generic confirmation-modal signature, detected by SHAPE
   * persistence (modal continuously PRESENT across polls) rather than
   * byte-stability. Catches the `/effort` "Change effort level?" modal
   * whose re-rendering pane defeats the byte-stable gate. On a
   * shape-persistent match the watchdog Escs it (the SAME compliant verb —
   * Esc == "No, go back", never confirms an effort change on the model's
   * behalf). `null` disables this branch.
   */
  confirmModalSignature?: RegExp | null;
  /**
   * Consecutive polls a confirmation modal must be PRESENT before Esc.
   * Default `SWITCHROOM_WEDGE_CONFIRM_POLLS` or 3.
   */
  confirmModalPolls?: number;
  /**
   * Fable-5 usage-credits consent modal, detected by SHAPE persistence.
   *
   * This modal is a REAL mid-session gap, not just a boot one: none of the
   * other signatures reach it. `WEDGE_FOOTER_SIGNATURE` requires a "to
   * select" / "to navigate" / ↑↓ affordance the modal's
   * "Enter to confirm · Esc to cancel" footer does not have;
   * `CONFIRM_MODAL_SIGNATURE` requires a "1. Yes / 2. No" pair (option 2 here
   * is "Switch to Sonnet 5 and continue"); `PERMISSION_PROMPT_SIGNATURE`
   * requires "Do you want to proceed?" + "don't ask again"; and
   * `RATE_LIMIT_MENU_SIGNATURE` requires "Stop and wait for". So a `/model
   * fable` switch mid-session parks the agent on an unanswerable modal
   * forever. On a shape-persistent match the watchdog selects "Continue with
   * Fable 5" (`fableConsentNav`), which is the operator's already-expressed
   * model choice. `null` disables this branch.
   */
  fableConsentSignature?: RegExp | null;
  /**
   * Consecutive polls the Fable consent modal must be PRESENT before we
   * answer it. Default `SWITCHROOM_WEDGE_FABLE_POLLS` or 3.
   */
  fableConsentPolls?: number;
  /**
   * Per-tool permission-prompt TUI signature, detected by SHAPE
   * persistence (the prompt continuously PRESENT across polls), same as
   * the confirmation modal. Catches a non-pre-approved MCP tool's
   * "Do you want to proceed?" permission prompt that rendered as Claude
   * Code's interactive TUI instead of emitting the channel notification —
   * which leaves the turn frozen forever with no TTL auto-deny (the
   * config_propose_edit / hostd-verb freeze). On a shape-persistent match
   * the watchdog Escs it; Esc == "decline" == a SAFE DENY (never selects
   * option 1/2 "Yes"), so the human-in-the-loop boundary is preserved.
   * `null` disables this branch.
   */
  permissionPromptSignature?: RegExp | null;
  /**
   * Consecutive polls a permission prompt must be PRESENT before Esc.
   * Default `SWITCHROOM_WEDGE_PERMISSION_POLLS` or 3.
   */
  permissionPromptPolls?: number;
  /**
   * Consecutive polls a permission prompt must be PRESENT before Esc **when
   * the gateway affirmatively reports no pending card** (`{ok:true,
   * pending:false}`). Substantially longer than `permissionPromptPolls`
   * because that answer cannot distinguish "no card will ever exist" from
   * "the card has not been POSTED yet" — see
   * `DEFAULT_PERMISSION_CARDLESS_POLLS`. Default
   * `SWITCHROOM_WEDGE_PERMISSION_CARDLESS_POLLS` or 24 (~120s @ 5s). Clamped
   * to at least `permissionPromptPolls`.
   */
  permissionCardlessPolls?: number;
  /**
   * Flood-pressure probe: "is Telegram currently throttling this agent's
   * outbound path?". While it reports `active`, the permission branch does
   * NOT send Esc — the approval card may simply be stuck behind a 429 window
   * / the edit-flood-fuse rather than absent.
   *
   * Consumes the flood-ban work's existing on-disk state only
   * (`flood-windows.json` + `429-ledger.json` via
   * `src/agents/flood-pressure-probe.ts`); it never records anything.
   * `undefined` (default) wires the real probe; `null` disables
   * flood-awareness entirely (kill switch / rollback).
   */
  floodPressure?: ((now: number) => FloodPressure) | null;
  /**
   * Absolute ceiling (in consecutive present-polls) on flood-pressure
   * suppression. Past this the prompt is Esc'd regardless of an open window,
   * so a multi-hour ban can never park a wedged turn forever. Default
   * `SWITCHROOM_WEDGE_PERMISSION_FLOOD_MAX_POLLS` or 120 (~10 min @ 5s).
   */
  permissionFloodMaxPolls?: number;
  /**
   * Issue #2971 — card-aware gate for the permission-prompt branch. Once
   * `permissionPromptPolls` shape-persistence is reached, the watchdog calls
   * this BEFORE ever sending Esc, to ask the gateway whether a live Telegram
   * approval card already exists for this agent (`pendingPermissions`).
   *
   *   - `{ ok: true, pending: true }`  → a card (+ the #2724 TTL reaper) owns
   *     this prompt. Skip Esc entirely — the reaper's channel-delivered deny
   *     dismisses the TUI at TTL with no keystroke needed.
   *   - `{ ok: true, pending: false }` → genuinely card-less prompt (bridge
   *     down, a `requiresUserInteraction` tool). Fall back to Esc.
   *   - `{ ok: false }` (gateway unreachable, timed out, or an older gateway
   *     that doesn't recognise the query) → fall back to Esc — identical to
   *     the pre-#2971 behaviour, so a mixed-version fleet degrades safely.
   *
   * `undefined` (the default) → real gateway UDS round-trip via
   * `queryPendingPermission` from `permission-pending-query.ts` (~2s budget).
   * `null` → disable the card-aware check entirely and Esc unconditionally,
   * exactly like before this feature existed (kill switch for tests / a
   * rollback).
   */
  queryPendingPermission?: ((agentName: string) => Promise<PendingPermissionQueryResult>) | null;
  /**
   * #2471 — semantic no-progress: a "Manifesting" + Stop-hook-error state
   * that persists past `manifestStallPolls`. The in-pane Esc evidently
   * could not clear it (the turn never ends), so this escalates to a clean
   * kill + handoff restart via `requestRestart`. `null` disables the
   * branch.
   */
  manifestStallSignature?: RegExp | null;
  /**
   * Consecutive polls a Manifesting + stop-hook-error state must persist
   * before escalating to restart. Default
   * `SWITCHROOM_WEDGE_MANIFEST_POLLS` or 60 (~5 min @ 5s).
   */
  manifestStallPolls?: number;
  /**
   * Called once when a manifest-stall wedge is confirmed: perform the
   * clean kill + handoff restart (the `resume_interrupted` path). Soft-fail
   * — must never throw. Default: undefined (detect + log only). The sidecar
   * wires this to the actual restart so the decision logic stays pure and
   * testable, and so the destructive action is opt-in.
   */
  requestRestart?: (agentName: string, reason: string) => void;
  /** Test seam: cap total polls. Default Infinity (runs until killed). */
  maxPolls?: number;
  /** Test seam: clock override. */
  now?: () => number;
  /** Test seam: sleep override. */
  sleep?: (ms: number) => Promise<void> | void;
  /** Test seam: pane capture override. Default: capturePane (real tmux). */
  capture?: (agentName: string) => string;
  /** Test seam: keystroke send override. Default: sendKeys (real tmux). */
  send?: (agentName: string, keys: string[]) => boolean;
}

export interface WedgeWatchdogResult {
  /** Number of times Esc was dispatched to dismiss a stuck prompt (includes
   *  rate-limit-menu parks). */
  fires: number;
  /** Subset of `fires` that were rate-limit (weekly-quota) menu detections that
   *  Esc-parked + signalled failover (the DEFAULT path for every account). */
  rateLimitFires: number;
  /** Subset of `fires` where the broker authorized overage for the active
   *  account and the watchdog SELECTED "usage credits" instead of failover
   *  (the opt-in carve-out). 0 unless an account is flagged AND overage is
   *  currently allowed by Anthropic. */
  overageCreditSelections: number;
  /** #2471 — subset of `fires` that dismissed a confirmation modal detected
   *  by SHAPE persistence (the `/effort`-class wedge). */
  confirmModalFires: number;
  /** Subset of `fires` that answered the Fable-5 usage-credits consent modal
   *  by SELECTING "Continue with Fable 5" (never a "buy credits" variant). */
  fableConsentFires: number;
  /** Subset of `fires` that dismissed a per-tool permission-prompt TUI
   *  (the config_propose_edit / hostd-verb freeze) with a safe Esc-decline. */
  permissionPromptFires: number;
  /** Issue #2971 — count of permission prompts where the gateway reported a
   *  LIVE pending-permission card, so the watchdog deferred (no Esc) rather
   *  than racing the card/TTL reaper. Disjoint from `permissionPromptFires`. */
  permissionPromptDeferrals: number;
  /** Count of polls where Esc was withheld because Telegram was throttling
   *  this agent's outbound path (an approval card may be en route but stuck
   *  behind a 429 window / the edit-flood-fuse). Disjoint from
   *  `permissionPromptFires`. */
  permissionPromptFloodHolds: number;
  /** Count of polls where Esc was withheld because a card-LESS gateway answer
   *  had not yet reached the longer `permissionCardlessPolls` streak.
   *  Disjoint from `permissionPromptFires`. */
  permissionPromptCardlessHolds: number;
  /** #2471 — count of manifest-stall escalations (kill + handoff restart). */
  restartEscalations: number;
  /** Total polls executed (bounded only in tests via maxPolls). */
  polls: number;
  reason: "max-polls" | "stopped";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Normalize a pane snapshot for stability comparison: strip trailing
 * whitespace per line so cursor-position jitter doesn't defeat the
 * identical-capture check.
 */
function stabilityKey(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n");
}

/**
 * Continuously watch an agent's tmux pane and dismiss a STABLE blocking
 * modal selector with Esc. Never throws. Designed to run for the container
 * lifetime (the autoaccept-poll sidecar enters this after its boot phase).
 */
export async function runWedgeWatchdog(
  opts: WedgeWatchdogOptions,
): Promise<WedgeWatchdogResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const stabilityThreshold = opts.stabilityThreshold ?? DEFAULT_STABILITY_THRESHOLD;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const deferToPrompts = opts.deferToPrompts ?? PROMPTS;
  const signature = opts.wedgeSignature ?? WEDGE_FOOTER_SIGNATURE;
  // `null` disables rate-limit detection (kill switch); `undefined` → default on.
  const rateLimitSignature =
    opts.rateLimitSignature === null ? null : (opts.rateLimitSignature ?? RATE_LIMIT_MENU_SIGNATURE);
  const onRateLimitMenu = opts.onRateLimitMenu;
  // Opt-in overage carve-out. `undefined` (the default) → never select credits;
  // the rate-limit branch behaves byte-identically to Esc-only (default-off).
  const overageDecision = opts.overageDecision;
  const parseReset = opts.parseReset ?? parseWeeklyReset;
  // #2471 — shape-persistence confirmation modal + semantic manifest-stall.
  // `null` disables the branch; `undefined` → default on.
  const confirmModalSignature =
    opts.confirmModalSignature === null
      ? null
      : (opts.confirmModalSignature ?? CONFIRM_MODAL_SIGNATURE);
  const confirmModalPolls =
    opts.confirmModalPolls ?? envInt("SWITCHROOM_WEDGE_CONFIRM_POLLS", DEFAULT_CONFIRM_MODAL_POLLS);
  // Fable-5 usage-credits consent modal. `null` disables; `undefined` → on.
  const fableConsentSignature =
    opts.fableConsentSignature === null
      ? null
      : (opts.fableConsentSignature ?? FABLE_CONSENT_SIGNATURE);
  const fableConsentPolls =
    opts.fableConsentPolls ?? envInt("SWITCHROOM_WEDGE_FABLE_POLLS", DEFAULT_FABLE_CONSENT_POLLS);
  // Per-tool permission-prompt TUI freeze (config_propose_edit / hostd verbs).
  // `null` disables the branch; `undefined` → default on.
  const permissionPromptSignature =
    opts.permissionPromptSignature === null
      ? null
      : (opts.permissionPromptSignature ?? PERMISSION_PROMPT_SIGNATURE);
  const permissionPromptPolls =
    opts.permissionPromptPolls ??
    envInt("SWITCHROOM_WEDGE_PERMISSION_POLLS", DEFAULT_PERMISSION_PROMPT_POLLS);
  // The card-LESS branch gets its OWN, longer streak. Clamped so a
  // mis-set env can never make the card-less path FASTER than the
  // wedged/unreachable path it is supposed to be more patient than.
  const permissionCardlessPolls = Math.max(
    permissionPromptPolls,
    opts.permissionCardlessPolls ??
      envInt("SWITCHROOM_WEDGE_PERMISSION_CARDLESS_POLLS", DEFAULT_PERMISSION_CARDLESS_POLLS),
  );
  // Flood-awareness. `null` disables; `undefined` → the real on-disk probe.
  const floodPressure =
    opts.floodPressure === null
      ? null
      : (opts.floodPressure ?? ((n: number) => readFloodPressure(n)));
  // Absolute ceiling on flood suppression — bounded patience, never infinite.
  const permissionFloodMaxPolls = Math.max(
    permissionCardlessPolls,
    opts.permissionFloodMaxPolls ??
      envInt("SWITCHROOM_WEDGE_PERMISSION_FLOOD_MAX_POLLS", DEFAULT_PERMISSION_FLOOD_MAX_POLLS),
  );
  const manifestStallSignature =
    opts.manifestStallSignature === null
      ? null
      : (opts.manifestStallSignature ?? MANIFESTING_SIGNATURE);
  const manifestStallPolls =
    opts.manifestStallPolls ?? envInt("SWITCHROOM_WEDGE_MANIFEST_POLLS", DEFAULT_MANIFEST_STALL_POLLS);
  const requestRestart = opts.requestRestart;
  // Issue #2971 — card-aware gate. `null` disables (Esc unconditionally,
  // pre-#2971 behaviour); `undefined` (default) wires the real gateway query.
  const queryPendingPermission =
    opts.queryPendingPermission === null ? null : (opts.queryPendingPermission ?? defaultQueryPendingPermission);
  const maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const capture = opts.capture ?? capturePane;
  const send = opts.send ?? sendKeys;

  let stableCount = 0;
  let lastKey: string | null = null;
  let cooldownUntil = 0;
  let fires = 0;
  let rateLimitFires = 0;
  let overageCreditSelections = 0;
  let confirmModalFires = 0;
  let fableConsentFires = 0;
  let permissionPromptFires = 0;
  let permissionPromptDeferrals = 0;
  let permissionPromptFloodHolds = 0;
  let permissionPromptCardlessHolds = 0;
  let restartEscalations = 0;
  let polls = 0;
  // #2471 — shape-persistence counters (independent of the byte-stable
  // `stableCount`): how many CONSECUTIVE polls each shape has been PRESENT.
  let confirmModalPresent = 0;
  let fableConsentPresent = 0;
  let permissionPromptPresent = 0;
  let manifestStallPresent = 0;
  // Byte-stability of the Manifesting pane across polls — the progress
  // discriminator that replaced the old mandatory stop-hook-error AND (see the
  // manifest-stall branch). A streaming/progressing turn changes this key every
  // poll and resets the stall counter; a frozen spinner keeps it identical.
  let lastManifestKey: string | null = null;
  let confirmCooldownUntil = 0;
  let fableCooldownUntil = 0;
  let permissionCooldownUntil = 0;
  // Log throttle for the two new "holding off on Esc" paths. They are
  // evaluated EVERY poll (deliberately — that is how we notice the moment the
  // card lands), so their log lines must not be.
  let lastPermissionHoldLogAt = Number.NEGATIVE_INFINITY;

  while (polls < maxPolls) {
    polls++;
    let text = "";
    try {
      text = capture(opts.agentName);
    } catch (err) {
      // capturePane is contracted to soft-fail, but defence-in-depth.
      console.error(
        `[wedge-watchdog] ${opts.agentName}: capture threw: ${(err as Error).message}`,
      );
      text = "";
    }

    // Rate-limit (weekly-quota) menu takes PRECEDENCE over the generic modal
    // branch: it must be SIGNALLED (to trigger failover) before any Esc, and a
    // bare Esc alone would just clear the visual block and re-wedge next turn.
    const isRateLimitMenu = !!text && rateLimitSignature !== null && rateLimitSignature.test(text);

    // #2471 — confirmation modal detected by SHAPE persistence (NOT
    // byte-stability). Precedence below rate-limit, above the byte-stable
    // blocking-modal branch — this is the `/effort` "Change effort level?"
    // class whose re-rendering pane defeats `stabilityKey`.
    //
    // We do NOT defer to the boot autoaccept PROMPTS here. The boot poller
    // is idle-timeout bounded (~30s) — it has exited by the time a
    // mid-session effort modal appears, so the watchdog is the only catcher
    // left. And the first-run prompts the boot poller owns ("1. I am using
    // this for local development" / "2. Exit", theme/MCP) do NOT match the
    // confirmation-modal shape (a "1. Yes / 2. No" selector or the effort
    // wording), so there is no collision to defer for. The watchdog's
    // remedy here (Esc) is also identical to the autoaccept effort rule, so
    // even an overlap would be harmless.
    // Per-tool permission-prompt TUI ("Do you want to proceed?" + a
    // "don't ask again" affordance) — the config_propose_edit / hostd-verb
    // freeze. Precedence above the confirm-modal branch: its shape
    // ("1. Yes / 2. Yes, and don't ask again / 3. No") is a SUPERSET match
    // risk, so we classify it first and Esc-decline it (safe DENY).
    //
    // The Fable-5 usage-credits consent modal is classified BEFORE the
    // permission/confirm/blocking branches, all of which would (if they
    // matched at all) Esc it — and Esc here cancels the operator's own model
    // choice. It sits below the rate-limit branch purely defensively: the two
    // signatures are disjoint ("Stop and wait for" vs "Continue with Fable"),
    // but the quota wall must always win if a pane ever showed both.
    const isFableConsent =
      !isRateLimitMenu &&
      !!text &&
      fableConsentSignature !== null &&
      fableConsentSignature.test(text);

    const isPermissionPrompt =
      !isRateLimitMenu &&
      !isFableConsent &&
      !!text &&
      permissionPromptSignature !== null &&
      permissionPromptSignature.test(text);

    const isConfirmModal =
      !isRateLimitMenu &&
      !isFableConsent &&
      !isPermissionPrompt &&
      !!text &&
      confirmModalSignature !== null &&
      confirmModalSignature.test(text);

    const isBlockingModal =
      !isRateLimitMenu &&
      !isFableConsent &&
      !isPermissionPrompt &&
      !isConfirmModal &&
      !!text &&
      signature.test(text) &&
      // Defer to the boot autoaccept poller for first-run prompts — those
      // want Enter, not Esc. `ruleMatches` (not a bare `match.test`) so a
      // rule's negative guard is honoured here too.
      !deferToPrompts.some((p) => ruleMatches(p, text));

    // #2471 — semantic no-progress tracker, INDEPENDENT of the modal chain: a
    // "Manifesting"/spinning turn that is NOT advancing is wedged despite the
    // terminal showing the spinner. Previously this required BOTH the
    // Manifesting signature AND a Stop-hook error — so a hang with no stop-hook
    // line matched nothing and was never caught. The stop-hook AND is dropped;
    // the false-positive it used to guard against (killing a healthy long
    // "Manifesting" turn) is now prevented by a PROGRESS discriminator instead:
    // the stall counter only climbs while the pane is BYTE-STABLE across polls
    // (a streaming/progressing turn changes the key and resets it). A present
    // Stop-hook error is kept as a fast path — it means wedged regardless of
    // byte movement. Tracked every poll (a modal poll won't match Manifesting,
    // so the counters don't collide).
    //
    // SCOPE (do not overclaim): byte-stability catches a FULLY FROZEN render —
    // a hard TUI/render-loop deadlock where even the elapsed-timer stops
    // repainting. It does NOT catch a live-but-hung pane whose elapsed timer
    // keeps ticking (a tool blocked but the spinner still animating) — that pane
    // is never byte-stable. That "carrie" class (tool hung mid-call, terminal
    // still alive) is caught by the gateway's Stage B marker-staleness restart
    // (`hang-restart-decision.ts`), NOT here. We deliberately do not normalize
    // the spinner glyph + elapsed timer out of the key: a silent long foreground
    // tool (no output, only a ticking clock) would then normalize to "stable"
    // and be false-killed by this tmux layer — the exact harm the discriminator
    // exists to avoid. This branch stays the narrow frozen-render net.
    const manifestSignatureHit =
      !!text &&
      manifestStallSignature !== null &&
      manifestStallSignature.test(text);
    const manifestKey = manifestSignatureHit ? stabilityKey(text) : null;
    const stopHookPresent = !!text && STOP_HOOK_ERROR_SIGNATURE.test(text);
    // No progress ⇔ the Manifesting pane is byte-identical to the last poll, OR
    // a Stop-hook error is present (a hard wedge signal independent of movement).
    const manifestNoProgress =
      manifestSignatureHit && (stopHookPresent || manifestKey === lastManifestKey);
    lastManifestKey = manifestKey;
    const isManifestStall = manifestNoProgress;
    if (isManifestStall) {
      manifestStallPresent++;
      if (manifestStallPresent >= manifestStallPolls) {
        const detail =
          `Manifesting ${stopHookPresent ? "+ stop-hook-error " : "pane byte-stable "}` +
          `present ${manifestStallPresent} polls ` +
          `(~${Math.round((manifestStallPresent * pollIntervalMs) / 1000)}s) with no progress`;
        console.error(
          `[wedge-watchdog] ${opts.agentName}: manifest-stall wedge — ${detail}; ` +
            (requestRestart
              ? "escalating to kill + handoff restart"
              : "no requestRestart wired — logging only"),
        );
        if (requestRestart) {
          try {
            requestRestart(opts.agentName, detail);
          } catch (err) {
            console.error(
              `[wedge-watchdog] ${opts.agentName}: requestRestart threw: ${(err as Error).message}`,
            );
          }
          restartEscalations++;
        }
        // Reset so we don't re-escalate every subsequent poll; require a
        // fresh full streak (the restart itself should clear the pane).
        manifestStallPresent = 0;
      }
    } else {
      manifestStallPresent = 0;
    }

    if (isRateLimitMenu) {
      const key = stabilityKey(text);
      if (key === lastKey) {
        stableCount++;
      } else {
        stableCount = 1;
        lastKey = key;
      }
      if (stableCount >= stabilityThreshold && now() >= cooldownUntil) {
        const resetAt = parseReset(text, now());
        // DECISION: default for EVERY account is failover + Esc-park (Esc can
        // never select a paid option). The ONLY way to instead select "usage
        // credits" is for the broker — the single audited authority for spending
        // money — to confirm overage is currently active for this agent's
        // account. The watchdog itself reads no config and decides nothing; it
        // just obeys the broker's verdict. Soft-fail → default (Esc-park).
        //
        // Robustness: this code path runs ONLY when claude actually RENDERS the
        // `/rate-limit-options` menu. If Anthropic serves overage SILENTLY (the
        // menu never appears), this branch never runs and the flagged account
        // simply keeps working on overage — correct either way. The menu is the
        // only case that needs handling, and it is handled here.
        let useCredits = false;
        if (overageDecision) {
          try {
            useCredits = (await overageDecision(opts.agentName)) === true;
          } catch (err) {
            console.error(
              `[wedge-watchdog] ${opts.agentName}: overageDecision threw: ${(err as Error).message} — defaulting to Esc-park + failover`,
            );
            useCredits = false;
          }
        }
        const nav = useCredits ? usageCreditsMenuNav(text) : null;
        if (useCredits && nav) {
          // Broker authorized overage for this account → SELECT "usage credits"
          // (paid overage billed to the operator's own Anthropic credits, on the
          // SAME interactive claude CLI + OAuth — still claude-native, never
          // API/SDK/`claude -p`). Do NOT signal failover / markExhausted: we
          // intend to keep using this account on overage.
          console.error(
            `[wedge-watchdog] ${opts.agentName}: rate-limit menu — broker confirms overage ACTIVE for the active account; ` +
              `selecting "usage credits" (${nav.join(" ")}) instead of failover. Anthropic overage billing will apply.`,
          );
          try {
            send(opts.agentName, nav);
          } catch (err) {
            console.error(
              `[wedge-watchdog] ${opts.agentName}: send threw: ${(err as Error).message}`,
            );
          }
          fires++;
          overageCreditSelections++;
        } else {
          if (useCredits && !nav) {
            // Broker said overage is active but we could NOT locate the
            // usage-credits row — fail SAFE to Esc-park rather than blind-nav.
            console.error(
              `[wedge-watchdog] ${opts.agentName}: overage authorized but the "usage credits" option could not be located in the pane — failing safe to Esc-park + failover`,
            );
          }
          console.error(
            `[wedge-watchdog] ${opts.agentName}: rate-limit (weekly-quota) menu detected ` +
              `after ${stableCount} stable polls — signalling failover` +
              (resetAt != null ? ` (resets ${new Date(resetAt).toISOString()})` : " (reset unparsed)") +
              ` then parking with Esc`,
          );
          // (a) Trigger the EXISTING gateway failover chain. Soft-fail — the
          //     never-throw sidecar contract holds even for a custom seam.
          if (onRateLimitMenu) {
            try {
              onRateLimitMenu(opts.agentName, resetAt);
            } catch (err) {
              console.error(
                `[wedge-watchdog] ${opts.agentName}: onRateLimitMenu threw: ${(err as Error).message}`,
              );
            }
          }
          // (b) Park the menu compliantly. ESC ONLY — cancels the modal without
          //     selecting any option, so it can NEVER land on "Switch to usage
          //     credits" (off-subscription) or "Upgrade your plan". Never send a
          //     Down/numeric key here.
          try {
            send(opts.agentName, ["Escape"]);
          } catch (err) {
            console.error(
              `[wedge-watchdog] ${opts.agentName}: send threw: ${(err as Error).message}`,
            );
          }
          fires++;
          rateLimitFires++;
        }
        cooldownUntil = now() + cooldownMs;
        stableCount = 0;
        lastKey = null;
      }
    } else if (isFableConsent) {
      // SHAPE persistence (the Ink modal repaints; it is never byte-stable).
      fableConsentPresent++;
      // A different shape is showing — keep the other streaks neutral.
      stableCount = 0;
      lastKey = null;
      permissionPromptPresent = 0;
      confirmModalPresent = 0;
      if (fableConsentPresent >= fableConsentPolls && now() >= fableCooldownUntil) {
        // Select "Continue with Fable 5" by its own digit. `fableConsentNav`
        // resolves the digit from the pane's LABELS; the ["1", "Enter"]
        // fallback is safe because the signature has already proved the
        // "Continue with Fable" row is on screen and it is option 1 in every
        // rendering of this component. We never send a bare Enter: the CLI
        // focuses option 2 ("Switch to Sonnet 5 and continue") by default, so
        // Enter would decline the operator's configured model.
        const nav = fableConsentNav(text) ?? ["1", "Enter"];
        console.error(
          `[wedge-watchdog] ${opts.agentName}: Fable-5 usage-credits consent modal present ` +
            `${fableConsentPresent} polls ` +
            `(~${Math.round((fableConsentPresent * pollIntervalMs) / 1000)}s) — ` +
            `selecting "Continue with Fable 5" (${nav.join(" ")}); the session is on fable ` +
            `because the operator configured it, and Enter/Esc here would silently decline it`,
        );
        try {
          send(opts.agentName, nav);
        } catch (err) {
          console.error(
            `[wedge-watchdog] ${opts.agentName}: send threw: ${(err as Error).message}`,
          );
        }
        fires++;
        fableConsentFires++;
        fableCooldownUntil = now() + cooldownMs;
        fableConsentPresent = 0;
      }
    } else if (isPermissionPrompt) {
      // SHAPE persistence (the Ink-rendered prompt repaints, so it is not
      // byte-stable). Count consecutive polls the prompt has been PRESENT.
      permissionPromptPresent++;
      // Keep the byte-stable machinery neutral so a later wedge starts fresh.
      stableCount = 0;
      lastKey = null;
      fableConsentPresent = 0;
      if (permissionPromptPresent >= permissionPromptPolls && now() >= permissionCooldownUntil) {
        // Issue #2971 — card-aware gate, BEFORE any keystroke. Claude Code
        // renders this TUI AND emits the `permission_request` channel
        // notification unconditionally in parallel — if a Telegram approval
        // card is already live for this request, firing Esc here just races
        // it and Esc-denies the operator's own in-flight card. Ask the
        // gateway first.
        let status: PendingPermissionQueryResult | null = null;
        if (queryPendingPermission) {
          try {
            status = await queryPendingPermission(opts.agentName);
          } catch (err) {
            // Soft-fail: the query function is contracted to never throw,
            // but defence-in-depth — treat a throw exactly like `ok: false`
            // (gateway-unreachable), i.e. fall back to Esc.
            console.error(
              `[wedge-watchdog] ${opts.agentName}: queryPendingPermission threw: ${(err as Error).message} — treating as unreachable`,
            );
            status = { ok: false, reason: `threw: ${(err as Error).message}` };
          }
        }
        if (status && status.ok && status.pending) {
          // A live card owns this prompt. Do NOT Esc — the #2724 TTL reaper
          // delivers a deny over the channel at TTL, which dismisses the TUI
          // cleanly with no keystroke. Cooldown throttles re-querying the
          // gateway every poll while the card is still live; the shape
          // streak (`permissionPromptPresent`) is left untouched — the
          // prompt genuinely is still present, so a later Esc fallback (if
          // the card ever disappears without resolving) still sees the full
          // accumulated streak.
          console.error(
            `[wedge-watchdog] ${opts.agentName}: permission prompt has live card ` +
              `${status.requestId ?? "(id unknown)"}, deferring to card/TTL after ` +
              `${permissionPromptPresent} polls present ` +
              `(~${Math.round((permissionPromptPresent * pollIntervalMs) / 1000)}s) — NOT sending Esc`,
          );
          permissionPromptDeferrals++;
          permissionCooldownUntil = now() + cooldownMs;
        } else {
          // ── Two independent gates now sit between "no live card" and Esc. ──
          //
          // Esc is a PERMANENT deny. Before this, the single
          // `permissionPromptPolls` streak fed both the live-card defer path
          // above and this one, so a card that was merely LATE (Telegram 429
          // → the gateway's edit-flood-fuse deferring `sendRichMessage`) got
          // the exact same ~15s of patience as a genuinely wedged card-less
          // prompt, and lost the race. The operator then tapped Approve on a
          // card whose prompt was already Esc-denied.
          const held = now();
          const pressure = floodPressure ? floodPressure(held) : null;
          const logHold = (line: string) => {
            if (held - lastPermissionHoldLogAt < cooldownMs) return;
            lastPermissionHoldLogAt = held;
            console.error(line);
          };

          // Gate 1 — Telegram is throttling this agent RIGHT NOW. Whatever the
          // gateway just said about pending cards, a card may be queued behind
          // the flood window / fuse, so no keystroke. Bounded by
          // `permissionFloodMaxPolls` so a multi-hour ban cannot park a
          // genuinely wedged turn forever.
          const floodHold =
            pressure?.active === true &&
            permissionPromptPresent < permissionFloodMaxPolls;
          // Gate 2 — the gateway affirmatively said "no card" but we have not
          // yet waited the longer card-LESS streak. `pending: false` cannot
          // distinguish "never will have a card" from "not posted yet".
          const cardless = status != null && status.ok && !status.pending;
          const cardlessHold =
            !floodHold && cardless && permissionPromptPresent < permissionCardlessPolls;
          if (floodHold) {
            permissionPromptFloodHolds++;
            logHold(
              `[wedge-watchdog] ${opts.agentName}: permission prompt present ` +
                `${permissionPromptPresent} polls ` +
                `(~${Math.round((permissionPromptPresent * pollIntervalMs) / 1000)}s) but ` +
                `Telegram is flood-throttling this agent (${pressure.reason}) — ` +
                `an approval card may be deferred, NOT sending Esc ` +
                `(ceiling ${permissionFloodMaxPolls} polls)`,
            );
          } else if (cardlessHold) {
            permissionPromptCardlessHolds++;
            logHold(
              `[wedge-watchdog] ${opts.agentName}: gateway reports no pending ` +
                `permission after ${permissionPromptPresent} polls ` +
                `(~${Math.round((permissionPromptPresent * pollIntervalMs) / 1000)}s) — ` +
                `holding Esc until the card-less streak of ${permissionCardlessPolls} polls ` +
                `(~${Math.round((permissionCardlessPolls * pollIntervalMs) / 1000)}s), ` +
                `in case the card is merely late`,
            );
          } else {
            const reason =
              queryPendingPermission == null
                ? "card-aware check disabled"
                : status && status.ok
                  ? `gateway reports no pending permission (card-less prompt) for ${permissionCardlessPolls}+ polls`
                  : `gateway unreachable/no answer within budget${status && !status.ok ? ` (${status.reason})` : ""}`;
            const floodNote = pressure?.active
              ? ` [flood ceiling ${permissionFloodMaxPolls} polls reached while ${pressure.reason}]`
              : "";
            console.error(
              `[wedge-watchdog] ${opts.agentName}: dismissing stuck per-tool ` +
                `permission prompt (Esc == decline == safe DENY) after ` +
                `${permissionPromptPresent} polls present ` +
                `(~${Math.round((permissionPromptPresent * pollIntervalMs) / 1000)}s) — ${reason}${floodNote}`,
            );
            // Esc ONLY — Claude Code treats Esc as "user declined", which is the
            // safe DENY for a non-pre-approved verb. It can NEVER land on option
            // 1/2 ("Yes" / "Yes, and don't ask again"), so the human-in-the-loop
            // boundary for the hostd verbs is preserved. Never send Enter/numeric.
            try {
              send(opts.agentName, ["Escape"]);
            } catch (err) {
              console.error(
                `[wedge-watchdog] ${opts.agentName}: send threw: ${(err as Error).message}`,
              );
            }
            fires++;
            permissionPromptFires++;
            permissionCooldownUntil = now() + cooldownMs;
            permissionPromptPresent = 0;
          }
        }
      }
    } else if (isConfirmModal) {
      // #2471 — SHAPE persistence, not byte-stability: count consecutive
      // polls the modal has been PRESENT. A flickering modal (timer
      // resetting to 0s) advances this counter where the byte-stable
      // branch never would.
      confirmModalPresent++;
      // Modal cleared the byte-stable streak machinery — keep it neutral so
      // a later byte-stable wedge starts fresh. A different shape is showing,
      // so drop any permission-prompt streak too.
      stableCount = 0;
      lastKey = null;
      permissionPromptPresent = 0;
      fableConsentPresent = 0;
      if (confirmModalPresent >= confirmModalPolls && now() >= confirmCooldownUntil) {
        console.error(
          `[wedge-watchdog] ${opts.agentName}: dismissing stuck confirmation modal ` +
            `(Esc == "No, go back") after ${confirmModalPresent} polls present ` +
            `(~${Math.round((confirmModalPresent * pollIntervalMs) / 1000)}s, flicker-immune) ` +
            `— no human to answer it`,
        );
        try {
          send(opts.agentName, ["Escape"]);
        } catch (err) {
          console.error(
            `[wedge-watchdog] ${opts.agentName}: send threw: ${(err as Error).message}`,
          );
        }
        fires++;
        confirmModalFires++;
        confirmCooldownUntil = now() + cooldownMs;
        confirmModalPresent = 0;
      }
    } else if (isBlockingModal) {
      const key = stabilityKey(text);
      if (key === lastKey) {
        stableCount++;
      } else {
        stableCount = 1;
        lastKey = key;
      }
      if (stableCount >= stabilityThreshold && now() >= cooldownUntil) {
        console.error(
          `[wedge-watchdog] ${opts.agentName}: dismissing stuck blocking prompt ` +
            `(Esc) after ${stableCount} stable polls (~${
              (stableCount * pollIntervalMs) / 1000
            }s) — no human to answer it`,
        );
        try {
          send(opts.agentName, ["Escape"]);
        } catch (err) {
          // sendKeys is contracted to soft-fail (returns boolean), but the
          // never-throw sidecar contract must hold even for a custom seam.
          console.error(
            `[wedge-watchdog] ${opts.agentName}: send threw: ${(err as Error).message}`,
          );
        }
        fires++;
        cooldownUntil = now() + cooldownMs;
        // Reset so we require a fresh stability streak before firing again.
        stableCount = 0;
        lastKey = null;
      }
    } else {
      // Pane is doing something else (working, idle REPL, plain text) — drop
      // any accumulated streak.
      stableCount = 0;
      lastKey = null;
      // #2471 — the confirmation modal is gone; reset its shape-present
      // streak so a re-armed modal must re-accumulate from scratch.
      confirmModalPresent = 0;
      // Same for the permission-prompt streak — gone means re-accumulate.
      permissionPromptPresent = 0;
      // …and the Fable consent modal's.
      fableConsentPresent = 0;
    }

    await sleep(pollIntervalMs);
  }

  return {
    fires,
    rateLimitFires,
    overageCreditSelections,
    confirmModalFires,
    fableConsentFires,
    permissionPromptFires,
    permissionPromptDeferrals,
    permissionPromptFloodHolds,
    permissionPromptCardlessHolds,
    restartEscalations,
    polls,
    reason: "max-polls",
  };
}
