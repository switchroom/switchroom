/**
 * Pure logic for the `/auth` slot-management sub-verbs (add/use/list/rm).
 *
 * Lives outside gateway.ts + server.ts so it's unit-testable without
 * spinning up a grammy bot. The gateway/server command handlers call
 * `parseAuthSubCommand` to turn a raw /auth argv into a dispatch plan
 * (switchroom CLI args + label + optional post-action hook), then
 * handle that plan via their existing runSwitchroomCommand pipeline.
 */

/** Pattern used by slot names throughout switchroom. Matches the shape
 *  used by `addAccountStart` and slot-dir naming in src/auth/accounts.ts. */
const SLOT_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export function assertSafeSlotName(slot: string): void {
  if (!SLOT_NAME_RE.test(slot)) {
    throw new Error(`invalid slot name: ${slot}`);
  }
}

/** Pattern used by global account labels — matches validateAccountLabel
 *  in src/auth/account-store.ts ([A-Za-z0-9._-]+, max 64 chars). */
const ACCOUNT_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function assertSafeAccountLabel(label: string): void {
  if (label === '.' || label === '..') {
    throw new Error(`invalid account label: ${label}`);
  }
  if (!ACCOUNT_LABEL_RE.test(label)) {
    throw new Error(`invalid account label: ${label}`);
  }
}

/** Agent-name check mirrored from gateway.ts so the parser doesn't
 *  need to import gateway.ts (which has top-level side effects). */
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export function assertSafeAgentNameForParser(name: string): void {
  if (name !== 'all' && !AGENT_NAME_RE.test(name)) {
    throw new Error(`invalid agent name: ${name}`);
  }
}

export type AuthIntent =
  | { kind: 'login' | 'reauth' | 'link'; agent: string; label: string; cliArgs: string[]; registerReauth: boolean }
  | { kind: 'code'; agent: string; code: string; label: string; cliArgs: string[] }
  | { kind: 'cancel'; agent: string; label: string; cliArgs: string[] }
  | { kind: 'status'; label: string; cliArgs: string[] }
  | { kind: 'add'; agent: string; slot?: string; label: string; cliArgs: string[] }
  | { kind: 'use'; agent: string; slot: string; force: boolean; label: string; cliArgs: string[]; restartAgentAfter: true }
  | { kind: 'list'; agent: string; label: string; cliArgs: string[] }
  | { kind: 'rm'; agent: string; slot: string; force: boolean; label: string; cliArgs: string[] }
  // ── New account-shaped verbs (see reference/share-auth-across-the-fleet.md) ──
  | { kind: 'account-add'; account: string; fromAgent: string; label: string; cliArgs: string[] }
  | { kind: 'account-list'; label: string; cliArgs: string[] }
  | { kind: 'account-rm'; account: string; label: string; cliArgs: string[] }
  | { kind: 'enable'; account: string; agents: string[]; label: string; cliArgs: string[]; restartAgentsAfter: true }
  | { kind: 'disable'; account: string; agents: string[]; label: string; cliArgs: string[] }
  | { kind: 'share'; account: string; fromAgent: string; label: string; cliArgs: string[]; restartAgentsAfter: true }
  | { kind: 'usage'; message: string }
  | { kind: 'error'; message: string };

export const AUTH_VERBS = [
  'login', 'reauth', 'link',
  'code', 'cancel', 'status',
  'add', 'use', 'list', 'rm',
  // New account-shaped verbs
  'account', 'enable', 'disable', 'share',
] as const;

/** Help/usage string shown for unknown subcommands. Keep wording close
 *  to the previous inline usage so the help-text asserting tests
 *  naturally catch drift. */
export function usageText(): string {
  return [
    'Usage:',
    '/auth                                       — status dashboard',
    '',
    'Per-agent (legacy slot model):',
    '/auth login [agent]                         — start OAuth for agent',
    '/auth reauth [agent]                        — re-auth from scratch',
    '/auth code [agent] <browser-code>           — finish OAuth flow',
    '/auth cancel [agent]                        — cancel pending flow',
    '/auth add [agent] [--slot <name>]           — add another slot',
    '/auth use [agent] <slot> [--force]          — switch active slot',
    '/auth list [agent]                          — list slots',
    '/auth rm [agent] <slot> [--force]           — remove a slot',
    '',
    'Anthropic accounts (shared across agents):',
    '/auth account add <label> [--from-agent <name>]  — promote slot to global account',
    '/auth account list                          — accounts + agents using each',
    '/auth account rm <label>                    — remove (refused if enabled)',
    '/auth enable <label> [agents...|all]        — wire account to agent(s); "all" = every agent',
    '/auth disable <label> [agents...|all]       — unwire account from agent(s); "all" = every agent',
    '/auth share <label> [--from-agent <name>]   — account add + enable on every agent in one step',
  ].join('\n');
}

/**
 * Turn raw /auth argv into a dispatch intent.
 *
 * `parts` is the whitespace-split tail of the /auth command (no leading
 * "/auth"). `currentAgent` is the agent this gateway process represents.
 * Missing agent arg defaults to `currentAgent` so single-agent setups
 * Just Work without typing the name.
 */
export function parseAuthSubCommand(
  parts: string[],
  currentAgent: string,
): AuthIntent {
  const sub = (parts[0] ?? 'status').toLowerCase();

  // Existing verbs — kept here so both gateway.ts and server.ts can
  // route them through a single source of truth once they migrate.
  if (sub === 'login' || sub === 'reauth' || sub === 'link') {
    const agent = parts[1] ?? currentAgent;
    try { assertSafeAgentNameForParser(agent); }
    catch { return { kind: 'error', message: 'Invalid agent name.' }; }
    return {
      kind: sub,
      agent,
      label: `auth ${sub} ${agent}`,
      cliArgs: ['auth', sub, agent],
      registerReauth: sub === 'reauth' || sub === 'login',
    };
  }

  if (sub === 'code') {
    let agent = currentAgent; let code = '';
    if (parts.length >= 3) { agent = parts[1]; code = parts.slice(2).join(' '); }
    else if (parts.length === 2) { code = parts[1]; }
    if (!code) return { kind: 'usage', message: 'Usage: /auth code [agent] <browser-code>' };
    try { assertSafeAgentNameForParser(agent); }
    catch { return { kind: 'error', message: 'Invalid agent name.' }; }
    return { kind: 'code', agent, code, label: `auth code ${agent}`, cliArgs: ['auth', 'code', agent, code] };
  }

  if (sub === 'cancel') {
    const agent = parts[1] ?? currentAgent;
    try { assertSafeAgentNameForParser(agent); }
    catch { return { kind: 'error', message: 'Invalid agent name.' }; }
    return { kind: 'cancel', agent, label: `auth cancel ${agent}`, cliArgs: ['auth', 'cancel', agent] };
  }

  if (sub === 'status') {
    return { kind: 'status', label: 'auth status', cliArgs: ['auth', 'status'] };
  }

  // --- New slot-management verbs ---

  if (sub === 'add') {
    // /auth add [agent] [--slot <name>]
    const rest = parts.slice(1);
    const { flags, positional } = splitFlags(rest, ['--slot']);
    const agent = positional[0] ?? currentAgent;
    // splitFlags returns `string | true | undefined` for value flags
    // (true when the flag is present without a value). For `--slot` we
    // expect a string value; reject the bare-flag form.
    const rawSlot = flags['--slot'];
    const slot = typeof rawSlot === 'string' ? rawSlot : undefined;
    try { assertSafeAgentNameForParser(agent); }
    catch { return { kind: 'error', message: 'Invalid agent name.' }; }
    if (slot !== undefined) {
      try { assertSafeSlotName(slot); }
      catch { return { kind: 'error', message: 'Invalid slot name. Use [A-Za-z0-9_-], 1-32 chars.' }; }
    }
    const cliArgs = ['auth', 'add', agent];
    if (slot) cliArgs.push('--slot', slot);
    return { kind: 'add', agent, slot, label: `auth add ${agent}`, cliArgs };
  }

  if (sub === 'use') {
    // /auth use [agent] <slot> [--force]
    const rest = parts.slice(1);
    const { flags, positional } = splitFlags(rest, []);
    if (positional.length === 0) {
      return { kind: 'usage', message: 'Usage: /auth use [agent] <slot> [--force]' };
    }
    const [agent, slot] = positional.length === 1
      ? [currentAgent, positional[0]]
      : [positional[0], positional[1]];
    try { assertSafeAgentNameForParser(agent); }
    catch { return { kind: 'error', message: 'Invalid agent name.' }; }
    try { assertSafeSlotName(slot); }
    catch { return { kind: 'error', message: 'Invalid slot name. Use [A-Za-z0-9_-], 1-32 chars.' }; }
    return {
      kind: 'use', agent, slot,
      force: flags['--force'] === true,
      label: `auth use ${agent} ${slot}`,
      cliArgs: ['auth', 'use', agent, slot],
      restartAgentAfter: true,
    };
  }

  if (sub === 'list') {
    const agent = parts[1] ?? currentAgent;
    try { assertSafeAgentNameForParser(agent); }
    catch { return { kind: 'error', message: 'Invalid agent name.' }; }
    return {
      kind: 'list', agent,
      label: `auth list ${agent}`,
      cliArgs: ['auth', 'list', agent, '--json'],
    };
  }

  if (sub === 'rm') {
    // /auth rm [agent] <slot> [--force]
    const rest = parts.slice(1);
    const { flags, positional } = splitFlags(rest, ['--force']);
    if (positional.length === 0) {
      return { kind: 'usage', message: 'Usage: /auth rm [agent] <slot> [--force]' };
    }
    const [agent, slot] = positional.length === 1
      ? [currentAgent, positional[0]]
      : [positional[0], positional[1]];
    try { assertSafeAgentNameForParser(agent); }
    catch { return { kind: 'error', message: 'Invalid agent name.' }; }
    try { assertSafeSlotName(slot); }
    catch { return { kind: 'error', message: 'Invalid slot name. Use [A-Za-z0-9_-], 1-32 chars.' }; }
    const force = flags['--force'] === true;
    return {
      kind: 'rm', agent, slot, force,
      label: `auth rm ${agent} ${slot}`,
      cliArgs: ['auth', 'rm', agent, slot],
    };
  }

  // --- Account-shaped verbs (see reference/share-auth-across-the-fleet.md) ---

  if (sub === 'account') {
    const accountSub = (parts[1] ?? 'list').toLowerCase();

    if (accountSub === 'add') {
      // /auth account add <label> [--from-agent <name>]
      // Default --from-agent to the current agent — that's the common case
      // for a Telegram-only operator who just /auth login'd this agent.
      const rest = parts.slice(2);
      const { flags, positional } = splitFlags(rest, ['--from-agent']);
      const account = positional[0];
      if (!account) {
        return {
          kind: 'usage',
          message: 'Usage: /auth account add <label> [--from-agent <name>]',
        };
      }
      try { assertSafeAccountLabel(account); }
      catch { return { kind: 'error', message: 'Invalid account label. Use [A-Za-z0-9._-], 1-64 chars.' }; }
      const fromAgentRaw = flags['--from-agent'];
      const fromAgent = typeof fromAgentRaw === 'string' ? fromAgentRaw : currentAgent;
      try { assertSafeAgentNameForParser(fromAgent); }
      catch { return { kind: 'error', message: 'Invalid --from-agent value.' }; }
      return {
        kind: 'account-add',
        account,
        fromAgent,
        label: `auth account add ${account}`,
        cliArgs: ['auth', 'account', 'add', account, '--from-agent', fromAgent],
      };
    }

    if (accountSub === 'list') {
      return {
        kind: 'account-list',
        label: 'auth account list',
        cliArgs: ['auth', 'account', 'list'],
      };
    }

    if (accountSub === 'rm') {
      // /auth account rm <label>
      const account = parts[2];
      if (!account) {
        return { kind: 'usage', message: 'Usage: /auth account rm <label>' };
      }
      try { assertSafeAccountLabel(account); }
      catch { return { kind: 'error', message: 'Invalid account label.' }; }
      return {
        kind: 'account-rm',
        account,
        label: `auth account rm ${account}`,
        cliArgs: ['auth', 'account', 'rm', account],
      };
    }

    return {
      kind: 'usage',
      message: 'Usage: /auth account add | list | rm  (see /auth)',
    };
  }

  if (sub === 'enable') {
    // /auth enable <label> [agents...] — defaults to the current agent.
    const rest = parts.slice(1);
    const account = rest[0];
    if (!account) {
      return { kind: 'usage', message: 'Usage: /auth enable <label> [agents...]' };
    }
    try { assertSafeAccountLabel(account); }
    catch { return { kind: 'error', message: 'Invalid account label.' }; }
    const agents = rest.slice(1);
    if (agents.length === 0) agents.push(currentAgent);
    for (const a of agents) {
      try { assertSafeAgentNameForParser(a); }
      catch { return { kind: 'error', message: `Invalid agent name: ${a}` }; }
    }
    return {
      kind: 'enable',
      account,
      agents,
      label: `auth enable ${account} ${agents.join(' ')}`,
      cliArgs: ['auth', 'enable', account, ...agents],
      restartAgentsAfter: true,
    };
  }

  if (sub === 'disable') {
    // /auth disable <label> [agents...] — defaults to the current agent.
    const rest = parts.slice(1);
    const account = rest[0];
    if (!account) {
      return { kind: 'usage', message: 'Usage: /auth disable <label> [agents...]' };
    }
    try { assertSafeAccountLabel(account); }
    catch { return { kind: 'error', message: 'Invalid account label.' }; }
    const agents = rest.slice(1);
    if (agents.length === 0) agents.push(currentAgent);
    for (const a of agents) {
      try { assertSafeAgentNameForParser(a); }
      catch { return { kind: 'error', message: `Invalid agent name: ${a}` }; }
    }
    return {
      kind: 'disable',
      account,
      agents,
      label: `auth disable ${account} ${agents.join(' ')}`,
      cliArgs: ['auth', 'disable', account, ...agents],
    };
  }

  if (sub === 'share') {
    // /auth share <label> [--from-agent <name>] — one-shot: account add + enable
    // on every agent. Defaults --from-agent to the current agent (same shape as
    // /auth account add).
    const rest = parts.slice(1);
    const { flags, positional } = splitFlags(rest, ['--from-agent']);
    const account = positional[0];
    if (!account) {
      return { kind: 'usage', message: 'Usage: /auth share <label> [--from-agent <name>]' };
    }
    try { assertSafeAccountLabel(account); }
    catch { return { kind: 'error', message: 'Invalid account label. Use [A-Za-z0-9._-], 1-64 chars.' }; }
    const fromAgentRaw = flags['--from-agent'];
    const fromAgent = typeof fromAgentRaw === 'string' ? fromAgentRaw : currentAgent;
    try { assertSafeAgentNameForParser(fromAgent); }
    catch { return { kind: 'error', message: 'Invalid --from-agent value.' }; }
    return {
      kind: 'share',
      account,
      fromAgent,
      label: `auth share ${account}`,
      cliArgs: ['auth', 'share', account, '--from-agent', fromAgent],
      restartAgentsAfter: true,
    };
  }

  return { kind: 'usage', message: usageText() };
}

/** Helper to split --flag [value]? from positional args.
 *  Value-taking flags are passed in `valueFlags`; bare flags (like
 *  --force) show up in `flags` as boolean true.*/
export function splitFlags(
  parts: string[],
  valueFlags: string[],
): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const valueSet = new Set(valueFlags);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('--')) {
      if (valueSet.has(p)) {
        const next = parts[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags[p] = next; i++; }
        else flags[p] = true;
      } else {
        flags[p] = true;
      }
    } else {
      positional.push(p);
    }
  }
  return { flags, positional };
}

/** Active + total slot accounting for the rm safety check.
 *  Returned from the CLI's --json shape (see src/cli/auth.ts `list`). */
export type SlotListingFromCli = {
  agent: string;
  slots: Array<{
    slot: string;
    active: boolean;
    health: string;
    expires_at: number | null;
    quota_exhausted_until: number | null;
  }>;
};

/** Check whether a /auth rm is safe. Returns `null` if safe, or an error
 *  message if the slot is the only/active slot without --force. */
export function checkRemoveSafety(
  listing: SlotListingFromCli,
  targetSlot: string,
  force: boolean,
): string | null {
  if (force) return null;
  if (listing.slots.length <= 1) {
    return `Refusing to remove the only account slot. Add another with /auth add ${listing.agent}, or pass --force to proceed.`;
  }
  const target = listing.slots.find(s => s.slot === targetSlot);
  if (!target) return null; // CLI will error with its own message
  if (target.active) {
    return `Refusing to remove the active slot "${targetSlot}". Switch first with /auth use ${listing.agent} <other-slot>, or pass --force.`;
  }
  return null;
}

/** Format the /auth list CLI --json output as a Telegram HTML block. */
export function formatSlotList(listing: SlotListingFromCli): string {
  if (!listing.slots || listing.slots.length === 0) {
    return `<i>No slots for <b>${escapeMini(listing.agent)}</b>. Add one with /auth add ${escapeMini(listing.agent)}.</i>`;
  }
  const lines = [`<b>Slots for ${escapeMini(listing.agent)}</b>`];
  for (const s of listing.slots) {
    const active = s.active ? '● ' : '  ';
    const name = `<code>${escapeMini(s.slot)}</code>`;
    const health = healthIcon(s.health) + ' ' + s.health;
    let tail = '';
    if (s.health === 'quota-exhausted' && s.quota_exhausted_until) {
      const mins = Math.max(0, Math.round((s.quota_exhausted_until - Date.now()) / 60_000));
      tail = ` · resets in ~${mins}m`;
    } else if (s.health === 'expired') {
      tail = ' · run /auth reauth';
    }
    lines.push(`${active}${name} ${health}${tail}`);
  }
  return lines.join('\n');
}

function healthIcon(health: string): string {
  switch (health) {
    case 'healthy': return '✓';
    case 'quota-exhausted': return '⚠️';
    case 'expired': return '⌛';
    case 'missing': return '✗';
    default: return '·';
  }
}

/** Tiny HTML escaper — mirrored from welcome-text.ts so this module
 *  stays dependency-free and testable in isolation. */
function escapeMini(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
