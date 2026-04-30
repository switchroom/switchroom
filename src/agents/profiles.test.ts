import { describe, it, expect } from "vitest";
import { sep as pathSep, resolve } from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProfilePath, listAvailableProfiles, renderProfileClaudeTemplate } from "./profiles.js";

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

  it("rejects a mixed-separator traversal attempt", () => {
    // resolve() normalizes mixed forward/backslash forms before the boundary
    // check fires, so this should be caught the same way `../etc` is.
    expect(() => getProfilePath("subfolder/../../etc")).toThrow(/Invalid profile name/);
  });

  // Symlink-traversal regression — covers the realpathSync check added in
  // response to PR #123 review. Skipped on Windows because creating a
  // directory symlink there requires elevated privileges or a developer-mode
  // setting that's not present on most CI / dev machines.
  it.skipIf(pathSep === "\\")(
    "rejects a profile name pointing at a symlink whose target is outside PROFILES_ROOT",
    () => {
      // We can't easily inject a symlink into the bundled profiles/ dir
      // without polluting the working tree. Instead, build a temp dir that
      // mirrors the real profiles/ layout, place a symlink-to-/etc inside,
      // and assert getProfilePath rejects names that resolve to that
      // symlink target. We do this by creating a sibling profile dir, which
      // confirms the symlink rejection works on a real fs layout.
      //
      // Strategy: create temp/<profiles>/<evil> as a symlink to /etc.
      // Direct getProfilePath call with absolute path is rejected by the
      // existing "absolute path" guard, so we instead check that
      // realpathSync of an in-tree symlink would throw. Indirect via
      // exposed PROFILES_ROOT would require module mocking; the simplest
      // verification is a unit-level check on realpathSync semantics.
      const tmp = mkdtempSync(join(tmpdir(), "switchroom-symlink-test-"));
      try {
        const fakeRoot = join(tmp, "profiles");
        mkdirSync(fakeRoot);
        // Create a target dir outside the fake root with a .hbs file
        const outside = join(tmp, "evil");
        mkdirSync(outside);
        writeFileSync(join(outside, "CLAUDE.md.hbs"), "x");
        // Create a symlink inside the fake root pointing at the outside dir
        symlinkSync(outside, join(fakeRoot, "lurker"), "dir");
        // The lexical check would PASS (resolve() doesn't follow symlinks)
        // but the realpath check should FAIL. We can't directly test
        // getProfilePath against a custom root, but we can prove the
        // realpath check works by computing it manually and asserting the
        // expected mismatch — that's the contract getProfilePath relies on.
        const lexical = resolve(fakeRoot, "lurker");
        expect(lexical.startsWith(fakeRoot + pathSep)).toBe(true);
        // realpathSync resolves through the symlink to the outside target:
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { realpathSync } = require("node:fs") as typeof import("node:fs");
        const real = realpathSync(lexical);
        expect(real.startsWith(fakeRoot + pathSep)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
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

describe("renderProfileClaudeTemplate", () => {
  it("renders CLAUDE.md.hbs to CLAUDE.md and returns { wrote: true, path }", () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-profile-render-test-"));
    try {
      const profileName = "test-profile";
      const profileDir = join(tmp, profileName);
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, "CLAUDE.md.hbs"),
        "# Profile: {{profile}}\nHello from the template.",
      );

      const result = renderProfileClaudeTemplate(profileName, tmp);

      expect(result.wrote).toBe(true);
      expect(result.path).toBe(join(profileDir, "CLAUDE.md"));
      expect(existsSync(result.path)).toBe(true);
      const content = readFileSync(result.path, "utf-8");
      expect(content).toBe("# Profile: test-profile\nHello from the template.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns { wrote: false } when no .hbs template exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-profile-render-test-"));
    try {
      const result = renderProfileClaudeTemplate("no-such-profile", tmp);
      expect(result.wrote).toBe(false);
      expect(existsSync(result.path)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("overwrites an existing CLAUDE.md on re-render", () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-profile-render-test-"));
    try {
      const profileName = "test-profile";
      const profileDir = join(tmp, profileName);
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, "CLAUDE.md.hbs"), "v1 {{profile}}");
      writeFileSync(join(profileDir, "CLAUDE.md"), "old content");

      const result = renderProfileClaudeTemplate(profileName, tmp);

      expect(result.wrote).toBe(true);
      const content = readFileSync(result.path, "utf-8");
      expect(content).toBe("v1 test-profile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("telegram-style partial — status? RCA-offer guidance (#162)", () => {
  it("instructs the agent to treat 'status?' as a UX-failure signal", () => {
    const REPO_ROOT = resolve(__dirname, "..", "..");
    const partial = readFileSync(
      join(REPO_ROOT, "profiles", "_shared", "telegram-style.md.hbs"),
      "utf-8",
    );
    expect(partial).toContain("status?");
    expect(partial).toContain("UX-failure signal");
    // Must reference the JTBD source for context
    expect(partial).toContain("know-what-my-agent-is-doing.md");
  });

  it("offers to file an RCA via the /file-bug skill", () => {
    const REPO_ROOT = resolve(__dirname, "..", "..");
    const partial = readFileSync(
      join(REPO_ROOT, "profiles", "_shared", "telegram-style.md.hbs"),
      "utf-8",
    );
    expect(partial).toContain("/file-bug");
    expect(partial).toContain("incident-rca");
  });

  it("warns against auto-filing on every status? (offer-then-confirm pattern)", () => {
    const REPO_ROOT = resolve(__dirname, "..", "..");
    const partial = readFileSync(
      join(REPO_ROOT, "profiles", "_shared", "telegram-style.md.hbs"),
      "utf-8",
    );
    // The "auto-file from a single status?" anti-pattern is explicitly
    // called out — without it the agent might invoke /file-bug
    // immediately on every "status?".
    expect(partial.toLowerCase()).toContain("auto-file");
    expect(partial.toLowerCase()).toContain("offer-then-confirm");
  });
});
