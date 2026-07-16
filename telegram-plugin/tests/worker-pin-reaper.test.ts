import { describe, it, expect } from "vitest";
import {
  decideWorkerPinReaps,
  storeOnlyWorkerPinCandidates,
  workerAgentIdOfPinKey,
  WORKER_PIN_TTL_MS_DEFAULT,
  type WorkerPinCandidate,
} from "../gateway/worker-pin-reaper.js";

const NOW = 1_750_000_000_000;
const TTL = WORKER_PIN_TTL_MS_DEFAULT;

function pin(over: Partial<WorkerPinCandidate> = {}): WorkerPinCandidate {
  return { pinKey: "wk:agent-1", chatId: "123", pinnedAt: NOW - 60_000, ...over };
}

describe("workerAgentIdOfPinKey", () => {
  it("extracts the agentId from a wk: key", () => {
    expect(workerAgentIdOfPinKey("wk:abc123")).toBe("abc123");
  });
  it("returns null for non-worker keys (fg:/banner:/tool:) and empty ids", () => {
    expect(workerAgentIdOfPinKey("fg:123:5")).toBeNull();
    expect(workerAgentIdOfPinKey("banner:owner")).toBeNull();
    expect(workerAgentIdOfPinKey("tool:123:9")).toBeNull();
    expect(workerAgentIdOfPinKey("wk:")).toBeNull();
  });
});

describe("decideWorkerPinReaps (#3001 mid-session wk: sweep)", () => {
  it("reaps a pin whose worker is terminal, however young the pin is", () => {
    const reaps = decideWorkerPinReaps({
      pins: [pin({ pinnedAt: NOW - 1_000 })],
      statusOf: () => 'terminal' as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(1);
    expect(reaps[0].reason).toBe("terminal");
    expect(reaps[0].pinKey).toBe("wk:agent-1");
  });

  it("reaps a non-terminal pin once it exceeds the TTL", () => {
    const reaps = decideWorkerPinReaps({
      pins: [pin({ pinnedAt: NOW - TTL })],
      statusOf: () => 'unknown' as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(1);
    expect(reaps[0].reason).toBe("ttl");
  });

  it("NEVER touches a pin younger than the TTL when the registry cannot vouch (unknown)", () => {
    const reaps = decideWorkerPinReaps({
      pins: [pin({ pinnedAt: NOW - TTL + 1 })],
      statusOf: () => 'unknown' as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });

  it("ignores non-worker keys entirely (fg:/banner:/tool: are not its job)", () => {
    const reaps = decideWorkerPinReaps({
      pins: [
        pin({ pinKey: "fg:123:5", pinnedAt: NOW - 10 * TTL }),
        pin({ pinKey: "banner:owner", pinnedAt: NOW - 10 * TTL }),
        pin({ pinKey: "tool:123:9", pinnedAt: NOW - 10 * TTL }),
      ],
      statusOf: () => 'terminal' as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });

  it("skips a candidate with no chat id (cannot unpin without one)", () => {
    const reaps = decideWorkerPinReaps({
      pins: [pin({ chatId: "", pinnedAt: NOW - 10 * TTL })],
      statusOf: () => 'terminal' as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });

  it("a registry-confirmed RUNNING worker keeps its pin PAST the TTL (no unpin/re-pin churn on healthy long workers)", () => {
    const reaps = decideWorkerPinReaps({
      pins: [pin({ pinnedAt: NOW - 10 * TTL })],
      statusOf: () => 'running' as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });

  it("status is consulted per-agent: terminal reaps young, running exempts old, unknown falls to the TTL gate", () => {
    const seen: string[] = [];
    const reaps = decideWorkerPinReaps({
      pins: [
        pin({ pinKey: "wk:done", pinnedAt: NOW - 1_000 }),
        pin({ pinKey: "wk:running-old", pinnedAt: NOW - TTL - 1 }),
        pin({ pinKey: "wk:unknown-young", pinnedAt: NOW - 1_000 }),
        pin({ pinKey: "wk:unknown-old", pinnedAt: NOW - TTL - 1 }),
      ],
      statusOf: (agentId) => {
        seen.push(agentId);
        if (agentId === "done") return "terminal";
        if (agentId === "running-old") return "running";
        return "unknown";
      },
      ttlMs: TTL,
      now: NOW,
    });
    expect(seen).toEqual(["done", "running-old", "unknown-young", "unknown-old"]);
    expect(reaps.map((r) => [r.pinKey, r.reason])).toEqual([
      ["wk:done", "terminal"],
      ["wk:unknown-old", "ttl"],
    ]);
  });

  it("registry hiccup ('unknown') never unpins a young pin — the caller's contract on statusOf degrade", () => {
    // The gateway wraps its DB lookup and degrades to 'unknown'. This pins the
    // pure module's side of the contract: unknown + young pin = untouched.
    const reaps = decideWorkerPinReaps({
      pins: [pin()],
      statusOf: () => 'unknown' as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });
});

describe("storeOnlyWorkerPinCandidates (#3001 durable group net)", () => {
  const inMem = (keys: string[] = []) => new Set(keys);

  it("promotes a wk: store row that has NO in-memory claim into a reap candidate (group chat)", () => {
    // A GROUP chat id is negative; the reconciling sweep must recover a
    // bot-tracked orphan there via a per-message unpin (never an unpin-all).
    const cands = storeOnlyWorkerPinCandidates({
      rows: [{ pinKey: "wk:group:-100:5", chatId: "-100", messageId: 42 }],
      inMemoryPinKeys: inMem(),
      now: NOW,
    });
    expect(cands).toHaveLength(1);
    expect(cands[0].pinKey).toBe("wk:group:-100:5");
    expect(cands[0].chatId).toBe("-100");
    // messageId is carried so the gateway can per-message unpin (group-safe).
    expect(cands[0].messageId).toBe(42);
    // A terminal registry verdict reaps it now, however "young" (pinnedAt=now).
    const reaps = decideWorkerPinReaps({
      pins: cands,
      statusOf: () => "terminal" as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps.map((r) => r.pinKey)).toEqual(["wk:group:-100:5"]);
  });

  it("NEVER promotes an untracked/human pin — only wk: rows qualify (fg:/tool:/banner: excluded)", () => {
    const cands = storeOnlyWorkerPinCandidates({
      rows: [
        { pinKey: "fg:-100:9", chatId: "-100", messageId: 1 },
        { pinKey: "tool:-100:9", chatId: "-100", messageId: 2, expiresAt: NOW + 1 },
        { pinKey: "banner:owner", chatId: "-100", messageId: 3 },
      ],
      inMemoryPinKeys: inMem(),
      now: NOW,
    });
    expect(cands).toHaveLength(0);
  });

  it("skips rows the in-memory reaper already owns (dedup by pinKey)", () => {
    const cands = storeOnlyWorkerPinCandidates({
      rows: [{ pinKey: "wk:a", chatId: "-100", messageId: 7 }],
      inMemoryPinKeys: inMem(["wk:a"]),
      now: NOW,
    });
    expect(cands).toHaveLength(0);
  });

  it("skips pending (pin API in-flight) and time-scoped tool rows and empty-chat rows", () => {
    const cands = storeOnlyWorkerPinCandidates({
      rows: [
        { pinKey: "wk:pending", chatId: "-100", messageId: 1, pending: true },
        { pinKey: "wk:tool", chatId: "-100", messageId: 2, expiresAt: NOW + 1000 },
        { pinKey: "wk:nochat", chatId: "", messageId: 3 },
      ],
      inMemoryPinKeys: inMem(),
      now: NOW,
    });
    expect(cands).toHaveLength(0);
  });

  it("a store-orphan with a live 'running' worker is kept (never reaped mid-run)", () => {
    const cands = storeOnlyWorkerPinCandidates({
      rows: [{ pinKey: "wk:live", chatId: "-100", messageId: 5 }],
      inMemoryPinKeys: inMem(),
      now: NOW,
    });
    const reaps = decideWorkerPinReaps({
      pins: cands,
      statusOf: () => "running" as const,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });
});
