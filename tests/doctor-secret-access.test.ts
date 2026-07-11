import { describe, it, expect } from "vitest";

import {
  runSecretAccessChecks,
  type VaultFileStat,
  type SecretAccessDeps,
  type PreflightOutcome,
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

// Default deps: passphrase SET → exercises the (preserved) LOCAL path.
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

// Broker-path deps: NO passphrase, inject a fake preflight RPC.
function brokerDeps(
  preflight: (a: string, k: string[]) => Promise<PreflightOutcome>,
  over: Partial<SecretAccessDeps> = {},
): SecretAccessDeps {
  return {
    vaultPath: "/v",
    selfUid: 1000,
    selfUser: "op",
    statVault: () => READABLE,
    passphrase: undefined,
    preflight,
    ...over,
  };
}

type R = Awaited<ReturnType<typeof runSecretAccessChecks>>;
const get = (r: R, name: string) => r.find((x) => x.name === name);

describe("runSecretAccessChecks — Check A (operator readable)", () => {
  it("ok when the vault file is absent (defers to Vault section)", async () => {
    const r = await runSecretAccessChecks(
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

  it("FAILs with a chown fix when the file is root-locked", async () => {
    const r = await runSecretAccessChecks(
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
    expect(a?.fix).toBe("sudo chown op:op /home/op/.switchroom/vault/vault.enc");
  });

  it("ok when the operator can read it", async () => {
    const r = await runSecretAccessChecks(cfg({}), deps());
    expect(get(r, "vault: operator readable")?.status).toBe("ok");
  });
});

describe("runSecretAccessChecks — Check B local path (passphrase set)", () => {
  it("fails when the vault won't open and the file IS readable", async () => {
    const r = await runSecretAccessChecks(
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

  it("ok per agent when declared cron secrets exist and ACL allows", async () => {
    const config = cfg({
      scout: {
        schedule: [{ cron: "0 8 * * *", prompt: "x", secrets: ["api-key"] }],
      },
      bare: {},
    });
    const entries: Record<string, VaultEntry> = {
      "api-key": { kind: "string", value: "v" },
    };
    const r = await runSecretAccessChecks(
      config,
      deps({ openVault: () => entries }),
    );
    expect(get(r, "secret access: scout")?.status).toBe("ok");
    expect(get(r, "secret access: scout")?.detail).toContain("all present");
    expect(get(r, "secret access: bare")?.detail).toContain(
      "no declared vault secrets",
    );
  });

  it("FAILs when a declared cron secret is missing from the vault", async () => {
    const config = cfg({
      scout: {
        schedule: [{ cron: "0 8 * * *", prompt: "x", secrets: ["api-key"] }],
      },
    });
    const r = await runSecretAccessChecks(
      config,
      deps({ openVault: () => ({}) }),
    );
    const s = get(r, "secret access: scout");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("'api-key' missing from the vault");
    expect(s?.fix).toContain("--allow scout");
  });

  it("config vault: ref is per-key-scope checked but NOT run through checkAclByAgent", async () => {
    const config = cfg({
      tgbot: { channels: { telegram: { bot_token: "vault:tok" } } },
    });
    const okEntries: Record<string, VaultEntry> = {
      tok: { kind: "string", value: "123:ABC" },
    };
    const okR = await runSecretAccessChecks(
      config,
      deps({ openVault: () => okEntries }),
    );
    expect(get(okR, "secret access: tgbot")?.status).toBe("ok");

    const denyEntries: Record<string, VaultEntry> = {
      tok: { kind: "string", value: "v", scope: { deny: ["tgbot"] } },
    };
    const denyR = await runSecretAccessChecks(
      config,
      deps({ openVault: () => denyEntries }),
    );
    const s = get(denyR, "secret access: tgbot");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("per-key scope denies");
    expect(s?.detail).not.toContain("no static ACL");
  });
});

describe("runSecretAccessChecks — Check B broker path (no passphrase)", () => {
  it("ok per agent when the broker reports all keys present + ACL ok", async () => {
    const config = cfg({
      scout: {
        schedule: [{ cron: "0 8 * * *", prompt: "x", secrets: ["api-key"] }],
      },
      bare: {},
    });
    const r = await runSecretAccessChecks(
      config,
      brokerDeps(async (_agent, keys) => ({
        kind: "ok",
        results: keys.map((key) => ({
          key,
          exists: true,
          acl_ok: true,
          scope_ok: true,
        })),
      })),
    );
    expect(get(r, "secret access: scout")?.status).toBe("ok");
    expect(get(r, "secret access: scout")?.detail).toContain("all present");
    expect(get(r, "secret access: bare")?.detail).toContain(
      "no declared vault secrets",
    );
  });

  it("FAILs with the SAME gap strings as the local path (missing / cron-ACL / scope)", async () => {
    const config = cfg({
      scout: {
        schedule: [
          { cron: "0 8 * * *", prompt: "x", secrets: ["missing", "noacl"] },
        ],
      },
    });
    const r = await runSecretAccessChecks(
      config,
      brokerDeps(async (_a, _k) => ({
        kind: "ok",
        results: [
          { key: "missing", exists: false, acl_ok: true, scope_ok: true },
          {
            key: "noacl",
            exists: true,
            acl_ok: false,
            acl_reason: "no allow grant",
            scope_ok: true,
          },
        ],
      })),
    );
    const s = get(r, "secret access: scout");
    expect(s?.status).toBe("fail");
    expect(s?.detail).toContain("'missing' missing from the vault");
    expect(s?.detail).toContain(
      "'noacl' (cron) — no static ACL grants read (no allow grant)",
    );
  });

  it("broker LOCKED → single honest skip (never a false fail)", async () => {
    const r = await runSecretAccessChecks(
      cfg({ a: { schedule: [{ cron: "* * * * *", prompt: "p", secrets: ["k"] }] } }),
      brokerDeps(async () => ({ kind: "locked" })),
    );
    const b = get(r, "agent secret access");
    expect(b?.status).toBe("skip");
    expect(b?.detail).toContain("locked");
    expect(r.some((x) => x.status === "fail")).toBe(false);
  });

  it("broker unreachable → single honest skip (never a false fail)", async () => {
    const r = await runSecretAccessChecks(
      cfg({ a: { schedule: [{ cron: "* * * * *", prompt: "p", secrets: ["k"] }] } }),
      brokerDeps(async () => ({ kind: "unreachable", msg: "ENOENT" })),
    );
    const b = get(r, "agent secret access");
    expect(b?.status).toBe("skip");
    expect(b?.detail).toContain("unreachable");
    expect(r.some((x) => x.status === "fail")).toBe(false);
  });
});

describe("runSecretAccessChecks — #1192 per-agent ACL granularity WARN", () => {
  const okEntries: Record<string, VaultEntry> = {
    "bank/token": { kind: "string", value: "v" },
    "cal/token": { kind: "string", value: "v" },
  };

  it("WARNs (not fails) when 2+ schedule entries declare divergent secrets[] sets", async () => {
    const config = cfg({
      scout: {
        schedule: [
          { cron: "0 8 * * *", prompt: "bank", secrets: ["bank/token"] },
          { cron: "0 9 * * 0", prompt: "cal", secrets: ["cal/token"] },
        ],
      },
    });
    const r = await runSecretAccessChecks(
      config,
      deps({ openVault: () => okEntries }),
    );
    const w = get(r, "secret ACL granularity: scout");
    expect(w?.status).toBe("warn");
    expect(w?.detail).toContain("per-AGENT");
    expect(w?.detail).toContain("UNION");
    // The warn never turns the run red on its own — key access is still ok.
    expect(get(r, "secret access: scout")?.status).toBe("ok");
  });

  it("does NOT warn when the two entries declare IDENTICAL secrets[] sets", async () => {
    const config = cfg({
      scout: {
        schedule: [
          { cron: "0 8 * * *", prompt: "a", secrets: ["bank/token"] },
          { cron: "0 9 * * *", prompt: "b", secrets: ["bank/token"] },
        ],
      },
    });
    const r = await runSecretAccessChecks(
      config,
      deps({ openVault: () => okEntries }),
    );
    expect(get(r, "secret ACL granularity: scout")).toBeUndefined();
  });

  it("does NOT warn for a single schedule entry", async () => {
    const config = cfg({
      scout: {
        schedule: [{ cron: "0 8 * * *", prompt: "a", secrets: ["bank/token"] }],
      },
    });
    const r = await runSecretAccessChecks(
      config,
      deps({ openVault: () => okEntries }),
    );
    expect(get(r, "secret ACL granularity: scout")).toBeUndefined();
  });

  it("also fires on the broker (no-passphrase) path", async () => {
    const config = cfg({
      scout: {
        schedule: [
          { cron: "0 8 * * *", prompt: "bank", secrets: ["bank/token"] },
          { cron: "0 9 * * 0", prompt: "cal", secrets: ["cal/token"] },
        ],
      },
    });
    const r = await runSecretAccessChecks(
      config,
      brokerDeps(async (_a, keys) => ({
        kind: "ok",
        results: keys.map((key) => ({
          key,
          exists: true,
          acl_ok: true,
          scope_ok: true,
        })),
      })),
    );
    expect(get(r, "secret ACL granularity: scout")?.status).toBe("warn");
  });
});
