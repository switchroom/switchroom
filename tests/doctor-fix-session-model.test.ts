/**
 * `switchroom doctor --fix` — rev5 /model carrier auto-remediation
 * (#3427 item 1, follow-up to #3424's detection-only tripwire).
 *
 * Outcome tests, not code-path tests: the integration suite scaffolds a REAL
 * agent tree, mangles start.sh to the live pre-rev5 legacy shape (the drift
 * #3424 detected in the field), runs the fix with the REAL `reconcileAgent`,
 * and asserts the healed start.sh actually passes the #3424 carrier check —
 * plus idempotency (a second run performs NO reconcile and rewrites nothing).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import { checkStartShSessionModelCarrier } from "../src/cli/doctor.js";
import {
  fixSessionModelCarrierDrift,
  type SessionModelCarrierFixDeps,
} from "../src/cli/doctor-fix-session-model.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function makeConfig(name: string, agentsDir: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: agentsDir,
      skills_dir: join(agentsDir, "..", "skills"),
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  } as SwitchroomConfig;
}

/** The live pre-rev5 legacy start.sh shape #3424's doctor check FAILs on. */
const LEGACY_START_SH = [
  "#!/usr/bin/env bash",
  "# --- Session-only model override (carrier: .session-model-override) ---",
  'if [ -f "/state/agent/.session-model-override" ]; then',
  '  _override="$(cat "/state/agent/.session-model-override")"',
  '  rm -f "/state/agent/.session-model-override"',
  '  _EFFECTIVE_MODEL="$_override"',
  "fi",
  'exec claude --model "$_EFFECTIVE_MODEL"',
].join("\n");

describe("fixSessionModelCarrierDrift — integration (real scaffold + real reconcile)", () => {
  let agentsDir: string;
  const name = "fixme";
  let config: SwitchroomConfig;
  let reconcileCalls: string[];
  let deps: SessionModelCarrierFixDeps;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "switchroom-doctor-fix-"));
    const agentConfig = makeAgentConfig();
    config = makeConfig(name, agentsDir, agentConfig);
    scaffoldAgent(name, agentConfig, agentsDir, telegramConfig, config);
    reconcileCalls = [];
    deps = {
      check: checkStartShSessionModelCarrier,
      reconcile: (agent) => {
        reconcileCalls.push(agent);
        reconcileAgent(agent, config.agents![agent]!, agentsDir, telegramConfig, config, undefined, {
          preserveClaudeMd: true,
        });
      },
    };
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
  });

  it("drift → heal → the regenerated start.sh PASSES the #3424 carrier check", () => {
    const startShPath = join(agentsDir, name, "start.sh");
    // Mangle to the live pre-rev5 legacy shape and prove it's detected as drift.
    writeFileSync(startShPath, LEGACY_START_SH);
    expect(checkStartShSessionModelCarrier(name, startShPath).status).toBe("fail");

    const results = fixSessionModelCarrierDrift(config, deps);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].detail).toContain("healed");
    expect(results[0].detail).toContain("next restart");
    expect(reconcileCalls).toEqual([name]);

    // The heal claim is grounded: the file on disk now passes the tripwire
    // and carries the real rev5 apply path (not just any content change).
    expect(checkStartShSessionModelCarrier(name, startShPath).status).toBe("ok");
    const healed = readFileSync(startShPath, "utf-8");
    expect(healed).toContain(".session-model");
    expect(healed).toContain("configuredDefaultAtWrite");
  });

  it("is idempotent: a healthy fleet is never reconciled and start.sh is not rewritten", () => {
    const startShPath = join(agentsDir, name, "start.sh");
    writeFileSync(startShPath, LEGACY_START_SH);
    fixSessionModelCarrierDrift(config, deps); // heal
    const healedContent = readFileSync(startShPath, "utf-8");
    const healedMtime = statSync(startShPath).mtimeMs;
    reconcileCalls.length = 0;

    const second = fixSessionModelCarrierDrift(config, deps);
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe("ok");
    expect(second[0].detail).toContain("nothing to fix");
    expect(reconcileCalls).toEqual([]); // the gate, not just writeIfChanged
    expect(readFileSync(startShPath, "utf-8")).toBe(healedContent);
    expect(statSync(startShPath).mtimeMs).toBe(healedMtime);
  });

  it("heals a MISSING start.sh too (warn → regenerate → ok)", () => {
    const startShPath = join(agentsDir, name, "start.sh");
    rmSync(startShPath);
    expect(checkStartShSessionModelCarrier(name, startShPath).status).toBe("warn");

    const results = fixSessionModelCarrierDrift(config, deps);
    expect(results[0].status).toBe("ok");
    expect(results[0].detail).toContain("healed");
    expect(checkStartShSessionModelCarrier(name, startShPath).status).toBe("ok");
  });
});

describe("fixSessionModelCarrierDrift — failure honesty (stubbed seams)", () => {
  const config = makeConfig("stub", "/nonexistent-agents-dir", makeAgentConfig());

  it("reports a fail (not a heal) when reconcile throws", () => {
    const results = fixSessionModelCarrierDrift(config, {
      check: () => ({ name: "x", status: "fail", detail: "legacy-only carrier" }),
      reconcile: () => {
        throw new Error("profiles tree missing");
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("reconcile failed: profiles tree missing");
    expect(results[0].detail).toContain("legacy-only carrier");
  });

  it("reports a fail when the regenerated start.sh STILL fails the check (stale template)", () => {
    // A reconcile that "succeeds" but the re-run check still fails must NOT be
    // reported as healed — the claim is the post-write check, never the write.
    let calls = 0;
    const results = fixSessionModelCarrierDrift(config, {
      check: () => {
        calls += 1;
        return { name: "x", status: "fail", detail: "still legacy" };
      },
      reconcile: () => {},
    });
    expect(calls).toBe(2); // pre + post
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("still fails the carrier check");
  });

  it("passes through the host-unreadable skip untouched (cannot verify → must not write)", () => {
    let reconciled = false;
    const results = fixSessionModelCarrierDrift(config, {
      check: () => ({ name: "x", status: "skip", detail: "unreadable from host" }),
      reconcile: () => {
        reconciled = true;
      },
    });
    expect(results[0].status).toBe("skip");
    expect(reconciled).toBe(false);
  });
});
