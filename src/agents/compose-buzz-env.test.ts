/**
 * Buzz co-channel compose env projection (Phase 1 deploy switch).
 *
 * The generator must project `channels.buzz` into the agent container's
 * BUZZ_* environment so the sidecar (which has no config-cascade access) can
 * read it — and it must preserve the default-OFF keystone:
 *   - enabled:true  → BUZZ_ENABLED=1 projected (sidecar forks);
 *   - enabled:false → the block projects, but WITHOUT BUZZ_ENABLED (dark);
 *   - no channels.buzz block → NO BUZZ_* env at all (byte-identical to pre-Buzz).
 */

import { describe, expect, it } from "vitest";
import { generateCompose } from "./compose.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENTS_DIR = "/home/op/.switchroom/agents";

function cfg(buzz?: Record<string, unknown>): SwitchroomConfig {
  return {
    agents: {
      klanker: {
        profile: "engineer",
        claudeAccount: "default",
        ...(buzz ? { channels: { buzz } } : {}),
      },
    },
    profiles: {},
    defaults: {},
    switchroom: { agents_dir: AGENTS_DIR },
    telegram: { forum_chat_id: "0" },
  } as unknown as SwitchroomConfig;
}

function gen(config: SwitchroomConfig): string {
  return generateCompose({ config, homeDir: "/home/op", warn: () => {} });
}

/** Extract the environment lines for the agent-klanker service. */
function agentEnv(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trim() === "agent-klanker:");
  expect(start).toBeGreaterThanOrEqual(0);
  return lines.slice(start).filter((l) => /^\s{6}[A-Z0-9_]+:/.test(l));
}

const enabledBlock = {
  enabled: true,
  relay_url: "ws://127.0.0.1:3000",
  relay_dial_url: "ws://10.0.10.5:3000",
  relay_host: "127.0.0.1:3000",
  chat_id: "555",
  default_channel_id: "group-uuid",
  operator_pubkey: "1400c2c9816f066e289e61b333b94adda2eb4d70e5190e8daf7cb3429a9bddfe",
  authorized_pubkeys: ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
  mirror: "both",
};

describe("compose generator — channels.buzz env projection (Phase 1)", () => {
  it("enabled:true → BUZZ_ENABLED=1 plus the full BUZZ_* set", () => {
    const yaml = gen(cfg(enabledBlock));
    expect(yaml).toContain('BUZZ_ENABLED: "1"');
    expect(yaml).toContain('BUZZ_MIRROR: "both"');
    expect(yaml).toContain('BUZZ_CHAT_ID: "555"');
    // Canonical tag URL vs the docker dial address are projected distinctly.
    expect(yaml).toContain('BUZZ_RELAY_URL: "ws://127.0.0.1:3000"');
    expect(yaml).toContain('BUZZ_RELAY_DIAL_URL: "ws://10.0.10.5:3000"');
    expect(yaml).toContain('BUZZ_RELAY_HOST: "127.0.0.1:3000"');
    expect(yaml).toContain('BUZZ_CHANNEL_IDS: "group-uuid"');
    expect(yaml).toContain(
      'BUZZ_OPERATOR_PUBKEY: "1400c2c9816f066e289e61b333b94adda2eb4d70e5190e8daf7cb3429a9bddfe"',
    );
    expect(yaml).toContain(
      'BUZZ_AUTHORIZED_PUBKEYS: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"',
    );
    // The nsec is NEVER projected — only its vault KEY NAME ({agent}-substituted).
    expect(yaml).toContain('BUZZ_NSEC_VAULT_KEY: "buzz/klanker-nsec"');
    expect(yaml).not.toContain("nsec1"); // no secret material anywhere
  });

  it("enabled:false → the block projects config but WITHOUT BUZZ_ENABLED (stays dark)", () => {
    const yaml = gen(cfg({ ...enabledBlock, enabled: false }));
    expect(yaml).not.toContain("BUZZ_ENABLED");
    // Other config still projects (so an operator can stage it), but the
    // sidecar never forks because start.sh gates on BUZZ_ENABLED=1.
    expect(yaml).toContain('BUZZ_RELAY_URL: "ws://127.0.0.1:3000"');
  });

  it("enabled omitted (defaults to false) → NO BUZZ_ENABLED", () => {
    const block: Record<string, unknown> = { ...enabledBlock };
    delete block.enabled;
    const yaml = gen(cfg(block));
    expect(yaml).not.toContain("BUZZ_ENABLED");
  });

  it("KEYSTONE: no channels.buzz block → NO BUZZ_* env at all (byte-identical to pre-Buzz)", () => {
    const withBuzz = gen(cfg(enabledBlock));
    const withoutBuzz = gen(cfg());
    // Not a single BUZZ_ key when the block is absent.
    expect(withoutBuzz).not.toMatch(/BUZZ_/);
    // Sanity: the projection path is real (the enabled config DID emit them).
    expect(withBuzz).toMatch(/BUZZ_/);
  });

  it("omits optional dial/host/allowlist keys when not configured", () => {
    const minimal = {
      enabled: true,
      relay_url: "ws://127.0.0.1:3000",
      chat_id: "555",
      default_channel_id: "group-uuid",
      operator_pubkey: "1400c2c9816f066e289e61b333b94adda2eb4d70e5190e8daf7cb3429a9bddfe",
    };
    const env = agentEnv(gen(cfg(minimal)));
    const joined = env.join("\n");
    expect(joined).toContain("BUZZ_RELAY_URL:");
    expect(joined).not.toContain("BUZZ_RELAY_DIAL_URL:");
    expect(joined).not.toContain("BUZZ_RELAY_HOST:");
    expect(joined).not.toContain("BUZZ_AUTHORIZED_PUBKEYS:");
    // Defaults still land for the required-ish operational knobs.
    expect(joined).toContain('BUZZ_MIRROR: "both"');
    expect(joined).toContain('BUZZ_NSEC_VAULT_KEY: "buzz/klanker-nsec"');
  });
});
