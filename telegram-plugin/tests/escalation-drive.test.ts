import { describe, it, expect } from "vitest";
import { driveEscalation } from "../gateway/escalation-drive.js";
import { ObligationLedger } from "../gateway/obligation-ledger.js";

// Drives the REAL escalation step (the code obligationSweep calls) with the REAL
// ObligationLedger and the REAL withDeadline — including a fake hanging send,
// the exact path the total proof flagged and that mtcute / a synchronous test
// cannot reach. This is the executable verification of the hang-wedge fix.

function openEscalatable(L: ObligationLedger, id: string) {
  L.openIfAbsent({ originTurnId: id, chatId: "-100", threadId: 3, messageId: 1, text: "x", openedAt: 0 });
}

const MAX = 3;
const DEADLINE = 15; // ms — short so the hang case settles fast and deterministically

describe("driveEscalation — the obligation escalation step is bounded and always reaches a terminal", () => {
  it("a successful send closes the obligation and clears the in-flight flag", async () => {
    const L = new ObligationLedger(2);
    openEscalatable(L, "c#1");
    const inFlight = new Set<string>();
    await driveEscalation({
      escId: "c#1",
      inFlight,
      ledger: L,
      send: () => Promise.resolve("sent"),
      maxAttempts: MAX,
      deadlineMs: DEADLINE,
      log: () => {},
    });
    expect(L.isOpen("c#1")).toBe(false); // closed
    expect(inFlight.has("c#1")).toBe(false); // flag cleared
  });

  it("a transient failure below the cap stays OPEN and clears the flag (retried next sweep)", async () => {
    const L = new ObligationLedger(2);
    openEscalatable(L, "c#1");
    const inFlight = new Set<string>();
    await driveEscalation({
      escId: "c#1",
      inFlight,
      ledger: L,
      send: () => Promise.reject(new Error("network blip")),
      maxAttempts: MAX,
      deadlineMs: DEADLINE,
      log: () => {},
    });
    expect(L.isOpen("c#1")).toBe(true); // still open — will retry
    expect(inFlight.has("c#1")).toBe(false); // flag cleared, so the next sweep can re-enter
  });

  it("THE FIX: a send that NEVER settles still clears the flag (bounded by the deadline)", async () => {
    const L = new ObligationLedger(2);
    openEscalatable(L, "c#1");
    const inFlight = new Set<string>();
    let sendInvoked = 0;
    const start = Date.now();
    // A promise that never resolves/rejects — the stalled send that, pre-fix,
    // left the in-flight flag set forever and wedged the obligation OPEN.
    await driveEscalation({
      escId: "c#1",
      inFlight,
      ledger: L,
      send: () => {
        sendInvoked++;
        return new Promise(() => {});
      },
      maxAttempts: MAX,
      deadlineMs: DEADLINE,
      log: () => {},
    });
    expect(sendInvoked).toBe(1);
    expect(inFlight.has("c#1")).toBe(false); // cleared despite the hang — the wedge is gone
    expect(Date.now() - start).toBeLessThan(DEADLINE + 500); // settled at the deadline, not "never"
  });

  it("repeated hung sends reach a bounded terminal (close best-effort), never an infinite loop", async () => {
    const L = new ObligationLedger(2);
    openEscalatable(L, "c#1");
    const inFlight = new Set<string>();
    let sends = 0;
    let drives = 0;
    // Simulate the 5s sweep firing repeatedly while every send hangs.
    while (L.isOpen("c#1") && drives < 20) {
      drives++;
      const p = driveEscalation({
        escId: "c#1",
        inFlight,
        ledger: L,
        send: () => {
          sends++;
          return new Promise(() => {});
        },
        maxAttempts: MAX,
        deadlineMs: DEADLINE,
        log: () => {},
      });
      if (p) await p; // each attempt settles within the deadline
    }
    expect(L.isOpen("c#1")).toBe(false); // reached a terminal (closed best-effort)
    expect(inFlight.has("c#1")).toBe(false);
    expect(sends).toBe(MAX); // exactly maxAttempts sends, then close — bounded
    expect(drives).toBeLessThanOrEqual(MAX + 1);
  });

  it("the in-flight guard prevents a concurrent second send for the same obligation", async () => {
    const L = new ObligationLedger(2);
    openEscalatable(L, "c#1");
    const inFlight = new Set<string>();
    let sends = 0;
    const hang = () => {
      sends++;
      return new Promise<void>(() => {});
    };
    const p1 = driveEscalation({ escId: "c#1", inFlight, ledger: L, send: hang, maxAttempts: MAX, deadlineMs: 60, log: () => {} });
    // Second call while the first is still awaiting → must be a no-op.
    const p2 = driveEscalation({ escId: "c#1", inFlight, ledger: L, send: hang, maxAttempts: MAX, deadlineMs: 60, log: () => {} });
    expect(p2).toBeUndefined(); // guarded
    expect(sends).toBe(1); // only one send fired
    expect(L.list()[0].escalateAttempts).toBe(1); // only one attempt recorded
    await p1; // let the first settle so we don't leak a pending timer
  });
});
