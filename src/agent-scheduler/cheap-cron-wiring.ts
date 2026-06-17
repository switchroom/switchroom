/**
 * Cheap-cron live wiring — reference/rfcs/cheap-cron-sessions.md.
 *
 * Constructs the CheapCronHooks the in-agent scheduler passes to
 * registerAgentSchedule, from operator config + env + the vault broker.
 * Returns `undefined` when SWITCHROOM_CHEAP_CRON is off, so main() wires
 * nothing and behaviour is exactly today's.
 *
 * Every external dependency (the vault-broker secret resolver, fetch, DNS,
 * the poll-state store) is INJECTABLE with a real default. Tests pass fakes
 * and therefore never touch the real broker or network — the vault test
 * isolation discipline (CLAUDE.md; the 2026-05-22 clobber incident).
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { ActionSpec, PollSpec, SwitchroomConfig } from "../config/schema.js";
import { isCheapCronEnabled } from "../scheduler/cron-routing.js";
import type { EgressAllowlist } from "../scheduler/poll-egress.js";
import { runHttpDiffPoll, type HttpDiffSpec, type PollOutcome } from "../scheduler/poll-engine.js";
import { runAction as runActionEngine, type ActionOutcome } from "../scheduler/action-engine.js";
import { createFilePollStateStore, type PollStateStore } from "../scheduler/poll-state.js";
import { getViaBroker } from "../vault/broker/client.js";
// type-only (erased) → no runtime import cycle with index.ts.
import type { CheapCronHooks } from "./index.js";

/** Post a MODEL-FREE outbound to the agent's OWN chat (bound by the caller in
 *  main() over the IPC client + the agent's channel target). Returns true iff
 *  the bytes were accepted by the gateway socket. */
export type PostOutbound = (args: {
  threadId?: number;
  text: string;
  parseMode: "html" | "text";
}) => boolean;

export interface CheapCronWiringDeps {
  /** Resolve a vault secret by name. Default: the agent's vault broker (ACL by socket identity). */
  resolveSecret?: (name: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** host → resolved IP for the rebind pin. Default: node:dns. */
  lookup?: (host: string) => Promise<string | null>;
  pollState?: PollStateStore;
  now?: () => number;
  /** Agent slug — drives {{agent}} substitution in telegram-message actions. */
  agentName?: string;
  /** Model-free outbound seam for telegram-message actions (#2307). Absent ⟹
   *  a telegram-message action records "not delivered"; webhook actions are
   *  unaffected (they use fetch). main() wires this over the IPC sendOutbound. */
  postOutbound?: PostOutbound;
}

const defaultResolveSecret = async (name: string): Promise<string> => {
  const entry = await getViaBroker(name);
  if (!entry) throw new Error(`secret '${name}' unavailable from vault broker`);
  if (entry.kind !== "string") throw new Error(`secret '${name}' is not a string secret`);
  return entry.value;
};

const defaultLookup = async (host: string): Promise<string | null> => {
  try {
    return (await dnsLookup(host)).address;
  } catch {
    return null;
  }
};

export function buildCheapCronHooks(
  config: SwitchroomConfig,
  env: NodeJS.ProcessEnv,
  deps: CheapCronWiringDeps = {},
): CheapCronHooks | undefined {
  if (!isCheapCronEnabled(env)) return undefined;

  const egress: EgressAllowlist = {
    hosts: config.cron?.egress?.allowed_hosts ?? [],
    secretBindings: config.cron?.egress?.secret_bindings ?? {},
  };
  const pollState =
    deps.pollState ??
    createFilePollStateStore(env.SWITCHROOM_AGENT_POLL_STATE ?? "/state/agent/poll-state.json");
  const resolveSecret = deps.resolveSecret ?? defaultResolveSecret;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const now = deps.now ?? Date.now;
  const agentName = deps.agentName ?? env.SWITCHROOM_AGENT_NAME ?? "-";
  const postOutbound = deps.postOutbound;

  const runPoll = async (spec: PollSpec, prevCursor: string | undefined): Promise<PollOutcome> => {
    if (spec.type === "http-diff") {
      return runHttpDiffPoll(spec as HttpDiffSpec, prevCursor, {
        fetchImpl,
        resolveSecret,
        lookup,
        allow: egress,
        now,
      });
    }
    // Unreachable today — http-diff is the only poll type (the telegram-reactions
    // poll was removed; reaction_dispatch covers reactions). Kept as a
    // forward-compat guard for a future poll type added to PollSpecSchema: never
    // a silent success, always an audited poll-error.
    return { hit: false, baseline: false, error: "poll type not yet wired" };
  };

  // Tier-0 action (#2307): model-free, terminal. telegram-message posts to the
  // agent's own chat via postOutbound (the IPC send_outbound seam); webhook
  // fires through the shared egress fence. The engine never wakes a model.
  const runAction = async (
    spec: ActionSpec,
    ctx: { threadId?: number },
  ): Promise<ActionOutcome> => {
    return runActionEngine(spec, {
      fetchImpl,
      resolveSecret,
      lookup,
      allow: egress,
      now,
      agent: agentName,
      sendMessage: async (text, opts) =>
        postOutbound
          ? postOutbound({ threadId: ctx.threadId, text, parseMode: opts.parseMode })
          : false,
    });
  };

  return { enabled: true, pollState, runPoll, runAction };
}
