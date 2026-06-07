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

import { capturePane, sendKeys, PROMPTS, type PromptRule } from "./autoaccept.js";

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
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (!Number.isFinite(day) || !Number.isFinite(hour) || day < 1 || day > 31 || hour > 23) {
    return null;
  }
  const tz = m[6]?.trim();
  // Resolve the year as the next occurrence (roll forward if M/D already passed).
  const probeYear = new Date(nowMs).getUTCFullYear();
  for (const year of [probeYear, probeYear + 1]) {
    const epoch = wallClockToEpoch(year, mon, day, hour, minute, tz);
    if (epoch != null && epoch > nowMs - 60_000) return epoch;
  }
  return null;
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
  /** Test seam: clock-injected weekly-reset parser. Default: parseWeeklyReset. */
  parseReset?: (text: string, nowMs: number) => number | null;
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
  /** Subset of `fires` that were rate-limit (weekly-quota) menu detections —
   *  each also signalled failover. */
  rateLimitFires: number;
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
  const parseReset = opts.parseReset ?? parseWeeklyReset;
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
  let polls = 0;

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

    const isBlockingModal =
      !isRateLimitMenu &&
      !!text &&
      signature.test(text) &&
      // Defer to the boot autoaccept poller for first-run prompts — those
      // want Enter, not Esc.
      !deferToPrompts.some((p) => p.match.test(text));

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
        cooldownUntil = now() + cooldownMs;
        stableCount = 0;
        lastKey = null;
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
    }

    await sleep(pollIntervalMs);
  }

  return { fires, rateLimitFires, polls, reason: "max-polls" };
}
