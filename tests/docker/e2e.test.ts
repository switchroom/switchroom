/**
 * Phase 1b E2E suite — exercises the actual built images. Skipped when
 * Docker isn't available or the phase1b-test images haven't been built
 * yet. CI builds the images first, then runs this suite.
 *
 * What this file ACTUALLY tests (one-liner per case):
 *   1. base image — node, bun, tini, tmux, claude all on PATH.
 *   2. broker image — bundle starts as a process and stays alive long
 *      enough to bind sockets (replaces the prior "module imports OK"
 *      stub that Phase 1b review correctly flagged as a no-op).
 *   3. scheduler image — bundle's better-sqlite3 prebuilt binary loads
 *      and an in-memory DB round-trips a row.
 *   4. agent image — read-only rootfs blocks writes (EROFS).
 *   5. agent image — cap_drop=ALL + no-new-privileges blocks mount (EPERM).
 *
 * What this file does NOT cover (deferred to Phase 1c):
 *   - Per-agent identity isolation across SEPARATE agent containers
 *     (this file only asserts kernel-level guards on a single container).
 *   - Cross-agent broker-socket testing (peercred ACL across two
 *     concurrently-running agents hitting the same broker).
 *   - Live docker-compose stand-up of all 5 services.
 *   - Approval kernel — kernel-server.ts entrypoint doesn't exist yet.
 *   - Real broker socket peercred handshake against a cron unit.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId,
  dockerRunLabels,
  dockerRunLabelsArgv,
  safeLabelTeardown,
} from "./_label-helpers.js";

// Per-run id — used to label every container this file creates so
// that `docker ps --filter label=switchroom.test.run=<runId>` returns
// only this file's containers and nothing else on the host.
const RUN_ID = newRunId();
const LABELS = dockerRunLabels(RUN_ID);
const LABELS_ARGV = dockerRunLabelsArgv(RUN_ID);

afterAll(() => {
  // Belt-and-braces — primary teardown is per-container `docker rm
  // -f <name>` and `--rm` self-cleanup. This catches any orphans from
  // a crash mid-test. Strictly label-scoped; cannot touch unrelated
  // containers (Coolify / hindsight / etc) on this host.
  safeLabelTeardown(RUN_ID);
});

const TAG = "phase1b-test";
const IMAGES = {
  base: `switchroom/base:${TAG}`,
  agent: `switchroom/agent:${TAG}`,
  broker: `switchroom/broker:${TAG}`,
  kernel: `switchroom/kernel:${TAG}`,
  // Phase 4 (#893) retired the singleton scheduler image. Keeping it
  // here would make `imagesOk` false in any environment that doesn't
  // build the (now-deleted) image, silently skipping this whole suite.
};

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
const allImagesPresent =
  dockerOk &&
  Object.values(IMAGES).every((ref) => hasImage(ref));

describe.skipIf(!dockerOk || !allImagesPresent)(
  "phase1b docker images — E2E (skipped when docker / images unavailable)",
  () => {
    it("base image has node, bun, tini, tmux, claude on PATH", () => {
      // dash's `command -v` only accepts one arg, so loop in shell.
      // Use spawnSync with explicit argv so neither the host shell nor
      // the JS template literal mangles `$c` before it reaches dash.
      const r = spawnSync(
        "docker",
        [
          "run", "--rm", ...LABELS_ARGV, "--entrypoint", "sh", IMAGES.base, "-c",
          'for c in node bun tini tmux claude; do command -v "$c" || echo "MISSING:$c"; done',
        ],
        { encoding: "utf8" },
      );
      const out = r.stdout;
      expect(out).not.toMatch(/^MISSING:/m);
      expect(out).toMatch(/\/node\b/);
      expect(out).toMatch(/\/bun\b/);
      expect(out).toMatch(/\/tini\b/);
      expect(out).toMatch(/\/tmux\b/);
      expect(out).toMatch(/claude/);
    });

    it("broker image's bundled server.js boots and stays alive (binds sockets, doesn't exit)", () => {
      // Phase 1b review fix: the prior version of this test only asserted
      // the module imported cleanly — it never started the broker, so a
      // missing main()/entry-guard (which would have made the production
      // CMD a no-op) would still pass. We now actually start the
      // container and verify the process stays running for 2s — long
      // enough for the listen() callbacks to fire and any synchronous
      // boot error to propagate via container exit.
      //
      // We mount a tmpfs over /run/switchroom/broker so the bundle's
      // mkdir/bind sequence has a writable target, and supply a minimal
      // switchroom.yaml via SWITCHROOM_CONFIG so loadConfig() resolves.
      // The vault file doesn't need to exist — the broker stays locked
      // and that's fine for "did it bind sockets and stay up" assertion.
      const tmp = mkdtempSync(join(tmpdir(), "broker-e2e-"));
      const cfgPath = join(tmp, "switchroom.yaml");
      writeFileSync(
        cfgPath,
        [
          "switchroom:",
          "  version: 1",
          "  agents_dir: /tmp/agents",
          "  skills_dir: /tmp/skills",
          "telegram:",
          "  bot_token: xxx",
          "  forum_chat_id: \"-1001234567890\"",
          "vault:",
          "  path: /tmp/vault.enc",
          "agents: {}",
          "",
        ].join("\n"),
      );

      const containerName = `broker-e2e-${process.pid}-${Date.now()}`;
      try {
        // Start detached. Mount config read-only, tmpfs the socket dir
        // (writable, root-owned per Dockerfile.broker), and override the
        // CMD-default socket path to a known location.
        execSync(
          [
            "docker run -d",
            `--name ${containerName}`,
            LABELS,
            "--tmpfs /run/switchroom/broker:rw,mode=755",
            `-v ${cfgPath}:/state/config/switchroom.yaml:ro`,
            "-e SWITCHROOM_CONFIG=/state/config/switchroom.yaml",
            "-e SWITCHROOM_BROKER_SOCKET=/run/switchroom/broker/vault-broker.sock",
            IMAGES.broker,
          ].join(" "),
          { stdio: "pipe" },
        );

        // Sleep 2s — enough for listen() to fire OR for a synchronous
        // boot error to crash the container (whichever happens first).
        execSync("sleep 2");

        const running = execSync(
          `docker inspect -f '{{.State.Running}}' ${containerName}`,
        )
          .toString()
          .trim();

        if (running !== "true") {
          // Surface logs in the assertion failure for forensics.
          const logs = (() => {
            try {
              return execSync(`docker logs ${containerName} 2>&1`).toString();
            } catch {
              return "<docker logs failed>";
            }
          })();
          throw new Error(`broker container exited within 2s. logs:\n${logs}`);
        }
        expect(running).toBe("true");

        // Confirm the data socket actually showed up at the configured
        // path (proves listen() ran, not just "process is alive sleeping").
        const lsOut = execSync(
          `docker exec ${containerName} ls -l /run/switchroom/broker/vault-broker.sock`,
        ).toString();
        expect(lsOut).toMatch(/vault-broker\.sock/);
      } finally {
        try {
          execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
        } catch {
          /* best effort */
        }
      }
    });

    // scheduler-image test removed in #893 (Phase 4 cron-fold-in
    // cutover). better-sqlite3 prebuilt-binary loading is now exercised
    // inside the agent image via the bundled agent-scheduler sidecar.

    it("agent image enforces read-only rootfs (touch /etc/passwd → EROFS)", () => {
      // Run as root inside the container so DAC permission isn't what
      // stops us. The agent image now defaults to USER 10001 (WS6-F5,
      // #1435) — without --user 0 the touch fails with EACCES at the
      // DAC layer before the kernel ever consults rootfs-readonly,
      // making this test assert on the wrong layer of defense. The
      // property under test is "the runtime --read-only flag prevents
      // even root from writing to the rootfs", which is what compose
      // gives every agent in production.
      const r = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          ...LABELS_ARGV,
          "--user",
          "0",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs",
          "/tmp:rw,size=64m,mode=1777",
          "--entrypoint",
          "sh",
          IMAGES.agent,
          "-c",
          "touch /etc/passwd",
        ],
        { encoding: "utf8" },
      );
      // The shell exits non-zero. The stderr should mention read-only fs.
      expect(r.status).not.toBe(0);
      expect(`${r.stderr}${r.stdout}`).toMatch(/read-only file system/i);
    });

    it("base image resolves an agent UID via /etc/passwd (whoami / id / pwd.getpwuid all work)", () => {
      // Layer 1 followup: agent containers run with UIDs 10001..10999 from
      // src/agents/compose.ts:allocateAgentUid. Without /etc/passwd entries
      // for that range, whoami fails, getpass.getuser() raises KeyError, and
      // git complains about unknown identity. The base Dockerfile bakes
      // 999 entries; this test pins both ends of the range plus the middle.
      for (const uid of [10001, 10500, 10999]) {
        const r = spawnSync(
          "docker",
          [
            "run", "--rm", ...LABELS_ARGV,
            "--user", String(uid),
            "--entrypoint", "sh", IMAGES.base, "-c",
            // whoami exits non-zero if no passwd entry; getent passwd
            // confirms the entry shape. Use a fully-shell-quoted body so
            // neither the host shell nor the JS template literal mangles
            // the substitution.
            `whoami && getent passwd ${uid} && python3 -c 'import pwd; print(pwd.getpwuid(${uid}).pw_name)'`,
          ],
          { encoding: "utf8" },
        );
        expect(r.status, `uid=${uid} stderr=${r.stderr}`).toBe(0);
        expect(r.stdout).toContain(`agent${uid}`);
      }
    });

    it("agent image gives uid 10001 a writable HOME at /state/agent/home (Layer 1)", () => {
      // The whole point of Layer 1: HOME points inside the bind-mount
      // root rather than the read-only "/" that an unmapped UID gets by
      // default. We can't test the bind mount in isolation here (this
      // test runs the bare image, not via compose), so we mount a tmpfs
      // at /state/agent and confirm HOME=$path-on-tmpfs is writable
      // when set in env. Compose itself is exercised by the
      // compose-generator tests; this asserts the *image* end of the
      // contract — that an unmapped UID + read-only root + an explicit
      // HOME env still produces a write-capable shell.
      const r = spawnSync(
        "docker",
        [
          "run", "--rm", ...LABELS_ARGV,
          "--read-only",
          "--user", "10001",
          "--tmpfs", "/state/agent:rw,uid=10001,mode=755",
          "--tmpfs", "/tmp:rw,size=16m,mode=1777",
          "-e", "HOME=/state/agent/home",
          "--entrypoint", "sh", IMAGES.agent, "-c",
          'mkdir -p "$HOME" && touch "$HOME/.gitconfig" && echo OK',
        ],
        { encoding: "utf8" },
      );
      expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
      expect(r.stdout).toContain("OK");
    });

    it("base image has Tier 1 tools on PATH (gh, ripgrep, fd, jq, pip, git, less, nano)", () => {
      // Pin the Tier 1 list — anything missing here is a regression in
      // docker/Dockerfile.base. These are the tools Claude reaches for
      // in the first 10 turns of a typical session; failing to install
      // them in base forces every agent to wait 30+s on apt-get on
      // first use, which torpedoes the boot-card "ready" promise.
      const r = spawnSync(
        "docker",
        [
          "run", "--rm", ...LABELS_ARGV, "--entrypoint", "sh", IMAGES.base, "-c",
          'for c in gh rg fd jq pip3 git less nano dig ping nc tree file; do command -v "$c" || echo "MISSING:$c"; done',
        ],
        { encoding: "utf8" },
      );
      expect(r.status, `stderr=${r.stderr}`).toBe(0);
      expect(r.stdout).not.toMatch(/^MISSING:/m);
    });

    it("agent image with cap_drop=ALL blocks mount (mount -t tmpfs → EPERM)", () => {
      // Run as root inside the container so the test exercises the
      // capability-drop defense rather than the DAC "must be superuser"
      // shortcut. The agent image now defaults to USER 10001
      // (WS6-F5, #1435); without --user 0 mount(8) refuses before the
      // kernel ever consults capabilities, making the assertion lie
      // about which layer of defense is being verified. cap_drop=ALL
      // is what compose gives every agent in production, so this is
      // what we actually want to prove.
      const r = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          ...LABELS_ARGV,
          "--user",
          "0",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs",
          "/tmp",
          "--entrypoint",
          "sh",
          IMAGES.agent,
          "-c",
          "mount -t tmpfs none /mnt",
        ],
        { encoding: "utf8" },
      );
      expect(r.status).not.toBe(0);
      // mount(8) prints "permission denied" when CAP_SYS_ADMIN is missing.
      expect(`${r.stderr}${r.stdout}`).toMatch(/permission denied|operation not permitted/i);
    });
  },
);

describe.skipIf(dockerOk && allImagesPresent)(
  "phase1b docker images — sentinel (visible when E2E was skipped)",
  () => {
    it("documents skip reason", () => {
      // Surfaces in the vitest report so a developer running locally
      // knows WHY the E2E suite didn't run.
      const reason = !dockerOk
        ? "docker daemon unreachable"
        : "phase1b-test images not built — run `bash tests/docker/build-images.sh` first";
      expect(reason).toMatch(/docker|phase1b/);
    });
  },
);
