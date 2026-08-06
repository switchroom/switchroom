import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLedger } from "./ledger.js";
import { runScan, writeLedger } from "./scan.js";
import type { Finding } from "./detect.js";
import { readFleetHealth } from "../web/fleet-health-read.js";

const CHAT = "77770002";

function dupFinding(agent: string, seq: number): Finding {
  return {
    signal: "duplicate-delivery-represent",
    agent,
    turn_id: `${CHAT}:_#${seq}`,
    log_pointer: `logs/${agent}/gateway-supervisor.log:${seq}`,
    ts: "2026-07-02T21:03:00Z",
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
