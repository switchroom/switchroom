/**
 * PreToolUse hook — deterministic foreground turn-hog gate for Bash.
 *
 * A foreground Bash call holds the WHOLE session for its full duration: the
 * agent cannot reply, steer, or take the next queued message until the
 * command returns (reference/jobs/steer-or-queue-mid-flight.md). The fleet
 * dev protocol already forbids foreground watches over 30s as prompt
 * discipline — this hook makes that guarantee MECHANICAL, in the same family
 * as the destructive-git detector (#3150): a conservative, deterministic
 * deny on KNOWN-BAD shapes, not a heuristic classifier. False negatives are
 * acceptable; false positives are not — a legitimate medium-length build or
 * test run must never be blocked, so nothing here matches generic
 * build/test commands.
 *
 * Gated shapes (each effectively unbounded — or pure dead time — in the
 * foreground):
 *   - `tail -f` / `tail -F` / `tail --follow`
 *   - `watch <cmd>`
 *   - `sleep N` with N > 30 seconds (bare or as a segment of a compound
 *     command, e.g. `npm run build && sleep 300`)
 *   - sleep-in-a-loop (`while ...; do ...; sleep ...; done`, also until/for)
 *   - `gh pr checks --watch`, `gh run watch`
 *   - `docker logs -f/--follow`, `kubectl logs -f/--follow`, `journalctl -f`
 *
 * The deny message is instructive (reference/principles.md #1): it names the
 * matched pattern and tells the model exactly what to do next — re-run the
 * same command with `run_in_background: true`, or use a bounded alternative.
 *
 * Kill-switch (reference/principles.md #2 — default ON, escape hatch, not
 * opt-in; mirrors `sendGateEnabledFromEnv` in telegram-plugin/send-gate.ts):
 * `SWITCHROOM_FOREGROUND_HOG_GATE=0|false|off|no` disables the gate; unset
 * or any other value keeps it enabled.
 *
 * Session scoping: Claude Code fires PreToolUse hooks for MAIN-session and
 * sub-agent (Task) tool calls alike, with the parent's session_id and no
 * sidechain marker in the payload (see tool-label-pretool.mjs — "Claude Code
 * does not pass sub-agent agent_id directly to the hook"). Main-session-only
 * scoping is therefore NOT expressible at this layer. The pattern list is
 * deliberately limited to shapes that are wrong even inside a worker: an
 * unbounded follower or a >30s dead sleep should be backgrounded or bounded
 * there too (fleet dev protocol: no foreground watches over 30s, anywhere).
 *
 * Claude Code PreToolUse protocol (v1), mirrors hindsight-mental-model-pretool:
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout                       → allow.
 *           exit 0 + {"decision":"block","reason":...}  → block (deny).
 *
 * Fail-OPEN on any stdin parse error / unknown shape: a turn-hygiene gate
 * must never be the reason a legitimate tool call fails. The only non-allow
 * outcome is the explicit deterministic block on a matched shape.
 */

import { readFileSync } from "node:fs";

/**
 * Default-on kill-switch, repo convention (send-gate.ts, midTurnFloorEnabled):
 * enabled unless SWITCHROOM_FOREGROUND_HOG_GATE is explicitly set to a
 * falsey/off value (`0`/`false`/`off`/`no`, case-insensitive, trimmed).
 */
function gateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SWITCHROOM_FOREGROUND_HOG_GATE;
  if (v == null) return true;
  const t = v.trim().toLowerCase();
  return !(t === "0" || t === "false" || t === "off" || t === "no");
}

/**
 * Sleep-in-a-loop across the WHOLE command: a `sleep` between `do` and
 * `done` of a while/until/for loop is a poll loop regardless of the
 * per-tick duration. Ordered match keeps it conservative (`... done &&
 * sleep 5` does not trip it — no `done` after the sleep).
 */
const LOOP_SLEEP =
  /\b(?:while|until|for)\b[\s\S]*?\bdo\b[\s\S]*?\bsleep\b[\s\S]*?\bdone\b/;

/** `sleep` durations: bare seconds or GNU suffixes s/m/h/d. Unparseable
 *  (e.g. `sleep $N`) → null → allow (false negatives are acceptable). */
function sleepSeconds(token: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(token);
  if (!m) return null;
  const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
  return Number(m[1]) * mult;
}

/** A short/combined flag or `--follow` that means "follow" for the follower
 *  commands gated below (tail/docker logs/kubectl logs/journalctl — for all
 *  of them a combined short group containing `f`, e.g. `-xef`, follows). */
function hasFollowFlag(args: readonly string[], allowCapitalF: boolean): boolean {
  return args.some(
    (a) =>
      a === "--follow" ||
      a.startsWith("--follow=") ||
      (/^-[a-zA-Z0-9]+$/.test(a) &&
        (a.includes("f") || (allowCapitalF && a.includes("F")))),
  );
}

/**
 * Split a compound command into its FOREGROUND segments. `&&`/`||`/`;`/`|`/
 * newline separate sequential segments (each holds the turn in sequence); a
 * segment terminated by a single `&` is shell-backgrounded and dropped — it
 * does not hold the turn. Quotes/subshells are not parsed: this is the
 * conservative tokenizer-lite the shape list needs, not a shell parser.
 */
function foregroundSegments(command: string): string[] {
  // fd-duplication redirects (`2>&1`, `>&2`) contain `&` but are not
  // backgrounding — blank them before splitting.
  const cleaned = command.replace(/\d*>&\d*/g, " ");
  const out: string[] = [];
  const sep = /&&|\|\||[;|\n&]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (seg: string, backgrounded: boolean) => {
    const t = seg.trim();
    if (t && !backgrounded) out.push(t);
  };
  while ((m = sep.exec(cleaned)) !== null) {
    push(cleaned.slice(last, m.index), m[0] === "&");
    last = m.index + m[0].length;
  }
  push(cleaned.slice(last), false);
  return out;
}

/** Tokenize one segment down to the actual command + args: strip leading
 *  env assignments, shell keywords, and transparent wrappers. */
function commandTokens(segment: string): string[] {
  const SKIP = new Set([
    "if", "elif", "then", "else", "do", "time", "nohup", "sudo", "command", "exec",
  ]);
  const tokens = segment.split(/\s+/);
  const out: string[] = [];
  let started = false;
  for (const rawTok of tokens) {
    const tok = rawTok.replace(/^[({]+/, "");
    if (!tok) continue;
    if (!started) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // FOO=bar prefix
      if (SKIP.has(tok)) continue;
      started = true;
    }
    out.push(tok);
  }
  return out;
}

/** Match ONE foreground segment against the known-bad shapes. Returns a
 *  human-readable pattern label, or null when the segment is fine. */
function matchSegment(segment: string): string | null {
  const tokens = commandTokens(segment);
  const cmd = tokens[0];
  if (!cmd) return null;
  const args = tokens.slice(1);

  if (cmd === "tail" && hasFollowFlag(args, true)) return "tail -f/--follow";

  if (cmd === "watch") return "watch";

  if (cmd === "sleep") {
    const secs = sleepSeconds(args[0] ?? "");
    if (secs !== null && secs > 30) return `sleep ${args[0]} (> 30s foreground)`;
  }

  if (cmd === "gh") {
    const joined = args.join(" ");
    if (/\bpr\s+checks\b/.test(joined) && args.includes("--watch"))
      return "gh pr checks --watch";
    if (/\brun\s+watch\b/.test(joined)) return "gh run watch";
  }

  if (cmd === "docker" && args[0] === "logs" && hasFollowFlag(args.slice(1), false))
    return "docker logs -f/--follow";

  if (cmd === "kubectl" && args[0] === "logs" && hasFollowFlag(args.slice(1), false))
    return "kubectl logs -f/--follow";

  if (cmd === "journalctl" && hasFollowFlag(args, false)) return "journalctl -f";

  return null;
}

/** The full detector. Returns the matched pattern label or null. */
function detectForegroundHog(command: string): string | null {
  if (LOOP_SLEEP.test(command)) return "sleep in a while/until/for loop";
  for (const segment of foregroundSegments(command)) {
    const hit = matchSegment(segment);
    if (hit) return hit;
  }
  return null;
}

function denyMessage(pattern: string): string {
  return (
    `Foreground-hog gate: \`${pattern}\` would hold the session foreground for its full duration. ` +
    "Re-run this exact command with `run_in_background: true` and act on the completion notification, " +
    "or use a bounded alternative (e.g. `tail -n 200` instead of `tail -f`)."
  );
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow(): never {
  process.exit(0);
}

function block(reason: string): never {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function main(): void {
  if (!gateEnabledFromEnv()) allow();

  const raw = readStdin().trim();
  if (!raw) allow();

  let event: { tool_name?: unknown; tool_input?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    allow(); // Claude protocol error — not ours to police.
  }

  if (event.tool_name !== "Bash") allow();
  const input = event.tool_input;
  if (!input || typeof input !== "object") allow();
  const { run_in_background: runInBackground, command } = input as {
    run_in_background?: unknown;
    command?: unknown;
  };
  if (runInBackground === true) allow(); // backgrounded → never a turn hog
  if (typeof command !== "string" || command.length === 0) allow();

  const pattern = detectForegroundHog(command);
  if (pattern) block(denyMessage(pattern));

  allow();
}

main();
