/**
 * `registerMemoryCommand` wiring tests — the first harness that drives the
 * command through commander end to end (no test file referenced
 * `registerMemoryCommand` before this; see #4486).
 *
 * Two things pinned here, both follow-ups from the review of #4471
 * (`fix(hindsight): resolve vault: LLM api_key refs on the
 * recreate/rollout launch path`):
 *
 *   #4486 — `tests/setup-verification.test.ts` only pins the vault-ref
 *   resolution wiring on `stepMemoryBackend` (the first-run setup path).
 *   `switchroom memory setup --recreate` (src/cli/memory.ts, reached from
 *   `switchroom rollout` via hostd's refresh step — the actual path that
 *   caused the 2026-08-06 outage) was asserted only indirectly, through a
 *   unit test of the resolver helper. This file adds the direct wiring
 *   assertion.
 *
 *   #4487 — `memory docker-compose` resolves `vault:` refs to their live
 *   secret and prints the result to stdout. That is correct when the
 *   operator explicitly wants a runnable snippet, but by DEFAULT a live
 *   `sk-…` key must never land on an operator's scrollback. This pins the
 *   new `--resolve-secrets` opt-in: unresolved `vault:` refs (plus a note)
 *   by default, the live secret only behind the flag — for both the LLM
 *   `api_key` and `cp_access_key`, so the command has one rule, not two.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  startHindsight: vi.fn(),
  getViaBrokerStructured: vi.fn(),
}));

// `memory setup --recreate` and `memory docker-compose` both shell out to
// docker for container/port bookkeeping unrelated to the vault-ref wiring
// under test here. Stub the docker-touching surface only; keep every pure
// resolver (resolveHindsightLlmSecrets, resolveHindsightCpAccessKey,
// hindsightGpuDecision, generateHindsightComposeSnippet, ...) real, so the
// actual resolution + emit code is what gets exercised.
vi.mock("../src/setup/hindsight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/setup/hindsight.js")>();
  return {
    ...actual,
    startHindsight: mocks.startHindsight,
    isDockerAvailable: () => true,
    isHindsightRunning: () => false,
    isHindsightContainerExists: () => false,
    getRunningHindsightPorts: () => null,
    pickHindsightPorts: async () => ({ apiPort: 18888, uiPort: 19999 }),
    preflightHindsightPorts: async () => null,
    pullHindsightImage: () => {},
    stopHindsight: () => {},
    getHindsightDeviceRequests: () => null,
    // Deterministic regardless of what this box's real
    // ~/.switchroom/host-capabilities.json says — irrelevant to the vault
    // wiring under test, and reading it here would make the test's outcome
    // depend on the runner's host state.
    hindsightGpuDecision: () => ({
      enabled: false,
      source: "autodetect" as const,
      degraded: false,
      capabilities: { status: "absent" as const, path: "/dev/null", caps: null, detail: "" },
      reason: "stubbed for test",
    }),
    resolveHindsightGpuOverride: () => null,
  };
});

// `resolveHindsightLlmSecrets` / `resolveHindsightCpAccessKey` dynamic-import
// this module to reach the broker (see src/setup/hindsight.ts
// resolveHindsightVaultString) — mock it here so both the direct import in
// src/cli/memory.ts and that dynamic import see the same stub.
vi.mock("../src/vault/broker/client.js", () => ({
  getViaBrokerStructured: mocks.getViaBrokerStructured,
  readVaultTokenFile: () => null,
}));

vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
}));

import { Command } from "commander";
import { registerMemoryCommand } from "../src/cli/memory.js";

function buildProgram(configPath: string): Command {
  const program = new Command()
    .name("switchroom")
    .option("-c, --config <path>", "Path to switchroom.yaml");
  registerMemoryCommand(program);
  program.setOptionValue("config", configPath);
  return program;
}

const VAULT_REF = "vault:litellm/gpt-oss-key";
const REAL_KEY = "sk-" + "test-fake-resolved-key-000";

describe("registerMemoryCommand wiring (#4486, #4487)", () => {
  let tmpDir: string;
  let configPath: string;
  let logs: string[];
  let errs: string[];
  let priorExitCode: number | string | undefined;
  let savedAgentName: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sr-memory-secrets-"));
    configPath = join(tmpDir, "switchroom.yaml");
    writeFileSync(
      configPath,
      [
        "switchroom:",
        "  version: 1",
        `  agents_dir: ${join(tmpDir, "agents")}`,
        "telegram:",
        '  bot_token: "test:token"',
        '  forum_chat_id: "0"',
        "agents:",
        "  alpha:",
        "    topic_name: alpha",
        "hindsight:",
        "  llm:",
        "    provider: openai",
        `    api_key: "${VAULT_REF}"`,
        "",
      ].join("\n"),
    );
    logs = [];
    errs = [];
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errs.push(args.join(" "));
    });
    mocks.startHindsight.mockReset();
    mocks.getViaBrokerStructured.mockReset();
    mocks.getViaBrokerStructured.mockResolvedValue({
      kind: "ok",
      entry: { kind: "string", value: REAL_KEY },
    });
    // Keep the broker call token-free, matching the sibling stepMemoryBackend
    // wiring test in tests/setup-verification.test.ts.
    savedAgentName = process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_AGENT_NAME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = priorExitCode;
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedAgentName === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
    else process.env.SWITCHROOM_AGENT_NAME = savedAgentName;
  });

  // ─── #4486: memory setup --recreate ────────────────────────────────────

  it("resolves a `vault:` LLM api_key BEFORE it reaches startHindsight on `memory setup --recreate` (2026-08-06 wiring)", async () => {
    // The regression this pins: the recreate/rollout launch path
    // (src/cli/memory.ts:991, reached from src/cli/rollout.ts:1412 via
    // hostd's refresh step) is the one that actually shipped the fleet-wide
    // outage — stepMemoryBackend (first-run setup) is a DIFFERENT code
    // path and does not exercise this call site. Unwire the resolver here
    // (pass hindsightConfig.hindsight?.llm verbatim to startHindsight) and
    // this fails: the spy would see the `vault:` literal instead of the
    // resolved `sk-` key.
    await buildProgram(configPath).parseAsync(["memory", "setup", "--recreate"], {
      from: "user",
    });

    expect(mocks.startHindsight).toHaveBeenCalledTimes(1);
    // startHindsight(ports, litellm, tag, llm, mirrorDir, gpu, perf, cpKey):
    // the resolved LLM config is the 4th positional arg (src/setup/hindsight.ts).
    const llmArg = mocks.startHindsight.mock.calls[0][3] as { api_key?: string } | undefined;
    expect(llmArg?.api_key).toBe(REAL_KEY);
    expect(llmArg?.api_key).not.toContain("vault:");
    expect(mocks.getViaBrokerStructured).toHaveBeenCalledWith("litellm/gpt-oss-key", {});
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("warns when a `vault:` LLM api_key ref is DROPPED on `memory setup --recreate` (#4473, preserved through the #4487 reconcile)", async () => {
    // #4473 landed independently of #4486/#4487 and wired
    // diffDroppedHindsightLlmVaultKeys into this same action for a DIFFERENT
    // failure mode (a `vault:` ref that fails to resolve is silently dropped,
    // not a resolved secret reaching stdout). The #4487 rebase touched the
    // docker-compose action only — this pins that the --recreate warning
    // wiring survived the reconcile untouched.
    mocks.getViaBrokerStructured.mockResolvedValue({
      kind: "denied",
      code: "VAULT-BROKER-DENIED",
      msg: "no grant for this key",
    });

    await buildProgram(configPath).parseAsync(["memory", "setup", "--recreate"], {
      from: "user",
    });

    const out = logs.join("\n");
    expect(out).toMatch(/dropped|vault:litellm\/gpt-oss-key/i);
    const llmArg = mocks.startHindsight.mock.calls[0]?.[3] as { api_key?: string } | undefined;
    // The fail-safe: a ref that can't be resolved must not be baked in
    // literally either — it's dropped (undefined), not passed through raw.
    expect(llmArg?.api_key).toBeUndefined();
  });

  // ─── #4487: memory docker-compose --resolve-secrets ────────────────────

  it("`memory docker-compose` (no flag) emits the `vault:` ref UNRESOLVED, with a note, and never touches the broker", async () => {
    await buildProgram(configPath).parseAsync(["memory", "docker-compose"], {
      from: "user",
    });

    const out = logs.join("\n");
    // The guard: a live secret must NEVER reach stdout without explicit
    // opt-in. This is what closes #4487 — assert the OUTCOME (what actually
    // printed), not that some resolver function was or wasn't called.
    expect(out).not.toContain(REAL_KEY);
    expect(out).toContain(VAULT_REF);
    expect(out).toMatch(/unresolved|resolve them|--resolve-secrets/i);
    expect(mocks.getViaBrokerStructured).not.toHaveBeenCalled();
  });

  it("`memory docker-compose --resolve-secrets` emits the LIVE key (explicit opt-in)", async () => {
    await buildProgram(configPath).parseAsync(
      ["memory", "docker-compose", "--resolve-secrets"],
      { from: "user" },
    );

    const out = logs.join("\n");
    expect(out).toContain(REAL_KEY);
    expect(out).not.toContain(VAULT_REF);
    expect(mocks.getViaBrokerStructured).toHaveBeenCalledWith("litellm/gpt-oss-key", {});
  });

  it("`memory docker-compose` (no flag) omits the unresolved note when there is no `vault:` ref to resolve", async () => {
    writeFileSync(
      configPath,
      [
        "switchroom:",
        "  version: 1",
        `  agents_dir: ${join(tmpDir, "agents")}`,
        "telegram:",
        '  bot_token: "test:token"',
        '  forum_chat_id: "0"',
        "agents:",
        "  alpha:",
        "    topic_name: alpha",
        "",
      ].join("\n"),
    );

    await buildProgram(configPath).parseAsync(["memory", "docker-compose"], {
      from: "user",
    });

    const out = logs.join("\n");
    expect(out).not.toMatch(/unresolved/i);
    expect(mocks.getViaBrokerStructured).not.toHaveBeenCalled();
  });

  it("`cp_access_key` follows the SAME default-unresolved rule as the LLM api_key", async () => {
    writeFileSync(
      configPath,
      [
        "switchroom:",
        "  version: 1",
        `  agents_dir: ${join(tmpDir, "agents")}`,
        "telegram:",
        '  bot_token: "test:token"',
        '  forum_chat_id: "0"',
        "agents:",
        "  alpha:",
        "    topic_name: alpha",
        "hindsight:",
        '  cp_access_key: "vault:hindsight/cp-key"',
        "",
      ].join("\n"),
    );
    mocks.getViaBrokerStructured.mockResolvedValue({
      kind: "ok",
      entry: { kind: "string", value: "cp-test-fake-live-key" },
    });

    await buildProgram(configPath).parseAsync(["memory", "docker-compose"], {
      from: "user",
    });
    let out = logs.join("\n");
    expect(out).not.toContain("cp-test-fake-live-key");
    expect(out).toContain("vault:hindsight/cp-key");

    logs = [];
    await buildProgram(configPath).parseAsync(
      ["memory", "docker-compose", "--resolve-secrets"],
      { from: "user" },
    );
    out = logs.join("\n");
    expect(out).toContain("cp-test-fake-live-key");
  });
});
