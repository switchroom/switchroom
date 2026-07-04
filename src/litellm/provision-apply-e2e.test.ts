/**
 * Apply-level e2e for LiteLLM provisioning against a REAL isolated
 * vault-broker (the seam that hid the original blocker-1: a passphrase-less
 * `putViaBroker` of a NEW key is always denied on the operator socket).
 *
 * This drives the real `provisionLiteLLMKeys` (src/cli/apply.ts) — including
 * its operator-passphrase recovery + passphrase-attested broker put — against
 * an in-process `VaultBroker` bound on a tmp socket, with an isolated tmp
 * vault + in-memory grants DB, and asserts the key is actually WRITTEN to the
 * vault and READABLE back through the broker.
 *
 * Bun test (uses bun:sqlite via the broker grants DB). Excluded from vitest;
 * listed in package.json `test:bun`.
 *
 * Vault/shared-state HARD RULES (CLAUDE.md): everything points at a
 * mkdtempSync tmpdir — never ~/.switchroom. `_testSecrets` is seeded so the
 * broker does NOT auto-unlock from the host blob (hermeticity guard in
 * server.ts start()).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { VaultBroker } from "../vault/broker/server.js";
import { createVault, getStringSecret } from "../vault/vault.js";
import { migrateGrantsSchema } from "../vault/grants.js";
import { putViaBroker } from "../vault/broker/client.js";
import { provisionLiteLLMKeys } from "../cli/apply.js";
import type { SwitchroomConfig } from "../config/schema.js";

// NOTE on the assertion lens: in production, apply connects to the broker's
// OPERATOR socket (`bindOperatorListener`, isOperator=true) where reads bypass
// ACL. That listener requires a canonical /run/switchroom path, so an
// in-process test on a tmp socket can't reproduce operator-mode reads — a
// null-agent GET there is ACL-denied. So we assert the WRITE landed by reading
// the encrypted vault FILE directly with the passphrase (getStringSecret) —
// that IS the ground truth blocker-1 broke (a passphrase-less broker put of a
// new key never reached disk). The broker put itself is exercised for real.

const TEST_PASSPHRASE = "operator-" + "test-" + "passphrase";

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

function makeConfig(tmpDir: string): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "123:TEST", forum_chat_id: "-1001" },
    vault: {
      path: join(tmpDir, "vault.enc"),
      broker: { socket: join(tmpDir, "broker.sock"), enabled: true },
    },
    litellm: {
      enabled: true,
      base_url: "http://127.0.0.1:4010",
      admin_key: "sk-master-test",
      team: "switchroom",
      small_fast_model: "claude-haiku-4-5-20251001",
    },
    agents: {
      clerk: { topic_name: "Clerk", litellm: { enabled: true } },
    },
  } as unknown as SwitchroomConfig;
}

describe("provisionLiteLLMKeys — real broker e2e (blocker-1 seam)", () => {
  let broker: VaultBroker;
  let tmpDir: string;
  let socketPath: string;
  let vaultPath: string;
  let grantsDb: Database;
  let prevNonLinux: string | undefined;
  let prevSock: string | undefined;
  let prevPass: string | undefined;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    prevNonLinux = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = mkdtempSync(join(tmpdir(), "litellm-apply-e2e-"));
    socketPath = join(tmpDir, "broker.sock");
    vaultPath = join(tmpDir, "vault.enc");
    grantsDb = makeInMemoryGrantsDb();

    // Real encrypted vault on disk so the broker's saveVault (on put)
    // persists. Same passphrase the broker is seeded with.
    createVault(TEST_PASSPHRASE, vaultPath);

    broker = new VaultBroker({
      // Seed an empty in-memory vault → start() skips host auto-unlock
      // (hermeticity guard) and the put adds the new key on top.
      _testSecrets: {},
      _testPassphrase: TEST_PASSPHRASE,
      _testVaultPath: vaultPath,
      _testGrantsDb: grantsDb,
      _testConfig: makeConfig(tmpDir),
      // Isolated audit logger → never touches the production audit log
      // (CLAUDE.md vault-test hermeticity HARD RULE).
      _testAuditLogger: { write: () => {} },
    });
    await broker.start(socketPath, undefined, vaultPath);

    // Point the broker client at our tmp socket.
    prevSock = process.env.SWITCHROOM_VAULT_BROKER_SOCK;
    process.env.SWITCHROOM_VAULT_BROKER_SOCK = socketPath;

    // Provide the operator passphrase via env so provisionLiteLLMKeys'
    // resolveOperatorVaultPassphrase succeeds without a machine-id blob.
    prevPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    process.env.SWITCHROOM_VAULT_PASSPHRASE = TEST_PASSPHRASE;

    // Stub global fetch so ensureTeam/ensureKey never hit the network.
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/team/new")) {
        return new Response(JSON.stringify({ team_id: "t1" }), { status: 200 });
      }
      if (u.endsWith("/key/generate")) {
        return new Response(JSON.stringify({ key: "sk-virtual-clerk-xyz" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    try {
      broker.stop();
    } catch {
      /* ignore */
    }
    if (prevNonLinux === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinux;
    if (prevSock === undefined) delete process.env.SWITCHROOM_VAULT_BROKER_SOCK;
    else process.env.SWITCHROOM_VAULT_BROKER_SOCK = prevSock;
    if (prevPass === undefined) delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    else process.env.SWITCHROOM_VAULT_PASSPHRASE = prevPass;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("writes a NEW per-agent key that actually persists to the vault", async () => {
    const config = makeConfig(tmpDir);
    const failures: { agent: string; message: string }[] = [];
    const out: string[] = [];
    const err: string[] = [];

    // Pre-check: the key does NOT exist in the vault file yet.
    expect(getStringSecret(TEST_PASSPHRASE, vaultPath, "litellm/clerk/api-key")).toBeNull();

    await provisionLiteLLMKeys(config, ["clerk"], undefined, {
      writeOut: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      failures,
      home: tmpDir, // not used (env passphrase wins) but keep isolated
    });

    // No failures — the write went through (this is exactly what blocker-1
    // broke: a passphrase-less put was silently denied → landed here).
    expect(failures).toEqual([]);

    // The key actually landed in the encrypted vault on disk (passphrase
    // attestation authorized the new-key write + saveVault persisted it).
    const stored = getStringSecret(TEST_PASSPHRASE, vaultPath, "litellm/clerk/api-key");
    expect(stored).toBe("sk-virtual-clerk-xyz");

    expect(out.join("")).toContain("provisioned virtual key");
  });

  it("control: a passphrase-LESS put of a new key IS denied (proves the seam)", async () => {
    // This is the exact failure mode blocker-1 described: without operator
    // attestation, the broker refuses to introduce a new key. If this ever
    // starts succeeding, the passphrase plumbing in provisionLiteLLMKeys is
    // no longer load-bearing and the e2e above would pass vacuously.
    const r = await putViaBroker("litellm/nobody/api-key", {
      kind: "string",
      value: "x",
    });
    expect(r.kind).not.toBe("ok");
  });

  it("null passphrase + unprovisioned NEW agent is SURFACED, not silently skipped", async () => {
    // Regression guard for the fail-open bug: when the vault passphrase is
    // unavailable, provisionLiteLLMKeys used to warn + `return` above the
    // per-agent loop, so a brand-new litellm-opted agent with NO vault key was
    // silently skipped and the rollout reported success. It must instead probe
    // the broker, find no key for the new agent, and push a scaffold FAILURE
    // the operator can see.
    const config = makeConfig(tmpDir);

    // Force the null-passphrase branch: no env passphrase, and `home` points at
    // an isolated tmp dir with no machine-id auto-unlock blob.
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;

    // Pre-check: clerk has NO key in the vault (genuinely new).
    expect(getStringSecret(TEST_PASSPHRASE, vaultPath, "litellm/clerk/api-key")).toBeNull();

    const failures: { agent: string; message: string }[] = [];
    const out: string[] = [];
    const err: string[] = [];
    await provisionLiteLLMKeys(config, ["clerk"], undefined, {
      writeOut: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      failures,
      home: tmpDir, // no auto-unlock blob here → passphrase resolves null
    });

    // The genuinely-new agent is surfaced as a failure (LOUD), not skipped.
    expect(failures.some((f) => f.agent === "clerk")).toBe(true);
    expect(failures.find((f) => f.agent === "clerk")!.message).toMatch(
      /passphrase|provision/i,
    );
    // And the operator sees a red warning line, not silence.
    expect(err.join("")).toMatch(/passphrase unavailable/i);
    // No key was written (can't, without the passphrase).
    expect(getStringSecret(TEST_PASSPHRASE, vaultPath, "litellm/clerk/api-key")).toBeNull();
  });

  // NOTE: the "already-provisioned agent continues quietly" half of the
  // null-passphrase split can't be exercised through this harness. The apply
  // path connects to the broker's OPERATOR socket (reads bypass ACL) in
  // production, but an in-process test on a tmp socket connects as a non-cron
  // peer, so `getViaBrokerStructured` returns `denied` for ANY key regardless
  // of presence (peer-identity ACL, not a key lookup) — same limitation the
  // file-header note calls out for operator-mode reads. The null-passphrase
  // branch deliberately treats a not_found / denied probe as "not known-good
  // → surface it" (an `unreachable` probe degrades to a WARNING since #2781 —
  // hostd's container has no broker socket by construction), the conservative,
  // LOUD behavior the fix requires. The unit-level split (ok → quiet,
  // else → surfaced) is asserted where the broker read is stubbable; here we
  // pin the load-bearing half: a genuinely-new agent is surfaced, not skipped
  // (the test above).

  it("is idempotent — a second run with the key present does not fail", async () => {
    const config = makeConfig(tmpDir);
    const run = async () => {
      const failures: { agent: string; message: string }[] = [];
      await provisionLiteLLMKeys(config, ["clerk"], undefined, {
        writeOut: () => {},
        writeErr: () => {},
        failures,
        home: tmpDir,
      });
      return failures;
    };
    expect(await run()).toEqual([]);
    // Second run: still no failures (a re-put of the same key is an upsert).
    const second = await run();
    expect(second).toEqual([]);
    // Key still present + correct in the vault file.
    expect(getStringSecret(TEST_PASSPHRASE, vaultPath, "litellm/clerk/api-key")).toBe(
      "sk-virtual-clerk-xyz",
    );
  });
});
