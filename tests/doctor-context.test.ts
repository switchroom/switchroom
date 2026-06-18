import { describe, it, expect } from "vitest";
import {
  contextRow,
  runContextChecks,
  type SnapshotRead,
  type ContextSnapshot,
} from "../src/cli/doctor-context.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

function cfg(p: Record<string, unknown>): SwitchroomConfig {
  return p as unknown as SwitchroomConfig;
}
function snap(s: Partial<ContextSnapshot>): SnapshotRead {
  return {
    kind: "ok",
    snapshot: {
      occupancy: 0,
      cap: 300000,
      headroom: 0,
      pct: 0,
      state: "ok",
      computedAt: 1,
      ...s,
    },
  };
}

describe("contextRow", () => {
  it("OK with occupancy/cap (%) when comfortably under the cap", () => {
    const r = contextRow("clerk", snap({ occupancy: 47000, cap: 300000, pct: 0.157, state: "ok" }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("47k/300k");
    expect(r.detail).toContain("16%");
  });

  it("WARNs (tight) with a fix when occupancy is near the cap", () => {
    const r = contextRow("marko", snap({ occupancy: 231000, cap: 300000, pct: 0.77, state: "tight" }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("tight");
    expect(r.detail).toContain("77%");
    expect(r.fix).toBeTruthy();
  });

  it("OK without a ratio when no cap is configured", () => {
    const r = contextRow("a", snap({ occupancy: 50000, cap: null, pct: null, state: "ok" }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no cap");
  });

  it("SKIPs (not a failure) when the snapshot is absent / unreadable / unknown", () => {
    expect(contextRow("a", { kind: "absent" }).status).toBe("skip");
    expect(contextRow("a", { kind: "unreadable", msg: "x" }).status).toBe("skip");
    expect(contextRow("a", snap({ state: "unknown" })).status).toBe("skip");
  });
});

describe("runContextChecks", () => {
  it("renders one row per agent, sorted, reading via the injected reader", async () => {
    const reads: Record<string, SnapshotRead> = {
      marko: snap({ occupancy: 231000, cap: 300000, pct: 0.77, state: "tight" }),
      clerk: snap({ occupancy: 47000, cap: 300000, pct: 0.157, state: "ok" }),
    };
    const res = await runContextChecks(
      cfg({ agents: { marko: {}, clerk: {} } }),
      { readSnapshot: async (a) => reads[a] ?? { kind: "absent" } },
    );
    expect(res.map((r) => r.name)).toEqual(["context:clerk", "context:marko"]);
    expect(res.find((r) => r.name === "context:marko")?.status).toBe("warn");
    expect(res.find((r) => r.name === "context:clerk")?.status).toBe("ok");
  });

  it("returns [] when there are no agents", async () => {
    expect(await runContextChecks(cfg({ agents: {} }))).toEqual([]);
  });

  it("default reader (no deps) → all skip (absent), never throws", async () => {
    const res = await runContextChecks(cfg({ agents: { a: {} } }));
    expect(res[0].status).toBe("skip");
  });
});
