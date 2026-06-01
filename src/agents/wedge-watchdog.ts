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
  /** Number of times Esc was dispatched to dismiss a stuck prompt. */
  fires: number;
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
  const maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const capture = opts.capture ?? capturePane;
  const send = opts.send ?? sendKeys;

  let stableCount = 0;
  let lastKey: string | null = null;
  let cooldownUntil = 0;
  let fires = 0;
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

    const isBlockingModal =
      !!text &&
      signature.test(text) &&
      // Defer to the boot autoaccept poller for first-run prompts — those
      // want Enter, not Esc.
      !deferToPrompts.some((p) => p.match.test(text));

    if (isBlockingModal) {
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

  return { fires, polls, reason: "max-polls" };
}
