/**
 * hostd server tests — bring up a real UDS server in a temp dir and
 * drive it via the client. The CLI binary is stubbed by setting
 * `switchroomBin` to a small shell script the test writes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, statSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HostdServer } from "../../src/host-control/server.js";
import { hostdRequest } from "../../src/host-control/client.js";
import {
  parsePendingRolloutMarker,
  encodePendingRolloutMarker,
  SELF_BUMP_MARKER_FILENAME,
  type PendingRolloutMarker,
} from "../../src/host-control/self-bump.js";

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

describe("hostd server — doctor (read-only, admin-gated)", () => {
  it("doctor: admin caller returns completed with the fleet report", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!; // klanker IS admin
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "doctor", request_id: "doc-ok" },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    expect(resp.stdout_tail).toContain("stub: doctor");
  });

  it("doctor: denied for a non-admin caller (whole-fleet visibility is admin-only)", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!; // bob is NOT admin
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "doctor", request_id: "doc-deny" },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/doctor requires admin/);
  });

  it("doctor: stays `completed` when `switchroom doctor` exits non-zero (findings ≠ dispatch failure)", async () => {
    // `switchroom doctor` exits 1 when it finds failing checks — a
    // *finding*, not a verb-dispatch failure. Unlike update_check
    // (exit≠0 → error) the doctor verb must still return `completed`
    // with the report + the real exit_code so the operator sees
    // "doctor found problems" rather than an opaque error.
    const failStub = join(tmp, "switchroom-doctorfail-stub.sh");
    writeFileSync(failStub, `#!/bin/sh\necho "stub: $@"\necho "  2 ok · 1 warn · 1 fail"\nexit 1\n`);
    chmodSync(failStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: failStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "doctor", request_id: "doc-fail" },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(1);
    expect(resp.stdout_tail).toContain("1 fail");
  });
});

describe("hostd server — agent_exec/agent_logs target must be a configured agent", () => {
  // Security-review finding: handleAgentExec/handleAgentLogs build the
  // docker target as `switchroom-${name}` and shell out to it. checkGate
  // lets an admin caller target ANY name, so without a membership check
  // an admin could exec/log into a SINGLETON service container
  // (vault-broker / approval-kernel / hostd / web) — each root, with the
  // vault store + /etc/machine-id mounted — and read vault key material.
  // The guard rejects any name not in the configured-agent registry
  // (this.opts.agentUids), while self-target and real peers still pass.

  // A docker stub that RECORDS every invocation, so the test can assert
  // the guard short-circuited BEFORE any `docker exec`/`docker logs` ran.
  async function withRecordingDocker(): Promise<string> {
    const invokedLog = join(tmp, `docker-inv-${Math.random().toString(36).slice(2)}.log`);
    const dockerStub = join(tmp, `docker-tgt-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(dockerStub, `#!/bin/sh\necho "$@" >> ${invokedLog}\nexit 0\n`);
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
    // Stash the invocation-log path on the stub name so tests can read it.
    (withRecordingDocker as unknown as { invokedLog: string }).invokedLog = invokedLog;
    return dockerStub;
  }

  it("agent_exec: admin caller targeting the vault-broker singleton is DENIED and never shells out", async () => {
    await withRecordingDocker();
    const invokedLog = (withRecordingDocker as unknown as { invokedLog: string }).invokedLog;
    // klanker IS admin — so this passes checkGate; only the new
    // configured-agent membership guard can stop it.
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-singleton",
        args: { name: "vault-broker", argv: ["cat", "/etc/machine-id"] },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/not a configured agent/);
    // Hard proof no `docker exec` ran against the singleton.
    expect(existsSync(invokedLog)).toBe(false);
  });

  it("agent_logs: admin caller targeting the vault-broker singleton is DENIED and never shells out", async () => {
    await withRecordingDocker();
    const invokedLog = (withRecordingDocker as unknown as { invokedLog: string }).invokedLog;
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_logs",
        request_id: "logs-singleton",
        args: { name: "vault-broker" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/not a configured agent/);
    expect(existsSync(invokedLog)).toBe(false);
  });

  it("agent_exec: self-target (bob→bob, non-admin) still passes the guard and shells out", async () => {
    await withRecordingDocker();
    const invokedLog = (withRecordingDocker as unknown as { invokedLog: string }).invokedLog;
    const sock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-self",
        args: { name: "bob", argv: ["cat", "/state/agent/start.sh"] },
      },
    );
    expect(resp.result).toBe("completed");
    // The guard let it through to the docker shell-out.
    expect(existsSync(invokedLog)).toBe(true);
    expect(readFileSync(invokedLog, "utf8")).toContain("switchroom-bob");
  });

  it("agent_logs: admin targeting a real peer agent (klanker→bob) still passes the guard and shells out", async () => {
    await withRecordingDocker();
    const invokedLog = (withRecordingDocker as unknown as { invokedLog: string }).invokedLog;
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_logs",
        request_id: "logs-peer",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("completed");
    expect(existsSync(invokedLog)).toBe(true);
    expect(readFileSync(invokedLog, "utf8")).toContain("switchroom-bob");
  });
});

describe("hostd server — agent_smoke (read-only in-agent battery)", () => {
  async function withDocker(stubBody: string): Promise<string> {
    const dockerStub = join(tmp, `docker-smoke-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(dockerStub, stubBody);
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
    return dockerStub;
  }

  it("running container, all probes pass → completed, exit 0, every probe ok", async () => {
    await withDocker(
      // exec) models real docker: a literal `--` as the command
      // position (docker exec C -- ...) is exec'd as a binary named
      // "--" → 127. Guards against re-introducing the cargo-culted
      // `docker run`-style `--` (the bug that broke prod, masked
      // because the old stub ignored argv past $1).
      '#!/bin/sh\ncase "$1" in\n  inspect) echo "true"; exit 0 ;;\n  exec) [ "$3" = "--" ] && { echo \'exec: "--": not found\' >&2; exit 127; }; exit 0 ;;\nesac\nexit 0\n',
    );
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_smoke", request_id: "sm-ok", args: { name: "klanker" } },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    const body = JSON.parse(resp.stdout_tail!);
    expect(body.container).toBe("running");
    expect(body.probes.map((p: { name: string }) => p.name).sort()).toEqual(
      ["auth", "bot_token", "mcp", "scheduler", "state", "tzdata"],
    );
    expect(body.probes.every((p: { state: string }) => p.state === "ok")).toBe(true);
  });

  it("probe commands target the real in-agent paths (regression: auth path)", async () => {
    // Pin the probe command STRINGS. Live-verify caught the auth probe
    // checking $CLAUDE_CONFIG_DIR/$HOME (both wrong/empty in-agent) →
    // false "auth FAIL" fleet-wide; the real cred is
    // /state/agent/.claude/.credentials.json. Stub-only tests can't
    // exercise real paths, so assert the literal cmds here.
    const argsLog = join(tmp, `smoke-args-${Math.random().toString(36).slice(2)}.log`);
    await withDocker(
      `#!/bin/sh\ncase "$1" in\n  inspect) echo "true"; exit 0 ;;\n  exec) echo "$@" >> ${argsLog}; exit 0 ;;\nesac\nexit 0\n`,
    );
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_smoke", request_id: "sm-paths", args: { name: "klanker" } },
    );
    const { readFileSync } = await import("node:fs");
    const seen = readFileSync(argsLog, "utf8");
    // auth probe must use the verified real path…
    expect(seen).toContain("/state/agent/.claude/.credentials.json");
    // …and must NOT use the old wrong locations.
    expect(seen).not.toContain("CLAUDE_CONFIG_DIR");
    expect(seen).not.toContain("$HOME/.claude/.credentials.json");
    // other probes still key off /state/agent
    expect(seen).toContain("/state/agent/start.sh");
    expect(seen).toContain("/state/agent/.mcp.json");
    expect(seen).toContain("/state/agent/telegram/.env");
  });

  it("cross-agent denied for a non-admin caller", async () => {
    await withDocker('#!/bin/sh\nexit 0\n');
    const sock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_smoke", request_id: "sm-deny", args: { name: "klanker" } },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/cross-agent requires admin/);
  });

  it("self-target allowed for a non-admin caller", async () => {
    await withDocker(
      // exec) models real docker: a literal `--` as the command
      // position (docker exec C -- ...) is exec'd as a binary named
      // "--" → 127. Guards against re-introducing the cargo-culted
      // `docker run`-style `--` (the bug that broke prod, masked
      // because the old stub ignored argv past $1).
      '#!/bin/sh\ncase "$1" in\n  inspect) echo "true"; exit 0 ;;\n  exec) [ "$3" = "--" ] && { echo \'exec: "--": not found\' >&2; exit 127; }; exit 0 ;;\nesac\nexit 0\n',
    );
    const sock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_smoke", request_id: "sm-self", args: { name: "bob" } },
    );
    expect(resp.result).toBe("completed");
    expect(JSON.parse(resp.stdout_tail!).container).toBe("running");
  });

  it("admin caller targeting the vault-broker singleton is DENIED and never shells out (#3136)", async () => {
    // #3136 defense-in-depth: handleAgentSmoke builds `switchroom-${name}`
    // and shells `docker inspect` / `docker exec` at it. klanker IS admin,
    // so checkGate lets it target ANY name; only the configured-agent
    // membership guard (mirrored from agent_exec/agent_logs) can stop a
    // singleton service container (vault-broker / approval-kernel / …).
    // A recording stub proves the guard short-circuits BEFORE any docker.
    const invokedLog = join(tmp, `smoke-inv-${Math.random().toString(36).slice(2)}.log`);
    await withDocker(`#!/bin/sh\necho "$@" >> ${invokedLog}\nexit 0\n`);
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_smoke",
        request_id: "sm-singleton",
        args: { name: "vault-broker" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/not a configured agent/);
    // Hard proof: no `docker inspect`/`docker exec` ran against the singleton.
    expect(existsSync(invokedLog)).toBe(false);
  });

  it("down container → completed, exit 0, every probe skip (never fail)", async () => {
    await withDocker(
      '#!/bin/sh\ncase "$1" in\n  inspect) echo "false"; exit 0 ;;\nesac\nexit 0\n',
    );
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_smoke", request_id: "sm-down", args: { name: "klanker" } },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    const body = JSON.parse(resp.stdout_tail!);
    expect(body.container).toBe("absent");
    expect(body.probes.every((p: { state: string }) => p.state === "skip")).toBe(true);
  });

  it("a failing probe → completed (NOT error), exit 1, and NO probe stdout leaks", async () => {
    // exec echoes a fake secret then exits 1 — the handler must never
    // surface stdout (probes are exit-code only).
    await withDocker(
      '#!/bin/sh\ncase "$1" in\n  inspect) echo "true"; exit 0 ;;\n  exec) [ "$3" = "--" ] && { echo \'exec: "--": not found\' >&2; exit 127; }; echo "FAKE-SECRET-LEAK-XYZ"; exit 1 ;;\nesac\nexit 0\n',
    );
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "agent_smoke", request_id: "sm-fail", args: { name: "klanker" } },
    );
    expect(resp.result).toBe("completed"); // a finding, not a dispatch error
    expect(resp.exit_code).toBe(1);
    expect(resp.stdout_tail).not.toContain("FAKE-SECRET-LEAK-XYZ");
    const body = JSON.parse(resp.stdout_tail!);
    expect(body.probes.every((p: { state: string }) => p.state === "fail")).toBe(true);
    expect(body.probes.every((p: { detail: string }) => /^exit \d+$/.test(p.detail))).toBe(true);
  });
});

describe("hostd server — operator socket", () => {
  const ENV = "SWITCHROOM_HOSTD_OPERATOR_UID";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  async function freshServer(): Promise<void> {
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
  }

  it("is NOT bound when SWITCHROOM_HOSTD_OPERATOR_UID is unset (legacy/test default)", async () => {
    delete process.env[ENV];
    await freshServer();
    expect(server.getBoundPaths().some((p) => p.endsWith("/operator/sock"))).toBe(false);
  });

  it("is bound when the env is set, and is UNGATED (operator bypasses the admin gate)", async () => {
    process.env[ENV] = String(process.getuid?.() ?? 1000);
    await freshServer();
    const opSock = server.getBoundPaths().find((p) => p.endsWith("/operator/sock"));
    expect(opSock).toBeDefined();

    // `doctor` is admin-gated for agents. From the operator socket it
    // must be allowed (kind:"operator" bypasses checkGate).
    const opResp = await hostdRequest(
      { socketPath: opSock! },
      { v: 1, op: "doctor", request_id: "op-doctor" },
    );
    expect(opResp.result).toBe("completed");

    // Same verb from the non-admin `bob` per-agent socket → denied.
    // Proves the operator socket is genuinely a different (ungated)
    // identity, not just "any socket works".
    const bobSock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const bobResp = await hostdRequest(
      { socketPath: bobSock },
      { v: 1, op: "doctor", request_id: "bob-doctor" },
    );
    expect(bobResp.result).toBe("denied");
  });

  it("skips the operator listener on an invalid (non-positive) env value", async () => {
    process.env[ENV] = "not-a-number";
    await freshServer();
    expect(server.getBoundPaths().some((p) => p.endsWith("/operator/sock"))).toBe(false);
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

  it("update_apply: writes a durable terminal audit row with stderr_tail on subprocess failure (#22)", async () => {
    // The whole point of #22: a failed fleet mutation must be
    // diagnosable from the on-disk audit log ALONE, because hostd's
    // in-memory status map is wiped on every container recreate
    // (which `switchroom update`'s refresh-hostd step does on every
    // run). Before #22 the stderr lived only in the status map and
    // the audit log carried just result/exit_code.
    // Token-shaped fixture built at runtime so the source file never
    // contains a contiguous secret literal (repo push-protection).
    const fakeToken =
      "sk-ant-oat01-" + "A".repeat(40) + "-" + "B".repeat(40) + "-fakeAA";
    const failStub = join(tmp, "switchroom-fail-stub.sh");
    writeFileSync(
      failStub,
      `#!/bin/sh\necho "stdout breadcrumb"\n` +
        // Simulate a stack trace that dumped a config object carrying
        // a credential — the realistic secret-leak vector for
        // switchroom apply/update.
        `echo "switchroom apply failed: EACCES /state/agent/start.sh" 1>&2\n` +
        `echo "  ctx: { oauthToken: '${fakeToken}' }" 1>&2\n` +
        `exit 1\n`,
    );
    chmodSync(failStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: failStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;

    const started = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_apply", request_id: "ua-term-1", args: {} },
    );
    expect(started.result).toBe("started");

    // Let the spawn finish + the .finally() terminal-audit write land.
    await new Promise((r) => setTimeout(r, 800));

    const { readFileSync } = await import("node:fs");
    const rows = readFileSync(join(tmp, "audit.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const terminal = rows.find(
      (r) => r.request_id === "ua-term-1" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.result).toBe("error");
    expect(terminal!.exit_code).toBe(1);
    // Non-secret diagnostic context survives.
    expect(String(terminal!.stderr_tail)).toContain("EACCES /state/agent/start.sh");
    expect(String(terminal!.stdout_tail)).toContain("stdout breadcrumb");
    // SECURITY (PR #1351 review blocker): the token-shaped secret in
    // the stub's stderr must be REDACTED before it hits the durable
    // log — admin agents can read this file :ro via /audit hostd.
    expect(String(terminal!.stderr_tail)).not.toContain(fakeToken);
    expect(String(terminal!.stderr_tail)).toContain("[REDACTED");
    // The synchronous request-path row is still there too (started)
    // and — critically — carries NO output tails (generic writeAudit
    // never persists them; only the fleet-mutation terminal path does).
    const startedRow = rows.find(
      (r) => r.request_id === "ua-term-1" && r.phase === undefined,
    );
    expect(startedRow).toBeDefined();
    expect(startedRow!.result).toBe("started");
    expect(startedRow!.stdout_tail).toBeUndefined();
    expect(startedRow!.stderr_tail).toBeUndefined();
  });

  it("generic writeAudit (agent_exec / agent_logs) never persists output tails — secrets stay out of the durable log (#1351)", async () => {
    // Regression guard for the PR #1351 review blocker: an admin
    // running `agent_exec cat .../credentials.json` must NOT get the
    // token written to the audit file. agent_exec returns a
    // stdout_tail on the response, but writeAudit deliberately drops
    // it from the persisted row.
    const dockerStub = join(tmp, "docker-secret-stub.sh");
    const fakeCred =
      "sk-ant-oat01-" + "C".repeat(40) + "-" + "D".repeat(40) + "-fakeBB";
    writeFileSync(
      dockerStub,
      `#!/bin/sh\necho '{"claudeAiOauth":{"accessToken":"${fakeCred}"}}'\nexit 0\n`,
    );
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
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;

    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-secret-1",
        args: { name: "klanker", argv: ["cat", "/state/agent/.claude/credentials.json"] },
      },
    );
    // The caller's response frame may carry the tail (that's the
    // existing, accepted trust boundary — admin === root proxy).
    expect(resp.result).toBe("completed");
    await new Promise((r) => setTimeout(r, 80));

    const { readFileSync } = await import("node:fs");
    const auditRaw = readFileSync(join(tmp, "audit.log"), "utf8");
    // The durable log must NOT contain the credential, and the
    // agent_exec row must carry no stdout_tail field at all.
    expect(auditRaw).not.toContain(fakeCred);
    const execRow = auditRaw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.request_id === "exec-secret-1");
    expect(execRow).toBeDefined();
    expect(execRow!.stdout_tail).toBeUndefined();
    expect(execRow!.stderr_tail).toBeUndefined();
  });

  // ── #2487 rollout (safe staggered canary fleet roll) ─────────────────
  it("rollout: requires admin (denied for non-admin caller)", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-deny", args: { pin: "v0.15.18" } },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/rollout requires admin/);
  });

  it("rollout: rejects a sha- pin at wire decode (semver-only)", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      // sha pin is a valid update_apply pin but NOT a valid rollout pin.
      { v: 1, op: "rollout", request_id: "ro-sha", args: { pin: "sha-abc1234" } } as never,
    );
    // Wire schema rejects it before dispatch → denied bad-request.
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/bad request/);
  });

  it("rollout: returns started for admin, spawns with --pin + SWITCHROOM_HOSTD_CONTEXT", async () => {
    // Stub that records its env + argv so we can prove the context
    // sentinel + flags are plumbed, and emits the structured sentinel.
    const recStub = join(tmp, "switchroom-rollout-stub.sh");
    const recOut = join(tmp, "rollout-rec.txt");
    writeFileSync(
      recStub,
      `#!/bin/sh\n` +
        `echo "argv: $@" >> "${recOut}"\n` +
        `echo "ctx: $SWITCHROOM_HOSTD_CONTEXT" >> "${recOut}"\n` +
        // Emit the structured result sentinel the daemon parses.
        `echo 'Rolling 2 agents…'\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["test-harness","klanker"],"warnings":["hostd/web refresh deferred"]}'\n` +
        `exit 0\n`,
    );
    chmodSync(recStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: recStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    const started = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "rollout",
        request_id: "ro-ok",
        args: { pin: "v0.15.18", agents: ["test-harness", "klanker"] },
      },
    );
    expect(started.result).toBe("started");
    expect(started.exit_code).toBeNull();

    await new Promise((r) => setTimeout(r, 300));

    const { readFileSync } = await import("node:fs");
    const rec = readFileSync(recOut, "utf8");
    // --pin + --agents plumbed; SWITCHROOM_HOSTD_CONTEXT set on the child.
    expect(rec).toContain("argv: rollout --pin v0.15.18 --agents test-harness,klanker");
    expect(rec).toContain("ctx: 1");

    // get_status surfaces the STRUCTURED outcome via `payload`, not a tail.
    const poll = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "ro-poll",
        args: { target_request_id: "ro-ok" },
      },
    );
    expect(poll.result).toBe("completed");
    expect(poll.payload).toBeDefined();
    const payload = JSON.parse(poll.payload!);
    expect(payload.rolled).toEqual(["test-harness", "klanker"]);

    // Terminal audit row carries the structured rolled[] too.
    const rows = readFileSync(join(tmp, "audit.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminal = rows.find(
      (r) => r.request_id === "ro-ok" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.op).toBe("rollout");
    expect(terminal!.rolled).toEqual(["test-harness", "klanker"]);
  });

  it("rollout: a FAILED canary surfaces failed_agent in the terminal row + status", async () => {
    const failStub = join(tmp, "switchroom-rollout-fail-stub.sh");
    writeFileSync(
      failStub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":false,"rolled":[],"failedStep":"restart-agent","failedAgent":"test-harness","got":"0.15.17","warnings":[]}'\n` +
        `exit 1\n`,
    );
    chmodSync(failStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: failStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-fail", args: { pin: "v0.15.18" } },
    );
    await new Promise((r) => setTimeout(r, 300));

    const poll = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "ro-fail-poll",
        args: { target_request_id: "ro-fail" },
      },
    );
    expect(poll.result).toBe("error");
    const payload = JSON.parse(poll.payload!);
    expect(payload.failedAgent).toBe("test-harness");
    expect(payload.failedStep).toBe("restart-agent");

    const { readFileSync } = await import("node:fs");
    const terminal = readFileSync(join(tmp, "audit.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.request_id === "ro-fail" && r.phase === "terminal");
    expect(terminal!.failed_agent).toBe("test-harness");
    expect(terminal!.failed_step).toBe("restart-agent");
  });

  it("rollout: shares the fleet-mutation lock with update_apply/apply", async () => {
    const slowStub = join(tmp, "switchroom-rollout-slow.sh");
    writeFileSync(slowStub, `#!/bin/sh\nsleep 1\nexit 0\n`);
    chmodSync(slowStub, 0o755);
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
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    const first = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-lock-1", args: { pin: "v0.15.18" } },
    );
    expect(first.result).toBe("started");

    // A concurrent update_apply is blocked by the SAME shared lock.
    const blocked = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_apply", request_id: "ro-lock-2", args: {} },
    );
    expect(blocked.result).toBe("denied");
    expect(blocked.error).toMatch(/fleet-mutation lock held/);
    expect(blocked.error).toMatch(/ro-lock-1/);

    await new Promise((r) => setTimeout(r, 1500));
  });

  it("rollout: forwards --allow-downgrade to the spawned CLI argv when set", async () => {
    // Mirror the existing argv-assertion pattern: stub records its argv
    // to a file, then we assert --allow-downgrade is present.
    const recStub = join(tmp, "switchroom-rollout-downgrade-stub.sh");
    const recOut = join(tmp, "rollout-downgrade-rec.txt");
    writeFileSync(
      recStub,
      `#!/bin/sh\n` +
        `echo "argv: $@" >> "${recOut}"\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(recStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: recStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "rollout",
        request_id: "ro-downgrade",
        args: { pin: "v0.15.16", allow_downgrade: true },
      },
    );
    await new Promise((r) => setTimeout(r, 300));

    const { readFileSync } = await import("node:fs");
    const rec = readFileSync(recOut, "utf8");
    expect(rec).toContain("--allow-downgrade");
    expect(rec).toContain("--pin v0.15.16");
  });

  it("rollout: does NOT include --allow-downgrade in argv when omitted (default path)", async () => {
    const recStub = join(tmp, "switchroom-rollout-nod-stub.sh");
    const recOut = join(tmp, "rollout-nod-rec.txt");
    writeFileSync(
      recStub,
      `#!/bin/sh\n` +
        `echo "argv: $@" >> "${recOut}"\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(recStub, 0o755);
    await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: recStub,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "rollout",
        request_id: "ro-nod",
        args: { pin: "v0.15.18" },
      },
    );
    await new Promise((r) => setTimeout(r, 300));

    const { readFileSync } = await import("node:fs");
    const rec = readFileSync(recOut, "utf8");
    expect(rec).not.toContain("--allow-downgrade");
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
    // NO `--`: `docker exec` stops parsing its own options at
    // CONTAINER, so caller argv after the container name can't be
    // reparsed as a docker flag (the #1401 concern doesn't apply to
    // `docker exec`). A literal `--` would be exec'd as a binary
    // named "--" → 127, which silently broke every real agent_exec
    // until this fix (the old stub ignored argv past $1 so tests
    // never caught it). This pins the corrected invocation.
    expect(resp.stdout_tail).toContain(
      "docker: exec switchroom-bob ls -la /state",
    );
    expect(resp.stdout_tail).not.toContain(" -- ");
  });

  it("agent_exec: argv element with a newline/NUL/CR is denied (#1401)", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-ctrl-1",
        // argv[0] is allowlisted; the smuggle is in a later element.
        args: { name: "bob", argv: ["cat", "/state\n--privileged"] },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/control character/);
    expect(resp.error).toMatch(/#1401/);
  });

  // #1400 target 3 — completes the WS5 per-element charclass finding:
  // #1401 only blocked NUL/LF/CR. ESC (U+001B) and the other C0
  // controls let a (now approval-gated, but still prompt-injectable)
  // admin agent smuggle ANSI escape sequences into the operator-facing
  // `switchroom audit hostd` trail. They must be rejected too.
  it("agent_exec: argv element with ESC / other C0 control is denied (#1400 target 3)", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-esc-1",
        // ESC + an SGR sequence. No NUL/LF/CR, so #1401
        // alone would have passed it. ESC byte built at
        // runtime so no source-level escape mangling can
        // weaken the test.
        args: {
          name: "bob",
          argv: ["grep", `${String.fromCharCode(27)}[31mpwned`, "/x"],
        },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/control character/);
    expect(resp.error).toMatch(/#1400/);
  });

  it("agent_exec: an over-long argv element is denied (#1400 target 3)", async () => {
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_exec",
        request_id: "exec-long-1",
        // 4097 bytes — one past MAX_EXEC_ARGV_ELEMENT_BYTES (4096).
        args: { name: "bob", argv: ["cat", "/".padEnd(4097, "a")] },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/exceeds 4096 bytes/);
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

describe("hostd server — apply-asset preflight (klanker incident)", () => {
  async function freshServer(applyAssetsRoot: string): Promise<HostdServer> {
    if (server) await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stubBin,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
      applyAssetsRoot,
    });
    await server.start();
    return server;
  }
  const adminSock = () =>
    server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

  it("update_apply: REFUSES (denied, nothing spawned) when apply assets are missing", async () => {
    const bare = join(tmp, "assets-missing"); // no profiles/ or vendor/
    mkdirSync(bare, { recursive: true });
    await freshServer(bare);
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "update_apply", request_id: "pf-ua", args: {} },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/missing apply-time assets/);
    expect(resp.error).toContain(join(bare, "profiles"));
    expect(resp.error).toMatch(/Nothing was pulled or changed/);
    expect(resp.error).toMatch(/switchroom update/);
    // Denied ⇒ spawnFleetMutation never ran: no status entry exists.
    const poll = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "get_status", request_id: "pf-poll", args: { target_request_id: "pf-ua" } },
    );
    expect(poll.result).not.toBe("started");
  });

  it("apply: also refused when assets missing (shared preflight)", async () => {
    const bare = join(tmp, "assets-missing-2");
    mkdirSync(bare, { recursive: true });
    await freshServer(bare);
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "apply", request_id: "pf-ap", args: {} },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/missing apply-time assets/);
  });

  it("update_apply: PROCEEDS when profiles/default + vendor/hindsight-memory are present", async () => {
    const ok = join(tmp, "assets-ok");
    mkdirSync(join(ok, "profiles", "default"), { recursive: true });
    mkdirSync(join(ok, "vendor", "hindsight-memory"), { recursive: true });
    mkdirSync(join(ok, "skills"), { recursive: true });
    await freshServer(ok);
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "update_apply", request_id: "pf-ok", args: {} },
    );
    // Preflight passes → proceeds to spawn the stub → "started".
    expect(resp.result).toBe("started");
  });

  it("partial assets (profiles present, vendor missing) still refuses, naming the gap", async () => {
    const partial = join(tmp, "assets-partial");
    mkdirSync(join(partial, "profiles", "default"), { recursive: true });
    await freshServer(partial);
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "update_apply", request_id: "pf-partial", args: {} },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toContain(join(partial, "vendor", "hindsight-memory"));
    expect(resp.error).not.toContain(join(partial, "profiles") + ",");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dashboard read-ops (dockerless-web fix): the agent_status /
// agent_schedule verbs. Unlike the other e2e verbs above (which only
// shell the stub CLI), these LOAD a real config — so this block stands up
// its own server with `configPath` pointing at a tmp switchroom.yaml.
//
// ISOLATION: the overlay loader resolves `schedule.d` under
// `$HOME/.switchroom/agents/<name>/` (resolveDualPath → process.env.HOME),
// NOT under config.agents_dir — so this block ALSO overrides HOME to a
// tmpdir. Both `SWITCHROOM_AGENTS_DIR` (resolveAgentsDir, the scheduler
// ledger path) and HOME (the overlay tree) point at the SAME isolated
// `<roTmp>/.switchroom/agents` so NOTHING reads/writes the operator's
// real ~/.switchroom. (Verified: without the HOME override the loader
// EACCES'd on the operator's real 0600 overlay files — exactly the
// production bug this verb fixes, but a test must never touch live state.)
//
// Proves: dispatch wiring, the operator-ungated/agent-admin gate, the
// `payload` round-trip, agent_schedule's recent-fire read against a real
// scheduler.jsonl, AND that a schedule.d overlay cron is merged in (the
// load-bearing fix — fresh loadConfig sees the overlay the base config
// lacks).
// ─────────────────────────────────────────────────────────────────────
describe("hostd server — dashboard read-ops (agent_status / agent_schedule)", () => {
  let roTmp: string;
  let roServer: HostdServer;
  let agentsDir: string;
  let savedAgentsDir: string | undefined;
  let savedHome: string | undefined;

  beforeAll(async () => {
    roTmp = mkdtempSync(join(tmpdir(), "hostd-readops-"));
    // The agents tree lives under <roTmp>/.switchroom/agents so the
    // overlay loader (HOME-rooted) and the ledger reader (agents_dir-
    // rooted) resolve to the SAME isolated location.
    agentsDir = join(roTmp, ".switchroom", "agents");
    const cfgPath = join(roTmp, "switchroom.yaml");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      cfgPath,
      [
        "switchroom:",
        "  version: 1",
        `  agents_dir: "${agentsDir}"`,
        "telegram:",
        '  bot_token: "x"',
        '  forum_chat_id: "1"',
        "agents:",
        "  klanker:",
        "    topic_name: Klanker",
        "    schedule:",
        '      - cron: "*/30 * * * *"',
        `        prompt: "${"p".repeat(300)}"`,
        "  bob:",
        "    topic_name: Bob",
      ].join("\n") + "\n",
    );
    // Seed a scheduler.jsonl with > 8 fires + a long outputSummary so the
    // bound payload exercises both truncation paths.
    mkdirSync(join(agentsDir, "klanker"), { recursive: true });
    // Fires must carry the base cron's REAL promptKey (sha256(prompt) prefix,
    // as collectScheduleEntries computes it) so boundScheduleView's
    // current-cron filter keeps them — fires for a key no current cron owns
    // are dropped as obsolete.
    const baseKey = createHash("sha256").update("p".repeat(300)).digest("hex").slice(0, 12);
    const rows = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({
        agent: "klanker",
        scheduleIndex: 0,
        promptKey: baseKey,
        exitCode: 0,
        outputSummary: i === 11 ? "s".repeat(300) : "ok",
        startedAt: 1747300000000 + i,
        finishedAt: 1747300000500 + i,
      }),
    );
    writeFileSync(join(agentsDir, "klanker", "scheduler.jsonl"), rows.join("\n") + "\n");

    // The agent-authored overlay cron the base config doesn't carry —
    // this is what the operator/web (uid 1000) can't read (0600, agent-
    // owned) but hostd (root) can. Asserting it surfaces proves the fix.
    mkdirSync(join(agentsDir, "klanker", "schedule.d"), { recursive: true });
    writeFileSync(
      join(agentsDir, "klanker", "schedule.d", "cron-overlay.yaml"),
      ["schedule:", '  - cron: "0 9 * * *"', '    prompt: "overlay standup"'].join("\n") + "\n",
    );

    savedAgentsDir = process.env.SWITCHROOM_AGENTS_DIR;
    savedHome = process.env.HOME;
    process.env.SWITCHROOM_AGENTS_DIR = agentsDir;
    process.env.HOME = roTmp;

    roServer = new HostdServer({
      homeDir: roTmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stubBin,
      auditLogPath: join(roTmp, "audit.log"),
      allowNonLinux: true,
      configPath: cfgPath,
    });
    await roServer.start();
  });

  afterAll(async () => {
    if (roServer) await roServer.stop();
    if (savedAgentsDir === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = savedAgentsDir;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(roTmp, { recursive: true, force: true });
  });

  const adminSock = () =>
    roServer.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
  const nonAdminSock = () =>
    roServer.getBoundPaths().find((p) => p.endsWith("/bob/sock"))!;

  it("agent_status: returns completed with a JSON payload of fleet statuses", async () => {
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "agent_status", request_id: "ro-st-1", args: {} },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    expect(resp.payload).toBeDefined();
    const parsed = JSON.parse(resp.payload!) as {
      statuses: Record<string, { uptime: string | null; memory: string | null }>;
    };
    // Both configured agents appear (docker may be absent → uptime null,
    // which is exactly the dockerless-web case this backfill serves).
    expect(Object.keys(parsed.statuses).sort()).toEqual(["bob", "klanker"]);
  });

  it("agent_status: narrows to one agent when name is given", async () => {
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "agent_status", request_id: "ro-st-2", args: { name: "klanker" } },
    );
    const parsed = JSON.parse(resp.payload!) as { statuses: Record<string, unknown> };
    expect(Object.keys(parsed.statuses)).toEqual(["klanker"]);
  });

  it("agent_status: cross-agent / fleet view denied for a non-admin agent", async () => {
    const resp = await hostdRequest(
      { socketPath: nonAdminSock() },
      { v: 1, op: "agent_status", request_id: "ro-st-3", args: {} },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/requires admin/);
  });

  it("agent_status: self-target allowed for a non-admin agent", async () => {
    const resp = await hostdRequest(
      { socketPath: nonAdminSock() },
      { v: 1, op: "agent_status", request_id: "ro-st-4", args: { name: "bob" } },
    );
    expect(resp.result).toBe("completed");
    const parsed = JSON.parse(resp.payload!) as { statuses: Record<string, unknown> };
    expect(Object.keys(parsed.statuses)).toEqual(["bob"]);
  });

  it("agent_schedule: returns the cron entries + bounded recent fires", async () => {
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "agent_schedule", request_id: "ro-sc-1", args: {} },
    );
    expect(resp.result).toBe("completed");
    const parsed = JSON.parse(resp.payload!) as {
      entries: Array<{ agent: string; cron: string; prompt?: string }>;
      recentByAgent: Record<string, Array<{ outputSummary: string }>>;
    };
    const klEntries = parsed.entries.filter((e) => e.agent === "klanker");
    const baseEntry = klEntries.find((e) => e.cron === "*/30 * * * *")!;
    expect(baseEntry).toBeDefined();
    // Prompt truncated to the 160-char cap (was seeded at 300).
    expect(baseEntry.prompt).toHaveLength(160);
    // The fix: the agent-authored schedule.d overlay cron — readable by
    // hostd (root) but not the dockerless web (0600, agent-owned) — is
    // merged in by the FRESH loadConfig. Without it the dashboard misses
    // crons the agent actually fires.
    expect(klEntries.some((e) => e.cron === "0 9 * * *")).toBe(true);
    // Last 8 fires only; the newest fire's long summary truncated to 100.
    expect(parsed.recentByAgent.klanker).toHaveLength(8);
    expect(parsed.recentByAgent.klanker.at(-1)!.outputSummary).toHaveLength(100);
  });

  it("agent_schedule: filters to one agent when name is given", async () => {
    const resp = await hostdRequest(
      { socketPath: adminSock() },
      { v: 1, op: "agent_schedule", request_id: "ro-sc-2", args: { name: "klanker" } },
    );
    const parsed = JSON.parse(resp.payload!) as { entries: Array<{ agent: string }> };
    expect(parsed.entries.every((e) => e.agent === "klanker")).toBe(true);
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it("agent_schedule: fleet view denied for a non-admin agent", async () => {
    const resp = await hostdRequest(
      { socketPath: nonAdminSock() },
      { v: 1, op: "agent_schedule", request_id: "ro-sc-3", args: {} },
    );
    expect(resp.result).toBe("denied");
  });
});

// ── #2487 item 7 — orphaned-`started`-row reconcile guard on boot ─────────
describe("hostd server — orphaned-started-row reconcile (#2487)", () => {
  let otmp: string;
  let ostub: string;
  let auditPath: string;

  function seedRow(row: Record<string, unknown>): void {
    appendFileSync(auditPath, JSON.stringify(row) + "\n");
  }

  function readRows(): Record<string, unknown>[] {
    return readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  beforeEach(() => {
    otmp = mkdtempSync(join(tmpdir(), "hostd-orphan-"));
    ostub = join(otmp, "stub.sh");
    writeFileSync(ostub, `#!/bin/sh\nexit 0\n`);
    chmodSync(ostub, 0o755);
    auditPath = join(otmp, "audit.log");
  });

  afterEach(async () => {
    if (server) await server.stop();
    rmSync(otmp, { recursive: true, force: true });
  });

  async function bootServer(): Promise<void> {
    server = new HostdServer({
      homeDir: otmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: ostub,
      auditLogPath: auditPath,
      allowNonLinux: true,
    });
    await server.start();
  }

  it("emits a rollout_orphaned terminal row for a stale rollout `started` with no terminal", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago
    seedRow({
      ts: old,
      op: "rollout",
      caller: { kind: "agent", name: "klanker" },
      request_id: "orphan-1",
      result: "started",
      exit_code: null,
      duration_ms: 0,
    });

    await bootServer();

    const synth = readRows().find(
      (r) => r.request_id === "orphan-1" && r.phase === "orphan_reconciled",
    );
    expect(synth).toBeDefined();
    expect(synth!.op).toBe("rollout_orphaned");
    expect(synth!.result).toBe("error");
    expect(synth!.original_op).toBe("rollout");
  });

  it("emits update_failed for a stale update_apply orphan", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedRow({
      ts: old,
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "orphan-ua",
      result: "started",
      exit_code: null,
      duration_ms: 0,
    });

    await bootServer();

    const synth = readRows().find(
      (r) => r.request_id === "orphan-ua" && r.phase === "orphan_reconciled",
    );
    expect(synth).toBeDefined();
    expect(synth!.op).toBe("update_failed");
  });

  it("does NOT flag a started row that already has a terminal row", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedRow({
      ts: old,
      op: "rollout",
      caller: { kind: "agent", name: "klanker" },
      request_id: "done-1",
      result: "started",
      exit_code: null,
      duration_ms: 0,
    });
    seedRow({
      ts: old,
      op: "rollout",
      phase: "terminal",
      caller: { kind: "agent", name: "klanker" },
      request_id: "done-1",
      result: "completed",
      exit_code: 0,
      duration_ms: 1000,
    });

    await bootServer();

    const synth = readRows().find(
      (r) => r.request_id === "done-1" && r.phase === "orphan_reconciled",
    );
    expect(synth).toBeUndefined();
  });

  it("does NOT flag a started row that is too fresh (< 15m)", async () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString(); // 1m ago
    seedRow({
      ts: recent,
      op: "rollout",
      caller: { kind: "agent", name: "klanker" },
      request_id: "fresh-1",
      result: "started",
      exit_code: null,
      duration_ms: 0,
    });

    await bootServer();

    const synth = readRows().find(
      (r) => r.request_id === "fresh-1" && r.phase === "orphan_reconciled",
    );
    expect(synth).toBeUndefined();
  });

  it("is idempotent — a second boot does NOT re-emit for an already-reconciled orphan", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedRow({
      ts: old,
      op: "rollout",
      caller: { kind: "agent", name: "klanker" },
      request_id: "orphan-idem",
      result: "started",
      exit_code: null,
      duration_ms: 0,
    });

    await bootServer();
    await server.stop();
    await bootServer(); // second boot

    const synthRows = readRows().filter(
      (r) => r.request_id === "orphan-idem" && r.phase === "orphan_reconciled",
    );
    expect(synthRows).toHaveLength(1); // exactly one, not two
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2458 — update_apply hostd-context deferral
//
// Asserts: (1) SWITCHROOM_HOSTD_CONTEXT=1 is injected for update_apply
//          (2) `apply` does NOT get that env var
//          (3) a child emitting the deferral sentinel populates
//              StatusEntry.deferred and surfaces in get_status payload
// ─────────────────────────────────────────────────────────────────────────────
describe("hostd server — update_apply hostd-context deferral (#2458)", () => {
  /** Set up a server whose switchroomBin echoes its env/argv to a recording
   *  file and optionally emits a deferral sentinel. Returns the admin socket
   *  path and the recording-file path. */
  async function freshDeferralServer(opts: {
    emitSentinel?: boolean;
    sentinelOk?: boolean;
    deferred?: string[];
  } = {}): Promise<{ sock: string; recOut: string; assets: string }> {
    if (server) await server.stop();

    // Create apply-time assets so the preflight doesn't deny the request.
    // These dirs don't need to be executable, so they live in the test tmpdir.
    const assets = join(tmp, `assets-deferral-${Date.now()}`);
    mkdirSync(join(assets, "profiles", "default"), { recursive: true });
    mkdirSync(join(assets, "vendor", "hindsight-memory"), { recursive: true });
    mkdirSync(join(assets, "skills"), { recursive: true });

    // The stub SCRIPT and its recording file must live on a filesystem that
    // allows exec — /tmp is noexec in this container, but /var/tmp is exec.
    const execTmp = mkdtempSync(join("/var/tmp", "hostd-deferral-"));
    const recOut = join(execTmp, `rec.txt`);
    const deferred = opts.deferred ?? ["refresh-hostd", "refresh-web"];
    const sentinel =
      opts.emitSentinel !== false
        ? `SWITCHROOM_UPDATE_RESULT:${JSON.stringify({ ok: opts.sentinelOk ?? true, deferred })}`
        : "";

    const recStub = join(execTmp, `stub.sh`);
    writeFileSync(
      recStub,
      `#!/bin/sh\n` +
        `echo "argv: $@" >> "${recOut}"\n` +
        `echo "ctx: $SWITCHROOM_HOSTD_CONTEXT" >> "${recOut}"\n` +
        (sentinel ? `echo '${sentinel}'\n` : "") +
        `exit 0\n`,
    );
    chmodSync(recStub, 0o755);

    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: recStub,
      auditLogPath: join(tmp, "audit.log"),
      applyAssetsRoot: assets,
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
    return { sock, recOut, assets };
  }

  it("update_apply: spawns child with SWITCHROOM_HOSTD_CONTEXT=1", async () => {
    const { sock, recOut } = await freshDeferralServer();

    const started = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_apply", request_id: "ua-ctx-1", args: {} },
    );
    expect(started.result).toBe("started");

    await new Promise((r) => setTimeout(r, 300));

    const rec = readFileSync(recOut, "utf8");
    // The stub echoes "ctx: $SWITCHROOM_HOSTD_CONTEXT" — must be "1".
    expect(rec).toContain("ctx: 1");
    expect(rec).toContain("argv: update");
  });

  it("apply: does NOT inject SWITCHROOM_HOSTD_CONTEXT", async () => {
    const { sock, recOut } = await freshDeferralServer({ emitSentinel: false });

    const started = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "apply", request_id: "ap-ctx-1", args: {} },
    );
    expect(started.result).toBe("started");

    await new Promise((r) => setTimeout(r, 300));

    const rec = readFileSync(recOut, "utf8");
    // For `apply`, SWITCHROOM_HOSTD_CONTEXT must NOT be "1" (env var absent → empty).
    expect(rec).not.toContain("ctx: 1");
  });

  it("sentinel parsed from child stdout populates StatusEntry.deferred in get_status payload", async () => {
    const { sock } = await freshDeferralServer({
      emitSentinel: true,
      sentinelOk: true,
      deferred: ["refresh-hostd", "refresh-web"],
    });

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_apply", request_id: "ua-sent-1", args: {} },
    );
    await new Promise((r) => setTimeout(r, 300));

    const poll = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "ua-sent-poll",
        args: { target_request_id: "ua-sent-1" },
      },
    );
    expect(poll.result).toBe("completed");
    expect(poll.payload).toBeDefined();
    const payload = JSON.parse(poll.payload!) as { deferred: string[] };
    expect(payload.deferred).toContain("refresh-hostd");
    expect(payload.deferred).toContain("refresh-web");
  });

  it("deferred list also appears in the terminal audit row", async () => {
    const { sock } = await freshDeferralServer({
      emitSentinel: true,
      sentinelOk: true,
      deferred: ["refresh-hostd", "refresh-web"],
    });

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_apply", request_id: "ua-audit-1", args: {} },
    );
    await new Promise((r) => setTimeout(r, 300));

    const rows = readFileSync(join(tmp, "audit.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminal = rows.find(
      (r) => r.request_id === "ua-audit-1" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.deferred).toEqual(["refresh-hostd", "refresh-web"]);
  });

  it("no sentinel → no payload.deferred (non-hostd-context update_apply)", async () => {
    const { sock } = await freshDeferralServer({ emitSentinel: false });

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "update_apply", request_id: "ua-nosent-1", args: {} },
    );
    await new Promise((r) => setTimeout(r, 300));

    const poll = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "ua-nosent-poll",
        args: { target_request_id: "ua-nosent-1" },
      },
    );
    expect(poll.result).toBe("completed");
    // No deferred steps → either no payload or payload without deferred.
    if (poll.payload) {
      const payload = JSON.parse(poll.payload!) as Record<string, unknown>;
      expect(payload.deferred).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BONUS: rollout `got`-field gap (#2458)
//
// The ROLLOUT_RESULT sentinel includes `got` (actual version on the failed
// agent) but spawnRollout was previously dropping it. Assert the fix:
// `got` appears in the get_status payload AND the terminal audit row.
// ─────────────────────────────────────────────────────────────────────────────
describe("hostd server — rollout got-field gap fix (BONUS #2458)", () => {
  it("got field from sentinel appears in get_status payload and terminal audit", async () => {
    // failStub must be executable — use /var/tmp (not /tmp which is noexec in this container)
    const execTmpBonus = mkdtempSync(join("/var/tmp", "hostd-bonus-rollout-"));
    const failStub = join(execTmpBonus, "stub.sh");
    writeFileSync(
      failStub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":false,"rolled":[],"failedStep":"restart-agent","failedAgent":"canary","got":"0.15.17","warnings":[]}'\n` +
        `exit 1\n`,
    );
    chmodSync(failStub, 0o755);

    const assets = join(tmp, `assets-rollout-got-${Date.now()}`);
    mkdirSync(join(assets, "profiles", "default"), { recursive: true });
    mkdirSync(join(assets, "vendor", "hindsight-memory"), { recursive: true });
    mkdirSync(join(assets, "skills"), { recursive: true });

    if (server) await server.stop();
    server = new (await import("../../src/host-control/server.js")).HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: failStub,
      auditLogPath: join(tmp, "audit.log"),
      applyAssetsRoot: assets,
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-got-1", args: { pin: "v0.15.18" } },
    );
    await new Promise((r) => setTimeout(r, 300));

    const poll = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "ro-got-poll",
        args: { target_request_id: "ro-got-1" },
      },
    );
    expect(poll.result).toBe("error");
    expect(poll.payload).toBeDefined();
    const payload = JSON.parse(poll.payload!) as { failedAgent: string; got: string };
    // BONUS: `got` must be in the payload.
    expect(payload.failedAgent).toBe("canary");
    expect(payload.got).toBe("0.15.17");

    const rows = readFileSync(join(tmp, "audit.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminal = rows.find(
      (r) => r.request_id === "ro-got-1" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    // BONUS: `got` must also be in the durable audit row.
    expect(terminal!.got).toBe("0.15.17");
    expect(terminal!.failed_agent).toBe("canary");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2726 — durable rollout observability + terminal push + narration seam.
//
// The rollout subprocess emits SWITCHROOM_ROLLOUT_PHASE: sentinel lines on
// stdout; hostd (the SOLE audit writer) streams them and appends a durable,
// hash-chained phase row per transition. get_status surfaces the live phase,
// and a fire-and-forget relay pushes ONE ordinary operator-DM message on the
// terminal row.
// ─────────────────────────────────────────────────────────────────────────────
describe("hostd server — rollout phase observability (#2726)", () => {
  function mkAssets(): string {
    const assets = join(tmp, `assets-phase-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(assets, "profiles", "default"), { recursive: true });
    mkdirSync(join(assets, "vendor", "hindsight-memory"), { recursive: true });
    mkdirSync(join(assets, "skills"), { recursive: true });
    return assets;
  }

  it("persists a durable audit row per phase, then a terminal row", async () => {
    const execTmp = mkdtempSync(join("/var/tmp", "hostd-phase-"));
    const stub = join(execTmp, "stub.sh");
    // Emit a realistic phase sequence, then the terminal RESULT sentinel.
    writeFileSync(
      stub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"apply","target":"v0.15.18"}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"canary-start","target":"v0.15.18","agent":"klanker","n":1,"m":2}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"canary-pass","target":"v0.15.18","agent":"klanker","n":1,"m":2}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"agent-start","target":"v0.15.18","agent":"bob","n":2,"m":2}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"agent-done","target":"v0.15.18","agent":"bob","n":2,"m":2}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker","bob"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(stub, 0o755);

    if (server) await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stub,
      auditLogPath: join(tmp, "audit-phase.log"),
      applyAssetsRoot: mkAssets(),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-phase-1", args: { pin: "v0.15.18" } },
    );
    await new Promise((r) => setTimeout(r, 400));

    const rows = readFileSync(join(tmp, "audit-phase.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.request_id === "ro-phase-1");

    // A durable phase row exists for each transition.
    const phases = rows.filter((r) => r.op === "rollout" && r.result === "started" && r.phase !== undefined && r.phase !== "terminal");
    const phaseNames = phases.map((r) => r.phase);
    expect(phaseNames).toContain("apply");
    expect(phaseNames).toContain("canary-start");
    expect(phaseNames).toContain("canary-pass");
    expect(phaseNames).toContain("agent-start");
    expect(phaseNames).toContain("agent-done");

    // Phase rows carry pin + n/m + agent per the observability contract.
    const canaryStart = phases.find((r) => r.phase === "canary-start")!;
    expect(canaryStart.pin).toBe("v0.15.18");
    expect(canaryStart.n).toBe(1);
    expect(canaryStart.m).toBe(2);
    expect(canaryStart.agent).toBe("klanker");

    // The terminal row is written AND is distinct from every phase row.
    const terminal = rows.find((r) => r.phase === "terminal");
    expect(terminal).toBeDefined();
    expect(terminal!.result).toBe("completed");
    // No phase row used the literal "terminal" — a phase can't masquerade as it.
    expect(phaseNames).not.toContain("terminal");

    rmSync(execTmp, { recursive: true, force: true });
  });

  it("get_status surfaces the CURRENT phase while the roll is in flight", async () => {
    const execTmp = mkdtempSync(join("/var/tmp", "hostd-phase-inflight-"));
    const stub = join(execTmp, "stub.sh");
    // Emit an early phase, then sleep so the roll is still in flight when we poll.
    writeFileSync(
      stub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"canary-start","target":"v0.15.18","agent":"klanker","n":1,"m":3}'\n` +
        `sleep 1\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(stub, 0o755);

    if (server) await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stub,
      auditLogPath: join(tmp, "audit-inflight.log"),
      applyAssetsRoot: mkAssets(),
      allowNonLinux: true,
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-inflight-1", args: { pin: "v0.15.18" } },
    );
    // Poll WHILE the stub is sleeping (phase emitted, terminal not yet).
    await new Promise((r) => setTimeout(r, 300));
    const poll = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "get_status", request_id: "poll-inflight", args: { target_request_id: "ro-inflight-1" } },
    );
    expect(poll.result).toBe("started");
    expect(poll.payload).toBeDefined();
    const payload = JSON.parse(poll.payload!) as { phase: string; n: number; m: number; agent: string; pin: string };
    expect(payload.phase).toBe("canary-start");
    expect(payload.n).toBe(1);
    expect(payload.m).toBe(3);
    expect(payload.agent).toBe("klanker");
    expect(payload.pin).toBe("v0.15.18");

    await new Promise((r) => setTimeout(r, 1200)); // let it finish
    rmSync(execTmp, { recursive: true, force: true });
  });

  it("fires the terminal relay push exactly once, with a rendered message", async () => {
    const execTmp = mkdtempSync(join("/var/tmp", "hostd-relay-"));
    const stub = join(execTmp, "stub.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker","bob"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(stub, 0o755);

    const pushes: { requestId: string; agentName: string; text: string }[] = [];

    if (server) await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stub,
      auditLogPath: join(tmp, "audit-relay.log"),
      applyAssetsRoot: mkAssets(),
      allowNonLinux: true,
      rolloutRelay: {
        postTerminal: (n) => pushes.push(n),
      },
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-relay-1", args: { pin: "v0.15.18" } },
    );
    await new Promise((r) => setTimeout(r, 400));

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.requestId).toBe("ro-relay-1");
    expect(pushes[0]!.agentName).toBe("klanker"); // routed through the caller agent
    expect(pushes[0]!.text).toContain("✅");
    expect(pushes[0]!.text).toContain("v0.15.18");

    rmSync(execTmp, { recursive: true, force: true });
  });

  it("a relay that throws does NOT fail the roll (fire-and-forget)", async () => {
    const execTmp = mkdtempSync(join("/var/tmp", "hostd-relay-throw-"));
    const stub = join(execTmp, "stub.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(stub, 0o755);

    if (server) await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stub,
      auditLogPath: join(tmp, "audit-relay-throw.log"),
      applyAssetsRoot: mkAssets(),
      allowNonLinux: true,
      rolloutRelay: {
        postTerminal: () => {
          throw new Error("gateway down");
        },
      },
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-relay-throw-1", args: { pin: "v0.15.18" } },
    );
    await new Promise((r) => setTimeout(r, 400));

    // The roll still completed (terminal row written), despite the relay throw.
    const poll = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "get_status", request_id: "poll-throw", args: { target_request_id: "ro-relay-throw-1" } },
    );
    expect(poll.result).toBe("completed");

    rmSync(execTmp, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2726 Part 2 — the narration renderer is FED each phase + the terminal by
// hostd (the tail-and-render seam lives in hostd). Wire a fake narrator and
// assert it receives the phases in order and the terminal, without blocking.
// ─────────────────────────────────────────────────────────────────────────────
describe("hostd server — rollout narrator feed (#2726 Part 2)", () => {
  it("feeds the narrator every phase, in order, then the terminal", async () => {
    const execTmp = mkdtempSync(join("/var/tmp", "hostd-narrator-"));
    const stub = join(execTmp, "stub.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"apply","target":"v0.15.18"}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"canary-start","target":"v0.15.18","agent":"klanker","n":1,"m":2}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"canary-pass","target":"v0.15.18","agent":"klanker","n":1,"m":2}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"agent-done","target":"v0.15.18","agent":"bob","n":2,"m":2}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker","bob"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(stub, 0o755);

    const assets = join(tmp, `assets-narrator-${Date.now()}`);
    mkdirSync(join(assets, "profiles", "default"), { recursive: true });
    mkdirSync(join(assets, "vendor", "hindsight-memory"), { recursive: true });
    mkdirSync(join(assets, "skills"), { recursive: true });

    const seenPhases: string[] = [];
    let terminalResult: string | null = null;

    if (server) await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stub,
      auditLogPath: join(tmp, "audit-narrator.log"),
      applyAssetsRoot: assets,
      allowNonLinux: true,
      rolloutNarrator: {
        onPhase: (_e, p) => seenPhases.push(p.phase),
        onTerminal: (e) => {
          terminalResult = e.result;
        },
      },
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-narr-1", args: { pin: "v0.15.18" } },
    );
    await new Promise((r) => setTimeout(r, 400));

    expect(seenPhases).toEqual(["apply", "canary-start", "canary-pass", "agent-done"]);
    expect(terminalResult).toBe("completed");

    rmSync(execTmp, { recursive: true, force: true });
  });

  it("a narrator that throws in onPhase does NOT fail the roll", async () => {
    const execTmp = mkdtempSync(join("/var/tmp", "hostd-narrator-throw-"));
    const stub = join(execTmp, "stub.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\n` +
        `echo 'SWITCHROOM_ROLLOUT_PHASE:{"phase":"apply","target":"v0.15.18"}'\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["klanker"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(stub, 0o755);

    const assets = join(tmp, `assets-narrator-throw-${Date.now()}`);
    mkdirSync(join(assets, "profiles", "default"), { recursive: true });
    mkdirSync(join(assets, "vendor", "hindsight-memory"), { recursive: true });
    mkdirSync(join(assets, "skills"), { recursive: true });

    if (server) await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: stub,
      auditLogPath: join(tmp, "audit-narrator-throw.log"),
      applyAssetsRoot: assets,
      allowNonLinux: true,
      rolloutNarrator: {
        onPhase: () => {
          throw new Error("narrator boom");
        },
        onTerminal: () => {
          throw new Error("narrator terminal boom");
        },
      },
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-narr-throw-1", args: { pin: "v0.15.18" } },
    );
    await new Promise((r) => setTimeout(r, 400));

    const poll = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "get_status", request_id: "poll-nt", args: { target_request_id: "ro-narr-throw-1" } },
    );
    // The roll completed despite the narrator throwing on every callback.
    expect(poll.result).toBe("completed");

    rmSync(execTmp, { recursive: true, force: true });
  });
});

// ── #2645 — hostd self-bump on stale-CLI rollout ─────────────────────────────
describe("hostd self-bump (#2645)", () => {
  const composeSeed = [
    "services:",
    "  hostd:",
    "    image: ghcr.io/switchroom/switchroom-hostd:v0.16.0",
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock",
    "",
  ].join("\n");

  const hostdDir = () => join(tmp, ".switchroom", "hostd");
  const composePath = () => join(hostdDir(), "docker-compose.yml");
  const markerPath = () => join(hostdDir(), SELF_BUMP_MARKER_FILENAME);

  /** Recording docker stub: appends argv to `rec`; behavior per-verb via
   *  the baked-in exit codes. */
  function writeDockerStub(opts: {
    rec: string;
    manifestExit?: number;
    runExit?: number;
    waitCode?: number;
  }): string {
    const p = join(tmp, `docker-stub-${createHash("sha1").update(opts.rec).digest("hex").slice(0, 8)}.sh`);
    writeFileSync(
      p,
      `#!/bin/sh\n` +
        `echo "docker: $@" >> "${opts.rec}"\n` +
        `case "$1" in\n` +
        `  manifest) exit ${opts.manifestExit ?? 0} ;;\n` +
        `  rm) exit 0 ;;\n` +
        `  run) echo cid; exit ${opts.runExit ?? 0} ;;\n` +
        `  wait) echo ${opts.waitCode ?? 0}; exit 0 ;;\n` +
        `esac\n` +
        `exit 0\n`,
    );
    chmodSync(p, 0o755);
    return p;
  }

  afterEach(() => {
    // Test 1 deliberately leaves a marker (prod deletes it at resume);
    // scrub it so the NEXT test's beforeEach server.start() can't resume
    // a stale roll against the default stub. Same for compose + baks.
    rmSync(markerPath(), { force: true });
    rmSync(composePath(), { force: true });
    for (const f of readdirSync(hostdDir())) {
      if (f.startsWith("docker-compose.yml.bak-selfbump-")) {
        rmSync(join(hostdDir(), f), { force: true });
      }
    }
  });

  it("a pin newer than hostd's CLI begins a self-bump: tag-bump + marker + detached helper, answers started", async () => {
    writeFileSync(composePath(), composeSeed);
    const dockerRec = join(tmp, "selfbump-docker-1.txt");
    const cliRec = join(tmp, "selfbump-cli-1.txt");
    const cliStub = join(tmp, "selfbump-cli-stub-1.sh");
    writeFileSync(cliStub, `#!/bin/sh\necho "argv: $@" >> "${cliRec}"\nexit 0\n`);
    chmodSync(cliStub, 0o755);

    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001, bob: 10002 },
      config: { agents: { klanker: { admin: true }, bob: {} } },
      switchroomBin: cliStub,
      dockerBin: writeDockerStub({ rec: dockerRec }),
      auditLogPath: join(tmp, "audit-selfbump-1.log"),
      allowNonLinux: true,
      selfVersion: "0.16.0",
      hostHomeDir: "/host/op",
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "rollout",
        request_id: "ro-sb-1",
        args: { pin: "v0.16.5", agents: ["test-harness", "klanker"], skip_web: true },
      },
    );
    expect(resp.result).toBe("started");
    const payload = JSON.parse(resp.payload!);
    expect(payload.phase).toBe("self-bump");
    expect(payload.note).toContain("resumes");
    expect(payload.note).toContain("do NOT re-issue");

    // Compose tag-bumped in place, backup written.
    expect(readFileSync(composePath(), "utf8")).toContain(
      "image: ghcr.io/switchroom/switchroom-hostd:v0.16.5",
    );
    expect(
      readdirSync(hostdDir()).some((f) =>
        f.startsWith("docker-compose.yml.bak-selfbump-"),
      ),
    ).toBe(true);

    // Marker carries everything the new hostd needs to resume.
    const marker = parsePendingRolloutMarker(readFileSync(markerPath(), "utf8"));
    expect(marker).toMatchObject({
      request_id: "ro-sb-1",
      pin: "v0.16.5",
      agents: ["test-harness", "klanker"],
      skip_web: true,
      caller: { kind: "agent", name: "klanker" },
      prior_hostd_version: "0.16.0",
    });

    // Helper spawned detached with host-path mounts; target image
    // existence probed first.
    const dockerCalls = readFileSync(dockerRec, "utf8");
    expect(dockerCalls).toContain(
      "manifest inspect ghcr.io/switchroom/switchroom-hostd:v0.16.5",
    );
    expect(dockerCalls).toContain("run -d --rm --name switchroom-hostd-selfbump");
    expect(dockerCalls).toContain(
      "-v /host/op/.switchroom/hostd:/host/op/.switchroom/hostd",
    );
    // The helper runs from the OLD (guaranteed-local) image so `run -d`
    // returns fast; the target is only fetched by its `compose pull`.
    const runLine = dockerCalls
      .split("\n")
      .find((l) => l.includes("run -d --rm"))!;
    expect(runLine).toContain(
      "/bin/sh ghcr.io/switchroom/switchroom-hostd:v0.16.0 -c",
    );
    // The rollout CLI child was NOT spawned — the roll resumes post-recreate.
    expect(existsSync(cliRec)).toBe(false);

    // Durable self-bump phase row under the SAME request_id.
    const rows = readFileSync(join(tmp, "audit-selfbump-1.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      rows.some(
        (r) =>
          r.op === "rollout" && r.phase === "self-bump" && r.request_id === "ro-sb-1",
      ),
    ).toBe(true);

    // Fleet-mutation lock held through the blip: a second roll is denied.
    const second = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-sb-1b", args: { pin: "v0.16.5" } },
    );
    expect(second.result).toBe("denied");
    expect(second.error).toContain("fleet-mutation lock");
  });

  it("refuses cleanly (nothing changed) when the target image is not pullable yet", async () => {
    writeFileSync(composePath(), composeSeed);
    const dockerRec = join(tmp, "selfbump-docker-2.txt");
    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: stubBin,
      dockerBin: writeDockerStub({ rec: dockerRec, manifestExit: 1 }),
      auditLogPath: join(tmp, "audit-selfbump-2.log"),
      allowNonLinux: true,
      selfVersion: "0.16.0",
      hostHomeDir: "/host/op",
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-sb-2", args: { pin: "v0.16.5" } },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toContain("not pullable");
    // Nothing changed: compose still on the old tag, no marker.
    expect(readFileSync(composePath(), "utf8")).toContain("v0.16.0");
    expect(existsSync(markerPath())).toBe(false);
  });

  it("rolls the bump back when the helper container fails to spawn", async () => {
    writeFileSync(composePath(), composeSeed);
    const dockerRec = join(tmp, "selfbump-docker-3.txt");
    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: stubBin,
      dockerBin: writeDockerStub({ rec: dockerRec, runExit: 1 }),
      auditLogPath: join(tmp, "audit-selfbump-3.log"),
      allowNonLinux: true,
      selfVersion: "0.16.0",
      hostHomeDir: "/host/op",
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-sb-3", args: { pin: "v0.16.5" } },
    );
    expect(resp.result).toBe("error");
    expect(resp.error).toContain("self-bump helper");
    // Rolled back: compose restored, marker removed.
    expect(readFileSync(composePath(), "utf8")).toContain("v0.16.0");
    expect(existsSync(markerPath())).toBe(false);
    // Terminal error row landed for the request.
    const rows = readFileSync(join(tmp, "audit-selfbump-3.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminal = rows.find(
      (r) => r.request_id === "ro-sb-3" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.result).toBe("error");
    // Lock released — a follow-up roll isn't lock-denied.
    const retry = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-sb-3b", args: { pin: "v0.16.5" } },
    );
    expect(retry.error ?? "").not.toContain("fleet-mutation lock");
  });

  it("watcher rolls the bump back when the HELPER (pull/up) fails after spawning", async () => {
    // The helper spawns fine but its pull/compose script fails — the
    // container exits nonzero (the script PROPAGATES the failure; a
    // trailing bare echo would mask it as 0), `docker wait` reports it,
    // and the still-alive old hostd restores the compose, deletes the
    // marker, releases the lock and writes a loud terminal row instead of
    // leaving the caller polling a perpetual `started`.
    writeFileSync(composePath(), composeSeed);
    const dockerRec = join(tmp, "selfbump-docker-3w.txt");
    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: stubBin,
      dockerBin: writeDockerStub({ rec: dockerRec, waitCode: 1 }),
      auditLogPath: join(tmp, "audit-selfbump-3w.log"),
      allowNonLinux: true,
      selfVersion: "0.16.0",
      hostHomeDir: "/host/op",
    });
    await server.start();
    const sock = server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;

    const resp = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-sb-3w", args: { pin: "v0.16.5" } },
    );
    // The spawn itself succeeded, so the caller still gets `started`…
    expect(resp.result).toBe("started");
    await new Promise((r) => setTimeout(r, 400));

    // …but the watcher then observed the failure and rolled everything back.
    expect(readFileSync(composePath(), "utf8")).toContain("v0.16.0");
    expect(readFileSync(composePath(), "utf8")).not.toContain("v0.16.5");
    expect(existsSync(markerPath())).toBe(false);
    const rows = readFileSync(join(tmp, "audit-selfbump-3w.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminal = rows.find(
      (r) => r.request_id === "ro-sb-3w" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.result).toBe("error");
    expect(String(terminal!.error)).toContain("helper failed");
    // Lock released — a follow-up roll isn't lock-denied.
    const retry = await hostdRequest(
      { socketPath: sock },
      { v: 1, op: "rollout", request_id: "ro-sb-3wb", args: { pin: "v0.16.5" } },
    );
    expect(retry.error ?? "").not.toContain("fleet-mutation lock");
  });

  it("boot resume relaunches the roll under the SAME request_id and deletes the marker", async () => {
    const cliRec = join(tmp, "selfbump-cli-4.txt");
    const cliStub = join(tmp, "selfbump-cli-stub-4.sh");
    writeFileSync(
      cliStub,
      `#!/bin/sh\n` +
        `echo "argv: $@" >> "${cliRec}"\n` +
        `echo "ctx: $SWITCHROOM_HOSTD_CONTEXT" >> "${cliRec}"\n` +
        `echo 'SWITCHROOM_ROLLOUT_RESULT:{"ok":true,"rolled":["test-harness","klanker"],"warnings":[]}'\n` +
        `exit 0\n`,
    );
    chmodSync(cliStub, 0o755);
    const marker: PendingRolloutMarker = {
      v: 1,
      request_id: "ro-sb-resume",
      pin: "v0.16.5",
      agents: ["test-harness", "klanker"],
      skip_web: true,
      caller: { kind: "agent", name: "klanker" },
      created_at: new Date().toISOString(),
      prior_hostd_version: "0.16.0",
    };
    writeFileSync(markerPath(), encodePendingRolloutMarker(marker));

    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: cliStub,
      auditLogPath: join(tmp, "audit-selfbump-4.log"),
      allowNonLinux: true,
      selfVersion: "0.16.5", // now ON the target — resume proceeds
      hostHomeDir: "/host/op",
    });
    await server.start();
    await new Promise((r) => setTimeout(r, 400));

    // Marker consumed; roll relaunched with the marker's exact args.
    expect(existsSync(markerPath())).toBe(false);
    const rec = readFileSync(cliRec, "utf8");
    expect(rec).toContain(
      "argv: rollout --pin v0.16.5 --agents test-harness,klanker --skip-web",
    );
    expect(rec).toContain("ctx: 1");

    const rows = readFileSync(join(tmp, "audit-selfbump-4.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      rows.some(
        (r) =>
          r.op === "rollout" &&
          r.phase === "self-bump-done" &&
          r.request_id === "ro-sb-resume",
      ),
    ).toBe(true);
    const terminal = rows.find(
      (r) => r.request_id === "ro-sb-resume" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.result).toBe("completed");
    expect(terminal!.rolled).toEqual(["test-harness", "klanker"]);
    // Caller identity survived the recreate (drives get_status gating + DM push).
    expect(terminal!.caller).toEqual({ kind: "agent", name: "klanker" });
  });

  it("boot resume with a STALE marker terminal-errors without spawning", async () => {
    const cliRec = join(tmp, "selfbump-cli-5.txt");
    const cliStub = join(tmp, "selfbump-cli-stub-5.sh");
    writeFileSync(cliStub, `#!/bin/sh\necho "argv: $@" >> "${cliRec}"\nexit 0\n`);
    chmodSync(cliStub, 0o755);
    const marker: PendingRolloutMarker = {
      v: 1,
      request_id: "ro-sb-stale",
      pin: "v0.16.5",
      caller: { kind: "agent", name: "klanker" },
      created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      prior_hostd_version: "0.16.0",
    };
    writeFileSync(markerPath(), encodePendingRolloutMarker(marker));

    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: cliStub,
      auditLogPath: join(tmp, "audit-selfbump-5.log"),
      allowNonLinux: true,
      selfVersion: "0.16.5",
      hostHomeDir: "/host/op",
    });
    await server.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(existsSync(markerPath())).toBe(false);
    expect(existsSync(cliRec)).toBe(false); // no roll spawned
    const rows = readFileSync(join(tmp, "audit-selfbump-5.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminal = rows.find(
      (r) => r.request_id === "ro-sb-stale" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.result).toBe("error");
    expect(terminal!.failed_step).toBe("self-bump");
  });

  it("boot resume terminal-errors when hostd is STILL older than the pin (helper failed)", async () => {
    const cliRec = join(tmp, "selfbump-cli-6.txt");
    const cliStub = join(tmp, "selfbump-cli-stub-6.sh");
    writeFileSync(cliStub, `#!/bin/sh\necho "argv: $@" >> "${cliRec}"\nexit 0\n`);
    chmodSync(cliStub, 0o755);
    const marker: PendingRolloutMarker = {
      v: 1,
      request_id: "ro-sb-stillstale",
      pin: "v0.16.5",
      caller: { kind: "agent", name: "klanker" },
      created_at: new Date().toISOString(),
      prior_hostd_version: "0.16.0",
    };
    writeFileSync(markerPath(), encodePendingRolloutMarker(marker));

    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: cliStub,
      auditLogPath: join(tmp, "audit-selfbump-6.log"),
      allowNonLinux: true,
      selfVersion: "0.16.0", // STILL stale — bump never landed
      hostHomeDir: "/host/op",
    });
    await server.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(existsSync(markerPath())).toBe(false);
    expect(existsSync(cliRec)).toBe(false);
    const rows = readFileSync(join(tmp, "audit-selfbump-6.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminal = rows.find(
      (r) => r.request_id === "ro-sb-stillstale" && r.phase === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.result).toBe("error");
    expect(String(terminal!.error)).toContain("hostd install");
  });

  it("a malformed marker is dropped without resuming (and without crashing boot)", async () => {
    const cliRec = join(tmp, "selfbump-cli-7.txt");
    const cliStub = join(tmp, "selfbump-cli-stub-7.sh");
    writeFileSync(cliStub, `#!/bin/sh\necho "argv: $@" >> "${cliRec}"\nexit 0\n`);
    chmodSync(cliStub, 0o755);
    writeFileSync(markerPath(), "{not json");

    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: cliStub,
      auditLogPath: join(tmp, "audit-selfbump-7.log"),
      allowNonLinux: true,
      selfVersion: "0.16.5",
      hostHomeDir: "/host/op",
    });
    await server.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(existsSync(markerPath())).toBe(false);
    expect(existsSync(cliRec)).toBe(false);
    expect(server.getBoundPaths().length).toBe(1); // boot completed normally
  });
});
