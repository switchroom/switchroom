/**
 * Session-handoff builder.
 *
 * Invoked by a Stop hook at session end (and as a lazy fallback in
 * start.sh). Reads the previous session's JSONL, extracts the recent
 * turns, and writes two sidecars into the agent's directory:
 *
 *   - .handoff.md        A bounded **raw transcript tail** of the
 *                        previous session, injected into the next
 *                        session via --append-system-prompt so the
 *                        agent can reorient itself.
 *   - .handoff-topic     Single-line topic string, read by the telegram
 *                        plugin to render a "↩️ Picked up where we left
 *                        off — <topic>" line on the first reply.
 *
 * **No `claude -p`.** Earlier releases shelled out to a headless
 * `claude -p` here to LLM-summarize the transcript. Under Anthropic's
 * 2026-06-15 policy a headless `claude -p` is *programmatic* usage
 * (off the subscription) and it spawned a parasitic second telegram
 * bridge (the #1613 flap). RFC #1620 Workstream B replaced the
 * summarization with a deterministic, pure transcript-tail format:
 * the next session reorients itself from the raw tail (and from its
 * own memory files) on its first turn — the summarization "moves into"
 * the agent's live interactive session, which is subscription-funded.
 * See `reference/rfcs/eliminate-claude-p.md`.
 *
 * Both writes are atomic (tmpfile + rename) so the telegram plugin
 * never reads a half-written file.
 *
 * **The tail is DELIBERATELY NOT written into Hindsight.** Earlier
 * releases mirrored the briefing to the retain API as a
 * `document_id: "session_handoff"` memory "so older handoffs remain
 * recallable" — and Hindsight ran fact extraction over it. The tail is
 * raw model output (assistant prose plus truncated `[tool result]`
 * fragments), so any hallucination the assistant printed in the prior
 * session — a guessed date, a wrong issue id quoted inside a tool
 * result — was re-extracted as a first-class `world` fact with a clean
 * `event_date`, and the next session's recall served it back as ground
 * truth (the KEN146/"June 19" poisoning, verified live 2026-08-02). It
 * was also a pure duplicate: the vendored hindsight plugin's own Stop
 * hook (`vendor/hindsight-memory/scripts/retain.py`) already retains
 * the same transcript window with provenance tags (`source:transcript`,
 * #4164), redaction, watermarks, dedup, oversized-content splitting and
 * commit-before-ack — none of which the mirror had. Removing the mirror
 * closes the unmarked ingestion path deterministically; the sidecars on
 * disk remain the sole product of this module. Do not reintroduce a
 * Hindsight write here — route any future retention need through the
 * plugin's retain path so provenance and extraction guardrails apply.
 *
 * Best-effort at every step — missing JSONL: warn to stderr, resolve
 * cleanly. The Stop hook must never block agent shutdown.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fsyncPathSync } from "../util/atomic.js";

export const DEFAULT_MAX_TURNS = 50;
export const TOPIC_MAX_CHARS = 117;
/** Per-turn text cap in the transcript tail — keeps a few huge turns
 *  from blowing the next session's context budget. */
export const TURN_TEXT_MAX_CHARS = 1200;

export type Turn = {
  role: "user" | "assistant";
  text: string;
};

type RawJsonl =
  | { type: "user"; message: { content: unknown } }
  | { type: "assistant"; message: { content: unknown } }
  | { type: string; [k: string]: unknown };

/**
 * Extract the last N user/assistant turn pairs from a session JSONL.
 * User turns from queue-operation enqueues (the telegram channel
 * feeds user input as synthetic queue events whose content embeds a
 * <channel>...</channel> block). Assistant turns are parsed from
 * standard assistant message blocks.
 */
export function extractTurnsFromJsonl(
  path: string,
  maxTurns: number,
): Turn[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: RawJsonl;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "queue-operation") {
      const op = (obj as { operation?: string }).operation;
      if (op !== "enqueue") continue;
      const content = (obj as { content?: string }).content;
      if (typeof content !== "string") continue;
      const text = extractChannelBody(content);
      if (text) turns.push({ role: "user", text });
      continue;
    }
    if (obj.type === "user" && obj.message && typeof obj.message === "object") {
      const content = (obj.message as { content?: unknown }).content;
      const raw = extractTextBlocks(content);
      // A telegram message also lands here as a type:"user" entry whose
      // string content is the raw <channel>…</channel> envelope (the
      // queue-operation form is the clean one). Strip the wrapper so
      // the tail and derived topic show the message body, not XML.
      const text = raw ? extractChannelBody(raw) : null;
      if (text) turns.push({ role: "user", text });
      continue;
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const content = (obj.message as { content?: unknown }).content;
      const text = extractTextBlocks(content);
      if (text) turns.push({ role: "assistant", text });
      continue;
    }
  }
  // A telegram message lands in the JSONL twice — once as a
  // queue-operation enqueue, once as a type:"user" entry — and after
  // channel-body stripping both yield identical text. Collapse
  // consecutive identical (role, text) turns so the tail isn't doubled.
  const deduped: Turn[] = [];
  for (const t of turns) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === t.role && prev.text === t.text) continue;
    deduped.push(t);
  }
  // Keep the most recent `maxTurns` turns (pairs counted generously —
  // we actually cap total turn entries, not user+assistant pairs).
  if (deduped.length <= maxTurns) return deduped;
  return deduped.slice(deduped.length - maxTurns);
}

function extractChannelBody(raw: string): string | null {
  const m = raw.match(/<channel[^>]*>([\s\S]*?)<\/channel>/);
  if (m) return m[1].trim();
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractTextBlocks(content: unknown): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    return t.length > 0 ? t : null;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown; content?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_result" && typeof b.content === "string") {
      parts.push(`[tool result] ${b.content.slice(0, 400)}`);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

// ─── Transcript-tail handoff (pure — no model call) ──────────────────────────

/**
 * Format the extracted turns into the `.handoff.md` document — a
 * bounded raw transcript tail the next session reads to reorient.
 * Pure and deterministic: no `claude -p`, no network.
 */
export function formatTranscriptTail(turns: Turn[]): string {
  const header =
    "# Handoff — previous session\n\n" +
    "You are resuming this agent's work. There is no generated summary " +
    "— below is the **raw tail of the previous session's transcript** " +
    "(oldest first, most recent last). Read it to reorient, then carry " +
    "on. Anything important worth keeping long-term should already be " +
    "in your memory files — check those too.\n";
  if (turns.length === 0) {
    return (
      header +
      "\n_(No recent turns were recoverable from the previous session.)_\n"
    );
  }
  const body = turns
    .map((t) => {
      let text = t.text;
      if (text.length > TURN_TEXT_MAX_CHARS) {
        text = text.slice(0, TURN_TEXT_MAX_CHARS) + "\n…[truncated]";
      }
      return `### ${t.role === "user" ? "User" : "Assistant"}\n${text}`;
    })
    .join("\n\n");
  return `${header}\n## Recent turns\n\n${body}\n`;
}

/**
 * Derive the single-line `.handoff-topic` — "what we were last on".
 * The most recent user turn is the best signal; fall back to the last
 * turn of any role. Deterministic, no model call.
 */
export function deriveTopic(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === "user") return clampTopic(firstLine(turns[i]!.text));
  }
  if (turns.length > 0) return clampTopic(firstLine(turns[turns.length - 1]!.text));
  return "previous session";
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? s;
  return line.trim();
}

function clampTopic(s: string): string {
  return s.length > TOPIC_MAX_CHARS ? s.slice(0, TOPIC_MAX_CHARS) + "…" : s;
}

export function writeSidecarsAtomic(
  agentDir: string,
  briefing: string,
  topic: string,
): void {
  mkdirSync(agentDir, { recursive: true });
  const handoffPath = join(agentDir, ".handoff.md");
  const topicPath = join(agentDir, ".handoff-topic");
  const handoffTmp = handoffPath + ".tmp";
  const topicTmp = topicPath + ".tmp";
  writeFileSync(handoffTmp, briefing, "utf-8");
  writeFileSync(topicTmp, topic, "utf-8");
  // Atomic ≠ durable. rename(2) guarantees a reader never sees a torn file,
  // but it does not put the tmp file's BYTES on stable storage — so a host
  // power cut can leave `.handoff.md` naming an inode that was never written,
  // and the next boot reorients from an empty or stale briefing. fsync each
  // tmp file BEFORE publishing it, then fsync the containing DIRECTORY after
  // both renames so the directory entries themselves survive.
  fsyncPathSync(handoffTmp);
  fsyncPathSync(topicTmp);
  renameSync(handoffTmp, handoffPath);
  renameSync(topicTmp, topicPath);
  // Best-effort: the renames have already landed, so a failure here only
  // means we can't prove the entries survive a power cut. Never fail the
  // handoff write over it.
  try {
    fsyncPathSync(agentDir);
  } catch {
    /* durability barrier only; the sidecars are written either way */
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export type BuildHandoffOpts = {
  jsonlPath: string;
  agentDir: string;
  agentName: string;
  maxTurns?: number;
};

/**
 * Full pipeline: extract turns → format the transcript tail → derive
 * the topic → atomic sidecar write. Resolves with a status string (for
 * logging); never throws.
 *
 * NO Hindsight write happens here — see the module header. The tail is
 * the assistant's own prior output, and ingesting it re-mints model
 * hallucinations as recallable facts (memory poisoning).
 */
export async function buildHandoff(opts: BuildHandoffOpts): Promise<string> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  const turns = extractTurnsFromJsonl(opts.jsonlPath, maxTurns);
  if (turns.length === 0) {
    return "no-turns";
  }

  const briefing = formatTranscriptTail(turns);
  const topic = deriveTopic(turns);

  try {
    writeSidecarsAtomic(opts.agentDir, briefing, topic);
  } catch (err) {
    process.stderr.write(
      `handoff: sidecar write failed — ${errMsg(err)}\n`,
    );
    return "write-error";
  }

  return "ok";
}

function errMsg(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Locate the most recent session JSONL for an agent. Claude Code
 * stores sessions under $CLAUDE_CONFIG_DIR/projects/<sanitized-cwd>/
 * as one JSONL per session, rotated over time. We pick the newest by
 * mtime.
 */
export function findLatestSessionJsonl(claudeConfigDir: string): string | null {
  const projects = join(claudeConfigDir, "projects");
  if (!existsSync(projects)) return null;
  let latest: { path: string; mtime: number } | null = null;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      const m = st.mtimeMs;
      if (!latest || m > latest.mtime) latest = { path: full, mtime: m };
    }
  };
  walk(projects);
  return latest ? (latest as { path: string; mtime: number }).path : null;
}
