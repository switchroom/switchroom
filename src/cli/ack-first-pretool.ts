/**
 * PreToolUse hook — enforces the human-feel "ack first" beat
 * (`reference/conversational-pacing.md` beat 1).
 *
 * Bundled to `/opt/switchroom/hooks/ack-first-pretool.mjs` at build
 * time so it runs inside every switchroom-telegram-plugin agent.
 *
 * Contract:
 *   Input:  JSON on stdin — `{ session_id, tool_name, tool_input, ... }`
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON `{ decision: "block", reason: "..." }` → block.
 *
 * Behaviour:
 *   - Reply / stream_reply tool calls themselves: always allowed. The
 *     hook never gates the very tool it asks the model to call.
 *   - Any other tool call: allowed IFF an ack has already been sent
 *     this turn (`$TELEGRAM_STATE_DIR/ack-sent.flag` exists). The
 *     gateway touches this flag at `executeReply` on the first reply
 *     of each turn and clears it at `turn_started`.
 *   - If the flag is absent: BLOCK with a clear reason. The model's
 *     next move is forced into `reply` with a brief acknowledgement.
 *
 * Why this exists (the diagnostic that motivated it):
 *   The prompt-side directives (`profiles/_shared/telegram-style.md.hbs`,
 *   the per-turn `<turn-pacing>` UserPromptSubmit hook, the silence-
 *   poke ack-budget `<system-reminder>` piggyback at 10s) are all
 *   advisory. UAT (2026-05-28 jtbd-fast-ack-dm 8-prompt fuzz on
 *   v0.13.55) showed the model produced a real fast ack in only 1 of
 *   8 non-trivial prompts; 3 of 8 were full-answer dumps with no ack
 *   at all. The framework owns the beat — this hook is the
 *   enforcement primitive.
 *
 * Cost model:
 *   - Trivial-answer turns that don't use other tools: no overhead.
 *     The model calls `reply` with the whole answer; flag fires;
 *     turn ends normally.
 *   - Heavy turns that need tools first: ONE extra `reply` call
 *     forced before the tool. ~100-300ms of model+network. The user
 *     gets immediate awareness in return — the whole point of the
 *     5-beat design.
 *
 * Fail modes (all fail-OPEN so a broken hook never wedges the model):
 *   - Stdin parse fails → allow (let Claude Code report its own
 *     protocol error if any).
 *   - TELEGRAM_STATE_DIR env missing → allow. Without the flag path,
 *     we can't gate; better to let the model proceed than wedge it.
 *   - Filesystem error reading the flag → allow.
 *
 * Kill switch: `SWITCHROOM_DISABLE_ACK_FIRST_GATE=1` allows all tool
 * calls regardless. Defence-in-depth for fleet operators if the hook
 * ever produces a regression class we need to clear urgently.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Reply tools that satisfy the ack requirement. Both the main reply
 *  and the streaming variant count — stream_reply landing its first
 *  emit fires the gateway's `recordOutbound` + `markAckSent` the same
 *  way as `reply` does. */
const REPLY_TOOL_NAMES = new Set([
  "mcp__switchroom-telegram__reply",
  "mcp__switchroom-telegram__stream_reply",
]);

/** Marker filename inside `$TELEGRAM_STATE_DIR`. Touched by the gateway
 *  on the first reply of each turn, removed at the next `turn_started`. */
export const ACK_SENT_MARKER = "ack-sent.flag";

export interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface HookDecision {
  decision: "allow" | "block";
  /** Operator-facing reason; surfaced to the model when blocked. */
  reason?: string;
}

/** Pure decision function — given a parsed input + the resolved state
 *  dir, compute allow/block. Exposed for unit tests. */
export function decide(
  input: HookInput,
  stateDir: string | undefined,
): HookDecision {
  const toolName = input.tool_name ?? "";

  // Fail-open: a missing/empty tool_name is a Claude Code protocol
  // error — never gate on it (we don't know what we'd be gating).
  if (toolName === "") {
    return { decision: "allow" };
  }

  // Reply tools are always allowed — that's literally the call the
  // hook asks the model to make.
  if (REPLY_TOOL_NAMES.has(toolName)) {
    return { decision: "allow" };
  }

  if (!stateDir) {
    // Can't gate without the state dir. Allow so a misconfigured
    // agent isn't bricked.
    return { decision: "allow" };
  }

  const markerPath = join(stateDir, ACK_SENT_MARKER);
  let ackAlreadySent = false;
  try {
    ackAlreadySent = existsSync(markerPath);
  } catch {
    // Filesystem error — allow (fail-open).
    return { decision: "allow" };
  }
  if (ackAlreadySent) {
    return { decision: "allow" };
  }

  return {
    decision: "block",
    reason:
      "First call `mcp__switchroom-telegram__reply` with a brief one-line " +
      "acknowledgement in your persona's voice before using any other tool — " +
      'e.g. "on it — checking", "good question — one sec", "let me dig in". ' +
      "This is the framework's enforcement of the human-feel design " +
      "(`reference/conversational-pacing.md` beat 1): a colleague answers " +
      "in a beat. The reply can be the entire short answer if you have one " +
      "ready (then no further work needed); otherwise it's a brief status " +
      "and you continue with the work after.",
  };
}

/** Live hook entry — reads stdin, writes stdout, exits. */
export async function runHook(): Promise<void> {
  if (process.env.SWITCHROOM_DISABLE_ACK_FIRST_GATE === "1") {
    process.exit(0);
  }

  const stdin = await readStdin();
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    // Fail-open: malformed stdin shouldn't block tools.
    process.exit(0);
  }

  const stateDir = process.env.TELEGRAM_STATE_DIR;
  const decision = decide(input, stateDir);

  if (decision.decision === "block") {
    process.stdout.write(
      JSON.stringify({ decision: "block", reason: decision.reason }) + "\n",
    );
  }
  process.exit(0);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
    // If stdin closes immediately (no data), resolve empty.
    if (process.stdin.isTTY) resolve("");
  });
}

// CLI entry point — when the bundled mjs is invoked directly.
if (
  typeof process !== "undefined" &&
  process.argv?.[1]?.endsWith("ack-first-pretool.mjs")
) {
  runHook().catch((err) => {
    process.stderr.write(
      `ack-first-pretool: hook failed unexpectedly: ${err}\n`,
    );
    // Fail-open even on unexpected error.
    process.exit(0);
  });
}
