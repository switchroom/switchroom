import { describe, it, expect } from "vitest";
import { linearSandboxRefusal } from "../src/cli/linear-agent.js";

describe("linearSandboxRefusal — host-only CLI guard", () => {
  it("refuses setup inside an agent container (SWITCHROOM_RUNTIME=docker)", () => {
    const msg = linearSandboxRefusal("setup", "docker");
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/HOST command/);
    expect(msg).toMatch(/linear_agent_setup/); // points at the in-container tool
  });

  it("refuses refresh too", () => {
    expect(linearSandboxRefusal("refresh", "docker")).toMatch(/'linear-agent refresh'/);
  });

  it("allows on the host (runtime undefined or non-docker)", () => {
    expect(linearSandboxRefusal("setup", undefined)).toBeNull();
    expect(linearSandboxRefusal("setup", "systemd")).toBeNull();
  });
});
