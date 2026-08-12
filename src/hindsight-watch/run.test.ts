import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyHysteresis, formatFiring, tick } from "./run.js";
import { recallLogPath } from "./recall-log.js";
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

  it("fires an EDGE signal (container / memory loss) immediately", () => {
    expect(applyHysteresis(FRESH, BREACH("container"), 1000).transition).toBe("fired");
    expect(applyHysteresis(FRESH, BREACH("retain-loss"), 1000).transition).toBe("fired");
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

/**
 * Write a recall log for `agent` whose rows reduce to the given score/pool.
 *
 * Enough rows to clear `RECALL_MIN_SAMPLES`, all stamped just before `now` so
 * they land inside the tick's trailing window; values are constant because
 * these tests assert the PLUMBING (does the summary reach the baseline, does
 * it survive a save/load), not the distribution — that is what
 * `recall-degradation.test.ts` uses the real fixture for.
 */
function recallLog(agent: string, score: number, pool: number, now: number): void {
  const p = recallLogPath(join(agentsDir, agent));
  mkdirSync(dirname(p), { recursive: true });
  const rows = Array.from({ length: 60 }, (_, i) => ({
    ts: new Date(now - (60 - i) * 10_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    bank_id: agent,
    result_count: 8,
    total_elapsed_ms: 1200,
    deadline_hit: false,
    deadline_effective_ms: 9993,
    pre_cap_count: pool,
    overlap_dropped: 0,
    injected_score_max: score,
    cache_hit: false,
    error: null,
    bank_timings: [{ bank_id: agent, elapsed_ms: 1200, timed_out: false, errored: false }],
  }));
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** #3599's `pending-evicted/` archive — a SIBLING of `pending-retains/`. */
function evicted(n: number): void {
  const d = join(agentsDir, "alpha", "home", ".hindsight", "pending-evicted");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(d, `e${i}.json`), "{}");
}

/**
 * The DURABLE `pending-reconciled/` archive — where drained (persisted)
 * entries are retired, capped at 500 and trimmed by `reason=archive-count`.
 * A SIBLING of `pending-retains/`, and NOT a loss channel: the watchdog must
 * never count it as live queue depth or as eviction. Also writes a matching
 * `pending-evictions.log` full of archive-count trims, exactly as the live
 * fleet had on 2026-08-05, to prove neither is read as loss.
 */
function reconciledArchive(n: number): void {
  const base = join(agentsDir, "alpha", "home", ".hindsight");
  const d = join(base, "pending-reconciled");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(d, `r${i}.json`), "{}");
  let log = "";
  for (let i = 0; i < n; i++) {
    log += `2026-08-05T11:0${i % 10}:00Z trimmed=r${i}.json bytes=1000 archive=pending-reconciled reason=archive-count archive_depth=500\n`;
  }
  writeFileSync(join(base, "pending-evictions.log"), log);
}

/** #3599's `record_drop` ledger — retains that never reached the queue. */
function drops(count: number): void {
  writeFileSync(
    join(agentsDir, "alpha", "home", ".hindsight", "pending-drops.json"),
    JSON.stringify({ schema: 1, count, last_dropped_at: "2026-07-26T00:00:00Z" }),
  );
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
    expect(sent.texts.some((t) => t.includes("retain-loss"))).toBe(true);
    expect(sent.texts.some((t) => t.includes("3 new .dead marker(s)"))).toBe(true);
  });

  // #3599 added two loss channels beside `.dead`, and the probe has to walk
  // real sibling paths to see them — so they are asserted end to end here
  // rather than only against a hand-built window.
  it("fires when memory is EVICTED from a full queue (#3599), not just .dead", async () => {
    const sent: Sent = { texts: [] };
    spool(10, 0);
    evicted(0);
    const base = {
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: dockerOk(),
      fetchImpl: fakeFetch(metricsBody(100, 0)),
    };
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    await tick({ ...base, nowFn: () => t0 });
    evicted(4);
    const r = await tick({ ...base, nowFn: () => t0 + 900_000 });
    expect(r.exitCode).toBe(10);
    expect(sent.texts.some((t) => t.includes("4 new evicted entry(s)"))).toBe(true);
    // The evicted archive must never be counted as live queue depth.
    const loss = r.outcomes.find((o) => o.verdict.signal === "retain-loss");
    expect(loss?.verdict.measured).toMatchObject({ evicted: 4, dead: 0, drops: 0 });
    const growth = r.outcomes.find((o) => o.verdict.signal === "retain-queue-growth");
    expect(growth?.verdict.measured?.pending).toBe(10);
  });

  // The 2026-08-05 false alarm, end to end: a deep-but-under-cap backlog with
  // a durable `pending-reconciled/` archive being archive-count-trimmed must
  // (a) never fire `retain-loss`, and (b) surface the backlog as an ORANGE
  // "degraded" notice, not the RED page an operator reads as "memories are
  // being lost". Fails against the pre-fix build, where queue-growth paged red.
  it("a deep under-cap backlog with archive-count trims is WARN, never a loss page", async () => {
    const sent: Sent = { texts: [] };
    reconciledArchive(600); // durable, trimmed — must be invisible to the probe
    spool(400); // under the 2,000-entry per-agent cap
    const base = {
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: dockerOk(),
      fetchImpl: fakeFetch(metricsBody(100, 0)),
    };
    const t0 = Date.parse("2026-08-05T09:00:00Z");
    // First breach: spool jumps 400 → 1200 (rising, past the floor). Level
    // signal — silent on the first breach.
    await tick({ ...base, nowFn: () => t0 });
    spool(1200);
    const r = await tick({ ...base, nowFn: () => t0 + 900_000 });

    // The archive is neither live depth nor loss.
    const growth = r.outcomes.find((o) => o.verdict.signal === "retain-queue-growth");
    expect(growth?.verdict.measured?.pending).toBe(1200); // NOT 1200 + 600 archive
    expect(growth?.verdict.state).toBe("breach");
    expect(growth?.verdict.severity).toBe("warn");
    const loss = r.outcomes.find((o) => o.verdict.signal === "retain-loss");
    expect(loss?.verdict.state).toBe("ok");
    // No red loss page reached the operator; the second breach would DM orange.
    expect(sent.texts.some((t) => t.includes("🔴 hindsight: retain-loss"))).toBe(false);
    expect(sent.texts.some((t) => t.includes("🔴 hindsight: retain-queue-growth"))).toBe(false);
  });

  it("fires when a retain never reached the queue at all (record_drop ledger)", async () => {
    const sent: Sent = { texts: [] };
    spool(10, 0);
    drops(2);
    const base = {
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run: dockerOk(),
      fetchImpl: fakeFetch(metricsBody(100, 0)),
    };
    const t0 = Date.parse("2026-07-25T09:00:00Z");
    // A pre-existing, non-zero drop count is NOT news — only a rise is.
    const r0 = await tick({ ...base, nowFn: () => t0 });
    const r1 = await tick({ ...base, nowFn: () => t0 + 900_000 });
    expect(r0.exitCode).toBe(0);
    expect(r1.exitCode).toBe(0);
    expect(sent.texts).toEqual([]);

    drops(5);
    const r2 = await tick({ ...base, nowFn: () => t0 + 1_800_000 });
    expect(r2.exitCode).toBe(10);
    expect(sent.texts.some((t) => t.includes("3 new dropped retain(s)"))).toBe(true);
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

  it("the trailing baseline SURVIVES that same outage, unlike the ring", async () => {
    // The paired assertion to the test above, and the reason the baseline is a
    // separate structure rather than more ring. The ring must forget across a
    // gap (a stale window would page about an era that already ended); the
    // baseline must NOT, because a quality regression that begins during a
    // watchdog outage is exactly the one still worth catching on return.
    // Asserting only one of these would leave the other free to drift into it.
    const sent: Sent = { texts: [] };
    spool(10);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t0 = Date.parse("2026-08-09T09:00:00Z");

    recallLog("alpha", 0.87, 95, t0);
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1000, 10)), nowFn: () => t0 });

    const t1 = t0 + 24 * 3_600_000;
    recallLog("alpha", 0.86, 94, t1);
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1100, 20)), nowFn: () => t1 });

    const back = loadState(statePath);
    expect(back.ring).toHaveLength(1); // forgot, as it must
    expect(back.baseline?.days.map((d) => d.day)).toEqual(["2026-08-09", "2026-08-10"]);
    expect(back.baseline?.days[0]?.scoreObs).toHaveLength(1);
  });

  it("persists a baseline the next tick can actually read back", async () => {
    // Round-trips through JSON and `normalizeBaseline`, which is where a
    // schema that only worked in memory would break — and it would break
    // SILENTLY, as a permanent `no-data` nobody is paged about.
    const sent: Sent = { texts: [] };
    spool(10);
    const base = { statePath, agentsDir, notify: makeNotify(sent), run: dockerOk() };
    const t0 = Date.parse("2026-08-11T09:00:00Z");
    recallLog("alpha", 0.88, 96, t0);
    await tick({ ...base, fetchImpl: fakeFetch(metricsBody(1000, 10)), nowFn: () => t0 });

    const persisted = loadState(statePath).baseline;
    expect(persisted).toBeDefined();
    const day = persisted!.days.find((d) => d.day === "2026-08-11")!;
    expect(day.scoreObs[0]).toBeCloseTo(0.88, 4);
    expect(day.poolObs[0]).toBe(96);
  });
});

describe("formatFiring — severity in the notification shade", () => {
  const base = { signal: "recall-candidate-floor" as const, state: "breach" as const, detail: "d" };

  it("renders a page-severity breach red", () => {
    expect(formatFiring({ ...base, severity: "page" }, false)).toContain(
      "🔴 hindsight: recall-candidate-floor",
    );
  });

  it("renders a warn-severity breach orange and says 'degraded'", () => {
    // So an operator can triage a 3.98h consolidation backlog from the phone
    // without opening a terminal, and does not learn to ignore the red dot.
    const out = formatFiring({ ...base, severity: "warn" }, false);
    expect(out).toContain("🟠");
    expect(out).toContain("degraded");
  });

  it("leaves every pre-existing signal red — none of them sets a severity", () => {
    const out = formatFiring({ signal: "retain-failure-rate", state: "breach", detail: "d" }, false);
    expect(out.startsWith("🔴 hindsight: retain-failure-rate\n")).toBe(true);
  });
});

// ── the 2026-07-29 consolidation outage, end to end ─────────────────────
//
// The regression this whole file section exists to pin: on 2026-07-29 the
// `overlord` bank's consolidation failed on ~every run for 2.5 h while the
// watchdog's `consolidation-queue-age` signal read "consolidation queue
// empty" — because the failing path marks the row `failed` in milliseconds,
// so it never appears in the `pending`/`processing` set that signal reads.
//
// These tests construct that EXACT condition — N consecutive failed ops with
// an empty pending queue — and assert an operator DM is actually sent. They
// fail against the pre-#3982 build for the right reason: nothing there reads
// `status='failed'`, so nothing fires.

/**
 * A docker runner that answers each of the four calls a tick makes, keyed on
 * the shell text so it cannot silently answer the wrong probe.
 */
function dockerIncident(opts: {
  /** `(bank, op_type, streak, newest_failure_age_s, last_completed_age_s)` rows */
  streaks?: Array<[string, string, number, number, number | null]>;
  /** `(bank, pending_consolidation)` rows */
  pending?: Array<[string, number]>;
  /** async_operations rows in `pending`/`processing` — the OLD signal's input */
  queueDepth?: number;
  queueOldestAgeS?: number;
  /** HNSW indexes that raised, as `name=error` */
  corruptIndexes?: string[];
  probedIndexes?: number;
}): (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string } {
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
  return (_cmd, args) => {
    if (args[0] === "inspect") return ok("0\t2026-07-29T04:00:00Z\thealthy\n");
    const sh = args[args.length - 1] ?? "";
    if (sh.includes("VECIDX")) {
      const bad = opts.corruptIndexes ?? [];
      const probed = opts.probedIndexes ?? 89;
      return ok(`NOTICE:  VECIDX|${probed}|${bad.length}|${bad.map((b) => `${b};`).join("")}\n`);
    }
    if (sh.includes("'S|'||")) {
      const lines = [
        ...(opts.streaks ?? []).map(
          ([b, t, n, age, ok]) => `S|${b}|${t}|${n}|${age}|${ok ?? ""}`,
        ),
        ...(opts.pending ?? [["overlord", 0]] as Array<[string, number]>).map(
          ([b, n]) => `P|${b}|${n}`,
        ),
      ];
      return ok(lines.join("\n") + "\n");
    }
    if (sh.includes("status IN ('pending','processing')")) {
      return ok(`${opts.queueDepth ?? 0}|${opts.queueOldestAgeS ?? 0}\n`);
    }
    return { status: 1, stdout: "", stderr: "unexpected docker call" };
  };
}

describe("tick — the 2026-07-29 silent consolidation outage", () => {
  it("DMs the operator while consolidation-queue-age still reads EMPTY", async () => {
    const sent: Sent = { texts: [] };
    spool(0);
    const t0 = Date.parse("2026-07-29T05:00:00Z");
    const run = dockerIncident({
      // The live shape, read off the production database during the incident:
      // `overlord | consolidation | 103 | 668`. Nothing else in the fleet.
      streaks: [["overlord", "consolidation", 103, 668, 9412]],
      pending: [["overlord", 38130], ["carrie", 45]],
      // …and the pending/processing queue is EMPTY at the same instant. This
      // is the whole bug: the old signal's input says the fleet is healthy.
      queueDepth: 0,
    });
    const base = { statePath, agentsDir, notify: makeNotify(sent), run };

    const r = await tick({
      ...base,
      fetchImpl: fakeFetch(metricsBody(1000, 10)),
      nowFn: () => t0,
    });

    // The blind signal, in the same tick, on the same data: still "ok" — but
    // its detail no longer reads as an all-clear (#3989): it names where the
    // failures it cannot see ARE counted instead of saying "queue empty".
    const age = r.outcomes.find((o) => o.verdict.signal === "consolidation-queue-age")!;
    expect(age.verdict.state).toBe("ok");
    expect(age.verdict.detail).not.toContain("consolidation queue empty");
    expect(age.verdict.detail).toContain("consolidation-failure-streak");

    // The new one fires on the FIRST tick — it is an edge signal, because a
    // streak of 3+ is already its own debounce.
    const streak = r.outcomes.find((o) => o.verdict.signal === "consolidation-failure-streak")!;
    expect(streak.verdict.state).toBe("breach");
    expect(streak.verdict.severity).toBe("page");
    expect(streak.transition).toBe("fired");
    expect(r.exitCode).toBe(10);

    // The outcome that matters: a human was told, and told WHICH bank.
    const dm = sent.texts.find((t) => t.includes("consolidation-failure-streak"));
    expect(dm).toBeDefined();
    expect(dm).toContain("overlord");
    expect(dm).toContain("103 consecutive FAILED consolidation");
  });

  it("DMs on the SPARSE 2026-08-12 shape, whose failures are 37h old", async () => {
    // End-to-end proof of the blind spot: `graph_maintenance` is
    // demand-driven, so a totally broken job emits no recent failure and the
    // whole tick — probe, parse, evaluate, notify — used to come back green.
    const sent: Sent = { texts: [] };
    spool(0);
    const t0 = Date.parse("2026-08-12T07:00:00Z");
    const run = dockerIncident({
      streaks: [
        ["overlord", "graph_maintenance", 19, 133_977, 791_908],
        ["klanker", "graph_maintenance", 9, 328_555, 791_676],
      ],
      pending: [["overlord", 0], ["klanker", 0]],
      queueDepth: 0,
    });
    const r = await tick({
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run,
      fetchImpl: fakeFetch(metricsBody(1000, 10)),
      nowFn: () => t0,
    });

    const streak = r.outcomes.find((o) => o.verdict.signal === "consolidation-failure-streak")!;
    expect(streak.verdict.state).toBe("breach");
    expect(streak.verdict.severity).toBe("page");
    expect(r.exitCode).toBe(10);

    const dm = sent.texts.find((t) => t.includes("consolidation-failure-streak"));
    expect(dm).toBeDefined();
    expect(dm).toContain("19 consecutive FAILED graph_maintenance");
    expect(dm).toContain("last SUCCESS 220.0h ago");
  });

  it("stays silent on a fleet with no failure streak at all — the live healthy shape", async () => {
    const sent: Sent = { texts: [] };
    spool(0);
    const t0 = Date.parse("2026-07-29T05:00:00Z");
    // Measured live 2026-07-29: 0 streak rows, largest healthy per-bank
    // unconsolidated depth 45, 89 HNSW indexes clean.
    const run = dockerIncident({
      streaks: [],
      pending: [["carrie", 45], ["switchroom-dev", 12], ["klanker", 0]],
    });
    const base = { statePath, agentsDir, notify: makeNotify(sent), run };
    for (let i = 0; i <= 4; i++) {
      const r = await tick({
        ...base,
        fetchImpl: fakeFetch(metricsBody(1000 + i * 40, 10)),
        nowFn: () => t0 + i * 900_000,
      });
      expect(r.exitCode).toBe(0);
    }
    expect(sent.texts).toEqual([]);
  });

  it("DMs on a corrupt HNSW index, naming the index and the fix", async () => {
    const sent: Sent = { texts: [] };
    spool(0);
    const t0 = Date.parse("2026-07-29T05:00:00Z");
    const run = dockerIncident({
      probedIndexes: 88,
      corruptIndexes: ["idx_mu_emb_obsv_81cef5f6a42e4b4d=different vector dimensions 384 and 0"],
    });
    const r = await tick({
      statePath,
      agentsDir,
      notify: makeNotify(sent),
      run,
      fetchImpl: fakeFetch(metricsBody(1000, 10)),
      nowFn: () => t0,
    });
    expect(r.exitCode).toBe(10);
    const dm = sent.texts.find((t) => t.includes("vector-index-corruption"));
    expect(dm).toBeDefined();
    expect(dm).toContain("idx_mu_emb_obsv_81cef5f6a42e4b4d");
    expect(dm).toContain("REINDEX");
  });
});
