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

import { describe, expect, it } from "vitest";

import {
  checkPendingRetainsQueues,
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
