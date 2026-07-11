/**
 * Unit tests for the #2578 wiring: when an `auth.consumers[]` entry sets
 * `mirror_dir`, the compose generator must create a shared `consumer-creds-
 * <name>` named volume, mount it on the auth-broker at the consumer's
 * `mirror_dir` path, and declare it with a canonical (unprefixed) name so
 * the out-of-project consumer container can mount the same volume. Consumers
 * WITHOUT `mirror_dir` must be byte-identical to pre-#2578 output (no volume).
 */

import { describe, expect, it } from "vitest";
import { generateCompose } from "./compose.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENTS_DIR = "/home/op/.switchroom/agents";

function baseConfig(
  consumers?: Array<{ name: string; account?: string; uid?: number; mirror_dir?: string }>,
): SwitchroomConfig {
  return {
    agents: {
      alice: { profile: "engineer", claudeAccount: "default" },
    },
    profiles: {},
    defaults: {},
    switchroom: { agents_dir: AGENTS_DIR },
    telegram: { forum_chat_id: "0" },
    ...(consumers ? { auth: { consumers } } : {}),
  } as unknown as SwitchroomConfig;
}

function gen(config: SwitchroomConfig): string {
  return generateCompose({
    config,
    homeDir: "/home/op",
    warn: () => {},
  });
}

describe("compose generator — consumer mirror_dir wiring (#2578)", () => {
  it("consumer WITH mirror_dir: declares the shared volume, mounts it on the broker, and gives it a canonical name", () => {
    const yaml = gen(
      baseConfig([{ name: "hindsight", uid: 11000, mirror_dir: "/run/consumer-creds/hindsight" }]),
    );

    // Broker mounts the shared volume at the operator-chosen mirror_dir path.
    expect(yaml).toContain("- consumer-creds-hindsight:/run/consumer-creds/hindsight");

    // The volume is declared with a canonical (unprefixed) name so the
    // cross-project consumer container can reference it by name.
    expect(yaml).toMatch(/ {2}consumer-creds-hindsight:\n {4}name: consumer-creds-hindsight/);
  });

  it("consumer WITHOUT mirror_dir: emits NO shared creds volume (pre-#2578 output)", () => {
    const yaml = gen(baseConfig([{ name: "hindsight", uid: 11000 }]));

    expect(yaml).not.toContain("consumer-creds-");
    // Socket volume is still present — only the creds mirror is gated.
    expect(yaml).toContain("auth-broker-hindsight-sock");
  });

  it("no consumers at all: no consumer-creds volume, output stable", () => {
    const yaml = gen(baseConfig());
    expect(yaml).not.toContain("consumer-creds-");
  });

  it("multiple consumers: only the mirror_dir one gets a shared volume", () => {
    const yaml = gen(
      baseConfig([
        { name: "hindsight", uid: 11000, mirror_dir: "/run/consumer-creds/hindsight" },
        { name: "scribe", uid: 12000 },
      ]),
    );

    expect(yaml).toContain("- consumer-creds-hindsight:/run/consumer-creds/hindsight");
    expect(yaml).toContain("name: consumer-creds-hindsight");
    // scribe has no mirror_dir → no creds volume for it.
    expect(yaml).not.toContain("consumer-creds-scribe");
  });

  it("mirror_dir output is a strict superset — the no-mirror output is a substring-free of the mirror volume", () => {
    const withMirror = gen(
      baseConfig([{ name: "hindsight", uid: 11000, mirror_dir: "/run/consumer-creds/hindsight" }]),
    );
    const without = gen(baseConfig([{ name: "hindsight", uid: 11000 }]));

    // The only creds-mirror lines appear exclusively in the mirror variant.
    expect(without).not.toContain("consumer-creds-hindsight");
    expect(withMirror).toContain("consumer-creds-hindsight");
  });
});
