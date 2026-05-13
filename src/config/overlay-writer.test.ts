import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeOverlayEntry,
  deleteOverlayEntry,
  listOverlayEntries,
  overlayPathsFor,
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
