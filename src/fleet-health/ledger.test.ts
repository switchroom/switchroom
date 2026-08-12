import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLedger } from "./ledger.js";
import { runScan, writeLedger } from "./scan.js";
import type { Finding } from "./detect.js";
import { readFleetHealth } from "../web/fleet-health-read.js";

const CHAT = "77770002";

function dupFinding(agent: string, seq: number, ts = "2026-07-02T21:03:00Z"): Finding {
  return {
    signal: "duplicate-delivery-represent",
    agent,
    turn_id: `${CHAT}:_#${seq}`,
    log_pointer: `logs/${agent}/gateway-supervisor.log:${seq}`,
    ts,
  };
}

/** The real-world cluster this regression is about: `reply-delivery-failure`
 *  (severity 3) on the delivery job spec. */
function deliveryFailFinding(agent: string, seq: number, ts: string): Finding {
  return {
    signal: "reply-delivery-failure",
    agent,
    turn_id: `${CHAT}:_#${seq}`,
    log_pointer: `logs/${agent}/gateway-supervisor.log:${seq}`,
    ts,
  };
}

/** A finding on a DIFFERENT job spec, so a scenario can compare ranks. */
function killedFinding(agent: string, seq: number, ts: string): Finding {
  return {
    signal: "killed-incomplete-turn",
    agent,
    turn_id: `${CHAT}:_#${seq}`,
    log_pointer: `agents/${agent}/turns.jsonl:${seq}`,
    ts,
  };
}

describe("buildLedger", () => {
  const now = new Date("2026-07-03T00:00:00Z");

  it("seeds all 23 records and aggregates by dedup_key across agents", () => {
    const findings = [
      dupFinding("clerk", 1),
      dupFinding("clerk", 2),
      dupFinding("marko", 3),
    ];
    const led = buildLedger(findings, { ownerAgent: "klanker", now });
    expect(led.records).toHaveLength(23); // 23 job specs (delivery seeded once)
    const delivery = led.records.find(
      (r) => r.job_spec === "talk-to-agents-from-anywhere",
    )!;
    expect(delivery.issues).toHaveLength(1);
    expect(delivery.issues[0].frequency).toBe(3);
    expect(delivery.issues[0].reach).toEqual(["clerk", "marko"]);
    expect(delivery.open_issue_count).toBe(1);
    expect(delivery.priority_score).toBeGreaterThan(0);
  });

  it("carries the GH issue number forward and flips to pending on a count-drop", () => {
    const prior = buildLedger(
      Array.from({ length: 20 }, (_, i) => dupFinding("clerk", i)),
      { now },
    );
    // inject a gh_issue number as if a prior sync opened it
    const pd = prior.records.find(
      (r) => r.job_spec === "talk-to-agents-from-anywhere",
    )!;
    pd.issues[0].gh_issue = 4242;

    // next scan: count dropped to 1 (below RESOLVED_THRESHOLD)
    const next = buildLedger([dupFinding("clerk", 99)], { now, prior });
    const nd = next.records.find(
      (r) => r.job_spec === "talk-to-agents-from-anywhere",
    )!;
    expect(nd.issues[0].gh_issue).toBe(4242);
    expect(nd.issues[0].status).toBe("resolved-pending-verify");
  });
});

describe("buildLedger — windowDays actually windows the findings", () => {
  const DELIVERY = "talk-to-agents-from-anywhere";
  const KILLED = "steer-or-queue-mid-flight";

  const FLEET = ["clerk", "marko", "klanker", "scout"];

  /** The real regression: 177 delivery-failure occurrences fleet-wide, all
   *  between 2026-07-18 and 2026-07-27, fixed on 2026-07-26, none since. Scanned
   *  well past the 30-day window they must no longer count at all. */
  function staleDeliveryBurst(): Finding[] {
    return Array.from({ length: 177 }, (_, i) =>
      deliveryFailFinding(
        FLEET[i % FLEET.length],
        i,
        `2026-07-${String(18 + (i % 10)).padStart(2, "0")}T12:00:00Z`,
      ),
    );
  }

  it("drops a cluster whose every occurrence is older than the window", () => {
    const now = new Date("2026-09-01T00:00:00Z"); // > 30d after 2026-07-27
    const led = buildLedger(staleDeliveryBurst(), { now });
    const delivery = led.records.find((r) => r.job_spec === DELIVERY)!;
    expect(delivery.issues).toHaveLength(0);
    expect(delivery.open_issue_count).toBe(0);
    expect(delivery.priority_score).toBe(0);
  });

  it("ranks a small FRESH cluster above a large stale one", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const led = buildLedger(
      [
        ...staleDeliveryBurst(), // 177, all out of window
        killedFinding("clerk", 1, "2026-08-31T09:00:00Z"), // 2, in window
        killedFinding("clerk", 2, "2026-08-31T10:00:00Z"),
      ],
      { now },
    );
    const delivery = led.records.find((r) => r.job_spec === DELIVERY)!;
    const killed = led.records.find((r) => r.job_spec === KILLED)!;
    expect(killed.priority_score).toBeGreaterThan(delivery.priority_score);
    // and the fresh one is genuinely at the top of the ledger
    const top = [...led.records].sort(
      (a, b) => b.priority_score - a.priority_score,
    )[0];
    expect(top.job_spec).toBe(KILLED);
  });

  it("counts only the in-window occurrences of a mixed cluster", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const led = buildLedger(
      [
        ...staleDeliveryBurst(), // 177 stale, fleet-wide
        deliveryFailFinding("clerk", 900, "2026-08-30T12:00:00Z"), // 1 fresh
        deliveryFailFinding("clerk", 901, "2026-08-31T12:00:00Z"), // 1 fresh
      ],
      { now },
    );
    const delivery = led.records.find((r) => r.job_spec === DELIVERY)!;
    expect(delivery.issues).toHaveLength(1);
    expect(delivery.issues[0].frequency).toBe(2);
    // the other three agents appear only in the stale burst
    expect(delivery.issues[0].reach).toEqual(["clerk"]);
    expect(delivery.issues[0].recency).toBe("2026-08-31T12:00:00Z");
  });

  it("closes a prior-open issue whose occurrences all aged out", () => {
    const at = new Date("2026-07-28T00:00:00Z");
    const prior = buildLedger(staleDeliveryBurst(), { now: at });
    const pd = prior.records.find((r) => r.job_spec === DELIVERY)!;
    expect(pd.issues[0].frequency).toBe(177); // in-window at scan time
    pd.issues[0].gh_issue = 4242;

    // Same findings, scanned a month later — every one is now out of window.
    const next = buildLedger(staleDeliveryBurst(), {
      now: new Date("2026-09-01T00:00:00Z"),
      prior,
    });
    const nd = next.records.find((r) => r.job_spec === DELIVERY)!;
    expect(nd.issues).toHaveLength(1);
    expect(nd.issues[0].status).toBe("closed");
    expect(nd.issues[0].frequency).toBe(0);
    expect(nd.issues[0].gh_issue).toBe(4242);
    expect(nd.open_issue_count).toBe(0);
  });

  it("keeps an undatable finding (ts null) rather than silently dropping it", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const led = buildLedger(
      [
        { ...dupFinding("clerk", 1), ts: null },
        { ...dupFinding("clerk", 2), ts: null },
      ],
      { now },
    );
    const delivery = led.records.find((r) => r.job_spec === DELIVERY)!;
    expect(delivery.issues).toHaveLength(1);
    expect(delivery.issues[0].frequency).toBe(2);
    // …but an undatable-only cluster carries no recency, so it cannot rank.
    expect(delivery.issues[0].recency).toBe(null);
    expect(delivery.priority_score).toBe(0);
  });

  it("keeps an unparseable-ts finding, and it still cannot rank", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const led = buildLedger(
      [{ ...dupFinding("clerk", 1), ts: "not-a-timestamp" }],
      { now },
    );
    const delivery = led.records.find((r) => r.job_spec === DELIVERY)!;
    expect(delivery.issues[0].frequency).toBe(1);
    // `recencyFactor` cannot parse it → 0, so the cluster scores 0 regardless.
    expect(delivery.priority_score).toBe(0);
  });

  it("honours a custom (shorter) windowDays", () => {
    const now = new Date("2026-08-12T00:00:00Z"); // inside the default 30d
    const findings = staleDeliveryBurst();
    const wide = buildLedger(findings, { now });
    const narrow = buildLedger(findings, { now, windowDays: 7 });
    expect(
      wide.records.find((r) => r.job_spec === DELIVERY)!.issues[0].frequency,
    ).toBe(177);
    expect(
      narrow.records.find((r) => r.job_spec === DELIVERY)!.issues,
    ).toHaveLength(0);
  });
});

describe("round-trip: buildLedger → readFleetHealth", () => {
  it("writes a ledger the reader accepts, ranked non-empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-ledger-"));
    try {
      const base = join(dir, ".switchroom");
      mkdirSync(base, { recursive: true });
      const led = buildLedger(
        [dupFinding("clerk", 1), dupFinding("marko", 2)],
        { ownerAgent: "klanker", now: new Date("2026-07-03T00:00:00Z") },
      );
      const path = writeLedger(base, led);
      const dash = readFleetHealth(path);
      expect(dash.empty).toBe(false);
      expect(dash.owner_agent).toBe("klanker");
      expect(dash.records[0].priority_score).toBeGreaterThanOrEqual(
        dash.records[1].priority_score,
      );
      expect(dash.records[0].job_spec).toBe("talk-to-agents-from-anywhere");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runScan (I/O) — defensive over a synthetic fleet tree", () => {
  it("scans good agents, skips a malformed/missing turns.jsonl without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-scan-"));
    try {
      const base = join(dir, ".switchroom");
      const agents = join(base, "agents");
      const logs = join(base, "logs");
      // good agent
      mkdirSync(join(agents, "clerk"), { recursive: true });
      mkdirSync(join(logs, "clerk"), { recursive: true });
      writeFileSync(
        join(agents, "clerk", "turns.jsonl"),
        JSON.stringify({
          turn_id: `${CHAT}:_#1`,
          status: "complete",
          tools: 0,
          // A genuine silent no-op used as an observable: route:'none' (nothing
          // reached the user) makes it a silent no-op vs a flush-recovery, and
          // lets it flag regardless of the route ship epoch (detect.ts).
          route: "none",
          // Real gateway rows always carry `ts`; the silent-no-op guard now
          // requires it (detect.ts). ~2026-07-02, matching the gw log line and
          // the scenario clock (below the fixed floor — see silentNoopFloorTs:0).
          ts: 1_783_032_000,
        }) + "\n",
      );
      writeFileSync(
        join(logs, "clerk", "gateway-supervisor.log"),
        `2026-07-02T21:03:00Z represent duplicate-send tid=${CHAT}:_#1\n`,
      );
      // malformed agent — corrupt turns, no log
      mkdirSync(join(agents, "broken"), { recursive: true });
      writeFileSync(join(agents, "broken", "turns.jsonl"), "{{{not json\n");
      // empty agent — no artifacts at all (skipped)
      mkdirSync(join(agents, "ghost"), { recursive: true });

      const warnings: string[] = [];
      const res = runScan({
        base,
        ownerAgent: "klanker",
        log: (m) => warnings.push(m),
        now: new Date("2026-07-03T00:00:00Z"),
        // Neutralize the silent-no-op floor for this fixture: the fixture turn
        // carries no `ts` and the scenario clock (2026-07-03) predates the
        // fixed floor, so without this override the silent-no-op finding is
        // dropped. Mirrors how detect.test.ts neutralizes the floor for
        // sub-floor fixtures. (prod CLI keeps the real floor — see fleet-health.ts)
        silentNoopFloorTs: 0,
        // Hermeticity: fully stub the live-state hindsight GPU sensor so it
        // neither shells out (docker/nvidia-smi) nor picks up a host-dependent
        // finding. "could not tell" ⇒ always ok, no finding.
        hindsightGpuDeps: {
          probe: () => ({ gpuPresent: false, containerToolkit: false, engine: "cloud", reason: "test stub" }),
          capsRead: () => ({ status: "absent", path: "/x", caps: null, detail: "" }),
          deviceRequests: () => null,
        },
      });
      expect(res.agentsSkipped).toContain("ghost");
      // clerk contributed a silent no-op + a duplicate delivery
      const delivery = res.ledger.records.find(
        (r) => r.job_spec === "talk-to-agents-from-anywhere",
      )!;
      expect(delivery.issues.length).toBeGreaterThan(0);
      const silent = res.ledger.records.find(
        (r) => r.job_spec === "know-what-my-agent-is-doing",
      )!;
      expect(silent.issues.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
