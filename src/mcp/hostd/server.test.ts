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
      "config_propose_edit", // PR 1a (admin-agent-config-edit) — flag-gated stub
      "get_status",     // PR B — read last terminal update_apply audit row
      "rollout",        // #2487 — safe staggered canary fleet roll
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

  it("update_apply forwards channel through to the daemon", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("update_apply", { channel: "dev" });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args).toEqual({ channel: "dev" });
  });

  it("update_apply forwards pin through to the daemon", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("update_apply", { pin: "sha-abc1234" });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args).toEqual({ pin: "sha-abc1234" });
  });

  it("update_apply rejects channel+pin combo without hitting the wire", async () => {
    const res = await dispatchTool("update_apply", {
      channel: "dev",
      pin: "v0.11.1",
    });
    expect(res.isError).toBe(true);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("update_apply rejects malformed pin without hitting the wire", async () => {
    const res = await dispatchTool("update_apply", { pin: "not-a-pin" });
    expect(res.isError).toBe(true);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  // ── #2487 rollout dispatch ───────────────────────────────────────────
  it("rollout sends a rollout request with a semver pin", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    const res = await dispatchTool("rollout", { pin: "v0.15.18" });
    expect(res.isError).toBeFalsy();
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.op).toBe("rollout");
    expect(sent.args).toEqual({ pin: "v0.15.18" });
    expect(sent.request_id).toMatch(/^mcp-rollout-/);
    expect(sent.v).toBe(1);
  });

  it("rollout forwards agents + skip_web", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("rollout", {
      pin: "v0.15.18",
      agents: ["test-harness", "clerk"],
      skip_web: true,
    });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args).toEqual({
      pin: "v0.15.18",
      agents: ["test-harness", "clerk"],
      skip_web: true,
    });
  });

  it("rollout rejects a sha- pin at the wire boundary (semver-only)", async () => {
    const res = await dispatchTool("rollout", { pin: "sha-abc1234" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/SHA pins are rejected|invalid/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("rollout rejects a missing pin without hitting the wire", async () => {
    const res = await dispatchTool("rollout", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/pin is required/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("rollout rejects an empty agents array without hitting the wire", async () => {
    const res = await dispatchTool("rollout", { pin: "v0.15.18", agents: [] });
    expect(res.isError).toBe(true);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("rollout forwards allow_downgrade when true", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("rollout", { pin: "v0.15.16", allow_downgrade: true });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args.allow_downgrade).toBe(true);
  });

  it("rollout omits allow_downgrade when not set (default upgrade path)", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("rollout", { pin: "v0.15.18" });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args.allow_downgrade).toBeUndefined();
  });

  // ── Bug 1: gated verbs forward an optional `reason` for the operator
  //    approval card's `why:` line (#2469 keeps the card reading the
  //    caller's arg, never the schema description). ──────────────────────
  it("rollout forwards reason into the request args when provided", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("rollout", {
      pin: "v0.15.18",
      reason: "promote canary-green build to the fleet",
    });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args.reason).toBe("promote canary-green build to the fleet");
  });

  it("rollout omits the reason key when absent", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("rollout", { pin: "v0.15.18" });
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.args).not.toHaveProperty("reason");
  });

  it("update_apply forwards reason when provided and omits it when absent", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("update_apply", {
      pin: "v0.15.18",
      reason: "ship the approval-card fix",
    });
    const withReason = hostdRequestMock.mock.calls[0]![1];
    expect(withReason.args.reason).toBe("ship the approval-card fix");

    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("update_apply", { pin: "v0.15.18" });
    const withoutReason = hostdRequestMock.mock.calls[1]![1];
    expect(withoutReason.args).not.toHaveProperty("reason");
  });

  it("declares `reason` FIRST in each gated verb's inputSchema (truncation-safe)", () => {
    for (const toolName of [
      "rollout",
      "update_apply",
      "agent_start",
      "agent_stop",
      "agent_logs",
      "agent_exec",
    ]) {
      const tool = TOOLS.find((t) => t.name === toolName);
      expect(tool, `${toolName} should exist`).toBeTruthy();
      const props = tool!.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("reason");
      expect(Object.keys(props)[0]).toBe("reason");
    }
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

  it("get_status returns the most recent terminal update_apply audit row", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mcp-getstatus-"));
    const auditPath = join(dir, "audit.log");
    // Two rows — one in-flight `started`, one terminal `completed` with
    // enrichment fields. `get_status` should return the terminal row.
    const lines = [
      JSON.stringify({
        ts: "2026-05-17T01:00:00.000Z",
        op: "update_apply",
        caller: { kind: "operator" },
        request_id: "ua-1",
        result: "started",
        exit_code: null,
        duration_ms: 1,
      }),
      JSON.stringify({
        ts: "2026-05-17T01:05:00.000Z",
        op: "update_apply",
        caller: { kind: "operator" },
        request_id: "ua-1",
        result: "completed",
        exit_code: 0,
        duration_ms: 240000,
        phase: "terminal",
        channel: "dev",
        resolved_sha: {
          "ghcr.io/switchroom/switchroom-agent:dev": "sha256:abc",
        },
        install_context: {
          install_type: "binary",
          detected_at: "2026-05-17T00:59:30.000Z",
        },
      }),
    ];
    writeFileSync(auditPath, lines.join("\n") + "\n");
    const prev = process.env.HOSTD_AUDIT_LOG_PATH;
    process.env.HOSTD_AUDIT_LOG_PATH = auditPath;
    try {
      const res = await dispatchTool("get_status", {});
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0]!.text);
      expect(parsed.op).toBe("update_apply");
      expect(parsed.phase).toBe("terminal");
      expect(parsed.channel).toBe("dev");
      expect(parsed.install_context.install_type).toBe("binary");
      expect(parsed.resolved_sha).toEqual({
        "ghcr.io/switchroom/switchroom-agent:dev": "sha256:abc",
      });
      expect(hostdRequestMock).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.HOSTD_AUDIT_LOG_PATH = prev;
      else delete process.env.HOSTD_AUDIT_LOG_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("get_status surfaces a clear error when no terminal update_apply rows exist", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mcp-getstatus-empty-"));
    const auditPath = join(dir, "audit.log");
    writeFileSync(auditPath, "");
    const prev = process.env.HOSTD_AUDIT_LOG_PATH;
    process.env.HOSTD_AUDIT_LOG_PATH = auditPath;
    try {
      const res = await dispatchTool("get_status", {});
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/no terminal update_apply rows/);
    } finally {
      if (prev !== undefined) process.env.HOSTD_AUDIT_LOG_PATH = prev;
      else delete process.env.HOSTD_AUDIT_LOG_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown tool name returns an error without wire-calling", async () => {
    const res = await dispatchTool("nope", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unknown tool: nope/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });
});

describe("dispatchTool — config_propose_edit", () => {
  const VALID_DIFF =
    "--- a/switchroom.yaml\n+++ b/switchroom.yaml\n@@ -1,1 +1,1 @@\n-a\n+b\n";

  it("forwards a well-formed request to hostd", async () => {
    hostdRequestMock.mockResolvedValueOnce({
      v: 1,
      request_id: "x",
      result: "error",
      exit_code: null,
      duration_ms: 0,
      error: "E_CONFIG_EDIT_DISABLED: ...",
    } as HostdResponse);
    const res = await dispatchTool("config_propose_edit", {
      unified_diff: VALID_DIFF,
      reason: "tweak the version comment",
      target_path: "/state/config/switchroom.yaml",
    });
    // Daemon returned an error response (here: config-edit disabled) —
    // surfaces as isError, but the request DID make it to the wire (this
    // tests the MCP dispatch forwards a well-formed call to hostd).
    expect(res.isError).toBe(true);
    const sent = hostdRequestMock.mock.calls[0]![1];
    expect(sent.op).toBe("config_propose_edit");
    expect(sent.args).toEqual({
      unified_diff: VALID_DIFF,
      reason: "tweak the version comment",
      target_path: "/state/config/switchroom.yaml",
    });
    expect(sent.request_id).toMatch(/^mcp-config-propose-edit-/);
  });

  it("uses a long wire timeout (outlasting the operator approval window)", async () => {
    // Root cause of the 2026-06-15 klanker debacle: the MCP wire used a
    // flat 10s for every op, but config_propose_edit BLOCKS server-side
    // until the operator taps (up to ~10 min). A 10s wire times out by
    // construction → the agent re-fires → phantom stacked cards. The
    // wire must outlast the approval window.
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "completed" }));
    await dispatchTool("config_propose_edit", {
      unified_diff: VALID_DIFF,
      reason: "x",
      target_path: "/state/config/switchroom.yaml",
    });
    const wireOpts = hostdRequestMock.mock.calls[0]![0] as { timeoutMs: number };
    expect(wireOpts.timeoutMs).toBe(11 * 60 * 1000);
    // And it must comfortably exceed the daemon's 10-min approval window.
    expect(wireOpts.timeoutMs).toBeGreaterThan(10 * 60 * 1000);
  });

  it("leaves the snappy default wire timeout on prompt-returning ops", async () => {
    hostdRequestMock.mockResolvedValueOnce(ok({ result: "started" }));
    await dispatchTool("update_check", {});
    const wireOpts = hostdRequestMock.mock.calls[0]![0] as { timeoutMs: number };
    expect(wireOpts.timeoutMs).toBe(10_000);
  });

  it("rejects missing unified_diff without hitting the wire", async () => {
    const res = await dispatchTool("config_propose_edit", {
      reason: "x",
      target_path: "/state/config/switchroom.yaml",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unified_diff is required/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("rejects missing reason without hitting the wire", async () => {
    const res = await dispatchTool("config_propose_edit", {
      unified_diff: VALID_DIFF,
      target_path: "/state/config/switchroom.yaml",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/reason is required/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("rejects an over-long reason without hitting the wire", async () => {
    const res = await dispatchTool("config_propose_edit", {
      unified_diff: VALID_DIFF,
      reason: "x".repeat(501),
      target_path: "/state/config/switchroom.yaml",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/capped at 500/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical target_path without hitting the wire", async () => {
    const res = await dispatchTool("config_propose_edit", {
      unified_diff: VALID_DIFF,
      reason: "x",
      target_path: "/etc/passwd",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/target_path/);
    expect(hostdRequestMock).not.toHaveBeenCalled();
  });
});
