import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDynamicBootstrapPrompt,
  buildStableBootstrapPrompt,
  decorateTurnWithWarning,
  isWorkspaceSetupCompleted,
  loadDynamicBootstrapFiles,
  loadStableBootstrapFiles,
  projectBootstrapFiles,
  resolveAgentWorkspaceDir,
} from "./workspace.js";

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "switchroom-workspace-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

describe("resolveAgentWorkspaceDir", () => {
  it("returns the `workspace` subdirectory of the agent dir", () => {
    expect(resolveAgentWorkspaceDir("/opt/sr/agent")).toBe("/opt/sr/agent/workspace");
  });
});

describe("isWorkspaceSetupCompleted", () => {
  it("returns false when AGENTS.md is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sr-empty-"));
    try {
      expect(await isWorkspaceSetupCompleted(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns true when AGENTS.md exists", async () => {
    const dir = await makeWorkspace({ "AGENTS.md": "hello" });
    try {
      expect(await isWorkspaceSetupCompleted(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadStableBootstrapFiles", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("loads files that exist and marks missing ones", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "A1",
      "SOUL.md": "S1",
      "USER.md": "U1",
      // IDENTITY.md, TOOLS.md, BOOTSTRAP.md missing
    });
    const files = await loadStableBootstrapFiles(dir);
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    expect(byName["AGENTS.md"]?.missing).toBe(false);
    expect(byName["AGENTS.md"]?.content).toBe("A1");
    expect(byName["SOUL.md"]?.missing).toBe(false);
    expect(byName["USER.md"]?.content).toBe("U1");
    expect(byName["IDENTITY.md"]?.missing).toBe(true);
    expect(byName["TOOLS.md"]?.missing).toBe(true);
    expect(byName["BOOTSTRAP.md"]?.missing).toBe(true);
  });
});

describe("loadDynamicBootstrapFiles", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("loads MEMORY.md and today+yesterday daily notes", async () => {
    // 2026-04-19 (UTC)
    const now = new Date(Date.UTC(2026, 3, 19, 12));
    dir = await makeWorkspace({
      "MEMORY.md": "long-term memory",
      "memory/2026-04-19.md": "today's log",
      "memory/2026-04-18.md": "yesterday's log",
    });
    const files = await loadDynamicBootstrapFiles(dir, { now });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath[path.join(dir, "MEMORY.md")]?.missing).toBe(false);
    expect(byPath[path.join(dir, "memory", "2026-04-19.md")]?.content).toBe("today's log");
    expect(byPath[path.join(dir, "memory", "2026-04-18.md")]?.content).toBe("yesterday's log");
  });

  it("can skip yesterday", async () => {
    const now = new Date(Date.UTC(2026, 3, 19));
    dir = await makeWorkspace({
      "memory/2026-04-19.md": "today",
      "memory/2026-04-18.md": "yesterday",
    });
    const files = await loadDynamicBootstrapFiles(dir, { now, includeYesterday: false });
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("2026-04-19.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("2026-04-18.md"))).toBe(false);
  });
});

describe("projectBootstrapFiles", () => {
  it("concatenates present files and skips missing ones", () => {
    const result = projectBootstrapFiles({
      files: [
        { name: "AGENTS.md", path: "/x/AGENTS.md", content: "agents content", missing: false },
        { name: "SOUL.md", path: "/x/SOUL.md", missing: true },
        { name: "USER.md", path: "/x/USER.md", content: "user content", missing: false },
      ],
      heading: "Project Context",
      budget: { bootstrapMaxChars: 1000, bootstrapTotalMaxChars: 10000 },
    });
    expect(result.concatenated).toContain("# Project Context");
    expect(result.concatenated).toContain("agents content");
    expect(result.concatenated).toContain("user content");
    expect(result.concatenated).not.toContain("SOUL.md");
    expect(result.injectedFiles).toHaveLength(2);
  });

  it("respects per-file cap and emits a truncation warning in once mode", () => {
    const result = projectBootstrapFiles({
      files: [
        {
          name: "AGENTS.md",
          path: "/x/AGENTS.md",
          content: "x".repeat(2000),
          missing: false,
        },
      ],
      heading: "Project Context",
      budget: { bootstrapMaxChars: 400, bootstrapTotalMaxChars: 10000 },
    });
    expect(result.analysis.hasTruncation).toBe(true);
    expect(result.warning.warningShown).toBe(true);
    expect(result.warning.lines.some((l) => l.includes("AGENTS.md"))).toBe(true);
  });

  it("respects total-size cap", () => {
    const result = projectBootstrapFiles({
      files: [
        { name: "AGENTS.md", path: "/x/AGENTS.md", content: "a".repeat(500), missing: false },
        { name: "SOUL.md", path: "/x/SOUL.md", content: "b".repeat(500), missing: false },
        { name: "USER.md", path: "/x/USER.md", content: "c".repeat(500), missing: false },
      ],
      heading: "Project Context",
      budget: { bootstrapMaxChars: 500, bootstrapTotalMaxChars: 900 },
    });
    expect(result.analysis.hasTruncation).toBe(true);
    // The injected files total must not exceed bootstrapTotalMaxChars.
    const totalInjected = result.injectedFiles.reduce((s, f) => s + f.content.length, 0);
    expect(totalInjected).toBeLessThanOrEqual(900);
  });

  it("returns empty output when all files are missing", () => {
    const result = projectBootstrapFiles({
      files: [{ name: "AGENTS.md", path: "/x/AGENTS.md", missing: true }],
      heading: "Project Context",
      budget: { bootstrapMaxChars: 1000, bootstrapTotalMaxChars: 10000 },
    });
    expect(result.concatenated).toBe("");
    expect(result.injectedFiles).toHaveLength(0);
    expect(result.analysis.hasTruncation).toBe(false);
    expect(result.warning.warningShown).toBe(false);
  });
});

describe("buildStableBootstrapPrompt (end-to-end)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("builds the concatenated stable block from disk", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "# AGENTS\nfollow rules",
      "SOUL.md": "# SOUL\nbe direct",
      "USER.md": "# USER\nname is Ken",
    });
    const result = await buildStableBootstrapPrompt({ workspaceDir: dir });
    expect(result.concatenated).toContain("# Project Context");
    expect(result.concatenated).toContain("follow rules");
    expect(result.concatenated).toContain("be direct");
    expect(result.concatenated).toContain("name is Ken");
    // injectedFiles should have 3 entries for the 3 present files
    expect(result.injectedFiles).toHaveLength(3);
  });

  it("surfaces truncation through round-trip when content exceeds cap", async () => {
    dir = await makeWorkspace({
      "AGENTS.md": "x".repeat(20000),
    });
    const result = await buildStableBootstrapPrompt({
      workspaceDir: dir,
      budget: { bootstrapMaxChars: 1000, bootstrapTotalMaxChars: 2000, warningMode: "once" },
    });
    expect(result.analysis.hasTruncation).toBe(true);
    expect(result.warning.warningShown).toBe(true);
  });
});

describe("buildDynamicBootstrapPrompt (end-to-end)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("includes MEMORY.md + today's daily when present", async () => {
    const now = new Date(Date.UTC(2026, 3, 19));
    dir = await makeWorkspace({
      "MEMORY.md": "lasting memory",
      "memory/2026-04-19.md": "today's notes",
    });
    const result = await buildDynamicBootstrapPrompt({ workspaceDir: dir, now });
    expect(result.concatenated).toContain("lasting memory");
    expect(result.concatenated).toContain("today's notes");
  });
});

describe("decorateTurnWithWarning", () => {
  it("appends the bootstrap warning when the warning is active", () => {
    const decorated = decorateTurnWithWarning("Tell me a joke.", {
      warningShown: true,
      lines: ["AGENTS.md: 20000 raw -> 1000 injected (~95% removed)"],
      warningSignaturesSeen: [],
      signature: "sig",
    });
    expect(decorated.startsWith("Tell me a joke.")).toBe(true);
    expect(decorated).toContain("[Bootstrap truncation warning]");
  });

  it("returns the turn unchanged when the warning is inactive", () => {
    const original = "Tell me a joke.";
    const decorated = decorateTurnWithWarning(original, {
      warningShown: false,
      lines: [],
      warningSignaturesSeen: [],
    });
    expect(decorated).toBe(original);
  });
});
