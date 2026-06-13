/**
 * Scoped, time-boxed approval — the "⏱ 30 min" tier, the middle rung
 * between "✅ Allow once" (re-prompts on the very next call) and
 * "🔁 Always…" (a durable `tools.allow` write that lasts forever). After
 * the operator taps "⏱ 30 min" on a permission card, byte-identical
 * in-scope requests auto-allow for a fixed window without re-carding.
 *
 * Design contract (reference/access-model.md — "you hold the leash"):
 *
 *  - **Operator-authored only.** Every cache entry is created by an
 *    `allowFrom`-authenticated Telegram tap. No tool call can seed an
 *    entry (first contact always cards) or extend one (the window is a
 *    FIXED box — `recordScopedGrant` sets `expiresAt` once; a matching
 *    request never moves it). So an agent can never author its own
 *    authorization.
 *  - **Gateway-side only.** This store lives in the gateway process. It
 *    must NOT be pushed down to the bridge's `sessionAllowRules`
 *    (`bridge.ts`) — that cache is agent-uid, untimed, and would silently
 *    promote a 30-min grant to session-forever. The gateway dispatches
 *    the in-flight allow WITHOUT the `rule` field for exactly this reason.
 *  - **Conservative scope (this tier, v1).** Only the *narrow* scope is
 *    ever time-boxed: an exact file path (`Edit(/x.ts)`) or a Bash
 *    command-family (`Bash(git:*)`). Broad scopes ("any file", resource-
 *    blind MCP, "any command") are NOT offered the ⏱ button — they stay
 *    once / always. This covers the real fatigue (re-editing the same
 *    file, re-running a safe command) without fanning one tap across an
 *    unbounded action set.
 *  - **Fail-closed on irreversible.** A Bash family grant (`Bash(git:*)`)
 *    must never auto-allow a destructive member of that family
 *    (`git push --force`, `git reset --hard`). `isDestructiveBashCommand`
 *    is re-checked at BOTH grant time (don't offer ⏱) and match time
 *    (a cached family grant fails closed → re-cards) so per-call consent
 *    for irreversible actions is preserved.
 *
 * Pure + side-effect-free so it unit-tests under vitest AND bun without a
 * Grammy context (mirrors permission-rule.ts). Callers pass `now`/`ttlMs`
 * explicitly; nothing reads the clock here.
 */

import { basename } from "node:path";
import { matchesAllowRule, type ScopedAllowChoices } from "./permission-rule.js";

/** Default time-box window: 30 minutes. */
export const SCOPED_APPROVAL_DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Resolve the configured window from the environment. `0` (or negative)
 * disables the tier — the gateway hides the ⏱ button and never
 * short-circuits. A blank/garbage value falls back to the 30-min default.
 * Kill-switch: `SWITCHROOM_SCOPED_APPROVAL_TTL_MS=0`.
 */
export function scopedApprovalTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWITCHROOM_SCOPED_APPROVAL_TTL_MS;
  if (raw === undefined || raw.trim() === "") return SCOPED_APPROVAL_DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SCOPED_APPROVAL_DEFAULT_TTL_MS;
  return Math.floor(n);
}

/** A single operator-tapped, time-boxed grant. */
export interface ScopedGrant {
  /** Narrow allow-rule, e.g. `Edit(/state/x.ts)` or `Bash(git:*)`. */
  readonly rule: string;
  /** Unix-ms when this grant stops auto-allowing. Fixed at grant time. */
  readonly expiresAt: number;
}

/** Per-agent store of live time-boxed grants. Keyed by agent name. */
export type ScopedGrantStore = Map<string, ScopedGrant[]>;

/** The narrow rule + an honest operator-facing breadth phrase for the card. */
export interface TimeBoxDecision {
  readonly rule: string;
  /** e.g. "edits to x.ts" / "any `git` command" — states the real breadth. */
  readonly breadth: string;
}

const FILE_RULE = /^(Edit|Write|MultiEdit|NotebookEdit|Read)\((.+)\)$/;
const BASH_FAMILY_RULE = /^Bash\(([^:]+):\*\)$/;

/**
 * Conservative time-box eligibility. Given the already-resolved scope
 * choices for a permission request, return the NARROW rule to time-box
 * plus an honest breadth phrase — or `null` when this request must not
 * get a ⏱ button (broad-only tools, MCP, Skill, a destructive Bash
 * command, or any tool with no narrow sub-scope).
 *
 *  - File tools with an exact path → time-boxable (bounded to the one
 *    operator-seen file).
 *  - Bash with a first-token family → time-boxable ONLY when the
 *    triggering command itself is non-destructive. The family grant
 *    still covers the whole `<tok>` family for matching, but match-time
 *    re-checks each later command (see `lookupScopedGrant`).
 */
export function resolveTimeBox(
  toolName: string,
  inputPreview: string | undefined,
  choices: ScopedAllowChoices | null,
): TimeBoxDecision | null {
  // Only ever time-box the narrow scope, and only when one exists.
  const specific = choices?.specific;
  if (!specific || specific.broad) return null;
  const rule = specific.rule;

  const fileMatch = FILE_RULE.exec(rule);
  if (fileMatch) {
    const verb = fileMatch[1] === "Read" ? "reads of" : "edits to";
    return { rule, breadth: `${verb} ${basename(fileMatch[2]!)}` };
  }

  const bashMatch = BASH_FAMILY_RULE.exec(rule);
  if (bashMatch) {
    const cmd = readBashCommand(inputPreview);
    // No command text to vet, or a destructive triggering command → don't
    // offer the time-box at all (fall through to once / always).
    if (!cmd || isDestructiveBashCommand(cmd)) return null;
    return { rule, breadth: `any \`${bashMatch[1]}\` command` };
  }

  // MCP (resource-blind), Skill, broad-only tools → not time-boxed in the
  // conservative tier.
  return null;
}

/**
 * Record an operator-tapped 30-min grant. The window is a FIXED box: a
 * re-tap on the same rule resets it (the operator just re-approved), but
 * nothing else ever moves `expiresAt`. Re-tapping the same rule replaces
 * the prior entry rather than accumulating duplicates. A non-positive
 * `ttlMs` is a no-op (tier disabled).
 */
export function recordScopedGrant(
  store: ScopedGrantStore,
  agent: string,
  rule: string,
  now: number,
  ttlMs: number,
): void {
  if (ttlMs <= 0) return;
  const list = store.get(agent) ?? [];
  const others = list.filter((g) => g.rule !== rule);
  others.push({ rule, expiresAt: now + ttlMs });
  store.set(agent, others);
}

/**
 * Is there a LIVE operator-tapped grant covering this request? Returns the
 * matching rule (for the audit log line) or `null`.
 *
 * FAIL-CLOSED in two ways:
 *   1. an expired grant never matches (→ re-card);
 *   2. a destructive Bash command never auto-allows even when its family
 *      grant (`Bash(git:*)`) matches — `git push --force` re-cards even
 *      after `git status` was time-boxed.
 *
 * Never mutates the store (no window-sliding). Pure read.
 */
export function lookupScopedGrant(
  store: ScopedGrantStore,
  agent: string,
  toolName: string,
  inputPreview: string | undefined,
  now: number,
): string | null {
  const list = store.get(agent);
  if (!list || list.length === 0) return null;
  for (const g of list) {
    if (g.expiresAt <= now) continue; // expired → fail closed
    if (!matchesAllowRule(g.rule, toolName, inputPreview)) continue;
    if (toolName === "Bash") {
      const cmd = readBashCommand(inputPreview);
      // Family grant matched, but re-vet THIS command: destructive or
      // un-vettable → fail closed, re-card.
      if (!cmd || isDestructiveBashCommand(cmd)) return null;
    }
    return g.rule;
  }
  return null;
}

/** Drop expired grants. Call from the gateway's periodic sweep. */
export function sweepScopedGrants(store: ScopedGrantStore, now: number): void {
  for (const [agent, list] of store) {
    const live = list.filter((g) => g.expiresAt > now);
    if (live.length === 0) store.delete(agent);
    else if (live.length !== list.length) store.set(agent, live);
  }
}

/**
 * Heuristic destructive/irreversible-command detector. FAIL-CLOSED: when
 * a command can't be read or looks risky, return `true` so it is never
 * time-boxed (it re-prompts instead). Better to re-card a safe command
 * than auto-allow a destructive one. Covers the access-model crown-jewel
 * cases that ride the tool-permission channel: pipe-to-shell, privilege
 * escalation, destructive coreutils/disk ops, recursive perms, device
 * redirects, destructive git, power/process control, and bulk
 * docker/package teardown.
 */
export function isDestructiveBashCommand(command: string): boolean {
  if (!command || !command.trim()) return true;
  const c = command.toLowerCase();

  // download-and-execute: ... | sh|bash|python|node
  if (/\|\s*(sudo\s+)?(sh|bash|zsh|fish|python\d?|perl|ruby|node)\b/.test(c)) return true;
  // privilege escalation
  if (/(^|\s|;|&&|\|\||\()sudo\b/.test(c)) return true;
  if (/(^|\s|;|&&|\|\||\()(su|doas)\s/.test(c)) return true;
  // destructive coreutils / disk
  if (/(^|\s|;|&&|\|\||\()(rm|rmdir|dd|shred|truncate|fdisk|mkfs\S*|wipefs|blkdiscard|fallocate)\b/.test(c)) return true;
  // recursive permission / ownership changes (-R / --recursive)
  if (/\b(chmod|chown|chgrp)\b[^|;&]*(\s-(-recursive|[a-z]*r[a-z]*)\b)/.test(c)) return true;
  // redirection clobbering devices or system dirs
  if (/>\s*\/(dev|etc|boot|sys|proc)\b/.test(c)) return true;
  // destructive git
  if (/\bgit\b/.test(c) &&
      /(push\b[^|;&]*(--force|-f\b|--force-with-lease)|push\s+[^\s]*\s+\+|reset\s+--hard|clean\s+-[a-z]*[fd]|filter-branch|reflog\s+expire|update-ref\s+-d|branch\s+-d{1,2}\b|checkout\s+--\s|restore\b)/.test(c)) return true;
  // power / process control
  if (/(^|\s|;|&&|\|\||\()(shutdown|reboot|halt|poweroff|kill|killall|pkill)\b/.test(c)) return true;
  if (/(^|\s)init\s+0\b/.test(c)) return true;
  // bulk docker teardown / package removal
  if (/\bdocker\b[^|;&]*\b(rm|prune)\b/.test(c)) return true;
  if (/(^|\s)(apt|apt-get|yum|dnf|brew|pacman|npm|pnpm|yarn|pip\d?)\b[^|;&]*\b(remove|uninstall|purge|prune)\b/.test(c)) return true;
  // fork bomb
  if (/:\s*\(\s*\)\s*\{/.test(c)) return true;

  return false;
}

/** Extract the `command` string from a permission_request input preview. */
function readBashCommand(inputPreview: string | undefined): string | null {
  if (!inputPreview || typeof inputPreview !== "string") return null;
  const trimmed = inputPreview.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const cmd = parsed?.command;
    return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}
