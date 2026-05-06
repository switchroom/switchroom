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
  /** Per-prompt timeout in ms. Default 30000. After this many ms with no prompt match, exit cleanly. */
  idleTimeoutMs?: number;
  /** Per-poll interval in ms. Default 250. */
  pollIntervalMs?: number;
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
  reason: "idle-timeout" | "manual-stop";
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
    // Dev-channels acknowledgement — shown once per machine when
    // --dangerously-load-development-channels is first used. Tightly
    // scoped to "development channels" to avoid over-matching per-tool
    // confirmations like "Yes, I accept this file edit." (those must
    // fall through to the plugin's permission_request flow).
    name: "dev-channels",
    match: /I.{0,5}accept.{0,80}development.{0,10}channels/,
    // Down + Enter — selects the second option (the "I accept" one).
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
    // Generic "Enter to confirm" — last because the more specific
    // matchers above should take precedence on the same screen.
    name: "enter-to-confirm",
    match: /Enter.{1,30}confirm/,
    keys: ["Enter"],
  },
];

const DEFAULT_IDLE_MS = 30_000;
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
 * Run the autoaccept poller until idle-timeout. Resolves with the list of
 * fired prompt names. Never throws.
 */
export async function runAutoaccept(
  opts: AutoacceptOptions,
): Promise<AutoacceptResult> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const rules = (opts.prompts ?? PROMPTS).map((r) => ({
    rule: r,
    fired: 0,
    cap: r.maxFires ?? 1,
  }));
  const fired: string[] = [];
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;

  let lastFire = now();
  let polls = 0;

  while (polls < maxPolls) {
    polls++;
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
    if (matchedThisPoll) {
      lastFire = now();
    } else if (now() - lastFire >= idleTimeoutMs) {
      return { fired, reason: "idle-timeout" };
    }
    await sleep(pollIntervalMs);
  }
  return { fired, reason: "manual-stop" };
}
