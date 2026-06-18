import { describe, it, expect } from "vitest";
import {
  computeMcpSecretRequirements,
  runMcpSecretChecks,
  type VaultAclResult,
} from "../src/cli/doctor-mcp-secrets.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

// Minimal config builder — only the fields the probe reads.
function cfg(partial: Record<string, unknown>): SwitchroomConfig {
  return partial as unknown as SwitchroomConfig;
}

/** A vaultAclReader stub from a key→result map (default: not_found). */
function reader(map: Record<string, VaultAclResult>) {
  return async (key: string): Promise<VaultAclResult> =>
    map[key] ?? { kind: "not_found" };
}

describe("computeMcpSecretRequirements", () => {
  it("collects per-agent user-declared MCP secrets", () => {
    const reqs = computeMcpSecretRequirements(
      cfg({
        agents: {
          marko: {
            mcp_servers: {
              meta: { command: "meta-mcp", secrets: ["meta/token"] },
              postiz: { command: "postiz-mcp", secrets: ["postiz/api-key"] },
            },
          },
        },
      }),
    );
    expect(reqs).toEqual([
      { agent: "marko", server: "meta", keys: ["meta/token"] },
      { agent: "marko", server: "postiz", keys: ["postiz/api-key"] },
    ]);
  });

  it("applies the defaults → profile → agent cascade (acl.ts parity)", () => {
    const reqs = computeMcpSecretRequirements(
      cfg({
        defaults: {
          mcp_servers: { perplexity: { command: "px", secrets: ["perplexity/api-key"] } },
        },
        profiles: {
          marketing: { mcp_servers: { brevo: { command: "brevo", secrets: ["brevo/key"] } } },
        },
        agents: {
          marko: {
            extends: "marketing",
            mcp_servers: { meta: { command: "meta", secrets: ["meta/token"] } },
          },
        },
      }),
    );
    const servers = reqs.map((r) => r.server).sort();
    // defaults(perplexity) + profile(brevo) + agent(meta) all visible.
    expect(servers).toEqual(["brevo", "meta", "perplexity"]);
  });

  it("a per-agent entry fully replaces the defaults entry at that key", () => {
    const reqs = computeMcpSecretRequirements(
      cfg({
        defaults: { mcp_servers: { px: { command: "px", secrets: ["old/key"] } } },
        agents: { a: { mcp_servers: { px: { command: "px", secrets: ["new/key"] } } } },
      }),
    );
    expect(reqs).toEqual([{ agent: "a", server: "px", keys: ["new/key"] }]);
  });

  it("skips false opt-outs, scalars, and entries without a secrets[] array", () => {
    const reqs = computeMcpSecretRequirements(
      cfg({
        agents: {
          a: {
            mcp_servers: {
              perplexity: false, // opt-out
              webkite: { command: "webkite" }, // no secrets[]
              note: "scalar", // not an object
              meta: { command: "m", secrets: [] }, // empty
              real: { command: "r", secrets: ["real/key"] },
            },
          },
        },
      }),
    );
    expect(reqs).toEqual([{ agent: "a", server: "real", keys: ["real/key"] }]);
  });

  it("returns nothing when no agent declares MCP secrets", () => {
    expect(computeMcpSecretRequirements(cfg({ agents: { a: {} } }))).toEqual([]);
  });
});

describe("runMcpSecretChecks", () => {
  const base = cfg({
    agents: {
      marko: { mcp_servers: { meta: { command: "m", secrets: ["meta/token"] } } },
    },
  });

  it("returns [] (silent) when no MCP secrets are declared", async () => {
    expect(await runMcpSecretChecks(cfg({ agents: { a: {} } }))).toEqual([]);
  });

  it("FAILs a configured-but-unauthed connection (missing key) with a fix", async () => {
    const res = await runMcpSecretChecks(base, {
      vaultAclReader: reader({}), // meta/token not_found
    });
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe("fail");
    expect(res[0].detail).toContain("configured but NOT authed");
    expect(res[0].fix).toContain("switchroom vault set meta/token --allow marko");
  });

  it("FAILs when the key exists but the agent is off its ACL (re-states full list)", async () => {
    const res = await runMcpSecretChecks(base, {
      vaultAclReader: reader({ "meta/token": { kind: "ok", allow: ["someoneelse"] } }),
    });
    expect(res[0].status).toBe("fail");
    expect(res[0].detail).toContain("NOT on the vault ACL");
    // fix re-states the FULL list (existing + marko), sorted.
    expect(res[0].fix).toContain("--allow marko,someoneelse");
  });

  it("OKs when the key exists and the agent is on its ACL", async () => {
    const res = await runMcpSecretChecks(base, {
      vaultAclReader: reader({ "meta/token": { kind: "ok", allow: ["marko"] } }),
    });
    expect(res[0].status).toBe("ok");
  });

  it("WARNs (never fails) when the broker is unreachable — fail-safe", async () => {
    const res = await runMcpSecretChecks(base, {
      vaultAclReader: async () => ({ kind: "unreachable", msg: "socket down" }),
    });
    expect(res[0].status).toBe("warn");
    expect(res[0].detail).toContain("unreachable");
  });

  it("reads each shared key once and lists all needing agents in the fix", async () => {
    let reads = 0;
    const shared = cfg({
      agents: {
        a: { mcp_servers: { px: { command: "p", secrets: ["px/key"] } } },
        b: { mcp_servers: { px: { command: "p", secrets: ["px/key"] } } },
      },
    });
    const res = await runMcpSecretChecks(shared, {
      vaultAclReader: async (key) => {
        reads++;
        return { kind: "not_found" as const, _k: key } as VaultAclResult;
      },
    });
    expect(reads).toBe(1); // cached across both agents
    // both agents fail, and each fix names both agents (sorted)
    expect(res.every((r) => r.fix?.includes("--allow a,b"))).toBe(true);
  });
});
