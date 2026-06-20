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
import { buildReviewPrompt, REVIEW_SOURCE } from "../self-improve/review-prompt.js";
import { selfImproveEnabled } from "../self-improve/config.js";
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
        // Compact "Name(primary-arg)" — enough for the gate's
        // Edit(...)/Bash(...) fix fingerprints without dumping payloads.
        const input = (p.input ?? {}) as Record<string, unknown>;
        const arg =
          (typeof input.file_path === "string" && input.file_path) ||
          (typeof input.command === "string" && input.command) ||
          (typeof input.path === "string" && input.path) ||
          "";
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

function main(): void {
  // Opt-out kill switch (RFC: ships on by default, per-agent disable).
  if (!selfImproveEnabled()) process.exit(0);

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
  const gate = runGate(messages);

  // Cost guarantee: no signal → return immediately, zero added work.
  if (!gate.tripped) process.exit(0);

  // Don't recurse: a review turn we injected is itself a transcript; if
  // its own messages somehow trip the gate, we'd loop. The injected
  // turn's first user message carries meta.source=self_improve_review;
  // the transcript flattening drops meta, but the visible prompt starts
  // with the "[self-improvement review]" banner — bail if the most
  // recent user message is one of ours.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && lastUser.text.startsWith("[self-improvement review]")) {
    process.exit(0);
  }

  const agentName = process.env.SWITCHROOM_AGENT_NAME ?? "";
  if (!agentName) process.exit(0); // can't route without identity — fail-open

  const prompt = buildReviewPrompt(gate.signals);
  injectReview(agentName, prompt, sessionId);
  // injectReview calls process.exit(0) on completion / timeout / error.
}

main();
