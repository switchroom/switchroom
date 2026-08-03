/**
 * Buzz (Nostr co-channel) doctor checks — the operator-visible health surface
 * for the per-agent Buzz sidecar (`src/buzz-gateway/`).
 *
 * Mirrors the shape of `doctor-notion.ts` / `doctor-microsoft.ts`: a per-agent
 * matrix of cheap config rows plus a vault-grant probe and a heartbeat-driven
 * liveness probe. It reports, for every agent that declares a `channels.buzz`
 * block:
 *
 *   1. **channel state** — enabled / mirror mode, and whether that resolves to
 *      a live sidecar (`enabled && mirror != off`) or a deliberately-dark one.
 *   2. **relay config** — the operationally-required relay fields are present
 *      (relay_url, relay_host, operator_pubkey, chat_id, default_channel_id).
 *      Belt-and-suspenders: the schema already enforces these at config-load,
 *      so a red row here means the load step was skipped/bypassed.
 *   3. **keypair / vault grant** — the agent's nsec vault key exists AND the
 *      agent is on its ACL. Without the grant the sidecar broker-fetch fails
 *      closed at boot and the channel silently never runs — the highest-leverage
 *      probe here, exactly like notion's vault-acl-aligned.
 *   4. **sidecar live** — the sidecar's heartbeat beacon
 *      (`buzz-sidecar.heartbeat.json`) is present and fresh, and its
 *      last-sampled subscription is up. Only meaningful for a live channel; a
 *      dark channel skips it (deliberately not running, not a fault).
 *
 * The buzz config is read cascade-resolved (`resolveAgentConfig`), because a
 * `channels.buzz` block can be inherited from a profile / defaults — matching
 * how `compose.ts` projects the sidecar env.
 *
 * Filesystem + vault access are dependency-injected for branch coverage,
 * mirroring `doctor-notion.ts`.
 */

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  statSync as realStatSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import {
  BUZZ_HEARTBEAT_STALE_MS as HEARTBEAT_STALE_MS,
  buzzHeartbeatOperatorPath,
  parseBuzzHeartbeat,
} from "../buzz-gateway/heartbeat.js";

import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** A heartbeat older than this reads as stale. Re-exported from the heartbeat
 *  module so the stale threshold and the sidecar's beat interval share ONE
 *  timing contract (#4302): the sidecar clamps its (env-tunable) beat interval
 *  to stay inside this window, so a healthy sidecar never false-reds. The
 *  threshold is DERIVED there as interval × missed-beat tolerance, not a fixed
 *  180s decoupled from the interval. */
export const BUZZ_HEARTBEAT_STALE_MS = HEARTBEAT_STALE_MS;

/** Small back-off before doctor re-reads a heartbeat that failed to parse, so a
 *  transient torn read of the in-place (non-atomic) beacon write self-heals
 *  within one doctor run instead of false-warning "malformed" (#4303). */
export const BUZZ_HEARTBEAT_REREAD_DELAY_MS = 50;

export interface BuzzProbeDeps {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf-8" | "utf8") => string;
  statSync?: (path: string) => { mtimeMs: number };
  homeDir?: () => string;
  /** Override clock for tests (default Date.now). */
  now?: () => number;
  /** Injected async delay for the torn-read retry (#4303); default a real
   *  setTimeout-backed sleep. Tests inject an instant no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject the vault ACL reader for tests. Returns the agents allowed to read
   *  the key, or an unreachable/not-found signal. */
  vaultAclReader?: (
    key: string,
  ) => Promise<
    | { kind: "ok"; allow: string[] }
    | { kind: "unreachable"; msg: string }
    | { kind: "not_found" }
  >;
}

interface ResolvedDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8" | "utf8") => string;
  statSync: (path: string) => { mtimeMs: number };
  agentsDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  vaultAclReader: NonNullable<BuzzProbeDeps["vaultAclReader"]>;
}

function resolveDeps(deps: BuzzProbeDeps): ResolvedDeps {
  const home = deps.homeDir?.() ?? homedir();
  return {
    existsSync: deps.existsSync ?? realExistsSync,
    readFileSync: deps.readFileSync ?? realReadFileSync,
    statSync: deps.statSync ?? realStatSync,
    agentsDir: join(home, ".switchroom", "agents"),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    vaultAclReader:
      deps.vaultAclReader ??
      (async () => ({ kind: "unreachable", msg: "no default reader wired" })),
  };
}

/** The effective, defaults-applied Buzz config for one agent (mirrors how
 *  compose.ts re-applies schema defaults over the merged raw cascade). */
export interface EffectiveBuzz {
  agent: string;
  enabled: boolean;
  mirror: "both" | "origin" | "off";
  /** enabled AND not the off kill-switch — the sidecar actually runs. */
  live: boolean;
  relayUrl: string;
  relayHost: string;
  operatorPubkey: string;
  chatId: string;
  channelIds: string;
  /** nsec vault key with `{agent}` substituted. */
  nsecVaultKey: string;
}

/**
 * Every agent with a `channels.buzz` block (cascade-resolved), with schema
 * defaults re-applied. An agent without the block is omitted entirely — Buzz is
 * default-OFF and absent-block agents must produce zero rows.
 */
export function computeBuzzAgents(config: SwitchroomConfig): EffectiveBuzz[] {
  const out: EffectiveBuzz[] = [];
  for (const [name, agentConfig] of Object.entries(config.agents ?? {})) {
    if (!agentConfig) continue;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    const raw = resolved.channels?.buzz;
    if (!raw) continue;
    const enabled = raw.enabled === true;
    const mirror = raw.mirror ?? "both";
    out.push({
      agent: name,
      enabled,
      mirror,
      // `origin` is degraded to dark at runtime (config.ts loadConfigFromEnv:
      // an explicit `origin` returns `off`), so the sidecar exits idle and never
      // writes a beacon. Treating it as live would run the liveness probe and
      // produce a false-red "sidecar not running" warn whose restart fix can't
      // help — so `origin` is NOT live here, matching `off`.
      live: enabled && mirror !== "off" && mirror !== "origin",
      relayUrl: raw.relay_url ?? "",
      relayHost: raw.relay_host ?? "",
      operatorPubkey: raw.operator_pubkey ?? "",
      chatId: raw.chat_id ?? "",
      channelIds: raw.default_channel_id ?? "",
      nsecVaultKey: (raw.nsec_vault_key ?? "buzz/{agent}-nsec").replace(/\{agent\}/g, name),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Probe 1 + 2: channel state + relay config (cheap, no IO)
// ────────────────────────────────────────────────────────────────────────

function checkChannelState(b: EffectiveBuzz): CheckResult {
  if (!b.enabled) {
    return {
      name: `buzz:channel:${b.agent}`,
      status: "skip",
      detail: `configured but disabled (enabled:false) — sidecar dark`,
    };
  }
  if (b.mirror === "off") {
    return {
      name: `buzz:channel:${b.agent}`,
      status: "skip",
      detail: `enabled but mirror:off (kill-switch) — sidecar exits idle`,
    };
  }
  // mirror `origin` is degraded to dark at runtime (S2 deferred) — surface it so
  // an operator who set it knows the channel is not actually mirroring.
  if (b.mirror === "origin") {
    return {
      name: `buzz:channel:${b.agent}`,
      status: "warn",
      detail: `mirror:origin is deferred (S2) and degrades to dark at runtime — set mirror:both to run live, or mirror:off to make the kill-switch explicit`,
    };
  }
  return {
    name: `buzz:channel:${b.agent}`,
    status: "ok",
    detail: `enabled, mirror=${b.mirror} (live)`,
  };
}

function checkRelayConfig(b: EffectiveBuzz): CheckResult {
  const missing: string[] = [];
  if (!b.relayUrl) missing.push("relay_url");
  if (!b.relayHost) missing.push("relay_host");
  if (!b.operatorPubkey) missing.push("operator_pubkey");
  if (!b.chatId) missing.push("chat_id");
  if (!b.channelIds) missing.push("default_channel_id");
  if (missing.length > 0) {
    return {
      name: `buzz:relay-config:${b.agent}`,
      status: "fail",
      detail: `channels.buzz for '${b.agent}' is missing required field(s): ${missing.join(", ")}`,
      fix: `Set the missing field(s) under agents.${b.agent}.channels.buzz (or the profile it inherits from) in switchroom.yaml. relay_host is the verbatim HTTP Host authority the relay resolves its community from; without it the sidecar fails closed.`,
    };
  }
  return {
    name: `buzz:relay-config:${b.agent}`,
    status: "ok",
    detail: `relay=${b.relayUrl} host=${b.relayHost} group=${b.channelIds}`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Probe 3: keypair / vault grant
// ────────────────────────────────────────────────────────────────────────

async function checkKeypairGrant(b: EffectiveBuzz, d: ResolvedDeps): Promise<CheckResult> {
  const acl = await d.vaultAclReader(b.nsecVaultKey);
  if (acl.kind === "unreachable") {
    return {
      name: `buzz:keypair:${b.agent}`,
      status: "warn",
      detail: `vault-broker unreachable checking '${b.nsecVaultKey}': ${acl.msg}`,
      fix: "Ensure the vault-broker is running and the operator socket is reachable, then re-run doctor.",
    };
  }
  if (acl.kind === "not_found") {
    return {
      name: `buzz:keypair:${b.agent}`,
      status: "fail",
      detail: `vault key '${b.nsecVaultKey}' is missing — the sidecar broker-fetches the agent nsec at boot and fails closed without it, so the channel never runs`,
      fix: `Store the agent's Nostr nsec: \`switchroom vault set ${b.nsecVaultKey} --allow ${b.agent}\` on the host (paste the nsec at the prompt).`,
    };
  }
  if (!acl.allow.includes(b.agent)) {
    const updated = [...acl.allow, b.agent].join(",");
    return {
      name: `buzz:keypair:${b.agent}`,
      status: "fail",
      detail: `vault key '${b.nsecVaultKey}' exists but agent '${b.agent}' is NOT on its ACL — the sidecar's broker fetch will be denied and the channel fails closed`,
      fix: `Re-run \`switchroom vault set ${b.nsecVaultKey} --allow ${updated}\` on the host (vault set overwrites the scope, so re-state the full list including '${b.agent}').`,
    };
  }
  return {
    name: `buzz:keypair:${b.agent}`,
    status: "ok",
    detail: `vault key '${b.nsecVaultKey}' present; agent on ACL`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Probe 4: sidecar liveness (heartbeat beacon)
// ────────────────────────────────────────────────────────────────────────

async function checkSidecarLive(b: EffectiveBuzz, d: ResolvedDeps): Promise<CheckResult> {
  if (!b.live) {
    return {
      name: `buzz:sidecar-live:${b.agent}`,
      status: "skip",
      detail: `channel not live (enabled=${b.enabled}, mirror=${b.mirror}) — sidecar intentionally not running`,
    };
  }
  const path = buzzHeartbeatOperatorPath(join(d.agentsDir, b.agent));
  if (!d.existsSync(path)) {
    return {
      name: `buzz:sidecar-live:${b.agent}`,
      status: "warn",
      detail: `no heartbeat at ${path} — the sidecar is not running (or has not emitted its first beat)`,
      fix: `Check the sidecar: \`switchroom agent restart ${b.agent} --wait\`, then tail its /var/log/switchroom/buzz-gateway.log for boot errors (a missing vault grant, an unreachable relay).`,
    };
  }
  let mtimeMs: number;
  try {
    mtimeMs = d.statSync(path).mtimeMs;
  } catch (err) {
    return {
      name: `buzz:sidecar-live:${b.agent}`,
      status: "warn",
      detail: `cannot stat heartbeat ${path}: ${(err as Error).message}`,
    };
  }
  const age = d.now() - mtimeMs;
  if (age > BUZZ_HEARTBEAT_STALE_MS) {
    return {
      name: `buzz:sidecar-live:${b.agent}`,
      status: "warn",
      detail: `heartbeat is ${Math.round(age / 1000)}s old (stale: >${BUZZ_HEARTBEAT_STALE_MS / 1000}s) — the sidecar has stalled or died`,
      fix: `Restart the sidecar: \`switchroom agent restart ${b.agent} --wait\` and check /var/log/switchroom/buzz-gateway.log.`,
    };
  }

  // Fresh beat — surface the last-sampled stats + subscription state.
  //
  // The beacon is written in place, non-atomically, to preserve the sidecar's
  // agent-uid file ownership (repo #3168 landmine — a tmp+rename would re-own
  // it). That leaves a narrow torn-read window where doctor can read a
  // half-written file that fails to parse. Rather than change the write side,
  // retry the READ once after a small delay (#4303): a genuine mid-write
  // self-heals on the second read within the same doctor run, while a durably
  // malformed beacon still fails both reads and warns.
  const readOnce = (): ReturnType<typeof parseBuzzHeartbeat> => {
    try {
      return parseBuzzHeartbeat(d.readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  };
  let hb = readOnce();
  if (!hb) {
    await d.sleep(BUZZ_HEARTBEAT_REREAD_DELAY_MS);
    hb = readOnce();
  }
  if (!hb) {
    return {
      name: `buzz:sidecar-live:${b.agent}`,
      status: "warn",
      detail: `heartbeat ${Math.round(age / 1000)}s old but unreadable/malformed at ${path}`,
    };
  }
  // Cross-check the beacon's own agent field against the agent this row is for
  // (#4304). The beacon lives in the agent's uid-writable state dir and this
  // fleet treats agents as prompt-injectable, so a beacon copied from another
  // agent's dir (or a stale/foreign one) must NOT pass this liveness probe.
  // A mismatch is treated as not-live/malformed. The beacon's agent value is
  // NOT echoed into the row — it is untrusted, agent-controlled content.
  if (hb.agent !== b.agent) {
    return {
      name: `buzz:sidecar-live:${b.agent}`,
      status: "warn",
      detail: `heartbeat ${Math.round(age / 1000)}s old at ${path} belongs to a different agent than '${b.agent}' — foreign/copied beacon, treating as not live`,
      fix: `Confirm the sidecar for '${b.agent}' owns this beacon: \`switchroom agent restart ${b.agent} --wait\` and check /var/log/switchroom/buzz-gateway.log.`,
    };
  }
  const s = hb.stats;
  const statLine =
    `received=${s.received} injected=${s.injected} dropped_by_kind=${s.droppedByKind} ` +
    `auth_failures=${s.authFailures} mirror_ok=${s.mirrorOk} mirror_failed=${s.mirrorFailed}`;
  if (!hb.subscribed) {
    return {
      name: `buzz:sidecar-live:${b.agent}`,
      status: "warn",
      detail: `sidecar up (heartbeat ${Math.round(age / 1000)}s old) but relay subscription is DOWN — inbound events are not being delivered; ${statLine}`,
      fix: `Check /var/log/switchroom/buzz-gateway.log for relay AUTH/connect errors (a wrong relay_host 404s the WS upgrade; a bad nsec fails NIP-42 AUTH).`,
    };
  }
  return {
    name: `buzz:sidecar-live:${b.agent}`,
    status: "ok",
    detail: `sidecar live (heartbeat ${Math.round(age / 1000)}s old, subscribed); ${statLine}`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Public — runBuzzChecks
// ────────────────────────────────────────────────────────────────────────

export async function runBuzzChecks(
  config: SwitchroomConfig,
  deps: BuzzProbeDeps = {},
): Promise<CheckResult[]> {
  const agents = computeBuzzAgents(config);
  if (agents.length === 0) {
    // No agent declares channels.buzz — Buzz not configured, skip silently.
    return [];
  }
  const d = resolveDeps(deps);
  const results: CheckResult[] = [];
  for (const b of agents) {
    results.push(checkChannelState(b));
    results.push(checkRelayConfig(b));
    results.push(await checkKeypairGrant(b, d));
    results.push(await checkSidecarLive(b, d));
  }
  return results;
}
