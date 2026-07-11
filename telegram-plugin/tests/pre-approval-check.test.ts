/**
 * #2975 Stage 2 — gateway-side read-only pre-approval predicate.
 *
 * `isDiffPreApproved` is what the gateway answers a hostd `check_pre_approved`
 * query with. It MUST:
 *   - return true ONLY for a byte-exact registered (agent, diff) pair
 *     (mental-model proposal OR "🔁 Always allow" correlation);
 *   - be forge-resistant: a diff differing by ONE byte from the registered one
 *     is NOT pre-approved;
 *   - NEVER mutate the correlation store (the single-use auto-resolve delete
 *     stays on the real request_config_approval — a peek can't consume consent).
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  isDiffPreApproved,
  type PreApprovalCheckDeps,
} from "../gateway/pre-approval-check.js";

const AGENT = "klanker";
const MM_DIFF =
  "--- a/switchroom.yaml\n+++ b/switchroom.yaml\n@@ -1 +1,2 @@\n+  mental_models: [x]\n";
const ALLOW_RULE = "Bash";
const ALLOW_DIFF =
  "--- a/switchroom.yaml\n+++ b/switchroom.yaml\n@@ -1 +1,2 @@\n+      - Bash\n";

function mmKey(agent: string, diff: string): string {
  return `${agent}::${createHash("sha256").update(diff).digest("hex")}`;
}

/** A Map-backed store exposing only sweep()+get(), plus spies to prove no
 *  mutation happened (the ReadonlyCorrelationStore type has no delete/set, so
 *  a mutating edit wouldn't even typecheck — these spies double-check sweep). */
function makeStore(entries: Record<string, { unifiedDiff: string }>) {
  const map = new Map(Object.entries(entries));
  const sweep = vi.fn((_now: number) => {
    /* no expiry in these tests */
  });
  return {
    store: {
      sweep,
      get: (k: string) => map.get(k),
    },
    map,
    sweep,
  };
}

function makeDeps(overrides: {
  alwaysAllow?: Record<string, { unifiedDiff: string }>;
  mentalModel?: Record<string, { unifiedDiff: string }>;
}): {
  deps: PreApprovalCheckDeps;
  aaMap: Map<string, { unifiedDiff: string }>;
  mmMap: Map<string, { unifiedDiff: string }>;
} {
  const aa = makeStore(overrides.alwaysAllow ?? {});
  const mm = makeStore(overrides.mentalModel ?? {});
  const deps: PreApprovalCheckDeps = {
    alwaysAllow: aa.store,
    mentalModel: mm.store,
    // Only recognise the ALLOW_RULE token when it appears as an added line.
    extractAddedAllowRule: (diff) =>
      diff.includes(`+      - ${ALLOW_RULE}`) ? ALLOW_RULE : null,
    mentalModelCorrelationKey: mmKey,
  };
  return { deps, aaMap: aa.map, mmMap: mm.map };
}

describe("isDiffPreApproved — mental-model correlation", () => {
  it("true for a byte-exact registered (agent, diff) pair", () => {
    const { deps } = makeDeps({
      mentalModel: { [mmKey(AGENT, MM_DIFF)]: { unifiedDiff: MM_DIFF } },
    });
    expect(isDiffPreApproved(AGENT, MM_DIFF, deps)).toBe(true);
  });

  it("false (forge-resistant) for a diff differing by one byte", () => {
    const { deps } = makeDeps({
      mentalModel: { [mmKey(AGENT, MM_DIFF)]: { unifiedDiff: MM_DIFF } },
    });
    // The key is derived from the tampered diff → no entry at that key; and even
    // if an attacker could guess the key, the stored unifiedDiff wouldn't match.
    expect(isDiffPreApproved(AGENT, MM_DIFF + " ", deps)).toBe(false);
  });

  it("false for a matching diff under a DIFFERENT agent name", () => {
    const { deps } = makeDeps({
      mentalModel: { [mmKey(AGENT, MM_DIFF)]: { unifiedDiff: MM_DIFF } },
    });
    expect(isDiffPreApproved("someone-else", MM_DIFF, deps)).toBe(false);
  });

  it("false when nothing is registered", () => {
    const { deps } = makeDeps({});
    expect(isDiffPreApproved(AGENT, MM_DIFF, deps)).toBe(false);
  });
});

describe("isDiffPreApproved — always-allow correlation", () => {
  it("true for a byte-exact registered always-allow diff", () => {
    const { deps } = makeDeps({
      alwaysAllow: {
        [`${AGENT}::${ALLOW_RULE}`]: { unifiedDiff: ALLOW_DIFF },
      },
    });
    expect(isDiffPreApproved(AGENT, ALLOW_DIFF, deps)).toBe(true);
  });

  it("false when the added rule token matches but the diff bytes differ (forge)", () => {
    const { deps } = makeDeps({
      alwaysAllow: {
        [`${AGENT}::${ALLOW_RULE}`]: { unifiedDiff: ALLOW_DIFF },
      },
    });
    // Same rule token, but the diff smuggles an extra byte → byte-match fails.
    expect(isDiffPreApproved(AGENT, ALLOW_DIFF + "\n", deps)).toBe(false);
  });
});

describe("isDiffPreApproved — read-only invariant", () => {
  it("never mutates either correlation store on a match", () => {
    const { deps, mmMap } = makeDeps({
      mentalModel: { [mmKey(AGENT, MM_DIFF)]: { unifiedDiff: MM_DIFF } },
    });
    const sizeBefore = mmMap.size;
    expect(isDiffPreApproved(AGENT, MM_DIFF, deps)).toBe(true);
    // The matched correlation is STILL present — a peek cannot consume the
    // single-use consent the real request_config_approval will spend later.
    expect(mmMap.size).toBe(sizeBefore);
    expect(mmMap.has(mmKey(AGENT, MM_DIFF))).toBe(true);
    // A second identical query still answers true (idempotent, no consumption).
    expect(isDiffPreApproved(AGENT, MM_DIFF, deps)).toBe(true);
  });

  it("never mutates the store on a miss", () => {
    const { deps, aaMap, mmMap } = makeDeps({
      alwaysAllow: {
        [`${AGENT}::${ALLOW_RULE}`]: { unifiedDiff: ALLOW_DIFF },
      },
      mentalModel: { [mmKey(AGENT, MM_DIFF)]: { unifiedDiff: MM_DIFF } },
    });
    expect(isDiffPreApproved(AGENT, "totally-unrelated-diff", deps)).toBe(false);
    expect(aaMap.size).toBe(1);
    expect(mmMap.size).toBe(1);
  });
});
