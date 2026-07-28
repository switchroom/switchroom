import { describe, it, expect, vi, afterEach } from "vitest";

import {
  resolveOperatorUid,
  resolveOperatorUidFromOwnership,
  operatorHomeCandidates,
  restoreOperatorOwnership,
  operatorOwnedPaths,
  type OperatorUidOwnershipDeps,
  type OwnershipRestoreDeps,
} from "../src/cli/operator-uid.js";

/**
 * Ownership tier stubbed to "nothing on disk" — the pre-#3928 behaviour.
 * Passed explicitly wherever a test asserts the env/syscall tiers in
 * isolation, so the assertion never depends on whether the machine
 * running the suite happens to have a real `~/.switchroom`.
 */
const NO_OWNERSHIP: OperatorUidOwnershipDeps = {
  env: {},
  home: "/nonexistent",
  exists: () => false,
  statUid: () => undefined,
};

const savedSudoUid = process.env.SUDO_UID;
const savedHostdUid = process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
afterEach(() => {
  if (savedSudoUid === undefined) delete process.env.SUDO_UID;
  else process.env.SUDO_UID = savedSudoUid;
  if (savedHostdUid === undefined) delete process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
  else process.env.SWITCHROOM_HOSTD_OPERATOR_UID = savedHostdUid;
  vi.restoreAllMocks();
});

describe("resolveOperatorUid", () => {
  it("prefers a valid SUDO_UID", () => {
    process.env.SUDO_UID = "1234";
    expect(resolveOperatorUid()).toBe(1234);
  });

  it("ignores SUDO_UID=0 and non-numeric, falling back to getuid()", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    process.env.SUDO_UID = "0";
    expect(resolveOperatorUid()).toBe(1000);
    process.env.SUDO_UID = "notanumber";
    expect(resolveOperatorUid()).toBe(1000);
  });

  it("returns undefined when running as real root with no SUDO_UID, no hostd uid, and no readable switchroom home", () => {
    delete process.env.SUDO_UID;
    delete process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(resolveOperatorUid(NO_OWNERSHIP)).toBeUndefined();
  });

  it("falls back to SWITCHROOM_HOSTD_OPERATOR_UID under root with no SUDO_UID (hostd-spawned apply)", () => {
    delete process.env.SUDO_UID;
    process.env.SWITCHROOM_HOSTD_OPERATOR_UID = "1000";
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(resolveOperatorUid()).toBe(1000);
  });

  it("prefers a real getuid()/SUDO_UID over SWITCHROOM_HOSTD_OPERATOR_UID", () => {
    process.env.SWITCHROOM_HOSTD_OPERATOR_UID = "1000";
    process.env.SUDO_UID = "1234";
    expect(resolveOperatorUid()).toBe(1234);
    delete process.env.SUDO_UID;
    vi.spyOn(process, "getuid").mockReturnValue(4242);
    expect(resolveOperatorUid()).toBe(4242);
  });

  it("ignores an invalid SWITCHROOM_HOSTD_OPERATOR_UID (0 / non-numeric)", () => {
    delete process.env.SUDO_UID;
    vi.spyOn(process, "getuid").mockReturnValue(0);
    process.env.SWITCHROOM_HOSTD_OPERATOR_UID = "0";
    expect(resolveOperatorUid(NO_OWNERSHIP)).toBeUndefined();
    process.env.SWITCHROOM_HOSTD_OPERATOR_UID = "notanumber";
    expect(resolveOperatorUid(NO_OWNERSHIP)).toBeUndefined();
  });

  // #3928 amendment — the whole point of switchroom is that the operator
  // drives the fleet from Telegram. An agent / hostd container is root
  // with no SUDO_UID by construction, so before this tier the CLI simply
  // refused (`webd install`) or silently degraded (`hostd install`
  // omitting SWITCHROOM_HOSTD_OPERATOR_UID from the compose it writes,
  // which propagates the same failure into the container it creates).
  it("derives the operator uid from the owner of ~/.switchroom under root with no env hints", () => {
    delete process.env.SUDO_UID;
    delete process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(
      resolveOperatorUid({
        env: {},
        home: "/host-home",
        exists: (p) => p === "/host-home/.switchroom/switchroom.yaml",
        statUid: (p) => (p === "/host-home/.switchroom" ? 1000 : undefined),
      }),
    ).toBe(1000);
  });

  it("never lets the ownership tier override a real SUDO_UID / getuid()", () => {
    const ownedBySomeoneElse: OperatorUidOwnershipDeps = {
      env: {},
      home: "/host-home",
      exists: () => true,
      statUid: () => 4242,
    };
    process.env.SUDO_UID = "1234";
    expect(resolveOperatorUid(ownedBySomeoneElse)).toBe(1234);
    delete process.env.SUDO_UID;
    vi.spyOn(process, "getuid").mockReturnValue(1001);
    expect(resolveOperatorUid(ownedBySomeoneElse)).toBe(1001);
  });
});

describe("resolveOperatorUidFromOwnership (#3928)", () => {
  it("reads the DIRECTORY's owner, not the config file's", () => {
    // Load-bearing: on the reference host `~/.switchroom/switchroom.yaml`
    // is root-owned (a root-mode `apply` rewrote it) while `~/.switchroom`
    // itself is still 1000:1000. Statting the file would resolve uid 0 and
    // be rejected, stranding the operator exactly as before.
    const statted: string[] = [];
    const uid = resolveOperatorUidFromOwnership({
      env: {},
      home: "/host-home",
      exists: () => true,
      statUid: (p) => {
        statted.push(p);
        return p.endsWith(".yaml") ? 0 : 1000;
      },
    });
    expect(uid).toBe(1000);
    expect(statted).toEqual(["/host-home/.switchroom"]);
  });

  it("REJECTS a root-owned switchroom home rather than adopting uid 0", () => {
    // Adopting 0 would write `user: "0:0"` into the web compose, and every
    // agent gateway's peercred ACL would silently 503 the webhook forward —
    // the exact breakage the original refusal existed to prevent.
    expect(
      resolveOperatorUidFromOwnership({
        env: {},
        home: "/root",
        exists: () => true,
        statUid: () => 0,
      }),
    ).toBeUndefined();
  });

  it("ignores a .switchroom dir with no switchroom.yaml in it", () => {
    expect(
      resolveOperatorUidFromOwnership({
        env: {},
        home: "/somewhere",
        exists: () => false,
        statUid: () => 1000,
      }),
    ).toBeUndefined();
  });

  it("falls through a candidate that is not visible here to one that is", () => {
    // Inside hostd / an agent container SWITCHROOM_HOST_HOME is the HOST
    // path (`/home/op`), which does not exist in that mount namespace; the
    // operator home is visible at the bind mount instead.
    const uid = resolveOperatorUidFromOwnership({
      env: { SWITCHROOM_HOST_HOME: "/home/op" },
      home: "/state/agent/home",
      exists: (p) => p === "/host-home/.switchroom/switchroom.yaml",
      statUid: (p) => (p === "/host-home/.switchroom" ? 1000 : undefined),
    });
    expect(uid).toBe(1000);
  });
});

describe("operatorHomeCandidates", () => {
  it("orders SWITCHROOM_HOST_HOME → process home → /host-home, deduped", () => {
    expect(
      operatorHomeCandidates({ SWITCHROOM_HOST_HOME: "/home/op" }, "/host-home"),
    ).toEqual(["/home/op/.switchroom", "/host-home/.switchroom"]);
    expect(operatorHomeCandidates({}, "/host-home")).toEqual([
      "/host-home/.switchroom",
    ]);
    expect(operatorHomeCandidates({}, "/root")).toEqual([
      "/root/.switchroom",
      "/host-home/.switchroom",
    ]);
  });
});

describe("operatorOwnedPaths", () => {
  it("covers vault, auto-unlock, audit logs, accounts, compose — not per-agent dirs", () => {
    const p = operatorOwnedPaths("/home/op");
    expect(p).toContain("/home/op/.switchroom/vault");
    expect(p).toContain("/home/op/.switchroom/vault-auto-unlock");
    expect(p).toContain("/home/op/.switchroom/vault-audit.log");
    expect(p).toContain("/home/op/.switchroom/host-control-audit.log");
    expect(p).toContain("/home/op/.switchroom/accounts");
    expect(p).toContain("/home/op/.switchroom/compose");
    expect(p.some((x) => x.includes("/agents"))).toBe(false);
  });
});

describe("restoreOperatorOwnership", () => {
  function fs(
    layout: Record<string, "file" | "dir" | "symlink">,
    children: Record<string, string[]> = {},
    realpaths: Record<string, string> = {},
  ): { calls: Array<[string, number, number]>; deps: OwnershipRestoreDeps } {
    const calls: Array<[string, number, number]> = [];
    return {
      calls,
      deps: {
        chown: (p, u, g) => {
          calls.push([p, u, g]);
        },
        exists: (p) => p in layout,
        isDir: (p) => layout[realpaths[p] ?? p] === "dir",
        isSymlink: (p) => layout[p] === "symlink",
        realpath: (p) => realpaths[p] ?? p,
        readdir: (p) => children[p] ?? [],
      },
    };
  }

  it("chowns every existing operator-owned path to operatorUid:operatorUid", () => {
    const root = "/h/.switchroom";
    const { calls, deps } = fs({
      [`${root}/vault`]: "dir",
      [`${root}/vault/vault.enc`]: "file",
      [`${root}/vault-audit.log`]: "file",
      // accounts/auto-unlock/host-control-audit/compose absent
    }, { [`${root}/vault`]: ["vault.enc"] });
    const done = restoreOperatorOwnership("/h", 1000, deps);
    expect(calls).toContainEqual([`${root}/vault`, 1000, 1000]);
    expect(calls).toContainEqual([`${root}/vault/vault.enc`, 1000, 1000]);
    expect(calls).toContainEqual([`${root}/vault-audit.log`, 1000, 1000]);
    expect(done).toContain(`${root}/vault/vault.enc`);
    // absent paths never chowned
    expect(calls.some(([p]) => p.includes("accounts"))).toBe(false);
  });

  it("follows a symlink to its realpath (v0.7.12 vault.enc legacy link)", () => {
    const root = "/h/.switchroom";
    const { calls, deps } = fs(
      {
        [`${root}/vault`]: "dir",
        [`${root}/vault/vault.enc`]: "file",
      },
      { [`${root}/vault`]: ["vault.enc", "vault.enc.legacy"] },
      { [`${root}/vault/vault.enc.legacy`]: `${root}/vault/vault.enc` },
    );
    // legacy entry is a symlink → resolves to the same real file (dedup)
    deps.isSymlink = (p) => p === `${root}/vault/vault.enc.legacy`;
    deps.exists = (p) =>
      p === `${root}/vault` ||
      p === `${root}/vault/vault.enc` ||
      p === `${root}/vault/vault.enc.legacy`;
    restoreOperatorOwnership("/h", 42, deps);
    const realFileChowns = calls.filter(
      ([p]) => p === `${root}/vault/vault.enc`,
    );
    expect(realFileChowns).toHaveLength(1); // deduped, not chowned twice
  });

  it("is best-effort: one failing chown does not abort the rest", () => {
    const root = "/h/.switchroom";
    const { deps } = fs({
      [`${root}/vault`]: "file",
      [`${root}/accounts`]: "file",
    });
    const got: string[] = [];
    deps.chown = (p) => {
      if (p === `${root}/vault`) throw new Error("EPERM");
      got.push(p);
    };
    const done = restoreOperatorOwnership("/h", 7, deps);
    expect(got).toContain(`${root}/accounts`);
    expect(done).toContain(`${root}/accounts`);
    expect(done).not.toContain(`${root}/vault`);
  });

  it("no-ops cleanly when nothing exists", () => {
    const { calls, deps } = fs({});
    expect(restoreOperatorOwnership("/h", 1000, deps)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
