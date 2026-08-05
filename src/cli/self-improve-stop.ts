/**
 * Stop hook — agent self-improvement GATE (RFC
 * `reference/rfcs/agent-self-improvement.md`, slice 1).
 *
 * Fires at turn end (alongside the handoff / secret-scrub / tool-label
 * Stop hooks). Reads the just-finished transcript, runs the cheap
 * DETERMINISTIC gate (`src/self-improve/gate.ts`), and — only when a
 * learning signal crosses the repetition threshold — injects a forked
 * review turn into the live session via the gateway IPC socket
 * (`inject_inbound`, the same primitive cron uses). NO model call here:
 * the review is the synthesized turn, which keeps us on the
 * claude-native / subscription-honest path (no `claude -p`).
 *
 * Cost guarantee (the whole point): a turn with NO signal returns in a
 * single transcript pass with zero IO beyond the read — no socket
 * connect, no model, no allocation storm. The gate is pure.
 *
 * Bundled to a self-contained `.mjs` at build time (like
 * skill-validate-pretool / drive-write-pretool) because it imports the
 * src/self-improve/* modules + node:net, none of which resolve from the
 * raw .mjs hooks dir inside the agent image.
 *
 * Claude Code Stop-hook protocol: JSON on stdin
 * ({ session_id, transcript_path, ... }); output ignored; exit 0 always
 * (fail-open — a triage hook must never be the reason a turn fails).
 */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";

import { runGate } from "../self-improve/gate.js";
import {
  buildReviewPrompt,
  isReviewTurn,
  REVIEW_SOURCE,
} from "../self-improve/review-prompt.js";
import { selfImproveEnabled } from "../self-improve/config.js";
import {
  writeReviewContext,
  clearReviewContext,
} from "../self-improve/review-context.js";
import { sweepEvalIntegrity } from "../self-improve/eval-cases.js";
import type { TurnMessage } from "../self-improve/types.js";

/** Newest-last window of messages to scan. Bounds the gate's cost and
 *  matches "this turn + a little context" — repetition across a long
 *  session is the operator's job, not the per-turn gate's. */
const SCAN_WINDOW = 40;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Cheap, stable, non-crypto string hash (djb2) → short base36 digest. Used
 * only to make Edit/Write fix fingerprints content-aware (NOT a security
 * primitive): two distinct edits to the same file get distinct fingerprints,
 * an identical re-applied edit gets the same one.
 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Flatten one Claude Code transcript entry's content to text. Handles
 * the nested `{type, message:{role, content}}` shape and the flat
 * `{role, content}` shape; content may be a string or a list of parts
 * ({type:"text",text} / {type:"tool_use",name,input} /
 * {type:"tool_result",...}). Tool calls are flattened to a compact
 * `Name(arg)` form so the gate's fix-fingerprint patterns can match.
 */
function flatten(entry: unknown): TurnMessage | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  let msg: Record<string, unknown> | null = null;
  if ((e.type === "user" || e.type === "assistant") && e.message && typeof e.message === "object") {
    msg = e.message as Record<string, unknown>;
  } else if (typeof e.role === "string" && "content" in e) {
    msg = e;
  }
  if (!msg) return null;
  const role = typeof msg.role === "string" ? msg.role : "";
  if (role !== "user" && role !== "assistant") return null;

  const content = msg.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push(p.text);
      } else if (p.type === "tool_use" && typeof p.name === "string") {
        // Compact "Name(arg)" — enough for the gate's Edit(...)/Bash(...) fix
        // fingerprints without dumping payloads.
        const input = (p.input ?? {}) as Record<string, unknown>;
        const file =
          (typeof input.file_path === "string" && input.file_path) ||
          (typeof input.path === "string" && input.path) ||
          "";
        let arg: string;
        if (typeof input.command === "string") {
          // Bash: the command IS the fix content — keep it whole so an
          // identical remediation re-run still fingerprints as a repeat.
          arg = input.command;
        } else if (file) {
          // Edit/Write/MultiEdit: the repeated-manual-fix signal must
          // fingerprint the FIX (the actual change), NOT just the file path.
          // A path-only fingerprint mis-reads normal iterative editing — a
          // few DISTINCT edits to one file in a turn — as "the same fix
          // applied N×" (issue #2462 follow-up). Append a short content hash
          // so only a genuinely identical re-applied edit recurs.
          const editish = [
            typeof input.old_string === "string" ? input.old_string : "",
            typeof input.new_string === "string" ? input.new_string : "",
            typeof input.content === "string" ? input.content : "",
            input.edits !== undefined ? JSON.stringify(input.edits) : "",
          ];
          arg = editish.some((x) => x.length > 0)
            ? `${file} #${shortHash(editish.join(" "))}`
            : file;
        } else {
          arg = "";
        }
        parts.push(`${p.name}(${arg})`);
      }
    }
    text = parts.join(" ");
  }
  return { role, text };
}

function readTranscript(path: string): TurnMessage[] {
  if (!path) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: TurnMessage[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = flatten(JSON.parse(t));
      if (m && m.text) out.push(m);
    } catch {
      /* skip malformed line */
    }
  }
  // Bounded tail.
  return out.length > SCAN_WINDOW ? out.slice(-SCAN_WINDOW) : out;
}

/** Agent state dir — set by start.sh; same fallback as the apply-guard
 *  hook so both agree on where the review-context marker lives. */
function resolveStateDir(): string {
  return (
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude", "channels", "telegram")
  );
}

function resolveSocketPath(): string {
  if (process.env.SWITCHROOM_GATEWAY_SOCKET) {
    return process.env.SWITCHROOM_GATEWAY_SOCKET;
  }
  const stateDir =
    process.env.TELEGRAM_STATE_DIR ?? join(homedir(), ".claude", "channels", "telegram");
  return join(stateDir, "gateway.sock");
}

/** The chat the review turn nominally belongs to. The review is off the
 *  reply path (the prompt forbids replying), so this is context only;
 *  inject_inbound does not gate on chat. Prefer an explicit override. */
function resolveChatId(): string {
  return (
    process.env.SWITCHROOM_SELF_IMPROVE_CHAT_ID ??
    process.env.SWITCHROOM_DEFAULT_CHAT_ID ??
    "self-improve"
  );
}

/**
 * Fire-and-forget the inject_inbound envelope at the gateway socket.
 * Best-effort: a short connect timeout, write, end. Never throws.
 */
function injectReview(agentName: string, text: string, sessionId: string): void {
  const socketPath = resolveSocketPath();
  const chatId = resolveChatId();
  const now = Date.now();
  const envelope = {
    type: "inject_inbound",
    agentName,
    inbound: {
      type: "inbound",
      chatId,
      messageId: now,
      user: "self-improve",
      userId: 0,
      ts: now,
      text,
      meta: {
        source: REVIEW_SOURCE,
        triggering_session: sessionId,
      } as Record<string, string>,
    },
  };

  let settled = false;
  const sock = createConnection(socketPath);
  const done = (): void => {
    if (settled) return;
    settled = true;
    try {
      sock.end();
    } catch {
      /* nothing to do */
    }
    try {
      sock.destroy();
    } catch {
      /* nothing to do */
    }
    process.exit(0);
  };
  const timer = setTimeout(done, 3000);
  timer.unref?.();
  sock.on("connect", () => {
    try {
      sock.write(JSON.stringify(envelope) + "\n", () => done());
    } catch {
      done();
    }
  });
  sock.on("error", () => done());
}

/** Agent skills root — where owned skill bundles (and their evals) live. */
function resolveSkillsRoot(): string {
  return join(homedir(), ".claude", "skills");
}

function main(): void {
  // Opt-out kill switch (RFC: ships on by default, per-agent disable).
  if (!selfImproveEnabled()) process.exit(0);

  // Eval-integrity sweep (RFC amendment §"corrections as eval cases", MJ1).
  // Runs EVERY turn, before anything transcript-dependent: adopt a first-sight
  // evals.json as the sanctioned baseline ONLY if it passes the fail-closed
  // PII/secret scan (MAJOR 2 — un-sanctioned bytes from a Bash write are
  // quarantined, never silently trusted), and REVERT any out-of-band drift
  // from the baseline snapshot. Tamper-EVIDENT + self-healing, NOT a
  // cryptographic boundary — the hard backstop is the T1-live gate (default
  // OFF). Best-effort and never throws; the Stop hook is fail-open. Cheap when
  // no skill ships evals (a single readdir that finds nothing).
  try {
    sweepEvalIntegrity(resolveSkillsRoot(), resolveStateDir());
  } catch {
    /* fail-open: a sweep error must never fail the turn */
  }

  const raw = readStdin().trim();
  if (!raw) process.exit(0);

  let event: { transcript_path?: unknown; session_id?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0); // Claude protocol error — not ours.
  }

  const transcriptPath =
    typeof event.transcript_path === "string" ? event.transcript_path : "";
  const sessionId =
    typeof event.session_id === "string" ? event.session_id : "unknown";

  const messages = readTranscript(transcriptPath);

  // Review-turn detection FIRST — BEFORE the gate check, and independent of
  // it. A turn we injected is itself a transcript whose most-recent user
  // message is the review prompt. On such a turn we (a) clear the
  // review-context marker so the apply-guard stops enforcing on later NORMAL
  // turns, and (b) never recurse by reviewing a review. This MUST run before
  // `!gate.tripped` returns: a well-behaved review (the review prompt + a
  // benign skill edit) trips NO learning signal, so if the clear sat after
  // the gate check the marker would leak after every real review — wrongly
  // blocking later normal-turn edits and, worse, letting a normal-turn edit
  // auto-apply against a STALE benchmark.
  //
  // `isReviewTurn` (not a bare `startsWith`) is load-bearing: the gateway
  // wraps every injected inbound in a `<channel …>` envelope before it lands
  // in the transcript, so the banner is NOT at offset 0. The old prefix check
  // never matched the real shape → the guard never fired → the review
  // re-injected every turn in an unbounded loop (issue #2462).
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && isReviewTurn(lastUser.text)) {
    clearReviewContext(resolveStateDir());
    process.exit(0);
  }

  // Defense in depth (also #2462): never let the gate INGEST our own injected
  // review prompts. They embed the prior turn's evidence, which the directive
  // detector would re-count as a fresh "restated rule" — a self-amplifying
  // feedback loop that climbs past threshold on every pass. Filtering them out
  // of the scan window keeps the gate measuring the operator's turn, not its
  // own output, even when a real message and a review inbound batch together
  // (so `lastUser` above isn't the review and the short-circuit is missed).
  const scanMessages = messages.filter((m) => !isReviewTurn(m.text));
  const gate = runGate(scanMessages);

  // Cost guarantee: no signal → return immediately, zero added work.
  if (!gate.tripped) process.exit(0);

  const agentName = process.env.SWITCHROOM_AGENT_NAME ?? "";
  if (!agentName) process.exit(0); // can't route without identity — fail-open

  // Drop the review-context marker BEFORE injecting, so the apply-guard in
  // the forked review turn enforces the deterministic T1 gate on any skill
  // edit the review attempts. Best-effort: a marker failure must not stop
  // the review from being injected (the guard then simply no-ops).
  try {
    writeReviewContext(resolveStateDir(), {
      created_at: new Date().toISOString(),
      triggering_session: sessionId,
      chat_id: resolveChatId(),
      signals: gate.signals,
    });
  } catch {
    /* marker best-effort; review still injects */
  }

  const prompt = buildReviewPrompt(gate.signals);
  injectReview(agentName, prompt, sessionId);
  // injectReview calls process.exit(0) on completion / timeout / error.
}

main();
