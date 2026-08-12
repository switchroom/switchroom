/**
 * #3084 follow-up — HOLD an undeliverable approval; never convert it into a
 * silent denial.
 *
 * The incident (overlord, 2026-07-11): Telegram flood-banned the bot token for
 * 4.6h. A Claude Code permission prompt fired during the ban. The gateway built
 * the card, the send failed, and the error was written to stderr and dropped on
 * the floor. Three things then went wrong at once:
 *
 *   1. `pendingPermissions` kept the entry with `cards: []` — no card had
 *      landed, so there was nothing for the operator to tap and no record that
 *      anything was waiting.
 *   2. 60 minutes later the TTL sweep fired and AUTO-DENIED the request,
 *      telling the agent the operator had declined. No human ever saw the ask.
 *   3. The #2862 missed-approval re-offer is anchored on `v.cards[0]` — the
 *      card's landed origin. With `cards: []` that is `undefined`, so the
 *      re-offer was skipped. The request was auto-denied AND erased from the
 *      only record that would have brought it back.
 *
 * Net: an undeliverable approval became a silent denial and then vanished. That
 * is a `no-self-escalation` / `on-leash` breach — the leash decided for the
 * operator, in their absence, and told the agent a human had spoken.
 *
 * The operator's call (Ken, explicit): **hold, and make the block visible.
 * Never auto-approve. Never auto-deny — not even on a deadline.** The agent
 * stays blocked, the ask is held, and it is re-delivered when the channel comes
 * back. An indefinite block is the correct behaviour; a fabricated verdict is
 * not.
 *
 * This module owns the three decisions that implement that, kept out of
 * gateway.ts so they are unit-testable (gateway.ts has top-level side effects
 * and is not importable from a test — see `tests/permission-card-routing.ts`):
 *
 *   - `createBlockedApprovalStore` — the durable, world-readable record of what
 *     is blocked and why (PR 1).
 *   - `selectHeldForRedelivery`   — which held cards to re-post when the flood
 *     window closes, capped so a backlog can't burst (PR 2).
 *   - `isHeldUndeliverable`       — the TTL freeze predicate (PR 3).
 *
 * @see reference/jobs/approve-what-my-agent-can-touch.md
 * @see reference/invariants.md § no-self-escalation, § on-leash
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { isFloodWaitActiveError } from '../retry-api-call.js'

/**
 * File mode 0644 — WORLD-READABLE, and that is load-bearing, not incidental.
 *
 * `switchroom-web` runs as uid 1000 and cannot read the agent's telegram state
 * files, which are 0600 (`permission-card-store.ts:63` writes
 * `pending-perm-cards.json` at 0o600 — verified unreadable on the live box:
 * `docker exec switchroom-web cat …/pending-perm-cards.json` → Permission
 * denied). A 0600 blocked-approval record renders a silently EMPTY dashboard —
 * the exact shape of the Hermes `registry.db` bug. `fleet-health/ledger.json`
 * is world-readable for the same reason; this follows that precedent.
 *
 * The safety consequence of world-readable is absolute and enforced by
 * `assertNoRawInput` below: this file carries METADATA ONLY. No `inputPreview`,
 * no raw tool input, no `card_text`, ever. A raw credential surviving in a
 * world-readable file is the failure this job spec names by name.
 */
export const BLOCKED_APPROVAL_FILE_MODE = 0o644

/**
 * The SHARED dir is sticky-world-writable (1777), the /tmp model — and it has
 * to be, or the feature is a silent no-op in production.
 *
 * Agents run as per-agent non-root uids (`AGENT_UID_MIN = 10001`,
 * `compose.ts:95`). A shared dir owned by the operator (or auto-created
 * `root:root` by Docker, which is what happens to any bind source that doesn't
 * exist — `compose.ts` calls this out by name: "docker auto-creates as root,
 * which then traps the agent uid out of writing") is NOT writable by uid 10001.
 * The write would EACCES into the best-effort catch below and the record would
 * never appear. The one surface telling the operator an agent is blocked would
 * be silently empty — the Hermes `registry.db` bug, on the write side.
 *
 * Sticky (`0o1000`) is what makes world-writable safe: each agent creates and
 * owns its own 0644 `<agent>.json`, so no agent can MODIFY another's record,
 * and the sticky bit means no agent can DELETE another's either. Same guarantee
 * /tmp gives. Cross-agent forgery of a *new* record is out of threat model by
 * the `single-tenant` invariant — every agent the operator wires in is
 * implicitly trusted; this is not an authorization boundary between mutually
 * distrusting parties.
 */
export const BLOCKED_APPROVAL_DIR_MODE = 0o1777

/**
 * Why a card could not be delivered — and every one of these is TRANSIENT.
 *
 * `flood_wait` is the incident cause: a per-bot-token ban, nothing can land until
 * `untilTs`. But it is not the only way a card goes undeliverable through no
 * fault of the operator, and the leash rule ("never auto-deny an approval no
 * human saw") does not care WHICH transient fault shut the channel — only
 * whether the operator ever got a chance to answer.
 */
export type UndeliverableReason = 'flood_wait' | 'transient'

/**
 * How long to wait before re-trying a card held for a NON-flood transient fault.
 * A flood-wait carries its own `untilTs`; a network blip has no such signal, so
 * back off a minute and let the reaper's next tick try again.
 */
export const HELD_RETRY_BACKOFF_MS = 60_000

/**
 * Ceiling on the exponential re-delivery backoff: 30 minutes.
 *
 * A held card that keeps failing must not be re-sent every 60s forever — that is
 * the request amplifier this series exists to avoid. But it must ALSO never stop
 * being retried entirely: a terminal give-up strands the card even after the
 * channel recovers, and because `turnInFlightForGate()` holds the inbound gate
 * while a permission is pending, that would silently buffer the operator's normal
 * messages forever with no signal.
 *
 * So the retry interval BACKS OFF (1m, 2m, 4m … capped at 30m) instead of
 * stopping. The rate is bounded; the retry never is. A recovered channel always
 * gets the card back within 30 minutes.
 */
export const HELD_RETRY_MAX_BACKOFF_MS = 30 * 60_000

/** Backoff for the Nth consecutive failure: 1m, 2m, 4m … capped. */
export function heldRetryBackoffMs(failures: number): number {
  const n = Math.max(1, failures)
  return Math.min(HELD_RETRY_BACKOFF_MS * 2 ** (n - 1), HELD_RETRY_MAX_BACKOFF_MS)
}

/**
 * Stamped onto the in-memory `pendingPermissions` entry when the card send
 * fails against a known-open flood window. Its presence is what freezes the TTL
 * (PR 3) and what makes the entry eligible for re-delivery (PR 2).
 */
export interface UndeliverableMark {
  /** When we first failed to deliver this card. */
  since: number
  /** Telegram's `untilTs` for the open flood window — when a retry may land. */
  retryableAt: number
  reason: UndeliverableReason
}

/**
 * The shared, world-readable blocked-approval record. Schema is a contract with
 * the switchroom-web reader — do not change field names or add fields carrying
 * tool input.
 */
export interface BlockedApprovalRecord {
  agent: string
  requestId: string
  toolName: string
  /**
   * `naturalAction()` text ONLY — e.g. "edit: supplement-log.md". A short
   * human sentence describing the ask. NEVER the raw `inputPreview`.
   */
  action: string
  /** When the agent first blocked on this approval. */
  blockedSince: number
  /** When we first failed to deliver the card. */
  undeliverableSince: number
  /** When the channel is expected back (the flood window's `untilTs`). */
  retryableAt: number
  reason: UndeliverableReason
}

/** Fields that must never appear in a world-readable record. */
const FORBIDDEN_FIELDS = ['inputPreview', 'input_preview', 'cardText', 'card_text', 'description']

/**
 * Fail loudly if a caller ever tries to widen the record with raw tool input.
 * `check-no-pii-secrets` cannot see a runtime object, so the guard lives here:
 * this file is 0644 and arbitrary tool input in it is a credential leak.
 */
function assertNoRawInput(rec: BlockedApprovalRecord): void {
  for (const f of FORBIDDEN_FIELDS) {
    if (f in (rec as unknown as Record<string, unknown>)) {
      throw new Error(
        `blocked-approval record must not carry raw tool input (field "${f}"): ` +
        `the record is world-readable (0644) so switchroom-web can read it`,
      )
    }
  }
}

/**
 * Tools whose `naturalAction()` text is SAFE to put in a world-readable file.
 *
 * This list is short on purpose, and it is an allowlist (fail-closed) rather
 * than a denylist. `naturalAction` is not uniformly safe:
 *
 *     naturalAction('Edit', …)  →  "edit: notes.md"                    ← a basename
 *     naturalAction('Bash', …)  →  "run: curl -H 'Authorization: Bearer sk-…"  ← THE RAW COMMAND
 *
 * For `Bash` it interpolates the raw command; for `Glob`/`Grep` the raw
 * pattern; for `WebFetch` the raw URL (which routinely carries a token in its
 * query string); for `mcp__*` arbitrary tool args. Writing any of those into a
 * 0644 file is exactly the "raw credential surviving in a world-readable place"
 * failure the job spec names.
 *
 * The tools below derive their text from a FILE BASENAME (or a skill name from
 * a fixed registry), which is safe to surface and is what makes the record
 * useful — "edit: supplement-log.md" tells the operator what is blocked.
 * Everything else falls back to the INPUT-FREE phrasing
 * (`naturalAction(tool, undefined)` → "run shell commands", "search files",
 * "send (Brevo)"), which is still a human sentence but structurally cannot
 * contain tool input.
 */
const ACTION_SAFE_WITH_INPUT = new Set([
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Write',
  'Read',
  'Skill',
])

/**
 * The `action` string for the world-readable record.
 *
 * `naturalAction` is the right VOICE for this field, but it is only
 * input-safe for some tools — see `ACTION_SAFE_WITH_INPUT`. Unknown and MCP
 * tools fail CLOSED to the input-free phrasing.
 *
 * @param naturalAction the real `permission-title.ts` helper, injected so this
 *        module stays free of a gateway import cycle and stays unit-testable.
 */
export function safeActionForRecord(
  naturalAction: (toolName: string, inputPreview: string | undefined) => string,
  toolName: string,
  inputPreview: string | undefined,
): string {
  return ACTION_SAFE_WITH_INPUT.has(toolName)
    ? naturalAction(toolName, inputPreview)
    : naturalAction(toolName, undefined)
}

/**
 * The one fs call whose FAILURE selects the fallback branch, injectable.
 *
 * The production trigger is "the shared dir is not writable by this uid" — and
 * that is exactly the condition a test cannot create for itself, because a test
 * run as **root ignores file modes**. The suite runs as uid 0 in the fleet's
 * debug container (and in any `docker run` without `--user`), where a
 * `chmod 0500` on the parent is a no-op: the shared write SUCCEEDS, the fallback
 * branch is never taken, and every assertion about the fallback record silently
 * describes the SHARED record instead. Two tests passed that way for real
 * (`is written world-readable`, `clears both locations`) — vacuous guards that
 * report coverage they do not provide.
 *
 * A filesystem artifact can't fix that either: anything planted in the shared
 * dir to make the write fail (an `<agent>.json` DIRECTORY → EISDIR, a symlink →
 * the lstat guard below) is also visible to the READER, which then counts it as
 * an unreadable record — changing the very thing the test measures. So the
 * refusal is injected instead: the real `write()` branch logic, the lstat guard,
 * the fallback selection, the stale-unlink and the stderr log all still run.
 *
 * Production callers never pass this.
 */
export interface BlockedApprovalStoreDeps {
  /** Defaults to `node:fs`'s. Tests substitute one that throws EACCES for the
   *  shared path, reproducing a root-owned bind under a per-agent uid. */
  writeFileSync?: typeof writeFileSync
}

export interface BlockedApprovalStore {
  /** Write (or replace) the blocked record for this agent. */
  write(rec: BlockedApprovalRecord): void
  /** Clear the record — the approval was delivered, resolved, or cancelled. */
  clear(): void
  /** Read the current record, or null when nothing is blocked. */
  read(): BlockedApprovalRecord | null
  /** Absolute path of the backing file (for logs and tests). */
  path: string
}

/** `<stateRoot>/blocked-approvals` — the shared directory switchroom-web reads. */
export function blockedApprovalsDir(stateRoot: string): string {
  return join(stateRoot, 'blocked-approvals')
}

/**
 * One file per agent: `<dir>/<agent>.json`. Single-record, not a list — an
 * agent blocks on ONE permission at a time (the claude turn is suspended inside
 * the MCP permission call), so there is exactly one thing to surface.
 *
 * Every write is best-effort: a failure to write the SURFACE must never take
 * down the gateway or, worse, fall back to the auto-deny the whole change
 * exists to remove. It logs and moves on.
 */
export function createBlockedApprovalStore(
  dir: string,
  agent: string,
  /**
   * Where to write when the shared dir isn't usable — the agent's OWN state dir
   * (`/state/agent`, host `~/.switchroom/agents/<name>/`), which the scaffold
   * chowns to the agent uid, so a write there always succeeds.
   *
   * This exists so the feature cannot silently no-op. If the shared bind is
   * missing (a container predating the volume), or auto-created root-owned, the
   * record still lands somewhere the operator and switchroom-web can read.
   *
   * **Reachable by mount is not the same as readable, and neither is the same as
   * READ.** That elision is a bug this comment used to paper over: it claimed
   * "web mounts all of ~/.switchroom, so both locations are reachable" — true,
   * and irrelevant, because the reader only ever scanned the shared dir. The
   * fallback was written to a file nobody read (#3109). Two things must hold, and
   * both are load-bearing: if either regresses, the record exists, the agent is
   * held, and the dashboard still prints "No agent is blocked".
   *
   *   1. **Mode.** The record is written 0644 into the 0775 agent dir. Verified
   *      live: `docker exec switchroom-web` reads a 0644 file under
   *      `~/.switchroom/agents/<agent>/` fine and gets EACCES only on the 0600
   *      files beside it. The FILE's mode locks web out, never the directory.
   *   2. **The reader must LOOK here.** It now does —
   *      `src/web/blocked-approvals-read.ts` scans the shared dir AND
   *      `agents/<agent>/blocked-approval.json` (its `FALLBACK_RECORD_NAME`,
   *      which must stay in sync with the filename below).
   */
  fallbackDir?: string,
  /** Test-only fs seam — see {@link BlockedApprovalStoreDeps}. */
  deps: BlockedApprovalStoreDeps = {},
): BlockedApprovalStore {
  const write_ = deps.writeFileSync ?? writeFileSync
  const primary = join(dir, `${agent}.json`)
  // Keep in sync with FALLBACK_RECORD_NAME in src/web/blocked-approvals-read.ts —
  // the reader matches this filename exactly. Pinned by the fallback-contract
  // tests in src/web/blocked-approvals.test.ts.
  const fallback = fallbackDir != null ? join(fallbackDir, 'blocked-approval.json') : null

  /** Where the last successful write landed — `read`/`clear` must agree with it. */
  let active = primary

  function tryWrite(target: string, body: string, dirMode?: number): boolean {
    const parent = dirname(target)
    try {
      mkdirSync(parent, { recursive: true })
      // Symlink-planting guard. The shared dir is 1777 (the /tmp model), so
      // any local uid can pre-create `<agent>.json` as a symlink pointing at a
      // file the AGENT uid can write (its own state, a config file). Writing
      // through it would let a planter redirect our 0644 write onto an
      // arbitrary target. lstat (never follows) and refuse: the sticky bit
      // stops us unlinking a symlink we don't own, so the safe move is to
      // treat this location as unusable and fall back.
      try {
        if (lstatSync(target).isSymbolicLink()) return false
      } catch {
        // ENOENT — no file yet, the normal case.
      }
      // The `mode` args to mkdirSync/writeFileSync are MASKED by the process
      // umask (and ignored outright for an existing dir), so passing them
      // guarantees nothing. Both modes are load-bearing — the shared dir must be
      // writable by every agent uid, the file readable by switchroom-web — so
      // set them explicitly. The dir chmod is best-effort: we may not own it,
      // which is fine, because the write below is the real test of whether this
      // location works at all.
      if (dirMode != null) {
        try { chmodSync(parent, dirMode) } catch { /* not ours to chmod */ }
      }
      write_(target, body, { encoding: 'utf-8', mode: BLOCKED_APPROVAL_FILE_MODE })
      chmodSync(target, BLOCKED_APPROVAL_FILE_MODE)
      return true
    } catch {
      return false
    }
  }

  return {
    get path() { return active },

    write(rec) {
      assertNoRawInput(rec)
      const body = JSON.stringify(rec)

      if (tryWrite(primary, body, BLOCKED_APPROVAL_DIR_MODE)) {
        active = primary
        // Best-effort removal of a stale FALLBACK record: an earlier write may
        // have landed there while the shared dir was unusable. Once the shared
        // surface works, a leftover fallback file would make a recovered host
        // double-report the block (web reads both locations).
        if (fallback != null) {
          try { unlinkSync(fallback) } catch { /* absent is the normal case */ }
        }
        return
      }
      // The shared dir refused us — almost always because it was auto-created
      // root-owned and we are a per-agent uid. Fall back to the agent's own
      // state dir rather than losing the record, and say so LOUDLY: a
      // half-visible leash surface is worth a noisy log line.
      if (fallback != null && tryWrite(fallback, body)) {
        active = fallback
        process.stderr.write(
          `telegram gateway: blocked-approval write to ${primary} failed ` +
          `(shared dir not writable by this agent uid?) — wrote ${fallback} instead. ` +
          `The hold is intact; the shared surface may be missing this agent.\n`,
        )
        return
      }
      process.stderr.write(
        `telegram gateway: blocked-approval write FAILED at ${primary}` +
        (fallback != null ? ` and ${fallback}` : '') +
        ` — the agent is HELD but the off-Telegram surface is blind. ` +
        `The hold itself is unaffected (the approval is never auto-denied).\n`,
      )
    },

    clear() {
      // Clear BOTH: an earlier write may have landed in the fallback.
      for (const p of [primary, fallback]) {
        if (p == null) continue
        try {
          unlinkSync(p)
        } catch {
          // Absent is the normal case — nothing was blocked.
        }
      }
      active = primary
    },

    read() {
      for (const p of [primary, fallback]) {
        if (p == null) continue
        try {
          const parsed = JSON.parse(readFileSync(p, 'utf-8'))
          if (parsed != null && typeof parsed === 'object') return parsed as BlockedApprovalRecord
        } catch {
          // try the next location
        }
      }
      return null
    },
  }
}

/**
 * Which held entry the blocked-approval surface should show — the RECONCILE
 * selection, extracted from gateway.ts's `reconcileBlockedApprovals()` so it is
 * unit-testable (gateway.ts has top-level side effects and cannot be imported
 * from a test).
 *
 * The rules, both load-bearing:
 *
 *   - **Oldest hold wins.** The store holds ONE record per agent, but an agent
 *     can hold several permissions at once (parallel tool calls). The one that
 *     has been waiting longest (smallest `undeliverable.since`) is the record.
 *   - **Reconcile, not clear.** Returning `null` — meaning the caller should
 *     `clear()` — happens ONLY when no entry is held at all. Resolving one of
 *     several holds must surface the next-oldest, never blank the file while a
 *     real block remains.
 */
export function selectOldestHeld<T extends { undeliverable?: UndeliverableMark | null }>(
  entries: Iterable<readonly [string, T]>,
): { requestId: string; pend: T; mark: UndeliverableMark } | null {
  let oldest: { requestId: string; pend: T; mark: UndeliverableMark } | null = null
  for (const [requestId, pend] of entries) {
    const u = pend.undeliverable
    if (u == null) continue
    if (oldest == null || u.since < oldest.mark.since) oldest = { requestId, pend, mark: u }
  }
  return oldest
}

/**
 * Classify a card-send failure: is this ask HELD, or does it fall through?
 *
 * This is the leash rule in one function, and its POLARITY is the whole point:
 * it FAILS CLOSED. Anything we do not positively recognise as permanent is HELD.
 *
 * The first version of this function was an allowlist of marker strings
 * (FLOOD_WAIT_ACTIVE / GIVE_UP_MESSAGE / LOCAL_RESOURCE_EXHAUSTED) on the
 * premise that a network partition or a Telegram 5xx would surface as a
 * give-up. **That premise was false, and the allowlist failed OPEN into
 * auto-deny** — the exact breach this series exists to close, with a different
 * first cause. Driving real errors through the real `retryApiCall`:
 *
 *   Telegram 502 / 500   → raw GrammyError      ← the network-retry branch is
 *                                                 guarded by `!isGrammyErr`
 *                                                 (retry-api-call.ts:377), so a
 *                                                 5xx is re-thrown on attempt 0
 *   ECONNRESET / fetch failed → raw Error       ← on the LAST attempt the
 *                                                 backoff branch is skipped and
 *                                                 the raw error is re-thrown
 *                                                 (retry-api-call.ts:384-396)
 *   short-but-persistent 429  → GIVE_UP_MESSAGE ← the only path that reaches it
 *   long 429                  → FLOOD_WAIT_ACTIVE
 *   ENOSPC                    → LOCAL_RESOURCE_EXHAUSTED
 *
 * A single routine 502 at the instant the card is posted was therefore enough to
 * reproduce 2026-07-11 in full: no card, no mark, TTL fires, agent told the
 * operator declined. The send is ONE-SHOT — without a mark there is no
 * re-delivery path at all.
 *
 * So the default is HOLD. Only a status we KNOW is permanent — a 400 (a card
 * that will never parse) or a 403 (the bot is blocked/removed from that chat) —
 * falls through to the TTL, because holding on those would park the agent
 * forever on a card that can never render. And even that is safe now: PR 3 gives
 * the no-card timeout a missed-approvals fallback, so a permanent failure is
 * re-offered to the operator rather than vanishing.
 *
 * If a future error class is unrecognised, it is HELD. A held approval is
 * visible and recoverable; a fabricated denial is neither.
 */
export function holdReasonFor(err: unknown): UndeliverableReason | null {
  if (isFloodWaitActiveError(err)) return 'flood_wait'
  // PERMANENT — and only these. Note 429 is deliberately NOT in this list: a
  // rate-limit is the most transient failure there is.
  const code = (err as { error_code?: unknown } | null | undefined)?.error_code
  if (code === 400 || code === 403) return null
  // Everything else — 5xx, raw network errors, give-ups, local-resource
  // exhaustion, and anything we have never seen — is transient. FAIL CLOSED.
  return 'transient'
}

/**
 * THE LEASH, as one shared decision — used by `sweepPermissionTtl`, which BOTH
 * gateway.ts and the outcome test's harness call.
 *
 * The harness used to keep a PRIVATE copy of this check (a `ttlFreeze` flag), so
 * deleting the real guard left every behavioural assertion GREEN — including the
 * flagship "no deny verdict is ever dispatched". Only a source-text grep noticed,
 * and greps drift. A test that cannot fail is not a test, and this is the test for
 * the `no-self-escalation` invariant.
 *
 * A HELD entry NEVER expires. The TTL answers one question: "how long did the
 * operator have to answer?" For a card that never landed — flood ban, 5xx, network
 * partition — the answer is ZERO SECONDS.
 */
export function shouldExpirePermission(
  pend: { undeliverable?: UndeliverableMark | null; startedAt: number },
  now: number,
  ttlMs: number,
): boolean {
  // Never auto-deny an ask no human ever saw. Not even on a deadline.
  if (isHeldUndeliverable(pend)) return false
  return now - pend.startedAt > ttlMs
}

/**
 * The TTL freeze predicate (PR 3).
 *
 * An entry marked undeliverable NEVER expires. The TTL answers "how long did
 * the operator have to respond?" — and for a card that never landed, the answer
 * is zero seconds. Letting a clock the operator was never shown run out, and
 * then reporting the silence to the agent as a denial, is the bug.
 */
export function isHeldUndeliverable(
  pend: { undeliverable?: UndeliverableMark | null },
): boolean {
  return pend.undeliverable != null
}

/** The fields the on-delivery reset reads and mutates. */
export interface DeliveredPermissionEntry {
  undeliverable?: UndeliverableMark | null
  redeliveryFailures?: number
  /** When the operator's decision window began — the TTL is measured from here. */
  startedAt: number
}

/**
 * A HELD card just LANDED — the operator can finally see and tap it. Clear the
 * hold marks and RESTART the TTL clock, as ONE shared decision used by BOTH
 * gateway.ts and the outcome test's harness.
 *
 * WHY THIS IS SHARED CODE AND NOT AN INLINE BLOCK (#3128):
 *
 * The harness used to carry a PRIVATE copy of this reset (its own
 * `live.startedAt = clock.now()`), so the behavioural test that proves the
 * operator gets a FULL window after re-delivery drove the double, not the real
 * gateway. Deleting `startedAt = Date.now()` from gateway.ts would have left that
 * test GREEN — only a source-text grep noticed, and greps drift. Same placebo-pin
 * class as the leash (#3123) and the never-auto-approve pin (#3126). Now the reset
 * lives here, in one importable place, and both callers drive it: delete
 * `entry.startedAt = now` below and the `(d2)` outcome test goes RED, because there
 * is only one implementation to delete.
 *
 * RESET THE TTL CLOCK is load-bearing, not cosmetic. `startedAt` is when the
 * agent asked; the TTL measures how long the operator had to answer. Until the
 * card lands they have NOTHING to answer — it did not exist in any chat. Without
 * the reset, a card held through a 4.6h ban lands already-expired against a 60-min
 * TTL and the very next reaper tick auto-denies it: the silent denial would be
 * MOVED, not removed.
 *
 * Returns true when this was a HELD-card recovery — the caller should reconcile
 * the off-Telegram surface and log the re-delivery. Returns false for a normal
 * first delivery (the entry was never held), where there is nothing to reset.
 *
 * @see reference/invariants.md § no-self-escalation, § on-leash
 */
export function applyDeliveredHoldReset(
  entry: DeliveredPermissionEntry,
  now: number,
): boolean {
  if (entry.undeliverable == null) return false
  entry.undeliverable = null
  entry.redeliveryFailures = 0
  entry.startedAt = now
  return true
}

/**
 * Per-tick re-delivery cap (PR 2).
 *
 * A backlog of held cards must not BURST the instant the window closes — that
 * burst is the one realistic way this design could re-earn the very ban it
 * exists to survive. Three per 60s tick drains any plausible backlog quickly
 * while staying far under Telegram's rate ceiling.
 */
export const HELD_CARD_REDELIVERY_CAP = 3

export interface HeldPermissionEntry {
  undeliverable?: UndeliverableMark | null
  /** Cards that actually landed. A held entry has none — that is the point. */
  cards: unknown[]
  /** Consecutive failed re-delivery attempts. Past the cap we stop RE-SENDING. */
  redeliveryFailures?: number
}

export interface RedeliverySelection {
  /** Request ids to re-post on this tick. */
  send: string[]
  /** Held ids the cap deferred to a later tick. Logged, never silently dropped. */
  deferred: string[]
}

/**
 * Choose which held cards to re-post on this reaper tick.
 *
 * Guards, all of which must hold before a single request goes out:
 *
 *   (i)   the flood window is CLOSED — `floodRemainingMs === 0`. Strictly
 *         stronger than `robustApiCall`'s own short-circuit, which only refuses
 *         windows longer than its sleep ceiling.
 *   (ii)  the entry is marked undeliverable AND has no landed card
 *         (`cards.length === 0`). This is the double-delivery guard: the bridge
 *         re-sends unresolved requests on IPC reconnect
 *         (`bridge/permission-ledger.ts`), so a card may already be live.
 *   (iii) the request is not already in flight from a previous tick.
 *   (iv)  the per-tick cap.
 *
 * `robustApiCall`'s independent pre-call probe is the fifth guard, and it sits
 * downstream of this function — if the window re-opens between selection and
 * send, the send still refuses itself.
 */
export function selectHeldForRedelivery(
  entries: Iterable<readonly [string, HeldPermissionEntry]>,
  opts: {
    floodRemainingMs: number
    inFlight: ReadonlySet<string>
    /** Now, for the per-entry backoff check. */
    now: number
    cap?: number
  },
): RedeliverySelection {
  const empty: RedeliverySelection = { send: [], deferred: [] }
  // Guard (i) — the window is still open. Send nothing at all.
  if (opts.floodRemainingMs > 0) return empty

  const cap = opts.cap ?? HELD_CARD_REDELIVERY_CAP
  const send: string[] = []
  const deferred: string[] = []

  for (const [requestId, pend] of entries) {
    // Guard (ii) — held, and nothing landed for it yet.
    if (!isHeldUndeliverable(pend)) continue
    if (pend.cards.length > 0) continue
    // Guard (iii) — a previous tick is still posting this one.
    if (opts.inFlight.has(requestId)) continue
    // Guard (v) — respect the per-entry backoff. A card that keeps failing is
    // retried on a widening interval (1m, 2m, 4m … 30m) rather than every tick:
    // bounded RATE, unbounded RETRY. It is never abandoned, so a channel that
    // recovers always gets the card back — and the approval is never auto-denied.
    const dueAt = pend.undeliverable?.retryableAt ?? 0
    if (opts.now < dueAt) continue
    // Guard (iv) — cap. Everything past it is DEFERRED, not dropped.
    if (send.length >= cap) {
      deferred.push(requestId)
      continue
    }
    send.push(requestId)
  }

  return { send, deferred }
}
