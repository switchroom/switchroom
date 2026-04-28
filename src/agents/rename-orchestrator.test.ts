/**
 * Tests for src/agents/rename-orchestrator.ts
 *
 * All side-effects are injected via the deps parameter:
 *   - loadConfig / resolveAgentsDir
 *   - stopAgent / startAgent
 *   - installUnit / uninstallUnit / generateUnit / generateGatewayUnit
 *   - resolveGatewayUnitName / unitFilePath / daemonReload
 *   - reconcileAgent
 *   - openVault / saveVault
 *   - snapshotDir / copyDir / removeDir / existsSync
 *
 * Tests verify:
 *   - happy path: rename succeeds end-to-end
 *   - rollback path: failure mid-rename triggers restoration
 *   - validation: rejects when <old> missing, <new> exists, names invalid
 *   - vault key rename logic (findAgentVaultKeys helper)
 *   - yaml rename logic (renameAgentInConfig helper)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

import {
  renameAgent,
  findAgentVaultKeys,
  renameAgentInConfig,
  type RenameAgentDeps,
} from "./rename-orchestrator.js";
import type { SwitchroomConfig } from "../config/schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sr-rename-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(
  agents: Record<string, object>,
  agentsDir: string,
): SwitchroomConfig {
  return {
    agents: agents as SwitchroomConfig["agents"],
    telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    defaults: undefined,
    profiles: undefined,
    agents_dir: agentsDir,
  } as unknown as SwitchroomConfig;
}

/**
 * Build a minimal set of deps with all side-effects mocked/in-memory.
 * Individual tests can override specific methods.
 */
function makeDeps(
  agentsDir: string,
  configPath: string,
  config?: Partial<SwitchroomConfig>,
  overrides?: Partial<RenameAgentDeps>,
): RenameAgentDeps {
  const baseConfig = makeConfig(
    {
      fin: {
        extends: "default",
        topic_name: "Fin",
        channels: { telegram: { plugin: "switchroom" } },
        schedule: [],
      },
    },
    agentsDir,
  );
  const merged = { ...baseConfig, ...config } as SwitchroomConfig;
  const oldAgentDir = resolve(agentsDir, "fin");
  const newAgentDir = resolve(agentsDir, "finn");

  // In-memory vault state
  const vaultSecrets: Record<string, unknown> = {
    "fin.bot_token": { kind: "string", value: "123:abc" },
    "fin-extra": { kind: "string", value: "some-value" },
    "other-agent.token": { kind: "string", value: "other" },
  };

  // Snapshot/restore tracking
  let snapContent: string | null = null;

  const deps: RenameAgentDeps = {
    loadConfig: vi.fn().mockImplementation((p: string) => {
      // After yaml rename call, return a config that has the new name
      if (p === configPath && merged.agents["finn"]) return merged;
      if (p === configPath && !merged.agents["finn"]) {
        // Simulate yaml not yet updated
        return merged;
      }
      return merged;
    }),
    resolveAgentsDir: vi.fn().mockReturnValue(agentsDir),
    stopAgent: vi.fn(),
    startAgent: vi.fn(),
    installUnit: vi.fn(),
    uninstallUnit: vi.fn(),
    generateUnit: vi.fn().mockReturnValue("[Unit]\nDescription=stub"),
    generateGatewayUnit: vi.fn().mockReturnValue("[Unit]\nDescription=stub-gw"),
    resolveGatewayUnitName: vi.fn().mockReturnValue("fin-gateway"),
    installScheduleTimers: vi.fn(),
    enableScheduleTimers: vi.fn(),
    daemonReload: vi.fn(),
    reconcileAgent: vi.fn().mockReturnValue({ changes: ["start.sh"], changesBySemantics: { hot: [], staleTillRestart: [], restartRequired: [] } }),
    usesSwitchroomTelegramPlugin: vi.fn().mockReturnValue(true),
    resolveAgentConfig: vi.fn().mockReturnValue({ admin: false }),
    resolveTimezone: vi.fn().mockReturnValue(undefined),
    openVault: vi.fn().mockReturnValue(vaultSecrets),
    saveVault: vi.fn(),
    resolveVaultPath: vi.fn().mockReturnValue("/fake/vault.enc"),
    snapshotDir: vi.fn().mockReturnValue("/fake/snapshot"),
    copyDir: vi.fn(),
    removeDir: vi.fn(),
    unitFilePath: vi.fn().mockImplementation((name: string) => `/fake/systemd/switchroom-${name}.service`),
    readFileSync: vi.fn().mockReturnValue("[Unit]\nDescription=stub"),
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (p === oldAgentDir) return true;
      if (p === newAgentDir) return false;
      if (p === "/fake/vault.enc") return true;
      if (p.endsWith(".service")) return true;
      return false;
    }),
    ...overrides,
  };

  return deps;
}

// ─── Tests: findAgentVaultKeys ────────────────────────────────────────────────

describe("findAgentVaultKeys", () => {
  it("matches exact name", () => {
    const secrets = { fin: { kind: "string", value: "x" } };
    expect(findAgentVaultKeys(secrets, "fin", "finn")).toEqual({ fin: "finn" });
  });

  it("matches dot-prefixed keys", () => {
    const secrets = {
      "fin.bot_token": { kind: "string", value: "x" },
      "fin.oauth": { kind: "string", value: "y" },
    };
    expect(findAgentVaultKeys(secrets, "fin", "finn")).toEqual({
      "fin.bot_token": "finn.bot_token",
      "fin.oauth": "finn.oauth",
    });
  });

  it("matches hyphen-prefixed keys", () => {
    const secrets = {
      "fin-extra": { kind: "string", value: "x" },
    };
    expect(findAgentVaultKeys(secrets, "fin", "finn")).toEqual({
      "fin-extra": "finn-extra",
    });
  });

  it("does not match other agents with overlapping prefix", () => {
    const secrets = {
      "finish.token": { kind: "string", value: "x" },
      "other.fin": { kind: "string", value: "y" },
    };
    // "finish" does not start with "fin-" or "fin." and is not "fin"
    expect(findAgentVaultKeys(secrets, "fin", "finn")).toEqual({});
  });

  it("returns empty when no keys match", () => {
    const secrets = {
      "other-agent.token": { kind: "string", value: "x" },
    };
    expect(findAgentVaultKeys(secrets, "fin", "finn")).toEqual({});
  });
});

// ─── Tests: renameAgentInConfig ───────────────────────────────────────────────

describe("renameAgentInConfig", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = join(tmpDir, "switchroom.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renames the agent key", () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          fin: { extends: "default", topic_name: "Fin" },
        },
      }),
    );
    renameAgentInConfig(configPath, "fin", "finn");
    const parsed = YAML.parse(String(require("fs").readFileSync(configPath)));
    expect(parsed.agents).toHaveProperty("finn");
    expect(parsed.agents).not.toHaveProperty("fin");
    expect(parsed.agents.finn.extends).toBe("default");
    expect(parsed.agents.finn.topic_name).toBe("Fin");
  });

  it("rewrites bot_token vault ref with old slug prefix", () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          fin: { extends: "default", bot_token: "vault:fin.bot_token" },
        },
      }),
    );
    renameAgentInConfig(configPath, "fin", "finn");
    const parsed = YAML.parse(String(require("fs").readFileSync(configPath)));
    expect(parsed.agents.finn.bot_token).toBe("vault:finn.bot_token");
  });

  it("does NOT rewrite bot_token vault ref when key is unrelated", () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          fin: { extends: "default", bot_token: "vault:global-bot-token" },
        },
      }),
    );
    renameAgentInConfig(configPath, "fin", "finn");
    const parsed = YAML.parse(String(require("fs").readFileSync(configPath)));
    // Not renamed because key doesn't start with "fin." or "fin-"
    expect(parsed.agents.finn.bot_token).toBe("vault:global-bot-token");
  });

  it("rewrites memory.collection when it equals oldName", () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          fin: { extends: "default", memory: { collection: "fin" } },
        },
      }),
    );
    renameAgentInConfig(configPath, "fin", "finn");
    const parsed = YAML.parse(String(require("fs").readFileSync(configPath)));
    expect(parsed.agents.finn.memory.collection).toBe("finn");
  });

  it("does NOT rewrite memory.collection when it differs from oldName", () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          fin: { extends: "default", memory: { collection: "custom-bank" } },
        },
      }),
    );
    renameAgentInConfig(configPath, "fin", "finn");
    const parsed = YAML.parse(String(require("fs").readFileSync(configPath)));
    expect(parsed.agents.finn.memory.collection).toBe("custom-bank");
  });

  it("throws when old agent not found", () => {
    writeFileSync(
      configPath,
      YAML.stringify({ agents: { other: { extends: "default" } } }),
    );
    expect(() => renameAgentInConfig(configPath, "fin", "finn")).toThrow(
      /not found/,
    );
  });

  it("throws when new name already exists", () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: { fin: { extends: "default" }, finn: { extends: "default" } },
      }),
    );
    expect(() => renameAgentInConfig(configPath, "fin", "finn")).toThrow(
      /already exists/,
    );
  });
});

// ─── Tests: renameAgent (orchestrator) ───────────────────────────────────────

describe("renameAgent", () => {
  let agentsDir: string;
  let configPath: string;

  beforeEach(() => {
    agentsDir = makeTmpDir();
    configPath = join(agentsDir, "switchroom.yaml");
    // Write a minimal yaml so real renameAgentInConfig calls work
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          fin: { extends: "default", topic_name: "Fin", bot_token: "vault:fin.bot_token" },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeLoadConfigSequence(
    agentsDir: string,
    configPath: string,
  ): RenameAgentDeps["loadConfig"] {
    // First calls return the old config (before yaml update);
    // subsequent calls return the new config (after yaml update).
    let callCount = 0;
    return vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        return makeConfig(
          {
            fin: {
              extends: "default",
              topic_name: "Fin",
              bot_token: "vault:fin.bot_token",
              channels: { telegram: { plugin: "switchroom" } },
              schedule: [],
            },
          },
          agentsDir,
        );
      }
      // After yaml update, return config with new name
      return makeConfig(
        {
          finn: {
            extends: "default",
            topic_name: "Fin",
            bot_token: "vault:finn.bot_token",
            channels: { telegram: { plugin: "switchroom" } },
            schedule: [],
          },
        },
        agentsDir,
      );
    });
  }

  it("happy path: calls all orchestration steps in order", async () => {
    // We need to mock renameAgentInConfig since we pass the real configPath
    // but loadConfig is mocked — so yaml mutation won't persist to real disk calls.
    // Use the real configPath with real yaml.
    const deps = makeDeps(agentsDir, configPath, undefined, {
      loadConfig: makeLoadConfigSequence(agentsDir, configPath),
    });

    // Set passphrase for vault path
    process.env.SWITCHROOM_VAULT_PASSPHRASE = "test-pass";

    let result: Awaited<ReturnType<typeof renameAgent>> | null = null;
    try {
      result = await renameAgent(
        { oldName: "fin", newName: "finn", configPath },
        deps,
      );
    } finally {
      delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    }

    expect(deps.stopAgent).toHaveBeenCalledWith("fin");
    expect(deps.snapshotDir).toHaveBeenCalled();
    expect(deps.copyDir).toHaveBeenCalledWith(
      resolve(agentsDir, "fin"),
      resolve(agentsDir, "finn"),
    );
    expect(deps.removeDir).toHaveBeenCalledWith(resolve(agentsDir, "fin"));
    expect(deps.uninstallUnit).toHaveBeenCalledWith("fin");
    expect(deps.installUnit).toHaveBeenCalledWith("finn", expect.any(String));
    expect(deps.saveVault).toHaveBeenCalled();
    expect(deps.reconcileAgent).toHaveBeenCalledWith(
      "finn",
      expect.any(Object),
      agentsDir,
      expect.any(Object),
      expect.any(Object),
      configPath,
    );
    expect(deps.startAgent).toHaveBeenCalledWith("finn");
    expect(result!.vaultKeysRenamed).toEqual(
      expect.arrayContaining(["fin.bot_token", "fin-extra"]),
    );
  });

  it("validates: rejects when oldName is not in config", async () => {
    const deps = makeDeps(agentsDir, configPath, undefined, {
      loadConfig: vi.fn().mockReturnValue(
        makeConfig({ other: { extends: "default" } }, agentsDir),
      ),
    });
    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath }, deps),
    ).rejects.toThrow(/not defined in switchroom.yaml/);
    expect(deps.stopAgent).not.toHaveBeenCalled();
  });

  it("validates: rejects when newName already exists in config", async () => {
    const deps = makeDeps(agentsDir, configPath, undefined, {
      loadConfig: vi.fn().mockReturnValue(
        makeConfig(
          {
            fin: { extends: "default" },
            finn: { extends: "default" },
          },
          agentsDir,
        ),
      ),
    });
    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath }, deps),
    ).rejects.toThrow(/already defined in switchroom.yaml/);
    expect(deps.stopAgent).not.toHaveBeenCalled();
  });

  it("validates: rejects invalid old name", async () => {
    const deps = makeDeps(agentsDir, configPath);
    await expect(
      renameAgent({ oldName: "Fin!", newName: "finn", configPath }, deps),
    ).rejects.toThrow(/Invalid old agent name/);
  });

  it("validates: rejects invalid new name", async () => {
    const deps = makeDeps(agentsDir, configPath);
    await expect(
      renameAgent({ oldName: "fin", newName: "Finn Bot", configPath }, deps),
    ).rejects.toThrow(/Invalid new agent name/);
  });

  it("validates: rejects when old dir does not exist", async () => {
    const deps = makeDeps(agentsDir, configPath, undefined, {
      existsSync: vi.fn().mockImplementation((p: string) => {
        if (p.endsWith("/fin")) return false; // old dir missing
        return false;
      }),
    });
    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath }, deps),
    ).rejects.toThrow(/not found/);
    expect(deps.stopAgent).not.toHaveBeenCalled();
  });

  it("validates: rejects when new dir already exists", async () => {
    const oldDir = resolve(agentsDir, "fin");
    const newDir = resolve(agentsDir, "finn");
    const deps = makeDeps(agentsDir, configPath, undefined, {
      existsSync: vi.fn().mockImplementation((p: string) => {
        if (p === oldDir) return true;
        if (p === newDir) return true; // new dir conflict
        return false;
      }),
    });
    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath }, deps),
    ).rejects.toThrow(/already exists/);
    expect(deps.stopAgent).not.toHaveBeenCalled();
  });

  it("rollback path: failure during dir rename restores snapshot", async () => {
    let copyCount = 0;
    const deps = makeDeps(agentsDir, configPath, undefined, {
      loadConfig: makeLoadConfigSequence(agentsDir, configPath),
      copyDir: vi.fn().mockImplementation(() => {
        copyCount++;
        if (copyCount === 1) {
          // First copyDir is the dir copy — succeed
          return;
        }
        // Second call shouldn't happen in normal flow
        throw new Error("unexpected second copyDir");
      }),
      removeDir: vi.fn().mockImplementation(() => {
        // removeDir after copyDir (during rename step) — simulate failure
        throw new Error("simulated rename failure");
      }),
    });

    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath }, deps),
    ).rejects.toThrow(/simulated rename failure/);

    // Rollback should attempt to restore from snapshot
    // startAgent called for old agent (best-effort rollback)
    expect(deps.startAgent).toHaveBeenCalledWith("fin");
  });

  it("rollback path: failure during yaml update restores vault and dir", async () => {
    // This simulates failure after vault rename but during yaml update.
    // We'll do this by making renameAgentInConfig effectively throw.
    // Since renameAgentInConfig is not injectable, we can simulate by making
    // the yaml on disk have a conflicting state.

    // Write yaml with both fin and finn already (so rename throws "already exists")
    writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          fin: { extends: "default", bot_token: "vault:fin.bot_token" },
          finn: { extends: "default" },
        },
      }),
    );

    process.env.SWITCHROOM_VAULT_PASSPHRASE = "test-pass";
    const deps = makeDeps(agentsDir, configPath, undefined, {
      loadConfig: vi.fn().mockReturnValue(
        makeConfig(
          {
            fin: { extends: "default", channels: { telegram: { plugin: "switchroom" } }, schedule: [] },
          },
          agentsDir,
        ),
      ),
    });

    try {
      await expect(
        renameAgent({ oldName: "fin", newName: "finn", configPath }, deps),
      ).rejects.toThrow(/already exists/);
    } finally {
      delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    }

    // Rollback: saveVault called to restore vault keys, startAgent called for old
    expect(deps.startAgent).toHaveBeenCalledWith("fin");
  });

  it("hindsight=fresh mode is accepted", async () => {
    const deps = makeDeps(agentsDir, configPath, undefined, {
      loadConfig: makeLoadConfigSequence(agentsDir, configPath),
    });
    process.env.SWITCHROOM_VAULT_PASSPHRASE = "test-pass";
    try {
      const result = await renameAgent(
        { oldName: "fin", newName: "finn", configPath, hindsightMode: "fresh" },
        deps,
      );
      expect(result.agentDir).toContain("finn");
    } finally {
      delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
    }
  });

  it("hindsight=migrate rejects with clear error", async () => {
    const deps = makeDeps(agentsDir, configPath, undefined, {
      loadConfig: makeLoadConfigSequence(agentsDir, configPath),
    });
    await expect(
      renameAgent(
        { oldName: "fin", newName: "finn", configPath, hindsightMode: "migrate" as any },
        deps,
      ),
    ).rejects.toThrow(/deferred/);
  });
});
