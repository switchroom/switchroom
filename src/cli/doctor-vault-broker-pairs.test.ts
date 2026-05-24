/**
 * Tests for `checkVaultBrokerSocketPairs` — the operational regression
 * guard for the per-agent unlock socket pair (PR #1721 follow-on).
 *
 * The original bug class: `bindAgentSocket()` bound only the data
 * socket, never the paired unlock socket — so the documented
 * Telegram `/vault unlock` flow failed `ENOENT` on every agent.
 * PR #1721 fixed `bindAgentSocket()`; this probe catches it again
 * if the volume-mount layout, the broker image, or `switchroom apply`
 * ever drifts a half-bound state back into the fleet.
 *
 * We inject the per-agent probe so the test exercises only the
 * aggregation + verdict shape — the real `probeVaultBrokerSocketPair`
 * is exercised by the live broker container, not in unit tests.
 */

import { describe, expect, it } from "vitest";

import {
  checkVaultBrokerSocketPairs,
  type PerAgentSocketPairState,
} from "./doctor.js";
import type { SwitchroomConfig } from "../config/schema.js";

function cfg(agentNames: string[]): SwitchroomConfig {
  const agents: Record<string, unknown> = {};
  for (const n of agentNames) agents[n] = {};
  return { agents } as unknown as SwitchroomConfig;
}

function probeFrom(
  states: Record<string, PerAgentSocketPairState>,
): (name: string) => PerAgentSocketPairState {
  return (name: string) => states[name] ?? "unreachable";
}

describe("checkVaultBrokerSocketPairs", () => {
  it("ok: all agents have both sockets bound", () => {
    const r = checkVaultBrokerSocketPairs(cfg(["clerk", "ziggy", "carrie"]), {
      probe: probeFrom({ clerk: "ok", ziggy: "ok", carrie: "ok" }),
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("3/3");
  });

  it("fail: one agent missing unlock half — the precise pre-fix bug class", () => {
    const r = checkVaultBrokerSocketPairs(cfg(["clerk", "ziggy"]), {
      probe: probeFrom({ clerk: "ok", ziggy: "missing-unlock" }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("1/2");
    expect(r.detail).toContain("unlock missing: ziggy");
    // Operator-facing diagnostic must name the symptom they'll see.
    expect(r.detail).toContain("ENOENT");
    expect(r.fix).toContain("#1721");
  });

  it("fail: missing unlock on multiple agents — names listed in stable order", () => {
    const r = checkVaultBrokerSocketPairs(cfg(["zeta", "alpha", "mike"]), {
      probe: probeFrom({
        zeta: "missing-unlock",
        alpha: "missing-unlock",
        mike: "ok",
      }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("unlock missing: alpha, zeta");
  });

  it("fail: missing data half (different bug class — broker bound nothing)", () => {
    const r = checkVaultBrokerSocketPairs(cfg(["clerk"]), {
      probe: probeFrom({ clerk: "missing-data" }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("data missing: clerk");
  });

  it("fail: missing both — compose mount not present at all", () => {
    const r = checkVaultBrokerSocketPairs(cfg(["clerk"]), {
      probe: probeFrom({ clerk: "missing-both" }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("both missing: clerk");
  });

  it("skip: all agents unreachable — broker container itself is down", () => {
    const r = checkVaultBrokerSocketPairs(cfg(["clerk", "ziggy"]), {
      probe: probeFrom({ clerk: "unreachable", ziggy: "unreachable" }),
    });
    // Don't N-row spam an operator when the broker is just down.
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("unreachable");
  });

  it("fail: partial unreachable (mid-restart) does NOT collapse to skip", () => {
    // If only some agents probe as unreachable while others are healthy,
    // that's a real divergence the operator needs to see — not the
    // "broker is down" blanket skip.
    const r = checkVaultBrokerSocketPairs(cfg(["clerk", "ziggy"]), {
      probe: probeFrom({ clerk: "ok", ziggy: "unreachable" }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("unreachable: ziggy");
  });

  it("ok: empty fleet (no agents declared)", () => {
    const r = checkVaultBrokerSocketPairs(cfg([]), { probe: () => "ok" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no agents configured");
  });

  it("groups the diagnostic so each bug class is surfaced once", () => {
    const r = checkVaultBrokerSocketPairs(
      cfg(["a", "b", "c", "d", "e"]),
      {
        probe: probeFrom({
          a: "ok",
          b: "missing-unlock",
          c: "missing-data",
          d: "missing-both",
          e: "missing-unlock",
        }),
      },
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("1/5");
    expect(r.detail).toContain("unlock missing: b, e");
    expect(r.detail).toContain("data missing: c");
    expect(r.detail).toContain("both missing: d");
  });
});
