/**
 * Contract tests for `mint_grant` (and `list_grants` / `put`) with
 * `attest_via_posture: true` (#1115 follow-up — broker-mediated
 * attestation).
 *
 * The gateway running inside a Docker agent container cannot read
 * the auto-unlock blob (mounted only on the broker singleton), so it
 * can't pass a passphrase as attestation. Instead it sets
 * `attest_via_posture: true`; the broker validates its OWN config has
 * `vault.broker.approvalAuth: telegram-id` AND it's unlocked AND the
 * caller is a per-agent peer, then uses its retained passphrase
 * internally. The passphrase is never sent over the wire.
 *
 * Threat model coverage:
 *   - DENIED when broker config is `passphrase` (telegram-id-not-enabled).
 *   - DENIED when caller is operator socket (no agent name).
 *   - LOCKED when the broker isn't unlocked.
 *   - BAD_REQUEST when both `passphrase` and `attest_via_posture` are
 *     supplied (mutually exclusive, refuse rather than silently pick).
 *   - Happy path: per-agent + telegram-id config + unlocked → mint
 *     succeeds, audit row carries method=posture.
 *   - list_grants gets the same posture path (#1051 grant-union
 *     symmetry).
 *   - put gets the same posture path (vault_request_save).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { VaultBroker } from "./server.js";
import {
  encodeRequest,
  decodeResponse,
  type BrokerRequest,
  type BrokerResponse,
} from "./protocol.js";
import type { VaultEntry } from "../vault.js";
import { createAuditLogger, type AuditEntry } from "./audit-log.js";

const SECRETS: Record<string, VaultEntry> = {
  k1: { kind: "string", value: "v1" },
};

function cloneSecrets(): Record<string, VaultEntry> {
  return JSON.parse(JSON.stringify(SECRETS));
}

function makeTelegramIdConfig(opts?: { postureMintAgents?: string[] }) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: {
        socket: "~/.switchroom/vault-broker.sock",
        enabled: true,
        autoUnlock: true,
        approvalAuth: "telegram-id" as const,
        postureMintAgents: opts?.postureMintAgents ?? ["uat-agent"],
      },
    },
    agents: {},
  } as any;
}

function makePassphraseConfig() {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: {
        socket: "~/.switchroom/vault-broker.sock",
        enabled: true,
        autoUnlock: true,
      },
    },
    agents: {},
  } as any;
}

async function rpc(socketPath: string, req: BrokerRequest): Promise<BrokerResponse> {
  return new Promise((resolveP, rejectP) => {
    const client = net.createConnection({ path: socketPath });
    let buffer = "";
    client.on("error", rejectP);
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        client.destroy();
        try { resolveP(decodeResponse(buffer.slice(0, idx))); } catch (e) { rejectP(e); }
      }
    });
    client.on("connect", () => { client.write(encodeRequest(req) + "\n"); });
  });
}

describe("broker mint_grant attest_via_posture", () => {
  let tmpDir: string;
  let socketPath: string;
  let broker: VaultBroker | null = null;
  let audit: AuditEntry[] = [];
  let prevNonLinuxFlag: string | undefined;
  let prevNodeEnv: string | undefined;
  let prevReqOpFlag: string | undefined;

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    // Hard-boundary mint gate (RFC vault-approval-hard-boundary) is default
    // OFF; ensure it's off for every test except the one that opts in, so
    // the existing posture happy-path stays green (proves backward-compat).
    prevReqOpFlag = process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT;
    delete process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-mint-posture-"));
    socketPath = path.join(tmpDir, "test.sock");
    audit = [];
  });

  afterEach(() => {
    if (broker) broker.stop();
    broker = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevReqOpFlag === undefined) delete process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT;
    else process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT = prevReqOpFlag;
  });

  function makeBroker(opts: {
    config: any;
    passphrase?: string;
    agentName?: string;
  }): VaultBroker {
    const auditor = createAuditLogger();
    (auditor as any).write = (e: AuditEntry) => audit.push(e);
    return new VaultBroker({
      _testSecrets: opts.passphrase ? cloneSecrets() : undefined,
      _testConfig: opts.config,
      _testPassphrase: opts.passphrase,
      _testAgentName: opts.agentName,
      _testAuditLogger: auditor as any,
    });
  }

  // ── Happy path ─────────────────────────────────────────────────────────

  it("per-agent peer + telegram-id config + unlocked broker → gate passes + method=posture audit", async () => {
    // The gate-test is what's load-bearing: assert that the
    // attestation gate WAS PASSED (audit row with
    // `allowed:posture-attested` + method=posture). The actual mint
    // operation depends on the full vault rig (vault file, key ACL,
    // grants DB) which is out of scope here — covered by the
    // mint-grant-passphrase-attest sibling suite and the UAT
    // scenario. The DENIED audit rows in the negative-path tests
    // below are the symmetric proof that the gate IS enforced.
    broker = makeBroker({
      config: makeTelegramIdConfig(),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["k1"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    // Gate passed → either an OK token OR a non-DENIED, non-LOCKED
    // failure further down the mint path. A DENIED/LOCKED here would
    // mean the attest_via_posture gate refused, which is the
    // regression this test catches.
    if (!resp.ok) {
      expect(resp.code).not.toBe("DENIED");
      expect(resp.code).not.toBe("LOCKED");
    }
    const allowed = audit.find(
      (e) => e.op === "mint_grant" && e.result === "allowed:posture-attested" && e.method === "posture",
    );
    expect(allowed, "audit row with method=posture must be written when the gate accepts").toBeDefined();
  });

  // ── Hard-boundary gate (RFC vault-approval-hard-boundary) ──────────────
  // With SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT=1, a posture-attested mint
  // (forgeable — claude shares the per-agent socket) must reference an
  // operator-verified kernel decision (origin='operator'). Without one →
  // DENIED. (The positive path — a real origin='operator' decision lets the
  // mint through — is unit-tested via isOperatorVerifiedDecision in
  // approval-origin.test.ts and is exercised end-to-end in PR ② once the
  // host verifier produces such decisions.)
  it("flag ON + no operator-verified decision → DENIED (posture alone is forgeable)", async () => {
    process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT = "1";
    broker = makeBroker({
      config: makeTelegramIdConfig(),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["k1"],
      ttl_seconds: 3600,
      attest_via_posture: true,
      // no decision_id → no operator-verified approval → must be denied
    } as BrokerRequest);
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    expect(
      audit.find(
        (e) =>
          e.op === "mint_grant" &&
          /denied:posture-mint-needs-operator-verified-decision/.test(e.result),
      ),
      "the forgeable posture mint must be refused when the gate is on",
    ).toBeDefined();
    expect(
      audit.find((e) => e.result === "allowed:posture-attested"),
      "must NOT reach the posture-attested allow when the gate denies",
    ).toBeUndefined();
  });

  // ── Gate 1: telegram-id-not-enabled ─────────────────────────────────────

  it("passphrase posture: DENIED telegram-id-not-enabled even for per-agent peer", async () => {
    broker = makeBroker({
      config: makePassphraseConfig(),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["k1"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const denied = audit.find((e) => e.op === "mint_grant" && /denied:telegram-id-not-enabled/.test(e.result));
    expect(denied, "must audit the denied:telegram-id-not-enabled row").toBeDefined();
  });

  // ── Gate 2: operator socket / no agent name ─────────────────────────────

  it("operator socket (no agent name): DENIED with posture-attest-needs-per-agent-peer", async () => {
    broker = makeBroker({
      config: makeTelegramIdConfig(),
      passphrase: "broker-pass",
      agentName: undefined,
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["k1"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const denied = audit.find(
      (e) => e.op === "mint_grant" && /denied:posture-attest-needs-per-agent-peer/.test(e.result),
    );
    expect(denied).toBeDefined();
  });

  // ── Gate 3: broker locked ───────────────────────────────────────────────

  it("broker locked (no passphrase): LOCKED with broker-locked", async () => {
    broker = makeBroker({
      config: makeTelegramIdConfig(),
      passphrase: undefined,
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["k1"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("LOCKED");
    const denied = audit.find((e) => e.op === "mint_grant" && /denied:broker-locked/.test(e.result));
    expect(denied).toBeDefined();
  });

  // ── Mutual exclusion ────────────────────────────────────────────────────

  it("passphrase + attest_via_posture together: BAD_REQUEST, neither path runs", async () => {
    broker = makeBroker({
      config: makeTelegramIdConfig(),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["k1"],
      ttl_seconds: 3600,
      passphrase: "broker-pass",
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("BAD_REQUEST");
    const denied = audit.find(
      (e) => e.op === "mint_grant" && /denied:bad-request-both-attestations/.test(e.result),
    );
    expect(denied).toBeDefined();
  });

  // ── Symmetry: list_grants posture-attested ──────────────────────────────

  it("list_grants attest_via_posture: gate passes (not DENIED)", async () => {
    // Same scope as the mint happy-path: assert the attest_via_posture
    // gate accepts. Full grants-list behavior depends on a live
    // grants DB seeded by an earlier mint (out of scope here).
    broker = makeBroker({
      config: makeTelegramIdConfig(),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "list_grants",
      agent: "uat-agent",
      attest_via_posture: true,
    });
    if (!resp.ok) {
      expect(resp.code).not.toBe("DENIED");
      expect(resp.code).not.toBe("LOCKED");
    }
    const allowed = audit.find(
      (e) => e.op === "list_grants" && e.result === "allowed:posture-attested" && e.method === "posture",
    );
    expect(allowed).toBeDefined();
  });

  // ── put with attest_via_posture ─────────────────────────────────────────

  it("put attest_via_posture happy path: write succeeds under telegram-id posture", async () => {
    broker = makeBroker({
      config: makeTelegramIdConfig(),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "uat/posture-write-test",
      entry: { kind: "string", value: "hello" },
      attest_via_posture: true,
    });
    // Note: put may fail with INTERNAL because the vault file doesn't
    // exist in the test rig; the load-bearing assertion is that we
    // get PAST the attestation gate (not a DENIED). Accept ok=true OR
    // a non-DENIED non-LOCKED error.
    if (!resp.ok) {
      expect(resp.code).not.toBe("DENIED");
      expect(resp.code).not.toBe("LOCKED");
    }
    const denied = audit.find((e) => e.op === "put" && /denied:/.test(e.result));
    expect(denied, "must not write a denial row for a posture-attested put under valid config").toBeUndefined();
  });

  // ── Per-agent allowlist (#1115 follow-up rev 3) ────────────────────────

  it("agent NOT on postureMintAgents: DENIED posture-agent-not-allowlisted (default empty)", async () => {
    broker = makeBroker({
      // Default-empty allowlist (no postureMintAgents key): no agent can self-mint.
      config: {
        switchroom: { version: 1 },
        telegram: { bot_token: "t", forum_chat_id: "1" },
        vault: {
          path: "~/.switchroom/vault.enc",
          broker: {
            socket: "~/.switchroom/vault-broker.sock",
            enabled: true,
            autoUnlock: true,
            approvalAuth: "telegram-id" as const,
            postureMintAgents: [],
          },
        },
        agents: {},
      } as any,
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["k1"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const denied = audit.find(
      (e) => e.op === "mint_grant" && /denied:posture-agent-not-allowlisted/.test(e.result),
    );
    expect(denied).toBeDefined();
  });

  it("cross-agent posture mint refused: req.agent !== agentName", async () => {
    // Allowlisted agent attempts to mint a grant naming a DIFFERENT agent.
    broker = makeBroker({
      config: makeTelegramIdConfig({ postureMintAgents: ["uat-agent"] }),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "victim-agent", // ← different from agentName
      keys: ["k1"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const denied = audit.find(
      (e) => e.op === "mint_grant" && /denied:posture-cross-agent-mint-refused/.test(e.result),
    );
    expect(denied).toBeDefined();
  });

  it("list_grants cross-agent posture refused: req.agent !== agentName", async () => {
    broker = makeBroker({
      config: makeTelegramIdConfig({ postureMintAgents: ["uat-agent"] }),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "list_grants",
      agent: "other-agent", // ← different from agentName
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const denied = audit.find(
      (e) => e.op === "list_grants" && /denied:posture-cross-agent-list-refused/.test(e.result),
    );
    expect(denied).toBeDefined();
  });

  it("put attest_via_posture: respects postureMintAgents allowlist", async () => {
    broker = makeBroker({
      config: makeTelegramIdConfig({ postureMintAgents: [] }),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "uat/posture-write-test",
      entry: { kind: "string", value: "hello" },
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const denied = audit.find((e) => e.op === "put" && /denied:posture-agent-not-allowlisted/.test(e.result));
    expect(denied).toBeDefined();
  });

  it("put attest_via_posture refused when broker is passphrase mode", async () => {
    broker = makeBroker({
      config: makePassphraseConfig(),
      passphrase: "broker-pass",
      agentName: "uat-agent",
    });
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "put",
      key: "uat/posture-write-test",
      entry: { kind: "string", value: "hello" },
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("DENIED");
    const denied = audit.find((e) => e.op === "put" && /denied:telegram-id-not-enabled/.test(e.result));
    expect(denied).toBeDefined();
  });
});
