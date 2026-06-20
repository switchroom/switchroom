// First-run autoaccept pane-poller (#725 PR-4).
//
// Replaces `bin/autoaccept.exp` (the `expect` wrapper) with a small TS
// pane-poller that uses `tmux capture-pane -p -t <name>` + `tmux send-keys`
// to dispatch keystrokes for the small set of first-run claude TUI
// prompts (theme picker, MCP trust, dev-channels acknowledgement,
// API provider picker, generic confirm).
//
// Why poll a tmux pane instead of attaching to the PTY: under the tmux
// supervisor (#725 PR-1, default since that PR) claude is already inside
// a tmux session — there's no PTY to spawn around it. tmux gives us a
// safe, side-effect-free read of the rendered screen via `capture-pane`
// and a safe write via `send-keys`. Both are pure observation/injection;
// neither alters the pane lifecycle.
//
// Hard contracts:
//   * Soft-fail throughout. tmux gone? Log to stderr and continue.
//   * Never throw out of `runAutoaccept`. Worst case: idle-timeout and
//     return cleanly.
//   * Never call destructive tmux verbs. Only `capture-pane` and
//     `send-keys`. No kill-session, no respawn, no detach.
//   * After ~30s with no prompt match, exit cleanly. claude has either
//     reached the REPL or wedged in a way the poller can't fix; either
//     way, leaving the pane untouched is the right move.
//   * Each prompt fires at most `maxFires` times (default 1). The pane
//     scrollback retains old prompt text; without a fire-cap the poller
//     would re-dispatch keystrokes every 250ms forever once a prompt
//     scrolled past.
//
// The prompt regexes are translated faithfully from `bin/autoaccept.exp`.
// If you change one, change both — the legacy expect wrapper is still
// gated behind `experimental.legacy_autoaccept_expect: true` as a
// rollback path for one release.

import { execFileSync } from "node:child_process";

export interface PromptRule {
  /** human-readable name, used for logging */
  name: string;
  /** regex against the captured pane text */
  match: RegExp;
  /** keystrokes to send via `tmux send-keys -t <agent>`. e.g. ["Enter"] or ["Down", "Enter"] */
  keys: string[];
  /** Optional: only match this prompt at most N times. Default 1. */
  maxFires?: number;
}

export interface AutoacceptOptions {
  agentName: string;
  /**
   * Absolute ceiling (ms) on the boot phase. The poller normally exits the
   * INSTANT claude reaches the REPL (see `replReadyMatch`); this cap only
   * bounds the pathological "claude never boots" case so the sidecar can
   * still hand off to the watch phase instead of looping forever. Default
   * 600_000 (10 min) — deliberately generous.
   *
   * It is NOT an idle timer. The pre-REPL pane (blank, a shell line, a
   * half-rendered banner, or a not-yet-matched prompt) must never trigger an
   * early exit: that is precisely what stranded 11/12 agents on the
   * unanswered dev-channels prompt during the 2026-06-17 cold full-host
   * restart, where claude — starved for CPU while every agent booted at once
   * — took well over the old 30s idle window just to render the prompt.
   */
  bootHardCapMs?: number;
  /** Per-poll interval in ms. Default 250. */
  pollIntervalMs?: number;
  /**
   * Pane signature that means claude has reached the interactive REPL — the
   * clean signal to end the boot phase and hand off to the wedge-watchdog.
   * Default: REPL_READY_SIGNATURE.
   */
  replReadyMatch?: RegExp;
  /** Override prompt set for tests. Default: built-in PROMPTS. */
  prompts?: PromptRule[];
  /** Test seam: cap total polls before giving up regardless of timer wall-clock. */
  maxPolls?: number;
  /** Test seam: clock + sleep override so unit tests don't burn real wall-clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void> | void;
}

export interface AutoacceptResult {
  fired: string[];
  /**
   * - `repl-ready`: claude reached the REPL — the normal, healthy handoff.
   * - `idle-timeout`: `bootHardCapMs` elapsed without reaching the REPL.
   * - `manual-stop`: `maxPolls` reached (tests only).
   */
  reason: "repl-ready" | "idle-timeout" | "manual-stop";
}

// Translated from `bin/autoaccept.exp`. The expect script uses `.{1,30}`
// bounded wildcards because claude's TUI inserts ANSI cursor-right
// sequences (`\033[1C`) between words, breaking naive literal matching.
// We see the same rendered bytes through `tmux capture-pane -p` (without
// `-e` for ANSI), so the regexes here can match the visible text without
// the `\033[1C` noise — but we keep the bounded wildcards to stay robust
// against minor TUI rewording.
//
// IMPORTANT: keep this list in sync with `bin/autoaccept.exp`. The legacy
// wrapper is still wired in when `experimental.legacy_autoaccept_expect`
// is true (one-release rollback knob).
export const PROMPTS: PromptRule[] = [
  {
    // NEW dev-channels prompt wording (Claude Code mid-2026+):
    //   WARNING: Loading development channels
    //   ❯ 1. I am using this for local development
    //     2. Exit
    // Option 1 is already highlighted, so just Enter — no Down needed.
    // Tightly scoped to "Loading … development channels" so we don't
    // over-match anywhere else.
    name: "dev-channels-loading",
    match: /Loading.{1,30}development.{1,30}channels/,
    keys: ["Enter"],
  },
  {
    // Belt-and-suspenders for the new prompt: match on the option-row
    // text in case the WARNING header has scrolled past the capture
    // window. "local development" is unique to this prompt and won't
    // appear in per-tool confirmations.
    name: "dev-channels-local",
    match: /using this for local development/,
    keys: ["Enter"],
  },
  {
    // LEGACY dev-channels acknowledgement — old wording before the 2026
    // TUI rename ("Yes, I accept the use of development channels"). Kept
    // as a fallback for older Claude Code releases. Tightly scoped to
    // "development channels" to avoid over-matching per-tool confirmations
    // like "Yes, I accept this file edit." (those must fall through to
    // the plugin's permission_request flow).
    name: "dev-channels",
    match: /I.{0,5}accept.{0,80}development.{0,10}channels/,
    // Down + Enter — selects the second option (the legacy "I accept" one).
    keys: ["Down", "Enter"],
  },
  {
    // MCP server trust prompt.
    name: "mcp-trust",
    match: /Use this and all future MCP servers/,
    keys: ["Enter"],
  },
  {
    // First-run theme selection — pick option 1 (Auto).
    name: "theme",
    match: /Choose.{1,30}text.{1,30}style/,
    keys: ["Enter"],
  },
  {
    // First-run API provider selection — pick Anthropic (option 1).
    name: "provider",
    match: /Anthropic.{1,80}Bedrock/,
    keys: ["Enter"],
  },
  {
    // #2471 — `/effort` confirmation modal:
    //   Change effort level?
    //   ❯ 1. Yes, switch to high
    //     2. No, go back
    // An agent/headless-driven session can't tap the 1/2 keyboard choice
    // itself, so the modal blocks indefinitely and wedges the turn (Stop
    // hook then errors "0/6"; session spins "Manifesting"). We DISMISS it
    // (Escape == "No, go back") rather than confirm — effort is set
    // non-interactively via the `--effort` CLI flag at session start, so
    // the interactive change is never something we want to accept on the
    // model's behalf. maxFires is bumped because a stack of queued
    // `/effort` injections can re-arm the modal several times; each
    // re-arm must be Esc'd again.
    name: "effort-modal-dismiss",
    match: /Change.{1,30}effort.{1,30}level/i,
    keys: ["Escape"],
    maxFires: 5,
  },
  {
    // Generic "Enter to confirm" — last because the more specific
    // matchers above should take precedence on the same screen.
    name: "enter-to-confirm",
    match: /Enter.{1,30}confirm/,
    keys: ["Enter"],
  },
];

/**
 * claude's interactive REPL footer. It is present on both the idle prompt
 * ("? for shortcuts"), a working turn ("esc to interrupt"), and the
 * "accept edits on" / "← for agents" affordances. None of these appear on
 * ANY first-run prompt screen (those show "Enter to confirm · Esc to
 * cancel"), so a match unambiguously means claude has finished booting and
 * dispatched all first-run prompts — the clean signal to hand the pane over
 * to the continuous wedge-watchdog.
 */
export const REPL_READY_SIGNATURE =
  /← for agents|accept edits on|\? for shortcuts|esc to interrupt/;

const DEFAULT_BOOT_HARD_CAP_MS = 600_000;
const DEFAULT_POLL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Capture a single pane snapshot. Returns "" on any tmux error (soft-fail).
 */
export function capturePane(agentName: string): string {
  const socket = `switchroom-${agentName}`;
  try {
    const out = execFileSync(
      "tmux",
      ["-L", socket, "capture-pane", "-p", "-t", agentName],
      {
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return out.toString("utf8");
  } catch (err) {
    console.error(
      `[autoaccept] ${agentName}: capture-pane failed: ${(err as Error).message}`,
    );
    return "";
  }
}

/**
 * Send keystrokes via tmux. Soft-fail.
 */
export function sendKeys(agentName: string, keys: string[]): boolean {
  const socket = `switchroom-${agentName}`;
  try {
    execFileSync(
      "tmux",
      ["-L", socket, "send-keys", "-t", agentName, ...keys],
      { timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch (err) {
    console.error(
      `[autoaccept] ${agentName}: send-keys ${keys.join(" ")} failed: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Run the autoaccept boot poller. Dispatches first-run TUI prompts as they
 * render, and returns the moment claude reaches the REPL (`repl-ready`) so
 * the caller can hand off to the continuous wedge-watchdog. Resolves with
 * the list of fired prompt names. Never throws.
 *
 * Crucially the poller does NOT give up on a quiet pane: it keeps polling
 * until claude is demonstrably up (REPL footer) or the generous
 * `bootHardCapMs` ceiling trips. The previous "30s idle since launch"
 * heuristic gave up before a slow-booting claude had even rendered the
 * dev-channels prompt, stranding the whole fleet on a cold full-host restart
 * (2026-06-17) — see `bootHardCapMs`.
 */
export async function runAutoaccept(
  opts: AutoacceptOptions,
): Promise<AutoacceptResult> {
  const bootHardCapMs = opts.bootHardCapMs ?? DEFAULT_BOOT_HARD_CAP_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const replReady = opts.replReadyMatch ?? REPL_READY_SIGNATURE;
  const rules = (opts.prompts ?? PROMPTS).map((r) => ({
    rule: r,
    fired: 0,
    cap: r.maxFires ?? 1,
  }));
  const fired: string[] = [];
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;

  const startTime = now();
  let polls = 0;

  while (polls < maxPolls) {
    polls++;
    const t = now();
    const text = capturePane(opts.agentName);
    let matchedThisPoll = false;
    if (text) {
      for (const entry of rules) {
        if (entry.fired >= entry.cap) continue;
        if (entry.rule.match.test(text)) {
          entry.fired++;
          matchedThisPoll = true;
          fired.push(entry.rule.name);
          console.error(
            `[autoaccept] ${opts.agentName}: fired ${entry.rule.name} (${entry.rule.keys.join("+")})`,
          );
          sendKeys(opts.agentName, entry.rule.keys);
        }
      }
    }

    // A prompt fired this poll → claude is still mid first-run flow. Keep
    // polling for the next prompt / the REPL; never give up mid-sequence.
    if (!matchedThisPoll) {
      // Clean handoff: claude has reached the interactive REPL.
      if (text && replReady.test(text)) {
        return { fired, reason: "repl-ready" };
      }
      // Pathological ceiling ONLY: claude never reached the REPL and isn't
      // prompting. Hand off to the watch phase rather than loop forever. A
      // blank / pre-REPL / not-yet-matched-prompt pane must never exit early
      // (the 2026-06-17 cold-restart wedge), so this is the sole giving-up
      // condition and is measured generously from launch.
      if (t - startTime >= bootHardCapMs) {
        return { fired, reason: "idle-timeout" };
      }
    }

    await sleep(pollIntervalMs);
  }
  return { fired, reason: "manual-stop" };
}
