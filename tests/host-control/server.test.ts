/**
 * hostd server tests — bring up a real UDS server in a temp dir and
 * drive it via the client. The CLI binary is stubbed by setting
 * `switchroomBin` to a small shell script the test writes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer } from "../../src/host-control/server.js";
import { hostdRequest } from "../../src/host-control/client.js";

let tmp: string;
let server: HostdServer;
let stubBin: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "hostd-test-"));
  // Stub `switchroom` binary — echoes the verb to stdout, exits 0.
  // Test cases that need a non-zero exit override the stub before
  // their call.
  stubBin = join(tmp, "switchroom-stub.sh");
  writeFileSync(stubBin, `#!/bin/sh\necho "stub: $@"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
});

afterAll(async () => {
  if (server) await server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  // Fresh server per test. The previous one (if any) was torn down
  // in afterEach of the prior test via .stop() in a finally.
  if (server) await server.stop();
  server = new HostdServer({
    homeDir: tmp,
    agentUids: { klanker: 10001, bob: 10002 },
    config: {
      agents: {
        klanker: { admin: true },
        bob: {},
      },
    },
    switchroomBin: stubBin,
    auditLogPath: join(tmp, "audit.log"),
    allowNonLinux: true,
  });
  await server.start();
});

describe("hostd server — startup & socket binding", () => {
  it("binds one socket per agent", () => {
    const bound = server.getBoundPaths();
    expect(bound).toHaveLength(2);
    expect(bound.some((p) => p.endsWith("/klanker/sock"))).toBe(true);
    expect(bound.some((p) => p.endsWith("/bob/sock"))).toBe(true);
  });

  it("parent hostd dir and per-agent dirs are 0755 so the operator can traverse", () => {
    // Regression for the silent-bind-mount-skip bug: when the daemon
    // ran the parent dir was created 0o700 (root-only). The compose
    // generator runs as the operator's uid and calls
    // existsSync(<hostdDir>/<agentName>) at apply time — with 0o700
    // root-owned, the operator's uid can't traverse and the
    // existsSync returns false, so compose silently omits the bind
    // mount. Result: agent containers had no /run/switchroom/hostd/
    // <name>/sock and could never reach the daemon. 0o755 fixes the
    // traversal while the socket-level mode (0o660 + chown-to-agent)
    // keeps the actual security boundary intact.
    const parent = join(tmp, ".switchroom", "hostd");
    const klankerDir = join(parent, "klanker");
    const bobDir = join(parent, "bob");
    // & 0o777 to drop the file-type bits and compare just the mode.
    expect(statSync(parent).mode & 0o777).toBe(0o755);
    expect(statSync(klankerDir).mode & 0o777).toBe(0o755);
    expect(statSync(bobDir).mode & 0o777).toBe(0o755);
  });

  it("rebinds on a fresh start after stop (idempotent unlink)", async () => {
    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: stubBin,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    expect(server.getBoundPaths().length).toBe(1);
  });
});

describe("hostd server — verb dispatch", () => {
  it("upgrade_status: returns completed and stdout_tail", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "upgrade_status",
        request_id: "req-1",
      },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    expect(resp.stdout_tail).toContain("stub: update --status");
  });

  it("agent_restart: returns started immediately", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-2",
        args: { name: "klanker" },
      },
    );
    expect(resp.result).toBe("started");
    expect(resp.exit_code).toBeNull();
  });

  it("agent_restart: cross-agent denies for non-admin caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-3",
        // bob is NOT admin; targeting klanker should be denied.
        args: { name: "klanker" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/cross-agent requires admin/);
  });

  it("agent_restart: cross-agent allowed for admin caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-4",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("started");
  });

  it("agent_restart: self-target allowed even for non-admin", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-5",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("started");
  });
});

describe("hostd server — get_status visibility", () => {
  it("returns the original verb's status to its own caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    // Start a verb.
    await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "orig-1",
        args: { name: "klanker" },
      },
    );
    // Wait for the detached run to complete (stub exits ~immediately).
    await new Promise((r) => setTimeout(r, 100));
    // Look up its status.
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "lookup-1",
        args: { target_request_id: "orig-1" },
      },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
  });

  it("returns denied (not-found-shape) to a non-admin agent looking up another agent's request", async () => {
    const klankerSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const bobSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    await hostdRequest(
      { socketPath: klankerSock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "orig-2",
        args: { name: "klanker" },
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    // bob (non-admin) tries to look it up.
    const resp = await hostdRequest(
      { socketPath: bobSock },
      {
        v: 1,
        op: "get_status",
        request_id: "probe-1",
        args: { target_request_id: "orig-2" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/not found or not visible/);
  });

  it("admins can look up any agent's request", async () => {
    const bobSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const klankerSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    await hostdRequest(
      { socketPath: bobSock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "orig-3",
        args: { name: "bob" },
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    const resp = await hostdRequest(
      { socketPath: klankerSock },
      {
        v: 1,
        op: "get_status",
        request_id: "admin-probe-1",
        args: { target_request_id: "orig-3" },
      },
    );
    expect(resp.result).toBe("completed");
  });
});

describe("hostd server — idempotency", () => {
  it("dedupes within the idempotency window", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const args = {
      v: 1 as const,
      op: "agent_restart" as const,
      request_id: "first",
      idempotency_key: "shared-key",
      args: { name: "klanker" },
    };
    const r1 = await hostdRequest({ socketPath: sock }, args);
    const r2 = await hostdRequest(
      { socketPath: sock },
      { ...args, request_id: "second" },
    );
    // Second response either matches first's status (cache hit) OR
    // returns the same started result. Either way the dedupe path
    // must not throw — the response is valid.
    expect(["started", "completed"]).toContain(r2.result);
    // The request_id echoed in the response is the second caller's
    // (echoes what the caller sent in this request).
    expect(r2.request_id).toBe("second");
    void r1;
  });
});

describe("hostd server — DoS guard", () => {
  it("closes the connection if the request exceeds 2x MAX_FRAME_BYTES without a newline", async () => {
    const { connect } = await import("node:net");
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const client = connect(sock);
    // EPIPE is expected once the server destroys the socket and
    // we keep writing; suppress so the test runner doesn't treat
    // it as an unhandled error.
    client.on("error", () => undefined);
    // Write more than 128 KiB (2x MAX_FRAME_BYTES) with no newline.
    // Wait for connect, then write in chunks until either we hit
    // the cap (server closes) or we've exceeded the budget.
    await new Promise<void>((resolve) =>
      client.once("connect", () => resolve()),
    );
    const chunk = "x".repeat(8192);
    let written = 0;
    const closed = new Promise<void>((resolve) =>
      client.once("close", () => resolve()),
    );
    for (let i = 0; i < 32; i++) {
      if (client.destroyed) break;
      try {
        client.write(chunk);
        written += chunk.length;
      } catch {
        break;
      }
    }
    await closed;
    expect(written).toBeGreaterThan(0);
    // We may not have written all 256 KiB before the server
    // destroyed the socket — that's the point. Just verify the
    // server closed us out.
    expect(client.destroyed).toBe(true);
  });
});

describe("hostd server — malformed request handling", () => {
  it("echoes the caller's request_id when present, even on schema failure", async () => {
    const { connect } = await import("node:net");
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const client = connect(sock);
    let buf = "";
    const got = new Promise<string>((resolve) => {
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(buf.slice(0, nl));
      });
    });
    await new Promise<void>((resolve) =>
      client.once("connect", () => resolve()),
    );
    // Valid JSON, wrong schema (missing required `args`).
    client.write(
      JSON.stringify({
        v: 1,
        op: "agent_restart",
        request_id: "caller-echoes-this",
      }) + "\n",
    );
    const line = await got;
    expect(line).toContain('"request_id":"caller-echoes-this"');
    expect(line).toContain('"result":"denied"');
    client.destroy();
  });

  it("falls back to a sentinel request_id on non-JSON input", async () => {
    const { connect } = await import("node:net");
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const client = connect(sock);
    let buf = "";
    const got = new Promise<string>((resolve) => {
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(buf.slice(0, nl));
      });
    });
    await new Promise<void>((resolve) =>
      client.once("connect", () => resolve()),
    );
    client.write("not json at all\n");
    const line = await got;
    expect(line).toContain('"request_id":"malformed-request"');
    expect(line).toContain('"result":"denied"');
    client.destroy();
  });
});

describe("hostd server — audit log", () => {
  it("appends a row per request", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "upgrade_status",
        request_id: "audit-1",
      },
    );
    // Audit write is async; give it a beat.
    await new Promise((r) => setTimeout(r, 50));
    const { readFileSync } = await import("node:fs");
    const audit = readFileSync(join(tmp, "audit.log"), "utf8");
    expect(audit).toContain('"op":"upgrade_status"');
    expect(audit).toContain('"request_id":"audit-1"');
    expect(audit).toContain('"caller":{"kind":"agent","name":"klanker"}');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 2 verbs — RFC §10 (update_check, update_apply, apply,
// agent_start, agent_stop). Same shape as the Phase 1 tests above:
// in-process HostdServer, stub `switchroom` binary, drive each verb
// via hostdRequest and assert the response shape + gate behaviour.
// ──────────────────────────────────────────────────────────────────────

describe("hostd server — Phase 2 read-only verbs", () => {
  it("update_check: returns completed and stdout_tail (any caller allowed)", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!; // bob is NOT admin — proves any-caller gate
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_check", request_id: "uc-1" },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    expect(resp.stdout_tail).toContain("stub: update --check");
  });
});

describe("hostd server — Phase 2 per-agent verbs", () => {
  it("agent_start: self-target allowed even for non-admin", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_start", request_id: "as-1", args: { name: "bob" } },
    );
    expect(resp.result).toBe("completed");
    expect(resp.stdout_tail).toContain("stub: agent start bob");
  });

  it("agent_start: cross-agent denied for non-admin caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_start", request_id: "as-2", args: { name: "klanker" } },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/cross-agent requires admin/);
  });

  it("agent_stop: cross-agent allowed for admin caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!; // klanker IS admin
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_stop",
        request_id: "ast-1",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("completed");
    expect(resp.stdout_tail).toContain("stub: agent stop bob");
    // PR #1208 review (B1): an earlier draft plumbed `args.force →
    // --force`, but `switchroom agent stop` doesn't accept that
    // flag. Assert it isn't there — if a future change reintroduces
    // it, this test catches it and the CLI side gets the flag
    // added in lockstep.
    expect(resp.stdout_tail).not.toContain("--force");
  });
});

describe("hostd server — Phase 2 fleet mutations + lock", () => {
  it("update_apply: requires admin (denied for non-admin caller)", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_apply", request_id: "ua-deny", args: {} },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/update_apply requires admin/);
  });

  it("apply: returns started for admin caller; flags plumbed via argv", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "apply", request_id: "ap-1", args: {} },
    );
    expect(resp.result).toBe("started");
    expect(resp.exit_code).toBeNull();

    // Poll get_status to confirm the async spawn completed against
    // the stub. 100ms cushion is enough — the stub exits immediately.
    await new Promise((r) => setTimeout(r, 100));
    const poll = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "ap-poll",
        args: { target_request_id: "ap-1" },
      },
    );
    expect(poll.result).toBe("completed");
    expect(poll.stdout_tail).toContain("stub: apply --non-interactive");
  });

  it("update_apply: while one is in flight, second is denied with the in-flight request_id", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;

    // Stub a slow `switchroom` so the first call's spawn doesn't
    // finish before the second arrives. Write a stub that sleeps 1s
    // then exits 0, then point the server at it for this test only.
    const slowStub = join(tmp, "switchroom-slow-stub.sh");
    writeFileSync(
      slowStub,
      `#!/bin/sh\nsleep 1\necho "slow stub: $@"\nexit 0\n`,
    );
    chmodSync(slowStub, 0o755);

    // Stand up a fresh server pointing at the slow stub. The shared
    // `server` keeps the fast stub for the rest of the suite.
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: slowStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const fresh = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    try {
      // Fire #1 (will sleep 1s in the spawned stub).
      const first = await hostdRequest(
        { socketPath: fresh },
        { v: 1, op: "update_apply", request_id: "ua-lock-1", args: {} },
      );
      expect(first.result).toBe("started");

      // Fire #2 immediately — lock should still be held.
      const second = await hostdRequest(
        { socketPath: fresh },
        { v: 1, op: "update_apply", request_id: "ua-lock-2", args: {} },
      );
      expect(second.result).toBe("denied");
      expect(second.error).toMatch(/fleet-mutation lock held/);
      // The denial message names the in-flight request_id so the
      // caller can poll get_status on it.
      expect(second.error).toMatch(/ua-lock-1/);

      // A different fleet-mutation verb is ALSO blocked by the same
      // lock (update_apply + apply share it).
      const cross = await hostdRequest(
        { socketPath: fresh },
        { v: 1, op: "apply", request_id: "ua-lock-3", args: {} },
      );
      expect(cross.result).toBe("denied");
      expect(cross.error).toMatch(/fleet-mutation lock held/);

      // Wait out the first call so the lock releases. 1.5s = 1s
      // sleep + 0.5s slack for the .finally() to fire.
      await new Promise((r) => setTimeout(r, 1500));

      // Now a fresh fleet mutation succeeds.
      const after = await hostdRequest(
        { socketPath: fresh },
        { v: 1, op: "apply", request_id: "ua-lock-4", args: {} },
      );
      expect(after.result).toBe("started");
    } finally {
      // afterEach in the next describe restores the standard server.
      // Nothing else to clean up here.
    }
  });

  // ── Phase 3 admin observability — agent_logs / agent_exec ─────────────
  it("agent_logs: shells out to docker and returns stdout_tail (admin cross-agent)", async () => {
    // Swap to a "docker" stub that echoes its argv so we can assert
    // the command line and the response shape.
    const dockerStub = join(tmp, "docker-stub.sh");
    writeFileSync(dockerStub, `#!/bin/sh\necho "docker: $@"\nexit 0\n`);
    chmodSync(dockerStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stubBin,
      dockerBin: dockerStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_logs",
        request_id: "logs-1",
        args: { name: "bob", tail: 50 },
      },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    expect(resp.stdout_tail).toContain("docker: logs --tail 50 switchroom-bob");
  });

  it("agent_logs: cross-agent denied for non-admin caller", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_logs",
        request_id: "logs-deny-1",
        args: { name: "klanker" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/cross-agent requires admin/);
  });

  it("agent_logs: self-target allowed even for non-admin", async () => {
    const dockerStub = join(tmp, "docker-stub2.sh");
    writeFileSync(dockerStub, `#!/bin/sh\necho "docker: $@"\nexit 0\n`);
    chmodSync(dockerStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stubBin,
      dockerBin: dockerStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_logs",
        request_id: "logs-self-1",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("completed");
  });

  it("agent_exec: read-only allowlisted argv runs via docker exec", async () => {
    const dockerStub = join(tmp, "docker-stub3.sh");
    writeFileSync(dockerStub, `#!/bin/sh\necho "docker: $@"\nexit 0\n`);
    chmodSync(dockerStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stubBin,
      dockerBin: dockerStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-1",
        args: { name: "bob", argv: ["ls", "-la", "/state"] },
      },
    );
    expect(resp.result).toBe("completed");
    expect(resp.stdout_tail).toContain(
      "docker: exec switchroom-bob ls -la /state",
    );
  });

  it("agent_exec: non-allowlisted argv[0] is denied with a clear pointer to the deferred scope", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-deny-1",
        // `rm` is not on the read-only allowlist.
        args: { name: "bob", argv: ["rm", "-rf", "/state"] },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/read-only allowlist/);
    expect(resp.error).toMatch(/host_os\.exec/);
  });

  it("agent_exec: cross-agent denied for non-admin caller (regardless of argv legality)", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-deny-2",
        args: { name: "klanker", argv: ["ls", "/"] },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/cross-agent requires admin/);
  });

  it("per-agent verbs (agent_start/agent_stop) are NOT gated by the fleet lock", async () => {
    // Re-create the standard server with the fast stub (the prior
    // test left us on the slow stub). beforeEach should also reset
    // it but make this test self-sufficient.
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stubBin,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    // Fire an apply (acquires the fleet lock briefly — the fast
    // stub completes near-instantly but we send the per-agent verb
    // immediately to assert there's no FLEET-lock blocking it).
    const fleet = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "apply", request_id: "lock-mix-1", args: {} },
    );
    expect(fleet.result).toBe("started");

    // Per-agent verb fires without denial regardless of lock state.
    const peragent = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_start", request_id: "lock-mix-2", args: { name: "bob" } },
    );
    expect(peragent.result).toBe("completed");
  });
});
