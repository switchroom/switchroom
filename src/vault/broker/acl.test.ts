/**
 * Tests for vault-broker ACL enforcement.
 *
 * Identity is established via cgroup-based systemdUnit. Covers:
 *   - Valid cron unit + key in schedule secrets → allowed
 *   - Valid cron unit + key NOT in secrets → denied
 *   - Cross-agent: unit for agentA can't read agentB's secrets → denied
 *   - systemdUnit=null (interactive caller, broker not for them) → denied
 *   - Malformed/unrecognized unit name → denied
 *   - Unknown agent name in unit → denied
 *   - Out-of-range schedule index → denied
 *
 * Note: there is no "interactive fallback" path. The broker is for cron-driven
 * access only. Interactive `switchroom vault get` reads the vault file directly
 * with the user's passphrase via --no-broker (or auto-fallback when broker
 * denies / is unreachable). See issue #129.
 */

import { describe, expect, it } from "vitest";
import { checkAcl, checkAclByAgent, parseGoogleAccountSlotKey } from "./acl.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import type { PeerInfo } from "./peercred.js";

/** Minimal valid SwitchroomConfig stub */
function makeConfig(
  agentSchedules: Record<
    string,
    Array<{ cron: string; prompt: string; secrets?: string[] }>
  >,
): SwitchroomConfig {
  const agents: SwitchroomConfig["agents"] = {};
  for (const [name, schedule] of Object.entries(agentSchedules)) {
    agents[name] = {
      topic_name: name,
      schedule: schedule.map((s) => ({
        cron: s.cron,
        prompt: s.prompt,
        secrets: s.secrets ?? [],
      })),
    };
  }
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: {
        socket: "~/.switchroom/vault-broker.sock",
        enabled: true,
      },
    },
    agents,
  } as unknown as SwitchroomConfig;
}

function peer(
  systemdUnit: string | null,
  exe = "/bin/bash",
  uid = 1000,
  pid = 1234,
): PeerInfo {
  return { uid, pid, exe, systemdUnit };
}

describe("ACL: cgroup-based cron identity", () => {
  it("allows a key that is in the declared secrets", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["api_key"] }],
    });
    const result = checkAcl(
      peer("switchroom-myagent-cron-0.service"),
      config,
      "api_key",
    );
    expect(result.allow).toBe(true);
  });

  it("denies a key not in the declared secrets", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["api_key"] }],
    });
    const result = checkAcl(
      peer("switchroom-myagent-cron-0.service"),
      config,
      "other_secret",
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("other_secret");
    }
  });

  it("denies when secrets is empty", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: [] }],
    });
    const result = checkAcl(
      peer("switchroom-myagent-cron-0.service"),
      config,
      "any_key",
    );
    expect(result.allow).toBe(false);
  });

  it("does not leak the allowed-keys list in the deny reason", () => {
    // Defense-in-depth: the per-cron deny message should not enumerate the
    // allowed key set — same-UID callers can already read the config file,
    // but the protocol should not echo the allowlist back.
    const config = makeConfig({
      myagent: [
        { cron: "0 8 * * *", prompt: "hi", secrets: ["secret_a", "secret_b", "secret_c"] },
      ],
    });
    const result = checkAcl(
      peer("switchroom-myagent-cron-0.service"),
      config,
      "not_in_acl",
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).not.toContain("secret_a");
      expect(result.reason).not.toContain("secret_b");
      expect(result.reason).not.toContain("secret_c");
    }
  });

  it("prevents cross-agent key leakage (unit for otheragent can't read myagent secrets)", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["api_key"] }],
      otheragent: [{ cron: "0 9 * * *", prompt: "other", secrets: [] }],
    });
    // otheragent's cron-0 tries to read myagent's api_key
    const result = checkAcl(
      peer("switchroom-otheragent-cron-0.service"),
      config,
      "api_key",
    );
    expect(result.allow).toBe(false);
  });

  it("grants access only to schedule[i].secrets (correct index binding)", () => {
    const config = makeConfig({
      myagent: [
        { cron: "0 8 * * *", prompt: "first", secrets: ["key_a"] },
        { cron: "0 9 * * *", prompt: "second", secrets: ["key_b"] },
      ],
    });
    // cron-0 may read key_a but not key_b
    expect(checkAcl(peer("switchroom-myagent-cron-0.service"), config, "key_a").allow).toBe(true);
    expect(checkAcl(peer("switchroom-myagent-cron-0.service"), config, "key_b").allow).toBe(false);

    // cron-1 may read key_b but not key_a
    expect(checkAcl(peer("switchroom-myagent-cron-1.service"), config, "key_b").allow).toBe(true);
    expect(checkAcl(peer("switchroom-myagent-cron-1.service"), config, "key_a").allow).toBe(false);
  });
});

describe("ACL: unknown agent → denied", () => {
  it("denies when agent name not in config.agents", () => {
    const config = makeConfig({
      otheragent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["key"] }],
    });
    const result = checkAcl(
      peer("switchroom-unknownagent-cron-0.service"),
      config,
      "key",
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("unknownagent");
    }
  });
});

describe("ACL: out-of-range schedule index → denied", () => {
  it("denies when cron index is beyond schedule length", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["key"] }],
    });
    // Only schedule[0] exists, cron-5 is out of range
    const result = checkAcl(
      peer("switchroom-myagent-cron-5.service"),
      config,
      "key",
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("out of range");
    }
  });
});

describe("ACL: malformed unit name → denied", () => {
  it("denies when systemdUnit does not match switchroom cron naming", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["key"] }],
    });
    // Unit name that looks like it could be switchroom but has bad format
    const result = checkAcl(
      peer("switchroom-myagent-cron-.service"),
      config,
      "key",
    );
    expect(result.allow).toBe(false);
  });

  it("denies when systemdUnit is a random non-switchroom service", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["key"] }],
    });
    const result = checkAcl(
      peer("some-random.service"),
      config,
      "key",
    );
    expect(result.allow).toBe(false);
  });
});

describe("ACL: non-cron callers (systemdUnit=null) → denied", () => {
  it("denies any key for a caller without a switchroom cron systemd unit", () => {
    // Replaces the prior "allow_interactive" tests. The broker no longer
    // serves interactive callers — they read the vault file directly with
    // the user's passphrase via `switchroom vault get --no-broker`.
    const config = makeConfig({});
    const result = checkAcl(peer(null, "/some/path/switchroom"), config, "any_key");
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("not a switchroom cron unit");
    }
  });
});

describe("ACL: socket-path-as-identity (Phase 2a)", () => {
  it("allows a key declared in the agent's schedule secrets", () => {
    const config = makeConfig({
      alice: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["alice_key"] }],
    });
    expect(checkAclByAgent(config, "alice", "alice_key").allow).toBe(true);
  });

  it("denies a key not in the agent's schedule secrets", () => {
    const config = makeConfig({
      alice: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["alice_key"] }],
    });
    const r = checkAclByAgent(config, "alice", "bob_key");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("not in ACL");
  });

  it("denies cross-agent — alice cannot read keys declared only on bob", () => {
    const config = makeConfig({
      alice: [{ cron: "0 8 * * *", prompt: "a", secrets: ["alice_key"] }],
      bob: [{ cron: "0 9 * * *", prompt: "b", secrets: ["bob_key"] }],
    });
    expect(checkAclByAgent(config, "alice", "bob_key").allow).toBe(false);
    expect(checkAclByAgent(config, "bob", "alice_key").allow).toBe(false);
    // Sanity: each agent CAN read its own.
    expect(checkAclByAgent(config, "alice", "alice_key").allow).toBe(true);
    expect(checkAclByAgent(config, "bob", "bob_key").allow).toBe(true);
  });

  it("aggregates secrets across multiple schedule entries", () => {
    // The broker container has no way to know which schedule index a
    // long-running agent connection corresponds to (no cron context), so
    // an agent declared with multiple schedule entries gets the union of
    // their secrets[]. Documented in checkAclByAgent's header.
    const config = makeConfig({
      alice: [
        { cron: "0 8 * * *", prompt: "morning", secrets: ["k1"] },
        { cron: "0 18 * * *", prompt: "evening", secrets: ["k2"] },
      ],
    });
    expect(checkAclByAgent(config, "alice", "k1").allow).toBe(true);
    expect(checkAclByAgent(config, "alice", "k2").allow).toBe(true);
    expect(checkAclByAgent(config, "alice", "k3").allow).toBe(false);
  });

  it("denies an unknown agent name", () => {
    const config = makeConfig({
      alice: [{ cron: "0 8 * * *", prompt: "a", secrets: ["k"] }],
    });
    const r = checkAclByAgent(config, "nonexistent", "k");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("not found in config");
  });

  it("denies an empty agent name", () => {
    const config = makeConfig({
      alice: [{ cron: "0 8 * * *", prompt: "a", secrets: ["k"] }],
    });
    expect(checkAclByAgent(config, "", "k").allow).toBe(false);
  });

  it("denies when the agent has no schedule entries at all", () => {
    // makeConfig coerces every entry into schedule with secrets[]; bypass
    // it here to construct an agent with an empty schedule.
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      agents: {
        alice: { topic_name: "alice", schedule: [] },
      },
    } as unknown as Parameters<typeof checkAclByAgent>[0];
    const r = checkAclByAgent(config, "alice", "k");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("no schedule entries");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Webkite — fleet-default credential ACL (framework-emits-entry-AND-ACL)
// ────────────────────────────────────────────────────────────────────────

describe("ACL: webkite credential keys (fleet-default)", () => {
  const WEBKITE_KEYS = [
    "webkite/cloudflare-account-id",
    "webkite/cloudflare-api-token",
    "webkite/firecrawl-api-key",
  ];

  it("allows every webkite key by default — agent did not opt out", () => {
    const config = makeConfig({
      alice: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["unrelated"] }],
    });
    for (const key of WEBKITE_KEYS) {
      const r = checkAclByAgent(config, "alice", key);
      expect(r.allow, `expected ${key} allowed for alice`).toBe(true);
    }
  });

  it("denies webkite keys when the agent opted out via mcp_servers.webkite: false", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      agents: {
        alice: {
          topic_name: "alice",
          schedule: [],
          mcp_servers: { webkite: false },
        },
      },
    } as unknown as Parameters<typeof checkAclByAgent>[0];
    for (const key of WEBKITE_KEYS) {
      const r = checkAclByAgent(config, "alice", key);
      expect(r.allow, `expected ${key} denied for opted-out alice`).toBe(false);
    }
  });

  it("does not allow arbitrary webkite/* keys — only the canonical 3", () => {
    const config = makeConfig({
      alice: [{ cron: "0 8 * * *", prompt: "hi", secrets: [] }],
    });
    // A speculatively-shaped key that LOOKS like a webkite cred but
    // isn't on the canonical allowlist must still be denied (so a
    // future `webkite/private-thing` operator-put isn't silently
    // exposed to every agent without a deliberate ACL).
    const r = checkAclByAgent(config, "alice", "webkite/not-a-real-key");
    expect(r.allow).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 2 — google: slot ACL via google_accounts[].enabled_for[]
// ────────────────────────────────────────────────────────────────────────

function makeGoogleAccountConfig(
  accounts: Record<string, { enabled_for: string[] }>,
  agents: Record<string, { schedule?: { cron: string; prompt: string; secrets?: string[] }[] }> = {},
) {
  const agentEntries: SwitchroomConfig["agents"] = {};
  for (const [name, agent] of Object.entries(agents)) {
    agentEntries[name] = {
      topic_name: name,
      schedule: (agent.schedule ?? []).map((s) => ({
        cron: s.cron,
        prompt: s.prompt,
        secrets: s.secrets ?? [],
      })),
    } as SwitchroomConfig["agents"][string];
  }
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "t", forum_chat_id: "1" },
    vault: { path: "~/.switchroom/vault.enc" },
    google_accounts: accounts,
    agents: agentEntries,
  } as unknown as SwitchroomConfig;
}

describe("parseGoogleAccountSlotKey", () => {
  it("extracts account + field for refresh_token slot", () => {
    expect(parseGoogleAccountSlotKey("google:alice@example.com:refresh_token")).toEqual({
      account: "alice@example.com",
      field: "refresh_token",
    });
  });

  it("extracts for status sidecar", () => {
    expect(parseGoogleAccountSlotKey("google:alice@example.com:status")).toEqual({
      account: "alice@example.com",
      field: "status",
    });
  });

  it("returns null for non-google: prefixes", () => {
    expect(parseGoogleAccountSlotKey("gdrive:klanker:refresh_token")).toBe(null);
    expect(parseGoogleAccountSlotKey("secret:OPENAI_API_KEY")).toBe(null);
    expect(parseGoogleAccountSlotKey("google:alice@example.com")).toBe(null);
  });
});

describe("ACL: google: slot routing through google_accounts[]", () => {
  it("allows an agent listed in enabled_for", () => {
    const config = makeGoogleAccountConfig(
      { "alice@example.com": { enabled_for: ["klanker", "gymbro"] } },
      { klanker: {} },
    );
    const r = checkAclByAgent(config, "klanker", "google:alice@example.com:refresh_token");
    expect(r.allow).toBe(true);
  });

  it("denies an agent NOT in enabled_for (cross-account leak prevention)", () => {
    const config = makeGoogleAccountConfig(
      { "alice@example.com": { enabled_for: ["klanker"] } },
      { gymbro: {} },
    );
    const r = checkAclByAgent(config, "gymbro", "google:alice@example.com:refresh_token");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("not in google_accounts");
  });

  it("denies when the account is not in google_accounts at all", () => {
    const config = makeGoogleAccountConfig({}, { klanker: {} });
    const r = checkAclByAgent(config, "klanker", "google:alice@example.com:refresh_token");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("not configured");
  });

  it("denies when enabled_for is empty (fail-closed)", () => {
    const config = makeGoogleAccountConfig(
      { "alice@example.com": { enabled_for: [] } },
      { klanker: {} },
    );
    const r = checkAclByAgent(config, "klanker", "google:alice@example.com:refresh_token");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("enabled_for is empty");
  });

  it("normalizes account email casing — schema-key 'alice@…' matches lookup of 'ALICE@…'", () => {
    const config = makeGoogleAccountConfig(
      { "alice@example.com": { enabled_for: ["klanker"] } },
      { klanker: {} },
    );
    // Slot key arrives in original case (not normalized at the broker
    // boundary) — extension still needs to resolve it.
    const r = checkAclByAgent(config, "klanker", "google:ALICE@EXAMPLE.COM:refresh_token");
    expect(r.allow).toBe(true);
  });

  it("google: slots bypass the schedule.secrets allowlist (the whole point)", () => {
    // Agent has NO schedule entries at all — under the legacy ACL path
    // this would deny everything. Under RFC G the google: slot should
    // still be readable when google_accounts[] permits it.
    const config = makeGoogleAccountConfig(
      { "alice@example.com": { enabled_for: ["klanker"] } },
      { klanker: { schedule: [] } },
    );
    const r = checkAclByAgent(config, "klanker", "google:alice@example.com:refresh_token");
    expect(r.allow).toBe(true);
  });

  it("non-google: keys still go through the legacy schedule.secrets allowlist", () => {
    const config = makeGoogleAccountConfig(
      { "alice@example.com": { enabled_for: ["klanker"] } },
      {
        klanker: {
          schedule: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["api_key"] }],
        },
      },
    );
    expect(checkAclByAgent(config, "klanker", "api_key").allow).toBe(true);
    expect(checkAclByAgent(config, "klanker", "other_key").allow).toBe(false);
  });

  it("denies with helpful reason when google_accounts is undefined entirely", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      agents: { klanker: { topic_name: "klanker", schedule: [] } },
    } as unknown as SwitchroomConfig;
    const r = checkAclByAgent(config, "klanker", "google:alice@example.com:refresh_token");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("not configured");
  });
});

describe("ACL: an agent may read its OWN configured bot_token (install-validation 2026-05-18)", () => {
  // Regression: a per-agent bot token added via the documented
  // `switchroom vault set telegram-<agent>-bot-token` + uncomment-the-
  // agent flow was broker-ACL-denied to its own agent (no schedule
  // secrets, no bot-token allowance) — masked before because the
  // global token only ever resolved via the <agent>/telegram/.env
  // materialization side-channel. #31/#1428-adjacent.
  function cfg(
    agents: Record<string, unknown>,
    globalBotToken: string,
  ): SwitchroomConfig {
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: globalBotToken, forum_chat_id: "123" },
      vault: { path: "~/.switchroom/vault.enc", broker: { socket: "s", enabled: true } },
      agents,
    } as unknown as SwitchroomConfig;
  }

  it("per-agent bot_token vault ref → that agent may read that key (no schedule needed)", () => {
    const config = cfg(
      { admin: { topic_name: "Admin", bot_token: "vault:telegram-admin-bot-token", admin: true } },
      "vault:telegram-bot-token",
    );
    expect(checkAclByAgent(config, "admin", "telegram-admin-bot-token").allow).toBe(true);
  });

  it("agent on the GLOBAL telegram.bot_token vault ref may read the global key", () => {
    const config = cfg(
      { assistant: { topic_name: "General" } },
      "vault:telegram-bot-token",
    );
    expect(checkAclByAgent(config, "assistant", "telegram-bot-token").allow).toBe(true);
  });

  it("per-agent override wins: admin reads its own key, NOT the global, NOT another agent's", () => {
    const config = cfg(
      {
        admin: { topic_name: "Admin", bot_token: "vault:telegram-admin-bot-token", admin: true },
        coach: { topic_name: "Fitness", bot_token: "vault:telegram-coach-bot-token" },
      },
      "vault:telegram-bot-token",
    );
    expect(checkAclByAgent(config, "admin", "telegram-admin-bot-token").allow).toBe(true);
    // admin overrides the global → must NOT get the global key via this path…
    expect(checkAclByAgent(config, "admin", "telegram-bot-token").allow).toBe(false);
    // …and definitely not a sibling agent's per-agent bot token.
    expect(checkAclByAgent(config, "admin", "telegram-coach-bot-token").allow).toBe(false);
    expect(checkAclByAgent(config, "coach", "telegram-admin-bot-token").allow).toBe(false);
  });

  it("empty-string per-agent bot_token falls back to the global key (matches getEffectiveBotToken)", () => {
    const config = cfg(
      { admin: { topic_name: "Admin", bot_token: "", admin: true } },
      "vault:telegram-bot-token",
    );
    // The gateway's getEffectiveBotToken treats "" as unset → uses the
    // global; the ACL must allow exactly that key (never deny the key
    // the gateway will actually request).
    expect(checkAclByAgent(config, "admin", "telegram-bot-token").allow).toBe(true);
  });

  it("does not open a hole: a literal (non-vault:) bot_token grants nothing; unrelated keys still gated", () => {
    const config = cfg(
      { admin: { topic_name: "Admin", bot_token: "123:literaltoken", admin: true } },
      "alsoliteral",
    );
    // literal token isn't a vault key → no allowance, and no schedule → deny
    expect(checkAclByAgent(config, "admin", "123:literaltoken").allow).toBe(false);
    expect(checkAclByAgent(config, "admin", "some-other-key").allow).toBe(false);
  });

  it("regression: schedule.secrets gating for NON-bot keys is unchanged", () => {
    const config = cfg(
      {
        admin: {
          topic_name: "Admin",
          bot_token: "vault:telegram-admin-bot-token",
          schedule: [{ cron: "0 8 * * *", prompt: "x", secrets: ["briefing_key"] }],
        } as unknown as SwitchroomConfig["agents"][string],
      },
      "vault:telegram-bot-token",
    );
    expect(checkAclByAgent(config, "admin", "telegram-admin-bot-token").allow).toBe(true); // own bot token
    expect(checkAclByAgent(config, "admin", "briefing_key").allow).toBe(true);  // schedule.secrets still works
    expect(checkAclByAgent(config, "admin", "random_key").allow).toBe(false);   // still gated
  });
});

describe("ACL: Google OAuth client credential (RFC G §4.4 completion)", () => {
  // End-to-end through checkAclByAgent (the real broker entrypoint), not
  // just the predicate. Pins that the clause is wired AND that it does
  // not shadow the schedule.secrets gate for other keys.
  function clientCredConfig(opts: {
    enabledFor: string[];
    clientSecret?: string;
    schedule?: { cron: string; prompt: string; secrets?: string[] }[];
  }): SwitchroomConfig {
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      google_accounts: {
        "you@example.com": { enabled_for: opts.enabledFor },
      },
      google_workspace: {
        google_client_secret: opts.clientSecret ?? "vault:google/client-secret",
      },
      agents: {
        klanker: {
          topic_name: "klanker",
          google_workspace: { account: "you@example.com" },
          schedule: (opts.schedule ?? []).map((s) => ({
            cron: s.cron,
            prompt: s.prompt,
            secrets: s.secrets ?? [],
          })),
        },
      },
    } as unknown as SwitchroomConfig;
  }

  it("a Drive-enabled agent with ZERO schedule entries can read the client secret (the prod regression)", () => {
    const config = clientCredConfig({ enabledFor: ["klanker"] });
    const r = checkAclByAgent(config, "klanker", "google/client-secret");
    expect(r.allow).toBe(true);
  });

  it("a non-enabled agent is still denied (falls through to the schedule.secrets gate)", () => {
    const config = clientCredConfig({ enabledFor: ["clerk"] });
    const r = checkAclByAgent(config, "klanker", "google/client-secret");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("no schedule entries");
  });

  it("does not shadow schedule.secrets — an unrelated key is still gated", () => {
    // klanker gets the client-cred grant but must NOT thereby gain
    // access to a key that isn't in any schedule.secrets[].
    const config = clientCredConfig({
      enabledFor: ["klanker"],
      schedule: [{ cron: "* * * * *", prompt: "p", secrets: ["allowed_key"] }],
    });
    expect(checkAclByAgent(config, "klanker", "google/client-secret").allow).toBe(true);
    expect(checkAclByAgent(config, "klanker", "allowed_key").allow).toBe(true);
    expect(checkAclByAgent(config, "klanker", "stripe/api-key").allow).toBe(false);
  });
});

// ─── User-declared MCP-server secrets (PR #1799 follow-up) ────────────
//
// Operators wire MCP servers via `defaults.mcp_servers.<name>` in
// switchroom.yaml; the cascade merges the entry onto every agent that
// inherits defaults. Pre-fix the ACL only honored `schedule.secrets[]`,
// so an MCP server whose launcher fetched its API key from the vault
// (e.g. perplexity, notion) was broker-denied at spawn and silently
// failed to connect. The new clause grants any key declared in the
// agent's effective `mcp_servers.<name>.secrets[]`, generalising the
// gdrive client-secret special-case to every user-declared MCP.

describe("ACL: user-declared MCP-server secrets", () => {
  // Helper — builds a config with one MCP server entry on the agent's
  // post-cascade `mcp_servers` map (callers can assume cascade already
  // ran). The ACL is index-blind to where the entry came from.
  function mcpConfig(opts: {
    agent: string;
    mcpEntries?: Record<string, unknown>;
    schedule?: Array<{ cron: string; prompt: string; secrets?: string[] }>;
  }): SwitchroomConfig {
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      agents: {
        [opts.agent]: {
          topic_name: opts.agent,
          ...(opts.mcpEntries ? { mcp_servers: opts.mcpEntries } : {}),
          schedule: (opts.schedule ?? []).map((s) => ({
            cron: s.cron,
            prompt: s.prompt,
            secrets: s.secrets ?? [],
          })),
        },
      },
    } as unknown as SwitchroomConfig;
  }

  it("allows a key declared under an effective mcp_servers entry", () => {
    const config = mcpConfig({
      agent: "clerk",
      mcpEntries: {
        perplexity: {
          command: "/path/to/perplexity-mcp.sh",
          secrets: ["perplexity/api-key"],
        },
      },
    });
    expect(checkAclByAgent(config, "clerk", "perplexity/api-key").allow).toBe(true);
  });

  it("allows even when the agent has zero schedule entries (MCP-only agent)", () => {
    // The MCP-secret clause must short-circuit BEFORE the no-schedule
    // early-deny — otherwise a long-running agent that uses MCPs but
    // declares no cron would never see any broker-accessible keys.
    const config = mcpConfig({
      agent: "ziggy",
      mcpEntries: {
        notion: {
          command: "/path/to/notion-mcp.sh",
          secrets: ["notion/api-key"],
        },
      },
      // intentionally no schedule
    });
    expect(checkAclByAgent(config, "ziggy", "notion/api-key").allow).toBe(true);
  });

  it("falls through to schedule.secrets for keys not in any mcp_servers entry", () => {
    const config = mcpConfig({
      agent: "clerk",
      mcpEntries: {
        perplexity: {
          command: "/path/to/perplexity-mcp.sh",
          secrets: ["perplexity/api-key"],
        },
      },
      schedule: [
        { cron: "0 * * * *", prompt: "p", secrets: ["microsoft/ken-tokens"] },
      ],
    });
    expect(checkAclByAgent(config, "clerk", "microsoft/ken-tokens").allow).toBe(true);
  });

  it("denies a key not declared in MCP-secrets or schedule.secrets", () => {
    const config = mcpConfig({
      agent: "clerk",
      mcpEntries: {
        perplexity: {
          command: "/path/to/perplexity-mcp.sh",
          secrets: ["perplexity/api-key"],
        },
      },
    });
    const r = checkAclByAgent(config, "clerk", "stripe/api-key");
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.reason).toContain("stripe/api-key");
    }
  });

  it("ignores `false` MCP entries (the per-agent opt-out shape)", () => {
    // An agent that opts out of an inherited MCP (`mcp_servers:
    // { perplexity: false }`) must NOT keep ACL access to its secrets.
    // `false` is not an object, so Object.values + the typeof guard
    // naturally skips it.
    const config = mcpConfig({
      agent: "carrie",
      mcpEntries: { perplexity: false },
    });
    expect(
      checkAclByAgent(config, "carrie", "perplexity/api-key").allow,
    ).toBe(false);
  });

  it("ignores entries with no `secrets` array — declaring an MCP doesn't auto-grant keys", () => {
    // The grant is opt-in per-MCP — an entry without `secrets:` gets
    // nothing. Operators have to declare what their launcher will
    // actually read.
    const config = mcpConfig({
      agent: "clerk",
      mcpEntries: { perplexity: { command: "/path/to/perplexity-mcp.sh" } },
    });
    expect(
      checkAclByAgent(config, "clerk", "perplexity/api-key").allow,
    ).toBe(false);
  });

  it("ignores non-array `secrets` values (defensive against bad yaml)", () => {
    const config = mcpConfig({
      agent: "clerk",
      mcpEntries: {
        perplexity: {
          command: "/path/to/perplexity-mcp.sh",
          // operator typo — string instead of array
          secrets: "perplexity/api-key" as unknown as string[],
        },
      },
    });
    expect(
      checkAclByAgent(config, "clerk", "perplexity/api-key").allow,
    ).toBe(false);
  });

  // ─── #1806 follow-up: defaults-cascade ─────────────────────────────
  // The broker loads raw yaml; cascade was open-coded inline in the
  // ACL clause. Pre-this-fix the read was per-agent-only, so an MCP
  // declared in defaults (the documented common case for perplexity)
  // was never seen by the ACL — every agent that inherited it via
  // cascade hit VAULT-BROKER-DENIED. Discovered live 2026-05-25 on
  // clerk against v0.13.42.

  it("allows a key declared under defaults.mcp_servers (cascade)", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      defaults: {
        mcp_servers: {
          perplexity: {
            command: "/path/to/perplexity-mcp.sh",
            secrets: ["perplexity/api-key"],
          },
        },
      },
      agents: {
        clerk: { topic_name: "clerk" },
      },
    } as unknown as SwitchroomConfig;
    expect(checkAclByAgent(config, "clerk", "perplexity/api-key").allow).toBe(true);
  });

  it("per-agent override of a defaults MCP entry wins (replaces secrets too)", () => {
    // Per `src/config/merge.ts:391-397` the cascade is per-key shallow:
    // an agent's mcp_servers.perplexity FULLY replaces the defaults
    // entry rather than partial-merging. So if the agent re-declares
    // perplexity, only its own `secrets:` apply.
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      defaults: {
        mcp_servers: {
          perplexity: {
            command: "/default/launcher.sh",
            secrets: ["perplexity/api-key"],
          },
        },
      },
      agents: {
        clerk: {
          topic_name: "clerk",
          mcp_servers: {
            perplexity: {
              command: "/clerk-custom-launcher.sh",
              secrets: ["perplexity/api-key", "perplexity/extra-key"],
            },
          },
        },
      },
    } as unknown as SwitchroomConfig;
    // Both the inherited key and the per-agent-only key are accessible
    // because the agent's full override re-declares both.
    expect(checkAclByAgent(config, "clerk", "perplexity/api-key").allow).toBe(true);
    expect(checkAclByAgent(config, "clerk", "perplexity/extra-key").allow).toBe(true);
  });

  it("per-agent `false` opt-out drops the inherited MCP's grant (cascade)", () => {
    // The shallow merge applies `false` over the defaults entry; the
    // typeof guard then skips it.
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      defaults: {
        mcp_servers: {
          perplexity: {
            command: "/path/to/launcher.sh",
            secrets: ["perplexity/api-key"],
          },
        },
      },
      agents: {
        clerk: {
          topic_name: "clerk",
          mcp_servers: { perplexity: false },
        },
      },
    } as unknown as SwitchroomConfig;
    expect(
      checkAclByAgent(config, "clerk", "perplexity/api-key").allow,
    ).toBe(false);
  });

  // ─── #1810 follow-up: profile-layer cascade ──────────────────────────
  // Per `src/config/merge.ts:resolveAgentConfig` the canonical cascade
  // is 3-layer: defaults → profiles.<agent.extends> → agent.
  // ProfileSchema accepts `mcp_servers` by design, so an operator can
  // declare an MCP under a custom profile and expect every agent
  // extending that profile to inherit it. Pin the profile layer.

  it("allows a key declared under profiles.<extends>.mcp_servers (cascade)", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      profiles: {
        coding: {
          mcp_servers: {
            github: {
              command: "/path/to/github-mcp.sh",
              secrets: ["github/api-token"],
            },
          },
        },
      },
      agents: {
        clerk: { topic_name: "clerk", extends: "coding" },
      },
    } as unknown as SwitchroomConfig;
    expect(checkAclByAgent(config, "clerk", "github/api-token").allow).toBe(true);
  });

  it("agent without extends does NOT inherit a profile's mcp_servers", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      profiles: {
        coding: {
          mcp_servers: {
            github: {
              command: "/path/to/github-mcp.sh",
              secrets: ["github/api-token"],
            },
          },
        },
      },
      agents: {
        clerk: { topic_name: "clerk" }, // no extends
      },
    } as unknown as SwitchroomConfig;
    expect(checkAclByAgent(config, "clerk", "github/api-token").allow).toBe(false);
  });

  it("per-agent override beats the profile's MCP entry", () => {
    // Layer order: defaults → profile → agent. The agent's per-key
    // entry fully replaces the profile's.
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      profiles: {
        coding: {
          mcp_servers: {
            github: {
              command: "/profile/github.sh",
              secrets: ["github/api-token"],
            },
          },
        },
      },
      agents: {
        clerk: {
          topic_name: "clerk",
          extends: "coding",
          mcp_servers: {
            github: {
              command: "/clerk/custom-github.sh",
              secrets: ["github/api-token", "github/extra-scope"],
            },
          },
        },
      },
    } as unknown as SwitchroomConfig;
    expect(checkAclByAgent(config, "clerk", "github/api-token").allow).toBe(true);
    expect(checkAclByAgent(config, "clerk", "github/extra-scope").allow).toBe(true);
  });

  it("per-agent `false` over a profile MCP drops the grant", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      profiles: {
        coding: {
          mcp_servers: {
            github: {
              command: "/path/to/github-mcp.sh",
              secrets: ["github/api-token"],
            },
          },
        },
      },
      agents: {
        clerk: {
          topic_name: "clerk",
          extends: "coding",
          mcp_servers: { github: false },
        },
      },
    } as unknown as SwitchroomConfig;
    expect(
      checkAclByAgent(config, "clerk", "github/api-token").allow,
    ).toBe(false);
  });

  it("does not cross agents — one agent's MCP secret stays on that agent", () => {
    const config = {
      switchroom: { version: 1 },
      telegram: { bot_token: "t", forum_chat_id: "1" },
      vault: { path: "~/.switchroom/vault.enc" },
      agents: {
        clerk: {
          topic_name: "clerk",
          mcp_servers: {
            perplexity: {
              command: "/path/to/perplexity-mcp.sh",
              secrets: ["perplexity/api-key"],
            },
          },
        },
        gymbro: {
          topic_name: "gymbro",
          // gymbro has perplexity DISABLED — must not get the key
          mcp_servers: { perplexity: false },
        },
      },
    } as unknown as SwitchroomConfig;
    expect(checkAclByAgent(config, "clerk", "perplexity/api-key").allow).toBe(true);
    expect(checkAclByAgent(config, "gymbro", "perplexity/api-key").allow).toBe(false);
  });
});
