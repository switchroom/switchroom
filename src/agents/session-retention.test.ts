/**
 * Tests for session-JSONL retention (src/agents/session-retention.ts, #2792).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  pruneSessionJsonl,
  DEFAULT_SESSION_RETENTION_MAX_COUNT,
} from "./session-retention.js";

let tmpDir: string;
let claudeConfigDir: string;
let projectsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-retention-"));
  claudeConfigDir = path.join(tmpDir, ".claude");
  projectsDir = path.join(claudeConfigDir, "projects", "proj-a");
  fs.mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Create a JSONL whose mtime is `ageDays` days in the past. */
function makeSession(name: string, ageDays: number): string {
  const p = path.join(projectsDir, name);
  fs.writeFileSync(p, '{"type":"user"}\n');
  const when = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  fs.utimesSync(p, new Date(when), new Date(when));
  return p;
}

describe("pruneSessionJsonl", () => {
  it("keeps the newest maxCount sessions and deletes the rest (age disabled)", () => {
    // 5 sessions aged 0..4 days.
    for (let i = 0; i < 5; i++) makeSession(`s${i}.jsonl`, i);
    const res = pruneSessionJsonl(claudeConfigDir, {
      maxCount: 3,
      maxAgeDays: 0, // disabled → count alone decides
    });
    expect(res.scanned).toBe(5);
    expect(res.deleted).toBe(2);
    const remaining = fs.readdirSync(projectsDir).sort();
    expect(remaining).toEqual(["s0.jsonl", "s1.jsonl", "s2.jsonl"]);
  });

  it("never deletes the keepPath even if it is old and over-count", () => {
    for (let i = 0; i < 5; i++) makeSession(`s${i}.jsonl`, i * 10);
    const keep = path.join(projectsDir, "s4.jsonl"); // oldest
    const res = pruneSessionJsonl(claudeConfigDir, {
      maxCount: 2,
      maxAgeDays: 5,
      keepPath: keep,
    });
    expect(fs.existsSync(keep)).toBe(true);
    expect(res.deleted).toBeGreaterThan(0);
  });

  it("only deletes files that are BOTH over-count AND over-age", () => {
    // 4 recent sessions (all 1 day old) + count bound of 2.
    for (let i = 0; i < 4; i++) makeSession(`s${i}.jsonl`, 1);
    const res = pruneSessionJsonl(claudeConfigDir, {
      maxCount: 2,
      maxAgeDays: 30, // all files are young → nothing is old enough
    });
    expect(res.deleted).toBe(0);
    expect(fs.readdirSync(projectsDir)).toHaveLength(4);
  });

  it("always retains at least MIN_KEEP newest even below maxCount", () => {
    makeSession("new.jsonl", 100);
    makeSession("old.jsonl", 200);
    const res = pruneSessionJsonl(claudeConfigDir, {
      maxCount: 1,
      maxAgeDays: 1, // both very old
    });
    // MIN_KEEP (2) protects both despite maxCount:1.
    expect(res.deleted).toBe(0);
  });

  it("is a no-op when both bounds are disabled", () => {
    for (let i = 0; i < 3; i++) makeSession(`s${i}.jsonl`, i * 100);
    const res = pruneSessionJsonl(claudeConfigDir, {
      maxCount: 0,
      maxAgeDays: 0,
    });
    expect(res.deleted).toBe(0);
    expect(res.scanned).toBe(0);
  });

  it("returns cleanly when the projects dir does not exist", () => {
    const res = pruneSessionJsonl(path.join(tmpDir, "nope"), {
      maxCount: DEFAULT_SESSION_RETENTION_MAX_COUNT,
    });
    expect(res).toEqual({ deleted: 0, scanned: 0 });
  });
});
