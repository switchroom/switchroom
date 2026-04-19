import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isInsideWorkspace } from "../src/cli/workspace.js";

/**
 * Regression coverage for sprint1 review finding #1: `switchroom
 * workspace edit` used a prefix check without a trailing separator,
 * so siblings like `/tmp/workspace-evil` were treated as being inside
 * `/tmp/workspace`. The fix hardened the guard; these tests lock in
 * both the rejection cases and the legitimate paths that must still
 * resolve inside the workspace.
 */
describe("isInsideWorkspace — path traversal guard", () => {
  const ws = resolve("/tmp/ws/workspace");

  it("rejects relative traversal (`../foo`)", () => {
    expect(isInsideWorkspace(ws, resolve(ws, "../foo"))).toBe(false);
  });

  it("rejects deep relative traversal (`../../etc/passwd`)", () => {
    expect(isInsideWorkspace(ws, resolve(ws, "../../etc/passwd"))).toBe(false);
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(isInsideWorkspace(ws, "/etc/passwd")).toBe(false);
    expect(isInsideWorkspace(ws, "/tmp/ws")).toBe(false);
  });

  it("rejects sibling dirs that share a string prefix (classic npm/tar bug)", () => {
    // `/tmp/ws/workspace-evil` starts with `/tmp/ws/workspace` but is NOT
    // inside it. This is the exact case the trailing-separator fix guards.
    expect(isInsideWorkspace(ws, "/tmp/ws/workspace-evil")).toBe(false);
    expect(isInsideWorkspace(ws, "/tmp/ws/workspace-evil/secret")).toBe(false);
  });

  it("accepts the workspace root itself (default `AGENTS.md` case)", () => {
    expect(isInsideWorkspace(ws, ws)).toBe(true);
  });

  it("accepts a file at the workspace root", () => {
    expect(isInsideWorkspace(ws, resolve(ws, "AGENTS.md"))).toBe(true);
  });

  it("accepts a file in a nested subdirectory", () => {
    expect(isInsideWorkspace(ws, resolve(ws, "memory/2026-04-19.md"))).toBe(
      true,
    );
  });

  it("accepts paths that normalise back inside the workspace", () => {
    // Callers may pass `foo/../bar.md`; `path.resolve` collapses it to a
    // real path under the workspace, which must still be permitted.
    expect(isInsideWorkspace(ws, resolve(ws, "sub/../AGENTS.md"))).toBe(true);
  });
});
