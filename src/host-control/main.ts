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
import { HostdServer, configPathProvenanceWarning } from "./server.js";
import { dockerFleetComponents } from "./prior-pin.js";
import { SocketApprovalGateway } from "./approval-gateway.js";
import { SocketRolloutRelay } from "./rollout-relay.js";
import { SocketRolloutNarrationRelay } from "./rollout-narration-relay.js";
import { LogTailRolloutNarrator } from "./rollout-narrator.js";
import { ReleaseWatcher } from "./release-watcher.js";
import {
  makeReleaseCheck,
  makeApply,
  makeRestart,
  makeUpdatePlan,
} from "./release-watcher-shellouts.js";
import { UpdateNotifier, short } from "./update-notifier.js";
import type { ApprovalResult } from "./approval-gateway.js";
import {
  makeAutoUpdateCheck,
  resolveReleaseWatcherMode,
} from "./auto-update-check.js";
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

  // #4661 follow-up — would `config_propose_edit` write a file hostd itself
  // would not read back? The write target is the wire literal
  // (`/state/config/switchroom.yaml`); hostd's own loadConfig and pin journal
  // go through findConfigFile. This compares those two INSIDE hostd's own cwd,
  // `$HOME` and mount namespace — it is not, and cannot be, a statement about
  // an agent container or the operator's host shell, which resolve elsewhere.
  // Say so LOUDLY at boot if they disagree, and do NOT refuse to start: a
  // config-layout change would otherwise take the whole daemon (rollouts
  // included) down to protect one verb that already refuses on its own at
  // apply time. Two NAMES for one file (same dev+inode) stay silent — the
  // shipped install is exactly that, and a warning that fires every boot is a
  // warning nobody reads.
  const provenanceWarning = configPathProvenanceWarning();
  if (provenanceWarning !== null) {
    process.stderr.write(`hostd: ${provenanceWarning}\n`);
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
    {
      log: (m) => process.stderr.write(`hostd: rollout-narration — ${m}\n`),
      // Late-bound: the narrator is built before `server` exists, but this
      // sink only fires when a post lands (well after `server` is assigned).
      // Persist the learned card id into the pending-rollout marker so a hostd
      // self-bump can hand it back and the resumed roll edits the same card
      // instead of stranding it and re-posting (#4062-adjacent).
      onMessageId: (rid, mid) => server?.persistNarrationMessageId(rid, mid),
      // #4065 — the card is gone AND the one allowed re-post did not land.
      // Structured, greppable telemetry in the hostd log; NEVER a chat card
      // asking the operator to fix it (PR #4104's rule). `get_status` stays
      // the durable record of the roll.
      escalate: (esc) =>
        process.stderr.write(
          `hostd: rollout card escalation request=${esc.requestId} agent=${esc.agentName} ` +
            `staleMessageId=${esc.staleMessageId} reason=${esc.reason}` +
            `${esc.detail !== undefined ? ` detail=${esc.detail}` : ""} ` +
            `— card could not be restored, no operator card issued\n`,
        ),
    },
  );

  const server = new HostdServer({
    homeDir: homedir(),
    agentUids,
    // The sole production wiring of the running-fleet inventory. `prior_pin`
    // (the rollback target stamped on every completed roll) is derived from
    // it; drop this and rollback degrades to "no target recorded". Asserted
    // by tests/host-control/hostd-fleet-components-callsite.test.ts.
    fleetComponents: () => dockerFleetComponents(),
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
  const watcherMode = resolveReleaseWatcherMode(config);
  if (watcherMode.mode !== "off") {
    const eventsLog = join(
      homedir(),
      ".switchroom",
      "release-watcher-events.jsonl",
    );
    const log = (m: string): void => {
      process.stderr.write(`hostd: ${m}\n`);
    };
    const onEvent = (e: object): void => {
      // Telemetry sink — JSONL append. The
      // `time_from_release_to_fleet_caught_up_seconds` AC counter
      // is the `duration_ms` field of the `fleet_caught_up` row
      // (delta from the matching `release_detected` row).
      void appendFile(eventsLog, JSON.stringify(e) + "\n").catch(() => {});
    };
    const intervalMinutes = autoRel?.interval_minutes ?? 5;
    const imageRef =
      autoRel?.image_ref ?? "ghcr.io/switchroom/switchroom-agent:latest";
    if (watcherMode.mode === "auto_update") {
      // KEN-131 — `release.auto_update: true`: version-based check, and on
      // detection the UNATTENDED staggered canary rollout via the server's
      // own launch path (fleet-mutation lock, self-bump, audit, narration,
      // rollback + alert hardening). NOT the legacy update+restart-all.
      // A `notify_on_detect` the auto-update path can't honour must not fail
      // silently — the operator asked for a card and would otherwise get
      // neither a card nor an explanation.
      if (autoRel?.notify_on_detect === true) {
        process.stderr.write(
          "hostd: release.auto_update is on, so notify_on_detect is " +
            "ignored — new releases roll unattended via the canary path and " +
            "only FAILURES post an operator alert. Turn off " +
            "release.auto_update if you want the tap-to-apply card instead.\n",
        );
      }
      // Live release block per tick — a green roll persists the pin, which
      // is what quiesces the check. Throws on malformed config (tick
      // dropped as check_failed, retried next interval).
      const liveRelease = (): { pin?: string; channel?: string } =>
        (loadConfig() as { release?: { pin?: string; channel?: string } })
          .release ?? {};
      releaseWatcher = new ReleaseWatcher({
        intervalMs: intervalMinutes * 60_000,
        checkFn: makeAutoUpdateCheck({
          imageRef,
          getCurrentPin: () => liveRelease().pin,
          getCurrentChannel: () => liveRelease().channel,
          getLatchedPin: () => server.autoRolloutLatchedPin(),
          log,
        }),
        applyFn: async (version) => {
          if (!version) {
            throw new Error("auto-update check reported no target version");
          }
          const r = await server.startAutoRollout(version);
          if (!r.started) {
            throw new Error(`auto rollout not started: ${r.reason}`);
          }
          log(
            `auto-update: unattended rollout to ${version} started ` +
              `(request_id ${r.request_id})`,
          );
        },
        // The rollout restarts agents itself (staggered, canary-first) —
        // a fleet-wide `restart all` here would double-bounce every agent.
        restartFn: async () => {},
        applyOnDetect: true,
        log,
        onEvent,
      });
      releaseWatcher.start();
      process.stderr.write(
        `hostd: auto-update watcher started (release.auto_update) — ` +
          `checking the published release every ${intervalMinutes}m; new ` +
          `releases roll via the staggered canary rollout\n`,
      );
    } else {
      const applyOnDetect = autoRel?.apply_on_detect ?? true;
      const notifyOnDetect = autoRel?.notify_on_detect ?? false;
      // KEN-129 — operator-in-the-loop drift card. Only wired when
      // auto-apply is OFF (apply_on_detect supersedes notify: a fleet
      // that self-applies has nothing to ask the operator).
      let notifier: UpdateNotifier | null = null;
      if (!applyOnDetect && notifyOnDetect) {
        // Card targets: admin (or root-tier) agents' gateways, in
        // stable order. The first gateway that actually accepts the
        // card wins; dispatch failures fall through to the next.
        const adminAgents = Object.keys(config.agents)
          .filter((n) => {
            const a = config.agents[n] as { admin?: boolean; root?: boolean };
            return a.admin === true || a.root === true;
          })
          .sort();
        // Card timeout — shared with the notifier's re-post suppress
        // window (a pre-restart pending card is honoured for exactly as
        // long as it could still be live in the operator's chat).
        const cardTimeoutMs = 60 * 60_000;
        if (adminAgents.length === 0) {
          // No admin agent → no gateway to carry the card. Every tick
          // would run the (slow) plan probe and then dispatch-fail; skip
          // wiring the notifier and say so once at startup instead.
          process.stderr.write(
            "hostd: notify_on_detect is enabled but no agent has " +
              "admin/root — update approval cards have nowhere to go; " +
              "notifier disabled\n",
          );
        } else notifier = new UpdateNotifier({
          statePath: join(homedir(), ".switchroom", "release-notify-state.json"),
          repostSuppressMs: cardTimeoutMs,
          isFleetMutationInFlight: () => server.isFleetMutationLocked(),
          startApply: (requestId) => {
            const res = server.startOperatorApprovedUpdateApply(requestId);
            return { result: res.result, ...(res.error ? { error: res.error } : {}) };
          },
          planFn: makeUpdatePlan("switchroom"),
          requestApproval: async ({ requestId, version, plan }) => {
            let last: ApprovalResult = {
              verdict: "deny",
              reason: "no admin agent with a reachable gateway socket",
              denySource: "dispatch_failure",
              finalize: async () => {},
            };
            for (const agent of adminAgents) {
              const res = await approvalGateway.requestApproval({
                requestId,
                agentName: agent,
                title: "⬆️ **Switchroom update available — fleet is behind**",
                // NOTE: plain text — the card handler escapes markdown in
                // the reason line, so backticks/bold here would render as
                // escaped literals.
                reason:
                  `New release detected for ${imageRef} ` +
                  `(digest ${short(version)}). Approve to run ` +
                  `switchroom update (the hostd update_apply path).`,
                unifiedDiff:
                  plan.length > 0
                    ? plan
                    : `switchroom update --check produced no plan output;\n` +
                      `remote digest: ${version}`,
                timeoutMs: cardTimeoutMs,
              });
              if (res.verdict === "deny" && res.denySource === "dispatch_failure") {
                last = res;
                continue; // this agent's gateway is unreachable — try next
              }
              return res;
            }
            return last;
          },
          log: (m) => process.stderr.write(`hostd: ${m}\n`),
        });
      }
      const notifierRef = notifier;
      releaseWatcher = new ReleaseWatcher({
        intervalMs: intervalMinutes * 60_000,
        checkFn: makeReleaseCheck({
          imageRef,
          log,
        }),
        applyFn: makeApply("switchroom"),
        restartFn: makeRestart("switchroom"),
        applyOnDetect,
        ...(notifierRef
          ? {
              notifyFn: async (version: string) => {
                await notifierRef.notifyIfNew(version);
              },
            }
          : {}),
        log,
        onEvent,
      });
      releaseWatcher.start();
      process.stderr.write(
        `hostd: release-watcher started — polling ${imageRef} ` +
          `every ${intervalMinutes}m ` +
          `(apply_on_detect=${applyOnDetect}, ` +
          `notify_on_detect=${notifyOnDetect})\n`,
      );
    }
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
