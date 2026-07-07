import { describe, it, expect, vi, afterEach } from "vitest";

import {
  resolveOperatorUid,
  restoreOperatorOwnership,
  operatorOwnedPaths,
  type OwnershipRestoreDeps,
} from "../src/cli/operator-uid.js";

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

  it("returns undefined when running as real root with no SUDO_UID and no hostd uid", () => {
    delete process.env.SUDO_UID;
    delete process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(resolveOperatorUid()).toBeUndefined();
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
    expect(resolveOperatorUid()).toBeUndefined();
    process.env.SWITCHROOM_HOSTD_OPERATOR_UID = "notanumber";
    expect(resolveOperatorUid()).toBeUndefined();
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
