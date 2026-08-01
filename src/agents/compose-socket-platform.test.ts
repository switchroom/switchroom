/**
 * Compose-generator tests for:
 *   #3648 — the root-agent docker.sock :rw bind uses the resolved host
 *           socket path (injected via ComposeGeneratorOptions.dockerSocketPath).
 *   #3637 — the platform-gated network-isolation default: Linux → "host"
 *           (byte-identical to pre-#3637), non-Linux → "strict".
 */
import { describe, expect, it } from "vitest";
import { generateCompose, defaultNetworkIsolation } from "./compose.js";
import type { SwitchroomConfig } from "../config/schema.js";

const AGENTS_DIR = "/home/op/.switchroom/agents";

function baseConfig(alice: Record<string, unknown> = {}): SwitchroomConfig {
  return {
    agents: {
      alice: { profile: "engineer", claudeAccount: "default", ...alice },
    },
    profiles: {},
    defaults: {},
    switchroom: { agents_dir: AGENTS_DIR },
    telegram: { forum_chat_id: "0" },
  } as unknown as SwitchroomConfig;
}

function gen(config: SwitchroomConfig, extra: Record<string, unknown> = {}): string {
  return generateCompose({
    config,
    homeDir: "/home/op",
    warn: () => {},
    ...extra,
  });
}

describe("compose generator — root-agent docker socket bind (#3648)", () => {
  it("binds the injected host socket path :rw for a root agent (target stays /var/run/docker.sock)", () => {
    const yaml = gen(baseConfig({ root: true }), {
      dockerSocketPath: "/run/user/1000/docker.sock",
    });
    expect(yaml).toContain(
      "- /run/user/1000/docker.sock:/var/run/docker.sock:rw",
    );
    // The stock host path must NOT appear as the bind source when the
    // context resolved elsewhere — proves the value is actually threaded.
    expect(yaml).not.toContain("- /var/run/docker.sock:/var/run/docker.sock:rw");
  });

  it("still binds the conventional default when that is the resolved path", () => {
    const yaml = gen(baseConfig({ root: true }), {
      dockerSocketPath: "/var/run/docker.sock",
    });
    expect(yaml).toContain("- /var/run/docker.sock:/var/run/docker.sock:rw");
  });

  it("emits NO docker.sock bind for a non-root agent", () => {
    const yaml = gen(baseConfig(), { dockerSocketPath: "/whatever.sock" });
    expect(yaml).not.toContain(":/var/run/docker.sock:rw");
  });
});

describe("defaultNetworkIsolation (#3637)", () => {
  it("defaults to host on Linux (byte-identical to pre-#3637)", () => {
    expect(defaultNetworkIsolation("linux")).toBe("host");
  });

  it("defaults to strict on macOS (Docker Desktop / LinuxKit VM)", () => {
    expect(defaultNetworkIsolation("darwin")).toBe("strict");
  });

  it("defaults to strict on Windows", () => {
    expect(defaultNetworkIsolation("win32")).toBe("strict");
  });
});

describe("compose generator — network default is Linux byte-identical (#3637)", () => {
  // These assertions capture the exact pre-#3637 Linux emission for an agent
  // with UNSET network_isolation. They run under vitest on Linux CI, where
  // defaultNetworkIsolation() resolves to "host" — so the platform gate is a
  // no-op here and the output must be unchanged.
  it("an agent with unset network_isolation emits `network_mode: host` on Linux", () => {
    const yaml = gen(baseConfig());
    expect(process.platform).toBe("linux"); // guard: this test only proves the invariant on Linux
    expect(yaml).toContain("    network_mode: host");
    // The strict-mode wiring must NOT appear for a default (host) agent.
    expect(yaml).not.toContain("- switchroom-net-alice");
  });

  it("an explicit strict agent still emits the dedicated bridge network + host-gateway", () => {
    const yaml = gen(baseConfig({ network_isolation: "strict" }));
    expect(yaml).toContain("- switchroom-net-alice");
    expect(yaml).toContain('- "host.docker.internal:host-gateway"');
  });
});
