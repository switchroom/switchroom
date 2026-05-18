import { describe, it, expect } from "vitest";
import {
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  deniedResponse,
  errorResponse,
  IDEMPOTENCY_WINDOW_MS,
  MAX_FRAME_BYTES,
  type HostdRequest,
  type HostdResponse,
} from "../../src/host-control/protocol.js";

describe("hostd protocol — framing & schema", () => {
  it("round-trips an agent_restart request", () => {
    const req: HostdRequest = {
      v: 1,
      op: "agent_restart",
      request_id: "abc-123",
      args: { name: "klanker", reason: "user", force: true },
    };
    const wire = encodeRequest(req);
    expect(wire.endsWith("\n")).toBe(true);
    const decoded = decodeRequest(wire.trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips an upgrade_status request without args", () => {
    const req: HostdRequest = {
      v: 1,
      op: "upgrade_status",
      request_id: "abc-456",
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips a doctor request without args", () => {
    const req: HostdRequest = {
      v: 1,
      op: "doctor",
      request_id: "doc-001",
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("round-trips a get_status request", () => {
    const req: HostdRequest = {
      v: 1,
      op: "get_status",
      request_id: "abc-789",
      args: { target_request_id: "abc-123" },
    };
    const decoded = decodeRequest(encodeRequest(req).trimEnd());
    expect(decoded).toEqual(req);
  });

  it("rejects unknown op", () => {
    expect(() => decodeRequest(JSON.stringify({ v: 1, op: "delete_everything", request_id: "x" }))).toThrow();
  });

  it("rejects v != 1", () => {
    expect(() =>
      decodeRequest(
        JSON.stringify({ v: 2, op: "upgrade_status", request_id: "x" }),
      ),
    ).toThrow();
  });

  it("rejects agent names with bad characters", () => {
    expect(() =>
      decodeRequest(
        JSON.stringify({
          v: 1,
          op: "agent_restart",
          request_id: "x",
          args: { name: "klanker;rm -rf /" },
        }),
      ),
    ).toThrow();
  });

  it("rejects oversized frames", () => {
    const big = "x".repeat(MAX_FRAME_BYTES + 10);
    expect(() => decodeRequest(big)).toThrow(RangeError);
  });

  it("round-trips a response", () => {
    const resp: HostdResponse = {
      v: 1,
      request_id: "abc-123",
      result: "completed",
      exit_code: 0,
      duration_ms: 42,
      stdout_tail: "ok",
    };
    const decoded = decodeResponse(encodeResponse(resp).trimEnd());
    expect(decoded).toEqual(resp);
  });

  it("deniedResponse / errorResponse have null exit_code", () => {
    expect(deniedResponse("x", "nope").exit_code).toBeNull();
    expect(errorResponse("x", "boom").exit_code).toBeNull();
  });

  it("exposes the idempotency window constant", () => {
    // Pinned to gateway's restart-marker debounce.
    expect(IDEMPOTENCY_WINDOW_MS).toBe(15_000);
  });
});
