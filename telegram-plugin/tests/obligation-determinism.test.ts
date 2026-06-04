import { describe, it, expect } from "vitest";
import { ObligationLedger, type Obligation } from "../gateway/obligation-ledger.js";
import {
  loadObligations,
  persistObligations,
  type ObligationStoreFsSeam,
} from "../gateway/obligation-store.js";

/**
 * DETERMINISM PROOF (by exhaustive simulation, not live observation).
 *
 * The operator's requirement: be confident — by reasoning — that EVERY real
 * inbound reaches answered-or-escalated for ANY model behaviour and ANY timing,
 * including across a restart, with no silent drop and no double-ask of a message
 * that WAS answered.
 *
 * This drives the REAL ObligationLedger + the REAL durable snapshot store
 * (obligation-store, over an in-memory fs whose rename is atomic) through a
 * faithful model of the gateway's obligation lifecycle:
 *
 *   OPEN     — on receipt (handleInbound, idempotent).
 *   close    — at turn_end iff the turn delivered a final answer (finalAnswerDelivered).
 *   represent— idle sweep, bounded by maxRepresents, drives a fresh must-answer turn.
 *   escalate — ladder exhausted: send the operator nudge; close ONLY after it
 *              lands; a transient send failure stays OPEN and retries; a permanent
 *              one is bounded (OBLIGATION_ESCALATE_MAX) → close best-effort.
 *   restart  — fresh ledger hydrated from the durable snapshot (counters intact).
 *
 * Over thousands of random schedules it asserts the invariant holds and the
 * engine always terminates (no infinite loop). The COALESCED PARTIAL-ANSWER
 * residual is deliberately NOT modelled — it is the one honest hard limit (a
 * turn-keyed ledger cannot see "answered half" without parsing model prose) and
 * is mitigated by coalescing policy, not the ledger.
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

function runSchedule(msgs: Msg[], seed: number): Sim {
  const PATH = "/state/agent/telegram/obligations.json";
  const store = memStore();
  let ledger = new ObligationLedger(MAX_REPRESENTS, {
    onChange: (snap) => persistObligations(PATH, store.fs, snap),
  });
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
  const deliverTurn = (id: string) => {
    const had = (turnsHad.get(id) ?? 0);
    const attemptIndex = had; // 0-based
    turnsHad.set(id, had + 1);
    if (byId.get(id)!.answerOnAttempt === attemptIndex) close(id, "answered");
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
        openedAt: 1000 + steps,
      });
      deliverTurn(m.id); // original turn (attempt 0)
    } else if (open) {
      const decision = ledger.decideAtIdle();
      const o = decision.obligation as Obligation;
      // INVARIANT (no double-ask): a terminated obligation must never resurface.
      expect(terminals.has(o.originTurnId)).toBe(false);
      if (decision.action === "represent") {
        ledger.markRepresented(o.originTurnId);
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
