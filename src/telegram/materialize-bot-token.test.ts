/**
 * Tests for materializeBotToken (issue #758).
 *
 * Strategy: stub `resolveVaultReferencesViaBroker` from ../vault/resolver
 * via vi.mock so we exercise the materializer's branching logic without
 * spinning up a real broker (peer-cred ACL behavior is not portable across
 * dev machines and is already covered by resolver-via-broker.test.ts).
 *
 * Covers:
 *   - env-set token  → returned as-is, no config/vault calls
 *   - plaintext config → no broker call
 *   - vault-ref + broker ok → resolved value reaches process.env
 *   - vault-ref + broker locked → BotTokenMaterializeError(reason="locked")
 *   - vault-ref + broker unreachable + SWITCHROOM_VAULT_PASSPHRASE → direct decrypt
 *   - vault-ref + broker unreachable + no passphrase → unreachable error
 *   - per-agent override wins over global
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ResolveViaBrokerResult } from "../vault/resolver.js";
import type { SwitchroomConfig } from "../config/schema.js";

// Stub: each test sets `mockBrokerResult` (or `mockBrokerImpl` for dynamic
// behavior). Importing the module under test happens after the mock is set
// up via vi.mock's hoisted stub.
const brokerStub = vi.hoisted(() => ({
  fn: vi.fn<(config: SwitchroomConfig) => Promise<ResolveViaBrokerResult>>(),
}));

vi.mock("../vault/resolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../vault/resolver.js")>();
  return {
    ...actual,
    resolveVaultReferencesViaBroker: brokerStub.fn,
  };
});

// Late import so the mock is in place.
const { materializeBotToken, BotTokenMaterializeError } = await import("./materialize-bot-token.js");
const { createVault, setStringSecret } = await import("../vault/vault.js");

function makeConfig(botToken: string): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: botToken, forum_chat_id: "-1001" },
    vault: { path: "~/.switchroom/vault.enc" },
    agents: {},
  } as unknown as SwitchroomConfig;
}

describe("materializeBotToken (issue #758)", () => {
  let tmpDir: string;
  let prevToken: string | undefined;
  let prevPass: string | undefined;

  beforeEach(() => {
    prevToken = process.env.TELEGRAM_BOT_TOKEN;
    prevPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-bot-token-"));
    brokerStub.fn.mockReset();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevPass === undefined) delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    else process.env.SWITCHROOM_VAULT_PASSPHRASE = prevPass;
  });

  it("returns env-set token as-is (no config/broker calls)", async () => {
    const env = { TELEGRAM_BOT_TOKEN: "from-env-12345" };
    const token = await materializeBotToken({ env });
    expect(token).toBe("from-env-12345");
    expect(brokerStub.fn).not.toHaveBeenCalled();
  });

  it("returns plaintext config token without calling the broker", async () => {
    const config = makeConfig("plaintext-token-abc");
    const token = await materializeBotToken({ config, env: {} });
    expect(token).toBe("plaintext-token-abc");
    expect(brokerStub.fn).not.toHaveBeenCalled();
  });

  it("resolves a vault: reference when broker returns ok", async () => {
    brokerStub.fn.mockResolvedValueOnce({
      ok: true,
      config: makeConfig("123456:RESOLVED"),
    });
    const config = makeConfig("vault:tg-token");
    const token = await materializeBotToken({ config, env: {} });
    expect(token).toBe("123456:RESOLVED");
    expect(brokerStub.fn).toHaveBeenCalledTimes(1);
  });

  it("throws BotTokenMaterializeError(locked) when broker reports vault locked", async () => {
    brokerStub.fn.mockResolvedValueOnce({ ok: false, reason: "locked" });
    const config = makeConfig("vault:tg-token");
    await expect(materializeBotToken({ config, env: {} })).rejects.toMatchObject({
      name: "BotTokenMaterializeError",
      reason: "locked",
    });
  });

  it("throws BotTokenMaterializeError(denied) when broker denies", async () => {
    brokerStub.fn.mockResolvedValueOnce({ ok: false, reason: "denied" });
    const config = makeConfig("vault:tg-token");
    await expect(materializeBotToken({ config, env: {} })).rejects.toMatchObject({
      name: "BotTokenMaterializeError",
      reason: "denied",
    });
  });

  it("falls back to direct vault decrypt when broker is unreachable and SWITCHROOM_VAULT_PASSPHRASE is set", async () => {
    brokerStub.fn.mockResolvedValueOnce({ ok: false, reason: "unreachable" });

    const passphrase = "test-passphrase-xyz";
    const vaultPath = path.join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
    setStringSecret(passphrase, vaultPath, "tg-token", "123456:DIRECT-DECRYPT");

    const config = {
      ...makeConfig("vault:tg-token"),
      vault: { path: vaultPath },
    } as unknown as SwitchroomConfig;

    const token = await materializeBotToken({
      config,
      env: { SWITCHROOM_VAULT_PASSPHRASE: passphrase },
    });
    expect(token).toBe("123456:DIRECT-DECRYPT");
  });

  it("throws unreachable when broker is down and no passphrase is available", async () => {
    brokerStub.fn.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    const config = {
      ...makeConfig("vault:tg-token"),
      vault: { path: path.join(tmpDir, "nonexistent-vault.enc") },
    } as unknown as SwitchroomConfig;
    await expect(materializeBotToken({ config, env: {} })).rejects.toMatchObject({
      name: "BotTokenMaterializeError",
      reason: "unreachable",
    });
  });

  it("prefers per-agent bot_token override over global", async () => {
    const config = {
      ...makeConfig("global-token"),
      agents: {
        myagent: { bot_token: "agent-specific-token" },
      },
    } as unknown as SwitchroomConfig;
    const token = await materializeBotToken({
      config,
      env: {},
      agentName: "myagent",
    });
    expect(token).toBe("agent-specific-token");
    expect(brokerStub.fn).not.toHaveBeenCalled();
  });

  // ── Regression: single-key isolation (voice token bug class) ──
  //
  // resolveVaultReferencesViaBroker fails the WHOLE batch unless EVERY vault:
  // ref resolves. If the materializer passes the full config, admin-only refs
  // elsewhere (litellm/master-key, google/client-secret) — correctly DENIED to
  // a normal agent — would sink the resolution even though the bot_token key is
  // granted. The fix passes a MINIMAL config carrying only the one ref. This
  // asserts the broker sees exactly ONE vault ref, regardless of other refs in
  // the config.
  it("passes the broker a config containing exactly one vault ref (isolated from admin-only refs)", async () => {
    let seenRefs: string[] = [];
    brokerStub.fn.mockImplementationOnce(async (cfg: SwitchroomConfig) => {
      const refs = new Set<string>();
      const walk = (v: unknown): void => {
        if (typeof v === "string" && v.startsWith("vault:")) refs.add(v.slice("vault:".length).split("#")[0]);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
      };
      walk(cfg);
      seenRefs = [...refs];
      return { ok: true, config: makeConfig("123456:RESOLVED") };
    });

    const config = {
      ...makeConfig("vault:tg/bot"),
      litellm: { admin_key: "vault:litellm/master-key" },
      google_workspace: { google_client_secret: "vault:google/client-secret" },
      agents: { klanker: { some_key: "vault:per-agent/secret" } },
    } as unknown as SwitchroomConfig;

    const token = await materializeBotToken({ config, env: {} });
    expect(token).toBe("123456:RESOLVED");
    expect(seenRefs).toEqual(["tg/bot"]);
  });

  it("BotTokenMaterializeError exports for instanceof checks", () => {
    const e = new BotTokenMaterializeError("x", "locked");
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe("locked");
  });
});
