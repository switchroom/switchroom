import { describe, expect, it } from "vitest";
import {
  setAgentWorkspaceAccount,
  clearAgentWorkspaceAccount,
  getAgentWorkspaceAccount,
} from "./agent-workspace-account.js";

const BASE = `agents:
  marko:
    extends: default
  ziggy:
    extends: default
`;

describe("setAgentWorkspaceAccount", () => {
  it("creates the workspace block + account selector under a known agent", () => {
    const after = setAgentWorkspaceAccount(BASE, "microsoft", "marko", "lisa@outlook.com");
    expect(getAgentWorkspaceAccount(after, "microsoft", "marko")).toBe("lisa@outlook.com");
    // Other agents untouched.
    expect(getAgentWorkspaceAccount(after, "microsoft", "ziggy")).toBeNull();
    // Comment-preserving editor keeps the rest of the file.
    expect(after).toContain("ziggy:");
  });

  it("is idempotent (byte-equal when already set to the same value)", () => {
    const once = setAgentWorkspaceAccount(BASE, "google", "marko", "a@b.com");
    const twice = setAgentWorkspaceAccount(once, "google", "marko", "a@b.com");
    expect(twice).toBe(once);
  });

  it("throws for an undeclared agent", () => {
    expect(() => setAgentWorkspaceAccount(BASE, "microsoft", "nope", "x@y.com")).toThrow(
      /not declared/,
    );
  });
});

describe("clearAgentWorkspaceAccount", () => {
  it("removes the selector and drops the now-empty workspace block", () => {
    const set = setAgentWorkspaceAccount(BASE, "microsoft", "marko", "lisa@outlook.com");
    const cleared = clearAgentWorkspaceAccount(set, "microsoft", "marko");
    expect(getAgentWorkspaceAccount(cleared, "microsoft", "marko")).toBeNull();
    expect(cleared).not.toContain("microsoft_workspace");
  });

  it("keeps the workspace block when it carries other keys", () => {
    const withOrg = `agents:
  marko:
    microsoft_workspace:
      account: lisa@outlook.com
      org_mode: true
`;
    const cleared = clearAgentWorkspaceAccount(withOrg, "microsoft", "marko");
    expect(getAgentWorkspaceAccount(cleared, "microsoft", "marko")).toBeNull();
    expect(cleared).toContain("org_mode: true");
  });

  it("is a no-op for an unset selector / unknown agent", () => {
    expect(clearAgentWorkspaceAccount(BASE, "microsoft", "marko")).toBe(BASE);
    expect(clearAgentWorkspaceAccount(BASE, "microsoft", "nope")).toBe(BASE);
  });
});
