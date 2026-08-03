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
  type RolloutCardEscalation,
  type RolloutEditOutcome,
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
  /**
   * #4065 — outcome an edit resolves to, as a function of the target
   * message_id. Defaults to success (the pre-#4065 happy path).
   */
  editOutcome: (messageId: number) => RolloutEditOutcome;
  /** Resolve all pending posts (they resolve on a microtask). */
}

function makeRelay(nextMessageId: number | null = 100): FakeRelay {
  const posts: { requestId: string; text: string }[] = [];
  const edits: { messageId: number; text: string }[] = [];
  const relay: FakeRelay = {
    posts,
    edits,
    nextMessageId,
    editOutcome: () => ({ ok: true }),
    async post(args) {
      posts.push({ requestId: args.requestId, text: args.text });
      return relay.nextMessageId;
    },
    async edit(args) {
      edits.push({ messageId: args.messageId, text: args.text });
      return relay.editOutcome(args.messageId);
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

  it("a seeded (post-self-bump) narrator EDITs the carried card and NEVER re-posts", async () => {
    // Regression for the self-bump card bug: when hostd recreates itself onto
    // the new CLI, the old process's in-memory message_id was lost, so the
    // resumed narrator re-posted a fresh card and stranded the original frozen.
    // Seeding the carried message_id must make the resumed roll take the EDIT
    // branch on its very first phase — post() must never fire.
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 1000 });
    const entry = makeEntry();

    // Old hostd had already posted card 4242; the new hostd carries the id.
    n.seedPostedMessage("ro-1", "overlord", 4242);

    // First phase after the self-bump.
    n.onPhase(entry, phase("self-bump-done"));
    await vi.advanceTimersByTimeAsync(1000);

    // Subsequent agent phases through to a converged terminal.
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 2 }));
    n.onPhase(entry, phase("agent-done", { agent: "a", n: 1, m: 2 }));
    await vi.advanceTimersByTimeAsync(1000);
    n.onTerminal(makeEntry({ result: "completed", rolled: ["a", "b"] }));
    await vi.runAllTimersAsync();

    // The card was NEVER re-posted — the whole point of the fix.
    expect(relay.posts).toHaveLength(0);
    // Every edit landed on the carried card id, including the converged render.
    expect(relay.edits.length).toBeGreaterThanOrEqual(1);
    expect(relay.edits.every((e) => e.messageId === 4242)).toBe(true);
    expect(relay.edits.at(-1)!.messageId).toBe(4242);
    expect(relay.edits.at(-1)!.text).toContain("✅");
  });

  // ── #4065: a seeded-resume edit into a card that is GONE ───────────────────
  // The operator outcome under test: a roll always ends on a truthful card. A
  // seeded narrator holds a message_id it never posted; if that card is gone
  // (operator deleted it, or it is no longer editable) the pre-#4065 code
  // edited into the void for the REST of the roll and the operator saw no
  // terminal ✅/❌ at all.

  it("re-posts exactly ONCE when a seeded card is gone, and the terminal card lands", async () => {
    const relay = makeRelay(5555); // the re-post lands as card 5555
    // Card 4242 (carried across the self-bump) was deleted; 5555 is editable.
    relay.editOutcome = (messageId) =>
      messageId === 4242
        ? { ok: false, gone: true, reason: "message to edit not found" }
        : { ok: true };
    const escalations: RolloutCardEscalation[] = [];
    const n = new LogTailRolloutNarrator(relay, {
      debounceMs: 1000,
      escalate: (e) => escalations.push(e),
    });
    const entry = makeEntry();

    n.seedPostedMessage("ro-1", "overlord", 4242);
    n.onPhase(entry, phase("self-bump-done"));
    await vi.runAllTimersAsync();

    // The dead card was answered with exactly one fresh post.
    expect(relay.posts).toHaveLength(1);

    // The roll continues on the NEW card, terminal included.
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 2 }));
    n.onPhase(entry, phase("agent-done", { agent: "a", n: 1, m: 2 }));
    await vi.runAllTimersAsync();
    n.onTerminal(makeEntry({ result: "completed", rolled: ["a", "b"] }));
    await vi.runAllTimersAsync();

    // Still exactly one re-post (no post-per-phase storm), and the operator
    // ends up looking at a live card carrying the terminal outcome.
    expect(relay.posts).toHaveLength(1);
    expect(relay.edits.at(-1)!.messageId).toBe(5555);
    expect(relay.edits.at(-1)!.text).toContain("✅");
    // A restored card is not a failure — nothing escalated.
    expect(escalations).toEqual([]);
  });

  it("escalates to telemetry (never a second card) when the one re-post also fails", async () => {
    const relay = makeRelay(null); // every post fails
    relay.editOutcome = () => ({
      ok: false,
      gone: true,
      reason: "message to edit not found",
    });
    const escalations: RolloutCardEscalation[] = [];
    const n = new LogTailRolloutNarrator(relay, {
      debounceMs: 1000,
      escalate: (e) => escalations.push(e),
    });
    const entry = makeEntry();

    n.seedPostedMessage("ro-1", "overlord", 4242);
    n.onPhase(entry, phase("self-bump-done"));
    await vi.runAllTimersAsync();

    // Keep the roll going: a looping implementation would post (or edit-then-
    // post) once per phase from here on.
    for (let i = 1; i <= 6; i++) {
      n.onPhase(entry, phase("agent-start", { agent: `a${i}`, n: i, m: 6 }));
      n.onPhase(entry, phase("agent-done", { agent: `a${i}`, n: i, m: 6 }));
      await vi.runAllTimersAsync();
    }
    n.onTerminal(makeEntry({ result: "completed", rolled: [] }));
    await vi.runAllTimersAsync();

    // Exactly ONE re-post attempt, ever — no storm.
    expect(relay.posts).toHaveLength(1);
    // And exactly one telemetry escalation carrying the stale id.
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      requestId: "ro-1",
      agentName: "overlord",
      staleMessageId: 4242,
      reason: "repost-failed",
    });
  });

  it("does NOT re-post on a transient edit failure (no duplicate card)", async () => {
    // A 429 past the gateway's retries / a socket blip leaves a perfectly good
    // card in the chat. Re-posting would duplicate it.
    const relay = makeRelay(5555);
    relay.editOutcome = () => ({
      ok: false,
      gone: false,
      reason: "timed out",
    });
    const escalations: RolloutCardEscalation[] = [];
    const n = new LogTailRolloutNarrator(relay, {
      debounceMs: 1000,
      escalate: (e) => escalations.push(e),
    });
    const entry = makeEntry();

    n.seedPostedMessage("ro-1", "overlord", 4242);
    n.onPhase(entry, phase("self-bump-done"));
    await vi.runAllTimersAsync();
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 2 }));
    await vi.runAllTimersAsync();
    n.onTerminal(makeEntry({ result: "completed", rolled: ["a"] }));
    await vi.runAllTimersAsync();

    expect(relay.posts).toHaveLength(0);
    expect(relay.edits.every((e) => e.messageId === 4242)).toBe(true);
    expect(escalations).toEqual([]);
  });

  it("surfaces the learned message_id to the onMessageId sink exactly once on first post", async () => {
    const relay = makeRelay(777);
    const seen: { requestId: string; messageId: number }[] = [];
    const n = new LogTailRolloutNarrator(relay, {
      debounceMs: 1000,
      onMessageId: (requestId, messageId) => seen.push({ requestId, messageId }),
    });
    const entry = makeEntry();

    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();
    n.onPhase(entry, phase("agent-start", { agent: "a", n: 1, m: 2 }));
    await vi.advanceTimersByTimeAsync(1000);

    // Fired once, on the post that learned the id — not on later edits.
    expect(seen).toEqual([{ requestId: "ro-1", messageId: 777 }]);
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

  it("carries the drifted component names onto the Telegram card (#3928)", async () => {
    // End-to-end for the operator-facing half of #3928: the roll's
    // `drifted[]` must survive sentinel → StatusEntry → narrator → render,
    // because Telegram is the only surface the operator has.
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();
    n.onPhase(entry, phase("canary-start", { agent: "test-harness", n: 1, m: 2 }));
    await vi.runAllTimersAsync();

    n.onTerminal(
      makeEntry({
        result: "error",
        rolled: ["test-harness", "klanker"],
        failed_step: "verify-components",
        drifted: ["switchroom-web", "switchroom-hindsight-autoheal"],
      }),
    );
    await vi.runAllTimersAsync();
    const t = relay.edits.at(-1)!.text;
    expect(t).toContain("INCOMPLETE");
    expect(t).toContain("switchroom-web");
    expect(t).toContain("switchroom-hindsight-autoheal");
    expect(t).toContain("Re-running the roll will NOT fix this");
  });

  it("renders a truthful singleton/shared section that tracks the singleton phases", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();

    // From the FIRST post the card must answer for the singletons, not just
    // the agents: web/hindsight pending, hostd honestly deferred (the
    // agent-invoked path cannot recreate its own hostd), shared services
    // named with their self-heal mechanism.
    n.onPhase(entry, phase("apply"));
    await vi.runAllTimersAsync();
    const first = relay.posts[0]!.text;
    expect(first).toContain("**Singletons / shared:**");
    expect(first).toContain("- · `switchroom-web`");
    expect(first).toContain("- · `hindsight`");
    expect(first).toContain("- ⧗ `hostd` — host-side");
    expect(first).toContain("self-heal with the first agent restart");

    // hindsight skip renders as an honest ○, not a ✓. Fed in REAL plan order:
    // refresh-hindsight runs BEFORE the canary on both plan paths (#4047).
    n.onPhase(entry, phase("hindsight-skipped"));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits.at(-1)!.text).toContain(
      "- ○ `hindsight` — no hindsight container on this host",
    );

    // First agent done → the shared singletons' self-heal ran (⏳, verified
    // at end — never a bare ✓ mid-roll).
    n.onPhase(entry, phase("canary-start", { agent: "test-harness", n: 1, m: 2 }));
    n.onPhase(entry, phase("canary-pass", { agent: "test-harness", n: 1, m: 2 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits.at(-1)!.text).toContain(
      "recreated with the first agent restart — verified at roll end",
    );

    // web refresh: ⏳ on -start, ✓ only on the observed -done.
    n.onPhase(entry, phase("web-refresh"));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits.at(-1)!.text).toContain("- ⏳ `switchroom-web` — webd install…");
    n.onPhase(entry, phase("web-refresh-done"));
    await vi.advanceTimersByTimeAsync(500);
    expect(relay.edits.at(-1)!.text).toContain("- ✓ `switchroom-web`");
  });

  it("terminal ✅ reconciles the singleton rows from the verify-components outcome", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();
    n.onPhase(entry, phase("canary-start", { agent: "a", n: 1, m: 1 }));
    n.onPhase(entry, phase("canary-pass", { agent: "a", n: 1, m: 1 }));
    await vi.runAllTimersAsync();
    // NO web/hindsight phases arrived (e.g. --skip-web) — a completed roll
    // must render them as skipped, never as a fabricated ✓.
    n.onTerminal(makeEntry({ result: "completed", rolled: ["a"] }));
    await vi.runAllTimersAsync();
    const final = relay.edits.at(-1)!.text;
    expect(final).toContain("- ○ `switchroom-web` — no refresh observed in this roll");
    expect(final).toContain("- ○ `hindsight` — no refresh observed in this roll");
    // Shared services: the end-of-roll component check passed with them in
    // scope (gatedOwners always gates "fleet"), so ✓ is an observation.
    expect(final).toContain(
      "- ✓ `shared services (approval-kernel · auth-broker · vault-broker · voice)`",
    );
    expect(final).toContain("end-of-roll check passed");
    // hostd stays the deferral truth.
    expect(final).toContain("- ⧗ `hostd`");
  });

  it("terminal drift (#3928) marks the named singleton ✗ — even past a web-refresh-done", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();
    n.onPhase(entry, phase("web-refresh"));
    n.onPhase(entry, phase("web-refresh-done"));
    await vi.runAllTimersAsync();
    n.onTerminal(
      makeEntry({
        result: "error",
        failed_step: "verify-components",
        rolled: ["a"],
        drifted: ["switchroom-web"],
      }),
    );
    await vi.runAllTimersAsync();
    const final = relay.edits.at(-1)!.text;
    expect(final).toContain("- ✗ `switchroom-web` — still behind (switchroom-web)");
  });

  it("terminal refresh-hindsight failure marks hindsight ✗ with the recovery command", async () => {
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 500 });
    const entry = makeEntry();
    n.onPhase(entry, phase("hindsight-refresh"));
    await vi.runAllTimersAsync();
    n.onTerminal(
      makeEntry({ result: "error", failed_step: "refresh-hindsight", rolled: ["a"] }),
    );
    await vi.runAllTimersAsync();
    const final = relay.edits.at(-1)!.text;
    expect(final).toContain("- ✗ `hindsight`");
    expect(final).toContain("switchroom memory setup");
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
      persistPin: (pin) => {
        persisted.push(pin);
        return true;
      },
      // Hermetic: refresh-hindsight now runs BEFORE the canary restart, so pin
      // the probe to false rather than letting it shell out to a real docker.
      hindsightExists: () => false,
    };

    const result = await executeRollout(steps, TARGET, deps, { hostdContext: true });

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

  // ── Regression: #4047 plan order vs the monotonic seq gate ─────────────────
  // #4047 moved refresh-hindsight BEFORE the canary restart; the narrator's
  // seq table still anchored the hindsight phases at their pre-#4047
  // end-of-roll position (MAX_SAFE_INTEGER - 3). So the first
  // hindsight-refresh phase pushed lastAppliedSeq near the ceiling and the
  // monotonic gate DROPPED every later canary/agent/web phase — the
  // operator's card froze at "hindsight refreshed" for the rest of the roll
  // (observed on the v0.19.48 → v0.20.0 prod roll, request
  // mcp-rollout-1785727512601: zero card edits for the entire 16-minute
  // canary + 12-agent window). Drive the REAL executor over the REAL hostd
  // plan so this test re-fails if the plan order and the seq table ever
  // drift apart again.
  it("keeps editing through canary + agents when hindsight refreshes BEFORE the canary (real hostd plan order)", async () => {
    const TARGET = "v1.2.3";
    const relay = makeRelay(100);
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 200 });

    const steps = planRollout(["clerk", "overlord", "test-harness"], {
      pinToPersist: TARGET,
      hostdContext: true,
      skipWeb: true, // web probes shell out; the frozen window under test is canary+agents
    });
    // Tether to the real plan: refresh-hindsight precedes the first
    // restart-agent. If this ever flips back, the seq table must move with it.
    expect(steps.findIndex((s) => s.kind === "refresh-hindsight")).toBeLessThan(
      steps.findIndex((s) => s.kind === "restart-agent"),
    );

    const entry = makeEntry();
    const deps: RolloutDeps = {
      run: () => ({ status: 0 }),
      probeVersion: () => "1.2.3", // every restart converges on the target
      log: () => {},
      emitPhase: (p) => n.onPhase(entry, p),
      persistPin: () => true,
      // Hermetic AND on the prod path: hindsight exists, so the executor
      // emits hindsight-refresh → hindsight-refresh-done before the canary.
      hindsightExists: () => true,
      sleepMs: async () => {},
    };

    const result = await executeRollout(steps, TARGET, deps, {
      hostdContext: true,
    });
    expect(result.ok).toBe(true);
    await vi.runAllTimersAsync();

    // The card kept editing THROUGH the agent window after the pre-canary
    // hindsight refresh: the canary and every agent appear on the final
    // mid-roll render, and hindsight kept its observed ✓. Before the fix the
    // canary/agent phases were dropped by the seq gate, so no agent row ever
    // reached the card.
    expect(relay.edits.length).toBeGreaterThanOrEqual(1);
    const last = relay.edits.at(-1)!.text;
    expect(last).toContain("`test-harness` (canary)");
    expect(last).toContain("- ✓ `clerk`");
    expect(last).toContain("- ✓ `overlord`");
    expect(last).toContain("- ✓ `hindsight`");
  });
});
