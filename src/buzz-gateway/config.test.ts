import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { isChannelLive, loadConfigFromEnv, resolveRelayHost, type EnvMap } from "./config.js";

const OP = getPublicKey(generateSecretKey());

function liveEnv(over: EnvMap = {}): EnvMap {
  return {
    BUZZ_ENABLED: "1",
    SWITCHROOM_AGENT_NAME: "klanker",
    BUZZ_CHAT_ID: "555",
    BUZZ_RELAY_URL: "ws://10.0.10.5:8080",
    BUZZ_CHANNEL_IDS: "group-uuid",
    BUZZ_OPERATOR_PUBKEY: OP,
    ...over,
  };
}

describe("loadConfigFromEnv", () => {
  it("loads a live config and includes the operator in the allowlist", () => {
    const res = loadConfigFromEnv(liveEnv());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.enabled).toBe(true);
    expect(res.config.authorized.has(OP.toLowerCase())).toBe(true);
    expect(res.config.nsecVaultKey).toBe("buzz/klanker-nsec");
  });

  it("folds extra authorized pubkeys plus the operator", () => {
    const extra = getPublicKey(generateSecretKey());
    const res = loadConfigFromEnv(liveEnv({ BUZZ_AUTHORIZED_PUBKEYS: `${extra}, garbage` }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.authorized.has(OP.toLowerCase())).toBe(true);
    expect(res.config.authorized.has(extra.toLowerCase())).toBe(true);
    expect(res.config.authorized.size).toBe(2); // garbage dropped
  });

  it("parses petnames", () => {
    const res = loadConfigFromEnv(liveEnv({ BUZZ_PUBKEY_NAMES: `${OP}=Ken` }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.pubkeyNames[OP.toLowerCase()]).toBe("Ken");
  });

  it("loads a DISABLED config even with a bare env (no operational fields)", () => {
    const res = loadConfigFromEnv({ SWITCHROOM_AGENT_NAME: "klanker", BUZZ_ENABLED: "0" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isChannelLive(res.config)).toBe(false);
  });

  it("rejects a LIVE config missing a required operational field", () => {
    const res = loadConfigFromEnv(liveEnv({ BUZZ_RELAY_URL: undefined }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/BUZZ_RELAY_URL/);
  });

  it("uses BUZZ_RELAY_URL as the canonical auth tag and dials it when no dial URL is set", () => {
    const res = loadConfigFromEnv(liveEnv({ BUZZ_RELAY_URL: "ws://127.0.0.1:3000" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.relayTagUrl).toBe("ws://127.0.0.1:3000");
    // No distinct dial address ⇒ dial the canonical URL.
    expect(res.config.relayUrl).toBe("ws://127.0.0.1:3000");
  });

  it("decouples the dial address (BUZZ_RELAY_DIAL_URL) from the canonical auth tag (BUZZ_RELAY_URL)", () => {
    const res = loadConfigFromEnv(
      liveEnv({
        BUZZ_RELAY_URL: "ws://127.0.0.1:3000", // canonical identity / auth tag
        BUZZ_RELAY_DIAL_URL: "ws://10.0.10.5:3000", // docker-network dial address
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.relayUrl).toBe("ws://10.0.10.5:3000"); // dialed
    expect(res.config.relayTagUrl).toBe("ws://127.0.0.1:3000"); // tagged
    // The tag value is independent of the dial URL.
    expect(res.config.relayTagUrl).not.toBe(res.config.relayUrl);
  });

  it("treats mirror:off as not-live (kill-switch)", () => {
    const res = loadConfigFromEnv(liveEnv({ BUZZ_MIRROR: "off" }));
    // off => not-live => operational fields not demanded, but still loads.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isChannelLive(res.config)).toBe(false);
  });
});

describe("resolveRelayHost", () => {
  it("prefers the explicit relay_host", () => {
    expect(resolveRelayHost({ relayHost: "127.0.0.1:3000", relayUrl: "ws://10.0.10.5:8080" })).toBe("127.0.0.1:3000");
  });

  it("falls back to the authority parsed from relay_url", () => {
    expect(resolveRelayHost({ relayHost: "", relayUrl: "ws://10.0.10.5:8080" })).toBe("10.0.10.5:8080");
  });
});
