# RFC — Cheap cron: deterministic polls + a per-agent Sonnet cron session

**Status:** Draft, post-review (rev 2)
**Author:** (agent-authored, operator-directed)
**Targets:** `upstream/main` @ v0.14.91
**Compliance pillar touched:** 3 (Claude-native, subscription-honest) — preserved by construction; see §7.

---

## Review verdict (5-lens adversarial, rev 1 → rev 2)

| Lens | rev 1 | After rev-2 changes |
|------|-------|---------------------|
| Compliance (pillar 3) | **APPROVE** | unchanged — Tier 0 model-free; Tier 1/2 interactive, no `-p` |
| Feasibility | REQUEST_CHANGES | §3.3 rewritten to own the full gateway refactor scope |
| Resources/Ops | REQUEST_CHANGES | §2.2 runtime shape → **lazy session (B3)**; double-escalation §2.1 |
| Security | **BLOCK** | §6.1 **SSRF/exfil hardening** added; §6.2 operator-commit boundary |
| Completeness | REQUEST_CHANGES | §2.4 status isolation; §5 observability; §3.1 custom-model migration |

The BLOCK was the `http-diff` SSRF/secret-exfil surface (§6.1). It is resolved at
the design level here; the build must implement the egress guard + host-pinned
secret bindings before any Tier-0 poll ships. Everything else was either
"code-not-yet-written" (expected for a spec) or a genuine sharpening folded in
below.

---

## 0. TL;DR

Cron fires are expensive for one structural reason: **every fire injects a
synthesized turn into the agent's live interactive session**, so it pays the
full standing-context cache-read tax (system prompt + ~31k-token MCP schema
surface + the whole running conversation) *and* runs at the agent's configured
model — even when the fire is a `*/10` poll that finds nothing to do.

Three tiers, cheapest-first:

- **Tier 0 — deterministic poll (no model).** Poll-heavy crons run a *declarative,
  operator-approved* poll in the scheduler process. No new data → `HEARTBEAT_OK`,
  **zero model tokens.** Only a hit escalates.
- **Tier 1 — per-agent cheap cron session.** Crons that need a model but not the
  agent's persona/memory fire into a **minimal-context `claude --model sonnet`
  session**, addressed by a new gateway session label `cron`. ~5–20× cheaper.
- **Tier 2 — main session (status quo).** Crons that need the agent's full context
  inject into the live session exactly as today.

Routing key = the **dead-but-present `ScheduleEntry.model` field** (reactivated) +
two new optional fields (`kind`, `context`). Behind `SWITCHROOM_CHEAP_CRON`
(default **off**), canaried on the two crons we disabled 2026-06-09.

---

## 1. Problem (grounded in code)

### 1.1 The fire path today

`src/agent-scheduler/index.ts` fires a node-cron handler → `dispatchAsInbound`
(`src/scheduler/dispatch.ts:193-219`) synthesizes an `InboundMessage` with
`meta.source='cron'` → `ipc-client.ts:159-167` writes `inject_inbound` NDJSON to
`gateway.sock` → `gateway.ts:6287-6305` `onInjectInbound` → `ipcServer.sendToAgent`
→ **the single registered bridge** → the live claude session runs it as a turn.

Consequences:

1. **Standing-context tax every fire.** The live session carries the full
   prompt-cache prefix (memory `project_context_token_optimization`: ~63k-token
   floor + the running conversation). Each fire re-reads it (`cache_read ≈ 0.1×`
   on 60k+ tokens = thousands of cost-weighted tokens) **whether or not there is
   work.** `*/10` = 144 fires/day, ~all no-ops.
2. **Agent's model, fixed per container** by `--model {{modelQ}}`
   (`start.sh.hbs:673` from `scaffold.ts:2181`; default
   `SWITCHROOM_DEFAULT_MAIN_MODEL='claude-sonnet-4-6'`). An Opus agent runs every
   fire at Opus (`output ≈ 5×`).
3. **`ScheduleEntry.model` is a dead letter** (`schema.ts:64-106`; `SchedulerEntry`
   `dispatch.ts:25-42` omits it). Set it today → **no error, no effect.**

### 1.2 The two disabled crons — both polls

- `clerk` `telegram-capture` (`*/10`, **144 fires/day**): `get_recent_messages` →
  capture 👨‍💻-reacted msgs to Notion → `HEARTBEAT_OK` if none.
- `marko` `lead-alert-3homes` (`*/15`, **96 fires/day**): `GET Brevo list 20` →
  email new "3 Homes" leads → `NO_REPLY` if none.

Neither needs a model on the no-op path. **240 fires/day, ~all wasted.**

---

## 2. Design: three tiers

```
                       cron fires (scheduler sidecar)
                                  │
                    ┌─────────────┴──────────────┐
                    │  entry.kind / .model / .context  │  ← pure routing fn
                    └─────────────┬──────────────┘
        ┌──────────────┬──────────┴──────────┬─────────────────┐
        ▼              ▼                      ▼                 ▼
   Tier 0          (hit→)              Tier 1             Tier 2
 deterministic  ──────────────▶  cheap cron session   main session
   poll (no                      claude --model sonnet  (live, status quo)
   model)                        session="cron", fresh  session="main"
        │                              │                      │
   HEARTBEAT_OK                   inject(session=cron)   inject(session=main)
   (no fire)                      reply-only, no card    full status card
```

### 2.1 Tier 0 — deterministic poll (no model)

`kind: poll` carries a **declarative, operator-approved** poll spec. **Not** an
agent-authored script (§6.2). Two built-in types cover the fleet:

- `poll: http-diff` — `{ url, method, headers?, secrets:[...], diff_jsonpath,
  state_key }`. Scheduler does a guarded `fetch()` (§6.1 — egress allowlist,
  no-redirect, host-pinned secret binding), extracts `diff_jsonpath`, compares to
  the last value under `state_key`. **New → escalate; unchanged → `HEARTBEAT_OK`.**
- `poll: telegram-reactions` — `{ chat_id, emoji, lookback }`. Needs a **new
  gateway internal IPC verb** `query_recent_reactions` (today `get_recent_messages`
  exists only as an MCP tool via the bridge — `bridge.ts:281` — there is no
  model-free internal path; this verb is net-new, see §3.3 / Q4). **Match →
  escalate; none → `HEARTBEAT_OK`.**

Tier 0 touches **no model** → outside pillar 3's inference surface (§7).

**Idempotency / no double-escalation (review-found race).** The escalation is
itself a Tier-1 fire whose audit lands *after* the Sonnet turn runs. A restart
mid-turn would let boot-replay re-fire the original poll and escalate twice
(e.g. email a lead twice). Fix: **write-ahead the state advance.** Before
dispatching the Tier-1 escalation, atomically write to `poll-state.json`:
`{ state_key: <new value>, escalated_at: <fire-ts>, pending_escalation: <diff> }`.
On boot, the poll re-reads state first; the already-advanced `state_key` means
the re-poll sees no new data → no re-escalation. `pending_escalation` lets a
crashed-before-dispatch escalation be re-sent exactly once (clear it on
dispatch-ack). State advance and escalation intent are one durable write.

**First-run semantics (Q3, now resolved).** No baseline ⟹ **record baseline, do
NOT escalate** (else every existing Brevo contact emails on day one). poll-state
lives on the `/state/agent/` volume; reconcile writes scaffold/config only and
**must not** touch runtime state — pinned by a new test
`tests/agent-scheduler/tier0-poll-first-run.test.ts`.

**Errors don't escalate.** Brevo 500 / vault denial / bad jsonpath → record a
poll-error row + **one-shot** operator notice (not every fire) naming the
next-step command; reuse the existing bounded retry ladder (`index.ts:156-230`).

**Min-interval applies to polls too** (§6.3) — model-free ≠ free (each poll hits
an external API / the broker; a tight poll is a cheap DoS).

### 2.2 Tier 1 — per-agent cheap cron session

A second **interactive** `claude --model {cronModel}` (default
`claude-sonnet-4-6`) in the agent container, addressed by gateway session label
`cron`. Minimal-context by construction: own `CLAUDE_CONFIG_DIR=.claude-cron`
(separate transcript), a **trimmed `.mcp.json`** (only `switchroom-telegram` +
the task's tool — not the full hindsight/perplexity/webkite surface, cutting the
~31k schema tax), `/clear` between fires.

**Runtime shape — recommendation changed by review to B3 (lazy).** Three shapes:

- **B1 — persistent at boot.** Warm, simplest supervision, but **doubles idle
  memory 24/7** to serve fires that Tier 0 makes rare. Needs a per-profile mem
  bump on tight (1.5g) profiles.
- **B2 — ephemeral per-fire.** Zero idle cost, minimal context by construction,
  no mem bump — but per-fire cold start + per-fire bridge-registration
  orchestration (the harder build).
- **B3 — lazy with idle-timeout (RECOMMENDED).** Forked on the *first* Tier-1
  fire, kept warm, **torn down after N minutes idle** (default 30). Zero idle
  cost in steady state (Tier 0 absorbs the frequent polls), warm within a burst,
  no per-fire cold start inside a burst, no permanent mem-bump. Best fit for the
  "rare bursty Tier-1 fire behind a frequent Tier-0 poll" profile this design
  creates. **The canary measures the Tier-0 no-op fraction first** (§5) — if it
  is >90% as expected, B3 is clearly right; the data also sizes any mem headroom.

All three are **interactive `claude` (no `-p`)** (§7). **B2/B3 must not be built
headless** — a CI guard asserts every cron-session spawn is interactive +
`--strict-mcp-config` (extend `tests/bridge-flap-regression-guard.test.ts`).

### 2.3 Tier 2 — main session passthrough

`context: agent` (or `model: opus`) → today's exact path (`session=main`, live
session, full status card). The safe default for anything the migration is unsure
about (§3.1).

### 2.4 Status-surface isolation (review-found collision)

A second session emitting Telegram status into the same chat+topic as the main
session collides: two sessions editing one progress card; a main-session reply
closing a cron's obligation; competing worker-feed `editMessageText`. **v1
stance: the cron session is status-silent** — it renders **no** progress card and
**no** worker-activity feed; its only Telegram output is the final reply. And
**obligations are session-scoped**: add `sessionLabel` to the `Obligation`
interface (`obligation-ledger.ts:29-58`) + the close-matcher
(`resolveCloseTarget`) + the durable store, so a cron-originated obligation can
only be closed by a cron-session reply. This removes every cross-session race for
v1 and shrinks scope; per-session live cards are a possible v2.

---

## 3. Schema & creation surface

### 3.1 Reactivate + extend `ScheduleEntry` (`schema.ts:64-106`)

```yaml
schedule:
  - cron: "*/15 * * * *"
    kind: poll                 # NEW: poll | prompt   (default: prompt)
    poll:                      # NEW: required iff kind=poll
      type: http-diff
      url: "https://api.brevo.com/v3/contacts/lists/20/contacts"
      secrets: [brevo_api_key] # host-pinned (§6.1); resolved by scheduler, no model
      diff_jsonpath: "$.contacts[*].id"
      state_key: last_max_contact_id
    prompt: |                  # ESCALATION prompt (Tier 1), templated with {{diff}}
      New 3-Homes lead(s): {{diff}}. Email luke@… and info@… per the SOP.
    model: sonnet              # REACTIVATED: sonnet | opus | <id>  (default: sonnet)
    context: fresh             # NEW: fresh | agent   (default: fresh)
```

Thread `model`/`context`/`kind`/`poll` into `SchedulerEntry` (`dispatch.ts:25-42`)
and `collectScheduleEntries`; `dispatchAsInbound` emits `meta.model` + `meta.session`.

**Cascade (Consistency check).** Schedule entries are **per-agent, no
cross-entry/cross-layer inheritance** of the new fields; the array stays
concat/append-only (`merge.ts:559-561`). Documented in `docs/configuration.md`.

**Migration — guarantee no existing cron changes tier silently:**

- `model: opus` or **unset** → `context: agent` (Tier 2 = today's behaviour).
- **`model` = a known-cheap id (sonnet/haiku family) only** → `context: fresh`.
- **Custom / unrecognised model id → `context: agent`** (conservative; never
  assume a custom id is cheap) **+ a one-time warn**: "cron X has custom model Y —
  running on the main session; set `model: sonnet` + `context: fresh` to use a
  cheap cron session."

This closes the review's silent-tier-flip gap for every current fleet config.

### 3.2 `schedule_add` (agent-config MCP) — cheap by default, operator-gated

`server.ts:133-149` + `agent-config-write.ts`. New params: `model` (default
`sonnet`), `context` (default `fresh`), `kind` (default `prompt`), `poll`.

- **New agent-authored crons default cheap** (`sonnet`/`fresh`). The
  `schedule_add` response states it plainly so it is never silent: *"this cron
  will run on Sonnet in a fresh cron session, not <agent>'s own model/persona —
  pass context: agent to use the agent."*
- **Escalation is operator-gated, and the gate is the *commit*, not an env
  check.** `context: agent`, `model: opus`, or any new `poll.secrets`/`poll.url`
  from an agent **stage** under `.pending/` (new `PendingReasonCode`s) and go live
  **only** when the operator commits (`schedule pending commit`, routed via hostd
  Allow/Deny — memory `feedback_dashboard_loopback_header_forge`). An agent
  scrubbing `SWITCHROOM_AGENT_NAME` (the pre-existing, acknowledged host-CLI
  identity weakness, `agent-config-write.ts:119-127`) still **cannot** commit its
  own pending entry — the operator commits. The security boundary is the
  operator-only commit, by design, not the forgeable agent-side identity.
- **Cost label at staging (v1, lightweight).** The pending meta carries a coarse
  `fires_per_day × tier_weight` estimate (sonnet=1, opus=5) so the operator's tap
  sees the spend before approving. Full predictive UX deferred to v2; v1 ships the
  one-number bound rather than zero visibility.

### 3.3 Gateway: session-labelled routing — the real refactor (review-corrected)

This is **more than one primitive.** Three structures are single-keyed by agent
and a second bridge would clobber the first today:

- `agentIndex` (`ipc-server.ts:359`, replaced in `handleRegister` ~617-633) →
  rekey to `(agent, session)`.
- `sendToAgent(agent, msg)` (`ipc-server.ts:760`) → add a `session` arg; route in
  `onInjectInbound` by `(agent, session)`.
- `pendingInboundBuffer` (`pending-inbound-buffer.ts:290`, keyed by agent) → rekey
  to `(agent, session, prompt_key)` so a fire while the cron bridge is down
  buffers/drains to the **cron** bridge, not main.
- `InboundMessage.meta` (`ipc-protocol.ts`) gains optional `session: string`;
  validation (`ipc-server.ts:228-248`) **allows** it, **defaults absent → `main`**
  (back-compat: every existing caller stays on `main`).

Scope: a contained but real change across the gateway IPC layer (index +
register + buffer + protocol + validation). Status card, reply routing, and the
obligation ledger key off chat/topic meta and stay session-agnostic **except**
the obligation `sessionLabel` add in §2.4.

---

## 4. Resources & ops

- **B3 makes the mem story easy:** no resident second session in steady state, so
  **no permanent per-profile mem bump.** A short-lived burst session on a 1.5g
  conversational cap (`compose.ts:70-93`) is acceptable; if the canary shows
  burst OOM pressure, add a transient bump only on cron-bearing agents
  (`emitAgentService`, `compose.ts:1285`). PIDs: a burst adds ~50–100; same
  conditional treatment, measured not assumed.
- **Supervision:** B3's fork/teardown reuses `_switchroom_supervise`
  (`start.sh.hbs:68-105`) with an idle-timeout teardown + a per-session audit
  line so a crash-looping cron session is visible and can't mask a healthy main.
- **Env-order landmine:** the fork's env must be exported in the preamble before
  it (`start.sh.hbs:47`, memory `project_configurable_status_clear_v0_14_55`).

## 5. Observability (review-found gap — now v1)

The value prop is cost; the operator must *see* it.

- `DispatchResult` (`dispatch.ts`) gains `tier: 'poll'|'cheap'|'main'` +
  `model_used`; written to `scheduler.jsonl` and the gateway fire log.
- A report surface — extend the existing `switchroom schedule`/`auth schedule`
  family with `switchroom schedule report <agent> [--since]`: counts of
  poll / cheap / main fires + an estimated cost-weighted-token breakdown
  (`poll×0 + cheap×sonnet + main×opus`). This is how the canary's success is
  *measured*, so it is v1, not v2.

## 6. Security

### 6.1 `http-diff` egress hardening (resolves the BLOCK)

A poll = URL + headers + vault secrets executed by the scheduler — an exfil/SSRF
primitive unless fenced. Mandatory before any Tier-0 poll ships:

1. **Egress allowlist, operator-owned.** A poll `url`'s host must match an
   operator-approved allowlist (`channels`/`secrets` config, **not**
   agent-writable). Reject loopback, RFC-1918/private, link-local, `*.internal`,
   non-`https`, `file://`, `unix://`. Resolve-then-pin the IP to defeat DNS-rebind.
2. **Host-pinned secret bindings.** A `poll.secrets` name may only be sent to the
   host it is **bound** to in operator config (`brevo_api_key → api.brevo.com`). A
   poll requesting a secret for an unbound host is rejected at staging — the
   operator can't be socially-engineered into approving an exfil because the
   binding, not the agent, decides where a secret may go.
3. **No redirects, hard timeout (5s), response size cap.** Secrets never appear in
   logs/audit/error text; the diff path reads only `diff_jsonpath`.
4. **Tests:** SSRF attempts (`http://127.0.0.1/...`, broker/hostd/gateway sockets,
   rebind) must fail closed; a secret bound to host A must refuse host B.

### 6.2 Declarative-only, broker-gated

No agent-authored poll *code*. Secrets resolve through the vault broker allowlist
as today; the scheduler hands them only to a §6.1-fenced `fetch`, never a model;
a new secret/url **stages** for operator commit.

### 6.3 Cheap-DoS floor

Model-free polls are cheaper to abuse → enforce `MIN_CRON_INTERVAL`
(`agent-config-write.ts:65-69`) for `kind: poll` too, and **harden
`violatesMinInterval`** (`reconcile-dry-run.ts:68-82`) to compute the true
smallest gap for CSV/range expressions (today `0,30 * * * *` slips through);
reject unparseable expressions for cheap-cron rather than passing them.

## 7. Compliance (pillar 3) — preserved by construction

- **Tier 0** touches no model → outside the inference surface (a guarded poll).
- **Tier 1 & 2** are **interactive `claude`** injected via `inject_inbound` — the
  sanctioned synthesized-turn pattern. The cron session launches `exec claude
  --model sonnet …` (no `-p`), the exact shape of `start.sh.hbs:673`, with
  `--strict-mcp-config`. **Neither uses `claude -p`**; a CI guard enforces it for
  the new spawn (§2.2).
- Same broker-managed OAuth `.credentials.json`; no SDK, no API key, no raw API.

## 8. Open questions — genuinely the operator's to decide

(Engineering questions Q3/Q4/custom-model are resolved above.)

- **Q1 — v1 poll scope.** `http-diff` only (canary = marko, 96/day) vs **both**
  poll types (canary = marko + clerk, 240/day). Review note: clerk's reactions
  poll is ~60% of the savings, but `telegram-reactions` needs the net-new internal
  gateway verb (§2.1/§3.3) — more build for a fuller canary.
- **Q2 — cron quota partitioning.** Tier-1 fires share the operator's OAuth weekly
  window. Accept (simple) vs ring-fence a dedicated `fallback_order` account for
  cron (protects live turns from a cron burst, memory
  `project_account_weekly_quota_schedule`).
- **Q5 — runtime shape sign-off.** B3 (lazy) recommended; confirm, or pin B1/B2.

## 9. Build sketch (agent-minutes, post-decision)

- Schema + `SchedulerEntry` thread-through + conservative migration warn: ~30m
- Gateway session routing (index + register + buffer + protocol + validation): ~70m
- §2.4 obligation `sessionLabel` + cron status-silence: ~30m
- Tier 0 `http-diff` engine + write-ahead poll-state + §6.1 egress guard: ~70m
- B3 lazy cron-session (fork/idle-teardown) + trimmed `.mcp.json` + `/clear`: ~55m
- `schedule_add` params + cheap-default + escalation staging + cost label: ~40m
- §5 observability (DispatchResult tier + `schedule report`): ~30m
- §6.3 min-interval hardening: ~15m
- UAT scenario + first-run test + SSRF tests + quota-proof: ~45m
- **v1 total (http-diff only, Q1=narrow): ~6.5 agent-hours.** +`telegram-reactions`
  internal verb (Q1=both): +~50m.
