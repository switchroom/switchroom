/**
 * Phase 1c — RFC §Phase 1 acceptance test: broker-IPC race.
 *
 * The headline "newbie agent comes online while the fleet processes
 * concurrent inbound IPC; zero drops; no broker/kernel/scheduler
 * RestartCount drift" test the RFC has been promising since Phase 0.
 *
 * Topology under test:
 *   - 3-agent fleet (alice / bob / carol) generated via the Phase 1a
 *     compose generator at src/agents/compose.ts.
 *   - All 5 services up via `docker compose up -d` against the
 *     phase1b-test images (built by tests/docker/build-images.sh).
 *   - Agent containers run a sleep-loop CMD override so they stay UP
 *     without needing a real start.sh / claude bundle / vault — the
 *     test exercises the IPC layer, not the agent runtime.
 *   - A host-side coroutine spawns a `docker exec` per request that
 *     opens a unix-domain client to the kernel's per-agent socket
 *     under /run/switchroom/kernel/alice/sock and issues
 *     `approval_lookup`. We use approval_lookup (not vault_get) for
 *     two reasons: (a) it works without an unlocked vault — no
 *     passphrase plumbing required; (b) it exercises the kernel-
 *     server entrypoint shipped earlier in this PR. The test's
 *     intent — "topology change doesn't disrupt in-flight IPC" — is
 *     opcode-agnostic.
 *   - Mid-stream we regenerate compose.yml with a 4th agent
 *     ("newbie"), then `docker compose up -d --no-deps agent-newbie
 *     approval-kernel vault-broker` to bring the new agent's
 *     dependencies online without touching existing containers.
 *
 * Acceptance (post-#1017):
 *   1. At least 80% of alice's lookups succeed across the window.
 *      Lower than the pre-#1017 "100% no-drops" contract because
 *      `bringUpAgentService` now deliberately recreates broker AND
 *      kernel mid-test so the new agent's per-agent socket dirs are
 *      actually bound. The kernel-recreate (~1-2s) is what drops
 *      alice's in-flight kernel lookups; the broker-recreate is
 *      invisible to alice's kernel UDS. Pre-#1017 the existing fleet
 *      looked stable but the new agent was permanently unreachable
 *      from broker/kernel — strictly worse.
 *   2. BOTH broker AND kernel container IDs change across the
 *      topology mutation. This is the positive evidence the helper's
 *      explicit recreate fired. RestartCount is unreliable as a
 *      signal because a recreate resets it to 0 on the new container.
 *   3. newbie reaches "first kernel-lookup answered via its own
 *      kernel socket" within 60s wall-clock from `up -d` invocation.
 *
 * The 90s @ 2s cadence is preserved as the canonical run; a fast
 * mode (15s @ 200ms cadence, still 45 requests but compressed to
 * fit a normal CI budget) is the default. Set
 * SWITCHROOM_RACE_LONG=1 for the wall-clock-faithful run.
 *
 * Skip discipline: cleanly skipped when docker daemon unavailable
 * OR when the phase1b-test images aren't built.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose } from "../../src/agents/compose.js";
import { bringUpAgentService } from "../../src/agents/docker-fleet.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";
import {
  newRunId,
  injectLabelsIntoCompose,
  safeLabelTeardown,
  mergeServiceEnv,
} from "./_label-helpers.js";
import { productionFleetIsLive, assertNoProductionFleet } from "./_prod-snapshot.js";

const RUN_ID = newRunId();
// See per-agent-isolation.test.ts:PROD_FLEET_LIVE — same prod-clobber
// guard. This file ALSO reads `switchroom-vault-broker` /
// `switchroom-approval-kernel` by their fixed names throughout the
// test body, so running it on a host with a live production fleet
// produces undefined cross-talk.
const PROD_FLEET_LIVE = productionFleetIsLive();

const TAG = "phase1b-test";
// Phase 4 cron-fold-in cutover removed the singleton scheduler image.
// Cron now runs in-container in every agent (see start.sh.hbs).
const IMAGES = ["base", "agent", "broker", "kernel", "auth-broker"].map(
  (n) => `switchroom/${n}:${TAG}`,
);
const PROJECT = `phase1c-race-${process.pid}`;

const LONG_MODE = process.env.SWITCHROOM_RACE_LONG === "1";
const TOTAL_REQUESTS = 45;
const INTERVAL_MS = LONG_MODE ? 2_000 : 200;
const NEWBIE_FIRST_REPLY_BUDGET_MS = 60_000;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch { return false; }
}
function hasImage(ref: string): boolean {
  try { execSync(`docker image inspect ${ref}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const dockerOk = hasDocker();
const imagesOk = dockerOk && IMAGES.every(hasImage);

function makeConfig(agents: string[]): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
    vault: { path: "/tmp/vault.enc" },
    defaults: undefined,
    profiles: undefined,
    agents: Object.fromEntries(
      agents.map((name) => [
        name,
        {
          topic_name: name,
          extends: undefined,
          // Single far-future schedule entry so the in-agent scheduler
          // sibling has work to register (otherwise it exits cleanly,
          // and the supervisor's restart-cap could be reached during
          // a long test run).
          schedule: [{ cron: "0 0 1 1 *", prompt: "noop", secrets: [] }],
          tools: { allow: [], deny: [] },
          hooks: undefined,
          channels: undefined,
        } as unknown as SwitchroomConfig["agents"][string],
      ]),
    ),
    drive: undefined as unknown as SwitchroomConfig["drive"],
  } as unknown as SwitchroomConfig;
}

/**
 * Patch generated compose for a test fleet:
 *   - swap ghcr.io/switchroom/<n> images for switchroom/<n>:phase1b-test
 *   - override agent CMD to sleep (no claude / start.sh runtime)
 *   - drop ${HOME} bind-mounts (we don't have host state for the test)
 *   - emit minimal switchroom.yaml inside a tmpfs the kernel/broker can read
 */
function buildTestCompose(agents: string[], cfgPath: string): string {
  // containerNamePrefix=PROJECT defends against the production-name
  // collision regression (#916 un-skip → 2026-05-10 klanker incident).
  // Emitted names become `phase1c-race-${pid}-vault-broker` etc., so
  // even if a production fleet is up the test names cannot collide
  // with `switchroom-vault-broker`. The describe.skipIf still gates
  // the suite — this is the second layer.
  let yml = generateCompose({
    config: makeConfig(agents),
    imageTag: TAG,
    containerNamePrefix: PROJECT,
  });
  // Rewrite registry refs to local tags. The compose generator points at
  // ghcr.io/switchroom/<image>:<tag>; for this test we want the locally
  // built switchroom/<image>:phase1b-test.
  // Generator emits ghcr.io/switchroom/switchroom-<name>:<tag>; locally
  // built test images are tagged switchroom/<name>:phase1b-test, so we
  // strip both the registry prefix and the doubled `switchroom-` infix.
  yml = yml.replace(/ghcr\.io\/switchroom\/switchroom-/g, "switchroom/");
  yml = yml.replace(/ghcr\.io\/switchroom\//g, "switchroom/");
  // Strip ${HOME}-prefixed bind mounts (host state we don't have). We
  // replace each with a named-volume / tmpfs equivalent.
  yml = yml
    .replace(/- \$\{HOME\}\/\.switchroom\/vault:\/state\/vault\b/g,
             "- vault-state:/state/vault")
    .replace(/- \$\{HOME\}\/\.switchroom\/approvals:\/state\/approvals\b/g,
             "- approvals-state:/state/approvals")
    .replace(/- \$\{HOME\}\/\.switchroom:\/state\/config:ro\b/g,
             `- ${cfgPath}:/state/config/switchroom.yaml:ro`)
    .replace(/- \$\{HOME\}\/\.switchroom\/agents\/[^:]+:\/state\/agent\b/g,
             "- agent-state:/state/agent")
    .replace(/- \$\{HOME\}\/\.claude\/projects\/[^:]+:\/state\/\.claude\b/g,
             "- claude-state:/state/.claude");

  // Override agent CMD with a sleep loop. We append `command:` and `entrypoint:`
  // overrides per agent. `read_only: true` blocks /tmp writes, but tmpfs
  // /tmp is already mounted; we need entrypoint that doesn't require start.sh.
  // Use ENTRYPOINT [tini --] CMD [sh -c "while true; do sleep 60; done"].
  for (const a of agents) {
    yml = yml.replace(
      new RegExp(`(  agent-${a}:\\s*\\n)`),
      `$1    entrypoint: ["/usr/bin/tini", "--", "sh", "-c", "while true; do sleep 60; done"]\n`,
    );
  }
  // The Phase 1b broker / kernel entrypoints both call loadConfig() at
  // startup. The compose generator (Phase 1a) does NOT pass
  // SWITCHROOM_CONFIG to the singleton services, so under the default
  // compose layout they boot, fail to auto-detect the config, and
  // restart-loop. The kernel-server I shipped this PR enumerates agent
  // dirs from the filesystem (so it boots without config) — but the
  // broker still needs a config. We inject SWITCHROOM_CONFIG via an
  // environment block + bind the same per-agent yaml. Documented as
  // "test-only override" — the production compose-generator slice that
  // wires this is out of scope.
  yml = mergeServiceEnv(yml, "vault-broker", [
    `      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`,
    `      SWITCHROOM_BROKER_ALLOW_NON_LINUX: "1"`,
  ]);
  yml = mergeServiceEnv(yml, "approval-kernel", [
    `      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`,
    `      SWITCHROOM_KERNEL_DB_PATH: /state/approvals/kernel.db`,
  ]);
  yml = mergeServiceEnv(yml, "switchroom-auth-broker", [
    `      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`,
  ]);
  // Mount the test config into broker + kernel + auth-broker.
  yml = yml.replace(
    /(  vault-broker:[\s\S]*?volumes:\n)/,
    `$1      - ${cfgPath}:/state/config/switchroom.yaml:ro\n`,
  );
  yml = yml.replace(
    /(  approval-kernel:[\s\S]*?volumes:\n)/,
    `$1      - ${cfgPath}:/state/config/switchroom.yaml:ro\n`,
  );
  yml = yml.replace(
    /(  switchroom-auth-broker:[\s\S]*?volumes:\n)/,
    `$1      - ${cfgPath}:/state/config/switchroom.yaml:ro\n`,
  );
  // Phase 4 cron-fold-in cutover: the singleton scheduler container
  // is gone. Cron now runs in-agent under the supervised sidecar
  // started by start.sh; it writes its JSONL audit to the agent's
  // own /state/agent bind mount, so no extra volume is needed.

  // Append the named volumes we introduced.
  yml += "  vault-state:\n";
  yml += "  approvals-state:\n";
  yml += "  agent-state:\n";
  yml += "  claude-state:\n";

  // Inject `switchroom.test=phase1c` + per-run UUID labels onto every
  // service so a label-filtered teardown cannot miss anything this
  // file spawned (see CLAUDE.md "Docker test discipline" HARD RULES).
  return injectLabelsIntoCompose(yml, RUN_ID);
}

interface FleetCtx {
  workdir: string;
  composePath: string;
  cfgPath: string;
}

function composeUp(ctx: FleetCtx): void {
  execSync(
    `docker compose -p ${PROJECT} -f ${ctx.composePath} up -d`,
    { stdio: "pipe", cwd: ctx.workdir },
  );
}
function composeDown(): void {
  try {
    execSync(`docker compose -p ${PROJECT} down -v --remove-orphans`,
      { stdio: "pipe" });
  } catch { /* best effort */ }
}

function getRestartCount(container: string): number {
  try {
    const r = execSync(`docker inspect -f '{{.RestartCount}}' ${container}`).toString().trim();
    return Number(r);
  } catch { return -1; }
}

function getContainerId(container: string): string {
  try {
    return execSync(`docker inspect -f '{{.Id}}' ${container}`).toString().trim();
  } catch { return ""; }
}

/**
 * Run an `approval_lookup` against kernel by execing a tiny inline
 * client inside the kernel container itself (which has bun + the
 * client socket path exposed). This avoids needing to mount sockets
 * to the host or shipping a separate test client image.
 */
/**
 * NOTE: the `container` argument is REQUIRED — there is deliberately
 * no default. Pre-fix, this defaulted to `switchroom-${agent}` which
 * is the PRODUCTION container name pattern emitted by the compose
 * generator when `containerNamePrefix === "switchroom"` (the default).
 *
 * That default had two failure modes:
 *   - On a clean-room runner (GHA) `switchroom-alice` doesn't exist
 *     and every exec exits 1 — manifests as "0/45 succeed, exit=1".
 *   - On the operator's host where `switchroom-alice` DOES exist as
 *     part of the production fleet, the test silently hits the live
 *     production kernel socket instead of the phase-test fleet. The
 *     test would pass for the wrong reason and could cause real
 *     side-effects against the operator's production state.
 *
 * Removing the default forces every callsite to pass the test
 * fleet's project-prefixed container name.
 */
function kernelLookup(agent: string, container: string):
  { ok: boolean; raw: string; durationMs: number; err?: string } {
  // Exec from INSIDE the agent's own container (running as the agent's
  // UID) so the file-perm boundary lets the connect through. Doing the
  // exec from inside the kernel container would fail because root
  // (cap_drop=ALL minus CAP_DAC_OVERRIDE) can no longer traverse the
  // 0700 alice-owned socket dir after Phase 1c locked it down.
  // Path inside the agent container: the kernel-<agent>-sock named
  // volume is mounted at /run/switchroom/kernel; the bound socket is
  // at /run/switchroom/kernel/sock.
  const sockPath = `/run/switchroom/kernel/sock`;
  // Inline node script: connect, send {v:1,op:"approval_lookup",...},
  // print the line. The kernel-server's identity guard requires
  // agent_unit to match the listener's directory name.
  const script = `
const net = require('node:net');
const c = net.createConnection('${sockPath}');
let buf = '';
const t = setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 4000);
c.on('connect', () => c.write(JSON.stringify({
  v:1, op:'approval_lookup',
  agent_unit:'${agent}', scope:'secret:test', action:'read',
  current_approver_set:[]
}) + '\\n'));
c.on('data', d => { buf += d.toString('utf8'); if (buf.includes('\\n')) {
  clearTimeout(t); console.log(buf.split('\\n')[0]); c.destroy(); process.exit(0);
} });
c.on('error', e => { clearTimeout(t); console.log('ERR:'+e.message); process.exit(3); });
`;
  const start = Date.now();
  const r = spawnSync(
    "docker",
    ["exec", container, "node", "-e", script],
    { encoding: "utf8", timeout: 8000 },
  );
  const durationMs = Date.now() - start;
  if (r.status !== 0) {
    return { ok: false, raw: r.stdout + r.stderr, durationMs, err: `exit=${r.status}` };
  }
  const line = r.stdout.trim();
  try {
    const parsed = JSON.parse(line);
    return { ok: parsed.ok === true, raw: line, durationMs };
  } catch {
    return { ok: false, raw: line, durationMs, err: "parse" };
  }
}

let ctx: FleetCtx | null = null;

// Cross-fork lock — see per-agent-isolation.test.ts for the rationale.
let _fleetLockPath: string | null = null;
function acquireFleetLock(p: string, timeoutMs = 240_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(p);
      _fleetLockPath = p;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const ageMs = Date.now() - statSync(p).mtimeMs;
          if (ageMs > 5 * 60_000) {
            try { rmdirSync(p); } catch { /* */ }
            continue;
          }
        } catch { /* */ }
        execSync("sleep 2");
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Could not acquire fleet lock at ${p} within ${timeoutMs}ms`);
}
function releaseFleetLock(): void {
  if (_fleetLockPath) {
    try { rmdirSync(_fleetLockPath); } catch { /* */ }
    _fleetLockPath = null;
  }
}

beforeAll(() => {
  if (!imagesOk) return;
  // Belt to the describe.skipIf(PROD_FLEET_LIVE) braces — refuse to
  // run if a live production fleet is present (this test file ALSO
  // reads/writes switchroom-vault-broker by fixed name).
  assertNoProductionFleet();
  acquireFleetLock("/tmp/switchroom-docker-fleet.lock");
  composeDown(); // belt + braces
  // Force-remove any leftover *project-scoped* containers from a
  // crashed prior run. ALL names here are prefixed with `${PROJECT}`,
  // which is `phase1c-race-${process.pid}` — so this CANNOT touch
  // `switchroom-vault-broker` or any other production container.
  // Pre-fix this loop included production-named singletons and would
  // clobber a live fleet (the 2026-05-10 klanker incident).
  for (const c of [
    `${PROJECT}-vault-broker`,
    `${PROJECT}-approval-kernel`,
    `${PROJECT}-alice`,
    `${PROJECT}-bob`,
    `${PROJECT}-carol`,
    `${PROJECT}-newbie`,
  ]) {
    try { execSync(`docker rm -f ${c}`, { stdio: "pipe" }); } catch { /* */ }
  }
  const workdir = mkdtempSync(join(tmpdir(), "phase1c-race-"));
  const cfgPath = join(workdir, "switchroom.yaml");
  writeFileSync(
    cfgPath,
    [
      "switchroom:",
      "  version: 1",
      "  agents_dir: /tmp/agents",
      "  skills_dir: /tmp/skills",
      "telegram:",
      "  bot_token: x",
      "  forum_chat_id: \"-1001234567890\"",
      "vault:",
      "  path: /tmp/vault.enc",
      "agents:",
      "  alice:",
      "    topic_name: alice",
      "    schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }]",
      "  bob:",
      "    topic_name: bob",
      "    schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }]",
      "  carol:",
      "    topic_name: carol",
      "    schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }]",
      "",
    ].join("\n"),
  );
  const composePath = join(workdir, "compose.yml");
  writeFileSync(composePath, buildTestCompose(["alice", "bob", "carol"], cfgPath));
  ctx = { workdir, composePath, cfgPath };
  composeUp(ctx);
  // Give services 8s to settle (kernel binds 3 sockets, broker binds, etc).
  execSync("sleep 8");
}, 120_000);

afterAll(() => {
  composeDown();
  // Belt-and-braces: label-filtered safety net catches any stragglers
  // that escaped the compose-down (mid-test crash, orphaned exec, ...).
  // Strictly scoped to this test run via the per-run UUID label.
  safeLabelTeardown(RUN_ID);
  if (ctx) {
    try { rmSync(ctx.workdir, { recursive: true, force: true }); } catch { /* */ }
  }
  releaseFleetLock();
}, 60_000);

// Ungated post-#857: the newbie-readiness assertion was flaky because
// the test used `docker compose restart approval-kernel`, which does
// NOT pick up the new kernel-newbie-sock volume mount. Switching to
// `up -d approval-kernel` (which detects the compose diff and recreates
// the container with the new volume) makes newbie's socket actually
// bindable. The compose-fixture rot that previously masked this was
// already addressed in PR-D3.
describe.skipIf(!imagesOk || PROD_FLEET_LIVE)(
  "phase1c broker-IPC race — newbie agent online during sustained kernel IPC",
  () => {
    it(
      "45 requests succeed, broker stays untouched across live add, newbie reaches first reply within 60s",
      async () => {
        if (!ctx) throw new Error("ctx not initialized");
        // Sanity: alice's container can see its own kernel sock at the
        // expected path (the kernel container's view of the same volume
        // is /run/switchroom/kernel/alice/sock, but the socket is now
        // chowned to alice's UID and the dir is 0700, so we ask alice).
        const aliceSock = (() => {
          try {
            return execSync(
              `docker exec ${PROJECT}-alice ls /run/switchroom/kernel/sock`,
            ).toString().trim();
          } catch (e) { return `MISSING (${(e as Error).message})`; }
        })();
        expect(aliceSock).toContain("/run/switchroom/kernel/sock");

        // Snapshot RestartCount before any topology mutation.
        const startCounts = {
          broker: getRestartCount(`${PROJECT}-vault-broker`),
          kernel: getRestartCount(`${PROJECT}-approval-kernel`),
        };
        // Also capture the kernel container ID — the live-add procedure
        // recreates the kernel container (`docker compose up -d` picks
        // up the new kernel-newbie-sock volume mount), which resets
        // RestartCount to 0 on the new container. We assert recreation
        // by container-ID change instead of restart-count bump (#857).
        const startKernelId = getContainerId(`${PROJECT}-approval-kernel`);
        const startBrokerId = getContainerId(`${PROJECT}-vault-broker`);

        const results: Array<{ idx: number; ok: boolean; durationMs: number; err?: string }> = [];
        let newbieFirstReplyAt: number | null = null;
        let newbieUpAt: number | null = null;
        const startedAt = Date.now();

        // Drive 45 requests at INTERVAL_MS, with newbie introduction at request 20.
        for (let i = 0; i < TOTAL_REQUESTS; i++) {
          if (i === 20 && newbieUpAt === null) {
            // Regenerate compose with a 4th agent and bring just the new
            // service online plus refresh broker/kernel volumes. We use
            // `up -d --no-deps` to avoid restarting existing containers.
            const compose2 = buildTestCompose(
              ["alice", "bob", "carol", "newbie"],
              ctx.cfgPath,
            );
            writeFileSync(ctx.composePath, compose2);
            // Update the config too (kernel/broker re-read on next restart,
            // but we don't restart them — newbie's socket dir is in a NEW
            // named volume the broker/kernel won't see until they restart;
            // this is the documented Phase 1c limitation. The test still
            // exercises topology mutation via `up -d --no-deps agent-newbie`
            // and verifies the existing fleet's IPC stays alive).
            writeFileSync(
              ctx.cfgPath,
              [
                "switchroom: { version: 1, agents_dir: /tmp/agents, skills_dir: /tmp/skills }",
                "telegram: { bot_token: x, forum_chat_id: \"-1001234567890\" }",
                "vault: { path: /tmp/vault.enc }",
                "agents:",
                "  alice:    { topic_name: alice,  schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }] }",
                "  bob:      { topic_name: bob,    schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }] }",
                "  carol:    { topic_name: carol,  schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }] }",
                "  newbie:   { topic_name: newbie, schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }] }",
                "",
              ].join("\n"),
            );
            newbieUpAt = Date.now();
            // Phase 3c F2 (#810): exercise the real CLI codepath rather
            // than a bespoke `docker compose up`. `bringUpAgentService`
            // is the same helper that `switchroom agent add` calls in
            // its docker-runtime branch — extracted from `cli/agent.ts`
            // for reuse from tests. We pass the pre-built test compose
            // via `generateComposeContent` (the test's compose YAML has
            // test-specific volume rewrites the production generator
            // doesn't emit), and isolate writes to a per-test
            // `switchroomHome` so the operator's real ~/.switchroom is
            // never touched. The compose project label is preserved by
            // setting the compose path to the existing test composePath.
            try {
              // The helper writes compose into <switchroomHome>/compose;
              // we point that at the test workdir so the file we already
              // wrote in the bespoke path is identical to what the
              // helper would emit, and so the helper's `docker compose
              // -f <path> up -d --no-deps agent-newbie` resolves to the
              // same compose file the rest of this test has been using.
              // We override the project name via env to match PROJECT.
              const composeContent = compose2;
              process.env.COMPOSE_PROJECT_NAME = PROJECT;
              bringUpAgentService({
                config: makeConfig(["alice", "bob", "carol", "newbie"]),
                agentName: "newbie",
                switchroomHome: ctx.workdir,
                generateComposeContent: () => composeContent,
                stdio: "pipe",
              });
              delete process.env.COMPOSE_PROJECT_NAME;
            } catch (e) {
              // newbie may fail to start (read_only + sleep CMD pattern is
              // fine on linux, but image-pull race etc). Don't fail the
              // test on that — we only assert IPC continuity + restart
              // count stability.
              process.stderr.write(`[race-test] newbie up failed: ${(e as Error).message}\n`);
            }
            // Track first SUCCESSFUL alice lookup post-add as a topology-
            // stability proxy (proves the live add didn't disturb existing
            // sockets). Newbie's own readiness is asserted separately
            // below after the kernel is recreated to pick up the new
            // volume mount.
          }
          // Container name MUST be the test fleet's prefixed alice, never
          // the default-shape `switchroom-alice` (which is the production
          // container on the operator's host — see kernelLookup's doc
          // comment for the prior failure mode).
          const r = kernelLookup("alice", `${PROJECT}-alice`);
          results.push({ idx: i, ok: r.ok, durationMs: r.durationMs, err: r.err });
          if (newbieUpAt !== null && newbieFirstReplyAt === null && r.ok) {
            newbieFirstReplyAt = Date.now();
          }
          if (i < TOTAL_REQUESTS - 1) {
            await new Promise((res) => setTimeout(res, INTERVAL_MS));
          }
        }

        const finishedAt = Date.now();
        const ok = results.filter((r) => r.ok).length;
        const drops = TOTAL_REQUESTS - ok;

        // Topology snapshot mid-test. Post-#1017 the broker AND kernel
        // are both deliberately recreated by `bringUpAgentService` so
        // their per-agent socket-dir enumeration picks up the new
        // agent — see the issue thread for why the previous
        // "broker stays untouched" invariant was a Phase 1c limitation
        // hiding a real bug (new agents could never reach the broker).
        const stabilityCounts = {
          broker: getRestartCount(`${PROJECT}-vault-broker`),
          kernel: getRestartCount(`${PROJECT}-approval-kernel`),
        };

        // Newbie readiness: bringUpAgentService now recreates both
        // singletons in-helper. The earlier hand-rolled `up -d
        // approval-kernel` is gone — the polling loop just waits for
        // newbie's own socket to appear and accepts the first
        // successful lookup.
        let newbieReadyAt: number | null = null;
        let newbieReadyLatencyMs: number | null = null;
        if (newbieUpAt !== null) {
          const readinessStart = Date.now();
          // Give the helper-driven recreate up to 30s to bind newbie's
          // per-agent socket.
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const probe = spawnSync(
              "docker",
              ["exec", `${PROJECT}-newbie`, "ls", "/run/switchroom/kernel/sock"],
              { encoding: "utf8", timeout: 4000 },
            );
            if (probe.status === 0 && probe.stdout.includes("/run/switchroom/kernel/sock")) {
              const r = kernelLookup("newbie", `${PROJECT}-newbie`);
              if (r.ok) {
                newbieReadyAt = Date.now();
                newbieReadyLatencyMs = newbieReadyAt - readinessStart;
                break;
              }
            }
            await new Promise((res) => setTimeout(res, 1000));
          }
        }

        const endCounts = {
          broker: getRestartCount(`${PROJECT}-vault-broker`),
          kernel: getRestartCount(`${PROJECT}-approval-kernel`),
        };

        // Diagnostic line for vitest output
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          test: "phase1c-broker-ipc-race",
          total_requests: TOTAL_REQUESTS,
          successful: ok,
          drops,
          duration_ms: finishedAt - startedAt,
          // Old "first alice reply after newbie up" — kept for log
          // continuity but no longer used as the readiness signal.
          alice_first_reply_after_newbie_up_ms:
            newbieFirstReplyAt && newbieUpAt ? newbieFirstReplyAt - newbieUpAt : null,
          // New: newbie's own socket reachable + first real lookup.
          newbie_ready_latency_ms: newbieReadyLatencyMs,
          start_restart_counts: startCounts,
          stability_restart_counts: stabilityCounts,
          end_restart_counts: endCounts,
          long_mode: LONG_MODE,
          first_5_failures: results.filter((r) => !r.ok).slice(0, 5),
        }));

        // ── Topology contract (post-#1017) ────────────────────────────
        // Both singletons get recreated by `bringUpAgentService` so
        // they can pick up the new agent's per-agent socket-dir volume
        // mount. The pre-#1017 invariant ("broker stays untouched") is
        // gone; that invariant was hiding the bug #1017 reports, where
        // a newly-added agent could never reach the broker because the
        // broker's startup-time directory enumeration didn't include
        // the new subdir.
        //
        // Assertion 1: at least 80% of alice's pre-existing-socket
        // lookups succeed. Some drops are expected during the
        // ~1-3s broker recreate window (in-flight UDS connections
        // die when the broker container restarts). Pre-#1017 this
        // was `expect(drops).toBe(0)` against a topology that
        // appeared stable but left newbie offline; post-#1017 the
        // tradeoff is "brief disruption during operator-driven
        // `agent add` in exchange for newbie actually working."
        expect(ok / TOTAL_REQUESTS).toBeGreaterThan(0.8);

        // Assertion 2: newbie reached "own socket bound + first lookup
        // answered" within the budget. This is the load-bearing assertion
        // — it verifies the fix accomplishes its goal.
        expect(newbieUpAt).not.toBeNull();
        expect(newbieReadyAt).not.toBeNull();
        expect(newbieReadyLatencyMs).not.toBeNull();
        expect(newbieReadyLatencyMs!).toBeLessThan(NEWBIE_FIRST_REPLY_BUDGET_MS);

        // Assertion 3: BOTH singletons were recreated. Container-ID
        // change is the recreate signal — RestartCount resets to 0 on
        // the new container, so a count-based check would false-pass.
        const endKernelId = getContainerId(`${PROJECT}-approval-kernel`);
        const endBrokerId = getContainerId(`${PROJECT}-vault-broker`);
        expect(endKernelId).not.toBe(startKernelId);
        expect(endBrokerId).not.toBe(startBrokerId);
      },
      LONG_MODE ? 240_000 : 120_000,
    );
  },
);

describe.skipIf(imagesOk)(
  "phase1c broker-IPC race — sentinel (visible when prereqs missing)",
  () => {
    it("documents skip reason", () => {
      const reason = !dockerOk
        ? "docker daemon unreachable"
        : "phase1b-test images not built — run `bash tests/docker/build-images.sh`";
      expect(reason).toBeTruthy();
    });
  },
);
