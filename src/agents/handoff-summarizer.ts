/**
 * Session-handoff summarizer.
 *
 * Invoked by a Stop hook at session end (and as a lazy fallback in
 * start.sh). Reads the session JSONL, builds a structured markdown
 * briefing via a fast Anthropic model (Haiku by default), and writes
 * two sidecars into the agent's directory:
 *
 *   - .handoff.md        Full briefing, injected into the next session
 *                        via --append-system-prompt.
 *   - .handoff-topic     Single-line topic string, read by the telegram
 *                        plugin to render a "↩️ Picked up where we left
 *                        off — <topic>" line on the first reply.
 *
 * Both writes are atomic (tmpfile + rename) so the telegram plugin
 * never reads a half-written file. The briefing is also mirrored to
 * Hindsight as a tagged memory so older handoffs remain semantically
 * recallable across arbitrarily many sessions.
 *
 * Best-effort at every step — missing API key, API failure, missing
 * JSONL, Hindsight unreachable: warn to stderr, resolve cleanly. The
 * Stop hook must never block agent shutdown.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_SUMMARIZER_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const TOPIC_MAX_CHARS = 117;

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
      const text = extractTextBlocks(content);
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
  // Keep the most recent `maxTurns` turns (pairs counted generously —
  // we actually cap total turn entries, not user+assistant pairs).
  if (turns.length <= maxTurns) return turns;
  return turns.slice(turns.length - maxTurns);
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

export type HandoffPrompt = {
  system: string;
  user: string;
};

export function buildHandoffPrompt(turns: Turn[]): HandoffPrompt {
  const system =
    "You produce concise handoff briefings for an AI assistant that is " +
    "about to start a fresh session. The next session has no memory of " +
    "what just happened; your briefing is its only carry-over context.\n\n" +
    "Output format — EXACTLY this structure, no preamble:\n" +
    "## Topic: <one short line, max 100 chars, describing what the user and assistant were most recently focused on>\n\n" +
    "## Summary\n<one paragraph, what we were working on>\n\n" +
    "## Open threads\n- <bulleted list of pending/unresolved items; empty list ok>\n\n" +
    "## Last exchange\n**User:** <verbatim or near-verbatim last user message, truncated to ~500 chars>\n**Assistant:** <last assistant response, truncated to ~500 chars>\n\n" +
    "## Key decisions & facts\n- <bullets; empty list ok>\n\n" +
    "## Active files / paths\n- <bullets; empty list ok>\n\n" +
    "Keep the whole briefing under ~1500 tokens. Prefer brevity. Omit sections only if truly empty (still emit the heading with '- (none)').";
  const transcript = turns
    .map((t) => `### ${t.role.toUpperCase()}\n${t.text}`)
    .join("\n\n");
  const user =
    "Here is the recent session transcript (oldest first). Produce the handoff briefing per the specified format.\n\n" +
    transcript;
  return { system, user };
}

/**
 * Parse the LLM's response into topic + full briefing. We require the
 * first non-empty line to be `## Topic: <text>`. Everything from that
 * line onward IS the briefing (we keep the Topic line in the briefing
 * so the system prompt reads naturally).
 */
export function parseHandoffResponse(raw: string): {
  topic: string;
  briefing: string;
} | null {
  const lines = raw.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length) return null;
  const first = lines[start].trim();
  const m = first.match(/^##\s*Topic:\s*(.+)$/i);
  if (!m) return null;
  let topic = m[1].trim();
  if (topic.length > TOPIC_MAX_CHARS) {
    topic = topic.slice(0, TOPIC_MAX_CHARS) + "…";
  }
  const briefing = lines.slice(start).join("\n").trim();
  return { topic, briefing };
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
  renameSync(handoffTmp, handoffPath);
  renameSync(topicTmp, topicPath);
}

export type AnthropicClientLike = {
  messages: {
    create: (req: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
    }) => Promise<{ content: { type: string; text?: string }[] }>;
  };
};

export type SummarizeOpts = {
  jsonlPath: string;
  agentDir: string;
  agentName: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  hindsightUrl?: string;
  hindsightBankId?: string;
  anthropic?: AnthropicClientLike;
  fetch?: typeof fetch;
};

/**
 * Full pipeline: extract turns → call Anthropic → parse response →
 * atomic sidecar write → Hindsight mirror. Resolves with a status
 * string (for logging); never throws.
 */
export async function summarize(opts: SummarizeOpts): Promise<string> {
  const model = opts.model ?? DEFAULT_SUMMARIZER_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const turns = extractTurnsFromJsonl(opts.jsonlPath, maxTurns);
  if (turns.length === 0) {
    return "no-turns";
  }
  const client = opts.anthropic ?? createAnthropicClient();
  if (!client) {
    return "no-api-key";
  }
  const prompt = buildHandoffPrompt(turns);

  let response: { content: { type: string; text?: string }[] };
  try {
    response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: 2000,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }),
      timeoutMs,
    );
  } catch (err) {
    process.stderr.write(
      `handoff-summarizer: anthropic call failed — ${errMsg(err)}\n`,
    );
    return "api-error";
  }

  const raw = response.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  if (!raw) {
    return "empty-response";
  }
  const parsed = parseHandoffResponse(raw);
  if (!parsed) {
    process.stderr.write(
      "handoff-summarizer: response missing '## Topic:' header; skipping\n",
    );
    return "parse-error";
  }

  try {
    writeSidecarsAtomic(opts.agentDir, parsed.briefing, parsed.topic);
  } catch (err) {
    process.stderr.write(
      `handoff-summarizer: sidecar write failed — ${errMsg(err)}\n`,
    );
    return "write-error";
  }

  await mirrorToHindsight(parsed.briefing, opts).catch(() => {});
  return "ok";
}

function createAnthropicClient(): AnthropicClientLike | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    process.stderr.write(
      "handoff-summarizer: ANTHROPIC_API_KEY unset; skipping\n",
    );
    return null;
  }
  return new Anthropic({ apiKey: key }) as unknown as AnthropicClientLike;
}

function errMsg(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function mirrorToHindsight(
  briefing: string,
  opts: SummarizeOpts,
): Promise<void> {
  const url = opts.hindsightUrl ?? process.env.HINDSIGHT_API_URL;
  const bankId = opts.hindsightBankId ?? process.env.HINDSIGHT_BANK_ID ?? "default";
  if (!url) return;
  const fetchFn = opts.fetch ?? fetch;
  const endpoint = `${url.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
  const body = {
    items: [
      {
        content: briefing,
        document_id: "session_handoff",
        tags: ["session_handoff", opts.agentName],
      },
    ],
    async: true,
  };
  try {
    await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(
      `handoff-summarizer: hindsight mirror failed — ${errMsg(err)}\n`,
    );
  }
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
      entries = require("fs").readdirSync(dir);
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

export function agentDirFromClaudeConfig(claudeConfigDir: string): string {
  return dirname(claudeConfigDir);
}
