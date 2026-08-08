/**
 * Setup-wizard verification tests (install-path review H7).
 *
 * The bug these pin: the wizard's final step printed a green
 * `OK Verification steps ready` unconditionally and swallowed the
 * `agent start` failure in a bare `catch {}`, so `switchroom setup`
 * reported success with nothing running. A happy-path test would not
 * have caught that — every assertion here is about a FAILURE producing a
 * failure (thrown error / non-zero exit / no green claim).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// setup.ts statically imports vault-broker.js → broker/server.ts →
// grants-db.ts → bun:sqlite, which vitest cannot resolve. Same mocks as
// tests/setup.test.ts.
vi.mock("../src/vault/vault.js", () => ({
  openVault: vi.fn(),
  createVault: vi.fn(),
  setStringSecret: vi.fn(),
  getStringSecret: vi.fn(() => null),
}));
vi.mock("../src/vault/grants-db.ts", () => ({}));
vi.mock("../src/vault/broker/server.js", () => ({
  VaultBroker: vi.fn(),
  registerShutdownHandlers: vi.fn(),
}));

import {
  waitForAgentContainerUp,
  verifyFleetContainers,
  agentContainerHealth,
  dedupeFindings,
  hasFatal,
  AGENT_STABLE_SAMPLES,
  AGENT_STABLE_WINDOW_MS,
  AGENT_POLL_INTERVAL_MS,
  SetupVerificationError,
} from "../src/setup/verify.js";
import { stepVerification, reportSetupFailure } from "../src/cli/setup.js";
// `stepMemoryBackend` was extracted out of setup.ts into its own vault-free
// module so its own tests can run under vitest at all (the old placement
// pulled bun:sqlite transitively through the vault graph). setup.ts now only
// consumes it, so import it from where it actually lives.
import { stepMemoryBackend } from "../src/cli/setup-memory-backend.js";
import { classifyContainerStatus } from "../src/cli/doctor-docker.js";
import type { ContainerRow } from "../src/cli/doctor-docker.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

const noSleep = async (): Promise<void> => {};

/** Minimal config with one agent named `alpha`. */
function configWithAgent(name = "alpha"): SwitchroomConfig {
  return {
    agents: {
      [name]: { topic_name: `${name}-topic` },
    },
  } as unknown as SwitchroomConfig;
}

/** A `docker ps` stub that plays a scripted sequence, repeating the last. */
function scripted(frames: (ContainerRow[] | null)[]): () => ContainerRow[] | null {
  let i = 0;
  return () => {
    const frame = frames[Math.min(i, frames.length - 1)];
    i++;
    return frame;
  };
}

const up = (name: string): ContainerRow[] => [
  { name: `switchroom-${name}`, status: "Up 5 seconds" },
];

// ─── waitForAgentContainerUp ─────────────────────────────────────────────────

describe("waitForAgentContainerUp", () => {
  const opts = { timeoutMs: 5000, intervalMs: 1000, stableSamples: 3 };

  it("FAILS when the container died right after start", async () => {
    const f = await waitForAgentContainerUp(
      "alpha",
      { listContainers: scripted([[{ name: "switchroom-alpha", status: "Exited (1) 2 seconds ago" }]]), sleep: noSleep },
      opts,
    );
    expect(f.status).toBe("fail");
    expect(f.detail).toContain("switchroom-alpha");
    expect(f.detail).toMatch(/exited/i);
    expect(f.fix).toContain("docker logs switchroom-alpha");
  });

  it("FAILS on a crash-looping container even after one healthy-looking sample", async () => {
    const f = await waitForAgentContainerUp(
      "alpha",
      {
        listContainers: scripted([
          up("alpha"),
          up("alpha"),
          [{ name: "switchroom-alpha", status: "Restarting (1) 3 seconds ago" }],
        ]),
        sleep: noSleep,
      },
      opts,
    );
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/crash-looping/i);
  });

  it("FAILS when the container never appears within the timeout", async () => {
    const f = await waitForAgentContainerUp(
      "alpha",
      { listContainers: scripted([[]]), sleep: noSleep },
      opts,
    );
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/did not reach a stable running state/);
    expect(f.detail).toContain("no such container");
  });

  it("FAILS when docker itself is unreachable", async () => {
    const f = await waitForAgentContainerUp(
      "alpha",
      { listContainers: () => null, sleep: noSleep },
      opts,
    );
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/docker ps is unavailable/);
  });

  it("FAILS when the container is stuck in Created for the whole window", async () => {
    const f = await waitForAgentContainerUp(
      "alpha",
      { listContainers: scripted([[{ name: "switchroom-alpha", status: "Created" }]]), sleep: noSleep },
      opts,
    );
    expect(f.status).toBe("fail");
    expect(f.detail).toContain("created");
  });

  it("only says ok after watching for at least the stability WINDOW", async () => {
    // PROPERTY, not a call count (review M5): an `ok` verdict must mean the
    // container was observed up across a window of wall-clock time, so a
    // container that dies inside that window cannot pass.
    let elapsedMs = 0;
    const f = await waitForAgentContainerUp(
      "alpha",
      {
        listContainers: () => up("alpha"),
        sleep: async (ms: number) => {
          elapsedMs += ms;
        },
      },
      // defaults: real window/interval/samples
      {},
    );
    expect(f.status).toBe("ok");
    expect(elapsedMs).toBeGreaterThanOrEqual(AGENT_STABLE_WINDOW_MS);
  });

  it("the default sample count really spans the documented window", () => {
    // Guards the constants against drifting apart: N samples span
    // (N-1) intervals.
    expect((AGENT_STABLE_SAMPLES - 1) * AGENT_POLL_INTERVAL_MS)
      .toBeGreaterThanOrEqual(AGENT_STABLE_WINDOW_MS);
  });

  it("FAILS on an agent whose start.sh dies ~9s in (the real failure mode)", async () => {
    // The bug M5 pins: with a ~4s window this container passed. It must not.
    let virtualMs = 0;
    const f = await waitForAgentContainerUp(
      "alpha",
      {
        listContainers: () =>
          virtualMs < 9_000
            ? up("alpha")
            : [{ name: "switchroom-alpha", status: "Exited (1) 1 second ago" }],
        sleep: async (ms: number) => {
          virtualMs += ms;
        },
      },
      {},
    );
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/exited/i);
  });

  it("does not count `Up (unhealthy)` as up (review M6)", async () => {
    const f = await waitForAgentContainerUp(
      "alpha",
      {
        listContainers: () => [
          { name: "switchroom-alpha", status: "Up 2 minutes (unhealthy)" },
        ],
        sleep: noSleep,
      },
      opts,
    );
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/healthcheck is failing/);
  });

  it("gives useful guidance (not `docker logs`) when no container was made", async () => {
    // Review H3(b): `docker logs switchroom-alpha` errors "No such container"
    // in exactly this case.
    const f = await waitForAgentContainerUp(
      "alpha",
      { listContainers: () => [], sleep: noSleep },
      opts,
    );
    expect(f.status).toBe("fail");
    expect(f.fix).not.toContain("docker logs");
    expect(f.fix).toContain("switchroom apply");
  });

  it("reports the healthcheck when one exists", async () => {
    const f = await waitForAgentContainerUp(
      "alpha",
      {
        listContainers: () => [
          { name: "switchroom-alpha", status: "Up 2 minutes (healthy)" },
        ],
        sleep: noSleep,
      },
      { ...opts, stableSamples: 1 },
    );
    expect(f.status).toBe("ok");
    expect(f.detail).toContain("healthcheck: healthy");
  });
});

// ─── agentContainerHealth ────────────────────────────────────────────────────

describe("agentContainerHealth", () => {
  it("reports absent when no container matches", () => {
    expect(agentContainerHealth("alpha", [{ name: "switchroom-beta", status: "Up 1 hour" }]))
      .toBe("absent");
  });

  it("does not match on a name prefix collision", () => {
    expect(
      agentContainerHealth("alpha", [
        { name: "switchroom-alpha-sidecar", status: "Up 1 hour" },
      ]),
    ).toBe("absent");
  });
});

// ─── verifyFleetContainers ───────────────────────────────────────────────────

describe("verifyFleetContainers", () => {
  it("FAILS when docker is unreachable", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => null,
    });
    expect(hasFatal(findings)).toBe(true);
    expect(findings[0].detail).toMatch(/docker is not reachable/);
  });

  it("FAILS on doctor's stuck/crash-loop signature", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => [
        { name: "switchroom-alpha", status: "Created" },
        { name: "switchroom-vault-broker", status: "Restarting (1) 2 seconds ago" },
      ],
    });
    expect(hasFatal(findings)).toBe(true);
    expect(findings.map((f) => f.detail).join(" ")).toMatch(/stuck\/crash-looping/);
  });

  it("reports PENDING (never ok) when no agent container exists yet", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => [],
    });
    expect(hasFatal(findings)).toBe(false);
    const agentRow = findings.find((f) => f.name === "agent containers");
    expect(agentRow?.status).toBe("pending");
    expect(agentRow?.detail).toContain("0/1");
  });

  it("reports PENDING for a stopped (deliberately) agent, not a hard fail", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => [
        { name: "switchroom-alpha", status: "Exited (0) 3 hours ago" },
      ],
    });
    expect(hasFatal(findings)).toBe(false);
    expect(findings.find((f) => f.name === "agent containers")?.status).toBe("pending");
  });

  it("FAILS when the hindsight container setup just started is crash-looping", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => [
        ...up("alpha"),
        { name: "switchroom-hindsight", status: "Restarting (1) 4 seconds ago" },
      ],
    });
    expect(hasFatal(findings)).toBe(true);
    expect(findings.find((f) => f.name === "hindsight memory")?.detail).toMatch(
      /crash-looping/,
    );
  });

  it("does not invent a hindsight row when there is no hindsight container", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => up("alpha"),
    });
    expect(findings.find((f) => f.name === "hindsight memory")).toBeUndefined();
  });

  it("names an agent in an unexpected docker state instead of dropping it", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => [{ name: "switchroom-alpha", status: "Paused" }],
    });
    const row = findings.find((f) => f.name === "agent containers");
    expect(row?.status).toBe("pending");
    expect(row?.detail).toContain("not up: alpha");
  });

  it("reports ok when every configured agent is up", async () => {
    const findings = await verifyFleetContainers(configWithAgent(), {
      sleep: noSleep,
      listContainers: () => up("alpha"),
    });
    expect(findings.find((f) => f.name === "agent containers")?.status).toBe("ok");
    expect(hasFatal(findings)).toBe(false);
  });
});

// ─── stepVerification ────────────────────────────────────────────────────────

describe("stepVerification", () => {
  function capture(): { lines: string[]; log: (l: string) => void; text: () => string } {
    const lines: string[] = [];
    return {
      lines,
      log: (l: string) => lines.push(l),
      text: () => lines.join("\n"),
    };
  }

  it("THROWS with the real error when `agent start` fails (was a bare catch {})", async () => {
    const out = capture();
    await expect(
      stepVerification(configWithAgent(), false, {
        log: out.log,
        sleep: noSleep,
        confirmStart: async () => true,
        composeFileExists: () => true,
        startAgent: () => {
          throw new Error("spawn switchroom ENOENT");
        },
        listContainers: () => [],
      }),
    ).rejects.toBeInstanceOf(SetupVerificationError);
    expect(out.text()).toContain("spawn switchroom ENOENT");
    expect(out.text()).toContain("Verification FAILED");
    expect(out.text()).not.toContain("Verification steps ready");
  });

  it("THROWS when the agent was started but never came up", async () => {
    const out = capture();
    await expect(
      stepVerification(configWithAgent(), false, {
        log: out.log,
        sleep: noSleep,
        timeoutMs: 3000,
        intervalMs: 1000,
        confirmStart: async () => true,
        composeFileExists: () => true,
        startAgent: () => {},
        // start "succeeded" but the container is nowhere — the exact shape
        // of the bug: a green success over a dead agent.
        listContainers: () => [],
      }),
    ).rejects.toBeInstanceOf(SetupVerificationError);
    expect(out.text()).toMatch(/did not reach a stable running state/);
  });

  it("THROWS when the started agent crash-loops", async () => {
    const out = capture();
    await expect(
      stepVerification(configWithAgent(), false, {
        log: out.log,
        sleep: noSleep,
        confirmStart: async () => true,
        composeFileExists: () => true,
        startAgent: () => {},
        listContainers: () => [
          { name: "switchroom-alpha", status: "Restarting (1) 1 second ago" },
        ],
      }),
    ).rejects.toBeInstanceOf(SetupVerificationError);
  });

  it("THROWS when docker is unreachable, even with nothing started", async () => {
    const out = capture();
    await expect(
      stepVerification(configWithAgent(), true, {
        log: out.log,
        sleep: noSleep,
        listContainers: () => null,
      }),
    ).rejects.toBeInstanceOf(SetupVerificationError);
    expect(out.text()).toMatch(/docker is not reachable/);
  });

  it("returns PENDING (not a green claim) on a fresh install with no containers", async () => {
    const out = capture();
    const verdict = await stepVerification(configWithAgent(), true, {
      log: out.log,
      sleep: noSleep,
      listContainers: () => [],
    });
    expect(verdict).toBe("pending");
    expect(out.text()).not.toContain("Verified: the fleet is running");
    expect(out.text()).toContain("switchroom apply");
  });

  it("returns verified only when the started container stays up", async () => {
    const out = capture();
    const verdict = await stepVerification(configWithAgent(), false, {
      log: out.log,
      sleep: noSleep,
      stableSamples: 2,
      confirmStart: async () => true,
        composeFileExists: () => true,
      startAgent: () => {},
      listContainers: () => up("alpha"),
    });
    expect(verdict).toBe("verified");
    expect(out.text()).toContain("Verified: the fleet is running");
  });

  it("never starts anything (and never claims to) in non-interactive mode", async () => {
    const out = capture();
    const startAgent = vi.fn();
    await stepVerification(configWithAgent(), true, {
      log: out.log,
      sleep: noSleep,
      startAgent,
      listContainers: () => [],
    });
    expect(startAgent).not.toHaveBeenCalled();
  });
});

// ─── exit contract ───────────────────────────────────────────────────────────

describe("reportSetupFailure", () => {
  it("returns a NON-ZERO exit code for a verification failure", () => {
    const lines: string[] = [];
    const code = reportSetupFailure(
      new SetupVerificationError([
        { name: "alpha: container up", status: "fail", detail: "died" },
      ]),
      (l) => lines.push(l),
    );
    expect(code).not.toBe(0);
    expect(lines.join("\n")).toMatch(/Setup did NOT complete/);
  });

  it("returns a NON-ZERO exit code for any other setup error", () => {
    expect(reportSetupFailure(new Error("boom"), () => {})).not.toBe(0);
  });
});

// ─── stepMemoryBackend: Docker absent ────────────────────────────────────────

describe("stepMemoryBackend (Docker absent)", () => {
  let dir: string;
  let cfgPath: string;
  let logs: string[];
  let origLog: typeof console.log;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-setup-mem-"));
    cfgPath = join(dir, "switchroom.yaml");
    writeFileSync(
      cfgPath,
      ["telegram:", '  forum_chat_id: "0"', "agents:", "  alpha:", "    topic_name: alpha", ""].join("\n"),
    );
    for (const k of ["SWITCHROOM_MEMORY_BACKEND", "SWITCHROOM_VAULT_PASSPHRASE", "HINDSIGHT_API_LLM_API_KEY"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = origLog;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("THROWS instead of printing a green OK when Docker is missing", async () => {
    // Probe returns null for every docker invocation → docker absent.
    await expect(
      stepMemoryBackend(configWithAgent(), true, cfgPath, {
        dockerProbe: () => null,
      }),
    ).rejects.toThrow(/Memory backend setup failed/);

    const text = logs.join("\n");
    expect(text).not.toContain("Manual setup pending");
    // The old code printed a green OK on this exact path.
    expect(text).toMatch(/Docker is not installed/);
    expect(text).toMatch(/SWITCHROOM_MEMORY_BACKEND=none/);
  });

  it("still honours the documented opt-out without touching Docker", async () => {
    process.env.SWITCHROOM_MEMORY_BACKEND = "none";
    const probe = vi.fn(() => null);
    const outcome = await stepMemoryBackend(configWithAgent(), true, cfgPath, {
      dockerProbe: probe,
    });
    expect(outcome).toEqual({ hindsightExpected: false, optedOut: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it("says INSTALL Docker only when the CLI is genuinely missing (review L8)", async () => {
    await expect(
      stepMemoryBackend(configWithAgent(), true, cfgPath, { dockerProbe: () => null }),
    ).rejects.toThrow(/not installed/);
    expect(logs.join("\n")).toMatch(/no `docker` command on PATH/);
  });

  it("says START Docker when the CLI is present but the daemon is down (L8)", async () => {
    // The common macOS case: Docker Desktop ships the CLI, VM is stopped.
    // "Install Docker" here sends the operator down the wrong road.
    const probe = (args: string[]) =>
      args[0] === "--version" ? "Docker version 27.0.0\n" : null;
    await expect(
      stepMemoryBackend(configWithAgent(), true, cfgPath, { dockerProbe: probe }),
    ).rejects.toThrow(/daemon is not responding/);
    const text = logs.join("\n");
    expect(text).toMatch(/daemon is not responding/);
    expect(text).not.toMatch(/Docker is not installed/);
  });

  it("THROWS when the container is started but does not stay running (H2)", async () => {
    // The PR's remaining silent-success: this printed a yellow "may still be
    // initializing" and the wizard finished with "Setup complete! Your agents
    // are running." over a dead memory backend.
    const probe = (args: string[]) => {
      if (args[0] === "--version") return "Docker version 27.0.0\n";
      if (args[0] === "ps" && args[1] === "--quiet") return "";
      return ""; // `docker ps --filter name=switchroom-hindsight` → no rows
    };
    const startContainer = vi.fn();
    await expect(
      stepMemoryBackend(configWithAgent(), true, cfgPath, {
        dockerProbe: probe,
        startContainer: startContainer as never,
        sleep: async () => {},
        readyRetries: 2,
      }),
    ).rejects.toThrow(/did not stay running/);
    expect(startContainer).toHaveBeenCalled();
    expect(logs.join("\n")).not.toMatch(/may still be initializing/);
  });

  it("resolves a `vault:` LLM api_key BEFORE it reaches startContainer (2026-08-06 wiring)", async () => {
    // The regression guard: the bug was NOT that resolveHindsightLlmSecrets
    // couldn't resolve — it's that the launch caller never CALLED it, handing
    // the literal `vault:…` ref straight to the container. This asserts the
    // wiring outcome: the config reaching startContainer carries the RESOLVED
    // `sk-` key. Unwire the resolver (pass config.hindsight?.llm verbatim) and
    // this fails — the spy would see the `vault:` literal.
    const VAULT_REF = "vault:litellm/gpt-oss-key";
    const REAL_KEY = "sk-" + "resolved-oss-key-xyz789";
    const savedName = process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_AGENT_NAME; // keep the broker call token-free

    const config = {
      agents: { alpha: { topic_name: "alpha-topic" } },
      hindsight: { llm: { provider: "openai", api_key: VAULT_REF } },
    } as unknown as SwitchroomConfig;

    // Probe: docker present, hindsight NOT already running / existing, so the
    // step proceeds to launch (identical shape to the H2 probe above).
    const probe = (args: string[]) => {
      if (args[0] === "--version") return "Docker version 27.0.0\n";
      return "";
    };
    const startContainer = vi.fn();
    const getViaBrokerStructured = vi
      .fn()
      .mockResolvedValue({ kind: "ok", entry: { kind: "string", value: REAL_KEY } });

    try {
      // Rejects on the post-start "did not stay running" check — irrelevant
      // here: startContainer was already called with the resolved config.
      await expect(
        stepMemoryBackend(config, true, cfgPath, {
          dockerProbe: probe,
          startContainer: startContainer as never,
          getViaBrokerStructured: getViaBrokerStructured as never,
          sleep: async () => {},
          readyRetries: 1,
        }),
      ).rejects.toThrow(/did not stay running/);

      expect(startContainer).toHaveBeenCalledTimes(1);
      // startHindsight(ports, litellm, tag, llm, mirrorDir, gpu, perf, cpKey):
      // the resolved LLM config is the 4th positional arg.
      const llmArg = startContainer.mock.calls[0][3] as { api_key?: string } | undefined;
      expect(llmArg?.api_key).toBe(REAL_KEY);
      expect(llmArg?.api_key).not.toContain("vault:");
      // The broker WAS consulted, by the bare vault key.
      expect(getViaBrokerStructured).toHaveBeenCalledWith("litellm/gpt-oss-key", {});
    } finally {
      if (savedName === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
      else process.env.SWITCHROOM_AGENT_NAME = savedName;
    }
  });

  it("WARNS (naming the lane + ref, no secret) when a `vault:` LLM api_key drops", async () => {
    // Minor-1 outcome guard: when the broker cannot resolve the `vault:` ref,
    // the key is dropped and the lane silently inherits the provider default.
    // The launch path must SAY so — symmetric to the cp_access_key warning —
    // rather than launch quietly. This asserts the warning fires, names the
    // lane and the `vault:` reference, and never prints a resolved `sk-` value.
    const VAULT_REF = "vault:litellm/gpt-oss-key";
    const savedName = process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_AGENT_NAME;

    const config = {
      agents: { alpha: { topic_name: "alpha-topic" } },
      hindsight: { llm: { provider: "openai", api_key: VAULT_REF } },
    } as unknown as SwitchroomConfig;

    const probe = (args: string[]) => {
      if (args[0] === "--version") return "Docker version 27.0.0\n";
      return "";
    };
    const startContainer = vi.fn();
    // Broker denies the grant → the ref cannot resolve → the key is dropped.
    const getViaBrokerStructured = vi.fn().mockResolvedValue({ kind: "denied" });

    try {
      await expect(
        stepMemoryBackend(config, true, cfgPath, {
          dockerProbe: probe,
          startContainer: startContainer as never,
          getViaBrokerStructured: getViaBrokerStructured as never,
          sleep: async () => {},
          readyRetries: 1,
        }),
      ).rejects.toThrow(/did not stay running/);

      // The dropped key reached startContainer as undefined (fail-safe), and the
      // operator was warned about it.
      const llmArg = startContainer.mock.calls[0][3] as { api_key?: string } | undefined;
      expect(llmArg?.api_key).toBeUndefined();

      const text = logs.join("\n");
      expect(text).toMatch(/did not resolve through the/);
      expect(text).toMatch(/global LLM lane/);
      expect(text).toContain(VAULT_REF);
      // Secret hygiene: no resolved `sk-` value on any operator-facing line.
      expect(text).not.toContain("sk-");
    } finally {
      if (savedName === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
      else process.env.SWITCHROOM_AGENT_NAME = savedName;
    }
  });
});

// ─── review M4: a FAIL verdict is sampled, like the OK verdict ───────────────

describe("verifyFleetContainers stability (review M4)", () => {
  it("does NOT fail on a transient created/restarting frame during a bounce", async () => {
    // Every switchroom container is generated with `restart: always`, so a
    // fleet seconds into `docker restart` legitimately reads like this on
    // the first snapshot. One snapshot used to be an unconditional exit 1.
    const findings = await verifyFleetContainers(
      configWithAgent(),
      {
        listContainers: scripted([
          [{ name: "switchroom-alpha", status: "Restarting (0) 1 second ago" }],
          up("alpha"),
        ]),
        sleep: noSleep,
      },
      { confirmIntervalMs: 1 },
    );
    expect(hasFatal(findings)).toBe(false);
  });

  it("downgrades a flap to PENDING rather than printing green over it", async () => {
    // A crash-looping container reads "Up 1 second" between restarts, so a
    // later clean sample is NOT evidence of health — it is what a flap looks
    // like. Not a hard fail (M4), but never an unqualified ok either.
    const findings = await verifyFleetContainers(
      configWithAgent(),
      {
        listContainers: scripted([
          [{ name: "switchroom-alpha", status: "Restarting (0) 1 second ago" }],
          up("alpha"),
        ]),
        sleep: noSleep,
      },
      { confirmIntervalMs: 1 },
    );
    expect(hasFatal(findings)).toBe(false);
    expect(findings.some((f) => f.status === "ok")).toBe(false);
    expect(findings.find((f) => f.name === "agent containers")?.status).toBe(
      "pending",
    );
    expect(findings.find((f) => f.name === "runtime stability")?.status).toBe(
      "pending",
    );
  });

  it("reports a clean fleet as ok with no stability caveat", async () => {
    const findings = await verifyFleetContainers(
      configWithAgent(),
      { listContainers: () => up("alpha"), sleep: noSleep },
      { confirmIntervalMs: 1 },
    );
    expect(findings.find((f) => f.name === "agent containers")?.status).toBe("ok");
    expect(findings.some((f) => f.name === "runtime stability")).toBe(false);
  });

  it("still FAILS when the breakage persists across every sample", async () => {
    let samples = 0;
    const findings = await verifyFleetContainers(
      configWithAgent(),
      {
        listContainers: () => {
          samples++;
          return [{ name: "switchroom-alpha", status: "Restarting (1) 2 seconds ago" }];
        },
        sleep: noSleep,
      },
      { confirmIntervalMs: 1 },
    );
    expect(hasFatal(findings)).toBe(true);
    expect(samples).toBeGreaterThan(1); // confirmed, not a single read
  });
});

// ─── review H1: the documented Docker-less opt-out, END TO END ──────────────

describe("SWITCHROOM_MEMORY_BACKEND=none on a Docker-less host (review H1)", () => {
  it("step 13 does NOT exit 1 when memory was opted out and docker is absent", async () => {
    // The whole point of the escape hatch docs/install.md advertises. The
    // isolated stepMemoryBackend test missed this because step 13 called
    // verifyFleetContainers unconditionally.
    const out: string[] = [];
    const verdict = await stepVerification(
      configWithAgent(),
      true,
      { log: (l) => out.push(l), sleep: noSleep, listContainers: () => null },
      { memoryOptedOut: true, hindsightExpected: false },
    );
    expect(verdict).toBe("pending");
    expect(out.join("\n")).toMatch(/docker is not reachable/);
    expect(out.join("\n")).not.toMatch(/Verification FAILED/);
  });

  it("still FAILS on an absent docker when memory was NOT opted out", async () => {
    await expect(
      stepVerification(
        configWithAgent(),
        true,
        { log: () => {}, sleep: noSleep, listContainers: () => null },
        { memoryOptedOut: false },
      ),
    ).rejects.toBeInstanceOf(SetupVerificationError);
  });
});

// ─── review H2: step 6 said it started memory; step 13 holds it to that ─────

describe("hindsight accountability (review H2/M6)", () => {
  it("FAILS when memory setup claimed success but no container exists", async () => {
    const findings = await verifyFleetContainers(
      configWithAgent(),
      { listContainers: () => up("alpha"), sleep: noSleep },
      { hindsightExpected: true, confirmIntervalMs: 1 },
    );
    expect(hasFatal(findings)).toBe(true);
    expect(findings.find((f) => f.name === "hindsight memory")?.detail).toMatch(
      /no switchroom-hindsight container/,
    );
  });

  it("FAILS on a wedged hindsight reporting `Up (unhealthy)`", async () => {
    // M6: the healthcheck exists to make a wedged API visible; treating
    // "Up (unhealthy)" as running verified a dead memory backend green.
    const findings = await verifyFleetContainers(
      configWithAgent(),
      {
        listContainers: () => [
          ...up("alpha"),
          { name: "switchroom-hindsight", status: "Up 2 minutes (unhealthy)" },
        ],
        sleep: noSleep,
      },
      { hindsightExpected: true, confirmIntervalMs: 1 },
    );
    expect(hasFatal(findings)).toBe(true);
    expect(findings.find((f) => f.name === "hindsight memory")?.detail).toMatch(
      /healthcheck is failing/,
    );
  });

  it("treats `health: starting` as pending, not a failure", async () => {
    const findings = await verifyFleetContainers(
      configWithAgent(),
      {
        listContainers: () => [
          ...up("alpha"),
          { name: "switchroom-hindsight", status: "Up 4 seconds (health: starting)" },
        ],
        sleep: noSleep,
      },
      { hindsightExpected: true, confirmIntervalMs: 1 },
    );
    expect(hasFatal(findings)).toBe(false);
    expect(findings.find((f) => f.name === "hindsight memory")?.status).toBe("pending");
  });

  it("classifies the docker status strings the verdicts rest on", () => {
    expect(classifyContainerStatus("Up 2 minutes (unhealthy)")).toBe("running-unhealthy");
    expect(classifyContainerStatus("Up 4 seconds (health: starting)")).toBe("running-starting");
    expect(classifyContainerStatus("Up 3 hours (healthy)")).toBe("running-healthy");
    expect(classifyContainerStatus("Up 3 hours")).toBe("running-no-healthcheck");
  });
});

// ─── review H3c: a first-install "yes" must not become a false FAIL ─────────

describe("fresh install, before `switchroom apply` (review H3c)", () => {
  it("does not offer to start (nor fail) when the compose file does not exist", async () => {
    const out: string[] = [];
    const startAgent = vi.fn();
    const confirmStart = vi.fn(async () => true);
    const verdict = await stepVerification(configWithAgent(), false, {
      log: (l) => out.push(l),
      sleep: noSleep,
      composeFileExists: () => false,
      startAgent,
      confirmStart,
      listContainers: () => [],
    });
    expect(verdict).toBe("pending");
    expect(confirmStart).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/has not generated the compose file yet/);
  });

  it("surfaces the child's real error when a start does fail", async () => {
    const out: string[] = [];
    await expect(
      stepVerification(configWithAgent(), false, {
        log: (l) => out.push(l),
        sleep: noSleep,
        composeFileExists: () => true,
        confirmStart: async () => true,
        startAgent: () => {
          throw new Error(
            "Command failed: Preflight failed for alpha / .oauth-token missing",
          );
        },
        listContainers: () => [],
      }),
    ).rejects.toBeInstanceOf(SetupVerificationError);
    expect(out.join("\n")).toMatch(/Preflight failed for alpha/);
    // NOT the misleading "run `switchroom apply` first" on a fleet that has
    // already been applied.
    expect(out.join("\n")).not.toMatch(/did not reach a stable running state/);
  });
});

// ─── review L11: every configured agent is offered, not just the first ──────

describe("multi-agent start offer (review L11)", () => {
  function twoAgents(): SwitchroomConfig {
    return {
      agents: { alpha: { topic_name: "a" }, beta: { topic_name: "b" } },
    } as unknown as SwitchroomConfig;
  }

  it("starts every agent, so `verified` is reachable on a 2-agent config", async () => {
    const started: string[] = [];
    const verdict = await stepVerification(twoAgents(), false, {
      log: () => {},
      sleep: noSleep,
      stableSamples: 2,
      composeFileExists: () => true,
      confirmStart: async () => true,
      startAgent: (n) => started.push(n),
      listContainers: () => [...up("alpha"), ...up("beta")],
    });
    expect(started).toEqual(["alpha", "beta"]);
    expect(verdict).toBe("verified");
  });

  it("waits on the agents CONCURRENTLY, not N × the stability window", async () => {
    // The stability window is wall-clock. Waiting in series would make the
    // wizard's worst case N × AGENT_UP_TIMEOUT_MS. Virtual clock: sum the
    // sleeps the waits ask for.
    let virtualMs = 0;
    let pending = 0;
    const sleep = async (ms: number) => {
      // Concurrent waiters overlap: only advance the clock for the sleep
      // that is not already covered by another in-flight waiter.
      pending++;
      if (pending === 1) virtualMs += ms;
      await Promise.resolve();
      pending--;
    };
    await stepVerification(twoAgents(), false, {
      log: () => {},
      sleep,
      composeFileExists: () => true,
      confirmStart: async () => true,
      startAgent: () => {},
      listContainers: () => [...up("alpha"), ...up("beta")],
    });
    // One window's worth of sleeping covered both agents.
    expect(virtualMs).toBeLessThan(AGENT_STABLE_WINDOW_MS * 2);
    expect(virtualMs).toBeGreaterThanOrEqual(AGENT_STABLE_WINDOW_MS);
  });
});

// ─── review L9 / L10: output hygiene ────────────────────────────────────────

describe("finding output hygiene", () => {
  it("de-duplicates the docker-unavailable row (review L9)", () => {
    const deduped = dedupeFindings([
      { name: "alpha: container up", status: "fail", detail: "a", code: "docker-unavailable" },
      { name: "docker runtime", status: "fail", detail: "b", code: "docker-unavailable" },
      { name: "agent containers", status: "pending", detail: "c" },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].name).toBe("alpha: container up");
  });

  it("numbers the pending checklist contiguously with zero agents (review L10)", async () => {
    const out: string[] = [];
    const verdict = await stepVerification(
      { agents: {} } as unknown as SwitchroomConfig,
      true,
      { log: (l) => out.push(l), sleep: noSleep, listContainers: () => [] },
    );
    expect(verdict).toBe("pending");
    const numbers = out
      .map((l) => l.match(/^\s+(\d+)\. /)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1)); // 1,2,3… no gap
  });
});
