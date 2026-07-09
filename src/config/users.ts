import type { SwitchroomConfig, AgentConfig } from "./schema.js";
import { resolveAgentConfig } from "./merge.js";

/**
 * First-class users — resolve the `users:` / `serves` / `knows` config for
 * one agent into the recall maps the scaffold emits (RFC
 * reference/rfcs/user-concept.md, memory-routing phase).
 *
 * UNION semantics, computed HERE (not via the replace-by-default config
 * cascade, which would drop fleet-wide `defaults.serves`):
 *   - `serves`/`knows` are unioned across the defaults tier and the cascaded
 *     agent value.
 *   - the generated maps are unioned with any explicit per-agent
 *     `memory.recall.sender_banks` / `additional_banks`.
 *
 * Mapping:
 *   - `serves` → each served user's `telegram_ids` map to their `profile_bank`
 *     (speaker routing → `sender_banks`).
 *   - `knows` → each entry resolves to a user's `profile_bank`, else is used
 *     as a raw bank name (subject knowledge → `additional_banks`).
 *
 * Unknown `serves` users are skipped defensively (the schema superRefine
 * already errors on them). Phase note: this does NOT generate access
 * (`allowFrom`) — agent access is paired as today.
 */
export interface ResolvedUserRecall {
  senderBanks: Record<string, string>;
  additionalBanks: string[];
}

export function resolveUsers(
  config: SwitchroomConfig,
  agentName: string,
): ResolvedUserRecall {
  const users = config.users ?? {};
  const agentRaw = config.agents?.[agentName];
  const agentConfig: AgentConfig | undefined = agentRaw
    ? resolveAgentConfig(config.defaults, config.profiles, agentRaw)
    : undefined;

  const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

  // serves/knows union the defaults tier with the cascaded agent value — the
  // cascade REPLACES arrays, so a fleet-wide `defaults.serves` would be lost.
  const serves = uniq([
    ...(config.defaults?.serves ?? []),
    ...(agentConfig?.serves ?? []),
  ]);
  const knows = uniq([
    ...(config.defaults?.knows ?? []),
    ...(agentConfig?.knows ?? []),
  ]);

  // serves → sender_banks (each served user's telegram_ids → profile_bank)
  const senderBanks: Record<string, string> = {};
  for (const userName of serves) {
    const u = users[userName];
    if (!u) continue; // unknown user — schema already flags it; stay defensive
    for (const id of u.telegram_ids) {
      senderBanks[id] = u.profile_bank;
    }
  }
  // union with explicit per-agent sender_banks (explicit wins on key conflict)
  Object.assign(senderBanks, agentConfig?.memory?.recall?.sender_banks ?? {});

  // knows → additional_banks (user → profile_bank, else raw bank), unioned
  // with explicit per-agent additional_banks.
  const additionalBanks = uniq([
    ...knows.map((entry) => users[entry]?.profile_bank ?? entry),
    ...(agentConfig?.memory?.recall?.additional_banks ?? []),
  ]);

  return { senderBanks, additionalBanks };
}

/**
 * Raw projection of `users:` entries that carry a `person_id` (see
 * `UserSchema.person_id` in schema.ts). This is a DUMB projection only — no
 * dedup, no shape validation beyond what the schema already enforces, no
 * dropping of malformed entries. That semantic validation happens
 * gateway-side (`telegram-plugin/gateway/resolve-person.ts`'s
 * `buildPersonDirectory`) at agent boot, because only the gateway process
 * can reach the fleet-alert path used to surface a dropped entry.
 *
 * Scaffolded into each agent's `telegram/people.json` (a plain
 * config-derived projection, regenerated on every scaffold/reconcile via
 * `writeFileSyncIfChanged` — unlike `access.json`, this file is never
 * mutated by the running gateway, so there's no "boot merge" step to
 * preserve).
 */
export interface RawPersonEntry {
  /** The `users:` map key (e.g. "lisa") — used only for alert messages. */
  key: string;
  person_id: string;
  telegram_ids: string[];
}

export function resolvePersonEntries(config: SwitchroomConfig): RawPersonEntry[] {
  const users = config.users ?? {};
  const entries: RawPersonEntry[] = [];
  for (const [key, u] of Object.entries(users)) {
    if (!u.person_id) continue;
    entries.push({ key, person_id: u.person_id, telegram_ids: u.telegram_ids });
  }
  return entries;
}
