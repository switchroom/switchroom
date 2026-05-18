import { describe, it, expect } from "vitest";
import { TOOLS } from "./server.js";

describe("agent-config MCP server — PR A author tools", () => {
  it("registers the four new author tools after skill_remove", () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ["skill_create", "skill_edit", "skill_read", "skill_delete"]) {
      expect(names).toContain(n);
    }
    // Ordering: each comes after skill_remove.
    const removeIdx = names.indexOf("skill_remove");
    for (const n of ["skill_create", "skill_edit", "skill_read", "skill_delete"]) {
      expect(names.indexOf(n)).toBeGreaterThan(removeIdx);
    }
  });

  it("tool descriptions mention scope=agent and the relevant error codes", () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    expect(byName.skill_create!.description).toMatch(/scope=agent/);
    expect(byName.skill_create!.description).toMatch(/E_SKILL_AUTHOR_REQUIRES_INTERACTIVE/);
    expect(byName.skill_edit!.description).toMatch(/E_SKILL_VERSION_STALE/);
    expect(byName.skill_delete!.description).toMatch(/E_SKILL_INVALID_PATH/);
    expect(byName.skill_read!.description).toMatch(/version/);
  });

  it("skill_create requires files map; skill_edit requires content+version", () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    expect(byName.skill_create!.inputSchema.required).toEqual(
      expect.arrayContaining(["name", "files"]),
    );
    expect(byName.skill_edit!.inputSchema.required).toEqual(
      expect.arrayContaining(["name", "file", "content", "version"]),
    );
  });
});
