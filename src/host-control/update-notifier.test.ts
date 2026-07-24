// KEN-129 — update-check drift notifier: one card per release id,
// fleet-lock respect, dispatch-failure retry, approve → update_apply.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateNotifier,
  short,
  type UpdateNotifierOptions,
} from "./update-notifier.js";
import type { ApprovalResult } from "./approval-gateway.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "update-notifier-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  notifier: UpdateNotifier;
  cards: { requestId: string; version: string; plan: string }[];
  applies: string[];
  finalizes: { outcome: string; detail?: string }[];
  statePath: string;
}

function makeHarness(over: {
  verdict?: ApprovalResult["verdict"];
  denySource?: "operator" | "dispatch_failure";
  locked?: () => boolean;
  startResult?: { result: string; error?: string };
  plan?: () => Promise<string>;
  // Per-call verdict override: sequence of results, last repeats.
  verdicts?: Partial<ApprovalResult>[];
} = {}): Harness {
  const statePath = join(dir, "state.json");
  const cards: Harness["cards"] = [];
  const applies: string[] = [];
  const finalizes: Harness["finalizes"] = [];
  let call = 0;
  const opts: UpdateNotifierOptions = {
    statePath,
    isFleetMutationInFlight: over.locked ?? (() => false),
    ...(over.plan ? { planFn: over.plan } : {}),
    requestApproval: async (args) => {
      cards.push(args);
      const seq = over.verdicts;
      const pick = seq ? seq[Math.min(call, seq.length - 1)] : undefined;
      call++;
      return {
        verdict: over.verdict ?? "approve",
        ...(over.denySource ? { denySource: over.denySource } : {}),
        ...pick,
        finalize: async (o) => {
          finalizes.push({ outcome: o.outcome, ...(o.detail ? { detail: o.detail } : {}) });
        },
      } as ApprovalResult;
    },
    startApply: (requestId) => {
      applies.push(requestId);
      return over.startResult ?? { result: "started" };
    },
    mintRequestId: () => `req-${cards.length}`,
  };
  return { notifier: new UpdateNotifier(opts), cards, applies, finalizes, statePath };
}

describe("UpdateNotifier", () => {
  it("approve → posts one card, starts update_apply, finalizes applied, persists release id", async () => {
    const h = makeHarness();
    const out = await h.notifier.notifyIfNew("sha256:aaa111");
    expect(out).toBe("apply_started");
    expect(h.cards).toHaveLength(1);
    expect(h.applies).toEqual(["req-0"]);
    expect(h.finalizes).toEqual([
      expect.objectContaining({ outcome: "applied" }),
    ]);
    const state = JSON.parse(readFileSync(h.statePath, "utf8"));
    expect(state.last_notified_version).toBe("sha256:aaa111");
  });

  it("dedups: a second detection of the SAME release posts no second card", async () => {
    const h = makeHarness();
    await h.notifier.notifyIfNew("sha256:aaa111");
    const out = await h.notifier.notifyIfNew("sha256:aaa111");
    expect(out).toBe("deduped");
    expect(h.cards).toHaveLength(1);
    expect(h.applies).toHaveLength(1);
  });

  it("a NEW release id gets a fresh card after a previous one was notified", async () => {
    const h = makeHarness({ verdict: "deny", denySource: "operator" });
    await h.notifier.notifyIfNew("sha256:aaa111");
    const out = await h.notifier.notifyIfNew("sha256:bbb222");
    expect(out).toBe("denied");
    expect(h.cards).toHaveLength(2);
    const state = JSON.parse(readFileSync(h.statePath, "utf8"));
    expect(state.last_notified_version).toBe("sha256:bbb222");
  });

  it("dedup survives a restart (state read from disk by a fresh instance)", async () => {
    const h1 = makeHarness();
    await h1.notifier.notifyIfNew("sha256:aaa111");
    const h2 = makeHarness();
    // Same statePath (same dir) — fresh instance must see the persisted id.
    const out = await h2.notifier.notifyIfNew("sha256:aaa111");
    expect(out).toBe("deduped");
    expect(h2.cards).toHaveLength(0);
  });

  it("respects the fleet-mutation lock: no card, no persist, retried after unlock", async () => {
    let locked = true;
    const h = makeHarness({ locked: () => locked });
    expect(await h.notifier.notifyIfNew("sha256:ccc333")).toBe("locked");
    expect(h.cards).toHaveLength(0);
    expect(existsSync(h.statePath)).toBe(false);
    locked = false;
    expect(await h.notifier.notifyIfNew("sha256:ccc333")).toBe("apply_started");
    expect(h.cards).toHaveLength(1);
  });

  it("re-checks the lock AFTER the plan probe: a mutation starting mid-probe suppresses the card", async () => {
    let locked = false;
    const h = makeHarness({
      locked: () => locked,
      plan: async () => {
        // Simulate a fleet mutation starting while `update --check` runs.
        locked = true;
        return "plan text";
      },
    });
    expect(await h.notifier.notifyIfNew("sha256:cafe11")).toBe("locked");
    expect(h.cards).toHaveLength(0);
    expect(existsSync(h.statePath)).toBe(false);
  });

  it("dispatch failure does NOT mark notified — the next tick re-cards", async () => {
    const h = makeHarness({
      verdicts: [
        { verdict: "deny", denySource: "dispatch_failure", reason: "gateway down" },
        { verdict: "approve" },
      ],
    });
    expect(await h.notifier.notifyIfNew("sha256:ddd444")).toBe("dispatch_failed");
    // Pending marker is cleared on a resolved dispatch failure so the
    // retry is prompt — nothing marks the release notified.
    const st = JSON.parse(readFileSync(h.statePath, "utf8"));
    expect(st.last_notified_version).toBeUndefined();
    expect(st.pending_version).toBeUndefined();
    expect(await h.notifier.notifyIfNew("sha256:ddd444")).toBe("apply_started");
    expect(h.cards).toHaveLength(2);
    expect(h.applies).toHaveLength(1);
  });

  it("restart-loop storm guard: a crash while the card is outstanding does NOT re-card within the suppress window", async () => {
    // First instance posts a card that never resolves (hostd "crashes").
    const statePath = join(dir, "state.json");
    const cards: string[] = [];
    const hung = new UpdateNotifier({
      statePath,
      isFleetMutationInFlight: () => false,
      requestApproval: async ({ version }) => {
        cards.push(version);
        return new Promise(() => {}); // card never resolves
      },
      startApply: () => ({ result: "started" }),
    });
    void hung.notifyIfNew("sha256:feed99");
    await new Promise((r) => setTimeout(r, 0)); // let the card post
    expect(cards).toHaveLength(1);
    // "Rebooted" instance, same state file: must suppress the re-post.
    const h2 = makeHarness();
    expect(await h2.notifier.notifyIfNew("sha256:feed99")).toBe(
      "pending_recent",
    );
    expect(h2.cards).toHaveLength(0);
    // …but a DIFFERENT release id is not suppressed.
    expect(await h2.notifier.notifyIfNew("sha256:aab000")).toBe(
      "apply_started",
    );
  });

  it("restart-loop storm guard expires: after the suppress window a fresh card is posted", async () => {
    const statePath = join(dir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        pending_version: "sha256:feed99",
        pending_posted_at: Date.now() - 2 * 60 * 60_000, // 2h ago
      }),
      "utf8",
    );
    const h = makeHarness(); // default suppress window = 1h
    expect(await h.notifier.notifyIfNew("sha256:feed99")).toBe("apply_started");
    expect(h.cards).toHaveLength(1);
  });

  it("skips (no card, no persist) when the watcher passes an empty release id", async () => {
    const h = makeHarness();
    expect(await h.notifier.notifyIfNew("")).toBe("skipped_no_version");
    expect(h.cards).toHaveLength(0);
    expect(existsSync(h.statePath)).toBe(false);
  });

  it("operator deny persists (one card per release) and never starts the apply", async () => {
    const h = makeHarness({ verdict: "deny", denySource: "operator" });
    expect(await h.notifier.notifyIfNew("sha256:eee555")).toBe("denied");
    expect(h.applies).toHaveLength(0);
    expect(await h.notifier.notifyIfNew("sha256:eee555")).toBe("deduped");
    expect(h.cards).toHaveLength(1);
  });

  it("timeout persists (card reached the operator) and never starts the apply", async () => {
    const h = makeHarness({ verdict: "timeout" });
    expect(await h.notifier.notifyIfNew("sha256:fff666")).toBe("timed_out");
    expect(h.applies).toHaveLength(0);
    expect(await h.notifier.notifyIfNew("sha256:fff666")).toBe("deduped");
  });

  it("approve but update_apply refused (lock raced) finalizes with the honest reason", async () => {
    const h = makeHarness({
      startResult: { result: "denied", error: "fleet-mutation lock held by apply" },
    });
    expect(await h.notifier.notifyIfNew("sha256:abc999")).toBe("apply_refused");
    expect(h.finalizes).toEqual([
      expect.objectContaining({
        outcome: "reconcile_failed_rolled_back",
        detail: expect.stringContaining("fleet-mutation lock held by apply"),
      }),
    ]);
  });

  it("plan probe failure still posts the card (plan is best-effort)", async () => {
    const h = makeHarness({
      plan: async () => {
        throw new Error("update --check exploded");
      },
    });
    expect(await h.notifier.notifyIfNew("sha256:0a0b0c")).toBe("apply_started");
    expect(h.cards[0].plan).toBe("");
  });

  it("passes the plan text through to the card", async () => {
    const h = makeHarness({ plan: async () => "2 releases behind: v1.2 → v1.4" });
    await h.notifier.notifyIfNew("sha256:1a2b3c");
    expect(h.cards[0].plan).toBe("2 releases behind: v1.2 → v1.4");
  });

  it("tolerates a corrupt state file (treated as never-notified, no crash)", async () => {
    const h = makeHarness();
    writeFileSync(h.statePath, "not json {{{", "utf8");
    expect(await h.notifier.notifyIfNew("sha256:c0ffee")).toBe("apply_started");
    const state = JSON.parse(readFileSync(h.statePath, "utf8"));
    expect(state.last_notified_version).toBe("sha256:c0ffee");
  });

  it("never throws when requestApproval rejects", async () => {
    const statePath = join(dir, "state.json");
    const notifier = new UpdateNotifier({
      statePath,
      isFleetMutationInFlight: () => false,
      requestApproval: async () => {
        throw new Error("socket exploded");
      },
      startApply: () => ({ result: "started" }),
    });
    expect(await notifier.notifyIfNew("sha256:boom")).toBe("dispatch_failed");
    // A thrown approval must not mark the release notified, and must
    // clear the pending marker so the next tick retries.
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    expect(st.last_notified_version).toBeUndefined();
    expect(st.pending_version).toBeUndefined();
  });

  it("clips an over-long refusal detail under the gateway's 500-char finalize cap", async () => {
    const h = makeHarness({
      startResult: { result: "denied", error: "x".repeat(600) },
    });
    expect(await h.notifier.notifyIfNew("sha256:b1gerr")).toBe("apply_refused");
    expect(h.finalizes).toHaveLength(1);
    const detail = h.finalizes[0].detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(450);
    expect(detail.startsWith("update did not start: ")).toBe(true);
  });

  it("a THROWING startApply after approval still finalizes honestly (apply_refused)", async () => {
    const statePath = join(dir, "state.json");
    const finalizes: { outcome: string; detail?: string }[] = [];
    const notifier = new UpdateNotifier({
      statePath,
      isFleetMutationInFlight: () => false,
      requestApproval: async () => ({
        verdict: "approve",
        finalize: async (o) => {
          finalizes.push({ outcome: o.outcome, ...(o.detail ? { detail: o.detail } : {}) });
        },
      }),
      startApply: () => {
        throw new Error("spawn exploded");
      },
    });
    expect(await notifier.notifyIfNew("sha256:thr0w1")).toBe("apply_refused");
    expect(finalizes).toEqual([
      expect.objectContaining({
        outcome: "reconcile_failed_rolled_back",
        detail: expect.stringContaining("spawn exploded"),
      }),
    ]);
  });
});

describe("short", () => {
  it("abbreviates sha256 digests for card/log display", () => {
    expect(short("sha256:0123456789abcdef0123")).toBe("0123456789ab");
    expect(short("v1.2.3")).toBe("v1.2.3");
  });
});
