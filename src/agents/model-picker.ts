/**
 * Claude CLI `/model` picker driver — discovery + selection over tmux.
 *
 * The Telegram `/model` menu must list whatever models the *installed*
 * claude CLI offers, without hardcoding names that go stale when
 * Anthropic ships new models. The only durable source of that list is
 * claude's own `/model` picker, so this module drives it:
 *
 *   discoverModels()  open picker → parse the rendered option rows →
 *                     ALWAYS Esc out (verified) → return the options.
 *   selectModel()     open picker → parse → arrow-key the cursor to the
 *                     target row (matched by label, never by stale
 *                     index) → press `s` (session-only apply) → capture
 *                     claude's confirmation. Esc + bail on any mismatch.
 *
 * Validated against claude 2.1.170's picker (2026-06-10, test-harness):
 *
 *     Select model
 *     Switch between Claude models. Your pick becomes the default ...
 *
 *       1. Default (recommended)  Opus 4.8 with 1M context · Best for
 *                                 everyday, complex tasks
 *     ❯ 2. Sonnet ✔               Sonnet 5 · Efficient for routine tasks
 *       3. Haiku                  Haiku 4.5 · Fastest for quick answers
 *
 *     ○ Low effort ←/→ to adjust
 *
 *     Enter to set as default · s to use this session only · Esc to cancel
 *
 * Semantics: `✔` marks the current model, `❯` the cursor (which starts
 * on the current row), wrapped descriptions continue on indented lines,
 * and the footer's "Esc to cancel" is the fully-rendered signal. We
 * press `s` (session-only) rather than Enter — Enter writes claude's
 * own settings default, which switchroom's scaffold overwrites on the
 * next reconcile anyway; session-only keeps one source of persistent
 * truth (`model:` in switchroom.yaml).
 *
 * Safety invariants (pinned by tests/model-picker.test.ts):
 *   - The picker is NEVER left open: every exit path of both verbs
 *     sends Escape unless a selection keypress already dismissed it,
 *     and dismissal is verified by re-capture (retry Esc once).
 *   - Selection navigates relative to the parsed cursor and re-verifies
 *     the cursor row label before pressing `s` — a pane that shifted
 *     between parse and keypress aborts instead of selecting blind.
 */

import { makeTmuxRunner, type TmuxRunner } from "./inject.js";
import { withPaneLock } from "./pane-lock.js";

export interface ModelPickerOption {
  /** 1-based number as rendered by the picker. */
  index: number;
  /** Row label, e.g. "Default (recommended)", "Sonnet" — ✔ stripped. */
  label: string;
  /** First-line description column (continuations appended). */
  detail: string;
  /** True for the row carrying the ✔ current-model marker. */
  current: boolean;
}

export interface ParsedModelPicker {
  options: ModelPickerOption[];
  /** 1-based index of the row the ❯ cursor sits on; -1 if not seen. */
  cursorIndex: number;
  /** True when the "Esc to cancel" footer rendered (modal complete). */
  footerSeen: boolean;
}

const HEADER_RE = /Select model/;
const OPTION_RE = /^\s*(❯)?\s*(\d+)\.\s+(.*)$/;
const FOOTER_RE = /Esc to cancel/i;
const EFFORT_RE = /^\s*○\s/;

/**
 * Parse the LAST rendered `/model` picker out of a pane capture.
 * Anchoring on the last "Select model" occurrence makes the parse
 * immune to older pickers still sitting in scrollback. Returns null
 * when no picker (or no option rows) is found.
 */
export function parseModelPicker(pane: string): ParsedModelPicker | null {
  const lines = pane.split("\n");
  let headerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADER_RE.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return null;

  const options: ModelPickerOption[] = [];
  let cursorIndex = -1;
  let footerSeen = false;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (FOOTER_RE.test(raw)) {
      footerSeen = true;
      break;
    }
    if (EFFORT_RE.test(raw)) continue; // effort selector row — not an option
    const m = OPTION_RE.exec(raw);
    if (m) {
      const index = Number(m[2]);
      // Split label from the description column on a run of 2+ spaces.
      // Labels contain single spaces ("Default (recommended)"); the
      // picker aligns the description with a wide gap.
      const rest = m[3].trimEnd();
      const gap = rest.search(/\s{2,}/);
      let label = (gap >= 0 ? rest.slice(0, gap) : rest).trim();
      const detail = gap >= 0 ? rest.slice(gap).trim() : "";
      let current = false;
      if (/[✔✓]$/.test(label)) {
        current = true;
        label = label.replace(/\s*[✔✓]$/, "").trim();
      }
      if (label.length === 0) continue;
      options.push({ index, label, detail, current });
      if (m[1]) cursorIndex = index;
      continue;
    }
    // Wrapped description continuation: indented, after at least one
    // option, no option-number shape. Append to the last option.
    if (options.length > 0 && /^\s{4,}\S/.test(raw)) {
      const last = options[options.length - 1];
      last.detail = `${last.detail} ${raw.trim()}`.trim();
      continue;
    }
    // Header description lines before the first option — skip.
  }

  if (options.length === 0) return null;
  return { options, cursorIndex, footerSeen };
}

/** Stable 8-hex tag for a label — used as Telegram callback identity. */
export function labelTag(label: string): string {
  // FNV-1a 32-bit; tiny, deterministic, dependency-free. Collisions
  // across a <10-row picker are practically impossible, and a stale
  // tag merely fails the match (re-render), never selects a wrong row.
  let h = 0x811c9dc5;
  for (const ch of label) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface PickerOpts {
  tmuxBin?: string;
  socketName?: string;
  sessionName?: string;
  /** Per-step settle wait (ms). Default 600. */
  stepMs?: number;
  /** Hard ceiling on the whole operation (ms). Default 12000 (#3241 — raised
   *  from 10000 to leave room for one dismiss-and-retry when an async access
   *  banner pushes the picker footer out of the first render window). */
  timeoutMs?: number;
  /** Test seam — injected runner + sleep + logger. */
  _runner?: TmuxRunner;
  _sleep?: (ms: number) => Promise<void>;
  _log?: (line: string) => void;
}

export type DiscoverResult =
  | {
      ok: true;
      options: ModelPickerOption[];
      currentLabel: string | null;
      /** Esc + verify failed twice — the modal may still be open. */
      dismissFailed?: true;
    }
  | { ok: false; reason: string; dismissFailed?: true };

export type SelectResult =
  | { ok: true; confirmation: string }
  | { ok: false; reason: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Io {
  runner: TmuxRunner;
  socket: string;
  session: string;
  stepMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  startedAt: number;
}

function makeIo(agentName: string, opts: PickerOpts): Io {
  return {
    runner: opts._runner ?? makeTmuxRunner(opts.tmuxBin ?? "tmux"),
    socket: opts.socketName ?? `switchroom-${agentName}`,
    session: opts.sessionName ?? agentName,
    stepMs: opts.stepMs ?? 600,
    timeoutMs: opts.timeoutMs ?? 12_000,
    sleep: opts._sleep ?? realSleep,
    log: opts._log ?? ((line) => process.stderr.write(`${line}\n`)),
    startedAt: Date.now(),
  };
}

/**
 * Dismiss + loudly report a failure. A false return means two
 * Esc+verify rounds could not confirm the modal closed — the
 * /rate-limit-options wedge class. The gateway log is the fleet's
 * wedge forensics surface, so this must never fail silently.
 */
async function dismissOrWarn(io: Io, verb: string): Promise<boolean> {
  const dismissed = await dismissPicker(io);
  if (!dismissed) {
    io.log(
      `model-picker: ${verb}: picker may still be open after Esc retries ` +
        `(socket=${io.socket} session=${io.session}) — pane needs eyes`,
    );
  }
  return dismissed;
}

function expired(io: Io): boolean {
  return Date.now() - io.startedAt >= io.timeoutMs;
}

function sendLiteral(io: Io, text: string): void {
  io.runner.send(io.socket, io.session, ["send-keys", "-l", text]);
}

function sendKey(io: Io, key: string): void {
  io.runner.send(io.socket, io.session, ["send-keys", key]);
}

/**
 * Open the picker and poll until it parses with a rendered footer. Bounded by
 * `deadlineMs` (absolute epoch ms) when supplied — used by
 * {@link openPickerWithRetry} to reserve budget for a second attempt — else by
 * the overall operation timeout.
 */
async function openPicker(io: Io, deadlineMs?: number): Promise<ParsedModelPicker | null> {
  sendLiteral(io, "/model");
  sendKey(io, "Enter");
  // Poll for the fully-rendered modal (footer visible). The picker
  // typically renders in well under a second; the loop is bounded by
  // the per-attempt deadline (if any) and the overall timeout.
  for (;;) {
    await io.sleep(io.stepMs);
    const pane = io.runner.capture(io.socket, io.session) ?? "";
    const parsed = parseModelPicker(pane);
    if (parsed?.footerSeen) return parsed;
    if ((deadlineMs != null && Date.now() >= deadlineMs) || expired(io)) {
      return parsed; // best parse we got (may be null)
    }
  }
}

/**
 * Open the picker, and if the first render doesn't produce a footer-complete
 * modal, dismiss any half-rendered interstitial with Escape and retry ONCE
 * (#3241 symptom 3). Anthropic's async "extending Claude … access" banner can
 * render inside the `/model` region and push the "Esc to cancel" footer out of
 * the initial poll window; the retry re-opens against a settled pane. Bounded
 * by the same overall timeout — the retry is skipped once the budget is spent.
 */
async function openPickerWithRetry(io: Io): Promise<ParsedModelPicker | null> {
  // Reserve budget for a second attempt: the first open gets HALF the remaining
  // time (floored at a couple of poll steps) so a dismiss-and-retry has room.
  const remaining = io.timeoutMs - (Date.now() - io.startedAt);
  const firstDeadline = Date.now() + Math.max(io.stepMs * 2, Math.floor(remaining / 2));
  const parsed = await openPicker(io, firstDeadline);
  if (parsed?.footerSeen) return parsed;
  if (expired(io)) return parsed;
  // A non-picker interstitial (async access banner / transient render) is sitting
  // where the picker should be. Esc it and re-open once against the settled pane
  // before giving up to the caller's static fallback. dismissPicker is Esc +
  // verify; its return is advisory here.
  await dismissPicker(io);
  if (expired(io)) return parsed;
  return openPicker(io);
}

/**
 * Send Escape and verify the modal actually dismissed (footer no
 * longer parseable as an open picker). Retries once. Never throws.
 */
async function dismissPicker(io: Io): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      sendKey(io, "Escape");
    } catch {
      return false;
    }
    await io.sleep(io.stepMs);
    const pane = io.runner.capture(io.socket, io.session) ?? "";
    const parsed = parseModelPicker(pane);
    // Dismissed when the last picker render no longer shows its footer
    // *as the live tail* — after Esc claude prints a "Kept model as …"
    // line below the old render, so the simplest robust check is that
    // a fresh parse no longer reports a footer-complete modal whose
    // footer is at the pane tail. We approximate with: no parse, or
    // text after the footer line (the confirmation).
    if (!parsed || !parsed.footerSeen) return true;
    const tail = pane.slice(pane.lastIndexOf("Esc to cancel"));
    if (tail.split("\n").slice(1).some((l) => l.trim().length > 0)) return true;
  }
  return false;
}

/**
 * Discover the model options claude's picker offers. Opens the picker,
 * parses it, and ALWAYS attempts dismissal before returning.
 */
export async function discoverModels(
  agentName: string,
  opts: PickerOpts = {},
): Promise<DiscoverResult> {
  const io = makeIo(agentName, opts);
  if (!io.runner.hasSession(io.socket, io.session)) {
    return { ok: false, reason: "tmux session not found" };
  }
  // Serialize against every other drive on this pane (other /model
  // dashboards, taps, /inject) — an overlapping drive's Enter landing
  // in an open picker is the modal's "set as default".
  return withPaneLock(`${io.socket}:${io.session}`, async () => {
    io.startedAt = Date.now(); // budget starts when the lock is held
    let parsed: ParsedModelPicker | null = null;
    let dismissed = true;
    try {
      parsed = await openPickerWithRetry(io);
    } finally {
      dismissed = await dismissOrWarn(io, "discover");
    }
    const tail = dismissed ? {} : { dismissFailed: true as const };
    if (!parsed || !parsed.footerSeen) {
      return {
        ok: false,
        reason: "picker did not render — agent may be mid-turn or the CLI changed its /model UI",
        ...tail,
      };
    }
    const current = parsed.options.find((o) => o.current) ?? null;
    return { ok: true, options: parsed.options, currentLabel: current?.label ?? null, ...tail };
  });
}

/**
 * Select a model by LABEL via the picker, applying session-only (`s`).
 * Re-opens and re-parses the picker fresh — never trusts a previously
 * rendered index. Any mismatch aborts via Escape.
 */
export async function selectModel(
  agentName: string,
  targetLabel: string,
  opts: PickerOpts = {},
): Promise<SelectResult> {
  const io = makeIo(agentName, opts);
  if (!io.runner.hasSession(io.socket, io.session)) {
    return { ok: false, reason: "tmux session not found" };
  }

  // Same per-pane serialization as discoverModels — see that comment.
  return withPaneLock(`${io.socket}:${io.session}`, async () => {
    io.startedAt = Date.now(); // budget starts when the lock is held
    let selected = false;
    try {
      const parsed = await openPickerWithRetry(io);
      if (!parsed || !parsed.footerSeen) {
        return { ok: false, reason: "picker did not render — agent may be mid-turn" };
      }
      const target = parsed.options.find((o) => o.label === targetLabel);
      if (!target) {
        const have = parsed.options.map((o) => o.label).join(", ");
        return { ok: false, reason: `option "${targetLabel}" not offered (have: ${have})` };
      }
      if (parsed.cursorIndex < 0) {
        return { ok: false, reason: "cursor marker not visible — refusing blind navigation" };
      }

      // Walk the cursor to the target row one keypress at a time,
      // verifying position after the walk. Option indices are the
      // picker's own contiguous numbering.
      const delta = target.index - parsed.cursorIndex;
      const key = delta > 0 ? "Down" : "Up";
      for (let i = 0; i < Math.abs(delta); i++) {
        if (expired(io)) return { ok: false, reason: "timed out navigating picker" };
        sendKey(io, key);
        await io.sleep(Math.min(io.stepMs, 250));
      }
      await io.sleep(io.stepMs);
      const verifyPane = io.runner.capture(io.socket, io.session) ?? "";
      const verify = parseModelPicker(verifyPane);
      const atRow = verify?.options.find((o) => o.index === verify.cursorIndex);
      if (!verify || !atRow || atRow.label !== targetLabel) {
        return {
          ok: false,
          reason: `cursor verification failed (on "${atRow?.label ?? "?"}", wanted "${targetLabel}")`,
        };
      }

      // `s` = apply for this session only — the keypress dismisses the
      // modal itself, so no Escape on this path.
      sendLiteral(io, "s");
      selected = true;
      await io.sleep(io.stepMs);
      const after = io.runner.capture(io.socket, io.session) ?? "";
      const confirmation = extractConfirmation(after) ?? `Switched to ${targetLabel} (session)`;
      return { ok: true, confirmation };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      if (!selected) {
        // Failure is reported loudly inside dismissOrWarn (gateway log).
        await dismissOrWarn(io, "select");
      }
    }
  });
}

/**
 * Pull claude's post-selection confirmation line from the pane tail —
 * e.g. "Set model to Haiku 4.5 for this session" / "Kept model as …".
 * Returns null when no recognizable line is present.
 */
export function extractConfirmation(pane: string): string | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].replace(/^\s*⎿\s*/, "").trim();
    if (/^(Set model to|Kept model as|Switched to)/i.test(t)) return t;
  }
  return null;
}
