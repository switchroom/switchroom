import { describe, it, expect } from "vitest";
import {
  scanAgent,
  parseTurns,
  detectTurnFindings,
  detectGatewayFindings,
  extractTs,
  HANG_MS,
  SILENT_NOOP_FLOOR_TS,
  GATEWAY_SIGNAL_NAMES,
} from "./detect.js";
import type { L0Signal } from "./detect.js";
import { mapSignal, countingUnitFor } from "./mapping.js";
import { ROUTE_FIELD_SHIP_TS } from "../../telegram-plugin/gateway/turn-record-status.js";

/**
 * Pins the model-free L0 detector port (from the validated `spec_audit_l0.py`):
 * the tuned hang threshold, the `synthetic-` exclusion, and the precise gateway
 * signatures. All fixtures use SYNTHETIC turn ids — never a real Telegram id.
 */

// Synthetic origin_turn_ids: `<synthetic-chat>:_#<seq>`.
const CHAT = "77770001";

function turn(seq: number, over: Record<string, unknown>): string {
  return JSON.stringify({
    ts: 1_782_600_000 + seq,
    agent: "alpha",
    turn_id: `${CHAT}:_#${seq}`,
    status: "complete",
    tools: 5,
    duration_ms: 40_000,
    ...over,
  });
}

describe("parseTurns", () => {
  it("skips malformed lines without throwing", () => {
    const text = [turn(1, {}), "{not json", "", turn(2, {})].join("\n");
    expect(parseTurns(text)).toHaveLength(2);
  });
});

describe("detectTurnFindings", () => {
  it("flags a silent no-op (complete, zero tools, real turn)", () => {
    // Fixture base ts (1_782_600_000 ≈ 2026-06-27) is BELOW the default
    // SILENT_NOOP_FLOOR_TS (2026-07-13), so pass floor:0 to assert the detector
    // LOGIC independent of the calendar window.
    // A genuine go-forward silent no-op carries route:'none' (nothing reached
    // the user). route is what makes it a silent no-op vs a flush-recovery.
    const turns = parseTurns(turn(10, { tools: 0, route: "none" }));
    const f = detectTurnFindings("alpha", turns, { silentNoopFloorTs: 0 });
    expect(f.map((x) => x.signal)).toContain("silent-no-op-candidate");
  });

  it("windows OUT a silent no-op whose ts is below the floor (Fix 2)", () => {
    // Same complete/zero-tool turn, but under the default floor its 2026-06-27
    // ts is pre-fix backlog → it must NOT be flagged.
    const turns = parseTurns(turn(10, { tools: 0 }));
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).not.toContain("silent-no-op-candidate");
  });

  it("flags a silent no-op whose ts is AT/ABOVE the default floor (Fix 2)", () => {
    // A post-fix turn (ts at the 2026-07-13 floor) is still a real signal — the
    // windowing must not swallow go-forward silent no-ops.
    const turns = parseTurns(
      turn(10, { tools: 0, route: "none", ts: SILENT_NOOP_FLOOR_TS + 100 }),
    );
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).toContain("silent-no-op-candidate");
  });

  it("does NOT flag a synthetic zero-tool turn as a silent no-op", () => {
    const turns = parseTurns(
      JSON.stringify({
        turn_id: `${CHAT}:_#synthetic-boot`,
        status: "complete",
        tools: 0,
        duration_ms: 1000,
      }),
    );
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).not.toContain("silent-no-op-candidate");
  });

  it("flags a killed/incomplete turn", () => {
    const turns = parseTurns(turn(11, { status: "killed", tools: 3 }));
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).toContain("killed-incomplete-turn");
  });

  it("does not flag no_reply as incomplete", () => {
    const turns = parseTurns(turn(12, { status: "no_reply", tools: 1 }));
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).not.toContain("killed-incomplete-turn");
  });

  it("flags send_failed as its own signal, NOT the killed catch-all (Fix 2)", () => {
    // gateway PR B writes status=send_failed when a turn-flush answer failed to
    // reach the user. It must surface as `send-failed-delivery` (a delivery
    // failure), not be miscategorised as `killed-incomplete-turn` (killed
    // mid-run) — which would corrupt that signal's meaning.
    const turns = parseTurns(turn(15, { status: "send_failed", tools: 0 }));
    const signals = detectTurnFindings("alpha", turns).map((x) => x.signal);
    expect(signals).toContain("send-failed-delivery");
    expect(signals).not.toContain("killed-incomplete-turn");
    // and a send_failed turn with tools:0 must NOT be a silent-no-op (it is an
    // honest delivery failure, not a benign complete-zero-tools turn).
    expect(signals).not.toContain("silent-no-op-candidate");
  });

  it("flags a hang only when long AND stalled (few tools)", () => {
    const stalled = parseTurns(turn(13, { duration_ms: HANG_MS + 1, tools: 1 }));
    const productive = parseTurns(turn(14, { duration_ms: HANG_MS + 1, tools: 9 }));
    expect(detectTurnFindings("alpha", stalled).map((x) => x.signal)).toContain(
      "hang-long-stalled",
    );
    expect(
      detectTurnFindings("alpha", productive).map((x) => x.signal),
    ).not.toContain("hang-long-stalled");
  });
});

describe("honest route splits silent-no-op from flush-recovery", () => {
  // All fixtures are complete/tools:0 at/after ROUTE_FIELD_SHIP_TS — the exact
  // shape that used to ALL score sev-3 silent-no-op. The `route` field is what
  // now tells them apart.
  const routed = (route: string | undefined, over: Record<string, unknown> = {}) =>
    parseTurns(
      turn(20, {
        tools: 0,
        ts: ROUTE_FIELD_SHIP_TS + 100,
        ...(route === undefined ? {} : { route }),
        ...over,
      }),
    );

  it("THE FALSIFIER: a flush-recovered turn yields ZERO silent-no-op and exactly ONE flush-recovered-turn", () => {
    const f = detectTurnFindings("alpha", routed("flush"));
    const signals = f.map((x) => x.signal);
    expect(signals.filter((s) => s === "silent-no-op-candidate")).toHaveLength(0);
    expect(signals.filter((s) => s === "flush-recovered-turn")).toHaveLength(1);
  });

  it("route:none still escalates as sev-3 silent-no-op-candidate", () => {
    const signals = detectTurnFindings("alpha", routed("none")).map((x) => x.signal);
    expect(signals).toContain("silent-no-op-candidate");
    expect(signals).not.toContain("flush-recovered-turn");
  });

  it("route:reply and route:stream produce no silent-no-op finding", () => {
    for (const r of ["reply", "stream"]) {
      const signals = detectTurnFindings("alpha", routed(r)).map((x) => x.signal);
      expect(signals).not.toContain("silent-no-op-candidate");
      expect(signals).not.toContain("flush-recovered-turn");
    }
  });

  it("legacy row (no route) BELOW the ship epoch is aged out — no sev-3", () => {
    const legacy = parseTurns(
      turn(21, { tools: 0, ts: ROUTE_FIELD_SHIP_TS - 100 }),
    );
    const signals = detectTurnFindings("alpha", legacy).map((x) => x.signal);
    expect(signals).not.toContain("silent-no-op-candidate");
  });

  it("field-less row AT/AFTER the ship epoch is treated as none (regression still surfaces)", () => {
    const signals = detectTurnFindings("alpha", routed(undefined)).map((x) => x.signal);
    expect(signals).toContain("silent-no-op-candidate");
  });

  /**
   * #4735 — `ROUTE_FIELD_SHIP_TS` is a hand-written literal
   * (`turn-record-status.ts:91` = 2026-07-31T00:00:00Z), but the `route` field
   * only reached each agent at ITS OWN container restart: the earliest real
   * `route` row anywhere on the fleet carries ts 1785492486 (+10.1h) and the
   * last agent's first carries 1785524964 (+19.2h). Every field-less row in
   * that gap was read as "the gateway dropped the field" — a severity-3
   * regression — when it was simply a legacy row. All five recorded occurrences
   * were false, and every one of them carries `landed_unconfirmed: 1`.
   *
   * The durable gate is that field, not a bigger constant.
   * `landed_unconfirmed` is written only by the backstop read-back accounting
   * (`turn-record-status.ts:255-269`) and counts message ids TELEGRAM ACKED.
   * Its presence is positive evidence a send left the gateway, which is
   * precisely what "silent no-op" denies — so it settles the row's class no
   * matter what the calendar says.
   */
  describe("#4735 — a row that LANDED a message id is not a silent no-op", () => {
    it("THE FALSIFIER: field-less row AT the ship epoch with landed_unconfirmed:1 yields ZERO sev-3", () => {
      const signals = detectTurnFindings(
        "alpha",
        routed(undefined, { landed_unconfirmed: 1 }),
      ).map((x) => x.signal);
      expect(signals.filter((s) => s === "silent-no-op-candidate")).toHaveLength(0);
      expect(signals.filter((s) => s === "flush-recovered-turn")).toHaveLength(1);
    });

    it("route:none with landed_unconfirmed:1 is a backstop delivery, not silence", () => {
      const signals = detectTurnFindings(
        "alpha",
        routed("none", { landed_unconfirmed: 1 }),
      ).map((x) => x.signal);
      expect(signals).not.toContain("silent-no-op-candidate");
      expect(signals).toContain("flush-recovered-turn");
    });

    it("landed_unconfirmed:0 does NOT clear the finding — zero landed ids is no evidence", () => {
      const signals = detectTurnFindings(
        "alpha",
        routed("none", { landed_unconfirmed: 0 }),
      ).map((x) => x.signal);
      expect(signals).toContain("silent-no-op-candidate");
    });

    it("a landed row that ALSO routed reply/stream stays finding-free (no phantom flush-recovery)", () => {
      for (const r of ["reply", "stream"]) {
        const signals = detectTurnFindings(
          "alpha",
          routed(r, { landed_unconfirmed: 1 }),
        ).map((x) => x.signal);
        expect(signals).not.toContain("silent-no-op-candidate");
        expect(signals).not.toContain("flush-recovered-turn");
      }
    });
  });
});

/**
 * #4735 — `status=err` on a `tg-post` rich send was specified (#3931) to mean a
 * TERMINAL outcome, but that contract only holds for sends routed through
 * `createRetryApiCall`: `willRetryTelegramFailure` returns `false` the moment
 * the attempt context is absent (`retry-api-call.ts:207`). Every recovery
 * ladder outside that policy — the THREAD_NOT_FOUND thread-drop the policy
 * hands OFF to the caller by design, the edit-flood-fuse deferral that
 * re-issues on a later tick, the backstop re-attempt, the queued-card re-send —
 * logged a send that DID deliver as terminal. On the live fleet 12 of 16
 * occurrences provably delivered, i.e. the operator was paged about replies
 * they had already read.
 *
 * These fixtures assert the OUTCOME (which signal the ledger books), not that a
 * branch ran. Every one of them fails on the pre-fix detector, which books
 * `reply-delivery-failure` for all of them.
 */
describe("#4735 — a recovered rich send is not a delivery failure", () => {
  const GCHAT = "-1001234567890";
  const post = (t: string, status: string, desc: string, chat = GCHAT, thread = "-") =>
    `[2026-08-11T${t}Z] tg-post method=sendRichMessage chat=${chat} thread=${thread}` +
    ` parse_mode=none bytes=0 hash=- status=${status} err=telegram_400 code=400 desc=${desc}`;

  const signalsOf = (lines: string[]) =>
    detectGatewayFindings("alpha", lines.join("\n")).findings.map((f) => f.signal);

  it("THE FALSIFIER: thread-drop ladder — thread-not-found then a landed send", () => {
    // The observed shape (2026-08-10 04:04:20.210, recovered in 554ms): the
    // first attempt carries the thread, the ladder drops it and re-sends bare.
    const s = signalsOf([
      post("04:04:20.210", "err", "Bad Request: message thread not found", GCHAT, "635"),
      post("04:04:20.764", "ok", "-"),
    ]);
    expect(s.filter((x) => x === "reply-delivery-failure")).toHaveLength(0);
    expect(s.filter((x) => x === "reply-delivery-recovered")).toHaveLength(1);
  });

  it("edit-flood-fuse / 429 deferral — recovery ~40s later still counts", () => {
    // The observed shape (2026-08-11 12:40:19.340 → `429 rate limited, waiting
    // 10s` → fuse deferral → landed). Well inside the window, far outside any
    // line-count lookahead.
    const s = signalsOf([
      post("12:40:19.340", "err", "Too Many Requests: retry after 10"),
      "[2026-08-11T12:40:19.347Z] telegram gateway: 429 rate limited, waiting 10s",
      "[2026-08-11T12:40:29.348Z] edit-flood-fuse deferred method=sendRichMessage" +
        ` key=cs:${GCHAT} class=critical`,
      post("12:40:59.900", "ok", "-"),
    ]);
    expect(s).not.toContain("reply-delivery-failure");
    expect(s).toContain("reply-delivery-recovered");
  });

  it("transport re-attempt — a 502 followed by a landed send is recovered", () => {
    const s = signalsOf([
      post("22:37:36.770", "err", "Bad Gateway"),
      post("22:37:38.100", "ok", "-"),
    ]);
    expect(s).not.toContain("reply-delivery-failure");
    expect(s).toContain("reply-delivery-recovered");
  });

  it("queued-card re-send — invalid message_id then a landed send is recovered", () => {
    const s = signalsOf([
      post("11:26:49.563", "err", 'Bad Request: field "message_id" must be a valid Number'),
      "[2026-08-11T11:26:49.570Z] telegram gateway: queued card send failed: Bad Request",
      post("11:26:50.100", "ok", "-"),
    ]);
    expect(s).not.toContain("reply-delivery-failure");
    expect(s).toContain("reply-delivery-recovered");
  });

  it("intervening FAILED attempts do not end the episode — the first ok settles it", () => {
    const s = signalsOf([
      post("12:40:19.340", "err", "Too Many Requests: retry after 10"),
      post("12:40:29.440", "err", "Too Many Requests: retry after 10"),
      post("12:40:40.000", "ok", "-"),
    ]);
    expect(s.filter((x) => x === "reply-delivery-failure")).toHaveLength(0);
    expect(s.filter((x) => x === "reply-delivery-recovered")).toHaveLength(2);
  });

  describe("what it must NOT clear", () => {
    it("a send that never lands stays a severity-3 delivery failure", () => {
      const s = signalsOf([
        post("22:37:36.770", "err", "Bad Gateway"),
        "[2026-08-11T22:37:40.000Z] telegram gateway: send-gate stats: sent=0",
      ]);
      expect(s).toContain("reply-delivery-failure");
      expect(s).not.toContain("reply-delivery-recovered");
    });

    it("a landing on a DIFFERENT chat is not this send's recovery (chat-not-found → operator DM)", () => {
      // The observed 2026-08-13 shape: the group send fails terminally and the
      // agent re-replies into the operator DM. The addressed chat really is
      // unreachable — a different chat being reachable does not fix that.
      const s = signalsOf([
        post("12:37:16.665", "err", "Bad Request: chat not found"),
        post("12:37:20.100", "ok", "-", "9876543210"),
      ]);
      expect(s).toContain("reply-delivery-failure");
      expect(s).not.toContain("reply-delivery-recovered");
    });

    it("a landing beyond the recovery window is a different episode", () => {
      // 121s > REPLY_DELIVERY_RECOVERY_WINDOW_MS (120s, the send stack's own
      // in-process wait ceiling).
      const s = signalsOf([
        post("12:00:00.000", "err", "Bad Gateway"),
        post("12:02:01.000", "ok", "-"),
      ]);
      expect(s).toContain("reply-delivery-failure");
      expect(s).not.toContain("reply-delivery-recovered");
    });

    it("an UNDATABLE failing line fails toward the alarm", () => {
      const s = signalsOf([
        `tg-post method=sendRichMessage chat=${GCHAT} thread=- parse_mode=none bytes=0` +
          " hash=- status=err err=telegram_502 code=502 desc=Bad Gateway",
        post("12:00:01.000", "ok", "-"),
      ]);
      expect(s).toContain("reply-delivery-failure");
      expect(s).not.toContain("reply-delivery-recovered");
    });

    it("a non-rich landing (sendMessage) does not clear a rich send", () => {
      const s = signalsOf([
        post("12:00:00.000", "err", "Bad Gateway"),
        `[2026-08-11T12:00:01.000Z] tg-post method=sendMessage chat=${GCHAT} thread=-` +
          " parse_mode=none bytes=9 hash=abc status=ok err=- code=- desc=-",
      ]);
      expect(s).toContain("reply-delivery-failure");
    });

    it("`status=okay` can never be read as a landing (token pinning)", () => {
      const s = signalsOf([
        post("12:00:00.000", "err", "Bad Gateway"),
        post("12:00:01.000", "okay", "-"),
      ]);
      expect(s).toContain("reply-delivery-failure");
      expect(s).not.toContain("reply-delivery-recovered");
    });
  });

  it("the recovered signal is severity 1, the unrecovered one severity 3", () => {
    expect(mapSignal("reply-delivery-recovered").severity).toBe(1);
    expect(mapSignal("reply-delivery-failure").severity).toBe(3);
  });

  it("a recovered-only log does NOT set escalate", () => {
    const log = [
      post("04:04:20.210", "err", "Bad Request: message thread not found", GCHAT, "635"),
      post("04:04:20.764", "ok", "-"),
    ].join("\n");
    expect(scanAgent("alpha", "", log).escalate).toBe(false);
    // …and an unrecovered one still does.
    const bad = post("04:04:20.210", "err", "Bad Gateway");
    expect(scanAgent("alpha", "", bad).escalate).toBe(true);
  });
});

describe("detectGatewayFindings", () => {
  const log = [
    `2026-07-02T21:03:00Z gateway: represent duplicate-send tid=${CHAT}:_#42`,
    `2026-07-02T21:04:00Z gateway: tg-post method=getUpdates status=err timeout`,
    `2026-07-02T21:05:00Z gateway: tg-post method=sendRichMessage tid=${CHAT}:_#43 status=err`,
    // The literal terminal line `escalation-drive.ts:62` emits.
    `2026-07-02T21:06:00Z telegram gateway: obligation escalation delivered + closed` +
      ` origin=${CHAT}:_#44`,
  ].join("\n");

  it("counts represent-duplicate and reply-delivery-failure, ignores getUpdates blip", () => {
    const { gw_hits } = detectGatewayFindings("alpha", log);
    expect(gw_hits["duplicate-delivery-represent"]).toBe(1);
    expect(gw_hits["reply-delivery-failure"]).toBe(1);
    expect(gw_hits["represent-escalation"]).toBe(1);
  });

  it("extracts turn_id + ts into the finding", () => {
    const { findings } = detectGatewayFindings("alpha", log);
    const dup = findings.find((f) => f.signal === "duplicate-delivery-represent");
    expect(dup?.turn_id).toBe(`${CHAT}:_#42`);
    expect(dup?.ts).toBe("2026-07-02T21:03:00Z");
  });

  // The orphaned-DB-fd sweep's alarm is the ONLY notification for the
  // registry.db lane, which has no in-process recovery — an unmatched signature
  // means silent data loss stays silent. The fixture is the literal line
  // `orphaned-db-sweep.ts` emits.
  const sweepLine =
    "2026-08-10T03:05:00Z telegram gateway: orphaned-db-sweep DETECTED 2 deleted-inode" +
    " DB handle(s): fd=13 /state/history.db-wal (deleted), fd=14 /state/history.db-shm" +
    " (deleted) — another process unlinked these files while we held them open;" +
    " every row written since the last checkpoint is LOST and further writes would" +
    " be lost too.";

  it("counts the orphaned-db-handle alarm", () => {
    const { gw_hits, findings } = detectGatewayFindings("alpha", sweepLine);
    expect(gw_hits["orphaned-db-handle"]).toBe(1);
    const f = findings.find((x) => x.signal === "orphaned-db-handle");
    expect(f?.agent).toBe("alpha");
    expect(f?.ts).toBe("2026-08-10T03:05:00Z");
  });

  it("does not fire on the sweep's recovery or disabled-detection lines", () => {
    const quiet = [
      "telegram gateway: orphaned-db-sweep reopened history.db — writes are durable again",
      "telegram gateway: orphaned-db-sweep cannot resolve stateDir=/nope — deleted-inode DB" +
        " detection is DISABLED until it exists and is readable.",
    ].join("\n");
    expect(detectGatewayFindings("alpha", quiet).gw_hits["orphaned-db-handle"]).toBe(0);
  });
});

/**
 * #4680 — two detector rules matched an ALARM without checking its OUTCOME, so
 * the nightly ledger booked working safety mechanisms as failures. Every fixture
 * below is the literal line its emitter writes; a fixture that drifts from the
 * emitter is the failure mode these rules already had once.
 */
describe("#4680 — a working guard is not a failure", () => {
  const ORIGIN = `${CHAT}:_#2198`;

  describe("represent-escalation matches the terminal OUTCOME, not every attempt", () => {
    // `obligation-wiring.ts:303` — the guard deliberately NOT escalating while
    // the Telegram bridge is down. This is the suppression path working.
    const suppressed =
      `2026-08-12T02:00:00Z telegram gateway: obligation escalation deferred — bridge down` +
      ` (nudge waits for reconnect) origin=${ORIGIN}`;
    // `escalation-drive.ts:72` — one line per ATTEMPT, below the retry policy.
    const retrying =
      `2026-08-12T02:05:00Z telegram gateway: obligation escalation send failed (attempt 1/3),` +
      ` retrying next sweep origin=${ORIGIN}: Error: 429`;
    // `escalation-drive.ts:62` / `:68` — the two mutually-exclusive terminals.
    const delivered =
      `2026-08-12T02:10:00Z telegram gateway: obligation escalation delivered + closed` +
      ` origin=${ORIGIN}`;
    const undeliverable =
      `2026-08-12T02:15:00Z telegram gateway: obligation escalation PERMANENTLY undeliverable` +
      ` after 3 attempts — closing best-effort origin=${ORIGIN}: Error: 403`;

    it("does NOT flag the bridge-down SUPPRESSION line", () => {
      const { gw_hits, findings } = detectGatewayFindings("carrie", suppressed);
      expect(gw_hits["represent-escalation"]).toBe(0);
      expect(findings).toHaveLength(0);
    });

    it("does NOT flag a retry attempt (the nudge has not resolved yet)", () => {
      expect(
        detectGatewayFindings("carrie", retrying).gw_hits["represent-escalation"],
      ).toBe(0);
    });

    it("DOES flag a delivered escalation", () => {
      const { gw_hits, findings } = detectGatewayFindings("carrie", delivered);
      expect(gw_hits["represent-escalation"]).toBe(1);
      expect(findings[0]?.turn_id).toBe(ORIGIN);
    });

    it("DOES flag a permanently-undeliverable escalation", () => {
      expect(
        detectGatewayFindings("carrie", undeliverable).gw_hits["represent-escalation"],
      ).toBe(1);
    });

    // The live shape: one obligation, four matching lines, of which exactly one
    // is an escalation that happened. Before the fix this booked 4 findings.
    it("books ONE finding for one obligation's full retry-then-deliver history", () => {
      const log = [suppressed, retrying, retrying, delivered].join("\n");
      const { findings } = detectGatewayFindings("carrie", log);
      const esc = findings.filter((f) => f.signal === "represent-escalation");
      expect(esc).toHaveLength(1);
      expect(esc[0]?.ts).toBe("2026-08-12T02:10:00Z");
    });
  });

  describe("orphaned-db-handle splits on whether the sweep RECOVERED", () => {
    const detect = (n: number, target: string) =>
      `2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED ${n} deleted-inode` +
      ` DB handle(s): fd=13 ${target} (deleted) — another process unlinked these files while` +
      ` we held them open; every row written since the last checkpoint is LOST and further` +
      ` writes would be lost too.`;
    const reopened =
      "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep reopened history.db —" +
      " writes are durable again (proved by the post-reopen writer self-check); rows" +
      " written since the last checkpoint are NOT recoverable.";

    /** Severity is what the ledger acts on, so assert THAT, not the signal name. */
    const severityOf = (log: string): number[] =>
      detectGatewayFindings("overlord", log).findings.map(
        (f) => mapSignal(f.signal).severity,
      );

    it("DETECT + reopen in the same tick is NOT a severity-3 record", () => {
      const log = [detect(1, "/state/history.db"), reopened].join("\n");
      expect(severityOf(log)).toEqual([1]);
      const { gw_hits } = detectGatewayFindings("overlord", log);
      expect(gw_hits["orphaned-db-handle"]).toBe(0);
      expect(gw_hits["orphaned-db-handle-recovered"]).toBe(1);
      // Still reported — the pre-reopen rows really are gone.
      expect(detectGatewayFindings("overlord", log).findings).toHaveLength(1);
    });

    it("DETECT with no recovery line STAYS severity 3", () => {
      expect(severityOf(detect(1, "/state/history.db"))).toEqual([3]);
    });

    it("a FAILED reopen stays severity 3", () => {
      const log = [
        detect(1, "/state/history.db"),
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep FAILED to reopen" +
          " history.db: EACCES — history writes are NOT durable; RESTART the gateway.",
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    it("registry.db stays severity 3 even when history recovers in the same tick", () => {
      // The registry lane has NO in-process recovery — reopening history does
      // not make those rows durable, so the tick is not recovered.
      const log = [
        detect(2, "/state/registry.db"),
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep found an orphaned" +
          " registry.db handle. An in-process reopen is NOT safe here — the turnsDb handle" +
          " is captured by value into long-lived wiring, so closing it would leave those" +
          " consumers on a closed handle. RESTART the gateway to recover; subagent/turn" +
          " rows written since the last checkpoint are LOST.",
        reopened,
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    it("an unowned lane stays severity 3 even alongside a history reopen", () => {
      const log = [
        detect(2, "/state/grants.db"),
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep found orphaned handle(s)" +
          " on grants.db, which no recovery lane owns — the gateway cannot reopen them in" +
          " place. RESTART the gateway to recover; rows written to those files since the" +
          " last checkpoint are LOST.",
        reopened,
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    // The tick's lane ordering is load-bearing and lives in a DIFFERENT file:
    // `orphaned-db-sweep.ts` logs the history lane (and therefore the reopen
    // line, since `attemptHistoryReopen` is synchronous) at :219-229 BEFORE
    // the registry lane at :231-238. So the line that VETOES a "recovered"
    // verdict is exactly the one an added `await`, or another subsystem's
    // interleaved output, pushes past the lookahead cap. Without the
    // tick-boundary requirement this silently downgrades real `registry.db`
    // data loss from severity 3 to severity 1 — and no adjacent-lines fixture
    // above would notice.
    it("stays severity 3 when the registry lane is pushed past the lookahead cap", () => {
      const filler = Array.from(
        { length: 14 },
        (_, i) => `2026-08-12T03:00:0${i % 10}Z telegram gateway: unrelated chatter #${i}`,
      );
      const log = [
        detect(2, "/state/registry.db"),
        reopened,
        ...filler,
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep found an orphaned" +
          " registry.db handle. An in-process reopen is NOT safe here — the turnsDb handle" +
          " is captured by value into long-lived wiring, so closing it would leave those" +
          " consumers on a closed handle. RESTART the gateway to recover; subagent/turn" +
          " rows written since the last checkpoint are LOST.",
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    // The conservative rule must not swallow the ordinary recovered case: an
    // alarm + reopen followed by a short quiet tail still ends at EOF inside
    // the window, so the whole tick IS visible.
    it("still books severity 1 when the whole tick is visible", () => {
      const log = [
        detect(1, "/state/history.db"),
        reopened,
        ...Array.from(
          { length: 3 },
          (_, i) => `2026-08-12T03:00:0${i}Z telegram gateway: unrelated chatter #${i}`,
        ),
      ].join("\n");
      expect(severityOf(log)).toEqual([1]);
    });

    it("a LATER tick's recovery does not launder an earlier unrecovered alarm", () => {
      const log = [detect(1, "/state/history.db"), detect(1, "/state/history.db"), reopened]
        .join("\n");
      expect(severityOf(log)).toEqual([3, 1]);
    });

    /**
     * #4682 B1 — the verdict must be a property of the TICK, not of how much
     * log happened to follow it. A line-count lookahead cap makes it the
     * latter: the exact same alarm+reopen pair books severity 1 while it sits
     * at the log tail and severity 3 once ordinary traffic pushes the (absent)
     * tick boundary out of the window. Sweeps are 5 minutes apart, so in a live
     * log the next alarm is essentially never within a dozen lines — the
     * verdict would then depend on WHEN the scan ran, and a signal that flips
     * with the clock migrates its findings between two dedup_keys and drives
     * the ledger's close-on-zero path on a defect nobody fixed.
     */
    it("books the same severity for one tick no matter how much traffic follows", () => {
      const tick = [detect(1, "/state/history.db"), reopened];
      for (const trailing of [0, 1, 5, 11, 12, 13, 60]) {
        const log = [
          ...tick,
          ...Array.from(
            { length: trailing },
            (_, i) => `2026-08-12T03:05:00Z telegram gateway: unrelated chatter #${i}`,
          ),
        ].join("\n");
        expect(severityOf(log), `${trailing} trailing lines`).toEqual([1]);
      }
    });

    /**
     * #4682 B1 — the same property in the severity-3 direction. The registry
     * lane has no in-process recovery, so an alarm naming `registry.db` is
     * silent data loss whether or not its lane line survived into the scanned
     * window. The DETECTED line itself interpolates every orphaned target
     * (`orphaned-db-sweep.ts:213-217`), so the affected LANES are knowable from
     * the alarm alone and no lookahead may be allowed to overrule it.
     */
    it("keeps severity 3 for a registry.db alarm whose lane line is absent", () => {
      // A truncated log tail: the alarm and the history reopen survive, the
      // registry lane line does not. Trusting the missing veto line downgrades
      // real, unrecoverable `registry.db` loss to informational.
      const log = [detect(1, "/state/registry.db"), reopened].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    it("keeps severity 3 for an unowned-lane alarm whose lane line is absent", () => {
      const log = [detect(1, "/state/grants.db"), reopened].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    it("keeps severity 3 when the alarm names history AND registry", () => {
      const log = [
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED 2 deleted-inode" +
          " DB handle(s): fd=13 /state/history.db (deleted), fd=14 /state/registry.db" +
          " (deleted) — another process unlinked these files while we held them open.",
        reopened,
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    it("keeps severity 3 when the alarm's target list cannot be parsed", () => {
      // Fail toward the alarm: an emitter format change must never silently
      // downgrade a data-loss record.
      const log = [
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED 1 deleted-inode" +
          " DB handle(s): <redacted>",
        reopened,
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    /**
     * #4682 B1 follow-up — a PARTIALLY parseable target list must fail toward
     * the alarm too. The emitter writes `DETECTED <n>` and then exactly one
     * `fd=<n> <target>` pair per orphan (`orphaned-db-sweep.ts:211-217`), so
     * the count and the pair list are 1:1 by construction. Reading only the
     * pairs makes the verdict depend on the alarm line arriving INTACT: a
     * short/interleaved `write()` on the supervisor's stderr for an alarm line
     * over `PIPE_BUF` — reachable exactly when many fds are orphaned, i.e. the
     * worst incident — truncates the list, and the surviving `history.db` pair
     * then launders a real `registry.db` loss down to severity 1. Cross-checking
     * the count makes the truncation visible from the alarm line alone.
     */
    it("keeps severity 3 when the alarm declares more handles than it lists", () => {
      const log = [
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED 2 deleted-inode" +
          " DB handle(s): fd=13 /state/history.db",
        reopened,
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    /**
     * The sharp case. The emitter logs the history lane BEFORE the registry
     * lane (`orphaned-db-sweep.ts:219-238`), so the registry veto line lands
     * AFTER the reopen line. If a truncated alarm hid `registry.db` from the
     * lane list, a verdict that reads ONLY the first sweep line after the alarm
     * never sees the intact `registry.db … rows written since the last
     * checkpoint are LOST.` line sitting right there in the log, and books
     * severity 1 on unrecoverable loss.
     */
    it("keeps severity 3 when a registry lane line follows the reopen line", () => {
      const log = [
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED 2 deleted-inode" +
          " DB handle(s): fd=13 /state/history.db",
        reopened,
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep found an orphaned" +
          " registry.db handle. An in-process reopen is NOT safe here — the turnsDb handle" +
          " is captured by value into long-lived wiring, so closing it would leave those" +
          " consumers on a closed handle. RESTART the gateway to recover; subagent/turn" +
          " rows written since the last checkpoint are LOST.",
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    it("keeps severity 3 when an unowned lane line follows the reopen line", () => {
      const log = [
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED 2 deleted-inode" +
          " DB handle(s): fd=13 /state/history.db",
        reopened,
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep found orphaned handle(s)" +
          " on grants.db, which no recovery lane owns — the gateway cannot reopen them in" +
          " place. RESTART the gateway to recover; rows written to those files since the" +
          " last checkpoint are LOST.",
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    /**
     * Isolates the VETO from the count cross-check: this alarm is entirely
     * self-consistent (`DETECTED 1` / one `fd=` pair / history lane), so the
     * count check passes it and only a lane-line veto can keep the severity.
     * Today's emitter cannot produce this shape — the registry line is emitted
     * only for a name in the alarm's own list (`orphaned-db-sweep.ts:231-238`)
     * — which is the point: this is the standing guarantee that an intact
     * "rows … are LOST" line in the tick is never overruled by whatever the
     * alarm line happens to say, so an emitter change cannot re-open the
     * downgrade path a second time.
     */
    it("an intact registry lane line vetoes recovery even on a consistent alarm", () => {
      const log = [
        detect(1, "/state/history.db"),
        reopened,
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep found an orphaned" +
          " registry.db handle. An in-process reopen is NOT safe here — RESTART the" +
          " gateway to recover; subagent/turn rows written since the last checkpoint" +
          " are LOST.",
      ].join("\n");
      expect(severityOf(log)).toEqual([3]);
    });

    /**
     * The count cross-check is a COMPLETENESS test, not a lane test: a full,
     * self-consistent multi-handle history-only alarm still books severity 1.
     */
    it("still books severity 1 for a complete multi-handle history alarm", () => {
      const log = [
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED 2 deleted-inode" +
          " DB handle(s): fd=13 /state/history.db (deleted), fd=14 /state/history.db-wal" +
          " (deleted) — another process unlinked these files while we held them open.",
        reopened,
      ].join("\n");
      expect(severityOf(log)).toEqual([1]);
    });

    /**
     * The veto must stay a property of THIS tick. A later tick's own alarm ends
     * the scan, so its lane lines can never be charged to an earlier, genuinely
     * recovered one — otherwise the veto would reintroduce exactly the
     * log-growth dependence #4682 B1 removed.
     */
    it("a LATER tick's registry lane does not re-arm an earlier recovered alarm", () => {
      const log = [
        detect(1, "/state/history.db"),
        reopened,
        detect(1, "/state/registry.db"),
        "2026-08-12T03:05:00Z telegram gateway: orphaned-db-sweep found an orphaned" +
          " registry.db handle. An in-process reopen is NOT safe here — RESTART the" +
          " gateway to recover; subagent/turn rows written since the last checkpoint" +
          " are LOST.",
      ].join("\n");
      expect(severityOf(log)).toEqual([1, 3]);
    });

    /**
     * The two lane lines the veto deliberately does NOT carry: the sticky
     * closed-history line and a FAILED reopen both also fire from the
     * no-DETECTED retry path (`orphaned-db-sweep.ts:253-264`), so vetoing on
     * them would let a later, unrelated tick flip an earlier recovered alarm —
     * log-growth dependence again. This tick's OWN failed reopen is already
     * caught by the first-sweep-line rule (asserted above), so nothing is lost.
     */
    it("a later tick's sticky history failure does not re-arm a recovered alarm", () => {
      const log = [
        detect(1, "/state/history.db"),
        reopened,
        "2026-08-12T03:05:00Z telegram gateway: orphaned-db-sweep history.db is CLOSED and" +
          " a previous reopen failed (EACCES) — every history read and write is dead and" +
          " no fd evidence remains. Retrying the reopen; RESTART the gateway if this keeps" +
          " repeating.",
      ].join("\n");
      expect(severityOf(log)).toEqual([1]);
    });

    it("treats history.db-wal alongside history.db as the history lane", () => {
      const log = [
        "2026-08-12T03:00:00Z telegram gateway: orphaned-db-sweep DETECTED 2 deleted-inode" +
          " DB handle(s): fd=13 /state/history.db (deleted), fd=14 /state/history.db-wal" +
          " (deleted) — another process unlinked these files while we held them open.",
        reopened,
      ].join("\n");
      expect(severityOf(log)).toEqual([1]);
    });
  });

  /**
   * #4682 M2 — `countingUnitFor` decides whether the ledger's count-drop
   * self-verify may compare two scans at all, and it reads a list of gateway
   * signal names. A hand-written list can silently omit a new signal, handing
   * that signal a `log-line` unit it was never counted in.
   *
   * The EXHAUSTIVENESS guarantee is `tsc`, not this test: `GATEWAY_SIGNAL_NAMES`
   * is derived from a `Record<GatewaySignal, true>`, so omitting a member is a
   * compile error (verified: `detect.ts:251`, TS2741). A runtime test cannot
   * add to that, because every runtime view of the set — `gw_hits`,
   * `GATEWAY_SIGNAL_NAMES`, `countingUnitFor`'s `GATEWAY_SIGNAL_SET` — is
   * derived from that same constant, so comparing them to each other is a
   * tautology that passes even against the hand-written array this was filed
   * about (measured).
   *
   * What this test IS: a tripwire against an INDEPENDENTLY written list. Adding
   * a gateway signal turns it red here, which is the prompt to confirm the new
   * signal's ledger counting unit deliberately rather than inherit one. Keep
   * the literal hand-written — deriving it from the source under test is
   * exactly what made the previous version vacuous.
   */
  describe("every emittable gateway signal carries the gateway-event unit", () => {
    const EXPECTED_GATEWAY_SIGNALS = [
      "duplicate-delivery-represent",
      "orphaned-db-handle",
      "orphaned-db-handle-recovered",
      "reply-delivery-failure",
      // #4735 — the informational counterpart of `reply-delivery-failure`, the
      // same shape `orphaned-db-handle-recovered` has. It is a DERIVED signal
      // (no `GATEWAY_SIGNATURES` entry), which is exactly the class this
      // tripwire exists for: confirmed deliberately as `gateway-event` by the
      // sibling `it` below.
      "reply-delivery-recovered",
      "represent-escalation",
    ] as const;

    it("is exactly the set this test was written against", () => {
      expect([...GATEWAY_SIGNAL_NAMES].sort()).toEqual([...EXPECTED_GATEWAY_SIGNALS]);
      expect(Object.keys(detectGatewayFindings("alpha", "").gw_hits).sort()).toEqual([
        ...EXPECTED_GATEWAY_SIGNALS,
      ]);
    });

    it("counts every one of them in gateway-event, not log-line", () => {
      for (const signal of EXPECTED_GATEWAY_SIGNALS) {
        expect(
          countingUnitFor(signal as L0Signal),
          `${signal} must be counted in gateway-event`,
        ).toBe("gateway-event");
      }
    });
  });

  describe("gateway findings dedup by event identity, not by log line", () => {
    it("folds repeated lines for the same origin into one finding", () => {
      const log = [
        `2026-08-12T04:00:00Z gateway: represent duplicate-send origin=${ORIGIN}`,
        `2026-08-12T04:01:00Z gateway: represent duplicate-send origin=${ORIGIN}`,
      ].join("\n");
      const { findings, gw_hits } = detectGatewayFindings("carrie", log);
      expect(findings).toHaveLength(1);
      // gw_hits stays the RAW line count — it is the digest's noise readout.
      expect(gw_hits["duplicate-delivery-represent"]).toBe(2);
    });

    // `buildLedger` windows AND ranks on `Finding.ts`, so a folded event that
    // kept the FIRST line's timestamp could age a still-happening cluster out
    // of the scan window entirely.
    it("carries the NEWEST line's timestamp and pointer, not the first's", () => {
      const log = [
        `2026-07-01T04:00:00Z gateway: represent duplicate-send origin=${ORIGIN}`,
        `2026-08-12T04:01:00Z gateway: represent duplicate-send origin=${ORIGIN}`,
      ].join("\n");
      const { findings } = detectGatewayFindings("carrie", log);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ts).toBe("2026-08-12T04:01:00Z");
      expect(findings[0]?.log_pointer).toBe("logs/carrie/gateway-supervisor.log:2");
    });

    // `log_pointer` is the line the operator greps to check the `ts` the ledger
    // windowed and ranked on. If a newest line with an unparseable timestamp
    // advanced the pointer while `ts` fell back to an earlier line, the finding
    // would claim line 2 as evidence for a timestamp that only line 1 carries.
    it("does not advance the pointer past the line its `ts` came from", () => {
      const log = [
        `2026-08-12T04:00:00Z gateway: represent duplicate-send origin=${ORIGIN}`,
        `gateway: represent duplicate-send origin=${ORIGIN}`, // no ISO prefix
      ].join("\n");
      const { findings } = detectGatewayFindings("carrie", log);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ts).toBe("2026-08-12T04:00:00Z");
      expect(findings[0]?.log_pointer).toBe("logs/carrie/gateway-supervisor.log:1");
    });

    it("keeps DISTINCT origins as distinct findings", () => {
      const log = [
        `2026-08-12T04:00:00Z gateway: represent duplicate-send origin=${CHAT}:_#1`,
        `2026-08-12T04:01:00Z gateway: represent duplicate-send origin=${CHAT}:_#2`,
      ].join("\n");
      expect(detectGatewayFindings("carrie", log).findings).toHaveLength(2);
    });

    it("keeps one-finding-per-line when the line carries NO origin id", () => {
      const log = [
        "2026-08-12T04:00:00Z gateway: represent duplicate-send",
        "2026-08-12T04:01:00Z gateway: represent duplicate-send",
      ].join("\n");
      expect(detectGatewayFindings("carrie", log).findings).toHaveLength(2);
    });
  });
});

/**
 * `extractTs` feeds `Finding.ts`, which `ledger.recencyFactor` and (since
 * #4622) `ledger.withinWindow` both read through `Date.parse`. A timestamp with
 * no zone designator is parsed as LOCAL time there, so it is not enough for the
 * string to survive the regex — it has to name its zone by the time it leaves
 * this module.
 */
describe("extractTs — a finding's timestamp always names its zone", () => {
  it("returns the real gateway prefix verbatim (it is already UTC)", () => {
    // The literal shape `stderr-timestamps.ts` writes: `toISOString()`, i.e.
    // millisecond precision and a trailing Z. All ~2.5M timestamps in the live
    // gateway logs look exactly like this.
    expect(
      extractTs("[2026-08-12T09:00:00.123Z] telegram gateway: tg-post status=err"),
    ).toBe("2026-08-12T09:00:00.123Z");
  });

  it("normalises a designator-less timestamp to UTC instead of silently going local", () => {
    // THE bug: `Date.parse('2026-08-12T09:00:00')` is LOCAL time, so on the
    // fleet's +10:00 host this finding was dated 23:00Z the previous day — a
    // ten-hour error in `recencyFactor`, and enough to move a finding across
    // `withinWindow`'s boundary.
    //
    // The assertion is on the STRING, deliberately: it is host-independent, so
    // it goes red on the bug on a UTC CI runner too. An assertion on the parsed
    // INSTANT alone would only fail on a host whose offset is non-zero — a guard
    // that passes for the wrong reason on half the machines that run it.
    expect(extractTs("2026-08-12T09:00:00 gateway: represent duplicate-send")).toBe(
      "2026-08-12T09:00:00Z",
    );
    // …and the normalised form is a real UTC instant.
    expect(Date.parse(extractTs("2026-08-12T09:00:00 gw")!)).toBe(
      Date.UTC(2026, 7, 12, 9, 0, 0),
    );
  });

  it("normalises a designator-less timestamp WITH fractional seconds too", () => {
    expect(extractTs("2026-08-12T09:00:00.500 gw: x")).toBe("2026-08-12T09:00:00.500Z");
  });

  it("leaves an EXPLICIT offset alone — appending Z would invent a 10h error", () => {
    expect(extractTs("2026-08-12T19:00:00+10:00 gw: x")).toBe("2026-08-12T19:00:00+10:00");
    // Same instant as 09:00Z — the offset is honoured, not overwritten.
    expect(Date.parse(extractTs("2026-08-12T19:00:00+10:00 gw: x")!)).toBe(
      Date.UTC(2026, 7, 12, 9, 0, 0),
    );
    expect(extractTs("2026-08-12T04:00:00-05:00 gw: x")).toBe("2026-08-12T04:00:00-05:00");
  });

  it("is still null for a line carrying no timestamp at all", () => {
    // Undatable stays undatable — `withinWindow` KEEPS those rather than
    // guessing an age, so inventing one here would be worse than none.
    expect(extractTs("telegram gateway: tg-post method=getUpdates status=err")).toBeNull();
  });

  it("dates a gateway FINDING in UTC even when the line's prefix has no Z", () => {
    // End to end through the real detector, not just the helper.
    const { findings } = detectGatewayFindings(
      "alpha",
      `2026-08-12T09:00:00 gateway: represent duplicate-send tid=${CHAT}:_#42`,
    );
    expect(findings[0]?.ts).toBe("2026-08-12T09:00:00Z");
  });
});

describe("scanAgent escalation decision", () => {
  it("escalates on a duplicate-send hit", () => {
    const res = scanAgent(
      "alpha",
      turn(1, {}),
      "gateway: represent duplicate-send tid=x",
    );
    expect(res.escalate).toBe(true);
  });

  it("does NOT escalate on a represent-escalation alone", () => {
    const res = scanAgent(
      "alpha",
      turn(1, {}),
      `telegram gateway: obligation escalation delivered + closed origin=${CHAT}:_#44`,
    );
    expect(res.gw_hits["represent-escalation"]).toBe(1);
    expect(res.escalate).toBe(false);
  });

  it("stays clean on a healthy agent", () => {
    const res = scanAgent("alpha", turn(1, {}) + "\n" + turn(2, {}), "");
    expect(res.escalate).toBe(false);
    expect(res.findings).toHaveLength(0);
  });
});

/**
 * #3702 — a backstop delivery whose read-back probe was inconclusive is counted
 * `complete` on the Bot API's ack alone. `landed_unconfirmed` on the turn row is
 * the measurement of how often that bet is made; the scan surfaces the count so
 * it is visible in the digest WITHOUT becoming a failure signal (escalating it
 * would recreate the phantom `send_failed` cluster it exists to explain).
 */
describe("scanAgent landed_unconfirmed accounting (#3702)", () => {
  it("counts turns whose delivery was never corroborated", () => {
    const text = [
      turn(1, {}), // ordinary row — field absent
      turn(2, { landed_unconfirmed: 2 }),
      turn(3, { landed_unconfirmed: 1 }),
      turn(4, { landed_unconfirmed: 0 }), // explicitly zero ⇒ not counted
    ].join("\n");
    const res = scanAgent("alpha", text, "");
    expect(res.landed_unconfirmed_turns).toBe(2);
  });

  it("is NOT a failure signal — it neither escalates nor emits a finding", () => {
    const res = scanAgent("alpha", turn(1, { landed_unconfirmed: 3 }), "");
    expect(res.landed_unconfirmed_turns).toBe(1);
    expect(res.escalate).toBe(false);
    expect(res.findings).toHaveLength(0);
    expect(res.status_mix).toEqual({ complete: 1 });
  });

  it("is zero on a fleet that never made the bet", () => {
    const res = scanAgent("alpha", turn(1, {}) + "\n" + turn(2, {}), "");
    expect(res.landed_unconfirmed_turns).toBe(0);
  });
});

describe("cross-attributed rows never count as this agent's drift", () => {
  // Regression for the fleet-health measurement bug: `emitTurnRecord` wrote to a
  // hard-coded `/state/agent/turns.jsonl`, so a characterization test running
  // inside an agent container appended rows stamped with ITS OWN agent name
  // (`chartestagent`) into the host agent's production turn record. Those rows
  // are complete/tools:0 — the exact silent-no-op shape — and they dominated the
  // top ledger entry (267 of 377 live candidates on 2026-07-26).
  const foreign = (seq: number) =>
    JSON.stringify({
      ts: SILENT_NOOP_FLOOR_TS + seq,
      agent: "chartestagent",
      turn_id: `t-${seq}`,
      status: "complete",
      tools: 0,
      duration_ms: 1000,
    });

  it("drops a foreign-agent silent-no-op row (would be flagged as alpha's)", () => {
    const findings = detectTurnFindings("alpha", parseTurns(foreign(1)));
    expect(findings).toHaveLength(0);
  });

  it("drops a foreign-agent send_failed row", () => {
    const row = JSON.stringify({
      ts: SILENT_NOOP_FLOOR_TS + 2,
      agent: "chartestagent",
      turn_id: "t-2",
      status: "send_failed",
      tools: 0,
      duration_ms: 1000,
    });
    expect(detectTurnFindings("alpha", parseTurns(row))).toHaveLength(0);
  });

  it("keeps the owning agent's rows (match is case-insensitive on the slug)", () => {
    const own = JSON.stringify({
      ts: SILENT_NOOP_FLOOR_TS + 3,
      agent: "ALPHA",
      turn_id: `${CHAT}:_#3`,
      status: "complete",
      tools: 0,
      route: "none",
      duration_ms: 1000,
    });
    const findings = detectTurnFindings("alpha", parseTurns(own));
    expect(findings.map((f) => f.signal)).toEqual(["silent-no-op-candidate"]);
  });

  it("keeps rows with no `agent` field (unattributable, so not foreign)", () => {
    const legacy = JSON.stringify({
      ts: SILENT_NOOP_FLOOR_TS + 4,
      turn_id: `${CHAT}:_#4`,
      status: "complete",
      tools: 0,
      route: "none",
      duration_ms: 1000,
    });
    expect(detectTurnFindings("alpha", parseTurns(legacy))).toHaveLength(1);
  });

  it("scanAgent excludes foreign rows from findings, turn count and status mix", () => {
    const text = [turn(1, {}), foreign(5), foreign(6)].join("\n");
    const res = scanAgent("alpha", text, "");
    expect(res.turns).toBe(1);
    expect(res.status_mix).toEqual({ complete: 1 });
    expect(res.findings).toHaveLength(0);
    expect(res.escalate).toBe(false);
  });
});

describe("the attribution filter is TOTAL — one junk row cannot erase an agent", () => {
  // `parseTurns` does no shape validation ("a corrupt line must never crash the
  // scan"), so `agent` / `turn_id` can hold ANY JSON value. `ownedTurns`
  // dereferences `agent`; a TypeError there escapes `scanAgent` into
  // src/fleet-health/scan.ts's catch, which drops the WHOLE agent into
  // `skipped[]` — every real finding for that agent silently vanishes from the
  // ledger. That is the same "health board lies" failure the filter exists to
  // prevent, so malformed rows must be inert, never fatal.
  const real = (seq: number) =>
    JSON.stringify({
      ts: SILENT_NOOP_FLOOR_TS + seq,
      agent: "alpha",
      turn_id: `${CHAT}:_#${seq}`,
      status: "complete",
      tools: 0,
      route: "none",
      duration_ms: 1000,
    });

  const junkAgents = [
    ['number `agent`', '{"ts":1,"agent":123,"turn_id":"j1","status":"complete","tools":0}'],
    ['array `agent`', '{"ts":1,"agent":["x"],"turn_id":"j2","status":"complete","tools":0}'],
    ['object `agent`', '{"ts":1,"agent":{"n":"x"},"turn_id":"j3","status":"complete","tools":0}'],
    ['null `agent`', '{"ts":1,"agent":null,"turn_id":"j4","status":"complete","tools":0}'],
    ['boolean `agent`', '{"ts":1,"agent":true,"turn_id":"j5","status":"complete","tools":0}'],
  ] as const;

  for (const [label, row] of junkAgents) {
    it(`${label}: does not throw, and the row is KEPT (unattributable, as before)`, () => {
      const parsed = parseTurns(row);
      expect(parsed).toHaveLength(1);
      expect(() => detectTurnFindings("alpha", parsed)).not.toThrow();
      // `killed-incomplete-turn` is not in play (status complete); the row is
      // present in the scan rather than dropped — matching the pre-filter
      // behaviour where a non-string `agent` was simply never read.
      const res = scanAgent("alpha", row, "");
      expect(res.turns).toBe(1);
    });
  }

  it("a junk row does not take the agent's REAL findings down with it", () => {
    // The regression shape: one bad line on disk + real drift. Before the fix
    // the whole scan threw and scan.ts skipped the agent, so the real
    // silent-no-op finding disappeared from the ledger.
    const text = [real(1), '{"ts":2,"agent":99,"turn_id":"j","status":"complete","tools":0}'].join(
      "\n",
    );
    const res = scanAgent("alpha", text, "");
    expect(res.findings.map((f) => f.signal)).toContain("silent-no-op-candidate");
  });

  it("a non-string `turn_id` is inert too (the `synthetic-` probe would throw)", () => {
    const row = '{"ts":1,"agent":"alpha","turn_id":7,"status":"killed","tools":0}';
    expect(() => scanAgent("alpha", row, "")).not.toThrow();
    expect(scanAgent("alpha", row, "").findings.map((f) => f.signal)).toEqual([
      "killed-incomplete-turn",
    ]);
  });

  it("parseTurns skips lines that parse to a NON-OBJECT", () => {
    // `JSON.parse("null")` succeeds, so these are not caught by the try/catch;
    // every consumer then dereferences a field off `null` and throws.
    expect(parseTurns(['null', '7', '"x"', '[1,2]', 'true'].join("\n"))).toEqual([]);
    expect(() => scanAgent("alpha", "null", "")).not.toThrow();
    // …and a junk line never displaces a valid neighbour.
    const res = scanAgent("alpha", ["null", real(9)].join("\n"), "");
    expect(res.turns).toBe(1);
  });
});
