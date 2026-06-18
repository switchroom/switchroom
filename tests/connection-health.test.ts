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
// Accepts ok entries as {allow, deny?} and fills deny:[] so fixtures stay terse.
type OkEntry = { kind: "ok"; allow: string[]; deny?: string[] };
type ReaderEntry = OkEntry | { kind: "unreachable"; msg: string } | { kind: "not_found" };
function reader(map: Record<string, ReaderEntry>) {
  return async (key: string): Promise<VaultAclResult> => {
    const e = map[key] ?? { kind: "not_found" as const };
    return e.kind === "ok" ? { kind: "ok", allow: e.allow, deny: e.deny ?? [] } : e;
  };
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

  it("does NOT flag a present key with an EMPTY scope.allow (v0.15.38 false-positive fix)", async () => {
    // The real fleet case: keys have no scope (allow=[] deny=[]). checkEntryScope
    // imposes no restriction on empty allow, so the agent is authed.
    const issues = await computeAgentConnectionIssues(marko, "marko", reader({
      "meta/token": { kind: "ok", allow: [], deny: [] },
      "postiz/key": { kind: "ok", allow: [], deny: [] },
    }));
    expect(issues).toEqual([]);
  });

  it("flags an 'acl' issue when scope.allow is NON-empty and the agent is absent (real denial)", async () => {
    const issues = await computeAgentConnectionIssues(marko, "marko", reader({
      "meta/token": { kind: "ok", allow: ["someoneelse"] }, // non-empty, marko absent → broker denies
      "postiz/key": { kind: "ok", allow: ["marko"] },
    }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ server: "meta", kind: "acl" });
    expect(issues[0].fix).toContain("--allow marko,someoneelse");
  });

  it("flags an 'acl' issue when the agent is in scope.deny (deny wins)", async () => {
    const issues = await computeAgentConnectionIssues(marko, "marko", reader({
      "meta/token": { kind: "ok", allow: [], deny: ["marko"] }, // empty allow but explicit deny
      "postiz/key": { kind: "ok", allow: ["marko"] },
    }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ server: "meta", kind: "acl" });
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
