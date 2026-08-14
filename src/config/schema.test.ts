/**
 * Tests for vault-broker schema additions (PR 1) and CLI flag knobs (PR 196-198).
 *
 * Covers:
 *   - ScheduleEntrySchema.secrets: valid values, regex rejection, default []
 *   - VaultConfigSchema.broker: default population when omitted
 *   - AgentSchema.thinking_effort: enum validation
 *   - AgentSchema.permission_mode: enum validation
 *   - AgentSchema.fallback_model: regex validation
 */

import { describe, expect, it } from "vitest";
import {
  AgentDriveConfigSchema,
  AgentGoogleWorkspaceConfigSchema,
  AgentSchema,
  AgentSoulSchema,
  BuzzChannelSchema,
  DriveConfigSchema,
  GoogleWorkspaceConfigSchema,
  GoogleWorkspaceTierSchema,
  ReleaseBlock,
  RootReleaseBlock,
  ScheduleEntrySchema,
  SwitchroomConfigSchema,
  TelegramChannelSchema,
  VaultConfigSchema,
} from "./schema.js";

describe("TelegramChannelSchema — supergroup smart defaults", () => {
  it("defaults default_topic_id to General (1) when chat_id is set and it is omitted", () => {
    const r = TelegramChannelSchema.parse({ chat_id: "-1001234567890" });
    expect(r?.default_topic_id).toBe(1);
  });

  it("preserves an explicit default_topic_id", () => {
    const r = TelegramChannelSchema.parse({ chat_id: "-1001234567890", default_topic_id: 17 });
    expect(r?.default_topic_id).toBe(17);
  });

  it("does NOT inject default_topic_id when there is no chat_id", () => {
    const r = TelegramChannelSchema.parse({ bot_token: "vault:x" });
    expect(r?.default_topic_id).toBeUndefined();
  });

  it("still rejects default_topic_id without chat_id (meaningless)", () => {
    expect(() => TelegramChannelSchema.parse({ default_topic_id: 5 })).toThrow();
  });
});

describe("TelegramChannelSchema — removed rate_limit_ms knob (#3161)", () => {
  it("a stale rate_limit_ms key is accepted-and-ignored, never a validation failure", () => {
    // The knob was removed (documented + scaffold-exported but read by
    // nothing; the send gate is the real throttle). Existing YAML that
    // still sets it must keep parsing — Zod's default strip mode drops
    // the unknown key, same pattern as the progress_card removal
    // (#1122 PR3).
    const r = TelegramChannelSchema.parse({ format: "html", rate_limit_ms: 500 });
    expect(r?.format).toBe("html");
    expect((r as Record<string, unknown> | undefined)?.rate_limit_ms).toBeUndefined();
  });
});

describe("TelegramChannelSchema — send_gate rate limits (#3084)", () => {
  it("accepts a full send_gate block and preserves every knob", () => {
    const r = TelegramChannelSchema.parse({
      send_gate: {
        enabled: true,
        global_per_sec: 40,
        global_burst: 6,
        per_chat_per_sec: 2,
        per_chat_burst: 5,
        per_group_per_min: 30,
        per_group_burst: 4,
        edit_floor_ms: 2000,
      },
    });
    expect(r?.send_gate).toEqual({
      enabled: true,
      global_per_sec: 40,
      global_burst: 6,
      per_chat_per_sec: 2,
      per_chat_burst: 5,
      per_group_per_min: 30,
      per_group_burst: 4,
      edit_floor_ms: 2000,
    });
  });

  it("omitting send_gate leaves it undefined (built-in defaults own the unset case)", () => {
    const r = TelegramChannelSchema.parse({ format: "html" });
    expect(r?.send_gate).toBeUndefined();
  });

  it("accepts a fractional per-sec rate (rates need not be integers)", () => {
    const r = TelegramChannelSchema.parse({ send_gate: { per_chat_per_sec: 0.5 } });
    expect(r?.send_gate?.per_chat_per_sec).toBe(0.5);
  });

  it("edit_floor_ms may be 0 (disables the floor)", () => {
    const r = TelegramChannelSchema.parse({ send_gate: { edit_floor_ms: 0 } });
    expect(r?.send_gate?.edit_floor_ms).toBe(0);
  });

  it("rejects a zero per-chat rate LOUDLY at config-load (would wedge sends)", () => {
    expect(() =>
      TelegramChannelSchema.parse({ send_gate: { per_chat_per_sec: 0 } }),
    ).toThrow();
  });

  it("rejects a negative global rate LOUDLY at config-load", () => {
    expect(() =>
      TelegramChannelSchema.parse({ send_gate: { global_per_sec: -5 } }),
    ).toThrow();
  });

  it("rejects a zero burst LOUDLY (a 0-capacity bucket never admits a token)", () => {
    expect(() =>
      TelegramChannelSchema.parse({ send_gate: { per_group_burst: 0 } }),
    ).toThrow();
  });

  it("rejects a non-integer burst LOUDLY", () => {
    expect(() =>
      TelegramChannelSchema.parse({ send_gate: { global_burst: 2.5 } }),
    ).toThrow();
  });

  it("rejects a negative edit_floor_ms LOUDLY", () => {
    expect(() =>
      TelegramChannelSchema.parse({ send_gate: { edit_floor_ms: -1 } }),
    ).toThrow();
  });
});

describe("TelegramChannelSchema — worker_feed.max_rows (coalesced feed)", () => {
  it("accepts a positive integer max_rows", () => {
    const r = TelegramChannelSchema.parse({ worker_feed: { max_rows: 10 } });
    expect(r?.worker_feed).toEqual({ max_rows: 10 });
  });

  it("omitting worker_feed leaves it undefined (built-in default of 8 owns the unset case)", () => {
    const r = TelegramChannelSchema.parse({ format: "html" });
    expect(r?.worker_feed).toBeUndefined();
  });

  it("rejects a zero max_rows LOUDLY (a 0-row feed would render no live workers)", () => {
    expect(() =>
      TelegramChannelSchema.parse({ worker_feed: { max_rows: 0 } }),
    ).toThrow();
  });

  it("rejects a non-integer max_rows LOUDLY", () => {
    expect(() =>
      TelegramChannelSchema.parse({ worker_feed: { max_rows: 8.5 } }),
    ).toThrow();
  });
});

describe("TelegramChannelSchema — voice_out (PR-C2)", () => {
  it("applies engine/reply_mode defaults when only enabled is set", () => {
    const r = TelegramChannelSchema.parse({ voice_out: { enabled: true } });
    expect(r?.voice_out?.enabled).toBe(true);
    expect(r?.voice_out?.engine).toBe("kokoro");
    expect(r?.voice_out?.reply_mode).toBe("voice+text");
    // max_chars has no zod default (the gateway supplies 600 at use-time).
    expect(r?.voice_out?.max_chars).toBeUndefined();
  });

  it("preserves explicit engine / voice / reply_mode / max_chars", () => {
    const r = TelegramChannelSchema.parse({
      voice_out: {
        enabled: true,
        engine: "openai",
        voice: "alloy",
        reply_mode: "voice-only",
        max_chars: 400,
        api_key: "vault:openai/api-key",
      },
    });
    expect(r?.voice_out?.engine).toBe("openai");
    expect(r?.voice_out?.voice).toBe("alloy");
    expect(r?.voice_out?.reply_mode).toBe("voice-only");
    expect(r?.voice_out?.max_chars).toBe(400);
    expect(r?.voice_out?.api_key).toBe("vault:openai/api-key");
  });

  it("rejects an unknown engine", () => {
    expect(() =>
      TelegramChannelSchema.parse({ voice_out: { engine: "piper" } }),
    ).toThrow();
  });

  it("accepts the on-demand reply_mode (Listen button)", () => {
    const r = TelegramChannelSchema.parse({
      voice_out: { enabled: true, reply_mode: "on-demand" },
    });
    expect(r?.voice_out?.reply_mode).toBe("on-demand");
  });

  it("keeps voice+text as the reply_mode default", () => {
    const r = TelegramChannelSchema.parse({ voice_out: { enabled: true } });
    expect(r?.voice_out?.reply_mode).toBe("voice+text");
  });

  it("rejects an unknown reply_mode", () => {
    expect(() =>
      TelegramChannelSchema.parse({ voice_out: { reply_mode: "text-only" } }),
    ).toThrow();
  });

  it("rejects a non-positive max_chars", () => {
    expect(() =>
      TelegramChannelSchema.parse({ voice_out: { max_chars: 0 } }),
    ).toThrow();
  });

  it("leaves voice_out undefined when omitted", () => {
    const r = TelegramChannelSchema.parse({ chat_id: "-100123" });
    expect(r?.voice_out).toBeUndefined();
  });
});

describe("BuzzChannelSchema (Buzz co-channel Phase 1)", () => {
  const OP = "npub1zsqv9jvpdurxu2y7vxen8w22mk3wkntsu5vsard00je59x5mmhlqgyjfll";
  const OP_HEX = "1400c2c9816f066e289e61b333b94adda2eb4d70e5190e8daf7cb3429a9bddfe";

  const minimal = { operator_pubkey: OP, relay_url: "wss://relay.buzz", relay_host: "relay.buzz", default_channel_id: "grp", chat_id: "555" };

  it("defaults enabled to false — the channel ships dark", () => {
    const r = BuzzChannelSchema.parse(minimal);
    expect(r.enabled).toBe(false);
  });

  it("applies the documented defaults (nsec key, mirror, empty allowlist)", () => {
    const r = BuzzChannelSchema.parse(minimal);
    expect(r.nsec_vault_key).toBe("buzz/{agent}-nsec");
    expect(r.mirror).toBe("both");
    expect(r.authorized_pubkeys).toEqual([]);
    expect(r.channel_map).toEqual({});
    expect(r.pubkey_names).toEqual({});
  });

  it("accepts a hex operator pubkey as well as an npub", () => {
    expect(BuzzChannelSchema.parse({ ...minimal, operator_pubkey: OP_HEX }).operator_pubkey).toBe(OP_HEX);
    expect(BuzzChannelSchema.parse(minimal).operator_pubkey).toBe(OP);
  });

  it("rejects a garbage operator pubkey (not npub, not 64-hex)", () => {
    expect(() => BuzzChannelSchema.parse({ ...minimal, operator_pubkey: "not-a-key" })).toThrow();
    expect(() => BuzzChannelSchema.parse({ ...minimal, operator_pubkey: "deadbeef" })).toThrow();
  });

  it("rejects a relay_url that is not ws:// or wss://", () => {
    expect(() => BuzzChannelSchema.parse({ ...minimal, relay_url: "https://relay.buzz" })).toThrow();
  });

  it("requires operator_pubkey, relay_url, relay_host, default_channel_id, and chat_id", () => {
    expect(() => BuzzChannelSchema.parse({ relay_url: "wss://r", relay_host: "r", default_channel_id: "g", chat_id: "1" })).toThrow();
    expect(() => BuzzChannelSchema.parse({ operator_pubkey: OP, relay_host: "r", default_channel_id: "g", chat_id: "1" })).toThrow();
    expect(() => BuzzChannelSchema.parse({ operator_pubkey: OP, relay_url: "wss://r", relay_host: "r", chat_id: "1" })).toThrow();
    // chat_id is now required too — config.ts demands BUZZ_CHAT_ID when live.
    expect(() => BuzzChannelSchema.parse({ operator_pubkey: OP, relay_url: "wss://r", relay_host: "r", default_channel_id: "g" })).toThrow();
    // relay_host is REQUIRED (coordinator 2026-08-03): the relay resolves its
    // community from the HTTP Host header and 404s without it, so an omitted
    // Host must be a hard config error, not a silent 404 loop.
    expect(() => BuzzChannelSchema.parse({ operator_pubkey: OP, relay_url: "wss://r", default_channel_id: "g", chat_id: "1" })).toThrow();
  });

  it("validates relay_host as a bare host[:port] authority (no scheme/path)", () => {
    expect(BuzzChannelSchema.parse({ ...minimal, relay_host: "127.0.0.1:3000" }).relay_host).toBe("127.0.0.1:3000");
    expect(BuzzChannelSchema.parse({ ...minimal, relay_host: "relay.buzz" }).relay_host).toBe("relay.buzz");
    // A scheme, a path, or whitespace is rejected — the Host must be sent verbatim.
    expect(() => BuzzChannelSchema.parse({ ...minimal, relay_host: "ws://127.0.0.1:3000" })).toThrow();
    expect(() => BuzzChannelSchema.parse({ ...minimal, relay_host: "127.0.0.1:3000/path" })).toThrow();
    expect(() => BuzzChannelSchema.parse({ ...minimal, relay_host: "" })).toThrow();
  });

  it("accepts and preserves chat_id, and rejects an empty one", () => {
    expect(BuzzChannelSchema.parse({ ...minimal, chat_id: "-100200300" }).chat_id).toBe("-100200300");
    expect(() => BuzzChannelSchema.parse({ ...minimal, chat_id: "" })).toThrow();
  });

  it("relay_dial_url is optional and validated as a ws(s) URL", () => {
    // Absent by default (dial the canonical relay_url).
    expect(BuzzChannelSchema.parse(minimal).relay_dial_url).toBeUndefined();
    // Present: a docker-network dial address distinct from the canonical tag.
    expect(
      BuzzChannelSchema.parse({ ...minimal, relay_dial_url: "ws://10.0.10.5:3000" }).relay_dial_url,
    ).toBe("ws://10.0.10.5:3000");
    expect(() => BuzzChannelSchema.parse({ ...minimal, relay_dial_url: "http://nope" })).toThrow();
  });

  it("is .strict() — an unknown key is a hard error (typo guard)", () => {
    expect(() => BuzzChannelSchema.parse({ ...minimal, enabed: true })).toThrow();
  });

  it("accepts mirror:off as the kill-switch value", () => {
    expect(BuzzChannelSchema.parse({ ...minimal, mirror: "off" }).mirror).toBe("off");
    expect(() => BuzzChannelSchema.parse({ ...minimal, mirror: "sometimes" })).toThrow();
  });
});

describe("TelegramChannelSchema.linear_agent (#2298)", () => {
  it("parses a valid linear_agent block", () => {
    const r = TelegramChannelSchema.parse({
      linear_agent: { enabled: true, token: "vault:linear/carrie/token" },
    });
    expect(r?.linear_agent?.enabled).toBe(true);
    expect(r?.linear_agent?.token).toBe("vault:linear/carrie/token");
  });

  it("accepts an optional workspace_id", () => {
    const r = TelegramChannelSchema.parse({
      linear_agent: {
        enabled: true,
        token: "vault:linear/carrie/token",
        workspace_id: "ws_abc123",
      },
    });
    expect(r?.linear_agent?.workspace_id).toBe("ws_abc123");
  });

  it("is optional — unset stays undefined", () => {
    expect(TelegramChannelSchema.parse({ bot_token: "vault:x" })?.linear_agent).toBeUndefined();
  });

  it("requires enabled", () => {
    expect(() =>
      TelegramChannelSchema.parse({ linear_agent: { token: "vault:linear/carrie/token" } }),
    ).toThrow();
  });

  it("requires token", () => {
    expect(() =>
      TelegramChannelSchema.parse({ linear_agent: { enabled: true } }),
    ).toThrow();
  });
});

describe("TelegramChannelSchema.clear_status_on_completion", () => {
  it("accepts true / false and round-trips the boolean", () => {
    expect(TelegramChannelSchema.parse({ clear_status_on_completion: true })?.clear_status_on_completion).toBe(true);
    expect(TelegramChannelSchema.parse({ clear_status_on_completion: false })?.clear_status_on_completion).toBe(false);
  });

  it("is optional — unset stays undefined (gateway default-off owns it)", () => {
    expect(TelegramChannelSchema.parse({ bot_token: "vault:x" })?.clear_status_on_completion).toBeUndefined();
  });

  it("rejects a non-boolean", () => {
    expect(() => TelegramChannelSchema.parse({ clear_status_on_completion: "yes" })).toThrow();
  });
});

describe("TelegramChannelSchema.pin_status_while_working", () => {
  it("accepts true / false and round-trips the boolean", () => {
    expect(TelegramChannelSchema.parse({ pin_status_while_working: true })?.pin_status_while_working).toBe(true);
    expect(TelegramChannelSchema.parse({ pin_status_while_working: false })?.pin_status_while_working).toBe(false);
  });

  it("is optional — unset stays undefined (gateway default-on owns it)", () => {
    expect(TelegramChannelSchema.parse({ bot_token: "vault:x" })?.pin_status_while_working).toBeUndefined();
  });

  it("rejects a non-boolean", () => {
    expect(() => TelegramChannelSchema.parse({ pin_status_while_working: "yes" })).toThrow();
  });
});

describe("ScheduleEntrySchema.secrets", () => {
  it("accepts a list of valid vault key names", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["openai_api_key", "polygon_api_key"],
    });
    expect(result.secrets).toEqual(["openai_api_key", "polygon_api_key"]);
  });

  it("accepts key names with hyphens", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["my-key", "another-key-123"],
    });
    expect(result.secrets).toEqual(["my-key", "another-key-123"]);
  });

  it("defaults to [] when secrets field is omitted", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
    });
    expect(result.secrets).toEqual([]);
  });

  it("defaults to [] when secrets is explicitly []", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: [],
    });
    expect(result.secrets).toEqual([]);
  });

  it("rejects key names containing spaces", () => {
    expect(() =>
      ScheduleEntrySchema.parse({
        cron: "0 8 * * *",
        prompt: "Send a brief.",
        secrets: ["bad space"],
      }),
    ).toThrow();
  });

  it("rejects key names containing shell-special characters", () => {
    const badNames = ["foo$bar", "foo;bar", "foo.bar", "foo@bar"];
    for (const name of badNames) {
      expect(() =>
        ScheduleEntrySchema.parse({
          cron: "0 8 * * *",
          prompt: "Send a brief.",
          secrets: [name],
        }),
        `expected "${name}" to be rejected`,
      ).toThrow();
    }
  });

  it("accepts namespaced key names with forward slashes", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["microsoft/ken-tokens", "openai/api-key"],
    });
    expect(result.secrets).toEqual(["microsoft/ken-tokens", "openai/api-key"]);
  });
});

describe("VaultConfigSchema.broker", () => {
  it("populates broker defaults when vault.broker is omitted", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker.socket).toBe("~/.switchroom/vault-broker.sock");
    expect(result.broker.enabled).toBe(true);
  });

  it("populates broker defaults when vault block is empty", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker).toEqual({
      socket: "~/.switchroom/vault-broker.sock",
      enabled: true,
      autoUnlock: false,
      autoUnlockCredentialPath: "~/.switchroom/vault-auto-unlock",
      approvalAuth: "passphrase",
      postureMintAgents: [],
      adminOnlyKeys: [],
      auditFailClosed: false,
    });
  });

  it("defaults auditFailClosed to false (fail-open, backward compatible) and accepts true", () => {
    // sec WS10-F3 / #1420 — the knob must default OFF so upgrading fleets
    // keep the historical fail-open behaviour until the operator opts in.
    expect(VaultConfigSchema.parse({}).broker.auditFailClosed).toBe(false);
    expect(
      VaultConfigSchema.parse({ broker: { auditFailClosed: true } }).broker
        .auditFailClosed,
    ).toBe(true);
  });

  it("defaults postureMintAgents to [] (no agent can self-mint via posture)", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker.postureMintAgents).toEqual([]);
  });

  it("accepts postureMintAgents: [agent-slug] for opt-in", () => {
    const result = VaultConfigSchema.parse({
      broker: {
        approvalAuth: "telegram-id",
        autoUnlock: true,
        postureMintAgents: ["test-harness", "clerk"],
      },
    });
    expect(result.broker.postureMintAgents).toEqual(["test-harness", "clerk"]);
  });

  it("rejects postureMintAgents entries that are non-strings or empty", () => {
    expect(() =>
      VaultConfigSchema.parse({
        broker: {
          approvalAuth: "telegram-id",
          autoUnlock: true,
          postureMintAgents: [""],
        },
      })
    ).toThrow();
  });

  it("defaults approvalAuth to passphrase", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker.approvalAuth).toBe("passphrase");
  });

  it("accepts approvalAuth: telegram-id when autoUnlock is true", () => {
    const result = VaultConfigSchema.parse({
      broker: { approvalAuth: "telegram-id", autoUnlock: true },
    });
    expect(result.broker.approvalAuth).toBe("telegram-id");
    expect(result.broker.autoUnlock).toBe(true);
  });

  it("rejects approvalAuth: telegram-id without autoUnlock: true", () => {
    expect(() =>
      VaultConfigSchema.parse({
        broker: { approvalAuth: "telegram-id" },
      })
    ).toThrow(/requires `autoUnlock: true`/);
  });

  it("rejects approvalAuth: telegram-id with autoUnlock: false", () => {
    expect(() =>
      VaultConfigSchema.parse({
        broker: { approvalAuth: "telegram-id", autoUnlock: false },
      })
    ).toThrow(/requires `autoUnlock: true`/);
  });

  it("rejects an unknown approvalAuth value", () => {
    expect(() =>
      VaultConfigSchema.parse({
        broker: { approvalAuth: "biometric" },
      })
    ).toThrow();
  });

  it("accepts an explicit broker socket override", () => {
    const result = VaultConfigSchema.parse({
      broker: { socket: "/run/my-broker.sock" },
    });
    expect(result.broker.socket).toBe("/run/my-broker.sock");
    expect(result.broker.enabled).toBe(true);
  });

  it("accepts broker.enabled: false", () => {
    const result = VaultConfigSchema.parse({
      broker: { enabled: false },
    });
    expect(result.broker.enabled).toBe(false);
    expect(result.broker.socket).toBe("~/.switchroom/vault-broker.sock");
  });

  it("preserves existing vault.path alongside broker defaults", () => {
    const result = VaultConfigSchema.parse({
      path: "/custom/vault.enc",
    });
    expect(result.path).toBe("/custom/vault.enc");
    expect(result.broker.enabled).toBe(true);
  });

  it("defaults autoUnlock to false", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker.autoUnlock).toBe(false);
  });

  it("accepts autoUnlock: true", () => {
    const result = VaultConfigSchema.parse({
      broker: { autoUnlock: true },
    });
    expect(result.broker.autoUnlock).toBe(true);
    expect(result.broker.enabled).toBe(true);
  });

  it("accepts a custom autoUnlockCredentialPath", () => {
    const result = VaultConfigSchema.parse({
      broker: { autoUnlockCredentialPath: "/etc/credstore.encrypted/vault-passphrase" },
    });
    expect(result.broker.autoUnlockCredentialPath).toBe(
      "/etc/credstore.encrypted/vault-passphrase"
    );
  });
});

function baseAgentInput(overrides: Record<string, unknown> = {}) {
  return {
    topic_name: "Test",
    ...overrides,
  };
}

describe("AgentSchema.thinking_effort", () => {
  it("accepts all valid effort values", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const result = AgentSchema.parse(baseAgentInput({ thinking_effort: effort }));
      expect(result.thinking_effort).toBe(effort);
    }
  });

  it("is optional — omitted means no flag", () => {
    const result = AgentSchema.parse(baseAgentInput());
    expect(result.thinking_effort).toBeUndefined();
  });

  it("rejects invalid effort values", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ thinking_effort: "ultra" })),
    ).toThrow();
  });

  it("rejects empty string", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ thinking_effort: "" })),
    ).toThrow();
  });
});

describe("AgentSchema.permission_mode", () => {
  it("accepts all valid permission_mode values", () => {
    const modes = [
      "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan",
    ] as const;
    for (const mode of modes) {
      const result = AgentSchema.parse(baseAgentInput({ permission_mode: mode }));
      expect(result.permission_mode).toBe(mode);
    }
  });

  it("is optional — omitted means no flag", () => {
    const result = AgentSchema.parse(baseAgentInput());
    expect(result.permission_mode).toBeUndefined();
  });

  it("rejects invalid permission_mode values", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ permission_mode: "skipAll" })),
    ).toThrow();
  });
});

describe("AgentSchema.fallback_model", () => {
  it("accepts valid model names", () => {
    for (const model of ["sonnet", "haiku", "claude-sonnet-5", "claude-haiku-4-5"]) {
      const result = AgentSchema.parse(baseAgentInput({ fallback_model: model }));
      expect(result.fallback_model).toBe(model);
    }
  });

  it("is optional — omitted means no flag", () => {
    const result = AgentSchema.parse(baseAgentInput());
    expect(result.fallback_model).toBeUndefined();
  });

  it("rejects model names with spaces", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ fallback_model: "bad model" })),
    ).toThrow();
  });

  it("rejects model names with shell-special characters", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ fallback_model: "model$foo" })),
    ).toThrow();
  });
});

describe("DriveConfigSchema (top-level drive: block)", () => {
  it("parses a fully-populated block", () => {
    const result = DriveConfigSchema.parse({
      google_client_id: "raw-id",
      google_client_secret: "raw-secret",
      approvers: [12345],
    });
    expect(result?.google_client_id).toBe("raw-id");
    expect(result?.approvers).toEqual([12345]);
  });

  it("accepts vault: refs for client id/secret", () => {
    const result = DriveConfigSchema.parse({
      google_client_id: "vault:google-oauth-client-id",
      google_client_secret: "vault:google-oauth-client-secret",
      approvers: [12345],
    });
    expect(result?.google_client_id).toBe("vault:google-oauth-client-id");
    expect(result?.google_client_secret).toBe("vault:google-oauth-client-secret");
  });

  it("accepts numeric-string approver ids", () => {
    const result = DriveConfigSchema.parse({
      google_client_id: "id",
      google_client_secret: "secret",
      approvers: ["12345", "111"],
    });
    expect(result?.approvers).toEqual(["12345", "111"]);
  });

  it("rejects non-numeric string approver", () => {
    expect(() =>
      DriveConfigSchema.parse({
        google_client_id: "id",
        google_client_secret: "secret",
        approvers: ["ken"],
      }),
    ).toThrow();
  });

  it("requires at least one approver when block is present", () => {
    expect(() =>
      DriveConfigSchema.parse({
        google_client_id: "id",
        google_client_secret: "secret",
        approvers: [],
      }),
    ).toThrow();
  });

  it("requires google_client_id and google_client_secret when block is present", () => {
    expect(() =>
      DriveConfigSchema.parse({ approvers: [1] }),
    ).toThrow();
    expect(() =>
      DriveConfigSchema.parse({
        google_client_id: "id",
        approvers: [1],
      }),
    ).toThrow();
  });

  it("is fully optional — undefined is accepted (back-compat with env-only flow)", () => {
    expect(DriveConfigSchema.parse(undefined)).toBeUndefined();
  });

  it("is wired onto the top-level SwitchroomConfigSchema as `drive`", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      drive: {
        google_client_id: "vault:google-oauth-client-id",
        google_client_secret: "vault:google-oauth-client-secret",
        approvers: [12345],
      },
      agents: {},
    });
    expect(result.drive?.google_client_id).toBe("vault:google-oauth-client-id");
  });
});

describe("AgentDriveConfigSchema (per-agent override)", () => {
  it("accepts an approvers override", () => {
    const result = AgentDriveConfigSchema.parse({ approvers: [123, 456] });
    expect(result?.approvers).toEqual([123, 456]);
  });

  it("is optional everywhere — block can be omitted on the agent", () => {
    const result = AgentSchema.parse(baseAgentInput());
    expect(result.drive).toBeUndefined();
  });

  it("is wired onto AgentSchema as `drive`", () => {
    const result = AgentSchema.parse(
      baseAgentInput({ drive: { approvers: [999] } }),
    );
    expect(result.drive?.approvers).toEqual([999]);
  });

  it("rejects an empty approvers list when the block is present", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ drive: { approvers: [] } })),
    ).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────
// RFC G Phase 1: google_workspace: as the canonical key, drive: as alias
// ───────────────────────────────────────────────────────────────────────

describe("GoogleWorkspaceTierSchema (RFC G Phase 1 tier knob)", () => {
  it("accepts the three documented tiers", () => {
    expect(GoogleWorkspaceTierSchema.parse("core")).toBe("core");
    expect(GoogleWorkspaceTierSchema.parse("extended")).toBe("extended");
    expect(GoogleWorkspaceTierSchema.parse("complete")).toBe("complete");
  });

  it("rejects unknown tier values", () => {
    expect(() => GoogleWorkspaceTierSchema.parse("minimal")).toThrow();
    expect(() => GoogleWorkspaceTierSchema.parse("")).toThrow();
    expect(() => GoogleWorkspaceTierSchema.parse(null as unknown as string)).toThrow();
  });
});

describe("GoogleWorkspaceConfigSchema (RFC G canonical name)", () => {
  it("is the same schema reference as DriveConfigSchema (alias)", () => {
    // Aliasing at the schema level — same object identity, same parser.
    expect(GoogleWorkspaceConfigSchema).toBe(DriveConfigSchema);
  });

  it("parses a fully-populated block including the new tier field", () => {
    const result = GoogleWorkspaceConfigSchema.parse({
      google_client_id: "id",
      google_client_secret: "secret",
      approvers: [123],
      tier: "core",
    });
    expect(result?.tier).toBe("core");
  });

  it("accepts an extended tier per-agent style", () => {
    const result = GoogleWorkspaceConfigSchema.parse({
      google_client_id: "id",
      google_client_secret: "secret",
      approvers: [123],
      tier: "extended",
    });
    expect(result?.tier).toBe("extended");
  });

  it("makes tier optional — undefined is fine (preserves shipped behaviour)", () => {
    const result = GoogleWorkspaceConfigSchema.parse({
      google_client_id: "id",
      google_client_secret: "secret",
      approvers: [123],
    });
    expect(result?.tier).toBeUndefined();
  });

  it("rejects unknown tier values", () => {
    expect(() =>
      GoogleWorkspaceConfigSchema.parse({
        google_client_id: "id",
        google_client_secret: "secret",
        approvers: [123],
        tier: "minimal",
      }),
    ).toThrow();
  });

  it("is wired onto the top-level SwitchroomConfigSchema as `google_workspace`", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      google_workspace: {
        google_client_id: "id",
        google_client_secret: "secret",
        approvers: [123],
        tier: "core",
      },
      agents: {},
    });
    expect(result.google_workspace?.tier).toBe("core");
  });
});

describe("AgentGoogleWorkspaceConfigSchema (RFC G per-agent override)", () => {
  it("is the same schema reference as AgentDriveConfigSchema (alias)", () => {
    expect(AgentGoogleWorkspaceConfigSchema).toBe(AgentDriveConfigSchema);
  });

  it("accepts a per-agent tier override without approvers", () => {
    const result = AgentGoogleWorkspaceConfigSchema.parse({ tier: "extended" });
    expect(result?.tier).toBe("extended");
    expect(result?.approvers).toBeUndefined();
  });

  it("accepts both approvers and tier together", () => {
    const result = AgentGoogleWorkspaceConfigSchema.parse({
      approvers: [999],
      tier: "complete",
    });
    expect(result?.approvers).toEqual([999]);
    expect(result?.tier).toBe("complete");
  });

  it("is wired onto AgentSchema as `google_workspace`", () => {
    const result = AgentSchema.parse(
      baseAgentInput({ google_workspace: { tier: "extended", approvers: [999] } }),
    );
    expect(result.google_workspace?.tier).toBe("extended");
    expect(result.google_workspace?.approvers).toEqual([999]);
  });

  it("RFC G Phase 2: SwitchroomConfigSchema accepts a google_accounts top-level block", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      google_accounts: {
        "alice@example.com": { enabled_for: ["klanker", "gymbro"] },
        "work@bigcorp.com": { enabled_for: ["coderev"] },
      },
      agents: {},
    });
    expect(result.google_accounts?.["alice@example.com"].enabled_for).toEqual([
      "klanker",
      "gymbro",
    ]);
    expect(result.google_accounts?.["work@bigcorp.com"].enabled_for).toEqual(["coderev"]);
  });

  it("RFC G Phase 2: google_accounts is optional and defaults to undefined", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      agents: {},
    });
    expect(result.google_accounts).toBeUndefined();
  });

  it("RFC G Phase 2: google_accounts rejects keys that aren't email-shaped", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        switchroom: { version: 1 },
        telegram: { bot_token: "x", forum_chat_id: "1" },
        google_accounts: {
          "not-an-email": { enabled_for: ["klanker"] },
        },
        agents: {},
      }),
    ).toThrow();
  });

  it("RFC G Phase 2: google_accounts rejects malformed agent slugs in enabled_for", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        switchroom: { version: 1 },
        telegram: { bot_token: "x", forum_chat_id: "1" },
        google_accounts: {
          "alice@example.com": { enabled_for: ["Has-Capitals"] },
        },
        agents: {},
      }),
    ).toThrow();
  });

  it("RFC G Phase 2: google_accounts rejects emails containing a colon (broker key-parser footgun)", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        switchroom: { version: 1 },
        telegram: { bot_token: "x", forum_chat_id: "1" },
        google_accounts: {
          // Colon in local-part would write a slot the broker can't
          // reverse-parse with its `^google:([^:]+):([a-z_]+)$` regex.
          "alice:risky@example.com": { enabled_for: ["klanker"] },
        },
        agents: {},
      }),
    ).toThrow();
  });

  it("RFC G Phase 2: google_accounts normalizes mixed-case email keys to lowercase at parse time", () => {
    // Without schema-side normalization, `Alice@Example.com` would write
    // a slot under `alice@example.com` (per normalizeGoogleAccount) but
    // the broker lookup against `google_accounts['alice@example.com']`
    // would miss. Schema transform closes that gap.
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      google_accounts: {
        "Alice@Example.COM": { enabled_for: ["klanker"] },
      },
      agents: {},
    });
    expect(Object.keys(result.google_accounts ?? {})).toEqual(["alice@example.com"]);
    expect(result.google_accounts?.["alice@example.com"].enabled_for).toEqual(["klanker"]);
  });

  it("RFC G Phase 2: google_accounts.enabled_for accepts an empty array (means dormant)", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      google_accounts: {
        "alice@example.com": { enabled_for: [] },
      },
      agents: {},
    });
    expect(result.google_accounts?.["alice@example.com"].enabled_for).toEqual([]);
  });

  it("AgentSchema accepts both `drive` and `google_workspace` simultaneously (loader rejects mismatch)", () => {
    // Schema layer is permissive — drive: and google_workspace: have
    // identical shapes and either can be set or both. Loader (not schema)
    // is the layer that rejects the both-with-different-values case.
    const result = AgentSchema.parse(
      baseAgentInput({
        drive: { approvers: [111] },
        google_workspace: { approvers: [222], tier: "extended" },
      }),
    );
    expect(result.drive?.approvers).toEqual([111]);
    expect(result.google_workspace?.tier).toBe("extended");
  });
});

describe("ReleaseBlock (release-channel pin / pointer)", () => {
  it("accepts a bare channel", () => {
    const result = AgentSchema.parse(baseAgentInput({ release: { channel: "dev" } }));
    expect(result.release).toEqual({ channel: "dev" });
  });

  it("accepts a sha pin", () => {
    const result = AgentSchema.parse(
      baseAgentInput({ release: { pin: "sha-abc1234" } }),
    );
    expect(result.release).toEqual({ pin: "sha-abc1234" });
  });

  it("accepts a semver pin", () => {
    const result = AgentSchema.parse(
      baseAgentInput({ release: { pin: "v1.2.3" } }),
    );
    expect(result.release).toEqual({ pin: "v1.2.3" });
  });

  it("rejects channel + pin together (mutually exclusive)", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({ release: { channel: "dev", pin: "sha-abc1234" } }),
      ),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a malformed pin (non-hex)", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ release: { pin: "sha-zzz" } })),
    ).toThrow();
  });

  it("rejects an unknown channel value", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ release: { channel: "stable" } })),
    ).toThrow();
  });

  it("attaches to the root SwitchroomConfigSchema as well", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      release: { channel: "latest" },
      agents: {},
    });
    expect(result.release).toEqual({ channel: "latest" });
  });
});

describe("HostdConfigSchema (admin-agent-config-edit RFC §3 / §4)", () => {
  it("populates defaults when the `hostd:` block is omitted (PR 1a — flag OFF by default)", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      agents: {},
    });
    expect(result.hostd).toEqual({
      config_edit_enabled: false,
      config_edit_rate_per_hour: 3,
      // #1841 — operator-attest 2nd factor: off by default, RFC §5.4
      // fleet-mutation verb set as the default required list.
      operator_attest_enabled: false,
      operator_attest_required_verbs: ["update_apply", "apply", "rollout"],
    });
  });

  it("accepts an explicit operator-attest opt-in with a custom verb list (#1841)", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      hostd: {
        operator_attest_enabled: true,
        operator_attest_required_verbs: ["update_apply", "agent_exec"],
      },
      agents: {},
    });
    expect(result.hostd.operator_attest_enabled).toBe(true);
    expect(result.hostd.operator_attest_required_verbs).toEqual([
      "update_apply",
      "agent_exec",
    ]);
  });

  it("accepts an explicit opt-in with a tuned rate", () => {
    const result = SwitchroomConfigSchema.parse({
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      hostd: { config_edit_enabled: true, config_edit_rate_per_hour: 5 },
      agents: {},
    });
    expect(result.hostd.config_edit_enabled).toBe(true);
    expect(result.hostd.config_edit_rate_per_hour).toBe(5);
  });

  it("rejects a rate below 1", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        switchroom: { version: 1 },
        telegram: { bot_token: "x", forum_chat_id: "1" },
        hostd: { config_edit_rate_per_hour: 0 },
        agents: {},
      }),
    ).toThrow();
  });

  it("rejects a rate above the 20/hour ceiling", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        switchroom: { version: 1 },
        telegram: { bot_token: "x", forum_chat_id: "1" },
        hostd: { config_edit_rate_per_hour: 100 },
        agents: {},
      }),
    ).toThrow();
  });

  it("rejects a non-integer rate", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        switchroom: { version: 1 },
        telegram: { bot_token: "x", forum_chat_id: "1" },
        hostd: { config_edit_rate_per_hour: 3.5 },
        agents: {},
      }),
    ).toThrow();
  });
});

describe("TelegramChannelSchema.enabled (offline-dev master switch)", () => {
  it("defaults to true when omitted", () => {
    const result = AgentSchema.parse(
      baseAgentInput({ channels: { telegram: {} } }),
    );
    expect(result.channels?.telegram?.enabled).toBe(true);
  });

  it("accepts an explicit false to disable the gateway sidecar", () => {
    const result = AgentSchema.parse(
      baseAgentInput({ channels: { telegram: { enabled: false } } }),
    );
    expect(result.channels?.telegram?.enabled).toBe(false);
  });
});

// ─── Supergroup-owned mode (RFC reference/rfcs/supergroup-mode.md) ──────────
describe("TelegramChannelSchema supergroup-owned fields", () => {
  it("accepts a fully-specified supergroup-owned agent block", () => {
    const result = AgentSchema.parse(
      baseAgentInput({
        channels: {
          telegram: {
            chat_id: "-1001234567890",
            default_topic_id: 1,
            topic_aliases: { general: 1, planning: 17, admin: 31, alerts: 41 },
          },
        },
      }),
    );
    expect(result.channels?.telegram?.chat_id).toBe("-1001234567890");
    expect(result.channels?.telegram?.default_topic_id).toBe(1);
    expect(result.channels?.telegram?.topic_aliases).toEqual({
      general: 1,
      planning: 17,
      admin: 31,
      alerts: 41,
    });
  });

  it("defaults default_topic_id to General (1) when chat_id is set alone (smart default, was an error pre-#supergroup-easy-defaults)", () => {
    const parsed = AgentSchema.parse(
      baseAgentInput({
        channels: { telegram: { chat_id: "-1001234567890" } },
      }),
    );
    expect(parsed.channels?.telegram?.default_topic_id).toBe(1);
  });

  it("rejects default_topic_id without chat_id (mutual dependency)", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          channels: { telegram: { default_topic_id: 1 } },
        }),
      ),
    ).toThrow(/chat_id/);
  });

  it("rejects topic_aliases without chat_id", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          channels: { telegram: { topic_aliases: { admin: 31 } } },
        }),
      ),
    ).toThrow(/chat_id/);
  });

  it("rejects a positive chat_id (must be negative supergroup form)", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          channels: {
            telegram: { chat_id: "1234567890", default_topic_id: 1 },
          },
        }),
      ),
    ).toThrow(/negative/);
  });

  it("rejects a non-positive default_topic_id", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          channels: {
            telegram: { chat_id: "-1001234567890", default_topic_id: 0 },
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects a non-integer topic_aliases value", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          channels: {
            telegram: {
              chat_id: "-1001234567890",
              default_topic_id: 1,
              topic_aliases: { admin: 31.5 },
            },
          },
        }),
      ),
    ).toThrow();
  });
});

describe("AgentSchema dm_only ↔ supergroup exclusion", () => {
  it("rejects dm_only:true combined with channels.telegram.chat_id", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          dm_only: true,
          channels: {
            telegram: { chat_id: "-1001234567890", default_topic_id: 1 },
          },
        }),
      ),
    ).toThrow(/dm_only/);
  });

  it("rejects dm_only:true combined with default_topic_id", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          dm_only: true,
          channels: { telegram: { default_topic_id: 1 } },
        }),
      ),
    ).toThrow();
  });

  it("rejects dm_only:true combined with topic_aliases", () => {
    expect(() =>
      AgentSchema.parse(
        baseAgentInput({
          dm_only: true,
          channels: { telegram: { topic_aliases: { admin: 31 } } },
        }),
      ),
    ).toThrow();
  });

  it("accepts dm_only:true with no supergroup fields (existing DM agent)", () => {
    const result = AgentSchema.parse(
      baseAgentInput({ dm_only: true, channels: { telegram: {} } }),
    );
    expect(result.dm_only).toBe(true);
  });

  it("accepts fleet-shared agent unchanged (no supergroup fields)", () => {
    // The default mode: no chat_id, no default_topic_id, no dm_only.
    // Backward-compat must hold — schema must accept these unchanged.
    const result = AgentSchema.parse(baseAgentInput({}));
    expect(result.channels?.telegram?.chat_id).toBeUndefined();
    expect(result.channels?.telegram?.default_topic_id).toBeUndefined();
  });
});

describe("ScheduleEntrySchema.topic (cron topic override)", () => {
  it("accepts a string alias", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * 1-5",
      prompt: "Morning digest",
      topic: "planning",
    });
    expect(result.topic).toBe("planning");
  });

  it("accepts a numeric topic ID", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Daily check",
      topic: 17,
    });
    expect(result.topic).toBe(17);
  });

  it("accepts entries without a topic field (backward-compat)", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Daily check",
    });
    expect(result.topic).toBeUndefined();
  });

  it("rejects an empty-string alias", () => {
    expect(() =>
      ScheduleEntrySchema.parse({
        cron: "0 8 * * *",
        prompt: "Daily check",
        topic: "",
      }),
    ).toThrow();
  });

  it("rejects a non-positive topic ID", () => {
    expect(() =>
      ScheduleEntrySchema.parse({
        cron: "0 8 * * *",
        prompt: "Daily check",
        topic: 0,
      }),
    ).toThrow();
  });

  it("rejects a non-integer topic ID", () => {
    expect(() =>
      ScheduleEntrySchema.parse({
        cron: "0 8 * * *",
        prompt: "Daily check",
        topic: 17.5,
      }),
    ).toThrow();
  });
});

// ─── auth.allow_overage_accounts config field ───────────────────────────────

describe("auth.allow_overage_accounts config field", () => {
  const minimalBase = {
    switchroom: { version: 1 },
    agents: {},
    telegram: { bot_token: "123:abc", forum_chat_id: "456" },
  };

  it("accepts a valid allow_overage_accounts list and threads through to AuthConfig", () => {
    const cfg = SwitchroomConfigSchema.parse({
      ...minimalBase,
      auth: {
        active: "alice",
        allow_overage_accounts: ["alice@example.com", "bob@example.com"],
      },
    });
    expect(cfg.auth?.allow_overage_accounts).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("defaults to undefined (omitted) when not set — no accounts are opt-in by default", () => {
    const cfg = SwitchroomConfigSchema.parse({
      ...minimalBase,
      auth: { active: "alice" },
    });
    expect(cfg.auth?.allow_overage_accounts).toBeUndefined();
  });

  it("accepts an empty list", () => {
    const cfg = SwitchroomConfigSchema.parse({
      ...minimalBase,
      auth: { active: "alice", allow_overage_accounts: [] },
    });
    expect(cfg.auth?.allow_overage_accounts).toEqual([]);
  });

  it("rejects entries that are empty strings", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...minimalBase,
        auth: { allow_overage_accounts: [""] },
      }),
    ).toThrow();
  });

  it("rejects non-array values for allow_overage_accounts", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...minimalBase,
        auth: { allow_overage_accounts: "alice@example.com" },
      }),
    ).toThrow();
  });
});

// ─── auth.proactive_failover_pct config field (#3031) ───────────────────────

describe("auth.proactive_failover_pct config field", () => {
  const minimalBase = {
    switchroom: { version: 1 },
    agents: {},
    telegram: { bot_token: "123:abc", forum_chat_id: "456" },
  };

  it("accepts a valid pct and threads through to AuthConfig", () => {
    const cfg = SwitchroomConfigSchema.parse({
      ...minimalBase,
      auth: { active: "alice", proactive_failover_pct: 95 },
    });
    expect(cfg.auth?.proactive_failover_pct).toBe(95);
  });

  it("defaults to undefined when omitted — the soft-avoid tier is off by default", () => {
    const cfg = SwitchroomConfigSchema.parse({
      ...minimalBase,
      auth: { active: "alice" },
    });
    expect(cfg.auth?.proactive_failover_pct).toBeUndefined();
  });

  it("rejects values above 99 (must stay below the hard wall)", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...minimalBase,
        auth: { active: "alice", proactive_failover_pct: 99.5 },
      }),
    ).toThrow();
  });

  it("rejects zero/negative and non-numeric values", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...minimalBase,
        auth: { active: "alice", proactive_failover_pct: 0 },
      }),
    ).toThrow();
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...minimalBase,
        auth: { active: "alice", proactive_failover_pct: "95" },
      }),
    ).toThrow();
  });
});

describe("AgentSoulSchema — first-class persona fields + shape (#1856)", () => {
  it("(a) validates a full soul block with all 8 fields and round-trips values", () => {
    const soul = {
      name: "Sage",
      style: "warm, concise",
      creature: "owl",
      vibe: "calm, precise",
      expertise: "systems engineering",
      emoji: "🦉",
      boundaries: "not a doctor",
      shape: "developer" as const,
    };
    const r = AgentSoulSchema.parse(soul);
    expect(r).toEqual(soul);
  });

  it("(b) parses a soul block without shape to shape:'generalist'", () => {
    const r = AgentSoulSchema.parse({ name: "X", style: "Y" });
    expect(r?.shape).toBe("generalist");
  });

  it("(c) rejects an unknown shape with a message naming the field + allowed values", () => {
    const r = AgentSoulSchema.safeParse({ name: "X", style: "Y", shape: "wizard" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "shape");
      expect(issue).toBeDefined();
      // enum rejection lists the four allowed values
      expect(issue?.message).toContain("executive-assistant");
      expect(issue?.message).toContain("developer");
      expect(issue?.message).toContain("coach");
      expect(issue?.message).toContain("generalist");
    }
  });

  it("(d) still validates a minimal soul (name + style only)", () => {
    const r = AgentSoulSchema.parse({ name: "X", style: "Y" });
    expect(r?.name).toBe("X");
    expect(r?.style).toBe("Y");
  });

  it("(e) validates a config with no soul block at all", () => {
    const cfg = {
      switchroom: { version: 1 },
      telegram: { bot_token: "123:ABC", forum_chat_id: "-100123" },
      agents: { bare: { extends: "default", topic_name: "Bare" } },
    };
    const r = SwitchroomConfigSchema.parse(cfg);
    expect(r.agents.bare.soul).toBeUndefined();
  });
});

describe("release.auto_update (KEN-131) — root-only opt-in", () => {
  it("root release block accepts auto_update: true alongside channel/pin rules", () => {
    expect(RootReleaseBlock.parse({ auto_update: true })).toEqual({
      auto_update: true,
    });
    expect(
      RootReleaseBlock.parse({ pin: "v1.2.3", auto_update: true }),
    ).toEqual({ pin: "v1.2.3", auto_update: true });
  });

  it("defaults OFF — an ordinary release block parses with auto_update undefined", () => {
    const r = RootReleaseBlock.parse({ pin: "v1.2.3" });
    expect(r.auto_update).toBeUndefined();
  });

  it("channel/pin mutual exclusion still holds on the root block", () => {
    expect(() =>
      RootReleaseBlock.parse({ channel: "latest", pin: "v1.2.3" }),
    ).toThrow();
  });

  it("per-agent / profile release blocks REJECT auto_update (fleet-only knob)", () => {
    expect(() => ReleaseBlock.parse({ auto_update: true })).toThrow();
    expect(() =>
      AgentSchema.parse({ release: { auto_update: true } }),
    ).toThrow();
  });

  it("full config: root release.auto_update parses; omitted stays undefined", () => {
    const base = {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "1" },
      agents: {},
    };
    const off = SwitchroomConfigSchema.parse({
      ...base,
      release: { pin: "v1.2.3" },
    });
    expect(off.release?.auto_update).toBeUndefined();
    const on = SwitchroomConfigSchema.parse({
      ...base,
      release: { pin: "v1.2.3", auto_update: true },
    });
    expect(on.release?.auto_update).toBe(true);
  });
});

describe("resources.tmp_size — per-agent /tmp tmpfs sizing", () => {
  const base = {
    switchroom: { version: 1 },
    telegram: { bot_token: "x", forum_chat_id: "1" },
  };

  it("survives AgentSchema parse (NOT stripped — the #3773 silent no-op class)", () => {
    // The `resources` object is a plain z.object, which STRIPS unknown
    // keys. If tmp_size is missing from the AgentSchema mirror the key
    // vanishes at parse and the knob is a silent no-op, exactly the bug
    // filed as #3773. Assert the resolved value, not the parse success.
    const a = AgentSchema.parse({ topic_name: "ops", resources: { tmp_size: "4g" } });
    expect(a.resources?.tmp_size).toBe("4g");
  });

  it("survives parse at the defaults layer (fleet-wide default)", () => {
    const cfg = SwitchroomConfigSchema.parse({
      ...base,
      defaults: { resources: { tmp_size: "4g" } },
      agents: {},
    });
    expect(cfg.defaults?.resources?.tmp_size).toBe("4g");
  });

  it("survives parse at the profile layer", () => {
    const cfg = SwitchroomConfigSchema.parse({
      ...base,
      profiles: { roomy: { resources: { tmp_size: "6g" } } },
      agents: {},
    });
    expect(cfg.profiles?.roomy?.resources?.tmp_size).toBe("6g");
  });

  it("accepts the docker size forms operators actually write", () => {
    for (const v of ["512m", "1g", "2g", "4g", "1.5g", "1048576k", "2G", "512M"]) {
      expect(AgentSchema.parse({ topic_name: "ops", resources: { tmp_size: v } }).resources?.tmp_size).toBe(v);
    }
  });

  it("rejects garbage at config-load time, not at `docker compose up`", () => {
    // "0"/"0g" parse as size strings but mount a ZERO-byte /tmp — every
    // write in the container fails, so they are rejected too.
    for (const bad of ["big", "4gb", "-1g", "4 g", "", "4gigs", "1e9", "0", "0g", "0.0m"]) {
      expect(() => AgentSchema.parse({ topic_name: "ops", resources: { tmp_size: bad } })).toThrow();
    }
  });

  it("rejects garbage at the defaults layer too", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...base,
        defaults: { resources: { tmp_size: "lots" } },
        agents: {},
      }),
    ).toThrow(/tmp_size must be a Docker size string/);
  });

  it("stays optional — an agent with no resources block still parses", () => {
    expect(AgentSchema.parse({ topic_name: "ops" }).resources).toBeUndefined();
  });
});

describe("AgentSchema — memory.recall query shaping (#3757)", () => {
  const agent = (recall: Record<string, unknown>) => ({
    model: "opus",
    topic_name: "test",
    purpose: "test agent",
    memory: { collection: "a", recall },
  });

  it("accepts the three shaping knobs and preserves their values", () => {
    const r = AgentSchema.parse(
      agent({
        query_max_tokens: 16,
        query_stop_terms: ["switchroom", "v0.19.24", "src/config", "well-known"],
        request_timeout_seconds: 14,
      }),
    );
    expect(r.memory?.recall?.query_max_tokens).toBe(16);
    expect(r.memory?.recall?.request_timeout_seconds).toBe(14);
    expect(r.memory?.recall?.query_stop_terms).toEqual([
      "switchroom",
      "v0.19.24",
      "src/config",
      "well-known",
    ]);
  });

  it("accepts query_max_tokens: 0 — the documented rollback lever", () => {
    expect(AgentSchema.parse(agent({ query_max_tokens: 0 })).memory?.recall?.query_max_tokens)
      .toBe(0);
  });

  it("rejects a stop term that could never be a BM25 token", () => {
    // Also what keeps the single-quoted start.sh export unbreakable: a term
    // containing a quote would terminate the shell string.
    for (const bad of ["", "two words", "it's", `say "hi"`, "a;rm -rf /"]) {
      expect(() => AgentSchema.parse(agent({ query_stop_terms: [bad] }))).toThrow();
    }
  });

  it("rejects a negative token cap and a zero timeout", () => {
    expect(() => AgentSchema.parse(agent({ query_max_tokens: -1 }))).toThrow();
    expect(() => AgentSchema.parse(agent({ request_timeout_seconds: 0 }))).toThrow();
  });
});

// ── v1 per-account selection: google_accounts.{readonly,services} ────────

describe("google_accounts per-account selection (v1 read-only scope model)", () => {
  const base = {
    switchroom: { version: 1 },
    telegram: { bot_token: "x", forum_chat_id: "1" },
    agents: {},
  };

  it("accepts readonly + services on an account record", () => {
    const result = SwitchroomConfigSchema.parse({
      ...base,
      google_accounts: {
        "alice@example.com": {
          enabled_for: ["klanker"],
          readonly: true,
          services: ["cal", "drive"],
        },
      },
    });
    const rec = result.google_accounts?.["alice@example.com"];
    expect(rec?.readonly).toBe(true);
    expect(rec?.services).toEqual(["cal", "drive"]);
  });

  it("both are optional (legacy records keep parsing, undefined selection)", () => {
    const result = SwitchroomConfigSchema.parse({
      ...base,
      google_accounts: {
        "alice@example.com": { enabled_for: ["klanker"] },
      },
    });
    const rec = result.google_accounts?.["alice@example.com"];
    expect(rec?.readonly).toBeUndefined();
    expect(rec?.services).toBeUndefined();
  });

  it("rejects an unknown service token (closed enum — a typo must not be inert)", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...base,
        google_accounts: {
          "alice@example.com": {
            enabled_for: ["klanker"],
            services: ["gmail"],
          },
        },
      }),
    ).toThrow();
  });

  it("rejects an empty services list (min 1 — empty means 'remove the key')", () => {
    expect(() =>
      SwitchroomConfigSchema.parse({
        ...base,
        google_accounts: {
          "alice@example.com": { enabled_for: ["klanker"], services: [] },
        },
      }),
    ).toThrow();
  });
});
