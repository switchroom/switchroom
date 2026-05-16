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

import { runDriveChecks, type DriveProbeDeps } from "./doctor-drive.js";
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
});
