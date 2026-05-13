/**
 * Phase F (switchroom#1163) — cron-only reconciles must NOT bounce
 * the agent container. These tests pin the decision branch in
 * `reconcileAndRestartAgent` so a regression that re-introduces an
 * unconditional `restartAgent` call after a cron-tagged reconcile
 * fails loudly.
 */
import { describe, expect, it, vi } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";
import { reconcileAndRestartAgent } from "./agent.js";
import type { ReconcileAndRestartDeps } from "./agent.js";

function mkConfig(name: string): SwitchroomConfig {
  return {
    telegram: { bot_token: "x", forum_chat_id: "-100" },
    agents: {
      [name]: {
        // Minimal — reconcileAndRestartAgent only checks `name` exists.
        // The mocked reconcileAgent dep doesn't touch agentConfig.
      } as unknown,
    },
  } as unknown as SwitchroomConfig;
}

function mkDeps(overrides: Partial<ReconcileAndRestartDeps> = {}): ReconcileAndRestartDeps & {
  reconcileAgent: ReturnType<typeof vi.fn>;
  restartAgent: ReturnType<typeof vi.fn>;
  gracefulRestartAgent: ReturnType<typeof vi.fn>;
  applyCronChangesHot: ReturnType<typeof vi.fn>;
} {
  return {
    reconcileAgent: vi.fn(() => ({ agentDir: "/tmp/a", changes: [] })),
    restartAgent: vi.fn(),
    gracefulRestartAgent: vi.fn(),
    applyCronChangesHot: vi.fn(() => ({ cronScripts: [], ipcSignalled: false })),
    ...overrides,
  } as never;
}

describe("reconcileAndRestartAgent — Phase F cron-only hot reload", () => {
  it("cron-only changes → applyCronChangesHot called, restartAgent NOT called", async () => {
    const cronPath = "/state/agents/foo/telegram/cron-0.sh";
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({
        agentDir: "/state/agents/foo",
        changes: [cronPath],
      })) as never,
    });

    const res = await reconcileAndRestartAgent(
      "foo",
      mkConfig("foo"),
      "/state/agents",
      undefined,
      { silent: true, force: true },
      deps,
    );

    expect(deps.applyCronChangesHot).toHaveBeenCalledTimes(1);
    expect(deps.applyCronChangesHot).toHaveBeenCalledWith("foo", [cronPath]);
    expect(deps.restartAgent).not.toHaveBeenCalled();
    expect(deps.gracefulRestartAgent).not.toHaveBeenCalled();
    expect(res.restarted).toBe(false);
    expect(res.changes).toEqual([cronPath]);
  });

  it("multiple cron-only changes → hot path, no restart", async () => {
    const changes = [
      "/state/agents/foo/telegram/cron-0.sh",
      "/state/agents/foo/telegram/cron-1.sh",
      "/state/agents/foo/telegram/cron-2.sh",
    ];
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({ agentDir: "/state/agents/foo", changes })) as never,
    });

    await reconcileAndRestartAgent(
      "foo",
      mkConfig("foo"),
      "/state/agents",
      undefined,
      { silent: true, force: true },
      deps,
    );

    expect(deps.applyCronChangesHot).toHaveBeenCalledWith("foo", changes);
    expect(deps.restartAgent).not.toHaveBeenCalled();
  });

  it("non-cron change → restartAgent called, applyCronChangesHot NOT called", async () => {
    const settingsPath = "/state/agents/foo/.claude/settings.json";
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({
        agentDir: "/state/agents/foo",
        changes: [settingsPath],
      })) as never,
    });

    const res = await reconcileAndRestartAgent(
      "foo",
      mkConfig("foo"),
      "/state/agents",
      undefined,
      { silent: true, force: true },
      deps,
    );

    expect(deps.restartAgent).toHaveBeenCalledTimes(1);
    expect(deps.restartAgent).toHaveBeenCalledWith("foo");
    expect(deps.applyCronChangesHot).not.toHaveBeenCalled();
    expect(res.restarted).toBe(true);
  });

  it("mixed cron + non-cron → restartAgent called (most-restrictive wins)", async () => {
    const changes = [
      "/state/agents/foo/telegram/cron-0.sh",
      "/state/agents/foo/.claude/settings.json",
    ];
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({ agentDir: "/state/agents/foo", changes })) as never,
    });

    await reconcileAndRestartAgent(
      "foo",
      mkConfig("foo"),
      "/state/agents",
      undefined,
      { silent: true, force: true },
      deps,
    );

    expect(deps.restartAgent).toHaveBeenCalledTimes(1);
    expect(deps.applyCronChangesHot).not.toHaveBeenCalled();
  });

  it("empty changes → status-quo restart (Phase F leaves this branch alone)", async () => {
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({ agentDir: "/state/agents/foo", changes: [] })) as never,
    });

    await reconcileAndRestartAgent(
      "foo",
      mkConfig("foo"),
      "/state/agents",
      undefined,
      { silent: true, force: true },
      deps,
    );

    // Existing callers (token-rotation, /restart, mini-deploy contract)
    // depend on restart firing even when scaffold drift is zero.
    expect(deps.restartAgent).toHaveBeenCalledTimes(1);
    expect(deps.applyCronChangesHot).not.toHaveBeenCalled();
  });
});
