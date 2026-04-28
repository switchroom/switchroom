/**
 * Tests for the vault-broker integration in cron scripts and systemd units.
 *
 * Covers:
 *   - buildCronScript emits SWITCHROOM_VAULT_BROKER_SOCK export when brokerSocket provided
 *   - buildCronScript does NOT emit the export when brokerSocket is undefined
 *   - generateTimerServiceUnit includes After/Wants for switchroom-vault-broker.service
 *   - generateBrokerUnit produces a valid [Unit]/[Service]/[Install] template
 *   - generateBrokerUnit snapshot test
 */

import { describe, expect, it } from "vitest";
import { buildCronScript } from "./scaffold.js";
import { generateTimerServiceUnit, generateBrokerUnit } from "./systemd.js";

const AGENT_DIR = "/home/test/.switchroom/agents/sample";
const PROMPT = "Summarize markets.";
const MODEL = "claude-sonnet-4-6";
const CHAT_ID = "9876543";
const BROKER_SOCKET = "/home/test/.switchroom/vault-broker.sock";

// ─── buildCronScript + broker socket ─────────────────────────────────────

describe("buildCronScript: SWITCHROOM_VAULT_BROKER_SOCK export", () => {
  it("emits SWITCHROOM_VAULT_BROKER_SOCK when brokerSocket is provided", () => {
    const script = buildCronScript(
      AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["key_a"], BROKER_SOCKET,
    );
    expect(script).toContain(
      `export SWITCHROOM_VAULT_BROKER_SOCK='${BROKER_SOCKET}'`,
    );
  });

  it("does NOT emit SWITCHROOM_VAULT_BROKER_SOCK when brokerSocket is undefined", () => {
    const script = buildCronScript(
      AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["key_a"],
    );
    expect(script).not.toContain("SWITCHROOM_VAULT_BROKER_SOCK");
  });

  it("does NOT emit SWITCHROOM_VAULT_BROKER_SOCK when brokerSocket is omitted (no secrets)", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    expect(script).not.toContain("SWITCHROOM_VAULT_BROKER_SOCK");
  });

  it("broker socket export appears before the claude invocation", () => {
    const script = buildCronScript(
      AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["key_a"], BROKER_SOCKET,
    );
    const sockIdx = script.indexOf("SWITCHROOM_VAULT_BROKER_SOCK");
    const claudeIdx = script.indexOf("exec claude -p");
    expect(sockIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(sockIdx).toBeLessThan(claudeIdx);
  });

  it("secrets comment and broker socket export coexist", () => {
    const script = buildCronScript(
      AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["key_a", "key_b"], BROKER_SOCKET,
    );
    expect(script).toContain("# Allowed vault keys for this cron (broker ACL): key_a, key_b");
    expect(script).toContain(`SWITCHROOM_VAULT_BROKER_SOCK='${BROKER_SOCKET}'`);
  });
});

// ─── generateTimerServiceUnit broker dependency ───────────────────────────

describe("generateTimerServiceUnit: vault broker dependency", () => {
  it("includes After=switchroom-vault-broker.service", () => {
    const unit = generateTimerServiceUnit("myagent", 0, AGENT_DIR);
    expect(unit).toContain("After=switchroom-vault-broker.service");
  });

  it("includes Wants=switchroom-vault-broker.service", () => {
    const unit = generateTimerServiceUnit("myagent", 0, AGENT_DIR);
    expect(unit).toContain("Wants=switchroom-vault-broker.service");
  });

  it("does NOT include Requires= (soft dependency)", () => {
    const unit = generateTimerServiceUnit("myagent", 0, AGENT_DIR);
    expect(unit).not.toContain("Requires=");
  });
});

// ─── generateBrokerUnit ───────────────────────────────────────────────────

describe("generateBrokerUnit", () => {
  const opts = {
    homeDir: "/home/test",
    bunBinDir: "/home/test/.bun/bin",
  };

  it("produces a unit file with [Unit], [Service], [Install] sections", () => {
    const unit = generateBrokerUnit(opts);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("uses Type=notify", () => {
    const unit = generateBrokerUnit(opts);
    expect(unit).toContain("Type=notify");
  });

  it("ExecStart references the switchroom CLI vault broker start --foreground", () => {
    const unit = generateBrokerUnit(opts);
    expect(unit).toContain("vault broker start --foreground");
  });

  it("uses Restart=on-failure", () => {
    const unit = generateBrokerUnit(opts);
    expect(unit).toContain("Restart=on-failure");
  });

  it("does NOT include EnvironmentFile (passphrase never touches disk)", () => {
    const unit = generateBrokerUnit(opts);
    expect(unit).not.toMatch(/^EnvironmentFile=/m);
  });

  it("WantedBy=default.target", () => {
    const unit = generateBrokerUnit(opts);
    expect(unit).toContain("WantedBy=default.target");
  });

  it("snapshot test for broker unit content", () => {
    const unit = generateBrokerUnit(opts);
    // Snapshot-style: verify the key structural lines are present
    const lines = unit.split("\n");
    const unitSection = lines.indexOf("[Unit]");
    const serviceSection = lines.indexOf("[Service]");
    const installSection = lines.indexOf("[Install]");

    expect(unitSection).toBeGreaterThanOrEqual(0);
    expect(serviceSection).toBeGreaterThan(unitSection);
    expect(installSection).toBeGreaterThan(serviceSection);

    // ExecStart should be in [Service] section
    const execStartLine = lines.findIndex((l) => l.startsWith("ExecStart="));
    expect(execStartLine).toBeGreaterThan(serviceSection);
    expect(execStartLine).toBeLessThan(installSection);

    // Type=notify should be in [Service] section
    const typeLine = lines.findIndex((l) => l.startsWith("Type="));
    expect(typeLine).toBeGreaterThan(serviceSection);
    expect(typeLine).toBeLessThan(installSection);
  });
});
