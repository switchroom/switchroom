/**
 * switchroom-hostd entrypoint.
 *
 * Designed to run as a host-side docker container (image
 * `ghcr.io/switchroom/switchroom-hostd`) sitting OUTSIDE the
 * switchroom compose project — same docker-first deployment shape
 * as the broker, kernel, and agent images, but in its own compose
 * project (`switchroom-hostd`) so the switchroom project's
 * `compose up -d --remove-orphans` cycle cannot recreate it mid-
 * update. See `reference/rfcs/host-control-daemon.md` § 5.1.
 *
 * Phase 1 (this file) is supervisor-agnostic — it just instantiates
 * HostdServer, starts it, and waits for SIGTERM. Phase 1.5 adds the
 * Dockerfile + image build target + `switchroom hostd install`
 * verb that writes the sibling compose file. Phase 2 swaps the
 * gateway's spawnSwitchroomDetached callsites to talk to the daemon.
 * Until then, this entrypoint can be invoked by an operator who's
 * opted into `host_control.enabled: true` but behaviour is
 * observation-only — the daemon binds sockets and audits incoming
 * calls, but no gateway code path produces them yet.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import { allocateAgentUid } from "../agents/compose.js";
import { HostdServer } from "./server.js";
import { SocketApprovalGateway } from "./approval-gateway.js";
import { ReleaseWatcher } from "./release-watcher.js";
import {
  makeReleaseCheck,
  makeApply,
  makeRestart,
} from "./release-watcher-shellouts.js";
import { appendFile } from "node:fs/promises";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.host_control?.enabled !== true) {
    process.stderr.write(
      "hostd: refusing to start — host_control.enabled is not true in switchroom.yaml\n",
    );
    process.exit(2);
  }

  // Bind a per-agent UDS for EVERY agent, not just admin-flagged ones.
  // The socket is identity (path-as-identity, forge-resistant); binding
  // it does NOT grant admin — every privileged verb is still gated in
  // `checkGate`. The one verb a non-admin agent can reach is a
  // self-scoped `config_propose_edit` (operator-tapped, single-shot)
  // that adds rules to its OWN `tools.allow` so "🔁 Always allow"
  // persists for the whole fleet, not only the 3 admin agents.
  const agentUids: Record<string, number> = {};
  for (const name of Object.keys(config.agents)) {
    agentUids[name] = allocateAgentUid(name);
  }

  if (Object.keys(agentUids).length === 0) {
    process.stderr.write(
      "hostd: no agents configured — nothing to serve.\n",
    );
    process.exit(2);
  }

  // #1623 — wire the SocketApprovalGateway so config_propose_edit can
  // round-trip an operator approval card through the caller agent's
  // gateway IPC socket. Socket location mirrors
  // `src/agents/lifecycle.ts:gracefulRestartAgent` —
  // `<agentsDir>/<agentName>/telegram/gateway.sock`.
  const agentsDir =
    process.env.SWITCHROOM_AGENTS_DIR ??
    join(homedir(), ".switchroom", "agents");
  const approvalGateway = new SocketApprovalGateway({
    resolveGatewaySocket: (agentName) => {
      const sock = resolve(agentsDir, agentName, "telegram", "gateway.sock");
      return existsSync(sock) ? sock : null;
    },
    log: (m) => process.stderr.write(`hostd: approval-gateway — ${m}\n`),
  });

  const server = new HostdServer({
    homeDir: homedir(),
    agentUids,
    config: {
      agents: Object.fromEntries(
        // `root: true` (the root-tier debugging agent) is strictly above
        // admin and carries admin authority — so hostd's checkGate admits
        // it to every admin-gated verb. See docs/root-agent.md.
        Object.entries(config.agents).map(([n, a]) => [
          n,
          { admin: a.admin === true || (a as { root?: boolean }).root === true },
        ]),
      ),
      ...(config.hostd
        ? {
            hostd: {
              ...(config.hostd.config_edit_enabled !== undefined
                ? { config_edit_enabled: config.hostd.config_edit_enabled }
                : {}),
            },
          }
        : {}),
    },
    approvalGateway,
  });
  await server.start();

  const paths = server.getBoundPaths();
  process.stderr.write(
    `hostd: ready — bound ${paths.length} agent socket(s): ${paths.join(", ")}\n`,
  );

  // #1743 — pull-based release-triggered fleet restart. Opt-in via
  // `host_control.auto_release_check.enabled: true`. The watcher
  // lives inside hostd because it's already the long-running host
  // daemon with docker socket access + the `switchroom` CLI on PATH
  // (RFC C §5.1).
  let releaseWatcher: ReleaseWatcher | null = null;
  const autoRel = config.host_control?.auto_release_check;
  if (autoRel?.enabled === true) {
    const eventsLog = join(
      homedir(),
      ".switchroom",
      "release-watcher-events.jsonl",
    );
    releaseWatcher = new ReleaseWatcher({
      intervalMs: autoRel.interval_minutes * 60_000,
      checkFn: makeReleaseCheck({
        imageRef: autoRel.image_ref,
        log: (m) => process.stderr.write(`hostd: ${m}\n`),
      }),
      applyFn: makeApply("switchroom"),
      restartFn: makeRestart("switchroom"),
      applyOnDetect: autoRel.apply_on_detect,
      log: (m) => process.stderr.write(`hostd: ${m}\n`),
      onEvent: (e) => {
        // Telemetry sink — JSONL append. The
        // `time_from_release_to_fleet_caught_up_seconds` AC counter
        // is the `duration_ms` field of the `fleet_caught_up` row
        // (delta from the matching `release_detected` row).
        void appendFile(eventsLog, JSON.stringify(e) + "\n").catch(() => {});
      },
    });
    releaseWatcher.start();
    process.stderr.write(
      `hostd: release-watcher started — polling ${autoRel.image_ref} ` +
        `every ${autoRel.interval_minutes}m ` +
        `(apply_on_detect=${autoRel.apply_on_detect})\n`,
    );
  }

  // Wait for SIGTERM / SIGINT. `docker stop` sends SIGTERM after
  // tini relays it; Ctrl-C in dev sends SIGINT. Both shut down
  // gracefully.
  let stopping = false;
  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`hostd: shutting down (${reason})\n`);
    if (releaseWatcher) releaseWatcher.stop();
    await server.stop();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`hostd: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
