/**
 * Unit tests for SocketApprovalGateway (#1762).
 *
 * Focus areas (added with #1762):
 *   - `reason` surfaces from gateway → ApprovalResult on
 *     config_approval_resolved
 *   - `denySource: "dispatch_failure"` propagates when the gateway
 *     reports a card-dispatch failure
 *   - `denySource: "operator"` defaults on a bare deny (no denySource
 *     field on the wire) so the caller's discriminant is always
 *     populated when verdict==="deny"
 *   - resolveGatewaySocket returning null → deny with
 *     denySource: "dispatch_failure"
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketApprovalGateway } from "./approval-gateway.js";
import { formatConfigApprovalDenyError } from "./server.js";

interface FakeGateway {
  server: Server;
  socketPath: string;
  /** Set by the test to control how the gateway responds to incoming requests. */
  respond: (write: (line: string) => void, requestId: string) => void;
  /** #2975 Stage 2 — control the reply to a check_pre_approved query. */
  respondPreApproved: (
    write: (line: string) => void,
    correlationId: string,
  ) => void;
  /** All client sockets — force-destroyed by afterEach to unblock server.close. */
  clients: Socket[];
}

function startFakeGateway(): FakeGateway {
  const dir = mkdtempSync(join(tmpdir(), "sr-1762-"));
  const socketPath = join(dir, "gw.sock");
  const handle: Partial<FakeGateway> = { clients: [] };
  const server = createServer((sock: Socket) => {
    handle.clients?.push(sock);
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line) as {
          type: string;
          requestId: string;
          correlationId: string;
        };
        if (obj.type === "request_config_approval") {
          handle.respond?.(
            (out: string) => sock.write(out + "\n"),
            obj.requestId,
          );
        } else if (obj.type === "check_pre_approved") {
          handle.respondPreApproved?.(
            (out: string) => sock.write(out + "\n"),
            obj.correlationId,
          );
        }
      }
    });
  });
  server.listen(socketPath);
  handle.server = server;
  handle.socketPath = socketPath;
  // default respond — overridden per-test
  handle.respond = () => {};
  // default: a gateway that never answers a pre-approval query (fail-closed).
  handle.respondPreApproved = () => {};
  // cleanup attached to the returned object via close handler
  server.on("close", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  return handle as FakeGateway;
}

const baseReq = {
  requestId: "req-fake",
  agentName: "klanker",
  reason: "test",
  unifiedDiff: "--- a\n+++ b\n",
  timeoutMs: 5_000,
};

describe("SocketApprovalGateway — dispatch_failure plumbing (#1762)", () => {
  let fake: FakeGateway;

  beforeEach(() => {
    fake = startFakeGateway();
  });
  afterEach(async () => {
    // SocketApprovalGateway keeps the client socket open after the
    // verdict resolves (so finalize() can reuse it). The fake server
    // can't fully close until every connection is gone, so destroy
    // them explicitly here.
    for (const c of fake.clients) c.destroy();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it("propagates reason + denySource='dispatch_failure' from the gateway", async () => {
    fake.respond = (write, requestId) => {
      write(
        JSON.stringify({
          type: "config_approval_resolved",
          requestId,
          verdict: "deny",
          reason: "Telegram sendMessage failed (4097 > 4096 chars)",
          denySource: "dispatch_failure",
        }),
      );
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    const result = await gw.requestApproval(baseReq);
    expect(result.verdict).toBe("deny");
    expect(result.reason).toBe(
      "Telegram sendMessage failed (4097 > 4096 chars)",
    );
    expect(result.denySource).toBe("dispatch_failure");
  });

  it("defaults denySource='operator' on a bare deny with no denySource field", async () => {
    fake.respond = (write, requestId) => {
      write(
        JSON.stringify({
          type: "config_approval_resolved",
          requestId,
          verdict: "deny",
        }),
      );
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    const result = await gw.requestApproval(baseReq);
    expect(result.verdict).toBe("deny");
    expect(result.denySource).toBe("operator");
    expect(result.reason).toBeUndefined();
  });

  it("denySource is undefined on non-deny verdicts (approve)", async () => {
    fake.respond = (write, requestId) => {
      write(
        JSON.stringify({
          type: "config_approval_resolved",
          requestId,
          verdict: "approve",
        }),
      );
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    const result = await gw.requestApproval(baseReq);
    expect(result.verdict).toBe("approve");
    expect(result.denySource).toBeUndefined();
  });

  it("resolveGatewaySocket=null → deny with denySource='dispatch_failure'", async () => {
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => null,
    });
    const result = await gw.requestApproval(baseReq);
    expect(result.verdict).toBe("deny");
    expect(result.denySource).toBe("dispatch_failure");
    expect(result.reason).toMatch(/no reachable telegram gateway/);
  });

  it("server-side mapping: denySource='dispatch_failure' → E_APPROVAL_DISPATCH_FAILED with the gateway reason", () => {
    const msg = formatConfigApprovalDenyError(
      {
        
        reason: "Telegram sendMessage failed (4097 > 4096 chars)",
        denySource: "dispatch_failure",
      },
      "abc12345",
    );
    expect(msg).toContain("E_APPROVAL_DISPATCH_FAILED");
    expect(msg).toContain("Telegram sendMessage failed");
    expect(msg).toContain("approval_id=abc12345");
    expect(msg).not.toContain("operator denied");
  });

  it("server-side mapping: denySource='operator' → E_DENIED with reason appended", () => {
    const msg = formatConfigApprovalDenyError(
      {
        
        denySource: "operator",
        reason: "operator tapped deny",
      },
      "abc12345",
    );
    expect(msg).toMatch(/^E_DENIED:/);
    expect(msg).toContain("operator denied config_propose_edit");
    expect(msg).toContain("operator tapped deny");
  });

  it("server-side mapping: no reason → bare E_DENIED message", () => {
    const msg = formatConfigApprovalDenyError(
      { denySource: "operator" },
      "abc12345",
    );
    expect(msg).toBe(
      "E_DENIED: operator denied config_propose_edit (approval_id=abc12345)",
    );
  });

  it("server-side mapping: dispatch_failure with no reason → generic fallback string", () => {
    const msg = formatConfigApprovalDenyError(
      { denySource: "dispatch_failure" },
      "abc12345",
    );
    expect(msg).toContain("E_APPROVAL_DISPATCH_FAILED");
    expect(msg).toContain("card dispatch failed");
  });

  it("gateway socket closes before verdict → deny with denySource='dispatch_failure'", async () => {
    fake.respond = (_write, _requestId) => {
      // Drop the connection without responding — simulates gateway
      // crash mid-request. Destroying every server-side client socket
      // surfaces as a 'close' event on the SocketApprovalGateway client.
      for (const c of fake.clients) c.destroy();
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    const result = await gw.requestApproval(baseReq);
    expect(result.verdict).toBe("deny");
    expect(result.denySource).toBe("dispatch_failure");
    expect(result.reason).toBeDefined();
  });
});

describe("SocketApprovalGateway.checkPreApproved — read-only bypass query (#2975 Stage 2)", () => {
  let fake: FakeGateway;

  beforeEach(() => {
    fake = startFakeGateway();
  });
  afterEach(async () => {
    for (const c of fake.clients) c.destroy();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it("returns true when the gateway answers preApproved:true", async () => {
    fake.respondPreApproved = (write, correlationId) => {
      write(
        JSON.stringify({
          type: "pre_approved_result",
          correlationId,
          preApproved: true,
        }),
      );
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(true);
  });

  it("returns false when the gateway answers preApproved:false", async () => {
    fake.respondPreApproved = (write, correlationId) => {
      write(
        JSON.stringify({
          type: "pre_approved_result",
          correlationId,
          preApproved: false,
        }),
      );
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(false);
  });

  it("fails closed (false) when the gateway never answers (mixed-version / old gateway)", async () => {
    // Default respondPreApproved is a no-op — no reply is ever sent, so the
    // short internal timeout must resolve false. Uses real timers; the query
    // deadline is 2s so we allow up to ~3s.
    fake.respondPreApproved = () => {};
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(false);
  }, 5_000);

  it("fails closed (false) on an unknown/unsupported-message reply", async () => {
    // An old gateway that doesn't know check_pre_approved might echo an error
    // frame of a different type — treat any non-matching type as not approved.
    fake.respondPreApproved = (write, correlationId) => {
      write(
        JSON.stringify({
          type: "error",
          correlationId,
          reason: "unknown message type: check_pre_approved",
        }),
      );
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(false);
  });

  it("fails closed (false) on a garbled (non-JSON) reply", async () => {
    fake.respondPreApproved = (write) => {
      write("this is not json {{{");
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(false);
  });

  it("fails closed (false) when the socket closes before answering", async () => {
    fake.respondPreApproved = () => {
      for (const c of fake.clients) c.destroy();
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(false);
  });

  it("fails closed (false) when there is no reachable gateway socket", async () => {
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => null,
    });
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(false);
  });

  it("ignores a reply carrying a mismatched correlationId (fail closed)", async () => {
    fake.respondPreApproved = (write) => {
      write(
        JSON.stringify({
          type: "pre_approved_result",
          correlationId: "some-other-id",
          preApproved: true,
        }),
      );
    };
    const gw = new SocketApprovalGateway({
      resolveGatewaySocket: () => fake.socketPath,
    });
    // Mismatched correlationId is a non-matching frame → fail closed to false.
    expect(await gw.checkPreApproved("klanker", "--- a\n+++ b\n")).toBe(false);
  });
});
