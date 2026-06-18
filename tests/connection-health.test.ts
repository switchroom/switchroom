import { describe, it, expect } from "vitest";
import {
  computeAgentConnectionIssues,
  refreshAgentConnectionHealth,
  writeConnectionHealthFile,
  type ConnectionHealth,
} from "../src/agents/connection-health.js";
import type { VaultAclResult } from "../src/cli/doctor-mcp-secrets.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

function cfg(partial: Record<string, unknown>): SwitchroomConfig {
  return partial as unknown as SwitchroomConfig;
}
function reader(map: Record<string, VaultAclResult>) {
  return async (key: string): Promise<VaultAclResult> =>
    map[key] ?? { kind: "not_found" };
}

const marko = cfg({
  agents: {
    marko: {
      mcp_servers: {
        meta: { command: "m", secrets: ["meta/token"] },
        postiz: { command: "p", secrets: ["postiz/key"] },
      },
    },
    clerk: { mcp_servers: {} },
  },
});

describe("computeAgentConnectionIssues", () => {
  it("flags a missing key as a 'missing' issue with a fix, scoped to the agent", async () => {
    const issues = await computeAgentConnectionIssues(marko, "marko", reader({
      "postiz/key": { kind: "ok", allow: ["marko"] }, // authed
      // meta/token → not_found
    }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ server: "meta", key: "meta/token", kind: "missing" });
    expect(issues[0].fix).toContain("switchroom vault set meta/token --allow marko");
  });

  it("flags ACL drift as an 'acl' issue and re-states the full allowlist", async () => {
    const issues = await computeAgentConnectionIssues(marko, "marko", reader({
      "meta/token": { kind: "ok", allow: ["someoneelse"] },
      "postiz/key": { kind: "ok", allow: ["marko"] },
    }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ server: "meta", kind: "acl" });
    expect(issues[0].fix).toContain("--allow marko,someoneelse");
  });

  it("returns no issues when everything is authed", async () => {
    const issues = await computeAgentConnectionIssues(marko, "marko", reader({
      "meta/token": { kind: "ok", allow: ["marko"] },
      "postiz/key": { kind: "ok", allow: ["marko"] },
    }));
    expect(issues).toEqual([]);
  });

  it("FAIL-SAFE: broker unreachable → zero issues (auth assumed), never false-flags", async () => {
    const issues = await computeAgentConnectionIssues(marko, "marko", async () => ({
      kind: "unreachable",
      msg: "down",
    }));
    expect(issues).toEqual([]);
  });

  it("returns [] for an agent with no MCP secrets", async () => {
    const issues = await computeAgentConnectionIssues(marko, "clerk", reader({}));
    expect(issues).toEqual([]);
  });
});

describe("refreshAgentConnectionHealth", () => {
  it("writes a snapshot with computedAt + issues via injected fs", async () => {
    const writes: Record<string, string> = {};
    const mkdirs: string[] = [];
    const health = await refreshAgentConnectionHealth(marko, "marko", "/agents/marko", {
      vaultAclReader: reader({}), // both keys missing
      now: () => 1234,
      mkdir: (p) => { mkdirs.push(p); },
      writeFile: (p, d) => { writes[p] = d; },
    });
    expect(health.computedAt).toBe(1234);
    expect(health.issues.map((i) => i.server).sort()).toEqual(["meta", "postiz"]);
    expect(mkdirs).toContain("/agents/marko/.claude");
    const written = JSON.parse(writes["/agents/marko/.claude/connection-health.json"]) as ConnectionHealth;
    expect(written.issues).toHaveLength(2);
  });

  it("never throws when the ACL reader throws — writes an empty (healthy) snapshot", async () => {
    const writes: Record<string, string> = {};
    const health = await refreshAgentConnectionHealth(marko, "marko", "/a/marko", {
      vaultAclReader: async () => { throw new Error("boom"); },
      now: () => 7,
      mkdir: () => {},
      writeFile: (p, d) => { writes[p] = d; },
    });
    expect(health.issues).toEqual([]);
    expect(Object.keys(writes)).toHaveLength(1);
  });

  it("never throws when the write fails", async () => {
    await expect(
      refreshAgentConnectionHealth(marko, "marko", "/a/marko", {
        vaultAclReader: reader({}),
        mkdir: () => {},
        writeFile: () => { throw new Error("EACCES"); },
      }),
    ).resolves.toBeDefined();
  });
});

describe("writeConnectionHealthFile", () => {
  it("targets <agentDir>/.claude/connection-health.json", () => {
    let path = "";
    writeConnectionHealthFile("/x/y", { computedAt: 1, issues: [] }, {
      mkdir: () => {},
      writeFile: (p) => { path = p; },
    });
    expect(path).toBe("/x/y/.claude/connection-health.json");
  });
});
