/**
 * Regression tests for sec #3143-B / #3143-C — entry-scope enforcement on the
 * TOKENLESS (path-as-identity) write path, plus the positive write-grant
 * control.
 *
 * #3143-B: the tokenless `put` path gated writes with `checkAclByAgent` ONLY
 * (server.ts ~1839) — no `checkEntryScope`. The READ path-as-identity path
 * (~1508) and the write-GRANT path (#3084-F2, ~1773) both enforce it. So an
 * agent whose `schedule.secrets[]` ACL covers a key that ALSO carries
 * `scope.deny:[thatagent]` could rotate that key WITHOUT a token, silently
 * bypassing the deny.
 *
 * #3143-C: no positive test pinned that a NON-denied agent's write-grant
 * rotation of a scoped existing key SUCCEEDS — the allow branch of the write
 * `checkEntryScope` was only covered indirectly.
 *
 * The B test FAILS against the pre-fix broker (the denied tokenless rotation
 * returns `ok:true`). The C test guards against a future over-broad deny.
 * No secret values are logged.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import { createVault, setStringSecret, openVault } from "../vault.js";
import type { AuditEntry } from "./audit-log.js";
import { migrateGrantsSchema, mintGrant } from "../grants.js";

function makeConfigWithAgents(agents: Record<string, unknown>) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents,
  } as any;
}

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

async function rpc(
  socketPath: string,
  req: Parameters<typeof encodeRequest>[0],
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let buffer = "";
    client.on("error", reject);
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        client.destroy();
        try { resolve(decodeResponse(line)); } catch (e) { reject(e); }
      }
    });
    client.on("connect", () => client.write(encodeRequest(req)));
  });
}

describe("VaultBroker: entry-scope on tokenless write (sec #3143-B/C)", () => {
  let tmpDir: string;
  let vaultPath: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  let agentsDir: string;
  let prevAgentsDirEnv: string | undefined;
  const brokers: VaultBroker[] = [];
  const PASSPHRASE = "test-pass-phrase-for-tokenless-scope";

  // Config: every agent that appears here has an ACL over `denied_key` via a
  // schedule.secrets[] entry, so checkAclByAgent passes and the ONLY thing
  // standing between them and the write is the entry-scope check under test.
  const CONFIG_AGENTS = {
    denyagent: { schedule: [{ secrets: ["denied_key"] }] },
    okagent: { schedule: [{ secrets: ["denied_key"] }] },
  };

  async function makeBroker(agentName: string): Promise<string> {
    const sp = path.join(tmpDir, `${agentName}.sock`);
    const b = new VaultBroker({
      _testConfig: makeConfigWithAgents(CONFIG_AGENTS),
      _testGrantsDb: grantsDb,
      _testAuditLogger: {
        write: (e: AuditEntry) => { auditEntries.push(e); return true; },
        failOpenCount: () => 0,
      },
      _testVaultPath: vaultPath,
      _testAgentName: agentName,
    });
    await b.start(sp, undefined, vaultPath);
    b.unlockFromPassphrase(PASSPHRASE);
    brokers.push(b);
    return sp;
  }

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-3143bc-test-"));
    vaultPath = path.join(tmpDir, "vault.enc");

    agentsDir = path.join(tmpDir, "agents");
    prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = agentsDir;

    // `denied_key` denies "denyagent" (but not "okagent").
    createVault(PASSPHRASE, vaultPath);
    setStringSecret(
      PASSPHRASE,
      vaultPath,
      "denied_key",
      "deny-original",
      undefined,
      { deny: ["denyagent"] },
    );

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
  });

  afterEach(() => {
    for (const b of brokers.splice(0)) { try { b.stop(); } catch { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevAgentsDirEnv === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDirEnv;
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
  });

  it("B: tokenless rotation by a scope-denied agent is REJECTED and the value is unchanged", async () => {
    // No token — pure path-as-identity. ACL (schedule.secrets) covers the key,
    // but the entry denies denyagent.
    const socket = await makeBroker("denyagent");

    const resp = await rpc(socket, {
      v: 1,
      op: "put",
      key: "denied_key",
      entry: { kind: "string", value: "overwritten-tokenless" },
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toContain("scope-deny");
    }
    const denied = auditEntries.find(
      (e) => e.op === "put" && String(e.result).includes("scope-deny"),
    );
    expect(denied).toBeDefined();
    const committed = auditEntries.find((e) => e.op === "put" && e.result === "allowed");
    expect(committed).toBeUndefined();

    // OUTCOME: persisted value unchanged.
    const persisted = openVault(PASSPHRASE, vaultPath).denied_key;
    if (persisted.kind === "string") {
      expect(persisted.value).toBe("deny-original");
    }
  });

  it("B-control: tokenless rotation by a NON-denied agent SUCCEEDS", async () => {
    const socket = await makeBroker("okagent");

    const resp = await rpc(socket, {
      v: 1,
      op: "put",
      key: "denied_key",
      entry: { kind: "string", value: "rotated-tokenless-ok" },
    });

    expect(resp.ok).toBe(true);
    const persisted = openVault(PASSPHRASE, vaultPath).denied_key;
    if (persisted.kind === "string") {
      expect(persisted.value).toBe("rotated-tokenless-ok");
    }
  });

  it("C: a NON-denied agent's write-grant rotation of a scoped key SUCCEEDS (allow branch)", async () => {
    // Pins the allow branch of the write-path checkEntryScope explicitly.
    const { token } = await mintGrant(
      grantsDb, "okagent", [], null, "ok write grant", ["denied_key"],
    );
    const socket = await makeBroker("okagent");

    const resp = await rpc(socket, {
      v: 1,
      op: "put",
      key: "denied_key",
      entry: { kind: "string", value: "rotated-by-grant-ok" },
      token,
    });

    expect(resp.ok).toBe(true);
    const served = auditEntries.find(
      (e) => e.op === "put" && e.key === "denied_key" && e.result === "allowed",
    );
    expect(served).toBeDefined();
    expect(served?.method).toBe("grant");
    const persisted = openVault(PASSPHRASE, vaultPath).denied_key;
    if (persisted.kind === "string") {
      expect(persisted.value).toBe("rotated-by-grant-ok");
    }
  });
});
