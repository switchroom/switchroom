/**
 * Tests for vault-broker ACL enforcement.
 *
 * Identity is established via cgroup-based systemdUnit (not exe path).
 * Covers:
 *   - Valid cron unit + key in schedule secrets → allowed
 *   - Valid cron unit + key NOT in secrets → denied
 *   - Cross-agent: unit for agentA can't read agentB's secrets → denied
 *   - systemdUnit=null + allow_interactive=true + exe is switchroom CLI → allowed
 *   - systemdUnit=null + allow_interactive=false (default) → denied
 *   - Malformed/unrecognized unit name → denied
 *   - Unknown agent name in unit → denied
 *   - Out-of-range schedule index → denied
 */

import { describe, expect, it } from "vitest";
import { checkAcl } from "./acl.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import type { PeerInfo } from "./peercred.js";

const HOME_DIR = "/home/testuser";
const BUN_BIN_DIR = `${HOME_DIR}/.bun/bin`;

/** Minimal valid SwitchroomConfig stub */
function makeConfig(
  agentSchedules: Record<
    string,
    Array<{ cron: string; prompt: string; secrets?: string[] }>
  >,
  allowInteractive = false,
): SwitchroomConfig {
  const agents: SwitchroomConfig["agents"] = {};
  for (const [name, schedule] of Object.entries(agentSchedules)) {
    agents[name] = {
      topic_name: name,
      schedule: schedule.map((s) => ({
        cron: s.cron,
        prompt: s.prompt,
        secrets: s.secrets ?? [],
        suppress_stdout: false,
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
        allow_interactive: allowInteractive,
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

const OPTS = { homeDir: HOME_DIR, bunBinDir: BUN_BIN_DIR };

describe("ACL: cgroup-based cron identity", () => {
  it("allows a key that is in the declared secrets", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["api_key"] }],
    });
    const result = checkAcl(
      peer("switchroom-myagent-cron-0.service"),
      config,
      "api_key",
      OPTS,
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
      OPTS,
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
      OPTS,
    );
    expect(result.allow).toBe(false);
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
      OPTS,
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
    expect(checkAcl(peer("switchroom-myagent-cron-0.service"), config, "key_a", OPTS).allow).toBe(true);
    expect(checkAcl(peer("switchroom-myagent-cron-0.service"), config, "key_b", OPTS).allow).toBe(false);

    // cron-1 may read key_b but not key_a
    expect(checkAcl(peer("switchroom-myagent-cron-1.service"), config, "key_b", OPTS).allow).toBe(true);
    expect(checkAcl(peer("switchroom-myagent-cron-1.service"), config, "key_a", OPTS).allow).toBe(false);
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
      OPTS,
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
      OPTS,
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
      OPTS,
    );
    // systemdUnit is not null, but parseCronUnit will reject it
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
      OPTS,
    );
    expect(result.allow).toBe(false);
  });
});

describe("ACL: allow_interactive", () => {
  it("grants access when allow_interactive=true and exe is switchroom CLI (systemdUnit=null)", () => {
    const config = makeConfig({}, true);
    const switchroomExe = `${BUN_BIN_DIR}/switchroom`;
    const result = checkAcl(
      peer(null, switchroomExe),
      config,
      "any_key",
      OPTS,
    );
    expect(result.allow).toBe(true);
  });

  it("denies when allow_interactive=false (default) even for switchroom CLI", () => {
    const config = makeConfig({}, false);
    const switchroomExe = `${BUN_BIN_DIR}/switchroom`;
    const result = checkAcl(
      peer(null, switchroomExe),
      config,
      "any_key",
      OPTS,
    );
    expect(result.allow).toBe(false);
  });

  it("denies when allow_interactive absent (defaults to false)", () => {
    const config = makeConfig({});
    const switchroomExe = `${BUN_BIN_DIR}/switchroom`;
    const result = checkAcl(
      peer(null, switchroomExe),
      config,
      "any_key",
      OPTS,
    );
    expect(result.allow).toBe(false);
  });

  it("denies interactive even with allow_interactive=true when exe is not switchroom CLI", () => {
    const config = makeConfig({}, true);
    const result = checkAcl(
      peer(null, "/usr/bin/bash"),
      config,
      "any_key",
      OPTS,
    );
    expect(result.allow).toBe(false);
  });
});
