/**
 * sec host-control-F1 — the 15s idempotency cache must (a) never be consulted
 * BEFORE the authz gate, and (b) be scoped by caller identity so one caller can
 * never be served — or collide with — another caller's cached mutation result.
 *
 * Pre-fix, `handleLine` consulted the cache first and keyed it on the bare
 * `idempotency_key ?? request_id` (no caller scope). So caller B replaying
 * caller A's idempotency_key would be handed A's cached result BEFORE
 * `checkGate` ran — an unauthorized, unaudited cross-caller leak.
 *
 * We drive the private `handleLine` directly (same private-method-via-cast
 * pattern as `reconcile-rollback-output.test.ts`) with a fake socket that
 * captures the response frame. `agent_restart` records its status entry and
 * returns `started` synchronously (the child is fire-and-forget), so no real
 * fleet mutation is needed; `switchroomBin` points at `/bin/true` so the
 * detached child exits cleanly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer, type ServerOptions } from "./server.js";
import { decodeResponse, type HostdRequest, type HostdResponse } from "./protocol.js";
import type { SocketIdentity } from "./peercred.js";

/** Minimal fake Socket capturing what the daemon writes back. */
function fakeSocket() {
  const frames: string[] = [];
  return {
    frames,
    write: (buf: string | Buffer) => {
      frames.push(buf.toString());
      return true;
    },
    end: () => undefined,
    response(): HostdResponse {
      // Last written frame is the response (denials & cache-serves both write one).
      const last = frames[frames.length - 1]!;
      return decodeResponse(last.replace(/\n$/, ""));
    },
  };
}

function restartReq(
  request_id: string,
  targetName: string,
  idempotency_key: string,
): HostdRequest {
  return {
    v: 1,
    request_id,
    op: "agent_restart",
    args: { name: targetName },
    idempotency_key,
  } as HostdRequest;
}

type ServerInternals = {
  handleLine: (
    line: string,
    caller: SocketIdentity,
    socket: ReturnType<typeof fakeSocket>,
  ) => Promise<void>;
  statusByRequestId: Map<string, unknown>;
};

describe("idempotency cache — caller-scoped & gate-first (sec F1)", () => {
  let home: string;
  let server: HostdServer;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hostd-idem-"));
    const opts: ServerOptions = {
      homeDir: home,
      agentUids: {},
      config: {
        agents: {
          alpha: { admin: true },
          beta: { admin: true },
          gamma: { admin: false },
        },
      },
      switchroomBin: "/bin/true",
      auditLogPath: join(home, "audit.log"),
      allowNonLinux: true,
    };
    server = new HostdServer(opts);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const internals = () => server as unknown as ServerInternals;

  it("does NOT serve caller A's cached result to a DIFFERENT admin caller sharing the idempotency_key", async () => {
    const alpha: SocketIdentity = { kind: "agent", name: "alpha" };
    const beta: SocketIdentity = { kind: "agent", name: "beta" };

    // Caller A (alpha, admin) restarts "svc" with a shared idempotency_key.
    const sockA = fakeSocket();
    await internals().handleLine(
      JSON.stringify(restartReq("reqA", "svc", "SHARED")),
      alpha,
      sockA,
    );
    expect(sockA.response().result).toBe("started");
    expect(internals().statusByRequestId.has("reqA")).toBe(true);

    // Caller B (beta, admin) sends the SAME idempotency_key. With caller
    // scoping, B must run its OWN dispatch (record reqB), NOT be short-
    // circuited onto A's cached entry.
    const sockB = fakeSocket();
    await internals().handleLine(
      JSON.stringify(restartReq("reqB", "svc", "SHARED")),
      beta,
      sockB,
    );
    expect(sockB.response().result).toBe("started");
    // The bite: pre-fix, B is served A's cache and never dispatches, so reqB
    // is never recorded. Post-fix, B dispatches and records its own entry.
    expect(internals().statusByRequestId.has("reqB")).toBe(true);
  });

  it("runs the authz gate BEFORE the cache — an unauthorized caller is denied, not served the cache", async () => {
    const alpha: SocketIdentity = { kind: "agent", name: "alpha" };
    const gamma: SocketIdentity = { kind: "agent", name: "gamma" };

    // Caller A (alpha, admin) caches a cross-agent restart of "svc".
    const sockA = fakeSocket();
    await internals().handleLine(
      JSON.stringify(restartReq("reqA", "svc", "SHARED2")),
      alpha,
      sockA,
    );
    expect(sockA.response().result).toBe("started");

    // Caller B (gamma, NON-admin) replays the shared idempotency_key on a
    // cross-agent restart (not self-targeting → requires admin).
    const sockB = fakeSocket();
    await internals().handleLine(
      JSON.stringify(restartReq("reqB", "svc", "SHARED2")),
      gamma,
      sockB,
    );
    const resp = sockB.response();
    // The bite: pre-fix, gamma is handed alpha's cached "started" ahead of the
    // gate. Post-fix, the gate denies gamma before the cache is ever consulted.
    expect(resp.result).toBe("denied");
    expect(String(resp.error ?? "")).toMatch(/admin/i);
    expect(internals().statusByRequestId.has("reqB")).toBe(false);
  });
});
