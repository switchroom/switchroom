/**
 * Integration tests for `vault.broker.adminOnlyKeys` enforcement on the
 * broker's posture-attested `mint_grant` path.
 *
 * Contract (see `src/vault/admin-only-keys.ts` + `docs/vault.md`):
 *   - A posture-attested mint may RETAIN an admin-only key the agent
 *     already holds (the gateway unions a newly-approved key with the
 *     agent's existing grant on re-mint) but may NEVER ADD a new one.
 *   - Adding an admin-only key requires the operator passphrase, which
 *     an agent (sharing the per-agent socket with the gateway) cannot
 *     forge. Surface-independent: also blocks an agent crafting raw
 *     broker protocol.
 *   - Non-admin-only keys are unaffected; default `[]` is a no-op.
 *
 * Mirrors the isolation discipline of the sibling
 * `server-mint-grant-posture-attest.test.ts`: tmp socket, in-memory
 * grants DB, audit captured in-process — never the production tree.
 *
 * The broker is left LOCKED (no `_testPassphrase`). The admin-only gate
 * runs in the posture branch BEFORE the broker-locked check (and long
 * before the actual mint + `.vault-token` write), so:
 *   - a blocked admin-only ADD is DENIED here (the gate fires first);
 *   - a permitted case falls through to a LOCKED response — proving it
 *     PASSED the admin-only gate without ever minting or writing a token
 *     into `~/.switchroom/agents/` (which an unlocked broker would do).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import {
  encodeRequest,
  decodeResponse,
  type BrokerRequest,
  type BrokerResponse,
} from "./protocol.js";
import { mintGrant, migrateGrantsSchema } from "../grants.js";
import { createAuditLogger, type AuditEntry } from "./audit-log.js";

function makeConfig(adminOnlyKeys: string[]) {
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
        postureMintAgents: ["uat-agent"],
        adminOnlyKeys,
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

const ADMIN_ONLY_DENIAL = "denied:posture-mint-admin-only-key";

describe("broker mint_grant adminOnlyKeys (posture path)", () => {
  let tmpDir: string;
  let socketPath: string;
  let broker: VaultBroker | null = null;
  let grantsDb: Database | null = null;
  let audit: AuditEntry[] = [];
  let prevNonLinuxFlag: string | undefined;
  let prevNodeEnv: string | undefined;
  let prevReqOpFlag: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    prevReqOpFlag = process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT;
    delete process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-admin-only-"));
    // Point HOME at the tmpdir so any `~/.switchroom/...` resolution
    // (and the hermeticity lint) lands in isolation, never the operator
    // tree. The broker is left locked anyway, but this keeps the test
    // hermetic by construction.
    prevHome = process.env.HOME;
    process.env.HOME = tmpDir;
    socketPath = path.join(tmpDir, "test.sock");
    audit = [];
    grantsDb = new Database(":memory:");
    migrateGrantsSchema(grantsDb);
  });

  afterEach(() => {
    if (broker) broker.stop();
    broker = null;
    if (grantsDb) { try { grantsDb.close(); } catch {} grantsDb = null; }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevReqOpFlag === undefined) delete process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT;
    else process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT = prevReqOpFlag;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  function makeBroker(adminOnlyKeys: string[]): VaultBroker {
    const auditor = createAuditLogger();
    (auditor as any).write = (e: AuditEntry) => audit.push(e);
    // No `_testPassphrase` → broker stays LOCKED on purpose (see file
    // header): the admin-only gate runs before the lock check, so a
    // permitted mint stops at LOCKED instead of writing a real token.
    return new VaultBroker({
      _testConfig: makeConfig(adminOnlyKeys),
      _testAgentName: "uat-agent",
      _testGrantsDb: grantsDb!,
      _testAuditLogger: auditor as any,
    });
  }

  it("DENIES adding a NEW admin-only key via posture (agent holds nothing)", async () => {
    broker = makeBroker(["stripe/*"]);
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["stripe/secret"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toMatch(/admin-only/i);
    }
    expect(
      audit.find((e) => e.op === "mint_grant" && e.result === ADMIN_ONLY_DENIAL),
      "the admin-only posture denial must be audited",
    ).toBeDefined();
  });

  it("ALLOWS retaining an admin-only key the agent already holds (union re-mint)", async () => {
    // Agent already has a passphrase-minted grant for stripe/secret.
    await mintGrant(grantsDb!, "uat-agent", ["stripe/secret"], 3600, "seed");
    broker = makeBroker(["stripe/*"]);
    await broker.start(socketPath, undefined, undefined);
    // Posture re-mint unions the existing admin-only key with a new
    // non-admin key — the admin-only gate must NOT fire (retain, not add).
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["stripe/secret", "perplexity/api-key"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(
      audit.find((e) => e.op === "mint_grant" && e.result === ADMIN_ONLY_DENIAL),
      "retaining an already-held admin-only key must NOT trip the admin-only gate",
    ).toBeUndefined();
    // Passed the admin-only gate → falls through to the broker-locked
    // check (LOCKED), never the admin-only DENIED.
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("LOCKED");
      expect(resp.msg ?? "").not.toMatch(/admin-only/i);
    }
  });

  it("does NOT affect non-admin-only keys", async () => {
    broker = makeBroker(["stripe/*"]);
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["perplexity/api-key"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(audit.find((e) => e.result === ADMIN_ONLY_DENIAL)).toBeUndefined();
    // Non-admin-only key passes the gate → falls through to LOCKED.
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("LOCKED");
      expect(resp.msg ?? "").not.toMatch(/admin-only/i);
    }
  });

  it("default adminOnlyKeys [] is a no-op (posture mint of any key passes the gate)", async () => {
    broker = makeBroker([]);
    await broker.start(socketPath, undefined, undefined);
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "uat-agent",
      keys: ["stripe/secret"],
      ttl_seconds: 3600,
      attest_via_posture: true,
    });
    expect(audit.find((e) => e.result === ADMIN_ONLY_DENIAL)).toBeUndefined();
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("LOCKED");
  });
});
