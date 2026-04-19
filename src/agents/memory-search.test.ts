import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getWorkspaceMemoryFile,
  searchWorkspaceMemory,
} from "./memory-search.js";

async function makeWs(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sr-memsearch-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

describe("searchWorkspaceMemory", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns empty result on empty query", async () => {
    dir = await makeWs({ "MEMORY.md": "hello world" });
    const res = await searchWorkspaceMemory({ workspaceDir: dir, query: "   " });
    expect(res.hits).toHaveLength(0);
    expect(res.indexedFiles).toBe(0);
  });

  it("returns empty result when no markdown files exist", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sr-memsearch-empty-"));
    try {
      const res = await searchWorkspaceMemory({ workspaceDir: dir, query: "anything" });
      expect(res.hits).toHaveLength(0);
      expect(res.indexedFiles).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ranks the most relevant file first", async () => {
    dir = await makeWs({
      "MEMORY.md": "# Memory\nKen uses Buildkite. His kids are Sidney and Mabel.",
      "memory/2026-04-19.md": "Today: nothing about Buildkite at all. Bought milk.",
      "memory/2026-04-18.md": "Meeting with Buildkite team. Buildkite strategy. Buildkite pricing.",
      "AGENTS.md": "# AGENTS\nMore rules here.",
    });
    const res = await searchWorkspaceMemory({
      workspaceDir: dir,
      query: "buildkite pricing",
    });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]?.path).toBe(path.join("memory", "2026-04-18.md"));
    expect(res.hits[0]?.snippet.toLowerCase()).toContain("buildkite");
  });

  it("returns snippet with line number of first matched term", async () => {
    dir = await makeWs({
      "MEMORY.md": "line 1\nline 2\nMatch TOKEN here\nline 4",
    });
    const res = await searchWorkspaceMemory({ workspaceDir: dir, query: "token" });
    expect(res.hits[0]?.line).toBe(3);
    expect(res.hits[0]?.snippet.toLowerCase()).toContain("token");
  });

  it("respects maxResults", async () => {
    dir = await makeWs({
      "a.md": "alpha keyword",
      "b.md": "bravo keyword",
      "c.md": "charlie keyword",
      "d.md": "delta keyword",
    });
    const res = await searchWorkspaceMemory({
      workspaceDir: dir,
      query: "keyword",
      maxResults: 2,
    });
    expect(res.hits).toHaveLength(2);
    expect(res.totalMatches).toBe(4);
    expect(res.indexedFiles).toBe(4);
  });

  it("ignores hidden directories and files", async () => {
    dir = await makeWs({
      "MEMORY.md": "public content with secret-key",
      ".hidden/leak.md": "secret-key leaked here",
      ".env.md": "secret-key env",
    });
    const res = await searchWorkspaceMemory({ workspaceDir: dir, query: "secret" });
    expect(res.hits.map((h) => h.path)).toEqual(["MEMORY.md"]);
  });

  it("walks nested subdirectories (within depth limit)", async () => {
    dir = await makeWs({
      "memory/notes/2026-01-01.md": "goal-oriented content here",
      "memory/2026-02-01.md": "also goal-oriented stuff",
    });
    const res = await searchWorkspaceMemory({ workspaceDir: dir, query: "goal" });
    expect(res.hits.length).toBe(2);
  });
});

describe("getWorkspaceMemoryFile", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads a workspace file by relative path", async () => {
    dir = await makeWs({ "MEMORY.md": "hello workspace" });
    const res = await getWorkspaceMemoryFile({
      workspaceDir: dir,
      relativePath: "MEMORY.md",
    });
    expect(res.content).toBe("hello workspace");
    expect(res.truncated).toBe(false);
  });

  it("reads nested files", async () => {
    dir = await makeWs({ "memory/2026-04-19.md": "today entry" });
    const res = await getWorkspaceMemoryFile({
      workspaceDir: dir,
      relativePath: "memory/2026-04-19.md",
    });
    expect(res.content).toBe("today entry");
  });

  it("refuses path traversal outside workspace dir", async () => {
    dir = await makeWs({ "MEMORY.md": "ok" });
    await expect(
      getWorkspaceMemoryFile({ workspaceDir: dir, relativePath: "../outside.md" }),
    ).rejects.toThrow(/path traversal/);
    await expect(
      getWorkspaceMemoryFile({
        workspaceDir: dir,
        relativePath: "../../../etc/passwd",
      }),
    ).rejects.toThrow(/path traversal/);
  });

  it("truncates when file exceeds maxBytes", async () => {
    dir = await makeWs({ "big.md": "x".repeat(1000) });
    const res = await getWorkspaceMemoryFile({
      workspaceDir: dir,
      relativePath: "big.md",
      maxBytes: 200,
    });
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBe(200);
    expect(res.bytes).toBe(1000);
  });
});
