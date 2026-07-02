/**
 * Tests for materializeSidecarToken (voice PR-B2, #2714).
 *
 * Strategy mirrors materialize-bot-token.test.ts: stub
 * `resolveVaultReferencesViaBroker` via vi.mock so we exercise the
 * materializer's branching WITHOUT a real broker.
 *
 * The load-bearing behavior #2714 fixed and this file pins:
 *   - a LITERAL (non-vault) token ref is returned as-is, no broker call
 *   - a vault: ref is resolved via the broker (ok path)
 *   - the broker is handed a MINIMAL config carrying EXACTLY ONE vault ref,
 *     isolated from admin-only refs elsewhere in the config (the narrowing
 *     that stops an unrelated denied ref from sinking the whole batch)
 *   - a resolved value that is STILL a vault: ref (broker echoed the ref
 *     back unresolved) narrows to null, not the unresolved ref
 *   - broker not-ok + no passphrase → null (graceful fallback, never throws)
 *   - broker not-ok + passphrase → direct decrypt fallback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ResolveViaBrokerResult } from "../vault/resolver.js";
import type { SwitchroomConfig } from "../config/schema.js";

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

const { materializeSidecarToken, DEFAULT_VOICE_SIDECAR_TOKEN_REF } = await import(
  "./materialize-sidecar-token.js"
);
const { createVault, setStringSecret } = await import("../vault/vault.js");

function makeConfig(): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "plaintext-bot", forum_chat_id: "-1001" },
    vault: { path: "~/.switchroom/vault.enc" },
    agents: {},
  } as unknown as SwitchroomConfig;
}

/** Build a broker "ok" result whose narrowed telegram.bot_token slot carries
 * the resolved sidecar token (that's the slot the materializer reads back). */
function okWith(resolved: string): ResolveViaBrokerResult {
  return {
    ok: true,
    config: {
      ...makeConfig(),
      telegram: { bot_token: resolved } as SwitchroomConfig["telegram"],
    },
  } as ResolveViaBrokerResult;
}

describe("materializeSidecarToken (#2714)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-sidecar-token-"));
    brokerStub.fn.mockReset();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns a literal (non-vault) token ref as-is, no broker call", async () => {
    const token = await materializeSidecarToken(
      { tokenRef: "literal-secret-xyz", config: makeConfig() },
      () => {},
    );
    expect(token).toBe("literal-secret-xyz");
    expect(brokerStub.fn).not.toHaveBeenCalled();
  });

  it("resolves the default vault: ref when broker returns ok", async () => {
    brokerStub.fn.mockResolvedValueOnce(okWith("RESOLVED-TOKEN"));
    const token = await materializeSidecarToken({ config: makeConfig() }, () => {});
    expect(token).toBe("RESOLVED-TOKEN");
    expect(brokerStub.fn).toHaveBeenCalledTimes(1);
    expect(DEFAULT_VOICE_SIDECAR_TOKEN_REF).toBe("vault:voice/sidecar-token");
  });

  it("hands the broker EXACTLY ONE vault ref, isolated from admin-only refs", async () => {
    let seenRefs: string[] = [];
    brokerStub.fn.mockImplementationOnce(async (cfg: SwitchroomConfig) => {
      const refs = new Set<string>();
      const walk = (v: unknown): void => {
        if (typeof v === "string" && v.startsWith("vault:"))
          refs.add(v.slice("vault:".length).split("#")[0]);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === "object")
          Object.values(v as Record<string, unknown>).forEach(walk);
      };
      walk(cfg);
      seenRefs = [...refs];
      return okWith("RESOLVED-TOKEN");
    });

    const config = {
      ...makeConfig(),
      litellm: { admin_key: "vault:litellm/master-key" },
      google_workspace: { google_client_secret: "vault:google/client-secret" },
      agents: { klanker: { some_key: "vault:per-agent/secret" } },
    } as unknown as SwitchroomConfig;

    const token = await materializeSidecarToken({ config }, () => {});
    expect(token).toBe("RESOLVED-TOKEN");
    expect(seenRefs).toEqual(["voice/sidecar-token"]);
  });

  it("narrows a still-unresolved vault: ref to null (does not leak the ref)", async () => {
    // Broker returned ok but echoed the ref back unresolved.
    brokerStub.fn.mockResolvedValueOnce(okWith("vault:voice/sidecar-token"));
    const token = await materializeSidecarToken({ config: makeConfig() }, () => {});
    expect(token).toBeNull();
  });

  it("returns null when broker not-ok and no passphrase is available (no throw)", async () => {
    brokerStub.fn.mockResolvedValueOnce({ ok: false, reason: "denied" });
    const config = {
      ...makeConfig(),
      vault: { path: path.join(tmpDir, "nonexistent-vault.enc") },
    } as unknown as SwitchroomConfig;
    const token = await materializeSidecarToken({ config, env: {} }, () => {});
    expect(token).toBeNull();
  });

  it("falls back to direct decrypt when broker unreachable and passphrase set", async () => {
    brokerStub.fn.mockResolvedValueOnce({ ok: false, reason: "unreachable" });

    const passphrase = "test-passphrase-abc";
    const vaultPath = path.join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
    setStringSecret(passphrase, vaultPath, "voice/sidecar-token", "DIRECT-DECRYPT-TOKEN");

    const config = {
      ...makeConfig(),
      vault: { path: vaultPath },
    } as unknown as SwitchroomConfig;

    const token = await materializeSidecarToken(
      { config, env: { SWITCHROOM_VAULT_PASSPHRASE: passphrase } },
      () => {},
    );
    expect(token).toBe("DIRECT-DECRYPT-TOKEN");
  });
});
