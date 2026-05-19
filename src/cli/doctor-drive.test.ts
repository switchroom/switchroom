/**
 * doctor-drive — surfaces the Drive integration's silent-failure class.
 *
 * Each case pins a bug class that escaped to a live deploy precisely
 * because nothing checked it up front:
 *   - R1: in enabled_for[] but no per-agent account → broker
 *     ACCOUNT_NOT_FOUND (the "1 of 9 agents work, no warning" finding)
 *   - reverse: per-agent account but not in enabled_for[] → ACCESS_DENIED
 *   - bug-8: .mcp.json gdrive entry missing its env block
 *   - bug-9 / C1: gdrive not trusted in .claude.json
 */

import { describe, expect, it } from "vitest";

import {
  runDriveChecks,
  runDriveBrokerReachabilityChecks,
  type DriveProbeDeps,
} from "./doctor-drive.js";
import type { SwitchroomConfig } from "../config/schema.js";

function cfg(partial: Partial<SwitchroomConfig>): SwitchroomConfig {
  return partial as unknown as SwitchroomConfig;
}

const GOOD_CLIENT = {
  google_client_id: "cid.apps.googleusercontent.com",
  google_client_secret: "GOCSPX-secret",
} as SwitchroomConfig["google_workspace"];

function statuses(rs: { name: string; status: string }[]) {
  return rs.map((r) => `${r.status}:${r.name}`);
}

describe("runDriveChecks — Drive unused", () => {
  it("returns [] when there is no google_accounts and no per-agent account", () => {
    expect(runDriveChecks(cfg({ agents: { carrie: {} as never } }))).toEqual(
      [],
    );
  });
});

describe("runDriveChecks — R1 config-matrix consistency", () => {
  it("FAILS an agent in enabled_for[] with no per-agent google_workspace.account", () => {
    const config = cfg({
      google_workspace: GOOD_CLIENT,
      google_accounts: { "a@gmail.com": { enabled_for: ["clerk", "carrie"] } },
      agents: {
        carrie: { google_workspace: { account: "a@gmail.com" } } as never,
        clerk: {} as never, // in enabled_for[] but NOT matrixed
      },
    });
    const rs = runDriveChecks(config, { existsSync: () => false });
    const clerk = rs.find((r) => r.name.includes("clerk"));
    expect(clerk?.status).toBe("fail");
    expect(clerk?.detail).toContain("ACCOUNT_NOT_FOUND");
    expect(clerk?.fix).toContain("google_workspace.account: a@gmail.com");
    // carrie (correctly matrixed) is ok
    expect(rs.find((r) => r.name.includes("carrie"))?.status).toBe("ok");
  });

  it("FAILS an agent that points at an account but isn't in its enabled_for[]", () => {
    const config = cfg({
      google_workspace: GOOD_CLIENT,
      google_accounts: { "a@gmail.com": { enabled_for: ["carrie"] } },
      agents: {
        carrie: { google_workspace: { account: "a@gmail.com" } } as never,
        ziggy: { google_workspace: { account: "a@gmail.com" } } as never,
      },
    });
    const rs = runDriveChecks(config, { existsSync: () => false });
    const ziggy = rs.find((r) => r.name.includes("ziggy"));
    expect(ziggy?.status).toBe("fail");
    expect(ziggy?.detail).toContain("ACCESS_DENIED");
  });

  it("FAILS an agent whose account has no google_accounts block at all", () => {
    const config = cfg({
      google_workspace: GOOD_CLIENT,
      google_accounts: { "a@gmail.com": { enabled_for: [] } },
      agents: {
        finn: { google_workspace: { account: "ghost@gmail.com" } } as never,
      },
    });
    const rs = runDriveChecks(config, { existsSync: () => false });
    const finn = rs.find((r) => r.name.includes("finn"));
    expect(finn?.status).toBe("fail");
    expect(finn?.detail).toContain("no google_accounts['ghost@gmail.com']");
  });
});

describe("runDriveChecks — OAuth client", () => {
  it("FAILS when a matrixed agent exists but client_secret is unset", () => {
    const config = cfg({
      google_workspace: {
        google_client_id: "cid",
      } as SwitchroomConfig["google_workspace"],
      google_accounts: { "a@gmail.com": { enabled_for: ["carrie"] } },
      agents: {
        carrie: { google_workspace: { account: "a@gmail.com" } } as never,
      },
    });
    const rs = runDriveChecks(config, { existsSync: () => false });
    const oauth = rs.find((r) => r.name.includes("OAuth client"));
    expect(oauth?.status).toBe("fail");
    expect(oauth?.detail).toContain("google_client_secret");
  });

  it("is ok when both client values are present", () => {
    const config = cfg({
      google_workspace: GOOD_CLIENT,
      google_accounts: { "a@gmail.com": { enabled_for: ["carrie"] } },
      agents: {
        carrie: { google_workspace: { account: "a@gmail.com" } } as never,
      },
    });
    const rs = runDriveChecks(config, { existsSync: () => false });
    expect(rs.find((r) => r.name.includes("OAuth client"))?.status).toBe("ok");
  });
});

describe("runDriveChecks — deployed scaffold wiring (bug-8 / bug-9)", () => {
  const base = cfg({
    google_workspace: GOOD_CLIENT,
    google_accounts: { "a@gmail.com": { enabled_for: ["carrie"] } },
    agents: {
      carrie: { google_workspace: { account: "a@gmail.com" } } as never,
    },
  });

  function fsFakes(files: Record<string, string>): DriveProbeDeps {
    return {
      agentsDir: "/agents",
      existsSync: (p) => p === "/agents/carrie" || p in files,
      readFileSync: (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
    };
  }

  it("FAILS when .mcp.json gdrive entry has no env block (bug-8)", () => {
    const rs = runDriveChecks(
      base,
      fsFakes({
        "/agents/carrie/.mcp.json": JSON.stringify({
          mcpServers: { gdrive: { command: "x", args: [] } },
        }),
        "/agents/carrie/.claude/.claude.json": JSON.stringify({
          projects: {
            "/agents/carrie": { enabledMcpjsonServers: ["gdrive"] },
          },
        }),
      }),
    );
    const w = rs.find((r) => r.name === "drive: carrie scaffold");
    expect(w?.status).toBe("fail");
    expect(w?.detail).toContain("no env block");
  });

  it("FAILS when gdrive is not trusted in .claude.json (bug-9 / C1)", () => {
    const rs = runDriveChecks(
      base,
      fsFakes({
        "/agents/carrie/.mcp.json": JSON.stringify({
          mcpServers: { gdrive: { command: "x", args: [], env: { HOME: "/h" } } },
        }),
        "/agents/carrie/.claude/.claude.json": JSON.stringify({
          projects: { "/agents/carrie": { enabledMcpjsonServers: [] } },
        }),
      }),
    );
    const w = rs.find((r) => r.name === "drive: carrie scaffold");
    expect(w?.status).toBe("fail");
    expect(w?.detail).toContain("enabledMcpjsonServers");
  });

  it("is ok when .mcp.json has gdrive+env AND .claude.json trusts it", () => {
    const rs = runDriveChecks(
      base,
      fsFakes({
        "/agents/carrie/.mcp.json": JSON.stringify({
          mcpServers: { gdrive: { command: "x", args: [], env: { HOME: "/h" } } },
        }),
        "/agents/carrie/.claude/.claude.json": JSON.stringify({
          projects: {
            "/agents/carrie": { enabledMcpjsonServers: ["gdrive"] },
          },
        }),
      }),
    );
    expect(
      rs.find((r) => r.name === "drive: carrie scaffold")?.status,
    ).toBe("ok");
  });

  it("WARNS (not fail) when the agent isn't scaffolded yet", () => {
    const rs = runDriveChecks(base, {
      agentsDir: "/agents",
      existsSync: () => false,
    });
    expect(
      rs.find((r) => r.name === "drive: carrie scaffold")?.status,
    ).toBe("warn");
  });

  // Regression for the #1368 doctor false-positive: in the canonical
  // docker topology the scaffold files are agent-UID-owned 0600 and
  // `doctor` runs as the host operator → EACCES. That must read as a
  // single honest "unverifiable from host" WARN, never a `fail`
  // (the original code mislabeled EACCES as ".mcp.json is unparseable"
  // and failed all 9 agents on a perfectly healthy fleet).
  it("SKIPS (not warn/fail) when scaffold files are host-unreadable (EACCES)", () => {
    const rs = runDriveChecks(base, {
      agentsDir: "/agents",
      existsSync: (p) =>
        p === "/agents/carrie" ||
        p === "/agents/carrie/.mcp.json" ||
        p === "/agents/carrie/.claude/.claude.json",
      readFileSync: () => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      },
    });
    const w = rs.find((r) => r.name === "drive: carrie scaffold");
    expect(w?.status).toBe("skip");
    expect(w?.detail).toContain("unverifiable from the host");
    // Crucially: nothing in the section is a `fail` purely because the
    // host can't read agent-UID-owned files.
    expect(rs.filter((r) => r.status === "fail")).toEqual([]);
  });

  it("FAILS when a readable .mcp.json is genuinely corrupt (not EACCES)", () => {
    const rs = runDriveChecks(base, {
      agentsDir: "/agents",
      existsSync: (p) =>
        p === "/agents/carrie" ||
        p === "/agents/carrie/.mcp.json" ||
        p === "/agents/carrie/.claude/.claude.json",
      readFileSync: (p) =>
        p.endsWith(".mcp.json")
          ? "{ this is not json"
          : JSON.stringify({
              projects: {
                "/agents/carrie": { enabledMcpjsonServers: ["gdrive"] },
              },
            }),
    });
    const w = rs.find((r) => r.name === "drive: carrie scaffold");
    expect(w?.status).toBe("fail");
    expect(w?.detail).toContain("corrupt");
  });
});

describe("runDriveBrokerReachabilityChecks — the silent-failure blind spot", () => {
  // This is the check that would have caught #1538 loud: config /
  // scaffold / MCP-trust all green, but the broker DENIES the agent the
  // OAuth client secret, so the gdrive MCP never spawns.
  const DRIVE_CFG = (
    clientSecret: string,
    clientId?: string,
  ): SwitchroomConfig =>
    cfg({
      agents: {
        carrie: { google_workspace: { account: "you@x.com" } } as never,
      },
      google_accounts: { "you@x.com": { enabled_for: ["carrie"] } } as never,
      google_workspace: {
        ...(clientId ? { google_client_id: clientId } : {}),
        google_client_secret: clientSecret,
      } as never,
    });

  it("returns [] when Drive is unused (no drive agents)", async () => {
    expect(
      await runDriveBrokerReachabilityChecks(cfg({ agents: {} as never })),
    ).toEqual([]);
  });

  it("reports ok (no broker needed) when the client secret is a literal", async () => {
    let called = false;
    const rs = await runDriveBrokerReachabilityChecks(
      DRIVE_CFG("GOCSPX-literal"),
      { preflight: async () => { called = true; return { kind: "locked" }; } },
    );
    expect(called).toBe(false);
    expect(rs).toHaveLength(1);
    expect(rs[0].status).toBe("ok");
    expect(rs[0].detail).toContain("literal");
  });

  it("OK when the broker will serve the vault: client secret to the agent", async () => {
    const rs = await runDriveBrokerReachabilityChecks(
      DRIVE_CFG("vault:google/client-secret"),
      {
        preflight: async (_a, keys) => ({
          kind: "ok",
          results: keys.map((key) => ({
            key,
            exists: true,
            acl_ok: true,
            scope_ok: true,
          })),
        }),
      },
    );
    expect(rs).toHaveLength(1);
    expect(rs[0].status).toBe("ok");
    expect(rs[0].name).toBe("drive: carrie client-cred broker-reachable");
  });

  it("FAILS loud when the broker DENIES the client secret (the #1538 regression)", async () => {
    const rs = await runDriveBrokerReachabilityChecks(
      DRIVE_CFG("vault:google/client-secret"),
      {
        preflight: async (_a, keys) => ({
          kind: "ok",
          results: keys.map((key) => ({
            key,
            exists: true,
            acl_ok: false,
            acl_reason:
              "agent 'carrie' has no schedule entries declaring 'secrets'; nothing is broker-accessible",
            scope_ok: true,
          })),
        }),
      },
    );
    expect(rs).toHaveLength(1);
    expect(rs[0].status).toBe("fail");
    expect(rs[0].detail).toContain("DENIES");
    expect(rs[0].detail).toContain("google/client-secret");
    expect(rs[0].detail).toContain("silently never works");
    expect(rs[0].fix).toContain("enabled_for[]");
  });

  it("SKIPS (never false-fails) when the broker is locked", async () => {
    const rs = await runDriveBrokerReachabilityChecks(
      DRIVE_CFG("vault:google/client-secret"),
      { preflight: async () => ({ kind: "locked" }) },
    );
    expect(rs[0].status).toBe("skip");
    expect(rs[0].detail).toContain("locked");
  });

  it("SKIPS (never false-fails) when the broker operator socket is unreachable", async () => {
    const rs = await runDriveBrokerReachabilityChecks(
      DRIVE_CFG("vault:google/client-secret"),
      {
        preflight: async () => ({
          kind: "unreachable",
          msg: "ENOENT operator sock",
        }),
      },
    );
    expect(rs[0].status).toBe("skip");
    expect(rs[0].detail).toContain("unreachable");
  });

  it("probes BOTH client_id and client_secret when both are vault: refs", async () => {
    let seen: string[] = [];
    await runDriveBrokerReachabilityChecks(
      DRIVE_CFG("vault:google/client-secret", "vault:google/client-id"),
      {
        preflight: async (_a, keys) => {
          seen = keys;
          return {
            kind: "ok",
            results: keys.map((key) => ({
              key,
              exists: true,
              acl_ok: true,
              scope_ok: true,
            })),
          };
        },
      },
    );
    expect(seen.sort()).toEqual(
      ["google/client-id", "google/client-secret"].sort(),
    );
  });
});
