/**
 * Phase 1a doctor checks — positive and negative cases per check.
 */

import { describe, it, expect } from "vitest";
import {
  checkAgentUidUniqueness,
  checkAgentSocketMounts,
  checkAgentCaps,
  checkDockerfileUserAlignment,
  runDockerChecks,
} from "../../src/cli/doctor-docker.js";
import { generateCompose, allocateAgentUid } from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

function makeConfig(agents: Record<string, { extends?: string; settings_raw?: Record<string, unknown> }>): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents", skills_dir: "~/.switchroom/skills" },
    telegram: { bot_token: "x" },
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, cfg]) => [
        name,
        { extends: cfg.extends, settings_raw: cfg.settings_raw, schedule: [], tools: { allow: [], deny: [] } },
      ]),
    ),
  } as unknown as SwitchroomConfig;
}

describe("checkAgentUidUniqueness", () => {
  it("ok when UIDs are unique (typical fleet)", () => {
    const r = checkAgentUidUniqueness(makeConfig({ klanker: {}, coach: {}, finn: {} }));
    expect(r.status).toBe("ok");
  });

  it("fails when two names hash to the same UID", () => {
    // Force a collision by spying on allocateAgentUid via two synthesised
    // names — find a real collision by brute force in [a-z]{1..3}.
    const seen = new Map<number, string>();
    let pair: [string, string] | null = null;
    outer: for (const a of "abcdefghijklmnopqrstuvwxyz".split("")) {
      for (let n = 0; n < 10000 && !pair; n++) {
        const candidate = `${a}${n}`;
        const uid = allocateAgentUid(candidate);
        const prev = seen.get(uid);
        if (prev) { pair = [prev, candidate]; break outer; }
        seen.set(uid, candidate);
      }
    }
    if (!pair) {
      // Realistically unreachable given 999 buckets vs 26*10000 candidates.
      throw new Error("no UID collision found in brute-force search");
    }
    const r = checkAgentUidUniqueness(makeConfig({ [pair[0]]: {}, [pair[1]]: {} }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain(pair[0]);
    expect(r.detail).toContain(pair[1]);
  });
});

describe("checkAgentSocketMounts", () => {
  it("ok on a freshly generated compose", () => {
    const yaml = generateCompose({ config: makeConfig({ a: {}, b: {} }) });
    const r = checkAgentSocketMounts(yaml);
    expect(r.status).toBe("ok");
  });

  it("fails when an agent mounts another's broker socket", () => {
    const good = generateCompose({ config: makeConfig({ a: {}, b: {} }) });
    // Inject a hostile mount under agent-a's volumes block — match the
    // line that ONLY appears in the agent block (in-agent broker mount
    // ends at /run/switchroom/broker; the broker service mount has /a
    // appended).
    const hostile = good.replace(
      "      - broker-a-sock:/run/switchroom/broker\n      - kernel-a-sock",
      "      - broker-a-sock:/run/switchroom/broker\n      - broker-b-sock:/run/switchroom/broker-b\n      - kernel-a-sock",
    );
    const r = checkAgentSocketMounts(hostile);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/agent-a mounts broker-b-sock/);
  });

  it("fails when an agent mounts another's kernel socket", () => {
    const good = generateCompose({ config: makeConfig({ x: {}, y: {} }) });
    // Post-RFC-H the agent's volume list interleaves an auth-broker-x-sock
    // mount between kernel-x-sock and the agent-state bind. Anchor the
    // injection between kernel-x-sock and the immediately-following
    // auth-broker-x-sock line so the patch is unambiguous.
    const hostile = good.replace(
      "      - kernel-x-sock:/run/switchroom/kernel\n      - auth-broker-x-sock",
      "      - kernel-x-sock:/run/switchroom/kernel\n      - kernel-y-sock:/run/switchroom/kernel-y\n      - auth-broker-x-sock",
    );
    const r = checkAgentSocketMounts(hostile);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/agent-x mounts kernel-y-sock/);
  });
});

describe("checkAgentCaps", () => {
  it("ok when no agent declares cap_add", () => {
    const r = checkAgentCaps(makeConfig({ a: {}, b: {} }));
    expect(r.status).toBe("ok");
  });

  it("fails when an agent has cap_add", () => {
    const r = checkAgentCaps(makeConfig({ rogue: { settings_raw: { cap_add: ["SYS_ADMIN"] } } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("rogue");
    expect(r.detail).toContain("SYS_ADMIN");
  });
});

describe("checkDockerfileUserAlignment", () => {
  it("ok when Dockerfile.agent declares no USER directive", () => {
    const yaml = generateCompose({ config: makeConfig({ a: {} }) });
    const r = checkDockerfileUserAlignment(yaml, "FROM node:22\nRUN echo hi\n");
    expect(r.status).toBe("ok");
  });

  it("warns when USER directive disagrees with compose user:", () => {
    const yaml = generateCompose({ config: makeConfig({ a: {} }) });
    const r = checkDockerfileUserAlignment(yaml, "FROM node:22\nUSER 9999\n");
    expect(r.status).toBe("warn");
  });

  it("FAILS when Dockerfile.agent declares USER 0 (privesc hazard)", () => {
    const yaml = generateCompose({ config: makeConfig({ a: {} }) });
    const r = checkDockerfileUserAlignment(yaml, "FROM node:22\nUSER 0\n");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/USER 0|root/);
  });

  it("FAILS when Dockerfile.agent declares USER 0:0", () => {
    const yaml = generateCompose({ config: makeConfig({ a: {} }) });
    const r = checkDockerfileUserAlignment(yaml, "FROM node:22\nUSER 0:0\n");
    expect(r.status).toBe("fail");
  });
});

describe("runDockerChecks", () => {
  it("no-ops when Docker mode is inactive", () => {
    const r = runDockerChecks({ config: makeConfig({}), active: false });
    expect(r.length).toBe(1);
    expect(r[0]!.status).toBe("ok");
    expect(r[0]!.detail).toContain("not active");
  });

  it("runs the full battery when active and compose is present", () => {
    const cfg = makeConfig({ a: {}, b: {} });
    const yaml = generateCompose({ config: cfg });
    const r = runDockerChecks({
      config: cfg,
      composeYaml: yaml,
      dockerfileAgent: "FROM node:22\n",
      active: true,
    });
    const names = r.map((c) => c.name);
    expect(names).toContain("agent UID uniqueness");
    expect(names).toContain("agent capability extras");
    expect(names).toContain("agent socket-volume isolation");
    expect(names).toContain("Dockerfile USER alignment");
  });

  it("warns when Docker mode is active but compose is missing", () => {
    const r = runDockerChecks({ config: makeConfig({ a: {} }), active: true });
    const composeCheck = r.find((c) => c.name === "compose file present");
    expect(composeCheck?.status).toBe("warn");
  });
});
