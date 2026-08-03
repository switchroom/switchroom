import { describe, it, expect } from "vitest";

import type { SwitchroomConfig } from "../config/schema.js";
import { runBuzzChecks, computeBuzzAgents, BUZZ_HEARTBEAT_STALE_MS } from "./doctor-buzz.js";
import { buzzHeartbeatOperatorPath, type BuzzHeartbeat } from "../buzz-gateway/heartbeat.js";
import type { BuzzPipelineSummary } from "../buzz-gateway/stats.js";

const HOME = "/home/op";
const AGENTS_DIR = `${HOME}/.switchroom/agents`;

const FULL_RELAY = {
  relay_url: "ws://127.0.0.1:3000",
  relay_host: "127.0.0.1:3000",
  operator_pubkey: "a".repeat(64),
  chat_id: "555",
  default_channel_id: "group-uuid",
};

function cfg(buzzByAgent: Record<string, Record<string, unknown> | undefined>): SwitchroomConfig {
  const agents: Record<string, unknown> = {};
  for (const [name, buzz] of Object.entries(buzzByAgent)) {
    agents[name] = buzz ? { channels: { buzz } } : {};
  }
  return { agents } as unknown as SwitchroomConfig;
}

const SUMMARY: BuzzPipelineSummary = {
  received: 10, injected: 6, duplicate: 1, queued: 0, injectFailed: 0,
  droppedByKind: 1, channelOff: 0, authFailures: 2, mirrorOk: 3, mirrorFailed: 0,
};

function heartbeat(over: Partial<BuzzHeartbeat> = {}): string {
  return JSON.stringify({
    v: 1, agent: "alpha", ts: 1_000_000, bootTs: 900_000, subscribed: true, stats: SUMMARY, ...over,
  });
}

/** A deps bundle where the ONE agent 'alpha' has a heartbeat file. */
function deps(opts: {
  heartbeatContent?: string | null;
  heartbeatMtimeMs?: number;
  now?: number;
  acl?:
    | { kind: "ok"; allow: string[] }
    | { kind: "unreachable"; msg: string }
    | { kind: "not_found" };
}) {
  const path = buzzHeartbeatOperatorPath(`${AGENTS_DIR}/alpha`);
  const has = opts.heartbeatContent != null;
  return {
    homeDir: () => HOME,
    now: () => opts.now ?? 2_000_000,
    existsSync: (p: string) => p === path && has,
    statSync: (p: string) => {
      if (p !== path || !has) throw new Error("ENOENT");
      return { mtimeMs: opts.heartbeatMtimeMs ?? 2_000_000 };
    },
    readFileSync: (p: string) => {
      if (p !== path || !has) throw new Error("ENOENT");
      return opts.heartbeatContent as string;
    },
    vaultAclReader: async () => opts.acl ?? { kind: "ok" as const, allow: ["alpha"] },
  };
}

function row(results: Awaited<ReturnType<typeof runBuzzChecks>>, prefix: string) {
  return results.find((r) => r.name.startsWith(prefix));
}

describe("computeBuzzAgents", () => {
  it("returns only agents that declare channels.buzz, with defaults applied", () => {
    const config = cfg({ alpha: { enabled: true, ...FULL_RELAY }, beta: undefined });
    const agents = computeBuzzAgents(config);
    expect(agents.map((a) => a.agent)).toEqual(["alpha"]);
    expect(agents[0].mirror).toBe("both"); // schema default re-applied
    expect(agents[0].live).toBe(true);
    expect(agents[0].nsecVaultKey).toBe("buzz/alpha-nsec"); // {agent} substituted
  });

  it("no agent with channels.buzz → runBuzzChecks yields zero rows", async () => {
    const results = await runBuzzChecks(cfg({ beta: undefined }), deps({ acl: { kind: "ok", allow: [] } }));
    expect(results).toEqual([]);
  });
});

describe("runBuzzChecks — channel state", () => {
  it("a live 'both' agent reports the channel OK", async () => {
    const config = cfg({ alpha: { enabled: true, mirror: "both", ...FULL_RELAY } });
    const results = await runBuzzChecks(config, deps({ heartbeatContent: heartbeat() }));
    const r = row(results, "buzz:channel:alpha");
    expect(r?.status).toBe("ok");
    expect(r?.detail).toContain("mirror=both");
  });

  it("a disabled agent SKIPs the channel and the liveness probe", async () => {
    const config = cfg({ alpha: { enabled: false, ...FULL_RELAY } });
    const results = await runBuzzChecks(config, deps({ heartbeatContent: null }));
    expect(row(results, "buzz:channel:alpha")?.status).toBe("skip");
    expect(row(results, "buzz:sidecar-live:alpha")?.status).toBe("skip");
    // config + keypair still evaluated
    expect(row(results, "buzz:relay-config:alpha")?.status).toBe("ok");
  });

  it("mirror:off (kill-switch) SKIPs channel + liveness", async () => {
    const config = cfg({ alpha: { enabled: true, mirror: "off", ...FULL_RELAY } });
    const results = await runBuzzChecks(config, deps({ heartbeatContent: null }));
    expect(row(results, "buzz:channel:alpha")?.detail).toContain("kill-switch");
    expect(row(results, "buzz:sidecar-live:alpha")?.status).toBe("skip");
  });

  it("mirror:origin (deferred) WARNs that it degrades to dark", async () => {
    const config = cfg({ alpha: { enabled: true, mirror: "origin", ...FULL_RELAY } });
    const results = await runBuzzChecks(config, deps({ heartbeatContent: null }));
    expect(row(results, "buzz:channel:alpha")?.status).toBe("warn");
  });

  it("mirror:origin is NOT live, so the liveness probe SKIPs (no false-red)", async () => {
    // LOW-1: `origin` degrades to dark at runtime (config.ts loadConfigFromEnv),
    // so the sidecar never writes a beacon. Running the liveness probe would emit
    // a false-red "sidecar not running" warn whose restart fix can't help and
    // that contradicts the channel-state warn. It must SKIP, exactly like off.
    const config = cfg({ alpha: { enabled: true, mirror: "origin", ...FULL_RELAY } });
    const agents = computeBuzzAgents(config);
    expect(agents[0].live).toBe(false);
    const results = await runBuzzChecks(config, deps({ heartbeatContent: null }));
    expect(row(results, "buzz:sidecar-live:alpha")?.status).toBe("skip");
  });
});

describe("runBuzzChecks — relay config", () => {
  it("FAILs when a required relay field is missing", async () => {
    const { relay_host: _omit, ...partial } = FULL_RELAY;
    const config = cfg({ alpha: { enabled: true, ...partial } });
    const results = await runBuzzChecks(config, deps({ heartbeatContent: heartbeat() }));
    const r = row(results, "buzz:relay-config:alpha");
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("relay_host");
  });
});

describe("runBuzzChecks — keypair / vault grant", () => {
  it("FAILs when the nsec vault key is missing", async () => {
    const config = cfg({ alpha: { enabled: true, ...FULL_RELAY } });
    const results = await runBuzzChecks(config, deps({ heartbeatContent: heartbeat(), acl: { kind: "not_found" } }));
    const r = row(results, "buzz:keypair:alpha");
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("missing");
    expect(r?.fix).toContain("buzz/alpha-nsec");
  });

  it("FAILs when the key exists but the agent is not on its ACL", async () => {
    const config = cfg({ alpha: { enabled: true, ...FULL_RELAY } });
    const results = await runBuzzChecks(
      config,
      deps({ heartbeatContent: heartbeat(), acl: { kind: "ok", allow: ["someone-else"] } }),
    );
    const r = row(results, "buzz:keypair:alpha");
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("NOT on its ACL");
  });

  it("WARNs (not fails) when the broker is unreachable", async () => {
    const config = cfg({ alpha: { enabled: true, ...FULL_RELAY } });
    const results = await runBuzzChecks(
      config,
      deps({ heartbeatContent: heartbeat(), acl: { kind: "unreachable", msg: "socket gone" } }),
    );
    expect(row(results, "buzz:keypair:alpha")?.status).toBe("warn");
  });

  it("passes when the key exists and the agent is on the ACL", async () => {
    const config = cfg({ alpha: { enabled: true, ...FULL_RELAY } });
    const results = await runBuzzChecks(config, deps({ heartbeatContent: heartbeat(), acl: { kind: "ok", allow: ["alpha"] } }));
    expect(row(results, "buzz:keypair:alpha")?.status).toBe("ok");
  });
});

describe("runBuzzChecks — sidecar liveness", () => {
  const liveCfg = cfg({ alpha: { enabled: true, ...FULL_RELAY } });

  it("OK on a fresh, subscribed heartbeat, surfacing the stats", async () => {
    const results = await runBuzzChecks(liveCfg, deps({ heartbeatContent: heartbeat(), heartbeatMtimeMs: 2_000_000, now: 2_030_000 }));
    const r = row(results, "buzz:sidecar-live:alpha");
    expect(r?.status).toBe("ok");
    expect(r?.detail).toContain("injected=6");
    expect(r?.detail).toContain("subscribed");
  });

  it("WARNs when the heartbeat is missing", async () => {
    const results = await runBuzzChecks(liveCfg, deps({ heartbeatContent: null }));
    const r = row(results, "buzz:sidecar-live:alpha");
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("no heartbeat");
  });

  it("WARNs when the heartbeat is stale", async () => {
    const now = 2_000_000;
    const results = await runBuzzChecks(
      liveCfg,
      deps({ heartbeatContent: heartbeat(), heartbeatMtimeMs: now - BUZZ_HEARTBEAT_STALE_MS - 1, now }),
    );
    const r = row(results, "buzz:sidecar-live:alpha");
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("stale");
  });

  it("WARNs when the sidecar is up but the relay subscription is down", async () => {
    const results = await runBuzzChecks(
      liveCfg,
      deps({ heartbeatContent: heartbeat({ subscribed: false }), heartbeatMtimeMs: 2_000_000, now: 2_010_000 }),
    );
    const r = row(results, "buzz:sidecar-live:alpha");
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("subscription is DOWN");
  });

  it("WARNs when the heartbeat file is fresh but malformed", async () => {
    const results = await runBuzzChecks(
      liveCfg,
      deps({ heartbeatContent: "{ not valid", heartbeatMtimeMs: 2_000_000, now: 2_010_000 }),
    );
    const r = row(results, "buzz:sidecar-live:alpha");
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("malformed");
  });
});
