/**
 * Ownership predicate for the worktree-isolated cwds the subagent-watcher
 * additionally watches (deterministic-turn-liveness.md Known Gap 2 / #2893
 * review fix). Pins the fail-CLOSED behaviour: the review found the closure
 * both FAILED OPEN (unset identity matched every ownerless record — the #1116
 * leak reintroduced) and FAILED CLOSED (a plain `worktree claim` produced an
 * ownerless record filtered out, so the sub-agent stayed invisible — Gap 2).
 *
 * Run with:
 *   bun test telegram-plugin/tests/worktree-watch-cwds.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  ownedWorktreeCwds,
  refreshOwnedWorktreeHeartbeats,
  __resetIdentityEscalationForTests,
  type WorktreeOwnershipRecord,
  type WorktreeHeartbeatRecord,
} from "../worktree-watch-cwds.js";

const idPath = (p: string) => p; // identity realpath for deterministic tests

beforeEach(() => __resetIdentityEscalationForTests());

describe("ownedWorktreeCwds", () => {
  const records: WorktreeOwnershipRecord[] = [
    { path: "/wt/mine-1", ownerAgent: "klanker" },
    { path: "/wt/mine-2", ownerAgent: "klanker" },
    { path: "/wt/theirs", ownerAgent: "reggie" },
    { path: "/wt/ownerless" }, // ownerAgent undefined
  ];

  it("returns NOTHING when the agent identity is unset and no durable fallback given (fail-closed, no #1116 leak)", () => {
    expect(
      ownedWorktreeCwds({ self: undefined, listRecords: () => records, realpath: idPath }),
    ).toEqual([]);
  });

  it("returns NOTHING when the agent identity is empty string and no durable fallback given", () => {
    expect(
      ownedWorktreeCwds({ self: "", listRecords: () => records, realpath: idPath }),
    ).toEqual([]);
  });

  // ---- Layer 2: durable, non-env identity fallback (#1116 / #2893) ----

  it("(a) env SET → ownership resolves exactly as before (fast path unchanged)", () => {
    expect(
      ownedWorktreeCwds({
        self: "klanker",
        agentDir: "/home/x/.switchroom/agents/SHOULD_BE_IGNORED",
        listRecords: () => records,
        realpath: idPath,
      }),
    ).toEqual(["/wt/mine-1", "/wt/mine-2"]);
  });

  it("(b) env UNSET but agentDir present → identity derived from dir basename, ownership resolves", () => {
    const out = ownedWorktreeCwds({
      self: undefined,
      agentDir: "/home/x/.switchroom/agents/klanker",
      listRecords: () => records,
      realpath: idPath,
    });
    expect(out).toEqual(["/wt/mine-1", "/wt/mine-2"]);
  });

  it("(b) env EMPTY but agentDir present → same durable derivation", () => {
    const out = ownedWorktreeCwds({
      self: "",
      agentDir: "/home/x/.switchroom/agents/klanker",
      listRecords: () => records,
      realpath: idPath,
    });
    expect(out).toEqual(["/wt/mine-1", "/wt/mine-2"]);
  });

  it("(b) durable fallback NEVER mis-attributes: a dir for a different agent matches only THAT agent's records, never klanker's", () => {
    // agentDir names 'reggie' → resolves reggie's worktrees, never klanker's
    // or the ownerless ones. A wrong basename fails-closed to [], it can never
    // attribute to the WRONG owner.
    const out = ownedWorktreeCwds({
      self: undefined,
      agentDir: "/home/x/.switchroom/agents/reggie",
      listRecords: () => records,
      realpath: idPath,
    });
    expect(out).toEqual(["/wt/theirs"]);
    expect(out).not.toContain("/wt/ownerless");
  });

  it("(c) BOTH env and agentDir unavailable → returns [] AND emits an escalated ERROR (no throw, no mis-attribution)", () => {
    const logs: string[] = [];
    const out = ownedWorktreeCwds({
      self: undefined,
      agentDir: undefined,
      listRecords: () => records,
      realpath: idPath,
      log: (m) => logs.push(m),
    });
    expect(out).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("ERROR");
    expect(logs[0]).toContain("identity resolution FAILED");
  });

  it("(c) blank agentDir (whitespace) is treated as unavailable → [] + escalated error", () => {
    const logs: string[] = [];
    const out = ownedWorktreeCwds({
      self: "",
      agentDir: "   ",
      listRecords: () => records,
      realpath: idPath,
      log: (m) => logs.push(m),
    });
    expect(out).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("identity resolution FAILED");
  });

  it("(c) the escalated error is one-shot per process (not re-logged every rescan tick)", () => {
    const logs: string[] = [];
    const call = () =>
      ownedWorktreeCwds({
        self: undefined,
        agentDir: undefined,
        listRecords: () => records,
        realpath: idPath,
        log: (m) => logs.push(m),
      });
    call();
    call();
    call();
    expect(logs).toHaveLength(1);
  });

  it("does NOT match ownerless records even when identity is set", () => {
    const out = ownedWorktreeCwds({ self: "klanker", listRecords: () => records, realpath: idPath });
    expect(out).not.toContain("/wt/ownerless");
    expect(out).not.toContain("/wt/theirs");
  });

  it("includes exactly the records this agent owns", () => {
    expect(
      ownedWorktreeCwds({ self: "klanker", listRecords: () => records, realpath: idPath }),
    ).toEqual(["/wt/mine-1", "/wt/mine-2"]);
  });

  it("returns [] when the registry read throws (best-effort; base watch undisturbed)", () => {
    expect(
      ownedWorktreeCwds({
        self: "klanker",
        listRecords: () => {
          throw new Error("registry unavailable");
        },
        realpath: idPath,
      }),
    ).toEqual([]);
  });

  it("realpaths owned paths (symlinked-base slug fix), falling back on failure", () => {
    const out = ownedWorktreeCwds({
      self: "klanker",
      listRecords: () => [
        { path: "/tmp/mine", ownerAgent: "klanker" },
        { path: "/gone/mine", ownerAgent: "klanker" },
      ],
      realpath: (p) => {
        if (p === "/tmp/mine") return "/private/tmp/mine";
        throw new Error("ENOENT");
      },
    });
    expect(out).toEqual(["/private/tmp/mine", "/gone/mine"]);
  });

  it("two-tick mutation: a fresh claim/release is picked up without restart", () => {
    // The provider is re-invoked every rescan tick, so a mutating registry
    // (claim adds an owned record; release removes it) must be reflected
    // tick-over-tick with no process restart.
    let live: WorktreeOwnershipRecord[] = [{ path: "/wt/a", ownerAgent: "klanker" }];
    const provider = () =>
      ownedWorktreeCwds({ self: "klanker", listRecords: () => live, realpath: idPath });

    // Tick 1: one owned worktree.
    expect(provider()).toEqual(["/wt/a"]);

    // Claim a second (as the ambient owner would default via SWITCHROOM_AGENT_NAME).
    live = [
      { path: "/wt/a", ownerAgent: "klanker" },
      { path: "/wt/b", ownerAgent: "klanker" },
    ];
    // Tick 2: both picked up, no restart.
    expect(provider()).toEqual(["/wt/a", "/wt/b"]);

    // Release the first.
    live = [{ path: "/wt/b", ownerAgent: "klanker" }];
    // Tick 3: reflects the release.
    expect(provider()).toEqual(["/wt/b"]);
  });
});

describe("refreshOwnedWorktreeHeartbeats", () => {
  const records: WorktreeHeartbeatRecord[] = [
    { id: "mine-1", ownerAgent: "klanker" },
    { id: "mine-2", ownerAgent: "klanker" },
    { id: "theirs", ownerAgent: "reggie" },
    { id: "ownerless" }, // ownerAgent undefined
  ];

  it("touches ONLY this agent's records, never ownerless or foreign ones", () => {
    const touched: string[] = [];
    const n = refreshOwnedWorktreeHeartbeats({
      self: "klanker",
      listRecords: () => records,
      touchHeartbeat: (id) => touched.push(id),
      minRefreshIntervalMs: 0, // always touch
    });
    expect(touched.sort()).toEqual(["mine-1", "mine-2"]);
    expect(touched).not.toContain("theirs");
    expect(touched).not.toContain("ownerless");
    expect(n).toBe(2);
  });

  it("fail-closed: unresolved identity touches NOTHING (no #1116 leak)", () => {
    const touched: string[] = [];
    const n = refreshOwnedWorktreeHeartbeats({
      self: undefined,
      listRecords: () => records,
      touchHeartbeat: (id) => touched.push(id),
      minRefreshIntervalMs: 0,
    });
    expect(touched).toEqual([]);
    expect(n).toBe(0);
  });

  it("resolves identity from agentDir when env is unset (durable fallback)", () => {
    const touched: string[] = [];
    refreshOwnedWorktreeHeartbeats({
      self: undefined,
      agentDir: "/home/x/.switchroom/agents/klanker",
      listRecords: () => records,
      touchHeartbeat: (id) => touched.push(id),
      minRefreshIntervalMs: 0,
    });
    expect(touched.sort()).toEqual(["mine-1", "mine-2"]);
  });

  it("throttles: skips a record whose heartbeat is younger than the interval", () => {
    const now = 1_000_000;
    const fresh = new Date(now - 30_000).toISOString(); // 30s ago
    const aged = new Date(now - 5 * 60_000).toISOString(); // 5min ago
    const touched: string[] = [];
    refreshOwnedWorktreeHeartbeats({
      self: "klanker",
      listRecords: () => [
        { id: "fresh", ownerAgent: "klanker", heartbeatAt: fresh },
        { id: "aged", ownerAgent: "klanker", heartbeatAt: aged },
      ],
      touchHeartbeat: (id) => touched.push(id),
      minRefreshIntervalMs: 2 * 60_000, // 2 min
      now: () => now,
    });
    // Only the aged one crosses the throttle window.
    expect(touched).toEqual(["aged"]);
  });

  it("a registry read failure is swallowed (never throws on the hot loop)", () => {
    expect(() =>
      refreshOwnedWorktreeHeartbeats({
        self: "klanker",
        listRecords: () => {
          throw new Error("registry gone");
        },
        touchHeartbeat: () => {},
      }),
    ).not.toThrow();
  });

  it("a per-record touch failure does not abort the remaining records", () => {
    const touched: string[] = [];
    const n = refreshOwnedWorktreeHeartbeats({
      self: "klanker",
      listRecords: () => records,
      touchHeartbeat: (id) => {
        if (id === "mine-1") throw new Error("write failed");
        touched.push(id);
      },
      minRefreshIntervalMs: 0,
    });
    // mine-2 still touched despite mine-1 throwing.
    expect(touched).toEqual(["mine-2"]);
    expect(n).toBe(1);
  });
});
