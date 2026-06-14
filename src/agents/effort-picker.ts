/**
 * Claude CLI `/effort <level>` driver over tmux.
 *
 * `/effort <level>` is NOT always a one-shot. On an idle / small-cache
 * session it applies directly ("Set effort level to <level>"). But when the
 * session has a substantial cached conversation, switching effort would
 * invalidate that cache, so claude pops a confirmation modal:
 *
 *     Change effort level?
 *     Your next response will be slower and use more tokens
 *     This conversation is cached for the current effort level. Switching to
 *     <level> means the full history gets re-read on your next message.
 *     ❯ 1. Yes, switch to <level>
 *       2. No, go back
 *
 * The bare inject primitive types `/effort <level>` and walks away, leaving
 * that modal open — which WEDGES the agent's pane (the /rate-limit-options
 * wedge class) and falsely reports success. This driver answers the modal:
 * the user explicitly asked for the level, so it confirms (Enter — the
 * cursor defaults to "Yes"). If the modal can't be dismissed it cancels
 * (Esc) rather than leave the pane wedged, and reports the failure.
 *
 * Reuses model-picker's tmux machinery (makeTmuxRunner + withPaneLock).
 */
import { makeTmuxRunner, type TmuxRunner } from "./inject.js";
import { withPaneLock } from "./pane-lock.js";

export interface EffortApplyOpts {
  tmuxBin?: string;
  socketName?: string;
  sessionName?: string;
  /** Per-poll settle wait (ms). Default 600. */
  stepMs?: number;
  /** Hard ceiling on the whole operation (ms). Default 10000. */
  timeoutMs?: number;
  /** Test seams. */
  _runner?: TmuxRunner;
  _sleep?: (ms: number) => Promise<void>;
  _log?: (line: string) => void;
}

export type EffortApplyResult =
  | { ok: true; level: string; confirmed: boolean; output: string }
  | {
      ok: false;
      reason: "session_missing" | "confirm_failed" | "apply_unverified";
      /** True when a modal was still open after we tried to dismiss it. */
      wedged?: boolean;
    };

/** The confirmation modal's title — present iff the switch needs confirming. */
const CONFIRM_RE = /Change effort level\?/i;

/**
 * The status banner shows the LIVE effort as "<level> · /effort"
 * (e.g. "● high · /effort"). The command echo is "/effort <level>" (the
 * verb precedes the level), so this pattern — level BEFORE `/effort`,
 * separated by the middot — matches ONLY the banner, never the echo.
 */
function appliedRe(level: string): RegExp {
  return new RegExp(`${level}\\s*\\u00b7\\s*/effort`);
}

/** Pull the human "Set effort level to <level>: …" line for the reply. */
function applyLine(pane: string, level: string): string {
  const re = new RegExp(`Set effort level to ${level}\\b.*`, "i");
  for (const line of pane.split("\n")) {
    const m = line.match(re);
    if (m) return m[0].trim();
  }
  return `Set effort level to ${level}`;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Type `/effort <level>` into the agent's pane and drive it to completion,
 * answering the confirmation modal if it appears. Bounded: at most two
 * confirmation keypresses, then it cancels and reports — never loops, never
 * leaves the pane wedged.
 */
export async function applyEffort(
  agentName: string,
  level: string,
  opts: EffortApplyOpts = {},
): Promise<EffortApplyResult> {
  const runner = opts._runner ?? makeTmuxRunner(opts.tmuxBin ?? "tmux");
  const socket = opts.socketName ?? `switchroom-${agentName}`;
  const session = opts.sessionName ?? agentName;
  const stepMs = opts.stepMs ?? 600;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sleep = opts._sleep ?? realSleep;
  const log = opts._log ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (!runner.hasSession(socket, session)) {
    return { ok: false, reason: "session_missing" };
  }

  return withPaneLock(`${socket}:${session}`, async () => {
    const startedAt = Date.now();
    const expired = () => Date.now() - startedAt >= timeoutMs;

    try {
      runner.send(socket, session, ["send-keys", "-l", `/effort ${level}`]);
      runner.send(socket, session, ["send-keys", "Enter"]);

      let confirmed = false;
      let confirmKeys = 0;

      while (!expired()) {
        await sleep(stepMs);
        const pane = runner.capture(socket, session) ?? "";

        if (CONFIRM_RE.test(pane)) {
          if (confirmKeys >= 2) {
            // Two confirms didn't clear it — cancel so we never wedge the pane.
            runner.send(socket, session, ["send-keys", "Escape"]);
            await sleep(stepMs);
            const after = runner.capture(socket, session) ?? "";
            log(
              `effort-picker: confirm modal would not dismiss for ${agentName} ` +
                `(socket=${socket}) — cancelled`,
            );
            return { ok: false, reason: "confirm_failed", wedged: CONFIRM_RE.test(after) };
          }
          // Cursor defaults to "Yes, switch to <level>"; Enter confirms.
          runner.send(socket, session, ["send-keys", "Enter"]);
          confirmed = true;
          confirmKeys += 1;
          continue;
        }

        if (appliedRe(level).test(pane)) {
          return { ok: true, level, confirmed, output: applyLine(pane, level) };
        }
        // Otherwise the command is still rendering — keep polling.
      }

      // Timed out. If a modal lingers, cancel it so the pane isn't wedged.
      const final = runner.capture(socket, session) ?? "";
      if (CONFIRM_RE.test(final)) {
        runner.send(socket, session, ["send-keys", "Escape"]);
        log(`effort-picker: timeout with modal open for ${agentName} — cancelled`);
        return { ok: false, reason: "confirm_failed", wedged: true };
      }
      return { ok: false, reason: "apply_unverified" };
    } finally {
      // Defence in depth: never exit this driver with a confirmation modal
      // still open. Normal paths leave none (success has no modal; the cancel
      // paths already Esc'd), so this is a no-op then — it only bites when the
      // drive threw mid-modal. Best-effort and self-isolating: a throw here
      // (tmux already gone → nothing to wedge) must not mask the real outcome.
      try {
        const pane = runner.capture(socket, session) ?? "";
        if (CONFIRM_RE.test(pane)) {
          runner.send(socket, session, ["send-keys", "Escape"]);
        }
      } catch {
        /* tmux unreachable — no live modal to leave open */
      }
    }
  });
}
