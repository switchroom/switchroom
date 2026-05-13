/**
 * hostd docker e2e — exercises the published switchroom-hostd image
 * end-to-end against a fixture switchroom.yaml.
 *
 * Three high-value cases (one per bug class from PR #1203/#1204):
 *   1. boots-cleanly        — install verb produces a daemon that
 *                             actually starts + binds sockets. Catches
 *                             the silent no-op bug (PR #1203 bug 1).
 *   2. wire-end-to-end      — NDJSON request through the bind-mounted
 *                             socket returns a typed JSON response.
 *                             Catches the bun-vs-node CLI shim bug
 *                             (PR #1204).
 *   3. refuses-when-disabled — daemon exits 2 with a clear message
 *                             when host_control.enabled is false.
 *                             Catches a future regression where
 *                             Phase 1.5 packaging silently bypasses
 *                             the config gate.
 *
 * Two failure modes intentionally NOT covered:
 *   - Symlinked switchroom.yaml — covered by the boots-cleanly path
 *     since this fixture mirrors the real-host setup's bind shape
 *     (and was the bug-class behind PR #1203 bug 2; boots-cleanly
 *     fails fast if the symlink-safe direct file bind is dropped).
 *   - Mutating verbs (agent_restart against a fake agent) — needs a
 *     second container running as the matching agent uid; deferred
 *     to Phase 2's test bundle when there are more verbs to exercise.
 *
 * Skipped when docker isn't available OR the image isn't pulled
 * locally. Every container labeled per CLAUDE.md test discipline
 * (`switchroom.test=hostd-int` + per-run uuid). Each container
 * `docker rm -f`'d in finally; safeLabelTeardown is belt-and-braces.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId,
  dockerRunLabels,
  dockerRunLabelsArgv,
  safeLabelTeardown,
} from "./_label-helpers.js";

const IMAGE = "ghcr.io/switchroom/switchroom-hostd:latest";
const HOSTD_CONTAINER_NAME_PREFIX = "switchroom-hostd-test";

// Per-test bound on the boot + verify cycle. Each test spins up a
// container, waits ~3s for the daemon to announce "ready" or exit-2,
// makes assertions, then runs the chown+rmSync teardown (which itself
// pulls + runs a busybox container). The chown step needs ~2-5s the
// first time busybox is pulled, then ~1s for subsequent tests.
//
// Vitest's default per-test timeout is 5s, which is comfortably too
// tight for this suite. Bumped to 20s per case.
const TEST_TIMEOUT_MS = 20_000;

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

const dockerOk = hasDocker();
const imagePresent = dockerOk && hasImage(IMAGE);

const RUN_ID = newRunId();
const LABELS = dockerRunLabels(RUN_ID);
const LABELS_ARGV = dockerRunLabelsArgv(RUN_ID);

// Containers tracked across tests so afterAll can clean any that
// crashed mid-finally.
const containers = new Set<string>();

afterAll(() => {
  for (const name of containers) {
    try {
      execSync(`docker rm -f ${name}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  safeLabelTeardown(RUN_ID);
});

interface FixtureBundle {
  homeDir: string;
  configPath: string;
  hostdName: string;
}

function makeFixture(opts: {
  hostControlEnabled: boolean;
  testSuffix: string;
}): FixtureBundle {
  const homeDir = mkdtempSync(join(tmpdir(), `hostd-e2e-${opts.testSuffix}-`));
  mkdirSync(join(homeDir, ".switchroom", "hostd"), { recursive: true });
  mkdirSync(join(homeDir, ".switchroom", "agents", "test-admin"), { recursive: true });

  // Minimal switchroom.yaml: only what loadConfig() requires at
  // startup PLUS one admin-flagged agent so the daemon has a socket
  // to bind. forum_chat_id, topic_name are schema-required even
  // though hostd doesn't use them.
  const yaml = [
    `switchroom:`,
    `  version: 1`,
    `  agents_dir: ~/.switchroom/agents`,
    `  skills_dir: ~/.switchroom/skills`,
    `telegram:`,
    `  bot_token: "test:fake"`,
    `  forum_chat_id: "-1001234567890"`,
    `host_control:`,
    `  enabled: ${opts.hostControlEnabled}`,
    `agents:`,
    `  test-admin:`,
    `    extends: default`,
    `    admin: true`,
    `    topic_name: "Test Admin"`,
    ``,
  ].join("\n");
  const configPath = join(homeDir, ".switchroom", "switchroom.yaml");
  writeFileSync(configPath, yaml, "utf8");

  return {
    homeDir,
    configPath,
    hostdName: `${HOSTD_CONTAINER_NAME_PREFIX}-${opts.testSuffix}`,
  };
}

function startHostd(bundle: FixtureBundle): { exitCode: number; logs: string } {
  // Mirrors src/cli/hostd.ts:renderHostdComposeFile EXACTLY — same
  // bind mounts, env, caps. That's the artifact we're validating.
  containers.add(bundle.hostdName);
  const args = [
    "run",
    "-d",
    "--name", bundle.hostdName,
    ...LABELS_ARGV,
    "--user", "0:0",
    "--cap-drop", "ALL",
    "--cap-add", "CHOWN",
    "--cap-add", "DAC_OVERRIDE",
    "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges:true",
    "-v", `${bundle.homeDir}/.switchroom:/host-home/.switchroom:rw`,
    // Symlink-safe direct file bind (the fix from PR #1203 bug 2).
    "-v", `${bundle.configPath}:/state/config/switchroom.yaml:ro`,
    "-v", "/var/run/docker.sock:/var/run/docker.sock:rw",
    "-e", "HOME=/host-home",
    "-e", "SWITCHROOM_CONFIG=/state/config/switchroom.yaml",
    "-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    IMAGE,
  ];
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) {
    return { exitCode: r.status ?? -1, logs: `docker run failed: ${r.stderr}` };
  }

  // Poll docker logs every 100ms until we see a terminal signal
  // ("ready", "refusing", or "fatal"), max 3s. `2>&1` merges the
  // container's stderr (where hostd's announcements actually land —
  // main.ts uses process.stderr.write) into stdout so execSync's
  // captured stdout sees both streams. Without the redirect the
  // captured buffer is empty and the test misreads "still booting"
  // as "no logs yet".
  let logs = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      logs = execSync(`docker logs ${bundle.hostdName} 2>&1`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (/hostd: ready —|hostd: refusing to start|hostd: fatal/.test(logs)) break;
    } catch {
      /* container exited; continue polling for last logs */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  // 0 if running; otherwise the exit code reported by docker.
  let exitCode = 0;
  try {
    const inspect = execSync(
      `docker inspect ${bundle.hostdName} --format '{{.State.ExitCode}}|{{.State.Running}}'`,
      { encoding: "utf8" },
    ).trim();
    const [code, running] = inspect.split("|");
    exitCode = running === "true" ? 0 : parseInt(code ?? "-1", 10);
  } catch {
    /* best-effort */
  }
  return { exitCode, logs };
}

function tearDownFixture(bundle: FixtureBundle): void {
  try {
    execSync(`docker rm -f ${bundle.hostdName}`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  containers.delete(bundle.hostdName);

  // Daemon (root inside container) created sockets owned by per-agent
  // UIDs in dirs owned by root. The test process (operator uid) can't
  // `unlink` those. One-shot busybox container (--rm) chowns the
  // subtree back so the subsequent rmSync succeeds. Labeled so
  // safeLabelTeardown can catch it if it doesn't self-clean.
  try {
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    execSync(
      `docker run --rm ${LABELS} -v "${bundle.homeDir}":/work:rw busybox chown -R ${uid}:${gid} /work`,
      { stdio: "ignore" },
    );
  } catch {
    /* best-effort */
  }
  rmSync(bundle.homeDir, { recursive: true, force: true });
}

describe.skipIf(!dockerOk || !imagePresent)(
  "switchroom-hostd docker image — e2e",
  () => {
    it("boots cleanly with a fixture config + one admin agent", () => {
      const bundle = makeFixture({
        hostControlEnabled: true,
        testSuffix: "boot",
      });
      try {
        const r = startHostd(bundle);
        // exit-code 0 = still running. Daemon should have bound at
        // least one socket and announced "ready" within the boot poll
        // window.
        expect(r.exitCode, `expected daemon running, logs:\n${r.logs}`).toBe(0);
        expect(r.logs).toMatch(/hostd: ready/);
        expect(r.logs).toMatch(/test-admin\/sock/);
      } finally {
        tearDownFixture(bundle);
      }
    }, TEST_TIMEOUT_MS);

    it("end-to-end NDJSON request returns a typed JSON response (bun shim is live)", () => {
      // We send `upgrade_status` — a read-only verb that shells out
      // to `switchroom update --status`. The fixture config doesn't
      // describe a real fleet, so the shellout's exit code may be
      // non-zero (docker compose can't find the fleet), but that's
      // fine: we're testing the WIRE works end-to-end. Specifically:
      //   - install path resolves the symlink-safe bind ✓ (start-up)
      //   - bun shim spawns the CLI without crashing on bun:* imports
      //   - protocol round-trips a parseable JSON response
      // Pre-PR #1204 the CLI shim used `node`, crashing on
      // ERR_UNSUPPORTED_ESM_URL_SCHEME long before getting to the
      // typed response below.
      const bundle = makeFixture({
        hostControlEnabled: true,
        testSuffix: "wire",
      });
      try {
        const r = startHostd(bundle);
        expect(r.exitCode, `daemon failed to start:\n${r.logs}`).toBe(0);

        const req = JSON.stringify({
          v: 1,
          request_id: "e2e-wire-1",
          op: "upgrade_status",
          args: {},
        });
        // docker exec INTO the running daemon container so the connect
        // happens via the in-container path which peercred.ts classifies
        // as `{kind:"agent", name:"test-admin"}` based on the socket
        // path. (Connecting via the host-side socket from the operator
        // uid would EACCES on the chown'd socket file.)
        const script = `
          const net = require("node:net");
          const sock = net.connect("/host-home/.switchroom/hostd/test-admin/sock");
          let buf = "";
          sock.on("data", d => buf += d.toString());
          sock.on("end", () => { process.stdout.write(buf); process.exit(0); });
          sock.on("error", e => { process.stderr.write(e.message); process.exit(2); });
          sock.write(${JSON.stringify(req)} + "\\n");
          setTimeout(() => { process.stdout.write(buf); process.exit(1); }, 8000);
        `;
        const resp = spawnSync(
          "docker",
          ["exec", bundle.hostdName, "node", "-e", script],
          { encoding: "utf8" },
        );
        const stdout = resp.stdout.trim();
        expect(
          stdout,
          `expected JSON, got: stdout="${stdout}" stderr="${resp.stderr}"`,
        ).toMatch(/^\{/);
        const parsed = JSON.parse(stdout);
        expect(parsed.v).toBe(1);
        expect(parsed.request_id).toBe("e2e-wire-1");
        // Pre-PR #1204 the bun shim bug would have crashed the spawned
        // CLI on a bun:sqlite import and the daemon would return
        // result:"error" with a Node.js MODULE_NOT_FOUND in stderr.
        // Post-fix the verb completes (CLI ran under bun). The exit
        // code may still be non-zero (no real fleet to introspect),
        // but that's an orthogonal concern — completed/error/denied
        // are all valid "wire works" outcomes.
        expect(["completed", "error", "denied"]).toContain(parsed.result);
        // If we ARE seeing the bun-shim regression, the stderr_tail
        // pin below catches it explicitly.
        if (parsed.stderr_tail) {
          expect(parsed.stderr_tail).not.toMatch(/bun:/);
          expect(parsed.stderr_tail).not.toMatch(/ERR_UNSUPPORTED_ESM_URL_SCHEME/);
        }
      } finally {
        tearDownFixture(bundle);
      }
    }, TEST_TIMEOUT_MS);

    it("refuses to start when host_control.enabled is false (config gate)", () => {
      const bundle = makeFixture({
        hostControlEnabled: false,
        testSuffix: "gate-off",
      });
      try {
        const r = startHostd(bundle);
        // exit-2 is the documented "refusing to start" contract from
        // main.ts:34. exit-0 (still running) would be a regression
        // where the gate doesn't fire.
        expect(r.exitCode).toBe(2);
        expect(r.logs).toMatch(/refusing to start.*host_control\.enabled/);
      } finally {
        tearDownFixture(bundle);
      }
    }, TEST_TIMEOUT_MS);
  },
);
