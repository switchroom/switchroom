/**
 * Tests for the hostd MCP shim.
 *
 * Covers:
 *   - `TOOLS` exports exactly the 5 documented tools with sane shape.
 *   - `dispatchTool` happy path: hostdRequest invoked with the right
 *      request shape and response surfaced as JSON.
 *   - `dispatchTool` denied/error path: hostd-side denied/error
 *      responses surface as `isError: true` with the daemon's
 *      message intact.
 *   - Argument validation: missing required `name` returns an error
 *      without touching the wire.
 *   - Environment guards: missing SWITCHROOM_AGENT_NAME returns a
 *      clear error; absent socket returns a setup-hint error.
 *   - Unknown tool name returns an error result.
 *
 * The hostd UDS is mocked at the `hostdRequest` import boundary — no
 * real socket is bound. End-to-end wire coverage lives in
 * `tests/host-control/server.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HostdResponse } from "../../host-control/protocol.js";

const hostdRequestMock = vi.fn();
const existsSyncMock = vi.fn((_p: string) => true);

vi.mock("../../host-control/client.js", () => ({
  hostdRequest: (...args: unknown[]) => hostdRequestMock(...args),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => existsSyncMock(p),
  };
});

// Import after the mocks. server.ts reads SWITCHROOM_AGENT_NAME at
// module-load — set it before the import.
process.env.SWITCHROOM_AGENT_NAME = "klanker";
const { TOOLS, dispatchTool } = await import("./server.js");

function ok(resp: Partial<HostdResponse> = {}): HostdResponse {
  return {
    v: 1,
    request_id: resp.request_id ?? "mcp-test-1",
    result: resp.result ?? "started",
    exit_code: resp.exit_code ?? null,
    duration_ms: resp.duration_ms ?? 1,
    ...resp,
  } as HostdResponse;
}

beforeEach(() => {
  hostdRequestMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
});

afterEach(() => {
  hostdRequestMock.mockReset();
});

describe("TOOLS export", () => {
  it("exposes the documented hostd tools (Phase 2 + Phase 3 admin observability)", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "agent_exec",     // Phase 3 — peer container read-only inspection
      "agent_logs",     // Phase 3 — peer container log read
      "agent_restart",
      "agent_start",
      "agent_stop",
      "update_apply",
      "update_check",
    ]);
  });

  it("every tool has an object inputSchema and a non-trivial description", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("agent_* tools require `name` as a kebab-case ASCII string", () => {
    for (const name of [
      "agent_restart",
      "agent_start",
      "agent_stop",
      "agent_logs",
      "agent_exec",
    ]) {
      const t = TOOLS.find((x) => x.name === name)!;
      const schema = t.inputSchema as unknown as {
        required?: string[];
        properties: { name?: { pattern?: string } };
      };
      expect(schema.required).toContain("name");
      expect(schema.properties.name?.pattern).toBe(
        "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
      );
    }
  });
});

describe("dispatchTool — happy path", () => {
  it("agent_restart sends an agent_restart request with the right args", async () => {
    hostdRequestMock.mockResolvedValueOnce(
      ok({ result: "started", request_id: "mcp-restart-x" }),
    );
    const res = await dispatchTool("agent_restart", {
      name: "bob",
      reason: "follow-up",
      force: true,
    });
    expect(res.isError).toBeFalsy();
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.op).toBe("agent_restart");
    expect(sent.args).toEqual({ name: "bob", reason: "follow-up", force: true });
    expect(sent.request_id).toMatch(/^mcp-restart-/);
    expect(sent.v).toBe(1);
  });

  it("update_check sends an update_check request with no args", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "completed" }));
    const res = await dispatchTool("update_check", {});
    expect(res.isError).toBeFalsy();
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.op).toBe("update_check");
    expect(sent.request_id).toMatch(/^mcp-update-check-/);
  });

  it("update_apply forwards skip_images and rebuild flags", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("update_apply", {
      skip_images: true,
      rebuild: true,
    });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.op).toBe("update_apply");
    expect(sent.args).toEqual({ skip_images: true, rebuild: true });
  });

  it("update_apply omits falsy flag fields", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("update_apply", {});
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args).toEqual({});
  });

  it("agent_logs forwards tail when provided and omits it when not", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "completed" }));
    await dispatchTool("agent_logs", { name: "scribe", tail: 250 });
    let sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.op).toBe("agent_logs");
    expect(sent.args).toEqual({ name: "scribe", tail: 250 });

    hostdRequestMock.mockResolvedValueOnce(ok({ result: "completed" }));
    await dispatchTool("agent_logs", { name: "scribe" });
    sent = hostdRequestMock.mock.calls[1]![1];
    expect(sent.args).toEqual({ name: "scribe" });
  });

  it("agent_exec forwards name + argv", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "completed" }));
    await dispatchTool("agent_exec", {
      name: "scribe",
      argv: ["ls", "-la", "/state"],
    });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.op).toBe("agent_exec");
    expect(sent.args).toEqual({ name: "scribe", argv: ["ls", "-la", "/state"] });
  });

  it("agent_exec without argv returns isError without wire-calling", async () => {
    const res = await dispatchTool("agent_exec", { name: "scribe" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/argv is required/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("response is surfaced as JSON text in content[0]", async () => {
    const resp = ok({ result: "started", request_id: "abc" });
    hostdRequestMock.mockResolvedValueOnce(resp);
    const res = await dispatchTool("agent_stop", { name: "alice" });
    expect(JSON.parse(res.content[0]!.text)).toEqual(resp);
  });
});

describe("dispatchTool — failure modes", () => {
  it("hostd denied response surfaces as isError with full payload", async () => {
    const denied: HostdResponse = {
      v: 1,
      request_id: "x",
      result: "denied",
      exit_code: null,
      duration_ms: 0,
      error: "cross-agent restart requires admin",
    };
    hostdRequestMock.mockResolvedValueOnce(denied);
    const res = await dispatchTool("agent_restart", { name: "bob" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text)).toEqual(denied);
  });

  it("hostd error response surfaces as isError", async () => {
    const err: HostdResponse = {
      v: 1,
      request_id: "x",
      result: "error",
      exit_code: null,
      duration_ms: 1,
      error: "lock held by another fleet mutation",
    };
    hostdRequestMock.mockResolvedValueOnce(err);
    const res = await dispatchTool("update_apply", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("lock held by another fleet mutation");
  });

  it("wire-call throw is wrapped into an isError text response", async () => {
    hostdRequestMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await dispatchTool("agent_start", { name: "alice" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/hostd wire error/);
    expect(res.content[0]!.text).toMatch(/ECONNREFUSED/);
  });

  it("missing `name` on agent_restart returns isError without wire-calling", async () => {
    const res = await dispatchTool("agent_restart", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/name is required/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("absent socket returns a setup-hint error without wire-calling", async () => {
    existsSyncMock.mockReturnValueOnce(false);
    const res = await dispatchTool("update_check", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/socket not bound/);
    expect(res.content[0]!.text).toMatch(/switchroom hostd install/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("unknown tool name returns an error without wire-calling", async () => {
    const res = await dispatchTool("nope", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unknown tool: nope/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });
});
