/**
 * Regression guard for the per-agent unlock socket.
 *
 * Before this fix, `bindAgentSocket` bound only the *data* socket for each
 * per-agent listener — never a paired unlock socket. The client side
 * (`unlockViaBroker` + `unlockSocketFor`) derives the unlock path from the
 * data socket as `<dir>/unlock`, so an in-container `vault unlock` from an
 * agent (the Telegram `/vault unlock` flow) failed with
 * `ENOENT /run/switchroom/broker/unlock` even though the broker was up and
 * the data socket was reachable.
 *
 * `bindOperatorListener` already pairs the sockets correctly; this test
 * pins the equivalent contract on `bindAgentSocket`.
 *
 * NOTE: This file uses `bun:sqlite` transitively (via VaultBroker →
 * grants-db.ts → bun:sqlite). It must NOT be run by vitest (excluded in
 * vitest.config.ts) and is run via `bun test` instead (see test:bun in
 * package.json).
 *
 * The canonical socket path regex in `peercred.ts` requires
 * `/run/switchroom/broker/<name>/sock`, which we can't write to from a
 * tmpdir-scoped test. We use `mock.module` to override `socketPathToAgent`
 * so the test can drive `bindAgentSocket` against a tmpdir path while
 * keeping the real `unlockSocketFor` (operates on any `/sock`-suffixed
 * path).
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";

// Pre-import + override peercred BEFORE importing server.ts so the broker
// picks up the patched `socketPathToAgent`. `unlockSocketFor` keeps its real
// implementation.
const peercredReal = await import("./peercred.js");
mock.module("./peercred.js", () => ({
  ...peercredReal,
  socketPathToAgent: (socketPath: string): string | null => {
    const m = socketPath.match(/\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/sock$/);
    return m ? m[1] : null;
  },
}));

const { VaultBroker } = await import("./server.js");
const { unlockSocketFor } = await import("./peercred.js");
const { createAuditLogger } = await import("./audit-log.js");
const { migrateGrantsSchema } = await import("../grants.js");
const { createVault } = await import("../vault.js");

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

function makeMinimalConfig(vaultPath: string) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: vaultPath,
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: {},
  } as any;
}

const CORRECT_PASSPHRASE = "correct-horse-battery-staple";

describe("VaultBroker bindAgentSocket: pairs data + unlock socket", () => {
  let broker: InstanceType<typeof VaultBroker>;
  let tmpDir: string;
  let agentDir: string;
  let dataSock: string;
  let unlockSock: string;
  let legacySock: string;
  let vaultPath: string;
  let auditLogPath: string;
  let prevNonLinuxFlag: string | undefined;
  let prevHome: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-pair-test-"));
    // Hermeticity: redirect HOME to the tmpdir BEFORE any broker code path
    // resolves `~/.switchroom/...`. See CLAUDE.md "Vault & shared-state
    // test discipline" — without this the test corrupts the operator's
    // live vault on a production-treated host.
    prevHome = process.env.HOME;
    process.env.HOME = tmpDir;
    agentDir = path.join(tmpDir, "test-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    dataSock = path.join(agentDir, "sock");
    unlockSock = unlockSocketFor(dataSock);
    legacySock = path.join(tmpDir, "legacy.sock");
    vaultPath = path.join(tmpDir, "vault.enc");
    auditLogPath = path.join(tmpDir, "vault-audit.log");

    createVault(CORRECT_PASSPHRASE, vaultPath);

    broker = new VaultBroker({
      _testConfig: makeMinimalConfig(vaultPath),
      _testAuditLogger: createAuditLogger({ path: auditLogPath }),
      _testGrantsDb: makeInMemoryGrantsDb(),
      _testIdentify: () => ({
        uid: process.getuid?.() ?? 1000,
        pid: process.pid,
        exe: process.execPath,
        systemdUnit: null,
      }),
    });
    await broker.start(legacySock, undefined, vaultPath);
  });

  afterEach(() => {
    try { broker.stop(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  it("binds both <agent>/sock AND <agent>/unlock after bindAgentSocket", async () => {
    const agentName = await broker.bindAgentSocket(dataSock);
    expect(agentName).toBe("test-agent");

    expect(fs.existsSync(dataSock)).toBe(true);
    expect(fs.statSync(dataSock).isSocket()).toBe(true);

    // The regression we're guarding: without the fix, this fails (ENOENT)
    // and the documented Telegram `/vault unlock` flow stays broken.
    expect(fs.existsSync(unlockSock)).toBe(true);
    expect(fs.statSync(unlockSock).isSocket()).toBe(true);
  });

  it("the paired unlock socket accepts a connection (no ENOENT)", async () => {
    await broker.bindAgentSocket(dataSock);

    // Precise symptom path: agent CLI dials `unlockSocketFor(dataSock)`.
    // Pre-fix this errored with ENOENT before any bytes flowed.
    await new Promise<void>((resolveP, rejectP) => {
      const c = net.createConnection({ path: unlockSock });
      const timeout = setTimeout(() => {
        c.destroy();
        rejectP(new Error("timed out connecting to per-agent unlock socket"));
      }, 2000);
      c.on("connect", () => {
        clearTimeout(timeout);
        c.destroy();
        resolveP();
      });
      c.on("error", (err) => {
        clearTimeout(timeout);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          rejectP(new Error(
            `per-agent unlock socket missing (ENOENT) at ${unlockSock} — ` +
            `pre-fix regression`,
          ));
          return;
        }
        rejectP(err);
      });
    });
  });

  it("stop() cleans up the per-agent unlock socket", async () => {
    await broker.bindAgentSocket(dataSock);
    expect(fs.existsSync(unlockSock)).toBe(true);

    broker.stop();
    expect(fs.existsSync(unlockSock)).toBe(false);
    expect(fs.existsSync(dataSock)).toBe(false);
  });
});
