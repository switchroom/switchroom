import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeOverlayEntry,
  writeSkillsOverlayEntry,
  deleteOverlayEntry,
  listOverlayEntries,
  overlayPathsFor,
  overlayWriterRuntime,
} from "./overlay-writer.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovl-writer-"));
});

describe("overlay-writer", () => {
  it("writes a yaml file atomically into schedule.d/", () => {
    const path = writeOverlayEntry("alice", "cron-deadbeefcafe", "schedule:\n  - cron: '0 * * * *'\n    prompt: hi\n", { root });
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("schedule.d/cron-deadbeefcafe.yaml");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("prompt: hi");
  });

  it("does not leave staging artefacts behind on success", () => {
    writeOverlayEntry("alice", "cron-aaaaaaaaaaaa", "schedule: []\n", { root });
    const paths = overlayPathsFor("alice", { root });
    const stagingFiles = existsSync(paths.stagingDir)
      ? readdirSync(paths.stagingDir).filter((f) => f.endsWith(".yaml"))
      : [];
    expect(stagingFiles).toEqual([]);
  });

  it("deleteOverlayEntry removes a written file and returns true", () => {
    writeOverlayEntry("bob", "cron-ffffffffffff", "schedule: []\n", { root });
    const removed = deleteOverlayEntry("bob", "cron-ffffffffffff", { root });
    expect(removed).toBe(true);
    const remaining = listOverlayEntries("bob", { root });
    expect(remaining).toEqual([]);
  });

  it("deleteOverlayEntry on a missing slug returns false (idempotent)", () => {
    const removed = deleteOverlayEntry("bob", "cron-ffffffffffff", { root });
    expect(removed).toBe(false);
  });

  it("listOverlayEntries enumerates only top-level *.yaml", () => {
    writeOverlayEntry("alice", "cron-111111111111", "schedule: []\n", { root });
    writeOverlayEntry("alice", "cron-222222222222", "schedule: []\n", { root });
    const entries = listOverlayEntries("alice", { root });
    expect(entries.map((e) => e.slug).sort()).toEqual([
      "cron-111111111111",
      "cron-222222222222",
    ]);
  });

  it("separate agents do not see each other's overlays", () => {
    writeOverlayEntry("a", "cron-111111111111", "schedule: []\n", { root });
    writeOverlayEntry("b", "cron-222222222222", "schedule: []\n", { root });
    expect(listOverlayEntries("a", { root }).map((e) => e.slug)).toEqual(["cron-111111111111"]);
    expect(listOverlayEntries("b", { root }).map((e) => e.slug)).toEqual(["cron-222222222222"]);
  });

  it("rewriting the same slug overwrites cleanly", () => {
    writeOverlayEntry("a", "cron-333333333333", "schedule:\n  - cron: '0 * * * *'\n    prompt: v1\n", { root });
    writeOverlayEntry("a", "cron-333333333333", "schedule:\n  - cron: '0 * * * *'\n    prompt: v2\n", { root });
    const entries = listOverlayEntries("a", { root });
    expect(entries).toHaveLength(1);
    expect(entries[0].raw).toContain("prompt: v2");
  });
});

describe("overlay-writer — foreign-euid ownership alignment (clerk EACCES incident)", () => {
  // A root/foreign-euid writer creating the staged inode leaves it owned
  // by the WRITER, mode 0600 — the agent (dir owner) then EACCESes on its
  // own cron overlay and the loader drops the entries. The writer must
  // align the staged file to the target dir's owner before the rename.
  // Unit tests run unprivileged, so the chown syscall is behind the
  // injectable overlayWriterRuntime seam (same pattern as
  // agent-owned-tree's ownershipRuntime).

  const real = {
    geteuid: overlayWriterRuntime.geteuid,
    chown: overlayWriterRuntime.chown,
  };

  afterEach(() => {
    overlayWriterRuntime.geteuid = real.geteuid;
    overlayWriterRuntime.chown = real.chown;
  });

  it("chowns the staged file to the dir owner when the writer euid differs (root-writer case)", () => {
    // Pre-create the dirs so their REAL owner is the test uid; simulate a
    // root writer by stubbing euid=0 (≠ dir owner for an unprivileged run).
    const paths = overlayPathsFor("alice", { root });
    const dirStat = { uid: statSync(root).uid, gid: statSync(root).gid };
    const chowns: Array<{ path: string; uid: number; gid: number }> = [];
    overlayWriterRuntime.geteuid = () => (dirStat.uid === 0 ? 12345 : 0);
    overlayWriterRuntime.chown = (path, uid, gid) => chowns.push({ path, uid, gid });

    const finalPath = writeOverlayEntry("alice", "cron-444444444444", "schedule: []\n", { root });

    expect(chowns).toHaveLength(1);
    // Aligned to the target schedule.d dir's real owner, on the STAGED
    // path (before rename — the publish is atomic with correct ownership).
    expect(chowns[0]).toMatchObject({ uid: dirStat.uid, gid: dirStat.gid });
    expect(chowns[0].path).toContain(paths.scheduleStagingDir);
    expect(existsSync(finalPath)).toBe(true);
  });

  it("does not chown when the writer euid already matches the dir owner", () => {
    const chowns: string[] = [];
    overlayWriterRuntime.chown = (path) => { chowns.push(path); };
    // real geteuid == real dir owner (both the test uid)
    writeOverlayEntry("alice", "cron-555555555555", "schedule: []\n", { root });
    expect(chowns).toEqual([]);
  });

  it("a chown failure (EPERM: unprivileged foreign writer) never blocks the write", () => {
    overlayWriterRuntime.geteuid = () => (statSync(root).uid === 0 ? 12345 : 0);
    overlayWriterRuntime.chown = () => {
      const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    const finalPath = writeOverlayEntry("alice", "cron-666666666666", "schedule: []\n", { root });
    expect(existsSync(finalPath)).toBe(true);
  });

  it("aligns skills.d writes the same way", () => {
    const dirUid = statSync(root).uid;
    const chowns: Array<{ path: string }> = [];
    overlayWriterRuntime.geteuid = () => (dirUid === 0 ? 12345 : 0);
    overlayWriterRuntime.chown = (path) => chowns.push({ path });
    const finalPath = writeSkillsOverlayEntry("alice", "ws", "skills:\n  - webapp-testing\n", { root });
    expect(chowns).toHaveLength(1);
    expect(chowns[0].path).toContain(join("skills.d", ".staging"));
    expect(existsSync(finalPath)).toBe(true);
  });
});
