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
  writeComposeFile: ReturnType<typeof vi.fn>;
} {
  return {
    reconcileAgent: vi.fn(() => ({ agentDir: "/tmp/a", changes: [] })),
    restartAgent: vi.fn(),
    gracefulRestartAgent: vi.fn(),
    applyCronChangesHot: vi.fn(() => ({ cronScripts: [], ipcSignalled: false })),
    writeComposeFile: vi.fn(async () => ({
      composePath: "/tmp/compose.yml",
      imageTag: "v0.0.0",
      bytes: 0,
      changed: false,
      previousImageTag: null,
    })),
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
      { silent: true },
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
      { silent: true },
      deps,
    );

    expect(deps.applyCronChangesHot).toHaveBeenCalledWith("foo", changes);
    expect(deps.restartAgent).not.toHaveBeenCalled();
  });

  it("cron-only changes + force → recreate wins (no hot path, #2779)", async () => {
    const changes = ["/state/agents/foo/.claude-cron/.mcp.json"];
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({ agentDir: "/state/agents/foo", changes })) as never,
    });

    const res = await reconcileAndRestartAgent(
      "foo",
      mkConfig("foo"),
      "/state/agents",
      undefined,
      { silent: true, force: true },
      deps,
    );

    // force is an explicit demand to recreate on the target image — the
    // cron-only classification must NOT short-circuit it.
    expect(deps.applyCronChangesHot).not.toHaveBeenCalled();
    expect(deps.restartAgent).toHaveBeenCalledTimes(1);
    expect(res.restarted).toBe(true);
  });

  it("cron-only changes + releaseOverride (pin) → recreate wins (no hot path, #2779)", async () => {
    const changes = ["/state/agents/foo/.claude-cron/.mcp.json"];
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({ agentDir: "/state/agents/foo", changes })) as never,
    });

    const res = await reconcileAndRestartAgent(
      "foo",
      mkConfig("foo"),
      "/state/agents",
      undefined,
      { silent: true, releaseOverride: { pin: "v1.2.3" } },
      deps,
    );

    // A one-shot pin (hostd rollout image bump) must reach the container —
    // the cron-only hot path would leave it on the old image.
    expect(deps.applyCronChangesHot).not.toHaveBeenCalled();
    expect(deps.restartAgent).toHaveBeenCalledTimes(1);
    expect(res.restarted).toBe(true);
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

describe("reconcileAndRestartAgent — compose regen before recreate (pin self-heal)", () => {
  it("regenerates the compose BEFORE recreating (so a pin bump applies on a plain restart)", async () => {
    const order: string[] = [];
    const deps = mkDeps({
      writeComposeFile: vi.fn(async () => {
        order.push("compose");
        return { composePath: "/tmp/c.yml", imageTag: "v0.14.92", bytes: 10, changed: true, previousImageTag: "v0.14.91" };
      }) as never,
      restartAgent: vi.fn(() => { order.push("restart"); }) as never,
    });

    await reconcileAndRestartAgent("foo", mkConfig("foo"), "/state/agents", "/cfg/switchroom.yaml", { silent: true, force: true, composePath: "/tmp/c.yml" }, deps);

    expect(deps.writeComposeFile).toHaveBeenCalledTimes(1);
    const arg = (deps.writeComposeFile as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg).toMatchObject({ composePath: "/tmp/c.yml", switchroomConfigPath: "/cfg/switchroom.yaml" });
    // ordering: compose written, THEN container recreated
    expect(order).toEqual(["compose", "restart"]);
  });

  it("cron-only hot path does NOT regenerate the compose (no recreate)", async () => {
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => ({ agentDir: "/state/agents/foo", changes: ["/state/agents/foo/telegram/cron-0.sh"] })) as never,
    });
    await reconcileAndRestartAgent("foo", mkConfig("foo"), "/state/agents", undefined, { silent: true }, deps);
    expect(deps.writeComposeFile).not.toHaveBeenCalled();
    expect(deps.restartAgent).not.toHaveBeenCalled();
  });

  it("a compose-regen failure WARNS but never aborts the restart", async () => {
    const deps = mkDeps({
      writeComposeFile: vi.fn(async () => { throw new Error("EACCES: permission denied"); }) as never,
    });
    const res = await reconcileAndRestartAgent("foo", mkConfig("foo"), "/state/agents", undefined, { silent: true, force: true }, deps);
    // restart still fired — the bounce works against the existing compose
    expect(deps.restartAgent).toHaveBeenCalledTimes(1);
    expect(res.restarted).toBe(true);
  });

  it("graceful restart still regenerates the compose first", async () => {
    const deps = mkDeps({
      gracefulRestartAgent: vi.fn(async () => ({ restartedImmediately: true, waitingForTurn: false })) as never,
    });
    await reconcileAndRestartAgent("foo", mkConfig("foo"), "/state/agents", undefined, { silent: true, force: true, graceful: true }, deps);
    expect(deps.writeComposeFile).toHaveBeenCalledTimes(1);
    expect(deps.gracefulRestartAgent).toHaveBeenCalledTimes(1);
  });

  it("a reconcile THROW propagates and NEVER recreates the container", async () => {
    // The incident seam: the ownership sweep runs at the END of
    // reconcileAgent; if it throws (e.g. a real, non-ENOENT chown failure)
    // the throw must abort reconcileAndRestartAgent BEFORE compose regen and
    // recreate — "never restart on top of a broken reconcile". The existing
    // tests only cover reconcileAgent RETURNING; this pins the THROW path.
    const deps = mkDeps({
      reconcileAgent: vi.fn(() => {
        throw new Error("ownership sweep failed: could not restore agent ownership");
      }) as never,
    });

    await expect(
      reconcileAndRestartAgent(
        "foo",
        mkConfig("foo"),
        "/state/agents",
        undefined,
        { silent: true, force: true },
        deps,
      ),
    ).rejects.toThrow(/ownership sweep/);

    // The container was never touched: no compose regen, no restart.
    expect(deps.writeComposeFile).not.toHaveBeenCalled();
    expect(deps.restartAgent).not.toHaveBeenCalled();
    expect(deps.gracefulRestartAgent).not.toHaveBeenCalled();
  });
});
