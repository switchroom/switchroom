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
import { checkAcl } from "./acl.js";
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
