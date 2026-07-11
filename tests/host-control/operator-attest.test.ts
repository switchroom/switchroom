/**
 * #1841 — operator-passphrase attestation (RFC host-control-daemon.md §5.4).
 *
 * Drives a real hostd UDS server with an INJECTED attestation verifier
 * (`attestVerifier` test seam) so the gate logic is exercised end-to-end
 * without a live vault broker. Assertions are on OUTCOMES: a required verb
 * with the correct passphrase passes; the wrong passphrase is DENIED and
 * writes an audit row tagged `method: "passphrase-attest"`; a required verb
 * with no attestation is denied; non-required verbs are unchanged; and with
 * the feature OFF a forwarded passphrase is ignored entirely.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostdServer,
  type AttestVerifier,
  type ServerConfig,
} from "../../src/host-control/server.js";
import { hostdRequest } from "../../src/host-control/client.js";
import { parseAuditLine } from "../../src/host-control/audit-reader.js";

const GOOD_PASSPHRASE = "correct horse battery staple";

let tmp: string;
let stubBin: string;
let server: HostdServer;
let verifyCalls: string[];

/** Stub verifier: OK iff the forwarded passphrase equals GOOD_PASSPHRASE.
 *  Mirrors the broker's fail-closed mismatch semantics. */
const stubVerifier: AttestVerifier = {
  verify: async (passphrase: string) => {
    verifyCalls.push(passphrase);
    return passphrase === GOOD_PASSPHRASE
      ? { ok: true }
      : { ok: false, reason: "broker denied attestation (DENIED)" };
  },
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "hostd-attest-"));
  stubBin = join(tmp, "switchroom-stub.sh");
  writeFileSync(stubBin, `#!/bin/sh\necho "stub: $@"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
});

afterAll(async () => {
  if (server) await server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

async function startServer(hostd: ServerConfig["hostd"]): Promise<void> {
  if (server) await server.stop();
  verifyCalls = [];
  server = new HostdServer({
    homeDir: tmp,
    agentUids: { klanker: 10001, bob: 10002 },
    config: {
      agents: { klanker: { admin: true }, bob: {} },
      ...(hostd ? { hostd } : {}),
    },
    switchroomBin: stubBin,
    auditLogPath: join(tmp, "audit.log"),
    allowNonLinux: true,
    attestVerifier: stubVerifier,
  });
  await server.start();
  // Truncate the audit log between servers so per-test assertions are clean.
  writeFileSync(join(tmp, "audit.log"), "");
}

function klankerSock(): string {
  return server.getBoundPaths().find((p) => p.endsWith("/klanker/sock"))!;
}

function auditRows() {
  return readFileSync(join(tmp, "audit.log"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(parseAuditLine)
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

describe("hostd operator-attest — feature ON, verb required", () => {
  beforeEach(async () => {
    await startServer({
      operator_attest_enabled: true,
      operator_attest_required_verbs: ["update_apply", "apply", "rollout"],
    });
  });

  it("required verb + correct passphrase → passes the gate", async () => {
    const resp = await hostdRequest(
      { socketPath: klankerSock() },
      {
        v: 1,
        op: "update_apply",
        request_id: "attest-ok",
        operator_passphrase: GOOD_PASSPHRASE,
        args: {},
      },
    );
    expect(resp.result).toBe("started");
    expect(verifyCalls).toEqual([GOOD_PASSPHRASE]);
    const row = auditRows().find((r) => r.request_id === "attest-ok");
    expect(row?.method).toBe("passphrase-attest");
    expect(row?.result).toBe("started");
  });

  it("required verb + WRONG passphrase → denied + audit method row", async () => {
    const resp = await hostdRequest(
      { socketPath: klankerSock() },
      {
        v: 1,
        op: "update_apply",
        request_id: "attest-wrong",
        operator_passphrase: "nope",
        args: {},
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/operator-attest failed/);
    const row = auditRows().find((r) => r.request_id === "attest-wrong");
    expect(row?.result).toBe("denied");
    expect(row?.method).toBe("passphrase-attest");
  });

  it("required verb WITHOUT attestation → denied (no verifier call)", async () => {
    const resp = await hostdRequest(
      { socketPath: klankerSock() },
      { v: 1, op: "update_apply", request_id: "attest-missing", args: {} },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/requires operator-passphrase attestation/);
    expect(verifyCalls).toEqual([]);
    const row = auditRows().find((r) => r.request_id === "attest-missing");
    expect(row?.method).toBe("passphrase-attest");
  });

  it("NEVER persists the passphrase to the audit log", async () => {
    await hostdRequest(
      { socketPath: klankerSock() },
      {
        v: 1,
        op: "update_apply",
        request_id: "attest-noleak",
        operator_passphrase: GOOD_PASSPHRASE,
        args: {},
      },
    );
    const raw = readFileSync(join(tmp, "audit.log"), "utf8");
    expect(raw).not.toContain(GOOD_PASSPHRASE);
  });

  it("non-required verb is unchanged when no attestation is supplied", async () => {
    // agent_restart is NOT in the required set: an admin caller passes
    // with no passphrase and the verifier is never consulted.
    const resp = await hostdRequest(
      { socketPath: klankerSock() },
      {
        v: 1,
        op: "agent_restart",
        request_id: "attest-nonreq",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("started");
    expect(verifyCalls).toEqual([]);
    const row = auditRows().find((r) => r.request_id === "attest-nonreq");
    expect(row?.method).toBeUndefined();
  });

  it("non-required verb with a WRONG passphrase fails closed (accept-and-audit)", async () => {
    const resp = await hostdRequest(
      { socketPath: klankerSock() },
      {
        v: 1,
        op: "agent_restart",
        request_id: "attest-nonreq-bad",
        operator_passphrase: "nope",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(verifyCalls).toEqual(["nope"]);
    const row = auditRows().find((r) => r.request_id === "attest-nonreq-bad");
    expect(row?.method).toBe("passphrase-attest");
  });
});

describe("hostd operator-attest — feature OFF (default posture)", () => {
  beforeEach(async () => {
    await startServer(undefined); // no hostd block at all
  });

  it("required-by-default verb passes WITHOUT attestation (backward compat)", async () => {
    const resp = await hostdRequest(
      { socketPath: klankerSock() },
      { v: 1, op: "update_apply", request_id: "off-noattest", args: {} },
    );
    expect(resp.result).toBe("started");
    expect(verifyCalls).toEqual([]);
    const row = auditRows().find((r) => r.request_id === "off-noattest");
    expect(row?.method).toBeUndefined();
  });

  it("a forwarded passphrase is IGNORED entirely (verifier never called)", async () => {
    const resp = await hostdRequest(
      { socketPath: klankerSock() },
      {
        v: 1,
        op: "update_apply",
        request_id: "off-withattest",
        operator_passphrase: "anything-at-all",
        args: {},
      },
    );
    expect(resp.result).toBe("started");
    expect(verifyCalls).toEqual([]);
  });
});
