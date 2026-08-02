/**
 * Buzz sidecar runtime config (Phase 1).
 *
 * The sidecar is a supervised sibling of the gateway. It reads its config from
 * ENV VARS (BUZZ_ENABLED / BUZZ_RELAY_URL / BUZZ_CHAT_ID / BUZZ_CHANNEL_IDS /
 * BUZZ_OPERATOR_PUBKEY / …), NOT by parsing switchroom.yaml — the sidecar has
 * no access to the config cascade. The one secret (the agent nsec) is NEVER an
 * env var; it is broker-fetched in-process at boot (see index.ts).
 *
 * IMPORTANT — these env vars are NOT populated by any config path in this
 * branch. The projection of the cascade-resolved `channels.buzz` block into
 * these env vars (at scaffold/compose time) is DEFERRED to the deploy-wiring
 * phase. Until that lands, `BUZZ_ENABLED` is unset everywhere, so the channel
 * is inert by construction and this sidecar never runs live. (Also deferred to
 * that phase: BuzzChannelSchema currently has no chat-id field, yet this loader
 * requires BUZZ_CHAT_ID when live — the schema→env mapping is part of the
 * env-projection work, not added here.)
 *
 * `loadConfigFromEnv` is pure w.r.t. a supplied env map so it is unit-testable.
 */

import { buildAuthorizedSet } from "./auth-gate.js";

export interface BuzzRuntimeConfig {
  /** Master switch. When false the sidecar no-ops (start.sh usually won't
   *  even fork it, but this is belt-and-braces for a direct launch). */
  enabled: boolean;
  /** This agent's name — the inject target on the gateway socket. */
  agentName: string;
  /** Telegram chat id an injected turn is routed to (reply lands here in
   *  Phase 1 — Telegram is the authoritative surface). */
  chatId: string;
  /** ws:// / wss:// URL the sidecar DIALS. This may be a docker-network
   *  address (e.g. ws://10.0.10.5:3000) that is only reachable from inside the
   *  sidecar container — it is NOT necessarily the relay's canonical identity.
   *  Defaults to `relayTagUrl` when no distinct dial address is configured. */
  relayUrl: string;
  /** Canonical relay URL used VERBATIM as the NIP-42 `["relay", …]` auth tag
   *  (e.g. ws://127.0.0.1:3000). A live probe proved the relay validates this
   *  tag as an EXACT string match against its own canonical URL BEFORE the
   *  membership check — so it must be the relay's advertised identity, which is
   *  decoupled from the address we dial (which may be a docker IP). Sourced
   *  from the canonical BUZZ_RELAY_URL, never from the dial address. */
  relayTagUrl: string;
  /** HTTP Host header authority for the WS upgrade (Phase 0 blocker #2).
   *  Empty string ⇒ derive from relayUrl. */
  relayHost: string;
  /** Relay-minted group UUID (NIP-29 `h` tag) subscribed to. */
  groupId: string;
  /** Effective, hex-normalized inbound allowlist. */
  authorized: Set<string>;
  /** Vault key NAME for the nsec (already `{agent}`-substituted). */
  nsecVaultKey: string;
  /** Petnames: hex pubkey → display name. */
  pubkeyNames: Record<string, string>;
  /** Mirror mode; Phase 1 only distinguishes 'off' (kill-switch) from the rest. */
  mirror: "both" | "origin" | "off";
}

export type EnvMap = Record<string, string | undefined>;

/** True iff the config is a genuine run target (enabled AND not the 'off'
 *  kill-switch). The sidecar exits idle otherwise. */
export function isChannelLive(cfg: Pick<BuzzRuntimeConfig, "enabled" | "mirror">): boolean {
  return cfg.enabled && cfg.mirror !== "off";
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNames(raw: string | undefined): Record<string, string> {
  // Format: "pubkey1=Alice,pubkey2=Bob". Robust to empty / malformed pairs.
  const out: Record<string, string> = {};
  for (const pair of parseList(raw)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim().toLowerCase();
    const v = pair.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Build the runtime config from an env map. Returns { ok:false } with a reason
 * when a REQUIRED field is missing/invalid so the caller can log + exit non-zero
 * (fail-closed — the supervisor backs off and retries).
 */
export function loadConfigFromEnv(
  env: EnvMap,
): { ok: true; config: BuzzRuntimeConfig } | { ok: false; reason: string } {
  const enabled = env.BUZZ_ENABLED === "1" || env.BUZZ_ENABLED === "true";
  const mirror = ((): "both" | "origin" | "off" => {
    const m = env.BUZZ_MIRROR;
    return m === "origin" || m === "off" ? m : "both";
  })();

  const agentName = env.SWITCHROOM_AGENT_NAME?.trim() ?? "";
  if (!agentName) return { ok: false, reason: "SWITCHROOM_AGENT_NAME missing" };

  const chatId = env.BUZZ_CHAT_ID?.trim() ?? "";
  // BUZZ_RELAY_URL is the CANONICAL relay identity — the exact string the relay
  // expects in the NIP-42 `relay` auth tag. The DIAL address may differ (a
  // docker-network IP the relay's own 127.0.0.1 loopback can't stand in for);
  // BUZZ_RELAY_DIAL_URL carries it when they diverge, else we dial the canonical
  // URL. This split is load-bearing: a live probe showed the relay rejects an
  // AUTH whose tag != its canonical URL BEFORE checking membership.
  const relayTagUrl = env.BUZZ_RELAY_URL?.trim() ?? "";
  const relayUrl = env.BUZZ_RELAY_DIAL_URL?.trim() || relayTagUrl;
  const groupId = env.BUZZ_CHANNEL_IDS?.trim() ?? "";
  const operatorPubkey = env.BUZZ_OPERATOR_PUBKEY?.trim() ?? "";

  // Only demand the operational fields when the channel is actually live —
  // a disabled sidecar must load (and then no-op) even with a bare env.
  if (isChannelLive({ enabled, mirror })) {
    if (!chatId) return { ok: false, reason: "BUZZ_CHAT_ID missing" };
    if (!relayTagUrl) return { ok: false, reason: "BUZZ_RELAY_URL missing" };
    if (!groupId) return { ok: false, reason: "BUZZ_CHANNEL_IDS missing" };
    if (!operatorPubkey) {
      return { ok: false, reason: "BUZZ_OPERATOR_PUBKEY missing" };
    }
  }

  const authorized = buildAuthorizedSet(
    operatorPubkey,
    parseList(env.BUZZ_AUTHORIZED_PUBKEYS),
  );

  const config: BuzzRuntimeConfig = {
    enabled,
    agentName,
    chatId,
    relayUrl,
    relayTagUrl,
    relayHost: env.BUZZ_RELAY_HOST?.trim() ?? "",
    groupId,
    authorized,
    nsecVaultKey:
      env.BUZZ_NSEC_VAULT_KEY?.trim() ||
      `buzz/${agentName}-nsec`,
    pubkeyNames: parseNames(env.BUZZ_PUBKEY_NAMES),
    mirror,
  };
  return { ok: true, config };
}

/**
 * Resolve the Host header the WS client must send. Prefers the explicit
 * relay_host; else parses the authority (host[:port]) out of relay_url.
 * Returns '' when neither is available (caller sends no override).
 */
export function resolveRelayHost(cfg: Pick<BuzzRuntimeConfig, "relayHost" | "relayUrl">): string {
  if (cfg.relayHost) return cfg.relayHost;
  try {
    const u = new URL(cfg.relayUrl);
    return u.host; // host + port, no scheme
  } catch {
    return "";
  }
}
