/**
 * #2726 Part 2 — the log-tailed rollout NARRATOR discipline: fire-and-forget,
 * monotonic-by-seq, freeze-on-terminal, debounced, one message edited in place.
 *
 * Driven with a fake relay (records posts + edits) and fake timers so the
 * debounce is deterministic. Pure logic — no gateway, no sockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LogTailRolloutNarrator,
  type RolloutNarrationRelay,
} from "./rollout-narrator.js";
import type { StatusEntry } from "./server.js";
import type { RolloutPhase } from "../cli/rollout.js";

function makeEntry(over: Partial<StatusEntry> = {}): StatusEntry {
  return {
    request_id: "ro-1",
    caller: { kind: "agent", name: "overlord" },
    op: "rollout",
    result: "started",
    exit_code: null,
    started_at: Date.now(),
    finished_at: null,
    stdout_tail: "",
    stderr_tail: "",
    pin: "v1.2.3",
    ...over,
  };
}

interface FakeRelay extends RolloutNarrationRelay {
  posts: { requestId: string; text: string }[];
  edits: { messageId: number; text: string }[];
  /** message_id the next post resolves to; null to simulate a failed post. */
  nextMessageId: number | null;
  /** Resolve all pending posts (they resolve on a microtask). */
}

function makeRelay(nextMessageId: number | null = 100): FakeRelay {
  const posts: { requestId: string; text: string }[] = [];
  const edits: { messageId: number; text: string }[] = [];
  const relay: FakeRelay = {
    posts,
    edits,
    nextMessageId,
    async post(args) {
      posts.push({ requestId: args.requestId, text: args.text });
      return relay.nextMessageId;
    },
    edit(args) {
      edits.push({ messageId: args.messageId, text: args.text });
    },
  };
  return relay;
}

const phase = (p: string, over: Partial<RolloutPhase> = {}): RolloutPhase => ({
  phase: p as RolloutPhase["phase"],
  target: "v1.2.3",
  ...over,
});

describe("LogTailRolloutNarrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts ONE message on the first phase, then EDITs it in place", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 1000 });
    const entry = makeEntry();

    n.onPhase(entry, phase("apply"));
    // Post is dispatched async — let the microtask resolve.
    await vi.runAllTimersAsync();
    expect(relay.posts).toHaveLength(1);
    expect(relay.posts[0]!.text).toContain("applying");

    // A later phase debounces an EDIT (not a second post).
    n.onPhase(entry, phase("canary-start", { agent: "test-harness", n: 1, m: 3 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(relay.posts).toHaveLength(1); // still just one post
    expect(relay.edits.length).toBeGreaterThanOrEqual(1);
    expect(relay.edits.at(-1)!.messageId).toBe(100);
    expect(relay.edits.at(-1)!.text).toContain("canary");
  });

  it("debounces multiple rapid phases into a single trailing-edge edit", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 1000 });
    const entry = makeEntry();

    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync(); // first post lands, message_id=100

    // Fire several agent phases within the debounce window.
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 3 }));
    n.onPhase(entry, phase("agent-done", { agent: "a", n: 1, m: 3 }));
    n.onPhase(entry, phase("agent-start", { agent: "b", n: 2, m: 3 }));
    // Before the debounce fires, no new edit yet.
    expect(relay.edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    // Exactly ONE edit coalesced the burst.
    expect(relay.edits).toHaveLength(1);
    expect(relay.edits[0]!.text).toContain("agent 2/3");
  });

  it("is monotonic: a stale (earlier) phase after a later one is dropped", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();

    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();
    // Advance to agent 3/3.
    n.onPhase(entry, phase("agent-start", { agent: "c", n: 3, m: 3 }));
    await vi.advanceTimersByTimeAsync(500);
    const editsAfterProgress = relay.edits.length;
    const lastText = relay.edits.at(-1)!.text;
    expect(lastText).toContain("agent 3/3");

    // A stale earlier phase (apply / canary) arrives out of order → dropped.
    n.onPhase(entry, phase("canary-start", { agent: "x", n: 1, m: 3 }));
    await vi.advanceTimersByTimeAsync(500);
    // No regressive edit was applied.
    expect(relay.edits.length).toBe(editsAfterProgress);
  });

  it("freezes on terminal: no later phase can un-finalize the message", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();

    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();

    // Terminal completes the roll.
    n.onTerminal(makeEntry({ result: "completed", rolled: ["a", "b", "c"] }));
    await vi.runAllTimersAsync();
    const finalEdit = relay.edits.at(-1)!;
    expect(finalEdit.text).toContain("✅");
    expect(finalEdit.text).toContain("done");
    const editCountAtFreeze = relay.edits.length;

    // A late phase arriving after terminal is IGNORED (frozen).
    n.onPhase(entry, phase("agent-start", { agent: "z", n: 9, m: 9 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(relay.edits.length).toBe(editCountAtFreeze);
    // The message still shows the terminal outcome, never regressed.
    expect(relay.edits.at(-1)!.text).toContain("✅");
  });

  it("renders the ❌ terminal-error outcome with the failed step/agent", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();
    n.onPhase(entry, phase("canary-start", { agent: "test-harness", n: 1, m: 2 }));
    await vi.runAllTimersAsync();

    n.onTerminal(
      makeEntry({
        result: "error",
        rolled: [],
        failed_step: "restart-agent",
        failed_agent: "test-harness",
        got: "1.2.2",
      }),
    );
    await vi.runAllTimersAsync();
    const t = relay.edits.at(-1)!.text;
    expect(t).toContain("❌");
    expect(t).toContain("restart-agent");
    expect(t).toContain("test-harness");
  });

  it("terminal before any phase still posts the final message", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    // No phases — straight to terminal (e.g. apply failed instantly).
    n.onTerminal(makeEntry({ result: "error", failed_step: "apply", rolled: [] }));
    await vi.runAllTimersAsync();
    expect(relay.posts).toHaveLength(1);
    expect(relay.posts[0]!.text).toContain("❌");
    expect(relay.posts[0]!.text).toContain("apply");
  });

  it("a failed post (message_id null) never crashes and skips edits", async () => {
    const relay = makeRelay(null); // post resolves null
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();
    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();
    expect(relay.posts).toHaveLength(1);
    // A later phase can't edit (no message_id) — it re-attempts a post instead,
    // never throws.
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits).toHaveLength(0);
  });

  it("does nothing for an operator-initiated roll (no agent gateway target)", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry({ caller: { kind: "operator" } });
    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();
    n.onTerminal(makeEntry({ caller: { kind: "operator" }, result: "completed" }));
    await vi.runAllTimersAsync();
    expect(relay.posts).toHaveLength(0);
    expect(relay.edits).toHaveLength(0);
  });
});
