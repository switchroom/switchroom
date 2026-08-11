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

  it("tags the telegram/cron-<hash>.source attribution sidecar as cron (#4607)", () => {
    // The stale-artifact sweep in reconcileAgent unlinks `cron-<hash>.sh`
    // and its `.source` sidecar in the SAME pass, so a classifier that
    // anchors on `.sh` alone makes a cron-only reconcile reject its own
    // cron cleanup. Both basename forms the sweep can produce:
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-0123456789ab.source")).toBe("cron");
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-0123456789ab.sh")).toBe("cron");
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-7.source")).toBe("cron");
  });

  it("does NOT over-match near-miss cron basenames (#4607 widening stays tight)", () => {
    // The widened `\.(?:sh|source)$` alternation must not loosen the
    // `cron-<12hex>|cron-<digits>` stem: a non-hex / wrong-length stem is
    // not a cron artifact, and mis-tagging one would let a cron-only
    // reconcile write an arbitrary telegram/ file unchallenged.
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-nothex.source")).toBe("other");
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-nothex.sh")).toBe("other");
    // 12 hex chars is the Phase-D length; 11 and 13 are not.
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-0123456789a.source")).toBe("other");
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-0123456789abc.source")).toBe("other");
    // Right stem, wrong extension.
    expect(classifyChangeKind("/state/agents/foo/telegram/cron-0123456789ab.json")).toBe("other");
    // `.source` outside the cron- family.
    expect(classifyChangeKind("/state/agents/foo/telegram/access.source")).toBe("other");
  });

  it("tags settings.json and .mcp.json as settings", () => {
    expect(classifyChangeKind("/state/agents/foo/.claude/settings.json")).toBe("settings");
    expect(classifyChangeKind("/state/agents/foo/.mcp.json")).toBe("settings");
  });

  it("tags .claude-cron/ (Tier-1 cron-session infra) as cron, not settings", () => {
    // Regression: the cron-session trimmed MCP is rendered when a cron routes
    // to a cheap session. It must classify as cron so a cron-only reconcile
    // (agent self-authoring a frequent cron) accepts it — otherwise the
    // .mcp.json rule below would tag it "settings" and the add fails.
    expect(classifyChangeKind("/state/agents/foo/.claude-cron/.mcp.json")).toBe("cron");
    // The main agent's .mcp.json is still settings (not under .claude-cron).
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
