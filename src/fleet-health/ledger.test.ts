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

/**
 * #4680 — the counting-UNIT guard.
 *
 * `frequency` is a count, and `buildLedger`'s self-verify closes an issue when
 * the count DROPS. Rule 3 of this PR changes what a gateway finding counts:
 * one per affected turn instead of one per matching log line. That makes every
 * open gateway issue's frequency fall on the first scan after merge with
 * nothing fixed — and the drop is indistinguishable from a real fix unless the
 * ledger records the ruler alongside the number. Left unguarded, a live
 * `duplicate-delivery-represent` issue flips to `resolved-pending-verify`,
 * closes on the next scan, and `gh-sync` comments "Verified count-drop …" on a
 * still-broken GitHub issue.
 */
describe("#4680 — a change of counting UNIT is not a count-drop", () => {
  const NOW = new Date("2026-07-03T00:00:00Z");
  const DELIVERY = "talk-to-agents-from-anywhere";
  const KILLED_JOB = "steer-or-queue-mid-flight";

  /** A ledger exactly as a PRE-#4680 scan wrote it to disk: counts are log
   *  lines and no `counting_unit` field exists on any issue. */
  function legacyLedger(findings: Finding[], ghIssue?: number) {
    const led = buildLedger(findings, { now: NOW });
    for (const rec of led.records) {
      for (const iss of rec.issues) {
        delete (iss as { counting_unit?: unknown }).counting_unit;
        if (ghIssue !== undefined) iss.gh_issue = ghIssue;
      }
    }
    return led;
  }

  const issueOn = (led: ReturnType<typeof buildLedger>, job: string) =>
    led.records.find((r) => r.job_spec === job)!.issues[0];

  it("holds a live gateway issue OPEN when the fold shrinks its frequency", () => {
    // Pre-#4680 on-disk state: 8 duplicate-send log lines across 3 turns.
    const prior = legacyLedger(
      [1, 1, 1, 2, 2, 2, 3, 3].map((turn, i) => dupFinding("clerk", turn, `2026-07-02T21:0${i}:00Z`)),
      4242,
    );
    expect(issueOn(prior, DELIVERY).frequency).toBe(8);
    expect(issueOn(prior, DELIVERY).status).toBe("open");

    // First post-merge scan: the SAME three broken turns, now folded to one
    // finding each. 3 <= RESOLVED_THRESHOLD, so the naive rule fires.
    const next = buildLedger(
      [1, 2, 3].map((t) => dupFinding("clerk", t, "2026-07-02T21:30:00Z")),
      { now: NOW, prior },
    );
    const iss = issueOn(next, DELIVERY);
    expect(iss.frequency).toBe(3);
    expect(iss.gh_issue).toBe(4242);
    // The defect is unchanged, so the board must still say so.
    expect(iss.status).toBe("open");
    // …and the new ruler is recorded, so the NEXT scan compares like with like.
    expect(iss.counting_unit).toBe("gateway-event");
  });

  it("still closes on a genuine drop the scan AFTER the unit change settles", () => {
    const legacy = legacyLedger(
      Array.from({ length: 20 }, (_, i) => dupFinding("clerk", i)),
      4242,
    );
    // Scan 1 — unit changes; held open despite the low count.
    const scan1 = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: legacy });
    expect(issueOn(scan1, DELIVERY).status).toBe("open");
    // Scan 2 — same unit on both sides now. Prior frequency is 1, which is not
    // above the threshold, so the count-drop arm cannot fire; the guard must
    // not have laundered a close either. A real regression back up and down is
    // what re-arms it, which is the honest semantics.
    const scan2 = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: scan1 });
    expect(issueOn(scan2, DELIVERY).status).toBe("open");

    // A real fix, measured in the SAME unit both times, still closes.
    const busy = buildLedger(
      Array.from({ length: 20 }, (_, i) => dupFinding("clerk", i)),
      { now: NOW, prior: scan2 },
    );
    expect(issueOn(busy, DELIVERY).frequency).toBe(20);
    const fixed = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: busy });
    expect(issueOn(fixed, DELIVERY).status).toBe("resolved-pending-verify");
    const verified = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: fixed });
    expect(issueOn(verified, DELIVERY).status).toBe("closed");
  });

  it("does not delay a signal whose unit did NOT change", () => {
    // `killed-incomplete-turn` is a turns.jsonl signal — the gateway fold never
    // touched it, so its legacy `log-line` unit still matches and the ordinary
    // count-drop must fire on the very first scan.
    const legacy = legacyLedger(
      Array.from({ length: 20 }, (_, i) =>
        killedFinding("clerk", i, "2026-07-02T21:03:00Z"),
      ),
      777,
    );
    const next = buildLedger(
      [killedFinding("clerk", 99, "2026-07-02T21:03:00Z")],
      { now: NOW, prior: legacy },
    );
    const iss = issueOn(next, KILLED_JOB);
    expect(iss.status).toBe("resolved-pending-verify");
    expect(iss.counting_unit).toBe("log-line");
  });

  it("never advances a pending-verify gateway issue to closed across the change", () => {
    const legacy = legacyLedger(
      Array.from({ length: 20 }, (_, i) => dupFinding("clerk", i)),
      4242,
    );
    // Pre-#4680: the issue had already dropped and was awaiting verification.
    const pending = legacyLedger([dupFinding("clerk", 1)], 4242);
    issueOn(pending, DELIVERY).status = "resolved-pending-verify";
    expect(issueOn(legacy, DELIVERY).frequency).toBe(20);

    const next = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: pending });
    // Held, not closed: the verification scan must be measured in the same unit
    // as the drop it is verifying.
    expect(issueOn(next, DELIVERY).status).toBe("resolved-pending-verify");
    const after = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: next });
    expect(issueOn(after, DELIVERY).status).toBe("closed");
  });
});

/**
 * #4682 — the counting-unit guard's two blind spots.
 *
 * M1: the guard rewrites `frequency` to the POST-fold count, and the
 * count-drop arm required `prior.frequency > RESOLVED_THRESHOLD`. A folded
 * count of 3 never satisfies that again, so a held issue could only ever leave
 * the board through the zero path — stale-open forever, not "delayed one
 * scan".
 *
 * B1: the guard only sees a prior issue under the SAME dedup_key. A finding
 * that reclassifies into a sibling signature (`orphaned-db-handle` →
 * `orphaned-db-handle-recovered`) empties its old key entirely, which reads as
 * a fix-to-zero and drives the close-on-zero path — the same false "Verified
 * count-drop" claim the unit guard exists to prevent, on a key the guard
 * cannot see.
 */
describe("#4682 — the guard's blind spots", () => {
  const NOW = new Date("2026-07-03T00:00:00Z");
  const DELIVERY = "talk-to-agents-from-anywhere";
  const DB_JOB = "survive-reboots-and-real-life";

  const issueFor = (led: ReturnType<typeof buildLedger>, key: string) =>
    led.records.flatMap((r) => r.issues).find((i) => i.dedup_key.endsWith(key));

  function legacyLedger(findings: Finding[], ghIssue?: number) {
    const led = buildLedger(findings, { now: NOW });
    for (const rec of led.records) {
      for (const iss of rec.issues) {
        delete (iss as { counting_unit?: unknown }).counting_unit;
        if (ghIssue !== undefined) iss.gh_issue = ghIssue;
      }
    }
    return led;
  }

  it("M1: a held issue still closes when its folded count genuinely drops", () => {
    // Pre-#4680: 8 duplicate-send log lines across 3 turns, GH #4242.
    const legacy = legacyLedger(
      [1, 1, 1, 2, 2, 2, 3, 3].map((t, i) =>
        dupFinding("clerk", t, `2026-07-02T21:0${i}:00Z`),
      ),
      4242,
    );
    // Scan 1 — the ruler changes, 8 log lines fold to 3 turns. Held open.
    const held = buildLedger([1, 2, 3].map((t) => dupFinding("clerk", t)), {
      now: NOW,
      prior: legacy,
    });
    const heldIssue = held.records.find((r) => r.job_spec === DELIVERY)!.issues[0];
    expect(heldIssue.status).toBe("open");
    expect(heldIssue.frequency).toBe(3);

    // Scan 2 — someone actually fixes two of the three turns. Same ruler on
    // both sides now, and the count really dropped. The board must be able to
    // say so: this is the "delayed one scan, never suppressed" promise.
    const dropped = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: held });
    const droppedIssue = dropped.records.find((r) => r.job_spec === DELIVERY)!.issues[0];
    expect(droppedIssue.frequency).toBe(1);
    expect(droppedIssue.status).toBe("resolved-pending-verify");

    // Scan 3 — verified, closed.
    const verified = buildLedger([dupFinding("clerk", 1)], { now: NOW, prior: dropped });
    expect(
      verified.records.find((r) => r.job_spec === DELIVERY)!.issues[0].status,
    ).toBe("closed");
  });

  it("M1: a count that does NOT drop is never laundered into pending-verify", () => {
    const legacy = legacyLedger(
      [1, 1, 1, 2, 2, 2, 3, 3].map((t, i) =>
        dupFinding("clerk", t, `2026-07-02T21:0${i}:00Z`),
      ),
      4242,
    );
    const held = buildLedger([1, 2, 3].map((t) => dupFinding("clerk", t)), {
      now: NOW,
      prior: legacy,
    });
    // Same three broken turns, forever. Nothing dropped, so nothing closes.
    let led = held;
    for (let scan = 0; scan < 3; scan++) {
      led = buildLedger([1, 2, 3].map((t) => dupFinding("clerk", t)), {
        now: NOW,
        prior: led,
      });
      expect(led.records.find((r) => r.job_spec === DELIVERY)!.issues[0].status).toBe(
        "open",
      );
    }
  });

  const dbFinding = (signal: Finding["signal"], seq: number): Finding => ({
    signal,
    agent: "alpha",
    turn_id: `alpha:gw#${seq}`,
    log_pointer: `logs/alpha/gateway-supervisor.log:${seq}`,
    ts: "2026-07-02T21:03:00Z",
  });

  it("B1: a reclassification into a sibling signature is not a verified fix", () => {
    const prior = buildLedger([dbFinding("orphaned-db-handle", 1)], { now: NOW });
    const priorIssue = issueFor(prior, "deleted-inode-writes")!;
    priorIssue.gh_issue = 909;
    expect(priorIssue.status).toBe("open");

    // The SAME sweep tick, now sorted into the recovered sibling. Nothing was
    // fixed; the alarm was re-filed.
    const next = buildLedger([dbFinding("orphaned-db-handle-recovered", 1)], {
      now: NOW,
      prior,
    });
    const migrated = issueFor(next, "deleted-inode-writes")!;
    expect(migrated.frequency).toBe(0);
    expect(migrated.gh_issue).toBe(909);
    // It IS closed — zero occurrences is zero occurrences — but the ledger must
    // record WHY, so gh-sync cannot claim a count-drop nobody earned.
    expect(migrated.status).toBe("closed");
    expect(migrated.close_reason).toBe("reclassified");
    // …and the sibling is on the board carrying the evidence.
    expect(issueFor(next, "recovered-in-tick")!.frequency).toBe(1);
  });

  it("B1: a genuine drop to zero is still marked as a count-drop", () => {
    const prior = buildLedger([dbFinding("orphaned-db-handle", 1)], { now: NOW });
    issueFor(prior, "deleted-inode-writes")!.gh_issue = 909;
    // No findings at all this scan — the sweep stopped firing.
    const next = buildLedger([], { now: NOW, prior });
    const closed = issueFor(next, "deleted-inode-writes")!;
    expect(closed.status).toBe("closed");
    expect(closed.close_reason).toBe("count-drop");
  });

  it("B1: an issue that comes back after closing is marked for reopening", () => {
    const prior = buildLedger([dbFinding("orphaned-db-handle", 1)], { now: NOW });
    issueFor(prior, "deleted-inode-writes")!.gh_issue = 909;
    const closed = buildLedger([], { now: NOW, prior });
    expect(issueFor(closed, "deleted-inode-writes")!.status).toBe("closed");

    // It regresses. A closed GitHub issue that never reopens is the board
    // lying permanently, which is the one thing this ledger exists to prevent.
    const back = buildLedger([dbFinding("orphaned-db-handle", 2)], {
      now: NOW,
      prior: closed,
    });
    const reborn = issueFor(back, "deleted-inode-writes")!;
    expect(reborn.status).toBe("open");
    expect(reborn.gh_issue).toBe(909);
    expect(reborn.reopened).toBe(true);
  });

  /**
   * #4682 M2 — pins the DURABILITY WINDOW of the reopen path above, because the
   * RFC now states it as a contract (`reference/rfcs/fleet-health.md`, "the
   * reopen path is a one-scan window"). `buildLedger`'s close-on-zero loop only
   * carries a prior key forward when its status is `open` or
   * `resolved-pending-verify` (`ledger.ts:283-287`), so a `closed` issue with
   * no findings is DROPPED on the very next scan and its `gh_issue` number goes
   * with it. A defect returning two or more scans later therefore cannot
   * reopen — it falls through to `gh-sync`'s create path and files a fresh
   * issue. That is deliberate (an unbounded tombstone list is its own problem)
   * but it is not obvious from the code, and a silent change to the window
   * would change which incidents keep their thread.
   */
  it("B1: the reopen window is exactly one scan — then the GH number is gone", () => {
    const prior = buildLedger([dbFinding("orphaned-db-handle", 1)], { now: NOW });
    issueFor(prior, "deleted-inode-writes")!.gh_issue = 909;

    // Scan 2: no findings — closed, but the number is still carried.
    const scan2 = buildLedger([], { now: NOW, prior });
    expect(issueFor(scan2, "deleted-inode-writes")!.gh_issue).toBe(909);

    // Scan 3: still clean — the key is dropped from the ledger entirely.
    const scan3 = buildLedger([], { now: NOW, prior: scan2 });
    expect(issueFor(scan3, "deleted-inode-writes")).toBeUndefined();

    // Scan 4: the defect is back, but there is nothing left to reopen. It is a
    // fresh issue as far as gh-sync is concerned.
    const scan4 = buildLedger([dbFinding("orphaned-db-handle", 2)], {
      now: NOW,
      prior: scan3,
    });
    const refiled = issueFor(scan4, "deleted-inode-writes")!;
    expect(refiled.status).toBe("open");
    expect(refiled.gh_issue).toBeUndefined();
    expect(refiled.reopened).toBeUndefined();
  });
});
