import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHysteresis, tick } from "./run.js";
import { loadState } from "./state.js";
import { RENOTIFY_MS } from "./thresholds.js";
import type { SignalState, Verdict } from "./types.js";

const OK = (signal: Verdict["signal"] = "retain-failure-rate"): Verdict => ({
  signal,
  state: "ok",
  detail: "ok",
});
const BREACH = (signal: Verdict["signal"] = "retain-failure-rate"): Verdict => ({
  signal,
  state: "breach",
  detail: "breach",
});
const NODATA = (signal: Verdict["signal"] = "retain-failure-rate"): Verdict => ({
  signal,
  state: "no-data",
  detail: "no-data",
});

const FRESH: SignalState = { status: "ok", breaches: 0, clears: 0 };

describe("applyHysteresis — the anti-spam contract", () => {
  it("does NOT fire a level signal on the first breach", () => {
    const r = applyHysteresis(FRESH, BREACH(), 1000);
    expect(r.transition).toBe("none");
    expect(r.next.status).toBe("ok");
    expect(r.next.breaches).toBe(1);
  });

  it("fires a level signal on the SECOND consecutive breach", () => {
    const first = applyHysteresis(FRESH, BREACH(), 1000);
    const second = applyHysteresis(first.next, BREACH(), 2000);
    expect(second.transition).toBe("fired");
    expect(second.next.status).toBe("firing");
    expect(second.next.firedAt).toBe(2000);
  });

  it("fires an EDGE signal (container / dead retains) immediately", () => {
    expect(applyHysteresis(FRESH, BREACH("container"), 1000).transition).toBe("fired");
    expect(applyHysteresis(FRESH, BREACH("retain-dead"), 1000).transition).toBe("fired");
  });

  it("does NOT re-notify on every subsequent breach", () => {
    let s = applyHysteresis(FRESH, BREACH(), 1000).next;
    s = applyHysteresis(s, BREACH(), 2000).next; // fired
    for (let t = 3000; t < 3000 + 20 * 60_000; t += 60_000) {
      expect(applyHysteresis(s, BREACH(), t).transition).toBe("none");
    }
  });

  it("re-notifies once the quiet period elapses", () => {
    let s = applyHysteresis(FRESH, BREACH(), 1000).next;
    const fired = applyHysteresis(s, BREACH(), 2000);
    s = fired.next;
    expect(applyHysteresis(s, BREACH(), 2000 + RENOTIFY_MS - 1).transition).toBe("none");
    const again = applyHysteresis(s, BREACH(), 2000 + RENOTIFY_MS);
    expect(again.transition).toBe("renotified");
    expect(again.next.lastNotifiedAt).toBe(2000 + RENOTIFY_MS);
  });

  it("requires TWO clean evaluations to resolve", () => {
    let s = applyHysteresis(FRESH, BREACH(), 1000).next;
    s = applyHysteresis(s, BREACH(), 2000).next;
    const clear1 = applyHysteresis(s, OK(), 3000);
    expect(clear1.transition).toBe("none");
    expect(clear1.next.status).toBe("firing");
    const clear2 = applyHysteresis(clear1.next, OK(), 4000);
    expect(clear2.transition).toBe("resolved");
    expect(clear2.next.status).toBe("ok");
  });

  it("no-data neither resolves a firing alert nor resets an accumulating one", () => {
    let s = applyHysteresis(FRESH, BREACH(), 1000).next;
    s = applyHysteresis(s, BREACH(), 2000).next; // firing
    const quiet = applyHysteresis(s, NODATA(), 3000);
    expect(quiet.transition).toBe("none");
    expect(quiet.next.status).toBe("firing");

    const accumulating = applyHysteresis(FRESH, BREACH(), 1000).next;
    const stillOne = applyHysteresis(accumulating, NODATA(), 2000);
    expect(stillOne.next.breaches).toBe(1);
  });

  it("a single clean evaluation resets the breach counter (no ratcheting)", () => {
    const one = applyHysteresis(FRESH, BREACH(), 1000).next;
    const cleaned = applyHysteresis(one, OK(), 2000).next;
    expect(cleaned.breaches).toBe(0);
    // …so an isolated breach an hour later still does not fire.
    expect(applyHysteresis(cleaned, BREACH(), 3000).transition).toBe("none");
  });
});

// ── tick() integration: fake probes, real state file ────────────────────

let dir: string;
let statePath: string;
let agentsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hindsight-watch-"));
  statePath = join(dir, "state.json");
  agentsDir = join(dir, "agents");
  mkdirSync(join(agentsDir, "alpha", "home", ".hindsight", "pending-retains"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function spool(pending: number, dead = 0): void {
  const d = join(agentsDir, "alpha", "home", ".hindsight", "pending-retains");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  for (let i = 0; i < pending; i++) writeFileSync(join(d, `p${i}.json`), "{}");
  for (let i = 0; i < dead; i++) writeFileSync(join(d, `d${i}.json.dead`), "{}");
}

function metricsBody(ok: number, fail: number): string {
  return (
    `hindsight_operation_operations_total{operation="retain",source="api",success="true"} ${ok}\n` +
    `hindsight_operation_operations_total{operation="retain",source="api",success="false"} ${fail}\n` +
    `hindsight_operation_duration_seconds_bucket{le="60.0",operation="retain",source="api",success="true"} ${ok}\n` +
    `hindsight_operation_duration_seconds_bucket{le="120.0",operation="retain",source="api",success="true"} ${ok}\n` +
    `hindsight_operation_duration_seconds_bucket{le="+Inf",operation="retain",source="api",success="true"} ${ok}\n`
  );
}

function fakeFetch(body: string | null, status = 200): typeof fetch {
  return (async () => {
    if (body === null) throw new Error("ECONNREFUSED");
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

const dockerOk = (
  restartCount = 0,
  startedAt = "2026-07-25T09:06:18Z",
  health = "healthy",
): ((cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string }) => {
  return () => ({ status: 0, stdout: `${restartCount}\t${startedAt}\t${health}\n`, stderr: "" });
};

interface Sent {
  texts: string[];
}

function makeNotify(sent: Sent, deliver = true): (t: string) => Promise<boolean> {
  return async (t) => {
    if (deliver) sent.texts.push(t);
    return deliver;
  };
}

describe("tick — end to end over a real state file", () => {
  it("fires ONE operator DM on the second storm interval, then goes quiet", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t0 = Date.parse("2026-07-25T09:00:00Z");

    // Baseline sample — nothing to compare against yet.
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1000, 10)), nowFn: () => t0 });
    expect(sent.texts).toEqual([]);

    // Interval 1: 30 retains, 15 failed (50%). First breach — no DM yet.
    const r1 = await tick({
      ...base,
      fetchImpl: fakeFetch(metricsBody(1015, 25)),
      nowFn: () => t0 + 900_000,
    });
    expect(r1.notified).toEqual([]);

    // Interval 2: still failing. Now it fires — exactly one DM.
    const r2 = await tick({
      ...base,
      fetchImpl: fakeFetch(metricsBody(1030, 40)),
      nowFn: () => t0 + 1_800_000,
    });
    expect(r2.exitCode).toBe(10);
    expect(sent.texts).toHaveLength(1);
    expect(sent.texts[0]).toContain("retain-failure-rate");
    expect(sent.texts[0]).toMatch(/5\d\.\d%/);

    // Interval 3+: still failing, and the operator is NOT re-paged.
    const r3 = await tick({
      ...base,
      fetchImpl: fakeFetch(metricsBody(1045, 55)),
      nowFn: () => t0 + 2_700_000,
    });
    expect(r3.exitCode).toBe(10);
    expect(sent.texts).toHaveLength(1);
  });

  it("never fires through a healthy run", async () => {
    const sent: Sent = { texts: [] };
    spool(50);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    for (let i = 0; i <= 6; i++) {
      const r = await tick({
        ...base,
        fetchImpl: fakeFetch(metricsBody(1000 + i * 40, 10 + i)),
        nowFn: () => t0 + i * 900_000,
      });
      expect(r.exitCode).toBe(0);
    }
    expect(sent.texts).toEqual([]);
  });

  it("exits 1 and DMs when the /metrics endpoint is unreachable — never a silent skip", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t0 = Date.parse("2026-07-25T09:00:00Z");

    const r1 = await tick({ ...base, fetchImpl: fakeFetch(null), nowFn: () => t0 });
    expect(r1.exitCode).toBe(1);
    expect(r1.probeError).toContain("metrics probe");
    expect(sent.texts).toEqual([]); // level hysteresis: first breach is silent

    const r2 = await tick({ ...base, fetchImpl: fakeFetch(null), nowFn: () => t0 + 900_000 });
    expect(r2.exitCode).toBe(1);
    expect(sent.texts).toHaveLength(1);
    expect(sent.texts[0]).toContain("cannot see hindsight");
  });

  it("exits 1 and DMs when /metrics answers 200 with no retain series", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    const body = 'hindsight_operation_operations_total{operation="recall",success="true"} 3\n';
    await tick({ ...base, fetchImpl: fakeFetch(body), nowFn: () => t0 });
    const r = await tick({ ...base, fetchImpl: fakeFetch(body), nowFn: () => t0 + 900_000 });
    expect(r.exitCode).toBe(1);
    expect(sent.texts[0]).toContain("cannot see hindsight");
  });

  it("exits 1 and DMs when docker cannot inspect the container", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const base = {
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: () => ({ status: 1, stdout: "", stderr: "No such object: switchroom-hindsight" }),
      fetchImpl: fakeFetch(metricsBody(10, 0)),
    };
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    await tick({ ...base, nowFn: () => t0 });
    const r = await tick({ ...base, nowFn: () => t0 + 900_000 });
    expect(r.exitCode).toBe(1);
    expect(sent.texts[0]).toContain("No such object");
  });

  it("fires immediately on a container restart", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    await tick({
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: dockerOk(0, "2026-07-25T09:06:18Z"),
      fetchImpl: fakeFetch(metricsBody(100, 0)),
      nowFn: () => t0,
    });
    const r = await tick({
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: dockerOk(1, "2026-07-25T09:20:00Z"),
      fetchImpl: fakeFetch(metricsBody(2, 0)),
      nowFn: () => t0 + 900_000,
    });
    expect(r.exitCode).toBe(10);
    expect(sent.texts.some((t) => t.includes("container"))).toBe(true);
  });

  it("fires immediately when a .dead marker appears", async () => {
    const sent: Sent = { texts: [] };
    spool(10, 0);
    const base = {
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: dockerOk(),
      fetchImpl: fakeFetch(metricsBody(100, 0)),
    };
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    await tick({ ...base, nowFn: () => t0 });
    spool(10, 3);
    const r = await tick({ ...base, nowFn: () => t0 + 900_000 });
    expect(r.exitCode).toBe(10);
    expect(sent.texts.some((t) => t.includes("retain-dead"))).toBe(true);
    expect(sent.texts.some((t) => t.includes("permanently lost"))).toBe(true);
  });

  it("retries the alert next tick when delivery fails (undelivered ≠ notified)", async () => {
    const failing: Sent = { texts: [] };
    spool(10);
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    const base = { statePath, agentsDir, run: dockerOk() };

    await tick({
      ...base,
      notify: makeNotify(failing, false),
      fetchImpl: fakeFetch(metricsBody(1000, 10)),
      nowFn: () => t0,
    });
    await tick({
      ...base,
      notify: makeNotify(failing, false),
      fetchImpl: fakeFetch(metricsBody(1015, 25)),
      nowFn: () => t0 + 900_000,
    });
    // Would have fired here, but the gateway was down.
    const r2 = await tick({
      ...base,
      notify: makeNotify(failing, false),
      fetchImpl: fakeFetch(metricsBody(1030, 40)),
      nowFn: () => t0 + 1_800_000,
    });
    expect(r2.notified).toEqual([]);
    // Exit 1, NOT 0: a breach nobody was told about is a failed check, and a
    // cron that reads exit 0 here would record "all clear" for an incident.
    expect(r2.exitCode).toBe(1);
    expect(loadState(statePath).signals["retain-failure-rate"]?.status).toBe("ok");

    // Gateway comes back: the very next tick delivers the alert.
    const ok: Sent = { texts: [] };
    const r3 = await tick({
      ...base,
      notify: makeNotify(ok),
      fetchImpl: fakeFetch(metricsBody(1045, 55)),
      nowFn: () => t0 + 2_700_000,
    });
    expect(ok.texts).toHaveLength(1);
    expect(r3.exitCode).toBe(10);
  });

  it("--dry-run prints the DM, sends nothing, and writes no state", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    const r = await tick({
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: dockerOk(1, "2026-07-25T09:20:00Z", "unhealthy"),
      fetchImpl: fakeFetch(metricsBody(100, 0)),
      nowFn: () => t0,
      dryRun: true,
    });
    expect(r.notified.length).toBeGreaterThan(0);
    expect(sent.texts).toEqual([]);
    expect(loadState(statePath).ring).toEqual([]);
  });

  it("resolves with one DM after two clean intervals", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t = (i: number): number => Date.parse("2026-07-25T09:00:00Z") + i * 900_000;

    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1000, 10)), nowFn: () => t(0) });
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1015, 25)), nowFn: () => t(1) });
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1030, 40)), nowFn: () => t(2) });
    expect(sent.texts).toHaveLength(1);

    // Recovery: plenty of clean retains each interval. The rolling window
    // still carries the storm's failures, so it takes a few clean intervals
    // for the WINDOW rate to fall back under threshold — then two clean
    // evaluations to resolve. That lag is deliberate: it is the same
    // hysteresis that stops a momentary dip from clearing a live incident.
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1200, 40)), nowFn: () => t(3) });
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1400, 40)), nowFn: () => t(4) });
    expect(sent.texts).toHaveLength(1);
    const r = await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1600, 40)), nowFn: () => t(5) });
    expect(sent.texts).toHaveLength(2);
    expect(sent.texts[1]).toContain("resolved");
    expect(r.exitCode).toBe(0);
  });

  it("keeps the alert FIRING when the all-clear cannot be delivered, and retries it", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const t = (i: number): number => Date.parse("2026-07-25T09:00:00Z") + i * 900_000;
    const base = { statePath, agentsDir, run: dockerOk() };
    const deliver = { notify: makeNotify(sent) };

    await tick({ ...base, ...deliver, fetchImpl: fakeFetch(metricsBody(1000, 10)), nowFn: () => t(0) });
    await tick({ ...base, ...deliver, fetchImpl: fakeFetch(metricsBody(1015, 25)), nowFn: () => t(1) });
    await tick({ ...base, ...deliver, fetchImpl: fakeFetch(metricsBody(1030, 40)), nowFn: () => t(2) });
    expect(sent.texts).toHaveLength(1); // fired

    // Recovery, but the gateway is down when the all-clear is due.
    const dropped: Sent = { texts: [] };
    const drop = { notify: makeNotify(dropped, false) };
    await tick({ ...base, ...drop, fetchImpl: fakeFetch(metricsBody(1200, 40)), nowFn: () => t(3) });
    await tick({ ...base, ...drop, fetchImpl: fakeFetch(metricsBody(1400, 40)), nowFn: () => t(4) });
    const lost = await tick({ ...base, ...drop, fetchImpl: fakeFetch(metricsBody(1600, 40)), nowFn: () => t(5) });

    // The undelivered all-clear must NOT be recorded as resolved, or the
    // operator is left holding a red alert forever.
    expect(lost.exitCode).toBe(1);
    expect(loadState(statePath).signals["retain-failure-rate"]?.status).toBe("firing");

    // Gateway returns: the next clean tick delivers the all-clear.
    const back = await tick({
      ...base,
      ...deliver,
      fetchImpl: fakeFetch(metricsBody(1800, 40)),
      nowFn: () => t(6),
    });
    expect(sent.texts).toHaveLength(2);
    expect(sent.texts[1]).toContain("resolved");
    expect(back.exitCode).toBe(0);
  });

  it("re-baselines after a long outage instead of paging on a stale window", async () => {
    const sent: Sent = { texts: [] };
    spool(10);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t0 = Date.parse("2026-07-25T09:00:00Z");

    // A day-old sample sits in the state file (cron was stopped).
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1000, 10)), nowFn: () => t0 });
    // Cron resumes 24h later. The counters have moved a long way; without the
    // age prune this would compute a 1440-minute failure rate against a
    // day-old baseline and could page about an era that already ended.
    const r = await tick({
      ...base,
      fetchImpl: fakeFetch(metricsBody(1100, 900)),
      nowFn: () => t0 + 24 * 3_600_000,
    });
    expect(loadState(statePath).ring).toHaveLength(1);
    const rate = r.outcomes.find((o) => o.verdict.signal === "retain-failure-rate");
    expect(rate?.verdict.state).toBe("no-data");
    expect(sent.texts).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
});
