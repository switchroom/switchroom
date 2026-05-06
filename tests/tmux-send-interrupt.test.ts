import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => {
  return {
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { sendAgentInterrupt } from "../src/agents/tmux.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe("sendAgentInterrupt", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("returns {ok:true} on happy path", () => {
    mockedExec.mockReturnValue(Buffer.from(""));
    const result = sendAgentInterrupt({ agentName: "klanker" });
    expect(result).toEqual({ ok: true });
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });

  it("invokes tmux with the exact argv shape", () => {
    mockedExec.mockReturnValue(Buffer.from(""));
    sendAgentInterrupt({ agentName: "klanker" });
    const [bin, args] = mockedExec.mock.calls[0]!;
    expect(bin).toBe("tmux");
    expect(args).toEqual([
      "-L",
      "switchroom-klanker",
      "send-keys",
      "-t",
      "klanker",
      "C-c",
    ]);
  });

  it("uses a 3s timeout on the exec call", () => {
    mockedExec.mockReturnValue(Buffer.from(""));
    sendAgentInterrupt({ agentName: "klanker" });
    const opts = mockedExec.mock.calls[0]![2] as { timeout?: number };
    expect(opts?.timeout).toBe(3000);
  });

  it("returns {error} on tmux failure without throwing", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("no server running on /tmp/tmux-1000/switchroom-x");
    });
    const result = sendAgentInterrupt({ agentName: "x" });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/no server running/);
  });

  it("returns {error} on timeout-style failure without throwing", () => {
    mockedExec.mockImplementation(() => {
      const err = new Error("ETIMEDOUT") as Error & { code?: string };
      err.code = "ETIMEDOUT";
      throw err;
    });
    const result = sendAgentInterrupt({ agentName: "x" });
    expect("error" in result).toBe(true);
  });

  it("retries when attempts > 1, sleeping retryDelayMs between calls", () => {
    let calls = 0;
    mockedExec.mockImplementation(() => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return Buffer.from("");
    });
    const t0 = Date.now();
    const result = sendAgentInterrupt({
      agentName: "x",
      attempts: 3,
      retryDelayMs: 20,
    });
    const elapsed = Date.now() - t0;
    expect(result).toEqual({ ok: true });
    expect(mockedExec).toHaveBeenCalledTimes(3);
    // 2 sleeps of 20ms between 3 attempts → at least ~40ms
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  it("returns last error when all attempts fail", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("still broken");
    });
    const result = sendAgentInterrupt({
      agentName: "x",
      attempts: 2,
      retryDelayMs: 1,
    });
    expect("error" in result).toBe(true);
    expect(mockedExec).toHaveBeenCalledTimes(2);
  });
});
