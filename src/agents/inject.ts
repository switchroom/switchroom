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
 * UX upgrade (epic #725): rather than throwing on every non-happy path,
 * `injectSlashCommandWith` now returns a tagged `InjectResult` whose
 * `outcome` field is one of `ok | ok_no_output | failed`. Validation
 * still throws (it's a programming error to pass an unvalidated cmd
 * down the seam) — but the runtime classification is data, not
 * exceptions, so callers (Telegram handler, CLI) can fan out without
 * re-implementing try/catch dispatch trees.
 *
 * FUTURE GAP — turn-lifecycle idle gate. This implementation always
 * sends keys immediately. If the agent is mid-tool-call (e.g. running
 * a long bash command) the slash inject lands in claude's input buffer
 * but the prompt isn't accepting commands, so the output won't render
 * until the current turn ends. For now, the operator is responsible
 * for timing — Phase 3 / future work will wire this to the turn-end
 * signal and queue or refuse non-idle injects.
 */

import { execFileSync } from "node:child_process";
import { withPaneLock } from "./pane-lock.js";

/**
 * Per-command metadata for the inject allowlist. `expectsOutput` is a
 * hint used to decide whether an empty capture is suspicious (warn) or
 * expected (silent). `silentNote` overrides the empty-capture display
 * for verbs that intentionally render nothing on success.
 *
 * `dialog` — set to `true` for commands that open an interactive TUI
 * dialog or picker in Claude Code v2.1.185+ (e.g. the usage dialog
 * opened by `/cost`, the Settings/Status dialog opened by `/status`).
 * When true, `injectSlashCommandWith` sends an Escape key AFTER
 * capturing the dialog's content so the pane is returned to a clean `❯`
 * prompt. Without this, the dialog stays open and the user's next
 * Telegram message is swallowed by the modal — silent message loss.
 * (#2566)
 */
export interface InjectCommandMeta {
  description: string;
  expectsOutput: boolean;
  silentNote?: string;
  /** True when injecting this command opens an interactive dialog/picker
   * that must be dismissed with Escape after capture. */
  dialog?: boolean;
}

/**
 * Hard-coded set of injectable slash commands. Read-only commands that
 * render information without mutating Claude's auth/session state. Add
 * with care — every entry expands the surface area of inject calls.
 */
export const INJECT_COMMANDS: ReadonlyMap<string, InjectCommandMeta> = new Map([
  // dialog:true — on Claude Code v2.1.185+, these commands open an
  // interactive TUI dialog (the usage dialog for /cost and /usage; the
  // Settings/Status tab-bar dialog for /status; a hooks dialog for /hooks).
  // injectSlashCommandWith sends Escape after capturing the dialog content
  // to dismiss the modal and restore a clean ❯ prompt. (#2566)
  ["/cost", { description: "Show session cost", expectsOutput: true, dialog: true }],
  ["/status", { description: "Show session status", expectsOutput: true, dialog: true }],
  ["/usage", { description: "Show plan quota", expectsOutput: true, dialog: true }],
  ["/hooks", { description: "List configured hooks", expectsOutput: true, dialog: true }],
  // #2566 — `/memory` is raw-injected (no dedicated driver) and on Claude
  // Code v2.1.185+ opens an interactive memory-file picker. It rides the
  // same dialog:true Escape-dismiss path: inject types `/memory` + Enter
  // (which OPENS the picker — it does not select a row), captures the
  // picker content, then sends Escape to CANCEL. No row is ever selected
  // (inject sends no arrow keys / no second Enter), so the dismiss is
  // side-effect-free — same safety profile as the /cost & /status dialogs.
  ["/memory", { description: "Open memory picker", expectsOutput: true, dialog: true }],
  // #2566 — `/model` stays on the allowlist with NO dialog flag. It is
  // NOT raw-injected from Telegram: the dedicated driver
  // (telegram-plugin/gateway/model-command.ts) intercepts every `/model`
  // message. Bare `/model` renders a dashboard (no inject); `/model <name>`
  // injects `/model <alias>` WITH AN ARGUMENT — a direct set that opens no
  // picker. The set path depends on `/model` being allowlisted (enforced by
  // model-command.test.ts "inject allowlist contract"), so it must not move
  // to the blocklist and needs no Escape handling.
  ["/model", { description: "Open model picker", expectsOutput: true }],
  // #2471 — `/effort` was previously listed here as an allowlisted inject,
  // but injecting it surfaces a blocking "Change effort level? 1. Yes /
  // 2. No" confirmation modal that an agent/headless session can't answer,
  // wedging the turn. It now lives ONLY in INJECT_BLOCKED — effort is set
  // non-interactively via the `--effort` CLI flag at session start.
  [
    "/clear",
    {
      description: "Clear session screen",
      expectsOutput: false,
      silentNote: "context cleared — fresh slate",
    },
  ],
  [
    "/compact",
    {
      description: "Compact conversation history",
      expectsOutput: false,
      silentNote: "compaction runs silently",
    },
  ],
]);

/**
 * Backwards-compat: a few callers (and tests) still want a plain Set of
 * allowed verbs. Derived from `INJECT_COMMANDS` so the two never drift.
 */
export const INJECT_ALLOWLIST: ReadonlySet<string> = new Set(INJECT_COMMANDS.keys());

export interface InjectBlockedMeta {
  reason: string;
}

/**
 * Commands explicitly refused with a `blocked` (vs `not_allowed`) error
 * code so the caller can surface a clearer message. These are the
 * destructive / session-ending commands an operator must never trigger
 * from a remote surface.
 */
export const INJECT_BLOCKED: ReadonlyMap<string, InjectBlockedMeta> = new Map([
  ["/login", { reason: "would mutate auth state" }],
  ["/logout", { reason: "would terminate the agent's auth session" }],
  ["/exit", { reason: "would kill the agent process" }],
  ["/quit", { reason: "would kill the agent process" }],
  // #2471 — `/effort` opens a blocking "Change effort level? 1. Yes / 2.
  // No" confirmation modal whenever the session has a cached conversation.
  // The RAW inject primitive types the command and walks away, leaving the
  // modal open with no human to answer it — which wedges the pane (the
  // Stop hook then errors "0/6" and the session spins "Manifesting"
  // forever). Effort has a DEDICATED, modal-driving path:
  // `applyEffort` (src/agents/effort-picker.ts), wired to the `/effort`
  // Telegram command and its inline-keyboard menu, which confirms or
  // cancels the modal so it never lingers. So `/effort` must NOT ride the
  // bare inject allowlist — it lives here in the blocklist, routing
  // operators to the proper command. (Boot effort is set non-interactively
  // via the `--effort` CLI flag, start.sh.hbs `{{thinkingEffort}}`.)
  [
    "/effort",
    {
      reason:
        "leaves a blocking confirmation modal open and wedges the pane; use the /effort command (it drives the modal), not raw inject",
    },
  ],
]);

/**
 * Backwards-compat Set view over the blocklist keys.
 */
export const INJECT_BLOCKLIST: ReadonlySet<string> = new Set(INJECT_BLOCKED.keys());

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

/**
 * Three outcomes only:
 *  - `ok` — non-empty capture; render output to the user.
 *  - `ok_no_output` — send-keys completed, capture empty. Could be
 *    expected (e.g. `/clear`) or suspicious (`/cost` with no output).
 *  - `failed` — validation rejected, session missing, or send-keys
 *    threw. `errorCode` and `errorMessage` carry the reason.
 *
 * Classification is derived from runtime capture, not from
 * `expectsOutput` — that field is a UX hint only.
 */
export type InjectOutcome = "ok" | "ok_no_output" | "failed";

export type InjectDiagnostic =
  | "anchor_missing"
  | "truncated_output"
  | "timeout"
  | "modal_partial";

export interface InjectResult {
  outcome: InjectOutcome;
  /** Empty for `ok_no_output` and `failed`. */
  output: string;
  truncated: boolean;
  /** Bare verb (e.g. `/cost`). Empty for `failed` w/ invalid input. */
  command: string;
  /** Allowlist metadata; null when the call failed before validation. */
  meta: InjectCommandMeta | null;
  diagnostic?: InjectDiagnostic;
  /** Set on `failed` outcomes. */
  errorCode?: InjectErrorCode;
  /** Short user-facing message for `failed` outcomes. */
  errorMessage?: string;
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
  const blockedMeta = INJECT_BLOCKED.get(bare);
  if (blockedMeta) {
    throw new InjectError(
      "blocked",
      `${bare} is explicitly blocked from inject (${blockedMeta.reason}).`,
    );
  }
  if (!INJECT_COMMANDS.has(bare)) {
    const allowed = [...INJECT_COMMANDS.keys()].sort().join(", ");
    throw new InjectError(
      "not_allowed",
      `${bare} is not in the inject allowlist. Allowed: ${allowed}`,
    );
  }
  return bare;
}

/**
 * Normalize a slash command for dedupe comparison: trim, collapse
 * internal whitespace, lowercase. `/effort  high` and `/EFFORT high`
 * collapse to the same key so re-injected duplicates are recognised
 * regardless of casing or spacing noise.
 */
export function normalizeInjectCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * #2471 — collapse a queue of injected slash commands so the same
 * command stacking up N times reduces to a single send. This guards the
 * raw-inject / programmatic path (the one that bypasses
 * {@link validateInjectCommand}) against the failure observed in #2471,
 * where repeated identical `/effort high` injections piled up and each
 * re-armed the blocking modal.
 *
 * Semantics:
 *   - Order-preserving: the FIRST occurrence of each distinct command
 *     keeps its position; later exact duplicates are dropped.
 *   - "Distinct" is by {@link normalizeInjectCommand} (case- and
 *     whitespace-insensitive), so `/effort high` and `/EFFORT  high`
 *     are treated as the same command.
 *   - Empty / whitespace-only entries are dropped.
 *
 * This is intentionally a pure list transform with no tmux side-effects
 * so it is trivially unit-testable and reusable by any caller that holds
 * a backlog of queued injects.
 */
export function dedupeInjectQueue(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of commands) {
    if (typeof raw !== "string") continue;
    const key = normalizeInjectCommand(raw);
    if (key.length === 0) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw.trim());
  }
  return out;
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
 * Result of {@link diffPane}. `anchored` is true when the diff was
 * computed against the command-echo line in the post-capture; false
 * when the function fell back to line-set diff against `before`.
 * Callers use the flag to set the `anchor_missing` diagnostic when
 * the fallback also yielded no output.
 */
export interface DiffPaneResult {
  output: string;
  anchored: boolean;
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

/**
 * Returns true for lines that are pure Claude Code TUI chrome — input-box
 * borders, prompt glyphs, footer hints, and copy affordances that appear
 * after `/clear` wipes the screen. Applied only in the FALLBACK (anchor-
 * missing) path of `diffPane` to prevent input-box furniture from being
 * classified as command output. Conservative by design: a real output line
 * (e.g. "Total cost: $1.23") must never match.
 *
 * Patterns matched:
 *   - box-drawing / rule lines: only border/rule glyphs, underscores, dashes, pipes
 *   - bare prompt glyphs: trimmed content is only `>`, `)`, or `❯` (with optional box chars)
 *   - footer hints: lines containing the known footer phrases
 *   - copy affordance: trimmed content is exactly "copy"
 */
export function isTuiChromeLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;

  // box-drawing / rule lines: only border glyphs, underscores, dashes, pipes, spaces
  if (/^[\s\-_│─╭╮╰╯┌┐└┘|]+$/.test(t)) return true;

  // bare prompt-glyph lines
  if (/^[╭╮╰╯│\s]*[>)❯][╭╮╰╯│\s]*$/.test(t)) return true;

  // footer hints
  if (/accept edits on/i.test(t)) return true;
  if (/shift\+tab to cycle/i.test(t)) return true;
  if (/for agents/i.test(t)) return true;
  if (/\? for shortcuts/i.test(t)) return true;
  if (/bypassing permissions/i.test(t)) return true;

  // copy affordance
  if (t === "copy") return true;

  return false;
}

export function diffPane(before: string, after: string, command?: string): DiffPaneResult {
  if (command) {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lines = after.split("\n");
    let anchorIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/[❯>]\s+/.test(lines[i]) && lines[i].includes(escaped)) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx >= 0) {
      const tail = lines.slice(anchorIdx + 1);
      const trimmed: string[] = [];
      for (const raw of tail) {
        const line = raw.trimEnd();
        if (line.length === 0 && trimmed.length === 0) continue;
        if (isTuiChromeLine(line)) continue;
        trimmed.push(line);
      }
      while (trimmed.length > 0 && trimmed[trimmed.length - 1].length === 0) {
        trimmed.pop();
      }
      const affordances = /^(esc to cancel|press any key|↵ select)/i;
      while (trimmed.length > 0 && affordances.test(trimmed[trimmed.length - 1].trim())) {
        trimmed.pop();
      }
      if (trimmed.length > 0) {
        return { output: trimmed.join("\n"), anchored: true };
      }
      // Anchor found but tail is empty — fall through to set-diff.
    }
  }
  // Fallback: line-set diff against pre-snapshot, then strip TUI chrome.
  // Chrome is also filtered in the anchored path above; both paths strip it
  // so that `/clear`'s input-box furniture never reaches Telegram regardless
  // of whether the command-echo anchor is present in the post-capture.
  const beforeSet = new Set(before.split("\n").map((l) => l.trimEnd()));
  const newLines: string[] = [];
  for (const raw of after.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (beforeSet.has(line)) continue;
    if (isTuiChromeLine(line)) continue;
    newLines.push(line);
  }
  return { output: newLines.join("\n"), anchored: false };
}

/**
 * Inject a slash command into an agent's tmux pane. Returns an
 * `InjectResult` describing the outcome — never throws for runtime
 * problems (session missing, send-keys failure). Validation errors
 * still throw `InjectError` because they indicate a caller bug.
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

  // Serialize against every other drive on this pane (other injects,
  // the /model picker driver) — see src/agents/pane-lock.ts. An
  // inject's Enter landing while another drive's modal is open would
  // act as that modal's confirm key.
  return withPaneLock(`${socket}:${session}`, () =>
    injectSlashCommandWith(makeTmuxRunner(tmuxBin), {
      socket,
      session,
      command: command.trim(),
      settleMs,
      timeoutMs,
    }),
  );
}

/**
 * Test seam. Same logic as `injectSlashCommand` but takes a pre-built
 * `TmuxRunner` so unit tests can fake the tmux subprocess.
 *
 * Classification rules:
 *   - validation/session/send-keys failure  → outcome=`failed`
 *   - non-empty captured output             → outcome=`ok`
 *   - empty output, send-keys completed     → outcome=`ok_no_output`
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

  // Re-validate so the seam itself enforces the contract. The bare
  // verb is what we'll surface in `result.command` / lookup metadata.
  let bareVerb: string;
  try {
    bareVerb = validateInjectCommand(command);
  } catch (err) {
    if (err instanceof InjectError) {
      return {
        outcome: "failed",
        output: "",
        truncated: false,
        command: command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "",
        meta: null,
        errorCode: err.code,
        errorMessage: err.message,
      };
    }
    throw err;
  }
  const meta = INJECT_COMMANDS.get(bareVerb) ?? null;

  if (!runner.hasSession(socket, session)) {
    return {
      outcome: "failed",
      output: "",
      truncated: false,
      command: bareVerb,
      meta,
      errorCode: "session_missing",
      errorMessage:
        `tmux session "${session}" on socket "${socket}" not found. ` +
        `Is the agent running under the tmux supervisor (the default)? ` +
        `If experimental.legacy_pty=true is set, inject is unsupported.`,
    };
  }

  const before = runner.capture(socket, session) ?? "";

  // Two-step send-keys: literal command body (so `/` survives without
  // tmux key-name interpretation), then Enter as a key name. Mirrors
  // the existing pattern in src/auth/manager.ts (the auth-code paste).
  try {
    runner.send(socket, session, ["send-keys", "-l", command]);
    runner.send(socket, session, ["send-keys", "Enter"]);
  } catch (err) {
    return {
      outcome: "failed",
      output: "",
      truncated: false,
      command: bareVerb,
      meta,
      errorCode: "tmux_failed",
      errorMessage: `tmux send-keys failed: ${err instanceof Error ? err.message : String(err)}`,
    };
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
        last = cur;
        break;
      }
    } else {
      stableSince = null;
    }
    last = cur;
    if (Date.now() - start >= settleMs && cur !== before) {
      break;
    }
  }

  const { output: rawOutput, anchored } = diffPane(before, last, command);
  let output = rawOutput;
  let truncated = false;
  const bytes = Buffer.byteLength(output, "utf-8");
  if (bytes > OUTPUT_BYTE_CAP) {
    while (Buffer.byteLength(output, "utf-8") > OUTPUT_BYTE_CAP) {
      output = output.slice(Math.floor(output.length * 0.1) + 1);
    }
    truncated = true;
  }

  // #2566 — Dialog dismissal. Commands marked `dialog:true` open an
  // interactive TUI modal (usage dialog, Settings/Status tab-bar, etc.)
  // that stays open after output is rendered. Send Escape to dismiss it
  // AFTER capturing so the dialog content is returned to Telegram but the
  // pane is left on a clean ❯ prompt for the user's next message.
  //
  // The send is in a try/catch with the same degraded-gracefully posture
  // as the original send-keys above: a tmux failure here does NOT
  // promote to a `failed` outcome — the output was already captured and
  // is valid. The failure is silently swallowed so a rare tmux glitch
  // on the dismiss step doesn't discard the captured content.
  if (meta?.dialog) {
    try {
      runner.send(socket, session, ["send-keys", "Escape"]);
    } catch {
      // Degrade gracefully — the content was already captured.
    }
  }

  if (output.trim().length === 0) {
    return {
      outcome: "ok_no_output",
      output: "",
      truncated: false,
      command: bareVerb,
      meta,
      ...(anchored ? {} : { diagnostic: "anchor_missing" as const }),
    };
  }

  return {
    outcome: "ok",
    output,
    truncated,
    command: bareVerb,
    meta,
    ...(truncated ? { diagnostic: "truncated_output" as const } : {}),
  };
}
