import { describe, it, expect } from "vitest";
import {
  decideWorkerPinReaps,
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
