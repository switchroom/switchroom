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
import { describe, it, expect } from "vitest";
import {
  ownedWorktreeCwds,
  type WorktreeOwnershipRecord,
} from "../worktree-watch-cwds.js";

const idPath = (p: string) => p; // identity realpath for deterministic tests

describe("ownedWorktreeCwds", () => {
  const records: WorktreeOwnershipRecord[] = [
    { path: "/wt/mine-1", ownerAgent: "klanker" },
    { path: "/wt/mine-2", ownerAgent: "klanker" },
    { path: "/wt/theirs", ownerAgent: "reggie" },
    { path: "/wt/ownerless" }, // ownerAgent undefined
  ];

  it("returns NOTHING when the agent identity is unset (fail-closed, no #1116 leak)", () => {
    expect(
      ownedWorktreeCwds({ self: undefined, listRecords: () => records, realpath: idPath }),
    ).toEqual([]);
  });

  it("returns NOTHING when the agent identity is empty string", () => {
    expect(
      ownedWorktreeCwds({ self: "", listRecords: () => records, realpath: idPath }),
    ).toEqual([]);
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
