import { describe, it, expect } from "vitest";
import { sep as pathSep, resolve } from "node:path";
import { getProfilePath, listAvailableProfiles } from "./profiles.js";

describe("getProfilePath", () => {
  it("resolves a real profile that exists on disk", () => {
    const result = getProfilePath("default");
    expect(result.endsWith(`${pathSep}default`)).toBe(true);
  });

  it("falls back to the default profile when the requested name does not exist", () => {
    const fallback = getProfilePath("not-a-real-profile-name-xyzzy");
    expect(fallback.endsWith(`${pathSep}default`)).toBe(true);
  });

  it("falls back to the default profile when the name is a config-only profile (e.g. 'coder')", () => {
    // The user can declare profiles inline in switchroom.yaml — these have no
    // filesystem directory, so getProfilePath should fall back, not throw.
    expect(() => getProfilePath("coder")).not.toThrow();
  });

  it("rejects a path-traversal attempt with `..`", () => {
    expect(() => getProfilePath("../etc")).toThrow(/Invalid profile name/);
  });

  it("rejects a path-traversal attempt with deeper `..`", () => {
    expect(() => getProfilePath("../../tmp")).toThrow(/Invalid profile name/);
  });

  it("rejects an absolute path", () => {
    // resolve() would canonicalize an absolute path, escaping PROFILES_ROOT.
    const abs = pathSep === "\\" ? "C:\\Windows" : "/etc/passwd";
    expect(() => getProfilePath(abs)).toThrow(/Invalid profile name/);
  });

  it("accepts an empty string (resolves to PROFILES_ROOT itself, then falls back)", () => {
    // resolve(PROFILES_ROOT, "") === PROFILES_ROOT, which is allowed; it
    // falls through to the default profile because it's not a usable
    // profile dir on its own.
    expect(() => getProfilePath("")).not.toThrow();
  });
});

describe("listAvailableProfiles", () => {
  it("includes the bundled 'default' profile", () => {
    const profiles = listAvailableProfiles();
    expect(profiles).toContain("default");
  });

  it("excludes the underscore-prefixed _base directory", () => {
    const profiles = listAvailableProfiles();
    expect(profiles).not.toContain("_base");
    expect(profiles.every((name) => !name.startsWith("_"))).toBe(true);
  });
});
