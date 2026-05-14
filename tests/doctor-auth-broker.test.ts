/**
 * Doctor checks for switchroom-auth-broker (RFC H).
 *
 * Each probe is dependency-injected for a docker shellout (service
 * health + per-agent socket presence) and for filesystem state (drift,
 * threshold-violations, active-account). Tests drive every branch
 * with tmpdir fixtures + stub callbacks; no docker daemon required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import {
  checkAuthBrokerActiveAccount,
  checkAuthBrokerDrift,
  checkAuthBrokerPerAgentSockets,
  checkAuthBrokerServiceHealth,
  checkAuthBrokerThresholdViolations,
  runAuthBrokerChecks,
  type AuthBrokerProbeDeps,
} from "../src/cli/doctor-auth-broker.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

let workDir: string;
let stateDir: string;
let homeDir: string;

beforeEach(() => {
  workDir = resolve(tmpdir(), `switchroom-doctor-auth-${Date.now()}-${Math.random()}`);
  stateDir = join(workDir, "state");
  homeDir = join(workDir, "home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function makeConfig(agents: string[] = [], authActive?: string): SwitchroomConfig {
  const agentMap: Record<string, unknown> = {};
  for (const a of agents) agentMap[a] = { soul: "default" };
  return {
    agents: agentMap,
    auth: authActive ? { active: authActive } : undefined,
  } as unknown as SwitchroomConfig;
}

function writeSha(label: string, contents: string): string {
  const accountsDir = join(homeDir, ".switchroom", "accounts", label);
  mkdirSync(accountsDir, { recursive: true });
  writeFileSync(join(accountsDir, "credentials.json"), contents);
  return createHash("sha256").update(contents).digest("hex");
}

function deps(extra: Partial<AuthBrokerProbeDeps> = {}): AuthBrokerProbeDeps {
  return { stateDir, home: homeDir, ...extra };
}

/* ── Check 1: service health ────────────────────────────────────────── */

describe("checkAuthBrokerServiceHealth", () => {
  it("ok when running + healthy", () => {
    const r = checkAuthBrokerServiceHealth(
      deps({ dockerInspect: () => "running|healthy" }),
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/healthcheck passing/);
  });

  it("fail when container missing", () => {
    const r = checkAuthBrokerServiceHealth(
      deps({ dockerInspect: () => null }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not found/);
  });

  it("fail when state != running", () => {
    const r = checkAuthBrokerServiceHealth(
      deps({ dockerInspect: () => "exited|unhealthy" }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/exited/);
  });

  it("fail when running but healthcheck unhealthy", () => {
    const r = checkAuthBrokerServiceHealth(
      deps({ dockerInspect: () => "running|unhealthy" }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unhealthy/);
  });

  it("warn when running but no healthcheck configured", () => {
    const r = checkAuthBrokerServiceHealth(
      deps({ dockerInspect: () => "running|none" }),
    );
    expect(r.status).toBe("warn");
  });
});

/* ── Check 2: per-agent sockets ─────────────────────────────────────── */

describe("checkAuthBrokerPerAgentSockets", () => {
  it("ok when every agent's socket is bound", () => {
    const config = makeConfig(["alice", "bob"]);
    const seen: string[] = [];
    const r = checkAuthBrokerPerAgentSockets(
      config,
      deps({
        dockerExecExists: (_c, path) => {
          seen.push(path);
          return true;
        },
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/2 agent socket/);
    expect(seen).toEqual([
      "/run/switchroom/auth-broker/alice/sock",
      "/run/switchroom/auth-broker/bob/sock",
    ]);
  });

  it("fail listing the agents whose sockets are missing", () => {
    const config = makeConfig(["alice", "bob", "charlie"]);
    const r = checkAuthBrokerPerAgentSockets(
      config,
      deps({
        dockerExecExists: (_c, path) =>
          !path.includes("/bob/") && !path.includes("/charlie/"),
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/bob, charlie/);
  });

  it("ok when no agents configured (empty fleet)", () => {
    const r = checkAuthBrokerPerAgentSockets(makeConfig([]), deps());
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/no agents/);
  });
});

/* ── Check 3: drift ──────────────────────────────────────────────────── */

describe("checkAuthBrokerDrift", () => {
  it("ok when sha-index.json missing (broker never seen an add)", () => {
    const r = checkAuthBrokerDrift(deps());
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/no sha-index/);
  });

  it("ok when every indexed entry matches on-disk credentials", () => {
    const shaWork = writeSha("work", '{"k":"v"}\n');
    const shaPlay = writeSha("play", '{"k":"v2"}\n');
    writeFileSync(
      join(stateDir, "sha-index.json"),
      JSON.stringify({ work: shaWork, play: shaPlay }),
    );
    const r = checkAuthBrokerDrift(deps());
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/2 indexed/);
  });

  it("fail when sha doesn't match (operator edited credentials)", () => {
    writeSha("work", '{"k":"v"}\n');
    writeFileSync(
      join(stateDir, "sha-index.json"),
      JSON.stringify({ work: "0".repeat(64) }),
    );
    const r = checkAuthBrokerDrift(deps());
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/sha mismatch.*work/);
  });

  it("fail when index entry has no on-disk credentials", () => {
    writeFileSync(
      join(stateDir, "sha-index.json"),
      JSON.stringify({ ghost: "deadbeef" }),
    );
    const r = checkAuthBrokerDrift(deps());
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/no credentials\.json.*ghost/);
  });

  it("fail when sha-index.json is unreadable", () => {
    writeFileSync(join(stateDir, "sha-index.json"), "{not json");
    const r = checkAuthBrokerDrift(deps());
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unreadable/);
  });
});

/* ── Check 4: threshold violations ──────────────────────────────────── */

describe("checkAuthBrokerThresholdViolations", () => {
  it("ok when file missing", () => {
    const r = checkAuthBrokerThresholdViolations(deps());
    expect(r.status).toBe("ok");
  });

  it("ok when all counts zero", () => {
    writeFileSync(
      join(stateDir, "threshold-violations.json"),
      JSON.stringify({ work: 0, play: 0 }),
    );
    const r = checkAuthBrokerThresholdViolations(deps());
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/zero violations/);
  });

  it("warn when any count is non-zero", () => {
    writeFileSync(
      join(stateDir, "threshold-violations.json"),
      JSON.stringify({ work: 3, play: 0 }),
    );
    const r = checkAuthBrokerThresholdViolations(deps());
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/work=3/);
  });

  it("warn when file is unreadable", () => {
    writeFileSync(join(stateDir, "threshold-violations.json"), "{bad");
    const r = checkAuthBrokerThresholdViolations(deps());
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/unreadable/);
  });
});

/* ── Check 5: fleet active account ──────────────────────────────────── */

describe("checkAuthBrokerActiveAccount", () => {
  it("fail when auth.active not set", () => {
    const r = checkAuthBrokerActiveAccount(makeConfig([], undefined), deps());
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not set/);
  });

  it("fail when active account dir does not exist", () => {
    const r = checkAuthBrokerActiveAccount(makeConfig([], "work"), deps());
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/does not exist/);
  });

  it("fail when account dir exists but credentials.json missing", () => {
    mkdirSync(join(homeDir, ".switchroom", "accounts", "work"), {
      recursive: true,
    });
    const r = checkAuthBrokerActiveAccount(makeConfig([], "work"), deps());
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/credentials\.json missing/);
  });

  it("ok when active account is fully present", () => {
    writeSha("work", '{"k":"v"}\n');
    const r = checkAuthBrokerActiveAccount(makeConfig([], "work"), deps());
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/auth\.active="work"/);
  });
});

/* ── Aggregator ──────────────────────────────────────────────────────── */

describe("runAuthBrokerChecks", () => {
  it("orders results fails first, warns next, oks last", () => {
    // No state-dir, no docker → service-health fails, drift+threshold
    // are ok (no files), per-agent ok (no agents), active fails.
    const results = runAuthBrokerChecks(
      makeConfig([], undefined),
      deps({
        dockerInspect: () => null,
        dockerExecExists: () => false,
      }),
    );
    const statuses = results.map((r) => r.status);
    // every fail must come before every warn, every warn before every ok
    let phase: "fail" | "warn" | "ok" = "fail";
    for (const s of statuses) {
      if (phase === "fail" && s === "warn") phase = "warn";
      else if ((phase === "fail" || phase === "warn") && s === "ok") phase = "ok";
      else if (phase === "warn" && s === "fail") {
        throw new Error(`bad order: ${statuses.join(",")}`);
      } else if (phase === "ok" && s !== "ok") {
        throw new Error(`bad order: ${statuses.join(",")}`);
      }
    }
  });

  it("happy-path returns all-ok when broker is healthy + state is consistent", () => {
    const sha = writeSha("work", '{"k":"v"}\n');
    writeFileSync(
      join(stateDir, "sha-index.json"),
      JSON.stringify({ work: sha }),
    );
    writeFileSync(
      join(stateDir, "threshold-violations.json"),
      JSON.stringify({ work: 0 }),
    );
    const results = runAuthBrokerChecks(
      makeConfig(["alice"], "work"),
      deps({
        dockerInspect: () => "running|healthy",
        dockerExecExists: () => true,
      }),
    );
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
});
