import { describe, it, expect } from "vitest";

import {
  runSecretAccessChecks,
  type VaultFileStat,
  type SecretAccessDeps,
} from "../src/cli/doctor-secret-access.js";
import type { VaultEntry } from "../src/vault/vault.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

function cfg(agents: Record<string, unknown>): SwitchroomConfig {
  return { agents, defaults: {}, profiles: {} } as unknown as SwitchroomConfig;
}

const READABLE: VaultFileStat = {
  exists: true,
  readable: true,
  uid: 1000,
  mode: 0o600,
  realPath: "/home/op/.switchroom/vault/vault.enc",
};

function deps(over: Partial<SecretAccessDeps> = {}): SecretAccessDeps {
  return {
    vaultPath: "/v",
    selfUid: 1000,
    selfUser: "op",
    statVault: () => READABLE,
    passphrase: "pp",
    openVault: () => ({}),
    ...over,
  };
}

const get = (r: ReturnType<typeof runSecretAccessChecks>, name: string) =>
  r.find((x) => x.name === name);

describe("runSecretAccessChecks — Check A (operator readable)", () => {
  it("ok when the vault file is absent (defers to Vault section)", () => {
    const r = runSecretAccessChecks(
      cfg({}),
      deps({
        statVault: () => ({
          exists: false,
          readable: false,
          uid: -1,
          mode: 0,
          realPath: "/v",
        }),
      }),
    );
    const a = get(r, "vault: operator readable");
    expect(a?.status).toBe("ok");
    expect(a?.detail).toContain("not present");
  });

  it("FAILs with a chown fix when the file is root-locked", () => {
    const r = runSecretAccessChecks(
      cfg({}),
      deps({
        statVault: () => ({
          exists: true,
          readable: false,
          uid: 0,
          mode: 0o600,
          realPath: "/home/op/.switchroom/vault/vault.enc",
        }),
      }),
    );
    const a = get(r, "vault: operator readable");
    expect(a?.status).toBe("fail");
    expect(a?.detail).toContain("uid 0");
    expect(a?.fix).toBe(
      "sudo chown op:op /home/op/.switchroom/vault/vault.enc",
    );
  });

  it("ok when the operator can read it", () => {
    const r = runSecretAccessChecks(cfg({}), deps());
    expect(get(r, "vault: operator readable")?.status).toBe("ok");
  });
});

describe("runSecretAccessChecks — Check B (per-agent access)", () => {
  it("skips (cannot verify) when the passphrase is unset", () => {
    const saved = process.env.SWITCHROOM_VAULT_PASSPHRASE;
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    try {
      const r = runSecretAccessChecks(
        cfg({ a: {} }),
        deps({ passphrase: undefined }),
      );
      const b = get(r, "agent secret access");
      expect(b?.status).toBe("skip");
      expect(b?.detail).toContain("SWITCHROOM_VAULT_PASSPHRASE not set");
    } finally {
      if (saved !== undefined) process.env.SWITCHROOM_VAULT_PASSPHRASE = saved;
    }
  });

  it("fails 'agent secret access' when the vault won't open and the file IS readable", () => {
    const r = runSecretAccessChecks(
      cfg({ a: {} }),
      deps({
        openVault: () => {
          throw new Error("bad passphrase");
        },
      }),
    );
    const b = get(r, "agent secret access");
    expect(b?.status).toBe("fail");
    expect(b?.detail).toContain("bad passphrase");
  });

  it("ok per agent when declared cron secrets exist and ACL allows", () => {
    const config = cfg({
      scout: {
        schedule: [{ cron: "0 8 * * *", prompt: "x", secrets: ["api-key"] }],
      },
      bare: {},
    });
    const entries: Record<string, VaultEntry> = {
      "api-key": { kind: "string", value: "v" },
    };
    const r = runSecretAccessChecks(config, deps({ openVault: () => entries }));
    expect(get(r, "secret access: scout")?.status).toBe("ok");
    expect(get(r, "secret access: scout")?.detail).toContain("all present");
    expect(get(r, "secret access: bare")?.status).toBe("ok");
    expect(get(r, "secret access: bare")?.detail).toContain(
      "no declared vault secrets",
    );
  });

  it("FAILs when a declared cron secret is missing from the vault", () => {
    const config = cfg({
      scout: {
        schedule: [{ cron: "0 8 * * *", prompt: "x", secrets: ["api-key"] }],
      },
    });
    const r = runSecretAccessChecks(config, deps({ openVault: () => ({}) }));
    const s = get(r, "secret access: scout");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("'api-key' missing from the vault");
    expect(s?.fix).toContain("--allow scout");
  });

  it("FAILs when the per-key scope denies the agent", () => {
    const config = cfg({
      scout: {
        schedule: [{ cron: "0 8 * * *", prompt: "x", secrets: ["api-key"] }],
      },
    });
    const entries: Record<string, VaultEntry> = {
      "api-key": { kind: "string", value: "v", scope: { deny: ["scout"] } },
    };
    const r = runSecretAccessChecks(config, deps({ openVault: () => entries }));
    const s = get(r, "secret access: scout");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("per-key scope denies");
  });

  it("picks up `vault:` refs from config (not just cron) and flags missing", () => {
    const config = cfg({
      tgbot: { channels: { telegram: { bot_token: "vault:bot#x" } } },
    });
    const r = runSecretAccessChecks(config, deps({ openVault: () => ({}) }));
    const s = get(r, "secret access: tgbot");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("'bot' missing from the vault");
  });

  it("OK for the canonical bot_token vault: ref with no cron schedule (no false ACL fail)", () => {
    // Regression for the BLOCK: bot_token is resolved operator-side at
    // scaffold time, NOT via the broker cron allowlist. An agent with
    // no schedule[] must NOT be failed by checkAclByAgent.
    const config = cfg({
      tgbot: { channels: { telegram: { bot_token: "vault:tok" } } },
    });
    const entries: Record<string, VaultEntry> = {
      tok: { kind: "string", value: "123:ABC" }, // exists, default (open) scope
    };
    const r = runSecretAccessChecks(config, deps({ openVault: () => entries }));
    const s = get(r, "secret access: tgbot");
    expect(s?.status).toBe("ok");
    expect(s?.detail).toContain("all present");
  });

  it("config vault: ref is still per-key-scope checked (deny ⇒ fail)", () => {
    const config = cfg({
      tgbot: { channels: { telegram: { bot_token: "vault:tok" } } },
    });
    const entries: Record<string, VaultEntry> = {
      tok: { kind: "string", value: "v", scope: { deny: ["tgbot"] } },
    };
    const r = runSecretAccessChecks(config, deps({ openVault: () => entries }));
    const s = get(r, "secret access: tgbot");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("per-key scope denies");
    expect(s?.detail).not.toContain("no static ACL"); // not run through checkAclByAgent
  });

  it("does not false-'missing' a google:<acct> slot ref (existence skipped)", () => {
    const config = cfg({
      g: {
        schedule: [
          { cron: "0 8 * * *", prompt: "x", secrets: ["google:a@x:drive"] },
        ],
      },
    });
    // not in the vault blob, but isGoogleSlot ⇒ existence skipped; ACL
    // is evaluated via checkAclByAgent (no google_accounts ⇒ denied).
    const r = runSecretAccessChecks(config, deps({ openVault: () => ({}) }));
    const s = get(r, "secret access: g");
    expect(s?.status).toBe("fail");
    expect(s?.detail).not.toContain("missing from the vault");
    expect(s?.detail).toContain("no static ACL");
  });
});
