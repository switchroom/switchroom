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
import {
  planRollout,
  executeRollout,
  type RolloutDeps,
} from "../cli/rollout.js";

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

  it("accumulates a per-agent checklist with durations and ETA; terminal edit omits the Deferred block", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry({ started_at: Date.now(), prior_pin: "v1.2.2" });

    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();

    // Canary takes 40s.
    n.onPhase(entry, phase("canary-start", { agent: "test-harness", n: 1, m: 3 }));
    await vi.advanceTimersByTimeAsync(40_000);
    n.onPhase(entry, phase("canary-pass", { agent: "test-harness", n: 1, m: 3 }));
    entry.rolled = ["test-harness"];
    n.onPhase(entry, phase("agent-start", { agent: "clerk", n: 2, m: 3 }));
    await vi.advanceTimersByTimeAsync(500);

    const t = relay.edits.at(-1)!.text;
    // Header: version → version + request id.
    expect(t).toContain("`v1.2.2` → `v1.2.3`");
    expect(t).toContain("req `ro-1`");
    // Checklist: canary done with duration, clerk running, 1 collapsed pending.
    expect(t).toContain("- ✓ `test-harness` (canary) — 40s");
    expect(t).toContain("- ⏳ `clerk` — restarting…");
    expect(t).toContain("- · 1 more pending");
    // Footer: rolled count + ETA from the canary's duration (40s × 2 left).
    expect(t).toContain("1/3 rolled");
    expect(t).toContain("~1m 20s left (rough est.)");

    // Terminal: the final edit shows the summary + elapsed total, but NOT the
    // Deferred command block — the fresh terminal ping (pushRolloutTerminal)
    // carries that, and rendering it on both would duplicate the 3-command
    // list per successful roll.
    n.onPhase(entry, phase("agent-done", { agent: "clerk", n: 2, m: 3 }));
    n.onPhase(entry, phase("agent-start", { agent: "marko", n: 3, m: 3 }));
    n.onPhase(entry, phase("agent-done", { agent: "marko", n: 3, m: 3 }));
    n.onPhase(entry, phase("hostd-web-deferred"));
    n.onTerminal(
      makeEntry({
        started_at: entry.started_at,
        finished_at: entry.started_at + 300_000,
        result: "completed",
        rolled: ["test-harness", "clerk", "marko"],
        prior_pin: "v1.2.2",
      }),
    );
    await vi.runAllTimersAsync();
    const final = relay.edits.at(-1)!.text;
    expect(final).toContain("✅");
    expect(final).toContain("rolled 3/3 agent(s) in 5m");
    expect(final).toContain("- ✓ `clerk`");
    expect(final).toContain("- ✓ `marko`");
    expect(final).not.toContain("Deferred");
    expect(final).not.toContain("switchroom webd install");
  });

  it("footer 'N/M rolled' tracks real completions while entry.rolled is still empty mid-roll", async () => {
    // REGRESSION (#2726): hostd only parses the child's result sentinel into
    // `entry.rolled` AFTER the whole subprocess exits, so every in-flight phase
    // reads `entry.rolled === undefined/[]`. The footer used to read that empty
    // list directly and froze at "0/M rolled" for the entire roll even as the
    // per-agent checklist showed agents ✓ done. The count must instead derive
    // from the accumulated checklist. entry.rolled is DELIBERATELY never set
    // here — that mirrors the live hostd path during the roll.
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry(); // entry.rolled stays undefined the whole time.

    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();

    // Canary passes — one agent is now rolled.
    n.onPhase(entry, phase("canary-start", { agent: "test-harness", n: 1, m: 3 }));
    n.onPhase(entry, phase("canary-pass", { agent: "test-harness", n: 1, m: 3 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(entry.rolled).toBeUndefined(); // hostd hasn't parsed the sentinel yet.
    expect(relay.edits.at(-1)!.text).toContain("1/3 rolled"); // was "0/3".

    // Second agent completes — footer advances to 2/3.
    n.onPhase(entry, phase("agent-start", { agent: "clerk", n: 2, m: 3 }));
    n.onPhase(entry, phase("agent-done", { agent: "clerk", n: 2, m: 3 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits.at(-1)!.text).toContain("2/3 rolled");

    // A still-running agent does NOT count until its -done phase lands.
    n.onPhase(entry, phase("agent-start", { agent: "marko", n: 3, m: 3 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits.at(-1)!.text).toContain("2/3 rolled");
    n.onPhase(entry, phase("agent-done", { agent: "marko", n: 3, m: 3 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits.at(-1)!.text).toContain("3/3 rolled");
  });

  it("marks the failed agent ✗ on a terminal error", async () => {
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
        got: null,
      }),
    );
    await vi.runAllTimersAsync();
    const t = relay.edits.at(-1)!.text;
    expect(t).toContain("- ✗ `test-harness` (canary) — failed");
    expect(t).toContain("unreachable");
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
    expect(finalEdit.text).toContain("Done");
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
    // A later phase can't edit (no message_id) and, because the first post
    // FAILED, it does NOT immediately re-post — it backs off (see the bounded-
    // storm test). No edit is dispatched (nothing to edit).
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits).toHaveLength(0);
    expect(relay.posts).toHaveLength(1); // still bounded — no re-post storm.
  });

  it("BOUNDS post() calls across a 12-agent roll when every post resolves null (no re-post storm)", async () => {
    // Realistic during a fleet roll: the relay gateway is being recreated, so
    // post() keeps resolving null (or the rollout_status_posted reply times out
    // while the send actually landed). messageId stays null. A naive impl
    // re-enters the post branch on EVERY phase → ~one duplicate DM per agent.
    const relay = makeRelay(null);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 200 });
    const entry = makeEntry();

    // apply + canary(start/pass) + 11 more agents (start/done each) = a busy roll.
    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();
    n.onPhase(entry, phase("canary-start", { agent: "a1", n: 1, m: 12 }));
    n.onPhase(entry, phase("canary-pass", { agent: "a1", n: 1, m: 12 }));
    await vi.runAllTimersAsync();
    for (let i = 2; i <= 12; i++) {
      n.onPhase(entry, phase("agent-start", { agent: `a${i}`, n: i, m: 12 }));
      n.onPhase(entry, phase("agent-done", { agent: `a${i}`, n: i, m: 12 }));
      await vi.advanceTimersByTimeAsync(200);
    }
    // Then the terminal — one reserved retry is allowed.
    n.onTerminal(makeEntry({ result: "completed", rolled: [] }));
    await vi.runAllTimersAsync();

    // BOUNDED: at most MAX_POST_ATTEMPTS (2) posts total across the whole roll,
    // NOT one-per-phase (~14). No duplicate-DM storm.
    expect(relay.posts.length).toBeLessThanOrEqual(2);
    // No edits either (never got a message_id to edit).
    expect(relay.edits).toHaveLength(0);
  });

  it("succeeds on a delayed post: first post null, edits skipped, terminal re-post lands", async () => {
    // A relay that fails the FIRST post but succeeds the reserved terminal one.
    const relay = makeRelay(null);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 200 });
    const entry = makeEntry();
    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();
    expect(relay.posts).toHaveLength(1); // failed

    // Several phases: no re-post (backed off).
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 3 }));
    n.onPhase(entry, phase("agent-done", { agent: "a", n: 1, m: 3 }));
    await vi.advanceTimersByTimeAsync(200);
    expect(relay.posts).toHaveLength(1); // still just the one failed attempt

    // Terminal: relay now succeeds → exactly one reserved retry lands the final.
    relay.nextMessageId = 500;
    n.onTerminal(makeEntry({ result: "completed", rolled: ["a", "b", "c"] }));
    await vi.runAllTimersAsync();
    expect(relay.posts).toHaveLength(2); // initial (failed) + terminal (ok)
    expect(relay.posts.at(-1)!.text).toContain("✅");
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

  // ── End-to-end: canary-failure abort is the riskiest rollout path ──────────
  // Covers the whole chain in ONE test: the executor aborts on a failed canary,
  // BOTH (a) the narration reaches the terminal ❌ (not left mid-roll), AND
  // (b) the durable persist-pin NEVER runs (a failed canary must never leave a
  // pin persisted — the executor returns before the post-canary persist-pin
  // step). Previously these were only covered piecewise.
  it("canary-failure abort: terminal ❌ narrated AND persist-pin never runs", async () => {
    const TARGET = "v1.2.3";
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });

    // hostd-order plan: apply → canary (test-harness) → persist-pin → rest.
    // The persist-pin step sits AFTER the canary, so a failed canary must
    // return before it is ever reached.
    const steps = planRollout(["clerk", "test-harness"], {
      pinToPersist: TARGET,
      hostdContext: true,
    });
    expect(steps.some((s) => s.kind === "persist-pin")).toBe(true);

    const persisted: string[] = [];
    const entry = makeEntry();
    const deps: RolloutDeps = {
      run: () => ({ status: 0 }),
      // Canary comes back on the WRONG (stale) version → abort.
      probeVersion: () => "1.2.2",
      log: () => {},
      // Bridge the executor's phase emissions into the real narrator.
      emitPhase: (p) => n.onPhase(entry, p),
      persistPin: (pin) => persisted.push(pin),
    };

    const result = executeRollout(steps, TARGET, deps, { hostdContext: true });

    // Executor aborted at the canary, before rolling anyone or persisting.
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("restart-agent");
    expect(result.failedAgent).toBe("test-harness");
    expect(result.rolled).toEqual([]);
    // (b) persist-pin NEVER ran — a failed canary leaves no durable pin.
    expect(persisted).toEqual([]);

    // Feed the terminal error the way hostd would after the executor returns.
    n.onTerminal(
      makeEntry({
        result: "error",
        rolled: [],
        failed_step: result.failedStep,
        failed_agent: result.failedAgent,
        got: result.got ?? null,
      }),
    );
    await vi.runAllTimersAsync();

    // (a) narration reached a terminal ❌ naming the failed canary.
    const finalText =
      relay.edits.at(-1)?.text ?? relay.posts.at(-1)?.text ?? "";
    expect(finalText).toContain("❌");
    expect(finalText).toContain("test-harness");
  });
});
