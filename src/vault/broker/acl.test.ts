/**
 * Tests for vault-broker ACL enforcement.
 *
 * Covers:
 *   - Exe outside ~/.switchroom/agents → denied
 *   - Correct agent/index mapping grants only schedule[i].secrets
 *   - Unknown key returns deny with reason
 *   - allow_interactive=true permits the installed switchroom CLI
 *   - Default (allow_interactive absent/false) permits nothing extra
 *   - Out-of-range schedule index → denied
 *   - Unknown agent name → denied
 */

import { describe, expect, it } from "vitest";
import { checkAcl } from "./acl.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import type { PeerInfo } from "./peercred.js";

const HOME_DIR = "/home/testuser";
const BUN_BIN_DIR = `${HOME_DIR}/.bun/bin`;
const AGENTS_DIR = `${HOME_DIR}/.switchroom/agents`;

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

function peer(exe: string, uid = 1000, pid = 1234): PeerInfo {
  return { uid, pid, exe };
}

const OPTS = { homeDir: HOME_DIR, bunBinDir: BUN_BIN_DIR };

describe("ACL: cron script path matching", () => {
  it("allows a key that is in the declared secrets", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["api_key"] }],
    });
    const exe = `${AGENTS_DIR}/myagent/telegram/cron-0.sh`;
    const result = checkAcl(peer(exe), config, "api_key", OPTS);
    expect(result.allow).toBe(true);
  });

  it("denies a key not in the declared secrets", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["api_key"] }],
    });
    const exe = `${AGENTS_DIR}/myagent/telegram/cron-0.sh`;
    const result = checkAcl(peer(exe), config, "other_secret", OPTS);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("other_secret");
    }
  });

  it("denies when secrets is empty", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: [] }],
    });
    const exe = `${AGENTS_DIR}/myagent/telegram/cron-0.sh`;
    const result = checkAcl(peer(exe), config, "any_key", OPTS);
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
    const exe0 = `${AGENTS_DIR}/myagent/telegram/cron-0.sh`;
    expect(checkAcl(peer(exe0), config, "key_a", OPTS).allow).toBe(true);
    expect(checkAcl(peer(exe0), config, "key_b", OPTS).allow).toBe(false);

    // cron-1 may read key_b but not key_a
    const exe1 = `${AGENTS_DIR}/myagent/telegram/cron-1.sh`;
    expect(checkAcl(peer(exe1), config, "key_b", OPTS).allow).toBe(true);
    expect(checkAcl(peer(exe1), config, "key_a", OPTS).allow).toBe(false);
  });
});

describe("ACL: exe outside agents dir → denied", () => {
  it("denies exe that is not under ~/.switchroom/agents", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["key"] }],
    });
    const result = checkAcl(
      peer("/usr/bin/bash"),
      config,
      "key",
      OPTS,
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("not a recognized switchroom cron script");
    }
  });

  it("denies exe under agents dir but wrong path structure", () => {
    const config = makeConfig({
      myagent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["key"] }],
    });
    // Missing /telegram/ segment
    const result = checkAcl(
      peer(`${AGENTS_DIR}/myagent/cron-0.sh`),
      config,
      "key",
      OPTS,
    );
    expect(result.allow).toBe(false);
  });
});

describe("ACL: unknown agent → denied", () => {
  it("denies when agent name not in config.agents", () => {
    const config = makeConfig({
      otheragent: [{ cron: "0 8 * * *", prompt: "hi", secrets: ["key"] }],
    });
    const exe = `${AGENTS_DIR}/unknownagent/telegram/cron-0.sh`;
    const result = checkAcl(peer(exe), config, "key", OPTS);
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
    const exe = `${AGENTS_DIR}/myagent/telegram/cron-5.sh`;
    const result = checkAcl(peer(exe), config, "key", OPTS);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("out of range");
    }
  });
});

describe("ACL: allow_interactive", () => {
  it("grants access when allow_interactive=true and exe is switchroom CLI", () => {
    const config = makeConfig({}, true);
    const switchroomExe = `${BUN_BIN_DIR}/switchroom`;
    const result = checkAcl(peer(switchroomExe), config, "any_key", OPTS);
    expect(result.allow).toBe(true);
  });

  it("denies when allow_interactive=false (default) even for switchroom CLI", () => {
    const config = makeConfig({}, false);
    const switchroomExe = `${BUN_BIN_DIR}/switchroom`;
    const result = checkAcl(peer(switchroomExe), config, "any_key", OPTS);
    expect(result.allow).toBe(false);
  });

  it("denies when allow_interactive absent (defaults to false)", () => {
    const config = makeConfig({});
    const switchroomExe = `${BUN_BIN_DIR}/switchroom`;
    const result = checkAcl(peer(switchroomExe), config, "any_key", OPTS);
    expect(result.allow).toBe(false);
  });
});
