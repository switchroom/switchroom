import { describe, it, expect } from "vitest";

import {
  runSecretAccessChecks,
  probeOwnedRoot,
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
// ownedRoots empty by default so Check B tests aren't polluted by the
// Check A sweep (which is exercised directly against probeOwnedRoot and
// via the dedicated Check A describe block below).
function deps(over: Partial<SecretAccessDeps> = {}): SecretAccessDeps {
  return {
    vaultPath: "/v",
    selfUid: 1000,
    selfUser: "op",
    statVault: () => READABLE,
    ownedRoots: [],
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
    ownedRoots: [],
    passphrase: undefined,
    preflight,
    ...over,
  };
}

type R = Awaited<ReturnType<typeof runSecretAccessChecks>>;
const get = (r: R, name: string) => r.find((x) => x.name === name);

const ROOT_LOCKED = (real: string): VaultFileStat => ({
  exists: true,
  readable: false,
  uid: 0,
  mode: 0o600,
  realPath: real,
});
const okStat = (real: string): VaultFileStat => ({
  exists: true,
  readable: true,
  uid: 1000,
  mode: 0o600,
  realPath: real,
});
const missingStat = (real: string): VaultFileStat => ({
  exists: false,
  readable: false,
  uid: -1,
  mode: 0,
  realPath: real,
});

describe("probeOwnedRoot — generalized Check A probe", () => {
  it("root-owned path → FAIL with a `sudo chown -R` remediation on the resolved root", () => {
    const root = "/home/op/.switchroom/vault";
    const targets = [root, `${root}/vault.enc`];
    const res = probeOwnedRoot(
      root,
      targets,
      (p) => (p === `${root}/vault.enc` ? ROOT_LOCKED(p) : okStat(p)),
      1000,
      "op",
    );
    expect(res?.status).toBe("fail");
    expect(res?.name).toBe("operator readable: vault");
    expect(res?.detail).toContain("owned by uid 0");
    expect(res?.detail).toContain(`${root}/vault.enc`);
    expect(res?.fix).toBe(`sudo chown -R op:op ${root}`);
  });

  it("correctly-owned path → PASS, no fix", () => {
    const root = "/home/op/.switchroom/accounts";
    const targets = [root, `${root}/creds.json`];
    const res = probeOwnedRoot(root, targets, okStat, 1000, "op");
    expect(res?.status).toBe("ok");
    expect(res?.name).toBe("operator readable: accounts");
    expect(res?.fix).toBeUndefined();
    expect(res?.detail).toContain(root);
  });

  it("missing root (empty target set) → SKIP silently (null)", () => {
    const res = probeOwnedRoot(
      "/home/op/.switchroom/compose",
      [],
      () => missingStat("/x"),
      1000,
      "op",
    );
    expect(res).toBeNull();
  });

  it("resolves the fix against the walker's realpath (symlink-resolved root)", () => {
    // walker already resolved a symlinked root to its real target
    const linkRoot = "/home/op/.switchroom/vault-audit.log";
    const realTarget = "/mnt/data/vault-audit.log";
    const res = probeOwnedRoot(
      linkRoot,
      [realTarget],
      () => ROOT_LOCKED(realTarget),
      1000,
      "op",
    );
    expect(res?.status).toBe("fail");
    // label from the logical root, fix from the resolved real target
    expect(res?.name).toBe("operator readable: vault-audit.log");
    expect(res?.fix).toBe(`sudo chown -R op:op ${realTarget}`);
  });
});

describe("runSecretAccessChecks — Check A sweep integration", () => {
  it("sweeps the injected owned roots: one FAIL (root-locked) + one OK, missing skipped", async () => {
    const vaultRoot = "/home/op/.switchroom/vault";
    const acctRoot = "/home/op/.switchroom/accounts";
    const composeRoot = "/home/op/.switchroom/compose";
    const r = await runSecretAccessChecks(
      cfg({}),
      deps({
        ownedRoots: [vaultRoot, acctRoot, composeRoot],
        walkOwned: (root) =>
          root === composeRoot ? [] : [root], // compose absent
        statPath: (p) => (p === vaultRoot ? ROOT_LOCKED(p) : okStat(p)),
      }),
    );
    expect(get(r, "operator readable: vault")?.status).toBe("fail");
    expect(get(r, "operator readable: vault")?.fix).toBe(
      `sudo chown -R op:op ${vaultRoot}`,
    );
    expect(get(r, "operator readable: accounts")?.status).toBe("ok");
    // compose absent → no result at all (silent skip)
    expect(get(r, "operator readable: compose")).toBeUndefined();
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
