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
      isTerminal: () => true,
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
      isTerminal: () => false,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(1);
    expect(reaps[0].reason).toBe("ttl");
  });

  it("NEVER touches a running worker younger than the TTL", () => {
    const reaps = decideWorkerPinReaps({
      pins: [pin({ pinnedAt: NOW - TTL + 1 })],
      isTerminal: () => false,
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
      isTerminal: () => true,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });

  it("skips a candidate with no chat id (cannot unpin without one)", () => {
    const reaps = decideWorkerPinReaps({
      pins: [pin({ chatId: "", pinnedAt: NOW - 10 * TTL })],
      isTerminal: () => true,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });

  it("terminality is consulted per-agent and wins over the TTL gate", () => {
    const seen: string[] = [];
    const reaps = decideWorkerPinReaps({
      pins: [
        pin({ pinKey: "wk:done", pinnedAt: NOW - 1_000 }),
        pin({ pinKey: "wk:running", pinnedAt: NOW - 1_000 }),
        pin({ pinKey: "wk:old-running", pinnedAt: NOW - TTL - 1 }),
      ],
      isTerminal: (agentId) => {
        seen.push(agentId);
        return agentId === "done";
      },
      ttlMs: TTL,
      now: NOW,
    });
    expect(seen).toEqual(["done", "running", "old-running"]);
    expect(reaps.map((r) => [r.pinKey, r.reason])).toEqual([
      ["wk:done", "terminal"],
      ["wk:old-running", "ttl"],
    ]);
  });

  it("a throwing-in-caller-terms predicate is the caller's contract: false keeps the pin (registry hiccup never unpins)", () => {
    // The gateway wraps its DB lookup and degrades to `false`. This pins the
    // pure module's side of the contract: false + young pin = untouched.
    const reaps = decideWorkerPinReaps({
      pins: [pin()],
      isTerminal: () => false,
      ttlMs: TTL,
      now: NOW,
    });
    expect(reaps).toHaveLength(0);
  });
});
