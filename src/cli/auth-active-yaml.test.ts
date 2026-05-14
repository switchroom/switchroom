import { describe, expect, it } from "vitest";

import { setAuthActive } from "./auth-active-yaml.js";

const BASE = `# top-level comment
switchroom:
  version: 1
telegram:
  bot_token: "x"
agents:
  clerk:
    extends: default
`;

describe("setAuthActive", () => {
  it("creates auth: map when absent", () => {
    const out = setAuthActive(BASE, "ken@example.com");
    expect(out).toMatch(/^# top-level comment/m);
    expect(out).toMatch(/^auth:\n  active: ken@example\.com$/m);
    // Preserves surrounding content.
    expect(out).toContain("switchroom:");
    expect(out).toContain("clerk:");
  });

  it("updates auth.active when already present (different label)", () => {
    const withAuth = `auth:\n  active: old@example.com\n  fallback_order:\n    - old@example.com\n    - new@example.com\n${BASE}`;
    const out = setAuthActive(withAuth, "new@example.com");
    expect(out).toMatch(/active: new@example\.com/);
    expect(out).not.toMatch(/active: old@example\.com/);
    // Preserves fallback_order.
    expect(out).toMatch(/fallback_order:\n\s+- old@example\.com\n\s+- new@example\.com/);
  });

  it("is idempotent — returns input verbatim when already set to label", () => {
    const withAuth = `auth:\n  active: same@example.com\n${BASE}`;
    const out = setAuthActive(withAuth, "same@example.com");
    expect(out).toBe(withAuth);
  });

  it("preserves comments around the auth: block", () => {
    const withComments = `# header
auth:
  # active account
  active: a@x.com
  fallback_order: [a@x.com]
# footer
${BASE}`;
    const out = setAuthActive(withComments, "b@x.com");
    expect(out).toContain("# header");
    expect(out).toContain("# active account");
    expect(out).toContain("# footer");
    expect(out).toMatch(/active: b@x\.com/);
  });

  it("throws on empty label", () => {
    expect(() => setAuthActive(BASE, "")).toThrow(/non-empty string/);
  });

  it("throws on YAML root that isn't a map (defensive)", () => {
    expect(() => setAuthActive("- list\n- root\n", "x@y.com")).toThrow(/not a map/);
  });

  it("ensures trailing newline on output", () => {
    const noTrail = `switchroom:\n  version: 1\n`.trimEnd();
    const out = setAuthActive(noTrail, "x@y.com");
    expect(out.endsWith("\n")).toBe(true);
  });
});
