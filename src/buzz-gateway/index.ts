/**
 * Buzz co-channel inbound sidecar (Phase 1) — entrypoint.
 *
 * Supervised sibling of the gateway (start.sh), mirroring the agent-scheduler.
 * Boot sequence:
 *   1. Load config from env (start.sh projects `channels.buzz` into env vars).
 *   2. If the channel isn't live (disabled or mirror:off) → log + exit 0. A
 *      disabled agent's sidecar is a clean no-op.
 *   3. Fetch the agent nsec via the vault broker IN-PROCESS (Bun.spawn, stdout
 *      piped into memory) — NEVER an env var, NEVER logged (M5).
 *   4. Open an anonymous inject-only IPC client to the gateway socket (NO
 *      register frame — B1 keystone).
 *   5. Open the durable dedup store (journal + fsync).
 *   6. Open the WS Nostr client (Host header set, NIP-42 auth), wire each
 *      admitted-by-the-relay EVENT through the pump (auth gate → dedup → map →
 *      inject).
 *
 * This file is the only runtime-specific module (Bun.spawn, Bun WebSocket,
 * process signals); everything it orchestrates is unit-tested in isolation.
 */

import { join } from "node:path";
import { getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { createInjectIpcClient } from "../agent-scheduler/ipc-client.js";
import type { NostrEventLike } from "./auth-gate.js";
import { isChannelLive, loadConfigFromEnv, resolveRelayHost } from "./config.js";
import { createDedupStore } from "./dedup.js";
import { makeInject } from "./ipc-peer.js";
import { createNostrClient, type SocketFactory, type WsLike } from "./nostr-client.js";
import { createBuzzPeerClient } from "./peer-client.js";
import { publishOutbound, type PublishTransport } from "./publisher.js";
import { createInboundPump } from "./pump.js";
import { createRetryQueue } from "./retry-queue.js";
import { buzzHeartbeatStatePath, writeBuzzHeartbeat } from "./heartbeat.js";
import { createStatsReporter, summarizePipeline } from "./stats.js";

function log(msg: string): void {
  process.stderr.write(`buzz-gateway: ${msg}\n`);
}

/**
 * Fetch the nsec via the vault broker, in-process, capturing stdout into a
 * variable so it never touches the supervised log stream. Returns the decoded
 * 32-byte secret key or null on failure (fail-closed).
 */
async function fetchSecretKey(vaultKey: string): Promise<Uint8Array | null> {
  // `Bun` is present at runtime (the sidecar runs under bun); guard the type.
  const bun = (globalThis as { Bun?: { spawn: (cmd: string[], opts: Record<string, unknown>) => {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  } } }).Bun;
  if (!bun) {
    log("FATAL: Bun runtime required to fetch the vault secret");
    return null;
  }
  const proc = bun.spawn(["switchroom", "vault", "get", vaultKey], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    // The broker's deny stderr carries a marker + hint but NO secret — safe to
    // surface the SECOND line (the actionable recovery hint).
    const hintLine = stderr.split("\n").find((l) => l.trim().length > 0) ?? "";
    log(`FATAL: vault get ${vaultKey} failed (exit ${code}): ${hintLine.trim()}`);
    return null;
  }
  const nsec = stdout.trim();
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type === "nsec" && decoded.data instanceof Uint8Array) {
      return decoded.data;
    }
    log("FATAL: vault secret is not a valid nsec");
    return null;
  } catch {
    log("FATAL: vault secret failed nsec decode");
    return null;
  }
}

/** Production socket factory — Bun's WebSocket, with the Host header override
 *  the closed relay requires (Phase 0 blocker #2). */
const bunSocketFactory: SocketFactory = (url, o, handlers) => {
  // Bun's WebSocket accepts a `headers` option the DOM lib type omits.
  const Ctor = WebSocket as unknown as new (
    url: string,
    opts?: { headers?: Record<string, string> },
  ) => WebSocket;
  const ws = new Ctor(url, o.host ? { headers: { Host: o.host } } : undefined);
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data;
    handlers.onMessage(typeof d === "string" ? d : String(d));
  });
  ws.addEventListener("close", () => handlers.onClose());
  ws.addEventListener("error", () => handlers.onError(new Error("ws error")));
  const wrapped: WsLike = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
  return wrapped;
};

async function main(): Promise<void> {
  const loaded = loadConfigFromEnv(process.env);
  if (!loaded.ok) {
    log(`FATAL: config invalid: ${loaded.reason}`);
    process.exit(1);
  }
  const config = loaded.config;

  if (!isChannelLive(config)) {
    log(`channel not live (enabled=${config.enabled}, mirror=${config.mirror}) — exiting idle`);
    process.exit(0);
  }

  const secretKey = await fetchSecretKey(config.nsecVaultKey);
  if (!secretKey) {
    // Non-zero exit → the supervisor backs off and retries (a grant may land).
    process.exit(1);
  }
  const agentPubkey = getPublicKey(secretKey).toLowerCase();
  log(`booted agent=${config.agentName} relay=${config.relayUrl} group=${config.groupId} allowlist=${config.authorized.size}`);

  const stateDir = process.env.TELEGRAM_STATE_DIR ?? "/state/agent/telegram";
  const socketPath = process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(stateDir, "gateway.sock");
  const journalPath = process.env.BUZZ_JOURNAL_PATH ?? join(stateDir, "buzz", "journal.jsonl");

  const dedup = createDedupStore({ journalPath, log });
  const ipcClient = createInjectIpcClient({ socketPath, log });
  const inject = makeInject(ipcClient, config.agentName);

  // MAJOR-1: an inject that fails because the gateway is momentarily down is
  // held here and re-attempted against the IPC client's reconnect, recording
  // dedup only once it lands — so a Buzz event is never lost to a brief gateway
  // outage, and never double-fired.
  const retryQueue = createRetryQueue({
    inject,
    onInjected: (id) => dedup.record(id),
    log,
  });

  const pump = createInboundPump({
    config,
    dedup,
    inject,
    retryQueue,
    verify: (ev: NostrEventLike) => verifyEvent(ev as unknown as Parameters<typeof verifyEvent>[0]),
    agentPubkey,
    log,
  });

  const nostr = createNostrClient({
    relayUrl: config.relayUrl,
    relayTagUrl: config.relayTagUrl,
    relayHost: resolveRelayHost(config),
    groupId: config.groupId,
    secretKey,
    onEvent: (ev) => {
      const outcome = pump.handleEvent(ev);
      if (outcome === "injected") log(`injected buzz event ${ev.id.slice(0, 12)}`);
      // A "queued" outcome is not durably handled — signal the client to hold
      // the resubscribe watermark so a resubscribe re-covers it if we crash.
      return outcome !== "queued";
    },
    socketFactory: bunSocketFactory,
    log,
  });

  // ── Phase 2b OUTBOUND: the duplex publish peer ──────────────────────────
  // A SECOND gateway connection (distinct from the send-only inject client)
  // that receives `outbound_to_buzz` publish requests from the hub and signs +
  // publishes each over the SAME NIP-42 authenticated relay socket. Signing is
  // the sole content-signer (publisher.ts, S3); the relay transport is the
  // nostr client's `publish`. A publish failure is reported honestly back to
  // the hub — never retried into a duplicate (the answer already landed on
  // Telegram under `both`).
  const publishTransport: PublishTransport = (event, timeoutMs) => nostr.publish(event, timeoutMs);
  // Outbound-mirror counters the sidecar owns (the hub-side correlation store is
  // separate). Incremented around each publish; surfaced in the periodic stats
  // + heartbeat below. Content-free — just the ok/failed tallies.
  const mirror = { ok: 0, failed: 0 };
  const buzzPeer = createBuzzPeerClient({
    socketPath,
    agentName: config.agentName,
    onOutbound: async (req) => {
      const result = await publishOutbound(
        {
          channelId: req.channelId,
          replyToEventId: req.replyToEventId,
          threadRootId: req.threadRootId,
          payload: req.payload,
        },
        secretKey,
        publishTransport,
      );
      if (result.ok) mirror.ok += 1;
      else mirror.failed += 1;
      return {
        type: "buzz_publish_result",
        correlationId: req.correlationId,
        ok: result.ok,
        ...(result.eventId ? { eventId: result.eventId } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
    log,
  });

  // ── Operator observability: periodic pipeline stats + liveness heartbeat ──
  // The reporter derives its numbers from the pump's own outcome counters (plus
  // the mirror tally above) — it invents no parallel counting — and beats a
  // content-free heartbeat file `switchroom doctor` reads for liveness. The
  // interval is overridable for tests/tuning (BUZZ_STATS_INTERVAL_MS).
  const bootTs = Date.now();
  const heartbeatPath = buzzHeartbeatStatePath(stateDir);
  const statsIntervalMs = Number(process.env.BUZZ_STATS_INTERVAL_MS) || 60_000;
  const statsReporter = createStatsReporter({
    intervalMs: statsIntervalMs,
    sample: () => ({
      summary: summarizePipeline(pump.stats, mirror),
      subscribed: nostr.isSubscribed(),
    }),
    emit: (line) => log(line),
    persist: (sample) =>
      writeBuzzHeartbeat(heartbeatPath, {
        v: 1,
        agent: config.agentName,
        ts: Date.now(),
        bootTs,
        subscribed: sample.subscribed,
        stats: sample.summary,
      }),
  });

  const shutdown = () => {
    log("shutting down");
    try { statsReporter.stop(); } catch { /* nothing to do */ }
    try { nostr.stop(); } catch { /* nothing to do */ }
    try { buzzPeer.close(); } catch { /* nothing to do */ }
    try { retryQueue.stop(); } catch { /* nothing to do */ }
    try { ipcClient.close(); } catch { /* nothing to do */ }
    try { dedup.close(); } catch { /* nothing to do */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  nostr.start();
  statsReporter.start();
}

main().catch((err) => {
  log(`FATAL: ${(err as Error).message}`);
  process.exit(1);
});
