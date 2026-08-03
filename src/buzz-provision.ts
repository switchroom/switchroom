/**
 * Buzz per-agent identity provisioning — core logic (PR-2 of the Buzz
 * live-enablement plan).
 *
 * `switchroom buzz provision <agent>` mints a per-agent Nostr keypair, stores
 * the secret key (nsec) STRAIGHT into the vault, and grants the agent read on
 * that key — so the sidecar can broker-fetch it in-process at boot (never an
 * env var, never a log line; job spec `use-my-team-from-the-desktop.md`,
 * Production-readiness §Security). `switchroom buzz status <agent>` reports the
 * four preconditions for a live channel.
 *
 * This module is deliberately free of any vault-store / broker / commander
 * import: the vault write and the grant are injected through {@link
 * BuzzProvisionStore}, and status is computed from raw inputs. That keeps it
 * (a) hermetic and unit-testable under vitest without dragging `bun:sqlite`
 * (which `src/vault/vault.ts` transitively pulls) into the module graph, and
 * (b) structurally unable to leak the nsec — the run/print path never receives
 * it, only the npub.
 *
 * The relay-side enrollment is an OFF-REPO operator act: this module only
 * PRINTS the exact `buzz-admin add-member` command. It never dials, never
 * writes to the relay.
 */

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

/** Relay container name the operator runs `buzz-admin` against (off-repo). */
export const BUZZ_RELAY_CONTAINER = "buzz-relay-1";

/**
 * Default vault key NAME for an agent's nsec. Mirrors the sidecar's
 * `BUZZ_NSEC_VAULT_KEY` default and the schema `nsec_vault_key` default
 * (`buzz/{agent}-nsec`) — keep these in sync (`src/buzz-gateway/config.ts`,
 * `src/config/schema.ts`).
 */
export function buzzNsecKey(agent: string): string {
  return `buzz/${agent}-nsec`;
}

export interface BuzzKeypair {
  /** bech32 `nsec1…` secret key — SECRET, never printed or returned upward. */
  nsec: string;
  /** bech32 `npub1…` public key — safe to print and enroll on the relay. */
  npub: string;
  /** 64-char hex public key. */
  pubkeyHex: string;
}

/** Generate a fresh Nostr keypair in-process (nostr-tools). */
export function generateBuzzKeypair(): BuzzKeypair {
  const sk = generateSecretKey();
  const pubkeyHex = getPublicKey(sk);
  return {
    nsec: nip19.nsecEncode(sk),
    npub: nip19.npubEncode(pubkeyHex),
    pubkeyHex,
  };
}

/** The exact operator command to enroll an npub on the closed relay. */
export function buzzAddMemberCommand(npub: string): string {
  return `docker exec ${BUZZ_RELAY_CONTAINER} buzz-admin add-member ${npub}`;
}

/**
 * Reminder lines printed on a ROTATE. Rotation exists for a suspected nsec
 * compromise — but re-enrolling the NEW npub is only half the job: the OLD
 * npub is still on the closed relay's member list and a leaked key still
 * authenticates and can read the group. The overwritten nsec means the prior
 * npub is no longer derivable here, so we can't print a targeted
 * `remove-member <npub>`; instead we tell the operator to list the current
 * members and remove the agent's prior one.
 *
 * `buzz-admin` is the off-repo relay tool (the same one that runs
 * `add-member`); its member list/remove subcommands live with it, so we point
 * at `buzz-admin --help` rather than fabricate a subcommand name this repo
 * cannot verify.
 */
export function buzzRelayMemberRemovalReminder(agent: string): string[] {
  return [
    `SECURITY: rotation does NOT remove '${agent}'s PREVIOUS npub from the relay.`,
    "A leaked old key still authenticates and can read the group until you",
    "remove it. The prior npub is no longer derivable here (the nsec was",
    "overwritten), so list the relay's current members and remove the agent's",
    "prior npub on the relay host:",
    `  docker exec ${BUZZ_RELAY_CONTAINER} buzz-admin --help   # find the member list/remove subcommands`,
  ];
}

/**
 * The `channels.buzz` YAML block to paste under the agent in switchroom.yaml.
 * Placeholders (`<…>`) are the operator's to fill from the live relay; the
 * nsec_vault_key and operator allowlist wiring are pre-filled. Dark by default
 * — the operator flips `enabled: true` deliberately (job spec: "The channel
 * ships dark").
 */
export function buzzChannelYamlBlock(agent: string, npub: string): string {
  const key = buzzNsecKey(agent);
  return [
    "    channels:",
    "      buzz:",
    "        enabled: false        # flip to true deliberately to go live",
    '        relay_url: "<ws://canonical-relay-url:3000>"',
    '        relay_host: "<canonical-relay-host:3000>"',
    '        chat_id: "<telegram-chat-id-for-injected-turns>"',
    '        default_channel_id: "<relay-minted-group-uuid>"',
    '        operator_pubkey: "<operator-npub-or-hex>"',
    `        nsec_vault_key: "${key}"   # this agent's npub: ${npub}`,
    '        mirror: "both"',
  ].join("\n");
}

// ─── Provision ────────────────────────────────────────────────────────────

/** Outcome of the (injected) grant step. */
export type BuzzGrantOutcome = { ok: true } | { ok: false; error: string };

/**
 * The agent's CURRENT active grant key sets, as read back before minting.
 * `read`/`write` are the `key_allow`/`write_allow` of the agent's active
 * (non-revoked, non-expired) grant. `null` means the broker could not be read
 * — provisioning then warns that the mint REPLACES the token.
 */
export type BuzzExistingGrantKeys = { read: string[]; write: string[] } | null;

/**
 * The side-effecting operations the CLI wires to the real vault + broker;
 * tests inject fakes. The nsec flows ONLY into {@link writeNsec} — no method
 * ever hands it back, so no caller of `provisionBuzzIdentity` can print it.
 */
export interface BuzzProvisionStore {
  /** True iff the nsec key already exists in the vault. */
  hasNsec(key: string): boolean | Promise<boolean>;
  /** Write (or overwrite) the nsec value at the vault key. */
  writeNsec(key: string, nsec: string): void | Promise<void>;
  /**
   * Read the agent's current active grant key sets so provisioning can UNION
   * the new nsec key into them. A grant mints a fresh single `.vault-token`
   * that REPLACES the agent's prior one, so minting `[nsecKey]` alone would
   * silently drop every other capability the agent already holds (e.g. a
   * `coolify/api-token` read grant). Mirrors the gateway's grant-union flow
   * (`telegram-plugin/gateway/callback-query-handlers.ts` #1051). `null` =
   * broker unreadable; provisioning then warns and mints nsec-only.
   */
  existingGrantKeys(agent: string): Promise<BuzzExistingGrantKeys>;
  /**
   * Grant the agent READ on `readKeys` (and WRITE on `writeKeys`) via the
   * broker. `readKeys` already includes the nsec key UNIONed with the agent's
   * existing keys, so the mint preserves prior capabilities.
   */
  grantRead(
    agent: string,
    readKeys: string[],
    writeKeys: string[],
  ): Promise<BuzzGrantOutcome>;
}

export interface BuzzProvisionOpts {
  /** Overwrite an existing key instead of refusing. */
  rotate?: boolean;
  /** Skip the grant step. */
  noGrant?: boolean;
  /** Override the nsec vault key name (defaults to `buzz/<agent>-nsec`). */
  nsecKey?: string;
  /** Test seam — defaults to the real nostr-tools generator. */
  genKeypair?: () => BuzzKeypair;
}

/**
 * How the new nsec key was combined with the agent's existing grant keys.
 * - `unioned`: existing keys were read and folded in (`priorKeys` = count).
 * - `unknown`: the broker could not be read, so the mint REPLACED the token
 *   with an nsec-only grant, dropping any prior capabilities — caller warns.
 * - `n/a`: grant was skipped (`--no-grant`).
 */
export type BuzzGrantUnion =
  | { kind: "unioned"; priorKeys: number }
  | { kind: "unknown" }
  | { kind: "n/a" };

export type BuzzProvisionResult =
  | { kind: "exists"; nsecKey: string }
  | {
      kind: "ok";
      npub: string;
      nsecKey: string;
      /** True when an existing key was overwritten (--rotate). */
      rotated: boolean;
      grant: "granted" | "skipped" | { failed: string };
      /** Whether existing grant keys were preserved in the mint. */
      grantUnion: BuzzGrantUnion;
    };

/**
 * Provision (or rotate) a per-agent Buzz identity. Generates a keypair, writes
 * the nsec to the vault, optionally grants read. Refuses when the key already
 * exists unless `rotate` is set. The returned result carries only the npub —
 * never the nsec.
 */
export async function provisionBuzzIdentity(
  agent: string,
  store: BuzzProvisionStore,
  opts: BuzzProvisionOpts = {},
): Promise<BuzzProvisionResult> {
  const nsecKey = opts.nsecKey ?? buzzNsecKey(agent);

  const exists = await store.hasNsec(nsecKey);
  if (exists && !opts.rotate) {
    return { kind: "exists", nsecKey };
  }

  const kp = (opts.genKeypair ?? generateBuzzKeypair)();
  await store.writeNsec(nsecKey, kp.nsec);

  let grant: "granted" | "skipped" | { failed: string };
  let grantUnion: BuzzGrantUnion;
  if (opts.noGrant) {
    grant = "skipped";
    grantUnion = { kind: "n/a" };
  } else {
    // UNION the nsec key with the agent's existing grant keys before minting,
    // so the fresh single-token grant preserves prior capabilities instead of
    // clobbering them. If the broker can't be read, fail open: mint nsec-only
    // and flag `unknown` so the caller warns the token was replaced.
    const existing = await store.existingGrantKeys(agent);
    const readKeys = new Set<string>();
    const writeKeys = new Set<string>();
    if (existing === null) {
      grantUnion = { kind: "unknown" };
    } else {
      for (const k of existing.read) readKeys.add(k);
      for (const k of existing.write) writeKeys.add(k);
      // priorKeys counts only keys OTHER than the nsec key we're about to add.
      const priorKeys = new Set([...existing.read, ...existing.write]);
      priorKeys.delete(nsecKey);
      grantUnion = { kind: "unioned", priorKeys: priorKeys.size };
    }
    readKeys.add(nsecKey);
    const g = await store.grantRead(
      agent,
      Array.from(readKeys),
      Array.from(writeKeys),
    );
    grant = g.ok ? "granted" : { failed: g.error };
  }

  return {
    kind: "ok",
    npub: kp.npub,
    nsecKey,
    rotated: Boolean(exists),
    grant,
    grantUnion,
  };
}

/** Minimal console seam so the print path is testable and default-real. */
export interface BuzzConsole {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const DEFAULT_CONSOLE: BuzzConsole = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
};

/**
 * Run `buzz provision`: provision, then print the npub, the operator
 * enrollment command, and the yaml block. Returns an exit code. Note this
 * function receives ONLY the npub-bearing {@link BuzzProvisionResult}; the nsec
 * is unreachable from here by construction.
 */
export async function runBuzzProvision(
  agent: string,
  store: BuzzProvisionStore,
  opts: BuzzProvisionOpts,
  io: BuzzConsole = DEFAULT_CONSOLE,
): Promise<{ exitCode: number; result: BuzzProvisionResult }> {
  const res = await provisionBuzzIdentity(agent, store, opts);

  if (res.kind === "exists") {
    io.error(
      `Buzz identity already provisioned for '${agent}' (vault key '${res.nsecKey}').`,
    );
    io.error(
      "Re-run with --rotate to overwrite it. Rotating invalidates the current " +
        "npub — the operator must re-enroll the new one on the relay.",
    );
    return { exitCode: 1, result: res };
  }

  io.log(
    res.rotated
      ? `Rotated Buzz identity for '${agent}'.`
      : `Provisioned Buzz identity for '${agent}'.`,
  );
  io.log(`  nsec written to vault key '${res.nsecKey}' (never printed).`);

  if (res.grant === "granted") {
    if (res.grantUnion.kind === "unioned" && res.grantUnion.priorKeys > 0) {
      io.log(
        `  granted '${agent}' read on '${res.nsecKey}' ` +
          `(unioned with ${res.grantUnion.priorKeys} existing grant key(s), preserved).`,
      );
    } else {
      io.log(`  granted '${agent}' read on '${res.nsecKey}'.`);
    }
    if (res.grantUnion.kind === "unknown") {
      io.error(
        `  WARNING: could not read '${agent}'s existing grants, so this mint ` +
          `REPLACED the agent's vault token with an nsec-only grant. If the ` +
          `agent held other capabilities (e.g. a coolify/api-token read), ` +
          `re-grant them: switchroom vault grant ${agent} --keys <key>`,
      );
    }
  } else if (res.grant === "skipped") {
    io.log(
      `  grant skipped (--no-grant). Grant it before going live: ` +
        `switchroom vault grant ${agent} --keys ${res.nsecKey}`,
    );
  } else {
    io.error(
      `  WARNING: grant failed (${res.grant.failed}). The nsec is stored but ` +
        `'${agent}' cannot read it yet. Grant manually: ` +
        `switchroom vault grant ${agent} --keys ${res.nsecKey}`,
    );
  }

  io.log("");
  io.log(`npub: ${res.npub}`);
  io.log("");
  io.log(
    "Operator: enroll this npub on the relay (off-repo — run on the relay host):",
  );
  io.log(`  ${buzzAddMemberCommand(res.npub)}`);
  io.log("");
  io.log("Then add this block under the agent in switchroom.yaml:");
  io.log("");
  io.log(buzzChannelYamlBlock(agent, res.npub));

  // On a rotate, re-enrolling the new npub is only half the job — the OLD
  // npub is still a relay member and a leaked key still reads the group.
  if (res.rotated) {
    io.log("");
    for (const line of buzzRelayMemberRemovalReminder(agent)) io.error(line);
  }

  return { exitCode: 0, result: res };
}

// ─── Status ───────────────────────────────────────────────────────────────

export type BuzzCheckStatus = "green" | "red" | "unknown";

export interface BuzzCheck {
  status: BuzzCheckStatus;
  detail: string;
}

export interface BuzzStatusReport {
  /** Vault key present? */
  vaultKey: BuzzCheck;
  /** Grant present for this agent on the key? */
  grant: BuzzCheck;
  /** Compose env projected (`BUZZ_*` on the agent service)? */
  composeEnv: BuzzCheck;
  /** Sidecar log shows `AUTH accepted` / `EOSE (live)`? */
  sidecar: BuzzCheck;
}

export interface BuzzStatusInputs {
  /** Vault key name to look for (defaults to `buzz/<agent>-nsec`). */
  nsecKey?: string;
  /** Vault key names the caller can enumerate; null = couldn't determine. */
  vaultKeys: string[] | null;
  /**
   * Active (non-revoked) grants; null = couldn't determine. `expires_at` is
   * unix seconds, or null/undefined for a non-expiring grant. It MUST be
   * carried through: the broker's `listGrants` filters `revoked_at` only, not
   * `expires_at`, so an expired grant still appears here — treating it as
   * present would false-green a channel the sidecar actually gets
   * `grant-expired` on.
   */
  grants:
    | { agent_slug: string; key_allow: string[]; expires_at?: number | null }[]
    | null;
  /** Rendered compose YAML; null = not found / unreadable. */
  composeYaml: string | null;
  /** Sidecar log tail; null = unreadable (container down, no log). */
  logTail: string | null;
  /** Test seam for "now" (unix seconds); defaults to the wall clock. */
  now?: number;
}

/**
 * Slice the environment lines belonging to one agent's compose service. The
 * generator emits `agent-<name>:` with 6-space-indented `KEY: value` env
 * entries under an `environment:` map (mirrors compose-buzz-env.test.ts). We
 * take everything from the service header to the next same-or-shallower
 * `\S`-starting service key and scan that window for `BUZZ_`.
 */
export function agentServiceBlock(composeYaml: string, agent: string): string | null {
  const lines = composeYaml.split("\n");
  const header = `agent-${agent}:`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  const startIndent = lines[start].length - lines[start].trimStart().length;
  const out: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    // A sibling service key at the same (or shallower) indent ends the block.
    if (indent <= startIndent) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Compute the four-check status report from raw inputs. */
export function computeBuzzStatus(
  agent: string,
  inputs: BuzzStatusInputs,
): BuzzStatusReport {
  const nsecKey = inputs.nsecKey ?? buzzNsecKey(agent);

  // 1. Vault key present?
  let vaultKey: BuzzCheck;
  if (inputs.vaultKeys === null) {
    vaultKey = { status: "unknown", detail: "could not read vault keys" };
  } else if (inputs.vaultKeys.includes(nsecKey)) {
    vaultKey = { status: "green", detail: `vault key '${nsecKey}' present` };
  } else {
    vaultKey = {
      status: "red",
      detail: `vault key '${nsecKey}' missing — run: switchroom buzz provision ${agent}`,
    };
  }

  // 2. Grant present AND unexpired for this agent on the key? An expired grant
  //    still shows up in listGrants (it filters revoked_at only) but the
  //    sidecar gets `grant-expired` — so an expired-only match is RED, not a
  //    false green.
  let grant: BuzzCheck;
  if (inputs.grants === null) {
    grant = { status: "unknown", detail: "could not read grants" };
  } else {
    const now = inputs.now ?? Math.floor(Date.now() / 1000);
    const matching = inputs.grants.filter(
      (g) => g.agent_slug === agent && g.key_allow.includes(nsecKey),
    );
    const active = matching.filter(
      (g) => g.expires_at == null || g.expires_at > now,
    );
    if (active.length > 0) {
      grant = { status: "green", detail: `'${agent}' granted read on '${nsecKey}'` };
    } else if (matching.length > 0) {
      grant = {
        status: "red",
        detail: `grant for '${agent}' on '${nsecKey}' EXPIRED — re-grant: switchroom vault grant ${agent} --keys ${nsecKey}`,
      };
    } else {
      grant = {
        status: "red",
        detail: `no grant for '${agent}' on '${nsecKey}' — run: switchroom vault grant ${agent} --keys ${nsecKey}`,
      };
    }
  }

  // 3. Compose env projected?
  let composeEnv: BuzzCheck;
  if (inputs.composeYaml === null) {
    composeEnv = { status: "unknown", detail: "compose file not found" };
  } else {
    const block = agentServiceBlock(inputs.composeYaml, agent);
    if (block === null) {
      composeEnv = {
        status: "red",
        detail: `no agent-${agent} service in the generated compose`,
      };
    } else if (/\bBUZZ_/.test(block)) {
      composeEnv = {
        status: "green",
        detail: `BUZZ_* env projected on agent-${agent}`,
      };
    } else {
      composeEnv = {
        status: "red",
        detail: `no BUZZ_* env on agent-${agent} — add channels.buzz and run: switchroom apply`,
      };
    }
  }

  // 4. Sidecar live (AUTH accepted / EOSE (live))?
  let sidecar: BuzzCheck;
  if (inputs.logTail === null) {
    sidecar = {
      status: "unknown",
      detail: "sidecar log unreadable (container down or channel dark)",
    };
  } else if (/AUTH accepted|EOSE \(live\)/.test(inputs.logTail)) {
    sidecar = { status: "green", detail: "sidecar authed and live on the relay" };
  } else {
    sidecar = {
      status: "red",
      detail: "sidecar log shows no AUTH accepted / EOSE (live)",
    };
  }

  return { vaultKey, grant, composeEnv, sidecar };
}

const CHECK_MARK: Record<BuzzCheckStatus, string> = {
  green: "[green]",
  red: "[ red ]",
  unknown: "[  ?  ]",
};

/** Format the report as human lines (mark + label + detail). */
export function formatBuzzStatus(agent: string, report: BuzzStatusReport): string[] {
  const rows: [string, BuzzCheck][] = [
    ["vault key ", report.vaultKey],
    ["grant     ", report.grant],
    ["compose   ", report.composeEnv],
    ["sidecar   ", report.sidecar],
  ];
  return [
    `Buzz status for '${agent}':`,
    ...rows.map(
      ([label, c]) => `  ${CHECK_MARK[c.status]} ${label} ${c.detail}`,
    ),
  ];
}

/** True when every check is green (channel fully live). */
export function isBuzzFullyLive(report: BuzzStatusReport): boolean {
  return (
    report.vaultKey.status === "green" &&
    report.grant.status === "green" &&
    report.composeEnv.status === "green" &&
    report.sidecar.status === "green"
  );
}
