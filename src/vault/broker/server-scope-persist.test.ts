/**
 * Regression tests for sec #3143-A — scope.deny / format durability across
 * a LEGITIMATE rotation.
 *
 * Before the fix, `put` did `this.secrets[key] = req.entry`, and the wire
 * `PutRequestSchema.entry` is `{kind, value}` only. So the moment ANY allowed
 * agent rotated a scoped key, the entry's `scope.deny`/`scope.allow` and its
 * `format` hint were silently erased. After that, `checkEntryScope(undefined)`
 * → allow, and a previously-denied agent could rotate the key freely — the
 * exact durability the #3084-F2/F3 write-scope work advertises, defeated by a
 * normal rotation.
 *
 * These assert the OUTCOMES against a real on-disk vault:
 *   1. A non-denied agent's write-grant rotation SUCCEEDS but the persisted
 *      entry STILL carries the original `scope.deny` + `format` (read back via
 *      openVault directly, not the value-only get path).
 *   2. After that rotation, the previously-denied agent's own write-grant
 *      rotation is STILL rejected with `scope-deny` — proving the deny
 *      survived. This whole test FAILS against the pre-fix broker (step 2's
 *      rotation would succeed because the deny was wiped in step 1).
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

function makeMinimalConfig() {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: {},
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

describe("VaultBroker: scope/format durability across rotation (sec #3143-A)", () => {
  let tmpDir: string;
  let vaultPath: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  let agentsDir: string;
  let prevAgentsDirEnv: string | undefined;
  const brokers: VaultBroker[] = [];
  const PASSPHRASE = "test-pass-phrase-for-scope-persist";

  async function makeBroker(agentName: string): Promise<string> {
    const sp = path.join(tmpDir, `${agentName}.sock`);
    const b = new VaultBroker({
      _testConfig: makeMinimalConfig(),
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-3143a-test-"));
    vaultPath = path.join(tmpDir, "vault.enc");

    agentsDir = path.join(tmpDir, "agents");
    prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = agentsDir;

    // Scoped key: denies "denyagent", carries a `json` format hint.
    createVault(PASSPHRASE, vaultPath);
    setStringSecret(
      PASSPHRASE,
      vaultPath,
      "scoped_key",
      "value-original",
      "json",
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

  it("a non-denied agent's rotation preserves scope.deny + format on disk", async () => {
    const { token } = await mintGrant(
      grantsDb, "rotator", [], null, "rotator write", ["scoped_key"],
    );
    const socket = await makeBroker("rotator");

    const resp = await rpc(socket, {
      v: 1,
      op: "put",
      key: "scoped_key",
      entry: { kind: "string", value: "value-rotated" },
      token,
    });
    expect(resp.ok).toBe(true);

    // Read the persisted entry directly — the value MUST be updated but the
    // scope + format metadata MUST survive.
    const persisted = openVault(PASSPHRASE, vaultPath).scoped_key;
    expect(persisted.kind).toBe("string");
    if (persisted.kind === "string") {
      expect(persisted.value).toBe("value-rotated");
    }
    expect(persisted.scope).toEqual({ deny: ["denyagent"] });
    expect("format" in persisted && persisted.format).toBe("json");
  });

  it("scope.deny still blocks the denied agent AFTER a legitimate rotation", async () => {
    // Step 1 — a non-denied agent rotates (this is what used to wipe scope).
    const { token: rotatorTok } = await mintGrant(
      grantsDb, "rotator", [], null, "rotator write", ["scoped_key"],
    );
    const rotatorSocket = await makeBroker("rotator");
    const first = await rpc(rotatorSocket, {
      v: 1,
      op: "put",
      key: "scoped_key",
      entry: { kind: "string", value: "value-rotated" },
      token: rotatorTok,
    });
    expect(first.ok).toBe(true);

    // Step 2 — the DENIED agent now tries its own write-grant rotation.
    // Pre-fix: step 1 erased the deny, so this would succeed. Post-fix: the
    // deny survived, so this is rejected with scope-deny.
    const { token: denyTok } = await mintGrant(
      grantsDb, "denyagent", [], null, "denyagent write", ["scoped_key"],
    );
    const denySocket = await makeBroker("denyagent");
    const second = await rpc(denySocket, {
      v: 1,
      op: "put",
      key: "scoped_key",
      entry: { kind: "string", value: "value-by-denied-agent" },
      token: denyTok,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("DENIED");
      expect(second.msg).toContain("scope-deny");
    }

    // And the persisted value must still be step 1's, never the denied write.
    const persisted = openVault(PASSPHRASE, vaultPath).scoped_key;
    if (persisted.kind === "string") {
      expect(persisted.value).toBe("value-rotated");
    }
  });
});
