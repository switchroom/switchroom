/**
 * Tests for `checkPendingRetainsQueues` — the per-agent pending-retains
 * probe (#1071 queue, scoping fix #1094).
 *
 * The bug class this replaces: the old `checkPendingRetainsQueue` scanned
 * `~/.hindsight/pending-retains/` on the OPERATOR HOST, but the queue is
 * written by session_end.py running INSIDE each agent container
 * (HOME=/state/agent/home). The host dir is always empty, so doctor
 * reported "ok" even when an agent had a real backlog or dead markers.
 *
 * We inject the per-agent probe so these tests exercise only the
 * aggregation + verdict shape — the real `probePendingRetainsQueue` is
 * exercised against a live container, not in unit tests (mirrors the
 * vault-broker socket-pair test seam).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPendingRetainsProbeScript,
  checkPendingRetainsQueues,
  parsePendingRetainsProbeOutput,
  PENDING_RETAINS_EVICTION_WINDOW_DAYS,
  type PendingRetainsProbeResult,
} from "./doctor.js";
import type { SwitchroomConfig } from "../config/schema.js";

function cfg(agentNames: string[]): SwitchroomConfig {
  const agents: Record<string, unknown> = {};
  for (const n of agentNames) agents[n] = {};
  return { agents } as unknown as SwitchroomConfig;
}

function probeFrom(
  states: Record<string, PendingRetainsProbeResult>,
): (name: string) => PendingRetainsProbeResult {
  return (name: string) =>
    states[name] ?? down();
}

/** Default cap; overridden per-case where the threshold is the point. */
const CAP = 2000;

const ok = (): PendingRetainsProbeResult => ({
  state: "ok",
  pending: 0,
  dead: 0,
  dropped: 0,
  evicted: 0,
  cap: CAP,
});
const backlog = (
  n: number,
  extra: Partial<PendingRetainsProbeResult> = {},
): PendingRetainsProbeResult => ({
  state: "backlog",
  pending: n,
  dead: 0,
  dropped: 0,
  evicted: 0,
  cap: CAP,
  ...extra,
});
const dead = (d: number, p = 0): PendingRetainsProbeResult => ({
  state: "dead",
  pending: p,
  dead: d,
  dropped: 0,
  evicted: 0,
  cap: CAP,
});
const down = (): PendingRetainsProbeResult => ({
  state: "unreachable",
  pending: 0,
  dead: 0,
  dropped: 0,
  evicted: 0,
  cap: CAP,
});

describe("checkPendingRetainsQueues (#1071/#1094)", () => {
  it("ok: all reachable agents have an empty queue", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk", "ziggy", "carrie"]), {
      probe: probeFrom({ clerk: ok(), ziggy: ok(), carrie: ok() }),
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("3/3");
    expect(r.detail).toContain("empty");
  });

  it("ok: empty fleet (no agents declared)", () => {
    const r = checkPendingRetainsQueues(cfg([]), { probe: () => ok() });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no agents configured");
  });

  it("warn: a live backlog names the agent and its count", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk", "ziggy"]), {
      probe: probeFrom({ clerk: ok(), ziggy: backlog(4) }),
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("ziggy (4)");
  });

  // #3596: the old remediation said a live backlog "drains automatically
  // on the agent's next SessionStart". It does not -- that drain clamps
  // each entry's HTTP timeout to the remaining hook budget (1-8s) while
  // the retain POSTs synchronously and takes 30-90s, so the server commits
  // and the client always gives up before the ack. The entry is never
  // deleted and is re-posted every session, forever. The hook drain is
  // what BUILT the backlog; telling the operator to wait for it is the
  // single worst thing this row could say.
  it("never tells the operator a backlog drains itself on SessionStart", () => {
    const rows = [
      checkPendingRetainsQueues(cfg(["ziggy"]), {
        probe: probeFrom({ ziggy: backlog(400) }),
      }),
      checkPendingRetainsQueues(cfg(["ziggy"]), {
        probe: probeFrom({ ziggy: dead(2, 400) }),
      }),
    ];
    for (const r of rows) {
      const text = `${r.detail ?? ""} ${r.fix ?? ""}`;
      expect(text).not.toMatch(/drains automatically/i);
      expect(text).not.toMatch(/drains on next SessionStart/i);
      // ...and it must name the path that actually works.
      expect(r.fix).toContain("drain_pending.py --backlog");
    }
  });

  it("warn: a backlog carries the explicit backlog-drain remediation", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("drain_pending.py --backlog");
    expect(r.fix).toContain("HINDSIGHT_DRAIN_CONCURRENCY");
  });

  // The retain model pool is small and shared with live traffic, so a
  // remediation that says "drain it" without saying "slowly, one agent at
  // a time" converts a memory backlog into a latency incident.
  it("warn: the remediation paces the drain instead of just starting one", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    const fix = r.fix ?? "";
    expect(fix).toContain("--phase reconcile");
    expect(fix).toMatch(/ONE agent at a time/i);
    expect(fix).toContain("HINDSIGHT_DRAIN_SLEEP_S");
    expect(fix).toContain("HINDSIGHT_DRAIN_P95_CMD");
  });

  // An operator who has just been told to run a drain needs to know where a
  // retired entry went -- the drain moves it, it does not delete it, and that
  // is the whole reason a wrong reconcile is recoverable.
  it("warn: the remediation says retired entries are archived, not deleted", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    const fix = r.fix ?? "";
    expect(fix).toContain(".hindsight/pending-reconciled/");
    expect(fix).toMatch(/never deleted/i);
  });

  it("fail: residual drops fail even with a healthy queue", () => {
    // The queue has since drained, but 37 turns could not be written at
    // all -- that memory is gone and must not read as "ok".
    const r = checkPendingRetainsQueues(cfg(["overlord", "clerk"]), {
      probe: probeFrom({ overlord: { ...ok(), dropped: 37 }, clerk: ok() }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("permanently dropped");
    expect(r.detail).toContain("overlord (37)");
    // The ledger is a SIBLING of the queue dir, not the old in-dir path.
    expect(r.fix).toContain(".hindsight/pending-drops.json");
    expect(r.fix).not.toContain("pending-retains/.drops.json");
  });

  it("fail: drops are reported alongside a live backlog", () => {
    const r = checkPendingRetainsQueues(cfg(["overlord"]), {
      probe: probeFrom({ overlord: backlog(158, { dropped: 12 }) }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain(
      "permanently dropped (could not be written): overlord (12)",
    );
    expect(r.detail).toContain("backlog: overlord (158)");
  });

  // Eviction is deliberate and bounded, but it is still memory shed, and
  // it must never be inferable only from a depth reading.
  it("fail: recorded evictions fail even once the queue has drained", () => {
    const r = checkPendingRetainsQueues(cfg(["marko"]), {
      probe: probeFrom({ marko: { ...ok(), evicted: 413 } }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("evicted to make room for newer entries");
    expect(r.detail).toContain("marko (413)");
    expect(r.fix).toContain("pending-evicted/");
    expect(r.fix).toContain("HINDSIGHT_PENDING_MAX_ENTRIES");
  });

  // Eviction is DESIGNED behaviour here and the ledger is append-only, so a
  // cumulative count would pin this row to fail forever after one legitimate
  // eviction. A check that trains operators to ignore it is worse than none.
  it("the eviction count is windowed, and says so", () => {
    const r = checkPendingRetainsQueues(cfg(["marko"]), {
      probe: probeFrom({ marko: { ...ok(), evicted: 5 } }),
    });
    expect(r.detail).toMatch(/in the last \d+d/);
    expect(r.fix).toMatch(/clears on its own/i);
    // …and must NOT tell the operator to delete the record of what was shed.
    expect(r.fix).not.toMatch(/reset it by deleting/i);
  });

  // "Set HINDSIGHT_DRAIN_P95_CMD" without a command is unactionable — the
  // operator has to go find the query the watchdog uses.
  it("warn: the p95 guidance ships a copy-pasteable command", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    const fix = r.fix ?? "";
    expect(fix).toContain("HINDSIGHT_DRAIN_P95_CMD");
    expect(fix).toContain("percentile_cont(0.95)");
    expect(fix).toContain("LiteLLM_SpendLogs");
    expect(fix).toMatch(/millisecond integer on stdout/);
  });

  // ADJACENCY, not mere presence. The assertions above — and the two #3689
  // ones below — are all substring checks, and a substring check cannot see
  // a splice: when a block of serialisation prose was inserted INTO the
  // middle of this sentence, the operator-facing text read "(must print a
  // SAFE ALONGSIDE THE `hindsight-drain` SIDECAR …" and picked the sentence
  // back up nine lines later with "…to replay them. millisecond integer on
  // stdout; unset = no backoff)." Both fragments still existed, so every
  // touching test stayed green while the remediation was incoherent at
  // exactly the point it explains the backoff contract. Green tests
  // asserting the wrong thing are worse than no test, so assert the sentence
  // is CONTIGUOUS.
  it("warn: the p95 backoff sentence is contiguous, not two fragments", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    const fix = r.fix ?? "";
    expect(
      fix,
      "the backoff contract must read as one sentence, start to finish",
    ).toContain("(must print a millisecond integer on stdout; unset = no backoff).");
    // …and nothing may be wedged between its two halves. Asserted separately
    // from the substring above so a failure names WHICH property broke.
    const opener = fix.indexOf("(must print a");
    const contract = fix.indexOf("millisecond integer on stdout");
    expect(opener, "the sentence opener is missing entirely").toBeGreaterThan(-1);
    expect(contract, "the contract clause is missing entirely").toBeGreaterThan(-1);
    expect(
      fix.slice(opener + "(must print a".length, contract),
      "text was spliced into the middle of the p95 backoff sentence",
    ).toBe(" ");
  });

  // The reciprocal: the block that was spliced IN must itself stay whole, so
  // a future re-anchor of some other paragraph cannot cut this one in half
  // the same way and still pass on substrings.
  it("warn: the serialisation and circuit-breaker guidance is contiguous too", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    const fix = r.fix ?? "";
    expect(fix).toContain(
      "SAFE ALONGSIDE THE `hindsight-drain` SIDECAR and a session booting " +
        "underneath you: drain_pending.py takes an exclusive lock on " +
        "`$HOME/.hindsight/drain-pending.lock` for the whole run",
    );
    expect(fix).toContain(
      "Entries past the attempt ceiling (HINDSIGHT_DRAIN_ATTEMPT_CEILING, " +
        "default 20) are PARKED and reported rather than retried forever; add " +
        "`--force` once the upstream is fixed to replay them.",
    );
  });

  // #3689: this command is now one of THREE drain paths into the same queue
  // (the others being the SessionStart hook and the `hindsight-drain`
  // sidecar). An operator running it cannot know whether one of the others is
  // mid-run, and two drains on one queue means one memory POSTed twice
  // against a 4-lane fleet-wide pool. The serialisation lives inside
  // drain_pending.py precisely so this documented command inherits it -- but
  // the operator still has to be told, and told NOT to add an `flock` of
  // their own on that path, which would hold the lock the script then asks
  // for and turn the drain into a silent no-op.
  it("warn: the remediation says the documented drain is serialised, and how not to break it", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    const fix = r.fix ?? "";
    expect(fix).toContain("drain-pending.lock");
    expect(fix).toMatch(/exclusive lock/i);
    expect(fix, "the operator must be told not to wrap it").toMatch(
      /Do NOT wrap this in `flock`/i,
    );
  });

  // A parked entry is queue depth that will never go down on its own. An
  // operator staring at that depth needs the escape hatch named, or the
  // circuit breaker reads as the drain being broken.
  it("warn: the remediation names the attempt ceiling and the --force replay", () => {
    const r = checkPendingRetainsQueues(cfg(["ziggy"]), {
      probe: probeFrom({ ziggy: backlog(400) }),
    });
    const fix = r.fix ?? "";
    expect(fix).toContain("HINDSIGHT_DRAIN_ATTEMPT_CEILING");
    expect(fix).toContain("--force");
  });

  it("ok: zero drops and zero evictions never mention either", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk"]), {
      probe: probeFrom({ clerk: ok() }),
    });
    expect(r.status).toBe("ok");
    const text = `${r.detail ?? ""} ${r.fix ?? ""}`;
    expect(text).not.toContain("dropped");
    expect(text).not.toContain("evicted");
  });

  it("fail: a .dead marker escalates past a warn and points at inspection", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk", "ziggy"]), {
      probe: probeFrom({ clerk: ok(), ziggy: dead(2, 1) }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("dead markers: ziggy (2 dead, 1 queued)");
    expect(r.fix).toContain(".json.dead");
    expect(r.fix).toContain("docker exec switchroom-<agent>");
  });

  // Depth alone is NOT loss: a full queue evicts the oldest entry rather
  // than refusing the incoming one. Failing the row on depth told the
  // operator memory was being dropped when none had been.
  it("warn (not fail): a queue at the threshold has not lost anything yet", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk"]), {
      probe: probeFrom({ clerk: backlog(2000) }),
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("at the eviction threshold");
    expect(r.detail).toContain("clerk (2000/2000)");
    expect(r.detail).not.toMatch(/dropping new failures/i);
  });

  // The cap is env-driven and already retuned fleet-wide, so a hardcoded
  // constant made doctor cry "at cap" at a container happily accepting
  // entries -- and stay silent at one that really was evicting.
  it("compares depth against the agent's OWN cap, not a constant", () => {
    const under = checkPendingRetainsQueues(cfg(["clerk"]), {
      probe: probeFrom({ clerk: backlog(1200, { cap: 5000 }) }),
    });
    expect(under.status).toBe("warn");
    expect(under.detail).toContain("queued: clerk (1200)");
    expect(under.detail).not.toContain("threshold");

    const over = checkPendingRetainsQueues(cfg(["clerk"]), {
      probe: probeFrom({ clerk: backlog(600, { cap: 500 }) }),
    });
    expect(over.status).toBe("warn");
    expect(over.detail).toContain("at the eviction threshold");
    expect(over.detail).toContain("clerk (600/500)");
  });

  it("fail: dead on one agent, backlog on another — both surfaced, fail wins", () => {
    const r = checkPendingRetainsQueues(cfg(["alpha", "bravo", "charlie"]), {
      probe: probeFrom({ alpha: dead(1), bravo: backlog(3), charlie: ok() }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("dead markers: alpha (1 dead)");
    expect(r.detail).toContain("backlog: bravo (3)");
  });

  it("skip: every agent container unreachable — one honest skip, not N rows", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk", "ziggy"]), {
      probe: probeFrom({ clerk: down(), ziggy: down() }),
    });
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("unreachable");
  });

  it("partial unreachable (mid-restart) does NOT collapse to skip", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk", "ziggy"]), {
      probe: probeFrom({ clerk: ok(), ziggy: down() }),
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("skipped (unreachable): ziggy");
  });

  it("partial unreachable is noted alongside a real backlog verdict", () => {
    const r = checkPendingRetainsQueues(cfg(["a", "b", "c"]), {
      probe: probeFrom({ a: backlog(2), b: down(), c: ok() }),
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("a (2)");
    expect(r.detail).toContain("skipped (unreachable): b");
  });

  it("names agents in stable sorted order", () => {
    const r = checkPendingRetainsQueues(cfg(["zeta", "alpha", "mike"]), {
      probe: probeFrom({ zeta: backlog(1), alpha: backlog(1), mike: ok() }),
    });
    expect(r.status).toBe("warn");
    // alpha before zeta in the joined list.
    const detail = r.detail ?? "";
    expect(detail.indexOf("alpha")).toBeLessThan(detail.indexOf("zeta"));
  });
});

/**
 * The probe's SHELL ARITHMETIC, run for real.
 *
 * Before this block, `probePendingRetainsQueue` had no test at all: the
 * suite injected a fake probe and exercised only aggregation. The one case
 * that mentioned the window ("the eviction count is windowed, and says
 * so") asserted the message wording, so deleting the `$1 >= c` filter from
 * the awk clause — making the count cumulative for all time — kept all 21
 * tests green while pinning the doctor row to `fail` forever after a
 * single legitimate eviction (#3599 review R3-B3).
 *
 * These run the generated one-liner with `sh -c` against a tmpdir instead
 * of a container, and assert the NUMBER.
 */
describe("buildPendingRetainsProbeScript — eviction window arithmetic", () => {
  const NOW = Date.parse("2026-07-25T12:00:00Z");
  const iso = (daysAgo: number) =>
    new Date(NOW - daysAgo * 86400_000).toISOString().replace(/\.\d+Z$/, "Z");

  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "doctor-pending-probe-"));
    mkdirSync(join(base, "pending-retains"), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Run the real probe script and parse its counters out of it. */
  function runProbe(env: Record<string, string> = {}): {
    P: number;
    D: number;
    X: number;
    E: number;
    C: number;
  } {
    const script = buildPendingRetainsProbeScript(base, NOW);
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    const grab = (k: string) =>
      parseInt(new RegExp(`${k}=(\\d+)`).exec(r.stdout)?.[1] ?? "-1", 10);
    return {
      P: grab("P"),
      D: grab("D"),
      X: grab("X"),
      E: grab("E"),
      C: grab("C"),
    };
  }

  function writeEvictionLog(daysAgo: number[]) {
    writeFileSync(
      join(base, "pending-evictions.log"),
      daysAgo
        .map(
          (d, i) =>
            `${iso(d)} evicted=1000-${i}.json bytes=99 reason=count ` +
            `queue_depth=2000 queue_bytes=1234`,
        )
        .join("\n") + "\n",
    );
  }

  it("counts ONLY the evictions inside the window, not every one ever", () => {
    // 3 inside 7d (0.5/3/6.9 days ago), 4 outside (7.1/30/90/400).
    writeEvictionLog([0.5, 3, 6.9, 7.1, 30, 90, 400]);
    expect(runProbe().E).toBe(3);
  });

  it("an all-historic ledger reads as zero, so the row can clear", () => {
    // The whole point: eviction is designed behaviour, so a row that can
    // never go back to ok trains the operator to ignore it.
    writeEvictionLog([8, 9, 60, 365]);
    expect(runProbe().E).toBe(0);
  });

  it("an entirely recent ledger counts every line", () => {
    writeEvictionLog([0, 1, 2, 3, 4, 5, 6]);
    expect(runProbe().E).toBe(7);
  });

  it("the boundary is the cutoff itself, and it is inclusive", () => {
    const cutoff = iso(PENDING_RETAINS_EVICTION_WINDOW_DAYS);
    writeFileSync(
      join(base, "pending-evictions.log"),
      `${cutoff} evicted=a.json bytes=1 reason=count queue_depth=1 queue_bytes=1\n`,
    );
    expect(runProbe().E).toBe(1);
  });

  it("non-eviction lines in the ledger are not counted", () => {
    writeFileSync(
      join(base, "pending-evictions.log"),
      [
        `${iso(1)} evicted=a.json bytes=1 reason=count queue_depth=1 queue_bytes=1`,
        `${iso(1)} rotated log lines=500`,
        `${iso(2)} evicted=b.json bytes=1 reason=bytes queue_depth=1 queue_bytes=1`,
      ].join("\n") + "\n",
    );
    expect(runProbe().E).toBe(2);
  });

  it("a missing ledger is zero, not an error", () => {
    expect(runProbe().E).toBe(0);
  });

  it("counts queued and dead entries without overlap", () => {
    const dir = join(base, "pending-retains");
    for (const n of ["1-a.json", "2-b.json", "3-c.json"])
      writeFileSync(join(dir, n), "{}");
    for (const n of ["4-d.json.dead", "5-e.json.dead"])
      writeFileSync(join(dir, n), "{}");
    const r = runProbe();
    expect(r.P).toBe(3);
    expect(r.D).toBe(2);
  });

  it("counts dead markers in the pending-dead/ sibling too", () => {
    // Markers moved OUT of the live queue directory so no janitor glob can
    // match a memory. If the probe only counted the in-queue form, that
    // relocation would read as "0 dead" and silently retire the operator's
    // only view of permanently-failed retains.
    const dd = join(base, "pending-dead");
    mkdirSync(dd, { recursive: true });
    for (const n of ["1-a.json.dead", "2-b.json.dead"])
      writeFileSync(join(dd, n), "{}");
    const r = runProbe();
    expect(r.D).toBe(2);
    expect(r.P).toBe(0); // and never as queue depth
  });

  it("sums dead across BOTH locations during a mid-migration fleet", () => {
    writeFileSync(join(base, "pending-retains", "legacy.json.dead"), "{}");
    const dd = join(base, "pending-dead");
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, "moved.json.dead"), "{}");
    expect(runProbe().D).toBe(2);
  });

  it("reads the residual-drop count from the sibling ledger", () => {
    writeFileSync(
      join(base, "pending-drops.json"),
      JSON.stringify({ count: 37, last: "x" }),
    );
    expect(runProbe().X).toBe(37);
  });

  // DEFENSIVE, and labelled as such. `grep -o` emits every
  // `"count"…<digits>` match and `head -n1` takes the first. A well-formed
  // ledger has exactly one — `lib/pending.py:_record_drop` writes a single
  // JSON object via tmp+os.replace, and a "count" quoted inside
  // `last_error_message` is backslash-escaped, so it cannot match. This
  // pins the behaviour for a ledger that is NOT well formed (a truncated
  // or doubly-written legacy file): the first, i.e. current, record wins
  // rather than whatever trailing garbage the file ends with.
  it("takes the FIRST count when a malformed ledger carries several", () => {
    writeFileSync(
      join(base, "pending-drops.json"),
      '{"schema": 1, "count": 12}\n{"schema": 1, "count": 999999}\n',
    );
    expect(runProbe().X).toBe(12);
  });

  // The sibling `pending-drops.json` is the current location; the
  // in-directory `.drops.json` is only a fallback for agents still on an
  // older plugin build. Reading the stale one in preference would report a
  // frozen count forever.
  it("prefers the sibling ledger over the legacy in-directory one", () => {
    writeFileSync(join(base, "pending-drops.json"), JSON.stringify({ count: 3 }));
    writeFileSync(
      join(base, "pending-retains", ".drops.json"),
      JSON.stringify({ count: 91 }),
    );
    expect(runProbe().X).toBe(3);
  });

  it("falls back to the legacy in-directory ledger when the sibling is absent", () => {
    writeFileSync(
      join(base, "pending-retains", ".drops.json"),
      JSON.stringify({ count: 91 }),
    );
    expect(runProbe().X).toBe(91);
  });

  // The cap is read from the agent's LIVE env because it is retuned via
  // switchroom.yaml; the compiled-in number is only the fallback, and it
  // must match the plugin's own default (lib/pending.py MAX_ENTRIES).
  it("reports the live cap, falling back to the plugin default", () => {
    expect(runProbe().C).toBe(2000);
    expect(runProbe({ HINDSIGHT_PENDING_MAX_ENTRIES: "500" }).C).toBe(500);
  });
});

/**
 * The OTHER half of the probe (#3599 review R4-B2).
 *
 * The B3 split made the shell arithmetic testable and left the parser with
 * zero tests while its comment still said "exported for testing" — it was
 * not even exported. Four mutations survived the whole doctor suite, and
 * each of them is a fleet-visible failure, not a nicety:
 *
 *   - `r.status !== 0` → `=== 0`: every SUCCESSFUL probe reads
 *     `unreachable` and every failure gets parsed. doctor goes permanently
 *     blind to the queue it exists to watch.
 *   - `dead > 0` → `>= 0`: every reachable agent reports `dead`, so the row
 *     is pinned to `fail` forever — the exact "trains operators to ignore
 *     it" failure the eviction window was designed to avoid.
 *   - `pending > 0` → `>= 0`: no agent can ever read `ok`.
 *   - `cap > 0` → `>= 0`: a `C=0` read (older image, or a garbage env
 *     value) becomes a cap of 0 instead of the 2000 default, and every
 *     backlog is then reported as "at the eviction threshold".
 *
 * Driven from synthetic `{status, stdout}` records — the parser takes that
 * shape rather than a `SpawnSyncReturns` precisely so no container is
 * needed.
 */
describe("parsePendingRetainsProbeOutput — probe verdict", () => {
  const out = (s: string, status: number | null = 0) =>
    parsePendingRetainsProbeOutput({ status, stdout: s });

  const full = (
    p: number,
    d: number,
    x = 0,
    e = 0,
    c = 2000,
  ) => `P=${p} D=${d} X=${x} E=${e} C=${c}\n`;

  describe("exit status decides whether stdout is trusted at all", () => {
    it("status 0 is parsed", () => {
      expect(out(full(0, 0)).state).toBe("ok");
    });

    it("a NON-zero status is unreachable even when stdout parses", () => {
      // Kills `r.status !== 0` → `=== 0`: under the mutant this record
      // parses to `backlog` with 7 pending.
      const r = out(full(7, 0), 125);
      expect(r.state).toBe("unreachable");
      expect(r.pending).toBe(0);
    });

    it("a null status (spawn timeout) is unreachable", () => {
      expect(out(full(7, 0), null).state).toBe("unreachable");
    });

    it("a spawn error is unreachable even at status 0", () => {
      expect(
        parsePendingRetainsProbeOutput({
          error: new Error("docker: not found"),
          status: 0,
          stdout: full(7, 0),
        }).state,
      ).toBe("unreachable");
    });

    it("unreachable carries zeroed counters and the default cap", () => {
      const r = out(full(9, 9, 9, 9, 17), 1);
      expect(r).toEqual({
        state: "unreachable",
        pending: 0,
        dead: 0,
        dropped: 0,
        evicted: 0,
        cap: 2000,
      });
    });

    it("unparsable stdout at status 0 is unreachable, not ok", () => {
      expect(out("sh: syntax error\n").state).toBe("unreachable");
      expect(out("P=3\n").state).toBe("unreachable"); // D= missing
    });
  });

  describe("state precedence", () => {
    it("an empty queue is ok", () => {
      expect(out(full(0, 0)).state).toBe("ok");
    });

    it("ONE dead marker is dead", () => {
      // Kills `dead > 0` → `>= 0` from the other side: paired with the
      // `ok` case above, no single comparison satisfies both.
      expect(out(full(0, 1)).state).toBe("dead");
    });

    it("ONE queued entry with no dead markers is backlog", () => {
      // Kills `pending > 0` → `>= 0` together with the `ok` case.
      expect(out(full(1, 0)).state).toBe("backlog");
    });

    it("dead wins over a live backlog", () => {
      expect(out(full(40, 2)).state).toBe("dead");
    });

    it("counters survive the classification", () => {
      expect(out(full(12, 3, 4, 5, 750))).toEqual({
        state: "dead",
        pending: 12,
        dead: 3,
        dropped: 4,
        evicted: 5,
        cap: 750,
      });
    });
  });

  describe("cap fallback", () => {
    it("a positive cap is taken verbatim", () => {
      expect(out(full(0, 0, 0, 0, 500)).cap).toBe(500);
    });

    it("C=0 falls back to the default, it is not a cap of zero", () => {
      // Kills `cap > 0` → `>= 0`. A cap of 0 makes every backlog read as
      // "at the eviction threshold".
      expect(out(full(3, 0, 0, 0, 0)).cap).toBe(2000);
      expect(out(full(3, 0, 0, 0, 0)).state).toBe("backlog");
    });

    it("C=1 is honoured — the fallback is for 0, not for 'small'", () => {
      expect(out(full(0, 0, 0, 0, 1)).cap).toBe(1);
    });
  });

  describe("older agent images", () => {
    // The forward-compat contract: an image emitting only P=/D= must read
    // as a real verdict, not as unreachable and not as a crash.
    it("absent X=/E=/C= read as zero and the default cap", () => {
      expect(out("P=2 D=0\n")).toEqual({
        state: "backlog",
        pending: 2,
        dead: 0,
        dropped: 0,
        evicted: 0,
        cap: 2000,
      });
    });
  });
});
