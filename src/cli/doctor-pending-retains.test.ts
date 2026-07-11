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
    states[name] ?? { state: "unreachable", pending: 0, dead: 0 };
}

const ok = (): PendingRetainsProbeResult => ({ state: "ok", pending: 0, dead: 0 });
const backlog = (n: number): PendingRetainsProbeResult => ({
  state: "backlog",
  pending: n,
  dead: 0,
});
const dead = (d: number, p = 0): PendingRetainsProbeResult => ({
  state: "dead",
  pending: p,
  dead: d,
});
const down = (): PendingRetainsProbeResult => ({
  state: "unreachable",
  pending: 0,
  dead: 0,
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
    expect(r.detail).toContain("next SessionStart");
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

  it("fail: a queue at the cap is a distinct, dropping-failures signal", () => {
    const r = checkPendingRetainsQueues(cfg(["clerk"]), {
      probe: probeFrom({ clerk: backlog(1000) }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("at cap of 1000");
    expect(r.detail).toContain("clerk (1000)");
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
