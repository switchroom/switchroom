/**
 * `switchroom handoff <agent>` — where the per-row observation scope comes
 * from, and what an invalid one costs.
 *
 * Two review findings on the `memory.observation_scopes` feature are pinned
 * here, both at the CLI seam rather than at the summarizer, because the CLI is
 * where the config actually lives and where the exit code is actually set.
 *
 * **M3 — the config is the authority.** `handoff.ts` already loads
 * switchroom.yaml, so reading the scope from `process.env` was wrong: any
 * invocation outside the container's exported env (an operator on the host, a
 * `hostd agent_exec`, a debugging run) saw "unset" for an agent configured to
 * `shared` and POSTed the briefing at the engine default. One row written at
 * the wrong scope, invisible until the bank is inconsistent — precisely the
 * defect the per-row scope exists to prevent, relocated one level out. And it
 * must come through the CASCADE, so a fleet-wide
 * `defaults.memory.observation_scopes` is honoured too.
 *
 * **M2 — the failure has to be visible.** The mirror fails closed on a bad
 * value, but a skip that still exits 0 reaches nobody: the Stop hook is
 * registered `async` (claude discards the code), start.sh's own `switchroom
 * handoff` call sends stderr to /dev/null, and nothing reaches `switchroom
 * doctor`. The one live surface is `bin/run-hook.sh`, which wraps this command
 * in the Stop hook and records a red `hook:handoff` issue — severity error,
 * stderr tail attached — **on a non-zero exit**, auto-resolving it on the next
 * clean one. So `process.exitCode` is the assertion that matters.
 *
 * Everything is tmpdir-scoped; nothing touches ~/.switchroom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
}));

import { Command } from "commander";
import { registerHandoffCommand } from "../src/cli/handoff.js";
import { OBSERVATION_SCOPES_ENV } from "../src/memory/observation-scopes.js";

/** Bodies POSTed to the Hindsight mirror during one CLI run. */
type Run = { exitCode: number | string | undefined; bodies: Record<string, unknown>[]; stderr: string };

describe("switchroom handoff — memory.observation_scopes", () => {
  let tmpDir: string;
  let configPath: string;
  let agentsDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-handoff-scopes-"));
    configPath = join(tmpDir, "switchroom.yaml");
    agentsDir = join(tmpDir, "agents");
    for (const k of [OBSERVATION_SCOPES_ENV, "HINDSIGHT_API_URL", "HINDSIGHT_BANK_ID"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // A URL must be set or the mirror short-circuits before the scope is ever
    // consulted. It is never dialled: every fetch is the injected fake, and the
    // skip path returns before fetching at all.
    process.env.HINDSIGHT_API_URL = "http://127.0.0.1:9";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Write a config + a session JSONL for `probe`, then run the real command
   * in-process with `fetch` stubbed at the network boundary only.
   */
  async function runHandoff(opts: {
    agentScope?: string;
    defaultsScope?: string;
    envScope?: string;
  }): Promise<Run> {
    writeFileSync(
      configPath,
      YAML.stringify({
        switchroom: { version: 1, agents_dir: agentsDir },
        telegram: { bot_token: "123:ABC", forum_chat_id: "-100123" },
        ...(opts.defaultsScope
          ? { defaults: { memory: { observation_scopes: opts.defaultsScope } } }
          : {}),
        agents: {
          probe: {
            topic_name: "Probe",
            memory: {
              collection: "probe",
              ...(opts.agentScope ? { observation_scopes: opts.agentScope } : {}),
            },
          },
        },
      }),
      "utf-8",
    );

    // Claude Code's on-disk layout: <agentDir>/.claude/projects/<x>/*.jsonl
    const projectDir = join(agentsDir, "probe", ".claude", "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess.jsonl"),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello from the probe" }] },
      }) + "\n",
      "utf-8",
    );

    if (opts.envScope !== undefined) process.env[OBSERVATION_SCOPES_ENV] = opts.envScope;

    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    let stderr = "";
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      });

    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command()
        .name("switchroom")
        .option("-c, --config <path>", "Path to switchroom.yaml");
      registerHandoffCommand(program);
      program.setOptionValue("config", configPath);
      await program.parseAsync(["handoff", "probe"], { from: "user" });
      return { exitCode: process.exitCode, bodies, stderr };
    } finally {
      process.exitCode = before;
      globalThis.fetch = realFetch;
      errSpy.mockRestore();
    }
  }

  function mirroredItem(run: Run): Record<string, unknown> {
    expect(run.bodies.length).toBe(1);
    return (run.bodies[0] as { items: Record<string, unknown>[] }).items[0];
  }

  // ---- default-off, unchanged -------------------------------------------

  it("unset everywhere — the item carries no scope key at all", async () => {
    // The shipped default. ABSENT, not null: byte-for-byte the pre-feature
    // body, so the engine's own default stands and nothing about an
    // unconfigured fleet changes.
    const run = await runHandoff({});
    expect(Object.keys(mirroredItem(run)).sort()).toEqual([
      "content",
      "document_id",
      "tags",
    ]);
    expect(run.exitCode).toBeUndefined();
  });

  // ---- M3: the config, not the env --------------------------------------

  it("reads the scope from switchroom.yaml with NO env var set", async () => {
    // The regression: run from the host, `hostd agent_exec`, or any shell that
    // did not inherit start.sh's export, this used to POST at the engine
    // default while every other retain path used `shared`.
    const run = await runHandoff({ agentScope: "shared" });
    expect(mirroredItem(run).observation_scopes).toBe("shared");
  });

  it("honours a fleet-wide defaults.memory.observation_scopes", async () => {
    // Read off `config.agents[name]` directly and this is silently missed: the
    // key is an override-cascade field accepted at the defaults tier too.
    const run = await runHandoff({ defaultsScope: "shared" });
    expect(mirroredItem(run).observation_scopes).toBe("shared");
  });

  it("the per-agent value beats the defaults tier", async () => {
    const run = await runHandoff({ defaultsScope: "shared", agentScope: "combined" });
    expect(mirroredItem(run).observation_scopes).toBe("combined");
  });

  it("the config beats the env var when they disagree", async () => {
    const run = await runHandoff({ agentScope: "shared", envScope: "per_tag" });
    expect(mirroredItem(run).observation_scopes).toBe("shared");
  });

  it("with no configured value the env var still speaks", async () => {
    const run = await runHandoff({ envScope: "shared" });
    expect(mirroredItem(run).observation_scopes).toBe("shared");
  });

  // ---- M2: the failure is visible ---------------------------------------

  it("an invalid scope EXITS NON-ZERO so run-hook.sh files a red issue", async () => {
    // zod gates the yaml at `switchroom apply`, so this arrives via the raw
    // export — the path zod cannot see. Outcome, in order of what matters:
    //   1. nothing is POSTed (no row at a scope nobody chose),
    //   2. the exit code is non-zero — the ONLY thing `bin/run-hook.sh` keys
    //      on to record a `hook:handoff` issue and surface it on the Telegram
    //      issues card,
    //   3. stderr says what to fix, because run-hook.sh attaches its tail to
    //      the issue detail.
    const run = await runHandoff({ envScope: "shred" });
    expect(run.bodies).toEqual([]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("shred");
    expect(run.stderr).toContain("memory.observation_scopes");
  });

  it("the sidecars are still written when the mirror is skipped", async () => {
    // The skip must cost only the recallable copy. If it cost the sidecars,
    // the next session would boot with no briefing — a much worse trade than
    // the wrong-scope row it avoids.
    await runHandoff({ envScope: "shred" });
    expect(existsSync(join(agentsDir, "probe", ".handoff.md"))).toBe(true);
  });

  it("a VALID scope exits zero, so run-hook.sh auto-resolves the issue", async () => {
    // The other half of the visibility contract: a red card that never clears
    // once the operator fixes the value is as useless as no card at all.
    const run = await runHandoff({ agentScope: "shared" });
    expect(run.exitCode).toBeUndefined();
  });
});
