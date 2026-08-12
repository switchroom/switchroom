import { describe, it, expect } from "vitest";
import { syncLedgerIssues, type GhSyncDeps } from "./gh-sync.js";
import { buildLedger } from "./ledger.js";
import { dedupKeyFor } from "./mapping.js";
import type { Finding } from "./detect.js";
import type { FleetHealthLedger } from "../web/fleet-health-read.js";

const CHAT = "77770003";

/** Pinned scan clock. `buildLedger` windows findings by `windowDays` (default
 *  30) relative to `now`, so a fixture with a fixed `ts` must pin `now` too —
 *  otherwise it silently ages out of the window as the wall clock moves. */
const NOW = new Date("2026-07-03T00:00:00Z");

function dup(agent: string, seq: number): Finding {
  return {
    signal: "duplicate-delivery-represent",
    agent,
    turn_id: `${CHAT}:_#${seq}`,
    log_pointer: `logs/${agent}/gateway-supervisor.log:${seq}`,
    ts: "2026-07-02T21:03:00Z",
  };
}

function fakeDeps(over: Partial<GhSyncDeps> = {}): {
  deps: GhSyncDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  const deps: GhSyncDeps = {
    log: () => {},
    run: (args) => {
      calls.push(args);
      if (args[0] === "auth") return { ok: true, stdout: "", stderr: "" };
      if (args[0] === "issue" && args[1] === "create") {
        return {
          ok: true,
          stdout: "https://github.com/switchroom/switchroom/issues/1841",
          stderr: "",
        };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    ...over,
  };
  return { deps, calls };
}

describe("gh-sync (no network — injected deps)", () => {
  it("no-ops with a clear signal when gh is unavailable", () => {
    const led = buildLedger([dup("clerk", 1), dup("clerk", 2), dup("marko", 3)], {
      now: NOW,
    });
    const { deps } = fakeDeps({
      run: (args) =>
        args[0] === "auth"
          ? { ok: false, stdout: "", stderr: "not logged in" }
          : { ok: true, stdout: "", stderr: "" },
    });
    const r = syncLedgerIssues(led, "switchroom/switchroom", deps);
    expect(r.skipped).toBe(true);
    expect(r.synced).toBe(0);
  });

  it("opens an issue with fleet-health + severity + job labels and stores the number", () => {
    const led = buildLedger([dup("clerk", 1), dup("clerk", 2), dup("marko", 3)], {
      now: NOW,
    });
    const { deps, calls } = fakeDeps();
    const r = syncLedgerIssues(led, "switchroom/switchroom", deps);
    expect(r.skipped).toBe(false);
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
    const labelIdx = create.indexOf("--label");
    const labels = create[labelIdx + 1];
    expect(labels).toContain("fleet-health");
    expect(labels).toContain("severity:2");
    expect(labels).toContain("job:talk-to-agents-from-anywhere");

    const delivery = led.records.find(
      (r) => r.job_spec === "talk-to-agents-from-anywhere",
    )!;
    expect(delivery.issues[0].gh_issue).toBe(1841);
    expect(delivery.gh_issues).toContain(1841);
  });

  it("closes the GH issue when a fix drops findings to zero (close-on-zero)", () => {
    // Prior scan: a delivery problem was resolved-pending-verify with a linked
    // GH issue #1841. The dedup_key must match what buildLedger derives so the
    // close-on-zero synthesis finds it absent from the current (empty) aggs.
    const key = dedupKeyFor(dup("clerk", 1));
    const prior: FleetHealthLedger = {
      generated_at: "2026-07-02T00:00:00Z",
      records: [
        {
          job_spec: "talk-to-agents-from-anywhere",
          open_issue_count: 0,
          last_scanned: "2026-07-02T00:00:00Z",
          priority_score: 0,
          gh_issues: [1841],
          last_deep_dive: null,
          issues: [
            {
              dedup_key: key,
              failure_mode: "duplicate",
              severity: 2,
              frequency: 2,
              reach: ["clerk"],
              recency: "2026-07-01T00:00:00Z",
              occurrences: [],
              gh_issue: 1841,
              status: "resolved-pending-verify",
            },
          ],
        },
      ],
    };

    // Current scan: NO findings for that key (the fix landed → count zero).
    const led = buildLedger([], { prior });

    const delivery = led.records.find(
      (r) => r.job_spec === "talk-to-agents-from-anywhere",
    )!;
    const closed = delivery.issues.find((i) => i.dedup_key === key)!;
    expect(closed.status).toBe("closed");
    expect(closed.gh_issue).toBe(1841);
    expect(closed.frequency).toBe(0);

    // gh-sync must see the closed issue and run `gh issue close 1841`.
    const { deps, calls } = fakeDeps();
    const r = syncLedgerIssues(led, "switchroom/switchroom", deps);
    expect(r.skipped).toBe(false);
    const closeCall = calls.find(
      (c) => c[0] === "issue" && c[1] === "close" && c[2] === "1841",
    );
    expect(closeCall).toBeDefined();
  });
});
