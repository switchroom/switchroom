import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent, renderFleetInvariants } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Memory prompt guidance — epic #1850 redesign moved this content from
 * `--append-system-prompt` into the fleet invariants file at
 * `~/.switchroom/fleet/switchroom-invariants.md`, loaded by Claude
 * Code native CLAUDE.md discovery via `--add-dir`. These tests now
 * verify the content is in the rendered invariants file (single source
 * of truth) rather than in scaffold-emitted start.sh.
 *
 * Regression guard: start.sh must NOT contain the memory guidance —
 * if it does, the session-level duplication the redesign removed
 * has been re-introduced.
 */
describe("Memory prompt guidance (post-#1850)", () => {
  let tmpDir: string;
  let telegramConfig: TelegramConfig;
  let switchroomConfig: SwitchroomConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scaffold-memory-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    telegramConfig = {
      bot_token: "test-token",
      forum_chat_id: "test-chat",
    };

    switchroomConfig = {
      agents: {},
      memory: {
        backend: "hindsight",
        config: { url: "http://localhost:18888/mcp/" },
      },
      telegram: telegramConfig,
    };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("renderFleetInvariants() includes the memory guidance block (lane 1)", () => {
    const out = renderFleetInvariants();
    expect(out).toContain("## Memory — proactive, conversational");
    expect(out).toContain("### Retain proactively");
    expect(out).toContain("### Correct proactively");
    expect(out).toContain("### Forget proactively");
    expect(out).toContain("### Inspect proactively");
    expect(out).toContain("mcp__hindsight__sync_retain");
    // The delete tool is `delete_document` (the real server tool). The prior
    // guidance + this assertion named `delete_memory`, which the hindsight
    // server REJECTS ("Unknown tool") — agents' forget/correct flows silently
    // failed. Guard the corrected name.
    expect(out).toContain("mcp__hindsight__delete_document");
    expect(out).not.toContain("mcp__hindsight__delete_memory");
    expect(out).toContain("mcp__hindsight__recall");
    expect(out).toContain("mcp__hindsight__reflect");
  });

  it("renderFleetInvariants() includes the shared repo-bank routing guidance (RFC P6)", () => {
    // P6: an agent must be TOLD to make an explicit retain into the shared
    // `switchroom-dev` bank for durable repo knowledge — auto-retain can only
    // ever reach the agent's own bank (derive_bank_id), so the guidance is the
    // only thing that produces a shared-bank write. Assert the outcome the
    // block exists to produce: the bank id, the explicit retain, the tag
    // convention, and the worked example.
    const out = renderFleetInvariants();
    expect(out).toContain("### Route repo knowledge to the shared repo bank");
    // The write path is the explicit, bank-named retain — not sync/auto.
    expect(out).toContain('bank_id="switchroom-dev"');
    expect(out).toContain("mcp__hindsight__retain");
    // The findability convention: repo:<name> tag on every shared write.
    expect(out).toContain('tags=["repo:switchroom"');
    // The asymmetry must be stated, not just implied: auto-retain stays on the
    // agent's own bank and this is the deliberate exception.
    expect(out).toMatch(/auto-retain (always writes your OWN bank|can't reach a shared bank)/i);
    // It lives inside the memory guidance section, after Inspect.
    const inspectIdx = out.indexOf("### Inspect proactively");
    const repoIdx = out.indexOf("### Route repo knowledge to the shared repo bank");
    expect(inspectIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeGreaterThan(inspectIdx);
  });

  it("renderFleetInvariants() includes the file-delivery guidance (no local-path dumps)", () => {
    const out = renderFleetInvariants();
    const deliveryIdx = out.indexOf("## Delivering a file to the user");
    expect(deliveryIdx).toBeGreaterThan(-1);
    // It must name the real delivery channels and forbid local-path dumps.
    expect(out).toContain('files: ["/abs/path"]'); // reply attachment path
    expect(out).toMatch(/Switchroom\/<your-agent-name>/); // the drive folder convention
    expect(out).toMatch(/not on your box|cannot open it/i); // the "don't hand back a path" rule
    // Placed in the sandbox→delivery flow: after the sandbox block, before memory.
    const sandboxIdx = out.indexOf("## Sandbox: you're running in a switchroom container");
    const memoryIdx = out.indexOf("## Memory — proactive, conversational");
    expect(sandboxIdx).toBeGreaterThan(-1);
    expect(deliveryIdx).toBeGreaterThan(sandboxIdx);
    expect(memoryIdx).toBeGreaterThan(deliveryIdx);
  });

  it("renderFleetInvariants() orders Telegram pacing BEFORE memory guidance", () => {
    // The fleet invariants file orders sections so the model reads
    // them in the same sequence as the prior --append-system-prompt
    // assembly. Telegram pacing first (it governs every turn),
    // memory second (it governs cross-turn retention).
    const out = renderFleetInvariants();
    const pacingIdx = out.indexOf("## Talking to a human on Telegram");
    const memoryIdx = out.indexOf("## Memory — proactive, conversational");
    expect(pacingIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(pacingIdx);
  });

  it("renderFleetInvariants() includes all four memory sub-sections in correct order", () => {
    const out = renderFleetInvariants();
    const retainIdx = out.indexOf("### Retain proactively");
    const correctIdx = out.indexOf("### Correct proactively");
    const forgetIdx = out.indexOf("### Forget proactively");
    const inspectIdx = out.indexOf("### Inspect proactively");

    expect(retainIdx).toBeGreaterThan(-1);
    expect(correctIdx).toBeGreaterThan(retainIdx);
    expect(forgetIdx).toBeGreaterThan(correctIdx);
    expect(inspectIdx).toBeGreaterThan(forgetIdx);
  });

  it("scaffoldAgent does NOT include memory guidance in start.sh (regression guard for session-level duplication)", () => {
    const agentConfig: AgentConfig = {
      channels: {
        telegram: {
          plugin: "switchroom",
        },
      },
      memory: {
        collection: "test-agent",
      },
    };

    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    const startShPath = join(tmpDir, "test-agent", "start.sh");
    const startSh = readFileSync(startShPath, "utf-8");

    // Memory content now lives in ~/.switchroom/fleet/switchroom-invariants.md
    // (loaded via --add-dir). It must NOT also appear in start.sh's
    // APPEND_PROMPT — that was the pre-#1850 duplication.
    expect(startSh).not.toContain("## Memory — proactive, conversational");
    expect(startSh).not.toContain("### Retain proactively");
    // But the fleet --add-dir IS present:
    expect(startSh).toContain("SR_FLEET_DIR");
    expect(startSh).toContain(".switchroom/fleet");
  });

  it("reconcileAgent emits identical start.sh as scaffoldAgent (parity, post-#1850)", () => {
    const agentConfig: AgentConfig = {
      channels: {
        telegram: {
          plugin: "switchroom",
        },
      },
      memory: {
        collection: "test-agent",
      },
    };

    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    const scaffoldStartSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");

    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    const reconcileStartSh = readFileSync(join(tmpDir, "test-agent", "start.sh"), "utf-8");

    // After #1850 the APPEND_PROMPT is just the operator's per-agent
    // `system_prompt_append` (empty by default), so scaffoldAgent and
    // reconcileAgent should produce identical start.sh for the same
    // input. Confirms the init-vs-reconcile drift fix held.
    expect(reconcileStartSh).toBe(scaffoldStartSh);
  });

  it("the seeded workspace AGENTS.md/CLAUDE.md has NO file-memory contradiction (hindsight-only)", () => {
    // Regression: the workspace operating protocol told agents to maintain
    // MEMORY.md + memory/ daily files, directly contradicting the cwd CLAUDE.md
    // + fleet invariants ("hindsight is your single backend"). Agents got
    // opposite memory instructions every turn. The workspace doc now defers to
    // hindsight and the cwd CLAUDE.md.
    const agentConfig: AgentConfig = {
      channels: { telegram: { plugin: "switchroom" } },
      memory: { collection: "test-agent" },
    };
    scaffoldAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);
    const ws = join(tmpDir, "test-agent", "workspace", "CLAUDE.md");
    expect(existsSync(ws)).toBe(true);
    const doc = readFileSync(ws, "utf-8");
    // The contradictory file-memory prose must be gone.
    expect(doc).not.toMatch(/MEMORY\.md is your long-term memory/);
    expect(doc).not.toMatch(/memory\/YYYY-MM-DD/);
    expect(doc).not.toMatch(/## Memory discipline/);
    expect(doc).not.toMatch(/memory_search.+memory_get/);
    // And it must point at hindsight instead.
    expect(doc).toMatch(/Hindsight/);
    expect(doc).toMatch(/mcp__hindsight__recall/);
  });
});
