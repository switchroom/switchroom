import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFleetHealth,
  fleetHealthLedgerPath,
  type FleetHealthLedger,
} from "./fleet-health-read.js";

/**
 * The Fleet Health page reads the owner agent's health ledger
 * (`~/.switchroom/fleet-health/ledger.json`), ranks the job records
 * worst-first by priority_score, and degrades to a clearly-marked empty
 * state when the ledger is absent (no owner agent assigned yet) or
 * unreadable — so the page always renders and is testable without a live
 * pipeline. These pin that reader.
 */
describe("readFleetHealth (job-spec-anchored issue tracker)", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-fleet-health-"));
    ledgerPath = join(dir, "ledger.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLedger(ledger: FleetHealthLedger): void {
    writeFileSync(ledgerPath, JSON.stringify(ledger));
  }

  const sampleLedger: FleetHealthLedger = {
    owner_agent: "klanker",
    generated_at: "2026-07-03T02:00:00Z",
    summary: "1 severe issue open across 2 agents.",
    records: [
      {
        job_spec: "feel-like-a-colleague",
        open_issue_count: 1,
        last_scanned: "2026-07-03T02:00:00Z",
        priority_score: 12.5,
        gh_issues: [1840],
        last_deep_dive: null,
        issues: [
          {
            dedup_key: "drift:padded-replies",
            failure_mode: "drift",
            severity: 1,
            frequency: 20,
            reach: ["clerk"],
            recency: "2026-07-01T10:00:00Z",
            occurrences: [
              { agent: "clerk", turn_id: "111:_#1", log_pointer: "logs/clerk/gw.log:pad" },
            ],
            gh_issue: 1840,
            status: "open",
          },
        ],
      },
      {
        job_spec: "fleet-stays-healthy",
        open_issue_count: 1,
        last_scanned: "2026-07-03T02:00:00Z",
        priority_score: 42.7,
        gh_issues: [1841],
        last_deep_dive: "2026-06-30T02:14:00Z",
        issues: [
          {
            dedup_key: "duplicate:represent-duplicate-send",
            failure_mode: "duplicate",
            severity: 2,
            frequency: 282,
            reach: ["clerk", "marko"],
            recency: "2026-07-02T21:03:00Z",
            occurrences: [
              {
                agent: "clerk",
                turn_id: "12345:_#12673",
                log_pointer: "logs/clerk/gateway-supervisor.log:represent duplicate-send",
              },
            ],
            gh_issue: 1841,
            status: "open",
          },
        ],
      },
    ],
  };

  it("ranks records worst-first by priority_score", () => {
    writeLedger(sampleLedger);
    const dash = readFleetHealth(ledgerPath);
    expect(dash.empty).toBe(false);
    expect(dash.records.map((r) => r.job_spec)).toEqual([
      "fleet-stays-healthy", // 42.7 — worst first
      "feel-like-a-colleague", // 12.5
    ]);
  });

  it("surfaces owner_agent, generated_at, and the L3 summary", () => {
    writeLedger(sampleLedger);
    const dash = readFleetHealth(ledgerPath);
    expect(dash.owner_agent).toBe("klanker");
    expect(dash.generated_at).toBe("2026-07-03T02:00:00Z");
    expect(dash.summary).toContain("severe issue open");
  });

  it("preserves hard-artifact evidence (turn_id + log pointer) per issue", () => {
    writeLedger(sampleLedger);
    const dash = readFleetHealth(ledgerPath);
    const rec = dash.records.find((r) => r.job_spec === "fleet-stays-healthy");
    const occ = rec?.issues[0].occurrences[0];
    expect(occ?.turn_id).toBe("12345:_#12673");
    expect(occ?.log_pointer).toContain("represent duplicate-send");
    expect(rec?.issues[0].gh_issue).toBe(1841);
  });

  it("degrades to a clearly-marked empty state when the ledger is missing", () => {
    // no file written — feature inert (no owner agent assigned yet)
    const dash = readFleetHealth(ledgerPath);
    expect(dash.empty).toBe(true);
    expect(dash.records).toEqual([]);
    expect(dash.owner_agent).toBeNull();
    expect(dash.reason).toContain("not wired up");
  });

  it("degrades to empty (never throws) on malformed JSON", () => {
    writeFileSync(ledgerPath, "{ not json");
    const dash = readFleetHealth(ledgerPath);
    expect(dash.empty).toBe(true);
    expect(dash.reason).toBeDefined();
  });

  it("degrades to empty when the records array is absent", () => {
    writeLedger({ owner_agent: "klanker" } as FleetHealthLedger);
    const dash = readFleetHealth(ledgerPath);
    expect(dash.empty).toBe(true);
    expect(dash.records).toEqual([]);
  });

  it("normalizes a missing / non-number priority_score to 0", () => {
    writeLedger({
      owner_agent: "klanker",
      records: [
        // missing priority_score entirely
        { job_spec: "no-score", open_issue_count: 0, issues: [] },
        // non-number priority_score (malformed ledger)
        {
          job_spec: "bad-score",
          open_issue_count: 0,
          priority_score: "oops",
          issues: [],
        },
        { job_spec: "good-score", open_issue_count: 0, priority_score: 5, issues: [] },
      ],
    } as unknown as FleetHealthLedger);
    const dash = readFleetHealth(ledgerPath);
    expect(dash.empty).toBe(false);
    // every record now carries a finite number score (never undefined/NaN/string)
    for (const r of dash.records) {
      expect(typeof r.priority_score).toBe("number");
      expect(Number.isFinite(r.priority_score)).toBe(true);
    }
    // the real score still ranks first; normalized-to-0 records follow
    expect(dash.records[0].job_spec).toBe("good-score");
  });

  it("resolves the default ledger path under ~/.switchroom/fleet-health", () => {
    const home = mkdtempSync(join(tmpdir(), "sr-home-"));
    mkdirSync(join(home, ".switchroom", "fleet-health"), { recursive: true });
    expect(fleetHealthLedgerPath(home)).toBe(
      join(home, ".switchroom", "fleet-health", "ledger.json"),
    );
    rmSync(home, { recursive: true, force: true });
  });
});
