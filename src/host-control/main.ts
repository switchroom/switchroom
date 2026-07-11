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
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, findConfigFile, loadConfig } from "../config/loader.js";
import {
  clearStaleDegradedMarker,
  postOperatorNoticeViaGateways,
  waitForConfigRecovery,
  type GatewayCandidate,
} from "./config-degraded.js";
import { allocateAgentUid } from "../agents/compose.js";
import { HostdServer } from "./server.js";
import { SocketApprovalGateway } from "./approval-gateway.js";
import { SocketRolloutRelay } from "./rollout-relay.js";
import { SocketRolloutNarrationRelay } from "./rollout-narration-relay.js";
import { LogTailRolloutNarrator } from "./rollout-narrator.js";
import { ReleaseWatcher } from "./release-watcher.js";
import {
  makeReleaseCheck,
  makeApply,
  makeRestart,
} from "./release-watcher-shellouts.js";
import { appendFile } from "node:fs/promises";

/**
 * Load switchroom.yaml, surviving a ConfigError (invalid YAML — e.g.
 * duplicate keys — schema failure, unreadable file) by entering DEGRADED
 * mode instead of the exit-1 → docker-restart crash-loop that previously
 * stalled fleet rollouts silently. See `config-degraded.ts` for the
 * mechanism (retry interval + file watch, prominent marker file,
 * best-effort operator DM, pending self-bump marker preservation).
 */
async function loadConfigResilient(): Promise<
  ReturnType<typeof loadConfig>
> {
  try {
    const config = loadConfig();
    // Healthy boot: remove any degraded marker orphaned by a hostd that
    // died while degraded after the operator had already fixed the yaml.
    // Left in place it would report degraded-forever to marker-keyed
    // health checks AND poison the NEXT degrade episode's persisted-epoch
    // credit (an ancient `since` → months-long degradedMs → preservation
    // cap refuses a genuinely fresh pending rollout).
    clearStaleDegradedMarker(homedir(), (m) =>
      process.stderr.write(`hostd: ${m}\n`),
    );
    return config;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Discover the config path (for the file watcher) without letting a
    // "no config found" error re-throw — the interval retry covers that.
    let configPath: string | undefined;
    try {
      configPath = findConfigFile();
    } catch {
      configPath = undefined;
    }
    // Notification transport: we cannot read the config, so we don't know
    // which agents exist or who is admin. Best-effort fallback: scan the
    // agents dir for gateway IPC socket paths (sorted — deterministic) and
    // post ONE plain operator-DM through the FIRST that actually accepts
    // the connection — a socket inode existing does not prove a listener
    // (a crashed gateway leaves it behind), so candidates are tried in
    // order until one takes the write. The gateway fences delivery to its
    // own operator chat, so this cannot leak outside the operator.
    const agentsDir =
      process.env.SWITCHROOM_AGENTS_DIR ??
      join(homedir(), ".switchroom", "agents");
    const listGatewayCandidates = (): GatewayCandidate[] => {
      const out: GatewayCandidate[] = [];
      try {
        for (const name of readdirSync(agentsDir).sort()) {
          const sock = resolve(agentsDir, name, "telegram", "gateway.sock");
          if (existsSync(sock)) out.push({ agent: name, sock });
        }
      } catch {
        /* agents dir unreadable — marker file is the fallback signal */
      }
      return out;
    };
    const log = (m: string): void => {
      process.stderr.write(`hostd: ${m}\n`);
    };
    const notify = (text: string): void => {
      const candidates = listGatewayCandidates();
      if (candidates.length === 0) {
        log("config-degraded: no gateway socket paths found; relying on marker file");
        return;
      }
      // Fire-and-forget: the recovery wait must never block on a chat send.
      void postOperatorNoticeViaGateways(candidates, text, log).then((agent) => {
        if (agent !== null) log(`config-degraded: operator DM relayed via ${agent}`);
      });
    };
    return waitForConfigRecovery({
      initialError: err,
      homeDir: homedir(),
      loadFn: () => loadConfig(),
      configPath,
      notify,
      log,
    });
  }
}

async function main(): Promise<void> {
  const config = await loadConfigResilient();
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
  const resolveGatewaySocket = (agentName: string): string | null => {
    const sock = resolve(agentsDir, agentName, "telegram", "gateway.sock");
    return existsSync(sock) ? sock : null;
  };
  const approvalGateway = new SocketApprovalGateway({
    resolveGatewaySocket,
    log: (m) => process.stderr.write(`hostd: approval-gateway — ${m}\n`),
  });

  // #2726 Part 1 — rollout terminal-push relay. Same transport as the approval
  // gateway (the caller agent's gateway IPC socket), but fire-and-forget: it
  // posts ONE ordinary operator-DM message on the rollout terminal row and
  // never awaits a reply, so a slow/absent gateway can't stall the roll.
  const rolloutRelay = new SocketRolloutRelay({
    resolveGatewaySocket,
    log: (m) => process.stderr.write(`hostd: rollout-relay — ${m}\n`),
  });

  // #2726 Part 2 — the log-tailed in-chat narration surface. hostd tails its
  // OWN durable rollout rows (it is fed each phase as it parses the child's
  // stdout) and edits ONE ordinary operator-DM message through the phases —
  // NOT pinned, NOT a bespoke card. The narrator holds no lifecycle state a
  // gateway restart could orphan; edits are fire-and-forget, monotonic,
  // debounced, frozen-on-terminal, and 429-handled gateway-side.
  const rolloutNarrator = new LogTailRolloutNarrator(
    new SocketRolloutNarrationRelay({
      resolveGatewaySocket,
      log: (m) => process.stderr.write(`hostd: rollout-narration — ${m}\n`),
    }),
    { log: (m) => process.stderr.write(`hostd: rollout-narration — ${m}\n`) },
  );

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
              // #1841 — operator-attest 2nd factor. Pass through so the
              // daemon's checkOperatorAttest sees the operator's opt-in.
              ...(config.hostd.operator_attest_enabled !== undefined
                ? { operator_attest_enabled: config.hostd.operator_attest_enabled }
                : {}),
              ...(config.hostd.operator_attest_required_verbs !== undefined
                ? {
                    operator_attest_required_verbs:
                      config.hostd.operator_attest_required_verbs,
                  }
                : {}),
            },
          }
        : {}),
    },
    approvalGateway,
    rolloutRelay,
    rolloutNarrator,
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
