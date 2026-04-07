import { describe, it, expect } from "vitest";
import { generateUnit } from "../src/agents/systemd.js";

describe("generateUnit", () => {
  it("generates valid unit file content", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("sets the correct Description", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain("Description=clerk agent: health-coach");
  });

  it("sets the correct ExecStart with tmux session", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain(
      'ExecStart=/usr/bin/tmux new-session -d -s clerk-health-coach "bash -l /home/user/.clerk/agents/health-coach/start.sh"'
    );
  });

  it("sets the correct ExecStop with tmux session", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain(
      "ExecStop=/usr/bin/tmux kill-session -t clerk-health-coach"
    );
  });

  it("sets the correct WorkingDirectory", () => {
    const unit = generateUnit("health-coach", "/home/user/.clerk/agents/health-coach");
    expect(unit).toContain("WorkingDirectory=/home/user/.clerk/agents/health-coach");
  });

  it("uses clerk- prefix for tmux session names", () => {
    const unit = generateUnit("assistant", "/opt/agents/assistant");
    expect(unit).toContain("-s clerk-assistant");
    expect(unit).toContain("-t clerk-assistant");
  });

  it("handles agent names with hyphens correctly", () => {
    const unit = generateUnit("my-cool-agent", "/agents/my-cool-agent");
    expect(unit).toContain("Description=clerk agent: my-cool-agent");
    expect(unit).toContain("-s clerk-my-cool-agent");
    expect(unit).toContain("-t clerk-my-cool-agent");
    expect(unit).toContain("WorkingDirectory=/agents/my-cool-agent");
  });

  it("includes network dependency targets", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
  });

  it("configures restart on failure", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=15");
  });

  it("sets Type=forking for tmux background sessions", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("Type=forking");
  });

  it("targets default.target for user units", () => {
    const unit = generateUnit("test", "/tmp/test");
    expect(unit).toContain("WantedBy=default.target");
  });
});
