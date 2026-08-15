/**
 * Widened task-tree discovery — the 2026-08 fleet disk incident.
 *
 * The root disk hit 85% full with 41 stale git checkouts scattered across
 * agent homes. `defaultTaskTreeRoots()` scanned exactly two subdirectories per
 * agent (`home/work`, `home/workspace`) and therefore missed almost all of
 * them. The classifier was never broken — it was aimed at a convention nobody
 * follows.
 *
 * The fixture below is the REAL layout observed in that incident (dot
 * directories, nested `repo/` children, a checkout outside `home/` entirely,
 * plus a reference clone that the manual sweep deliberately preserved). The
 * assertions are outcomes: which directories the scanner returns and which
 * verdict the planner reaches — not which code path ran.
 *
 * These tests fail on unmodified `gc.ts`: `discoverAgentCheckouts` does not
 * exist there, and the root-based scan cannot reach any of the dot-directory
 * or outside-`home/` litter no matter how it is invoked.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAgentCheckouts,
  isPrunedDiscoveryDir,
  planGc,
  classifyTaskTree,
  isReferenceCheckoutBranch,
  allocateTrashDest,
  KEEP_MARKER,
  type GcDeps,
  type TaskTreeClassifyInput,
} from "../src/worktree/gc.js";

// ── fixture: the real incident layout ───────────────────────────────────────

/** Checkout paths, relative to `<agentsDir>`, exactly as found on the fleet. */
const LITTER = [
  "klanker/home/sr-4638", //              direct child of home/, ad-hoc name
  "klanker/home/srwork",
  "klanker/home/review-4432-klanker",
  "klanker/home/wt-benchdrop-647877",
  "klanker/home/tmp-build/switchroom", // nested one level deeper
  "klanker/home/voiceout-work/switchroom",
  "overlord/home/r5repro2",
  "overlord/home/sr-secreview",
  "overlord/.work4481/repo", //           DOT dir, outside home/ entirely
  "overlord/worktrees/b3-overlay-eacces", // sibling of home/, not under it
  "overlord/home/.cache/sr-review", //    inside a DOT directory
  "overlord/home/ovl-changelog-fix/repo",
  "overlord/home/wt-vault-4486",
  "gymbro/scratchwork/switchroom", //     outside home/
  "carrie/home/switchroom-work",
  "clerk/home/switchroom-pr",
  // the two roots the pre-incident scanner did cover — must not regress
  "klanker/home/work/fix-3333",
  "klanker/home/workspace/sr-2771",
];

/** Checkouts that must be SPARED. */
const PRECIOUS = [
  "overlord/home/switchroom-clone", // reference clone (manual sweep kept it)
  "carrie/home/ProductOS", //          a real project repo the agent owns
  "overlord/workspace", //             the agent's own host-side workspace
  "overlord/home/workspace", //        the agent's own workspace dir
  "overlord/work/switchroom", //       the STABLE per-repo tree
];

/** Directories that exist but are NOT checkouts (walked through, never emitted). */
const NOISE_DIRS = [
  "overlord/home/.cache/uv/sdists-v9/editable/pkg", // pruned by name (`uv`)
  "overlord/home/node_modules/left-pad", //           pruned by name
  "klanker/home/work/fix-3333/node_modules/react", // inside a checkout
  "klanker/home/work/fix-3333/.git/worktrees/x", //   .git internals
  "overlord/home/a/b/c/d/e/f/deep-checkout", //       past the depth cap
  "klanker/tmp/sr-a4b-xyz/a4b/workspace", //          the tmp reaper owns tmp/
  "overlord/home/mirrors/switchroom.git/worktrees/w", // bare-repo admin dir
];

let AGENTS: string;

function mkCheckout(rel: string, gitIsDir = true) {
  const dir = join(AGENTS, rel);
  mkdirSync(dir, { recursive: true });
  if (gitIsDir) mkdirSync(join(dir, ".git"), { recursive: true });
  else writeFileSync(join(dir, ".git"), "gitdir: /owner/.git/worktrees/x\n");
}

beforeAll(() => {
  AGENTS = mkdtempSync(join(tmpdir(), "gc-discovery-"));
  for (const rel of LITTER) mkCheckout(rel, !rel.includes("wt-"));
  for (const rel of PRECIOUS) mkCheckout(rel);
  for (const rel of NOISE_DIRS) mkCheckout(rel);
  mkCheckout("overlord/home/a/b/c/d/e/f/deep-checkout");
  // a symlink loop — the walk must not follow it and must not hang
  mkdirSync(join(AGENTS, "klanker/home/loopsrc"), { recursive: true });
  try {
    symlinkSync(join(AGENTS, "klanker"), join(AGENTS, "klanker/home/loopsrc/back"));
  } catch {
    /* platforms without symlink perms — the rest of the fixture still holds */
  }
});

afterAll(() => {
  rmSync(AGENTS, { recursive: true, force: true });
});

const relOf = (abs: string) => abs.slice(AGENTS.length + 1);

describe("discoverAgentCheckouts — finds the incident litter", () => {
  it("finds EVERY stale checkout from the real incident layout", () => {
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    for (const rel of LITTER) expect(found).toContain(rel);
  });

  it("finds the litter the two blessed roots structurally could not reach", () => {
    // This is the regression that caused the incident: every one of these sits
    // outside `home/work` and `home/workspace`, so NO invocation of the
    // root-based scanner can produce them.
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    expect(found).toContain("overlord/.work4481/repo"); //          dot dir, outside home/
    expect(found).toContain("overlord/home/.cache/sr-review"); //   inside a dot dir
    expect(found).toContain("gymbro/scratchwork/switchroom"); //    outside home/
    expect(found).toContain("overlord/worktrees/b3-overlay-eacces");
    expect(found).toContain("klanker/home/sr-4638"); //             direct child of home/
    expect(found).toContain("overlord/home/ovl-changelog-fix/repo"); // nested repo/ child
  });

  it("does not regress the pre-existing home/work + home/workspace coverage", () => {
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    expect(found).toContain("klanker/home/work/fix-3333");
    expect(found).toContain("klanker/home/workspace/sr-2771");
  });
});

describe("discoverAgentCheckouts — spares what must be spared", () => {
  it("never emits the agent's own durable furniture", () => {
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    // `<agent>/workspace` and `<agent>/home/workspace` are the agent's own
    // workspace; `<agent>/work/<slug>` is the STABLE per-repo tree.
    expect(found).not.toContain("overlord/workspace");
    expect(found).not.toContain("overlord/home/workspace");
    expect(found).not.toContain("overlord/work/switchroom");
    expect(found).not.toContain("overlord/work");
    expect(found).not.toContain("overlord/home");
    expect(found).not.toContain("overlord");
  });

  it("stops at a checkout boundary — nested node_modules and .git are never candidates", () => {
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    for (const f of found) {
      expect(f).not.toContain("/node_modules");
      expect(f).not.toContain("/.git/");
      expect(f.endsWith("/.git")).toBe(false);
    }
  });

  it("prunes package-manager caches by name and honours the depth cap", () => {
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    expect(found.some((f) => f.includes("/uv/"))).toBe(false);
    // depth 7 below the agent dir, past the default cap of 4
    expect(found).not.toContain("overlord/home/a/b/c/d/e/f/deep-checkout");
    // ...and IS found once the cap is lifted, proving the cap is what excluded it
    const deep = discoverAgentCheckouts(AGENTS, { maxDepth: 8 }).map(relOf);
    expect(deep).toContain("overlord/home/a/b/c/d/e/f/deep-checkout");
  });

  it("leaves <agent>/tmp to the separate tmp reaper", () => {
    // `klanker/tmp/...` is pruned; `klanker/home/tmp-build/switchroom` is NOT
    // — the prune is the exact name, not a prefix.
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    expect(found.some((f) => f.startsWith("klanker/tmp/"))).toBe(false);
    expect(found).toContain("klanker/home/tmp-build/switchroom");
  });

  it("never descends a bare repo's internal worktrees/ admin dir", () => {
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    expect(found.some((f) => f.includes(".git/"))).toBe(false);
    expect(isPrunedDiscoveryDir("switchroom.git")).toBe(true);
    expect(isPrunedDiscoveryDir("tmp")).toBe(true);
    expect(isPrunedDiscoveryDir("tmp-build")).toBe(false);
  });

  it("does not follow symlinks (a loop terminates)", () => {
    const found = discoverAgentCheckouts(AGENTS).map(relOf);
    expect(found.some((f) => f.includes("loopsrc/back"))).toBe(false);
  });

  it("honours the visit budget instead of walking unbounded", () => {
    const budgeted = discoverAgentCheckouts(AGENTS, { maxVisits: 5 });
    const full = discoverAgentCheckouts(AGENTS);
    expect(budgeted.length).toBeLessThan(full.length);
  });
});

// ── planGc integration: discovered dirs go through the FULL guard gauntlet ──
//
// Uses INJECTED deps over synthetic absolute paths rather than the on-disk
// fixture: `isEphemeralPath` (gc.ts) refuses `/tmp`, `/state` and `/host`
// outright, so a real temp-dir fixture would be skipped before any classifier
// ran. The paths mirror the incident layout exactly.

describe("planGc — discovered candidates are classified, precious ones spared", () => {
  const NOW = 1_700_000_000_000;
  const SR = "https://github.com/switchroom/switchroom.git\n";
  const A = "/agents";

  const DISCOVERED = [
    `${A}/overlord/.work4481/repo`,
    `${A}/overlord/home/.cache/sr-review`,
    `${A}/overlord/home/ovl-changelog-fix/repo`,
    `${A}/overlord/worktrees/b3-overlay-eacces`,
    `${A}/gymbro/scratchwork/switchroom`,
    `${A}/klanker/home/tmp-build/switchroom`,
    `${A}/klanker/home/voiceout-work/switchroom`,
    `${A}/klanker/home/sr-4638`,
    `${A}/klanker/home/work/fix-3333`,
    `${A}/overlord/home/switchroom-clone`,
    `${A}/carrie/home/ProductOS`,
  ];
  const LITTER_DIRS = DISCOVERED.slice(0, 9);

  interface Over {
    remote?: string;
    branch?: string;
    keep?: boolean;
  }

  function deps(overrides: Record<string, Over> = {}): GcDeps {
    return {
      dateStamp: "2026-08-15",
      idleDays: 14,
      nowMs: NOW,
      probeInUse: () => "free",
      newestTrackedMtimeMs: () => NOW - 60 * 86_400_000,
      existsSync: (p: string) => {
        if (p.endsWith(`/${KEEP_MARKER}`)) {
          return overrides[p.slice(0, -(KEEP_MARKER.length + 1))]?.keep === true;
        }
        if (p.endsWith("/.git")) return DISCOVERED.includes(p.slice(0, -5));
        return DISCOVERED.includes(p);
      },
      readDir: (p: string) => {
        throw new Error("unexpected readDir " + p);
      },
      stat: () => ({ isDirectory: () => true }), // every fixture tree is a clone
      exec: (_file: string, args: string[]) => {
        const dir = args[args.indexOf("-C") + 1]!;
        const o = overrides[dir] ?? {};
        if (args.includes("remote")) return o.remote ?? SR;
        if (args.includes("status")) return "";
        if (args.includes("@{upstream}")) return "origin/x\n";
        if (args.includes("rev-list")) return "0\n";
        if (args.includes("rev-parse")) return `${o.branch ?? "feat/x"}\n`;
        throw new Error("unexpected exec " + args.join(" "));
      },
      prSignal: () => "merged",
    };
  }

  const byDir = (overrides: Record<string, Over> = {}, roots: string[] = []) => {
    const plan = planGc([], deps(overrides), roots, DISCOVERED);
    return { plan, trees: new Map(plan.taskTrees.map((t) => [t.dir, t])) };
  };

  it("reaps the dot-directory litter the old roots could not see", () => {
    const { trees } = byDir();
    for (const dir of LITTER_DIRS) {
      expect(trees.get(dir)?.verdict, dir).toBe("reap");
      expect(trees.get(dir)?.willAct, dir).toBe(true);
    }
  });

  it("spares a project repo the agent owns — its origin is not switchroom's", () => {
    const dir = `${A}/carrie/home/ProductOS`;
    const { plan, trees } = byDir({ [dir]: { remote: "git@github.com:acme/ProductOS.git\n" } });
    expect(trees.has(dir)).toBe(false);
    expect(plan.skipped.find((s) => s.dir === dir)?.kind).toBe("not-ours");
  });

  it("spares a reference clone carrying the .switchroom-keep marker", () => {
    const dir = `${A}/overlord/home/switchroom-clone`;
    const { trees } = byDir({ [dir]: { branch: "review-merge", keep: true } });
    expect(trees.get(dir)?.verdict).toBe("skip-protected");
    expect(trees.get(dir)?.willAct).toBe(false);
  });

  it("spares a reference clone parked on trunk, without spending a gh probe on it", () => {
    const dir = `${A}/overlord/home/switchroom-clone`;
    const probed: string[] = [];
    const plan = planGc(
      [],
      { ...deps({ [dir]: { branch: "main" } }), prSignal: (r: string) => (probed.push(r), "merged") },
      [],
      DISCOVERED,
    );
    const t = plan.taskTrees.find((x) => x.dir === dir);
    expect(t?.verdict).toBe("skip-protected");
    expect(t?.willAct).toBe(false);
    expect(probed).not.toContain(dir);
    expect(plan.taskTrees.filter((x) => x.willAct).length).toBeGreaterThan(0);
  });

  it("de-duplicates a directory reachable via BOTH a blessed root and discovery", () => {
    const root = `${A}/klanker/home/work`;
    const plan = planGc(
      [],
      {
        ...deps(),
        existsSync: (p: string) =>
          p === root ||
          (p.endsWith(`/${KEEP_MARKER}`)
            ? false
            : p.endsWith("/.git")
              ? DISCOVERED.includes(p.slice(0, -5))
              : DISCOVERED.includes(p)),
        readDir: (p: string) => (p === root ? ["fix-3333"] : []),
      },
      [root],
      DISCOVERED,
    );
    expect(plan.taskTrees.filter((t) => t.dir === `${root}/fix-3333`).length).toBe(1);
  });

  it("gives every quarantined tree a DISTINCT destination", () => {
    const { plan } = byDir();
    const acting = plan.taskTrees.filter((t) => t.willAct);
    // the layout alone carries three `switchroom` and two `repo` basenames
    expect(acting.length).toBeGreaterThan(3);
    const dests = acting.map((t) => t.dest);
    expect(new Set(dests).size).toBe(dests.length);
  });

  it("records the discovered candidates on the plan", () => {
    const { plan } = byDir();
    expect(plan.taskTreeDirs).toEqual(DISCOVERED);
  });
});

// ── pure guards ─────────────────────────────────────────────────────────────

describe("precious-vs-disposable guards (pure)", () => {
  const base: TaskTreeClassifyInput = {
    isRegistryClaimed: false,
    isStablePerRepoTree: false,
    isEphemeralPath: false,
    clean: true,
    pushed: "pushed",
    prSignal: "merged",
    idle: true,
    inUse: "free",
  };

  it("an otherwise-reapable tree IS reaped (the guards are not blanket)", () => {
    expect(classifyTaskTree(base)).toBe("reap");
  });

  it("a trunk-branch checkout is protected", () => {
    expect(classifyTaskTree({ ...base, isReferenceCheckout: true })).toBe("skip-protected");
    for (const b of ["main", "master", "trunk", "develop"]) {
      expect(isReferenceCheckoutBranch(b), b).toBe(true);
    }
    for (const b of ["feat/x", "fix/4638", "review-merge", null]) {
      expect(isReferenceCheckoutBranch(b), String(b)).toBe(false);
    }
  });

  it("a .switchroom-keep marked tree is protected", () => {
    expect(classifyTaskTree({ ...base, isKeepMarked: true })).toBe("skip-protected");
  });

  it("allocateTrashDest never collides on equal basenames", () => {
    const used = new Set<string>();
    const a = allocateTrashDest("/trash", "/agents/x/home/w1/repo", used);
    const b = allocateTrashDest("/trash", "/agents/y/home/w2/repo", used);
    expect(a).toBe("/trash/repo");
    expect(b).not.toBe(a);
    // stable across runs
    expect(allocateTrashDest("/trash", "/agents/y/home/w2/repo", new Set(["repo"]))).toBe(b);
  });
});
