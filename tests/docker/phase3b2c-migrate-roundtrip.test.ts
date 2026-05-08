/**
 * Phase 3b-2c — `switchroom migrate` round-trip e2e.
 *
 * Headline acceptance test for Phase 3b-2: drives the executor through
 * `to-docker` and then `to-host` against a fully isolated tmpdir
 * "switchroom home" (runtime-mode marker, compose path, watchdog
 * sentinel, agents root, migration.log all redirected). Real docker
 * daemon is exercised — but only via a single labelled alpine sleep
 * service inside a phase3b2c-scoped compose project. Systemd is faked
 * via an injected `RunCommand` that records calls.
 *
 * What we assert:
 *   1. to-docker: containers up under the test project, runtime-mode
 *      marker == "docker", migration.log shows ok entries for every
 *      step.
 *   2. broker.db + kernel.db schema_version snapshots taken between
 *      the two migrations remain stable across to-host.
 *   3. to-host: containers down (compose-down scoped to project),
 *      runtime-mode marker == "host", migration.log shows ok entries
 *      for the reversal.
 *   4. Pre/post `sudo docker ps` snapshot identical (no Coolify drift).
 *
 * HARD RULES compliance:
 *   - Every test container labelled `switchroom.test=phase3b2c` plus
 *     a per-run UUID label.
 *   - Compose project name `switchroom-test-phase3b2c-${RUN_ID8}` —
 *     scope guarantees compose-down only touches our fixtures.
 *   - safeLabelTeardown() in afterAll as belt-and-braces.
 *   - Never touches the real ~/.switchroom/ — every state path is
 *     redirected via ExecutorDeps.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
// @ts-expect-error - node:sqlite is built-in on Node ≥ 22.5 but lacks ambient
// types in this repo's tsconfig. We use it only for a schema_version PRAGMA.
import { DatabaseSync } from "node:sqlite";

import { buildPlan } from "../../src/cli/migrate/plan.js";
import { executePlan } from "../../src/cli/migrate/executor.js";
import { _resetLogChainForTests } from "../../src/cli/migrate/log.js";
import type { RunCommand } from "../../src/cli/migrate/preflight.js";
import {
  captureProdSnapshot,
  expectNoProdDrift,
  type ProdSnapshot,
} from "./_prod-snapshot";

const RUN_ID = randomUUID();
const RUN_ID_SHORT = RUN_ID.slice(0, 8);
const COMPOSE_PROJECT = `switchroom-test-phase3b2c-${RUN_ID_SHORT}`;
const ALPINE = "alpine:3.19";

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureAlpine(): boolean {
  if (hasImage(ALPINE)) return true;
  try {
    execSync(`docker pull ${ALPINE}`, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const dockerOk = hasDocker();
const imageOk = dockerOk && ensureAlpine();

function safeLabelTeardown(): void {
  for (const filter of [
    `label=switchroom.test.run=${RUN_ID}`,
    `label=switchroom.test=phase3b2c`,
  ]) {
    try {
      const ids = execSync(`docker ps -aq --filter ${filter}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (ids.length === 0) continue;
      execSync(`docker rm -f ${ids.split(/\s+/).join(" ")}`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
  // Also: project-scoped compose down as the primary path.
  try {
    execSync(`docker compose -p ${COMPOSE_PROJECT} down -v --remove-orphans`, {
      stdio: "ignore",
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Build the labelled compose YAML the executor's `compose-generate`
 * step will write. Single alpine service running `sleep` so compose-up
 * succeeds and the round-trip exercises real container lifecycle.
 */
function makeComposeYaml(): string {
  return [
    `services:`,
    `  alice:`,
    `    image: ${ALPINE}`,
    `    container_name: phase3b2c-${RUN_ID_SHORT}-alice`,
    `    command: ["sleep", "3600"]`,
    `    labels:`,
    `      switchroom.test: "phase3b2c"`,
    `      switchroom.test.run: "${RUN_ID}"`,
    ``,
  ].join("\n");
}

function snapshotSchema(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA schema_version").get() as { schema_version: number };
    return row.schema_version;
  } finally {
    db.close();
  }
}

function seedDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY, v TEXT);
      INSERT INTO sample (v) VALUES ('seed-${RUN_ID_SHORT}');
    `);
  } finally {
    db.close();
  }
}

let prodBefore: ProdSnapshot;
let TMP_HOME: string;
let LOG_PATH: string;
let COMPOSE_PATH: string;
let RUNTIME_MODE_PATH: string;
let WATCHDOG_PAUSE_PATH: string;
let AGENTS_ROOT: string;
let BROKER_DB: string;
let KERNEL_DB: string;
let recordedSystemctl: Array<{ args: readonly string[] }> = [];

beforeAll(() => {
  prodBefore = captureProdSnapshot();
  TMP_HOME = mkdtempSync(join(tmpdir(), "sr-3b2c-"));
  LOG_PATH = join(TMP_HOME, "migration.log");
  COMPOSE_PATH = join(TMP_HOME, "compose", "docker-compose.yml");
  RUNTIME_MODE_PATH = join(TMP_HOME, "runtime-mode");
  WATCHDOG_PAUSE_PATH = join(TMP_HOME, "watchdog.paused");
  AGENTS_ROOT = join(TMP_HOME, "agents");
  mkdirSync(AGENTS_ROOT, { recursive: true });
  mkdirSync(join(AGENTS_ROOT, "alice"), { recursive: true });

  // Seed dbs to mimic broker/kernel state.
  BROKER_DB = join(TMP_HOME, "broker.db");
  KERNEL_DB = join(TMP_HOME, "kernel.db");
  seedDb(BROKER_DB);
  seedDb(KERNEL_DB);

  // Pretend we start in host mode.
  writeFileSync(RUNTIME_MODE_PATH, "host\n", "utf8");

  _resetLogChainForTests();
});

afterAll(() => {
  safeLabelTeardown();
  if (TMP_HOME && existsSync(TMP_HOME)) {
    rmSync(TMP_HOME, { recursive: true, force: true });
  }
  const after = captureProdSnapshot();
  expectNoProdDrift(prodBefore, after);
});

const skipIfNoDocker = !dockerOk || !imageOk ? it.skip : it;

describe("phase3b2c migrate round-trip (host → docker → host)", () => {
  skipIfNoDocker(
    "completes round-trip with stable schema and no prod drift",
    async () => {
      const fakeSystemctl: RunCommand = async (cmd, args) => {
        if (cmd === "systemctl") {
          recordedSystemctl.push({ args });
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        // For docker we shell out for real — see runCommandReal below.
        return { stdout: "", stderr: "unexpected cmd via fake", exitCode: 1 };
      };

      // Phase 3c F-new-1 — observability of the watchdog pause sentinel.
      // We don't run the watchdog process itself (too coupled for an
      // in-test boot); instead we trace whether the sentinel was
      // present at the moment each docker command fired. The contract
      // is: sentinel exists for the entire docker-touching window of
      // the migration, and is gone by the time the executor returns.
      const sentinelObservations: Array<{ phase: string; cmd: string; sentinelPresent: boolean }> = [];
      let currentPhase = "to-docker";
      const observeSentinel = (cmd: string): void => {
        sentinelObservations.push({
          phase: currentPhase,
          cmd,
          sentinelPresent: existsSync(WATCHDOG_PAUSE_PATH),
        });
      };

      // Compound runner: real docker, fake systemctl. Records sentinel
      // state at each docker invocation so we can assert the watchdog
      // would have stayed paused for the whole compose-touching window.
      const runCommand: RunCommand = async (cmd, args) => {
        if (cmd === "systemctl") return fakeSystemctl(cmd, args);
        if (cmd === "docker") {
          observeSentinel(`docker ${args.slice(0, 3).join(" ")}`);
          try {
            const out = execSync(
              `docker ${args.map((a) => JSON.stringify(a)).join(" ")}`,
              { stdio: ["ignore", "pipe", "pipe"] },
            ).toString();
            return { stdout: out, stderr: "", exitCode: 0 };
          } catch (err: any) {
            return {
              stdout: err.stdout?.toString() ?? "",
              stderr: err.stderr?.toString() ?? String(err.message ?? err),
              exitCode: err.status ?? 1,
            };
          }
        }
        return { stdout: "", stderr: `unexpected cmd ${cmd}`, exitCode: 1 };
      };

      // ---- to-docker ----------------------------------------------------
      const toDockerPlan = buildPlan("to-docker", {
        agents: ["alice"],
        composeProject: COMPOSE_PROJECT,
        composePath: COMPOSE_PATH,
        // No targetUid → skip uid-align step (we don't want chown noise).
      });

      const toDockerResult = await executePlan(
        toDockerPlan,
        { composeProject: COMPOSE_PROJECT, composePath: COMPOSE_PATH },
        {
          runCommand,
          generateComposeContent: () => makeComposeYaml(),
          probeAgentBroker: async () => true,
          confirmUidAlign: async () => true,
          chownPath: async () => undefined,
          logPath: LOG_PATH,
          runtimeModePath: RUNTIME_MODE_PATH,
          watchdogPausePath: WATCHDOG_PAUSE_PATH,
          agentsRoot: AGENTS_ROOT,
        },
      );

      expect(toDockerResult.ok).toBe(true);
      expect(toDockerResult.completed.length).toBe(toDockerPlan.steps.length);
      expect(readFileSync(RUNTIME_MODE_PATH, "utf8").trim()).toBe("docker");

      // Phase 3c F-new-1 — sentinel was present during every docker
      // call of the to-docker migration, and is gone now that the
      // executor returned (watchdog-resume is the final step).
      const toDockerObs = sentinelObservations.filter((o) => o.phase === "to-docker");
      expect(toDockerObs.length).toBeGreaterThan(0);
      expect(toDockerObs.every((o) => o.sentinelPresent)).toBe(true);
      expect(existsSync(WATCHDOG_PAUSE_PATH)).toBe(false);

      currentPhase = "to-host";

      // Verify the test container is up under our scoped project.
      const psOut = execSync(
        `docker ps --filter label=switchroom.test.run=${RUN_ID} --format '{{.Names}}'`,
        { stdio: ["ignore", "pipe", "pipe"] },
      )
        .toString()
        .trim();
      expect(psOut).toContain(`phase3b2c-${RUN_ID_SHORT}-alice`);

      // ---- mid-flight schema snapshot ----------------------------------
      const brokerSchemaMid = snapshotSchema(BROKER_DB);
      const kernelSchemaMid = snapshotSchema(KERNEL_DB);

      // ---- to-host ------------------------------------------------------
      const toHostPlan = buildPlan("to-host", {
        agents: ["alice"],
        composeProject: COMPOSE_PROJECT,
        composePath: COMPOSE_PATH,
      });

      const toHostResult = await executePlan(
        toHostPlan,
        { composeProject: COMPOSE_PROJECT, composePath: COMPOSE_PATH },
        {
          runCommand,
          generateComposeContent: () => makeComposeYaml(),
          probeAgentBroker: async () => true,
          confirmUidAlign: async () => true,
          chownPath: async () => undefined,
          logPath: LOG_PATH,
          runtimeModePath: RUNTIME_MODE_PATH,
          watchdogPausePath: WATCHDOG_PAUSE_PATH,
          agentsRoot: AGENTS_ROOT,
        },
      );

      expect(toHostResult.ok).toBe(true);
      expect(toHostResult.completed.length).toBe(toHostPlan.steps.length);
      expect(readFileSync(RUNTIME_MODE_PATH, "utf8").trim()).toBe("host");

      // Phase 3c F-new-1 — same sentinel contract on the reverse leg.
      const toHostObs = sentinelObservations.filter((o) => o.phase === "to-host");
      expect(toHostObs.length).toBeGreaterThan(0);
      expect(toHostObs.every((o) => o.sentinelPresent)).toBe(true);
      expect(existsSync(WATCHDOG_PAUSE_PATH)).toBe(false);

      // Container should be gone (compose down scoped to our project).
      const psAfter = execSync(
        `docker ps -a --filter label=switchroom.test.run=${RUN_ID} --format '{{.Names}}'`,
        { stdio: ["ignore", "pipe", "pipe"] },
      )
        .toString()
        .trim();
      expect(psAfter).toBe("");

      // ---- post schema snapshot ----------------------------------------
      const brokerSchemaPost = snapshotSchema(BROKER_DB);
      const kernelSchemaPost = snapshotSchema(KERNEL_DB);
      expect(brokerSchemaPost).toBe(brokerSchemaMid);
      expect(kernelSchemaPost).toBe(kernelSchemaMid);

      // ---- migration.log shape -----------------------------------------
      const log = readFileSync(LOG_PATH, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const okEntries = log.filter((e) => e.status === "ok");
      const rollbackEntries = log.filter((e) => e.status === "rollback");
      expect(okEntries.length).toBe(toDockerPlan.steps.length + toHostPlan.steps.length);
      expect(rollbackEntries.length).toBe(0);

      const verbs = new Set(log.map((e) => e.verb));
      expect(verbs.has("to-docker")).toBe(true);
      expect(verbs.has("to-host")).toBe(true);

      // Systemctl calls were recorded for both directions.
      expect(recordedSystemctl.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
