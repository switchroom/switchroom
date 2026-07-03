import { describe, it, expect } from "vitest";
import { syncLedgerIssues, type GhSyncDeps } from "./gh-sync.js";
import { buildLedger } from "./ledger.js";
import type { Finding } from "./detect.js";

const CHAT = "77770003";

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
    const led = buildLedger([dup("clerk", 1), dup("clerk", 2), dup("marko", 3)]);
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
    const led = buildLedger([dup("clerk", 1), dup("clerk", 2), dup("marko", 3)]);
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
});
