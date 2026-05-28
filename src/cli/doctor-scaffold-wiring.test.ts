/**
 * Tests for the shared scaffold-wiring probe (extracted from
 * `doctor-drive.ts` so m365 + notion can reuse it).
 *
 * Two regression-gate classes pinned here:
 *   - **bug-8 class**: `.mcp.json` carries the integration's entry
 *     but with no env block. Claude spawns the MCP with a sanitized
 *     env so the launcher can't reach switchroom.yaml / the broker.
 *   - **bug-9 class**: `.claude.json` `projects[<agentDir>].enabledMcpjsonServers`
 *     doesn't include the integration's key — Claude silently ignores
 *     the un-allowlisted server.
 *
 * Both are scaffold-side failures that the original `doctor-drive`
 * probe added to catch (and which the m365 + notion releases
 * inherited unguarded). The shared helper closes both gaps for the
 * other two integrations.
 */

import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkIntegrationScaffoldWiring,
  type ScaffoldWiringDeps,
} from "./doctor-scaffold-wiring.js";

const AGENTS_DIR = "/tmp/agents";

function fakeFs(files: Record<string, string | "unreadable">): ScaffoldWiringDeps {
  return {
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (v === "unreadable") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return v;
    },
  };
}

describe("checkIntegrationScaffoldWiring — empty agents", () => {
  it("returns no results when agents list is empty", () => {
    const r = checkIntegrationScaffoldWiring({
      label: "notion",
      mcpKey: "notion",
      agents: [],
      agentsDir: AGENTS_DIR,
      deps: fakeFs({}),
    });
    expect(r).toEqual([]);
  });

  it("warns once when agentsDir is undefined", () => {
    const r = checkIntegrationScaffoldWiring({
      label: "ms-365",
      mcpKey: "ms-365",
      agents: ["clerk"],
      agentsDir: undefined,
      deps: fakeFs({}),
    });
    expect(r.length).toBe(1);
    expect(r[0].status).toBe("warn");
    expect(r[0].detail).toMatch(/agents directory/);
  });
});

describe("checkIntegrationScaffoldWiring — happy path", () => {
  it("emits ok when .mcp.json has the entry with env AND .claude.json trusts it", () => {
    const agentDir = resolve(AGENTS_DIR, "clerk");
    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");
    const fs = fakeFs({
      [agentDir]: "",
      [mcpPath]: JSON.stringify({
        mcpServers: { notion: { command: "x", env: { HOME: "/tmp" } } },
      }),
      [claudeJsonPath]: JSON.stringify({
        projects: { [agentDir]: { enabledMcpjsonServers: ["notion"] } },
      }),
    });

    const r = checkIntegrationScaffoldWiring({
      label: "notion",
      mcpKey: "notion",
      agents: ["clerk"],
      agentsDir: AGENTS_DIR,
      deps: fs,
    });

    expect(r.length).toBe(1);
    expect(r[0].status).toBe("ok");
    expect(r[0].name).toBe("notion: clerk scaffold");
    expect(r[0].detail).toMatch(/wired in \.mcp\.json/);
  });
});

describe("checkIntegrationScaffoldWiring — bug-8 (missing env block)", () => {
  it("FAILS when entry exists but env is missing/empty", () => {
    const agentDir = resolve(AGENTS_DIR, "carrie");
    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");
    const fs = fakeFs({
      [agentDir]: "",
      [mcpPath]: JSON.stringify({
        mcpServers: { notion: { command: "x" } }, // no env!
      }),
      [claudeJsonPath]: JSON.stringify({
        projects: { [agentDir]: { enabledMcpjsonServers: ["notion"] } },
      }),
    });

    const r = checkIntegrationScaffoldWiring({
      label: "notion",
      mcpKey: "notion",
      agents: ["carrie"],
      agentsDir: AGENTS_DIR,
      deps: fs,
    });

    expect(r[0].status).toBe("fail");
    expect(r[0].detail).toMatch(/env block|bug-8/);
    expect(r[0].fix).toMatch(/switchroom agent restart carrie/);
  });
});

describe("checkIntegrationScaffoldWiring — bug-9 (trust list missing)", () => {
  it("FAILS when .mcp.json is fine but .claude.json doesn't enable the server", () => {
    const agentDir = resolve(AGENTS_DIR, "clerk");
    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");
    const fs = fakeFs({
      [agentDir]: "",
      [mcpPath]: JSON.stringify({
        mcpServers: { "ms-365": { command: "x", env: { HOME: "/tmp" } } },
      }),
      [claudeJsonPath]: JSON.stringify({
        projects: { [agentDir]: { enabledMcpjsonServers: [] } }, // ms-365 NOT enabled
      }),
    });

    const r = checkIntegrationScaffoldWiring({
      label: "ms-365",
      mcpKey: "ms-365",
      agents: ["clerk"],
      agentsDir: AGENTS_DIR,
      deps: fs,
    });

    expect(r[0].status).toBe("fail");
    expect(r[0].detail).toMatch(/enabledMcpjsonServers|bug-9/);
  });
});

describe("checkIntegrationScaffoldWiring — entry missing entirely", () => {
  it("FAILS when .mcp.json has no entry for the integration's key", () => {
    const agentDir = resolve(AGENTS_DIR, "clerk");
    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");
    const fs = fakeFs({
      [agentDir]: "",
      [mcpPath]: JSON.stringify({ mcpServers: { gdrive: { env: { x: "y" } } } }),
      [claudeJsonPath]: JSON.stringify({
        projects: { [agentDir]: { enabledMcpjsonServers: ["gdrive"] } },
      }),
    });

    const r = checkIntegrationScaffoldWiring({
      label: "notion",
      mcpKey: "notion",
      agents: ["clerk"],
      agentsDir: AGENTS_DIR,
      deps: fs,
    });

    expect(r[0].status).toBe("fail");
    expect(r[0].detail).toMatch(/no notion server/);
  });
});

describe("checkIntegrationScaffoldWiring — unreadable (EACCES, 0600 by agent UID)", () => {
  it("SKIPS rather than fails — host operator can't read agent-owned files", () => {
    const agentDir = resolve(AGENTS_DIR, "clerk");
    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");
    const fs = fakeFs({
      [agentDir]: "",
      [mcpPath]: "unreadable",
      [claudeJsonPath]: "unreadable",
    });

    const r = checkIntegrationScaffoldWiring({
      label: "ms-365",
      mcpKey: "ms-365",
      agents: ["clerk"],
      agentsDir: AGENTS_DIR,
      deps: fs,
    });

    expect(r[0].status).toBe("skip");
    expect(r[0].detail).toMatch(/agent-UID-owned/);
  });
});

describe("checkIntegrationScaffoldWiring — corrupt JSON", () => {
  it("FAILS when .mcp.json is unparseable", () => {
    const agentDir = resolve(AGENTS_DIR, "clerk");
    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");
    const fs = fakeFs({
      [agentDir]: "",
      [mcpPath]: "{ not valid json",
      [claudeJsonPath]: JSON.stringify({
        projects: { [agentDir]: { enabledMcpjsonServers: ["notion"] } },
      }),
    });

    const r = checkIntegrationScaffoldWiring({
      label: "notion",
      mcpKey: "notion",
      agents: ["clerk"],
      agentsDir: AGENTS_DIR,
      deps: fs,
    });

    expect(r[0].status).toBe("fail");
    expect(r[0].detail).toMatch(/not valid JSON/);
  });
});

describe("checkIntegrationScaffoldWiring — unscaffolded agent", () => {
  it("WARNS when agent dir doesn't exist yet", () => {
    const r = checkIntegrationScaffoldWiring({
      label: "notion",
      mcpKey: "notion",
      agents: ["new-agent"],
      agentsDir: AGENTS_DIR,
      deps: fakeFs({}),
    });
    expect(r[0].status).toBe("warn");
    expect(r[0].detail).toMatch(/not scaffolded yet/);
  });
});
