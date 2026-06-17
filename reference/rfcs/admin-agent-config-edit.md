# RFC: Admin-agent edits to switchroom.yaml via approval-gated hostd verb

Status: Draft v1
Author: Ken (via Klanker pair-design)
Date: 2026-05-21

## 1. Summary

Add a new hostd verb `config_propose_edit` that lets an admin-flagged
agent propose a unified-diff patch against `/state/config/switchroom.
yaml`. The host validates the patch (applies cleanly + post-patch yaml
parses against the config zod schema) before bothering the human;
valid proposals raise a Telegram approval card in the operator's
primary chat showing the rendered diff, the requesting agent, and the
rationale. On Approve, the host writes the file atomically, snapshots
the prior version to `~/.switchroom/config-backups/`, and runs
`switchroom apply`; on Deny (or timeout) the proposal is a no-op.
Every proposal — approved, denied, errored — is appended to the
existing hostd audit log.

This collapses today's "agent pastes yaml block, asks human to copy-
paste it on the host" loop into a single approval tap, without
expanding the agent's trust boundary: the operator's eyeballs on the
diff remain the only thing standing between a prompt-injected admin
agent and fleet-wide config drift. Same security model as
`agent_restart` and `update_apply`; we are not inventing a new gate,
we are reusing the one that already gates every mutating hostd verb.

## 2. Motivation

### 2.1 Current friction

Admin agents (today: `klanker`) regularly need to edit
`switchroom.yaml`. Common asks:

- "Add a 06:00 cron entry to clerk's schedule."
- "Install the `pdf` skill onto reggie."
- "Add a `webhook_dispatch` rule routing `pull_request.opened` to
  reggie."
- "Flip `defaults.model` to opus-4-7-2."

The agent's container mounts `/state/config/switchroom.yaml` read-
only — by design; admin agents are prompt-injectable and must not be
trusted with autonomous writes. So today the flow is:

1. Agent drafts the yaml block in Telegram.
2. Human copy-pastes the block into a terminal.
3. Human runs `switchroom apply`.
4. Human pastes the result back.

Three steps that could be one tap. Worse, every copy-paste round is
an error surface: indentation drift, the wrong block under the wrong
key, a stale snapshot of the file because the agent didn't re-fetch
before drafting.

### 2.2 Why not just give the agent write access

The whole point of the read-only mount is that admin agents are the
biggest prompt-injection blast radius in the fleet — they can already
restart peers, exec read-only commands inside peers, and trigger
fleet upgrades. Adding silent yaml writes would mean a single
poisoned tool-output (a doctored PR description, a malicious file in
a peer's logs) could rewrite the fleet's config. The approval card is
the explicit human-in-the-loop boundary. Every other hostd mutating
verb is gated this way; config edits should be no different.

### 2.3 Why not granular per-section verbs

We could ship `schedule_add`, `schedule_remove`, `skill_install`,
`webhook_dispatch_add`, `defaults_set`, etc. — one verb per common
edit. Each would have a tight, typed surface area. Two reasons not
to:

1. **Proliferation.** Every new yaml section (every future RFC) would
   need its own verb pair, its own approval-card renderer, its own
   audit shape. Unified-diff is one well-understood primitive that
   covers any edit, including ones we haven't thought of.
2. **Approval clarity does not improve.** The operator still has to
   read what's actually changing; a structured
   `schedule_add(agent=clerk, cron='0 6 * * *', prompt='...')` call
   surfaces the same information a 6-line diff does, and the diff is
   less likely to silently smuggle a second change.

Note that an `agent-config` MCP server already ships
`schedule_add` / `skill_install` / `skill_remove` etc., but those
write **per-agent overlays** under `~/.switchroom/agents/<name>/`,
not `switchroom.yaml` itself, and they have their own bounded approval
surface (`src/cli/agent-config-pending.ts`). This RFC is the missing
piece for changes that must land in the central yaml: webhook routing,
defaults, peer-agent edits an admin needs to make on someone else's
behalf, and anything an overlay cannot express.

## 3. Proposal

### 3.1 Verb signature

```
config_propose_edit({
  patch: string,        // unified diff against switchroom.yaml
  rationale: string,    // human-readable; rendered on the card
  dry_run?: boolean,    // default false; validates without raising
                        // a card (useful for the agent to sanity-
                        // check its own diff before bothering the
                        // operator)
})
  → { approved: boolean, applied: boolean, diff_id: string,
      outcome: "approved"|"denied"|"expired"|"reconcile-failed"|
               "schema-rejected"|"apply-rejected"|"validation-rejected"|
               "rate-limited",
      error?: string }
```

Wire-level: new variant in `src/host-control/protocol.ts` (~line 68,
alongside the existing `agent_restart` / `update_apply` discriminated
union). MCP tool registration in `src/mcp/hostd/server.ts`
(~line 67–250 alongside the other admin-flagged tools). Tool
description must say "requires operator approval; the card is posted
to the operator's chat, not yours."

### 3.2 Validation pipeline (host side, BEFORE the card)

In order, all server-side, all before the operator hears a peep:

1. **Patch shape.** Must be a unified diff with ≥3 lines context.
   The `---` and `+++` header paths must each match exactly one of
   `a/switchroom.yaml`, `b/switchroom.yaml`, or the bare filename
   `switchroom.yaml` (git's three accepted forms). Any other path —
   including `../`, absolute paths, multi-file diffs, or symlink
   targets — is rejected at this step as `validation-rejected`
   before `git apply` is invoked. Closes the
   `+++ b/../../etc/passwd` attack vector. Reject context-less
   patches too — they're ambiguous and they defeat the operator's
   ability to spot-check the diff visually. Patches MUST be LF-only
   (no CRLF), no BOM, and capped at 1 MB raw bytes — this step is
   the single source of truth for the 1 MB cap, §3.3's attachment
   discussion references it but does not re-decide it.
2. **Apply check.** `git apply --check --whitespace=nowarn --recount`
   against a scratch copy of the current `switchroom.yaml`. The
   pinned flags prevent silent CRLF / trailing-whitespace mangling.
   If it doesn't apply, reject with the git error verbatim; the
   agent re-fetches and retries. This is the
   race-with-operator-hand-edits guard.
3. **Schema validation.** Apply the patch in-memory, parse the result
   through `src/config/loader.ts` + `src/config/schema.ts`. **The
   yaml parse step MUST use the FAILSAFE schema** (`yaml.load(...,
   { schema: FAILSAFE_SCHEMA })` for js-yaml, or `safe_load` for
   PyYAML-shaped libs). Reject `!!`-tags (`!!js/function`,
   `!!python/object`, …) and reject merge-key anchors / aliases
   (`&foo` / `*foo` / `<<:`) at parse time — these are code-
   execution / hidden-mutation primitives the zod schema runs *after*
   and cannot defend against. If the zod parse fails, reject with the
   formatted error; the operator is not woken.
4. **Secrets-deref guard.** The yaml may contain `vault:foo/bar`
   references (see `src/config/overlay-secrets-filter.ts`); the diff
   renderer in §3.3 must NOT resolve these. Render the `vault:`
   string literal. (Today no codepath dereferences it before render;
   this is a "do not regress" note, not new code.)

Only proposals that pass all four go to the operator.

### 3.3 Approval card

Posted to the operator's primary chat via the existing approval-card
infra in `telegram-plugin/gateway/approval-card.ts` /
`drive-write-approval.ts` — both are existing precedents for non-
vault mutating actions gated by a card. Card payload:

- **Header**: `<agent_name> wants to edit switchroom.yaml`
- **Rationale**: the agent-supplied string, max 500 chars on the
  card (full text in callback payload).
- **Diff body**: rendered as a Telegram `<pre>` block with ±/-prefix
  lines. If the diff is >40 lines, truncate to 30 lines with a
  "+N more lines" footer and attach the full diff as a `.diff` file
  via Telegram's attachment surface. Hard cap the attachment at 1 MB
  (well under Telegram's 50 MB document ceiling); a patch larger than
  that is `validation-rejected` at §3.2 step 1 — config patches of
  that size belong in a hand-edited release, not a chat approval.
- **Buttons**: `[Approve]` / `[Deny]`.
- **Safety delay**: for diffs over 20 lines, the Approve button
  initially renders with label `⏳ Approve (5s)` and `callback_data`
  pointing to a no-op acknowledgement handler ("read the diff first").
  After 5 real seconds the gateway calls `editMessageReplyMarkup`
  to swap in the live `[✅ Approve]` button bound to the diff_id.
  Aimed at diff fatigue (see §5).

The card lives in the **operator's** chat — `operator_chat_id` from
the gateway config, NOT the requesting agent's chat. The operator
may be a different human from the agent's day-to-day user; the
person who owns the host is the person who approves config writes.

Timeout: 10 minutes. After that the `diff_id` expires, the card is
edited to "Expired", and the agent must re-propose. Rationale: a
stale diff_id approved an hour later might apply against a
materially different `switchroom.yaml`. (The `git apply --check`
would catch it, but failing fast at 10m is friendlier than
mysterious post-approval `does-not-apply` errors.)

`diff_id` is a 128-bit cryptographically random token (not derived
from `patch_sha256` — identical patches collide, and content-
derived ids leak deduplication signal). Each id is single-use;
recorded as consumed in the same sqlite row that backs the rate
limiter (§5), so the approve-callback handler atomically transitions
`pending → consumed` or rejects with `expired`. Closes the replay-
the-callback-on-a-fresh-id race.

**Privilege-change escalation.** Diffs that touch another agent's
`admin:`, `secrets:`, `vault_grants:`, or `model:` keys force the
5-second tap delay regardless of diff size, and the card header
prepends `⚠️ privilege change to peer <name>:`. Three-line
`admin: true` insertions into a 40-line diff are exactly the diff-
fatigue case the static size threshold misses.

### 3.4 Apply path (on approve)

Sequenced, on the host as the operator UID. The entire sequence
(steps 1–4) runs under an exclusive `flock(2)` on
`~/.switchroom/config-backups/.lock` to serialise concurrent
proposals and any host-side `switchroom apply` invocations triggered
by hand-edits. Without the lock two approved proposals can
interleave rename and reconcile; with it the second proposal blocks
until the first either commits or rolls back.

1. **Re-check.** Inside the lock, re-run `git apply --check` against
   the live `switchroom.yaml`. If the operator hand-edited the file
   between approval and lock acquisition, this fails and the
   proposal terminates as `apply-rejected` with no further state
   change. Closes the TOCTOU between §3.2 step 2 and the rename
   below.
2. **Snapshot.** `cp switchroom.yaml
   ~/.switchroom/config-backups/switchroom.yaml.bak-<ts>` — the
   snapshot is of the *just-re-checked* live file, so the rollback
   target in step 4 cannot clobber an interleaved operator edit.
   Rotate to keep the 10 most recent.
3. **Write.** Apply the patch to a `switchroom.yaml.tmp` next to the
   original; `fsync`; `rename(2)` over the original. Atomic on the
   same filesystem.
4. **Reconcile.** Invoke `switchroom apply` (the existing host-side
   reconcile entrypoint — see `src/agents/reconcile-dry-run.ts` and
   the apply path it shadows). Stdout/stderr are appended to
   `~/.switchroom/hostd-audit.jsonl` as a single
   `{op: "config_propose_edit", phase: "reconcile-output", ...}`
   row alongside the terminal row from §3.5.
5. **Rollback on reconcile failure.** If `switchroom apply` exits
   non-zero, `rename(2)` the `.bak-<ts>` snapshot back over
   `switchroom.yaml` (still under the same lock) and surface the
   failure both to the requesting agent
   (`{ approved: true, applied: false, outcome:
   "reconcile-failed", error: "..." }`) and to the operator chat as
   a follow-up message edit on the original card ("Reconcile failed;
   rolled back. <error>").

Why rollback rather than "fix forward": the operator already left
the conversation by the time reconcile runs. Leaving the fleet in a
half-applied state because the human is now AFK is worse than
reverting to a known-good config and asking them to try again later.

### 3.4.6 Crash recovery

`flock(2)` is released on process death, so a hostd crash mid-apply
does not deadlock. It can, however, leave the on-disk state in two
recoverable shapes:

- **Orphan `.tmp`.** Crash between step 3 (`fsync` of `switchroom.
  yaml.tmp`) and step 4 (`rename`). On boot, hostd unlinks any
  `switchroom.yaml.tmp` adjacent to `switchroom.yaml` — the file is
  by definition uncommitted.
- **Orphan reconcile.** Crash between step 4 (rename complete) and
  step 5 (reconcile exit). The yaml is the new version but
  reconcile never finished. Mitigated by a journal file
  `~/.switchroom/config-backups/reconcile-in-progress.json` written
  atomically before invoking `switchroom apply` (containing
  `diff_id`, `bak-<ts>` path, and the rename ts) and unlinked on
  reconcile success or rollback. On boot, hostd checks for the
  journal: if present, run `switchroom apply` again to finish (or
  roll back via the snapshot if it still fails twice in a row),
  audit the recovery outcome.

In-flight diff_ids that were `pending` (card raised, not yet
approved) are marked `expired` on hostd boot. The Telegram cards
get edited to "Expired (hostd restarted)"; agents re-propose if
they still want the change. Simpler than trying to resume a
half-pending approval state.

### 3.5 Audit

Every proposal terminus appends one line to
`~/.switchroom/hostd-audit.jsonl` (the same path
`src/host-control/audit-reader.ts` already reads). Shape:

```
{ ts, op: "config_propose_edit", phase: "terminal",
  agent: "<requester>", diff_id, rationale,
  outcome: "approved"|"denied"|"expired"|"reconcile-failed"|
           "schema-rejected"|"apply-rejected"|
           "validation-rejected"|"rate-limited",
  patch_sha256, backup_path?, reconcile_exit_code? }
```

The full diff is NOT in the audit row — only its sha256 — to keep
the audit log scannable. The diff itself is preserved in
`~/.switchroom/config-backups/proposals/<diff_id>.diff` for the
30-day retention window the rest of hostd audit uses.

**Metrics** (Prometheus): `hostd_config_propose_total{outcome}`
counter (one label per §3.1 outcome enum value);
`hostd_config_propose_approval_seconds` histogram (card raised →
operator tap); `hostd_config_propose_reconcile_seconds` histogram
(rename → reconcile exit); `hostd_config_propose_rollback_total`
counter. Sufficient to spot silent abuse, slow approvals, or a
rising rollback rate without scraping the jsonl.

**Operator audit UX.** `switchroom doctor` surfaces a one-line
summary from the last 24h of proposals: "config_propose_edit: N
total, M denied, K rate-limited, J rolled back". A full
`switchroom config-edit log` subcommand to render the jsonl as a
table is out of scope for the RFC but called out so future readers
know where it goes.

## 4. Non-goals

- **Editing the secrets vault.** Vault writes go through the existing
  `vault_request_save` / `vault_request_access` grant flow.
  `config_propose_edit` operates on `vault:foo/bar` *references*
  (just strings in yaml), not on the encrypted vault store. Concrete
  rules: adding a new `vault:foo/bar` reference is allowed; removing
  one is allowed; *replacing* `vault:foo/bar` with `vault:baz/qux` is
  allowed (it's still a reference swap, not a value change — the
  vault store is untouched, and the operator sees both keys on the
  diff card). What the verb cannot do is set a non-`vault:` literal
  where one previously existed (e.g. replacing `vault:foo/bar` with
  an inline plaintext secret) — that's caught by the schema-
  validation step in §3.2 if the field is typed as a vault ref, and
  by the operator's eyes on the diff regardless.
- **Editing `~/.switchroom/skills/**` content.** That dir is
  operator-only and out of scope. Adding a skill *name* to an agent's
  `skills:` list in `switchroom.yaml` is in scope; writing the skill
  file itself is not.
- **Editing per-agent overlays under `~/.switchroom/agents/<name>/`.**
  Overlay files are read by a different loader
  (`src/config/overlay-loader.ts`) and have their own approval surface
  in the existing `src/cli/agent-config-pending.ts` flow.
- **Bypassing approval, ever.** No `force: true`. No "trusted agent"
  allowlist. The card is the boundary.

## 5. Risks

- **Prompt-injection escalation.** An admin agent that's been prompt-
  injected can now ask for any yaml change, not just restarts.
  Mitigation: the operator MUST read the diff. The card surfaces
  requester + rationale prominently so "klanker wants to edit gymbro's
  `secrets:` block — why?" is visually obvious. Diffs over 20 lines
  get a 5-second tap delay (see §3.3). Per-agent rate limit of 3
  cards/hour (configurable, defaults flag).
- **Diff fatigue.** Operator approves without reading. Mitigations
  above. There is no software fix for "user always taps yes"; if the
  operator is unwilling to read diffs, they should pin
  `hostd.config_edit_enabled: false` and keep the paste-and-ask flow.
  Rate-limit specifics: **3 cards per requesting-agent per rolling
  hour** (default; overridable via
  `hostd.config_edit_rate_per_hour`). Implemented as a sqlite
  token-bucket in `~/.switchroom/hostd-state.db` (atomic decrement
  inside a single transaction — naive in-memory counters race when
  two proposals from the same agent arrive concurrently). Tripping
  the limit returns `{ outcome: "rate-limited", approved: false,
  applied: false }` immediately, audits the attempt as a terminal
  row (same `phase: "terminal"`, `outcome: "rate-limited"`), and
  does NOT raise a card.
- **Race with operator hand-edits.** Operator edits the file in vim
  while a proposal is in flight. `git apply --check` catches the
  mismatch on approve and rejects with `apply-rejected`. Agent re-
  fetches via the existing read-only mount and re-proposes.
- **Reconcile failure post-write.** Covered by the §3.4 rollback.
  Documented failure semantics: `applied: false` + operator-chat
  follow-up + audit row with `outcome: "reconcile-failed"`.
- **Secrets in diffs.** yaml contains `vault:foo/bar` references, not
  raw secrets, so a diff render is safe at the file level. The guard
  in §3.2 step 4 is a do-not-regress note for future changes.
- **Backup-dir exhaustion.** 10-file rotation; bounded.

## 6. Alternatives considered

- **Status quo (paste-and-ask).** Works. Friction-heavy and error-
  prone (operator typos). Acceptable fallback if this RFC is rejected.
- **Operator-only `switchroom config edit` CLI.** Already the
  fallback. Doesn't address the agent-driven workflow.
- **Granular per-section verbs.** See §2.3.
- **No-approval autonomous writes for admin agents.** Violates the
  prompt-injection threat model — see §2.2. Non-starter.
- **Approval card to the requesting agent's chat, not the operator's.**
  Rejected: the agent's chat may be shared with a non-operator user
  (a family member, a collaborator). Config writes need the host
  owner's eyes.

## 7. Decisions

- **Verb name: `config_propose_edit`.** Mirrors `update_apply` naming
  (verb_phase). The `propose_` prefix signals "this won't take effect
  without approval", distinguishing it from `agent_restart` which the
  operator-attest path can run unilaterally.
- **Diff format: unified, ≥3 lines context.** Patches without context
  are rejected at validation.
- **Backup retention: last 10 in `~/.switchroom/config-backups/`.**
- **Approval timeout: 10 minutes.** Diff_id then expires.
- **Visibility: operator's primary chat, not requester's chat.**
- **Audit: piggybacks on existing `hostd-audit.jsonl`** with the
  shape in §3.5.
- **Rollback on reconcile failure** rather than leaving partial
  state. Operator-chat follow-up explains.

## 8. Migration

Three PRs, same shape as the webhook-via-gateway-socket rollout
(`reference/rfcs/webhook-via-gateway-socket.md` §3.4):

1. **PR 1 — additive.** New verb in `src/host-control/protocol.ts`,
   dispatcher in `src/host-control/server.ts`, MCP tool in
   `src/mcp/hostd/server.ts`. Card renderer in
   `telegram-plugin/gateway/` mirroring `drive-write-approval.ts`.
   Behind a defaults flag `hostd.config_edit_enabled: false`. Legacy
   paste-and-ask flow unchanged. Tests cover: patch-rejected-by-
   schema, patch-doesn't-apply, approve-then-reconcile-fails (rollback
   path), approve-then-reconcile-ok, deny, timeout, rate-limit hit.
2. **PR 2 — rollout.** Flip the default to `true`. Release notes call
   out the new approval surface in the operator's chat. Operators
   with bespoke chat routing can pin `config_edit_enabled: false` to
   defer.
3. **PR 3 — subtractive.** One release after PR 2, delete the flag.
   Add a `switchroom doctor` check that verifies:
   `~/.switchroom/config-backups/` exists, is mode `0o700`, is owned
   by the operator UID, is writable, and contains at most 10 `bak-*`
   files (rotation working). Warn on any miss; error on
   non-writable.

A `switchroom config-edit history` CLI subcommand could surface the
audit rows for the operator's review; out of scope for this RFC,
mentioned so future readers don't think it was missed.
