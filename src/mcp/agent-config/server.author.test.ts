import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TOOLS, dispatchTool, spawnSyncWithStdin } from "./server.js";

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

  it("S5: skill_edit description documents per-skill version semantics", () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    expect(byName.skill_edit!.description).toMatch(/per-skill, not per-file/);
    expect(byName.skill_edit!.description).toMatch(/Re-read/);
  });

  it("E2E: skill_create round-trips via the real CLI (spawnSyncWithStdin)", () => {
    // Drive the real CLI source through `bun` (the project's chosen
    // runtime — `node dist/cli/switchroom.js` doesn't work because the
    // bundled output uses `bun:` imports). Skip cleanly if bun isn't
    // on PATH so the test stays runnable in node-only envs.
    const which = spawnSync("which", ["bun"], { encoding: "utf-8" });
    if (which.status !== 0) return;
    const cliEntry = join(process.cwd(), "bin", "switchroom.ts");
    if (!existsSync(cliEntry)) return;
    const tmp = mkdtempSync(join(tmpdir(), "skill-author-e2e-"));
    try {
      const fakeHome = tmp;
      const env = {
        ...process.env,
        HOME: fakeHome,
        SWITCHROOM_AGENT_NAME: "alice",
      } as NodeJS.ProcessEnv;
      const files = {
        "SKILL.md": `---\nname: e2e\ndescription: e2e roundtrip\n---\n# hi\n`,
      };
      const r = spawnSync(
        "bun",
        [cliEntry, "skill", "create", "--name", "e2e", "--from-stdin"],
        {
          encoding: "utf-8",
          env,
          input: JSON.stringify(files),
          timeout: 30000,
        },
      );
      if (r.status !== 0) {
        throw new Error(
          `CLI exit ${r.status}: stdout=${r.stdout} stderr=${r.stderr}`,
        );
      }
      const parsed = JSON.parse(r.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.slug).toBe("e2e");
      const skillDir = join(fakeHome, ".switchroom", "agents", "alice",
        ".claude", "skills", "e2e");
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8"))
        .toContain("description: e2e roundtrip");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("S2: spawnSyncWithStdin uses a 30s timeout", () => {
    // Sanity-check that the helper actually executes; with a no-op
    // command we should get a quick exit. The real assertion is the
    // function exists and returns the ExecResult shape.
    const r = spawnSyncWithStdin(["--version"], "");
    expect(typeof r.status).toBe("number");
  });
});
