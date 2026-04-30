import { describe, it, expect } from "vitest";
import {
  createIssuesCardHandle,
  renderIssuesCard,
  type BotApiForIssuesCard,
} from "../issues-card.js";
import type { IssueEvent } from "../../src/issues/index.js";

function makeEvent(partial: Partial<IssueEvent>): IssueEvent {
  const ts = partial.last_seen ?? 1_700_000_000_000;
  return {
    ts,
    agent: "klanker",
    severity: "error",
    source: "hook:handoff",
    code: "cli-error",
    summary: "claude -p exited 1",
    fingerprint: "hook:handoff::cli-error",
    occurrences: 1,
    first_seen: ts,
    last_seen: ts,
    ...partial,
  };
}

describe("renderIssuesCard", () => {
  it("returns null when there are no unresolved events", () => {
    expect(renderIssuesCard({ agentName: "klanker", events: [] })).toBeNull();
  });

  it("filters out resolved events (returns null when only resolved)", () => {
    const e = makeEvent({ resolved_at: 999 });
    expect(renderIssuesCard({ agentName: "klanker", events: [e] })).toBeNull();
  });

  it("renders a header with the max severity emoji", () => {
    const events = [
      makeEvent({ fingerprint: "a::1", code: "1", severity: "warn" }),
      makeEvent({ fingerprint: "a::2", code: "2", severity: "critical" }),
      makeEvent({ fingerprint: "a::3", code: "3", severity: "info" }),
    ];
    const out = renderIssuesCard({ agentName: "klanker", events });
    expect(out).toMatch(/^🚨 <b>klanker<\/b>/);
    expect(out).toContain("3 issues");
  });

  it("uses singular 'issue' for one event", () => {
    const events = [makeEvent({})];
    const out = renderIssuesCard({ agentName: "klanker", events });
    expect(out).toContain("1 issue");
    expect(out).not.toContain("issues");
  });

  it("orders rows by severity then most-recent", () => {
    const events = [
      makeEvent({ fingerprint: "a::low", code: "low", severity: "warn", last_seen: 100 }),
      makeEvent({ fingerprint: "a::hi-old", code: "hi-old", severity: "critical", last_seen: 50 }),
      makeEvent({ fingerprint: "a::hi-new", code: "hi-new", severity: "critical", last_seen: 200 }),
    ];
    const out = renderIssuesCard({ agentName: "klanker", events, now: 1000 });
    const hiNewIdx = out!.indexOf("hi-new");
    const hiOldIdx = out!.indexOf("hi-old");
    const lowIdx = out!.indexOf("low");
    // hi-new (critical, recent) before hi-old (critical, older) before low (warn).
    expect(hiNewIdx).toBeLessThan(hiOldIdx);
    expect(hiOldIdx).toBeLessThan(lowIdx);
  });

  it("includes occurrence count when > 1", () => {
    const events = [makeEvent({ occurrences: 5 })];
    const out = renderIssuesCard({ agentName: "klanker", events });
    expect(out).toContain("(×5)");
  });

  it("shows relative time for last_seen", () => {
    const events = [makeEvent({ last_seen: 1_000_000 })];
    const out = renderIssuesCard({ agentName: "klanker", events, now: 1_000_000 + 90_000 });
    expect(out).toContain("2m ago");
  });

  it("truncates rows beyond maxRows and notes the overflow", () => {
    const events: IssueEvent[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(
        makeEvent({
          source: `s${i}`,
          code: `c${i}`,
          fingerprint: `s${i}::c${i}`,
          summary: `failure ${i}`,
        }),
      );
    }
    const out = renderIssuesCard({ agentName: "klanker", events, maxRows: 5 });
    expect(out).toContain("+10 more not shown");
  });

  it("HTML-escapes user-supplied fields", () => {
    const events = [
      makeEvent({
        agent: "<script>",
        source: "hook:<x>",
        code: "<y>",
        fingerprint: "<x>::<y>",
        summary: "<dangerous & stuff>",
      }),
    ];
    const out = renderIssuesCard({ agentName: "<script>", events });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;x&gt;::&lt;y&gt;");
    expect(out).toContain("&lt;dangerous &amp; stuff&gt;");
  });
});

// ─── createIssuesCardHandle (lifecycle) ──────────────────────────────────────

interface FakeBot extends BotApiForIssuesCard {
  sent: Array<{ text: string; opts?: Record<string, unknown> }>;
  edits: Array<{ messageId: number; text: string }>;
  deletes: Array<{ messageId: number }>;
  failNextEdit?: boolean;
}

function makeFakeBot(): FakeBot {
  let nextId = 1000;
  const fb: FakeBot = {
    sent: [],
    edits: [],
    deletes: [],
    sendMessage: async (_chat, text, opts) => {
      fb.sent.push({ text, opts });
      return { message_id: nextId++ };
    },
    editMessageText: async (_chat, mid, text) => {
      if (fb.failNextEdit) {
        fb.failNextEdit = false;
        throw new Error("Bad Request: message to edit not found");
      }
      fb.edits.push({ messageId: mid, text });
      return {};
    },
    deleteMessage: async (_chat, mid) => {
      fb.deletes.push({ messageId: mid });
      return {};
    },
  };
  return fb;
}

describe("createIssuesCardHandle", () => {
  it("posts no card when called with zero unresolved events", async () => {
    const bot = makeFakeBot();
    const handle = createIssuesCardHandle({
      agentName: "klanker",
      chatId: "1",
      bot,
    });
    await handle.refresh([]);
    expect(bot.sent).toHaveLength(0);
    expect(handle.messageId()).toBeNull();
  });

  it("posts a card on first refresh with events", async () => {
    const bot = makeFakeBot();
    const handle = createIssuesCardHandle({
      agentName: "klanker",
      chatId: "1",
      bot,
    });
    await handle.refresh([makeEvent({})]);
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].opts?.parse_mode).toBe("HTML");
    expect(handle.messageId()).toBe(1000);
  });

  it("edits in place on subsequent refreshes when content changes", async () => {
    const bot = makeFakeBot();
    const handle = createIssuesCardHandle({
      agentName: "klanker",
      chatId: "1",
      bot,
    });
    await handle.refresh([makeEvent({ summary: "first" })]);
    await handle.refresh([makeEvent({ summary: "second" })]);
    expect(bot.sent).toHaveLength(1);
    expect(bot.edits).toHaveLength(1);
  });

  it("skips redundant edits when content is unchanged", async () => {
    const bot = makeFakeBot();
    const handle = createIssuesCardHandle({
      agentName: "klanker",
      chatId: "1",
      bot,
      now: () => 1_000_000, // freeze time so relTime is stable
    });
    await handle.refresh([makeEvent({})]);
    await handle.refresh([makeEvent({})]); // identical
    expect(bot.sent).toHaveLength(1);
    expect(bot.edits).toHaveLength(0);
  });

  it("deletes the card when issues drop to zero", async () => {
    const bot = makeFakeBot();
    const handle = createIssuesCardHandle({
      agentName: "klanker",
      chatId: "1",
      bot,
    });
    await handle.refresh([makeEvent({})]);
    expect(handle.messageId()).toBe(1000);
    await handle.refresh([]);
    expect(bot.deletes).toEqual([{ messageId: 1000 }]);
    expect(handle.messageId()).toBeNull();
  });

  it("re-posts when an edit fails (stale message_id, etc.)", async () => {
    const bot = makeFakeBot();
    const handle = createIssuesCardHandle({
      agentName: "klanker",
      chatId: "1",
      bot,
    });
    await handle.refresh([makeEvent({ summary: "v1" })]);
    expect(handle.messageId()).toBe(1000);

    bot.failNextEdit = true;
    await handle.refresh([makeEvent({ summary: "v2" })]);
    // Edit failed → re-posted as a fresh message.
    expect(bot.sent).toHaveLength(2);
    expect(handle.messageId()).toBe(1001);
  });

  it("includes message_thread_id when threadId is provided", async () => {
    const bot = makeFakeBot();
    const handle = createIssuesCardHandle({
      agentName: "klanker",
      chatId: "1",
      threadId: 42,
      bot,
    });
    await handle.refresh([makeEvent({})]);
    expect(bot.sent[0].opts?.message_thread_id).toBe(42);
  });
});
