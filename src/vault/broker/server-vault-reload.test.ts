/**
 * Regression tests for the stale-secret bug: the broker decrypted the vault
 * ONCE at unlock and served every `get` from memory, so an operator-side
 * `switchroom vault set <key>` wrote `vault.enc` and every agent kept reading
 * the OLD value indefinitely. SIGHUP swapped config only, and
 * `docker compose up -d` left a Running broker untouched — the sole recovery
 * was `docker restart switchroom-vault-broker`. Observed live on 2026-08-16:
 * `marko/postiz-db-url` was rewritten twice and marko kept serving the stale
 * DSN until the broker was restarted.
 *
 * These assert OUTCOMES against a real on-disk vault and the real socket RPC:
 *   1. `get` after an out-of-band write returns the NEW value.
 *   2. `list` after an out-of-band key ADD includes the new key.
 *   3. A LOCKED broker never lazily re-opens the vault (no passphrase-free
 *      unlock) — it still answers LOCKED and holds no secrets.
 *   4. A corrupt / torn vault file does NOT cost the fleet its vault access:
 *      the previously loaded secrets keep serving, and a later completed
 *      write self-heals (the failed stamp is not treated as loaded).
 *   5. `put` refreshes before its read-modify-write, so an agent rotation
 *      does not silently revert an operator's out-of-band write to another key.
 *   6. `reload()` (the SIGHUP path) picks up a vault write on its own —
 *      belt-and-braces for `switchroom apply`.
 *
 * Every one of 1, 2, 5, 6 fails against the pre-fix broker.
 *
 * NOTE: uses `bun:sqlite` (grants DB) — bun-run only, excluded from vitest.
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

const PASSPHRASE = "test-pass-phrase-for-lazy-reload";

/**
 * Every vault touch (createVault / setStringSecret / unlock) runs a real
 * scrypt derivation, so a single test spends multiple seconds in the KDF.
 * The runners' 5s default is not enough — this is CPU, not a hang.
 */
const KDF_TIMEOUT_MS = 60_000;

/**
 * Config with a standing read grant (`agents.<name>.secrets`) so plain
 * peercred-identified `get`/`list` are allowed — the same shape the live
 * fleet uses for an agent's declared secrets.
 */
function makeConfig(agentName: string, keys: string[]) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: { [agentName]: { purpose: "test agent", secrets: keys } },
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

function stringValue(resp: BrokerResponse): string | undefined {
  if (!resp.ok) return undefined;
  const entry = (resp as { entry?: { kind: string; value?: string } }).entry;
  return entry?.value;
}

describe("VaultBroker: out-of-band vault writes are observable by readers", () => {
  let tmpDir: string;
  let vaultPath: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;
  let prevAgentsDirEnv: string | undefined;
  const brokers: VaultBroker[] = [];

  /** Start an unlocked broker bound as `agentName`, return its socket path. */
  async function makeBroker(
    agentName: string,
    keys: string[],
  ): Promise<{ broker: VaultBroker; socket: string }> {
    const socket = path.join(tmpDir, `${agentName}.sock`);
    const broker = new VaultBroker({
      _testConfig: makeConfig(agentName, keys),
      _testGrantsDb: grantsDb,
      _testAuditLogger: {
        write: (e: AuditEntry) => { auditEntries.push(e); return true; },
        failOpenCount: () => 0,
      },
      _testVaultPath: vaultPath,
      _testAgentName: agentName,
    });
    await broker.start(socket, undefined, vaultPath);
    broker.unlockFromPassphrase(PASSPHRASE);
    brokers.push(broker);
    return { broker, socket };
  }

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-vault-reload-test-"));
    vaultPath = path.join(tmpDir, "vault.enc");

    prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = path.join(tmpDir, "agents");

    createVault(PASSPHRASE, vaultPath);
    setStringSecret(PASSPHRASE, vaultPath, "postiz-db-url", "postgres://old-dsn");

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];
  }, KDF_TIMEOUT_MS);

  afterEach(() => {
    for (const b of brokers.splice(0)) { try { b.stop(); } catch { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevAgentsDirEnv === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDirEnv;
    if (prevNonLinuxFlag === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
  }, KDF_TIMEOUT_MS);

  it("get returns the NEW value after an out-of-band `vault set`", async () => {
    const { socket } = await makeBroker("marko", ["postiz-db-url"]);

    const before = await rpc(socket, { v: 1, op: "get", key: "postiz-db-url" });
    expect(before.ok).toBe(true);
    expect(stringValue(before)).toBe("postgres://old-dsn");

    // Operator rewrites the key on the host, broker untouched.
    setStringSecret(PASSPHRASE, vaultPath, "postiz-db-url", "postgres://new-dsn");

    const after = await rpc(socket, { v: 1, op: "get", key: "postiz-db-url" });
    expect(after.ok).toBe(true);
    // Pre-fix this was still "postgres://old-dsn" forever.
    expect(stringValue(after)).toBe("postgres://new-dsn");
  }, KDF_TIMEOUT_MS);

  it("list picks up a key added out of band", async () => {
    const { socket } = await makeBroker("marko", ["postiz-db-url", "added-later"]);

    const before = await rpc(socket, { v: 1, op: "list" });
    expect(before.ok).toBe(true);
    expect((before as { keys: string[] }).keys).not.toContain("added-later");

    setStringSecret(PASSPHRASE, vaultPath, "added-later", "v");

    const after = await rpc(socket, { v: 1, op: "list" });
    expect(after.ok).toBe(true);
    expect((after as { keys: string[] }).keys).toContain("added-later");
  }, KDF_TIMEOUT_MS);

  it("a LOCKED broker never re-opens the vault (no passphrase-free unlock)", async () => {
    const { broker, socket } = await makeBroker("marko", ["postiz-db-url"]);

    broker.lock();
    setStringSecret(PASSPHRASE, vaultPath, "postiz-db-url", "postgres://new-dsn");

    const resp = await rpc(socket, { v: 1, op: "get", key: "postiz-db-url" });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe("LOCKED");
    // Still holding nothing: the read path must not have unlocked us.
    expect(broker._getSecretsRef()).toBeNull();
    expect(broker.getStatus().unlocked).toBe(false);
  }, KDF_TIMEOUT_MS);

  it("a corrupt vault file keeps the already-loaded secrets serving, and a later good write self-heals", async () => {
    const { socket } = await makeBroker("marko", ["postiz-db-url"]);

    // Torn/partial write: the file changed but cannot be decrypted.
    fs.writeFileSync(vaultPath, "{ not-valid-json", "utf8");

    const during = await rpc(socket, { v: 1, op: "get", key: "postiz-db-url" });
    expect(during.ok).toBe(true);
    expect(stringValue(during)).toBe("postgres://old-dsn");

    // Repeated reads keep working too (the bad load is never swapped in).
    const again = await rpc(socket, { v: 1, op: "get", key: "postiz-db-url" });
    expect(stringValue(again)).toBe("postgres://old-dsn");

    // The writer finishes: a complete vault lands and the broker picks it up.
    fs.rmSync(vaultPath);
    createVault(PASSPHRASE, vaultPath);
    setStringSecret(PASSPHRASE, vaultPath, "postiz-db-url", "postgres://healed-dsn");

    const healed = await rpc(socket, { v: 1, op: "get", key: "postiz-db-url" });
    expect(healed.ok).toBe(true);
    expect(stringValue(healed)).toBe("postgres://healed-dsn");
  }, KDF_TIMEOUT_MS);

  it("an agent put does not revert an operator's out-of-band write to another key", async () => {
    setStringSecret(PASSPHRASE, vaultPath, "rotatable", "rot-v1");
    const { token } = await mintGrant(
      grantsDb, "rotator", [], null, "rotate", ["rotatable"],
    );
    const { socket } = await makeBroker("rotator", ["rotatable"]);

    // Load the vault into broker memory.
    const seed = await rpc(socket, { v: 1, op: "get", key: "rotatable" });
    expect(seed.ok).toBe(true);

    // Operator changes a DIFFERENT key out of band.
    setStringSecret(PASSPHRASE, vaultPath, "postiz-db-url", "postgres://new-dsn");

    // Agent rotates its own key: saveVault re-encrypts the whole dict, so a
    // stale in-memory load would write the old DSN back over the operator's.
    const put = await rpc(socket, {
      v: 1,
      op: "put",
      key: "rotatable",
      entry: { kind: "string", value: "rot-v2" },
      token,
    });
    expect(put.ok).toBe(true);

    const persisted = openVault(PASSPHRASE, vaultPath);
    expect(persisted["rotatable"].kind === "string" && persisted["rotatable"].value)
      .toBe("rot-v2");
    // Pre-fix: "postgres://old-dsn" — the operator's write silently reverted.
    expect(persisted["postiz-db-url"].kind === "string" && persisted["postiz-db-url"].value)
      .toBe("postgres://new-dsn");
  }, KDF_TIMEOUT_MS);

  it("reload() (the SIGHUP path) re-reads the vault with the retained passphrase", async () => {
    const { broker } = await makeBroker("marko", ["postiz-db-url"]);

    setStringSecret(PASSPHRASE, vaultPath, "postiz-db-url", "postgres://new-dsn");

    // `switchroom apply` SIGHUPs the broker → handler calls reload(config).
    broker.reload(makeConfig("marko", ["postiz-db-url"]));

    const held = broker._getSecretsRef();
    expect(held).not.toBeNull();
    const entry = held!["postiz-db-url"];
    // Pre-fix: reload() touched config only, so this stayed the old DSN.
    expect(entry.kind === "string" && entry.value).toBe("postgres://new-dsn");
  }, KDF_TIMEOUT_MS);

  it("reload() on a LOCKED broker stays locked (never re-unlocks without a passphrase)", async () => {
    const { broker } = await makeBroker("marko", ["postiz-db-url"]);
    broker.lock();

    broker.reload(makeConfig("marko", ["postiz-db-url"]));

    expect(broker._getSecretsRef()).toBeNull();
    expect(broker.getStatus().unlocked).toBe(false);
  }, KDF_TIMEOUT_MS);
});
