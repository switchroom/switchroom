import { describe, it, expect } from "vitest";
import {
  scanAgent,
  parseTurns,
  detectTurnFindings,
  detectGatewayFindings,
  extractTs,
  HANG_MS,
  SILENT_NOOP_FLOOR_TS,
} from "./detect.js";
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
});

describe("detectGatewayFindings", () => {
  const log = [
    `2026-07-02T21:03:00Z gateway: represent duplicate-send tid=${CHAT}:_#42`,
    `2026-07-02T21:04:00Z gateway: tg-post method=getUpdates status=err timeout`,
    `2026-07-02T21:05:00Z gateway: tg-post method=sendRichMessage tid=${CHAT}:_#43 status=err`,
    `2026-07-02T21:06:00Z gateway: obligation escalation tid=${CHAT}:_#44`,
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
    const res = scanAgent("alpha", turn(1, {}), "gateway: obligation escalation");
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
