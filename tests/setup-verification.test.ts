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
  hasFatal,
  SetupVerificationError,
} from "../src/setup/verify.js";
import {
  stepVerification,
  stepMemoryBackend,
  reportSetupFailure,
} from "../src/cli/setup.js";
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

  it("passes only after the container has STAYED up across samples", async () => {
    let calls = 0;
    const f = await waitForAgentContainerUp(
      "alpha",
      {
        listContainers: () => {
          calls++;
          return up("alpha");
        },
        sleep: noSleep,
      },
      opts,
    );
    expect(f.status).toBe("ok");
    expect(calls).toBe(3); // stableSamples, not a single lucky read
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
  it("FAILS when docker is unreachable", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
      listContainers: () => null,
    });
    expect(hasFatal(findings)).toBe(true);
    expect(findings[0].detail).toMatch(/docker is not reachable/);
  });

  it("FAILS on doctor's stuck/crash-loop signature", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
      listContainers: () => [
        { name: "switchroom-alpha", status: "Created" },
        { name: "switchroom-vault-broker", status: "Restarting (1) 2 seconds ago" },
      ],
    });
    expect(hasFatal(findings)).toBe(true);
    expect(findings.map((f) => f.detail).join(" ")).toMatch(/stuck\/crash-looping/);
  });

  it("reports PENDING (never ok) when no agent container exists yet", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
      listContainers: () => [],
    });
    expect(hasFatal(findings)).toBe(false);
    const agentRow = findings.find((f) => f.name === "agent containers");
    expect(agentRow?.status).toBe("pending");
    expect(agentRow?.detail).toContain("0/1");
  });

  it("reports PENDING for a stopped (deliberately) agent, not a hard fail", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
      listContainers: () => [
        { name: "switchroom-alpha", status: "Exited (0) 3 hours ago" },
      ],
    });
    expect(hasFatal(findings)).toBe(false);
    expect(findings.find((f) => f.name === "agent containers")?.status).toBe("pending");
  });

  it("FAILS when the hindsight container setup just started is crash-looping", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
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

  it("does not invent a hindsight row when there is no hindsight container", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
      listContainers: () => up("alpha"),
    });
    expect(findings.find((f) => f.name === "hindsight memory")).toBeUndefined();
  });

  it("names an agent in an unexpected docker state instead of dropping it", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
      listContainers: () => [{ name: "switchroom-alpha", status: "Paused" }],
    });
    const row = findings.find((f) => f.name === "agent containers");
    expect(row?.status).toBe("pending");
    expect(row?.detail).toContain("not up: alpha");
  });

  it("reports ok when every configured agent is up", () => {
    const findings = verifyFleetContainers(configWithAgent(), {
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
    ).rejects.toThrow(/Docker is not available/);

    const text = logs.join("\n");
    expect(text).not.toContain("Manual setup pending");
    // The old code printed a green OK on this exact path.
    expect(text).toMatch(/Docker is not available/);
    expect(text).toMatch(/SWITCHROOM_MEMORY_BACKEND=none/);
  });

  it("still honours the documented opt-out without touching Docker", async () => {
    process.env.SWITCHROOM_MEMORY_BACKEND = "none";
    const probe = vi.fn(() => null);
    await expect(
      stepMemoryBackend(configWithAgent(), true, cfgPath, { dockerProbe: probe }),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
