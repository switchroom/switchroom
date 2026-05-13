/**
 * Phase F (switchroom#1163) — `applyCronChangesHot` & `classifyChangeKind`.
 *
 * The helper itself is deliberately minimal: cron scripts on the host
 * bind-mount are already rewritten by `reconcileAgent`, so the in-
 * container scheduler sees them on the next fire without a docker
 * touch. These tests pin the contract — particularly that no docker /
 * systemctl side effects sneak in — so a future refactor can't quietly
 * resurrect the container bounce.
 */
import { describe, expect, it } from "vitest";
import { applyCronChangesHot, classifyChangeKind } from "./lifecycle.js";

describe("classifyChangeKind", () => {
  it("tags telegram/cron-<i>.sh as cron", () => {
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-0.sh")).toBe("cron");
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-42.sh")).toBe("cron");
  });

  it("does NOT tag other telegram/ files as cron", () => {
    expect(classifyChangeKind("/state/agents/foo/telegram/access.json")).not.toBe("cron");
    expect(classifyChangeKind("/state/agents/foo/telegram/.env")).not.toBe("cron");
  });

  it("tags settings.json and .mcp.json as settings", () => {
    expect(classifyChangeKind("/state/agents/foo/.claude/settings.json")).toBe("settings");
    expect(classifyChangeKind("/state/agents/foo/.mcp.json")).toBe("settings");
  });

  it("tags .claude/skills/ payload as skill", () => {
    expect(classifyChangeKind("/state/agents/foo/.claude/skills/humanizer/SKILL.md")).toBe("skill");
  });

  it("tags start.sh as infra", () => {
    expect(classifyChangeKind("/state/agents/foo/start.sh")).toBe("infra");
  });

  it("falls through to other for unknown paths", () => {
    expect(classifyChangeKind("/state/agents/foo/workspace/CLAUDE.md")).toBe("other");
  });
});

describe("applyCronChangesHot", () => {
  it("returns only the cron-tagged subset of changes", () => {
    const changes = [
      "/state/agents/foo/telegram/cron-0.sh",
      "/state/agents/foo/.claude/settings.json",
      "/state/agents/foo/telegram/cron-1.sh",
    ];
    const r = applyCronChangesHot("foo", changes);
    expect(r.cronScripts).toEqual([
      "/state/agents/foo/telegram/cron-0.sh",
      "/state/agents/foo/telegram/cron-1.sh",
    ]);
  });

  it("is a no-op for an empty changes list", () => {
    const r = applyCronChangesHot("foo", []);
    expect(r.cronScripts).toEqual([]);
    expect(r.ipcSignalled).toBe(false);
  });

  it("ipcSignalled is false by default (no host-side scheduler IPC today)", () => {
    const r = applyCronChangesHot("foo", ["/state/agents/foo/telegram/cron-0.sh"]);
    expect(r.ipcSignalled).toBe(false);
  });
});
