/**
 * #725 Phase 2 — slash-command injection primitive.
 *
 * Lets an operator type a Claude Code REPL slash command (e.g. `/cost`)
 * via Telegram or the CLI; this module shells out to `tmux send-keys`
 * against the agent's supervised pane and captures the rendered output
 * by diffing pane snapshots taken before and after the inject.
 *
 * Allowlist-only by design: the set of accepted commands is hard-coded
 * (no user override) so a compromised Telegram chat / typo can't issue
 * destructive verbs like `/login`, `/logout`, `/exit`, `/quit`. The
 * blocklist exists purely to give a more specific error message for
 * those four — anything else outside the allowlist returns `not_allowed`.
 *
 * FUTURE GAP — turn-lifecycle idle gate. This implementation always
 * sends keys immediately. If the agent is mid-tool-call (e.g. running
 * a long bash command) the slash inject lands in claude's input buffer
 * but the prompt isn't accepting commands, so the output won't render
 * until the current turn ends. For now, the operator is responsible
 * for timing — Phase 3 / future work will wire this to the turn-end
 * signal and queue or refuse non-idle injects.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Hard-coded set of injectable slash commands. Read-only commands that
 * render information without mutating Claude's auth/session state. Add
 * with care — every entry expands the surface area of inject calls.
 */
export const INJECT_ALLOWLIST: ReadonlySet<string> = new Set([
  "/cost",
  "/status",
  "/model",
  "/clear",
  "/compact",
  "/memory",
  "/hooks",
  "/usage",
]);

/**
 * Commands explicitly refused with a `blocked` (vs `not_allowed`) error
 * code so the caller can surface a clearer message. These are the
 * destructive / session-ending commands an operator must never trigger
 * from a remote surface.
 */
export const INJECT_BLOCKLIST: ReadonlySet<string> = new Set([
  "/login",
  "/logout",
  "/exit",
  "/quit",
]);

export type InjectErrorCode =
  | "not_allowed"
  | "blocked"
  | "session_missing"
  | "invalid"
  | "timeout"
  | "tmux_failed";

export class InjectError extends Error {
  code: InjectErrorCode;
  constructor(code: InjectErrorCode, message: string) {
    super(message);
    this.name = "InjectError";
    this.code = code;
  }
}

export interface InjectOpts {
  /** tmux binary path. Defaults to `tmux` on PATH. */
  tmuxBin?: string;
  /** tmux session name. Defaults to the agent name (matches systemd unit). */
  sessionName?: string;
  /** tmux socket name. Defaults to `switchroom-${agentName}`. */
  socketName?: string;
  /**
   * Wait window for the pane buffer to settle (ms). The poller checks
   * every ~150ms and considers the pane stable when two consecutive
   * captures are equal. Default 2000ms.
   */
  settleMs?: number;
  /** Hard upper bound on total wait (ms). Default 5000ms. */
  timeoutMs?: number;
}

export interface InjectResult {
  output: string;
  truncated: boolean;
}

const POLL_INTERVAL_MS = 150;
const OUTPUT_BYTE_CAP = 3000;

/**
 * Validate a raw slash command. Returns the lowercased bare verb on
 * success, throws `InjectError` otherwise.
 */
export function validateInjectCommand(command: string): string {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new InjectError("invalid", "command is empty");
  }
  const trimmed = command.trim();
  if (!trimmed.startsWith("/")) {
    throw new InjectError("invalid", `command must start with "/": got ${trimmed}`);
  }
  const bare = trimmed.split(/\s+/, 1)[0].toLowerCase();
  // Block first so /login etc. get the more specific message.
  if (INJECT_BLOCKLIST.has(bare)) {
    throw new InjectError(
      "blocked",
      `${bare} is explicitly blocked from inject (would mutate session/auth state).`,
    );
  }
  if (!INJECT_ALLOWLIST.has(bare)) {
    throw new InjectError(
      "not_allowed",
      `${bare} is not in the inject allowlist. Allowed: ${[...INJECT_ALLOWLIST].sort().join(", ")}`,
    );
  }
  return bare;
}

function defaultSocketName(agentName: string): string {
  return `switchroom-${agentName}`;
}

export interface TmuxRunner {
  capture(socket: string, session: string): string | null;
  send(socket: string, session: string, args: string[]): void;
  hasSession(socket: string, session: string): boolean;
}

/**
 * Build a TmuxRunner backed by the real `tmux` binary at `tmuxBin`.
 *
 * Exported (vs the original module-private factory) so integration
 * tests can drive the same splice logic as production rather than
 * hand-constructing argv via `spawnSync`. A regression of the #728
 * splice fix should be observable through `runner.send` — the unit
 * test mocks the runner, so it can't see that.
 */
export function makeTmuxRunner(tmuxBin: string): TmuxRunner {
  return {
    capture(socket, session) {
      try {
        return execFileSync(
          tmuxBin,
          ["-L", socket, "capture-pane", "-p", "-t", session, "-S", "-200"],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch {
        return null;
      }
    },
    send(socket, session, args) {
      // tmux send-keys grammar: `send-keys [-l] [-t target] keys...`. The -t
      // flag must come BEFORE the keys, otherwise -l treats `-t session` as
      // additional literal text and types it into the pane (e.g. `/cost`
      // becomes `/cost-tgymbro` keystrokes). Splice -t after the subcommand
      // name and any leading flags, before the positional key args.
      const [subcmd, ...rest] = args;
      const flagEnd = rest.findIndex((a) => !a.startsWith("-"));
      const flagsBeforeKeys = flagEnd === -1 ? rest : rest.slice(0, flagEnd);
      const keys = flagEnd === -1 ? [] : rest.slice(flagEnd);
      execFileSync(
        tmuxBin,
        ["-L", socket, subcmd, ...flagsBeforeKeys, "-t", session, ...keys],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    },
    hasSession(socket, session) {
      try {
        execFileSync(tmuxBin, ["-L", socket, "has-session", "-t", session], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Extract the response to a slash command from a post-inject pane
 * capture. We anchor on the LAST occurrence of Claude's prompt-echo
 * line for the command (`❯ <command>` — Ink renders the user's input
 * with that arrow glyph) and return everything below it, trimming
 * trailing modal-affordance lines like `Esc to cancel`.
 *
 * Why anchor instead of line-set diff against the pre-snapshot? When
 * the same slash command has been issued recently, the prior render's
 * lines are still in pane scrollback. A line-set diff filters those
 * "duplicate" lines out and returns empty — even though the user just
 * fired the command and got a fresh response. Anchoring on the
 * command-echo line in the post-capture is positional and immune to
 * scrollback pollution.
 *
 * The pre-snapshot is now used only as a fallback signal: if no
 * command-echo anchor is found in the post-capture, fall back to
 * line-set diff so unusual TUI shapes still surface something.
 */
export function diffPane(before: string, after: string, command?: string): string {
  if (command) {
    // Build a regex that tolerates Ink's right-arrow input prefix and
    // any leading whitespace; match exact command verb plus optional
    // args (we already validated allowlist/blocklist upstream).
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lines = after.split("\n");
    let anchorIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      // Match `❯ /command` or `> /command` (some terminals render it
      // differently). Allow trailing args. Strict-anchor at end of
      // line to avoid catching the prompt that contains the command
      // as a substring inside narrative text.
      if (/[❯>]\s+/.test(lines[i]) && lines[i].includes(escaped)) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx >= 0) {
      const tail = lines.slice(anchorIdx + 1);
      // Trim leading and trailing blank lines, and drop common
      // modal-affordance footers that aren't part of the response.
      const trimmed: string[] = [];
      for (const raw of tail) {
        const line = raw.trimEnd();
        if (line.length === 0 && trimmed.length === 0) continue;
        trimmed.push(line);
      }
      while (trimmed.length > 0 && trimmed[trimmed.length - 1].length === 0) {
        trimmed.pop();
      }
      // Drop trailing affordance lines (case-insensitive). These are
      // Ink modal hints that aren't part of the slash output.
      const affordances = /^(esc to cancel|press any key|↵ select)/i;
      while (trimmed.length > 0 && affordances.test(trimmed[trimmed.length - 1].trim())) {
        trimmed.pop();
      }
      if (trimmed.length > 0) {
        return trimmed.join("\n");
      }
      // Anchor found but tail is empty — fall through to set-diff.
    }
  }
  // Fallback: line-set diff against pre-snapshot.
  const beforeSet = new Set(before.split("\n").map((l) => l.trimEnd()));
  const newLines: string[] = [];
  for (const raw of after.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (beforeSet.has(line)) continue;
    newLines.push(line);
  }
  return newLines.join("\n");
}

/**
 * Inject a slash command into an agent's tmux pane. Returns the diff
 * of new lines that appeared in the pane after the inject.
 *
 * Suitable execution states: agent prompt is idle (not mid-tool-call).
 * See FUTURE GAP comment at the top of this file.
 */
export async function injectSlashCommand(
  agentName: string,
  command: string,
  opts: InjectOpts = {},
): Promise<InjectResult> {
  validateInjectCommand(command);

  const tmuxBin = opts.tmuxBin ?? "tmux";
  const socket = opts.socketName ?? defaultSocketName(agentName);
  const session = opts.sessionName ?? agentName;
  const settleMs = opts.settleMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 5000;

  return injectSlashCommandWith(makeTmuxRunner(tmuxBin), {
    socket,
    session,
    command: command.trim(),
    settleMs,
    timeoutMs,
  });
}

/**
 * Test seam. Same logic as `injectSlashCommand` but takes a pre-built
 * `TmuxRunner` so unit tests can fake the tmux subprocess.
 */
export async function injectSlashCommandWith(
  runner: TmuxRunner,
  args: {
    socket: string;
    session: string;
    command: string;
    settleMs: number;
    timeoutMs: number;
  },
): Promise<InjectResult> {
  const { socket, session, command, settleMs, timeoutMs } = args;

  if (!runner.hasSession(socket, session)) {
    throw new InjectError(
      "session_missing",
      `tmux session "${session}" on socket "${socket}" not found. Is the agent running with experimental.tmux_supervisor=true?`,
    );
  }

  const before = runner.capture(socket, session) ?? "";

  // Two-step send-keys: literal command body (so `/` survives without
  // tmux key-name interpretation), then Enter as a key name. Mirrors
  // the existing pattern in src/auth/manager.ts (the auth-code paste).
  try {
    runner.send(socket, session, ["send-keys", "-l", command]);
    runner.send(socket, session, ["send-keys", "Enter"]);
  } catch (err) {
    throw new InjectError(
      "tmux_failed",
      `tmux send-keys failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Poll capture-pane every POLL_INTERVAL_MS until two consecutive
  // captures match (= buffer settled) OR timeoutMs elapses. settleMs
  // bounds how long we're willing to wait for that stable read; if the
  // pane is still changing past settleMs we accept whatever's there.
  const start = Date.now();
  let last = before;
  let stableSince: number | null = null;
  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);
    const cur = runner.capture(socket, session) ?? "";
    if (cur === last && cur !== before) {
      if (stableSince === null) {
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= POLL_INTERVAL_MS) {
        // Two consecutive equal captures past the first stable mark —
        // good enough.
        last = cur;
        break;
      }
    } else {
      stableSince = null;
    }
    last = cur;
    if (Date.now() - start >= settleMs && cur !== before) {
      // Past the settle window with at least one change — return what
      // we have rather than burning to the hard timeout.
      break;
    }
  }

  let output = diffPane(before, last, command);
  let truncated = false;
  const bytes = Buffer.byteLength(output, "utf-8");
  if (bytes > OUTPUT_BYTE_CAP) {
    // Trim from the front; the tail is more interesting (the result of
    // the command, not the echoed prompt).
    while (Buffer.byteLength(output, "utf-8") > OUTPUT_BYTE_CAP) {
      output = output.slice(Math.floor(output.length * 0.1) + 1);
    }
    truncated = true;
  }

  return { output, truncated };
}

// Avoid unused-import warning when execFileAsync is reserved for
// future async refactor. Re-exported so callers that want the promise
// form can grab it.
export const _execFileAsync = execFileAsync;
