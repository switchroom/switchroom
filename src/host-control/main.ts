/**
 * switchroom-hostd entrypoint.
 *
 * Designed to run as a host-side docker container (image
 * `ghcr.io/switchroom/switchroom-hostd`) sitting OUTSIDE the
 * switchroom compose project — same docker-first deployment shape
 * as the broker, kernel, and agent images, but in its own compose
 * project (`switchroom-hostd`) so the switchroom project's
 * `compose up -d --remove-orphans` cycle cannot recreate it mid-
 * update. See `docs/rfcs/host-control-daemon.md` § 5.1.
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

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.host_control?.enabled !== true) {
    process.stderr.write(
      "hostd: refusing to start — host_control.enabled is not true in switchroom.yaml\n",
    );
    process.exit(2);
  }

  const agentUids: Record<string, number> = {};
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.admin === true) {
      agentUids[name] = allocateAgentUid(name);
    }
  }

  if (Object.keys(agentUids).length === 0) {
    process.stderr.write(
      "hostd: no admin-flagged agents — nothing to serve. Set `admin: true` on at least one agent.\n",
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
        Object.entries(config.agents).map(([n, a]) => [n, { admin: a.admin === true }]),
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

  // Wait for SIGTERM / SIGINT. `docker stop` sends SIGTERM after
  // tini relays it; Ctrl-C in dev sends SIGINT. Both shut down
  // gracefully.
  let stopping = false;
  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`hostd: shutting down (${reason})\n`);
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
