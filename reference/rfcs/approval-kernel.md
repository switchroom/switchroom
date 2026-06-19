# RFC B: Unified human-approval kernel

Status: Draft v4 — **partially shipped; hard-boundary direction descoped for single-tenant (2026-06-02)**
Author: klanker (sub-agent draft)
Date: 2026-05-06

> **Scope note (2026-06-02).** The kernel, nonce/scope binding, per-agent
> socket ACL, and `apv:` callback flow are shipped. The "hard boundary"
> direction this RFC anticipates — making the agent↔gateway channel
> unforgeable against a **same-uid** actor (a host-side operator verifier
> setting `origin='operator'`, flipping
> `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT=1`, and the second-bot idea
> floated alongside it) — is **descoped for the single-tenant deployment**
> switchroom targets. Same-uid is out of scope by construction
> (`docs/vault.md`), so that machinery defends a threat this product
> doesn't have, at real cost. The authorization contract that supersedes
> the hard-boundary framing is [`reference/rfcs/access-model.md`](access-model.md);
> the mint flag stays **off** by default. Reopen only if the deployment
> model changes (untrusted agents / multi-operator / hostile network).

Prerequisite: **RFC A — Bot token to vault** (`reference/rfcs/bot-token-to-vault.md`). Keeping the token in the vault rather than plaintext `.env` is still worthwhile hygiene (one revocation surface, no casual read); it is **not** relied on as a security boundary against a same-uid agent per the access model.

## 1. Summary

Switchroom asks the user to approve sensitive actions through several independent code paths today: deferred-secret cards (`vd:`), vault grants, and the various per-MCP prompts that are about to multiply as Drive, Notion, Slack, and Gmail wrappers come online. This RFC proposes a single approval kernel — folded into the existing vault broker — that **secrets and MCP tool calls** plug into. One process, one socket, one SQLite file, one audit table, one Telegram card primitive, one set of `/approvals` commands.

**Scope is deliberately narrow.** The kernel covers secrets, vault grants, and MCP tool calls (Drive, Notion, Slack, Gmail, etc.). Tool/skill permissions stay on the existing `permission-rule.ts` + `settings.json` path — see §14.

## 2. Motivation

Approval-shaped surfaces in the codebase today:

- **Deferred-secret cards** with `vd:unlock|cancel` callbacks — `telegram-plugin/gateway/gateway.ts:5555`.
- **Vault grants** via the `/vault grant` wizard, persisted to SQLite at `~/.switchroom/vault-grants.db` — schema in `src/vault/grants.ts`.
- **Operator and dashboard prompts** under `op:` and `auth:` callback prefixes — `telegram-plugin/gateway/gateway.ts` (callback dispatcher at `:8285`; infrastructure-prefix list at `:2304`).

Adding a Google Drive MCP, then Notion, Slack, and Gmail, means adding a fresh approval surface every time unless the shape is unified. Each duplicates: callback parser, storage decision, TTL semantics, revocation command, audit trail. The user sees inconsistent UX and there is no `/revoke-all` killswitch covering everything.

## 3. Threat model

Trust root: the user's Telegram account (with 2FA). An inbound `callback_query.from.id` is authenticated by Telegram's bot session and cannot be spoofed remotely.

Same-uid compromise of an agent process is **game-over**, per `docs/vault.md:227` ("ACL is misconfiguration protection, not a security boundary"). The kernel does NOT defend against same-uid attackers; it defends against accidental misuse and provides an auditable trail of approvals. Filesystem perms and the vault passphrase are the real boundary; this RFC works inside that envelope.

Two existing protections matter and are reused as-is: peercred + cgroup unit identity at the broker socket (`src/vault/broker/peercred.ts`), and per-agent ACL enforcement (`src/vault/broker/acl.ts`). The peercred regex needs broadening to long-running units (§4.1); that's a real bug fix, not added hardening.

## 4. Design — fold into the vault broker

The kernel does not stand up a parallel broker. Approvals live as new tables in the existing `vault-grants.db`. Filename is preserved (no rename) to keep downgrade simple.

The existing vault broker at `src/vault/broker/server.ts` grows new RPC methods:

- `requestApproval({ scope, why, ttl_hint })` → `{ status: 'pending', request_id }` immediately.
- `lookupDecision({ request_id | scope })` → checks for a live grant or pending decision. Used both for fast-path matching and for the short-poll wait loop (§10).
- `recordDecision({ request_id, mode, ttl })` → invoked by the gateway when the user taps.
- `revoke({ id, reason })` and `listForUser({ user_id })`.

**Honest reuse claims.** What is reused: the IPC socket, peercred + cgroup transport, the agent-identity ACL machinery, the audited SQLite handle, broker test scaffolding. What is **new code** named as such: the `apv:` callback router, the ScopeMatcher subsystem (§6), the short-poll wait protocol (§10), the staleness digest job (§9.1), the batch-coalescing logic (§11), the `/approvals` command surface.

### 4.1 Peercred regex must be broadened

`src/vault/broker/peercred.ts:223` currently matches **only** cron units:

```
/^switchroom-[a-zA-Z0-9_-]+-cron-\d+\.service$/
```

Long-running agent units like `switchroom-klanker.service` are not matched and fail the broker's auth check today. Replace with:

```
/^switchroom-[a-zA-Z0-9_-]+(-cron-\d+)?\.service$/
```

This is a real bug fix needed for the kernel (and arguably for any long-running agent's vault access today). Pair it with the existing `verifySystemdUnit` cross-check at `peercred.ts:254`, which the broker already calls on every request.

## 5. Decision storage

Two tables in `vault-grants.db`: a **grants** table for durable decisions, and a **nonces** table that holds the per-prompt 8-hex callback request id and tracks single-use redemption. No HMAC, no chains.

```sql
CREATE TABLE approval_decisions (
  id                       TEXT PRIMARY KEY,    -- UUID v4
  agent_unit               TEXT NOT NULL,       -- systemd unit, verified via peercred + verifySystemdUnit
  scope                    TEXT NOT NULL,       -- see §6
  action                   TEXT NOT NULL,       -- agent's intended action (read|write|...); required for the (agent_unit, scope, action) lookup index per §6
  decision                 TEXT NOT NULL,       -- allow_once | allow_always | allow_ttl | deny | deny_perm
  ttl_expires_at           INTEGER,             -- unix-ms, NULL for non-ttl
  granted_at               INTEGER NOT NULL,
  granted_by_user_id       INTEGER NOT NULL,    -- Telegram user_id
  approver_set_canonical   TEXT NOT NULL,       -- canonicalized JSON of allowFrom at grant time; see §5.1
  last_used_at             INTEGER,             -- for sliding-window TTL + staleness
  revoked_at               INTEGER,
  revoke_reason            TEXT
);

CREATE TABLE approval_nonces (
  request_id              TEXT PRIMARY KEY,    -- 8-hex from generateAskId; appears in apv:<id>:... callback_data
  decision_id             TEXT,                -- FK into approval_decisions once a tap lands; NULL while pending
  agent_unit              TEXT NOT NULL,
  scope                   TEXT NOT NULL,
  action                  TEXT NOT NULL,       -- intended action; carried on the nonce so redemption is atomic without a join
  approver_set_canonical  TEXT NOT NULL,       -- snapshot of allowFrom at request time; lets the consume step verify drift without a separate lookup
  why                     TEXT,                -- agent-supplied "why this access" string
  created_at              INTEGER NOT NULL,    -- unix-ms
  expires_at              INTEGER NOT NULL,    -- unix-ms; 5-min default per §8.1
  consumed_at             INTEGER              -- unix-ms; set atomically on first tap; subsequent taps no-op
);

CREATE TABLE approval_audit (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  agent_unit  TEXT NOT NULL,
  scope       TEXT NOT NULL,
  action      TEXT,             -- agent's intended action (read|write|...); same column name as on approval_decisions
  event       TEXT NOT NULL,    -- kernel verb: request | grant | deny | revoke | timeout | match | consume | expire | drift_revoke
  decision_id TEXT,
  context     TEXT              -- JSON: why-string, request_id
);
```

UUID is the durable primary key. The 8-hex callback token (matching existing `generateAskId` at `telegram-plugin/ask-user.ts:133`) maps to the UUID for the prompt's lifetime only.

The audit table splits agent-intent from kernel-verb into two columns: `action` records what the agent wanted to do (read/write/etc., same vocabulary as `approval_decisions.action`) and `event` records what the kernel did about it. Audit-by-scope queries need both. `event` is a superset of the original RFC vocabulary — it adds `consume`, `expire`, and `drift_revoke` for operational events the kernel records (nonce redemption, prompt timeout, drift-triggered auto-revocation per §5.1).

The "same-uid attacker writes a forged grant row directly to SQLite" attack is acknowledged per §3 and not defended against in code; it's defended against by the trust model documented in `docs/vault.md`.

### 5.1 Config-drift auto-revocation

A grant recorded when `allowFrom = ["U1"]` must not silently extend if `allowFrom` later becomes `["U1", "U2"]`. We don't HMAC-bind the approver set into the row, but we do compare on lookup:

- Store the approver set captured at grant time in the `approver_set_canonical` column (canonicalized JSON: NFC-normalized, sorted lexicographically, no insignificant whitespace).
- At every `lookupDecision`, re-read the current `allowFrom`, canonicalize identically, compare against the row's `approver_set_canonical`.
- If they differ: write a `drift_revoke` audit row, return no-grant, force re-prompt under the new approver set.
- If the current set has more than one approver, all standing grants are dormant until the operator re-confirms each one.

This makes "future multi-user support" a tripwire rather than a silent expansion.

## 6. Scope grammar

Pluggable per surface. Each consumer registers a namespace and a matcher.

```ts
interface ScopeMatcher {
  namespace: string                     // 'secret' | 'mcp' | 'doc'
  matches(grant: string, request: string): boolean
  humanize(scope: string): Promise<string>  // for card display, async
}
```

ScopeMatcher is **new code** — not a reuse of `checkEntryScope` in `src/vault/broker/acl.ts` (that one matches agent slugs against entry allow/deny lists; different problem). The agent-identity ACL gating IS reused; scope-string-vs-scope-string matching is built fresh.

Namespaces in v1:

- `secret:OPENAI_*` — env-name glob.
- `doc:gdrive:1abc...xyz` — specific Drive doc id.
- `doc:gdrive:folder/789/**` — folder glob.
- `mcp:notion:page:...`, `mcp:slack:channel:...`, etc.

### 6.1 Callback wire format

Telegram callback_data is hard-capped at 64 bytes including the bridge's `agent:` prefix. Scopes won't fit. Wire format:

```
apv:<8-hex request id>:<action>[:<param>]
```

- 8-hex request id matches `generateAskId` convention.
- Single-use enforced by an atomic `UPDATE approval_nonces SET consumed_at = ? WHERE request_id = ? AND consumed_at IS NULL` with a rowcount check. Only on rowcount=1 does the kernel proceed to insert/update the corresponding `approval_decisions` row. A re-tap of an already-consumed callback returns a brief "this prompt expired" toast via `answerCallbackQuery`. *(PR-6: the Telegram `apv:` card path realizes this "only on rowcount=1 do we proceed to the decision row" as a single atomic `approval_consume_record` op — `consumeNonce` + `recordDecision` in one `db.transaction()` — rather than two RPC round-trips, so a broker death between consume and record can no longer burn the nonce without a decision. See `src/vault/approvals/MIGRATION.md`.)*
- Examples: `apv:a3f1b9c2:allow`, `apv:a3f1b9c2:ttl:1h`, `apv:a3f1b9c2:deny`.

Full scope and humanized title are stored server-side keyed by request id.

## 7. Decision modes

Universal across surfaces:

- `allow_once` — single use. **This is what the primary `Allow` button binds to.**
- `allow_always` — standing grant, no expiry. Subject to drift-revocation (§5.1).
- `allow_ttl` — bounded grant, **sliding window with hard cap.** Each successful match against an `allow_ttl` row updates `last_used_at` and extends `ttl_expires_at = now + ttl_original_ms`. Renewal is silent (sudo-style, not Bitwarden-style). The renewal does NOT extend past `granted_at + max_lifetime`. Default sliding-window TTL: 7 days (configurable per-decision via `opts.max_ttl_lifetime_ms`). The implementation chose a more conservative default than the original 30d; either value is reasonable, the codepath is the same. Default per-prompt TTL is 1h; user can override via the expand picker.
- `deny` — single-shot reject.
- `deny_perm` — standing reject; future requests auto-fail without re-prompt.

The card surfaces only the common subset. Full mode set is editable via `/approvals`.

## 8. Telegram approval card UX

One shape, every surface. Built on the existing `aq:` (ask_user) primitive at `telegram-plugin/gateway/gateway.ts:8321` — that path already handles topic routing, quote-reply targeting, reaction lifecycle, and `allowFrom` enforcement. The kernel registers a new `apv:` callback handler and reuses the rest.

### 8.1 Card states

**Pristine:**

```
🔐 klanker wants to read a doc
"Q3 Strategy Notes"     ← humanized via doc-title resolver
[ See more ]   [ ✅ Allow ]   [ 🚫 Deny ]
[ 🔁 Always ]  [ ⏱ For 1h ]
```

**Primary `Allow` = `allow_once`.** Stated explicitly so it cannot be re-interpreted later. `Always` and `For 1h` on the secondary row are explicit overrides. `Always` is offered only when scope is rule-synthesizable. `For 1h` is a single TTL default; the picker lives behind expand.

**Expanded** (after `See more`): call-site context, raw scope string, agent-supplied "why this access" line, TTL picker (`1h` / `24h` / `7d`), `Deny permanent`, custom mode.

**Granted (in place):** `✅ Granted once · /approvals revoke a3f1b9c2`

**Granted always:** `✅ Granted always to klanker for doc:gdrive:1abcDEFxyz789 · /approvals revoke a3f1b9c2`

**Denied:** `🚫 Denied`

**Expired (5-minute timeout):** `⌛ Expired — agent will re-request.` A tap on an already-expired callback returns `answerCallbackQuery({ text: 'this prompt expired' })`.

**Revoked-after-grant:** on the next use attempt the agent gets a denial; the kernel posts a fresh notification card identifying which standing grant fired the denial and offering one-tap reinstate.

### 8.2 humanize() with a 500ms render budget

The kernel calls `humanize()` before rendering but never blocks on it.

1. Kick `humanize(scope)` immediately on `requestApproval`.
2. Race against a 500ms timer.
3. If `humanize()` resolves first → card ships with the humanized title.
4. If the timer fires first → card ships with the raw scope; when `humanize()` later resolves (within a 5s ceiling), patch via `editMessageText`.
5. If `humanize()` rejects or hits the 5s ceiling → leave the raw scope, append a small `(could not resolve)` annotation.

### 8.3 Patterns preserved through migration

- **`perm:more` expand button** at `gateway.ts:1980` — basis of the new card's expand. Same UX shape.
- **`vd:unlock` deferred-secret card flow** at `gateway.ts:5555` — Phase 2 migrates this surface; the inline-passphrase capture step must survive the move.
- **`aq:` topic-routing + reaction lifecycle** at `gateway.ts:8321` — inherit, do not rebuild.
- **`allowFrom` enforcement on every callback** — match the existing pattern.

## 9. Audit, revocation, staleness

- `/approvals list` — paginated, two-level. Top-level shows agent summary counts (`klanker: 12 grants, gymbro: 3 grants, …`) with tappable inline buttons. `/approvals list <agent>` shows up to 20 rows; older accessible via `Next →`. Each row has inline `Revoke`. User mental model: "what can klanker do?"; GitHub-style permissions UI is the reference.
- `/approvals revoke <id>` — single revoke; logs to `approval_audit`. **Every grant card's confirmation message includes `· /approvals revoke <id>` inline** so revocation is one tap from the grant itself.
- `/approvals add` — wizard for adding grants outside a prompt context (e.g. "allow all of Drive" post-onboarding).
- `/approvals stats` — surfaces 7-day request/grant/deny counts per agent. Used by the soft-alert in §11.
- `/revoke-all` — killswitch. See §9.2.

### 9.1 Staleness model with weekly digest coalescing

Rather than per-row prompts (which scale badly — 40 stale rows = 40 prompts), staleness coalesces into a single weekly digest with the same threshold-trigger logic:

- **New-grants digest** (threshold-triggered): when `count(allow_always WHERE never_seen_in_digest) >= 3`, send a digest of the new standing grants. At most one digest per 24h.
- **Stale-grants digest** (weekly): grants that haven't fired in 30d coalesce into one digest with one inline `Revoke` button per row. **No more than one staleness digest per week** regardless of how many rows go stale.
- Suppression is set per-row when the user taps `Keep` (suppressed for another 30d) or implicitly when the row remains in the digest unchanged for 4 consecutive weeks (auto-revoke under "stale and ignored", configurable).

Steal sudo's pattern: surface staleness, not totals.

### 9.2 `/revoke-all` ordered sequence

Multi-step with real failure modes; spec the ordering.

1. **Telegram `revokeToken`** — call the Bot API to evict the current token at Telegram's edge. If this fails: abort, surface `revoke_all_step1_failed`; nothing has changed.
2. **Mark all active rows revoked** in `approval_decisions`. If this fails after step 1: token is dead at Telegram; gateway will fail to receive updates on next poll. Operator runs `switchroom token rotate`.
3. **Write new token to vault** under the bot-token slot (RFC A).
4. **SIGHUP gateway** — gateway re-reads token from vault.
5. **Mark `revoke-all` complete** — audit row.

`switchroom token rotate` is the recovery command — idempotent re-run of steps 1, 3, 4. Documented in killswitch help text.

## 10. Wait protocol — short-poll

The vault broker is request/response. Approvals can wait up to 5 minutes for a tap. Long-poll (broker holds connection open) is rejected: it ties up a socket per pending request, opens a small DoS surface, and requires keepalive framing inside the existing IPC.

**Short-poll spec:**

1. Agent calls `requestApproval(...)` → `{ status: 'pending', request_id }` immediately.
2. Agent calls `lookupDecision({ request_id })` every 2 seconds. Broker responds immediately with `{ status: 'pending' | 'granted' | 'denied' | 'expired', mode?, ttl? }`.
3. On `granted`/`denied`/`expired`, agent stops polling.
4. On gateway restart between polls, agent simply retries — `lookupDecision` is stateless from the agent's perspective.

**Caps:**

- Per `agent_unit`: max 2 concurrent pending requests. A third returns `{ status: 'rate_limited', retry_after_ms: 5000 }`.
- Global: max 32 pending across all agents.

## 11. Risks and open questions

- **Cross-agent grant scope is unit-scoped.** `allow_always` for `secret:OPENAI_API_KEY` granted to klanker does NOT auto-grant to gymbro. Each `agent_unit` is a separate principal, matching existing vault grants. User-scoped grants out of scope for v1.
- **Callback delivery is best-effort.** If the gateway is down when the user taps, the tap is lost. 5-minute timeout, `timeout` audit row, agent re-issues if still wanted.
- **OAuth tokens (Google refresh tokens) live in vault.** Kernel asks vault for the token by slot name; vault enforces its own grant on that slot; kernel never persists raw tokens.
- **Adding a user re-confirms standing grants.** Multiple trusted users per agent is supported (`single-tenant` invariant), but standing *grants* stay conservative: drift-revocation (§5.1) makes a roster change safe-by-default — the moment `allowFrom` changes (including growing past one entry), every standing grant becomes dormant pending re-confirmation. Per-user grant *scoping* is out of scope for v1 (grants are unit-scoped, matching the invariant's "nothing finer than the per-agent user assignment").
- **Tap-budget target and instrumentation.** Day 1 of Drive enablement: 10–30 taps expected (cold cache, no folder grants). Steady state: <5 taps/day. `/approvals stats` surfaces 7-day tap counts. Soft-alert (DM) at >10 taps/day sustained for 3 days. If exceeded, **batch coalescing** kicks in: the kernel buffers prompts for 5 seconds; if 3+ pending share a scope-prefix (e.g. `doc:gdrive:folder/Work/*`), it collapses into a single "klanker is requesting access to 4 docs in /Work — allow folder?" card.

## 12. Migration plan

**Prerequisite: RFC A** (bot token in vault) is in place.

**Phase 1 — kernel folded into vault broker.** New `approval_decisions` and `approval_audit` tables in `vault-grants.db` (no rename), new RPC methods on `src/vault/broker/server.ts`, broaden peercred regex (§4.1), short-poll wait protocol (§10), `apv:` callback router in gateway, `/approvals list|revoke|add|stats` commands, drift revocation, plus tests matching the existing broker's coverage. **~1.5 days.**

**Phase 2 — secrets as first consumer.** Migrate the deferred-secret card path (`gateway.ts:5555`) to call the kernel. Lower-traffic, validates the abstraction. Preserve the inline-passphrase capture UX. ~0.5 day.

**Phase 3 — first MCP consumer (Google Drive).** Covered separately in **RFC D — Google Drive MCP integration** (originally drafted as "RFC C", renumbered after `host-control-daemon.md` took the C slot).

## 13. Estimated effort

RFC B Phase 1 + Phase 2: **~2 days.**

Combined with RFC A (~0.5d) and RFC D (~1d): **~3.5 days total** across the three RFCs.

## 14. Out of scope

- **Tool/skill permission migration: deferred indefinitely.** Tools and skills stay on the existing `permission-rule.ts` + `settings.json` path, untouched. Migrating Claude's tool-permission prompts into the kernel would conflict with switchroom's "unmodified Claude" principle (`README.md:16`) — it requires intercepting and rewriting `settings.json` from kernel state, which the kernel does NOT do. The kernel is not authoritative for tool perms.
- Group / multi-user bot support.
- Per-action MFA prompts beyond approval — Telegram 2FA is sufficient at this trust level.
- Web dashboard approval UX (CLI + Telegram only for v1).
- User-scoped (cross-agent) grants — every grant is unit-scoped in v1.
- Per-agent BindPaths / user-namespace isolation of the DB file. Same-uid is game-over per `docs/vault.md:227`; the kernel works inside that envelope.
- Bash-arg matching — out of scope along with the rest of tool-perm migration.
- DB filename rename to `vault.db` — kept as `vault-grants.db` to preserve downgrade path.
