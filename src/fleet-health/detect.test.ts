import { describe, it, expect } from "vitest";
import {
  scanAgent,
  parseTurns,
  detectTurnFindings,
  detectGatewayFindings,
  HANG_MS,
  SILENT_NOOP_FLOOR_TS,
} from "./detect.js";

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
    const turns = parseTurns(turn(10, { tools: 0 }));
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
      turn(10, { tools: 0, ts: SILENT_NOOP_FLOOR_TS + 100 }),
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
