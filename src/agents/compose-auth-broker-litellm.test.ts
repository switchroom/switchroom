/**
 * Regression guard: the auth-broker must be able to reach the LiteLLM proxy
 * for `get-external-spend` (the `/usage` External OpenRouter row).
 *
 * Bug: with a loopback LiteLLM base (`http://127.0.0.1:4010`, the normal
 * Coolify/socat host-loopback publish), the generator rewrote the base to
 * `host.docker.internal` and left the broker on the compose bridge. But
 * host.docker.internal/host-gateway routes to the host's *bridge* IP, NOT to
 * host loopback — a 127.0.0.1-bound host port is unreachable from the bridge.
 * The broker's live `/spend/logs` fetch was refused, `get-external-spend`
 * returned `available:false`, and the `/usage` External row rendered blank.
 *
 * Fix: a loopback base makes the broker join the host network (mirroring the
 * hindsight consumer's proven path) and keep the loopback URL verbatim. A
 * non-loopback base stays on the bridge with host-gateway.
 */

import { describe, expect, it } from "vitest";
import { generateCompose, isLoopbackHttpBase } from "./compose.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENTS_DIR = "/home/op/.switchroom/agents";

function configWithLitellmBase(baseUrl?: string): SwitchroomConfig {
  return {
    agents: {
      alice: { profile: "engineer", claudeAccount: "default" },
    },
    profiles: {},
    defaults: {},
    switchroom: { agents_dir: AGENTS_DIR },
    telegram: { forum_chat_id: "0" },
    ...(baseUrl ? { litellm: { enabled: true, base_url: baseUrl } } : {}),
  } as unknown as SwitchroomConfig;
}

function gen(config: SwitchroomConfig): string {
  return generateCompose({ config, homeDir: "/home/op", warn: () => {} });
}

/** Slice the generated compose to the `switchroom-auth-broker:` service block. */
function authBrokerBlock(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === "  switchroom-auth-broker:");
  expect(start).toBeGreaterThanOrEqual(0);
  // Next top-level service (2-space indent + name) or the volumes: block.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("isLoopbackHttpBase", () => {
  it("recognizes host-loopback bases", () => {
    expect(isLoopbackHttpBase("http://127.0.0.1:4010")).toBe(true);
    expect(isLoopbackHttpBase("http://localhost:4010")).toBe(true);
    expect(isLoopbackHttpBase("http://127.0.0.1:4010/")).toBe(true);
  });

  it("rejects non-loopback bases", () => {
    expect(isLoopbackHttpBase("http://litellm:4010")).toBe(false);
    expect(isLoopbackHttpBase("http://10.0.0.5:4010")).toBe(false);
    expect(isLoopbackHttpBase("https://proxy.example.com")).toBe(false);
  });
});

describe("compose generator — auth-broker LiteLLM reachability", () => {
  it("loopback base: broker joins host network and keeps the loopback URL verbatim", () => {
    const block = authBrokerBlock(gen(configWithLitellmBase("http://127.0.0.1:4010")));

    // Host network so 127.0.0.1:4010 (loopback-published proxy) is reachable.
    expect(block).toContain("network_mode: host");
    // The loopback URL is passed to the broker unchanged — NOT rewritten to a
    // host.docker.internal address that cannot reach a loopback-bound port.
    expect(block).toContain('SWITCHROOM_LITELLM_BASE: "http://127.0.0.1:4010"');
    expect(block).not.toContain("host.docker.internal");
    expect(block).not.toContain("extra_hosts");
  });

  it("localhost base: same host-network treatment", () => {
    const block = authBrokerBlock(gen(configWithLitellmBase("http://localhost:4010")));
    expect(block).toContain("network_mode: host");
    expect(block).toContain('SWITCHROOM_LITELLM_BASE: "http://localhost:4010"');
    expect(block).not.toContain("host.docker.internal");
  });

  it("non-loopback base: stays on the bridge with host-gateway, no host network", () => {
    const block = authBrokerBlock(gen(configWithLitellmBase("http://litellm-proxy.internal:4010")));

    expect(block).not.toContain("network_mode: host");
    expect(block).toContain('SWITCHROOM_LITELLM_BASE: "http://litellm-proxy.internal:4010"');
    expect(block).toContain("extra_hosts");
    expect(block).toContain("host.docker.internal:host-gateway");
  });

  it("no litellm base configured: neither host network nor host-gateway", () => {
    const block = authBrokerBlock(gen(configWithLitellmBase(undefined)));
    expect(block).not.toContain("network_mode: host");
    expect(block).not.toContain("extra_hosts");
    expect(block).not.toContain("SWITCHROOM_LITELLM_BASE");
  });
});
