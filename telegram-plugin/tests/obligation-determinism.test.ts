import { describe, it, expect } from "vitest";
import { ObligationLedger, type Obligation } from "../gateway/obligation-ledger.js";
import {
  loadObligations,
  persistObligations,
  type ObligationStoreFsSeam,
} from "../gateway/obligation-store.js";

/**
 * REGRESSION GUARD — not the proof.
 *
 * The actual determinism argument is closed-form and lives WITH the code: the
 * ledger is a finite FSM with a total transition function and a strictly-
 * decreasing measure μ = (REPRESENT_MAX - representCount) + (ESCALATE_MAX -
 * escalateAttempts) ⇒ every OPEN reaches a terminal (see the proof comment on
 * obligationSweep in gateway.ts and the ledger methods in obligation-ledger.ts).
 * A total state-machine proof also found — and a fix closed — the one liveness
 * hole this kind of SAMPLING test structurally cannot reach: a hung escalation
 * send leaking the in-flight flag (now bounded by withDeadline; guarded by
 * with-deadline.test.ts). The lesson stands: a random-schedule test only
 * exercises the behaviours its model encodes; it is evidence, never the proof.
 *
 * What this file still earns its keep doing: drive the REAL ObligationLedger +
 * REAL durable snapshot store over many random {model-behaviour × timing ×
 * restart} schedules to catch a regression that breaks the FSM invariant
 * (no silent drop, no double-ask of an answered message, bounded termination).
 * It models the lifecycle SYNCHRONOUSLY (open at receipt; close at turn_end on a
 * delivered answer; bounded represent→escalate; restart = hydrate from snapshot)
 * — so it does NOT and cannot cover async/coupling liveness (hung send, gate
 * never opening, drain wedging); those are proven/bounded in the code, not here.
 * The coalesced PARTIAL-ANSWER residual is also out of model — the one honest
 * hard limit (a turn-keyed ledger can't see "answered half" without parsing the
 * model's prose), mitigated by coalescing policy, not the ledger.
 */

// Mirrors the gateway constants under test.
const MAX_REPRESENTS = 2;
const ESCALATE_MAX = 3;

// Deterministic PRNG (mulberry32) so any failure reproduces from its seed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function memStore(): { fs: ObligationStoreFsSeam } {
  const files = new Map<string, string>();
  return {
    fs: {
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error(`ENOENT ${p}`);
        return files.get(p)!;
      },
      writeFileSync: (p, d) => files.set(p, d),
      renameSync: (a, b) => {
        if (!files.has(a)) throw new Error(`ENOENT ${a}`);
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      existsSync: (p) => files.has(p),
      fsyncFileSync: () => {},
      fsyncDirSync: () => {},
    },
  };
}

type Terminal = "answered" | "escalation-delivered" | "escalation-give-up";

interface Msg {
  id: string;
  /** Real numeric Telegram message id (the gateway only opens an obligation
   *  when deriveTurnId is non-null, i.e. messageId > 0 — so the durable row
   *  always carries a valid number). */
  msgId: number;
  /** Turn attempt index (0 = original, 1 = 1st re-present, 2 = 2nd) at which
   *  the model delivers a final answer. >MAX_REPRESENTS ⇒ never answered ⇒ escalates. */
  answerOnAttempt: number;
  /** How many escalation SEND attempts fail before one succeeds. ≥ESCALATE_MAX
   *  ⇒ permanently undeliverable ⇒ bounded give-up. */
  escalateFailsFor: number;
}

interface Sim {
  terminals: Map<string, Terminal>;
  steps: number;
}

function runSchedule(
  msgs: Msg[],
  seed: number,
  graceMs = 0,
  bgGraceMs = 0,
  bgAlwaysActive = false,
  // #3550 — per-represent grace. Exercised so the determinism proof actually
  // reaches `representGraceStillProtecting`; without this the fuzz never passes
  // representGraceMs and the branch is unvisited.
  representGraceMs = 0,
  // #3550 discriminator knob. When FALSE, a re-present turn ends WITHOUT ever
  // stamping noteTurnEnded — the "re-present still in flight" shape, in which
  // the early-out provably cannot fire and the full represent window is held.
  // Running the same seed both ways is what turns the represent-grace case from
  // a code-path exercise into a test that FAILS if the early-out is removed.
  stampTurnEndAfterRepresent = true,
): Sim {
  const PATH = "/state/agent/telegram/obligations.json";
  const store = memStore();
  let ledger = new ObligationLedger(MAX_REPRESENTS, {
    onChange: (snap) => persistObligations(PATH, store.fs, snap),
  });
  // Virtual monotonic clock (only meaningful when graceMs>0). Advances every
  // step by more than one sweep tick so the grace window deterministically
  // expires within the step budget — proving grace DELAYS but never PREVENTS a
  // terminal (no livelock).
  let clock = 1_000_000;
  const SWEEP_TICK = 5_000;
  const TURN_DURATION = 1_000; // virtual ms a turn occupies before it ends
  const r = rng(seed);

  const pending = [...msgs]; // not yet received
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const turnsHad = new Map<string, number>(); // total turns delivered to each obligation
  const terminals = new Map<string, Terminal>();
  const received = new Set<string>();

  const close = (id: string, why: Terminal) => {
    ledger.close(id);
    terminals.set(id, why);
  };

  // Run one turn for an obligation; close if the model answers on this attempt.
  // If it does NOT answer and grace is on, stamp the turn-end clock (mirrors the
  // gateway's endCurrentTurnAtomic !finalAnswerDelivered branch) so the next
  // decideAtIdle({now, graceMs}) waits out the grace before re-presenting.
  const deliverTurn = (id: string) => {
    const had = (turnsHad.get(id) ?? 0);
    const attemptIndex = had; // 0-based
    turnsHad.set(id, had + 1);
    const isRepresentTurn = attemptIndex > 0;
    if (byId.get(id)!.answerOnAttempt === attemptIndex) {
      close(id, "answered");
    } else if (isRepresentTurn && !stampTurnEndAfterRepresent) {
      // In-flight shape: the turn produced nothing observable, so nothing is
      // stamped and the per-represent window is held for its full duration.
      // (Deliberately NOT advancing the clock either — the two runs must differ
      // only in whether the early-out can fire.)
    } else if ((graceMs > 0 || representGraceMs > 0) && ledger.isOpen(id)) {
      // A turn takes real time: its end is strictly LATER than the represent
      // that triggered it. Without this the sim stamps lastTurnEndedAt equal to
      // lastRepresentedAt and the #3550 early-out (which requires strictly
      // greater) is never reached — the branch would go unproven.
      clock += TURN_DURATION;
      ledger.noteTurnEnded(id, clock);
    }
  };

  const ESC_IN_FLIGHT = new Set<string>(); // mirrors the gateway's concurrency guard (no-op in a sync model)

  let steps = 0;
  const CAP = 10_000; // generous; a real infinite loop blows past this and fails
  while (steps < CAP) {
    steps++;
    const open = ledger.hasOpen();
    // Receive a fresh inbound (interleave: maybe receive while something is open,
    // exercising multi-open). Always receive if nothing is open and work remains.
    if (pending.length > 0 && (!open || r() < 0.5)) {
      const m = pending.shift()!;
      received.add(m.id);
      // OPEN at receipt — keyed origin id; idempotent.
      ledger.openIfAbsent({
        originTurnId: m.id,
        chatId: "-100123",
        threadId: 3,
        messageId: m.msgId,
        text: `msg ${m.id}`,
        // When the background-work ceiling is exercised it is measured from
        // openedAt against `clock`, so openedAt must live on the same virtual
        // clock (the legacy proofs keep the tiny 1000+steps value — they never
        // read openedAt against `now`).
        openedAt: bgGraceMs > 0 ? clock : 1000 + steps,
      });
      deliverTurn(m.id); // original turn (attempt 0)
    } else if (open) {
      const decision =
        graceMs > 0 || bgGraceMs > 0 || representGraceMs > 0
          ? ledger.decideAtIdle({
              now: clock,
              graceMs,
              backgroundWorkActive: bgGraceMs > 0 && bgAlwaysActive,
              backgroundGraceMs: bgGraceMs,
              representGraceMs,
            })
          : ledger.decideAtIdle();
      if (decision.action === "none") {
        // Every open obligation is within its grace window — the sweep waits.
        // Advance the clock so grace deterministically expires; no livelock.
        clock += SWEEP_TICK;
        continue;
      }
      const o = decision.obligation as Obligation;
      // INVARIANT (no double-ask): a terminated obligation must never resurface.
      expect(terminals.has(o.originTurnId)).toBe(false);
      if (decision.action === "represent") {
        // Stamp on the SAME virtual clock as noteTurnEnded, otherwise the
        // per-represent window is measured against a wall-clock `Date.now()`
        // default and never interacts with the grace under test.
        ledger.markRepresented(o.originTurnId, clock);
        deliverTurn(o.originTurnId); // the re-present turn
      } else if (decision.action === "escalate") {
        if (ESC_IN_FLIGHT.has(o.originTurnId)) continue;
        const attempt = ledger.markEscalateAttempt(o.originTurnId);
        const willSucceed = byId.get(o.originTurnId)!.escalateFailsFor < attempt;
        if (willSucceed) {
          close(o.originTurnId, "escalation-delivered");
        } else if (attempt >= ESCALATE_MAX) {
          close(o.originTurnId, "escalation-give-up");
        }
        // else: transient failure — stays OPEN, retried next sweep.
      }
    } else {
      break; // idle: nothing pending, nothing open → done
    }

    // Random restart: the durable snapshot is the only thing that survives.
    // A fresh ledger hydrated from disk must resume exactly where we left off.
    if (r() < 0.15) {
      ledger = new ObligationLedger(MAX_REPRESENTS, {
        onChange: (snap) => persistObligations(PATH, store.fs, snap),
      });
      ledger.hydrate(loadObligations(PATH, store.fs));
    }
    // Advance the virtual clock every step so any stamped grace window
    // deterministically expires within the step budget.
    clock += SWEEP_TICK;
  }

  return { terminals, steps };
}

function pick<T>(arr: T[], r: () => number): T {
  return arr[Math.floor(r() * arr.length)];
}

describe("obligation determinism — every inbound reaches a terminal, no silent loss, no double-ask", () => {
  it("holds across 3000 random {model-behavior × timing × restart} schedules", () => {
    const ANSWER = [0, 1, 2, 3, 99]; // 0..2 = answered via ladder; 3/99 = never → escalate
    const ESCFAIL = [0, 1, 2, 3, 5]; // 0 = first send ok; ≥3 = permanently undeliverable
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed * 7919);
      const n = 1 + Math.floor(r() * 5); // 1..5 messages
      const msgs: Msg[] = [];
      for (let i = 0; i < n; i++) {
        const msgId = seed * 100 + i; // real positive integer id
        msgs.push({
          id: `c:3#${msgId}`,
          msgId,
          answerOnAttempt: pick(ANSWER, r),
          escalateFailsFor: pick(ESCFAIL, r),
        });
      }
      const { terminals, steps } = runSchedule(msgs, seed * 104729);

      // 1. TERMINATION: the engine settled well within the cap (no infinite loop).
      expect(steps).toBeLessThan(10_000);

      // 2. NO SILENT LOSS: every message received reached a terminal.
      for (const m of msgs) {
        const t = terminals.get(m.id);
        expect(t, `seed=${seed} msg=${m.id} answer=${m.answerOnAttempt} escFail=${m.escalateFailsFor}`).toBeDefined();

        // 3. CORRECT TERMINAL per behaviour:
        if (m.answerOnAttempt <= MAX_REPRESENTS) {
          // answerable within the represent ladder → answered (never escalated early)
          expect(t).toBe("answered");
        } else if (m.escalateFailsFor < ESCALATE_MAX) {
          // never answered, escalation eventually lands
          expect(t).toBe("escalation-delivered");
        } else {
          // never answered, escalation permanently undeliverable → bounded give-up
          expect(t).toBe("escalation-give-up");
        }
      }
    }
  });

  it("holds across 3000 schedules WITH the escalate-grace window on (grace delays, never prevents a terminal)", () => {
    const ANSWER = [0, 1, 2, 3, 99];
    const ESCFAIL = [0, 1, 2, 3, 5];
    const GRACE_MS = 45_000;
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed * 7919);
      const n = 1 + Math.floor(r() * 5);
      const msgs: Msg[] = [];
      for (let i = 0; i < n; i++) {
        const msgId = seed * 100 + i;
        msgs.push({
          id: `c:3#${msgId}`,
          msgId,
          answerOnAttempt: pick(ANSWER, r),
          escalateFailsFor: pick(ESCFAIL, r),
        });
      }
      // Same enumeration as the no-grace proof, but the ledger now runs the grace
      // path: every non-answering turn stamps noteTurnEnded and the sweep waits
      // out the window before acting. The terminal each message reaches must be
      // IDENTICAL to the no-grace run — grace only delays.
      const { terminals, steps } = runSchedule(msgs, seed * 104729, GRACE_MS);
      expect(steps).toBeLessThan(10_000); // still terminates (no grace livelock)
      for (const m of msgs) {
        const t = terminals.get(m.id);
        expect(t, `grace seed=${seed} msg=${m.id} answer=${m.answerOnAttempt} escFail=${m.escalateFailsFor}`).toBeDefined();
        if (m.answerOnAttempt <= MAX_REPRESENTS) {
          expect(t).toBe("answered");
        } else if (m.escalateFailsFor < ESCALATE_MAX) {
          expect(t).toBe("escalation-delivered");
        } else {
          expect(t).toBe("escalation-give-up");
        }
      }
    }
  });

  it("holds across 3000 schedules WITH background-work grace PERPETUALLY active (ceiling forces a terminal, never prevents one)", () => {
    // The hardest case for the new bound: the agent appears to be doing
    // autonomous sub-agent work for the ENTIRE run (backgroundWorkActive never
    // clears). The ledger must still drive every obligation to its correct
    // terminal — proving the OBLIGATION_BACKGROUND_WORK_GRACE_MS ceiling makes
    // the suppression bounded BY CONSTRUCTION (no livelock, no silent loss), and
    // that, like the trailing-answer grace, it only DELAYS: the terminal each
    // message reaches is IDENTICAL to the no-grace run. If always-on terminates
    // correctly, every intermittent work pattern does too (strictly less
    // suppression).
    const ANSWER = [0, 1, 2, 3, 99];
    const ESCFAIL = [0, 1, 2, 3, 5];
    const GRACE_MS = 45_000;
    const BG_CEIL_MS = 20 * 60_000; // mirrors OBLIGATION_BACKGROUND_WORK_GRACE_MS default
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed * 7919);
      const n = 1 + Math.floor(r() * 5);
      const msgs: Msg[] = [];
      for (let i = 0; i < n; i++) {
        const msgId = seed * 100 + i;
        msgs.push({
          id: `c:3#${msgId}`,
          msgId,
          answerOnAttempt: pick(ANSWER, r),
          escalateFailsFor: pick(ESCFAIL, r),
        });
      }
      const { terminals, steps } = runSchedule(msgs, seed * 104729, GRACE_MS, BG_CEIL_MS, true);
      expect(steps).toBeLessThan(10_000); // ceiling forces progress — no bg-grace livelock
      for (const m of msgs) {
        const t = terminals.get(m.id);
        expect(t, `bg seed=${seed} msg=${m.id} answer=${m.answerOnAttempt} escFail=${m.escalateFailsFor}`).toBeDefined();
        if (m.answerOnAttempt <= MAX_REPRESENTS) {
          expect(t).toBe("answered");
        } else if (m.escalateFailsFor < ESCALATE_MAX) {
          expect(t).toBe("escalation-delivered");
        } else {
          expect(t).toBe("escalation-give-up");
        }
      }
    }
  });

  it("holds across 3000 schedules WITH the per-represent grace on, and the #3550 early-out DISCRIMINATES (same terminals, strictly fewer sweeps)", () => {
    // Honest framing of what this case is and is not.
    //
    // The terminal assertions below are NOT a discriminator for the #3550 diff:
    // a terminal is a function of `answerOnAttempt` / `escalateFailsFor` alone,
    // and the worst-case schedule settles in ~72 sweep steps against a CAP of
    // 10_000. Revert the early-out and every terminal — and the step budget —
    // still holds. Those assertions are a NO-LIVELOCK / NO-LOSS guard on the
    // represent-grace path, nothing more, and are labelled as such.
    //
    // The discriminator is the paired run. The SAME seed is run twice, differing
    // in exactly one thing: whether a re-present turn ends (stamping
    // noteTurnEnded) or stays in flight. The early-out fires only in the first,
    // so:
    //   - terminals must be IDENTICAL — the early-out changes WHEN the ladder
    //     advances, never WHERE it lands; and
    //   - the ended-turn run must take STRICTLY FEWER sweep steps — which is
    //     the early-out actually firing and shortening rungs. Delete the
    //     early-out and both runs hold the full 120s window, the step counts
    //     become equal, and this assertion fails.
    const ANSWER = [0, 1, 2, 3, 99];
    const ESCFAIL = [0, 1, 2, 3, 5];
    const GRACE_MS = 45_000;       // trailing-answer grace, still armed
    const REPR_GRACE_MS = 120_000; // mirrors OBLIGATION_REPRESENT_GRACE_MS default
    let discriminated = 0; // schedules the early-out demonstrably shortened
    let totalRetired = 0;
    let totalInFlight = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed * 7919);
      const n = 1 + Math.floor(r() * 5);
      const msgs: Msg[] = [];
      for (let i = 0; i < n; i++) {
        const msgId = seed * 100 + i;
        msgs.push({
          id: `c:3#${msgId}`,
          msgId,
          answerOnAttempt: pick(ANSWER, r),
          escalateFailsFor: pick(ESCFAIL, r),
        });
      }
      const retired = runSchedule(msgs, seed * 104729, GRACE_MS, 0, false, REPR_GRACE_MS, true);
      const inFlight = runSchedule(msgs, seed * 104729, GRACE_MS, 0, false, REPR_GRACE_MS, false);

      // No-livelock / no-loss guard (NOT the #3550 discriminator).
      expect(retired.steps).toBeLessThan(10_000);
      expect(inFlight.steps).toBeLessThan(10_000);
      for (const m of msgs) {
        const t = retired.terminals.get(m.id);
        expect(t, `repr seed=${seed} msg=${m.id} answer=${m.answerOnAttempt} escFail=${m.escalateFailsFor}`).toBeDefined();
        if (m.answerOnAttempt <= MAX_REPRESENTS) {
          expect(t).toBe("answered");
        } else if (m.escalateFailsFor < ESCALATE_MAX) {
          expect(t).toBe("escalation-delivered");
        } else {
          expect(t).toBe("escalation-give-up");
        }
      }

      // DISCRIMINATOR 1 — the early-out is terminal-neutral.
      expect(
        [...retired.terminals].sort(),
        `terminals diverged at seed=${seed}`,
      ).toEqual([...inFlight.terminals].sort());

      // DISCRIMINATOR 2 — the early-out actually fires and shortens rungs.
      // Directional per seed (retiring a grace can never ADD sweeps)…
      expect(
        retired.steps,
        `early-out LENGTHENED seed=${seed} (retired=${retired.steps} inFlight=${inFlight.steps})`,
      ).toBeLessThanOrEqual(inFlight.steps);
      // …and strictly shorter on the schedules that actually sit out a rung.
      // Not every schedule does: with several messages interleaved, other work
      // can advance the virtual clock past the window with no waiting sweep, so
      // the strict inequality is asserted in aggregate rather than per seed.
      if (retired.steps < inFlight.steps) discriminated++;
      totalRetired += retired.steps;
      totalInFlight += inFlight.steps;
    }
    // Delete the early-out and BOTH runs hold the full 120s window: every seed
    // becomes equal, `discriminated` drops to 0 and the totals converge. These
    // two assertions are what make this case a real test of the #3550 diff.
    expect(discriminated, "the #3550 early-out never shortened a single schedule").toBeGreaterThan(1_000);
    expect(totalRetired).toBeLessThan(totalInFlight);
  });

  it("a delivered-but-unanswered obligation survives a restart and is escalated, not lost", () => {
    // Deterministic single case: model NEVER answers, escalation succeeds first try,
    // with a restart forced mid-life via a seed that triggers the 0.15 branch.
    const { terminals } = runSchedule(
      [{ id: "c:3#715", msgId: 715, answerOnAttempt: 99, escalateFailsFor: 0 }],
      42,
    );
    expect(terminals.get("c:3#715")).toBe("escalation-delivered");
  });

  it("escalation that is permanently undeliverable is bounded (give-up), never an infinite loop", () => {
    const { terminals, steps } = runSchedule(
      [{ id: "c:3#900", msgId: 900, answerOnAttempt: 99, escalateFailsFor: 99 }],
      7,
    );
    expect(terminals.get("c:3#900")).toBe("escalation-give-up");
    expect(steps).toBeLessThan(10_000);
  });
});
