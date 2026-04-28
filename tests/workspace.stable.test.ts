/**
 * Tests for the `extra_stable_files` feature — per-agent config option
 * to include additional files in the stable workspace render.
 *
 * Replaces the earlier hardcoded BRIEF.md approach from feat/brief-md-stable-render.
 * See feat/extra-stable-files for the design rationale.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildStableBootstrapPrompt,
  loadStableBootstrapFiles,
  STABLE_BOOTSTRAP_FILENAMES,
} from "../src/agents/workspace.js";

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sr-extra-stable-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// loadStableBootstrapFiles — extra_stable_files option
// ---------------------------------------------------------------------------

describe("loadStableBootstrapFiles with no extra_stable_files", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns only default files when no extraStableFiles provided", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "agents content",
      "SOUL.md": "soul content",
      "BRIEF.md": "brief content that should NOT appear in default render",
    });
    const files = await loadStableBootstrapFiles(dir);
    const names = files.map((f) => f.name);
    // Should match exactly the STABLE_BOOTSTRAP_FILENAMES defaults
    expect(names).toEqual(STABLE_BOOTSTRAP_FILENAMES);
    // BRIEF.md must not be present
    expect(names).not.toContain("BRIEF.md");
    expect(files).toHaveLength(STABLE_BOOTSTRAP_FILENAMES.length);
  });

  it("returns only default files when extraStableFiles is empty array", async () => {
    dir = await makeWorkspace({ "AGENTS.md": "hi" });
    const files = await loadStableBootstrapFiles(dir, { extraStableFiles: [] });
    expect(files).toHaveLength(STABLE_BOOTSTRAP_FILENAMES.length);
  });
});

describe("loadStableBootstrapFiles with extra_stable_files: ['BRIEF.md']", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("loads BRIEF.md content when the file exists", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "agents",
      "BRIEF.md": "# Case Brief\nThis is the brief.",
    });
    const files = await loadStableBootstrapFiles(dir, { extraStableFiles: ["BRIEF.md"] });
    const brief = files.find((f) => f.name === "BRIEF.md");
    expect(brief).toBeDefined();
    expect(brief?.missing).toBe(false);
    expect(brief?.content).toBe("# Case Brief\nThis is the brief.");
  });

  it("appends BRIEF.md after the default files, not before", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "a",
      "BRIEF.md": "brief",
    });
    const files = await loadStableBootstrapFiles(dir, { extraStableFiles: ["BRIEF.md"] });
    const names = files.map((f) => f.name);
    const briefIdx = names.indexOf("BRIEF.md");
    // BRIEF.md should come after all default stable filenames
    for (const defaultName of STABLE_BOOTSTRAP_FILENAMES) {
      const defaultIdx = names.indexOf(defaultName);
      expect(briefIdx).toBeGreaterThan(defaultIdx);
    }
  });

  it("marks BRIEF.md as missing: true when file does not exist", async () => {
    dir = await makeWorkspace({ "AGENTS.md": "a" });
    const files = await loadStableBootstrapFiles(dir, { extraStableFiles: ["BRIEF.md"] });
    const brief = files.find((f) => f.name === "BRIEF.md");
    expect(brief).toBeDefined();
    expect(brief?.missing).toBe(true);
  });
});

describe("loadStableBootstrapFiles with extra_stable_files: ['NONEXISTENT.md']", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("does not throw when extra file is missing", async () => {
    dir = await makeWorkspace({ "AGENTS.md": "a" });
    await expect(
      loadStableBootstrapFiles(dir, { extraStableFiles: ["NONEXISTENT.md"] }),
    ).resolves.not.toThrow();
  });

  it("includes missing entry but gracefully skips in render", async () => {
    dir = await makeWorkspace({ "AGENTS.md": "agents content" });
    const result = await buildStableBootstrapPrompt({
      workspaceDir: dir,
      extraStableFiles: ["NONEXISTENT.md"],
    });
    // Should not error, NONEXISTENT.md should not appear in output
    expect(result.concatenated).not.toContain("NONEXISTENT.md");
    // agents content should still be present
    expect(result.concatenated).toContain("agents content");
  });
});

describe("loadStableBootstrapFiles with multiple extra_stable_files", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("loads both FOO.md and BAR.md in declared order", async () => {
    dir = await makeWorkspace({
      "FOO.md": "foo content",
      "BAR.md": "bar content",
    });
    const files = await loadStableBootstrapFiles(dir, {
      extraStableFiles: ["FOO.md", "BAR.md"],
    });
    const names = files.map((f) => f.name);
    const fooIdx = names.indexOf("FOO.md");
    const barIdx = names.indexOf("BAR.md");
    expect(fooIdx).toBeGreaterThan(-1);
    expect(barIdx).toBeGreaterThan(-1);
    // FOO before BAR (declared order preserved)
    expect(fooIdx).toBeLessThan(barIdx);
    // Both extra files come after all defaults
    for (const defaultName of STABLE_BOOTSTRAP_FILENAMES) {
      const defaultIdx = names.indexOf(defaultName);
      expect(fooIdx).toBeGreaterThan(defaultIdx);
      expect(barIdx).toBeGreaterThan(defaultIdx);
    }
  });

  it("includes content from both extra files in the stable render", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "base agents",
      "FOO.md": "foo body",
      "BAR.md": "bar body",
    });
    const result = await buildStableBootstrapPrompt({
      workspaceDir: dir,
      extraStableFiles: ["FOO.md", "BAR.md"],
    });
    expect(result.concatenated).toContain("foo body");
    expect(result.concatenated).toContain("bar body");
  });
});

// ---------------------------------------------------------------------------
// buildStableBootstrapPrompt — end-to-end with extra_stable_files
// ---------------------------------------------------------------------------

describe("buildStableBootstrapPrompt with extra_stable_files: ['BRIEF.md']", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("includes BRIEF.md content in the render output", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "agent rules",
      "BRIEF.md": "case brief text",
    });
    const result = await buildStableBootstrapPrompt({
      workspaceDir: dir,
      extraStableFiles: ["BRIEF.md"],
    });
    expect(result.concatenated).toContain("case brief text");
  });

  it("does NOT include BRIEF.md when extraStableFiles is omitted", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "agent rules",
      "BRIEF.md": "case brief text that should NOT appear",
    });
    const result = await buildStableBootstrapPrompt({ workspaceDir: dir });
    expect(result.concatenated).not.toContain("case brief text that should NOT appear");
  });

  it("injectedFiles count includes the extra file when present", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "agent rules",
      "BRIEF.md": "brief",
    });
    const withExtra = await buildStableBootstrapPrompt({
      workspaceDir: dir,
      extraStableFiles: ["BRIEF.md"],
    });
    const withoutExtra = await buildStableBootstrapPrompt({ workspaceDir: dir });
    expect(withExtra.injectedFiles.length).toBe(withoutExtra.injectedFiles.length + 1);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — extra_stable_files rejects non-string entries
// ---------------------------------------------------------------------------

describe("AgentSchema — extra_stable_files validation", () => {
  it("accepts a valid string array", async () => {
    const { AgentSchema } = await import("../src/config/schema.js");
    const result = AgentSchema.safeParse({
      topic_name: "Test Agent",
      extra_stable_files: ["BRIEF.md", "CONTEXT.md"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extra_stable_files).toEqual(["BRIEF.md", "CONTEXT.md"]);
    }
  });

  it("accepts omitted extra_stable_files (optional field)", async () => {
    const { AgentSchema } = await import("../src/config/schema.js");
    const result = AgentSchema.safeParse({ topic_name: "Test Agent" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extra_stable_files).toBeUndefined();
    }
  });

  it("accepts an empty array", async () => {
    const { AgentSchema } = await import("../src/config/schema.js");
    const result = AgentSchema.safeParse({
      topic_name: "Test Agent",
      extra_stable_files: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-string entries (e.g. [123])", async () => {
    const { AgentSchema } = await import("../src/config/schema.js");
    const result = AgentSchema.safeParse({
      topic_name: "Test Agent",
      extra_stable_files: [123],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "";
      // Zod reports "Expected string, received number" for z.string() violations
      expect(msg).toMatch(/string/i);
    }
  });

  it("rejects mixed array with non-string entries", async () => {
    const { AgentSchema } = await import("../src/config/schema.js");
    const result = AgentSchema.safeParse({
      topic_name: "Test Agent",
      extra_stable_files: ["BRIEF.md", null],
    });
    expect(result.success).toBe(false);
  });
});
