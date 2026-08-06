import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { isTestAgent } from "./test-agents.js";
import { runScan } from "./scan.js";

/**
 * Metric-truth: `test-harness` (and any test/synthetic/UAT agent) deliberately
 * exercises the represent/obligation-escalation path on every UAT run, so it
 * must NOT count as production drift — its occurrences must never enter the
 * ledger's frequency/reach. Regression guard for the 341/418-inflation bug.
 */
describe("isTestAgent", () => {
  it("flags the sanctioned test-harness canary", () => {
    expect(isTestAgent("test-harness")).toBe(true);
    expect(isTestAgent("TEST-HARNESS")).toBe(true);
  });

  it("flags test/synthetic/uat prefixes", () => {
    expect(isTestAgent("test-foo")).toBe(true);
    expect(isTestAgent("synthetic-probe")).toBe(true);
    expect(isTestAgent("uat-gate")).toBe(true);
  });

  it("does not flag real production agents", () => {
    for (const a of ["marko", "clerk", "klanker", "carrie", "gymbro"]) {
      expect(isTestAgent(a)).toBe(false);
    }
  });

  it("does not flag the empty slug", () => {
    expect(isTestAgent("")).toBe(false);
    expect(isTestAgent("   ")).toBe(false);
  });
});

describe("runScan excludes test agents from the ledger", () => {
  const bases: string[] = [];
  afterEach(() => {
    for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
  });

  // One gateway log line that trips the represent/obligation-escalation signal.
  const ESCALATION_LINE =
    "2026-07-03T02:00:00Z telegram gateway: obligation escalation delivered + closed origin=77770001:_#1";

  function makeAgent(base: string, agent: string, gwLines: string[]): void {
    mkdirSync(resolve(base, "agents", agent), { recursive: true });
    writeFileSync(resolve(base, "agents", agent, "turns.jsonl"), "", "utf-8");
    mkdirSync(resolve(base, "logs", agent), { recursive: true });
    writeFileSync(
      resolve(base, "logs", agent, "gateway-supervisor.log"),
      gwLines.join("\n") + "\n",
      "utf-8",
    );
  }

  function freshBase(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "fh-scan-"));
    const base = resolve(dir, ".switchroom");
    mkdirSync(base, { recursive: true });
    bases.push(dir);
    return base;
  }

  it("keeps a real agent's escalations but drops test-harness's", () => {
    const base = freshBase();
    // test-harness produces 5 escalations; a real agent produces 1.
    makeAgent(base, "test-harness", Array(5).fill(ESCALATION_LINE));
    makeAgent(base, "marko", [ESCALATION_LINE]);

    // Hermeticity: fully stub the live-state hindsight GPU sensor so it neither
    // shells out (docker/nvidia-smi) nor injects a host-dependent finding into
    // this fixture scan. "could not tell" ⇒ always ok, no finding.
    const res = runScan({
      base,
      hindsightGpuDeps: {
        probe: () => ({ gpuPresent: false, containerToolkit: false, engine: "cloud", reason: "test stub" }),
        capsRead: () => ({ status: "absent", path: "/x", caps: null, detail: "" }),
        deviceRequests: () => null,
      },
    });

    expect(res.agentsExcluded).toContain("test-harness");
    expect(res.agentsScanned).toBe(1); // only marko

    // The represent/obligation-escalation issue must reflect ONLY marko:
    // frequency 1, reach [marko], not 6 across two agents.
    const record = res.ledger.records.find(
      (r) => r.job_spec === "feel-like-a-colleague",
    );
    expect(record).toBeDefined();
    const escalationIssues = (record?.issues ?? []).filter(
      (i) =>
        i.dedup_key === "feel-like-a-colleague:represent:obligation-escalation" &&
        i.frequency > 0,
    );
    for (const iss of escalationIssues) {
      expect(iss.reach).not.toContain("test-harness");
    }
    const totalReach = new Set(escalationIssues.flatMap((i) => i.reach));
    expect(totalReach.has("test-harness")).toBe(false);
    expect(totalReach.has("marko")).toBe(true);
    const totalFreq = escalationIssues.reduce((s, i) => s + i.frequency, 0);
    expect(totalFreq).toBe(1); // marko's single escalation only
  });
});
