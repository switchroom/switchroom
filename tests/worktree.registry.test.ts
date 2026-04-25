/**
 * Unit tests for worktree registry (read/write/delete/list).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeRecord,
  readRecord,
  deleteRecord,
  listRecords,
  touchHeartbeat,
  countByRepo,
  recordExists,
} from "../src/worktree/registry.js";
import type { WorktreeRecord } from "../src/worktree/types.js";

function makeRecord(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "abc12345",
    repo: "/home/user/code/myrepo",
    repoName: "myrepo",
    branch: "task/feature-abc12345",
    path: "/home/user/.switchroom/worktree-checkouts/abc12345-feature",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("worktree registry", () => {
  let tmpDir: string;
  const origEnv = process.env.SWITCHROOM_WORKTREE_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-reg-test-"));
    process.env.SWITCHROOM_WORKTREE_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.SWITCHROOM_WORKTREE_DIR;
    else process.env.SWITCHROOM_WORKTREE_DIR = origEnv;
  });

  it("writes and reads back a record", () => {
    const rec = makeRecord();
    writeRecord(rec);
    const back = readRecord(rec.id);
    expect(back).not.toBeNull();
    expect(back?.id).toBe(rec.id);
    expect(back?.branch).toBe(rec.branch);
    expect(back?.repoName).toBe(rec.repoName);
  });

  it("returns null for a missing record", () => {
    expect(readRecord("nonexistent")).toBeNull();
  });

  it("recordExists returns correct boolean", () => {
    const rec = makeRecord({ id: "exist001" });
    expect(recordExists(rec.id)).toBe(false);
    writeRecord(rec);
    expect(recordExists(rec.id)).toBe(true);
  });

  it("deletes a record", () => {
    const rec = makeRecord({ id: "del001" });
    writeRecord(rec);
    expect(recordExists(rec.id)).toBe(true);
    deleteRecord(rec.id);
    expect(recordExists(rec.id)).toBe(false);
    expect(readRecord(rec.id)).toBeNull();
  });

  it("lists all records", () => {
    const r1 = makeRecord({ id: "list001" });
    const r2 = makeRecord({ id: "list002" });
    writeRecord(r1);
    writeRecord(r2);
    const all = listRecords();
    const ids = all.map(r => r.id);
    expect(ids).toContain("list001");
    expect(ids).toContain("list002");
  });

  it("lists empty when no records", () => {
    expect(listRecords()).toHaveLength(0);
  });

  it("touches heartbeat updates heartbeatAt", async () => {
    const pastIso = new Date(Date.now() - 30_000).toISOString();
    const rec = makeRecord({ id: "hb001", heartbeatAt: pastIso });
    writeRecord(rec);
    const before = new Date(readRecord("hb001")!.heartbeatAt).getTime();
    // Brief delay to ensure time difference
    await new Promise(r => setTimeout(r, 10));
    touchHeartbeat("hb001");
    const after = new Date(readRecord("hb001")!.heartbeatAt).getTime();
    expect(after).toBeGreaterThan(before);
  });

  it("touchHeartbeat is no-op for missing id", () => {
    expect(() => touchHeartbeat("missing999")).not.toThrow();
  });

  it("countByRepo counts correctly", () => {
    writeRecord(makeRecord({ id: "c1", repo: "/repo/a" }));
    writeRecord(makeRecord({ id: "c2", repo: "/repo/a" }));
    writeRecord(makeRecord({ id: "c3", repo: "/repo/b" }));
    expect(countByRepo("/repo/a")).toBe(2);
    expect(countByRepo("/repo/b")).toBe(1);
    expect(countByRepo("/repo/c")).toBe(0);
  });
});
