import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveSwitchroomCliPath, generateGatewayUnit } from "../src/agents/systemd";

/**
 * These tests cover the gateway-CLI-wrapper switch added to close the
 * silent-respawn JTBD anti-pattern. The live bug: `/auth reauth`,
 * `/restart`, `/reconcile` all fail silently on bun-only hosts because
 * the packaged `switchroom` binary shebang is `#!/usr/bin/env node`.
 * `resolveSwitchroomCliPath` flips to a repo-local wrapper when node is
 * absent, so the gateway invokes the CLI through bun instead.
 */

describe("resolveSwitchroomCliPath", () => {
  it("returns the packaged CLI when node is on PATH", () => {
    const result = resolveSwitchroomCliPath("/home/test/.bun/bin", { nodeAvailable: true });
    expect(result).toBe("/home/test/.bun/bin/switchroom");
  });

  it("returns the repo-local wrapper when node is NOT on PATH and the wrapper exists", () => {
    const result = resolveSwitchroomCliPath("/home/test/.bun/bin", { nodeAvailable: false, wrapperExists: true });
    expect(result).toMatch(/scripts\/switchroom-cli-wrapper\.sh$/);
  });

  it("falls back to the packaged CLI when neither node nor wrapper is available", () => {
    const result = resolveSwitchroomCliPath("/home/test/.bun/bin", { nodeAvailable: false, wrapperExists: false });
    expect(result).toBe("/home/test/.bun/bin/switchroom");
  });

  it("detects node availability on PATH by default (no override)", () => {
    // This test isn't deterministic across hosts but validates the
    // default-injection path doesn't throw. Assertion: result is a
    // non-empty absolute path ending in either 'switchroom' or the
    // wrapper script name.
    const result = resolveSwitchroomCliPath("/home/test/.bun/bin");
    expect(result).toMatch(/(switchroom|switchroom-cli-wrapper\.sh)$/);
    expect(result.startsWith("/")).toBe(true);
  });

  it("repo ships the wrapper script on disk at the resolved path", () => {
    // Sanity check that the wrapper path we resolve to actually exists
    // in the repo. This would fail if someone deleted the script.
    const wrapperPath = resolveSwitchroomCliPath("/home/test/.bun/bin", { nodeAvailable: false, wrapperExists: true });
    expect(existsSync(wrapperPath)).toBe(true);
  });
});

describe("generateGatewayUnit — existing contract preserved", () => {
  it("always includes SWITCHROOM_CLI_PATH env var", () => {
    const unit = generateGatewayUnit("/tmp/test-state-dir", "test-agent");
    expect(unit).toContain("Environment=SWITCHROOM_CLI_PATH=");
    // The exact value depends on the host running the test (node present or
    // not) and the wrapper existing on disk. Both branches are correctness-
    // asserted by the resolveSwitchroomCliPath tests above.
  });

  it("includes the agent name in the description and SWITCHROOM_AGENT_NAME", () => {
    const unit = generateGatewayUnit("/tmp/test-state-dir", "klanker");
    expect(unit).toContain("Description=switchroom telegram gateway (klanker)");
    expect(unit).toContain("Environment=SWITCHROOM_AGENT_NAME=klanker");
  });

  it("uses the given stateDir for WorkingDirectory and TELEGRAM_STATE_DIR", () => {
    const unit = generateGatewayUnit("/tmp/my-state", "clerk");
    expect(unit).toContain("WorkingDirectory=/tmp/my-state");
    expect(unit).toContain("Environment=TELEGRAM_STATE_DIR=/tmp/my-state");
  });
});
