# Changelog

## v0.18.3 — Watchdog thinking-pause fix, acceptEdits fleet default, Claude CLI 2.1.205, configurable retain cadence

### Gateway: orphaned-reply watchdog survives model thinking pauses (#2949)

The orphaned-reply watchdog force-ended a live turn if no `reply` landed
within its timeout, but a long model *thinking* pause (no stream events, no
tool calls) looked identical to a hung turn. Turns doing real reasoning were
being cut off mid-thought. The watchdog now tracks recent stream activity
(`LivenessTracker`): it only force-ends when the turn is genuinely idle, and
re-arms while the model is still streaming — with the existing re-arm cap
intact so a truly wedged turn still gets reaped. Fixes premature turn
termination during extended reasoning.

### acceptEdits is now the built-in default permission mode (#2951)

Every agent now defaults to `acceptEdits` (auto-accept file edits) without any
yaml — previously only agents with an `allow: [all]` wildcard got it, so a
couple of agents silently sat in ask-before-edit mode and could stall on an
edit prompt they can't answer. Override fleet-wide via
`defaults.permission_mode` or per-agent via `permission_mode`; an explicit
override now wins over the wildcard path too.

**Behavior change:** plain agents with no `permission_mode` that previously
inherited Claude Code's ask-before-edit default flip to `acceptEdits` on their
next scaffold/reconcile. For non-interactive Telegram agents this is the
correct posture (they can't answer an edit prompt — ask-mode just stalls), but
any operator relying on ask-mode as a safety brake should set
`permission_mode: default` explicitly to keep it.

### Bundle Claude Code CLI 2.1.205 (#2951)

Bumps the bundled Claude Code CLI `2.1.199` → `2.1.205` in both
`docker/Dockerfile.base` and `docker/Dockerfile.hindsight`. Rolls up upstream
fixes for background/forked sessions losing `ANTHROPIC_BASE_URL` (401s),
SessionStart-hook idle-reaping, and background agents stuck as failed/completed
after a `SendMessage` resume. The `default`→`Manual` mode rename (2.1.200) is
backward-compatible; emitted `settings.json` values are unaffected.

### Greet by name — Telegram user id resolution via `users.<key>.person_id`

Inbound Telegram messages only ever carried the sender's raw numeric id/username,
so an agent couldn't greet a known person by name without hard-coding an id
somewhere. Adds an optional `person_id` field on `users:` entries
(`lisa: { telegram_ids: [...], profile_bank: ..., person_id: "Lisa" }`); when
set, the `<channel>` tag's `user` attribute shows the display name instead of
the raw id/username (`meta.user_id` is unchanged — still the raw numeric id).

Design constraints, by intent:

- **Not a tool** — never exposed to agents as a callable MCP tool, purely a
  passive `<channel>` attribute.
- **Not hot-reloaded** — the gateway's name-resolution table is built once at
  boot from the config as scaffolded; editing `person_id` requires an agent
  restart to take effect.
- **Fail-open, and completely separate from `access.json`** — `access.json` is
  the fail-**closed** allow-list deciding whether an agent responds at all; this
  feature never touches it. An id that doesn't resolve just falls back to
  today's raw-id behavior, never blocking or denying anything.
- **Chat-scoped** — a resolved name is only shown in a chat/group the person is
  confirmed to be a member of (via that chat's `access.json` `allowFrom`); an
  unrestricted/empty `allowFrom` means membership can't be confirmed, so the
  raw id/username shows instead. A DM always resolves (the chat IS the sender).
  Prevents a name that's fine to show 1:1 from leaking into every group the
  agent sits in.
- **Per-entry, boot-time-only validation** — a malformed `users:` entry (empty
  `person_id`, no `telegram_ids`, or a `person_id` collision) drops only that
  one entry (not fleet-wide) and posts a low-severity "config warning" operator
  alert (reuses the existing fleet-alert channel, tagged so it never pages like
  a real outage) naming the entry and why. The check itself is dead-man's-switch
  protected — if it crashes, that's alerted too, with name resolution disabled
  (fail-open) for that boot rather than failing silently.
- **Accepted soft mitigation** — there's no automated enforcement that a
  `person_id` stays safe if a group's membership changes after the entry is
  written; documented as an operator-discipline convention in
  `docs/configuration.md`, accepted at today's fleet-wide scale (two
  configured users) rather than a closed gap.

### Operator-configurable Hindsight auto-retain cadence (default 3 / 1) (#2950)

The plugin's auto-retain cadence (`retainEveryNTurns` / `retainOverlapTurns`)
was hardcoded at scaffold to `1` / `2` — retain every single turn with a 3-turn
overlapping window. That guaranteed a 1–2 turn fact-sharing session survived a
restart, and was correct while retain/consolidation ran on a cheap remote
model. Once the fleet moved retain/consolidation to a **local reasoning model**
(Ollama `gpt-oss-20b`), the every-turn cadence with large overlapping payloads
made the model run away — single retains observed generating 22k–37k output
tokens over 100–200s, starving workers.

### Make retain cadence configurable + change defaults to 3 / 1

Adds two optional per-agent+defaults knobs under `memory.retain`:

- `every_n_turns` (int, min 1, **default 3**) → plugin `retainEveryNTurns`
- `overlap_turns` (int, min 0, **default 1**) → plugin `retainOverlapTurns`

The resolved cascade value (defaults → profile → agent, per-field merge like
`memory.recall`) is stamped into each agent's plugin `settings.json` on **every**
scaffold/reconcile, so the yaml value is authoritative and **survives
`switchroom apply`** regenerating that file — a hand-edit to `settings.json`
was previously reverted on the next reconcile.

The default change `1`/`2` → `3`/`1` yields ~3× fewer, smaller retains.
**Tradeoff:** at `every_n_turns: 3`, up to ~3 turns of transcript can be lost on
a hard crash before the next retain fires, instead of ≤2 at the old every-turn
cadence. Operators who need the tight crash-durability guarantee set
`memory.retain.every_n_turns: 1` (per-agent or fleet-wide under `defaults`);
chatty banks can raise it further.

Schema: `AgentMemorySchema.retain` (`src/config/schema.ts`), deep-merged in
`src/config/merge.ts` alongside `recall`. Scaffold wiring:
`resolveHindsightRetainConfig` + `renderHindsightSettingsOverrides` in
`src/agents/scaffold.ts`. Docs: `docs/configuration.md` ("Tuning auto-retain
cadence").

## v0.18.2 — Fix progress-card freeze during foreground sub-agent delegation

The Telegram progress card could freeze mid-turn (observed stuck at 41s and
3m12s) while a foreground sub-agent was still working underneath. Fixes on top
of v0.18.1.

### Keep the post-answer liveness card climbing during sub-agent delegation (#2947)

`evaluatePostAnswerLiveness` (`turn-liveness-floor.ts`) had a single signal —
elapsed time since the last watcher tick vs. a hardcoded 30s staleness cap —
with no way to distinguish "sub-agent finished" from "sub-agent silently
mid-step." Once a long silent step exceeded 30s the verdict flipped to
`'stale'` and the card stopped updating, exactly the reported freeze.

Adds a `stillDispatched` input, sourced at the call site from the pre-existing
`turn.foregroundSubAgents.size > 0` lifecycle map, that bypasses the cap only
while a foreground sub-agent is genuinely still tracked; the cap re-engages
normally the moment the sub-agent completes. Background workers
(`worker-activity-feed.ts`) were unaffected — they run their own independent,
clock-driven heartbeat and were never subject to this cap.

New regression coverage renders the actual card text at the reported 41s/3m12s
marks (not just the internal verdict), and `claude-code-event-contract.test.ts`
was hardened into a version-drift canary so a future Claude Code CLI change to
the session-transcript JSONL shape fails CI loudly instead of silently
degrading.

## v0.18.1 — Fix inbound-delivery wedge (intercepted messages) + vault test-isolation leak

Two fixes on top of v0.18.0. The gateway fix is fleet-wide: the wedge it closes
could silently stop an agent from receiving *any* Telegram inbound for minutes.

### Defer the delivery-machine inbound emit past the intercept gauntlet (#2945)

`handleInbound` drove the delivery state machine's `inbound` event **eagerly at
handler entry**, before the intercept/early-return paths (permission-reply,
`/auth` paste-back, interrupt empty-body, secret-detect drop, drop/pair). Since
the machine is now authoritative for the turn-in-flight gate
(`turnInFlightForGate → isMachineInTurn`), an intercepted message — e.g. an
operator approval reply — drove the machine `idle → bridge_alive_in_turn` and
then early-returned as an intercept: no delivery, no `claudeBusyKeys` mark, and
critically no `turnEnd`. The machine held the gate closed until the 5-minute
`TURN_TTL_MS` tick force-cleared it, buffering **every** subsequent inbound
(including `/usage`) the whole time — the exact `machine_over_holds` divergence
`gate-parity-probe.ts` was built to flag (observed live on `overlord`,
2026-07-08).

The `inbound` emit now fires at the delivery-commit point (after every
intercept, before the deliver-or-buffer decision) and carries the real
`isSteering` classification. The machine can no longer be advanced into a turn
by a message that never becomes one, keeping it in lockstep with the imperative
delivery lifecycle it models. Kill switch (`SWITCHROOM_DELIVERY_MACHINE_CUTOVER=0`)
still reverts to the legacy `claudeBusyKeys` read. New source-pin
`inbound-emit-after-intercepts.test.ts` fails on the pre-fix layout.

### Vault token/grant paths respect `SWITCHROOM_AGENTS_DIR` (#2944)

`vaultTokenFilePath()` and the mint/revoke-grant paths ignored
`SWITCHROOM_AGENTS_DIR`, so a test that forgot `_testGrantsDb` silently wrote to
the real production grants DB — the vector that leaked 64 fake `uat-agent` grant
rows into `vault-grants.db` over months. The token-file path now honors the
override. (Follow-up tracked: `openGrantsDb()` still lacks a
`safeGrantsDbPath()` guard analogous to the vault/audit-log guards.)

## v0.18.0 — Model-routing hardening: boot self-heal, full OpenRouter sr-* coverage, subscription-compliance docs

Hardens the LiteLLM routing layer so a boot-time proxy outage can no longer
strand an agent on direct-untracked OAuth for its whole life, opens up the
`/model` command to every registered OpenRouter model without bloating the menu,
and documents the routing architecture and its subscription-compliance
invariants end to end. LiteLLM stays an *optional* metering gateway layered over
subscription-native Claude OAuth — the fail-open model is the load-bearing
property, and this release makes it precise about *when* to fail open.

### Model-routing & subscription-compliance docs (#2939)

Adds `docs/model-routing.md` documenting the routing architecture: LiteLLM as an
OPTIONAL metering gateway layered over subscription-native Claude OAuth, the
fail-open model (agents boot-probe litellm liveliness and, on missing-key or
unreachable proxy, strip routing → direct OAuth only), and the
subscription-compliance invariants that keep Claude traffic on the OAuth path
rather than a metered API path. Establishes the ground truth the following two
fixes are written against.

### Boot self-heal — keep routing in place when the proxy is unreachable (#2940)

Splits the boot fail-open into two distinct modes across BOTH the outer
gateway-hoist and inner claude-process blocks of `start.sh.hbs`, instead of
collapsing every probe failure into "strip routing":

- **MISSING virtual key** → strip routing and fall back to direct OAuth (the key
  will never appear on its own; nothing to wait for).
- **Proxy UNREACHABLE** → keep the routing env in place with a loud, non-fatal
  warning, so the agent self-heals the moment litellm recovers instead of being
  pinned to direct-untracked OAuth for the rest of its life.

Also routes `ANTHROPIC_BASE_URL` by model class in `compose.ts` (`isClaudeModel`
→ `/anthropic` passthrough, everything else → litellm root) and adds a
post-resolution `sr-*` passthrough→router repoint gate so non-Claude default
models route correctly. Regression tests execute the extracted bash dispatch and
assert the routing env survives an unreachable proxy vs. is stripped on a
missing key.

### Full OpenRouter sr-* coverage via `/model` passthrough (#2941)

The `/model` menu keyboard stays curated to the main models, but typing
`/model sr-<any-registered-openrouter-id>` now passes through and switches — a
shape-gate only, no whitelist. Adds 8 display labels (GPT-OSS 20B/120B, GPT-5.5,
GPT-5 Codex, GPT-5.2 Codex, Gemini 3.1 Flash Lite, MiniMax M3, DeepSeek V4 Flash)
and bumps the `sr-glm-5` label to GLM-5.2. `SR_MODEL_ALIASES` (the 6-entry menu
source) is intentionally left unchanged so the keyboard isn't bloated — the new
models are typeable, not menued.

## v0.17.11 — Telegram rich-message rendering (default-on) + Hindsight recall precision + gateway FIFO/reaper hardening

Ships the Telegram-native rich-formatting engine end to end and flips it
default-ON fleet-wide (with a per-agent killswitch) after a live-wire
verification pass confirmed every construct except `__underline__` renders as
its intended Bot API 10.1 entity. Also ships Hindsight recall-precision Phase
1, per-operation LLM model config, an OpenRouter-by-default routing change for
Hindsight LLM ops, and two gateway correctness fixes (rapid-fire DM ordering,
stale activity-card reaping).

### Telegram-native rich-message rendering — default-on with a killswitch (#2928, #2929, #2930, #2932, #2934, #2936, #2937)

Delivers the full pipeline behind `SWITCHROOM_RICH_RENDER`: a markdown parser
and typed IR (#2928), an IR → Bot API 10.1 markdown renderer covering
bold/italic/strike/code/links/spoiler/highlight/expandable blockquotes/tables/
lists (#2930, #2932), and a nested-list tight-spacing fix that preserves
mdast's tight/loose distinction instead of hardcoding newline behavior
(#2936). A live-wire probe against the real Bot API — inspecting Telegram's
own returned message entities, not a visual guess — confirmed spoiler and
highlight both render correctly (reversing earlier UAT-harness evidence that
had flagged spoiler as broken; that was a harness decode limitation, not a
wire failure) and surfaced the one real exclusion: `__underline__` has no
Telegram markdown equivalent and degrades cleanly to bold. Docs and the
governing RFC were reconciled to this ground truth (#2929, #2937). The flag
is now default `"1"` in `defaults.env`; an agent can still opt out with
`env: { SWITCHROOM_RICH_RENDER: "0" }`, which wins per the standard
agent-overrides-defaults config merge.

### Hindsight recall precision + LLM routing (#2924, #2925, #2931, #2933, #2935)

- **Phase-1 recall precision (#2931, #2933):** score-sort ordering and a
  `prefer_observations` bias in `client.recall()`.
- **LLM routing (#2924, #2925, #2935):** a durable top-level `hindsight.llm`
  config knob (provider + model), OpenRouter-via-LiteLLM as the new default
  for Hindsight's retain/reflect/consolidation ops instead of always pinning
  Claude, and per-operation overrides (`hindsight.llm.{retain,reflect,consolidation}`)
  that inherit from the global knob when unset.

### Gateway hardening (#2917/#2919, #2918/#2921, #1116/#2893/#2920)

- **Rapid-fire DM ordering:** fixed a FIFO-ordering bug where the inbound→bridge
  delivery gate read a stale `turnInFlight` snapshot instead of a live value,
  causing out-of-order emission under rapid-fire DMs.
- **Stale activity-card reaper:** added a periodic mid-session reaper for
  orphaned turns (owning SDK subprocess died mid-session) — previously only
  reaped at boot, leaving a frozen "working…" card until the next restart.
- **Worktree-worker identity:** harden identity resolution to fall back to
  config, not just env, fixing lost live-progress feeds for worktree-isolated
  sub-agents when `SWITCHROOM_AGENT_NAME` was unset or the registry read
  failed.

### Also in this release

- `/model <sr-*>` non-Claude model switches now do a session-only relaunch
  instead of failing in the native picker (#2927).
- `/usage` card split into per-window reset columns (5h/7d each get their own
  reset-time column) (#2889).
- Doc-only: corrected the Hindsight auto-retain cadence description
  (every-turn chunked, not every ~10 turns) (#2898).

## v0.17.10 — Hindsight reliability: close the FK-race memory-loss window + review-finding hardening

Ships the fix for a silent memory-loss race in Hindsight plus the hardening
findings from a full review of the memory implementation. The headline is the
cross-task foreign-key race that could drop a whole retain batch on the
document re-ingest path; the rest tightens security, runtime correctness, docs,
and the propose-card / directive flow.

### Hindsight FK-race fix — no more silent memory loss on re-ingest (#2899)

The retain pipeline resolved entities (Phase 1) and inserted the
`unit_entities` child rows (Phase 2) in separate transactions. In the window
between them, graph-maintenance `prune_orphan_entities` could delete an entity
that Phase 1 had already resolved but Phase 2 had not yet referenced — it
momentarily looks like an orphan — so the Phase-2 insert violated
`fk_unit_entities_entity_id_entities`, was classified non-retryable, and the
entire `batch_retain` was dropped (silent memory loss, worst on the document
re-ingest / re-consolidation path). Fixed with a same-transaction
`reassert_entities()` (`INSERT ... ON CONFLICT DO NOTHING`) on the Phase-2
connection immediately before the child insert: an entity referenced by a live
unit is by definition not an orphan, so resurrecting it is correct and closes
the window regardless of pruner timing. Carried as a self-verifying build-patch
in `docker/Dockerfile.hindsight` with fail-loud `assert n == 1` anchors and a
hermetic guard test.

### Review-finding hardening (#2905, #2907, #2908, #2909)

- **P1 security (#2905):** loopback-only compose ports, gate mental-model
  writes behind confirm, confirm-before-legibility.
- **P3 runtime (#2907):** correct the healthcheck claim, fix host-network port
  reuse, restore consolidation-backlog visibility (opt-in fleet backlog row),
  dedupe the port constant.
- **P2 docs (#2908):** sync the synthesis-layers RFC + operator runbook to the
  shipped state and fix stale comments.
- **P4 flow (#2909):** harden the propose-card lifecycle, dedup directives, and
  decouple the vendor envelope grammar.

### Test env-coupling fixes (#2913)

Decoupled two tests from the hardened-container environment so CI is
deterministic: the recall-exit-codes tests no longer assume `/tmp` is
exec-mounted, and the scaffold tilde-path test now controls
`SWITCHROOM_HOST_HOME` (which outranks `HOME`). Test-only; no product change.

## v0.17.9 — Agents curate their own memory: mental-model-curator skill + permanent Hindsight port-collision fix

Ships the user-facing counterpart to v0.17.8's Phase 5 mental-model machinery —
a default-on skill that lets an agent survey its own memory and *propose*
curated mental models — and permanently closes the Hindsight host-port
collision that could take fleet memory down silently.

### mental-model-curator bundled skill — default-on (#2883)

Adds a new **default-on** bundled skill, `mental-model-curator`, that has an
agent use its most capable model to review its **own** Hindsight memory bank and
**propose** well-formed mental models ("knowledge models") to the operator
through the approve/deny proposal card — never blindly self-creating them.
Because each mental model carries real recall/reflect (and optional
post-consolidation) cost, every candidate is routed through
`mcp__switchroom-telegram__mental_model_propose` so a human ratifies it; agents
cannot self-approve, by design. The `SKILL.md` teaches a disciplined workflow:
check `get_bank_stats` and **stop on an empty/thin bank** (it synthesizes to
confident noise), read existing models and **semantically dedupe** (the propose
flow only hard-rejects exact-name dupes), survey recurring themes via
`reflect`/`recall` and cluster them into standing questions the bank actually
backs, and frame each `source_query` as a **domain** question — never identity /
"who is the user" (identity lives in profile banks; an identity model is
explicitly forbidden after it caused a wrong-fact contradiction bug).
`refresh_after_consolidation` defaults **off** and models stay tight. This turns
the v0.17.8 Phase 5 propose/approve plumbing into an ability agents actually
reach for.

### Permanent Hindsight port-collision fix + fresh-install/upgrade hardening (#2885)

`switchroom-hindsight` runs `--network host` and binds `HINDSIGHT_API_PORT`
directly on the host, so the launcher could hand an **already-occupied** host
port to `docker run` and then silently crash-loop — fleet memory goes down
invisibly because a failing auto-recall surfaces no user-facing error. In the
field this crash-looped ~72× (`[Errno 98] address already in use: 8888`) with
memory silently down for ~9h, because the old **default port 8888** collided
with a host `nginx-tunnel-gateway` publishing `127.0.0.1:8888:80`, and because
the `--recreate` path reused the previously-published port via
`getRunningHindsightPorts()` without any free-check. Fixes:
**default API port 8888 → 18888** (`HINDSIGHT_DEFAULT_API_PORT`; UI stays 9999),
`pickHindsightPorts()` no longer prefers the contended 8888, the recreate path
now runs the free-check instead of blindly rebinding the old port, plus a **loud
preflight** and a **memory-down health check** so a bind failure is visible
instead of silent — all covered by new regression tests. Internal reliability;
no config change required on upgrade.

## v0.17.8 — Hindsight synthesis layers complete: specialized banks + curated mental models

Closes out the Hindsight synthesis-layers RFC
(`reference/rfcs/hindsight-synthesis-layers.md`) — Phases 2 through 5 — so
memory banks are *specialized*, corrections *stick*, and per-specialist mental
models can be curated without ever crossing the no-silent-self-write line.

### PR A — Close out bank specialization (hindsight Phase 2 / #2871)

Phase 2's core mission/disposition threading (`reflect_mission`,
`observations_mission`, per-bank `disposition`) already landed via #2855
(shipped in v0.17.7). This resolves the phase's one remaining open item — the
dormant #2816 recall tag-filter port — by **documenting it as intentionally
dormant** rather than wiring a speculative per-bank tag taxonomy the RFC
doesn't specify. `scaffold.ts` gains a decision comment + `TODO(#2816)`
spelling out exactly how to wire it later (the `HINDSIGHT_RECALL_TAGS` env
escape hatch stays available to advanced operators), and a new regression test
locks the scaffold to the vendor no-op defaults so no agent's recall is
silently tag-scoped. RFC Phase 2 marked SHIPPED; no runtime behavior change.

### PR B — Deterministic correction capture that sticks (hindsight Phase 3 / #2873)

Extends the Stage-B directive-capture *nudge* (#2864) with a **Stage-C
Stop-hook post-turn verifier** (`vendor/hindsight-memory/scripts/directive_verify.py`).
Stage B was purely advisory — when the model silently ignored the nudge a
durable correction was lost the same way it was pre-Stage-B (Stage A measured a
~55% miss rate). The verifier isolates the human turn, tests it against a
**narrow, high-precision** durable-rule regex (a strict subset of Stage B's
detector, AND-gated on `looks_like_standing_rule`), and — if a durable rule was
stated but **no** `create_directive` fired — blocks the stop **once** to
re-prompt capture. Invariant-clean, identical to Stage B: pure-regex detection
(no model callsite), no silent hook-side write (the model still authors the
directive verbatim, visible in chat), at-most-once per turn with an explicit
one-off escape. Reuses the `memory.directive_capture_nudge` knob (disabling the
nudge disables the verifier). **Also fixes a retain double-fire**: the block
re-fires the Stop event, so `retain.py` now early-returns under
`stop_hook_active=true` to avoid POSTing a duplicate transcript document and
double-incrementing the retain cadence counter.

### PR C — Consolidation-driven remembered/updated surface (hindsight Phase 4 / #2872)

Adds the poll-free **UPDATE** side of the Phase 4 chat-legible memory surface,
the background counterpart to the foreground store/forget path shipped in
#2858 (v0.17.7). When the consolidation engine distils a new durable
observation (or supersedes a stale one) it emits a `consolidation.completed`
webhook and the gateway surfaces ONE terse line
(`🧠 updated what I know about "…"` / `🧠 revised …`). New pure
`consolidation-legibility.ts` module (materiality filter + per-agent rate
limiter: 10-min interval, 1-h identical-line dedup); `recordWebhookEvent`
routes the verified event to a **send-free** sink, still audited to
`webhook-events.jsonl`, **never** injected as a model turn. No model call, no
polling, no `claude -p`. **Plumbed but dormant** — gated OFF by default
(`SWITCHROOM_CONSOLIDATION_LEGIBILITY`, opt-in), and the pinned hindsight
image (v0.8.4) does **not** yet emit `consolidation.completed`, so the consumer
stays inert until that upstream event ships. The payload parser tolerates
several plausible field aliases; whoever lands the hindsight-side emitter
should pin the exact schema.

### PR D — Operator-declared per-agent mental models (hindsight Phase 5 / #2874)

Lands the **operator-curated declarative** half of Phase 5, plus the design
note (`reference/rfcs/hindsight-phase5-mental-model-curation.md`). Adds
`memory.mental_models[]` (`{ name, source_query, refresh_after_consolidation?,
max_tokens? }`), accepted at the **per-agent tier only**, consumed by a
generalized `ensureMentalModel` / `ensureDeclaredMentalModels` on scaffold +
reconcile. Avoids every harm that #2447 removed by construction: **no blind
seeding** (zero declarations = byte-for-byte post-#2447 behavior, no default
model), **no identity collision** (profile banks still own "who the user is";
these answer *domain* questions), **no self-escalation** (declarations are
operator-edited in `switchroom.yaml`), and **no fleet-wide over-seeding** (never
accepted at `defaults`/profile tier). Refresh is opt-in, off by default.

### PR E — Agent-proposes / human-approves mental models (hindsight Phase 5 / #2875)

Adds the **second half** of the Phase 5 shape on top of PR D: the agent
**proposes** a mental model, the human **approves in chat**, and on approval it
becomes a first-class declared model in `agents.<self>.memory.mental_models[]`
— consumed by the exact `ensureDeclaredMentalModels` path from PR D. New
`mental_model_propose` gateway MCP tool mirrors the `vault_request_access`
shape: renders a `[✅ Approve] [🚫 Deny]` card, ends the turn, resumes via a
synthetic inbound. On approve, the gateway builds a unified diff **appending**
the model and submits it through hostd's `config_propose_edit` apply+reconcile
machinery (hostd stays the sole config writer); the #1977 single-tap
correlation avoids a second card since the operator already approved on the
proposal card. Guardrails: propose-only/self-approve impossible (operator-only
tap + hostd gate), duplicate-name rejected before any card, per-agent ≤5
cards/hour, a narrow self-scope gate letting a non-admin agent append **only**
to its own `memory.mental_models[]`. Nothing is created before the human taps;
live-session-only (no 3am cards into an empty topic).

## v0.17.7 — Approvals survive restarts + specialized, chat-legible memory

### PR A — Re-arm approval cards across restarts + bridge request ledger (#2861/#2867)

Pending tool-permission approvals lived only in the gateway's in-memory
`pendingPermissions` map and died two ways, both closed here. A gateway
restart used to strip the persisted card ("Gateway restarted…") while the
claude session stayed suspended inside the MCP permission call — no verdict
was ever dispatched and the turn wedged (marko's gateway booted ~14× on
fleet-roll day, killing every pending card each time). And the bridge dropped
permission requests whenever the gateway IPC was down, so no card ever posted
and claude hung indefinitely. The existing `permission-card-store.ts`
persistence is now used to **re-arm** the question after a restart (restoring
`pendingPermissions` with the original `startedAt` and re-attaching the
keyboard on the existing message — never a fresh card), and the bridge keeps
an outstanding-request ledger keyed by `request_id`, buffering disconnected
requests and re-sending them on every reconnect. Re-arm restores only the
question, never a verdict (no-self-escalation); kill switch
`SWITCHROOM_PERMISSION_REARM=0`.

### PR B — Re-offer missed approvals when the operator returns after TTL (#2862/#2866)

When an approval card TTL-expires with the operator away, the gateway
auto-denies (timeout-is-not-denial) — but nothing re-offered the approval when
the operator came back, so cron-fired gated work was silently dropped (marko's
brevo nurture-drip batches died this way two days running). At TTL auto-deny
the miss is now appended to a persisted digest in `STATE_DIR`
(`missed-approvals-store.ts`); on the first operator-activity event after ≥1
miss accumulates, the gateway posts **one** compact digest card per origin
surface. **Retry** synthesizes an inbound asking the agent to re-attempt the
action (the same synthesized-inbound path cron uses — it re-raises a fresh
approval card, never a synthesized verdict); **Dismiss** clears the record.
Kill switch `SWITCHROOM_MISSED_APPROVAL_REOFFER=0`.

### PR C — Persist scoped grants across restarts (#2863/#2865)

The gateway's 30-min scoped-approval windows (`scopedGrants`) were in-memory
only, so any bounce — fleet roll, config apply, failover probe — wiped every
window and an action the operator had allowed minutes ago re-carded
immediately, reading as "my approval didn't stick." They now persist to a tiny
`STATE_DIR/scoped-grants.json` (same pattern as the card store). Entries carry
the absolute wall-clock `expiresAt` captured at the original tap, so a restart
can never *extend* a window (grant at T, reload at T+29min → ~1 min left); the
reloaded grant runs the identical fail-closed gate. Kill switch
`SWITCHROOM_SCOPED_GRANT_PERSIST=0`.

### PR D — Route cron boot-replays through the durable inbound spool (#2793 part B / #2860)

Cron boot-replay was ledgered at socket-accept in the scheduler, not at
consumption, opening two windows: a replay accepted but never consumed (bridge
not up yet) was recorded delivered and dropped (silent-loss), and the
accept-time ledger couldn't distinguish "consumed" from "accepted" so a
re-replay across a restart could re-run it (double-fire). A boot-replay now
carries `meta.replay_fire_ms` and routes through the durable inbound spool —
`put` on accept, `ack` only on confirmed delivery — with a stable `spoolId`
keyed on `(chatId, schedule_index, replay_fire_ms)`. Re-replays dedup to one
entry (closes double-fire) and un-acked entries re-deliver on the next boot
(closes silent-loss): at-least-once with dedup. (Part A, at-most-once resume,
shipped earlier in #2808.)

### PR E — Sparse, chat-legible memory surface (hindsight Phase 4 / #2858)

Surfaces ONE terse line in the originating chat/topic when the interactive
session *materially* changes what it remembers: `📌 remembered: "<directive>"`
on `create_directive`, `✂️ forgot: …` on an invalidate / demote-from-recall.
Deterministic tool-call observation — no model call, no polling, no `claude
-p`. It's sparse and material-only: **no line on ordinary recall, no line on
routine consolidation**, avoiding the "regurgitating old facts unprompted"
anti-pattern. New reusable `memory-legibility.ts` module (whose
`detectMemoryLegibilityEvent` primitive PR F imports rather than re-deriving);
kill switch `SWITCHROOM_MEMORY_LEGIBILITY=0` (default ON). Serves
`remember-across-sessions`.

### PR F — Deterministic directive-capture nudge (#2848 Stage B / #2864)

Stage A measured a **~55% miss rate** on durable corrections — capture was a
per-agent lottery (clerk held 0 directives across 449 messages). The vendored
recall hook (UserPromptSubmit) now regex-detects correction / standing-rule-
shaped inbound and appends a terse advisory to the turn's `additionalContext`
telling the model to persist the rule with `create_directive` **if** it's
durable — the model still does the judgment in-session and calls the tool
itself (no silent hook-side write, no new model callsite). A negative guard
scrubs pleasantry shapes ("always happy to help") before matching. Config knob
`memory.directive_capture_nudge` (default ON). Serves
`remember-across-sessions`.

### PR G — Thread reflect/observations mission + disposition through the cascade (#2855)

Phase 2 of the hindsight synthesis-layers RFC — banks should be *specialized*,
not merely isolated. Wires the remaining bank-steering levers through the
config cascade: `reflect_mission` and `observations_mission` (string,
override) and `disposition {skepticism, literalism, empathy}` (1–5 each,
per-key merge). Verified against the live engine: `disposition` is three flat
1–5 integer fields (modeled as one nested object in YAML, flattened at the API
boundary), and switchroom's existing `bank_mission` **is** the engine's
`reflect_mission` (kept as a documented alias). Built-in profiles ship
differentiated defaults (`health-coach` empathy-high 2/2/5,
`executive-assistant` 4/4/3, `coding` 4/5/2) so a fresh setup needs zero
config. Operator-config-driven only — no agent self-modification of its own
bank missions.

### PR H — Pin the refresh-hindsight recreate to the release target (#2851/#2856)

`switchroom update`'s `refresh-hindsight` step recreated the hindsight
singleton via `memory setup --recreate` with no `--tag`, so it always pulled
floating `:latest` even on a version-pinned fleet — the hole that left the
v0.17.5 roll's `switchroom-hindsight` on `:latest`. The target is now resolved
lazily (`--pin`, else the persisted `release.pin`) and threaded as `--tag
<version>`. Only a concrete `vX.Y.Z` is pinnable; a `sha-` pin, a floating
`--channel`, or no pin still floats to `:latest` (the standalone default,
unchanged).

### PR I — `switchroom apply --dry-run` (#2829)

Adds a real `--dry-run` to `switchroom apply`: it runs the full
compose-regeneration + validation pipeline **in memory** and reports what a
real apply would do — profile resolution per agent, vault provisioning gaps
(broker reachability, new-key provisioning), and would-be compose changes
(image-tag deltas) — **without** writing the compose file, persisting
anything, or touching a container. Exits non-zero when a real apply would
fail. Closes the gap behind the v0.17.0 rollout incident, where
`rollout --dry-run` only printed the step plan and never exercised the
config-regeneration that actually failed (`apply --dry-run` errored with
`unknown option`).

### PR J — Docs: fix ProductOS link + conform reference/ to current templates (#2868)

Fixes the 404ing `../../ProductOS/` relative link in `reference/README.md`,
and brings `reference/` into conformance with the current ProductOS templates
after the front-door revamp: adds the missing `## Related` section to the 9 job
specs that lacked it (all 23 now carry the full terse subset) and fixes two
RFCs using path-style `serves:` values to the bare-slug scheme.

## v0.17.6 — Durable fleet failover: persisted active, proactive roll, unpinned consumers

### PR A — Honest ↻ Refresh on /auth and /usage cards (#2843)

The cards' ↻ Refresh button served up-to-45s-cached quota while stamping
"Live · refreshed 0s ago". It now passes `forceLive` (an explicit tap is
the user asking for live-now data, still throttled to one per 5s per
message), stamps "⚠ cached Nm ago" whenever any account was served from
cache, and keeps demo-mode email masking across refresh (switch-button
labels are masked too). The served/capturedAt zip logic is extracted as
`zipProbeResults` with unit tests so the footer logic can't drift.

### PR B — Durable fleet failover (#2845)

Root cause of the 2026-07-05 walled-fleet incident: account swaps lived
only in broker memory, so every broker/agent recreate reloaded the stale
yaml `auth.active` and re-poisoned the fleet with a quota-walled account;
an idle fleet never proactively recovered at all.

- **Persisted active override** (`state/auth-broker/active-override.json`)
  — written on every `set-active` and every corroborated roll; applied at
  boot + SIGHUP. A hand-edited yaml `auth.active` wins and drops the
  override (operator intent is never overridden by stale automation).
- **Auto-promote on roll** — `mark-exhausted` with a successful roll
  promotes the target to nominal `auth.active` (persisted). Gated on a
  fresh (≤5h) live snapshot proving the wall, so a bogus mark keeps the
  old self-reverting window semantics. Note: after a corroborated wall
  the fleet *stays* on the promoted account when the old one refills —
  no auto-revert to the previous primary.
- **Proactive fleet failover** — the broker's periodic per-account probe
  now rolls the fleet the moment the ACTIVE account's fresh probe shows
  exhaustion (boot + interval; kill switch
  `SWITCHROOM_DISABLE_FLEET_QUOTA_PROBE=1`). No failed agent turn needed.

### PR C — Optional consumer pin: unpinned consumers follow the fleet active (#2852)

`auth.consumers[].account` is now optional. An unpinned consumer (the new
`switchroom setup` default for hindsight) rides `auth.active` exactly like
an agent: same swaps, same failover, mark-exhausted attributes to the
active. Pinned consumers keep the existing quota-isolation semantics.
Config note: a pin-less consumer entry requires this broker version —
unpin yaml only after the fleet is on v0.17.6. Also folds in #2845 review
hardening: proactive marks write durable audit records, and the durable-
promote corroboration ceiling tightens from 24h to one 5h refill period.

## v0.17.5 — Fix approval card race + start.sh claude command warning

### PR A — Hold inbound delivery gate while approval card is outstanding (#2840)

After the first interim reply, `releaseTurnBufferGate` cleared `claudeBusyKeys`
even when claude was still blocked on an outstanding approval card. A new
inbound arriving in that window saw `turnInFlightAtReceipt=false`, delivered
directly, and displaced the approval context — orphaning the pending MCP call
(observed: Brevo post approval tapped, but email send never executed).

`turnInFlightForGate()` now returns `true` while `pendingPermissions` is
non-empty, keeping the gate closed from card-post through the operator tap or
10-minute auto-deny TTL.

### PR B — Structural regression tests + prune loop guard (#2841)

- Structural pins in `permission-no-repeat-wiring.test.ts` asserting both code
  paths of `turnInFlightForGate()` include `pendingPermissions.size > 0`. Future
  refactors that drop the guard will fail CI.
- `start.sh` prune loop skips the canonical `$HOME/.local/bin/claude` symlink
  (via `readlink` guard) to avoid spurious "pruning shadow" log on subsequent
  boots.

### PR C — Fix stale comment in start.sh re-seat block (#2842)

Corrects a one-sentence comment that said the prune loop "removes" the symlink
on the next boot — after the #2841 guard it now skips (preserves) it.

Also re-seats `$HOME/.local/bin/claude → /usr/local/bin/claude` at boot,
silencing the claude v2.1.x+ "claude command missing or broken" startup warning.

## v0.17.4 — Fix "Always allow" not sticking

`config_propose_edit` in hostd now passes `--only <agent>` to `switchroom apply`,
scoping reconcile to just the requesting agent (~8s) instead of the full fleet
(2+ min). The full-fleet apply was exceeding the gateway's 60s dispatch timeout,
causing "Always allow" taps to silently fail — the permission was granted for the
session but never written to disk.

## v0.17.3 — LiteLLM Anthropic pass-through

### Claude routes via the /anthropic pass-through, not the model-mapped path (#2835)

Routing Claude (opus) through LiteLLM's model-mapped `/v1/messages` route
re-chunks the upstream SSE stream, which stalled long responses mid-flight
("API Error: Response stalled mid-stream" after minutes — the 2026-07-05
marko incident). Claude now points at LiteLLM's **Anthropic pass-through**
(`<root>/anthropic/v1/messages`), which raw-forwards and streams native SSE
bytes — same shape as direct OAuth, no re-chunk.

- `compose.ts` emits `ANTHROPIC_BASE_URL=<root>/anthropic` for the claude
  CLI, plus a new `SWITCHROOM_LITELLM_BASE=<root>` for the two consumers
  that need the root proxy surface, not the pass-through: start.sh's
  `/health/liveliness` boot probe and the gateway's `/model/info`
  non-Claude (`sr-*`) model discovery.
- `start.sh` (outer + inner) + `cron-session.sh` health probes and the
  gateway's `discoverSrModels` now target the root; hindsight's
  claude_agent_sdk subprocess also routes via the pass-through.
- OAuth still rides in `Authorization` (forwarded upstream unchanged); the
  virtual key rides in `x-litellm-api-key` — the split that keeps this
  subscription-native. Non-Claude models stay on the model-mapped root path
  via the virtual key.
- Pairs with a LiteLLM proxy bump to v1.91.0 ("disable proxy buffering on
  streaming SSE responses") on the operator's deployment.

## v0.17.2 — hostd self-service rolls

### PR A — hostd self-bump on stale-CLI rollout (#2833)

- **hostd self-bumps on a stale-CLI rollout instead of refusing** (#2645):
  hostd's CLI is baked into its image, so it is older than EVERY freshly
  tagged release — which made every agent-invoked `rollout` to a new version
  fail `preflight-stale-cli`, with a host-shell-only remedy (`switchroom
  hostd install --tag …`). The root agent could never roll a release by
  itself; agents worked around it by hand-editing hostd's compose file. Now,
  when the pin is newer than hostd's own CLI, hostd: verifies the target
  image is pullable (`docker manifest inspect` — refuses cleanly when the
  docker-images workflow hasn't finished), tag-bumps its own compose in
  place (backup kept), writes a resume marker, and hands its own recreate to
  a detached sibling helper container (`docker run -d --rm`, docker.sock +
  hostd dir only — a sibling survives the recreate that would SIGKILL any
  in-container driver, brick scenario #1/#2458). The NEW hostd finds the
  marker at boot and relaunches the roll under the SAME request_id, so the
  audit hash-chain, in-chat narration and `get_status` all continue
  seamlessly. Marker is single-shot (deleted before validation), staleness-
  capped at 15 min, and shape-validated; a failed helper is caught by a
  `docker wait` watcher that rolls the compose bump back and writes a loud
  terminal row. New `self-bump` / `self-bump-done` narration phases. The
  rollout terminal warnings now name exactly what stays on the prior version
  (web dashboard, host operator CLI) with the host-side finish commands
  (#2645 item 3).

### PR B — keep broker operator socket across hostd rollouts (#2832)

- **hostd-driven rollouts no longer drop the vault-broker operator socket**:
  `resolveOperatorUid()` read only `SUDO_UID` → `getuid()`; when `apply` is
  shelled out by hostd it runs as root without sudo, so it returned
  `undefined` and `generateCompose` omitted the operator-socket bind — which
  broke host-shell `switchroom vault …` and made the litellm key-confirm
  probe fail, silently stripping litellm routing fleet-wide (observed on the
  v0.17.1 roll). `SWITCHROOM_HOSTD_OPERATOR_UID` (already injected into
  hostd, same host-fact pattern as `SWITCHROOM_HOST_HOME`/`_TZ`) is now the
  final fallback; sudo/`getuid()` still win when present.

## v0.16.50 — Fleet-wide webkite render config

### Web extraction

- **Baked-in webkite render config so JS-heavy sites render** (#2805): the
  fleet ships cloakbrowser (stealth Chromium) baked into the agent image, but
  carried no webkite render config, so webkite's auto-heuristic classified
  JS-gated SPA/booking pages (e.g. `palacecinemas.com.au` session times) as
  `thin_article` with `has_renderers: false` and returned only the static
  shell. A default `config.toml` is now baked to `/opt/switchroom/webkite/`
  in `Dockerfile.agent` and re-synced to `~/.config/webkite/config.toml` at
  boot by `start.sh` whenever the two differ (NOT copy-if-absent: `$HOME` is a
  host-persistent bind mount, so a write-once seed would let a stale home copy
  shadow every future image update; refresh-from-image keeps the fleet
  current). An operator-authored `~/.switchroom/webkite/config.toml` override
  is bind-mounted RO onto the same target and still wins (detected and left
  untouched). It enables render, keeps the baked-in local cloakbrowser as the
  auto-spawned primary backend with Cloudflare/Firecrawl as cloud fallback
  (`profile = "local-first"`), and force-renders known JS-gated domains via
  `[[render.routes]]`. Every
  key was verified against the shipped `webkite` binary's own schema. NOTE: a
  per-route post-render wait/interaction hook is not expressible in webkite
  0.4.0's `RouteConfig` (only `domains`/`providers`/`mode`/`exclusive`); the
  wait-for-selector path remains a per-call `webkite_read` argument.

## v0.16.47 — Admin-key passphrase prompt made unmissable

A single focused Telegram fix on top of v0.16.46.

### Telegram

- **Admin-key passphrase prompt: rich render + notification ping** (#2771):
  when an operator tapped Approve on a vault-grant card for an admin-only key
  (e.g. `npm_token_*`), the follow-up passphrase request was written by
  editing the original card in place with a raw markdown string. That failed
  two ways: the raw string went out `parse_mode=none` so `**bold**`/`_italic_`
  rendered as literal characters (the "locked" branch was worse, concatenating
  a string with a `richMessage()` object → `[object Object]`), and an in-place
  edit fires no notification and stays stapled to the card's old position, so
  a busy topic buried it — the operator missed the prompt entirely (observed
  on v0.16.45) and the grant was never minted. Fix: the original card is now
  edited only to strip its buttons and show a short "waiting" status; the
  passphrase prompt goes out as a NEW rich message through the sanctioned
  `richMessage()`/`sendRichMessage()` path — real bold, a strong "ACTION
  NEEDED: passphrase required" header, short lines, the key in code
  formatting. It lands at the bottom of the chat and fires a notification.
  Applies to all three branches (admin-only, locked vault, batched cards).
  Security semantics unchanged: the passphrase message is still deleted on
  receipt, never logged, and the agent still can never self-mint.

## v0.16.42 — Fleet Health: operator-facing fleet issue tracker + admin page

Ships the first slice of Fleet Health (RFC `reference/rfcs/fleet-health.md`,
serving `reference/jobs/fleet-stays-healthy.md`, outcome `always-available`):
the job-spec-anchored issue tracker's read side. A new admin **Fleet Health**
page renders the health ledger (`~/.switchroom/fleet-health/ledger.json`) —
the 22 job records ranked worst-first by `priority_score` — degrading to a
clearly-marked empty state when no owner agent is assigned. Adds the typed
read-only ledger reader (`src/web/fleet-health-read.ts`) and the top-level
`fleet_health.owner_agent` config field (override cascade; the admin agent
that will run the detection crons). Feature is inert until an owner is
assigned.

## v0.16.46 — Voice pipeline: eager pre-synthesis + deterministic TTS normalization; intent-narration pacing; formatting, handback & model-picker fixes

Voice-out gets faster and cleaner, thinking-visibility gets a reliable
carrier, and a batch of Telegram/web/model fixes land alongside two
CHANGELOG sections that shipped without a version header (folded in below).

### Voice

- **Eager pre-synthesis + attach-on-tap Listen + 7-day rolling cleanup**
  (#2766/#2763): whenever a reply becomes Listen-eligible the gateway kicks
  an async background kokoro synth off the reply critical path, writes the
  audio under `TELEGRAM_STATE_DIR/voice-cache/<token>.ogg`, and tapping 🔊
  Listen attaches the pre-made file instantly instead of waiting on the GPU.
  New `telegram-plugin/voice-presynth.ts` (bounded FIFO `PreSynthQueue`,
  `sweepVoiceCacheDir` with 7-day TTL + 500MB oldest-first budget, atomic
  writer, kill switch `SWITCHROOM_DISABLE_EAGER_VOICE=1`). On-demand entry
  TTL raised 1h → 7 days; local engine only (the openai cloud path never
  eager-synthesizes); missing/expired entries fall back to lazy synth.
- **Deterministic L1 TTS normalization before `/tts`** (#2762/#2760 Phase 1):
  new pure `telegram-plugin/tts-normalize.ts` (markdown strip, spoken URLs,
  emoji, currency, percentages, ordinals, times, ISO dates, phone digit runs,
  units, symbol expansion) applied in the voice-out path right before the
  `/tts` body is built, mirroring `text-voice-scrub.ts` (inline-code
  park/restore, kill switch). Wired at both body-build sites
  (`synthesizeVoiceOut` kokoro+openai, and the on-demand Listen tap). Shipped
  default-on; `SWITCHROOM_DISABLE_TTS_NORMALIZE` wins as the kill switch.

### Pacing / thinking-visibility

- **Intent-narration as the reliable thinking-visibility carrier** (#2761):
  flagship models server-redact interstitial thinking text, so the model's
  own plain-language intent narration is the only compliant "what am I doing"
  carrier during a silent tool burst. Strengthens the pacing prompt
  (`TELEGRAM_GUIDANCE` beat 2 + the per-turn `<turn-pacing>` directive) so a
  one-line plain intent reliably precedes tool bursts, and always give Bash a
  plain-English description as the visible label — without per-tool-call
  message spam or raw tool names. Contract pinned in `scaffold.test.ts` + a
  new `jtbd-narration-intent-dm` UAT scenario.

### Telegram / formatting / model

- **Fleet-wide consistent outbound formatting** (#2755): deterministic
  typography at the gateway, identical on reply / edit_message / stream_reply.
  `addParagraphSpacers` inserts the U+00A0 spacer line at every block
  transition (keeping list/table/quote interiors tight); new
  `normalizePunctuation` (em/en dashes → comma or hyphen, unicode bullets →
  `- `) and `stripExcessBold` (over-bold tripwire). Floor "Formatting for
  Telegram" card + its `reference/telegram-formatting-guide.md` mirror
  rewritten to one concise shared spec.
- **Sub-agent handback survives Claude Code split-line writes** (#2758):
  Claude Code 2.1.199 now splits one logical assistant message across
  multiple JSONL lines sharing a `message.id`, stamping terminal
  `stop_reason: end_turn` on every split line (including the leading
  thinking-only line). `projectSubagentLine` now treats `end_turn` as
  terminal only on a line carrying the answer surface (non-empty text or a
  real non-Agent/Task tool_use), so background/sub-agent work keeps surfacing
  in the thread. Legacy single-line shape degrades identically.
- **Hermes model picker uses family aliases; `model.info` reads config**
  (#2759, part of #2757 gap 3): the picker injected pinned concrete ids
  (incl. the retired `claude-fable-5` that 4xx'd the fleet); switch
  `SWITCHROOM_MODELS` to the CLI-resolved family aliases
  (fable/opus/sonnet/haiku). `model.info` (RPC + `GET /api/model/info`) now
  reports the agent's configured model from `switchroom.yaml` instead of a
  hardcoded `claude-sonnet-5`.
- **sonnet-5 pins, vault reason alias, async always-allow save, idempotent
  scaffold** (#2756): bump every live `claude-sonnet-4-6` default to
  `claude-sonnet-5`; `vault_request_access` accepts `why` as a `reason`
  alias (reason wins when both present); always-allow save acks the tap
  immediately then persists in a 12-min background continuation with the real
  outcome edited back; `writeFileSyncIfChanged` + `dirContentEquals` skip
  byte-identical scaffold rewrites.

### CI / docs / tests

- **Live Telegram UAT made on-demand only** (#2765): `UAT_GATE_ENABLED` repo
  var flipped false (operator decision 2026-07-04) so PRs/merges stop burning
  subscription quota on a live Opus turn; the sentinel treats var-off as pass,
  and `workflow_dispatch` bypasses the var + path filter so a manual
  `gh workflow run ci-uat.yml` always executes.
- **CLAUDE.md refresh** (#2764): rewrite the root CLAUDE.md against the
  current tree (1099 → ~360 lines), every claim re-verified — required-check
  count 10 → 11, corrected npm scripts, current `src/` layout, developer-
  ownership test-failure stance, uat-gate SLA + flake guidance, PR-hygiene
  and root-context uid-0 editing pitfalls.
- **tool-label-pretool root test aligned with #2758 label rewrite** (#2769):
  update the 4 stale vitest expectations to the shipped hook label strings,
  clearing vitest-shard (3) red on main.
- **Drop dead `src/watchdog` test globs from `test:bun`** (#2768, fixes
  #2767): `src/watchdog/` was removed but `test:bun` still listed its two
  test files; removing the dead globs keeps the test surface honest.

### Fleet Health live detection pipeline (model-free sensor, priority ledger, GH-issue lifecycle)

The machinery that populates the ledger the admin page reads (RFC
`reference/rfcs/fleet-health.md`; serves `fleet-stays-healthy`). A new
`switchroom fleet-health` CLI verb with three subcommands:

- `scan` — the nightly **model-free (zero-token)** sensor. Iterates every
  agent under `~/.switchroom/agents/*`, reads each agent's `turns.jsonl` +
  `logs/<agent>/gateway-supervisor.log`, runs the L0 detectors (ported verbatim
  from the validated reference detector: `HANG_MS=360000`, `HANG_MAXTOOLS=2`,
  `synthetic-` exclusion, precise gateway signatures, `turn_id` join key),
  classifies each finding into the 9-class failure-mode taxonomy, maps it to
  one of the 22 job specs, scores it `severity × frequency × reach × recency`,
  and writes the ledger in the exact shape the read side consumes. `--dry-run`
  / `--json` supported. Defensive: a malformed/missing `turns.jsonl` is skipped
  with a warning, never crashes the scan.
- `scan --sync-issues` — the GitHub issue lifecycle (default-off, network-
  guarded so CI/tests never hit it): opens one issue per distinct problem
  (`dedup_key`), updates its occurrence list + count on re-scan, and closes it
  on a verified count-drop. Labels `fleet-health`, `severity:1|2|3`,
  `job:<slug>`. No-ops with a clear log line if `gh` is unavailable.
- `deep-dive-targets` — prints the top-N ledger records as a structured brief
  the owner agent's weekly Opus deep-dive cron consumes (the model spend stays
  in the agent's own budgeted session; the CLI calls no model — claude-native).

Documents the two owner-agent crons (nightly sensor, weekly deep-dive) and the
mapping/scoring in the RFC + a new `docs/fleet-health.md`. Per-agent cron config
and per-agent ledger state are never committed.

### Voice PR-B2: local GPU STT sidecar (gateway consuming side + token injection)

Wires the gateway's voice-in path to the local `voice-sidecar` GPU
speech-to-text service when the host's PR-B1 voice verdict is `engine: local`.
On such a host an inbound Telegram voice note is transcribed entirely
on-box (faster-whisper) — no third-party STT key (vision #3,
subscription-honest) and no cloud reachability dependency (vision #4,
always-available). On a `cloud` verdict the existing OpenAI Whisper path is
unchanged. Either way, any transcription failure falls back to the legacy
`(voice message)` envelope — voice-in stays a non-critical UX enhancement.
Serves `reference/jobs/talk-to-agents-from-anywhere.md`.

- Gateway: new `transcribeViaSidecar` (POST audio → sidecar `/stt` with the
  `X-Voice-Token` shared secret, mirroring `transcribeViaWhisper`'s
  return-contract) and `maybeTranscribeVoiceLocal`. Engine selection reads
  the persisted `loadHostCapabilities()` verdict; the local path needs no
  `provider === 'openai'` gate (it has no API key). The Telegram download
  is now a shared `downloadVoiceBytes` helper used by both paths.
- Token: the sidecar's shared secret is resolved by BOTH ends from the vault
  at `voice/sidecar-token`. The gateway resolves it at use-time via the
  broker (`materializeSidecarToken`, mirroring `materializeVoiceKey`). At
  `switchroom apply` (local verdict only), the token is seeded in the vault
  if absent and written to the compose-adjacent `.env` (0600) so docker's
  `${VOICE_SIDECAR_TOKEN}` interpolation populates the pure-Python sidecar's
  env — the secret never lands in the generated YAML. A `cloud` verdict
  removes any stale token `.env`.
- Singleton reconcile + doctor now manage `voice-sidecar` as a
  verdict-gated conditional singleton (`resolveSingletonServices`): tracked
  for image-drift on a `local` host, never flagged missing/unhealthy on a
  `cloud` host.

## v0.16.30 — Telegram deterministic formatting: reply-path bullet split + card-body normalization

Deterministic Telegram formatting on two surfaces. On the reply path, collapsed inline bullet lists are now split onto separate lines (`splitCollapsedInlineBullets`) so bullets that arrived run-together render as a proper list. (#2687)

Card bodies are normalized (`stackCardLines`) so the progress, worker, issues, and boot cards stack their bullets consistently — the same way a reply renders. The permission card is unchanged (zero-diff). (#2688)

## v0.16.29 — Fix Hermes Desktop session.create + pet.info for v0.17

Hermes Desktop v0.17.0 calls `session.create {cols, profile}` — no `session_id` — when the user sends the first message after reconnect. The handler was falling through to `""` and returning "Unknown session: ". Fix: fall back to `ctx.activeSessionId` (set by the prior `session.resume` auto-resume), then to the most-recently-active agent by `lastTurnAt`. Also adds `pet.info / pet.info.meta / pet.gallery` stubs returning `{enabled:false}` — without these, -32601 errors triggered a retry loop that spammed the WS connection every ~5s. (#2684)

## v0.16.28 — Fix Hermes Desktop "Unknown session" on chat

`session.status` was the only WebSocket handler missing the `ctx.activeSessionId` fallback. Hermes Desktop v0.17.0 calls `session.status` after `session.activate` without re-sending `session_id`, hitting the empty-string path and returning `Unknown session: ` — showing "Session unavailable" in the chat view. Fix: consistent with every other handler in the switch block. (#2682)

## v0.16.27 — Fix agent-initiated rollouts (hostd machine-id + litellm passphrase)

Fleet rollouts triggered by agents via the hostd MCP (`/update apply`) were failing at the apply step whenever LiteLLM is enabled. Root cause: the hostd container was not mounting `/etc/machine-id`, so `resolveOperatorVaultPassphrase` could not decrypt the auto-unlock blob, returned null, and `provisionLiteLLMKeys` counted all 12 opted-in agents as scaffold failures — aborting rollout before a single agent was restarted. Keys already in the vault were untouched.

Fix: add `/etc/machine-id:/etc/machine-id:ro` to the hostd compose (same mount the vault-broker already carries). Defense-in-depth: change the passphrase-null path in `provisionLiteLLMKeys` from a hard failure to a warning — already-provisioned keys are unaffected; first-time provisioning still requires an interactive `switchroom apply`. (#2679)

**After upgrading:** run `switchroom hostd install` once to regenerate the hostd compose with the new mount.

## v0.16.26 — Approval-card reason + TTL determinism

Gated hostd fleet verbs (`rollout`, `update_apply`, `agent_exec`, `agent_start`/`agent_stop`, `agent_logs`) now accept and display a `reason` on the operator approval card, so the operator can see *why* an action is being requested before tapping Approve or Deny.

Approval cards for hostd fleet verbs now use a 30-minute decision window (was 10 minutes), strip their inline keyboard when they time out, and a tap on an already-expired card returns an honest "already timed out — ask again" notice instead of silently doing nothing — fixing the "approved but nothing happened" race. (#2677)

## v0.16.25 — Telegram deterministic message formatting

Paragraph normalizer: guarantees a blank line (`\n\n`) between paragraphs and at GFM block boundaries — before tables, fenced code, blockquotes, and headings, and after a list when breakout prose follows — while keeping list internals and table rows intact. Fixes tables rendering as inline pipe text and prose being absorbed into the preceding bullet under the Bot API 10.1 rich-message (GFM) path.

Character cap unified to 32768 across all Telegram send paths (status cards, silent-reply anchor, `formatSwitchroomOutput`, drive-write approval, ipc `send_outbound`), with length-error detection and automatic re-split on overflow.

Telegram formatting floor card injected into every agent's system prompt at boot — concise guidance on the formatting toolkit and when and why to use each tool. (#2674)

## v0.16.24 — Hermes Desktop: supergroup forum topics as sessions + topic name resolution

### PR A — WAL file permissions + history channel filter (#2668)

`registry.db-shm` and `registry.db-wal` (SQLite WAL mode sidecar files) were still `0600` after v0.16.23 widened the main DB. All three files are now chmoded to `0644` in `openTurnsDb` so the `switchroom-web` container can read WAL-mode databases. Host workaround for existing files: `sudo find ~/.switchroom/agents -name "registry.db*" -exec chmod 0644 {} \;`

`handleGetTurns` now filters to the agent's configured `channels.telegram.chat_id` so supergroup agents (marko, test-harness) show their group conversation history instead of a mix of DM and group turns.

### PR B — One Hermes session per forum topic (#2668)

For agents with a primary channel `chat_id` configured, `/api/sessions` and all WS session handlers now enumerate distinct `thread_id` values from the turns DB and expose one session per forum topic:

- `marko` → General topic (null thread_id)
- `marko~3` → Meta Campaigns
- `marko~635` → Social Posts (Postiz)
- etc.

Session titles resolve friendly names via `channels.telegram.topic_aliases` (e.g. `marko · meta`, `marko · crm`). Thread IDs with no alias fall back to the numeric ID. DM-only agents are unchanged.

`parseHermesSessionId()` (new export) splits composite session IDs; all `injectInbound` / `injectSlashCommand` callsites use the bare agent name so socket paths remain correct.

## v0.16.23 — Hermes Desktop: history crash fix + cron run labels

### PR A — History crash + registry.db permissions (#2665)

Hermes Desktop crashed with `TypeError: Cannot read properties of undefined (reading 'forEach')` when selecting a session. Root cause: `GET /api/sessions/:id/messages` and WS `session.messages` returned `{error: "unable to open database file"}` when the agent's `registry.db` was unreadable; Hermes iterated the response as data. Both paths now degrade gracefully to `{messages: []}` on any DB error.

`openTurnsDb` now creates `registry.db` at `0644` (was `0600`) so the `switchroom-web` container (different UID, same host bind-mount) can read turn history. Existing files on disk should be widened manually: `sudo find ~/.switchroom/agents -name registry.db -exec chmod 0644 {} \;`

Cron run rows now include a `name` field (formatted timestamp, e.g. `Jun 29, 07:00`) so the sidebar shows the run date instead of `—`.

### PR B — Release process docs (#2664)

CLAUDE.md updated with two lessons from the v0.16.22 rollout: temporary `package.json` version bump before `npm pack` (stale placeholder produces wrong tarball filename), and the manual `switchroom-web` container update procedure (separate compose project, not touched by `switchroom update`).

## v0.16.22 — Hermes Desktop: conversation history, model picker, cron panel, slash palette

### PR A — Conversation history + model picker (#2660)

`GET /api/sessions/:id/messages` returns the agent's conversation history from the local turns database, rendered as `SessionMessage[]` with Unix-second timestamps. Hermes Desktop's History tab now shows real messages instead of an empty list.

`GET /api/model/options` and `model.options` / `model.info` WS methods return the four Claude models switchroom supports. The `config.set` WS method accepts `{ key: "model", value: "<model>" }` and injects `/model <name>` into the agent session, wiring the model picker.

### PR B — Cron panel (#2661)

`GET /api/cron/jobs`, `GET /api/cron/jobs/:id`, `GET /api/cron/jobs/:id/runs` implement the Hermes cron panel backed by `handleGetSchedule`. Job IDs use `agent~index` (tilde separator) to avoid URL path ambiguity. Run history maps `DispatchResult` records with Unix-second timestamps. Write endpoints return 422 (switchroom manages schedules via YAML config, not the API).

### PR C — Slash command palette + exec (#2662)

`commands.catalog` returns four categories of switchroom extension commands (Session, Memory & knowledge, Vault & auth, Diagnostics) that populate the Hermes `/` autocomplete popover.

`slash.exec` routes commands via two paths: REPL commands (`/memory`, `/status`, `/usage`, `/clear`, `/compact`, `/model`) go through `injectSlashCommand` (tmux send-keys) and return captured pane output; non-REPL gateway commands (`/vault`, `/auth`, `/doctor`, `/whoami`, `/logs`, `/version`, `/commands`) go through `injectInbound` as a synthesized turn. Blocked commands (`/effort`, `/login`, `/logout`, `/exit`, `/quit`) return a clear error. `/restart` and `/new` are excluded from the catalog — they require the grammy bot.command handler path.

## v0.16.21 — Hermes Desktop: profiles render crash fix + settings stubs

Fixes a React render crash that occurred immediately on first paint after the remote backend connected. `GET /api/profiles` was returning `{}` instead of `{ profiles: [] }` (ProfilesResponse), causing `data.profiles.length` to throw `TypeError: Cannot read properties of undefined (reading 'length')`. (#2658)

Also stubs three settings-panel endpoints that were returning 404 (visible as Electron main-process log errors when opening Settings, not boot-blocking): `GET /api/env` → `{}`, `POST /api/providers/validate` → `{ok:true, model:null}`, `GET /api/auth/providers` → `{providers:[]}`. (#2658)

Adds `GET /api/profiles/:name/soul` stub → `{content:"",exists:false}` for profile soul lookups.

## v0.16.20 — Hermes Desktop: green status + full session fields

The Hermes Desktop status bar now shows green "Inference ready" instead of amber "needs setup." The `setup.status` and `setup.runtime_check` JSON-RPC methods were returning -32601 errors, which made the desktop think no provider was configured. Both now return `{provider_configured: true}` / `{ok: true}` — switchroom always has the subscription-funded claude CLI available.

Session objects in the sidebar now carry all required `SessionInfo` fields: `is_active`, `started_at`, `last_active`, `ended_at`, `input_tokens`, `output_tokens`, `message_count`, `tool_call_count`, `preview`, `source`, `title`. Missing fields were previously causing potential undefined-access issues in sidebar components.

`/api/status` now returns the full `StatusResponse` shape Hermes Desktop expects (`version`, `gateway_running: true`, `gateway_state`, `gateway_platforms`, `hermes_home`, etc.) rather than a switchroom-specific shape.

`prompt.submit` now emits `message.delta` + `message.complete` with `"(Prompt sent to <agent> — response will appear in Telegram)"` so the chat shows a visible acknowledgement instead of a hanging spinner after submission. (#2656)

## v0.16.19 — Dependency maintenance

CI and base-image dependency bumps, no runtime behavior change: refreshed the `node:22-trixie-slim` base image digest (#2646), bumped `actions/setup-python` 6.2.0 → 6.3.0 (#2648), and `actions/cache` 5.0.5 → 6.1.0 (#2647).

## v0.16.18 — Hermes Desktop render crash fix

Fixes a React render crash (`Cannot read properties of undefined (reading 'length')`) that occurred immediately after the WebSocket connected. `GET /api/cron/jobs` was returning `{}` instead of `[]` (Hermes renders the cron-jobs list with `.length`), and `GET /api/messaging/platforms` was returning `{}` instead of `{ platforms: [] }`. Both stubs now return the correct shape. (#2653)

## v0.16.17 — Hermes Desktop adapter boot fix

Hermes Desktop was immediately crashing on connect with "Error: 404: Not Found" after the WebSocket handshake succeeded. The renderer calls several REST endpoints at boot (`/api/profiles/sessions`, `/api/model/info`, `/api/config/defaults`, `/api/config/schema`, `/api/logs`, and others) that the adapter did not implement. All missing endpoints now return appropriate stub or empty responses so the boot sequence completes. (#2651)

## v0.16.16 — answer-stream lane now renders markdown; quieter idle-clear

Agent narration sent through the answer-stream lane is now converted from
markdown to Telegram HTML before going on the wire, matching every other
outbound lane (the reply handler, the turn-flush backstop, the PTY partial
handler). Previously this lane shipped the raw transcript under
`parse_mode: 'HTML'`, so `**bold**` reached the user as literal asterisks and
agent narration read as unformatted text. The renderer
(`sanitizeTelegramHtml(markdownToHtml(...))`) is injected as a dependency, so
dedup/comparison logic still runs on the raw text and only the outbound payload
is converted. (#2628)

The Telegram idle-clear notice is no longer posted to chat — the idle clear is
now a stderr-only log, removing a noisy message from topics while keeping the
event observable to operators. (#2641)

## v0.16.15 — fix sr-* success reply showing spurious "picker unavailable"

After a successful sr-* model tap the reply now shows a clean ✅ banner
+ static model info. Previously, `buildModelMenu` called `discover()`,
which reliably fails immediately post-inject (picker in flux), prepending
`(picker unavailable: picker did not render…)` to a successful switch —
making it look like an error. (#2642)

## v0.16.14 — sr-* model tap: immediate ⏳ feedback while switching

When tapping an sr-* model button in `/model`, the gateway now immediately
edits the menu message to `⏳ Switching session to X…` while the
text-inject round-trip completes (10-30s). Previously the operator saw a
3-5s Telegram toast then silence, with no indication the tap registered.
Once the inject returns, the final ✅/❌ edit replaces it in-place with
the full menu + banner. (#2638)

A `didInterimSrEdit` guard prevents the `toastOnly` early-return from
leaving the menu button-less if a new inbound turn starts during the
interim edit's await.

## v0.16.13 — fix sr-* reply routing after silence poke (Bug D)

When a slow sr-* model (e.g. Gemini 2.5 Flash in thinking mode via
OpenRouter) takes longer than the 5-minute silence threshold to call
`reply`, the gateway's silence poke fires and nulls `currentTurn`. The
Bug B fallback from v0.16.12 reads `turn.sessionChatId` but `turn` is
`null` at that point — so the fallback was inert and `assertAllowedChat`
threw, silently dropping the reply. (#2635)

Fix: introduce `lastActiveTurnChatId` (captured in `setCurrentTurn()`, NOT
cleared by the silence poke). The `executeReply` fallback now uses
`turn?.sessionChatId ?? lastActiveTurnChatId`, so a late reply routes
correctly even after the poke. The tier (`active` vs `last-known`) is
logged to stderr for operator visibility.

UAT: `jtbd-model-litellm-sr-dm` timeout extended to 480 s (expectMessage) /
660 s (overall) to accommodate Gemini 2.5 Flash thinking mode. Button
selection now prefers `deepseek-v3` (non-thinking, <10 s) over `flash`
(may default to thinking on OpenRouter). (#2635)

## v0.16.12 — fix sr-* reply routing: chat_id fallback + obligation meta

Two remaining routing bugs that prevented Gemini (via LiteLLM sr-* models)
from delivering replies after a model switch:

**Bug B — executeReply fallback**: When a non-Claude model passes an unexpected
`chat_id` (not in the allowlist), `executeReply` now falls back to the active
turn's `sessionChatId`, which was already validated at inbound receipt. The
fallback logs a `stderr` line so operators can observe model confusion without
the reply being silently dropped. (#2632)

**Bug C — obligation represent meta**: `buildObligationRepresentInbound` set
`chatId` on the root `InboundMessage` but omitted it from `meta`. The bridge
builds the `<channel>` XML from `meta`, so obligation re-presents had no
`chat_id` attribute — the model had no value to pass back to `reply`. Fix:
add `chat_id: o.chatId` to `meta`, matching the pattern in
`resume-inbound-builder.ts`. (#2632)

## v0.16.11 — fix sr-* reply blocked by numeric chat_id type mismatch

Non-Anthropic models routed via LiteLLM (e.g. `sr-gemini-2.5-flash`) send
`chat_id` as a numeric JSON integer even though the tool schema declares
`type: string`. `assertAllowedChat` ran `allowFrom.includes(number)` against
a string array → `false` → threw → silently swallowed by `onToolCall`, making
every `reply` from an sr-* session invisible.

Fix: widen `assertAllowedChat` to accept `string | number` and coerce to
string internally. Replace all `args.chat_id as string` extractions in tool
handlers (`reply`, `stream_reply`, `send_checklist`, `update_checklist`,
`react`, `edit_message`, `send_typing`, `pin_message`, `delete_message`,
`forward_message`, `get_recent_messages`, `vault_request_access`) with
`String(args.chat_id ?? '')` for defence-in-depth. (#2629)

## v0.16.10 — fix sr-* obligation cascade + Codex 5.5 model

### PR A — Fix obligation cascade on sr-* short replies (#2624)

Turns via sr-* (LiteLLM/OpenRouter) models consistently ended with
`finalAnswerDelivered=false` when the model replied with a short answer
(e.g. "OK"). The claude CLI calls `reply("OK", {disable_notification: true})`
for short responses — below the 200-char backstop and notification-suppressed,
so `isFinalAnswerReply` returned false. The obligation system then re-presented
the turn with the full 25k-token conversation context, which again produced a
short reply, which cascaded — blocking the agent for minutes and making 4-6
sequential 25k-token calls per sr-* turn.

Fix: at `turn_end` (explicit model completion signal), close the obligation when
`replyCalled=true`, regardless of `finalAnswerDelivered`. The ack-then-ghost case
that obligations are designed to catch ends via `silence_fallback` (silent timeout),
not `turn_end`. The `silence_fallback` path is unchanged.

**Config: sr-codex-5.5 added to LiteLLM proxy.** `openrouter/openai/gpt-5.5-codex`
is now exposed as `sr-codex-5.5` and appears in the `/model` OpenRouter section.

## v0.16.9 — graceful restart on sr-* → Claude model switch

### PR A — Graceful restart: text-command path (#2619)

When an agent's live session is on an sr-* (OpenRouter) model and the
operator types `/model claude-opus-4-5` (or any Claude model name), the
gateway now schedules a **graceful restart** instead of injecting `/model`
in-place. In-place inject can't restore the native Claude OAuth routing
path once the session was started under LiteLLM — restart is the only
clean path back.

- `handleModelCommand()` detects the sr-* → Claude transition via
  `isSrToClaudeTransition(prevModel, nextModel)` and calls
  `deps.scheduleRestart()` (hostd-first, `triggerSelfRestart` fallback).
- Restart marker written so the post-restart boot card edits into the
  originating chat.
- Claude → Claude and Claude → sr-* switches are unchanged (in-place inject).

### PR B — Graceful restart: menu button-tap path (#2621)

Same logic for the inline `/model` menu button press path. When an operator
taps a Claude subscription button while the session is on sr-*, the menu
card is replaced with a restart notice and the same graceful restart fires.

- `isSrToClaudeTransition` exported from `model-command.ts` and shared
  between text-command and button-tap paths.
- Gateway callback handler captures `prevSessionModel` before updating
  `activeSessionModelOverride`, detects the transition, and calls
  `triggerSelfRestart` (same gate as `/restart`).

### PR C — UAT: prefer fast sr-* model + timeout fixes (#2620)

- UAT now selects `sr-gemini-2.5-flash` (or any non-reasoning sr-* model)
  over `sr-deepseek-r1` (a reasoning model that takes 2-5 min per response).
- Response timeout raised 60s → 120s; test-2 overall timeout raised to 120s.
- Restore step matches any `mdl:s:` (Claude) button; restore wait raised
  4s → 15s to cover the graceful restart path.

---

## v0.16.8 — gateway LiteLLM key fix (ANTHROPIC_CUSTOM_HEADERS in outer block)

- Gateway sidecar now inherits `ANTHROPIC_CUSTOM_HEADERS` at startup so
  `/model` menu correctly shows OpenRouter (`sr-*`) models. Root cause: the
  key was fetched only in the inner tmux shell (after re-exec), never reaching
  the outer-block sidecars (gateway, agent-scheduler). Fix: fetch once in the
  outer block before any sidecar fork — all child processes inherit it
  automatically. cron-session and inner-block fetches become defense-in-depth.
- Hermes-Desktop adapter: operator console JSON-RPC 2.0 gateway (`/web/hermes`).

## v0.16.7 — sr-* model discovery + cron LiteLLM key fix

- `/model` menu now shows OpenRouter (`sr-*`) models by querying LiteLLM
  `/model/info` directly — previously only Anthropic models appeared because
  the claude CLI picker never returns `sr-*` names.
- Cron sessions (`clerk-cron` and any other Tier-1 cron claude) now correctly
  export `ANTHROPIC_CUSTOM_HEADERS` with the LiteLLM virtual key before the
  tmux launch. Without this, every cron fire hit the LiteLLM proxy without a
  key header and received 401 ("Unable to find token in LiteLLM_VerificationTokenTable").
- New UAT scenario `jtbd-model-litellm-sr-dm` proves the sr-* section appears
  in the `/model` menu on LiteLLM-enabled agents.

## v0.16.6 — /model menu grouped by subscription tier

- `/model` inline keyboard now shows two labelled sections when both Claude and
  OpenRouter models are available:
  `── Claude (Max / Pro subscription) ──` and `── OpenRouter / external ──`
- Body text updated to read "Claude models use your Max/Pro subscription.
  🌐 models are billed separately via OpenRouter." for clarity.
- Section header rows show an informational toast if tapped; no selection occurs.
- Headers are suppressed for agents without LiteLLM sr-* options (clean list).
- Hindsight Docker healthcheck now probes the correct port (18888) when running
  in LiteLLM host-network mode instead of the hardcoded upstream default (8888).

## v0.16.5 — LiteLLM spend enrichment + hindsight routing + sr-* model switching

### PR A — Enriched LiteLLM spend tags + gateway model discovery (#2601)

- `scheduleName` tag added to agent audit JSONL so cron vs Telegram spend is
  attributable in the LiteLLM spend log.
- Per-turn gateway discovery of available models (via `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`)
  enables the non-Anthropic model picker in Ship D below.
- Static spend tags now include `profile:<name>` alongside `agent:<name>`.

### PR B — Ship C: Grafana turn panels + tag exporter (#2604)

- New Grafana dashboard panels for per-agent turn throughput, latency, and
  model breakdown, driven by the Turn JSONL stream.
- `litellm-tag-exporter` sidecar harvests per-agent virtual-key spend from
  the LiteLLM API and writes Prometheus metrics for fleet cost attribution.
- Turn JSONL file format documented; gateway writes one record per completed
  turn (start/end timestamps, model, status, token estimates).

### PR C — Hindsight LiteLLM routing (#2603)

When `litellm.enabled: true` globally and `memory.backend: hindsight`,
`switchroom apply` now provisions a `service:hindsight` virtual key
(vault `litellm/hindsight/api-key`) and injects it into the hindsight
container so its Claude Agent SDK subprocess routes through LiteLLM for
spend tracking — same subscription, now metered.

- `startHindsight()` accepts an optional `LiteLLMHindsightConfig` param.
  When provided: `--network host` (matching agent containers so
  `127.0.0.1:4010` is reachable), `HINDSIGHT_API_PORT`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_CUSTOM_HEADERS` with Bearer key + static tags.
- Fail-open: if the key is missing or vault unreachable, hindsight starts
  normally (direct OAuth, no tracking).

### PR D — Ship D: sr-* non-Anthropic model switching in /model (#2607)

The `/model` Telegram command now surfaces non-Anthropic LiteLLM models when
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is active (automatic when
`litellm.enabled: true`).

- `classifyDiscoveredOptions()` splits picker results: native Claude models
  (uppercase label or `claude-*` ID) go to the cursor-nav section; sr-*
  synthetic names (e.g. `sr-gemini-2.5-pro`, `sr-deepseek-r1`) appear as
  🌐-prefixed buttons; internal paths (`openrouter/*`, `gpt-*`, `voyage-*`)
  are silently dropped.
- sr-* selection uses text-inject (`/model sr-<name>`) rather than cursor
  navigation — more reliable with a long model list.
- `SR_MODEL_LABELS` maps sr-* API names to friendly display labels
  ("Gemini 2.5 Pro", "DeepSeek R1", "DeepSeek V3", "GLM-5").
- **I6 invariant**: sr-* names have no entry in
  `model_group_settings.*.forward_client_headers_to_llm_api` — Anthropic
  OAuth is never forwarded to OpenRouter. Documented in
  `reference/rfcs/litellm-max-subscription-invariants.md`.

---

## v0.16.4 — LiteLLM gateway routing + channels durable fix + Claude Code 2.1.195

### LiteLLM subscription-native gateway routing (opt-in) (#2597)

Operators can now route all agent traffic through a self-hosted LiteLLM proxy
for usage tracking and content-safety guardrails, while keeping the Max
subscription as the funding source (OAuth forwarded unchanged — never an API
key). Default OFF; enable per-agent or fleet-wide via `litellm.enabled: true`
in `switchroom.yaml`.

- `switchroom apply` provisions a per-agent virtual key (vault
  `litellm/<agent>/api-key`), tagged `agent:<name>` in LiteLLM for clean cost
  attribution. Admin key stored at `vault:litellm/master-key`.
- **Fail-open**: if the virtual key is missing or the proxy is unreachable at
  boot, start.sh strips the routing env and falls back to direct OAuth —
  availability is never sacrificed to the proxy.
- Per-agent attribution via `x-litellm-customer-id` + `x-litellm-tags` (static
  headers, one per agent process). Per-session granularity is a future Ship C
  (log⨝ledger correlation) — `claude` CLI sends no session id on the wire.
- Non-Anthropic models routed through the same proxy (OpenRouter etc.) are a
  separate, clearly-labelled off-subscription path.
- New invariant carve-out in `reference/invariants.md` + mirror in `vision.md`
  pillar 3 and `CLAUDE.md`: a metering+safety proxy is allowed iff OAuth
  forwarded unchanged, no API/SDK call, content-safety guardrails only,
  opt-in, fails open.

### Durable channels fix: bake `channelsEnabled` managed-settings into image (#2598)

Claude Code ≥ 2.1.185 blocks `--dangerously-load-development-channels` (the
flag `start.sh` uses to load the telegram plugin) unless `channelsEnabled:
true` appears in endpoint-managed settings. Without this fix, pulling any
newer image would silently strand all agents.

Bakes `/etc/claude-code/managed-settings.json` (`{"channelsEnabled":true}`)
into the base image so all agent images inherit it — survives version bumps
without per-agent intervention.

### Claude Code pin bump: 2.1.185 → 2.1.195 (#2598)

Bumps the pinned Claude Code version in `docker/Dockerfile.base` and
`docker/Dockerfile.hindsight` (kept in lockstep). Latest release.

---

## v0.16.3 — fix OAuth token refresh (correct Claude Code client_id)

The auth-broker presented the wrong OAuth `client_id` (`9d1cd16e-…`) on the
token-refresh exchange, so Anthropic rejected every refresh with
`400 invalid_request: Client with id … not found`.

- **Correct client_id** (#2594). Refresh now uses the real Claude Code OAuth
  client (`9d1c250a-…`, the one the `claude` CLI's own login / setup-token flow
  uses). The wrong value had been in place since the refresh primitive landed
  (#621 / #1254) but the bug was **latent**: every historical account was a
  long-lived `setup-token` (`user:inference`, ~1y expiry) that never hits the
  refresh path. The first full Claude-Code session token (broad scopes, ~8h
  expiry) added to the broker surfaced it — refresh 400'd every ~8h and the
  account silently expired (real incident: `ken@autograb.com.au`). Override
  remains available via `SWITCHROOM_OAUTH_CLIENT_ID`. New
  `account-refresh.test.ts` pins the value, the refresh request body, and the
  override path.

## v0.16.2 — opt-in overage, /auth add TTY fix, feed + turn liveness

This release adds an operator opt-in to spend an account's Anthropic overage
past the weekly wall (default-off, subscription-honest by construction), fixes
the `/auth add` Telegram OAuth flow, and hardens two activity-liveness surfaces
so a busy-but-silent turn never reads as idle or "done".

### Opt-in overage past the weekly wall (#2591)

The auth-broker can now keep a flagged account eligible past the 7-day
utilization wall when Anthropic reports overage is available — strictly opt-in,
and still the unmodified `claude` CLI on the subscription (no API/SDK; the
`claude-native` invariant is untouched).

- **`auth.allow_overage_accounts`** (new config list, default absent) — only an
  account explicitly listed is ever kept eligible past the wall, and only while
  its fresh quota snapshot reports `overageStatus:"allowed"` and not
  `out_of_credits`. Every unflagged account behaves exactly as before.
- **Broker is the sole spend authority.** The in-agent wedge-watchdog consults a
  single broker boolean (`active_overage_serving`) before, on the
  `/rate-limit-options` menu, selecting "usage credits" instead of Escaping —
  and only for the opted-in account. With no flag set the watchdog is
  byte-identical to today (Escape-only); every error path fails safe to Escape.
- **Auto-stop + most-recent-signal-wins.** A fresh probe reporting
  `out_of_credits` removes the lift immediately; a real-429 mark blocks while it
  is the newest signal, and a fresh post-429 `allowed` probe re-authorizes —
  which is how overage engages at the wall. Kill switch
  `SWITCHROOM_RATE_LIMIT_OVERAGE=0`.
- **Docs.** `reference/vision.md` pillar 3 + the `keep-my-subscription-honest`
  and `track-plan-quota-live` job specs amended to record the narrow opt-in
  carve-out (same shape as the existing opt-in voice-key exception).

### /auth add — setup-token under tmux so the TTY OAuth flow works (#2592, closes #2584)

`claude setup-token` does TTY-direct I/O (writes the OAuth URL to `/dev/tty`,
reads the code from the TTY), so the gateway spawning it with pipes never saw
the URL and the code never reached it — `/auth add` timed out after 120s. It now
runs under a tmux pane (mirroring the existing via-claude path): the URL is
scraped with `capture-pane`, the code injected with `send-keys`, and every error
path kills the session and wipes the scratch dir. The echoed code is never
re-scraped.

### Telegram narrative feed + post-answer background-agent liveness (#2589, supersedes #2587/#2588)

- Restores the narrative feed lines and adds a post-answer liveness card so a
  background sub-agent still surfaces activity after the answer lands.
- The post-answer card is bounded by a default-on 30s staleness cap
  (`SWITCHROOM_POST_ANSWER_LIVENESS_STALE_MS`) so a finished worker no longer
  shows an ever-climbing "running" line. Decoupled post-teardown workers are
  covered by the dedicated `workerActivityFeed`. Kill switch
  `SWITCHROOM_FEED_HEARTBEAT=0`.

### Turn-liveness primitive: a busy-but-silent turn can't read as "done" (#2527)

A user could DM an agent, see the ambient ack (👀 / typing), and then get
nothing for minutes while the agent worked — or a 👍 over a turn that never
delivered an answer. Two seams, both fixed by one role-keyed primitive hung off
the loop rather than enumerated per turn-type/surface. Design:
`reference/rfcs/turn-liveness-primitive.md` (serves `know-what-my-agent-is-doing`).

- **Mid-turn liveness floor.** A `user` turn working silently past
  `SWITCHROOM_SILENCE_FLOOR_MS` (default 45s) with no substantive answer now
  gets ONE quiet (no-ping) "still on it" beat — honest text from the
  longest-running in-flight tool (model-free, claude-native), routed through the
  same send path as a model reply. The old 300s safety net *deferred* even its
  loud fallback while "legitimately working", assuming the activity feed covered
  it — but a foreground turn has no feed, so a 6-minute diagnose was invisible.
  The floor inverts that: busy-silent ⇒ speak. Fire-once per turn; the 300s
  unwedge still sits above it. Kill switch `SWITCHROOM_TG_LIVENESS_FLOOR=0`.
- **"Status?" short-circuit.** A message arriving mid-turn fires the floor
  immediately (DM and forum-supergroup topic alike) — the user asked, so answer.
- **Role-aware terminal honesty.** A `user` turn that ends without a delivered
  answer now finalizes to a gentle 😐 ('undelivered'), not 👍 — the operator's
  "thumbs up so it feels done" report. `system`/cron turns and
  `NO_REPLY`/`HEARTBEAT_OK` turns keep 👍 (their silence is legitimate). Kill
  switch `SWITCHROOM_TG_TERMINAL_HONESTY=0`.
- **One provenance discriminator.** Turns are stamped `user` | `system` once at
  enqueue (`deriveTurnRole`), replacing scattered `chatType`/`chatId==null`/
  `source==='cron'` predicates. New agent types are not new roles — coverage by
  construction, not enumeration.
- **Proof.** A fuzzed invariant test (`turn-liveness-invariant.test.ts`, 2000
  turn shapes × both surfaces) asserts fire-once, the role gate, terminal
  honesty, and DM-vs-topic **surface parity** (identical outcome + correct
  thread routing) — the anti-whack-a-mole proof. Plus pure-decision unit tests.

## v0.15.48 — live activity feed never goes dark on a working turn

A productive foreground turn could read as pure silence. The activity feed was
purely tool-driven (it opened only when a tool emitted a non-null label), so a
turn dominated by thinking or by suppressed-by-design tools (typing / memory /
reply) never opened a feed and looked idle until the 300s silence-poke.

- **Liveness-driven feed open.** `feedHeartbeatTick` now opens a minimal
  `Working…` feed once a turn has been alive `SWITCHROOM_FEED_LIVENESS_OPEN_MS`
  (default 12s) with no labelled tool yet, and keeps its elapsed climbing via
  the existing 6s heartbeat. The first real tool label takes over and its edit
  replaces the placeholder; a pure-thinking turn finalizes to `✓ Working…`
  rather than freezing on the live line. Kill switch `SWITCHROOM_FEED_LIVENESS_OPEN=0`.
  Validated live on the UAT harness (feed opened at `→ Working… · 7s` on a
  tool-less turn).
- **Never-null tool labels.** `computeLabel` no longer returns `null` for an
  unrecognized built-in tool (the fallthrough) or an empty-slug `Skill` — a
  null label wrote no sidecar line, so a turn whose first/only tool hit that
  path opened no feed at all. Surface/control tools (reply / react / send_typing
  / sync_retain) stay suppressed (pinned by new tests).
- **labeledToolCount counted after the feed push (#2461 Phase 5).** The
  `tools=` lifecycle field and `✓ N steps` total now increment only when a
  label actually renders, so dropped/empty labels no longer inflate the count.
- **UAT coverage.** New `jtbd-liveness-feed-open-dm` scenario plus the
  re-homed foreground feed-visibility scenarios pin the feed-open invariant.

## v0.15.45 — profile-bank visibility + retire per-agent user-profile mental models

Follow-ups to the per-user memory work (v0.15.44).

- **Profile banks on the health surfaces (#2446).** Per-user / shared profile banks (`ken-profile`, `lisa-profile`, …) now appear on the web dashboard `/memory` tab (labelled "profile bank"), in `switchroom doctor`, and in `switchroom memory stats` — previously invisible because those surfaces enumerated only agent collections. New shared `collectProfileBanks` helper drives all three.
- **Retire per-agent user-profile mental models (#2447).** Dedicated profile banks are now the source of truth for "who the user is", so scaffold/reconcile no longer auto-create a per-agent `user-profile` mental model and no longer wire the `user-profile-refresh` Stop hook. This removes a drift class (empty/failed models injected every turn and flagged by doctor) and a source of personal-fact conflicts (a stale per-agent profile outranking the curated bank). The dashboard "Build profile" button + the helper remain as a dormant opt-in; agent guidance no longer tells agents to build one.

## v0.15.44 — per-user memory: profile banks, per-speaker routing, first-class users

The fleet now gives each trusted user their own memory. When a user messages an agent, recall surfaces *their* profile — not a blended pool.

- **Profile banks + `memory.recall.additional_banks` (#2441).** Recall can merge extra Hindsight banks (a shared / profile bank) into an agent's own results — recall-ranked, 8s timeout each, non-fatal. New `switchroom memory profile add/list` authors operator-written facts into a named bank.
- **Per-speaker routing — `memory.recall.sender_banks` (#2442).** The recall hook reads the Telegram sender from the `<channel user="…">` envelope and routes recall to that user's profile bank (additive; a leading `@` is optional; the sender is part of the recall cache key so multi-user sessions don't cross-serve). Vendor recall-hook change only — no model/SDK/API path added.
- **First-class users — `users:` + agent `serves` / `knows` (#2444).** Define a trusted person once (`telegram_ids` + `profile_bank`) and assign them to agents: `serves` generates `sender_banks` (speaker routing), `knows` generates `additional_banks` (subject knowledge — accepts a user or a raw bank). Union semantics; a `serves` typo is a config error. Memory-routing phase only — access (`allowFrom`) generation is deferred. RFC `reference/rfcs/user-concept.md`.
- **`single-tenant` invariant clarified (#2439, #2440).** Multiple *trusted users within one tenant* and per-user memory isolation are now explicit goals — the invariant had conflated "single deployment" with "single human."
- **Hindsight: 8 GB memory + consolidation throughput knobs (#2438).** Mem limit 4 GB → 8 GB (baseline RSS ~3.4 GB was tight); exposes `LLM_PARALLELISM` (4→6) and `MAX_MEMORIES_PER_ROUND` (100→300) as managed config — concurrency ceiling 3×6=18, fleet-safe. Applied via `memory setup --recreate`.

## v0.15.43 — hindsight ops: working backups, mental-model refresh, throughput, liveness

- **Automated backup now actually works (#2436).** The
  `switchroom-hindsight-backups` volume mounts onto `/backups`, but the
  dir didn't exist in the image, so Docker created the mount point
  root-owned and the non-root hindsight process (UID 11000) got EACCES on
  every `pg_dump` — automated backups **silently never succeeded**.
  `/backups` is now created 11000-owned before `USER hindsight` so a fresh
  named volume inherits writable ownership.
- **Mental-model refresh no longer times out on large banks (#2436).**
  Reflect wall timeout raised 300s→600s: refreshing a model over a 12-13k
  observation bank exceeded 300s and timed out, leaving user-profile
  models stale (observed across 8 banks). 600s lets them complete.
- **Consolidation throughput (modest, reversible) (#2436).**
  `CONSOLIDATION_LLM_BATCH_SIZE` 8→12 (fewer LLM round-trips) and
  `WORKER_CONSOLIDATION_MAX_SLOTS` 2→3 (one more concurrent bank during
  backlog recovery). Kept conservative — slots are a global pool of
  concurrent `claude` subprocesses (subscription-honest).
- **Queue-liveness probe (#2436).** The maintenance loop now logs a loud
  WARNING (read-only) when the oldest pending/processing op exceeds a
  threshold (default 2h) — the visibility that was missing when a 26-day
  consolidation stall went unnoticed. The lease reaper still auto-heals
  stuck processing ops.

## v0.15.42 — poll auto-recovery, context-headroom surface, session commands

- **Telegram poll auto-recovery after a network flap (#2432).** A flaky-internet
  flap could leave the whole fleet alive-but-deaf: the long-poll stall-recovery
  hung in grammy's `runnerHandle.stop()`, which awaits a runner task blocked on a
  non-abortable `getUpdates` retry backoff — so the runner never stopped and the
  in-place restart never ran. Now a confirmed stall exits the gateway non-zero and
  `_switchroom_supervise` restarts it with a fresh runner (exit 1, **never 78**).
  Stall detection sped up 5min→60s, so a flap self-heals in ~3min instead of
  staying deaf until a manual restart. Restarts only the gateway sidecar (claude
  untouched; in-flight turns boot-resumed).
- **Context-headroom surface (#2429, #2430).** Each agent's working-context
  occupancy vs the cap is now visible — a "Context Headroom" section in `switchroom
  doctor` (WARN on the tight band) and a per-agent gauge on the web fleet view. The
  gateway writes a per-turn snapshot reusing the exact occupancy proactive-compaction
  reads, so the surface can never disagree with what triggers `/compact`. Read-only,
  no per-turn model cost. Makes the ~40% tool-search context win legible.
- **Telegram session commands (#2434).** Removed `/reset` (a pure alias of `/new`);
  added `/compact` and `/clear` as first-class commands open to any chat member; and
  sessions now auto-`/clear` after **3h idle by default** (`session.idle_clear_after`;
  `0s` disables) — clearing the working context only, with long-term memory kept in
  Hindsight. Never fires mid-turn; inbound and cron activity re-arm it. Subtle notice
  on auto-clear.
- **`switchroom update` refreshes the hindsight singleton (#2431).** A version
  update now also recreates the hindsight container, not just the agents/broker.

## v0.15.41 — memory: observation-backed recall + trivial-turn skip (on by default)

- **Recall now consumes the synthesized `observation` tier, on by default
  for every agent (#2425, RFC `reference/rfcs/hindsight-synthesis-layers.md`
  phase 1).** Auto-recall requested only raw `world`/`experience` facts, so
  the deduped, dated, provenance-backed observations the consolidation engine
  already generates on every retain (~46k of them) were thrown away — leaving
  recall as the "grab-bag" the `remember-across-sessions` job calls bad. A/B
  on the test-harness bank: with observations, results rank top, reconcile
  contradictory raw facts, and dedup near-duplicates, at neutral recall latency
  and zero model spend (recall is retrieval + local rerank).
- **Recall is skipped on plausibly-stateless trivial turns (#2425, phase 6a).**
  Time/date/greeting turns no longer pay the ~1–2s recall arm + up to ~1024
  injected tokens. Conservative + guarded: the classifier bails the instant a
  prompt references user/project/session state (validated corpus: 18/18 trivial
  skipped, 16/16 memory-needing kept, zero false negatives).
- **Opt-out cascade (#2427).** Both default ON; operators opt out per-agent or
  fleet-wide under `defaults.memory.recall` via `types` / `skip_trivial` in
  `switchroom.yaml` (exported as `HINDSIGHT_RECALL_TYPES` /
  `HINDSIGHT_RECALL_SKIP_TRIVIAL` only when overridden; env wins over the
  on-by-default settings.json).
- **`switchroom --version` reads package.json, not stale build-info (#2426).**

## v0.15.40 — tool-search ON by default (~40% smaller working context)

- **`ENABLE_TOOL_SEARCH` now defaults to `true` (force-defer), not `auto` (#2421).**
  `auto`'s threshold scales with the model window; on the 1M-Opus window the
  whole ~50-80k MCP tool surface fits under it, so `auto` loaded everything
  upfront — it never deferred (measured: clerk fresh-boot baseline 79,056 tok
  under `auto`, unchanged even after the per-tool diet). `true` defers every
  tool NOT pinned via `_meta["anthropic/alwaysLoad"]`; switchroom pins the
  load-bearing hot path (reply / stream_reply / get_recent_messages / react in
  the telegram bridge; hindsight + agent-config server-wide), so the reply path
  stays loaded while the heavy business-MCP + cold-tool surface defers and loads
  on first use. **Canary: fresh-boot baseline 79,056 → 47,064 tok (~40%)** with
  the reply UAT still passing. Trade-off: a deferred tool pays a one-time
  ToolSearch round-trip on first use per session (once-per-tool) for ~32k of
  per-turn context savings. Revert with `SWITCHROOM_TOOL_SEARCH_MODE=auto`;
  full opt-out `SWITCHROOM_DISABLE_TOOL_SEARCH=1`.

## v0.15.39 — fix: connection-health false positives (empty scope.allow)

- **Connection-health no longer false-flags working MCPs (#2417).** v0.15.38's
  doctor "MCP Connections (auth)" check + agent-start boot card reported a
  user-declared MCP as "not authed" whenever the agent wasn't in the vault
  entry's `scope.allow` — *including the normal case of an empty `scope.allow`*,
  which the broker treats as no restriction. The whole fleet false-positived.
  The check now mirrors the broker's `checkEntryScope` exactly
  (`entryScopeDenies`): an empty allow is fine; only a non-empty allow without
  the agent, or the agent being in `scope.deny`, is a real denial (and
  `scope.deny` is now threaded through the readers, so deny-based revocations
  are caught too). Real-denial detection is preserved; only the empty-allow
  false positive is removed.
- **Also:** agents nudged to batch foreseeable approvals + not drop timed-out
  ones (#2415); hindsight automated backups + container healthcheck + pg
  self-maintenance (#2416).

## v0.15.38 — Connection health + leaner telegram tool surface + cold-restart fix

Makes third-party **connections** (MCP integrations) honest about their auth
state, trims the always-loaded telegram tool surface, and fixes a fleet-wide
cold-restart wedge.

- **Cold full-host restart no longer wedges the fleet (#2402).** The autoaccept
  boot poller used a 30 s "idle since launch" timeout; when every agent boots at
  once and `claude` is CPU-starved, the dev-channels prompt rendered after the
  window closed and the poller gave up — stranding 11/12 agents on an
  unanswered prompt. It now polls until `claude` reaches the REPL
  (`REPL_READY_SIGNATURE`), with a generous `bootHardCapMs` ceiling for the
  pathological never-boots case. A blank/pre-REPL pane can no longer trigger an
  early exit.
- **`switchroom doctor` surfaces configured-but-unauthed MCP connections
  (#2404).** Framework integrations (gdrive/ms-365/notion) already verified
  auth; the blind spot was user-declared MCPs (perplexity, postiz, brevo, meta,
  google_ads). New "MCP Connections (auth)" section flags a missing vault key or
  ACL drift with the exact `vault set --allow` fix. Cascade-accurate to the
  broker ACL; fail-safe (broker-down → WARN, never a false fail).
- **Unauthed connections surface at agent start (#2406).** `apply` computes
  connection-health host-side and writes a snapshot the boot card reads via a
  new `probeConnections` probe — a non-silent boot-card line + `/status` Health
  row naming the unauthed integration and its fix. The boot card stays
  silent-when-healthy.
- **Leaner always-loaded telegram tool surface (#2408).** `switchroom-telegram`
  is the primary interface, so its ~8k-token schema loads on every agent every
  turn. The 3 `linear_*` tools are now advertised only when the agent has the
  Linear connection configured, and the server is no longer pinned wholesale:
  the bridge pins only the load-bearing hot tools (reply, stream_reply,
  get_recent_messages, react, edit_message, send_typing, download_attachment)
  via the native per-tool `_meta["anthropic/alwaysLoad"]`, so the ~14 cold tools
  defer under tool-search — reclaiming ~5k tokens/agent. Kill switch:
  `SWITCHROOM_DISABLE_TOOL_SEARCH=1`.
- **Also:** permission-card origin-topic recovery after a force-closed turn and
  no-repeat after a TTL timeout (#2407, #2411); web Connections tab — path-based
  routing, Linear app-actor section, visibility fix (#2405, #2409, #2410);
  hindsight v0.8.2 claude_code provider uses our file creds (#2399); docs:
  vault is passphrase-free + .env auto-loads for UAT (#2403).

## v0.15.37 — Linear agent auth: loud failures, in-container self-serve, proactive watch (#2394, #2396, #2397)

Hardens Linear `actor=app` agent auth after the clerk/carrie incident, where
both agents silently failed Linear with a daily 401: their refresh BUNDLE
(`linear/<agent>/oauth`) was never persisted, because `linear-agent setup` is a
host-only command that no-ops when run inside an agent container — so the access
token expired (~24h) with nothing to refresh from, and nobody was told.

- **Un-healable Linear auth now pages the operator (#2394).** A Linear 401 that
  can't auto-refresh because no refresh bundle was stored (`no_bundle`) or the
  refresh token was revoked (`revoked`) now posts a `🔑 Linear auth needs you`
  Telegram alert in the alerts lane — deduped 6 h per `(agent, reason)`,
  kill-switch `SWITCHROOM_LINEAR_AUTH_ALERT=0`. Transient errors
  (network/HTTP/bad-response) stay log-only. New `linear-auth` outbound
  topic-router kind.
- **Agents can self-serve Linear auth in-container, operator-approved (#2396).**
  New `linear_agent_setup` MCP tool: `action: "authorize_url"` returns the
  browser consent URL; `action: "complete"` exchanges the code and stores the
  access token + refresh bundle via the broker. New-key creation rides a
  `vault_request_access` write-grant; the durable `secrets[]` ACL + `linear_agent`
  block ride `config_propose_edit` — both operator-approved. Secrets stay
  in-process (never config or logs).
- **Footgun guard + proactive watch (#2397).** `linear-agent setup`/`refresh`
  now refuse under `SWITCHROOM_RUNTIME=docker` (they'd silently create a
  throwaway vault) and point at the MCP tool / host shell. A proactive
  Linear-auth watch runs on boot (35 s) + every 6 h
  (`SWITCHROOM_LINEAR_AUTH_WATCH_POLL_MS=0` disables): missing bundle → alert
  now, access token near expiry → proactive rotate, revoked → alert. Wires the
  previously-dead `needsRefresh` helper.

## v0.15.36 — in-hostd reconcile keeps symlinked + bundled-skills mounts; hindsight v0.8.2 (#2393)

Completes the in-hostd conditional-mount fix (#2382) and bumps the hindsight
backend to stop silent memory-write loss.

- **Symlinked conditional dirs survive an in-hostd reconcile (#2387).**
  `~/.switchroom/skills` is a symlink to an absolute host path; inside hostd
  `existsSync` followed it to a `/home/op` target hostd can't see → the skills
  mount was silently dropped on any agent self-restart through hostd. New
  symlink-aware probe resolves the link target against the container-real home;
  the baked mount source stays the host path (docker follows it host-side).
  Applied to skills/mcp-launchers/fleet/credentials/.switchroom-config. No-op
  on the host.
- **Bundled-skills pool bakes a host-rooted source (#2383).** The
  dedup-vs-skills check compared a `/host-home` path against the `/home/op`
  host path in hostd, wrongly emitting a `/host-home` mount source. Translated
  the bake path to the host home.
- **hindsight bumped v0.7.1 → v0.8.2 (#2392).** Picks up the concurrent-retain
  `ForeignKeyViolation` fix (upstream vectorize-io/hindsight #1795/#1882) +
  0.8.x entity-link rework — the `batch_retain` FK race on `unit_entities` was
  silently dropping ~2-3% of memory writes. The image bump runs DB migrations
  on the persisted memory volume on first boot (recreated backup-first).

Reliability fix for concurrent rollouts. Agents share one host and one
`release.pin`; an agent rolling an OLDER pin used to silently revert a
newer-deployed `switchroom-web`/`switchroom-hostd` (its `webd/hostd install
--tag <old>` step blindly `docker compose up`'d, with no check against the
running version). Now `webd install` / `hostd install` read the running
container's tag and REFUSE a clear `vX.Y.Z → older-vX.Y.Z` downgrade (a no-op
skip, not an error — so `update` and `rollout` both stay clean), unless
`--allow-downgrade` is passed. Channel / `sha-…` / `latest` deploys and
upgrades/same-version/first-installs are unaffected. Both `rollout` and
`update` route through these install commands, so every deploy path is
covered.

## v0.15.34 — Connections tab: honest failure state + auto-retry (#2388)

The dashboard Connections tab no longer renders a transient fetch failure as
"nothing configured". The tab fetches only on open (not the fleet poll), and a
failed fetch used to collapse to an empty list — indistinguishable from "no
accounts". Now a failed fetch shows a clear "couldn't load — retrying" banner
(and per-provider "couldn't load" instead of "none configured"), with bounded
auto-retry (3s/6s/9s) that self-heals a blip without a manual re-click. A
genuinely-empty bank is unchanged. (This web image also carries the v0.15.33
Memory-tab redesign, which a parallel v0.15.32 fleet rollout had reverted.)

## v0.15.33 — Memory tab: grouped bands + model relationships (#2385)

The dashboard Memory tab is regrouped and now visualizes how models relate.
Each bank card is split into labelled bands — **Bank summary** (a dense stat
line + an aggregate source-mix bar + a per-model freshness heat-strip) →
**Mental models** → **Actions** — with problems (corruption / extraction gaps)
promoted to a red attention band at the top. A model that synthesizes other
models is shown as a **hub** (badge + clickable "draws on" chips) with its
source models nested beneath it via tree connectors; clicking a chip scrolls
to and flashes that model. Banks with no such relationships degrade to a flat
list (no empty graph). Each model carries a stacked **provenance bar**
(observations / directives / from-other-models). The model→model edges and
provenance come from data the list call already returns — no extra hindsight
round-trips, still zero model calls.

## v0.15.32 — in-hostd reconcile keeps conditional mounts; config_propose_edit determinism (#2382, #2381)

### PR #2382 — compose probes the container-real home for conditional mounts

Closes the filesystem-probe half of the in-hostd-apply host-home bug class
(the bake half was #2353). compose generation gates every optional bind mount
(mcp-launchers, skills, fleet, credentials, .switchroom-config, webkite,
cloakbrowser, audit/schedule.d pre-creates) on
`existsSync(${hostHome}/.switchroom/...)`. When `apply` runs INSIDE hostd — any
agent self-restart through hostd (`/restart`, `/new`, `/reset`,
`config_propose_edit`, `/update apply`) — `hostHome` is the real HOST path
(`/home/op`, correct for baking), but that path doesn't exist in hostd's own
filesystem (the operator's home is bind-mounted at `/host-home`). So every
probe returned false and **silently dropped the conditional mounts**, and the
agent recreated by that reconcile booted without them. This caused the
2026-06-15 marko meta_pages outage: marko was restarted through hostd after a
token rotation, the mcp-launchers mount was dropped, its launcher ENOENT'd, and
the `mcp__meta_pages__*` tools never registered ("No such tool available") —
the token was fine the whole time.

Fix: split a `probeHome` (container-real home, `homedir()` = `/host-home` in
hostd) for all `existsSync`/`mkdirSync`, from the `hostHomeForChecks` bake home
(host path, still bakes mount sources + the agent's `SWITCHROOM_HOST_HOME`
env). On the host the two are identical → zero change; inside hostd the probes
now see the bind-mounted dirs. (Follow-up #2383 tracks the same latent class in
the bundled-skills pool mount.) Rule of thumb: **bake with the host home, probe
with the container-real home.**

### PR #2381 — config_propose_edit deterministic from agents

Per-op wire timeout + idempotent proposals so an admin agent's
`config_propose_edit` behaves deterministically (no duplicate proposals on
retry, bounded wait per op).

The dashboard Memory tab now makes the agents' memory legible. Each mental
model shows the recall question it answers (hindsight's `source_query` — the
"why"), a refresh-mode badge, and a **view** expander that lazy-loads its full
content plus provenance (e.g. *"Synthesized from 35 source facts: 24
observations · 11 directives"*). A new **How memory works** panel explains the
`Conversations → Facts → Mental models → Recall` pipeline with live fleet
totals. The web makes **zero model calls** — it only reads hindsight's REST
API (new read-only `GET /api/memory/model`, bank-gated; CI-enforced
subscription-honest).

## v0.15.30 — Fix: restore per-cron fire history (#2377)

v0.15.29's per-cron fire bounding kept the last fires of every distinct
`promptKey`, including obsolete ones a long-lived agent accumulates — which
blew the response frame budget so the trim shed all fires and the Schedule
tab showed "no fires" for every cron. `boundScheduleView` now keeps only
fires whose `promptKey` matches a current cron.

## v0.15.29 — Per-cron Schedule view (#2375)

The dashboard Schedule tab now shows each cron as a self-contained block —
its title (captured from the overlay file's `# name:` header), cron
expression + routing badges, prompt, and its OWN recent fire history right
below it (matched by `promptKey`) — instead of a flat per-agent table with a
separate agent-wide fires table. Fires are now bounded per-cron, so a busy
cron no longer crowds a quiet one out of the window.

## v0.15.28 — Dashboard favicon (#2373)

The admin dashboard now serves the switchroom logo as its favicon (a
transparent multi-size `favicon.ico` + apple-touch icon), instead of the
generic browser-tab icon.

## v0.15.27 — Admin dashboard overhaul (#2363–2370)

A full audit and rebuild of the `switchroom-web` admin dashboard. The web
container is dockerless by design (the one internet-facing component), which
had silently broken a whole family of features that assumed docker access;
the fix routes the control + observability path through hostd (which holds the
docker socket) over its ungated operator socket, while keeping the web making
**zero model calls** (now enforced by a CI guard).

### PR #2363 — repair the Agents-tab crash + 4 data-accuracy bugs
- CRITICAL: the Agent Details panel read a field the API renamed post-RFC-H,
  throwing a TypeError that blanked the entire Agents grid on every poll.
- Accounts now derive 5h/7d quota from the broker's free `last_quota` snapshot
  instead of spending a billed probe; the health badge reflects the broker's
  live `exhausted` flag.
- Connections show a "connected" pill + "auto-refreshes" instead of
  "Expires 23d ago"; a non-unreachable broker error no longer vanishes a
  configured account. The System hostd panel surfaces the error string and
  uses a tri-state status dot.

### PR #2364 — uptime/mem, schedule overlays, logs via hostd read-ops
- New read-only hostd verbs `agent_status` (uptime + memory) and
  `agent_schedule` (merges each agent's `schedule.d/*.yaml` cron overlays —
  0600 agent-owned, unreadable by the operator/web, readable by hostd as root)
  with a provably frame-bounded payload. Logs route through hostd `agent_logs`.

### PR #2365 — control plane via hostd
- Restart routes through hostd's `agent_restart` (ungated). Live-log streaming
  polls hostd and replaces in place (the old `docker logs -f` couldn't run in
  the dockerless container). Liveness honesty: the status dot is labeled a
  bridge heartbeat, with a real "Last turn" signal from the turns DB.

### PR #2366 — server-side SWR cache + /api/summary + visibility-gated poll
- A stale-while-revalidate cache fronts every expensive panel; `/api/summary`
  collapses the Summary tab's 5-way fan-out into one round-trip; the 10s poll
  pauses when the tab is backgrounded. The billed quota probe is never cached.

### PR #2367 — actionable errors (ProblemDetail framework)
- Every error/degraded state renders a remediation (a copyable host command,
  link, or Telegram note) instead of a raw string; degraded banners replace
  silent empties (e.g. the schedule view when hostd is unreachable).

### PR #2368 — standing capability grants on the Approvals tab
- The approval-kernel ledger is honestly empty; the real standing grants live
  in the vault-broker grants DB. A read-only "Standing capability grants"
  section surfaces them.

### PR #2369 — Memory remediation buttons
- Per-bank "Reprocess", "Refresh model", and "Build profile" buttons that POST
  to hindsight to trigger the work on its own claude-code provider — the web
  makes no model call. Targets are re-derived/validated server-side.

### PR #2370 — triage strip, recent turns, WS-auth fix, CI guard
- A "Needs attention" triage strip on Summary; recent turns in the agent
  Details panel; the live-log WebSocket now authenticates via the
  `Sec-WebSocket-Protocol` bearer the server already checks; and a lint guard
  that fails if `src/web` imports an Anthropic SDK / hits the raw API /
  spawns `claude -p`.

## v0.15.26 — Linear app tokens self-heal (durable OAuth refresh) (#2360, #2361)

Linear's `actor=app` token exchange returns a short-lived access token (~24h)
plus a `refresh_token`, but `linear-agent setup` stored only the access token —
so a Linear agent (carrie, clerk) went dead on expiry and needed a manual
browser re-auth. This release makes app tokens durable: they refresh themselves.

### PR — refresh core + storage + verb (#2360)

- New `src/linear/oauth-refresh.ts` (pure, injectable): exchanges the refresh
  token at Linear's token endpoint; classifies a dead refresh token (`400
  invalid_grant`) as `revoked` — the only case needing operator re-auth — vs
  transient failures; preserves the old refresh token when Linear doesn't
  rotate; persists the rotated **bundle before the access token** so a failed
  write can't strand a rotated refresh token.
- `linear-agent setup` now stores the rotatable refresh bundle (`--refresh-token`,
  `--token-expires-in`, and the app `--client-id`/`--client-secret`) at
  `linear/<agent>/oauth`.
- New `linear-agent refresh --agent <name>` verb (host-side refresh / ops seed).

### PR — in-container auto-refresh on 401 (#2361)

- On a Linear `401`, the runtime refreshes the token **in-container** via the
  broker `put` op (#950 — an agent rotates keys it can already read; no operator
  passphrase) and retries **once**. A `revoked` refresh token is logged loudly
  (`grep 'linear token REVOKED'`) and the original 401 surfaces — bounded, no
  loop. Wired into both `linear_agent_activity` and `linear_create_issue`.
- `linear-agent setup` auto-grants the ACL (adds `linear/<agent>/oauth` +
  `linear/<agent>/token` to the agent's `secrets[]`) so in-container rotation
  works out of the box.

Net: a Linear app actor self-heals on token expiry with **zero operator touch**,
and the vault passphrase boundary is respected (all rotation happens
in-container). Existing Linear agents need one browser re-auth via
`setup --refresh-token …` to seed their bundle.

## v0.15.25 — permissions stop re-asking: [all] keeps grants + scoped 30-min covers Grep/Glob (#2357, #2358)

Two fixes to the approval flow, both surfaced while diagnosing an admin agent
that re-asked for the same permission on every turn.

### PR #2357 — `tools.allow: [all]` keeps explicit grants

An agent with `tools.allow: [all]` expands to all built-in tools + the
switchroom-managed MCP tokens, deliberately excluding privileged hostd tools,
`Skill(...)`, and 3rd-party MCP (the leash — even an `[all]` admin approves
those once). The intended "stop asking" path is a 🔁 Always tap, which now
durably persists the rule into `tools.allow` as `[all, mcp__hostd__agent_logs]`
via hostd `config_propose_edit`. But the scaffold's `[all]` branch dropped
every explicit entry at reconcile, so the persisted grant never reached the
agent's `settings.json` → the agent re-asked forever. Fix (both render sites):
when `[all]` is present, keep the explicit non-`all` entries alongside the
built-ins. Strictly additive; honors the operator's explicit grant.

Also: the `switchroom apply` "manual recreate" hint now prints the real host
compose path (via `toHostHomePath`) instead of the in-container `/host-home`
path when apply runs inside hostd. Display-only.

### PR #2358 — scoped 30-min approval covers read-only Grep/Glob

The scoped 30-min window (tap ✅ Allow → the same low-risk action auto-allows
for 30 min) had effectively never fired: `resolveTimeBox` only time-boxed
Read/Edit/Write-with-a-path and non-destructive Bash families — tools that are
usually pre-approved and rarely prompt — while the tools that actually prompt
and repeat (`Grep`, `Glob`) are "broad-only" (no path sub-scope) and every
broad rule was refused. So an agent grepping a file with several regexes
re-asked on each one even after ✅ Allow. Fix: time-box the broad grant for
read-only whole-tool inspection (Grep, Glob) — they can't mutate, so "any Grep
for 30 min" is low-risk and stops the spam. Network-egress broad-only tools
(WebFetch/WebSearch) stay per-call. Gateway-side only, TTL-bounded,
fail-closed, kill-switch `SWITCHROOM_SCOPED_APPROVAL_TTL_MS=0` unchanged.

## v0.15.24 — scaffold bakes the host home, not the in-container /host-home (#2353)

Closes the second half of the in-container-apply host-home bug class. v0.15.23
made `config_propose_edit` work — which meant hostd began running `switchroom
apply` from **inside its own container**, where `$HOME=/host-home` (the
in-container bind-mount point of the operator's home, not a host filesystem
path). The scaffold generator baked `$HOME`-rooted paths into each agent's
`start.sh` (`cd "{{agentDir}}"`, `--plugin-dir {{agentDir}}/...`, the
`$HOME/.switchroom` symlink target). Agent containers mount `~/.switchroom` at
its **real host path** (same path in/out, `network_mode: host`) and have no
`/host-home` mount, so every baked path dangled → claude fell to the login
screen. This poisoned the whole fleet's on-disk scaffolds (one agent broke on
recreate; the rest were landmines on next recreate).

- **Scaffold bakes the host home.** New `toHostHomePath` / `hostHomeForBake`
  helpers translate the **baked** `agentDir` + `$HOME/.switchroom` symlink
  target from the in-container home to `SWITCHROOM_HOST_HOME` at both `start.sh`
  render sites (initial scaffold + reconcile). Filesystem **writes** keep using
  `$HOME` (`/host-home`, which bind-resolves to the real dir) — only baked
  values change. No-op on the host (`SWITCHROOM_HOST_HOME` unset or `== $HOME`).
  This mirrors the protection `write-compose.ts` already gave the compose bind
  sources (#2279/#2285); the scaffold path was the unprotected sibling.
- **Regression test.** `tests/scaffold.host-home-bake.test.ts` reproduces the
  in-hostd scenario and asserts `start.sh` bakes the host path, not
  `/host-home`.

## v0.15.23 — config-edit works end-to-end: writable, discoverable, honestly described (#2350)

Fixes the bug where an admin agent couldn't edit `switchroom.yaml`, plus the
broader class it exposed.

- **EROFS fix (the real blocker).** hostd mounted `switchroom.yaml` **read-only**,
  so `config_propose_edit` validated + got operator approval but always died at
  the write (`EROFS → E_RECONCILE_FAILED_ROLLED_BACK`) — it had never been able
  to commit. hostd is the sanctioned, operator-tap-gated config writer, so its
  mount is now `:rw` (agents stay `:ro` — the security boundary is unchanged);
  the in-place writer preserves the file's owner/mode. Regression-guarded in
  `hostd.test.ts`.
- **Honest self-descriptions.** The `config_propose_edit` MCP tool no longer
  describes itself as an unimplemented "PR 1a skeleton / returns
  E_NOT_IMPLEMENTED" (it shipped long ago) — an agent reading that wrongly
  refused. Also: admin `CLAUDE.md` now points agents at `config_propose_edit`
  (+ `get_status`) instead of asking the operator to hand-edit yaml; the setup
  wizard no longer calls the working Google OAuth flow a "stub"; and the
  cheap-cron + worker-activity-feed default-flip docs are corrected to "on by
  default; `=0` disables".
- **Recurrence guard.** New `scripts/check-stale-tool-descriptions.mjs` (wired
  into `npm run lint`) fails CI when an agent-facing tool description or prompt
  carries build-time-status language (PR-number / skeleton / E_NOT_IMPLEMENTED
  / "ships in follow-up" / "not yet implemented"); genuine deferrals use an
  `intentional-deferred:` waiver.

## v0.15.22 — admin config edits name the agents to restart (#2346)

### PR — feat(config-edit): name which agents to restart for an admin edit (#2346)

Closes the admin/arbitrary-edit half of the "config edit takes effect" gap. An
admin agent's `config_propose_edit` is written + reconciled, but claude loads
config at boot — so the change was silently INERT in the running agents until a
restart, with no signal which ones. The finalize card just said "✅ Applied".

Now the Applied card names exactly which agents must restart, with the command:
"🔄 Not live until restart — affects: clerk, gymbro · `/restart clerk` ·
`/restart gymbro`"; a shared/inherited change (defaults / profiles / top-level)
guides to "affects all agents — run `switchroom rollout`".

- New `src/host-control/config-blast-radius.ts` `classifyBlastRadius(before,
  after)` deep-diffs the config: `agents.<X>.*` → agent X; defaults / profiles /
  any other top-level → fleet-wide. **Fails safe** — unparseable or ambiguous →
  fleet-wide (over-inclusive; never silently under-reports). Pure + unit-tested.
- Read-only classification + honest card text; **no auto-restart, no new
  authorization path**. The self-scoped "Always allow" case already
  auto-restarts (#2343); this completes the admin case at the legibility level.
  A one-tap "Restart affected" button was deferred (would add a callback stack on
  the riskiest surface for a one-tap delta over the command the card shows).

## v0.15.21 — approval cards resume reliably (mid-turn strand fix) (#2340)

### PR — fix(gateway): turn-gate vault/secret resume synthetics (#2340)

Approval cards (vault grant approve/deny, secret provide/decline, vault save)
inject a synthetic "resume your task" inbound to wake the waiting agent. That
inject did a raw `ipcServer.sendToAgent` and only buffered the message when the
bridge was disconnected (`delivered=false`). But approvals routinely land
**while the agent's grant-requesting turn is still finishing** — the socket
write succeeds (`delivered=true`) yet claude is mid-turn, so the channel
notification is typed into its TUI composer and stranded by the
turn-completion race (the #1556 lawgpt-composer wedge class). `delivered=true`
meant the buffer never rescued it, so the agent sat idle until the operator
manually poked it — the "approved but doesn't continue" symptom. It got worse
recently because Telegram-ID auto-unlock + cached passphrase mint the grant
while the requesting turn is still open, so approvals now land mid-turn far
more often.

- All eight resume synthetics (`vault_grant_approved`/`denied`,
  `secret_provided`/`declined`/`provide_failed`,
  `vault_save_completed`/`failed`/`discarded`) now route through a new
  `deliverResumeSyntheticOrBuffer` helper that consults the **same**
  `decideInboundDelivery` turn-gate the normal Telegram inbound path uses.
  Mid-turn → `buffer-until-idle` (the turn-end drain + idle-drain timer flush
  it the instant claude goes idle, where it lands cleanly as a fresh turn);
  idle → deliver; bridge-down → buffer (unchanged #1150 behaviour).
- Live proof (clerk `hotdoc/credentials`, 2026-06-13): injection 179ms before
  `turn_end`, then 2 minutes of silence until a manual poke.
- Other approval families (dangerous-tool / skill / MCP permissions,
  Drive/Microsoft writes, hostd config edits) were never affected — they keep
  the turn alive (suspend-in-place or block-in-turn) rather than ending it, so
  an approval flows straight back into the running turn.

## v0.15.20 — admin-agent self-management: see your sandbox, grants take effect, durable pins (#2339, #2341, #2343)

Three improvements that let an admin/root agent (and the operator) manage the
fleet more legibly and reliably — each grounded in the access model (every
change still flows from operator config or an operator tap; no agent authors
its own authorization).

### PR — feat(whoami): an agent can see its own sandbox (#2341)

New on-demand legibility surface so an agent that hits a permission wall can
see what it's actually authorized for instead of guessing or escalating
(reference/access-model.md, "Dead-ends breed workarounds"):

- **`whoami` MCP tool** on the already-scaffolded agent-config server — the
  agent's primary consumer; its description says to call it FIRST when blocked.
- **`switchroom config whoami`** host CLI verb; **operator `/whoami`** in
  Telegram (read-only, like `/version`).
- Reports tier, resolved tools (allow/deny), MCP servers, skills, vault KEY
  NAMES (never values) each with the live ACL verdict, powers
  (admin/root/config-edit/cross-agent verbs), schedule count, memory backend.
- **Drift-free**: computed from the SAME enforcement functions that gate each
  action (`resolveAgentConfig` + `checkAclByAgent`), not a hand-list. Pure
  over config → works in-container. Secret values never appear.

### PR — feat(approvals): "Always allow" auto-restarts so the grant takes effect (#2343)

Tapping **🔁 Always allow** writes a durable grant, but claude loads settings
at boot — so it was inert until a manual restart (the "restart agent for full
effect" hint operators ignored, leaving the same permission to re-prompt).
Now a durable Always-allow schedules a **marker-safe, turn-deferred
SELF-restart** (caller agent only; fires at turn-complete, never mid-turn;
only after the operator's tap) so the grant goes live automatically. Reuses
the existing marker-safe restart machinery — no new primitive. Kill-switch
`SWITCHROOM_AUTORESTART_ON_GRANT=0` (default-on).

### PR — feat(cli): durable `--pin` for rollout / update (#2339)

`switchroom rollout --pin vX` and `switchroom update --pin vX` were one-shot
(never written to switchroom.yaml, so the next plain reconcile reverted the
fleet). They now **persist `release.pin`** to the config (comment-preserving,
atomic via `atomicWriteFileSync`, ownership-restored after a sudo write,
idempotent, dry-run-safe) as the first step — so a pinned roll sticks. Shared
helper across both verbs so the two `--pin` paths can't diverge.

## v0.15.19 — `/effort` Telegram command (#2336)

### PR — feat(telegram): `/effort` command — switch reasoning effort per session (#2336)

A Telegram **`/effort`** command, the sibling of `/model`, to show or switch the
Claude **reasoning effort** (`low · medium · high · xhigh · max`,
faster→smarter) for an agent's live session. The bare `/effort` renders a
five-button menu (the live level marked ✅); `/effort <level>` sets it directly.
Both type claude's own native `/effort` REPL command into the agent pane via the
existing allowlisted inject primitive — Claude-native, no API/SDK/config
mutation.

The switch is **session-scoped**: `start.sh` already relaunches claude with
`--effort <thinking_effort>` (the cascade default, `low`), so a session change
reverts to the configured default on the next restart. The config + launch
plumbing already existed (`thinking_effort` cascade field,
`SWITCHROOM_DEFAULT_THINKING_EFFORT`); this adds only the command surface:
`effort-command.ts` (parser + handler + menu + callback, 18 tests), the
`/effort` inject-allowlist entry, `thinking_effort` in `agent list --json`, the
gateway wiring, and the slash-menu + `/commands` entries. No fleet behavior
change on deploy (every agent already launches at `--effort low`).

## v0.15.18 — 30-min approvals fold into "Allow" + `switchroom rollout` verb (#2333, #2334)

### PR — feat(approvals): fold the 30-min window into the "Allow" tap (#2333)

Refines the v0.15.13 scoped-approval tier per operator feedback: there is no
longer a separate **⏱ 30 min** button. The 30-min window is now the DEFAULT
behavior of **✅ Allow** for a narrow, non-destructive action — tap Allow on a
re-edit of the same file (or a safe command-family) and it stops re-asking for
30 minutes. Broad / MCP / destructive scopes stay truly once. The button is
relabeled "✅ Allow" (from "Allow once"), and the post-tap card states the real
outcome honestly: "won't ask again about edits to x.ts for 30 min" vs "Allowed
once". All invariants from #2317 are preserved unchanged — gateway-side-only
(no `rule` leaked to the bridge's untimed cache), irreversible commands re-card
at grant AND match time, fixed window, dies on restart, fail-closed expiry,
kill-switch `SWITCHROOM_SCOPED_APPROVAL_TTL_MS=0`.

### PR — feat(cli): `switchroom rollout` — safe staggered fleet deploy (#2334)

A new verb that encodes the correct staggered-rollout sequence as one command
so it can't be fumbled: **apply** (regenerate compose, no bounce) → **canary-
first staggered `agent restart --wait --force` with a per-agent `--version`
assert, STOP on the first mismatch** → **refresh `switchroom-web` +
`switchroom-hostd`** (separate compose projects that don't self-heal on a pin
bump) → **version sweep**. It orchestrates the existing hardened subcommands —
no new destructive primitive.

- Closes the recurring footguns: apply-before-restart ordering, stale
  singletons (self-heal on first restart, #2170), stale web/hostd, the
  `:latest` pull-race (the per-agent version assert).
- `test-harness` rolls first (automatic canary gate); stop-on-first-mismatch
  never strands the fleet silently — it reports what rolled and how to resume
  (idempotent re-run). web/hostd refresh failures are non-fatal.
- `--dry-run` prints the plan; `--pin vX.Y.Z` sets the target (rejects a
  sha-pin up front — not version-assertable); `--agents <list>` rolls a subset;
  `--skip-web` skips the web/hostd refresh.

## v0.15.17 — cheap-cron Tier-1 auto-routing DEFAULT-ON (#2307)

Now that the Tier-1 cheap cron session boots automatically (v0.15.16, canary
green end-to-end), cadence auto-routing is **on by default** — a frequent
hint-less cron runs cheap without you opting in (the Defaults principle).

- **#2331** — `SWITCHROOM_CRON_AUTO_TIER` flips from a default-off feature flag
  to a **default-on safety kill-switch** (`=0`/`false`/`off` reverts the fleet
  to full Tier-2 turns, mirroring `SWITCHROOM_CHEAP_CRON`). A frequent (≤60min)
  hint-less cron auto-routes to the cheap Tier-1 session; daily/weekly and
  unreadable cadences stay on the full session; an explicit `context: agent` is
  the per-cron opt-out. Also removes the never-wired `telegram-reactions` poll
  type (redundant with the event-driven `reaction_dispatch`, #2291).

Blast radius on this fleet is small (only agents with a frequent hint-less cron
get a cron session); graceful fallback means a cron is never dropped.

## v0.15.16 — Tier-1 cron-session auto-boot (#2307 canary follow-up 2)

The v0.15.15 canary proved the Tier-1 cron session works end-to-end once its
boot prompts are dismissed, but it didn't boot *automatically*. This fixes the
last two wedges so the `<agent>-cron` bridge registers with no manual step.

- **#2329** — (1) `seedCronConfigDir` now copies the agent's fully-onboarded
  main `.claude/.claude.json` into `.claude-cron` (the minimal seed lacked
  `oauthAccount`/theme → login/theme wedge); (2) `cron-session.sh` forks a
  boot-phase `autoaccept-poll` for the cron socket so the per-boot
  `--dangerously-load-development-channels` ack is dismissed (the main
  autoaccept watches only `switchroom-<name>`).

Still inert for the fleet by default (cron session / `kind: action` /
`SWITCHROOM_CRON_AUTO_TIER` are all opt-in).

## v0.15.15 — Tier-1 cron-session boot fix (#2307 canary follow-up)

A canary follow-up to v0.15.14. The v0.15.14 test-harness canary proved Tier-0
model-free actions and Tier-1 cadence auto-routing both work end-to-end, and
caught one pre-existing bug that only became reachable once the cron session was
un-starved + trust-seeded.

- **#2327** — launch the Tier-1 cron session **detached**. `cron-session.sh` ran
  `tmux new-session -A` (attach), but the cron session is a supervised
  background sidecar with no controlling TTY (the main session owns it), so
  attach died `open terminal failed: not a terminal` and the `<agent>-cron`
  bridge never registered (every Tier-1 fire then fell back to main —
  gracefully, but the saving was never realised). Now uses `new-session -d` +
  a `tmux has-session` supervise-block. With this, the cron bridge registers and
  a frequent cron actually runs in the cheap session.

Still inert for the fleet by default (no cron session / `kind: action` /
`SWITCHROOM_CRON_AUTO_TIER` until opt-in).

## v0.15.14 — cheap-cron Tier-0 action tier + Tier-1 un-starve (#2307)

Completes #2307 — making scheduled work spend the model only when it earns it.
Everything here is **inert for the fleet** by default (no agent runs a cron
session; `kind: action` is unused; `SWITCHROOM_CRON_AUTO_TIER` is off), so the
release is byte-identical for running agents until an operator opts in.

### Tier-0 — model-free action tier (#2320, #2321; engine in v0.15.13/#2318)

A `kind: action` cron now **completes mechanical work deterministically in the
scheduler process — zero model calls, no second `claude`, no session wake**.
Two action types: `telegram-message` (post fixed/templated text to the agent's
**own** chat — `{{date}}/{{time}}/{{agent}}` only, no secrets in a message) and
`webhook` (a fixed HTTP request through the same egress fence the polls use).

- **#2320** — `send_outbound` gateway IPC verb: the one `ClientToGateway` verb
  that posts a Telegram message **without waking the model** (no
  `inject_inbound`, no `currentTurn`). Fences `agentName == self` +
  `assertAllowedChat` so an action can only post to the agent's own chat.
- **#2321** — wiring: `buildCheapCronHooks.runAction` over the `send_outbound`
  transport + the agent's own channel target.

`kind: action` is operator-config-only (the `schedule_add` MCP tool can't author
it) and **flag-independent** (model-free regardless of `SWITCHROOM_CHEAP_CRON`).

### Tier-1 — un-starve the cheap cron session (#2322–#2325)

The Tier-1 cheap cron session (`<agent>-cron` — a second cheap Sonnet `claude`
for cheap cron fires) was lobotomised (trimmed `.mcp.json`, a "you don't have
memory" prompt) and never ran in production. Now it's "a fresh, low-context
conversation that **still has the agent's memory + tools**, on a cheaper model."

- **#2322** — the cron `.mcp.json` carries the **full** filtered MCP set (shared
  hindsight memory bank — baked from the base agent name, zero fragmentation;
  tool-search-deferred to keep context cheap). The cron bridge's liveness file
  is isolated (`SWITCHROOM_BRIDGE_ALIVE_PATH` → `.bridge-alive-cron`) so it can't
  mask a dead main bridge, while `STATE_DIR`/gateway socket stay shared. The
  append-prompt now says it shares memory + tools.
- **#2323** — boot-wedge fix: `seedCronConfigDir` seeds the cron
  `CLAUDE_CONFIG_DIR` with onboarding + trust state (full server set), so the
  cron `claude` no longer wedges on the first-run wizard and the `<agent>-cron`
  bridge actually registers. The shared onboarding helpers gained a
  `configDirName` param (default `.claude`, so the main boot path is untouched).
- **#2324** — observability: a `switchroom doctor` *Cron Session* check
  (asserts the cron bridge is registered when expected) + a
  `cron_fell_back_to_main` runtime metric (a climbing counter = a down cron
  session).
- **#2325** — re-enable cadence auto-routing behind **default-off**
  `SWITCHROOM_CRON_AUTO_TIER`: a hint-less frequent (≤60min) cron auto-routes to
  the cheap session; daily/weekly and unreadable cadences stay on the main
  session; explicit hints always win. Graceful fallback means a misconfigured
  flag never drops a cron.

See `docs/scheduling.md` for the `kind: action` and auto-routing operator docs.

## v0.15.13 — 30-min scoped approvals + Linear capture/create-issue (#2317, #2313–#2316)

### PR — feat(approvals): "⏱ 30 min" scoped approval tier (#2317)

A new middle rung on the Telegram permission card between **✅ Allow once**
(re-asks on the very next call) and **🔁 Always…** (a durable forever-write to
`tools.allow`): a fixed-window, scoped, fail-closed auto-approval. After the
operator taps **⏱ 30 min**, byte-identical in-scope requests auto-allow for 30
minutes without re-carding — killing tap-fatigue when an agent re-edits the
same file or re-runs the same safe command seconds apart.

Conservative by design (serves `reference/access-model.md` — "you hold the
leash", without babysitting):

- **Narrow scope only.** Only an exact file path (`Edit(/x.ts)`) or a Bash
  command-family (`Bash(git:*)`) is ever time-boxed. Broad scopes ("any file",
  resource-blind MCP, "any command") do not get the ⏱ button — they stay
  once/always.
- **Irreversible stays gated, at grant AND match time.** A `Bash(git:*)` grant
  auto-allows `git status` but **re-cards** on `git push --force` /
  `git reset --hard` / `rm` / `sudo` / pipe-to-shell / backtick-or-`$()`
  substitution — `isDestructiveBashCommand` is fail-closed (unknown → treat as
  risky) and re-checked on every matching call.
- **Fixed window, dies on restart.** A matching call never slides the window;
  only an operator re-tap resets it. Expiry fails closed (re-cards).
- **Gateway-side only.** The auto-allow verdict is dispatched without the
  `rule` field, so the bridge's untimed `sessionAllowRules` never caches it
  (a `rule` there would silently promote 30 min → session-forever in agent-uid
  memory). Per-agent isolation; every auto-allow is logged.
- **Default-on** with an ops kill-switch (`SWITCHROOM_SCOPED_APPROVAL_TTL_MS=0`
  disables the tier and hides the button). All policy lives in a pure,
  unit-tested module (`telegram-plugin/scoped-approval.ts`).

### PR — feat(linear): `linear_create_issue` tool (#2314)

An agent can file a Linear issue from a turn via a new MCP tool, resolving the
Linear app token from the vault.

### PR — feat(linear): capture-on-reaction → Linear as a switchroom default (#2315)

Reacting to a message captures it into Linear as a switchroom default path.

### PR — fix(linear-agent): force `webhook_via_gateway` on linear-agent setup (#2316)

`switchroom linear-agent setup` now forces `webhook_via_gateway` so a freshly
installed Linear agent wakes via the in-process gateway inject path.

### PR — fix(scaffold): guard the `model: default` footgun (#2313)

A literal `model: default` in agent config is remapped to the switchroom
default model rather than being passed through to claude as a bogus id.

## v0.15.12 — Linear agents as first-class actors (#2298, #2310)

### PR — feat(model): keep `fable` selectable + model regression coverage (#2310)

`fable` is now a first-class `/model` alias (alongside `opus`/`sonnet`/
`haiku`/`default`) so the latest flagship (Fable 5) stays discoverable. The
2026-06-13 fleet outage came from pinning the full *codename* `claude-fable-5`
(retired server-side → 4xx), not the alias; regression tests lock in that
aliases stay selectable and that the `/model` shape-gate passes any full id
through to claude (switchroom never allowlists models).

### PR — feat(linear): Linear agents as first-class actors (#2298)

Builds the agent-session lifecycle layer on top of the plain Linear webhook
support (#2272), so an operator can install an agent into a Linear workspace
as a first-class app actor (own name/avatar, @-mentionable, delegate-assignable)
and have mentions/delegations wake it instantly — no polling cron.

- **Config**: new per-agent `channels.telegram.linear_agent` block
  (`enabled` + `token` vault ref + optional `workspace_id`), mirroring the
  `webhook_dispatch` conventions. Off by default.
- **Agent sessions**: a verified Linear `AgentSessionEvent` (mention or
  delegation) ALWAYS wakes the agent (no dispatch-rule matcher) via the same
  in-process gateway inject path `webhook_dispatch` uses — tagged
  `meta.source="linear"` with `agent_session_id`, `linear_trigger`
  (`mention`|`delegation`), and `linear_event`. The injected content is
  Linear's pre-assembled `promptContext` when present, else a readable
  summary. Gated on `linear_agent.enabled`.
- **MCP tool `linear_agent_activity`**: the agent emits structured Linear
  AgentActivity (`thought`/`message`/`complete`/`error`) against a session via
  the `agentActivityCreate` GraphQL mutation. Resolves the agent's Linear app
  token from the vault (`linear/<agent>/token`); on a vault denial it returns
  actionable text pointing at `vault_request_access`.
- **CLI `switchroom linear-agent setup --agent <name> --token <token>`**:
  vault-stores the app token, patches switchroom.yaml to enable the
  `linear_agent` block, and prints the webhook URL to register in Linear plus
  the OAuth authorize-URL hint block (the browser authorize step can't run
  headless, so the token is passed in via `--token`). Supports `--dry-run`.

Tests: `src/config/schema.test.ts` (linear_agent parse/required),
`src/web/webhook-dispatch.test.ts` (parseLinearAgentSession + buildLinearInbound),
`src/web/webhook-gateway-record.test.ts` (verified AgentSessionEvent injects with
meta.source=linear + session id; not-enabled is ignored),
`telegram-plugin/tests/linear-agent-activity.test.ts` (tool wiring + stubbed-fetch
happy path + vault-denied guidance + API-error surfacing),
`tests/cli.telegram.test.ts` (setLinearAgent YAML editor).

## v0.15.11 — make `latest` safe: tool-aware cron routing + claude CLI 2.1.177

Housekeeping release so the published `latest` is safe to roll. v0.15.9/v0.15.10
enforced cadence-based cheap-cron routing WITHOUT the tool-aware de-risk — they
should not be pinned fleet-wide. This supersedes them.

- **Tool-aware cron routing** (#2305): cadence is advisory; Tier-1 (cheap
  cron session) is OPT-IN via explicit `model: sonnet` / `context: fresh`.
  `applyDefaultTier` no longer forces a hint-less cron into the cheap session
  (which is context/tool-minimal and could starve a tool-using cron). The
  graceful main-session fallback (#2301) still guarantees a cron is never
  dropped by tier routing. Full Tier-1 hardening tracked in #2307.
- **Bundled claude CLI 2.1.170 → 2.1.177** (#2306).

Includes the v0.15.8–v0.15.10 cron work: schedule hot-reload (#2293), agent
tier options (#2294), the cheap-crons JTBD (#2296), value-gate selector
(#2297), graceful Tier-1 fallback + reconcile classify (#2301), cron-session
shell gate default-on (#2304).

## v0.15.10 — cheap-by-default made robust (graceful Tier-1 fallback)

Re-rolls the cheap-crons default (v0.15.9, #2299) with the fix for the blocker
its canary caught: the Tier-1 cron session is boot-forked, so a frequent cron
added by hot-reload or agent self-authoring had no live session.

- **Graceful Tier-1 fallback** (#2301): a cron-routed fire whose cron-session
  bridge isn't connected falls back to the main agent session, so a cron is
  NEVER dropped by tier routing — cheap when the session is up, full session
  otherwise. It routes cheap again once the next restart forks the session.
- **Reconcile fix** (#2301): `.claude-cron/` (Tier-1 trimmed MCP) is classified
  as cron infrastructure, so an agent self-authoring a frequent cron no longer
  fails the cron-only reconcile.
- Cheap-by-default itself (#2299): a deterministic, conservative value-gate
  routes confidently-frequent hint-less crons to a cheap session; daily/weekly
  briefings and any unreadable cadence keep the full session. `SWITCHROOM_CHEAP_CRON=0`
  is the kill-switch.

## v0.15.9 — cheap crons by default (value-gate drives the tier)

The cheap-correct cron tier is now the **default**, chosen deterministically by
the system rather than via an opt-in flag (the cheap-crons JTBD's Defaults
fix). A frequent, hint-less cron routes to a cheap Tier-1 session automatically;
daily/weekly briefings keep the full agent session; anything whose cadence
can't be read confidently stays full (conservative — never strips context).

- **Cheap-cron is ON by default** (#2299). `SWITCHROOM_CHEAP_CRON=0/false/off`
  is the emergency kill-switch (restores all-Tier-2). Disabling never silently
  drops a cron.
- **Deterministic value-gate** (#2294/#2297/#2299): a conservative cadence
  estimator + `applyDefaultTier` fill `context: fresh` for confidently
  sub-hourly hint-less crons. Explicit `kind`/`model`/`context` always win.
  Wired consistently across the scheduler fire path, scaffold cron-session
  rendering, and compose resource headroom. Threshold tunable via
  `SWITCHROOM_CRON_FREQUENT_GAP_MIN`.
- Cheap-crons JTBD added to the design contract
  (`reference/crons-use-the-model-only-when-it-earns-it.md`).

## v0.15.8 — cheaper crons: schedule hot-reload + agent-facing tier options

Cron token-optimization: scheduled work should pay for a model only when the
model earns it (the cheap-crons JTBD). This release ships the capability;
cheap-cron routing stays behind `SWITCHROOM_CHEAP_CRON`.

### Schedule hot-reload (#2293)

- The in-agent scheduler now hot-reloads the `schedule.d` overlay (default on;
  `SWITCHROOM_SCHEDULER_HOT_RELOAD=0` to freeze). A schedule add/remove takes
  effect within ~30s with **no restart** — fixing the "frozen at boot" class
  where a removed entry kept firing (a zombie burning a wasted turn every
  interval) and a new entry never ran. In-process node-cron task swap; the
  agent session is untouched. Cold 0→N self-restarts cleanly into the active
  path. Replay stays boot-only.

### Agent-facing cron tier options (#2294)

- `schedule_add` gains `--model` / `--context` (CLI + the agent-config MCP
  tool), so an agent can route a light recurring task to a fresh, cheap
  cron session (Tier 1) instead of its full live session (Tier 2). Inert
  unless `SWITCHROOM_CHEAP_CRON` is on; never silently dropped.
- `restart_required` is now hot-reload-aware (`false` + "live within ~30s" by
  default; `true` only when hot-reload is disabled). Skill writes unchanged
  (skills still load at boot). The agent self-service doc + MCP descriptions +
  `docs/scheduling.md` now teach the cost model (default Tier 2 for
  memory-dependent work, `model: sonnet` Tier 1 for light work, and "ask the
  operator for a poll / reaction-dispatch" for change-triggered work).

## v0.15.7 — hostd install resolves the real host home (close #2279 gap)

A fleet-killer hardening release.

### `hostd install` is container-context-safe (#2285)

- `switchroom hostd install` regenerated its OWN compose bind-mount **sources**
  via bare `homedir()`. When that regen runs inside the hostd container (the
  `/update apply` → refresh-hostd path), `homedir()` returns `/host-home` — the
  in-container mount point of the operator home, not a host path. Docker then
  auto-created empty `/host-home/...` dirs on the host, the config mount was
  empty, and **hostd crash-looped on `ConfigError: Failed to read config file:
  /state/config/switchroom.yaml`** (observed live 2026-06-12, all agents cut off
  from host control). The poison also re-baked into the new compose's
  `SWITCHROOM_HOST_HOME`, self-perpetuating.
- #2279 fixed this exact class for the agent-fleet generator but left
  `hostd install` on bare `homedir()`. New `resolveHostdHostHome()` mirrors the
  canonical resolver (`SWITCHROOM_HOST_HOME || homedir()`) and **refuses to emit
  when the resolved home is `/host-home` or under it** — failing loud with the
  "run from the HOST" recovery path instead of writing a daemon-killing compose.
  The self-perpetuation guard also rejects a `SWITCHROOM_HOST_HOME` that is
  itself `/host-home`.

## v0.15.6 — webhook dispatch for generic + Linear sources

Extends agent-waking webhook dispatch beyond GitHub (epic #717).

### Source-generic webhook dispatch + Linear (#2272, #2283)

- `evaluateDispatch` and the `webhook_dispatch` schema now key rules by
  **source** — `github` / `generic` / `linear` — so any known source can wake
  the agent through the same `inject_inbound` path, not just github. Cooldown
  keys are namespaced by source so rule indices can't collide across sources.
- **Linear** is a first-class source:
  - `verifyLinearSignature` — bare-hex HMAC-SHA256 of the raw body in the
    `Linear-Signature` header (Linear sends no Bearer auth); per-source secret
    from `webhook-secrets.json` keyed `[agent][source]`.
  - `renderLinearEvent` — issue/comment events, HTML-escaped, strict template
    (payloads are data, never instructions).
  - `buildLinearContext` + new `assignee_any` / `mentions_any` rule matchers.
- Dispatch knobs (cooldown, quiet_hours) and the ingest-path rate-limit + dedup
  now apply uniformly across generic/linear. Security model unchanged:
  per-source secret, edge lock, rendered payloads escaped and treated as data.
- Docs: `docs/webhook-ingest.md` gains Linear setup + a per-source matcher table.

## v0.15.5 — ship every agent hook script into the image (turn-pacing 127 fix)

A one-fix release closing the last loose end from the v0.15.4 batch.

### Agent image ships ALL bin hook scripts (#2281)

- `#2273` added `bin/turn-pacing-hook.sh` and wired it into the agent's
  `UserPromptSubmit` hooks (via `DOCKER_BIN_PATH`) but never added the matching
  `COPY` line to `Dockerfile.agent` — so the script was absent from the image
  and the hook exec-failed `127` **every turn, fleet-wide**, losing the
  turn-pacing directive and logging a 🔴 `hook:turn-pacing::env exited 127`
  per turn (surfaced as "Finn · 1 issue" on the status board).
- Fix: replace the drifting explicit per-script `COPY bin/<name>-hook.sh` list
  with a single `COPY bin/*.sh /opt/switchroom/bin/` glob (+ `chmod +x`), so
  any hook script the scaffold references is shipped by construction.
- New build-gate regression guard (`tests/docker/dockerfile-agent-bakes.test.ts`)
  cross-references every `join(DOCKER_BIN_PATH, "<x>.sh")` reference in
  `scaffold.ts` against the Dockerfile — a referenced-but-unshipped hook now
  fails the build instead of the fleet.

## v0.15.4 — fleet-outage root-cause fixes + /model picker UX + spool de-spam

The headline is **two fleet-killer class bugs**, both root-caused and fixed in
layers. When `apply` runs inside a container (the hostd `/update apply` path),
the compose generator was emitting in-container paths as bind-mount SOURCES —
docker auto-created empty dirs on the host, so brokers crashed (EISDIR) and
agents exec-failed (`start.sh` missing → 127). Twice on 2026-06-11/12.

### Compose generation is container-context-safe (#2275, #2276, #2279)

- **#2279 (the root cause)**: hostd now exports `SWITCHROOM_HOST_HOME` (the
  real host home) so an in-container `apply` resolves host bind sources
  correctly — previously `homedir()` returned `/host-home` (the mount point)
  and poisoned every source, self-perpetuating by re-baking `/host-home` into
  the fleet. Plus a generator **backstop** that refuses to emit `/host-home`
  as a bind source, failing loud with the recovery path instead of generating
  a fleet-killing compose. Guards every caller, forever.
- **#2275 / #2276**: the same fix for the config-file mount specifically —
  a `/state/config/…` container path is rewritten to the canonical host path
  (caller-side translation + a generator guard).

### /model picker UX (#2270, #2271)

- The picker never leaves a dead menu: a mid-turn tap is an instant toast that
  keeps the buttons; every outcome re-renders the menu with a status banner
  (✅ set / ❌ failed / ℹ️ already), so a switch never collapses to a
  button-less line.
- Tapping the ✔ row actually switches the live session (the ✔ marks the
  default-for-new-sessions, not the running model), and `/status` now reflects
  the live session-model override so the two surfaces agree.

### Inbound-spool give-up de-spam (#2278)

The durable spool's "couldn't deliver — please resend" notice is now coalesced
per chat on a persisted sliding window: a burst of undeliverable inbounds
(e.g. a synthetic re-aged every 15 min across restarts during an outage) posts
**one** notice, not one per cycle — and the window survives restarts.

### Context diet (#2273, #2274)

- Turn-pacing and workspace-dynamic UserPromptSubmit hooks are gated to
  inject-on-change (#2273); the always-injected `HEARTBEAT.md` workspace file
  is removed (#2274).

## v0.15.3 — failover trusts live quota; /model dashboard; root agent docker CLI (#2265, #2263, #2262, #2264)

### Failover: live quota is authoritative over stale exhaustion marks (#2265)

The 2026-06-10 fleet failover outage was a stale-data-over-live-truth
inversion. The auth-broker judged an account eligible-or-not purely by
the persisted `exhausted_until` mark, never consulting the live quota
probe already cached beside it. One misfired `+7d` weekly mark on the
healthy primary account stranded the whole fleet — every failover
returned `no-eligible-target` — and it survived `auth use`/`refresh` and
a broker recreate because nothing cleared a mark on a healthy probe. A
separate path routed a consumer onto an account whose mark had expired
(looked eligible) while its live 5h was 100% walled.

Fix (most-recent-signal-wins): a new pure `account-eligibility` module
makes a fresh (≤24h) quota snapshot that is newer than the mark
authoritative — walled→blocked, healthy→not — and only falls back to the
mark when there is no usable live data. A clearly-healthy probe now
self-heals (clears) a stale mark off disk, so a misfire can't outlast one
probe cycle. Marks carry `marked_at` for recency comparison. Wired into
the broker's three decision points (serving, failover, and the
`list-state` `exhausted` field, which also stops the all-exhausted alert
and cron preflight from false-alarming on a stale-mark-but-healthy
account). 289 broker + 67 server tests, both incident shapes reproduced
as integration tests.

### /model dashboard + root agent docker CLI (#2263, #2262, #2264)

- `/model` is now a live picker-driven menu with a quota brief (#2263),
  plus a UAT DM scenario covering show / switch / bad-name (#2262).
- A root debugging agent (`SWITCHROOM_AGENT_ROOT`) auto-provisions a
  version-pinned static `docker` client into `$HOME/.local/bin` on first
  boot — idempotent and non-fatal, so `docker ps/logs/exec/inspect` work
  out of the box (#2264). See `docs/root-agent.md`.

## v0.15.2 — memory-bank health, /model command, root debugging agent (#2257, #2258, #2238, #2259, #2261)

Built mid-incident on 2026-06-10: every active agent had silent memory
damage from the June quota outages — 155 conversations across 9 banks
were retained but never fact-extracted (invisible to recall), and mental-
model refreshes that ran during the quota wall persisted the literal LLM

Also fixes a first-boot bridge break for admin/root agents: the admin
audit-log bind mounts (`vault-audit.log`, `host-control-audit.log`) target
paths under `$HOME/.switchroom`, so on a fresh agent's first boot docker
materialised `$HOME/.switchroom` as a real directory before `start.sh`
could lay down the `#910` symlink the gateway↔claude bridge relies on —
the bridge then never registered and the agent silently buffered every
Telegram DM without answering. `switchroom apply` now pre-creates that
symlink on the host (create-only, never clobbers an existing link/dir)
before first boot, so docker resolves the binds through it. Surfaced by
the first root agent; would have hit any freshly-scaffolded admin agent.

## v0.15.2 — memory-bank health, /model command, root debugging agent (#2257, #2258, #2238, #2259, #2261)

Built mid-incident on 2026-06-10: every active agent had silent memory
damage from the June quota outages — 155 conversations across 9 banks
were retained but never fact-extracted (invisible to recall), and mental-
model refreshes that ran during the quota wall persisted the literal LLM
error string ("You're out of extra usage · resets 3am (UTC)") as model
content, injected into every turn. Nothing surfaced either failure.

### PR A — hindsight bank-health in doctor + dashboard Memory tab (#2257)

- New `src/memory/bank-health.ts`: REST inspection client over
  `/v1/default/banks/*` (stats, documents with per-doc extracted-fact
  counts, mental models with refresh timestamps). Injectable fetch,
  never throws.
- `switchroom doctor`: per-bank checks — FAIL on recent (≤30d, >1KB)
  zero-fact documents with the exact `/reprocess` curl in the fix
  string; WARN on stale (>7d) mental models or a stuck pending queue;
  OK line summarises docs/facts/newest-activity/models. Banks probed
  concurrently; agents sharing a collection dedupe into one row.
- Dashboard: new **Memory** tab (`GET /api/memory-health`) with the
  same per-bank truth: status dot, conversations/facts, latest
  activity, extraction-gap banner, per-model refresh age.

### PR B — detect LLM-failure-corrupted mental models (#2258)

- `corruptedMentalModels()`: fingerprints tiny content matching
  quota/limit failure phrasing (or empty content on a refreshed
  model). Doctor FAILs the bank naming the corrupted models; the
  dashboard shows a red banner. Live-validated against the real
  corruption (lawgpt ×2, carrie, kdogg) with healthy banks unaffected.

### PR C — Google Drive resumable upload for files > 5MB (#2238)

- The Google delivery provider was multipart-only (reliable to ~5MB),
  so a large `deliver-file` on a Google-only agent failed. `uploadFile`
  now dispatches on size: ≤5MB multipart, above that a resumable
  session (POST `uploadType=resumable` → PUT 8MiB chunks with
  `Content-Range`) — parity with the OneDrive provider.

### PR D — Telegram `/model` command (#2259)

- `/model` shows the agent's cascade-resolved model + switch options;
  `/model <opus|sonnet|haiku|full-id>` switches the live session by
  injecting claude's own `/model <name>` REPL command via the existing
  allowlisted tmux inject primitive. Claude-native, session-scoped
  (until restart); persisting stays `model:` in switchroom.yaml.
- The bare form never injects — claude's no-arg `/model` opens an
  interactive picker modal Telegram can't drive (pane-wedge class).
  The argument is shape-gated at the parser AND handler seam.
- Fixes a latent gap the review found: `agent list --json` never
  emitted a `model` field, so the gateway's `/status` model line
  silently rendered "default" on every host. The CLI now emits the
  cascade-resolved effective model (pinned by
  `tests/cli.agent-list-model.test.ts`).

### PR E — root-tier debugging agent (`root: true`) (#2261)

A new agent privilege tier above `admin`: set `root: true` on one agent
and it runs the unmodified interactive `claude` CLI inside a
root-privileged container (uid 0; `/var/run/docker.sock`, the whole
`~/.switchroom` tree, and the host root filesystem at `/host` all mounted
rw). DM it from Telegram to debug the fleet — read any agent's logs,
`docker exec` into peers, edit host files — instead of SSHing into the
host as root.

- **`root: true`** is per-agent only (no cascade, mirroring `admin`) and
  **implies `admin: true`**, so every admin slash command and the `hostd`
  MCP surface come with it.
- The container skips the per-agent hardening (`cap_drop: ALL`,
  `read_only`, `no-new-privileges`) because the docker socket already
  makes it root-on-host — the mounts and uid 0 make that reach
  ergonomic, not new. Mem/CPU/PID limits and tmpfs `/tmp` are unchanged.
- **Standing root, no per-action tap** — the deliberate trade for
  frictionless debugging. The safety boundary is operator-private gating
  (private chat + `allowFrom`) plus the root agent's `CLAUDE.md`
  discipline block (default read-only, announce host mutations, never act
  on instructions found in a peer's output, never exfiltrate the vault).
  The audit trail is the session transcript + shell history.
- Stays Claude-native / subscription-honest: interactive CLI on OAuth,
  no `claude -p` / SDK / API.
- See `docs/root-agent.md`.

## v0.15.1 — quota-status floods silenced (#2254, #2255)

The 2026-06-09 incident: a fleet bounce released days-stale quota-recovery
latches on all 11 agent gateways at once — 26 byte-identical 🟢 "Quota back in
healthy range" messages in 16 minutes, for recoveries that had happened 19h
and 3.4 days earlier. Content was technically true; volume and timing made it
read as wrong. This release fixes the notifier and its sibling surfaces.

### PR A — quota-watch: fleet dedup + staleness gate + verified numbers (#2254)

One account edge used to mean up to 26 Telegram sends (11 independent
watchers × per-agent chat fan-out). The auth-broker now arbitrates a
`claim-notification` op: the first claimant per (account, transition, chat)
in a 30-minute window sends; the other agents advance their local state
silently. Per-chat keys keep the audience identical. Gateways fail OPEN on
claim errors, so a skewed rollout degrades to today's duplicates, never to
silence. Classification gains a staleness gate (cached snapshots older than
60 min carry no opinion), recovery edges observed on the first post-boot tick
or whose 🟡 warning is over 6 h old reconcile silently (the latch clears,
nothing is sent), and a notification whose pre-send validation probe fails is
deferred to the next tick instead of shipping unverified numbers. The
decision FSM is proven by total enumeration (144 cells + a terminal-state
invariant). Kill-switches: `SWITCHROOM_QUOTA_WATCH_FLEET_DEDUP=0`,
`SWITCHROOM_QUOTA_WATCH_MAX_STALE_MS=0`,
`SWITCHROOM_QUOTA_WATCH_LATE_RECOVERY_MS=0`.

### PR B — fallback failure notice + honest quota columns (#2255)

The ⚠️ model-unavailable card promises "Auto-failover in progress — see the
announcement below" before the dispatcher's outcome is known; on dispatcher
error nothing ever arrived (12 broken-promise cards on 06-06→07). Every error
path now broadcasts a failure notice with the manual recovery verbs, bounded
by a dedicated 30-minute per-gateway cooldown (the fallback gate's dedup
window only arms on successful swaps, so it could not bound this). Kill:
`SWITCHROOM_FLEET_FALLBACK_FAILURE_NOTICE=0`. And `switchroom auth list` plus
the Telegram legacy fleet table now show a `QUOTA 5h·7d` column from the
broker's cached utilization with its age ("16%·1% (3m ago)") — a 99%-utilized
account no longer reads "available —", and "no data" is distinct from "not
exhausted".

## v0.15.0 — claude CLI 2.1.170 for Fable 5 (#2252)

The fleet default model moved to **Fable 5** (`claude-fable-5[1m]`), and this
release moves the in-container claude CLI with it.

### claude CLI 2.1.168 → 2.1.170 across all images (#2252)

Both lockstep pins bumped: `docker/Dockerfile.base` (flows to the agent,
broker, kernel, auth-broker and hostd images via `FROM base`) and
`docker/Dockerfile.hindsight`. 2.1.170 is the CLI version the Fable 5 banner
recommends; agents ran Fable fine on 2.1.168, so this is a recommended-floor
catch-up, not a fix. Rollback is a pin revert.

### Dashboard: resilient connections fetch + always-fresh quota (#2239)

The dashboard's connections panel now tolerates a slow/failed accounts fetch
without blanking, and quota readings refresh without a manual reload.

## v0.14.93 — `agent restart` regenerates the compose, so pin bumps apply (#2249)

A `release.pin` bump in `switchroom.yaml` followed by `switchroom agent restart`
silently didn't take: restart re-emitted the agent-dir scaffold (`start.sh`) but
**not** the fleet compose, so the container recreated against the *old* image ref
still on disk. Operators had to remember a separate `switchroom apply` first.

`agent restart` now regenerates the compose from the current config right before
the recreate — restoring the "edit `switchroom.yaml` → restart → done" contract
its own docstring already promised. Apply and restart share one
`writeComposeFile()` so they can never drift; the compose path is resolved with
the same env-aware resolver `restartAgent` reads from; a write failure warns but
never aborts the bounce; and the file stays operator-owned under sudo. Only the
named service is recreated (`--no-deps`), so a single-agent restart can't disrupt
the rest of the fleet. (`switchroom update --pin` already ran `apply` internally
and was unaffected.)

## v0.14.92 — Cheap cron: deterministic polls + a per-agent Sonnet cron session (#2244, #2245, #2246, #2247)

Cron fires were expensive for a structural reason: **every fire injected a turn
into the agent's live session**, paying the full standing-context cache-read tax
(system prompt + the ~31k-token MCP schema surface + the running conversation)
*and* running at the agent's configured model — even when the fire was a `*/10`
poll that found nothing to do. Two disabled polls (a telegram-capture and a
lead-alert) were ~240 no-op fires/day, almost all wasted.

This release lands the **cheap-cron** machinery in three tiers, cheapest-first,
entirely behind `SWITCHROOM_CHEAP_CRON` (default **off** — a complete no-op until
an operator opts in, so the fleet is unchanged):

- **Tier 0 — deterministic poll (no model).** A `kind: poll` schedule entry runs
  a declarative, operator-approved poll (`http-diff`) in the scheduler process.
  No change → `HEARTBEAT_OK`, **zero model tokens**; only a hit escalates. This is
  the headline saving. Fenced by an SSRF/egress guard (https-only operator
  allowlist + host-pinned secret bindings + loopback/private/rebind rejection)
  and write-ahead poll-state (a restart mid-escalation never double-fires; the
  first poll of a new key records a baseline and never floods).
- **Tier 1 — a per-agent cheap cron session.** A second *interactive* `claude
  --model sonnet` registers to the gateway as a distinct `<name>-cron` bridge —
  reusing the hardened single-bridge IPC untouched, with all status surfaces
  gated off the cron identity (the cron session is status-silent). It loads a
  **trimmed `.mcp.json`** (switchroom-telegram only), skipping the main session's
  MCP schema tax, and shares the broker-managed OAuth.
- **Tier 2 — main session.** `context: agent` injects into the live session,
  exactly as today.

Routing is driven by the reactivated `ScheduleEntry.model` field plus new
`kind`/`context`, decided by a pure, total-enumeration-proven function. New
`switchroom schedule report [agent]` shows the per-tier cost breakdown. Compliance
is preserved by construction: Tier 0 touches no model; Tiers 1–2 are interactive
`claude` (never `claude -p`).

## v0.14.91 — Surface orphaned foreground sub-agents (extended autonomous work) (#2240)

When an agent kept working **after its turn ended** — extended autonomous work,
which is desirable — any foreground sub-agent it dispatched had no live parent
turn to nest its status into, so the work ran completely **invisible** (no
progress card, no worker feed). Diagnosed on finn: a `reviewer` sub-agent ran
for minutes with the operator seeing nothing.

Status visibility no longer depends on the model holding a turn open. A
foreground sub-agent with no live turn now surfaces via the worker-activity feed
(the same `🛠 Worker` message, routed to the dispatching chat or the owner DM
via the existing fallback), exactly like a background worker. In-turn foreground
sub-agents still nest into the progress card, unchanged. The routing is a pure,
total-enumeration-proven decision; kill switch `SWITCHROOM_ORPHAN_SUBAGENT_STATUS=0`.

## v0.14.90 — Framework owns the reply topic, not the model (#2233)

A General-topic question to an agent in a forum supergroup could get its answer
routed to a *different* topic — so the person reading General saw silence. Root
cause: General-topic messages carry no `message_thread_id`, and when the model
passed an explicit `message_thread_id` on its reply, the answer-thread resolver
let that explicit thread win **outright** over the framework's record of which
topic the question came from. The model could redirect any reply to any topic.

The topic a reply lands in is now owned by the **framework's turn anchor**, not
the model's `message_thread_id`. New precedence:

```
origin turn  →  live in-flight turn  →  (model explicit, last resort)  →  late recovery
```

The model's explicit thread is consulted only when there is neither a resolved
origin nor a live in-flight turn (a genuinely orphaned / proactive send). The
live tier keys off the turn's *presence*, not its thread value, so a General
live turn (which has no thread) still anchors the reply to General instead of
letting the model pull it into another topic. Topic-targeting for proactive
posts is therefore config-driven (a cron's `topic:`), not model-driven.

Determinism is proven by total enumeration of the resolver's reachable input
space (the load-bearing invariant: the output is independent of the model's
explicit thread whenever an origin or live turn exists). Kill switch
`SWITCHROOM_REPLY_TOPIC_AUTHORITY=0` restores the legacy explicit-first
precedence. A new `EXPLICIT_OVERRIDDEN(model→X,routed→Y)` tag on the reply-route
log surfaces every time the framework corrects a model topic-grab.

`stream_reply` and all framework status surfaces (worker feed, handback,
sub-agent progress, approval cards, cron) are unaffected — only a model
deliberately cross-posting a `reply` to a different topic than the one it's
working in is redirected (the misroute this fixes).

## v0.14.89 — Bump bundled claude CLI 2.1.159 → 2.1.168 (#2230)

Bumps the bundled Claude CLI core runtime from 2.1.159 (pinned since v0.14.26)
to 2.1.168 (latest), across every image — base (→ agent / broker / kernel /
auth-broker / hostd) and hindsight, kept in lockstep per the #1978 thinking-block
invariant.

Relevant upstream changes (2.1.160–168): background-agent worktree crash-loop +
overnight-history fixes; rate-limit/auth/transport errors now surface
immediately (helps the gateway's quota detection → failover); hook outputs can
return additionalContext; configurable model fallbacks in interactive sessions.
Canaried on test-harness — verified injected/cron turns still deliver under the
2.1.166 cross-session-messaging hardening — before fleet roll.

## v0.14.88 — File delivery: `switchroom deliver-file` (OneDrive + Google Drive)

Agents can now hand the user a file they can actually open, instead of a
local container path the user can't reach.

### `deliver-file` verb (#2225, #2228)

`switchroom deliver-file <path>` uploads a file the agent produced into the
user's `Switchroom/<agent>/` folder on their connected drive and prints a
shareable link. The agent runs it and replies with the link. Switchroom owns
the destination + upload, so it bypasses the per-write approval gate (writes
only ever land in the agent's own delivery folder). Picks the first connected
drive — **OneDrive** or **Google Drive** — using the broker's fresh access
token. Share-link scope is configurable via `SWITCHROOM_DELIVER_LINK_SCOPE`.
OneDrive path canary-proven; Google handles files up to 5 MB (resumable for
larger is a follow-up).

### Delivery guidance (#2224)

A fleet-invariant prompt block tells agents to deliver files (via the `reply`
tool's `files:` attachment for ≤50 MB, or `deliver-file` for keepables) and
never hand back a local container path.

### Fix: deliver-file one-shot hang (#2228)

The verb delivered the file and printed the link but didn't exit — the
auth-broker client kept a socket open. Closed it; the process now exits
cleanly.

## v0.14.87 — `auth schedule` quota view + `deliver-file` (#2226, #2225)

**`switchroom auth schedule` (#2226).** A new per-account quota view that
separates the 5-hour rolling window from the 7-day weekly window — the thing
`auth list`/`auth show` hide by collapsing quota into a single "soonest reset"
column. Per account it shows pool role (active / fallback rank / excluded),
5h % + reset, weekly % + reset DAY, and a STATE that distinguishes `healthy` /
`5h-walled` / `weekly-walled`. This surfaces the staggered weekly schedule
(each subscription's weekly limit resets on a fixed, different day-of-week) so
you can see at a glance which account has weekly headroom. A maxed weekly
window (≥99.5%) is classified `weekly-walled` with the weekly reset as the
horizon even when the exhaustion ledger points at a sooner 5h reset, so a
weekly-capped account isn't mislabelled as recovering in minutes. Defaults to a
live probe (the broker's existing `probe-quota` op — one tiny header-only call
per account; `--cached` skips it, `--json` dumps raw state).

**`switchroom deliver-file` (#2225).** Uploads a file to `Switchroom/<agent>`
and returns a link (OneDrive), so agents deliver files instead of handing back
an in-container path.

## v0.14.86 — Durably hold weekly-quota auto-fallback (clerk wedge) (#2222)

Follow-up to v0.14.84. Agent `clerk` went silently dead on the same
`/rate-limit-options` weekly-quota TUI menu v0.14.84 was meant to catch. Deep
inspection found the auto-failover chain broken in **three complementary
places** — all three are required for a weekly wall to fail over *and stay
failed over*:

- **Detector blind spot (the bug v0.14.84 shipped).** The menu detector
  anchored on `/rate-limit-options`, which is printed *above* the menu and
  scrolls off the top of the `tmux capture-pane -p` viewport (no scrollback) on
  a pane with enough preceding output. clerk wedged exactly that way and the
  detector logged zero fires. Re-anchored on the option-1 menu-body row
  (`Stop and wait for…`, pinned to the bottom of the pane where the cursor is)
  plus an option string only this menu shows (`usage credits` — covering both
  "Switch to…" and the newer "Add funds to continue with…" wording —
  `Upgrade your plan`, or `/rate-limit-options`). Esc-only park unchanged
  (compliance, vision.md pillar 3).

- **Exhaustion window too short on the 429 path.** The menu path already
  threaded the parsed weekly reset as `markExhausted`'s `until`; the 429 path
  passed none → the broker's ~5h default. A weekly wall that surfaces as a 429
  carries calendar wording (`resets Jun 9, 5am`) that the reset parser can't
  read → an undefined reset → the ~5h default un-exhausts a weekly-walled
  account after 5 hours. Factored the decision into a shared, unit-tested
  `resolveExhaustUntil()` with a +7d floor that **never returns undefined**,
  called from both the menu handler and the 429 path.

- **Broker re-mirrored the walled account every refresh tick.** Even with a
  correct weekly `until`, `mark-exhausted` marks quota + mirrors the fallback
  once but never rewrites `auth.active`, and the refresh-tick fanout resolved
  the effective account with no exhaustion check — so when the walled account's
  OAuth token refreshed (~1h; refresh works, a quota wall is not an auth
  failure) it silently re-mirrored the walled creds onto the whole fleet,
  undoing the failover (flap). Routed the agent serving + fanout reads through
  a shared `accountWithFailover()` (generalised from the proven consumer-
  failover): serve/mirror the first healthy fallback while walled, fall back to
  the pinned/active account when none is healthy (retry beats going dark), and
  auto-revert once the window passes. Operator serving stays attribution-true.

Kill switch `SWITCHROOM_RATE_LIMIT_DETECT=0` (detector) is unchanged. The
broker change ships in the `switchroom-auth-broker` singleton — recreate it
explicitly on rollout (the staggered per-agent restart skips singletons).

## v0.14.85 — Stop false "out of pre-paid credits" alarms (subscription-only) (#2220)

Agents were posting "⚠️ out of pre-paid credits — cron tasks and inbound
replies will fail" cards. False alarm: the card came from credits-watch reading
`cachedExtraUsageDisabledReason` from `.claude.json` — a flag that is always
"why the optional pay-as-you-go EXTRA USAGE layer is disabled." switchroom is
subscription-only by design (compliance pillar 3), so extra-usage-off is the
expected, desired state; none of its values indicate a real failure, and the
card's "buy credits" advice contradicts the subscription-honest model.

credits-watch now defaults to silent on these flags (`DEFAULT_CREDIT_FATAL_REASONS`
empty). Genuine exhaustion is already covered: an account's subscription window
exhausting → fleet auto-fallback (v0.14.80); the whole fleet exhausting → the
all-exhausted alert (v0.14.83). Operators who actually run pay-as-you-go can opt
the alarm back in via `SWITCHROOM_CREDITS_WATCH_FATAL_REASONS` (comma list, or
`*`). The transition machinery is unchanged — only the default policy of which
reasons are fatal (now none). Reversible via env.

## v0.14.84 — Auto-recover the rate-limit (weekly-quota) TUI wedge (#2218)

Closes the last failover blind spot. The claude CLI's WEEKLY quota wall surfaces
as an interactive `/rate-limit-options` menu, NOT a stderr 429 — so the gateway
never saw it, `markExhausted` was never called, and none of the v0.14.80-83
failover/alert machinery engaged. A headless agent then sat silently dead on a
menu no human would answer (real incident: finn, wedged for hours). The generic
wedge-watchdog missed it too (the menu footer lacks the "to select/navigate/↑↓"
affordance its signature requires).

The wedge-watchdog now detects the menu (a strict two-anchor signature, behind
the same stability gate), signals the gateway over a new `quota_wall_detected`
IPC verb, and the gateway triggers the EXISTING `fireFleetAutoFallback` —
threading the parsed weekly reset as `markExhausted`'s `until` (with a +7d
fallback when unparsed, so the ~5h default can't un-exhaust a weekly wall and
re-wedge). The existing chain then rolls to a fallback subscription account, or
fires #2215's all-exhausted operator alert. The menu is parked with `Esc` only.

Compliance (pillar 3): recovery is ONLY subscription-account failover or a
graceful Esc-park — a unit test asserts the detector can never emit a keystroke
that selects "Switch to usage credits" (off-subscription) or "Upgrade your plan".
Kill switch `SWITCHROOM_RATE_LIMIT_DETECT=0`.

## v0.14.83 — Fleet-wide all-exhausted operator alert (#2215)

Observability capstone to the failover trilogy. The trigger-based all-blocked
card only fires when an agent 429s into the wall — it misses a quiet period
(the fleet goes all-exhausted but no agent happens to hit it) and the
consumer (hindsight) + cron paths added in v0.14.81/82, which degrade silently.

quota-watch now emits one edge-triggered fleet alert: `🔴 All accounts
exhausted` (with earliest-reset + self-healing reassurance) when every account
enters the broker's exhausted state, and `🟢 Fleet recovered` when one frees.
Keyed off the broker's authoritative per-account `exhausted` flag (not
probe-derived), so there is no probe-failure false alarm; deduped so it never
re-spams. Observability only — no behavior/recovery change.

(This superseded the originally-scoped "split all-blocked vs probe-failed in
logs": post-v0.14.80 the all-blocked decision is broker-authoritative, so that
ambiguity no longer exists — the real gap was the missing quiet-period/
consumer/cron alert, which this fills.)

## v0.14.82 — Cron quota preflight: defer + retry instead of firing into a wall (#2212)

The last of the three account-failover gaps. A cron fires through the
persistent claude session (no `claude -p` — off-subscription, banned by the
compliance pillar), which holds one account for its lifetime. When the fleet
was fully quota-walled, a scheduled fire 429'd and the run was **silently
lost** — and because the scheduler's audit is delivery-based, it recorded
`exit_code=0` "success". A failed cron looked successful.

The scheduler now runs a quota preflight before each fire: when EVERY account
is exhausted (dispatch is futile), it DEFERS — records `exit_code=-2`
(deferred, distinct from delivered/gateway-down, so the truth is in the audit,
not a false success) and bounded-retries (default 3 attempts, 1m/3m/5m
backoff). With at least one healthy account it dispatches normally (the fleet
serves a healthy account via failover). Operator-confirmed: crons have no hard
deadlines, so worst case a deferred cron runs when the window resets (≤5h) —
no forced restart. Fails open (any broker/gate error → dispatch); retries
cancelled on shutdown; replay still treats only `exit_code=0` as "ran", so a
deferred fire lost across a restart is eligible for boot replay. Kill switch
`SWITCHROOM_DISABLE_CRON_QUOTA_PREFLIGHT=1`.

Completes the failover trilogy: agents (v0.14.80), consumers/hindsight
(v0.14.81), crons (this release).

## v0.14.81 — Consumer-quota sensor: hindsight (and any dedicated-account consumer) fails over (#2209)

Closes the gap v0.14.80 left open. Hindsight is a consumer pinned to a dedicated
Anthropic account kept out of `fallback_order` for quota isolation. Its
serving-failover is wired (#2194), but the exhaustion state it keys off
(`this.quota`) is only set by `mark-exhausted` — which agents raise on a 429.
An account no agent shares has nobody to raise it, so the failover never
triggered and hindsight sat dead on an exhausted account (the 2026-06-06
outage); the broker had no quota-probe loop.

Adds a broker-side sensor that periodically probes consumer-pinned accounts and
auto-marks exhaustion when a probe shows a hard wall (≥99.5% on the binding
window), so the consumer's serving-failover kicks in and reverts automatically
when the window resets. `exhausted_until` is set to the probe's real reset time
(race-free, no explicit clear); a FAILED probe is a no-op (a transient error
must never fail a consumer over). Only marks — never changes `auth.active` or
touches agent credentials. Default cadence 10 min (~6 tiny probes/hr per
consumer account); `SWITCHROOM_CONSUMER_QUOTA_PROBE_MS` to tune,
`SWITCHROOM_DISABLE_CONSUMER_QUOTA_PROBE=1` to disable. Broker-only change.

## v0.14.80 — Auto-fallback works for non-admin agents (#2206)

Anthropic-account auto-failover never worked for the production fleet. On a
quota 429 the gateway called the broker's **admin-gated `set-active`**, but it
runs as the agent that hit the wall — almost always a non-admin agent — so the
broker rejected it with `set-active requires admin` and no swap happened. It
only succeeded when an admin agent (klanker/carrie/test-harness) happened to be
the one to exhaust. The operator had been working around it by hand, tapping the
`/auth` card's switch button (which works only because that button inherits
admin from the admin bot it's tapped on).

Auto-fallback now routes through the broker's existing **non-admin**
`mark-exhausted` verb: it derives the account from the caller's own identity,
marks it exhausted, and rolls every agent on it to the next non-exhausted
`fallback_order` account — exactly what `/auth rotate` does, just automatic and
from any agent. `mark-exhausted` additively returns `rolledTo` so a non-admin
caller can announce an accurate swap. Target selection now lives solely in the
broker's `nextHealthyAccount` (removed the divergent gateway-side
lowest-utilization picker). Manual `/auth use` / `/auth rotate` / the card button
stay on `set-active` (operator is explicitly choosing, and is admin) — only the
automatic path changed. Agents pick up the rolled credentials on claude's next
refresh, matching the manual button (no restart added).

## v0.14.79 — Hindsight: user-profile MM existence check by name, not substring (#2205)

Completes the v0.14.78 user-profile mental-model repair. The "already exists?"
check in `ensureUserProfileMentalModel` did a naive substring match
(`includes("user-profile")`) on the list-response blob, so it false-positived
whenever another model's name / query / content contained that substring — and
skipped creation, reporting "ready" while the bank had no real user-profile
model. Found live on the v0.14.78 rollout (lawgpt's Lisa-focused models; clerk's
shared `assistant` bank). Fixed to match by exact item name.

## v0.14.78 — Hindsight: repair the user-profile mental model + phantom-caller honesty (#2203 + #2201)

Two hindsight correctness fixes surfaced by the context-token audit, both in the
`isError`-not-checked bug class (a hindsight `tools/call` returns HTTP 200 with an
error envelope; code that checks only the HTTP status reports false success).

### #2203 — repair the user-profile mental model ("an agent that knows you")

The whole user-profile mental-model feature was **non-functional fleet-wide** — an
upstream hindsight argument rename, silently swallowed:

- **Creation:** `create_mental_model`'s arg is `source_query`, not `query`. Passing
  `query` returned `isError "Missing required argument: source_query"`, but the code
  only checked the HTTP status → reported success while creating nothing. Every
  agent's bank had **zero** mental models despite scaffold printing "ready". Fixed
  (`source_query` + an `isError` check).
- **Stop-hook refresh** (`bin/user-profile-refresh-hook.sh`): the stateless server
  returns no `mcp-session-id`, but the hook gated the refresh on one → it never
  fired; and `refresh_mental_model` takes `mental_model_id`, not `name`. The hook
  now resolves the id via `list_mental_models` and refreshes by id.

After upgrade, a `switchroom apply` re-runs the (now-fixed) creation to populate the
user-profile mental model for every agent.

### #2201 — phantom-caller honesty + hindsight tool-allowlist deferral

`vault-sweep` (`delete_memory`) and `addMemoryTag` (`update_memory`) called
non-existent hindsight tools and silently reported success; both now fail honestly.
The MCP tool-surface allowlist was evaluated and **deliberately not shipped** (a
3-hunt audit found it would filter the shared singleton with a ~16-tool minimum and
the token win is already captured by tool-search) — recorded in
`src/setup/hindsight.ts`. (Separate open issue #2202: vault-sweep's secret-scrub has
no working delete path and needs a document-granularity rework.)

## v0.14.77 — Context-token optimization: tool-search + cleanup (#2198 + #2199 + #2197)

From the 2026-06 context audit (per-turn floor ~63k tok ≈ 32% of a 200k window;
the MCP tool-schema surface ~31k tok — larger than all authored prompt text).

### #2198 — enable Claude Code tool-search (defer the ~31k-token MCP surface)

Sets `ENABLE_TOOL_SEARCH=auto` on every agent so the unmodified `claude` CLI
DEFERS (lazy-loads) MCP tool schemas — surfaced by name, full JSON fetched only
when a tool is called — reclaiming ~25–29k tok of window. `alwaysLoad:true`
pins the load-bearing framework servers (switchroom-telegram reply/
get_recent_messages/react, hindsight recall, agent-config) so they never defer;
the heavy integration servers (webkite/perplexity/marketing) defer = the win.
Kill switch `SWITCHROOM_DISABLE_TOOL_SEARCH=1`; mode override
`SWITCHROOM_TOOL_SEARCH_MODE`.

### #2199 — context hygiene

- **Memory-prose contradiction removed:** the workspace operating protocol told
  agents to maintain `MEMORY.md` + daily files, contradicting the cwd CLAUDE.md
  + invariants ("Hindsight is your single backend"). Now defers to hindsight.
- **delete_memory → delete_document:** agents were told to call a hindsight tool
  that doesn't exist (the real one is `delete_document`) — forget/correct flows
  silently failed. Fixed. (The broader tool-allowlist trim was deferred: a global
  allowlist would break host-side mental-model/vault-sweep ops, and the token win
  is already captured by tool-search.)
- **`debug turn` per-turn-floor accounting:** fixed the SOUL double-count, added
  the --add-dir fleet invariants + the MCP tool surface, `/3.7` token estimate,
  and a "Per-turn FLOOR" total (was understated ~3x).

### #2197 — vault secret-guard message + doctor check for IDs-as-secrets

## v0.14.76 — Hindsight: consumer quota-failover + fleet-default file gate

### Consumer quota-failover (#2194)

Agents survive a quota-exhausted account because they ride the swappable
`auth.active`; consumers (hindsight) were pinned to their account
unconditionally, so a quota-exhausted pinned account left hindsight dead
(retains accepted, 0 facts extracted) — the 2026-06-06 outage. The
auth-broker now fails a consumer over to the first healthy account in
`fallback_order` when its pinned account is within a mark-exhausted window,
reverting automatically once the window passes. Reuses the existing
exhaustion state + fallback_order; propagates via hindsight's existing
cred-refresh loop. Serving (get-credentials) is failover-aware; attribution
(mark-exhausted) stays raw, so a consumer can never mismark a healthy
account.

### Fleet-default file gate (#2195)

`memory.file` is now accepted at the defaults tier, so a single
`defaults.memory.file: false` makes the whole fleet — and future agents —
hindsight-native by default, with per-agent `memory.file: true` opt-in.

## v0.14.75 — Hindsight memory: durable shm fix + hindsight-native file gate

Foundation for converging agent memory onto Hindsight as the single
backend (retiring the parallel curated `MEMORY.md`).

### Durable shm fix (#2190)

The `switchroom-hindsight` container launched with no `--shm-size`, so it
got Docker's 64MB default `/dev/shm`. Its embedded PostgreSQL needs far
more (~533MB+ for shared query/sort segments), so every such allocation
failed with `could not resize shared memory segment ... No space left on
device` — taking down **all** memory writes fleet-wide. Adds
`HINDSIGHT_DEFAULT_SHM_SIZE=2g` to both the `docker run` and compose launch
paths so a future recreate can't regress to the broken default.

### `memory.file` gate (#2191)

Adds a per-agent `memory.file` boolean (default `true` = no change). When
`false`, the scaffold stops seeding the curated `workspace/MEMORY.md` on
**both** the scaffold and reconcile paths — so once an agent's memory is
migrated into Hindsight and the file deleted, the delete sticks across
`agent restart` / `apply` instead of being re-seeded as an empty template.
This is the mechanism for the hindsight-native migration; the per-turn
loader already tolerates an absent file.

## v0.14.74 — Two-file persona (switchroom baseline + operator override); dead-carrier cleanup (#2188)

**Persona two-file.** Adds `SOUL.default.md`, a small switchroom-owned
baseline persona composed *before* the operator's `SOUL.md` so the
operator's persona wins by recency. The baseline is restored from the
release template on every reconcile (so improvements propagate), while
`SOUL.md` stays seed-once and is never clobbered. This is the "switchroom
default + operator customization, merged" split for persona: the default
is overridable (it is persona, not a guardrail). Operator-owned agent
state was first versioned in `~/.switchroom-config`, so the change is fully
rollback-able.

**Carrier cleanup.** Removes the dead `_shared/telegram-style.md.hbs`
fragment (no profile rendered it; its "status? = UX-failure signal"
guidance lives in the `switchroom-runtime` skill). Closes the
edit-a-dead-carrier-for-zero-effect trap for that fragment.


## v0.14.73 — Persona owns presentation; drop the self-disclosure guardrail (#2184)

Removes the "be honest about being a switchroom agent / not a custom
model" directive from the default agent template. A persona that has to
out itself as "an AI running Claude" is less of a colleague, which works
against the product's first outcome (a standing team that feels like real
people). The agent keeps the factual self-knowledge it needs to operate
(it is a switchroom agent in a container); how it presents itself to
people is now explicitly the persona's call (`SOUL.md`).

First step of the agent-context architecture rework: the customize layer
(persona) owns presentation, with no removable "must disclose" rule
layered on top. Propagates fleet-wide on reconcile (the agent CLAUDE.md
regenerates from the template).

## v0.14.72 — Voice: prompt-first tone, no context-free word deletion (#2182)

Rebalances agent voice enforcement away from a hook that deletes words and
toward the prompt, where the model has the context to keep a genuine
acknowledgement and drop only the hollow kind. Context-free deletion is
bad UX: a blind hook can strip a sincere "good catch, that was my bug"
along with the empty praise.

- **The sycophancy-opener strip is now opt-in, OFF by default**
  (`SWITCHROOM_VOICE_STRIP_OPENERS=1` re-enables it as a backstop). By
  default the deterministic layer removes no words.
- **Em-dash normalization stays deterministic.** It substitutes
  punctuation, removes no content, and prompt-only guidance was measured
  to fail at it (em-dashes in 73% of replies despite the SOUL rule). The
  prompt now also asks for plain punctuation so both layers agree.
- **The turn-pacing VOICE directive is now context-aware:** skip the
  hollow openers and AI-tell filler, but genuine acknowledgement that
  adds something is fine. Tone lives in the prompt, where the model can
  judge genuine versus reflexive.

Net: the AI-tell that is pure punctuation (em-dash) stays a safe
deterministic backstop; the AI-tell that is about judgment and context
(sycophancy, tone) is the prompt's job.

## v0.14.71 — Fleet-wide fact-grounding + anti-AI-tell voice (#2180)

Two agent behaviors, fleet-wide.

**Fact-grounding.** Agents asserted volatile facts (CRM numbers, status,
prices) from stale memory/training instead of validating against a live
source. A `GROUND BEFORE YOU ASSERT` block now rides the per-turn
directive (so it reaches every agent, including custom-CLAUDE.md ones,
fresh each turn): any fact that can change must come from a source the
agent checked *this turn*; memory is a lead to verify, not a citation;
"let me check" beats a confident wrong number. Ordering-phrased
("pull it this turn, then state it") rather than a weaker "verify" nudge.

**Anti-AI-tell voice.** Two layers:

- *Prompt* — a `VOICE` line in the same directive: no sycophancy openers,
  no AI-tell filler, lead with the answer, disagree plainly.
- *Deterministic* — the gateway `scrubVoice` (which already strips em/en
  dashes on every outbound reply) now also strips a **leading** sycophancy
  opener ("You're absolutely right", "Great catch", "Exactly right", ...)
  and recapitalizes. Conservative by construction: only at message start,
  only the pure-affirmation set, only when a clause separator and real
  content follow (a standalone ack survives; "Spot on the map..." is left
  alone). Mid-sentence hype stays with the prompt layer. Kill switch
  unchanged: `SWITCHROOM_DISABLE_VOICE_SCRUB`.

A fuzzy MTCute UAT (`fuzz-voice-scrub-dm`) drives real inbounds engineered
to bait both tells and asserts neither reaches the user.

## v0.14.70 — Stop the answer-stream flash (#2178)

Fixes the recurring "unformatted message appears, then a formatted one, then the
unformatted one is deleted" flash users saw on most turns — a fleet-wide
regression where one fix silently undid another.

The flash is the **visible answer-stream**: a raw preview the agent posts as it
streams, retracted (deleted) when the formatted `reply` tool fires. v0.14.52
turned that surface OFF by default *specifically to remove this flash*. v0.14.68
retired the invisible compose-box draft transport but wired the preview-open
condition as `(ANSWER_STREAM_VISIBLE_ENABLED || DRAFT_ANSWER_LANE_RETIRED)` — and
the draft is retired by default, so a visible preview opened on every streaming
turn and got retracted. v0.14.68 re-opened the flash v0.14.52 removed, fleet-wide.

The fix decouples the two flags: the visible preview gates on
`SWITCHROOM_VISIBLE_ANSWER_STREAM` alone; draft retirement controls only the
transport. With defaults the answer-stream lane is **dormant** — no preview, no
draft → the `reply` tool is the single formatted message → no flash. No-reply
text-only answers still deliver via the turn-flush backstop.

The flag→config decision is extracted into a pure function
(`resolveAnswerLaneConfig`) the gateway delegates to, and is proved by total
enumeration (all 4 flag combos + the invariant `opensVisiblePreview ===
visibleEnabled`) plus an end-to-end test (the dormant config sends nothing for a
full answer). Adversarially verified across the lost-answer, opt-in-visible, and
draft-kill-switch paths.

## v0.14.69 — Deterministic answer-routing: prove the core, recover origin, alarm the residual (#2176 + #2175)

Forum-supergroup answer/topic routing was **conditionally deterministic** —
correct only when the model echoes `origin_turn_id` (precedence tier 2). A
finite-FSM proof (total enumeration of the pure resolver + adversarial trace of
the routing FSM that feeds it) found the load-bearing hole and this release
proves the core, recovers what the framework owns, and surfaces the rest.

### #2176 — prove determinism, recover origin without the model echo

When the model omits `origin_turn_id` **and** `currentTurn` has flipped to a
successor topic (reachable by construction via the 2.5s no-reply escape-hatch
drain or the 300s silence-poke), a reply fell to the live successor's thread =
**wrong topic**, silently. Three pieces:

1. **Prove the deterministic core.** `answer-thread-resolve.test.ts` is promoted
   from 9 sampled cases to a **total enumeration** over the whole 64-input
   space — totality, determinism, no-fabrication, the precedence decision
   table, and the by-construction invariants, notably **INV-2 origin
   flip-immunity**: once origin is resolved, the result is independent of the
   live thread for *every* combination, so a `currentTurn` flip cannot steal a
   resolved origin. (A reviewer mutation-test confirmed the proof catches a
   tier-swap regression — it is not a self-rubber-stamp.)
2. **Recover origin without the model echo.** When the model quotes a message
   (`reply_to`), that id is a *framework-owned* anchor: a new chat-scoped
   source-message reverse index (evicted in lock-step with `recentTurnsById`)
   maps it back to the owning turn. Origin resolves as `echo ?? quoted` — echo
   stays authoritative; the quote is strictly additive and resolves the actual
   origin turn, never the live successor. Kill switch
   `SWITCHROOM_FRAMEWORK_ORIGIN_ROUTING`.
3. **Alarm the irreducible residual.** A bare no-echo, no-quote late reply is
   genuinely model-dependent — `MISROUTE_RISK(no-echo→live-successor)` telemetry
   now surfaces that case instead of silently mis-routing it. Observability
   only; routing unchanged.

### #2175 — multi-topic + cross-surface ordering stress; UNROUTED false-alarm fix

New supergroup UAT stress scenarios (multi-topic back-to-back, cross-surface
ordering) and a fix for the `UNROUTED` telemetry false-alarm that fired on every
legitimate General-topic reply (now gated on `ownerTurn == null`).

## v0.14.68 — Testable live answer surface: retire the compose-box draft (#2173 + #2172)

### #2173 — retire the invisible compose-box draft

The live answer-stream rendered to the **compose-box draft** (`sendMessageDraft`),
which the mtcute UAT harness cannot observe — so the live answer surface was
**untestable** (the source of the recurring `botMsgs=0` confusion in triage).
It's now a **visible edit-in-place message** (`sendMessage` + `editMessageText`):
fully observable, and the #2169 silence-liveness reset on it now fires on visible
sends in **DMs and supergroups** (supergroups had no answer-lane reset before).
Default = draft retired; kill switch `SWITCHROOM_DRAFT_ANSWER_LANE=0` restores the
legacy draft. The flash that originally drove the draft is bounded by model
behaviour — on the common think→tool→reply turn the lane never opens; reply-tool
turns keep a single canonical formatted reply.

### #2172 — Connections dashboard tab

Web dashboard tab surfacing Google + Microsoft + Notion connection visibility.

## v0.14.67 — Status stays live through long work (#2169 + #2168)

Closes the last status-dark case, found by the new real-work UAT: a long turn
that is visibly producing — the activity feed editing in place, or the compose
draft updating — still tripped the 300s silence-poke fallback and nulled the
live status mid-work. Fix A (#2164) only deferred while a tracked tool was in
flight; it didn't count feed/draft renders.

### #2169 — count feed/draft activity as liveness

The silence clock now resets on **model-driven** observable production (a new
activity-feed step, or an answer-stream draft update), so the 300s fallback
fires only on **genuine** silence — no reply, no feed, no draft, no tool events
for the window. Critically, the reset is wired ONLY to model-driven sites: an
adversarial review caught a first revision that reset on every feed render,
including the framework's model-independent 6s heartbeat (climbing-elapsed),
which would have pinned a hung-but-connected turn forever (the #1556 wedge) —
that path is now structurally guarded against. Default ON; kill switch
`SWITCHROOM_SILENCE_LIVENESS_PRODUCTION=0`. Plus a `turn-lifecycle clear
reason=silence_fallback` telemetry line so a fallback-nulled turn is greppable
like every other clear.

### #2168 — real-work UAT coverage + a reply-route telemetry fix

New UAT scenarios send human-style prompts that trigger genuine work (multi-tool,
research, sub-agents, background workers) in DM and channel, asserting the status
surface + answer land correctly — the coverage that surfaced the bug above. Also
fixes the `reply-route` marker spuriously tagging every DM reply `recovered`.

## v0.14.66 — Late replies land in their own topic (#2166)

Follow-up to the v0.14.65 status work, from a live marko triage: in a forum
supergroup, a reply that fired *after* the orphaned-reply backstop ended its
turn lost its topic and landed in **General** — so the answer vanished from the
topic the user was reading (an out-of-order / "missing message" feel). Routing
had depended on the model echoing `origin_turn_id`, which it does
inconsistently.

- **Deterministic late-reply topic recovery.** New precedence tier in the
  answer-thread resolver: when there's no explicit thread, no echoed origin,
  AND no live turn, recover the origin topic from the most-recently-ended turn
  for that chat. No model echo required. Kill switch:
  `SWITCHROOM_LATE_REPLY_TOPIC_RECOVERY=0`.
- **`reply-route` telemetry.** One log line per answer reply — which precedence
  tier won, the resolved thread, the origin turn, and whether the reply was
  late — with `RECOVERED` (a late reply saved from General) and `UNROUTED` (a
  supergroup reply that still resolved to no topic) markers. The reply-routing
  blind spot the triage exposed is now a one-line grep.
- **Turn-pacing directive** reinforced: call the reply tool as the first action
  when you have the answer, so the backstop never has to flush late.

## v0.14.65 — Live status surface: stop the dark feed (#2162 + #2163 + #2164)

Fixes the "status went dark" incident (marko, supergroup): the live progress
card / activity feed / worker feed going dark while the agent kept working.
Diagnosed to two latent, version-independent bugs plus a DM thread-leak — not a
regression in any recent release. Three PRs ship together.

### PR #2162 — instrument the live status-surface lane for triage

The lane was nearly silent in the logs, which is why a one-line bug needed a
deep investigation. Additive logging, no behaviour change:

- A `turn-lifecycle` line at every `currentTurn` set (enqueue) and clear
  (turn-end) — turnId, topic key, tool count, feed state, age, reason.
- A `status-surface DEGRADED` line at turn-end when a turn did tool work but the
  live feed never opened because its sends failed.
- Worker-activity feed now logs `paint`/`edit`/`finish` on **success** (it
  previously logged only failures, so a healthy worker feed was invisible).

### PR #2163 — stop two always-failing status sends

- **Resume-turn dark feed:** synthetic boot-resume inbounds fabricate a
  `message_id` from `Date.now()` (~1.78e13). That was used as the activity-feed
  reply anchor — 829× over Telegram's 2³¹ max — so **every** feed send on the
  first turn after a restart 400'd and the live feed was dark the whole turn.
  The enqueue guard now rejects out-of-range ids as anchors (the feed posts
  unanchored); the deliver-until-acked tracking is unaffected.
- **Compaction-notice DM thread-leak:** the proactive `/compact` notice attached
  the agent's supergroup topic id to operator-DM sends → `400 message thread not
  found` → the notice silently vanished. Now guarded with `topicForRecipient`,
  matching the sibling operator-event / drive / ms365 sends.

### PR #2164 — keep the live feed alive during long in-flight tool work

The 300s silence-poke fallback nulls `currentTurn` (which drives the live feed)
when there's been no model reply for 5 min — so a long quiet tool stretch (a
foreground sub-agent, a big research pass) darkened the feed mid-work. With the
live activity feed (#2162-era) now showing tool progress, an actively-working
turn is no longer silent to the user. The fallback now **defers** while a parent
tool is genuinely in flight, bounded by a hard ceiling so a hung-mid-tool turn
still unwedges; a turn with no in-flight tool, and crash recovery, are
unchanged. **Enabled fleet-wide in this release**
(`SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=1`; unset to disable). Tunable:
`SWITCHROOM_SILENCE_FALLBACK_MS` (300000), `SWITCHROOM_SILENCE_FALLBACK_HARD_MS`
(900000).

## v0.14.64 — Obligation ledger graduates to default-on fleet-wide (#2160)

- **Obligation ledger is now ON by default** for every agent. After days of
  canary on marko (supergroup — the hardest multi-topic case) and test-harness
  with the full hardening — the hang-wedge fix (#2152), the escalate-grace
  window (#2156, which killed the fuzz-found over-escalation), and
  interrupt-cancel (#2157) — and 0 false cards, the no-drop guarantee graduates
  from opt-in to the fleet default. A message the agent reads but never answers
  is re-presented (bounded) then escalated, so it can't be silently lost.
  **Kill switch: `SWITCHROOM_OBLIGATION_LEDGER=0`** restores the prior behaviour.
- **Mid-turn auto-classify shadow is now on by default** — fleet-wide
  data-gathering with zero behaviour change (logs the would-be steer/queue
  decision + maintains a bounded recency map), to inform the eventual auto-steer
  default. **Kill switch: `SWITCHROOM_AUTOCLASSIFY_MIDTURN_SHADOW=0`.**

## v0.14.63 — Obligation: stop false nudges on slow turns + interrupt cleanup; mid-turn auto-classify (shadow)

- **Obligation escalate-grace window (#2156).** Fuzz testing found the ledger
  fired a false "⚠️ I may have missed this" on a slow / background-worker /
  multi-segment turn: the turn ends (the in-flight gate clears) before its
  trailing answer's reply lands, and the 5s sweep escalated in that gap. The
  sweep now waits a grace window (default 45s, `SWITCHROOM_OBLIGATION_ESCALATE_GRACE_MS=0`
  to disable) after a turn ends without a final answer before re-presenting/
  escalating — so the trailing answer's close has a beat to fire. The genuine
  drop (a thread that never gets an answer) still escalates after grace expires.
  Proven by folding the grace path into the 3000-schedule determinism
  enumeration (grace delays, never prevents a terminal).
- **Interrupt cancels its obligation (#2157).** An `!` interrupt SIGINT-kills the
  in-flight turn, which doesn't reliably emit turn_end, so its obligation
  survived and the sweep later re-asked a question the user *explicitly
  cancelled*. The interrupt now closes that turn's obligation (queued siblings
  untouched).
- **Mid-turn auto-classify, shadow mode (#2158).** Groundwork toward steering/
  queuing by intent instead of explicit `/steer` `/q` prefixes: a deterministic,
  model-free classifier (topic-vs-active-turn + reply-recency). Behind
  `SWITCHROOM_AUTOCLASSIFY_MIDTURN_SHADOW` (default OFF) it only LOGS what it
  would decide — behaviour is unchanged — to gather data before any auto-steer
  ever acts.

## v0.14.62 — Obligation ledger: close the hang-wedge (#2152)

- **Obligation-ledger determinism completion (#2152), still behind the flag.** A
  total state-machine proof (every reachable state × every input event, not a
  sampled test) found the one liveness hole a property test structurally can't
  reach: the escalation send is fire-and-forget and clears its in-flight guard
  only in a `.finally`, which runs only if the send *settles* — and grammy/fetch
  impose no request timeout, so a stalled send never settled, leaking the guard
  forever and wedging the obligation OPEN (never re-presented, escalated, or
  closed). Fixed by racing the send against a 45s deadline (`withDeadline`) so
  the chain always settles, the guard always clears, and a hang becomes a bounded
  reject feeding the bounded escalate ladder to a terminal. Also decoupled
  escalation from the buffered-represent gate — escalation is a direct Telegram
  send, so a represent stranded behind a dead bridge no longer blocks the
  operator nudge. The determinism argument (finite FSM + strictly-decreasing
  measure) is now recorded with the code; the property test is demoted to a
  regression guard. Remains behind `SWITCHROOM_OBLIGATION_LEDGER`.

## v0.14.61 — Obligation ledger: deterministic across restart + escalation (#2149)

- **Obligation-ledger determinism fix (#2149), still shipped OFF.** An
  end-to-end determinism audit (by reasoning, not live observation) found the
  ledger (`SWITCHROOM_OBLIGATION_LEDGER`, default off) held for every model
  behaviour on a single obligation but leaked in two places — both now closed:
  - **Escalation no longer silently drops.** The idle sweep closed the
    obligation *before* sending the operator nudge, so a send failure lost the
    terminal entirely. It now sends via `retryWithThreadFallback` (a
    dead/renumbered topic retries thread-less — the #2096 pattern) and closes
    only *after* the send lands; a transient failure stays OPEN and retries, a
    permanent one is bounded (then closes best-effort) — never an infinite or
    boot-surviving loop. A concurrency guard prevents overlapping sends.
  - **Obligations survive a restart.** The in-memory ledger emptied on every
    gateway/container restart, and the spool's boot-replay bypasses the open
    site, so a delivered-but-unanswered message used to lose its obligation
    across a restart. A durable per-agent snapshot (atomic write-tmp + rename)
    now restores open obligations — with their re-present and escalation
    counters intact — on boot.
  - Proven by a property test over 3000 random `{model-behaviour × timing ×
    restart}` schedules: every inbound reaches answered-or-escalated, no silent
    loss, no double-ask, bounded termination. The "coalesce double-ask" the
    audit first flagged was refuted in code (an obligation opens once per
    coalesced group). Remains behind the flag (default off; on test-harness).

## v0.14.60 — Obligation ledger: close on answer at turn-end (#2147)

- **Obligation-ledger correctness fix (#2147), still shipped OFF.** The ledger
  (v0.14.59, default off) closed an obligation only on a *substantive* reply
  (≥200 chars), so a short genuine answer ("4") read as unanswered and the idle
  sweep re-asked it — a double-ask on every short turn (caught in canary, never
  fleet-exposed). It now also closes the obligation at turn-end when the turn
  delivered a final answer (`finalAnswerDelivered`, which post-v0.14.58 is true
  only for a genuine answer, not a bare "on it" ack) — so short answers close
  cleanly while ack-then-ghost / no-reply turns still re-present. Remains behind
  `SWITCHROOM_OBLIGATION_LEDGER` (default off); enabled per-agent after canary.

## v0.14.59 — Live status never freezes; groundwork so a message can't be silently dropped

- **The "what it's doing" status no longer freezes on a long step (#2143).**
  The activity feed only redrew when the agent started a *new* tool, so a long
  single step (a 25-30s data pull, a long think) left it stuck on "→ doing X"
  for tens of seconds and read as ghosting. It now ticks a live elapsed
  (`→ Pulling Meta data · 18s`) every few seconds while a step runs, so you can
  always see it's alive. Kill switch `SWITCHROOM_FEED_HEARTBEAT=0`.
- **Delivery-obligation ledger — the deterministic fix for silently-dropped
  messages, shipped OFF (#2145).** When you send several messages close together
  in different topics, the agent (single-threaded) could finish one and silently
  lose another it had "set aside." This adds the missing guarantee: every inbound
  is an obligation that stays open until the framework observes a real answer to
  *it* — re-presented until answered, never discharged by the agent merely saying
  it'll get to it. Lands **disabled** (`SWITCHROOM_OBLIGATION_LEDGER`, default
  off) so it's inert until canary-proven on the multi-topic case, then enabled
  per-agent.

## v0.14.58 — Agents keep showing status after an "on it" (#2141)

- **The live activity feed survives an ack-first turn (#2141).** When an agent
  replied "on it…" and then did the actual work, the live "what I'm doing" feed
  went dark for the work — most visible in a supergroup work topic, where you'd
  see the ack and the final answer but nothing in between. Cause: the interim
  ack was classified as the turn's final answer (any reply that pings or runs
  ≥200 chars), which gates the feed off. Now, if the agent keeps doing tool work
  after such an ack, the feed re-opens and narrates that work — but only for a
  genuine short ack, never after a real final answer (so post-answer housekeeping
  like a memory write doesn't re-open a feed or cause a duplicate reply). Behind
  `SWITCHROOM_FEED_REOPEN_AFTER_ACK` (default on).

## v0.14.57 — The left-behind status feed reads "done", not stuck mid-step (#2139)

- **The persisted "what it's doing" feed now finalizes cleanly after a
  delegated step (#2139).** Since v0.14.54 the live status feed stays in the
  chat as a record, finalized to all-done (`✓`). One path missed that: when
  the agent acked ("On it") and then handed a step to a foreground sub-agent,
  the feed froze on its last `→ in-progress` line instead of `✓` once the
  sub-agent finished — the sub-agent's steps were cleared from the feed a beat
  before the finalize ran, leaving nothing to mark done. The finalize now
  captures the done-state *before* clearing, so those turns read complete like
  every other turn. Cosmetic only (the message always persisted); takes effect
  on restart.

## v0.14.56 — Two questions in two topics get two answers, each in its own topic (#2137)

- **Per-topic reply routing for multi-topic supergroups (#2137).** Asking an
  agent two questions in two different forum topics back-to-back could land
  *both* answers in one topic (and leave the other unanswered). An agent is one
  Claude session and can only reply sequentially — but each question must be
  answered in its own topic. Two root causes: a buffered cross-topic message
  drained the moment a turn ended even if that turn hadn't replied yet (orphaning
  its answer into the next topic), and a late reply was attributed to whichever
  topic's turn was active at reply time. Now: a queued cross-topic message is
  held until the current topic's turn actually delivers its reply (with a bounded
  ~2.5s escape hatch so a no-reply turn can never wedge the queue), every reply
  is pinned to the topic its turn originated from, and the waiting topic shows a
  self-clearing "Queued — replying in #X" status. DMs and single-topic chats are
  unchanged. All behind kill-switches (`SWITCHROOM_SERIALIZE_UNTIL_REPLIED`,
  `SWITCHROOM_SERIALIZE_NOREPLY_DRAIN_MS`, `SWITCHROOM_TURN_ORIGIN_ROUTING`,
  `SWITCHROOM_TOPIC_FRAMING`, `SWITCHROOM_QUEUED_STATUS_UX`).

## v0.14.55 — Telegram channel config knobs reach the gateway on docker (#2135)

- **`channels.telegram.*` env knobs now actually take effect on docker
  agents (#2135).** start.sh forks the Telegram gateway daemon in its outer
  pass, then re-execs into a tmux inner pass for the agent. The
  `channels.telegram.*` knobs the gateway reads from its environment
  (stream throttle, edit budget, and the new
  `clear_status_on_completion` from v0.14.54) were exported only in the
  inner pass — *after* the gateway had already forked — so the daemon never
  saw them and every such knob silently fell back to its default. They're
  now exported before the gateway fork. No fleet behaviour change today (no
  agent sets one of these knobs); this makes them functional for anyone who
  does — including `clear_status_on_completion: true` to opt back into
  deleting the live status feed on completion. Takes effect on restart.

## v0.14.54 — The "what it's doing" status stays as a record (#2132)

- **The live activity/status feed now stays in the chat by default (#2132).**
  The in-place "what it's doing" message (Reading X, Searching the web for Y,
  …) used to be **deleted** the moment the final answer landed. On trivial
  turns that produced a visible post-then-delete flicker, and it threw away a
  useful "what I just did" trail. It now **stays**: when the answer lands the
  message is finalized in place — every step marked done (`✓`), no frozen
  "→ in-progress" arrow — and left beside the reply as a record. No
  post-then-delete. Opt back into deletion per agent with
  `channels.telegram.clear_status_on_completion: true`. Config-only change;
  takes effect on restart.

## v0.14.53 — Answers post promptly after long tasks (#2130)

- **No more ~30-second blank after a long task (#2130).** Agents sometimes
  finished a turn with the answer written as plain transcript text and never
  called the reply tool — and since Telegram only shows what's sent through the
  reply tool, the answer only appeared ~30s later when the gateway's backstop
  flushed it. It read as "the agent went quiet / isn't posting updates," most
  often after long multi-step jobs (e.g. scheduling a batch of social posts).
  Measured at 15–40% of turns across the fleet. The per-turn pacing guidance now
  explicitly binds "answer" to a reply-tool call — so the agent delivers its
  result through the reply tool instead of leaving it as transcript text the
  backstop has to rescue. Greetings and genuine non-prompts still correctly send
  nothing. Prompt-only change; takes effect on restart.

## v0.14.52 — No more unformatted-then-deleted reply flash (#2128)

Every reply used to flash an unformatted message that was then deleted and
replaced by the formatted one — in DMs and supergroup topics alike. Root
cause: the "visible answer-stream" posted a preliminary chat message seeded
with the model's RAW markdown and streamed edits into it; when the model
called the reply tool (≈every turn) the reply posted a SEPARATE formatted
message and the stream RETRACTED (deleted) its preliminary. In supergroup
topics it also mis-routed (preliminary → General, reply → topic).

It delivered ~none of its intended "watch it type" value: Telegram
rate-limits message edits to ~1/second, and the model emits almost no
interstitial text (it thinks → tool → reply), so the preliminary was a
near-empty bubble (observed: 5–13 byte edits) that flashed and vanished.

Fix: the visible answer-stream now defaults **OFF**
(`SWITCHROOM_VISIBLE_ANSWER_STREAM=1` to opt back in per agent). The answer
lane uses the invisible compose-box draft (DMs) or stays fully suppressed
(supergroup topics, where drafts aren't supported), so the reply tool's
message is the single, canonical, properly-formatted one — no preliminary,
no delete. The live "what it's doing" signal is unchanged (activity feed +
"…typing" indicator).

## v0.14.51 — A resumed turn recovers the full original request (#2126)

- **Restart-resume no longer loses the tail of a long request (#2126).** A turn
  resumed after a restart only saw a truncated preview of what you'd asked: the
  registry stores the first ~200 characters of the message, and the resume
  wake-up sliced that again to 160 — so instructions near the end of a long,
  detailed task were silently dropped, and the agent resumed only the part it
  could still see. The full message was always on disk (the per-chat history
  buffer stores it verbatim and survives restarts), the resume just never went
  back for it. Now the resume wake-up includes the full stored preview and tells
  the agent to pull its complete original message (and surrounding context) from
  recent history before continuing — so it picks the *whole* task back up, not a
  clipped version. No behaviour change for short requests.

- Also lands the permanent restart/resume UAT regression gates (#2125,
  dev-only test infra).

## v0.14.50 — Resumed turns get a progress card + survive a not-ready restart (#2122)

When an agent restarts mid-work, the boot-resume wake-up (the synthetic message
that makes it pick up the interrupted task without being re-prompted) is now a
first-class turn and can't be silently dropped.

- **Resumed turns show progress and route to the right place (#2122).** The
  boot-resume synthetics carried only `meta.source` — no `chat_id` / topic. The
  gateway builds a turn's `currentTurn` (progress card, silence-poke hang
  protection, reply routing) only when the enqueue carries a `chat_id`, and the
  channel attributes are rendered from `meta` alone. So a resumed turn ran with
  **no progress card and no silence-poke**, and on a supergroup agent its reply
  fell back to the default chat instead of the topic the interrupted work lived
  in. Both resume builders now carry `chat_id` + `message_thread_id` in meta
  (the same shape real inbounds and sub-agent handbacks already use), so a
  resumed/report turn shows live progress, is hang-protected, and answers in the
  originating chat/topic.

- **The resume wake survives a not-ready restart (#2122).** The resume synthetic
  is buffered and redelivered on bridge-up exactly like a user inbound, but it
  was excluded from the deliver-until-acked queue — so a restart that dropped it
  into a still-booting (slow MCP) session silently failed to pick the work back
  up (the resume-side of the v0.14.48 lost-message race). The `resume_interrupted`
  synthetic now also carries a `message_id`, letting it enrol in the queue and
  re-deliver until claude consumes it, keyed and id-matched so it can never
  re-deliver forever. The watchdog "report" stays untracked; every other
  synthetic (cron / vault / handback) is unchanged. Rides the existing
  `SWITCHROOM_INBOUND_DELIVERY_CONFIRM` kill switch.

## v0.14.49 — Reboot cards edit in place → zero notification (#2121)

Agent reboot "back up" cards already arrived silently (no sound/banner,
`disable_notification: true`), but a freshly *sent* message still bumps the
unread badge — and the Telegram Bot API has no flag to suppress that. So a
routine reboot now **edits the prior boot card in place** instead of sending
a new one; edits never touch the badge, so reboots are truly notification-
free.

- **Routine reboots (operator update / cli rollout / crash / fresh boot)**
  reuse the prior boot card: the gateway persists its message id per
  (chat, topic) under the agent's state dir and edits that message on the
  next boot. The first boot after upgrading still sends one card (to
  establish the message it'll reuse); every reboot after that is a silent
  in-place edit → no sound, no banner, no badge.
- **Telegram-initiated `/restart`** still sends a fresh card that replies to
  your command — you asked and you're watching, so it should land at the
  bottom of the chat.
- Safe fallback: if the prior card was deleted, or on first boot, it sends a
  fresh (silent) card. A new `editMessageTextStrict` distinguishes
  "message gone" from a landed edit so the card is never silently lost.

Trade-off: the chat shows each agent's CURRENT status (one card, updated)
rather than a scroll-back of every past reboot.

## v0.14.48 — Don't lose a message sent while an agent is restarting (#2117)

A DM (or supergroup-topic message) sent while an agent was mid-restart could
vanish: the operator saw "your message is queued…" → "still working… (5 min)"
→ silence, with nothing ever answered. Hit twice in one day on clerk/KenGPT
during fleet rollouts. This release closes the root cause.

- **Restart-redelivered inbounds now enroll in the deliver-until-acked queue
  (#2117).** When an agent restarts, buffered/spooled inbounds are redelivered
  to the new process — but `bridge registered` only means the IPC socket is
  up, not that the `claude` session is ready to receive. If Hindsight (or any
  MCP server) is slow to come up, the redelivered inject hit a still-booting
  session and was silently dropped; `claude` wrote no `enqueue`, so the
  framework's 300s silence-poke ended a phantom turn (`drained_buffered=0/0`)
  and the message — already drained from the buffer and tombstoned in the
  spool — was gone with nothing retrying it. The live (non-restart) path
  already guards against exactly this with a 5s deliver-until-acked sweep
  (gated on `currentTurn == null`), but the restart-drain paths acked on a
  bare socket-write and never enrolled. They now do: every drain→deliver path
  (bridge-up dispatch, kill-switch fallback, idle-drain, silence-poke
  fallback, both flap flushes) re-tracks the redelivered inbound, keyed per
  `(chat, thread)` so **DMs and supergroup forum topics recover identically**.
  It re-delivers every 5s until `claude` finishes booting and actually
  consumes it. Steering/interrupt/synthetic-source inbounds are excluded, so
  nothing can re-deliver forever. Rides the existing
  `SWITCHROOM_INBOUND_DELIVERY_CONFIRM` kill switch.

- **A mid-flight turn cut off by restart no longer auto-resumes if it's stale
  (#2117).** Boot-resume of an interrupted turn now has a 3-hour failsafe: a
  turn older than `SWITCHROOM_RESUME_MAX_AGE_MS` (default 3h) downgrades from
  a silent auto-resume to a passive "your last turn was interrupted" notice,
  so the agent never silently acts on hours-stale context (a number, a "send
  it" the user has moved on from). Fresh interrupts resume as before.

## v0.14.47 — Permission cards route to the work topic + name the operation (#2118)

A high-risk permission approval card raised by a supergroup-owned agent now
appears IN the forum topic the operator asked from, and says what it's about
to do — two operator-reported defects on marko's Brevo approvals.

- **The Approve/Deny card follows the conversation into its topic (#2118).**
  The initial card emitter sent to the operator's DM (`access.allowFrom`) —
  and a supergroup's chat id is never in that list, so a card raised from
  the "CRM (Brevo)" topic could only ever land in the DM, not the topic the
  work lives in. (The post-verdict "continuing…" resume message already
  routed correctly; the card didn't.) The card and the resume now route
  through one shared helper — turn-initiated → the originating chat+topic;
  no active turn → operator DMs, thread-stripped — so they can't drift. The
  card send is wrapped in the thread-fallback retry, so a deleted/recreated
  topic re-sends thread-less into the main chat instead of vanishing into
  the 10-minute auto-deny. DM agents are unchanged.

- **The card names the operation, not just the verb (#2118).** "post
  (Brevo)" / "put (Brevo)" gave no idea WHAT was being written. The
  REST-wrapper integrations (Brevo / Meta / Postiz) take `{ path, body }`,
  so the card now reads "POST /smtp/email (Brevo)" with a third line
  summarizing the payload ("↳ subject: …, templateId: 12, to"). Every value
  passes the secret-redaction filter (a token in the body is masked), is
  length-capped, and nested objects show as the bare key name — never a data
  dump. Falls back to the old phrasing for unrecognized input shapes.

## v0.14.46 — Supergroup credential-resume routing + setup discoverability (#2114, #2115)

Two supergroup-mode follow-ups from a DM-hardcoding audit: credential
approvals now resume in the topic you were working in, and supergroup mode
is discoverable at setup time instead of hand-edit-only.

- **Vault grant / save / secret outcomes route back to the work topic
  (#2114).** When an agent fired `vault_request_access`,
  `vault_request_save`, or `request_secret` from inside a forum topic, the
  synthetic wake-up inbound the gateway injects after you tap
  Approve / Save / Provide carried no thread — so the resumed turn's reply
  landed in **General** instead of the topic the work lives in. All eight
  outcome inbounds (`vault_grant_approved/denied`,
  `vault_save_completed/failed/discarded`,
  `secret_provided/provide_failed/declined`) now carry the originating
  topic both top-level (`threadId`, for the per-topic delivery keying) and
  in `meta.message_thread_id` (which session-tail re-extracts to route the
  reply) — the same two-carrier pattern cron inbounds use. Purely additive:
  DM / non-topic requests are unchanged.

- **Supergroup mode is discoverable at setup (#2115).** Supergroup mode
  (one agent owns a Telegram forum supergroup, routing its work into
  per-topic threads) was real but hand-edit-only — no wizard step, an aside
  in `scheduling.md`, no example block. Now `switchroom setup` offers an
  **optional, skip-by-default** "Supergroup mode" step that writes
  `channels.telegram.chat_id` for you (the schema smart-defaults the rest);
  `examples/switchroom.yaml` carries a commented per-agent block; and a new
  `docs/supergroup-mode.md` guide (linked from the docs index) covers
  finding your chat_id + topic ids, the config, and the gotchas. The
  zero-config DM path is untouched.

## v0.14.45 — Operator MCP tools surface in the live activity feed (#2111)

A turn driven by operator-configured MCP tools (perplexity, webkite, …) —
e.g. a research request — showed **no activity feed at all**, only a typing
dot + the 👀 reaction, so it read as "I can't see what it's doing" (operator
report; confirmed in the session JSONL: `perplexity_ask` ×2, `perplexity_search`,
`webkite_read` ×3 over 73s, with **zero `tool_label` events**).

- **The PreToolUse label hook allowlisted only the built-in MCP servers.**
  `tool-label-pretool.mjs` `computeLabel` emitted labels for
  switchroom-telegram + hindsight and returned `null` for every other
  `mcp__*` tool. The live activity feed is driven off this sidecar, so
  research tools produced nothing — even though the gateway's own
  `describeToolUse` already had a generic MCP fallback. Now the hook has the
  same fallback: friendly per-server labels (perplexity → "Searching the web
  for …", webkite → "Reading <host>", gdrive/gmail/notion/calendar), else a
  model-authored field (`description`/`query`/`title`), else a humanized tool
  name ("Using <tool>"). switchroom-telegram surface/control tools stay
  suppressed (they ARE the conversation). MCP-driven research now narrates its
  steps live — in DMs and supergroups.

## v0.14.44 — Status honesty + post-ack feed + supergroup sibling-topic fix (#2107, #2108, #2109)

Three fixes from a turn-wedge root-cause investigation — the recurring 300s
"turn-wedges" turned out to be mostly a *benign* approval-latency artifact plus
two status-surface gaps.

- **Silence-poke tells the truth when you're the blocker (#2107).** The 300s
  framework-fallback said *"still working… (no update in 5 min)"* even when the
  turn was parked on an approval card waiting for your tap — the dominant live
  wedge class (claude alive, blocked on a permission prompt, self-recovering
  the instant you answer). It now says *"waiting for your approval — tap
  Approve or Deny on the card above (N min)"* when the reaction controller is in
  its awaiting-approval state. Pure copy/branch; the 300s self-recovery is
  unchanged.

- **The activity feed survives an ack-first reply (#2108).** Ack-first ("On it"
  → then delegate/work) is the live fleet pattern, but the feed was deleted on
  the *first* reply, so the post-ack sub-agent/tool work rendered into nothing
  ("agent went silent after On it"). The feed lifecycle now gates on
  `finalAnswerDelivered` instead of the first reply, so it keeps narrating
  between the ack and the real answer. turn_end's unconditional clear stays as
  the idempotent net.

- **A live supergroup topic isn't purged when another times out (#2109).** The
  silence-poke's sibling-key sweep matched on chatId only — and in
  one-agent-owns-supergroup every forum topic shares the chatId, so a 300s poke
  on topic A purged a LIVE sibling topic B's reaction controller + typing loop.
  Each sibling is now gated on its OWN silence clock (purge only if itself
  silent ≥ the fallback threshold, or dangling) — preserving the #1556
  dangling-key cleanup while sparing live topics. Uses silence, not turn-start
  age, so a long-but-narrating turn isn't mistaken for stale.

## v0.14.43 — Sub-agent status reaches users in channels, not just DMs (#2098–#2102)

Status from delegated work — background workers, foreground sub-agents,
researchers — was reliable in DMs but **mis-routed or invisible in Telegram
supergroups**, the operator's "must work in channels" gap. A 9-lens audit
found two root causes: synthesized sub-agent inbounds were *born thread-blind*,
and a foreground sub-agent's tool steps never surfaced. This release fixes both
and adds the first real-Telegram **supergroup UAT** coverage (every prior
scenario was DM-only).

- **Sub-agent handback / progress route to the dispatching topic (#2098).**
  When a background worker finished, the agent's in-voice "here's what I found"
  handback (and mid-flight progress wake-ups) landed in the chat's *last-seen*
  topic instead of the topic the work was dispatched from — reading as silence
  in the topic the user was watching. `resolveSubagentOriginChat` already
  resolved the origin topic, but the handback/progress callsites took only
  `.chatId` and dropped `.threadId`, and the inbound builders had no thread
  carrier. Now both builders carry the origin topic (top-level `threadId` +
  `meta.message_thread_id`, mirroring the real-inbound shape), applied only
  when the origin chat resolved (the owner-DM fallback stays topic-less). And
  `executeReply` / `executeStreamReply` now prefer **this turn's own
  originating topic** over the chat's last-seen-topic heuristic when the model
  passes no explicit `message_thread_id` — strictly more correct under
  multi-topic concurrency; DM behavior unchanged. Pure jsonl-tail → render,
  no model call. 24 new builder/decision thread-assertions.

- **Foreground sub-agents nest TOOL steps, not just prose (#2099).** A
  foreground sub-agent (Task/Agent, no `run_in_background`) that ran tools
  *without narrating* — a researcher reading files, a worker running commands —
  surfaced nothing in the parent turn's nested `↳` activity block: the watcher
  fired `onProgress` only on `sub_agent_text` (prose), never on
  `sub_agent_tool_use`. Now it fires on tool events too, carrying a friendly
  `describeToolUse` label ("Reading X", "Running a command") — the same
  renderer the main-turn feed uses — so foreground steps read identically. The
  worker's narrative result (`latestSummary`, the beat-4 handback payload) is
  never polluted with tool labels.

- **Supergroup channel UAT + driver dialog priming (#2101).** First
  real-Telegram coverage in a forum supergroup: `jtbd-supergroup-reply-channel`
  (agent replies inside the supergroup, not the DM) and
  `fuzz-supergroup-channel` (realistic inbounds → meaningful, leak-free replies
  land in the topic). New `driver.primeDialogs()` / `driver.canResolve()`
  prime the mtcute MemoryStorage peer cache so a username-less supergroup
  resolves. Both self-skip green when no test supergroup is wired.

- **UAT fuzz: jailbreak-resistance false-positive fixed (#2102) + steer
  narration accepted (#2100).** The fuzz jailbreak check matched the trigger
  word *anywhere*, mis-flagging a correct refusal that quoted the bait as a
  surrender; it now only flags genuine persona-adoption. #2100 accepts
  "switched to X as you asked" steer narration.

## v0.14.42 — Approval cards reach the operator from supergroup topics (#2096)

A HIGH-RISK approval / permission card (e.g. a Brevo `POST`, or a Drive /
MS-365 / hostd-config write) that an agent raised from **inside a supergroup
topic** was undeliverable to the operator — so the request auto-denied after
its 10-minute TTL and the agent sat at the still-open prompt, **wedged**,
unable to do anything else (no replies, no topic status reports). Observed
live on `marko`: a Panorama "Winter Special" Brevo EDM approval looping
`permission_request send … 400 message thread not found` → `auto-deny
tool=mcp__brevo__post`.

- **Don't attach a supergroup topic id to a DM approval card.** The "PR4b
  emitter sweep" routed every approval card's `message_thread_id` from the
  originating turn's forum topic — but that topic id is valid **only in the
  agent's supergroup**, while the cards fan out to the operator's `allowFrom`
  chats, which are normally DMs. A DM `sendMessage` carrying a
  `message_thread_id` is rejected by Telegram (`400 message thread not
  found`), so the card never arrived. A new pure `topicForRecipient` guard
  attaches the resolved topic **only** to the recipient that owns it (the
  agent's `channels.telegram.chat_id`) and sends operator DMs thread-less.
  Applied at all five affected emitters (permission, drive, MS-365, config,
  the no-turn permission re-emit). Fire-and-forget informational broadcasts
  (boot / compact-watchdog) were intentionally left alone — they swallow a
  thread-not-found as a benign no-op and have no TTL to auto-deny. Pinned by
  six focused `topic-router` unit tests.

## v0.14.41 — Delivery-path hardening: steer-loop fix + 6 audit findings (#2092, #2093)

Two rounds of follow-up hardening to v0.14.40's deliver-until-acked queue —
the second from an exhaustive adversarial audit of the whole inbound→reply
path. The queue closed the marko 300s-drop wedge, but its re-delivery sweep
had been bolted on without inheriting the protections the fresh-inbound path
earned over 15+ prior wedge fixes.

- **Don't track steering/interrupt deliveries (#2092).** v0.14.40 tracked
  **every** delivered inbound for an `enqueue` ack — including `/steer` and
  `!`-interrupt messages. Those are delivered mid-turn to *amend the running
  turn* and never emit a fresh `enqueue`, so they were never acked and the 5s
  sweep re-delivered them forever (duplicate turns / a re-delivery loop).
  `shouldTrackDelivery` now gates tracking to non-steering, non-interrupt
  inbounds — exactly the messages the #1556 buffer-gate holds-then-delivers,
  which are the ones that produce an `enqueue` to ack against. Also removes
  the only realistic source of unbounded queue growth. An adversarial
  stress-test caught this before it bit in anger (the canary's steer test had
  passed only by ack-timing luck).

- **Six further queue-correctness fixes (#2093).** An 8-lens adversarial audit
  (each finding independently verified) found the re-delivery sweep was *more*
  failure-prone than the drop it replaced for several reachable states. Fixed:
    1. **Mid-turn re-delivery** re-creating the very wedge the queue prevents —
       the sweep now re-delivers only when claude is genuinely idle
       (`currentTurn == null`, the enqueue-confirmed signal; *not*
       `claudeBusyKeys`, which is set eagerly at delivery and stays set through
       a strand) and not during a pending permission / ask_user prompt.
    2. **Cross-source ACK collision (silent drop)** — `enqueue` fires for every
       turn start (cron / subagent-handback / vault-resume / restart-marker), so
       a key-only ack let a synthetic turn clear — and drop — a real user
       message waiting under the same key. The ack now matches the tracked
       message id.
    3. **Empty-body re-delivery loop** — an empty `/queue` body never enqueues,
       so tracking it re-delivered every cycle forever (a self-inflicted DoS);
       now carved out, along with synthetic (`meta.source`) inbounds.
    4. **Negative / NaN env timeout** → infinite re-delivery; the timeout
       override is clamped to a positive, finite value.
    5. **Orphaned replay of steer/interrupt** — one that failed delivery while
       the bridge was offline was persisted to the durable spool and replayed as
       a fresh orphaned turn after restart; now carved out.
    6. **Re-delivery ack-race** — a successful re-send now re-marks busy and
       re-affirms tracking, so only `enqueue` ever clears tracking.
  Lower-reachability / structurally-separate follow-ups (turn_end gate-wedge
  backstop, drain-path tracking centralization, reaction-flush gate, bridge
  dedup) are tracked in #2094.

- **Test + docs (#2091, #2087).** Wired the no-drop rapid-fire UAT into
  `ci-uat` and fixed a flaky `/steer` narration assertion; added
  `reference/access-model.md` (single-tenant security contract).

## v0.14.40 — Reliable inbound delivery: deliver-until-acked (#2089)

Telegram inbounds reach claude as an MCP channel notification that the
unmodified CLI appends to its TUI composer and auto-submits only when the
composer is empty + idle. When a message arrives as the prior turn is
finalizing, the auto-submit races turn-completion and the text **strands
unsubmitted** — claude never starts the turn, so the gateway sat
"typing…" until the 300s silence-poke **dropped the message**. Observed
recurring on `marko` (supergroup forum topics and DMs alike); the #1556
delivery gate + #2039 composer-clear narrowed the window but didn't close
it because delivery was never *acknowledged*.

- **Delivery is now acked by `enqueue`, not by `sendToAgent`.** A
  delivered inbound is tracked in a small per-key queue until claude
  actually starts the turn (the `enqueue` session-event — the one signal
  that claude truly picked the message up). If it isn't acked within 15s
  it stranded: the gateway re-clears the composer and re-delivers it, and
  keeps re-delivering until claude acks. The message is **never dropped**.
  Bridge-offline re-sends hand off to the existing persistent offline
  buffer. Kill switch: `SWITCHROOM_INBOUND_DELIVERY_CONFIRM=0` restores
  the legacy fire-and-forget path. New pure module
  `inbound-delivery-confirm.ts` with full unit coverage.

## v0.14.39 — Sub-agent attribution stamped at dispatch (#2081, #2083, #2084)

Make a sub-agent's parent turn **ground truth captured at dispatch**
instead of reconstructed after the fact — fixing wrong-topic worker-card
pins in supergroups and hardening background-worker detection.

- **`parent_turn_key` stamped from the live turn-active marker (#2081,
  #2083).** The PreToolUse hook now reads the gateway's
  `<telegramDir>/turn-active.json` marker — the turn whose tool call is
  dispatching this sub-agent — and writes `parent_turn_key =
  marker.turnKey` at INSERT. Previously the column was left NULL and the
  gateway reconstructed it at jsonl-link time from a `started_at`
  time-window match. That match assumed "at most one turn window
  contains a given instant", which is false in supergroups: forum topics
  multiplex many concurrent turns under one `chat_id` and `ended_at` is
  unreliable (batch-swept), so the window query could attribute a
  sub-agent to the **wrong topic** (proven on marko) and pin its worker
  card to the wrong conversation (#2081). Stamping the exact turn_key at
  dispatch removes the reconstruction entirely. It also attributes
  sub-agents whose JSONL never links (~8% — the backfill only ran on
  link), which were previously never attributed (#2083). The gateway
  window-match remains a best-effort fallback for the no-active-turn
  case; the hook's value always wins (the backfill's `IS NULL` guard).
- **Async-launch detection hardened (#2084).** `isAsyncLaunchAck` gains
  a third, drift-tolerant tier keyed on the functional `agentId: <stem>`
  token (the most wording-stable part of Claude Code's async-launch ACK)
  paired with a launch/background/async/dispatch context word, so a CLI
  bump that rewords BOTH prose phrases no longer silently regresses
  background-worker promotion. The exact ACK contract (verified against
  the pinned claude-code 2.1.156) is now pinned by drift-variant tests.
- **Turn `ended_at` lifecycle (#2082):** the overlap mis-attribution it
  caused is eliminated above (attribution no longer depends on
  `ended_at`). The residual orphan open turns are a symptom of the
  not-yet-done supergroup `currentTurn → Map` refactor and self-heal at
  boot; tracked there rather than risking the turn-end/resume/watchdog
  couplings here.

## v0.14.38 — Supergroup zero-config easy-mode (#2077)

Make the **supergroup-owned topology zero-config easy mode**: point an
agent at a Telegram supergroup and it answers **everywhere, all topics
(including ones created later), with DMs still served** — no
hand-editing `access.json`, no picking a default topic.

This came out of enabling marko in a working group, which required
discovering the silent `group_unknown` drop, knowing `access.json` is
`writeIfMissing`, hand-merging the group, and hand-picking
`default_topic_id` — all toil that fails principles 1
(teach-itself) and 2 (batteries-included).

- **Config-driven group registration.** `reconcileConfiguredGroup`
  idempotently merges the agent's configured supergroup into
  `access.json` on every reconcile — strictly additive: adds the group
  only if absent; preserves `allowFrom`, pairings, other groups, and
  any operator policy override (e.g. `requireMention: true`). Closes
  the `writeIfMissing` gap that made a supergroup added *after* first
  scaffold never register. Smart default for a newly-added group:
  `requireMention: false` (a room the agent owns answers every
  message), all topics (the gate is per-group, not per-topic).
- **Effective-chat resolution.** Both the reconcile and the
  fresh-scaffold access-list paths now resolve the per-agent
  `channels.telegram.chat_id` override *ahead of* the fleet
  `telegram.forum_chat_id` — same precedence as the cron router — so
  the access list, scheduler, and gateway all agree on which chat the
  agent owns.
- **`default_topic_id` defaults to General (1).** Setting `chat_id` no
  longer *requires* `default_topic_id`; it falls back to General (the
  outbound wrapper strips `thread_id === 1` on send). Pin a different
  fallback only if you want one.

Net easy path is one config line —
`channels.telegram.chat_id: "<supergroup-id>"`. Mention-only,
per-topic deny, and a pinned default topic remain opt-*in*. Leash
unchanged: this only affects which messages the agent *reads* in a
group it owns; actions still gate through Allow/Deny + `allowFrom`.
RFC: `docs/rfcs/supergroup-easy-defaults.md` (scopes the phase-2 CLI
`--topology supergroup` on-ramp + the in-Telegram "enable this group?"
nudge).

## v0.14.37 — Background-worker visibility fixes (#2075, #2076)

Two fixes to how a delegated background worker is surfaced back to the
Telegram conversation it was launched from.

### PR A — promote a mis-recorded foreground worker to background (#2075)

When an agent delegates with `run_in_background: true`, Claude Code
sometimes reports the dispatch to the PreToolUse hook *without* the
background flag, so the registry row is recorded as `background=0`. The
PostToolUse hook then took the foreground path — terminalizing the row
and emitting a "hand back to me" nudge — even though the worker was
still running detached. The worker's live activity never reached
Telegram.

The PostToolUse hook now trusts Claude Code's async-launch
acknowledgement (`"Async agent launched successfully … working in the
background … agentId: …"`) over the pretool's input flag: on that ACK
it **promotes** the row to `background=1`, takes the non-terminalizing
background path, and suppresses the foreground handback nudge. The
worker stays visible through its own activity feed.

### PR B — backfill `parent_turn_key` at jsonl-link time (#2076)

A sub-agent row's `parent_turn_key` is the only link back to the
originating Telegram conversation (chat + topic). The PreToolUse hook
can't know it — Claude Code's payload carries the `claude` session id,
never the gateway-minted Telegram turn_key — so the row is recorded
with `parent_turn_key = NULL` and the worker card defaulted to the
operator DM instead of the group/topic the work was requested in.

The gateway now backfills `parent_turn_key` when it links a worker's
JSONL stem to its registry row (`backfillJsonlAgentId`), resolving it
from the turn whose `[started_at, ended_at]` window contained the
sub-agent's dispatch. Because turns are processed serially per agent,
exactly one turn window contains any given dispatch instant — and the
resolution stays correct even for a background worker that **outlives**
its parent turn (it attributes to the containing turn, not whichever
turn happens to be active at link time). The existing
`parent_turn_key IS NULL` guard means an already-populated value is
never overwritten.

## v0.14.36 — Admin-only vault credentials (#2073)

Mark sensitive vault keys that may be granted **only by the admin
operator** (`access.allowFrom[0]`) and **only with the vault passphrase**
— never via posture attestation, even under the `approvalAuth:
telegram-id` single-factor fleet default.

```yaml
vault:
  broker:
    adminOnlyKeys:
      - stripe/*               # whole namespace (exact names or `*` globs)
      - microsoft/ken-tokens
```

For any key matching `adminOnlyKeys`:

- **Only the admin operator may approve a grant.** The admin is the first
  entry in `access.allowFrom` (the owner). A grant-approval tap from any
  other allowFrom member is rejected — the card stays open for the owner.
- **It is always minted with the operator passphrase, never posture.**
  Even when the fleet default is `telegram-id` (no passphrase prompt for
  normal grants), approving an admin-only key prompts for the vault
  passphrase. The broker **refuses** to mint an admin-only key via posture
  attestation, so an agent — even one on `postureMintAgents` — cannot
  self-grant it. (`claude` shares the gateway's per-agent broker socket
  and can forge a Telegram tap, but it does not have the passphrase.)
  Posture may **retain** an admin-only key the agent already holds across
  a union re-mint, but never **add** a new one.

Enforced at two layers: the broker (`mint_grant` posture path,
surface-independent — also blocks an agent crafting raw broker protocol)
and the gateway (the `vra:approve` handler). Default `adminOnlyKeys: []`
is a no-op — existing behaviour is unchanged. Takes effect on broker +
gateway restart (no ACL hot-reload). See `docs/vault.md` § "Admin-only
credentials".

## v0.14.35 — Stop agents guessing vault key names (#2071, #2070)

### Stop agents guessing vault keys (#2071)

Agents have no innate knowledge of their own vault key names, so they
**guess** — e.g. `postiz/api-key` when the real, already-granted key is
namespaced `marko/postiz-api-key`. The old denied-hint then steered them
straight to the `vault_request_access` MCP tool, **burning an operator
approval tap on a key that doesn't exist** (live incident: marko,
2026-06-02).

Two fleet-wide fixes:

- **Self-correcting denied error.** On a broker-denied `switchroom vault
  get <key>` inside an agent, the CLI now looks up the keys the agent
  **actually holds** (broker `list` op — the same disclosure as
  `switchroom vault list`, no info leak) and surfaces the closest
  near-matches. The hint leads with *"you already have access to `<real
  key>` — use that"* and *"run `vault list`"*, demoting
  `vault_request_access` to a confirmed last resort. The machine-readable
  `ERROR-ENVELOPE:` line is unchanged, so structured consumers are
  unaffected. Pure, unit-tested token-overlap ranker
  (`src/cli/vault-key-suggest.ts`).
- **Proactive fleet guidance.** A new `VAULT_GUIDANCE` block in the fleet
  invariants teaches every agent up front: read with `vault get`, **never
  guess**, `vault list` shows your real `<you>/...` keys, only
  `vault_request_access` for a key you've confirmed you lack.

### Flag-gated operator-verified mint gate (#2070, inert by default)

Foundation for the vault-approval hard boundary (RFC #2069). Adds an
`origin` column to `approval_decisions` (server-set `'agent'`/`'operator'`,
no wire path) + a pure `isOperatorVerifiedDecision()` predicate + a broker
mint gate behind `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT` (**default
off — inert**). No behaviour change until a future PR flips the flag; this
release only lays the seam.

## v0.14.34 — Operator-set standing vault grant (#2067)

Adds `agents.<name>.secrets[]` — an **operator-set standing vault grant**
the broker honours for an agent **independent of any cron or MCP server**.
Cascades UNION across `defaults → profile → agent`.

Until now an agent's access to a vault key could only be granted by welding
it to a specific cron's `schedule[].secrets[]` or an `mcp_servers[].secrets`.
Skill-based credentials an agent needs **both interactively and in its own
agent-managed schedules** (e.g. a calendar/mail skill reading an OAuth token
via `switchroom vault get`) had no clean home — the grant leaked in only via
a cron, tangling *what the agent may access* with *when it runs*. The
standing grant separates them: it is the home for "what it may access", so
an agent's schedules can move to agent-managed overlays (which deliberately
cannot carry `secrets:`) and still work.

**Operator-only by design** — agents cannot edit `switchroom.yaml` or
self-grant (`reference/vision.md` outcome 2, *"you hold the leash; only your
tap grants it"*). A standing grant *is* the tap, expressed as config. Purely
additive: an agent with no `secrets:` is unaffected. Broker-enforced in
`src/vault/broker/acl.ts`. See `docs/configuration.md` § "Standing vault
grants".

## v0.14.33 — Blocking-TUI wedge fix (AskUserQuestion deny + wedge-watchdog)

Closes a wedge class where claude's **blocking interactive TUI selectors**
(the `AskUserQuestion` / `ExitPlanMode` class — a full-screen
multiple-choice list with the footer "❯ 1. … · Enter to select · ↑/↓ to
navigate · Esc to cancel") freeze a **headless** agent forever. With no
human at the terminal the selector blocks indefinitely: the turn never
completes, queued Telegram inbounds pile up, and the agent looks **mute**
(real incident: klanker, 2026-06-01, recovered only by a manual tmux `Esc`).

Two defensive layers:

### Layer 1 — deny `AskUserQuestion` fleet-wide (#2064)

`AskUserQuestion` is now an unconditional fleet-baseline deny
(`INTERACTIVE_TUI_FLEET_DENY_TOOLS` in `src/agents/scaffold.ts`), wired into
the fresh-scaffold `toolsDeny`, the `reconcileAgent` `desiredDeny`, AND the
existing-agent merge branch in `scaffoldAgent` (the `switchroom apply`
convergence path). A denied `AskUserQuestion` does **not** crash the turn —
claude degrades gracefully and asks the same question as **plain text**,
which reaches the operator over Telegram. A one-off power-user need can
re-enable via the `settings_raw` deep-merge escape hatch.

### Layer 2 — continuous mid-session wedge-watchdog (#2065)

Defense-in-depth for blocking selectors Layer 1's deny can't reach (a
`settings_raw` override, a not-yet-reconciled agent, a future selector tool,
or `ExitPlanMode`). The `autoaccept-poll` sidecar now runs two phases in one
process: the existing boot phase, then a continuous `runWedgeWatchdog` that
polls the pane and dismisses a **stable** blocking selector with `Esc`
(which claude treats as "user declined" — non-destructive).

Conservative by design — false positives (Esc into a *live* turn) are worse
than false negatives. Fires only on **all three** of: a strict footer
signature (same-line "Esc…cancel" AND a select/navigate affordance — rejects
the working footer "esc to interrupt" and the idle REPL footer);
byte-identical stability across N consecutive polls (default 3 @ 5s ≈ 15s
confirmed-stuck — a working pane's spinner/timer changes between polls); and
a post-fire cooldown (default 60s). Defers to first-run prompts (those want
Enter) and soft-fails throughout. Kill-switch: `SWITCHROOM_WEDGE_WATCHDOG=0`
restores legacy boot-only behaviour.

## v0.14.32 — Background worker card routes to the dispatch chat (#2061)

Fixes a routing bug where a background sub-agent's live worker card
("🛠 Worker · &lt;task&gt; running …") and its completion handback were
always posted to the operator **DM**, even when the Task was dispatched
from a group or forum topic. So asking an agent to do background work *in
a group* sent all the progress and the result to its DM instead of where
you asked.

Root cause: the worker-card chat came from the pinned-card "fleet" lookup,
which was removed in #1122 (`progressDriver` is now permanently `null`), so
every path fell back to the operator DM and the dispatch chat was never
recoverable. The fix recovers the originating conversation from the
per-agent registry (`sub-agent → parent_turn_key → turns.chat_id/thread_id`)
and routes the worker card (chat **and** forum topic), the legacy progress
envelope, and the handback there. Best-effort with the existing DM fallback
preserved, so **DM-only agents are unaffected** (a registry miss is exactly
today's behaviour).

Known follow-up: the handback reply carries the chat but not the topic, so
on a true **forum-topic** group the result lands in the General topic;
plain groups and DMs are fully fixed.

## v0.14.31 — Broader secret coverage + inbound reliability

A "stop missing secrets" upgrade (GitHub-scanner-style detection) plus two
inbound-path reliability fixes.

### Secret detection — two-part coverage upgrade

- **High-precision provider ruleset (#2054).** ~30 curated, prefix-anchored
  provider patterns (Stripe, SendGrid, GitLab, Hugging Face, Twilio,
  DigitalOcean, Doppler, Linear, Shopify, Square, New Relic, Notion,
  PlanetScale, Supabase, Atlassian, Dropbox, Databricks, Grafana, PyPI,
  AWS-STS, GCP-OAuth, …) merged into the shared `detectSecrets` engine, so
  they protect the inbound gate, the outbound mask, and the issues pipeline
  at once. Prefixed-only → near-zero false positives (load-bearing: the
  inbound gate auto-deletes on a high-confidence hit). Baked as TS (the
  bundler doesn't ship the vendored `.toml`).
- **Generic bare-high-entropy fallback (#2059).** The long-tail detector
  for standalone tokens no prefix/KV rule matches (the Sanctum class).
  Emitted at `ambiguous` confidence — it drives the inbound "stash to vault
  or ignore?" ASK, and is excluded from `redact()` so it never masks agent
  replies. Gate: charset `[A-Za-z0-9]` (separators excluded so identifiers
  break up) + ≥1 digit + ≥18 distinct chars, which excludes hex/SHA/UUID/
  digit-runs and dense CamelCase/snake_case identifiers by construction.

### Inbound reliability

- **Idle-session composer wedge (#2039).** Clear the claude TUI composer
  (`tmux send-keys C-u C-a C-k`) before delivering an inbound, so stranded
  typed-ahead text can't strand a fresh prompt. Soft-fails to delivery;
  no-op on the happy path; orthogonal to the Telegram draft/answer-stream.
- **NO_REPLY sentinel leak on cron turns (#2056).** Three guarded layers
  (Stop-hook scan with a cron-scoped carve-out, gateway flush-gate skip,
  PreToolUse reply guard) stop a `NO_REPLY`/`HEARTBEAT_OK` sentinel from
  leaking into chat when a cron turn ends in `prose\nNO_REPLY`.

## v0.14.30 — "message me anytime" on the worker ticker

After an agent delegates to a background worker and ends its turn, the
ambient cross-turn ticker edits the agent's last reply in place every 60s
with a `— still working (Nm)` suffix. That silent ticker read as *"agent
is unresponsive"* — so the user waited instead of messaging, even though
the agent was reachable the whole time (a background-worker dispatch never
sets `turnInFlight`, so an inbound user message is delivered as a fresh
turn, never buffered or raced against the handback).

The gap was signaling, not capability. The fix is copy.

### Reachability suffix (#2057)

- The ticker suffix becomes `— still working (Nm) · message me anytime,
  I'll keep you posted`, telling the user they can reach in at any moment
  while the worker runs.
- Pure render/copy change — no new dispatch path, no model call, no typing
  churn. Edited in place every 60s exactly as before (jsonl-tail → render
  only), so it stays inside the subscription boundary. The suffix stays
  plain-text-safe under HTML parse_mode (no `<`, `>`, `&`).
- `SUFFIX_RE` (the strip-before-reappend guard) made backward-compatible
  — the new reachability clause is optional so an in-flight anchor carrying
  a pre-upgrade suffix is still stripped on the next edit during a rolling
  fleet upgrade.

## v0.14.29 — Worker cards finish, the 👍 waits for them

Two bugs in the native Telegram background-worker progress card (shipped
v0.14.27): once a background `Agent` worker finished, the parent agent's
done-reaction fired prematurely on the original request, and the worker
card hung at `running` for ~9 minutes before terminalising. Both are now
bound to authoritative completion signals.

### Worker completion (#2051)

- **Authoritative early terminal.** A background worker's JSONL on claude
  ≥2.1.156 never writes the `system/turn_duration` line the card relied on
  for `sub_agent_turn_end`, so the card only terminalised via the ~9-minute
  silent-stall synthesis. The session-tail projector now emits
  `sub_agent_turn_end` the moment the worker's final assistant message
  carries `stop_reason === 'end_turn'` — emitted after the summary text so
  the card renders the result, and a no-op if a later real `turn_duration`
  arrives (the watcher's handler is guarded on `state === 'running'`).
- **Deferred 👍 reads the dispatch-time DB, not the lagging registry.** The
  done-reaction gate counted running workers from the file-discovery
  in-memory registry, which lags dispatch by a poll/fswatch tick. With the
  ack-first pattern (reply "On it" → dispatch worker → end turn), the
  parent turn-end fired before the worker was registered → count 0 → the
  👍 promoted immediately on an incomplete request. The gate now reads the
  registry DB, where `recordSubagentStart` inserts the row the instant the
  `Agent` tool_use fires (before turn-end).
- **`stalled` rows don't wedge the gate.** `countRunningBackgroundSubagents`
  counts `status = 'running'` only. A `stalled` row is the reaper's sink for
  an orphaned dispatch (row inserted, JSONL never linked) and is never
  terminalised — counting it would hold the 👍 forever. A live-but-quiet
  worker reaches `completed` via the watcher's terminal paths long before
  the 1h reaper, and a stalled row that genuinely resumes is flipped back to
  `running`, so excluding `stalled` never releases the 👍 on a merely-paused
  worker.

## v0.14.28 — Secrets never leave the box in plaintext

A secret-handling hardening release. A live Coolify/Laravel Sanctum API
token (`<id>|<token>`) a user pasted into chat was not redacted and
persisted in plaintext (token since revoked). This release closes the gap
in both directions and removes the reason an agent would ever ask for a
paste.

### Secret detection + redaction (#2043, #2046)

- **Sanctum/Coolify pattern.** Added a `laravel_sanctum_token` rule
  (`\d+\|[A-Za-z0-9]{40,}`, high-confidence) to the shared `detectSecrets`
  engine, so the inbound gate, the `redact()` mask, and the issues
  pipeline all cover the `<id>|<token>` shape uniformly. Diagnosis: the
  inbound gate already detects at ingest, fail-closed, before persistence
  — the leak was pure pattern coverage, not a bypass.
- **Both-direction storage redaction.** `redact()` now masks at the
  `history.ts` persistence chokepoint (`recordInbound` / `recordOutbound` /
  `recordEdit`), so no detected secret lands in the message store in
  either direction. `redact()` moved into the plugin (src re-exports).
- **Outbound transport redaction.** Agent-authored text is masked before
  it reaches Telegram or the stderr preview — at the entry of `reply`,
  `stream_reply`, `edit_message`, and the turn-flush backstop. Mutates in
  place like the voice scrub, keeping answer-stream diffing consistent.

### Agent-requested secrets — secure save-card (#2045)

- **`request_secret` tool.** Agents must never ask a user to paste a
  secret into chat. When an agent needs a credential that isn't in the
  vault, it calls `request_secret(key, reason)`; the operator gets a
  `[Provide securely]` card, sends the value once, and the gateway deletes
  the message + writes it straight to the vault. The raw value is never
  recorded, logged, or returned to the agent — it only ever sees
  `vault:<key>`. Third sibling of `vault_request_save` / `vault_request_access`.
- `TELEGRAM_GUIDANCE` updated: agents are told to use `request_secret` /
  `vault_request_save` / `vault_request_access` and never request a chat
  paste.

### Also

- Agent-voiced "continuing" message on permission verdicts (#2048).
- Worker card no longer leaks raw `##` Markdown / multi-line steps (#2050).
- Guard-test fix: `vsp:` callback prefix documented in the dispatcher
  consistency check (follow-up to #2045).

## v0.14.27 — Native Telegram worker card (#2041)

The background-worker card (the live, edit-in-place card a
`run_in_background: true` sub-agent gets) now renders as clean Telegram
HTML that matches the normal activity card, instead of leaking raw
model-authored Markdown.

Before, `renderWorkerActivity` HTML-escaped the model's text but never
stripped Markdown, so `**bold**`, backticks, and `---` rules rendered as
literal characters in Telegram — the card looked half-finished and
off-style versus the framework's other cards.

Now:

- A shared `stripMarkdown` + `cleanWorkerResultParagraph` pair in
  `telegram-plugin/card-format.ts` removes emphasis, inline code, links,
  headings, list/quote markers, horizontal rules, and code fences before
  the text is escaped and placed into the card.
- The card body is a `✓` / `→` step feed (newest step bold-arrowed,
  prior steps checked, older steps collapsed into a `+N earlier…`
  overflow line) — the same visual grammar as the foreground
  tool-activity summary.
- The terminal card shows a `finished · completed|failed · N tools ·
  MM:SS` line, a divider rule, and a cleaned one-paragraph result with a
  `✅`/`⚠️` lead.

No behavior change to dispatch, throttling, or the
`SWITCHROOM_WORKER_ACTIVITY_FEED` flag — this is presentation only.

## v0.14.26 — Bump bundled claude CLI to 2.1.159

Moves the hard-pinned `@anthropic-ai/claude-code` from **2.1.156** to
**2.1.159** in both images that bundle it (`docker/Dockerfile.base`, used
by every agent, and `docker/Dockerfile.hindsight`, used by the memory
provider). 2.1.156 was pinned in v0.14.8 as the build that fixed the
Opus 4.8 "thinking block cannot be modified" 400 under low reasoning
effort (#1978); the 2.1.157–2.1.159 changelogs contain no revert of that
fix and no breaking changes affecting switchroom's MCP / hooks / session
path. The bump is gated on a live-turn canary (test-harness, Opus 4.8 at
low effort) confirming the 400 does not return before fleet rollout.
2.1.157 also auto-loads `.claude/skills` without a marketplace and
hardens managed-settings MCP allow/deny parsing.

## v0.14.25 — Surface foreground sub-agent activity after the ack

### PR — surface foreground sub-agent activity after the ack-first reply (#2034)

Fixes the foreground sub-agent visibility blindspot: a FOREGROUND
sub-agent (`Agent`/`Task` *without* `run_in_background`) runs inline in
the parent turn and its live steps were meant to nest into the parent's
activity-summary feed (the #2027 "Model A" nesting). But every render
path bailed on `turn.replyCalled`, and the framework's ack-first pattern
replies "On it…" **first** and then delegates — so the sub-agent always
ran with `replyCalled` already true and **nothing ever painted**. #2027
only tested the pure renderer, so the regression shipped silently (the
"marko's researcher showed no Telegram activity" report).

The render gate no longer depends on `replyCalled`. The decision is
extracted into a pure, tested seam (`gateway/foreground-nesting.ts`):
`shouldRenderForegroundProgress` keys only on the kill-switch
(`SWITCHROOM_FOREGROUND_SUBAGENT_NESTING`, default on), and
`foregroundFinishAction` drives the post-ack hand-off (clear the feed
when the last foreground sub-agent finishes, recompose while others run).
Because a foreground `Task` blocks the parent, any `replyCalled` seen
while it runs is necessarily an interim ack, never the final answer — so
surfacing the nested narrative post-ack is always correct.

Classification is task-agnostic: foreground vs. background keys solely on
`run_in_background` in the PreToolUse tracker hook, never on
`subagent_type`. A generic sub-agent narrates the same as a researcher.

### PR — UAT for foreground sub-agent activity nesting (#2035)

Adds the mtcute UAT (`jtbd-foreground-subagent-activity-dm.test.ts`) that
exercises the fix end-to-end: forces the ack-first shape, dispatches a
FOREGROUND general-purpose sub-agent that narrates eight paced steps, and
asserts the activity-summary feed message carrying the nested marker
("↳") surfaces **after** the ack and advances in place. Plus a unit
regression guard (`foreground-nesting.test.ts`) pinning the
`replyCalled`-independence directly, so the blindspot can't return
silently.

## v0.14.24 — Age-bound the boot-promotion (stale-handback hotfix)

### PR — age-bound the boot-promotion so stale dead workers don't replay (#2032)

Hotfix for a regression introduced by #2029 (shipped in v0.14.23). That
change promoted **every** background-worker JSONL that was still in a
`running` state at boot to live (`historical = false`), on the assumption
that "running at boot = an in-flight worker whose handback the user is
still awaiting across a restart." But a worker process that died in a
prior session without writing its terminal `turn_end` line *also* sits
permanently in `running` state, and these dead files accumulate by the
hundred in a long-lived agent's `subagents/` directory. On the v0.14.23
fleet rollout, every agent's boot scan promoted all of them and replayed
weeks-old handbacks — many `failed`, from long-stale error lines — as
fresh inbounds. Result: a fleet-wide spam of stale "worker failed"
messages.

The promotion is now gated on **file freshness**. At boot we only promote
a `running` file to live if its mtime is within
`inflightPromoteMaxAgeMs` (default **15 minutes**) — comfortably above a
container-recreate + image-pull gap, far below the weeks-old staleness of
a dead prior-session worker. Stale files take the "leaving historical"
branch: no handback **and** no stall-synthesis (the historical guard in
`checkStalls` already suppresses both). `entry.lastActivityAt` /
`dispatchedAt` are both stamped `now` at boot registration and so carry no
freshness signal — `fs.statSync(filePath).mtimeMs` is the only reliable
per-file boot-time freshness signal, and is what the gate reads.

A kill-switch ships alongside: `SWITCHROOM_SUBAGENT_BOOT_PROMOTE=0`
disables boot-promotion entirely (every `running`-at-boot file stays
historical), and `SWITCHROOM_SUBAGENT_INFLIGHT_MAX_AGE_MS` overrides the
window. The fixed boot scan suppresses the stale files, so the rollout
that carries this fix is itself clean.

## v0.14.23 — git-lfs in the base agent image; background-worker handback gaps

### PR — close two background-worker handback gaps (#2029)

Two gaps in the background-worker handback path. **Gap 1:** a worker that
was genuinely in-flight when the agent restarted was treated as
`historical` by the boot scan and its handback was silently dropped, so a
user who dispatched a long background task and then triggered (or rode
through) a restart never got woken when it finished. The boot scan now
promotes a `running`-at-boot worker to live so its `onFinish` handback
fires. **Gap 2:** a worker that finished in a `failed` state produced the
same generic "Worker done" handback as a success, giving the agent no
signal to tell the user the task errored. The handback now carries an
`errored` flag + `errorDetail`, and the outcome is rendered as
`failed` / `orphan` / `completed`.

> Note: Gap 1's unconditional promotion caused a stale-replay regression
> on long-lived agents — see v0.14.24 (#2032) for the age-bound fix.

### PR — add git-lfs to the base agent image (#2030)

Agent containers shipped without a `git-lfs` binary, so any repo an agent
clones that tracks large assets via LFS (images, video, SQLite DBs) would
materialise those files as 130-byte pointer stubs rather than the real
content — and a naive `git add`/commit would push the raw pointer or, with
the smudge filter unconfigured, the raw binary. Agents working with a media
or content library (e.g. a marketing agent reusing historical social posts,
photos, and video) had no usable path to the actual bytes.

`docker/Dockerfile.base` now installs `git-lfs` and runs
`git lfs install --system --skip-repo`, registering the LFS smudge/clean
filters in `/etc/gitconfig` so they apply to every per-agent `HOME` (a
`--global` install wouldn't persist, since each agent boots a fresh home).
`tests/docker/e2e.test.ts` gains `git-lfs` to the Tier-1 binary-presence
loop and a new assertion that the system-wide smudge filter resolves to
`git-lfs smudge`.

This is a base-image change: it reaches the fleet on the next image build +
rollout. No CLI/runtime behaviour changes.

## v0.14.22 — Foreground sub-agent visibility + self-resuming interrupted turns

Two visibility/reliability features land on top of the v0.14.21 worker
feed, closing the next gap in the "you hold the leash — awareness +
control" outcome.

### PR — foreground sub-agent steps nest in the parent's live draft (#2027)

Background workers got a live `🔧 Worker` feed in v0.14.21. This release
closes the **foreground** sub-agent blindspot — the larger, more common
case. A foreground sub-agent (`Task`/`Agent` with no `run_in_background`)
runs inside the parent's turn, and previously surfaced only as the
parent's `→ Delegating: <desc>` line plus a ticking timer — zero internal
detail.

Now its live narrative **nests under the parent's own activity feed**: the
parent's lines render done (`✓`) while it's blocked at the Task tool, and
the sub-agent's recent steps render as an indented `↳` block with the
newest as the in-progress `→` step. The block collapses when the
sub-agent finishes (its result returns inline as the Task tool result).

This edits the same activity-summary message the existing tool-label feed
owns — not the compose draft — so there's no answer-stream contention.
Pure jsonl-tail → render: no model call, inside the subscription-honest
boundary. ON by default; `SWITCHROOM_FOREGROUND_SUBAGENT_NESTING=0`
disables only the nesting (the parent's own feed is unaffected).
Background workers are unchanged.

### PR — agents wake and resume interrupted turns on their own (#2026)

Agents now detect a turn that was interrupted (restart / crash mid-turn)
and resume it on their own rather than leaving the user hanging.

## v0.14.21 — Inbound coalescing + worker feed + safe-boundary interrupt, on by default

v0.14.20 shipped the inbound-coalescing / worker-visibility series
default-off so it could roll out with zero behaviour change. This
release **flips all three behaviours on by default** — they are now the
standard experience, not an opt-in — and adds the end-to-end UAT gate
that was missing for the album path.

Each default lives in a single pure resolver (mirroring the existing
`resolveInterruptMaxWaitMs` seam) and is pinned by a unit test, so the
default can't silently regress. Operators can still set the config field
explicitly to restore the old behaviour.

### PR A — flip the three defaults on (#2021)

- **Album / multi-attachment coalescing** —
  `channels.telegram.coalesce.max_attachments` now defaults to **10** (a
  full Telegram album) instead of 1. A forwarded album or text+multi-image
  burst folds into a single Claude turn: the agent sees the primary
  attachment plus numbered siblings (`image_path_2`, …) and an
  `attachment_count`. Attachments past the cap still spill into the next
  turn (nothing is dropped). Set `max_attachments: 1` to restore the old
  one-image-per-turn behaviour.
- **Deferred safe-boundary `!` interrupt** —
  `channels.telegram.interrupt.safe_boundary` now defaults to **true**. A
  `!`-prefix interrupt that arrives mid-tool-call defers to a clean
  boundary (the in-flight tool's `tool_result`, or turn end) instead of
  SIGINT-ing the agent partway through a `Write`/`Bash`. Acked immediately
  with ⚡; `max_wait_ms` (default 8000, unchanged) caps the wait. A bare
  `!` (halt-now) and an empty body still fire immediately. Set
  `safe_boundary: false` to restore fire-immediately-always.
- **Worker-activity feed** — the live background-worker feed
  (`SWITCHROOM_WORKER_ACTIVITY_FEED`) is now **on unless explicitly set to
  `0`**, rather than requiring `=1`. (It was already enabled fleet-wide;
  this makes the default match the rollout.)

### PR B — album-coalescing end-to-end UAT gate (#2023)

The album path had unit + fuzz coverage but no end-to-end gate, and the
mtcute UAT driver couldn't even send a `media_group`. This adds
`driver.sendAlbum()`, three committed JPEG fixtures, and
`jtbd-album-coalescing-dm.test.ts` — which sends a real 3-photo album and
asserts the agent reports seeing **3** images in one turn (a
non-coalescing gateway answers 1). The matcher anchors on a distinctive
`IMAGECOUNT=<n>` token and drains to the final reply, so the now-default-on
worker feed and progress-card timers can't collide with the count.
Test-only; doubles as the rollout canary.

### PR C — memory-recall matcher skips the worker feed (#2020, #2022)

Two test-only follow-ups so the memory-survives-restart recall scenario
ignores worker-feed messages (now default-on) when matching for the
agent's own reply, instead of latching onto the feed's first paint.

## v0.14.20 — Inbound bursts + a live worker feed that reads like the agent

This release lands the four-PR inbound-coalescing / worker-visibility
series. Every new behaviour is **default-off or flag-gated**, so the
release rolls out with zero behaviour change until opted in.

### PR A — forwarded-burst UAT scenario (#2014)

A real-mtcute UAT scenario that pins the v0.14.18 inbound-coalescing
behaviour end-to-end: a rapid forwarded burst of messages from one
sender merges into a single Claude turn rather than firing a reply per
fragment. Test-only; no runtime change.

### PR B — A2 multi-attachment / album inbound coalescing (#2015)

`channels.telegram.coalesce.max_attachments` (default **1** — unchanged
behaviour) can now be raised to fold a forwarded album (`media_group_id`)
or a text+multi-image burst into one turn. The agent sees the primary
attachment in the usual `image_path` / `attachment_file_id` fields plus
numbered siblings (`image_path_2`, …) and an `attachment_count`.
Attachments past the cap spill into the next turn (nothing is dropped).
At the default cap of 1 the historical single-attachment behaviour is
preserved exactly.

### PR C — deferred safe-boundary `!` interrupt (#2016)

`channels.telegram.interrupt.safe_boundary` (default **false**) defers a
`!`-prefix interrupt that arrives **mid-tool-call** to a clean boundary
(the in-flight tool's `tool_result`, or turn end) instead of SIGINT-ing
the agent partway through a `Write`/`Bash`. Acked immediately with ⚡;
`max_wait_ms` (default 8000) caps the wait so a long tool never ghosts
the interrupt. A bare `!` (halt-now) and an empty body always fire
immediately. Rapid repeated `!` while one is parked coalesce into a
single interrupt carrying the latest body. Off by default — existing
fire-immediately behaviour is unchanged.

### PR D — growing worker-activity feed narrative (#2009)

The live worker-activity feed (the edit-in-place message that surfaces a
*background* sub-agent's progress, behind `SWITCHROOM_WORKER_ACTIVITY_FEED`)
now **grows** a block of `↳` narrative lines — reading like the main
agent's live answer — instead of collapsing each tick onto a single
replaced line. Lines are deduped against the preceding line and capped to
the last 6; accumulation happens before the throttle/cooldown/first-paint
gates so a line is never lost. The hard limit stands: during a single
long tool the watcher emits no narrative, so the feed legitimately holds
(event-granular surfacing, not token smoothing).

## v0.14.19 — Scannable replies, for real + resuming-beat across gates

### Scannable formatting reaches agents via the live carrier (#2012)

v0.14.18's #2008 added multi-section formatting guidance to
`profiles/_shared/telegram-style.md.hbs` — but that fragment is **orphaned
dead code**: no template uses `{{> telegram-style}}` anymore (the fleet
moved its "Lane 1" invariants out of per-agent `CLAUDE.md` into the
release-controlled `~/.switchroom/fleet/switchroom-invariants.md`). So the
guidance never reached a single agent. This adds a **"Formatting — make it
scannable"** subsection to the live carrier — the `TELEGRAM_GUIDANCE`
constant in `src/agents/scaffold.ts`, rendered by `renderFleetInvariants()`
and loaded by every agent via `--add-dir ~/.switchroom/fleet`. Conversational
one-liners stay minimal; multi-section messages (status updates, summaries,
and the message posted **before kicking off a sub-agent/worker**) get a bold
label on each section's own line plus blank-line spacing. Takes effect
fleet-wide on apply + restart.

### Resuming beat + awaiting-reaction across permission gates (#2011)

Carried in from upstream/main — permission-gate flows now emit a resuming
beat and preserve the awaiting-reaction state across the gate.

## v0.14.18 — Inbound burst coalescing + scannable status replies

### Coalesce forwarded / split-paste bursts into one turn (#2007)

Forwarding several Telegram messages — or pasting a long block Telegram
splits across messages — made Claude reply to each fragment as its own
turn, reasoning with partial context. Media handlers now route through
`handleInboundCoalesced` (with three guards that keep album / multi-
attachment behaviour identical to today — at most one attachment per
flush, no silent drops), and a new pure `planBufferedRedelivery`
collapses consecutive same-`(chat,thread,user)` source-less inbounds on
buffer drain. System inbounds (vault grants, approvals, cron, handbacks)
never merge. New cascade knob `channels.telegram.coalesce.window_ms`
(default 500ms, `0` disables); the 👀 ack still fires on the first
message so perceived latency is unchanged.

### Visual hierarchy for multi-section status replies (#2008)

Agents posted "where things stand" / worker-dispatch updates as emoji-
prefixed plain-text lines with no bold and no blank-line spacing, so
every line carried equal weight and the message read as a flat wall on
mobile. The markdown→HTML converter can't enrich what the model never
marks up — so this is a prompt-guidance fix in
`profiles/_shared/telegram-style.md.hbs`, not a converter change. It
relaxes the "bold sparingly / no headings" rule **only for multi-section
messages**: bold the section label on its own line (`**✅ Done**`,
`**🔲 Remaining**`, `**Next**`) with one blank line between sections.
Short conversational replies stay minimal — hierarchy is reserved for
grouped updates, keeping inside the "chat is the artifact, not a
dashboard" principle.

## v0.14.17 — Worker-feed hardening: regression pin + docs/comment sweep (#2004)

Hardening pass on the v0.14.15/16 worker-activity feed — no behaviour
change, all default-off.

The real-task-description wiring shipped in #2002 (feed header renders
`🔧 Worker · <real task>` from the `subagents` registry row) had no fast
test pinning it — only the slow, non-gating mtcute UAT. A refactor could
have silently swapped it back to the watcher's generic `'sub-agent'`
placeholder and CI would stay green. This release closes that gap:

- New DB-free pure helper `resolveWorkerFeedDispatch(sub, watcherDescription)`
  (`telegram-plugin/gateway/worker-feed-dispatch.ts`) returns
  `{ isBackground, feedDescription }`, preferring a non-empty registry
  description and falling back to the watcher label on null/empty.
  Pinned by `worker-feed-dispatch.test.ts` (6 cases, runs under both
  vitest and bun).
- `gateway.ts` `onProgress`/`onFinish` now route the registry read
  through the typed `getSubagentByJsonlId` helper + `resolveWorkerFeedDispatch`,
  replacing two copies of inlined raw SQL — behaviour-preserving,
  reviewer-confirmed equivalent.
- Swept the stale `subagent-watcher.ts` comment that implied
  `WorkerEntry.description` carries the real task name (it's a fixed
  `'sub-agent'` placeholder, never reassigned) — it now points readers
  at `resolveWorkerFeedDispatch`.
- Updated JTBD (`reference/know-what-my-agent-is-doing.md`), user docs
  (`docs/telegram-plugin.md` + env-var table), and agent guidance
  (`CLAUDE.md`).

## v0.14.16 — Worker-feed real task description + live UAT (#2002)

Follow-up polish to the v0.14.15 worker-activity feed. The feed header
rendered `🔧 Worker · sub-agent` because `entry.description` was never
reassigned from its init default — the real dispatch description was
sitting unused in the registry DB. The gateway now reads the real
description from the `subagents` registry row in both the live
(`onProgress`) and terminal (`onFinish`) paths, so the feed renders
`🔧 Worker · <real task>` (e.g. `🔧 Worker · Background ten-step
worker`). The `onFinish` restructure moves the feed `finish()` call
after the registry query while keeping `deferredDoneReactions.promote()`
unconditionally first — behaviour-preserving, reviewer-confirmed.

Also lands the end-to-end mtcute UAT scenario
(`jtbd-worker-activity-feed-dm`) that dispatches a real background
worker and asserts the full feed lifecycle: first paint (`🔧 Worker`),
in-place edit while work is in flight, and terminal recap (`✅ Worker
done · … / N tools`). The UAT worker is paced (~10 short narrated steps,
~2s jsonl gaps) to stay under the test-harness stall window
(`SWITCHROOM_SUBAGENT_STALL_MS=5000`) so it runs to real completion
instead of tripping a synthesized terminal turn_end mid-flight. Feed
stays default-off (`SWITCHROOM_WORKER_ACTIVITY_FEED`).

## v0.14.15 — Background-worker visibility (#1999, #2000)

A *background* sub-agent (`run_in_background: true`) decouples from the
parent turn. Two gaps made a dispatched background worker read as
**silence** once its parent turn ended — exactly the JTBD
**you-hold-the-leash** awareness gap an operator hit watching a worker
go quiet. This release closes both.

### PR A — hold 👍 until the last background worker finishes (#1999)

When a turn ended with a background worker still running, the reply got
its terminal 👍 (done) reaction immediately — implying the work was
finished while the worker was still grinding away. The 👍 is now
*deferred* while any background worker for the turn is still running:
the reply holds the working reaction (✍️/⚡) instead, and promotes to 👍
only once the last worker terminates. A worker finishing promotes iff
none remain running, so multi-worker turns settle correctly.

### PR B — live worker-activity feed (#2000, flag-gated)

New `SWITCHROOM_WORKER_ACTIVITY_FEED` surface (default **off**): while a
background worker runs, the gateway posts **one regular Telegram message
per worker and edits it in place** as work happens — current tool +
short summary + elapsed — finalizing with a tool-count + duration recap
on completion. This is the same "live, growing message" shape the main
agent's answer uses, *not* card chrome (the pinned progress card was
deleted in #1126; "Chat IS the artifact" bars re-adding widgets).

The feed is watcher-driven (so it keeps surfacing activity after the
parent turn ends), background-gated, first-paint-delayed (trivial
sub-second workers stay silent — the handback reply covers them),
edit-throttled + body-deduped, and resilient to 429s and message_id
drift. When the flag is on it supersedes the coarse 5-min progress
bucket relay to avoid double-surfacing the same beat. Modeled on
`issues-card.ts` (pure render + injected bot API); 17 unit tests under
both vitest and bun.

## v0.14.14 — Handoff banner flag actually works on docker (#1997)

`session_continuity.show_handoff_line: false` is meant to suppress the
visible `↩️ Picked up where we left off …` line on the first reply after
a restart. It has been a **silent no-op on every docker agent since
v0.7**: the value reaches the agent only through start.sh, and the
gateway — the sole consumer — is forked in the docker preamble's *outer*
pass, *before* the export ran (the export lived in the inner tmux pass).
The forked gateway never inherited the var, so the flag did nothing.

The export now sits ahead of the runtime branch (still gated on
`handoffEnabled`), so it covers the docker outer fork pass, the inner
tmux pass, and the v0.6 non-docker path alike — mirroring the existing
`TELEGRAM_STATE_DIR` hoist that solved the identical fork-ordering
problem. A regression test pins the export ahead of the gateway fork and
to exactly one occurrence. Serves **you-hold-the-leash**: a documented
config field that silently does nothing erodes trust in the cascade.

## v0.14.13 — Readable, durable permission grants (#1994, #1995)

Reworks the Telegram tool-approval card so a non-technical operator can
read it, and makes "always allow" both *persist* for every agent and
*express its grant scope* before the operator commits it. Two pillars of
the vision met at once: **you hold the leash** (control is legible and
trustworthy) and a **standing team that knows you** (grants survive
restarts without re-prompting).

### PR A — always-allow persists for every agent (#1994)

Tapping "🔁 Always allow" used to write durably only for the three
admin-flagged agents; for everyone else the rule was cached for the
session and then forgotten at the next restart ("Allowed for now —
'always' did NOT save"). The durable write only lands via the host-side
`switchroom-hostd` daemon's `config_propose_edit` flow, and only admin
agents had a hostd socket bound.

Now **every** agent gets a per-agent hostd socket (path-as-identity,
forge-resistant), but binding a socket does **not** grant admin. Exactly
one self-scoped verb is opened to non-admin agents: a
`config_propose_edit` that may only add rules to *its own*
`agents.<self>.tools.allow`. Server-side `assertSelfScopedAllowEdit`
enforces additive-only + own-allow-list-only (deep-equal after stripping
the caller's own allow list); any edit that touches another agent, flips
`admin`, or removes a deny is rejected `E_NOT_SELF_SCOPED`. Every other
hostd verb stays admin-gated.

### PR B — human-readable scoped permission card (#1995)

The card no longer shows raw tool identifiers like
`mcp__perplexity__search` or `Edit:`. It reads as a plain sentence —
`🔐 Gymbro wants to edit: supplement-log.md` with a `why:` line — and
the action row is compact: `❌ Deny · ✅ Allow once · 🔁 Always…`.

Tapping **🔁 Always…** swaps the row for a scope choice —
`← Back · This file · Any file ⚠️` — so the breadth of an always-grant
is visible *before* it is committed; the ⚠️ rides the broadest option
only. After a grant lands, the confirmation is phrased from the chosen
scope ("gymbro can now edit supplement-log.md without asking" /
"…use any Perplexity tool…"). The session-scoped allow cache (#1138)
now understands the scoped rule forms (`Edit(path)`, `Bash(tok:*)`,
`Skill(name)`, `mcp__server__*`) so sub-agent tool calls still
short-circuit the prompt.

## v0.14.12 — Web service container (dashboard + webhook receiver) (#1992)

Phase 3 of the Docker-native webhook work. Packages the `switchroom web`
server — the dashboard **and** the GitHub-webhook receiver — as an
image-pinned container (`switchroom-web`) in its own compose project,
replacing the legacy `switchroom-web.service` systemd unit that ran the
server straight off the shared source checkout. That arrangement was
fragile: another agent's worktree activity could delete the hoisted root
`node_modules` out from under the long-lived process, crash-looping the
next restart on ENOENT. Pinning it to an image makes it immune to repo
churn and brings the last systemd holdout in line with the rest of the
fleet.

New `switchroom webd <install|status|uninstall>` lifecycle (mirrors
`switchroom hostd`). Three load-bearing properties of the compose shape,
each forced by what the web service is:

- **`network_mode: host`** — the server must own host loopback
  `127.0.0.1:8080`, where the cloudflared tunnel (webhooks) and
  `tailscale serve` (dashboard) both reach it; the dashboard CSRF gate
  trusts the `Tailscale-User-Login` header only on loopback (PR #1380).
- **runs as the operator uid** — the receiver's forward to each agent's
  `webhook.sock` is peercred-gated to `{agent uid, operator uid}`; any
  other uid is silently `503`'d. `webd install` refuses to write a
  root-uid compose so the silent-breakage class can't recur.
- **no docker socket, no added caps, `no-new-privileges`** — minimal
  surface for the one internet-facing component.

`switchroom update` refreshes the container only when the new
`web_service.managed` flag is `true` (**default off**), so existing
systemd-mode installs are not surprised by a container takeover of
loopback `:8080`. The systemd unit is intentionally left in place —
cutover is a deliberate manual step, and rollback is seconds. See
`docs/webhook-ingest.md` § Deployment.

## v0.14.11 — Cloudflare-only webhook edge lock (#1989)

Phase 2 of the Docker-native webhook work. Adds a per-agent opt-in
`channels.telegram.webhook_require_edge` (**off by default**). When set,
every webhook request must carry an `X-Switchroom-Edge` header matching
the operator's secret at `~/.switchroom/webhook-edge-secret` — injected
by a Cloudflare Transform Rule on `hooks.switchroom.ai` — *before* any
HMAC verification runs, or it is rejected `403`.

The per-agent HMAC proves *who signed the body*, not *which network path
the request took*. This closes the gap where anyone reaching the tunnel
origin directly (or an SSRF from a co-located service) bypasses the
GitHub-IP WAF: the edge header proves "this request entered through our
Cloudflare edge", which nothing else on the request can. It **stacks on**
the existing WAF + per-agent HMAC — it replaces neither.

**Fail-closed**: when an agent requires the lock but the secret file is
missing or empty, every request is rejected — a misconfigured control
denies, it never falls open. The gate runs before the HMAC work so a
non-edge request is cheaply denied and never consumes a signature
verification, and the `403` body leaks no detail (the reason goes only
to the operator log). Receiver-side only — no gateway, compose, or
agent-image change, and orthogonal to `webhook_via_gateway`. When the
flag is unset the existing receiver path is byte-for-byte unchanged.
Implements `docs/rfcs/webhook-cloudflare-edge-lock.md`.

## v0.14.10 — Docker-native GitHub webhook ingest (#1986)

Fixes GitHub webhook delivery on Docker installs. Since the
systemd→Docker migration, agent state dirs are owned by the per-agent
container UID, so the host-user web receiver could no longer write
`<agentDir>/telegram/webhook-events.jsonl` (EACCES → HTTP 500 → GitHub
marking the hook broken). A second latent gap: the webhook dispatch
helper had no production caller, so even a successful write never woke
the agent.

This release adds an opt-in path (`channels.telegram.webhook_via_gateway`,
**off by default**) that routes webhook ingest through the per-agent
**gateway** — which runs as the agent's container UID and already owns
that state dir. The gateway binds a dedicated peercred-gated
`webhook.sock` (allowing only the agent's own UID and the host operator
UID, conveyed via the new `SWITCHROOM_WEBHOOK_RECEIVER_UID` compose
env); the host web receiver becomes a thin stateless verify + render +
forward, mapping the gateway's response to the right HTTP status so
GitHub's retry semantics are preserved (202 ok / 200 deduped / 500
error / 503 unreachable). Dispatch is wired in-process through the same
`inject_inbound` synthesized-turn path cron uses — no new model
callsite. The whole gateway-side path is behind a defensive boot guard
that can never crash the gateway, and `resolveChannelTarget` was
extracted into a node-cron-free leaf so the gateway bundle stays lean.
Implements `docs/rfcs/webhook-via-gateway-socket.md`. When the flag is
unset, the existing receiver path is byte-for-byte unchanged.

## v0.14.9 — activity feed is the unconditional default (#1984)

The live tool-activity feed (#1982) is now **on for every agent by
default**. The `SWITCHROOM_DRAFT_MIRROR` env flag and its kill-switch
are removed: the flag existed to guard the *earlier* draft-slot design
that contended with the answer-stream, and #1982 already moved the feed
onto a separate in-place edited message (reply-quoted), so there is
nothing left for the kill-switch to protect. New agents and fresh
installs get the feed with zero config.

The deprecated legacy verb-count summary lane ("Ran 5 commands" —
`register`/`formatSummary`/`registerAndRender`/`verbForTool`) is deleted;
the feed renderers (`appendActivityLabel`/`renderActivityFeed` et al.)
remain. The feed is driven by the real-time PreToolUse `tool_label`
sidecar event, clears on the first reply (hand-off) and again at
turn_end (no-reply safety net).

## v0.14.8 — pin claude CLI to the thinking-block-fix build; durable approvals; activity feed

Bundles the claude-CLI thinking-block-400 fix, two reliability fixes
that merged to `main` since v0.14.7, and the flag-gated activity feed.

### Claude CLI pinned to `@2.1.156` (the 400-fix build)

`docker/Dockerfile.base` and `docker/Dockerfile.hindsight` now install
`@anthropic-ai/claude-code@2.1.156` (was `@latest`). 2.1.156 proactively
strips stale `thinking`/`redacted_thinking` blocks before re-sending the
assistant turn, which fixes the `400 "thinking blocks ... cannot be
modified"` failures that hit Opus 4.x agents under concurrent sub-agent
dispatch (see #1978). Hard-pinning makes the built image deterministic
and auditable — a CLI bump is now an explicit, reviewable one-line
change rather than "whatever `@latest` resolved at build time."

The hindsight image is pinned to the same version so the memory
provider runs the identical claude bundle as the agent containers —
a version skew there could reintroduce the thinking-block class of
failures on memory reflection.

### PR — durable always-allow approvals (#1979 / #1977)

Approval grants marked always-allow are now persisted durably via
hostd `config_propose_edit` instead of living only in process memory,
so they survive a gateway/agent restart.

### PR — doctor flags risky `thinking_effort` × adaptive-model combos (#1980 / #1978)

`switchroom doctor` now warns when an Opus 4.x agent is configured with
`thinking_effort` above the `low` floor — the combination that triggers
the thinking-block 400s above. Sonnet is explicitly exempt (it runs
higher effort fine in practice — avoids false alarms).

### PR — pin claude to the image binary, prune user-local shadows (#1981)

`start.sh` now resolves `claude` to the image-baked
`/usr/local/bin/claude` and prunes any user-local `claude` install
shadowing it on `PATH`, so an agent always runs the audited, pinned CLI
bundle rather than a stale per-HOME copy.

### PR — activity feed via in-place edited message + reply-quote (#1982)

The live tool-activity feed (`SWITCHROOM_DRAFT_MIRROR`, **default OFF**)
now renders through a single `sendMessage` that is then repeatedly
`editMessageText`-ed in place, reply-quoting the originating message,
instead of the old compose-draft transport that conflicted with the
answer-stream over Telegram's single draft slot. Dormant unless the
flag is enabled.

## v0.14.7 — cite Claude Opus 4.8 as the current flagship model (#1975)

Docs refresh: Opus 4.8 (released 2026-05-28) supersedes 4.7 as
Anthropic's most capable model. Example/reference model IDs across the
docs and copyable examples now cite `claude-opus-4-8`:
`docs/architecture.md`, `docs/cli-reference.md`, `docs/configuration.md`,
`docs/session-optimization.md`, `examples/switchroom.yaml`, and the
`switchroom-status` skill sample output.

No code change — the config schema accepts any model string and
switchroom passes `--model` straight through to the unmodified `claude`
CLI. Historical records (compliance-attestation analysis attribution,
RFC authorship lines) intentionally keep their 4.7 reference since they
document which model actually did that work.

Operator note: when pinning Opus 4.8, keep `thinking_effort` at the
`low` floor. Higher effort levels emit `thinking`/`redacted_thinking`
blocks that the claude CLI can reject ("thinking blocks ... cannot be
modified") once framework-side message rewriting touches the assistant
turn; omitting `thinking_effort` is worse, not better, because 4.8
defaults `effort=high` when unset.

## v0.14.6 — allowed_tools/disallowed_tools cascade from defaults (#1973)

Fixes a silent double no-op: `defaults.allowed_tools` (and
`disallowed_tools`) in switchroom.yaml was stripped at parse (the
fields weren't in `AgentDefaultsSchema`) **and** dropped at merge (no
cascade clause in `mergeAgentConfig`). An operator setting a
fleet-wide granular tool policy in `defaults` — e.g. pre-approving an
operator-defined MCP server's tools with
`allowed_tools: [mcp__perplexity, mcp__perplexity__*]` so agents stop
prompting on every first tool call — saw it silently ignored.

Root cause: `allowed_tools`/`disallowed_tools` are agent-only fields
(defined inline in `AgentSchema`, #199) and `AgentSchema` deliberately
does not spread `profileFields`, so they were never mirrored into the
defaults/profile levels (same convention `resources` follows).

Fix (3 parts):
- `schema.ts`: mirror both fields into `profileFields` so
  `AgentDefaultsSchema` + `ProfileSchema` accept them.
- `merge.ts`: cascade both in `mergeAgentConfig` — union, dedup-
  preserving-order (defaults first), mirroring `extra_stable_files`.
  Union (not REPLACE) so an agent's granular grants EXTEND the fleet
  policy; `disallowed_tools` / `tools.deny` remain the denial path.
- `merge.test.ts`: 6 cases (defaults-only cascade, union, dedup-order,
  agent-only, neither, disallowed_tools mirror).

Operator note: this is a HOST-CLI fix (the cascade runs at
`switchroom apply` time when start.sh is rendered). Activating a
`defaults.allowed_tools` policy needs `switchroom apply` + an agent
restart after upgrading the host CLI — no new agent image required.

Risk: low. The cascade clause only fires when a layer sets the field;
existing agent-only `allowed_tools` configs are unchanged, and
settings.json `permissions.allow` (built from `tools.allow`) is
untouched.

## v0.14.5 — first-turn-after-restart fix (session-tail replays in-flight enqueue)

### session-tail: replay an in-flight turn's enqueue on first attach (#1971)

The first turn after **every agent restart** silently lost its
`currentTurn`, so the **progress card, draft-mirror, and silence-poke**
were all dead for that turn (the reply still landed; the per-turn UI did
not). A pre-existing latent gap, surfaced while validating the
draft-mirror.

Root cause: the gateway sets `currentTurn` only from the `enqueue`
session event (the sole event carrying the chatId). The bridge's
session-tail emits `enqueue` when it reads the transcript's
`queue-operation enqueue` line — but on first attach it seeks to EOF
("only new events"). When the agent restarts mid-turn, or processes a
spooled inbound during boot, that enqueue line is written *before* the
tail attaches, so seek-to-EOF skips it → no `enqueue` → `currentTurn`
never set.

Fix: `computeFirstAttachCursor` does a bounded (1 MiB) tail scan on first
attach and, if it finds an in-flight turn (the last `enqueue` with no
`turn_duration` after it), replays from that enqueue's offset so the turn
gets its `currentTurn`. Completed turns still seek to EOF — no history
replay; re-attach (sub-agent file flips) is unchanged. Validated with
runtime instrumentation on the test-harness canary (cold turn:
`currentTurn=false` throughout → no draft; warm turn: `currentTurn=true`
→ accumulating HTML draft) plus 5 deterministic unit tests.

This also confirms the v0.14.3/v0.14.4 draft-mirror works correctly in
steady state — the only failing case was this first-post-restart turn.

## v0.14.4 — draft-mirror determinism fix (sidecar subscribe race) + CI/doctor

### draft-mirror: replay sidecar history to late subscribers (#1969)

The headline fix. v0.14.3's real-time sidecar (#1963) had a
subscribe-after-drain ordering bug that silently lost the entire
activity feed on exactly the turns it was built for, so the draft never
streamed. Found by live validation on the test-harness canary: a 28s
clustered-tool turn wrote a fully-populated sidecar
(`Bash`/`Read`/`ToolSearch` labels) yet produced **zero** `tool_label`
events and **no** `sendMessageDraft`.

Root cause: `createToolLabelSidecar` does an initial drain (`poll()`) in
its constructor, but the gateway's `ensureSidecar` wires `onLabel` only
*after* construction (`create → set → onLabel`). On a fast/clustered
turn — or any resumed/flipped session where the hook already wrote
labels — the initial drain consumes every row into the read offset with
an empty subscriber set, and the subscriber that attaches microseconds
later receives nothing.

Fix: buffer every ingested row (`label` + `tool_name`) in an ordered
`seen` log and replay it to each subscriber when it attaches via
`onLabel`, then register for future rows. Single-threaded, so each row
reaches the callback exactly once regardless of subscribe timing — the
sidecar is now deterministic no matter when the gateway subscribes
relative to the hook's writes. Still behind `SWITCHROOM_DRAFT_MIRROR`
(default OFF).

### other

- CI: docker-images now uses a GHCR registry cache instead of the flaky
  `type=gha` cache, fixing the recurring SAS-token-expiry / stalled-blob
  build failures on the heavy agent image (#1965 / #1968).
- gateway: a failed always-allow grant is now surfaced loudly and the
  grant is verified persisted before proceeding (#1967).
- doctor: new probe asserting approval-kernel DB durability —
  `allow_always` grants survive a container recreate (#1966).

## v0.14.3 — draft-mirror determinism (real-time sidecar) + pacing fixes

### draft-mirror: real-time via PreToolUse sidecar (#1963)

Makes the draft-mirror deterministic regardless of when the unmodified
`claude` CLI flushes its session transcript. Still behind
`SWITCHROOM_DRAFT_MIRROR` (default OFF; flag-off byte-identical).

The draft previously sourced from the lazily-flushed session JSONL, so
on fast/clustered-tool turns the tool_use rows weren't on disk until
~turn-end and the instant reply IPC suppressed the feed (zero draft
even on a 42s turn). It now sources from the **PreToolUse hook
sidecar**, written synchronously at tool-call time (flush-independent):
the hook labels every tool, the sidecar is created+subscribed eagerly
on session-attach, and a new real-time `tool_label` event drives the
draft — not gated on `replyCalled`, cleared at `turn_end` so a mid-turn
reply can't wipe it.

### pacing + fuzz (#1962)

Turn-pacing directive discourages the trailing `"Done."`/`"Sent."` the
model emits after its answer. Conversational-pacing fuzz de-staled:
`sleep`→`python3 time.sleep` (Claude Code's bash sandbox blocks
standalone `sleep`), and the CC-2 assertion tolerates a trailing
confirmation. Fuzz went 9→4 failing (remaining are reaction-observation
+ long-wait-ceiling edge cases, not regressions).

### other

- PR3b: turn-in-flight gate cut over to the delivery state machine
  (#1961). Docs: stale `claude -p` reference fix (#1960), drift-audit
  phase-4 report (#1959).



Phase 2 of the draft-mirror (#1957), still behind `SWITCHROOM_DRAFT_MIRROR`
(**default OFF**; flag-off behavior byte-identical to v0.14.1).

Phase 1 showed only the latest action in the compose-area draft; Phase 2
accumulates the turn's actions into a running, Claude-Code-style feed:

```
· Reading gateway.ts
· Searching memory
· List workspace
```

- `appendActivityLine` / `renderActivityFeed` (`tool-activity-summary.ts`)
  — chronological (newest last), `· ` bullets, consecutive exact-duplicate
  lines collapsed, capped to the last 6 with a `· +N earlier…` header so a
  heavy turn stays readable in the draft.
- Each line is still the model-authored friendly description from Phase 1
  (Bash.description, file basenames, "Searching memory", etc.) — never raw
  shell/query syntax.
- Telegram formatting: the feed is HTML-escaped before the `<i>…</i>` wrap
  (parse_mode HTML), so filenames/queries carrying `<`/`>`/`&` can't break
  parsing; newlines render as line breaks.

Flag-off path unchanged (the legacy verb-count summary). Ships dormant;
test-harness canary gates any default flip.



Bundles the composite-silent-noise leak fix with the parallel work that
merged to main since v0.14.0. Released off the main tip per the
merge-to-main-on-green model; each PR below was reviewed + CI-passed
independently.

### Gateway / UX

- **Suppress composite silent-noise leak (#1955).** After a clean
  reply, the model would emit a trailing `Sent.`, get re-prompted by
  the silent-end Stop hook, answer `NO_REPLY` once or twice, and the
  accumulated `Sent.\nNO_REPLY\nNO_REPLY` blob leaked to chat as a
  visible message (once per turn). Root cause: `isSilentFlushMarker`
  only matched a *single* sentinel; the multi-line composite exceeded
  the length guard. New `isCompositeSilentNoise` suppresses a blob
  whose lines are all silent markers / trivial confirmations with ≥1
  real marker present (conservative — never drops genuine answer text).
- **Proactive quota threshold push (#1931).** The gateway pushes a
  heads-up when usage crosses 80% of the window.
- **Remove auth-slot buttons that redirect to terminal (#1930).** Drops
  inline buttons whose only action was to send the user to a terminal
  flow that doesn't apply on the docker install.
- **Boot-card surfaces config changes since last boot (#1933).** The
  post-restart boot card now diffs config and lists what changed.

### Fleet / lifecycle

- **Worktree provisioning wired into reconcile + destroy (#1932).**
- **hostd: replace the `claude -p` deep probe with an auth-broker token
  check (#1929).** Removes a compliance-sensitive `claude -p` callsite
  in favour of a direct broker token introspection — aligns with the
  Claude-native / no-`claude -p` constraint.

### Docs

- Drift-audit refresh batch (#1902–1912): JTBD/principle/reference
  alignment, conversational-pacing emoji sequence, RFC promotions,
  posthog event tightening. No runtime impact.

(v0.14.0's friendly activity mirror (#1951) + webkite doctor (#1953)
are carried forward — v0.14.0 was tagged but never rolled to the fleet;
v0.14.1 is the first fleet rollout of the 0.14 line.)



Minor bump marking the **human-friendly activity** line: the agent's
"what am I doing" signal is now rendered from the model's own
plain-English descriptions, not developer tool jargon. Bundles two
merged PRs on top of the v0.13.x human-feel arc (fast-ack, turn-pacing
v4, draft-mirror Phase 1).

### Draft-mirror: friendly tool_use rendering (#1951)

Still behind `SWITCHROOM_DRAFT_MIRROR` (**default OFF**; flag-off
behavior is byte-identical to v0.13.65). The flag-on canary on
test-harness falsified the original Phase 1 premise (stream
`assistant.text` prose into the draft): on a normal tool turn the
model emits *no* interstitial prose — it goes `thinking` (redacted) →
`tool_use` → `reply`, so the prose draft was empty.

The real human-friendly signal lives in **`tool_use.input`, authored
by the model** — verified against a live session JSONL (1360 Bash
calls): `Bash.description` ("List workspace", never `ls -la`),
`Read`/`Edit`/`Write` file basename, `Grep` pattern, `Task`
description, `WebFetch` hostname, plus domain labels for hindsight
("Searching memory"), calendar, email, drive, notes. This is exactly
why Claude Code's own UI reads friendly — the model writes the
descriptions; the Bash tool *requires* one.

New `describeToolUse(name, input)` (`telegram-plugin/tool-activity-summary.ts`)
renders each tool_use as a present-tense, human-friendly line —
model-authored description, then domain label, then humanized name;
**never raw shell/query syntax**. Option A: uniform across code and
non-code agents — a health coach sees "Searching memory" / "Checking
your calendar"; a code agent sees "Editing gateway.ts" / the model's
own Bash description. Streams the latest action into the ephemeral
compose-area draft, clears on reply.

The prior Phase 1 `assistant.text`→draft transport flip is reverted
(that lane keeps visible-answer-stream). `drainActivitySummary` now
HTML-escapes content before the `<i>` wrap (the #1942 literal-tag bug
class — file names / descriptions can carry `<`, `>`, `&`). Design in
`docs/rfcs/draft-mirror-preview.md` (PIVOT section). Ships dormant;
the test-harness canary gates any default flip.

### Webkite doctor health section (#1953)

`switchroom doctor` gains a webkite section: binary architecture
check, cloakbrowser presence, and per-agent `.mcp.json` scaffold
wiring — so the webkite fleet-default integration (v0.13.62) is
observable from the standard health sweep instead of silently
degrading.



Fixes the webkite rollout's last gap. The webkite MCP server was wired
into every agent's `.mcp.json` and native WebFetch/WebSearch were
denied — but the `webkite_*` tools were never pre-approved in
`settings.json` `permissions.allow`. So the first "read this URL" turn
hit a Claude Code permission prompt and wedged (observed live on the
v0.13.63 fleet: "agent is requesting the skill/mcp").

Root cause was subtle: `switchroom apply` on a deployed (existing)
agent hits `writeIfMissing` — skipping the settings.json template —
then an MCP-merge block re-seeds `permissions.allow`. That block only
re-seeded `agent-config` + `hostd`, so webkite never reached existing
agents. Fresh-scaffold unit tests passed while the deployed fleet still
prompted.

`WEBKITE_MCP_TOOLS` (`mcp__webkite`, `mcp__webkite__*`) is now
pre-approved at all three allow-seed sites — fresh scaffold, reconcile,
AND the existing-agent merge loop — gated on the `mcp_servers.webkite:
false` opt-out. New regression test covers the existing-agent merge
path specifically; new UAT `jtbd-webkite-read-dm` DMs a JS-rendered SPA
URL without naming webkite and asserts the agent returns the JS-gated
content (webkite chosen unprompted + cloakbrowser renders JS + no
wedge). Live-validated: the agent returned the Einstein quote from
`quotes.toscrape.com/js/` in 49s.

(#1949)

## v0.13.64 — turn-pacing v4 (greetings) + draft-mirror preview Phase 1

Two changes, both about the "what is my agent doing / does it answer
me" feel.

### turn-pacing v4 — always reply to a direct message (#1946)

v0.13.61's v3 directive ("don't ack, only reply with substantive
content") over-corrected: the model began classifying bare social
messages — "hi", "hey", "you there?" — as not-substantive and ending
the turn with NO_REPLY, leaving a direct human message unanswered
(live clerk regression 2026-05-28: a plain "hi" sat silent for 300s
and only replied via the framework fallback). v4 leads with "ALWAYS
reply to a direct message" + an explicit greeting/thanks/question
carve-out, then keeps the no-placeholder-ack rule that killed the
"on it" spam. Single-string scaffold.ts change; the directive lives
in host-generated settings.json (no image dependency). New UAT gate
`greeting-reply-dm.test.ts` — bare "hi" → reply in ~16s (was:
NO_REPLY → 300s framework fallback).

### draft-mirror preview Phase 1 — flag-gated (#1947)

First step of the draft-mirror RFC (`docs/rfcs/draft-mirror-preview.md`):
stream the model's prose narration into the ephemeral compose-area
draft as a live "what's it doing" preview that clears when the reply
lands — reply stays the canonical committed answer. Behind
`SWITCHROOM_DRAFT_MIRROR` (**default OFF — zero behavior change** until
explicitly enabled). When on, narration routes to `sendMessageDraft`
and the activity-summary tool-count draft is suppressed to avoid
colliding on the single per-chat draft slot. No-reply delivery is
owned by turn-flush (not answer-stream materialize, which is dead on
the draft-only path). Vision-evolution of `know-what-my-agent-is-doing`
(model's own words, ephemeral) — not the retired #1122 persistent card.
Ships dormant; the flag-on canary on test-harness gates any default
flip (Phase 3).



Unblocks the v0.13.62 webkite rollout. The v0.13.62 canary caught the
webkite MCP binary requiring **GLIBC_2.39**, which the Debian bookworm
base (glibc 2.36) can't satisfy — webkite was dead-on-arrival
in-container. Two coupled fixes:

**Base bookworm → trixie.** `docker/Dockerfile.base` FROM
`node:22-bookworm-slim` → `node:22-trixie-slim` (digest-pinned, sec
WS9-F4 reviewed bump). glibc 2.36 → 2.41, python 3.11 → 3.13. This is
the base for the whole fleet (agents + broker + kernel + auth-broker +
hostd). `docker/Dockerfile.hostd`'s docker-CLI apt suite bumped
bookworm → trixie (Docker publishes a trixie suite).

Validated in a built agent image before ship: webkite 0.4.0 runs,
cloakbrowser detected (12 MCP tools), claude CLI 2.1.153 runs, bun
gateway bundle loads, all 22 hindsight scripts compile AND
session_start/end + recall execute rc=0 on python 3.13, playwright
python binding imports, tmux/sqlite3/rg/fd/jq/pandoc/ffmpeg all run.
CI's build-base + 5 build-dependents confirm the trixie base builds
cleanly fleet-wide.

**Fail-safe WebFetch deny.** The fleet-default WebFetch/WebSearch deny
now applies only when a webkite binary is actually staged
(`webkiteBinaryAvailable`: probes `~/.switchroom/bin/webkite` OR the
in-container `/usr/local/bin/webkite`, override via
`SWITCHROOM_WEBKITE_BINARY`). A degraded install — binary missing,
operator hasn't run setup, or a glibc-incompatible build pulled —
keeps native WebFetch as a safety net instead of going dark on web
access. Exactly the failure mode the v0.13.62 canary hit; this makes
the whole feature fail-safe. Both scaffold + reconcile deny sites
route through the new `webkiteDenyForAgent` helper.

(#1944)

## v0.13.62 — webkite fleet-default + activity-summary draft UX fixes

Two PRs.

### PR A — webkite fleet-default web fetcher (#1941)

Wires **webkite** as a 4th fleet-default integration MCP, replacing
native `WebFetch` / `WebSearch` on every agent. Webkite spawns a
local stealth Chromium (cloakbrowser) for bot-gated sites and falls
back to Cloudflare/Firecrawl cloud render when configured. The
model gets 12 typed tools (`webkite_read`, `webkite_search`,
`webkite_extract`, `webkite_crawl`, `webkite_map`, …) instead of
shelling out — cleaner DX, structured outputs, and one fleet-wide
authentication path.

**Distribution model.** Deliberately split across three lanes so the
private-beta webkite binary never lives in this repo or our images:

- **`webkite` binary** (private beta) — operator stages at
  `~/.switchroom/bin/webkite`; compose RO-mounts to in-container
  PATH. existsSync-guarded: fleet works in degraded "no-webkite" mode
  if absent. Never committed.
- **Cloakbrowser Python tool** (public OSS) — baked into
  `docker/Dockerfile.agent` via pipx at `/opt/cloakbrowser`.
- **Stealth Chromium binary** (~700MB) — operator-installed once at
  `~/.cloakbrowser/`, RO bind-mounted into every agent's HOME so the
  whole fleet shares one install instead of N copies.
- **Cloudflare/Firecrawl creds** — operator-vaulted at
  `webkite/cloudflare-account-id`, `webkite/cloudflare-api-token`,
  `webkite/firecrawl-api-key`. start.sh fetches via the vault-broker
  at boot and exports into the agent env so the `webkite mcp` child
  inherits them.

**Cascade.** `INTEGRATION_MCP_RESOLVERS` gets a 4th entry that always
emits unless an agent opts out via `mcp_servers.webkite: false`.
Settings.json `permissions.deny` baseline-seeds `[WebFetch,
WebSearch]` fleet-wide — opt-out re-enables the native tools
together with re-enabling webkite (all-or-nothing). The
`WEB_FETCH_GUIDANCE` block joins the three existing fleet invariant
blocks (sandbox / telegram / memory) so every agent reads "use
`webkite_*`" via Claude Code's native CLAUDE.md discovery.

**Broker.** `isWebkiteCredentialKeyForAgent` joins the existing
`isGoogleClientCredentialKeyForAgent` special-case at
`src/vault/broker/acl.ts`: framework-emitted MCP entries get
framework-emitted broker ACL so operators never have to maintain
`--allow` lists on the 3 canonical webkite keys. Gated on per-agent
opt-out — disabled-webkite agents still can't read the keys.

**Operator one-time setup:**

```
cp /path/to/webkite ~/.switchroom/bin/webkite && chmod +x ~/.switchroom/bin/webkite
XDG_DATA_HOME=~/.switchroom/webkite-share webkite setup --yes cloakbrowser
switchroom vault set webkite/cloudflare-account-id
switchroom vault set webkite/cloudflare-api-token
switchroom update
```

Ten new tests across four files (`scaffold.integration-registry.test`,
`docker/compose-generator.test`, `docker/dockerfile-agent-bakes.test`,
`broker/acl.test`) pin the registry shape, the existsSync mount
guards, the pipx bake, and the three new ACL cases (default allow,
opt-out denies, non-canonical webkite/* still denied).

(#1941)

### PR B — activity-summary draft UX fixes (#1942)

Three user-visible bugs in the activity-summary draft path that
landed alongside Option B (v0.13.59/60). Live-observed on clerk
post-v0.13.61 (screenshot evidence).

**1. Literal `<i>` HTML tags in DM drafts.**
`gateway.ts:drainActivitySummary` sent `<i>${summary}</i>` to
`sendMessageDraft` without `parse_mode='HTML'`, so Telegram rendered
the angle brackets literally — user saw `<i>Ran a command,
dispatched a sub-agent</i>` instead of italicized text. The sibling
sendMessage and editMessageText branches in the same function
already pass HTML; the draft branch was the outlier. Wrapper
signature extended to accept the option; the drain callsite passes
it. `clearActivitySummary`'s empty-text draft still passes no
parse_mode (correct — empty text needs none).

**2. "Used 2 tools" generic fallback for recognised MCP tools.**
`tool-activity-summary.ts:verbForTool` mapped only the standard
built-in tools (Read, Bash, Grep, …) to specific past-tense verbs;
everything else — including `mcp__hindsight__reflect`,
`mcp__google-workspace__*`, claude.ai integrations — fell through to
the generic `"used"` verb → "Used 2 tools". The pre-tool hook
label table (`hooks/tool-label-pretool.mjs`) already maps these to
nice strings like `"Searching memory"`; the activity-summary
builder was unaware. Now:

- `mcp__hindsight__recall|reflect` → "searched" → "ran a search"
- `mcp__hindsight__retain|update_memory|sync_retain` → new `"saved"`
  verb → "saved a memory"
- `mcp__google-workspace__*` and claude.ai variants: read-shaped
  (search/list/query/read/get/fetch/download) → "searched";
  write-shaped (create/update/write/send/move/copy/duplicate) →
  "edited"
- `mcp__notion__*` / `mcp__claude_ai_Notion__notion-*`: same split

Unrecognised future MCP tools still fall through to `"used"` — the
generic fallback is the right answer for unknown tools.

Also fixes the MCP-name regex: `[^_]+` → `(.+?)` (lazy match) so
server names with underscores (`claude_ai_Gmail`,
`claude_ai_Google_Drive`) parse correctly, and lowercases the
server segment so mixed-case claude.ai names match.

**3. Raw `mcp__server__tool` leaking into silence-poke fallback.**
`silence-poke.ts:formatFrameworkFallbackText` concatenated both the
raw tool name AND the human label:
`running mcp__hindsight__reflect Searching memory for 46s`. Now when
an MCP-shaped name (`^mcp__`) has a label, drop the name and lead
with the label: `Searching memory for 46s`. Built-in tool names
(Grep, Read, Bash) are already human-readable so they keep the
prior `running ${name} ${label}` shape — regression-guarded by a
new test.

### Test plan
- tool-activity-summary.test.ts: 21 pass (2 updated, 1 added)
- silence-poke.test.ts: 70 pass (3 added)
- tsc / plugin-references / bot-api-wrapping lints clean
- Full vitest: 8027/8027 pass

(#1942)

## v0.13.61 — turn-pacing v3: stop telling the model to ack

Live UX regression observed on clerk 2026-05-28 after Option B rolled
(v0.13.59/60): user saw multiple persistent "on it…" / "good question
— one sec" / "let me dig in" chat messages preceding every tool-using
turn's actual answer. The PreToolUse gate was correctly stripped in
v0.13.59 — but the prompt-side `turn-pacing` UserPromptSubmit
directive still told the model to call reply with an ack BEFORE any
other tool call. The model was complying. Net: same chat clutter,
prompt-driven instead of hook-driven.

This release rewrites the directive (v3). Tells the model:
  - NOT to call reply with placeholder acks ("on it" et al.)
  - The framework already surfaces activity via the compose-area
    draft preview (#1926, #1927)
  - Reply only with substantive content: actual answers, real
    questions, real mid-work milestones / pivots
  - Trivial one-sentence answers still go via reply (they ARE the
    answer)

Single-file scaffold.ts change, no code paths. 266/266 scaffold tests
pass.

The 5-min framework_fallback wedges observed in the same session are
extended-thinking turns — model goes silent internally with no
tool_use / no text. Different problem class (#1918), structural
ceiling, not addressed here.

## v0.13.60 — delete dead ack-first gate code (cleanup)

Hygiene follow-up to v0.13.59. After ~1 hour of UAT confirmed no
regressions from de-registering the PreToolUse `ack-first-pretool`
gate, this release deletes the orphaned source + bundled .mjs +
Dockerfile.agent COPY + scripts/build.mjs bundle invocation.

452 lines deleted, 0 added.

No behavioral change. The strip work happened in v0.13.59 (#1934);
v0.13.60 just removes the now-unreachable files.

## v0.13.59 — strip the ack-first PreToolUse gate; draft transport owns the beat

Removes the PreToolUse `ack-first-pretool` gate (shipped v0.13.56,
#1921). The activity-summary draft transport (#1926/#1927, shipped
v0.13.58) is now the user-facing ack lane: ephemeral preview in the
compose area that updates as tools fire, clears when the model's
reply lands.

Per-turn UX shift:
  - Before: `[user msg]` → `[bot]: on it — checking` (persistent ack
    message) → `[bot]: <full answer>`
  - After: `[user msg]` → draft preview *Read a file* (compose area,
    updates in place) → preview clears, `[bot]: <full answer>`

One persistent message per turn. Activity visible only as ephemeral
compose preview. Chat history is just the answers.

Pre-flight UAT on kill-switched test-harness (2026-05-28):
  - Fast-ack 8-prompt fuzz: **8/8 PASS**, **5/8 hit <8s vision**
    (vs 1/8 with gate ON across all prior versions)
  - Trivial DM: **8.6s** TTFO (vs 11s with gate ON — gate added
    ~50-100ms node-spawn overhead per tool call)
  - Gate-validation: 5/8 PASS, same as gate ON; failures are model-
    side pure-reasoning ceiling, not regressions

Safety nets that stay intact:
  - Activity summary + draft transport (#1926/#1927) — the new lane
  - 60s awareness ping (#1920) — backstop for >60s wedges
  - Silence-poke ladder + 300s framework_fallback — last-resort wedge
    breaker
  - Telemetry post-fallback fix (#1919) — honest outbound_count
  - Turn-pacing UserPromptSubmit hook — soft prompting (no enforcement)
  - Voice scrubber, over-ping safety net, etc.

The (now-dead) `src/cli/ack-first-pretool.ts` source + bundled
`.mjs` + `telegram-plugin/ack-flag.ts` helpers are still on disk;
deleted in v0.13.60 after fleet-wide UAT confirms this release.

## v0.13.58 — activity summary: Claude Code-style live-updating draft in Telegram

Two PRs land the design Ken sketched in #1926/#1927:

### #1926 — batched activity summary

Replaces the per-tool intent labels from v0.13.57 with a single
Claude Code-style summary line — `Ran 5 commands, read a file`,
`Edited a file, read a file, ran a command` — that accumulates as
the agent works. Same chronological phrasing Claude Code's chat UI
and CLI use natively. Single-flight coalescing: a burst of N
parallel `tool_use` events (modern Sonnet/Opus emits these
routinely) produces ONE message edited in place, not N spam
messages. Counters per verb class (read/edited/created/ran/searched/
fetched/dispatched/noted/used), first-occurrence ordering, singular/
plural-aware.

### #1927 — draft transport + clear-on-reply

Streams the summary via Telegram's `sendMessageDraft` API in DMs
(the same primitive the answer-stream uses for live previews).
Each call REPLACES the draft text — natural fit for the burst
coalescer. The user sees a live preview in their compose area as
the agent works; when the model's reply tool fires, the gateway
sends an empty draft to clear the preview and the real reply
lands clean. Falls back to send+edit+delete on forum topics and
hosts without the draft API.

Net steady-state UX:
  - User sends a question
  - Compose-area preview: *Read a file*
  - Preview updates: *Read 2 files, ran a command*
  - Preview clears, model's reply lands

No persistent intermediate status messages. No model-side prompting.
No PreToolUse blocking in the common path. The previous primitives
(ack-first gate, awareness ping, silence-poke ladder) remain as
safety nets but the steady state no longer leans on them.

## v0.13.57 — tool-intent surface: framework lifts model's stream into immediate user awareness

UAT on v0.13.56 confirmed the PreToolUse ack-first gate (#1921) works
exactly where designed — tool-using prompts produce a fast ack + answer
split (Read 1.5s, multi-step 11.6s ack-then-answer, disk-usage 7.2s).
But the gate has two costs:

  - Per-tool node-spawn overhead (~50-100ms)
  - Forces the model to author an explicit reply ack ("on it — checking")
    even when the model's own `tool_use` event already carries the intent

Ken's framing: "the gateway could surface some of the models description
items without forcing the model to send a message using the tool."

This release ships that. New gateway behaviour: when the model emits its
FIRST non-reply `tool_use` event of a turn AND no reply has happened yet,
the gateway lifts the model's intent (tool name + input, formatted via
the existing `toolLabel()` helper) into a brief silent Telegram message:

  - `<i>running:</i> ls -la /var/log`
  - `<i>reading:</i> os-release`
  - `<i>searching:</i> "Victoria drink driving"`
  - `<i>fetching:</i> example.com`
  - `<i>dispatching:</i> review the auth code`

The model never has to call the reply tool just to ack — the gateway
pulls the ack content directly from the stream. Italic verb signals
framework-narrating. One-shot per turn (`turn.intentSurfaceFired`) so
multi-tool turns don't spam.

Composes with #1921's PreToolUse gate as belt-and-suspenders: whichever
fires first sets `$TELEGRAM_STATE_DIR/ack-sent.flag` synchronously, the
other sees it and stays quiet. Either lands an immediate user signal —
framework voice from the surface, model voice from a gate-forced reply.

The PreToolUse gate stays as the kill-switch fallback for any case the
gateway-side surface can't fire (Telegram API down, etc.).

Closes the design loop on #1918 for tool-using prompts. Pure-reasoning
prompts (where the model emits no `tool_use` and just composes an
answer) still take 10-16s — `thinking` event bodies are redacted by
Anthropic so the gateway can't surface anything from them. Tracked as
design space.

## v0.13.56 — human-feel UX: ack-first gate + awareness ping + telemetry honesty

### Headline — ack-first PreToolUse gate (#1921)

UAT on v0.13.55 (jtbd-fast-ack-dm, 2026-05-28, 8 non-trivial prompts)
showed the model produces a real fast ack on only **1 of 8 prompts**.
3 of 8 are full-answer dumps with no ack at all — the user stares at
a silent chat for ~10s, then gets a 400-600 char dump. The
conversational-pacing design contract calls this out: "the framework
deterministically owns the mechanical beat and enforces compliance,
but never composes user-facing prose." The advisory levers (prompt
directives, per-turn `<turn-pacing>` hook, silence-poke ack-poke
piggyback) are model-suggestions. The model ignores them ~70% of the
time on non-trivial prompts.

This release ships the missing **enforcement primitive**: a
`PreToolUse` hook that blocks non-reply tool calls when no reply has
been sent yet this turn. Reply tools always allowed; non-reply tools
require the gateway-touched `$TELEGRAM_STATE_DIR/ack-sent.flag` to
exist. The flag is cleared at every fresh turn atom (real inbound,
cron fire, subagent handback, vault-grant resume, restart marker).
Kill-switched via `SWITCHROOM_DISABLE_ACK_FIRST_GATE=1`.

Trivial-answer turns are unaffected (their first call IS reply).
Heavy turns gain one extra reply call (~100-300ms) for immediate
user awareness. Closes #1918.

### Awareness ping at 60s (#1920)

Sibling to the existing 300s framework_fallback, but earlier and
silent (no device ping). Lands even during pure extended-thinking or
held-inbound silences when the model-targeted ack/soft/firm pokes
can't reach the model via tool_result piggyback. One-shot per turn.
Reuses `formatFrameworkFallbackText` so the wording stays consistent
("still working… (no update from agent in 1 min)") and in-flight
tools are still named when known.

User-visible UX: no more 5-minute silent chats while the model is
busy. At 60s into any wedged turn, the user sees a framework-tagged
status message; the louder 300s fallback escalates with a
notification if the model still hasn't replied.

### Telemetry honesty: post-fallback recovery accounting (#1919)

`gateway.ts` was clearing the `signalTracker` state immediately at
framework_fallback. Late reply tool calls (the model's eventual
recovery — the load-bearing unwedge primitive) then silently no-oped
against cleared state. Both `turn_ended` emissions (the fallback
itself + the canonical session-end follow-up) reported
`outbound_count: 0` even when replies were demonstrably delivered.
The framework's actual unwedge success rate was systematically
under-reported in the KPIs.

Fix: defer the clear to the canonical session-end paths. The
silence-poke ladder is already drained at fallback so no further
pokes fire — only the metrics state survives long enough to catch
late `noteOutbound` calls.

### Known: inbound-delivery hold (filed #1922)

Live trace on clerk 2026-05-27 showed an inbound the gateway received
at 12:50:57 didn't reach the claude session until 12:55:58 — a
5-minute hold with no observable cause (no thinking, no tool, no
event). Root cause not yet diagnosed; likely candidates are IPC
backpressure during post-turn Hindsight/compaction or a bridge
state-machine corner. The three fixes above make the user UX
acceptable even when this bug recurs; the underlying delivery hold
is tracked separately.

## v0.13.55 — Notion integration (5-PR series)

Adds a Notion provider to switchroom: one operator-owned internal
integration shared across agents, per-agent database allowlists, and
a privacy-preserving search filter. Five PRs (#1896, #1897, #1898,
#1899, #1900) plus the RFC (#1895). ~2900 LOC across schema +
launcher + broker primitive + PreToolUse hook + DB resolver + LRU
cache + privacy post-filter + doctor + CLI + docs + bundled skill.

Design lives at `docs/rfcs/notion-integration.md`. Operator setup
guide at `docs/notion-integration.md`. Config reference at
`docs/configuration.md` § Notion Workspace.

### Highlights

- **Operator registers once.** Notion → Settings → Integrations →
  New Internal Integration → copy the secret →
  `switchroom vault set notion/integration-token --allow clerk,carrie`.
  Then share the relevant databases with the integration in Notion's
  UI.
- **Per-DB allowlist** is the load-bearing per-agent control.
  `agents.<name>.notion_workspace.databases: [essays]` restricts an
  agent to a subset of what the upstream integration was shared with.
  Empty list rejected at config-load.
- **Mandatory privacy filter on `search`.** carrie searching for a
  term in clerk's private database returns zero results — page
  titles and snippets are stripped before the model sees them.
  Pinned by a regression-gate test at
  `src/notion/search-filter.test.ts`.
- **`create_database` and standalone-page writes hard-denied v1.**
  Create new databases via Notion's UI; agents read/write existing
  ones only.
- **Doctor section** with five probes — top-level block, integration
  token present, DB reference resolvable, vault-ACL aligned (catches
  the launcher-503-at-runtime case at config-edit time), launcher
  heartbeat.
- **Operator CLI** — `switchroom notion list-dbs` prints a
  ready-to-paste YAML block of friendly-name → UUID mappings (powers
  the bootstrap order). `switchroom notion test <agent>` smoke-tests
  the integration token + ACL + network.
- **Bundled skill** (`skills/notion/SKILL.md`) describes the tool
  surface, common workflows, v1 limits, and what to do when the
  allowlist denies a call.

### PR breakdown

- **PR 1 — config schema + per-DB ACL helpers** (#1896) —
  `NotionWorkspaceConfigSchema` and `AgentNotionWorkspaceConfigSchema`
  wired into the root and agent schemas. Pure predicates in
  `src/config/notion-workspace-acl.ts` (`shouldEmitNotionMcp`,
  `agentCanAccessNotionDB`, `resolveDbNameFromUuid`,
  `normalizeNotionUuid`) + load-time cross-validator.
- **PR 2 — MCP launcher + scaffold + broker rate-bucket primitive**
  (#1897) — hidden `switchroom notion-mcp-launcher` verb fetches the
  integration token from the vault-broker and execs
  `@notionhq/notion-mcp-server@1.8.1` (pinned). No refresh loop —
  Notion's token is long-lived. Scaffold emits the `.mcp.json` entry
  via `resolveNotionMcpEntry` (mirrors `resolveMs365McpEntry` shape).
  Pure `NotionRateBucket` class shipped standalone — wire-up to the
  broker IPC verb defers to a follow-up PR.
- **PR 3 — allowlist gate + db-resolver + privacy post-filter +
  PreToolUse hook** (#1898) — LRU page→DB cache, per-tool dispatch +
  recursion-bounded parent walk, minimal Notion REST client, hook
  bundled into the image AND the security-plugin's
  unstrippable-hooks directory. Privacy invariant regression-gated.
- **PR 4 — doctor probes + operator CLI verbs** (#1899) —
  `runNotionChecks` mirroring `doctor-microsoft.ts` shape, plus
  `switchroom notion list-dbs / test <agent>`.
- **PR 5 — docs + bundled skill + CLI-string corrections** (#1900) —
  operator setup guide, configuration reference section, bundled
  skill. Also corrected `vault put` / `vault acl add/remove` strings
  across the prior merged PRs to the actual `vault set --allow X,Y`
  CLI verb shape (reviewer-caught regression — operators following
  the docs would have hit "unknown command").

### Deliberate v1 deferrals

These ship as follow-up PRs after first operator use, not as part of
v0.13.55:

- **Operator approval cards on writes.** The allowlist IS the security
  primitive; approval cards are UX. m365/drive pattern adds card
  surface in a clean follow-up PR on top of the hook.
- **Hook-side rate-bucket wire-up.** The primitive ships (`PR 2`); the
  hook makes Notion API calls directly. If production logs show >5%
  429s, the broker IPC verb gets wired and the hook calls into it.
- **`notion:rate-bucket-saturation` doctor probe.** Lands with the
  hook-side bucket wire-up.
- **`notion:upstream-reachable` doctor probe** (`--deep`-gated).
  `switchroom notion test <agent>` covers the same surface manually.
- **UAT scenarios** (`telegram-plugin/uat/scenarios/jtbd-notion-*`).
  Privacy invariant is already unit-tested; live UAT requires
  operator-side Notion + per-agent vault setup to be meaningful.

### Migration: existing `personal-notion` skill on clerk

If an agent currently runs a per-agent `personal-notion` skill that
bundles its own Notion authentication, the bundled `skills/notion`
shipped in this release supersedes it. To migrate:

1. Set up `notion_workspace:` in switchroom.yaml as above.
2. Remove the agent's personal skill via the agent's MCP:
   `skill_remove_personal notion`. The bundled skill is
   auto-discovered.

See `docs/notion-integration.md` § Migration for the full path.

## v0.13.54 — schedule_add unblocked + supergroup mode PR4b/5/6 + MS-365 PR3/4/5

### Headline — schedule_add drift fix (#1893, closes #1892)

`schedule_add` via the agent-config MCP was failing on every docker-mode
agent with `E_RECONCILE_FAILED: non-cron changes surfaced during cron-
only reconcile: <agentDir>/.mcp.json`. The overlay was rolled back,
clerk (and any docker-mode agent) couldn't manage scheduled tasks.

Root cause: both `.mcp.json` writers (`scaffoldAgent`, `reconcileAgent`)
derived `TELEGRAM_STATE_DIR` from runtime `agentDir` — HOME-dependent.
Host CLI wrote `/home/<user>/...`, in-container CLI wrote
`/state/agent/home/...` for the same logical agent. Both target the
same bind-mounted file. Each invocation flipped the on-disk shape; the
broker's cron-only reconcile bridge detected drift on its own write
and rolled back the schedule overlay.

Fix: pin `TELEGRAM_STATE_DIR` to `${DOCKER_AGENT_HOME}/.switchroom/
agents/${name}/telegram` in both writers — environment-independent,
matching every other path in the framework MCP set. Latent since
v0.7.x docker cutover, visible whenever a host `switchroom apply`
runs between in-container reconciles.

Regression test (`tests/scaffold.mcp-json-telegram-state-dir.test.ts`)
asserts both writers emit the canonical in-container value regardless
of runtime `agentDir`.

### Supergroup mode (continued)

- **PR4b emitter sweep (#1890)** — operator-event, permission, and
  approval cards now route via the supergroup helper so they land in
  the correct topic instead of the default topic when supergroup mode
  is on.
- **PR5 (#1891)** — slash-command smart split: heavy-output commands
  in supergroup mode route to the admin alias topic, keeping query
  responses in-place. Per-command classification: `query` follows the
  originating topic; `mutation` and `heavy` route to admin.
- **PR6 (#1889)** — hindsight topic tagging + filter-mode flag.
  Memories tagged with the originating topic id; new filter-mode knob
  controls cross-topic recall scope. Instrumentation added.

### Microsoft 365 integration (RFC #1873, continued)

- **PR3 (#1886)** — `m365-mcp-launcher` CLI verb + scaffold
  integration; agents with `microsoft_workspace:` declarations now
  get the launcher wired into `.mcp.json` via `resolveMs365McpEntry`.
- **PR4 (#1887)** — write-approval hook for MS-365 mutating ops in
  the telegram-plugin (mirror of the gdrive write-pretool pattern).
- **PR5 (#1888)** — doctor probes for the Microsoft workspace
  surface + user-facing docs.

## v0.13.53 — supergroup-mode foundations + parallel-turns deadlock fix

Ships the entire **per-agent Telegram supergroup mode** design
(`docs/rfcs/supergroup-mode.md`) as a structural foundation: one
agent can own a whole supergroup with multiple forum topics, and the
gateway handles per-topic conversation state, queuing, and routing
correctly. Behavior under existing fleet-shared / DM topologies is
unchanged — this is additive scaffolding for the new topology.

The headline correctness fix is **PR3b** (#1880): supergroup-mode
parallel-turns deadlock. Pre-fix, when topic A was processing and
topic B's user sent a message, B's eager `activeTurnStartedAt[keyB]`
entry would pin the fleet-wide held-inbound flush gate forever (B
never reached claude, so no turn_end ever fired for B). The fix
splits the conflated map into `activeTurnStartedAt` (receipt-side
timestamp) + `claudeBusyKeys` (delivery-side fleet gate). 340-line
surgical fix, NOT the originally-planned 5-8 day `currentTurn` →
`Map` refactor — claude serializes, so the singleton is structurally
correct; the actual load-bearing piece was the fleet gate.

This release also ships the auth-broker side of the **Microsoft 365
integration** (RFC #1873 PR 1/5) — Microsoft provider + storage
landed but not yet user-facing (subsequent PRs ship the refresher
sidecar, MCP launcher glue, and skills).

Plus the standalone `switchroom status` CLI for fleet/accounts/MCPs
snapshot (#1853).

### Supergroup mode (10 PRs)

- **PR1 (#1868)** — schema + outbound topic router helper. Pure
  additive: `channels.telegram.chat_id` / `default_topic_id` /
  `topic_aliases` fields parse, `resolveOutboundTopic()` helper exists.
- **PR2 (#1869)** — chat-lock + inbound-coalesce per-(chat,thread)
  keying. The grammY chat-lock proxy and inbound-coalesce key both
  canonicalize via `chatKey(chat, thread)`. 429-isolation guardrail
  test pins the cross-topic API isolation contract.
- **PR3 (#1870)** — typing indicators + auth-intercept maps
  per-(chat,thread). Cross-topic clobber closed; pendingAuthAddFlows
  + pendingReauthFlows re-keyed.
- **PR3b (#1880)** — supergroup-mode parallel-turns deadlock fix.
  See headline above. Introduces `claudeBusyKeys: Set<string>` as the
  delivery-side fleet gate, separate from the receipt-side
  `activeTurnStartedAt`. 5 new regression tests pin both the pre-fix
  failure mode AND the post-fix invariants.
- **PR4a (#1871)** — General-topic strip-1 wrapper. Bot API rejects
  `message_thread_id=1` (MTProto's General-topic id) on send;
  `chatLock.wrapBot` strips it transparently. 6 tests.
- **PR4b-boot (#1874)** — boot card / SessionStart routes via
  `resolveOutboundTopic({ kind: 'boot' })` for supergroup-owned
  agents (alerts alias → default_topic_id fallback).
- **PR4b-cron (#1876)** — per-cron `schedule[].topic` field wired
  through the in-agent synthesizer. Cascade-aware `resolveChannelTarget`
  picks supergroup chat_id when set; `resolveEntryThreadId` helper
  resolves alias → number per entry.
- **PR4b-compact (#1877)** — proactive-compaction card routing.
  Generalizes the boot-card helper into `resolveAgentOutboundTopic(event)`
  so all future emitter wirings are one-line changes.
- **#1878** — loader-side validation of cron `topic:` aliases.
  Typos fail fast at config-load with aggregated cross-field error
  instead of silent fallback at dispatch time.
- **PR7 (#1872)** — `switchroom telegram topics <chat_id>` discovery
  CLI. Reads the agent's local SQLite history buffer, surfaces
  distinct thread_ids with first-message preview, generates a
  copy-paste-ready `topic_aliases:` YAML snippet.

### Microsoft 365 integration (2 of 5)

- **#1873** — RFC + validation-pass update (#1879).
- **#1881** — auth-broker Microsoft provider + storage (PR 1/5).
  Common-tenant Entra app, MSAL device-code flow, broker-only token
  storage.
- **#1882** — `switchroom auth microsoft …` CLI verbs + OAuth flow
  (PR 2/5). Operator-facing device-code login wired through to the
  broker storage from PR 1/5. Subsequent PRs (sidecar refresher v1,
  MCP launcher glue, skills) build on this.

### Standalone

- **#1853** — `switchroom status` CLI for fleet/accounts/MCPs snapshot.

### PR3b follow-up — orphan sweep (#1884)

Edge-case audit of #1880 found a strictly-new latent leak:
`claudeBusyKeys` can hold keys that `activeTurnStartedAt` does NOT,
because synthetic-inbound deliveries (cron via `onInjectInbound`,
reaction-dispatch, vault grant/deny/etc, button-callback) bypass
handleInbound's fresh-turn branch. If such a synthetic-delivered
turn dies without `turn_end`, the existing recovery sweeps
(disconnect-flush iterating `activeTurnStartedAt.keys()`,
silence-poke framework-fallback keyed off activeTurnStartedAt) can't
see the orphan → fleet flush gate wedges. Fix: append
`claudeBusyKeys.clear()` to `flushOnAgentDisconnect` (same
justification as the existing dangling-sweep — bridge died, every
busy key is dead by definition). 3 new regression tests. Folded
into this release so the leak never ships.

## v0.13.52 — agents now know about clone-to-personal (discovery gap)

The plumbing landed in v0.13.45-51, but the doc every agent reads on
every turn (\`profiles/_shared/agent-self-service.md.hbs\`) was silent
on the new verbs — agents had the tools but didn't know they existed.
The gymbro screenshot that drove this whole arc ("Operator action:
edit ~/.switchroom/agents/gymbro/.claude/skills/garmin/scripts/
garmin-list.py") would have kept happening until this doc shipped.

### docs(agent): teach agents about clone-to-personal + personal-skill ops (PR #1863)

Closes the discovery gap. Adds to the bundled
\`agent-self-service.md.hbs\` template (reconciled into every agent's
\`CLAUDE.md\` at scaffold time):

- **Trigger-table rows** — including the explicit "YOU find a bug in
  a skill you depend on → clone+edit yourself" pattern that fires
  when an LLM agent recognises the situation
- **"Fixing a skill you depend on — don't ask the operator"** section
  with the 3-step flow (clone → edit → use \`personal-<name>\`)
- **"Discovering skills"** section with the three-tier model + advice
  to \`skill_search\` BEFORE authoring
- **Tool docs** for the six new MCP verbs (search, init/edit/remove/
  list_personal, clone_to_personal) — same voice as the existing
  \`schedule_add\` / \`skill_install\` entries

No code change — every agent picks up the new guidance on next
\`switchroom apply\` / agent restart.

## v0.13.51 — closes the agent-managed-skills JTBD end-to-end

Two PRs that complete what v0.13.50 started: the durability story is
now true for the dominant in-container caller, and bundled skills are
finally cloneable.

UAT of v0.13.50 surfaced two gaps the principled triage (fresh-process
Opus reviewer, aligned to vision + principles) ranked as load-bearing:

### fix(skill-clone): skip non-allowlisted source files (PR #1848, closes #1847)

Six of nine bundled skills (\`docx\`, \`mcp-builder\`, \`humanizer\`,
\`pdf\`, \`pptx\`, \`skill-creator\`) ship with operator-relevant files
at root (LICENSE, VENDORED.md, reference.md, scripts/requirements.txt)
that aren't in the agent-authored-skill path allowlist. \`skill clone-
to-personal bundled:<name>\` was failing the dominant case.

\`readSourceFiles\` now filters source files through \`validateRelPath\`.
Skipped paths surface as a single-line yellow stderr note + an explicit
\`skipped[]\` array in the JSON output (empty when source was shape-
clean — distinguishable from "we silently dropped something you might
care about"). Publish-side validator stays strict.

### feat(compose): bind-mount config-repo personal-skills per-agent (PR #1849, closes #1846)

The load-bearing JTBD fix. v0.13.50 (#1844) auto-mirrored personal-
skill writes to \`~/.switchroom-config/agents/<agent>/personal-skills/\`
for durability. But the agent runs **inside** a container where
\`~/.switchroom-config/\` didn't exist → \`resolveConfigSkillsDir\`
returned null → mirror silently no-op'd for the dominant caller.

Four coordinated changes (all four layers of the audit-dir precedent):

1. **\`compose.ts\`** — per-agent \`rw\` bind mount of the operator's
   slice (\`~/.switchroom-config/agents/<a>/personal-skills/\`) when
   the operator has opted into versioned skills (\`~/.switchroom-config\`
   exists on host)
2. **\`profiles/_base/start.sh.hbs\`** — sibling \`ln -sfn\` so the
   in-container CLI's \`homedir()\` call resolves to the bind-mounted
   host path (matches the existing \`~/.switchroom\` symlink at #910)
3. **\`scaffold.ts:alignAgentUid\`** — chown the mirror dir to the
   agent UID so the in-container write doesn't EACCES
4. **\`apply.ts:ensureHostMountSources\`** — pre-create the per-agent
   dir at pass-1 so the chown sweep finds it on first apply

Fresh-process Opus reviewer caught the missing fourth layer (#3
symlink) during initial review. The four-layer pattern is now
documented for future bind-mounts of operator state.

## v0.13.50 — agents fix their own skills (clone-to-personal + versioned mirror)

Two PRs that close the biggest gap surfaced by v0.13.47 UAT — agents
finding defects in skills they depend on, hitting a wall at "I can't
edit the shared pool", and pinging the operator to fix it manually.
That doesn't scale to multi-operator fleets (e.g. Lisa's agents on
her own host).

### feat(skill): clone-to-personal (PR #1843)

5th personal-skill verb: agent forks a `shared:<name>` or
`bundled:<name>` source into its own personal tier; the fork is
mutable via `edit-personal`; upstream pool is untouched.

```
switchroom skill clone-to-personal shared:garmin
# or via MCP:
skill_clone_to_personal { source: "shared:garmin" }
```

Source allow-list mirrors `skill_install`: only `shared:` and
`bundled:` accepted, no `file://`, no arbitrary paths, no symlinks
(refuses to follow out of the canonical pool). When `--name` differs
from the source slug, the SKILL.md `name:` frontmatter is rewritten
to match so the validator accepts the bundle. 1 MiB per-file cap on
source reads (defense-in-depth vs. pathological input). All test-
only CLI flags are `hideHelp()`-ed.

Why this shape vs. delegation/RBAC or Phase 2 propose-publish: blast
radius matches existing personal-tier invariant (self-only), zero
new ACL concepts, ~3 agent-hour implementation. Phase 2
propose-publish (deferred to ~2026-07-25) becomes the eventual
*promotion* path back to shared — complementary, not competing.

9 new tests covering the security-critical paths.

### feat(skill): auto-mirror to ~/.switchroom-config (PR #1844)

After every successful `init_personal` / `edit_personal` /
`clone_to_personal`, opportunistically mirror the dir into:

```
~/.switchroom-config/agents/<agent>/personal-skills/<name>/
```

if the operator has the config repo. `remove_personal` moves the
mirror to a `.<name>-trash-<ts>/` sibling so the deletion shows in
`git status`. Each edit leaves a `.<name>-prior-<ts>/` sibling for
recovery before commit. **24h lazy sweep** of `.prior-*` / `.trash-*`
prevents chatty agents from accumulating stale dirs forever (same
TTL as the live skills-trash).

If the config repo doesn't exist, the mirror **silently no-ops**
(operator hasn't opted in). If a mirror write fails, a warning
prints to stderr and the **live copy continues unaffected** —
`appendAudit`'s "never block a live action" pattern. No auto-commit;
operator commits at their own cadence via plain git.

`SWITCHROOM_CONFIG_DIR` env override for multi-operator hosts and
tests.

Mirror-after-write (vs. bind-mount/symlink redirect): zero claude-
code discovery changes, zero compose mount changes, zero UID
alignment changes, free migration. Tradeoff is the live → mirror gap
is bounded by the next successful sync (typically same call); on
failure the audit row + live copy still land.

Critical test-discipline fix found in review: previous test suite
leaked fixtures into the operator's real `~/.switchroom-config` (36
dirs of test-agent state, cleaned up before merge). File-level
`beforeAll` now pins `SWITCHROOM_CONFIG_DIR` to a tmpdir before any
test runs — same Vault/shared-state HARD rule as `project_vault_
clobbered_by_test_2026_05_22`.

8 new tests covering happy paths, opt-in/opt-out, failure isolation,
24h sweep, and symlink defense.

## v0.13.49 — hotfix: actually register the repo-context hook in settings.json

PR #1811 / v0.13.48 added the repo-context PreToolUse hook to
`telegram-plugin/hooks/hooks.json` (the plugin-system view, loaded
when an agent uses `--plugin-dir`). But the scaffold writes the
agent's `settings.json` PreToolUse list from a separate hand-coded
array in `src/agents/scaffold.ts:3184+` — and that list was missed
in the original PR. Claude Code reads PreToolUse from `settings.json`
at session start, so the hook never actually fired in production.

Caught by the live UAT against v0.13.48: agent navigated into a repo
with a CLAUDE.md containing a marker string, agent replied "NO
MARKER OBSERVED" — proving the hook wasn't called. Direct invocation
of the hook on the same envelope produces the correct
`additionalContext`, confirming the hook itself is fine.

Fix (PR #1839): add the missing entry to scaffold.ts's
`switchroomPreToolUse` array. Extends `reconcile-hooks-drift.test.ts`
to pin the registration so a future refactor can't silently regress
it.

Risk: low. Pure additive change to the hand-coded scaffold list;
mirrors how the other 5 PreToolUse hooks are registered. The hook
itself is unchanged — only the registration that enables Claude Code
to invoke it.

## v0.13.48 — repo-context hook + buildEnvelope refactor + agent-managed-skills RFC

Three independent PRs bundled — one feature, one refactor, one docs.

### feat(hooks): repo-context PreToolUse — auto-inject mid-session repo CLAUDE.md (#1811)

Closes the "agent navigates into a code repo mid-session and forgets
its CLAUDE.md" gap. Claude Code's native CLAUDE.md auto-load is
cwd-at-session-start + parents only; a switchroom agent's session
launches at the agent's workspace, so when a user (often a non-coder
over Telegram) asks "go work on `~/code/foo`", that repo's CLAUDE.md
is NOT in the agent's context. The agent's system prompt soft-nudges
it to `Read` the marker file but that depends on model obedience.

New PreToolUse hook fires on Read/Edit/Write/MultiEdit/NotebookEdit/
Bash. The first time a session's tool call touches a path under a
repo with `CLAUDE.md` (or `AGENTS.md` / `AGENT.md`), the hook reads
the marker file and injects it via `additionalContext` wrapped in a
`<repo-context>` envelope. Subsequent calls in the same repo are
no-ops (tracked per-session in `/tmp/switchroom-repo-context-<session_id>/loaded.txt`).

- **Per-tool target resolution:** file tools use `dirname(file_path)`;
  Bash uses the hook envelope's `cwd` (which the Bash tool's
  persistent shell maintains across calls per Claude Code docs).
- **Safety caps:** 5 distinct repos / 100 KB total / 30 KB per file
  per session (overridable via env). Oversized files emit a one-liner
  pointer rather than the body.
- **Skips the agent workspace** (already auto-loaded by Claude Code).
- **Walks UP only to filesystem root or `$HOME`** — no accidental
  operator-home CLAUDE.md.
- **Fail-open on every error path** — hook never blocks tool
  execution.
- **Kill switch:** `SWITCHROOM_DISABLE_REPO_CONTEXT_HOOK=1`.

29 new tests covering pure helpers + end-to-end spawn.

### refactor: extract buildEnvelope() + make request_id optional (#1784)

Two cleanups for the #1758 error-envelope rollout:

- Extract `buildEnvelope(code, human, fix?, opts?)` in
  `src/host-control/protocol.ts` as the single source of truth for
  the `ErrorEnvelope` wire shape. `ErrorBuilder.build()`,
  `writeVaultDeniedEnvelope`, and `agent-config-write.ts`'s
  `buildEnvelopeForCode` now all delegate envelope assembly; per-code
  → `fix.kind` selection stays at each callsite.
- Relax `request_id` on `ErrorEnvelopeSchema` to `optional()`. Both
  CLI emit sites previously fabricated placeholder ids
  (`agent-config-${randomUUID()}`, `vault-cli-${Date.now()}-…`)
  purely to satisfy the receiver schema. They now omit; receivers
  correlate via `audit_id` / surrounding context. The hostd dispatch
  path still threads the real RPC `request_id`.

Refs #1758, #1759, #1769, #1770, #1776, #1777.

### docs(rfc): agent-managed skills — fleet capability lifecycle (#1814)

Historical RFC for the personal-skill autonomy work that shipped
across #1825 (Phase 1) / #1826 (Phase 3) / #1828 (Phase 3 follow-up)
/ #1829 (60-day observability). Preserved as institutional memory;
status line updated post-merge to mark Phases 1+3 as shipped.

## v0.13.47 — audit-log unblocking (closes the silent-audit class)

Two narrow fixes that resolve UAT findings from v0.13.46. The
headline is that **the agent-config audit log was silently empty on
every host since the audit feature shipped** — `~/.switchroom/audit/<agent>/`
was created root-owned by `apply` running under sudo, so every
`appendAudit` from the in-container agent UID returned EACCES which
`appendAudit` swallows silently by design. v0.13.46's observability
work depended on those rows; v0.13.47 actually makes them land.

### fix(scaffold): chown audit dir to agent UID (PR #1833, closes #1831)

`alignAgentUid` now includes `~/.switchroom/audit/<name>/` in its
chown sweep alongside the existing agent state dir and per-agent log
dir. Same shape as the #880 log-dir chown; same idempotent sudo
fallback. `ensureHostMountSources` pre-creates the dir under
operator umask BEFORE the chown pass so a fresh install lands
agent-owned in one apply cycle (reviewer caught this — without the
pre-create, the dir doesn't exist on first apply and the chown is a
no-op).

Security implication: with audit writes restored, the agent-config
audit log (config-read denials, cron-list deny-by-default,
skill.*_personal mutations) is **usable for the first time** on
freshly-applied hosts. Existing hosts get the fix on next
`switchroom update` — the manual chown workaround applied during
v0.13.46 UAT is no longer required.

### fix(observe-personal-skills): surface EACCES (PR #1834, closes #1832)

`scripts/observe-personal-skills.mjs` used to report `files=0 bytes=0`
for unreadable 0700 personal-skill dirs — silent and misleading. Now
distinguishes "unreadable" from "empty": per-entry shows `<opaque
(need sudo)>`, a top-of-report `Unreadable (0700 dirs): N` line
points at the sudo workaround, and the JSON output carries an
`unreadable: true` flag plus a `totals.unreadable_personals` rollup.

The dir COUNT — the load-bearing signal for the 60-day Phase 2
decision rubric — is unchanged. This is observability honesty, not
a load-bearing fix.

## v0.13.46 — agent-managed skills follow-ups (UX + observability)

Two small follow-ups to v0.13.45, both surfaced during that release's UAT
and addressed before they could rot:

### fix(skill-search): default --agent to $SWITCHROOM_AGENT_NAME (PR #1828, closes #1827)

`skill search` was the only personal-skill verb that didn't default
`--agent` from the in-container env. Agents calling `skill_search`
from inside their own session had to pass `--agent` explicitly to see
their personal tier — otherwise personal results were silently
omitted. Now mirrors the four sibling ops (init/edit/remove/list).

Three regression tests pin: env-populates-personal-tier,
explicit-flag-overrides-env, no-env-no-flag-still-searches-shared.

### feat(skill): observability for personal-skills adoption (PR #1829)

Telemetry for the 60-day Phase 2 decision (RFC #1819 defers operator-
approval-gated shared-pool edits until usage data exists):

1. **Audit rows** — three mutating personal-skill ops
   (`init_personal`, `edit_personal`, `remove_personal`) now write one
   row each to `~/.switchroom/audit/<agent>/agent-config.jsonl` on
   success. Same shape as existing `config.get` / `cron.list` rows.
   Read-only ops (`list_personal`, `search`) deliberately NOT audited
   — disk state is the ground truth.
2. **`scripts/observe-personal-skills.mjs`** — host-side fleet scan.
   Reports per-agent: current personal skills, trash entries
   (24h-recoverable), audit-row counts. Supports `--json` and
   `--since 7d`.
3. **`docs/personal-skills-adoption-observability.md`** — decision
   rubric with explicit thresholds (strong/weak/no Phase 2 demand)
   for the ~2026-07-25 checkpoint.

Hardening: `dirSize` in the observability script uses `lstatSync`
not `statSync` to keep enumeration scoped to the agent's skill tree
(can't be lured out via a `personal-foo → /etc` symlink).

## v0.13.45 — agent-managed skills (Phase 1 + Phase 3)

Four PRs that ship the first cut of **agents authoring their own skills**:
admin and non-admin agents alike can now write, edit, list, remove, and
discover skills from inside their own Claude Code session — no operator
involvement, no `claude -p` programmatic call. The RFC's deferred phases
(propose-publish to shared pool with operator approval card) remain
out of scope; everything in this release is per-agent scope only.

### PR A — `switchroom skill apply` CLI verb (PR #1822, #1817)

Operator-facing helper that takes a skill payload (stdin, file, directory,
or tarball) and writes it to the global skills pool at
`~/.switchroom/skills/<name>/`. Same validation gates that the new MCP
ops use (name regex, path allowlist, SKILL.md frontmatter, banned-headless-
phrase content scan, behavioural `bash -n` / `python3 -m py_compile`).

### PR B — Phase 0 spike findings (PR #1824, #1818)

Resolved 7 open design questions before Phase 1 code landed. Headline:
binary-extracted from the Claude Code v2.1.150 CLI that personal-skill
discovery is **depth-1** and hard-coded to `.claude/skills/` — so the
RFC's draft "personal/ subdir" convention won't work; ships as
`<agentDir>/.claude/skills/personal-<name>/` (name-prefix) instead.

### PR C — Phase 1 personal-skill primitives (PR #1825, #1819)

Four new actions, each callable as both an operator CLI verb and an
in-agent MCP op via the agent-config server:

- `switchroom skill init  <name> --agent <a> [--from <file|dir>|stdin]`
- `switchroom skill edit  <name> --agent <a> [--from <file|dir>|stdin]`
- `switchroom skill remove <name> --agent <a>`
- `switchroom skill list  --agent <a>`

MCP-side: `skill_init_personal`, `skill_edit_personal`,
`skill_remove_personal`, `skill_list_personal`. Multi-file payloads via
`files: { path: content }` JSON map, JSON-piped through the CLI's stdin
so the MCP and operator paths share one validator (
`src/cli/skill-common.ts:validateSkillBundle`).

**Symlink-safe writes** (defense-in-depth vs. T3 from the security
review): `lstatSync` pre-flight refuses to overwrite a live OR dangling
symlink, then `mkdtempSync` staging dir + single atomic rename so a
half-written bundle never lands at the final path.

**Delete = trash + lazy sweep**, not unlink: `remove` moves the dir to
`<agentDir>/.claude/skills-trash/<name>-<unix-ts>/` (sibling of
`skills/`, so it's never picked up by depth-1 discovery). Every
personal-skill op also sweeps `skills-trash/` for entries older than 24h
(`TRASH_TTL_MS`). No host cron — the cron singleton was retired in
Phase 4 of the agent-scheduler fold-in.

### PR D — Phase 3 read-only `skill_search` (PR #1826, #1819)

Enumerate skills across three tiers an agent can see:

- `personal`: `<agentDir>/.claude/skills/personal-<name>/SKILL.md`
- `shared`: `~/.switchroom/skills/<name>/SKILL.md` (operator pool)
- `bundled`: `~/.switchroom/skills/_bundled/<name>/SKILL.md` (shipped)

Surface: `switchroom skill search [--agent <a>] [--query <q>]
[--tier personal|shared|bundled|any] [--limit N] [--no-json]` + MCP op
`skill_search`. Case-insensitive substring match against name,
description, and the new `jtbd` frontmatter key. Stable sort:
personal → shared → bundled, then name. Limit defaults to 50, max 500.

Path-traversal guard on the `agent` slug: an MCP caller passing
`agent="../../etc"` short-circuits to `[]` before the value is joined
into the agents-root path (`AGENT_NAME_RE` mirror of
`src/agents/lifecycle.ts`). Hidden test-only `--root`, `--shared-root`,
`--bundled-root` flags stay out of `--help`.

### Deliberately deferred

The full `skill_propose_publish` / `skill_propose_edit` /
`skill_propose_remove` hostd verb suite (operator-approval-gated edits
to the **shared** pool). Security + UX reviewer passes surfaced 8
must-fixes (per-opt-in vault-grant delta, multi-file diff card flow,
rationale typographic quarantine, semantic lint pass, rate-limit, etc.)
that need a fresh RFC. Tracked under #1821. Until 60+ days of personal-
skill usage data exists, PR-A's CLI verb is the operator-driven fallback
for shared-pool changes.

The `installed_by` filter on `skill_search` (cross-agent opt-in
enumeration) and the "current opt-in count per match" — both deferred
until "does the skill exist?" proves insufficient as the dominant
discovery use case.

## v0.13.44 — visible-answer-stream goes live, recovery ladder widened

Three PRs that together convert the dominant catastrophic UX failure on
Telegram (model emits transcript text instead of calling the reply
tool, user sees nothing until the 5-minute silence-poke framework
fallback fires a canned "no update from agent in N min" nudge) into a
non-issue. Fleet log audit on 2026-05-25 measured this failure mode at
**~19% of inbound events fleet-wide** (target per
`reference/conversational-pacing.md`: <0.5%). The audit revisited the
shelve memo's prior 5% assumption; empirical rate is ~4× that.

### feat: visible-answer-stream default ON + over-ping fix (PR #1813, follow-up to #1672)

Flips `SWITCHROOM_VISIBLE_ANSWER_STREAM` from default OFF → ON. The
answer-stream lane (introduced flag-gated in #1672 / v0.13.15) now
renders the model's transcript text as a USER-VISIBLE chat-timeline
message that grows in place as the model thinks, instead of writing
to Telegram's invisible compose-box draft. When the turn ends without
the model calling the `reply` MCP tool, the stream IS the canonical
final answer — no recovery ladder needed.

Also fixes Bug A from the shelve memo: the visible-mode sendMessage
callback at `gateway.ts:~6651` was forwarding `parse_mode`,
`message_thread_id`, `link_preview_options`, `reply_parameters` — but
NOT `disable_notification`. The over-ping safety net at
`gateway.ts:~4452` is wired into `executeReply` only, not into the
direct answer-stream send. Without the fix, the first text chunk that
opened the visible message device-pinged, and when the model later
called reply, that reply pinged AGAIN. Two device pings per multi-step
turn.

The fix: per-call `purpose: 'stream' | 'materialize'` discriminator on
the sendMessage params. Streaming opens are silent; the turn-end
materialize fresh-send pings the device exactly once per the beat-5
contract.

The "chat IS the artifact" principle clarification: the retired
progress card (#1122) was chrome — a pinned widget separate from the
chat. Visible-answer-stream is **not chrome**. It is a regular Telegram
chat message that grows. From the user's perspective it is
indistinguishable from "the model is typing live." The chat is still
the artifact; the artifact just shows the model's actual thought
process surfacing in real time.

### fix: visible-answer-stream materialize-and-delete at turn-end (PR #1815, R1 review caught dedup hazard)

Initial #1813 ship forced `disable_notification: true` unconditionally
on every answer-stream sendMessage to fix Bug A. Live UAT on
test-harness caught the regression: text-only short turns ("on it"
being the whole reply) now landed silently — the user had no
notification to know the answer arrived. The midturn-silent-dm UAT
failed on this.

Fix: at turn-end stream-as-answer, call `stream.materialize()` to
send a fresh pinged message, then `bot.api.deleteMessage` the old
silent streamed preview. The materialize-and-delete pattern: during
the turn the user sees text streaming live in a silent preview; at
turn-end that preview is replaced atomically by a fresh pinged
message with the final content.

R1 review caught a load-bearing dedup hazard in the first cut: the
pre-materialize `outboundDedup.record(...)` populated the same dedup
store that `materialize()`'s internal `checkDedup` consults. Result:
materialize would dedup-suppress its own send, the delete would still
fire, and the user would lose the content entirely. R2 fix: remove the
pre-record, let `materialize()` own bookkeeping itself (it already
calls `recordDedup` + `recordOutbound` internally with the correct NEW
message_id), and gate the cleanup `deleteMessage` on a numeric sentId
return.

### fix: SILENT_END_MAX_RETRIES bumped from 1 to 2 (PR #1812)

When the visible-answer-stream lane is OFF (or the model emits text in
a way the lane doesn't capture), the Stop hook's `silent-end-interrupt`
re-prompt is the last working safety net before the 5-min framework
fallback. With `MAX_RETRIES=1`, a stubborn model that emits text+end_turn
twice falls through to the user-visible canned nudge. Bumped to 2 —
two re-prompt rounds give the model another chance to call the reply
tool before the user sees the framework's "no update" message.

Both constants stay in sync (`telegram-plugin/silent-end.ts:60` and
`telegram-plugin/hooks/silent-end-interrupt-stop.mjs:65`); the in-sync
regression test at `silent-end.test.ts:238` regex-extracts the hook
value and asserts equality.

### UAT (pre-release, on test-harness)

Full scenario sweep on `sha-52dd5d9` (the v0.13.44 merge tip pre-tag):

| Scenario | Result | Notes |
|---|---|---|
| `midturn-silent-dm` | ✓ PASS (52.9s) | Single-message text-only turns now ping at materialize |
| `visible-answer-stream-dm` | ✓ PASS (58.8s) | Multi-step: silent streamed preview + final pinged reply |
| `silent-end-recovery-dm` | ✓ PASS (15.1s) | Headline 19%-fallback failure mode resolved |
| `jtbd-fast-trivial-dm` | ✓ PASS (TTFO=9.1s) | Within 12s contract |
| `jtbd-rapid-followup-dm` | ✓ PASS | Steer + queue classification works |
| `jtbd-subagent-handback-dm` | ✓ PASS (43.3s) | Beat-4 handback synthesis |

## v0.13.43 — broker ACL mcp_servers cascade hotfix (PR #1809)

PR #1806 / v0.13.42 added an ACL clause for user-declared
`mcp_servers.<name>.secrets[]` but the implementation read
`agentConfig.mcp_servers` only. The broker loads raw yaml via
`loadConfig` and never runs the cascade pipeline
(`resolveAgentConfig` / `mergeAgentConfig`), so an MCP declared
*once* in `defaults.mcp_servers` (the documented common case for
perplexity / notion / etc.) was invisible to the ACL — every agent
that inherited the entry via cascade still hit
`VAULT-BROKER-DENIED`.

Discovered live 2026-05-25 on clerk against v0.13.42: operator
declared `secrets: [perplexity/api-key]` under
`defaults.mcp_servers.perplexity`, restarted the broker, and clerk's
`switchroom vault get perplexity/api-key` still returned DENIED.

Fix: open-code the canonical 3-layer cascade inline in
`checkAclByAgent` — `defaults.mcp_servers` → `profiles.<extends>.
mcp_servers` (when the agent has `extends:`) → `agents.<name>.
mcp_servers`. Per-key shallow merge, matching
`src/config/merge.ts:391-397`. Full cascade pipeline would be too
expensive per ACL request and pull in deeper machinery (env merges,
deprecation-warn side effects); the ACL only needs to know "which
mcp_servers entries are effectively live for this agent".

`false` opt-outs still drop the grant because the shallow merge
applies `false` over the inherited entry and the typeof guard skips
non-object values.

7 new ACL unit tests (53 total in the file): defaults-only inherited,
per-agent override re-declares secrets (replace-not-merge), per-agent
`false` over defaults, profile-inherited via `extends:`, no-extends
agent doesn't see profiles, per-agent override beats profile,
per-agent `false` over profile drops grant.

## v0.13.42 — broker ACL grants user-declared MCP secrets + silent-end retry-budget hygiene

### fix(broker): ACL grants user-declared mcp_servers.*.secrets[] keys (PR #1806)

User-declared MCP servers in switchroom.yaml (perplexity, notion, any
operator-added entry) whose launcher fetches its API key via
`switchroom vault get <key>` were broker-denied at spawn time. The
vault-broker ACL only special-cased three identity-bound exceptions
— Google account slots, gdrive's `google/client-secret`, per-agent
`telegram-bot-token` — plus the union of `schedule[].secrets[]`. Any
launcher-time vault fetch outside those clauses hit
`VAULT-BROKER-DENIED`, the launcher exported an empty env var, and
the upstream MCP server hard-rejected on missing key.

Live repro 2026-05-25 (clerk): the perplexity MCP was wired through
scaffold (#1786) + launcher mount (#1787) + mint_grant persistence
(#1798), all green. But `claude mcp list` reported perplexity as
"Failed to connect" because clerk's broker ACL had no entry for
`perplexity/api-key`.

Fix: generalise the gdrive `google/client-secret` special-case into
a per-MCP `secrets:` declaration on each `mcp_servers.<name>` entry.
Operators opt in inline:

```yaml
defaults:
  mcp_servers:
    perplexity:
      command: /home/<operator>/.switchroom/mcp-launchers/perplexity-mcp.sh
      secrets: [ perplexity/api-key ]
```

The cascade resolves `mcp_servers.perplexity` onto every agent that
inherits defaults; the declared `secrets[]` array is then broker-
accessible to that agent under its peercred identity. No per-agent
`vault grant` ceremony required.

- Checked BEFORE the no-schedule early-deny so an MCP-only agent
  (no cron) still works.
- `false` opt-outs (`mcp_servers: { perplexity: false }` per-agent)
  drop the ACL grant too.
- Opt-in per-MCP — an entry without `secrets:` gets nothing.
- Switchroom-internal `secrets:` is stripped from rendered `.mcp.json`
  so vault key names don't leak to the in-container Claude session.

8 new ACL unit tests + 1 scaffold test pin the contract. Docs
updated in `docs/configuration.md` ("Wiring an MCP server that
needs vault secrets") and `docs/vault-broker.md` ("Identity-bound
ACL exceptions").

### fix(telegram): silent-end retry-budget hygiene (PRs #1804 + #1805)

Two related fixes to the Stop-hook silent-end re-prompt budget
introduced in #1664:

- **#1804** — `clearSilentEndState` widened to evict pre-#1664
  legacy-format state files. Pre-fix, legacy files survived every
  clear path forever and broke the retry budget on any subsequent
  silent-end for the affected agent. Reproduced live on clerk
  2026-05-25 around 17:15 Melbourne.
- **#1805** — `clearSilentEndState` now called at turn-start
  (immediately after `currentTurn = next`) so the Stop hook's retry
  budget resets to zero on every new turn instead of inheriting from
  prior turns.

## v0.13.41 — #1799 follow-up: apply-side sweep + docs cleanup, quota reset UX

### fix(#1799 follow-up): apply-side cleanup of stale cron-*.sh (PR #1802)

Discovered during the v0.13.40 rollout: PR #1799 added the
dormant-script sweep to `reconcileAgentDir`, but `switchroom apply`
calls `scaffoldAgent` (not reconcile) for agents it considers "up to
date". On the live host, agents WITH `schedule:` entries still had
their dormant `cron-*.sh` + `.source` files on disk after rolling
v0.13.40 because the scaffold path had no sweep.

This release moves the sweep into `scaffoldAgent` so `switchroom
apply` sweeps regardless of which code path it takes per agent.
Idempotent: no-op when nothing matches. Defense-in-depth: the
reconcile sweep is retained.

Also cleans up stale doc/comment references that still described
the retired cron-script generation path:
- `src/agents/cron-unit-name.ts` — header rewritten to make the
  file's cleanup-only survival role explicit
- `src/agents/lifecycle.ts` — `classifyChangeKind` + `applyCronChangesHot`
  doc comments updated (cron change-kind now signals stale-script
  deletion, not regeneration)
- `src/cli/agent.ts:597` — Phase F hot-reload comment updated
- `docs/auth.md:268` — hindsight described accurately as using the
  `claude-code` LLM provider (over the Anthropic API under the
  consumer's OAuth identity), not "running `claude -p`"

### feat(web): surface quota reset times under the 5h/7d % cells (PR #1801)

Pure UI: the operator web dashboard now shows the wall-clock reset
time alongside the 5h/7d quota percentages — easier at-a-glance
"when does this reset?" without doing math from now+remaining.

## v0.13.40 — bridge-flap class closed: eliminate `claude -p` cron generator, vault-broker per-agent token mount

Two fixes that together close out a 2026-05-25 forensic investigation
of recurring bridge-reconnect-race storms on a long-running agent.

### fix: eliminate `claude -p` cron script generator (#1613/#1616 follow-up, PR #1799)

The 2026-05-25 storm cluster on clerk was caused by the legacy
`src/agents/scaffold.ts:buildCronScript` writing literal `claude -p
'<prompt>'` to `~/.switchroom/agents/<name>/telegram/cron-*.sh` on
every `switchroom apply`. The agent-scheduler (Phase 4 cron-fold-in,
#890-#893) had moved cron firing to in-container `inject_inbound`
IPC, but the scripts remained on disk — and any code path that
invoked one (or any external trigger we couldn't fully pin down
in the forensic window) spawned a parasitic 2nd claude code session
that loaded the agent's full `.mcp.json` (including
`switchroom-telegram`), creating a 2nd telegram bridge that
ping-pong'd with the live agent's bridge against the gateway IPC's
`register: closing prior client for agent=... — bridge reconnect
race` eviction. That's the #1613/#1616 flap class.

Separately and equally important: `claude -p` is **programmatic**
usage under Anthropic's 2026-06-15 policy — off the Pro/Max
subscription. Generating these scripts at all is a switchroom
pillar-3 compliance violation (CLAUDE.md hard constraint).

Changes:
- `src/agents/scaffold.ts`: delete `buildCronScript` and both
  callsites. Reconcile path now unconditionally deletes any
  `cron-*.sh` + `.source` files (both content-hash and legacy
  `cron-<index>.sh` forms). Idempotent — re-running on a clean
  agent is a no-op.
- `src/cli/migrate.ts` (deleted): one-shot pre-Phase-D filename-
  migration verb, now moot.
- `src/agents/sub-agent-telegram-prompt.ts`: delete the cron-
  specific `build/applyCronTelegramGuidance` helpers (sub-agent
  progress guidance for live sessions stays). Cron prompts now
  flow into the live session via `inject_inbound` and use the
  session's existing reply-tool guidance.
- `tests/bridge-flap-regression-guard.test.ts`: add second scan
  that catches `claude -p` in **string-template literals** (single,
  double, backtick), with a `KNOWN_TEMPLATE_GAPS` allowlist that
  may only shrink. The existing spawn-callsite regex missed the
  scaffold.ts violation because the literal was inside a TS string
  template emitted to a shell script, not a direct spawn callsite.
- `tests/scaffold.test.ts`: replace the cron-script generation
  tests (asserting old shape) with retirement-contract tests
  (scaffold writes no `cron-*.sh`; reconcile deletes any stale
  ones).

The first `switchroom apply` after rolling this release sweeps
every agent's `telegram/cron-*.sh` + `.source` artifacts, closing
the active-code path of the flap class for good.

### fix(broker): bind-mount per-agent `.vault-token` files into vault-broker (#1798)

The vault-broker's `mint_grant` flow writes the per-agent capability
token to a per-agent file. Pre-fix the broker container had no
bind-mount for the path on the agent side, so the file write
silently no-op'd from the broker's perspective and the agent's
next vault read missed the freshly-minted grant. This bind-mounts
each `~/.switchroom/agents/<name>/telegram/.vault-token` path into
the broker's matching agent dir so `mint_grant` lands durably.



Three independent fixes batched into a single release. All from the
fresh-process reviewer pass on PR #1706.

### fix(telegram): decode entities before re-escape in prior_assistant_preview (#1791, PR #1796)

`steering.ts:formatPriorAssistantPreview` stripped HTML tags and then
XML-escaped *without* decoding entities first. A turn containing
inline `<code>` (stored in history as `<code>&lt;…&gt;</code>`)
surfaced to the model on the next inbound's `prior_assistant_preview`
attribute as `&amp;amp;lt;…&amp;amp;gt;` — triple-encoded. The model
had to mentally decode three layers to recover the original
characters it wrote one turn ago — measurably hostile to
comprehension on turns with placeholders, JSX, XML, generics, etc.

Fix: decode the canonical six entities (`&lt;` / `&gt;` / `&quot;` /
`&apos;` / `&nbsp;` / `&amp;`) after strip and before the existing
re-escape pass. Attribute boundary stays safe because
`escapeXmlAttribute` runs unchanged at the tail. Decode order has
`&amp;` last so a single pass can't strip two layers (e.g. someone
deliberately encoding the word `&lt;` round-trips back to itself).

### fix(telegram): answer-stream forceNewMessage clears stale draftId before rotating (#1792, PR #1796)

PR #1706 added `clearDraftBestEffort` to `stop()` and `retract()` so
the sendMessageDraft preview doesn't sit in the user's compose box
after turn end. The fresh-process reviewer flagged a latent race:
the only production caller (`gateway.ts:6476` rapid-steer path)
invokes `forceNewMessage(); stop();` on the prior turn's stream.
`forceNewMessage` synchronously rotates `draftId` to a fresh
allocation; stop's fire-and-forget clear then read the NEW (unused)
id, leaving the prior turn's stale content in the compose box until
Telegram's 30 s expiry.

Fix is in `forceNewMessage` itself — clear the OLD draftId BEFORE
rotating. That puts the responsibility on the rotation point, the
natural owner of the "abandon current turn, start fresh" semantic.
`stop()` and `retract()` continue to clear whatever draftId is
current at the time they run (defensive; clearing an unused id is a
harmless no-op).

### test(uat): promote pending-progress-html-dm to a permanent jtbd scenario (#1793, PR #1796)

The PR #1706 verification scenario (parse_mode-preserved on
cross-turn edits) becomes `jtbd-pending-progress-html-dm.test.ts`.
The pending-progress / silent-anchor / answer-stream code family all
touch the parse_mode contract on cross-turn edits; the existing UAT
suite covers cadence / round-trip / pacing but not parse_mode. #1698
shipped to prod with the suite green throughout — this scenario
closes that blind spot. ~80-90s runtime, part of `bun run test:uat`.

## v0.13.38 — approval-card collapsed view shows what + why without expanding

### fix(telegram): approval-card collapsed view (#1790, PR #1794)

Skill / MCP / generic-tool permission cards rendered as a single line
`🔐 Permission: <title>` with the agent's stated rationale and the
input preview hidden behind "See more". Operators couldn't tell why
they were being asked to approve. The vault `vault_request_access`
card already had a multi-line layout — it was the gold standard. This
release converges all three approval surfaces on the vault layout:

```
🔐 <agent> · <tool summary>
why: <description-or-"not provided">
```

Specifics:

- **`telegram-plugin/permission-title.ts`** — new
  `formatPermissionCardBody({toolName, inputPreview, description,
  agentName})` pure function builds the multi-line HTML-escaped body.
  Always renders the why-line: when the agent omitted `description`,
  renders `why: <i>not provided</i>` so a missing rationale is visible
  as an agent-side failure rather than a card-template choice.
- **Skill summarizer** no longer returns bare `Skill` when no
  skill-name key matches. Falls through `command` → first scalar arg
  hint before giving up. Closes the regression that produced
  "🔐 Permission: Skill" with zero context.
- **MCP summarizer** appends `(key: value)` for the first scalar arg
  of any uncurated MCP tool (skips routing-only keys like `chat_id` /
  `message_thread_id` / `request_id`). Operators see context on
  third-party / new MCP tools without an expand tap.
- **`onPermissionRequest`** (`telegram-plugin/gateway/gateway.ts`)
  switched to the new body builder. Send call now carries
  `parse_mode: 'HTML'`. Passes `_client.agentName` so the operator
  sees which agent is asking.
- **`renderVaultRequestAccessCard`** always renders the why-line —
  `why: <i>not provided</i>` when reason is missing.
- **`bridge.ts`** vault tool description nudges agents to supply
  `reason`; explains that omission will render as "not provided"
  which operators will usually take as a Deny signal.

UAT on test-harness (bind-mounted dist) triggered the vault card and
observed clean rendering: `🔐 test-harness wants vault access / key:
pr1790-uat-fake / scope: read · duration: 30d / why: PR #1790 card
layout UAT` — no literal HTML tags, parse_mode=HTML honoured.

Out of scope: the expanded "See more" view stays as-is — collapsed-
view fix only. No bridge / IPC protocol changes (`description` was
already on the wire from Claude Code's `PermissionRequest` payload).

## v0.13.37 — user-declared mcp_servers reach .mcp.json (regression class fix)

Audit-driven release closing a class regression that shipped silently
since PR #875 (v0.7.6 docker cutover): user-declared `mcp_servers` in
`switchroom.yaml` (under `defaults.mcp_servers` or per-agent
`agents.<name>.mcp_servers`) never reached `.mcp.json` for any agent.
Live state on the operator's fleet pre-fix: `defaults.mcp_servers.perplexity`
and `agents.carrie.mcp_servers.notion` both absent from `claude mcp list`
on every agent despite being declared in yaml.

Three PRs, scoped per concern.

### PR A — fix(scaffold): user-declared mcp_servers reach .mcp.json (both writers) (#1786)

Root cause: both `.mcp.json` writers in `src/agents/scaffold.ts`
(`scaffoldAgent` and `reconcileAgent`) were template-driven — emitting
only the hardcoded framework set (`switchroom-telegram`, `agent-config`,
`hostd` if admin, hindsight, gdrive). User-declared entries DID land
in `settings.json` (via `profiles/_base/settings.json.hbs`), but the
agent's `exec claude` line at `profiles/_base/start.sh.hbs:559` carries
`--dangerously-load-development-channels server:switchroom-telegram`
with no `--mcp-config` — Claude Code loads project MCPs from `.mcp.json`
in CWD only. `settings.json.mcpServers` is dead text for this
invocation.

Fix: after the framework set is assembled, spread
`agentConfig.mcp_servers` into the rendered `mcpServers` map in both
writers, filtered through the existing `filterMcpServers` helper (which
strips `false` opt-out sentinels). User-declared entries win on key
collision — matches the settings.json precedence at line ~2255 where
built-in defaults only land when `!settings.mcpServers[entry.key]`.

The trust pass `ensureMcpServersTrusted` automatically picks up the
new entries because it iterates `Object.keys(mcpServers)`.

### PR B — feat(compose): mount ~/.switchroom/mcp-launchers/ for user-declared command-based MCPs (#1787)

PR A makes user-declared HTTP MCPs (e.g. carrie's `notion` with
`type: http`) work as soon as it lands. For command-based MCPs (e.g.
perplexity's `command: /home/<op>/.switchroom/perplexity-mcp.sh`) the
launcher path also needs to resolve inside the agent container — pre-fix
only the per-agent subdirs of `~/.switchroom/` were bind-mounted,
nothing at the root.

Fix: `src/agents/compose.ts` adds a same-path `:ro` bind-mount of
`~/.switchroom/mcp-launchers/` into every agent, mirroring the existing
`skills/` mount pattern. Operators drop launchers in that convention
directory; the yaml `command:` value Just Works in-container.
`existsSync`-guarded so dev installs without a launcher dir don't
hard-fail compose `up`.

### PR C — feat(doctor): probe user-declared MCPs against rendered .mcp.json (#1788)

Regression guard for the bug class fixed in PR A. New
`checkUserDeclaredMcps` helper cross-references the cascade-resolved
`mcp_servers` (defaults + per-agent merge via the canonical
`resolveAgentConfig`) against the keys actually in the rendered
`.mcp.json`. Three outcomes per agent: **skip** (no user-declared),
**ok** (all present), **warn** (with missing-key list + reconcile
fix-up). `false` opt-out sentinels are filtered before the diff. A
future writer regression of the same class would surface as a warn
within one `switchroom doctor` invocation instead of silently shipping
again.

### Operator-side migration (private config repo)

Operators with launchers at the root of `~/.switchroom/` must move
them under `~/.switchroom/mcp-launchers/` for the new bind-mount to
reach them and update the corresponding `command:` paths in
`switchroom.yaml`. One-time migration; the launcher contents are
unchanged.

## v0.13.36 — silent-end determinism, error-envelope completeness, ticker + oversize-card fixes

15 commits since v0.13.35. Headline: the silent-end Stop hook is now
deterministic (#1775 race closed) — instead of depending on a gateway-
written state file as its block/allow signal (a file written ~175ms
AFTER the hook fires, so the race was structurally always lost), the
hook now reads `transcript_path` directly and scans the just-finished
turn's tool_use entries. The state file is preserved for retry-count
bookkeeping only.

Error-envelope rollout completes (#1769 Phase 2 + #1770 Phase 3 +
#1773 / #1774 / #1780 tightenings) — `ERROR-ENVELOPE: <json>` sibling
lines on every denial path; negative-path schema tests pin the
integrity boundary; `VAULT-BROKER-DENIED` prefix collision fixed.

Plus a small cluster of UX fixes: still-working ticker teardown on
reply finalize (#1763), drive-write approval-card oversize-body
overflow (#1768), config_propose_edit silent E_DENIED on oversize
diff (#1766), cron-interval doc clarity (#1782).

### fix(#1775): deterministic silent-end Stop hook via transcript scan

The pre-fix Stop hook (silent-end-interrupt-stop.mjs) depended on the
gateway's `silent-end-pending.json` as its block/allow signal. That
file is written by the gateway's `turn_end` handler downstream of the
JSONL `turn_duration` line, which is itself written AFTER
`stop_hook_summary`. Live evidence on clerk (12 correlated samples,
2026-05-25): the state file lands ~175ms (range 111-287ms) after the
hook fires. The race is structurally always lost — the hook never saw
its OWN turn's signal. The recovery mechanism only worked
one-turn-delayed via stale state from prior turns.

The hook now reads `transcript_path` from its event input directly
(Claude Code flushes assistant content to JSONL before firing Stop
hooks — verified empirically) and scans the current turn's
`tool_use` entries for a qualifying reply. The `isFinalAnswerReply`
predicate (done===true OR !disableNotification OR text.length>=200)
mirrors `telegram-plugin/final-answer-detect.ts:78-83`. NO_REPLY /
HEARTBEAT_OK silent-marker carve-out preserved; sub-agent
(`isSidechain:true`) lines skipped (the parent's reply obligation
isn't satisfied by a sub-agent's reply tool).

The hook's state-file write now includes `turnKey` + `chatId` derived
from the enqueue envelope so the gateway's later `recordSilentTurnEnd`
write matches in `writeSilentEndState`'s preservation gate
(`silent-end.ts:114`) and honors the 1-retry design budget. Without
this, the gateway would reset retryCount to 0 and double the
effective re-prompt budget.

29 new tests pin every branch (scan helper + spawn-subprocess
integration). Live UAT against Ken's msg 12227 slip data: ack-only
+ plain-text answer → block; final reply → allow; trivial reply →
allow; NO_REPLY → allow; exhausted retry → allow.

### fix(#1779/#1782): clarify extractCronIntervalMin returns smallest gap, not worst-case

Documentation-only clarification — the helper computes the smallest
gap between adjacent fires, not the worst-case interval. Misnaming
risked downstream callers treating it as a ceiling.

### fix(#1777): rename envelope sentinel to `ERROR-ENVELOPE:` to avoid `VAULT-BROKER-DENIED` prefix collision

The Phase 3 envelope sentinel originally shipped as
`VAULT-BROKER-DENIED-ENVELOPE: <json>` (#1776), which shares a prefix
with the legacy `VAULT-BROKER-DENIED [<code>]: <msg>` line. A loose
`/^VAULT-BROKER-DENIED/` decoder regex matched both lines and tried
to parse the envelope as legacy, getting `ENVELOPE: {...}` as the
"code". Renamed the sentinel to `ERROR-ENVELOPE:` — canonical across
all envelope-emitting CLIs, and breaks the prefix collision cleanly.
Exported as `ENVELOPE_SENTINEL` from `src/cli/vault-denied-envelope.ts`.

### feat(#1770): error envelope Phase 3 — VAULT-BROKER-DENIED and cron quota errors

Extends the structured `error_envelope` (#1758 Phase 1, #1759 / #1769 Phase 2)
to the two error families that live outside hostd. The vault CLI now writes
a sibling `ERROR-ENVELOPE: <json>` line on stderr alongside the
byte-identical legacy `VAULT-BROKER-DENIED [<code>]: <msg>` line — `fix.kind`
is `request_vault_grant` with `vault_key` populated so the gateway's auto-
resume flow has the unlock-card hint it needs. The `agent-config` CLI's
`emitError` JSON line now carries an `error_envelope` sibling for
`E_CRON_TOO_FREQUENT` and `E_QUOTA_EXCEEDED`, both `fix.kind: quota_exceeded`
with the `quota`/`current`/`limit` triplet filled. Top-level `code`/`message`
fields preserved verbatim for back-compat with string-matching decoders.

### feat(#1761): error envelope Phase 2 — batch migration + denied-vs-error classification + negative-path tests

Follow-ups on the Phase 1 wire protocol (#1759). Five tightenings:

1. **Negative-path schema tests for `ErrorFixSchema` / `ErrorEnvelopeSchema`.**
   Phase 1 only pinned the happy path. Phase 2 adds `safeParse` rejections
   for: unknown `fix.kind`, missing required field per kind, non-URL
   `docs`, malformed `code` (`e_lowercase`, bare `FOO`). The discriminator
   is the integrity boundary for the unlock-card path — every silently-
   accepted garbage shape becomes a load-bearing allowlist bypass on the
   gateway side.

2. **`err().docs(URL)` now throws `TypeError` at author-time** on a
   non-URL string, matching `ErrorEnvelopeSchema`'s `z.string().url()`
   receiver-side check. A new call site can no longer ship an envelope
   that fails its own schema.

3. **`E_CONFIG_EDIT_DISABLED` returns `result: "denied"`** instead of
   `"error"` — it's a policy denial (feature flag off), not a server
   fault. `asDenied()` swept across the other policy-denial codes
   migrated in this PR (`E_DENIED`, `E_APPROVAL_TIMEOUT`).

4. **Batch-migrated every remaining `errorResponse()` call site** in
   `src/host-control/server.ts` to the `err()` builder with the
   appropriate `fix` envelope:
   - validation rejections (`E_PATCH_APPLY_FAILED` etc.) → `fix: bad_input`
   - `E_NO_APPROVAL_GATEWAY` → `fix: operator_action` (infra)
   - operator tap-deny `E_DENIED` → `fix: operator_action` (policy_denied), `result: "denied"`
   - dispatch-failure `E_APPROVAL_DISPATCH_FAILED` → `fix: operator_action` (infra), `result: "error"`
   - `E_APPROVAL_TIMEOUT` → `fix: operator_action` (policy_denied), `result: "denied"`
   - rollback-path `E_RECONCILE_FAILED_ROLLED_BACK` → `fix: operator_action` (infra)
   - top-level dispatch catch → `E_DISPATCH_FAILED` (no fix, internal)
   - `get_status` invariant violation → `E_INTERNAL` (no fix)

   Legacy `error: string` is preserved verbatim at every migrated site
   so existing string-matching decoders (audit reader, telegram-plugin
   gateway response handler, broker client) see no semantic regression.

5. **MCP hostd surface — `content` length goes 1 → 2 on errors.** When
   `error_envelope` is present, the MCP hostd tool response now appends
   a second `content` text item carrying the envelope JSON (with a
   leading `Structured error — fix.kind=…` discriminator hint). Tooling
   that string-matches `content[0].text` is still safe; tooling that
   parses the structured form should branch on `content.length === 2`.

### test(#1771/#1774): envelope-shape assertions for three Phase 2 codes

Pins the wire-format of `E_PATCH_APPLY_FAILED`, `E_DENIED`,
`E_APPROVAL_TIMEOUT` envelopes — the three Phase 2 migrations most
likely to regress on a future codepath change.

### fix(#1772/#1773): diff-preview-card error message says '8 hex' but regex is 32

The user-facing error said "expected 8 hex characters" while the
backing regex required 32. Aligned the message to the regex.

### fix(#1767/#1768): drive-write approval card oversize-body overflow

Card body text larger than Telegram's per-message budget overflowed
silently and never rendered. Now truncates with a "…[N chars
truncated]" suffix and emits the full body to the audit log so
operators can recover the original on demand.

### fix(#1762/#1766): config_propose_edit silent E_DENIED on oversize diff

`agent_config` would return `E_DENIED` (looks like a policy denial)
when the diff exceeded the size budget — the user got no hint that
they were close to a hard limit. Now returns `E_INPUT_TOO_LARGE`
with the byte counts in the envelope so the operator can decide
whether to split the edit.

### fix(#1760/#1763): tear down still-working ticker on every reply finalize

The "still working…" ticker was started on the first non-trivial
tool_use and torn down only when the model called `done:true`. For
turns that ended via a final reply WITHOUT a done flag (the
common case for short factual answers), the ticker was left
running until the gateway's turn-end housekeeping caught it ~5s
later — visible as a stray "still working…" beat AFTER the final
answer had already landed. Now torn down on every reply finalize.

### chore(deps): dependabot bumps

- `docker/setup-buildx-action` 4.0.0 → 4.1.0 (#1751)
- `node` base image `689c110` → `7af03b1` (#1752)
- `docker/build-push-action` 7.1.0 → 7.2.0 (#1753)
- `docker/login-action` 4.1.0 → 4.2.0 (#1754)
- `actions/cache` 4.3.0 → 5.0.5 (#1755)

## v0.13.35 — gateway crash-banner noise, error envelope, timezone hook

Three reliability/UX fixes landed since v0.13.34.

### PR A — fix(gateway): stop the agent-crashed banner noise (#1764)

"Clerk seems to be crashing" investigation 2026-05-25 surfaced two
distinct sources of misleading `agent-crashed` Telegram banners:

1. **Clean-shutdown marker never cleared on boot.** A marker from a
   prior graceful shutdown could sit on disk for hours; when the
   gateway later crashed via `unhandledRejection` (which explicitly
   SKIPS writing a fresh marker per `gateway.ts:15107`), the next
   boot read the old marker, classified it stale-by-age, and posted
   a banner with detail like `clean-shutdown marker stale
   age=39976s` — misleadingly tying the old marker to the current
   crash. Fix: clear the marker after the boot reads it. The marker
   now describes the IMMEDIATELY PRECEDING shutdown only.

2. **429 + 5xx + HttpError leaked past the retry policy → crash.**
   `classifyRejection` returned `shutdown` for these even though
   `retry-api-call.ts:100-162` already handles them with backoff.
   A leaked rejection from a fire-and-forget callsite (or 3
   sustained retries) crashed the gateway and posted a banner.
   Fix: broaden `log_only` to cover 429 (flood-wait), 5xx
   (transient server errors), and `HttpError` (network-layer
   transient failures). `401` / `403` / unknown-`400` still
   crash (genuine config bugs).

Tests: `unhandled-rejection-policy.test.ts` updated (old "shutdown
for 429"/"shutdown for 500" tests inverted to `log_only`; new
502/503/HttpError cases). New `boot-clears-clean-shutdown-marker.
test.ts` pins the import + call-site + comment-explains-edge-case
structurally.

### PR B — feat(#1758): error envelope Phase 1 (#1759)

Wire protocol + builder + `E_CONFIG_EDIT_DISABLED` migration +
unlock card. First phase of the error-envelope refactor that lets
verbs return structured failure codes with operator-facing
remediation instead of opaque strings.

### PR C — fix(timezone-hook): include weekday + AM/PM (#1757)

The timezone hook injected ISO datetime only, which let the LLM
drift on day-of-week and 12h/24h context. Now includes weekday +
AM/PM in the injected line.

## v0.13.34 — silent-end determinism, handoff reliability, release self-healing

Four PRs landing two reliability cleanups in the Telegram-plugin
gateway, plus a closed loop that means future fleet upgrades happen
automatically rather than requiring an operator `update_apply` per
agent.

### PR A — fix(#1741): gate clearSilentEndState on isFinalAnswerReply (#1744)

Interim ack replies (`disable_notification: true`, text < 200 chars,
no `done` flag) were unconditionally clearing the silent-end state
file AND bumping `outboundMetrics.outboundCount` — silencing the
missed-reply detector on every turn that emitted a "still working"
ping. The fix gates both state-file clearing and outbound-count
bumping behind `isFinalAnswerReply({ text, disableNotification, done })`
at both call sites (`executeReply`, `executeStreamReply`). 6 new unit
tests in `tests/silent-end.test.ts` exercise the ack-persists,
final-clears, length-backstop, and ack-then-final-ordering branches.

### PR B — silent-end follow-ups: stream_reply edge case, integration test, docs (#1748)

Reviewer follow-ups from PR A:

- `clearSilentEndState` now also fires next to
  `turn.finalAnswerDelivered = true` at `gateway.ts:5343` — handles
  streams whose FIRST emit was ack-shaped (skipping the first-emit
  gate) but whose LATER emit flips `done=true`. The clear is
  turnKey-matched so unconditional invocation on every final-answer
  emit is idempotent.
- New `tests/silent-end-integration.test.ts` walks the full stream
  state machine through ack→final ordering — closes the gap left by
  PR A's inline-gate unit tests.
- "Silent-end contract" section added to
  `telegram-plugin/docs/waiting-ux-spec.md`.

### PR C — feat(#1743): release-triggered fleet restart (pull-based) (#1747)

Opt-in `ReleaseWatcher` inside `hostd` polls `docker manifest
inspect` (remote digest) vs `docker image inspect` (local digest) on
a configurable interval. On new release detected, runs `switchroom
update` + `switchroom restart all`. Default off (`host_control.
auto_release_check.enabled: false`); operators flip it on per host.
Closes the deploy-lag root cause where a binary rebuild only
propagated to running agents on next manual restart. Telemetry
JSONL at `~/.switchroom/release-watcher-events.jsonl` records every
state transition; the AC's `time_from_release_to_fleet_caught_up_
seconds` counter equals `duration_ms` on the `fleet_caught_up` row.
8 unit tests cover all branches (available/unavailable, apply
failure, check failure, overlap, stop).

### PR D — fix: handoff yaml dep + remove fictional live-briefing fallback (#1749)

Closes #1745 and #1746:

- `src/cli/handoff.ts` catches `ConfigError` from `loadConfig()` and
  falls back to defaults (`agentDir = $CLAUDE_PROJECT_DIR ?? cwd`,
  `max_turns_in_briefing = 50`). The yaml is not bind-mounted into
  sandboxed agent containers, so the previous hard-require produced
  a red issue card on every Stop turn-end on every sandboxed agent
  and prevented `.handoff.md` from ever being written.
- `src/agents/scaffold.ts` drops the `--config '/state/config/
  switchroom.yaml'` arg from the emitted Stop-hook command. The
  `configPath` field on `HooksBlockParams` is marked `@deprecated`.
- Drift test in `tests/reconcile-hooks-drift.test.ts` flipped to
  assert the inverse (must NEVER contain `--config`).
- CLAUDE.md scaffold template (`profiles/default/CLAUDE.md.hbs`)
  refined to accurately describe the live-briefing path that
  `handoff-briefing.sh` provides.

## v0.13.33 — doctor: vault-broker durability section (regression coverage for the v0.13.27-32 wedge cluster)

Single feature PR (#1739). New doctor section `Vault-broker durability`
with 6 probes that catch deployment-shape regressions in the broker
bind-mount + auto-unlock chain. Every regression in the v0.13.27 →
v0.13.32 wedge cluster would have been caught by ONE of these probes
if they had existed.

### PR A — feat(doctor): vault-broker durability section (#1739)

Probes:

1. `vault-broker unlocked (state)` — broker actually unlocked at
   runtime, not just `vault.broker.autoUnlock: true` in config.
2. `vault-broker: auto-unlock blob` — `~/.switchroom/vault-auto-unlock`
   exists with non-zero size.
3. `vault-broker: machine-id passthrough` — `/etc/machine-id` mounted
   into the broker.
4. `vault-broker: vault.enc bind mount` — host inode == broker
   container inode.
5. `vault-broker: vault-grants.db bind mount (#1737)` — the reviewer-
   suggested probe from #1737. Catches the EXACT regression class
   the v0.13.32 fix addressed.
6. `vault-broker: vault-audit.log bind mount (#1025)` — symmetric
   coverage for the audit log.

Architecture: bind-mount probes use `docker exec switchroom-vault-
broker stat -c '%i %s'` to compare host inode/size against broker-
container view. The unlocked-state probe uses the host CLI
`switchroom vault broker status` because the broker container image
doesn't ship the switchroom CLI binary.

Verdict shapes: ok / fail-mismatch / warn-host-missing / skip-broker-
unreachable / warn-broker-stat-failed. Each failure detail names the
regression class explicitly with an actionable fix.

Tests: `doctor-vault-broker-durability.test.ts` — 12 cases pin each
verdict shape via dependency-injected mock stat/status functions
(no real broker needed). Full CLI suite green: vitest 439/439.

**Host-CLI-only fix.** Container images don't change. Operators get
the new doctor probes by upgrading the host `switchroom` binary
(`sudo npm i -g switchroom@0.13.33`).

## v0.13.32 — broker grants DB survives container recreate

Capability grants minted via Telegram approval cards (the access-
approve flow) live in `vault-grants.db` SQLite. Pre-fix the broker
wrote to `/root/.switchroom/vault-grants.db` inside the container,
which evaporated on every container recreate. Token files on disk
(`~/.switchroom/agents/<agent>/.vault-token`) persist via per-agent
bind mounts and reference grant IDs that no longer exist in the
fresh broker DB — `vault get` from inside agent containers
returns `VAULT-BROKER-DENIED [DENIED]: key 'X' not in ACL for agent
'Y'` because the #1496 fall-through routes the unusable token to
the standing schedule.secrets ACL, which usually denies (the whole
reason a grant was minted in the first place).

Surfaced 2026-05-24 after the v0.13.31 broker recreate wiped every
grant minted earlier the same day (clerk's `vg_5e1991` grant for
`ha/access-token` disappeared). Doctor doesn't catch this — it only
inspects path-as-identity ACL, not grant-based access.

### PR A — fix(broker): bind-mount vault-grants.db so capability grants survive container recreate (#1737)

Mirrors the existing vault-audit.log pattern:
- `src/agents/compose.ts` adds the RW bind mount
  `${HOME}/.switchroom/vault-grants.db:/root/.switchroom/vault-grants.db`
  in the broker service.
- `src/cli/apply.ts:ensureHostMountSources` pre-creates the host
  file as 0-byte mode 0600 (secrets material — bcrypt-hashed grant
  tokens) so docker doesn't auto-create a directory at the source
  path on greenfield installs.

`openGrantsDb` runs the SQL migration idempotently on every open,
so the broker boots cleanly on either an empty new file OR an
existing populated DB.

**Rollout impact:** broker container recreate adopts the host
file. Any grants minted between the host file's last write and
the rollout are lost (they were in the ephemeral container DB).
Operators with active grants will need to re-approve via Telegram.

## v0.13.31 — buffer gate releases on every reply finalize (v0.13.30 wedge fix)

Closes the trivial-prompt wedge surfaced on the v0.13.30 UAT canary
where short non-notification replies (the model classifying its
answer as an interim ack — "4" for "what's 2+2?") left the buffer
gate set forever. Every subsequent inbound logged `held mid-turn ...
will flush on turn-complete` but `turn_end` doesn't reliably fire
for trivial-prompt turns, so the gate never opened.

The wedge has been latent since v0.13.28 (where the narrow #1729
`isFinalAnswerReply`-gated fix first landed). v0.13.28 passed UAT
once by cache-warm luck; the structural issue stayed. v0.13.30
didn't regress anything — the gateway diff between v0.13.28 and
v0.13.30 doesn't touch `executeReply`, `finalizeStatusReaction`, or
`activeTurnStartedAt`. Just exposed it on a different cache state.

### PR A — fix(gateway): release buffer gate on every reply finalize (#1735)

Decouple buffer-gate cleanup from reaction-state finalize.

New narrow `releaseTurnBufferGate(key)` helper does ONLY:
- `activeTurnStartedAt.delete(key)` (the buffer gate)
- The deterministic-delivery flush on `size === 0`
- A `shadowEmit({ kind: 'turnEnd' })` for the structural metric

It does NOT touch:
- `activeStatusReactions` (preserves #1713's bidirectional ladder
  AND the steer-vs-queue logic at `gateway.ts:7787` which reads
  the controller to classify mid-turn inbounds)
- `activeReactionMsgIds`, the typing loop, or the reaction
  message-id removal

Called unconditionally from `executeReply` and `executeStreamReply`
on successful finalize — regardless of `isFinalAnswerReply`. The
narrow #1729 `finalizeStatusReaction` call stays (still fires the
👍 reaction on the final-answer happy path); only the buffer-gate
cleanup is broadened.

Net contract:
- Final-answer reply → 👍 + buffer gate released (unchanged)
- **Short non-notification reply → no 👍 + buffer gate released**
  (this is the v0.13.30 fix)
- `turn_end` event → 👍 + buffer gate released (unchanged)
- Steer / queued mid-turn detection — unchanged (reads
  `activeStatusReactions`, which the new helper does not touch)

Tests: new `buffer-gate-broadened.test.ts` (5 cases) pins the
narrow contract structurally — helper exists, body is narrow
(no `activeStatusReactions.delete` / `finalizeStatusReaction` /
`purgeReactionTracking` in body), release call is OUTSIDE the
`isFinalAnswerReply` branch in `executeReply`, callsite count
locked to 3 (definition + 2 usages) so any future mid-turn
callsite trips the test for reviewer awareness.

Full plugin suite green under both runners (vitest 2750/2750 +
bun:test 3336/3336).

## v0.13.30 — vault_request_save attest-via-posture under telegram-id

Closes the UX gap where tapping Save on a `vault_request_save` card
surfaced a misleading "🔒 Vault is locked" message even when the
broker had been auto-unlocked at boot for hours. Telegram-id-mode
installs never run `/vault unlock` (auto-unlock is the design intent),
so the gateway's per-chat passphrase cache stayed empty forever and
every save card wedged.

### PR A — fix(gateway): vault_request_save routes through attest_via_posture under telegram-id (#1733)

#1115 follow-up. The save handler now uses `attest_via_posture: true`
on the broker `put` (same primitive `mint_grant` has used since
#1115). Closes the tracked TODO named at `gateway.ts:11784`.

Architecture: broker already supported `put` with
`attest_via_posture: true` (`server.ts:1448-1500`, added by #1115
follow-up rev 3) and broker client `putViaBroker` already accepted
the flag. The gap was the CLI shell-out (`defaultVaultWrite`) — new
`defaultVaultWritePosture` helper calls `putViaBroker` directly,
returning the same `VaultWriteResult` shape for drop-in substitution.

Behavioral contract:
- interim ack reply (`isFinalAnswerReply === false`) — unchanged
  non-event for the reaction (preserves #1713)
- final-answer reply — unchanged (still triggers
  `finalizeStatusReaction` from #1729)
- **`vault_request_save` Save tap under telegram-id** — now uses
  posture-attested broker put; no passphrase needed; no
  `/vault unlock` prerequisite
- `vault_request_save` Save tap under passphrase mode — unchanged
  (cached-passphrase + shell-out to `switchroom vault set`)
- Card text corrected from "🔒 Vault is locked" (misleading — the
  broker may be unlocked) to "🔒 Passphrase not cached for this
  chat" in the passphrase-mode failure branch.

Operator note: under telegram-id mode the broker requires the agent
be in `vault.broker.postureMintAgents` for posture-attested put to
succeed (same allowlist `mint_grant` uses). Operators new to the
posture flow who haven't allowlisted will hit
`VAULT-BROKER-DENIED (DENIED): agent 'X' is not on
vault.broker.postureMintAgents` — surfaces via the existing renderer
with the existing remedy.

Tests: new `vault-write-posture.test.ts` (7 cases) pins the helper's
contract; existing `vault-approval-posture.test.ts` updated with new
pins for the posture-attested call site and the corrected card text.
Full plugin suite green under both runners (vitest 2745/2745 +
bun:test 3331/3331).

## v0.13.29 — host vault list broker-first (UX, host CLI only)

Single fix; no container image changes; no fleet roll needed — only
the operator's local `switchroom` CLI changes.

### PR A — fix(cli): vault list routes through the broker first on the host (#1731)

`switchroom vault list` on the host always prompted for the operator
passphrase, even when the broker was up and unlocked with the
operator socket bound. `vault get` (since #1053) and `vault set`
(since #969 P1b) both already broker-first on the host. Only `list`
was the outlier — it routed through the broker exclusively in
sandbox contexts.

Fix: mirror the `vault get` broker-first pattern. Pre-fix behavior
is preserved verbatim for the fallback cases.

Net contract:
- host + broker unlocked     → list via broker (no passphrase)
- host + broker locked       → fall through to passphrase prompt
- host + broker unreachable  → fall through to passphrase prompt
- sandbox + broker unlocked  → list via broker (only path)
- sandbox + broker locked    → exit 3 (mirrors `vault get`)
- sandbox + broker unreach.  → exit 6 (preserves pre-fix sandbox)

## v0.13.28 — v0.13.27 wedge fix (final-answer reply releases buffer gate)

v0.13.27 was released and immediately reverted because every agent
wedged on `inbound held mid-turn — will flush on turn-complete` with
the gate never opening. v0.13.28 ships the targeted fix.

### PR A — fix(#1728): release buffer gate on final-answer reply (#1729)

Root cause: #1718's contract change made `turn_end` the sole terminal
trigger for BOTH the 👍 reaction AND the per-turn buffer gate
(`activeTurnStartedAt`). Pre-#1718, `executeReply` synchronously
called `endStatusReaction('done')` → `purgeReactionTracking` which
cleared `activeTurnStartedAt[key]` on every reply. Removing that
call deferred the cleanup to `turn_end`. But Claude Code's
`turn_duration` system event doesn't reliably land in the JSONL
session tail for the trivial-prompt happy path (driver sends
"what's 2+2", model replies "4", no `turn_duration` ever fires).
When `turn_end` never fires, `activeTurnStartedAt[key]` stays set
forever and every subsequent inbound queues without delivery.

The contract was right in spirit (turn_end SHOULD be the sole
terminal trigger) but it relied on an upstream guarantee the Claude
CLI doesn't actually make. Production logs going back to 2026-05-21
show the pre-existing 300s `silence-poke framework-fallback` firing
regularly even on v0.13.26 with `currentTurn_nulled=false` — so this
wedge class existed pre-#1718; #1718 just promoted it from tail-case
to the common case for every trivial-prompt turn.

Fix: when `executeReply` detects the final answer
(`isFinalAnswerReply` — same classifier #1664 uses for silent-end
re-prompt gating), it now calls
`finalizeStatusReaction(chat_id, threadId, 'done')`. That fires the
debounced 👍 AND calls `purgeReactionTracking` which releases the
buffer gate. Interim acks (`isFinalAnswerReply === false`) bypass
this branch and remain non-events for the reaction (preserves
#1713's working-state ladder). `currentTurn` itself stays alive; a
subsequent `turn_end` event still cleans up its share idempotently.

Net contract:
- interim ack reply → non-event for reaction, buffer gate stays
- final-answer reply → finalize reaction (debounced 👍), release
                       buffer gate, currentTurn unchanged
- `turn_end` event → unchanged (still terminal, idempotent)

Tests: `telegram-plugin/tests/reply-terminal-reaction.test.ts`
updated to pin both halves of the new contract — the legacy
`endStatusReaction('done')` regression guard stays, plus a new case
asserts `finalizeStatusReaction` IS called AND IS gated on
`isFinalAnswerReply`. Full plugin suite green (vitest 2738/2738 +
bun 3324/3324).

## v0.13.27 — reflective status reactions + deterministic handback/progress envelopes

Four PRs tightening the conversational-pacing primitives the user
relies on as ambient liveness signals. All gateway/streaming work;
no broker changes; no schema/migration.

### PR A — fix(#1713): reflective status reactions — only turn_end finalizes (#1718)

The status reaction on a user's inbound message must reflect CURRENT
TURN ACTIVITY, not delivery state. Plain `reply` and `stream_reply
done=true` were both firing the terminal 👍 mid-turn, collapsing the
working-state ladder the user relies on as their primary ambient
liveness signal. Restores the documented contract
(`telegram-plugin/docs/waiting-ux-spec.md` Class B).

Contract (locked):
- `finalize(reason)` is the SOLE terminal trigger on the controller.
- `setTool` / `setThinking` / `setCompacting` / `setError` are
  bidirectional and non-terminal.
- Mid-turn replies (ack OR final-answer) are non-events for the
  reaction.
- Disconnect-flush and turn-flush backstops route through `finalize()`.
- Debounce 3500ms coalesces rapid state flips.
- `setSilent` removed (dead code); `setCompacting` wired into the
  proactive-compact emit path.

New JTBD UAT at
`telegram-plugin/uat/scenarios/jtbd-reflective-status-reaction-dm.test.ts`
covers all 4 acceptance criteria.

### PR B — fix(#1719): deterministic spoolId for subagent_handback envelopes (#1724)

The synthesised `subagent_handback` inbound used `Date.now()` as its
message id, so `spoolId()` minted a fresh `m:<chat>:<msgId>` for
every rebuild. A re-built envelope for the same finished sub-agent —
from the `onFinish` race or a gateway/container restart re-running
the watcher path — produced a NEW spoolId, so `InboundSpool.put`'s
idempotency-by-id couldn't collapse the duplicate and the handback
turn re-fired.

Fix: plumb the JSONL agent id (unique per Claude Code spawn) onto
`meta.subagent_jsonl_id` and branch `spoolId()` to return
`s:handback:<jsonl_agent_id>` for `meta.source === 'subagent_handback'`.
Old envelopes still work via the existing fall-through (no migration).

### PR C — feat(#1720): deterministic progress-pacing envelopes for background sub-agents (#1725)

Conversational-pacing beat-3 for *background* sub-agents: between
dispatch and the eventual handback (beat 4, #1724), the user saw
nothing about WHAT the worker was doing. The cross-turn ambient
ticker kept the parent's last reply alive ("— still working (Nm)")
but that's liveness, not content.

Design (one primitive, event-driven):
- The watcher already captures `lastResultText` on every
  `sub_agent_text` emission. Add an `onProgress` callback fired from
  the same branch.
- Foreground sub-agents short-circuit; only background paths emit.
- Envelope spoolId: `s:progress:<jsonl_agent_id>:<bucketIdx>` with
  `bucketIdx = floor(elapsedMs / progressIntervalMs)`. A worker
  emitting 10 narrative lines within one bucket window collapses to
  ONE live entry; the next bucket gets its own.
- TTL: every envelope carries `meta.expiresAt = nowMs + 2×interval`.
  `InboundSpool.liveEntries()` filters past-TTL entries — the single
  divergence from the handback shape.
- Handback-time sweep: when the gateway queues a `subagent_handback`,
  it calls the new `InboundSpool.dropMatching` with the
  `s:progress:<jsonl_agent_id>:` prefix so a still-live progress
  envelope from the same worker can't land on top of the handback turn.

Kill switch: `SWITCHROOM_DISABLE_SUBAGENT_PROGRESS=1`.

### PR D — chore: address post-merge nits from #1718 and #1725 (#1726)

Three reviewer-identified follow-ups, no behavior changes:

1. Delete dead `endStatusReaction` shim left over from #1718's
   contract change (no production call sites; 5 test stub properties
   also cleaned up).
2. Harden the `SWITCHROOM_DISABLE_SUBAGENT_PROGRESS` kill-switch
   parser — the original `!== '0'` gate foot-gunned on `"false"`,
   `"no"`, `"off"`. New `isEnvFlagOn` helper accepts unset / empty /
   `0` / `false` / `no` / `off` (case-insensitive, trimmed) as OFF.
3. Wire `clearPending('progress')` at the progress-envelope enqueue
   site so the cross-turn ambient ticker doesn't double-surface the
   signal as a parallel "— still working (Nm)" edit when the model is
   about to compose an explicit in-voice progress line.

## v0.13.26 — vault-broker per-agent unlock socket pair

Closes a structural gap in the per-agent socket model dating to v0.7:
`bindAgentSocket()` bound only the data socket, never a paired unlock
socket. The documented Telegram `/vault unlock` flow (CLAUDE.md) has
been silently non-functional since then — every in-container unlock
attempt hit `ENOENT /run/switchroom/broker/unlock` because the broker
never bound a listener at the path the client derives. Only the
host-shell route (`switchroom vault broker unlock` against the
operator socket pair) and the auto-unlock blob actually worked.

Surfaced 2026-05-24 when the operator hit it from klanker.

### PR A — fix(vault-broker): pair per-agent unlock socket with each data socket (#1721)

`bindOperatorListener` already pairs data + unlock sockets correctly.
Mirror that pattern in `bindAgentSocket`: bind the data socket, chown
to the agent UID, then bind a paired unlock listener at
`unlockSocketFor(abs)`, chown the same way, register both in
`agentServers` so `stop()` cleans them up. Peercred stays ON for
agent unlock — the operator-only peercred bypass added in #1561 does
not apply.

On bind failure for the unlock pair, tear down the data listener too
so the broker can't drift into a half-bound state (data up, unlock
down) where `/vault unlock` keeps failing silently.

- `src/vault/broker/server.ts:bindAgentSocket` — paired unlock bind.
- `src/vault/broker/server-per-agent-unlock.test.ts` (new bun:test) —
  pins the regression with `mock.module` to bypass the canonical
  `/run/switchroom/broker/...` regex; asserts both sockets exist as
  sockets, connection to the unlock socket no longer ENOENTs (the
  precise pre-fix symptom), and `stop()` unlinks both files.

**Rollout note:** vault-broker container must recreate to re-run
`bindAgentSocket` per agent. Agent containers do NOT need to restart
— they'll dial the new socket on next attempt.

### PR B — feat(doctor): probe per-agent vault-broker socket pair (#1722)

Operational regression guard at the doctor layer. PR A pins
`bindAgentSocket()` itself; this catches the deployment-level
regression class — broker image rolled back, compose volume mounts
drifted, `apply` skipped the reconcile — that the unit test can't
see.

- `src/cli/doctor.ts:probeVaultBrokerSocketPair` — single
  `docker exec switchroom-vault-broker sh -c "test -S sock && test -S
  unlock"` per agent; returns `ok | missing-unlock | missing-data |
  missing-both | unreachable`. Mirrors `probeAuthBrokerSocket` for
  the sibling auth-broker.
- `src/cli/doctor.ts:checkVaultBrokerSocketPairs` — aggregates per-
  agent verdicts into one CheckResult in the existing "Vault"
  section. Single row for a fleet of 9+ agents (no N-row spam).
- `src/cli/doctor-vault-broker-pairs.test.ts` (new vitest) — 9 cases
  pinning each verdict shape, including the partial-unreachable case
  that must NOT collapse to skip (mid-restart visibility), and the
  operator-facing detail string that names "ENOENT" so the symptom
  pattern-matches.

Verdict shapes:
- `ok` — all agents have both halves bound.
- `fail (unlock missing: <agents>)` — the precise pre-#1721 bug class.
- `fail (data missing / both missing / unreachable: <agents>)` —
  separate bug classes surfaced with their own group label.
- `skip` — broker container unreachable; one honest skip instead of
  N "missing" rows.

## v0.13.25 — security MED tail (epic #1389) + vault-CLI binary fix + config hygiene

Six PRs closing the medium-severity tail of the security review epic
plus three small standalone fixes surfaced in the 2026-05-24 issue
audit.

### PR A — sec(WS1-F1): chown account-level credentials.json + meta.json to operator UID post-write (#1447) (#1715)

The auth-broker container runs as root in production. After it wrote
account-level OAuth state under `~/.switchroom/accounts/<label>/`,
the artifacts landed root:root and the operator's non-root CLI hit
EACCES on subsequent reads — `switchroom auth list` was unreadable
until a manual chown recovered it. The apply-time
`restoreOperatorOwnership` sweep papered over this on the next
reconcile, but the durable fix is to chown at the write site.

- New `chownAccountFiles(label, uid, home)` helper in
  `src/auth/account-store.ts` — chowns the account dir + creds.json
  + meta.json to (uid, uid). Validates the label first; safe to call
  before any artifact has landed; no-op for missing files; throws on
  EPERM so callers can route through their warn helper.
- New `chownAccountFilesIfRoot(label)` private method on
  `AuthBrokerServer` — no-op when `operatorUid` is undefined (dev
  path), otherwise calls the helper and swallows EPERM via the
  existing one-shot `warnCapChownMissing` pattern used by the
  per-agent mirror chown.
- Wired into both account-level write callsites: `opAddAccount` and
  `runRefreshTick` (after the refresh helper reports `refreshed`).

### PR B — sec(WS3): validate agent slug on broker requests with path-component use (#1448) (#1714)

`mint_grant` previously accepted any non-empty string as the `agent`
field on the wire and joined it directly into a filesystem path:

    const tokenDir = path.join(os.homedir(), ".switchroom", "agents", agent);
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(tokenPath, mintResult.token, { mode: 0o600 });

A peer with broker-IPC access could pass `agent: "../foo"`,
`agent: "/etc/passwd"`, or `agent: "operator"` to escape the agents
tree, write outside the intended directory, or shadow another
identity.

- New shared `AgentNameSchema` Zod validator in
  `src/vault/broker/protocol.ts` — charclass + cap mirror
  `src/host-control/protocol.ts` AgentNameSchema (kebab-case ASCII,
  64-char cap), with a `.refine` that rejects `isReservedAgentName`
  matches (so `operator` and `hostd` are blocked).
- Applied to `MintGrantRequestSchema.agent`,
  `ListGrantsRequestSchema.agent` (optional — validates only when
  set), and `PreflightAccessRequestSchema.agent`.
- Validation runs at `decodeRequest`/`zod.parse`, so the bad request
  is rejected before any `mkdirSync` / `writeFileSync` runs.

### PR C — sec(WS3 follow-up): defend revoke_grant token-unlink against pre-fix stored slugs (#1716)

Wire validation in PR B blocks new poisoned slugs at write time, but
the grants DB can still carry pre-fix rows whose `agent_slug`
predates the validator. The `revoke_grant` handler joins that stored
value into a filesystem path before `unlinkSync` — pre-fix rows
could redirect the unlink outside the agents tree.

- Re-validate `row.agent_slug` against `AgentNameSchema` before
  path-join. Poisoned rows skip the file unlink; the DB-level revoke
  (`revokeGrant`) still runs unconditionally so the capability is
  gone either way.
- JSDoc accuracy fix: example list of reserved names in
  `protocol.ts` now mentions both `operator` and `hostd`.

### PR D — fix(vault): vault set --file preserves binary bytes via kind="binary" (#1090) (#1710)

`switchroom vault set <key> --file <path>` previously called
`readFileSync(path, "utf8")`, which silently replaced non-UTF-8
sequences with U+FFFD (3 bytes: EF BF BD). Binary inputs (tarballs,
sealed archives, raw key material) stored a corrupted form, and
`vault list` only verifies key presence — so the corruption was
invisible.

- Lossless-UTF-8 round-trip detection
  (`Buffer.compare(buf, Buffer.from(buf.toString("utf8"), "utf8")) === 0`)
  chooses between `kind="string"` (text — existing behaviour
  preserved) and `kind="binary"` (base64-encode + stderr hint about
  `base64 -d`).
- New `setBinarySecret` helper as the parallel to `setStringSecret`.
- Format-hint validation is skipped for binary `--file` inputs
  (stored value is base64, not the original bytes; out of scope).

### PR E — chore(config): remove orphaned summarizer_model + DispatchRule.model (#1630) (#1711)

Two config fields left parsed-but-ignored after the `claude -p`
elimination (RFCs #1620 / #1625 / #1626):

- `session_continuity.summarizer_model` — handoff is now a
  deterministic transcript tail (#1626); no summarizer model.
- `webhook_dispatch[].model` (`DispatchRule.model`) — webhook turns
  run in the agent's live session (#1625) and use the agent's own
  model.

Schema is non-strict (only `ReleaseSchema` uses `.strict()`), so
existing configs that still set either field will silently drop the
unknown key instead of rejecting — backwards-compatible.

### PR F — test: unit-cover warnLegacyStateOnce + checkLegacyState (#1375) (#1712)

Pure test addition. Pins the v0.12.x legacy-state deprecation safety
rails (`~/.clerk` dual-read + v0.6 broker-socket detection) so the
v0.13.0 shim-removal PR lands with green coverage. Coverage includes
the dangling-symlink case (lstatSync detection — the case
statSync would miss).

### PR G — style(telegram): capitalise voice exemplars + drop em-dashes from prompt (#1709)

Voice-style polish on the agent's first-person exemplars. No code
behaviour change.

## v0.13.24 — telegram formatting fixes, /update apply gate, agent-config follow-up

### PR A — fix(telegram): preserve parse_mode on pending-progress edits + clear draft on answer-stream stop/retract (#1698, #1704) (#1706)

Two reply-path formatting bugs reported 2026-05-23/24, sharing no
code but the same shape — a terminal edit forgot to honour what an
earlier send established.

- **#1698** — `pending-work-progress.ts` was editing the model's
  anchor message in place every 60s with a "still working (Nm)"
  suffix while async work was in flight, *without* `parse_mode`.
  The anchor was sent through the `reply` MCP tool (default
  `format: 'html'`), so every `<b>` / `<code>` / `<a>` tag in the
  anchor re-rendered as literal text the moment the first tick
  fired. Three user repros all matched: HTML tag near the start of
  a message that had pending async work following it.
  Fix: capture `anchorParseMode` in `noteOutbound`, thread through
  `PendingProgressEditCtx`, reuse on every edit. All three
  production callsites in the gateway (executeReply, silent-anchor
  merge, stream_reply done=true) updated.
- **#1704 part B** — `answer-stream.ts:stop()` and `retract()`
  never called `sendMessageDraft(chatId, draftId, '')` to clear the
  in-progress draft. Only `materialize()` did. So whenever a DM
  turn ended without materialising (the common path when the model
  goes on to call `reply` directly), the draft sat in the user's
  compose box and Telegram Desktop blocked the user from typing
  until the 30s draft expiry.
  Fix: extracted `clearDraftBestEffort()` and called it from all
  three terminal paths (stop fire-and-forget, retract awaited,
  materialize replaces inline copy).
- **#1704 part A** — diagnosed, not changed. The "stdout
  auto-forward" is `turn-flush-safety`, deliberately kept as the
  ghost-reply safety net (see docstring at line 99). Fixing part B
  removes the perceptual half (stuck draft preview) in DMs.

UAT on test-harness with the PR bundle bind-mounted confirmed: the
pending-progress 60s ticks fire `editMessageText` with
`parse_mode=HTML` (wire-log evidence), mtcute reads back the edited
text without literal `<b>` / `<code>` characters, and the 11
regression scenarios (smoke / fast-trivial / fast-ack ×8 / soft-commit
/ rapid-followup) all stayed green.

Closes #1698, #1704 (part B). Side-effects: closes #1120
(non-reproducible — verified via UAT, fixed by intervening commit on
format.ts), #1161 (architecturally addressed by turn-flush-safety +
#1614 + #1664 + #1666 + PR #1706's draft cleanup), #1445 (closed-in-
spirit by #1669 cross-turn pending-progress; this PR fixes a parse_mode
regression in that fix).

### PR B — feat(gateway): split /update apply availability gate by hostd state (#1469, #1470) (#1707)

`/update apply` previously failed-fast when hostd was unreachable,
producing an opaque error. PR splits the availability gate so:

- `host_control.enabled=false` → clean "host-control disabled, run on
  host CLI" error (closes #1469)
- `host_control.enabled=true` but per-agent hostd socket absent →
  prompt operator to install hostd via the existing `/update install
  hostd` flow (closes #1470)

### PR C — fix(agent-config): gate remaining in-agent-unsafe blocks in reconcileAgent (#1705)

Follow-up to #1618 — three additional reconcile blocks needed the
`!isInAgent` gate to avoid double-applying drift fixes that hostd
already owns. No user-visible behaviour change; closes a low-priority
fleet log-noise source.

### Smaller fixes bundled

- **fix(vault)** (#1661) — redirect mis-isolated broker tests away from
  the live vault. Closes a 2026-05-22 incident-class fix; the broker
  tests now provably never touch `~/.switchroom/vault/vault.enc`.
- **test(telegram)** (#1697) — unskip `jtbd-interrupt-marker-dm` after
  the #1689 framework fix.
- **docs(claudemd)** (#1703) — top-level CLAUDE.md audit + restructure
  (~140 lines cut, 3 process gaps closed). Operator-only.

## v0.13.23 — revert v0.13.22's CPU cap (was making rerank 3-10x slower)

### fix(hindsight) — revert CPU cap (#1701)

v0.13.22 shipped `--cpus=2.0` on the hindsight container as a smart-
default, on the theory that bursts of concurrent rerank tasks would
starve the agent fleet on shared hosts.

**Live measurement immediately after deploy showed the opposite.** The
cross-encoder rerank is dominated by per-pair compute, not task-level
contention. Capping CPU at 2 cores forced each rerank to serialize
through 2 cores instead of using the host's free cores, which made
each pass 3-10x slower:

| State | Rerank p50 | Rerank under burst |
|---|---|---|
| Pre-v0.13.22 (uncapped) | ~4.9s | ~14s |
| v0.13.22 (`cpus=2.0`) | 7-20s | 25-42s |
| v0.13.23 (cap removed) | **~2.1s** | TBD |

Fix:
- Remove `HINDSIGHT_DEFAULT_CPUS` constant + the `--cpus` flag
  emission in `startHindsight()` and the compose snippet.
- Restore `HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT` to vendor
  default `4` (v0.13.22 lowered to `2` paired with the CPU cap; with
  CPU uncapped, 4-way is the right knob — allows 4 fleet recalls to
  overlap without thrashing per-pair compute).

Memory cap (`4g`), reservation (`2g`), pids cap (`1000`) all stay —
those defend against runaway memory growth without restricting the
reranker's compute.

The other v0.13.22 smart-defaults (bucket_batching, max_candidates=150,
recall_max_concurrent=8, recall.py 8s timeout, drop cache TTL,
recallMaxMemories=8, recallMinOverlap=0.10) keep behaving as designed.
Only the CPU cap was wrong-headed.

## v0.13.22 — hindsight smart-defaults (recall p50 5.6s → ~2-2.5s)

Forensic-audit-driven release. The 2026-05-24 audit measured hindsight
recall p50 5.6s / p95 14.5s, with 17-26% of turns on heavy agents
breaching the 12s UserPromptSubmit hook ceiling. Root cause: switchroom
was passing vendor defaults sized for dedicated-host installs, not the
actual workload (CPU-only, 9 always-on agents, shared 16-core host).

### feat(hindsight) — smart-defaults for recall/rerank latency + container caps (#1699)

Five changes ship the optimised-out-of-box config. All operator-
overridable; smart-default philosophy is "simple, reliable, fast by
default; opt-in complexity available".

**Reranker env vars** (in `src/setup/hindsight.ts` `docker run` args
AND the generated compose snippet):
- `HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING=true` (was `false`)
  Vendor's own comment: "36-54% speedup, quality-identical by
  construction". Sorts candidate pairs by length to avoid padding
  waste.
- `HINDSIGHT_API_RERANKER_MAX_CANDIDATES=150` (was `300`)
  Final cap is 12 anyway; scoring 300 wastes ~50% of rerank CPU.
- `HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT=2` (was `4`)
  With 9 always-on agents, 4-way oversubscription on a 16-core box
  thrashes. 2 leaves headroom for burst.
- `HINDSIGHT_API_RECALL_MAX_CONCURRENT=8` (was `32`)
  Sized for shared-host co-tenancy with the agent fleet.

**Container resource caps** (`docker run` + compose):
- `--memory=4g` (live RSS 3.4 GiB)
- `--memory-reservation=2g`
- `--cpus=2.0`
- `--pids-limit=1000`

Prevents reranker bursts from starving the fleet on shared hosts.

**`vendor/hindsight-memory/scripts/recall.py` HTTP timeout** `10s → 8s`.
Reclaims 4s headroom inside the 12s UserPromptSubmit hook ceiling so a
slow recall fails cleanly with empty memories instead of blowing past
the hook timeout and dropping the recall entirely.

**Dropped the unconditional `HINDSIGHT_RECALL_CACHE_TTL_SECS=600`**
default export in `profiles/_base/start.sh.hbs`. Audit measured 0%
hit rate across 430+ Telegram turns: the cache key is `(session_id,
prompt, bank, extra_banks)` and Telegram inbounds are always unique
prompts. Operators who run Claude Code interactively (where prompt-
repeat exists) can still opt in via `memory.recall.cache_ttl_secs`
in switchroom.yaml.

**Scaffold settings overrides** (`applyHindsightSettingsOverrides`):
- `recallMaxMemories` 12 → 8 (tighter prompt; recall@N quality
  unchanged in audit sample)
- `recallMinOverlap` 0.0 → 0.10 (turn on the Jaccard-overlap gate
  #475 that was wired but disabled)

### Expected impact

- Recall p50: 5.6s → ~2-2.5s
- Recall p95: 14.5s → ~6-7s
- UserPromptSubmit hook timeout breach rate: 17-26% → <5%
- TTFO improvement on every Telegram turn fleet-wide

## v0.13.21 — wedge cleanup + dedup turnKey + interrupt fix + scrub coverage + doc flip

Forensic-audit-driven release. Seven PRs addressing prod issues
surfaced by the 2026-05-23/05-24 fleet audit.

### fix(telegram) — wedge fallback late-fire skip + disconnect dangling-turn sweep (#1685)

- `gateway.ts onFrameworkFallback` short-circuits when the turn ended
  cleanly during the silence window. Removes ~90% of misleading
  "ended wedged turn" log noise + the spurious user "still working…"
  ping racing the real reply.
- `disconnect-flush.ts` unconditionally sweeps any `activeTurnStartedAt`
  keys the controller loop missed (bridge crashed AFTER setDone
  cleared `activeStatusReactions` but BEFORE
  `activeTurnStartedAt.delete`). Closes the real ~14-events/3-days
  wedge documented in `feedback_5min_restart_wedge_violates_vision`.
- New `onDanglingTurnsSwept` callback lets the gateway null
  `currentTurn` for the same reason.

### fix(telegram) — outbound dedup keyed by turnKey (#1686)

User asks two similar questions within 60s ⇒ second turn's reply
hash collided with the first's ⇒ dedup fired ⇒ user got no
response. The original 60s TTL was sized for the within-turn #546
retry race; per-chat key had no turn awareness.

Added optional 5th `turnKey` arg to `record()` + `check()`. When
both sides have non-null distinct turnKeys, treat as miss. Either-
null falls back to legacy match — preserves #546 within-turn
protection and boot-time / silent-marker callers unchanged. Threaded
`currentTurn?.registryKey ?? null` through all 9 gateway callsites.

### fix(telegram) — subagent-watcher deregisters on ENOENT/EACCES (#1687)

`readSubTail` was emitting one log line per second per stranded
JSONL — clerk grew 540k+ ENOENT errors in 3 days (~30/sec sustained)
from polling files Claude Code had reaped along with the parent
session's `subagents/` dir. Each stranded entry also leaked an
`fs.watch` FD.

Fix: detect `err.code === 'ENOENT' | 'EACCES'`, log ONCE, invoke
new optional `onFileVanished` callback wired to
`cleanupTerminalAgent` (closes FSWatcher, drops registry entry,
records in `terminatedAgentIds` so rescans don't re-register).

### fix(telegram) — em-dash handoff-line template (#1688)

PR #1683 voice scrub runs BEFORE the framework's `takeHandoffPrefix`
concatenation in `executeReply`. The literal em-dash in the
"↩️ Picked up where we left off — " template bypassed scrub
entirely — 16 of 17 dashed messages on test-harness post-v0.13.20
were this prefix. Replaced at the template source with a comma.

### fix(telegram) — `!` interrupt body bypasses the buffer gate (#1689)

User-facing bug: `!`-prefix interrupt SIGINTs the in-flight turn,
but the killed turn does NOT reliably emit `turn_complete`. Without
that event, the post-`!` body sits in `pendingInboundBuffer`
forever. User fires `! actually do X` ⇒ agent never replies.

Live UAT (`jtbd-interrupt-marker-dm`, `describe.skip`'d since
#1132) reproduces this on test-harness with a 60s timeout. Fix: add
`isInterrupt: boolean` to `InboundDeliveryGateInput` as a peer of
`isSteering` (both are intentional mid-turn delivery cases). Thread
`interrupt.isInterrupt` through to the gate call.

### fix(telegram) — voice scrub wired into stream_reply + turn_flush (#1690)

PR #1683 wired scrub into `executeReply` + `executeEditMessage`
only. Modern Claude on the fleet uses the answer-stream /
draft-stream path for multi-paragraph replies — emits via
`stream_reply done=true` or via the turn-flush `capturedText` path,
both bypassing the scrub.

Wired scrub into both new sites with new `site:'stream_reply'` and
`site:'turn_flush'` runtime metric variants.

### docs(telegram) — steering contract flip in docs + UAT (#1691)

The steering default was flipped 2026-04-17 (commits `4fff90bf` +
`597a58af`) — unprefixed mid-turn follow-ups are QUEUED; steering
is opt-in via `/steer` or `/s`. Three docs lagged the code change
for 5 weeks: the model prompt
(`profiles/_shared/telegram-style.md.hbs`), the JTBD doc
(`reference/steer-or-queue-mid-flight.md`), and the
`jtbd-rapid-followup-dm` UAT (was `describe.skip`'d with too-loose
`/md5/i` assertion). All three flipped to match the live contract.

## v0.13.20 — em-dash scrubber (framework-side voice enforcement)

### feat(telegram) — em-dash voice scrubber (#1683)

Sampled 2,867 recent fleet outbound replies on 2026-05-23 and
found em-dashes in 73% of messages despite three landed soft-layer
fixes (SOUL.md.hbs never-em-dash rule, PR #1177 voice
consolidation, /humanizer skill). Soft layer was not winning.

This ships the hard layer: `telegram-plugin/text-voice-scrub.ts`,
a pure predicate that rewrites em / en dashes to commas / periods
based on the neighbour character, with format-aware protection
for fenced code blocks, inline code, `<code>` / `<pre>` HTML, and
URLs. Same architectural pattern as the over-ping safety net
(#1674) and silent-reply auto-edit (#1677): pure module, gateway
wire-in, runtime metric.

Wired into `executeReply` and `executeEditMessage` (the two MCP
entry points). Silent-anchor edits and progress updates inherit
the scrub transitively via the same `text` variable. Kill switch
`SWITCHROOM_DISABLE_VOICE_SCRUB=1` returns identity.

Phrase denylist (`smoking gun`, `load-bearing`, `by design`, etc.)
was scoped OUT: fleet incidence is 0.2-0.5%, and substituting
risks semantic loss the mechanical dash-rewrite does not.

## v0.13.19 — over-ping × silent-anchor: demoted finals no longer buried

### fix(telegram) — over-ping-suppressed finals bypass silent-anchor merge (#1681)

Closes the load-bearing follow-up from #1679's documented residuals.

**Symptom.** A multi-step turn with both:

- silent updates anchored into one growing bubble (#1677), AND
- a model-intended-pinged final reply that gets demoted to silent
  by the over-ping safety net (#1674, because an earlier reply
  already pinged)

…would *merge the demoted final answer into the silent anchor*.
The user has long since disengaged from the silently-edited
bubble (no ping, no scroll change), so the actual final answer is
buried in it.

**Fix.** Single bypass clause in `decideSilentReplyAnchor`: when
`wasOverPingSuppressed === true`, the reply lands as a fresh
silent bubble (no anchor capture). Discoverability preserved
(user sees a new bubble); ping contract preserved (no second
beep). Model intent ('this is a distinct delivery') honored
visually.

The over-ping safety net's job is to suppress *device pings*; the
silent-anchor's job is to combat *visual spam*. They compose
correctly for most cases; this fix resolves the one case where
they fought.

## v0.13.18 — silent-anchor side-effect parity (data-loss fix)

### fix(telegram) — silent-anchor edit branch runs the chunk-loop side effects (#1679)

Principal-engineer end-to-end review of #1677 found that the
silent-anchor edit branch (added in v0.13.17) early-returns
without running the chunk-loop completion path's side effects.
The load-bearing one — `pendingProgress.noteOutbound` —
synchronises the cross-turn-ambient anchor (`pending-work-progress.ts`)
with the latest outbound text. Skipping it caused **silent
content loss** in turns that have BOTH:

- multiple silent replies the auto-edit accumulates, AND
- async dispatch (`Agent` / `Task` / `Bash` with
  `run_in_background:true`) that activates cross-turn ambient.

Failure mode: cross-turn ambient holds the FIRST silent reply's
text as its anchor view. When the +60s tick fires, it appends
`\n\n— still working (Nm)` to that stale text and edits the
anchor — overwriting the model's accumulated "Step 1...\n\nStep
2..." content with `"on it\n\n— still working (1m)"`. User loses
their silent content.

The fix wires four side effects into the edit-anchor branch (each
mirrors a chunk-loop-completion call):

1. `pendingProgress.noteOutbound` — load-bearing data-loss fix.
2. `recordOutbound` — keeps SQLite `get_recent_messages` complete.
3. `isFinalAnswerReply` → `finalAnswerDelivered = true` — silent-
   end re-prompt now suppressed when accumulated silent content
   qualifies as substantive (per #1664 length-backstop).
4. `outboundDedup.record` — same-content retries within the dedup
   window no-op, matching fresh-send.

## v0.13.17 — silent replies edit one growing message (closes the visual-spam pattern)

### feat(telegram) — consecutive silent replies edit a single anchor in place (#1677)

The operator's original complaint that drove this whole epic was
**visual** spam, not just notification spam: *"I would like more
regular process updates, where it edits a status message in place
vs spamming multiple messages."* The over-ping cap (v0.13.16)
closed the notification half. This release closes the visual half.

Pre-fix multi-step turn: 4 stacked chat bubbles — silent ack +
silent step 1 + silent step 2 + pinged final answer. Even with
only one notification, the user still sees four separate bubbles
stack up, which reads as spam.

Post-fix: consecutive silent `reply` tool calls in the same turn
EDIT a single anchor message instead of fresh-sending. Net visual
for a multi-step turn = 2 bubbles total — one silent growing
preamble (all the silent updates accumulated with paragraph-break
separators) + one pinged final answer bubble.

- Pure `decideSilentReplyAnchor` predicate (`telegram-plugin/silent-reply-anchor.ts`) with an 11-test unit suite.
- Gateway wiring: edit-anchor branch BEFORE the chunk loop (single-chunk happy path); anchor capture AFTER successful single-chunk silent fresh send.
- Edit failures (rate-limit, message-deleted, parse errors) fall through to fresh-send — the next silent reply re-anchors cleanly.
- Default ON. Kill switch `SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT=1` reverts to per-reply fresh-send.

Bypasses (anchor not engaged, fresh-send per existing semantics):
pinged replies, files attached, inline_keyboard set, empty body,
merged-text overflowing the 4000-char cap.

### test(telegram) — unit coverage + runtime-metric for the over-ping safety net (#1676)

Non-blocking follow-ups from the #1674 review pass: extracted the
over-ping decision to a pure `decideOverPing` predicate with a
6-test unit suite, and added an `over_ping_suppressed`
runtime-metric for fleet-wide observability of how often the
safety net engages. Pure refactor + additive metric — no
behaviour change in the safety net itself.

## v0.13.16 — one ping per turn (framework safety net for beat-5 contract violations)

### fix(telegram) — cap device pings at 1 per turn (#1674)

`reference/conversational-pacing.md` beat 5 is explicit: *"Deliver
the answer as a fresh `reply` (omit `disable_notification` — pings
the device once)."* — EXACTLY ONE ping per turn.

Live UAT against test-harness on 2026-05-23 reproduced a real
spam pattern: the model sometimes sends two `disable_notification:
false` replies in one turn (substantive answer pinged + a wrap-up
"Delivered all three steps with a wrap-up summary" or meta-narration
like "Sent." ALSO pinged). Two device beeps for what should be one.

This release adds a framework safety net: once the first
`disable_notification: false` reply lands in a turn, subsequent
pinged replies auto-downgrade to silent (`disable_notification:
true`), with a clear `telegram gateway: reply over-ping safety net`
log line for operator visibility. Model intent ("I want this loud")
is honoured for the FIRST ping; subsequent pings are demoted. No
content is dropped — only the notification flag flips.

Aligned to the principle that the framework owns the BEAT
(cadence + count) while the model owns the WORDS. Reviewer
verified scope and design: this is a safety net, not framework
overreach — the model still authors every reply; the framework
only enforces the contract's "EXACTLY ONE" count.

Behaviour change is on by default — no env flag. Zero changes to
single-ping turns (the common case); only the spam pattern is
caught.

## v0.13.15 — visible answer-stream (TTFO under 5s for the common case, flag-gated)

### feat(telegram) — model's transcript text auto-renders live in the chat (#1672, narrow scope of #869 Phase 1)

The existing answer-lane (`answer-stream.ts`) already reads the
model's session-stream `text` events and edits a draft in place —
but it writes to Telegram's invisible compose-box draft, so the user
never sees the stream. The canonical user-facing answer is supposed
to be a `reply` tool call, with `final-answer-detect.ts` + #1664
re-prompt as the safety net for transcript-only turns. Forensic
data: TTFO median 69 s on the busiest fleet agent — for what the
distribution shows is mostly <1–3 min workflows, that's a full
minute of zero words for a 20-second exchange.

Adds env flag `SWITCHROOM_VISIBLE_ANSWER_STREAM=1` (default OFF —
opt-in per agent). When ON:

- `createAnswerStream` is instantiated WITHOUT `sendMessageDraft`,
  falling back to `sendMessage`/`editMessageText` against a real
  chat-timeline message. `minInitialChars` drops 50 → 1 so the
  first text chunk pushes a visible message immediately.
- At `turn_end`, when the model never called reply/stream_reply
  AND captured text is substantive AND the stream actually sent a
  message, the gateway does NOT retract (deleting the message
  the user has been reading live). Instead it freezes the stream
  as final, records the outbound in dedup + history, marks
  `turn.finalAnswerDelivered=true` so the #1664 silent-end
  re-prompt does not fire, and suppresses the turn-flush IIFE
  (its job is structurally already done).
- The reply-tool path is unchanged — when the model uses `reply`
  the prior streamed message is retracted and the reply takes
  over as before.

Trade-off: a stream-as-final-answer turn does NOT push a device
notification (Telegram does not notify on edits; we choose not to
send a duplicate fresh message for the ping). For short turns
where the user is watching, this is the right shape; the
cross-turn pending-progress system (v0.13.14) covers long waits.

Default OFF means zero behaviour change on agents without the env
var. Canary plan: flip the flag on `test-harness`, validate via the
new UAT scenario (`visible-answer-stream-dm.test.ts`), then opt
production agents in.

Honest scope: this is the high-impact slice of #869 Phase 1, not
the full architectural rewrite. Within-turn ambient (Phase 2),
silence-poke retirement (Phase 3), and the full `ChannelRenderer`
generalization (Phase 4) remain follow-ups — each gated on the
prior shipping cleanly.

## v0.13.14 — cross-turn pending-async progress (no more dead-air during background work)

### feat(telegram) — ambient `still working (Nm)` while async work runs across turn boundaries (#1669, closes #1445)

The dominant "agent went silent for 30+ minutes" pain — the user
dispatches background work (sub-agent worker, async `Agent` / `Task`,
`Bash` with `run_in_background:true`), the model sends one ack reply
that pings, the turn ends, and then nothing reaches the user until
the worker returns. Forensic data: silence-poke success rate is **0–7%**
across hundreds of fires (the polite levels need the model to be
mid tool-cycle to even land), and the 300 s framework fallback is a
destructive turn-killer, not a UX update.

The fix is additive and out-of-band: a new `pending-work-progress.ts`
state machine watches for `tool_use(Agent|Task|Bash+run_in_background)`
in the current turn, captures the model's last `reply` / `stream_reply`
as an anchor, and at turn-end (with pending work) edits that single
message in place every ~60 s with a `\n\n— still working (Nm)`
suffix. Edits are silent (no notification spam), capped at 30 min,
and clear the moment the user re-engages, a `subagent_handback`
channel turn lands, or any other fresh turn starts.

- Kill switch: `SWITCHROOM_DISABLE_PENDING_PROGRESS=1`.
- Coverage: both `reply` and `stream_reply` anchor capture; clear
  hooks at `handleInbound` (real user inbound, fast path) AND
  `handleSessionEvent.enqueue` (backstop for synthesised wakes that
  bypass `handleInbound` — handback, cron, vault grant, restart).
- Three new runtime-metric kinds (`pending_progress_started` /
  `edited` / `cleared`) for observability.
- 14-test unit suite + a UAT regression scenario
  (`cross-turn-pending-progress-dm.test.ts`) that pins in-place edits
  with the suffix, silent-flag, and single-anchor invariants during a
  350 s background bash.

Honest scope caveat: this is a pragmatic stopgap, not the principled
endpoint. The within-turn silence-poke ladder (0–7% success) and the
300 s framework-fallback's destructive turn-kill are unchanged in
this release. The architectural fix — model emits typed events,
framework owns delivery (#869) — remains the long-term shape.

## v0.13.13 — create Workspace files; streamed answers stop vanishing

### fix(auth) — mint Slides/Docs/Sheets OAuth scopes so agents can edit Workspace files (#1663)

Agents could read Drive and create plain Drive files but could not
create or edit native Google **Slides / Docs / Sheets** — the
auth-broker token only carried Drive scopes. Any Docs/Sheets/Slides API
call 403'd, and the upstream Google Workspace MCP then fell back to its
own browser OAuth on port 8000 (unrecoverable inside a container).

- `switchroom auth google account add` now mints the Workspace API
  scopes (`documents`, `spreadsheets`, and — at `extended`/`complete` —
  `presentations`) alongside the Drive scopes. The scope set is **tied
  to `google_workspace.tier`** so every tool a tier exposes can
  authenticate. Calendar/Forms/Tasks/Chat/Gmail scopes are deliberately
  out of scope (separate decision).
- The `gdrive` MCP launcher runs a scope↔tier preflight at startup: a
  token missing scopes the tier needs produces a loud, actionable
  stderr warning naming the exact `account add --replace` recovery
  command — instead of upstream's silent doomed port-8000 fallback.
- The launcher also moves the upstream MCP's OAuth callback port off
  8000 (`SWITCHROOM_GDRIVE_MCP_PORT`, default `8631`) so the fallback,
  if ever triggered, no longer collides with whatever the host runs on
  8000.
- Changing the tier requires re-running `account add --replace` — OAuth
  scopes are fixed at consent time. Documented in
  `docs/google-workspace.md`.

### fix(pacing) — streamed answers no longer vanish from the chat (#1664)

An agent often ends a turn with its real answer as plain assistant
transcript text instead of a `reply` tool call. The gateway rendered
that transcript as a live Telegram draft and then **deleted it at
turn-end** — the user watched the answer stream in, then it vanished,
and it never reached history either.

The framework can't classify transcript-after-a-`reply` (sometimes the
real answer, sometimes a redundant wrap-up — only the model knows), so
per `reference/principles.md` ("the model communicates; the framework
is the safety net") the fix re-prompts the model rather than faking the
message. It extends the silent-end safety net: each turn tracks whether
a real **final-answer beat** landed — a notification-bearing `reply`, a
≥200-char reply, a `stream_reply` with `done=true`, or a legitimate
turn-flush. If a turn ends without one, the Stop hook blocks turn-end
and re-prompts the agent to send its answer via `reply` (or `NO_REPLY`
if it already did). No duplicate, no data loss; complements the #1657
turn-flush fix without weakening it.

## v0.13.12 — quieter turns: no duplicate wrap-up, no card-era worker pings

Three production message-noise fixes plus the agent-image Playwright
binding. All observed live on agent "finn" (2026-05-22): every turn
ended with a redundant recap, a stale "Worker done" ghost fired
mid-build, and `webapp-testing` was broken on every agent.

### fix(pacing) — stop posting the model's turn wrap-up as a duplicate (#1657)

Every turn that called `reply` was followed by a second, redundant
Telegram message — a third-person recap of the turn ("Answered the X
question and acked Y…"). The model wasn't sending it: the gateway's
turn-flush safety net was scraping the model's trailing terminal text
and posting it.

Root cause was the #1291 post-reply-tail flush — `decideTurnFlush`
flushed any assistant text emitted after the last `reply` (≥40 chars)
as a follow-up. The intent was to catch a soft-commit reply followed by
the real answer in terminal text only, but the post-reply tail is
almost never a forgotten answer — it's the model's habitual end-of-turn
summary, indistinguishable from a real answer by length, so it misfired
on essentially every turn.

The contract is now deterministic: **a message reaches the user iff the
model called `reply`/`stream_reply`.** Once `replyCalled` is true,
`decideTurnFlush` always skips — trailing terminal text is the model's
wrap-up, never a second bubble. The genuine ghost-reply backstop (a
turn that ended with zero outbound) is unchanged. Aligns with
`reference/conversational-pacing.md` v2 — "the framework owns the beat;
the model authors the words".

### fix(telegram) — stop subagent-watcher posting card-era "✓ Worker done" (#1659)

The subagent-watcher's `sendNotification` callback still posted a
framework-authored `✓ Worker done: sub-agent (N tools) — …` message
straight to chat — wiring left over from the retired progress card
(#1122). It fired from the silent-stall heuristic, so a worker mid-
`Bash` (a build, a deploy) was declared "done" ~6 min early, surfacing
a stale ghost of an already-answered task. Removed the callback
entirely; sub-agent completion is surfaced through the structured
`onFinish` cue the #1650 handback path already consumes — the model
authors the user-facing handback in its own voice.

### fix(docker) — provision the Python Playwright binding in the agent image (#1658)

The bundled `webapp-testing` skill ships enabled on every agent and is
Python-only, but the agent image baked only the JS Playwright binding —
`import playwright` failed with `ModuleNotFoundError` on every agent.
The image now bakes the Python binding too, pinned via a single
`ARG PLAYWRIGHT_VERSION` (1.60.0) so the JS and Python bindings share
one chromium revision and cannot drift. Lands on the agent-image
rebuild + fleet rollout.

### docs — Vault & shared-state test discipline (HARD RULES) (#1660)

Adds a HARD-RULES section to CLAUDE.md after a mis-isolated vault/broker
test truncated the live operator vault on 2026-05-22. Vault / broker /
audit-log tests MUST use an isolated tmpdir; the dangerous default
paths are now named explicitly.

## v0.13.11 — a transient overload is not quota exhaustion

### fix(auth) — honest escalation for transient overloads (#1655)

Agents were showing a false "⚠️ Model unavailable — quota exhausted /
Auto-failover in progress" card, then "Auto-fallback skipped: …probed
healthy. Stale event?" — looping on every transient Anthropic HTTP 529.
The accounts were never exhausted; the fleet auto-fallback correctly
declined. The bug was a mislabel: a 529 `overloaded_error` (server
capacity; retryable; Claude Code retries it internally) was classified
`quota-exhausted`.

- `overloaded_error` / HTTP 529 → `rate-limited`, not `quota-exhausted`.
- Fleet auto-fallback now triggers only on a genuine `quota_exhausted`,
  never `overload` — failing over does nothing when every account is
  equally hit by server load.
- A transient overload Claude is still retrying posts **no operator
  card** — `session-tail` reads Claude Code's `retryAttempt`/`maxRetries`
  annotations and escalates only terminal failures. The calm
  `rate-limited` card replaces the scary "Model unavailable" one for
  transients. Genuine usage-limit detection (the `isApiErrorMessage`
  429 shape) is unchanged and still triggers auto-fallback.

### test(pacing) — cover the sub-agent handback decision gate (#1654)

The gateway `onFinish` handback gate (which injects a turn) was
extracted into a pure `decideSubagentHandback` with 12 unit tests —
closing the regression-coverage gap on the feature's riskiest surface.

## v0.13.10 — sub-agent handback + hostd config-edit + fleet defaults

### feat(pacing) — deterministic sub-agent handback, beat 4 (#1650)

Conversational-pacing beat 4 — the handback — now has a deterministic
mechanism. A *background* sub-agent (the default worker/researcher)
finishes decoupled from any turn boundary, with the parent idle and no
turn to receive the result — so the user never heard back until they
sent the next message themselves. The gateway's subagent-watcher
`onFinish` now builds a `subagent_handback` inbound carrying the
worker's result and delivers it through the idle-drain path; the agent
wakes and synthesises a user-facing handback in its own voice. A
foreground PostToolUse nudge covers in-turn sub-agents. Framework
delivers the cue; the model authors the words. Kill-switch:
`SWITCHROOM_SUBAGENT_HANDBACK=0`.

### feat(hostd) — config_propose_edit apply path (#1651)

hostd can apply an approved config edit: approval card → atomic
tmp→rename write → reconcile, with atomic rollback on reconcile
failure. No write lands without an explicit operator approve.

### feat(defaults) — bake pandoc/ffmpeg/imagemagick + expand skills (#1652)

The base image now ships `pandoc`, `ffmpeg`, `imagemagick`. The
example config's `defaults.skills` expands to include docx, pdf, pptx,
xlsx, webapp-testing, mcp-builder, skill-creator, file-bug.

### fix(agent-config) — skip profile re-render in cron-only reconcile (#1619)

A cron-only reconcile inside an agent container no longer attempts to
re-render profile `.hbs` templates (absent from the container bundle),
which previously threw `ENOENT`.

### fix(gateway) — stop logging anonymous IPC disconnects as flaps (#1649)

Anonymous one-shot IPC clients (recall.py's `update_placeholder`
handshake) no longer log as `bridge disconnected — agent=null`, which
read as a bridge flap in the supervisor log when nothing flapped.

## v0.13.9 — pacing v2.1: the ack gate is answer length, not tool use

### fix(pacing) — acknowledge first on long replies, not just tool turns

v0.13.8 shipped the five-beat pacing model but the verbal-ack beat
still mostly did not fire. A fuzzy UAT against test-harness (8 prompt
shapes) measured **1/8** turns producing a genuine opening
acknowledgement.

Root cause: every pacing surface gated the ack on *"any turn that
needs real work — a file read, a search, a command"*. Half of real
prompts ("compare X and Y", "summarise this in plain language") need
**no** tool call — they are pure reasoning — so the model correctly
read the contract and skipped the ack, then went silent for 10–17s
while composing a multi-paragraph answer.

The gate is now **answer length, not tool use**: unless the whole
reply is a single short sentence to send immediately, acknowledge
first — *even when no tool call is involved*. Fixed in lockstep
across `turnPacingDirective` (the per-turn UserPromptSubmit hook),
`telegram-style.md.hbs`, `scaffold.ts`'s append-prompt, and
`reference/conversational-pacing.md`.

Re-running the same UAT: **8/8** pass the 20s contract, **5/8**
genuine opening acks + 2 legitimate fast-answer skips (replies that
landed in 1.7s / 4.5s — too fast to need an ack).

## v0.13.8 — conversational pacing v2: the five-beat human-feel model

### feat(pacing) — re-found conversational pacing (#1645, #1646)

Messaging a switchroom agent now follows five beats — **acknowledge
first**, then go quiet and work, **surface meaningful progress** in
human prose, **hand back delegations with synthesis**, deliver.

The verbal acknowledgement failed across v0.13.5–v0.13.7. A broad
pipeline trace found it was never the wording: the ack instruction was
buried in a 32KB prompt **and actively contradicted** by card-era
guidance — *"don't fill silence", "the reaction signals alive",
"silence is valid", "don't narrate, the card shows it"* — left over
from the pinned progress card retired in #1122. With no card, that
guidance is just a black box, and it out-voted the lone ack bullet.

v2 fixes both halves:
- **#1645** re-founds the contract (`conversational-pacing.md`), the
  prompt (`telegram-style.md.hbs`), and the high-salience append-prompt
  (`scaffold.ts`) on the five beats, and removes every card-era
  contradiction. The guardrail flips from pro-silence to anti-spam.
- **#1646** injects the pacing directive **per-turn** via a
  UserPromptSubmit hook, so "acknowledge first" is salient adjacent to
  the user's message — not a buried sub-bullet the model must recall.

### docker — agent /tmp tmpfs raised 256MB → 1GB, noexec kept (#1644)

## v0.13.7 — auto-failover detects the new Claude usage-limit shape

### fix(auth) — quota-exhaustion detection for Claude v2.1.x (#1642)

Account auto-failover was dead fleet-wide: an agent that hit its Claude
subscription quota surfaced *"You've hit your limit · resets …"* and
stopped — never rotating to a healthy account, even with others
available in `fallback_order`. Claude Code v2.1.x records a usage-limit
hit as a *synthetic assistant message* (`isApiErrorMessage: true`,
`apiErrorStatus: 429`), not the `api_error` line shape the detector
recognised — so the exhaustion signal never reached the fleet
auto-fallback path and `fireFleetAutoFallback` was never called. The
detector now catches the new shape and classifies a 429 in it as
quota-exhausted; the model-unavailable text signals learn the new
"hit your limit" wording. Regression tests are pinned to the exact
on-disk line shape so the next Claude format drift fails loud.

## v0.13.6 — a typing indicator for the whole turn

Headline: the agent now shows `typing…` for the *entire* turn, not
just the split-second a reply is transmitted. Messaging an agent now
feels like messaging a person — you see them composing the whole
time.

### feat(telegram) — continuous typing indicator (#1638)

The Telegram `typing…` indicator was fired as one-shot ~5s pings at
turn start — so any turn that read a file or thought for a moment
went dark after 5 seconds, and the chat felt like a black box until
the answer dropped. It now holds a continuous `typing…` chat-action
from turn-start to turn-end, self-renewing every 4s, on a dedicated
interval map that the reply handler's and tool-wrapper's stop calls
cannot clobber. Deterministic, framework-owned, no prose — the
mechanical ambient layer of the conversational-pacing contract.

The "Open with an acknowledgement" prompt rule is also tightened from
a fuzzy "skip if the answer lands in a second or two" (which the
model misjudged) to a bright line: any tool call needed → acknowledge
first; skip only for a question answerable immediately from memory.

### hostd — config_propose_edit skeleton (#1637)

Flag-gated schema + dispatcher stub for approval-gated agent-config
edits. No behaviour change (flag off).

## v0.13.5 — human-feel pacing: a guaranteed fast acknowledgement

Headline: an agent now opens every turn with a fast verbal
acknowledgement. A person you message answers in a beat — *"got it"*,
*"on it, checking now"* — before the work is done. Until now an agent
could sit silent for the whole opening stretch of a turn while it read
files and thought; the first safety-net poke did not fire until 75s.

### feat(telegram) — guarantee a fast verbal ack (#1633)

Split across the two layers the design contract demands. The
conversational-pacing prompt teaches the model to open with a short
human one-liner unless the answer itself lands in a second or two. The
silence-poke subsystem *enforces* it: a new `ack`-budget poke fires at
~10s when nothing at all has been sent this turn, nudging the model to
acknowledge before it does more work. The poke is one-shot and sits
outside the soft/firm/fallback ladder — a turn that still never acks
escalates exactly as before. The framework owns the *beat*; the model
authors every word.

### fix(vault) — sub-agent inaccessible-service reports as a missing grant (#1632)

A sub-agent reporting a service it cannot reach is now treated as a
missing vault grant, routing it through the grant-request flow rather
than surfacing an opaque error.

### test(uat) — fuzzy ack-pacing validation (#1634)

`jtbd-fast-ack-dm` drives eight varied non-trivial prompt shapes and
asserts the user sees a sign of life fast on every one — the
regression gate for the guaranteed-ack behaviour.
`reference/conversational-pacing.md` documents the new 10s ack rung.

### docs — vision + README re-anchored on the standing-team thesis (#1629, #1631)

`reference/vision.md` and the top-level `README.md` are re-anchored:
switchroom is a standing team of always-on specialist assistants that
know you and act while you get on with life — not a tool-call
transparency layer for developers.

## v0.13.4 — zero `claude -p` (subscription-honest under the 2026-06-15 policy)

Headline: switchroom no longer spawns `claude -p` anywhere. Every model
call is the interactive `claude` session.

On **2026-06-15** Anthropic reclassifies `claude -p` and the Agent SDK
as *programmatic* usage — billed to a separate credit, off the
subscription. switchroom's core pillar is subscription-honest (run the
unmodified `claude` CLI on the Pro/Max subscription), so RFC #1620
removed the two remaining `claude -p` callsites.

### feat(webhook) — deliver via `inject_inbound`, not `claude -p` (#1625)

`webhook-dispatch` now synthesizes an `InboundMessage` and injects it
into the agent's live gateway — the same path cron uses — instead of
spawning a headless `claude -p`. The webhook turn runs in the agent's
interactive session. Also closes #1617 (the `claude -p` spawned a
parasitic second telegram bridge).

### feat(handoff) — transcript-tail handoff, not `claude -p` (#1626)

The session-handoff briefing was an LLM summary produced by a
per-turn headless `claude -p`. It is now a pure, deterministic
**transcript tail** — a bounded raw excerpt of the prior session that
the next interactive session reads to reorient. No model call, no
`claude -p`. (The per-turn `claude -p` was also the root cause of the
v0.13.3 bridge flap.)

### test(bridge-flap) — regression guards (#1622)

A CI guard fails the build if any source file spawns a headless
`claude` without `--strict-mcp-config`; a behavioural UAT scenario
catches a reintroduced flap by symptom. The codebase now has zero
headless-`claude` spawners and the guard keeps it that way.

### docs

- RFC #1620 (eliminate `claude -p`); the Claude-native /
  subscription-funded constraint codified in `reference/vision.md`
  pillar 3 + `CLAUDE.md` (#1624); the `keep-my-subscription-honest`
  and `track-plan-quota-live` JTBDs refreshed for the 2026-06-15
  policy (#1627); RFC for approval-gated admin-agent config edits
  (#1623).

## v0.13.3 — bridge-flap fix + silent-turn fallback

Headline: the recurring **bridge-flap** wedge class (#1613) is
root-caused and fixed.

### fix(handoff) — `--strict-mcp-config` stops a parasitic 2nd bridge (#1616)

The handoff-briefing summarizer shells out to a headless `claude -p`
once per turn (handoff Stop hook). It ran without
`--strict-mcp-config`, so it auto-discovered the agent's project
`.mcp.json` and started every MCP server in it — including
`switchroom-telegram`. That spun up a *second* telegram bridge
process which registered against the same gateway socket as the live
agent's real bridge; the two collided under the gateway's
register-race close, producing the ~2s `bridge reconnect race`
ping-pong for the ~7-9s the `claude -p` lived. The handoff hook fires
every turn, so did the flap.

Root-caused by process-ancestry instrumentation — every flapping
bridge traced to `claude -p … → run-hook.sh hook:handoff`, never to
Claude Code's channel layer. Fix: pass `--strict-mcp-config` (the
summarizer is pure transcript-in / briefing-out and needs no MCP
tools). Canary on test-harness: parasitic bridges 4-5/burst → 0,
`bridge reconnect race` → 0, 6/6 turns delivered.

### fix(telegram) — fallback when a silent turn exhausts its re-prompt (#1614)

A turn that ends silently and exhausts its re-prompt budget now
delivers a fallback message instead of leaving the user with no
reply.

### Also in this release

- docs(rfc): bridge-presence design note (#1615); webhook ingest via
  the agent gateway socket (#1612).
- chore(cleanup): scrub post-docker systemd ghosts, retire buildkite
  skills (#1611).

## v0.13.2 — revert PR 3b steps 1-5 (canary regression)

The v0.13.1 canary on test-harness surfaced a regression: the
canonical shadow `turnEnd` event no longer fires on the dominant
happy-path turn-end. The audit's premise — that
`endCurrentTurnAtomic(turn)` at gateway.ts:~6444 would emit the
single authoritative event after the bare-purge deletions — turned
out to be empirically wrong for the trivial-reply path. The
v0.13.0 trace shows one `turnEnd outbound=false` per trivial UAT;
the v0.13.1 trace shows zero.

No user-visible impact (no fleet rolled to v0.13.1; test-harness
rolled back to v0.13.0 within minutes of the canary). The shadow
trace correctness fixes that PR 3b was meant to deliver are
strictly worse off — fewer correct emits, not more.

Reverts the gateway.ts changes from PRs #1604, #1605, #1606,
#1607, #1608. The #1603 RFC addendum remains in place as
documentation; it accurately describes the audit's findings, only
the implementation order needs revisiting (per-step empirical
bisection required, not pure code-review).

v0.13.2 = v0.13.0 + the #1602 sends-counter fix (already shipped
in v0.13.1) + no other changes to gateway.ts.

The audit work (the per-callsite mapping) remains valuable. The
re-implementation will:
- Bisect each step on test-harness before committing.
- Assert the trivial-UAT shadow `turnEnd` count BEFORE AND AFTER
  each individual change.
- Treat any drop in emit count as a blocker, not progress.

## v0.13.1 — sends counter fix + shadow `turnEnd` correctness audit (PR 3b)

Two themes:

1. **Draft-stream `sends` counter** — finishes the v0.13.0 canary
   follow-up by including BOTH bare `send()` callsites in the
   counter, so `gw-trace stream-end sends=N` matches reality.

2. **Shadow `turnEnd` correctness — PR 3b steps 1-5.** Per-callsite
   audit of `purgeReactionTracking` (the canonical turn-end signal)
   landed as an RFC addendum (#1603), then five surgical fixes
   removed duplicate-emits / premature-emits / wrong-signal-emits
   from the seven bare-purge callsites in `gateway.ts`. The shadow
   trace's `turnEnd` event now emits exactly once per logical turn
   from an authoritative source. Unblocks the shadow→live cutover.

### PR — draft-stream `sends` counter (#1602)

The v0.13.0 canary surfaced this: draft-transport streams' `gw-trace
stream-end` showed `sends=0` even though `sendMessage` had fired in
`finalize()` to materialize the draft into a real persisted message
(visible in `tg-post method=sendMessage` lines). Counter
under-reporting only — no behaviour bug — but confusing for
observability + downstream metrics.

Fix: bump `sendFires++` at BOTH bare `send()` callsites that
bypass the `sendViaMessage` helper that owns the increment:

1. **Finalize-materialize** (`draft-stream.ts:679`) — the
   `send(textToMaterialize)` call inside `finalize()` that promotes
   a draft into a real persisted message.
2. **Persist-chain** (`draft-stream.ts:469`) — the `send(chunk)`
   call inside the 25s/4000-char persist-chain trigger. Sibling
   instance of the same bug; without this fix, draft-transport
   streams that cross the chain boundary would still under-report
   `sends` by the chain count even after the finalize fix landed.

2 new tests pin the contract:
- draft-transport stream that materializes a non-empty reply must
  report `sends>=1` in stream-end
- draft-transport stream that fires a persist chain + a finalize
  materialize must report `sends>=2` and `persists>=1`

### PR audit — state-machine turnEnd per-callsite plan (#1603)

Extended `docs/rfcs/inbound-delivery-state-machine.md` with an
"Updated cutover plan" section reframing PR 3 as 3a/3b/3c/PR-4,
plus a 7-row per-callsite audit table for every bare
`purgeReactionTracking(key)` callsite in `gateway.ts`. Reviewer-
verified migration recommendations and an implementation-order
suggestion (smallest-risk-first).

### PR step 1 — delete duplicate `turnEnd` emits (#1604)

Two bare purge calls at `gateway.ts:5831` and `:5989` were each
firing a second shadow `turnEnd` immediately before the canonical
`endCurrentTurnAtomic(turn)` call on the same key. Deleted.
No runtime behaviour change — `endCurrentTurnAtomic` already does
the work.

### PR step 2 — stop premature `turnEnd` from reply-tool (#1605)

`endStatusReaction` (mid-turn signal from reply tool + stream_reply
post-finalize) was invoking `purgeReactionTracking(key)` for the 👍
transition. That function ALSO fires turn-end semantics — shadow
`turnEnd` emit, `activeTurnStartedAt` clear, and the model-idle
restart/flush gate. All three fired mid-turn on every reply tool
success. Split `purgeReactionTracking` into two primitives:

- `clearReactionState(key)` — pure reaction-cleanup. Mid-turn-safe.
- `purgeReactionTracking(key, endingTurn?)` — turn-end signal.
  Now delegates the maps cleanup to `clearReactionState`.

`endStatusReaction` swapped to `clearReactionState`. Fixes:
- N reply-tool calls in one turn no longer fire N shadow `turnEnd`s.
- The idle gate no longer false-trips mid-turn (preventing premature
  `pendingInboundBuffer` flush + `triggerSelfRestart`).

### PR step 3 — thread `turn` at post-null IIFE sites (#1606)

Two callsites of `purgeReactionTracking` live inside the turn-flush
backstop IIFE (`gateway.ts:6167` / `:6295`) that runs AFTER
`endCurrentTurnAtomic(turn)` already nulled module-scope
`currentTurn`. Without explicit threading, the function's
`outboundEmitted` fallback reads `undefined → false` — wrong for
the dedup branch where `recentCount > 0` proves the reply tool DID
send messages.

Both sites now pass the captured `turn` closure variable explicitly.

### PR step 4 — delete duplicate at happy-path tail (#1607)

The dominant happy-path turn-end tail at `gateway.ts:6322` was
firing `purgeReactionTracking(...)` followed ~90 lines later by
`endCurrentTurnAtomic(turn)` on the SAME key (chatId/threadId
derived from `turn.sessionChatId/sessionThreadId` at lines
5946-5947). Same duplicate-emit class as step 1. Deleted the bare
call.

Side benefit: the idle gate (pendingInbound flush, restart trigger,
`maybeProactiveCompact`) now fires once at the natural point after
all turn-end telemetry / DB recording / marker cleanup, rather
than twice.

### PR step 5 — silence-poke fallback explicit `outboundEmitted=false` (#1608)

The silence-poke framework fallback fires after 5 min of agent
silence with no visible outbound. The shadow trace's
`outboundEmitted` field must be **false** for this path regardless
of `wedgedTurn.replyCalled` — the fallback firing is by definition
"no visible delivery happened." Extended `purgeReactionTracking`
signature with a third `outboundEmittedOverride?: boolean`
parameter (highest precedence in the derivation), applied at both
`gateway.ts:3127` and the sibling-key sweep iterator at `:3143`.

### Audit complete

All six live `purgeReactionTracking` callsites in `gateway.ts` now
emit `outboundEmitted` from an authoritative source:

- `gateway.ts:1408` — canonical via `endCurrentTurnAtomic`, threads
  `turn`.
- `gateway.ts:3127` — silence-poke fallback, explicit `false`.
- `gateway.ts:3143` — sibling-key sweep, explicit `false`.
- `gateway.ts:6175` — turn-flush dedup branch, threads `turn`.
- `gateway.ts:6315` — turn-flush finally, threads `turn`.
- `gateway.ts:6412` — canonical happy-path tail via
  `endCurrentTurnAtomic`, threads `turn`.

Empirical validation step ("eyeball shadow trace on test-harness
during multi-reply DM") is the canary gate before fleet rollout.

## v0.13.0 — sendMessageDraft alignment (PRs A+B+C+D)

Closes the sendMessageDraft alignment epic — four PRs aligning
`telegram-plugin/draft-stream.ts` with Telegram's new
beta-graduated `sendMessageDraft` Bot API method (Bot API 9.3 / 9.5 /
10.0). DM streams now use ephemeral draft previews for sub-second
live-feel; long turns chain through real `sendMessage` calls when
the draft expires; rate-limits and soft failures fall back gracefully
to message transport.

### PR A — gw-trace stream-start/stream-end observability (#1596)

Two always-on structured stderr traces from `draft-stream.ts`:
`gw-trace stream-start ...` captures transport resolution + reason
at stream creation; `gw-trace stream-end ...` captures per-stream
fire counts (drafts / sends / edits / fallbacks / persists) +
`firstFireMs` (TTFO sub-component) at `finalize()`. Kill switch:
`SWITCHROOM_STREAM_TRACES=0`.

### PR B — sub-second draft throttle + configurable knob (#1597)

Transport-aware throttle defaults: **300 ms for draft transport**
(DMs) — drafts are ephemeral and don't share `editMessageText`'s
per-message rate cap; **1000 ms for message transport** (groups /
forums / draft API absent). Both overridable via
`channels.telegram.stream_throttle_ms` in agent yaml (plumbed
through `SWITCHROOM_TG_STREAM_THROTTLE_MS` env). Floor 250 ms.
Removes the legacy `throttleMs: 600` compromise on the LLM
stream_reply path (PTY-activity path deliberately kept at 600 — see
`gateway.ts:6438` comment).

### PR C — 30s persist-then-continue chain (#1598)

Telegram's `sendMessageDraft` preview expires after 30 seconds.
Long LLM turns blow past that. Fix: at ≥25s OR ≥4000 unpersisted
chars, fire a real `sendMessage` with the current chunk, allocate
a fresh `draft_id`, continue streaming. Long turns now render as a
chain of persisted chunks separated by live previews. `finalize()`
materializes only the unpersisted tail (no duplicate of earlier
chunks). Per-stream `gw-trace stream-persist chunk_chars=...`
emitted at each persist boundary; `persists=N` added to stream-end
trace.

### PR D — 429 + non-true fallback robustness (#1599)

Two new failure paths handled in `sendViaDraft`: (1) 429 from
`sendMessageDraft` — extract `retry_after`, fall back to message
transport, push `lastSentAt` forward by `retry_after * 1000` so
the fallback's next send respects Telegram's cooldown
(per-chat cap is shared across methods); (2) non-true return —
`false`/`null` triggers fallback, `undefined` is treated as
success (grammY's typed wrapper strips the bool). Both bump
`fallbackFires` for the stream-end counter.

### Scope

Draft transport is DM-only (per existing `auto` transport logic).
Group / forum / threaded streams continue on the message-transport
path unchanged.

### Test totals

81 vitest + 52 bun-test on `draft-stream.test.ts`; 30+ unit tests
on the new `draft-transport.ts` helpers.

### Deferred follow-ups (in-code comments)

- Per-chunk hash dedup for lost-ACK double-persist (PR D follow-up).
- Cumulative-text retraction tolerated as benign (stale preview
  until model re-extends).

## v0.12.29 — feat(gateway): prefix-cache warmup (Phase 1, opt-in) + outboundEmitted refinement

Per cold-start TTFO RFC (#1589) Option A. On every bridge-up after
restart, the gateway synthesizes a `__WARMUP_PING__` inbound and
sends it to the just-registered bridge. Claude processes the message
— paying the cold prefix-cache cost on the synthetic turn — and is
instructed in the message text to respond `NO_REPLY`. The existing
silent-marker suppression at `gateway.ts:5906` swallows the response.
By the user's NEXT real message, Anthropic's prefix cache is warm and
TTFO drops ~4-8s on cold-start.

**Opt-in via `SWITCHROOM_PREFIX_WARMUP=1`. Default OFF.**

Phase 1 is deliberately minimal:
- No AGENT.md modification — the warmup TEXT carries the NO_REPLY
  instruction inline. Agent compliance is best-effort; non-compliant
  agents may emit a real reply to the primary chat (acceptable
  opt-in UX cost).
- No `meta.suppressProgressCard` plumbing — the warmup turn will
  briefly show a 👀 reaction + progress card before NO_REPLY
  suppression unpins it. Phase 2 will tag for full suppression.
- Cooldown: 5-min per agent (gymbro-style 6-reconnects-per-cycle
  doesn't burn quota).
- Routes to the boot chat resolved by `resolveBootChatId` — same
  helper the boot card uses.

13 unit tests pin env gate, cooldown debounce (per-agent), message
shape (`meta.source="warmup"`, synthetic messageId=0), boot-target
fallback, send-error handling.

### turnEnd outboundEmitted refinement (PR 3b precondition)

Phase 2b PR 3b precondition. The shadow emit at `gateway.ts:1287`
previously sent `outboundEmitted: true` blindly on every turnEnd —
flagged in the PR 3a CHANGELOG (gateway.ts:1277-1281 doc comment) as a
known approximation that would corrupt invariant #5's `lastOutboundAt`
data once dispatched live.

Now reads from `endingTurn?.replyCalled` (threaded explicitly from
`endCurrentTurnAtomic`) with a fallback to module-scope
`currentTurn?.replyCalled` for legacy sibling-purge / restart-init
callsites. NO_REPLY / HEARTBEAT_OK / wedged turns now correctly emit
`outboundEmitted: false` — so a subsequent silence-poke fallback fire
won't get over-suppressed by stale `lastOutboundAt` data when the state
machine's tick effects are eventually wired live (PR 3b2).

Implementation note: `endCurrentTurnAtomic` nulls `currentTurn` BEFORE
calling `purgeReactionTracking`, so reading module-scope `currentTurn`
inside the helper would always see `null` on the happy path (every
replied turn). Fixed by threading the ending turn explicitly through
the new optional second parameter `endingTurn?: CurrentTurn`. Legacy
sibling-purge / restart-init callsites still pass undefined and fall
back to module-scope — `false` is correct there since those paths
aren't ending the current turn.

Pure data-quality change for the shadow trace; no behavior delta until
the turnEnd cutover (PR 3b2) executes the dispatcher's `noteOutbound`
effect.

## v0.12.28 — fix(npm): ship vendor/ in published tarball + per-line log timestamps

The `vendor/` directory (containing the hindsight-memory plugin tree)
was missing from `package.json`'s `files` array. Effect: every npm-
installed switchroom CLI ran `switchroom apply` with
`resolveHindsightVendorPath()` pointing at a non-existent path. The
guard at `scaffold.ts:1493` silently returned null, so the
hindsight plugin tree was NEVER copied into existing agents on apply.
Workaround was manual `sed` across all 9 fleet agents whenever a
hindsight setting changed (e.g., the v0.12.23 `retainEveryNTurns=1`
rollout).

Fix: add `"vendor"` to the `files` array. Also: the silent-null path
now logs to stderr so a future regression of the same shape is loud.

### Per-line ISO timestamps on supervisor log

Per cold-start TTFO RFC (#1589) rec #1. The gateway's stderr is captured
to `/var/log/switchroom/gateway-supervisor.log` but had no per-line
timestamps, which made every cold-start TTFO claim unverifiable.

New module `telegram-plugin/stderr-timestamps.ts` installs a one-time
wrapper on `process.stderr.write` that prepends an ISO-8601 timestamp
(`[YYYY-MM-DDTHH:MM:SS.mmmZ]`) at the start of each logical line.
Line-buffered: partial writes accumulate until a newline arrives, then
get stamped and forwarded. Wraps closest to the original `stderr.write`
so the existing `plugin-logger.ts` file mirror picks up the timestamped
text.

Kill switch: `SWITCHROOM_LOG_TIMESTAMPS=0` disables. Default ON.

Enables: TTFO delta measurement between `bridge registered`, first
`gw-trace dispatch stage=bridge_recover`, and first `tg-post
method=sendMessage` — required to validate any subsequent cold-start
optimization.

## v0.12.27 — feat(gateway): Phase 2b PR 3a — bridgeUp dispatcher cutover

First real cutover of the `InboundDeliveryStateMachine` (RFC
`docs/rfcs/inbound-delivery-state-machine.md`). The `bridgeUp` event
site in `onClientRegistered` now drives the drain and perm-verdict
redeliver paths through `dispatchEffects()` instead of inline
imperative loops. Behavior parity with the shadow trace baked over
v0.12.25–v0.12.26.

Scope is deliberately narrow:

- **bridgeUp** cutover. Effects `drainBuffer`,
  `redeliverPersistedPermVerdicts`, `logTrace` flow through the
  dispatcher. The boot-card path remains imperative (out of machine
  scope).
- **bridgeDown** still uses imperative `flushOnAgentDisconnect` —
  the machine's only effect on `bridgeDown` is `logTrace`.
- **turnEnd** stays imperative this PR. The shadow's
  `outboundEmitted: true` is currently a blind approximation
  (`gateway.ts:1277-1281`); cutting over without refining that
  signal first would silently corrupt invariant #5's
  `lastOutboundAt` data and over-suppress fallback fires.
- **inbound** stays imperative — biggest cutover, deferred.

New: `telegram-plugin/gateway/inbound-delivery-machine-dispatch.ts`
+ `telegram-plugin/tests/inbound-delivery-machine-dispatch.test.ts`
(18 unit tests pinning each effect-kind primitive call).

Kill-switch: `SWITCHROOM_DELIVERY_MACHINE_CUTOVER=0` falls back to the
imperative drain path (kept inline at the bridgeUp callsite as
parity-for-rollback; PR 4 deletes that branch once the cutover bakes).
Default ON.

**Minor behavior change**: the cutover path re-buffers an inbound on
`client.send` throw (via `redeliverBufferedInbound`'s lossless
re-push); the legacy imperative path dropped on throw. Strict
improvement — buffer depth survives transient send failures — but
mentioned because future debuggers may see non-zero depths after
bridge flaps where the old path would have shown zero (and lost the
message). The kill-switch fallback retains the legacy drop-on-throw
semantics for exact rollback parity.

## v0.12.26 — fix(P0): close the chronic bridge-flap class (IPC agentIndex race)

P0 hotfix for the fleet-wide chronic bridge-flap that caused
clerk + gymbro to be unresponsive on 2026-05-20 (and predates
that — first carrie disconnect at gateway log line 20464 from
earlier in the day).

Two concurrent races in `ipc-server.ts`'s agentIndex maintenance:

1. `handleRegister` was replace-not-reject — when a new client
   registered as an agent already in the index, it overwrote the
   prior entry without closing it. The code comment even admitted
   it: *"handleRegister does replace-not-reject, so this is
   belt-and-suspenders"*.

2. `removeClient` blindly deleted `agentIndex[client.agentName]`
   with no identity check — when a stale client got evicted (by
   the watchdog or natural disconnect), the delete removed the
   LIVE replacement client's entry by accident.

Combined: a fast bridge reconnect could orphan the live client
from the routing table. `sendToAgent` returned false despite a
healthy bridge being connected; messages buffered indefinitely
until the next reconnect happened to land in an order that left
the index populated.

### Fix

`removeClient` identity-checks before deleting — only the OWNER
(current value) can remove its own entry. `handleRegister`
explicitly closes any prior client with the same agent name
before installing the new one — single canonical value at all
times. Together the agentIndex stays consistent with reality
through all bridge churn.

### Changes

#### Fixes

- **fix(gateway):** IPC agentIndex race — close the chronic
  bridge-flap class. Identity-checked removeClient + zombie-close
  in handleRegister. Logs new line `register: closing prior
  client for agent=X — bridge reconnect race` when the zombie
  path fires (forensic visibility). (#1585)

## v0.12.25 — fix: shadow trace only emits for REAL bridge events (observability fix)

Hotfix for an observability bug in v0.12.24's shadow mode. The
`shadowEmit({kind: 'bridgeUp'/'bridgeDown'})` calls fired on EVERY
IPC client connect/disconnect — including anonymous MCP client
churn (recall.py + drain_pending.py + other transient MCP
handshakes). Every recall.py invocation flipped the shadow state to
`bridge_dead`, giving a misleading view of fleet health.

Symptom (observed during 2026-05-20 clerk/gymbro unresponsive
incident): 7 of 9 agents showed `shadow_state=bridge_dead` while in
reality the imperative gateway was mostly fine (UATs passed, crons
fired). Fix: gate both shadow emits on `client.agentName != null`
so anonymous IPC churn no longer pollutes the bridge state machine.

The underlying bridge sidecar flap (the REAL issue behind clerk +
gymbro getting stuck) is a separate investigation — see issue/task
P0 bridge flap. The shadow fix here is observability-only.

### Changes

#### Fixes

- **fix(gateway):** shadow only emits `bridgeUp`/`bridgeDown` for the
  REAL bridge sidecar (non-null `agentName`). Closes the
  `shadow_state=bridge_dead` false-positives caused by anonymous
  MCP client churn. (#1583)

## v0.12.24 — feat: InboundDeliveryStateMachine shadow mode (Phase 2b PR 2)

The state machine from PR 1 (#1578, v0.12.23) now runs ALONGSIDE the
existing gateway code in shadow mode. Every event-site emits a
structured `gw-trace shadow ...` stderr line showing the effects
the machine PREDICTS the gateway should take. **Behavior unchanged**
— the imperative code still runs everything. PR 3 will cut over
to executing the machine's effects.

This is the operator's window into validating the machine matches
reality before the cutover. Grep for `gw-trace shadow` after a
restart and the v0.12.22 boot-wedge fix's correctness becomes
visible per-event: first inbound after `bridgeUp` should emit
`effects=[setTurnStarted,deliverToBridge,...]` (not `bufferInbound`).

### Changes

#### Features

- **feat(gateway):** wire `InboundDeliveryStateMachine` in shadow
  mode at 4 event sites — `bridgeUp`/`bridgeDown`/`inbound`/`turnEnd`.
  Pure module from #1578 is now exercised in production via
  `shadowEmit()`; effects are LOGGED not EXECUTED. Kill switch:
  `SWITCHROOM_DELIVERY_MACHINE_SHADOW=0`. Wrapped in try/catch —
  a shadow bug can never wedge a real turn. (#1581)

## v0.12.23 — fix(memory/vision): close the remember-across-sessions moat + Phase 2b architectural foundations

The moat JTBD `remember-across-sessions` was silently failing in
production — a user's "please remember this" prompt never persisted
because the vendored hindsight plugin throttled retention to every
10 turns. Closed in v0.12.23: scaffold-layer override retains every
turn. Live UAT after the fix: capture TTFO=22.7s, recall TTFO=14.1s,
token round-tripped across restart.

Phase 2b architectural foundation: RFC + pure
`InboundDeliveryStateMachine` module with 5 property-test invariants
validated over 5,000 random schedules. PR 2 (wiring) and PR 3
(cleanup) follow. Zero behavior change for v0.12.23 — the module
is shipped UNWIRED.

Plus three vision-aligned UATs (fast-trivial TTFO, wake-audit
content, memory-survives) that catch JTBD gaps mock-based testing
keeps missing.

### Changes

#### Fixes

- **fix(memory):** override hindsight `retainEveryNTurns=1` in the
  per-agent scaffold (vendor file untouched). Closes the
  `remember-across-sessions` JTBD's silent failure. (#1579)

#### Features

- **feat(gateway):** `InboundDeliveryStateMachine` pure module + 5
  property-test invariants. Unwired in this release per the RFC's
  3-PR cutover. (#1578)

#### Tests

- **test(uat):** `jtbd-fast-trivial-dm.test.ts` — TTFO contract for
  short happy path. Baseline 1,771ms. (#1575)
- **test(uat):** `jtbd-wake-audit-content-dm.test.ts` — wake-audit
  content contract. 9 config signals on test-harness. (#1577)
- **test(uat):** `jtbd-memory-survives-restart-dm.test.ts` — memory
  survival contract; unskipped by #1579 above. (#1577, #1579)

#### Docs / RFCs

- **docs(rfc):** `docs/rfcs/inbound-delivery-state-machine.md` —
  Phase 2b design for closing the wedge-cluster bug CLASS. (#1576)

## v0.12.22 — fix(P0/vision): close the 5-min restart wedge — first-after-restart messages reply in seconds, not minutes

The "always-on specialist exec-assistants" vision means agents reply
fast. Pre-v0.12.22, **every agent container restart produced ~5 minutes
of blank** on the first user message in each thread — the silence-poke
framework-fallback fired at 300s and only THEN drained the message.
Observed live on all 9 fleet agents during the v0.12.21 rollout. This
release closes the wedge: a one-line snapshot in `handleInbound` makes
the #1556 delivery gate read the pre-receipt state instead of the live
size that the very same handler had just mutated for this inbound.

Plus the first JTBD UAT scenario explicitly tied to the always-on
vision contract — an mtcute regression guard that restarts an agent,
sends a fresh inbound, and asserts the reply lands well below the
silence-poke fallback floor.

### Changes

#### Fixes

- **fix(gateway):** snapshot `turnInFlight` at receipt to close the
  5-min restart wedge. The #1556 delivery gate read
  `activeTurnStartedAt.size > 0` live — but the fresh-turn branch at
  `gateway.ts:7357` had already written a Map entry for THIS inbound's
  turn before the gate ran. The gate saw the entry it just produced
  and decided buffer-until-idle, stranding the turn-starting message
  in `pendingInboundBuffer`. Claude never received it. Claude never
  replied. 5 min later the silence-poke fallback fired, drained the
  buffer, the reply finally landed — five minutes late. Fix: capture
  `const turnInFlightAtReceipt = activeTurnStartedAt.size > 0` once
  at receipt (after `gate()` early-exits, before any side effects)
  and pass the snapshot to `decideInboundDelivery`. Captures "was a
  turn already in flight WHEN this inbound arrived" — the actual
  semantic #1556 wanted. (#1573)

#### Tests

- **test(uat):** `jtbd-always-on-after-restart-dm.test.ts` — first
  mtcute UAT scenario explicitly tied to the always-on vision
  contract. Shells out to `switchroom agent restart`, sends a fresh
  inbound via the driver session, asserts reply lands within 120s
  (hard contract — well below the 300s silence-poke floor) with a
  30s yellow-band log for forensic visibility. Self-skips on hosts
  without NOPASSWD sudo. Wired into `ci-uat` as a separate gated
  step so it runs alongside the fuzz scenarios on operator-host UAT.
  Per memory `reference_mtcute_harness_local_e2e.md` this is the
  right tool for vision-aligned testing of the gateway delivery
  surface — wedge-cluster fixes that mock-based tests keep missing.
  (#1573)



Five PRs that turn the lessons of the 2026-05-19 wedge cluster into
durable structural fences. The headline fix closes the **#1564
sibling-key class at its root** — a single canonical chat-key
constructor that collapses `0` / `null` / `undefined` thread IDs into
the same token, so the bug that wedged gymbro/klanker (sibling
`activeTurnStartedAt` entries surviving turn-end) becomes
unrepresentable, not just recoverable. A forward-looking lint bans
fire-and-forget `ipcServer.broadcast(...)` for delivery semantics
(Class A — the bug behind PRs #1536/#1537/#1539/#1546/#1549/#1555/
#1558). The gateway.ts bot-api allowlist cuts over from drift-prone
line ranges (~20 ceiling-bumps in 14 days) to inline markers — the
tax is gone. And the first **live-docker integration test** (#1529
regression class) catches the stub-vs-real divergence that hid every
real `agent_exec` being 127'd for months.

### Changes

#### Fixes

- **fix(gateway):** canonicalize chat-key derivation to close the
  #1564 sibling-key class at the source. New
  `telegram-plugin/gateway/chat-key.ts` provides the single canonical
  constructor (`chatKey(chatId, threadId)`) that collapses
  `0`/`null`/`undefined` thread IDs into the same token (`_`).
  `${chatId}:${threadId ?? '_'}` previously rendered `0` as `"0"` (??
  doesn't coalesce `0`) and null/undefined as `"_"`, accumulating
  sibling keys for the same chat+thread; the silence-poke fallback's
  per-key purge left them stranded. Migrates the 4 ad-hoc literal
  sites in gateway.ts (lane suffixes + turnKey + silent-turn
  suppressPrefix) plus the sibling helpers in `stream-reply-handler.ts`
  and `pty-partial-handler.ts`. Test harnesses in `tests/e2e.test.ts`
  and `tests/races.test.ts` realigned from divergent `'default'`
  sentinel to canonical `_`. (#1570)

#### Tests

- **test(docker):** live argv-passthrough regression guard for
  `docker-exec` (the #1529 bug class). New
  `tests/docker/docker-exec-argv-e2e.test.ts` exercises 5 cases
  against a real `busybox:latest` container labeled per project test
  discipline. Pre-#1529 the production `runDocker(["exec", container,
  "--", ...argv])` invocation 127'd every real `agent_exec` for
  months because `docker exec` (unlike `docker run`) does NOT
  recognize `--` as an argv separator — it execs a binary named
  literally "--". CI was green throughout because the docker stub
  ignored argv past `$1`. This test is the first live-docker
  integration coverage of `runDocker(["exec", ...])` against a real
  container; a future PR that reinserts `--` (or any other
  argv-passthrough breakage) fails the gate. (#1571)

#### Lint / Dev infrastructure

- **feat(lint):** ban `ipcServer.broadcast(...)` for delivery
  semantics. New `scripts/check-no-broadcast-delivery.mjs` (160-file
  scan, comment-aware) requires a `// allow-broadcast: <reason>`
  marker on the line IMMEDIATELY preceding every broadcast callsite.
  Forward-looking guard against Class A (fire-and-forget delivery
  over a flappy bridge) — the bug class that the entire wedge cluster
  patched outward in 8 layers. The 2 broadcasts remaining on main
  (checklist task notify, shutdown status) are both informational
  and now carry explicit markers. (#1567)
- **feat(lint):** accept inline `// allow-raw-bot-api: <reason>`
  markers in `scripts/check-bot-api-wrapping.sh` as an alternative
  to the line-range ALLOWLIST. The wrapper-detection lookback
  (`robustApiCall` / `swallowingApiCall` / `retryWithThreadFallback`
  closures) is unchanged. **Zero behavior change** — both mechanisms
  coexist for one PR window to enable a clean cutover. (#1568)
- **refactor(lint):** cut over the gateway.ts bot-api allowlist from
  6 drift-prone line-range entries to 8 inline markers at the
  callsites that aren't already inside a wrapper closure. Deletes
  212 lines of bump-trail comments (the file's own comments
  documented ~20 ceiling-bumps in 14 days as gateway.ts insertions
  drifted the ranges). Per memory `feedback_gateway_bot_api_allowlist_drift.md`
  the recurring tax is gone — markers don't drift. (#1569)

## v0.12.20 — fix: held-mid-turn wedge closed at both source and recovery; vault-broker operator-unlock + backups

Two headlines. (a) Gateway: the gymbro/klanker "agent receives the
message, acknowledges with a reaction, then never replies" wedge is
fully closed — the silence-poke framework fallback now sweeps sibling
`activeTurnStartedAt` entries for the firing chat (recovery), AND
every site that nulls `currentTurn` now atomically purges the turn's
statusKey (source). #1556's turn-gate can no longer stay stuck on a
dangling sibling key while claude is idle. (b) Vault: the broker's
operator-unlock path now bypasses peercred (closes the RFC-J Phase-3
gap surfaced during the vault-forensics window), and a new
`switchroom vault backup` verb writes dated, encrypted, versioned
snapshots so a vault rewrite is no longer single-copy-fatal.

### Changes

#### Features

- **feat(vault):** `switchroom vault backup` — operator-run command
  that writes dated, encrypted, versioned snapshots of the vault to a
  configurable destination, so a single-copy loss (rewrite, accidental
  reinit) is no longer fatal to vault state. (#1562)

#### Fixes

- **fix(gateway):** held-mid-turn wedge closed at both layers.
  (a) The silence-poke framework fallback now sweeps any
  `activeTurnStartedAt` sibling key for the firing chat (new pure
  `purgeStaleTurnsForChat` helper) — catches any dangling state from
  whichever path leaked it. Multi-chat safe: only touches keys for
  `fbChatId`, preserving #1546's cross-chat guard. (b) All four
  turn-end paths (context-exhaust / silent-marker / turn-flush /
  `turn_end`) now call a new `endCurrentTurnAtomic(turn)` helper that
  pairs `currentTurn = null` with
  `purgeReactionTracking(statusKey(turn.sessionChatId,
  turn.sessionThreadId))` — null and purge are inseparable at the
  source, so siblings can't leak through to begin with. The fallback's
  multi-chat-safe null guard is untouched. Symptom (gymbro/klanker
  2026-05-20): `currentTurn_nulled=false drained_buffered=0/N
  rebuffered=N` followed by every subsequent inbound stuck in `inbound
  held mid-turn`. (#1564)
- **fix(vault-broker):** bypass peercred on the operator-unlock path —
  closes a Phase-3 gap from RFC-J where an unlock invoked via the
  operator socket could fail the peercred check that's only meaningful
  for per-agent sockets. (#1561)
- **fix(test-hermeticity):** regression-proof gate against the
  `os.homedir()` trap so vault-related tests can no longer leak into
  the real `~/.switchroom` instead of a tmpdir. (#1560)
- **test:** de-flake `timezone-hook.test.ts` (CI shard timeout under
  load). (#1563)

## v0.12.19 — feat: "your message is queued" now survives a restart (durable inbound spool)

Headline: the gateway's "⏳ your message is queued and will be
processed when it reconnects" promise was backed by an in-memory
buffer — a gateway/container restart silently lost the message (the
user had to resend; hit twice, finn + carrie). This release makes the
promise deterministic with a crash-tolerant on-disk spool on the
persistent per-agent volume: every queued inbound is durably
recorded, boot-replayed if undelivered, acked only on confirmed
delivery, and — if still undeliverable past a bound — the promise is
explicitly retracted with a "couldn't deliver, resend" card rather
than vanishing. Also closes the mid-turn composer wedge and a
stateless-hindsight false-fail in the status probe.

### Changes

#### Features

- **feat(gateway):** durable inbound spool. The "message is queued"
  promise is now crash-survivable: a JSONL spool on
  `STATE_DIR=/state/agent/telegram` (survives container recreate),
  composed into the in-memory buffer at a single chokepoint (all push
  sites). Boot-replays un-acked inbound; acks only on confirmed
  delivery to a live registered bridge; dedups by a stable id; and a
  bounded-escalation sweep posts an explicit "couldn't deliver —
  resend" card so a queued message is ALWAYS resolved (delivered or
  visibly retracted), never silently lost across a restart.
  Compaction is atomic (tmp+rename). v1 ack = "delivered to a live
  bridge"; a true claude→gateway consumption-ack is a documented
  follow-up. (#1558)

#### Fixes

- **fix(gateway):** turn-gate inbound delivery to end the composer
  wedge — a non-steering Telegram message arriving mid-turn was typed
  into claude's TUI composer and its auto-submit raced
  turn-completion, stranding the message (the lawgpt wedge). Such
  inbound is now buffered until claude goes idle, where it submits
  cleanly as a fresh turn; steering messages stay exempt. (#1555)
- **fix(status):** the agent-status probe tolerates a stateless
  hindsight backend instead of false-failing the status check when
  hindsight is configured stateless. (#1556)

## v0.12.18 — feat: tell the user when proactive compaction runs

Headline: v0.12.17 added opt-in proactive `/compact`, but it ran
silently — an agent could drop ~600k+ of working context with no
visible trace, which is at odds with switchroom's Visibility outcome.
This makes proactive compaction observable: a single Telegram card is
posted when `/compact` fires and edited in place to "context compacted
(~X → ~Y tokens)" once the context has verifiably shrunk. Session
reset/rotation (`session.max_idle` / `max_turns`) stays deliberately
silent — unchanged. No new config: the notice activates automatically
wherever `session.max_context_tokens` is set.

### Changes

#### Features

- **feat(session):** proactive-compaction start/finish notification.
  On `/compact` fire the gateway posts a START card and edits it in
  place to FINISHED once the proactive-compaction decider's re-arm
  edge confirms context actually dropped below 0.6×cap (no new IPC /
  no new session event — reuses the v0.12.17 state machine and the
  bridge's already-forwarded active-file). A same-file guard rejects a
  sub-agent transcript briefly leading session-tail's current file
  (no spurious / pre-completion finish); a wall-clock 15-minute
  timeout edits a never-confirmed card to a neutral terminal state so
  it can't dangle on an idle agent; a single-outstanding-card
  invariant supersedes a prior card and clears the record+timer
  atomically so a stale message is never re-edited. START is decided
  synchronously after the opt-in `cap == null` return, so a fleet
  with the feature off posts nothing (Defaults preserved). Transition
  selection is a pure, unit-tested module; `proactive-compact.ts` is
  unchanged. (#1553)

## v0.12.17 — feat: proactive context compaction (opt-in token cap)

Headline: an always-on fleet on the 1M Opus window only hits Claude
Code's native auto-compaction near the very top of the window
(~800k+), which means agents can run for a long time on a huge,
mostly-stale context — slower, costlier per turn, lower-signal. This
adds an opt-in token cap that proactively runs `/compact` once live
context occupancy reaches a configured threshold, so the fleet holds
a deliberately lean working context on a large-window model. Off by
default (a fresh `switchroom setup` is unchanged); Hindsight remains
the cross-session safety net.

### Changes

#### Features

- **feat(session):** new opt-in `session.max_context_tokens`. When
  set, the gateway runs the allowlisted `/compact` once the latest
  assistant turn's live occupancy (`input + cache_read +
  cache_creation` — the prefix actually re-read this turn, not a
  cumulative total) reaches the cap. Fires only at the model-idle
  turn boundary (never mid-generation), reading the session-tail's
  already-attached transcript (forwarded bridge→gateway) rather than
  an independent re-scan. Anti-flap is a pure, unit-tested state
  machine: disarm-on-fire + occupancy hysteresis (re-arm below
  0.6×cap) + a turn-count cooldown floor — it degrades to "don't
  fire" rather than livelooping if a compaction fails to shrink
  context. Standard per-field `session` cascade (agent-wins); set
  fleet-wide under `defaults.session`. No schema default → opt-in.
  `docs/session-optimization.md` documents the trade-off and revises
  the prior "let native compaction handle it" guidance for
  large-window fleets. (#1551)

## v0.12.16 — fix: close the bridge-flap-while-idle inbound-orphan gap + green CI on hindsight-untouched releases

Headline: v0.12.15 made agents self-heal a *wedged-turn* (silence-poke
fallback flushes the buffer). But a message buffered during a
bridge-IPC flap that settled with no subsequent clean re-register,
while the agent was *idle* (no turn → silence-poke never arms), was
drained by neither path and orphaned until a manual restart (hit on
`finn`). This adds a third, opportunistic drain trigger so that case
self-heals too. Also: `docker-images` no longer false-reds on `main`
for releases that don't rebuild hindsight.

### Changes

#### Fixes

- **fix(gateway):** opportunistic idle-drain of `pendingInboundBuffer`
  — a 5s `.unref()` timer (new pure, unit-tested `idleDrainTick`)
  flushes any buffered inbound once the bridge is alive again, closing
  the bridge-flap-while-idle orphan gap that v0.12.15's wedged-turn
  self-heal didn't cover. Gated zero-cost / zero-churn: a no-op when
  the buffer is empty or the bridge is down (never drains into a dead
  bridge); reuses the lossless `redeliverBufferedInbound` (re-buffers
  any per-message miss). `onClientRegistered` + the silence-poke
  paths are unchanged — purely additive. (#1549)

#### CI / build

- **ci(docker-images):** `promote-to-dev` tolerates a missing
  per-commit `:sha-<short>` source tag. A release that doesn't change
  hindsight's build context is a 100% buildx cache hit → nothing
  pushed → the hindsight retag hard-failed → whole `docker-images`
  run RED on `main` for almost every release (fleet always
  unaffected: `:latest` is pushed inline by the build jobs). Now
  gated `needs: [smoke-test, build-hindsight]` so a missing tag
  provably means cache-hit (never failed build), and only an explicit
  not-found skips — any other inspect error fails loudly so a
  transient registry/network error can't silently stall `:dev`. (#1548)

## v0.12.15 — fix: agents self-heal a post-network-storm wedge (no manual restart)

Headline: an agent that had a turn in flight when the network flapped
(e.g. every gateway hitting `api.telegram.org` at once during a
fleet-wide `switchroom update` recreate) could end up silently "not
responding" — the inbound buffer drained ONLY on a bridge re-register,
so once connectivity returned with the bridge still connected the
buffered user messages sat forever until a manual per-agent restart.
The silence-poke framework fallback now flushes that buffer when it
clears the wedged turn, so the agent self-recovers within the
silence-poke window with no operator action. Also: the approval kernel
closes its consume↔record gap (atomic), and `switchroom doctor` now
actively probes Drive OAuth-client broker-reachability instead of only
checking config presence.

### Changes

#### Features

- **feat(approval):** `approval_consume_record` is now atomic — the
  single-use nonce consume and the audit-record write can no longer
  tear apart on a crash/race between the two, closing the
  consume↔record gap (PR-6). (#1545)

#### Fixes

- **fix(gateway):** agents self-heal a wedged turn after a network
  storm. `pendingInboundBuffer` previously drained only on bridge
  re-register (`onClientRegistered`); after a storm that settled with
  the bridge still connected, messages buffered during the flap never
  drained and the agent looked dead until a manual restart. The
  silence-poke framework fallback now flushes the buffer (new pure
  `redeliverBufferedInbound` — drain → send → re-buffer on miss so
  nothing is lost) when it clears the wedge. The fallback log gains
  `drained_buffered=<n>/<n>` for visibility. Root-caused from the
  2026-05-19 fleet-update thundering-herd incident. (#1546)
- **fix(doctor):** the Google Drive section now actively probes that
  the vault-broker will actually *serve* the configured OAuth client
  credential to each Drive-enabled agent (operator-socket
  `preflight_access` → full `checkAclByAgent`), instead of only
  checking the value is present in config. Closes the blind spot that
  let the v0.12.14 client-secret broker-ACL bug ship silently; broker
  locked/unreachable maps to `skip`, never a false fail. (#1543)

#### Internal

- **refactor(approval):** extracted a pure `resolveApprovalDecision`
  and unit-tested the bad-TTL seam, de-risking the approval-decision
  path ahead of the atomic-consume change. (#1544)

## v0.12.14 — fix: Google Drive MCP works fleet-wide (RFC G §4.4) + gateway/approval delivery reliability

Headline: the Google Drive MCP was dead on arrival on every install
that stores the OAuth client secret as a `vault:` ref (the documented
`switchroom auth google connect` shape). The launcher resolves
`google_workspace.google_client_secret` through the vault-broker, but
the broker's only standing read-ACL is per-agent
`schedule[].secrets[]` and nothing in onboarding wired the client
secret into it — so every Drive-enabled agent was broker-`DENIED` the
secret and the `gdrive` MCP never spawned, even with config, scaffold,
MCP trust, and the refresh token all correct. This release completes
RFC G §4.4: the broker now derives the grant from
`google_workspace` + `google_accounts.enabled_for[]` config, the same
gate the scaffold uses. No operator action — works on fresh installs.
Also: a four-part gateway/approval delivery-reliability series and a
default-doctor cron-secret preflight.

### Changes

#### Features

- **feat(broker,doctor):** `preflight_access` — the default `doctor`
  run now verifies each agent's declared cron `secrets[]` are actually
  broker-reachable, so a misconfigured ACL surfaces before a 3am cron
  fails on it rather than after. (#1533)

#### Fixes

- **fix(vault-broker):** grant Drive-enabled agents read access to the
  configured Google OAuth client credential
  (`google_workspace.google_client_{id,secret}` vault refs), gated by
  the same `shouldEmitGdriveMcp` predicate the scaffold uses so broker
  and scaffold can never disagree. Completes RFC G §4.4 — the Google
  *account* slots were already exempt from `schedule.secrets`; the
  client credential was the one piece of the same Drive auth flow left
  out, which made the `gdrive` MCP fail to connect fleet-wide. The
  predicate moved to a new dependency-free
  `config/google-workspace-acl.ts` so the broker (whose `acl.ts` is
  deliberately pure) can share it. Identity-bound, not cross-agent —
  exactly analogous to the existing per-agent `bot_token` clause; the
  `mcp_servers: { gdrive: false }` opt-out is honoured. (#1538)
- **fix(gateway):** wake the agent after `vault_request_save`
  Save/Discard/fail so a vault-save decision no longer leaves the
  turn hung (PR-1/4). (#1536)
- **fix(gateway):** buffer Telegram-inbound messages and button-tap
  delivery so taps/messages arriving mid-reconnect are not dropped
  (PR-2/4). (#1537)
- **fix(gateway):** permission verdicts survive a gateway reconnect,
  with TTL auto-deny so a never-answered prompt fails closed rather
  than hanging forever (PR-3/4). (#1539)
- **fix(approval):** compute the approval decision *before* burning
  the single-use nonce, so a decision is not lost when the nonce is
  consumed (PR-4/4). (#1541)
- **fix(broker):** a test-injected broker must not auto-unlock the
  real vault — test isolation fix preventing a test broker from
  touching operator vault state. (#1534)

#### Docs

- **docs:** value-first README restructure + accuracy pass and
  diagram alignment. (#1540)

## v0.12.13 — fix: agent_smoke auth probe checked the wrong path

### Changes

#### Fixes

- **fix(hostd):** the `agent_smoke` `auth` probe tested
  `$CLAUDE_CONFIG_DIR`/`$HOME/.claude/.credentials.json`, but
  in-agent `CLAUDE_CONFIG_DIR` is unset and `HOME=/state/agent/home`
  while the real OAuth credential is `/state/agent/.claude/.credentials.json`
  — so it false-failed "auth" for every healthy agent (the only
  probe still red after the v0.12.12 `--` fix). Probe now targets the
  verified path, consistent with the other probes. Completes the
  honest-doctor arc (v0.12.9 `skip` → v0.12.10 `agent_smoke` →
  v0.12.11 operator socket → v0.12.12 `--` → this): the "Agent
  liveness" section now reports real per-agent `ok`. A new server
  test pins every probe's command string so a wrong-path probe
  can't regress unseen. (#1531)

## v0.12.12 — fix: docker-exec `--` broke agent_exec & agent_smoke in production

### Changes

#### Fixes

- **fix(hostd):** drop the `--` from `docker exec` invocations in
  `agent_exec` (#1208/#1401) and `agent_smoke` (#1525). Unlike
  `docker run`, `docker exec` stops parsing its **own** options at
  `CONTAINER`, so the `--` #1401 added was both unnecessary and
  prod-breaking: docker tried to exec a binary literally named `"--"`
  → exit 127, so **every real `agent_exec`/`agent_smoke` call failed**
  (invisible because the hostd tests used a docker stub that ignored
  argv past `$1`). The caller-argv-as-docker-flag concern #1401
  worried about cannot occur for `docker exec` (verified against real
  docker); the `agent_exec` allowlist + charclass backstops are
  unchanged. The test stub now models real docker (a `--` command
  position exits 127) so this can't regress unseen. Surfaced by
  live-verifying the v0.12.11 "Agent liveness" doctor section. (#1529)

## v0.12.11 — hostd operator socket; honest doctor, part 3 (verified liveness goes live)

Completes the honest-doctor arc. Part 1 (v0.12.9) made the
host-unverifiable rows an honest `skip`; part 2 (v0.12.10) built the
verified `agent_smoke` probe; deploying part 2 surfaced that hostd
had **no operator socket**, so the host CLI couldn't consume it and
the "Agent liveness" section degraded to a single `skip`. Part 3
gives the host operator the transport.

### Changes

#### Features

- **feat(hostd):** hostd now binds an **operator socket**
  (`~/.switchroom/hostd/operator/sock`, mode 0600, chowned to
  `SWITCHROOM_HOSTD_OPERATOR_UID`) alongside the per-agent sockets.
  `peercred` maps it to `kind:"operator"` and `checkGate` leaves it
  ungated (the operator is root-equivalent on its own host). The
  hostd compose template passes the operator UID (SUDO-aware). No-op
  when the env is unset/invalid — fail-closed, same posture as the
  vault-broker. With this, `switchroom doctor`'s "Agent liveness
  (in-agent via hostd)" section flips from a degraded `skip` to real
  per-agent verified `ok`/`✗`. (#1527)

## v0.12.10 — verified in-agent liveness (`agent_smoke`); honest doctor, part 2

Part 2 of the `switchroom doctor` signal-to-noise work (part 1, the
`skip` status, shipped in v0.12.9). The host operator can't read
agent-private 0600 state (WS6-F2), so those rows are honest `skip`.
This adds the *verified* truth via the one audited, admin-gated
component that holds the docker socket — hostd — rather than the
unprivileged doctor CLI shelling docker itself.

### Changes

#### Features

- **feat(hostd):** new read-only `agent_smoke` verb — hostd runs a
  fixed, exit-code-only probe battery inside an agent container
  (auth-creds present, scheduler block + sidecar, `.mcp.json` valid,
  bot-token present, `/state` writable; opt-in `--deep` adds a
  bounded real `claude -p` auth smoke — the default makes **no**
  model call). Probes never surface stdout (the bot-token probe is
  `grep -q`; the token never leaves the container). Self-target
  allowed, cross-agent admin-gated (mirrors `agent_logs`/`agent_exec`).
  A down container / docker failure degrades every probe to `skip`;
  the verb is always `completed` when it ran (a failing probe is a
  finding, not a dispatch error). (#1525)
- **feat(doctor):** new "Agent liveness (in-agent via hostd)" section
  — one compact verified row per agent. hostd unreachable /
  `host_control` off / agent down → `skip`, never fail. `--fast`
  omits it (offline/quick). The Telegram whole-fleet `/doctor`
  (#1518) now runs `doctor --fast` so it stays structural and can't
  blow the gateway's 30 s budget. (#1525)

## v0.12.9 — restore the Telegram reauth flow (auth reauth/code/cancel)

One fix: the per-agent OAuth reauth flow was dead fleet-wide.

### Changes

#### Fixes

- **fix(auth):** restore the `auth reauth` / `auth code` / `auth cancel` CLI verbs. RFC-H (#1254) removed their registrations from `src/cli/auth.ts` when it restructured auth around the broker, but left the engine (`src/auth/manager.ts` — `startAuthSession`/`submitAuthCode`/`cancelAuthSession`), every caller (the Telegram gateway `op:reauth` + `/auth reauth`, `welcome-text`, `operator-events`) and the tests all still expecting them. Net effect: any agent's 🔐 Reauth button ran `switchroom auth reauth <agent>` → "unknown command" → the operator saw **"Command failed"** (surfaced on `gymbro` after a transient 4xx). Re-registered as thin, agent-scoped wrappers over the existing, tested engine (`--slot`/`--force`, `auth code … --json` pinned to the gateway's parser); the credential write path is unchanged, so RFC-H's single-*writer* broker plane is untouched. (#1522)

## v0.12.8 — operator vault CLI fix, whole-fleet /doctor, audit tamper-evidence correctness

Three fixes from a `switchroom doctor` audit pass.

### Changes

#### Fixes

- **fix(vault-broker):** the broker runs as root, so its only vault write path (`saveVault` → atomic rename) left `~/.switchroom/vault/vault.enc` `root:root 0600`. The broker keeps reading it (CAP_DAC_READ_SEARCH) which masked the breakage, but the operator's `switchroom vault …` CLI failed `EACCES` on its own vault — and it silently re-broke on every persist (token rotation, `/vault put`, auto-unlock, every broker bounce). doctor's lone hard fail. Broker now chowns `vault.enc` back to the operator UID after persist, mirroring its existing socket-chown pattern. (#1519)
- **fix(doctor):** audit tamper-evidence (`doctor-audit-integrity`) was a false-negative on every long-lived host: it inspected only the first log row, so an append-only log's permanent pre-#1433 legacy preamble made it report "tamper-evidence inactive, run `switchroom update`" forever AND never verify the chained region (a forensically-rewritten row was undetectable — the exact WS10-F2 attack the check exists for). New `verifyAuditLog()` is segment-aware: the broker/hostd re-anchor the chain on every restart (multi-segment is normal — the live host has 6 segments / 5 restarts), so pass/fail is per-row self-consistency (`_hash == sha256(_prev∥_seq∥body)`), which never false-alarms on restarts yet still catches an in-place edit. (#1520)

#### Features

- **feat(hostd,telegram):** `/doctor` from Telegram now offers admin agents a one-tap scope picker — **🩺 Whole fleet** (host-side via the new read-only, admin-gated hostd `doctor` verb, so it sees every container + singleton) or **🩺 This agent** (the prior in-container view). Non-admin / no-hostd agents keep the original behaviour unchanged. No approval card — `doctor` is read-only. (#1518)

## v0.12.7 — republish of v0.12.6 (broken artifact had no dist/)

`switchroom@0.12.6` was published with **no `dist/`** — the build had failed silently (the publish command piped the build through `tail`, which masked its non-zero exit) so the tarball shipped without the CLI bundle and is unusable. **Use v0.12.7.** v0.12.6 is deprecated on npm. The *code* content of v0.12.7 is identical to the intended v0.12.6 — the only delta is a correctly built artifact (verified post-publish that the tarball contains `dist/cli/switchroom.js` with the fix). No source changes vs v0.12.6.

Carries the v0.12.6 fix:

## v0.12.6 — fix: stateless Hindsight MCP broke memory onboarding fleet-wide

`switchroom apply` / `agent reconcile` silently failed to create every agent's Hindsight memory bank, bank mission, and user-profile mental model — `⚠ Failed to create Hindsight bank for <agent>: No session ID returned` for the whole fleet. Hindsight's MCP server runs **stateless by design** (`HINDSIGHT_API_MCP_STATELESS=true`) and returns no `mcp-session-id` header on `initialize` (the MCP spec makes it optional, and tool calls work statelessly), but the scaffold client *required* that header in all four memory-onboarding paths and hard-failed when it was absent. Latent fleet-wide since the stateless Hindsight container rolled out.

### Changes

#### Fixes

- **fix(memory):** the Hindsight client (`createBank`, `ensureUserProfileMentalModel`, `updateBankMissions`, `addMemoryTag`) now forwards `mcp-session-id` only when a stateful server actually returns one, and otherwise proceeds without it instead of hard-failing `"No session ID returned"`. The stateful path is unchanged (header still forwarded when present); the stateless path now completes memory onboarding. Regression tests updated to assert stateless tolerance and that the header is still forwarded on the stateful path. Do **not** "fix" this by flipping Hindsight stateful — that re-introduces the bounce-strands-sessions fleet outage. (#1515)

## v0.12.5 — admin agents get their admin CLAUDE.md; deterministic in-flight update status

Two fixes completing the in-Telegram admin-fleet-ops path (the klanker incident).

### Changes

#### Fixes

- **fix(scaffold):** admin agents now get the **admin branch** of their switchroom-managed `CLAUDE.md`. `buildWorkspaceContext()` — the template context the `switchroom apply` / `update_apply` / `agent restart→reconcile` render path uses — omitted top-level `admin`, while `profiles/default/CLAUDE.md.hbs` gates its "Admin operations" section on `{{#if admin}}`. So **every admin agent's CLAUDE.md rendered the non-admin `{{else}}` branch** ("You're NOT `admin: true` — hand fleet ops to a peer"), telling admin agents (klanker, carrie, test-harness) they were *not* admin and to refuse the fleet ops the operator wants them to run — and it never self-healed (fresh render == stale file → `apply` reported "up to date"). Fix mirrors the field into `buildWorkspaceContext` (single source with the reconcile path; the divergence that site's own comment warned about). On the next `apply` each admin agent's CLAUDE.md self-heals to the admin branch. (#1513)

#### Features

- **feat(gateway):** **deterministic, model-free in-flight status** for hostd `update_apply`. An admin agent's `/update apply` runs async in hostd for minutes and recreates the agent itself; previously the only signal was the content-free framework backstop ("still working… no update from agent in N min"). Now, while an update is in flight, that same backstop carries hostd's **real phase + elapsed** ("⏳ Fleet update in progress — phase: apply-config (~2m). …I'll report the result here when it's done.") sourced from a single-shot `get_status` (no model, no pinned card). Degrades byte-identically to the prior generic text if hostd is unreachable; the post-recreate terminal verdict was already in place. Serves the `know-what-my-agent-is-doing` JTBD. (#1512)

## v0.12.4 — fix: hostd `update_apply`/`apply` stranded the fleet (missing apply assets)

In-Telegram `/update apply` by an admin agent (→ hostd) silently failed and left the **whole fleet stranded on the old image** with the agent's turn wedged. hostd's image baked only the CLI bundle, not the assets `switchroom apply` resolves relative to the CLI module (`profiles/` via `resolve(import.meta.dirname,"../../profiles")`, and the vendored hindsight plugin). So hostd's `apply` died `Profile not found: default (searched /opt/switchroom/profiles)` **after `pull-images`, before `recreate-containers`**. (Agent images deliberately don't bake these either — agents never run `apply`; hostd is the one container that does.)

This makes the operator's intended flow reliable — admin agent initiates `/update apply` from Telegram, operator attests the card, fleet updates — with agents staying unprivileged (hostd remains the audited broker; no container gets host root).

### Changes

#### Fixes

- **fix(hostd):** `Dockerfile.hostd` now bakes `profiles/` → `/opt/switchroom/profiles` and `vendor/hindsight-memory/` → `/opt/switchroom/vendor/hindsight-memory` (exactly the paths the bundled CLI resolves at runtime), so hostd's in-container `apply` behaves like host-side. Plus a **fail-fast asset preflight** in `handleUpdateApply`/`handleApply`: if those assets are missing, hostd refuses with a clear actionable error **before pulling or changing anything** (same principle as the `--rebuild` guard) instead of pulling-then-stranding the fleet — and future-proofs the per-asset fragility. **The behaviour change ships in the rebuilt `switchroom-hostd` GHCR image**; the running daemon picks it up via `switchroom update`'s refresh-hostd step. (#1510)

## v0.12.3 — fix: the v0.12.2 `--rebuild` guard never fired on nvm/npm-global

v0.12.2's `--rebuild` published-install guardrail was ineffective on the exact install model it protects. It detected "source checkout" as *any* `.git` within 10 parent directories — but **nvm is itself a git clone** (`~/.nvm/.git` exists) and an npm-global install lives under `~/.nvm/…`, so the guard saw a `.git` ancestor and **allowed** `--rebuild` on a published host (a dotfiles `$HOME` git repo defeats it the same way). The guard now requires a directory that has **both** a `.git` (dir *or* file — git worktrees still count) **and** a `package.json` whose `name` is `switchroom`, at the same level — so nvm/dotfiles `.git` dirs and installed package dirs both correctly refuse, while real checkouts and worktrees are still allowed. Anyone on v0.12.2 should upgrade: until 0.12.3, `update --rebuild` on a published host silently drifts it off the released artifacts instead of refusing.

### Changes

#### Fixes

- **fix(update):** `--rebuild` guard requires an actual switchroom source checkout (`.git` + switchroom `package.json` at the same dir), not any `.git` ancestor — closes the v0.12.2 defect where nvm's own `~/.nvm/.git` (and dotfiles `$HOME/.git`) made every npm-global install look like a checkout and the guard never fired. New `runningFromSwitchroomCheckout()`; `isGitCheckout` retained (unused by the guard) so nothing else regresses; refusal message corrected. Verified live on a published host. (#1508)

## v0.12.2 — published-install guardrail for `update --rebuild`

`switchroom update --rebuild` (git pull + build from source) is a source-checkout / maintainer-only operation. On a published install (npm-global / GHCR-image host) it is now **hard-refused fail-fast**: a preflight in `runUpdate` refuses *before any step runs* (and before the `--check` plan) with exit 2 and the correct remediation — `npm i -g switchroom@latest && switchroom update`. Previously it died mid-pipeline (after `pull-images`) with advice ("invoke from a source checkout") that's wrong for a consumer host. Source checkouts — including git worktrees — are byte-unchanged; this only makes a published host structurally un-driftable off the reviewed, CI-published release via that flag.

### Changes

#### Fixes

- **fix(update):** `--rebuild` hard-refuses on a published install (fail-fast preflight, exit 2, nothing runs) with the published-path remediation; shared `rebuildRefusalMessage()` is the single source of truth (preflight + in-step defence-in-depth); header/option help corrected (it claimed "auto-skipped"; it refuses). Maintainer source-checkout behaviour unchanged. (#1506)

## v0.12.1 — Claude-native skill authoring; doctor/vault-broker hardening

Headline: skill authoring is now **Claude-native and gated by review, not by tooling**. An agent creates a skill for itself the same way anyone uses Claude — it writes files into its own `$CLAUDE_CONFIG_DIR/skills/<slug>/` (persistent, reconcile-safe, discovered next session), guided by the bundled `skill-creator` skill and a non-blocking validator hook. There is **no** skill-authoring/publish tool, CLI, or broker write path. Sharing a skill with the rest of the fleet is a **reviewed pull request** (it becomes a bundled-default, opt-out per agent, or a `skills:`-cascade entry from `switchroom.skills_dir`), distributed by the normal reconcile path — never a runtime action. Also: more honest `doctor` visibility and several vault-broker ACL correctness fixes.

### Changes

#### Features

- **feat(skill-author):** native-by-default skill authoring. Agent-scope skills are authored with plain `Write`/`Edit` into `$CLAUDE_CONFIG_DIR/skills/<slug>/`; a non-blocking `PreToolUse` linter nudges toward a well-formed skill (the only hard stop is the 2 MiB per-skill cap). The deprecated `skill_create/edit/read/delete` MCP + CLI shim was **removed** (closing the `--version`-shadowing bug class, #1492). An interim runtime `skill_publish`/`skill_unpublish` path was added and then **removed** in favour of review-via-PR — net: no privileged runtime authoring or publish path exists. Fleet-wide sharing = a reviewed PR (bundled-default opt-out via `bundled_skills`, or `skills:` cascade). See [docs/skills.md](docs/skills.md); design record in [docs/rfcs/skill-authoring-native.md](docs/rfcs/skill-authoring-native.md). (#1490–#1502)
- **feat(doctor):** hostd visibility + image-drift WARN (#1471); vault operator-lockout + per-agent secret-access ACL surfacing (#1473).
- **feat(compose):** pin the Claude runtime version for the immutable 24/7 fleet — perf + correctness.

#### Fixes

- **fix(vault-broker):** fall through to the standing ACL when a presented token is unusable (`get`/`list`); an agent may read its OWN configured `bot_token`; generous `unlock` timeout — no false "Timeout" on a slow decrypt (RFC J Phase 4b).
- **fix(gateway):** `vault_request_access` short-circuits when a standing ACL already covers the key.
- **fix(apply):** restore operator ownership of `~/.switchroom` after a self-elevated apply (#1473).
- **fix(docker):** bake the switchroom CLI into the broker image — RFC J Phase 3b (#1485).
- **fix(auth):** remaining user-facing `--from-oauth` → `--via-claude` (doctor + setup).
- **fix(boot-probes):** `/status` lists every skill bucketed by source (#1467).
- **fix(doctor):** MFF probes are per-agent + WS6-F2 agent-private aware.
- **fix(privacy):** scrub operator PII from the tracked tree; extend the PII regression gate (incl. an `sk-ant` rule).
- **fix(ci):** drop the broken docker-smoke spike that permanently failed promote-to-dev.

#### Internal

- **chore(deps):** GitHub Actions bumps — checkout, setup-node, setup-python, paths-filter, docker/build-push-action.
- **docs(readme):** align with the v0.12.0 architecture + command surface.

## v0.12.0 — user-owned SOUL.md + broker healthcheck honesty + legacy-state deprecations

Headline: agent persona (`workspace/SOUL.md`) becomes a user-owned, seed-once file — switchroom seeds it once and never overwrites it again, matching the OpenClaw/Hermes "my persona sticks" expectation while the machinery (`CLAUDE.md`) keeps propagating fleet-wide. Also: the vault-broker healthcheck now reports honestly (a locked/never-unlocked broker reads unhealthy instead of false-healthy), the operator unlock hint is corrected, and the long-lived `clerk → switchroom` rename shims are scheduled for removal. No automatic state migration is performed.

### Changes

#### Features

- **feat(persona):** `workspace/SOUL.md` is now **user-owned** — seeded once (from the setup wizard's new per-agent persona prompts, or the profile `SOUL.md.hbs` + `soul:` config when skipped) and then **never overwritten** by `apply`/`reconcile`/`update`. This is the deliberate inverse of the root `CLAUDE.md`, which stays switchroom-managed so machinery/template updates keep propagating fleet-wide. New `switchroom soul {path,show,reset}` verb; `soul reset <agent>` re-seeds from the agent's current profile after backing the existing file up to `SOUL.md.bak`. `soul:` config and profile `SOUL.md.hbs` are now seed-time inputs only. See [docs/configuration.md § Persona & SOUL.md ownership](docs/configuration.md#persona--soulmd-ownership). (#1458)
- **feat(update-flow):** end-to-end release-channel/pin redesign. A `release` config block (`channel: dev|rc|latest` *or* `pin: sha-…|vX.Y.Z`, mutually exclusive, per-agent REPLACES root) at every cascade layer (#1415); `switchroom apply --channel/--pin` + `resolveImageTag()` threading the resolved tag into compose/CLI/hostd/MCP (#1431); gateway boot-card surfaces the last `update_apply` audit outcome and honors `channels.telegram.enabled` in `start.sh` (#1456); dual-tag (`:dev` + `:sha-<7>`) docker-images workflow + operator `promote.yml` (dev→rc→latest, retag-without-rebuild) (#1461).
- **feat(vault):** auto-unlock is the unattended default — RFC J Phase 1 (#1454).
- **feat(auth-google):** native Google Drive onboarding — self-documenting `auth google connect` wizard (#1344), opt-in Drive **write** scope via `--write` (#1354), refresh-token seed launcher + per-agent scaffold wiring (#1355).
- **feat(web):** dashboard build-out — auth-broker/hindsight/hostd health (#1359), Google Workspace + cron Schedule panels (#1360), read-only Approvals kernel-ledger panel (#1363), real per-account usage % + Summary tab (#1381).
- **feat(audit):** tamper-evident hash-chain for the vault and hostd audit logs — sec WS10-F2 (#1433).
- **feat(doctor):** flags inlined plaintext secrets in `switchroom.yaml` — sec WS6-F3 (#1434).
- **feat(kernel):** read-only host operator socket, deny-by-default (#1362).
- **feat(telegram):** automatic HTML→plaintext fallback on a Telegram 400 parse-reject (#1356).
- **feat(scheduler):** boot-time notice for runs dropped past the replay window (no more silent drops); deprecate the unused `model:` schedule field; rebuilt scheduling docs (#1424).
- **feat(agent-config):** restart-required readback on `skill_install` / `schedule add` / `schedule remove` (#1430).
- **feat(hostd-audit):** persist stderr/stdout tails so failed mutations survive a container recreate (#1351).

#### Fixes

- **fix(install):** fresh-install agents now boot authenticated end-to-end — `createMinimalClaudeConfig()` writes `hasCompletedOnboarding:true`, install docs reorder auth after fleet-up (the 2026-05-17 blank-server validation wedge) (#1422).
- **fix(setup):** persist per-agent bot tokens to the vault (#1428); bootstrap config to `~/.switchroom` mirroring `findConfigFile` (#1426).
- **fix(vault-broker):** route the host CLI to the containerized broker — RFC J Phase 3 (#1457).
- **fix(oauth):** correct device-code client type + 401 `invalid_client` tier-fallthrough (#1352).
- **fix(quota):** align `/auth show` + boot card on the broker-canonical quota (#1345).
- **fix(auth-google):** `account add` resolves `vault:` refs via the broker (#1348); connect wizard writes secrets via the vault-broker, not the file (#1347).
- **fix(drive-mcp):** reliability hardening closing the silent-failure class (#1368); doctor EACCES false-positive + pin-regression (#1369); pin `USER_GOOGLE_EMAIL` to the seeded account (#1367); pin `aiofile==3.8.8` via `uvx --with` (#1365); correct uvx exec name `workspace-mcp` (#1364); inject gdrive into `.mcp.json` not just `settings.json` (#1358); sanitize Pydantic anyOf-root input schemas + boot tool validation (#1388).
- **fix(scaffold):** wire gdrive MCP env + trust scaffolded servers (#1366); honor `SWITCHROOM_MEMORY_BACKEND=none` (#1425).
- **fix(docker):** install `uv`/`uvx` in the agent image — the Drive MCP launcher needs it (#1361).
- **fix(web):** dashboard caught up with v0.7 Docker + RFC-H migrations (#1357); usable under fleet load — batched docker status + tailscale-serve origin (#1380).
- **fix(build):** ship the web dashboard UI in the bundled CLI (`dist/cli/ui`) (#1374).
- **fix(examples):** one bot per agent — ship 1 active agent, others commented with their own `bot_token` (#1423).
- **fix(codex):** correct pre-Docker assumptions on live agent/operator paths (#1376).
- **fix(docs):** `vault.md` wrongly said `set` auto-creates the store (#1379).

#### Security (epic #1400 / workstream hardening)

- **fix(gateway):** require operator authz on the `apv:` approval callback (WS7-F1, #1404); fleet-admin verbs operator-private (WS7-F2, #1408); `/auth` operator-private (WS7-F2b, #1414).
- **fix(hostd):** harden `agent_exec` argv — `--` separator + NUL/CR/LF rejection (#1411); reject all C0/DEL controls + cap argv element size (#1429).
- **fix(scaffold):** de-pre-approve mutating hostd MCP verbs (#1427).
- **fix(approval-kernel):** listener-identity ACL on consume/revoke/record + 128-bit request ids (#1406).
- **fix(auth-broker):** symlink-guard the per-agent credential mirror (#1409).
- **fix(compose):** per-agent `credentials/` scope + migration-safe doctor warn (WS6-F2, #1407); UID-collision hard-fail + non-root agent image + logdir perms (WS6-F4/F5/F6, #1435).
- **fix(atomic):** `O_NOFOLLOW` + `O_EXCL` on the broker tempfile open (#1444).
- **fix(audit,doctor):** canonical `agent_name` attribution + audit-integrity doctor check (WS10-F6/F4, #1436).
- **fix(agent):** image-baked unstrippable security-hooks plugin (WS8-F1, #1432).
- **feat(sec):** opt-in strict inter-agent network isolation (WS6-F1, #1446).
- **ci(security):** close the sentinel path-filter blind spot + SHA-pin all actions (WS9-F1/F6, #1405); image provenance/SBOM + base images pinned `@sha256` (WS9-F3/F4, #1437).
- **docs(CLAUDE.md):** reconcile CI/governance prose to actual posture (WS9-F2, #1412).

#### Reliability / Ops

- **fix(supervisor):** exponential backoff + never-give-up restart policy — RFC J Phase 2 (#1453).
- **fix(broker):** honest, fail-closed healthcheck (a locked/never-unlocked broker reads **unhealthy** instead of false-healthy — the 2026-05-17 install-validation failure mode); corrected operator unlock hint to `switchroom vault broker unlock` — RFC J Phase 4a (#1455).
- **ci:** real sentinel pattern for required checks — docs-only PRs hard-block, fixes #1331 (#1350).

#### Docs

- **docs(audit):** repo-wide documentation audit across all tiers — onboarding-breaking + operator-hazard defects (#1385), hygiene + structure (#1386), coverage gaps + reference Status banners (#1387).
- **docs:** RFC J spec — vault-broker resilience & default auto-unlock (#1450); code-grounded diagram regeneration specs (#1343); `applyCronChangesHot` prose corrected (#1459); retire pre-Docker / pre-RFC-H narrative in user docs + agent CLAUDE.md/skills (#1378, #1377); Drive access model corrected + stale pin literals retired (#1371).

#### Chore / CI

- **chore(deps):** GitHub Actions major-version bumps — `actions/upload-artifact` 4→7, `actions/download-artifact` 4→8, `docker/login-action` 3→4, `docker/setup-qemu-action` 3→4, `docker/setup-buildx-action` 3→4 (Node24 runtime; shared Artifacts-v4 backend, no workflow behavior change) (#1439–#1443).
- **fix(ci):** constrain Dependabot docker to digest/patch, not Node major bumps (#1460).
- **chore/test:** Tier-1/2 dead-code + stale-comment cleanup + CI-eval-summary fix (#1370, #1372); strip residual Buildkite cruft post-GHA-cutover (#1353); evals cover restart-required readback + skip-notice guidance (#1452); docker tests pass `--user 0` to read-only-rootfs + cap_drop probes (#1451); sharpen auth-google edge-case messages (#1349).

#### Deprecations

- **deprecate(state):** `switchroom doctor` now WARNs (exit 0) when legacy `~/.clerk` state or the v0.6 host-side `~/.switchroom/vault-broker.sock` is present; any CLI/agent invocation that reads from `~/.clerk` emits a one-time stderr deprecation notice. These back-compat shims (`src/config/paths.ts` dual-read, the top-level `clerk:` switchroom.yaml alias, and `src/vault/broker/client.ts` `LEGACY_SOCKET_PATH`) are **REMOVED in v0.13.0** (#1373).
- **schema:** the `model:` field on a `schedule:` entry is documented DEPRECATED/IGNORED post cron-fold-in (kept optional, non-breaking) (#1424).

### Upgrade notes

- **RFC J — vault auto-unlock is now the unattended default (#1454).** A broker with a machine-bound auto-unlock blob unlocks itself on boot with no operator interaction. Hosts that deliberately want interactive-only unlock must opt out; review RFC J (#1450) before upgrading where unattended unlock is unacceptable.
- **RFC J — broker healthcheck is fail-closed (#1455).** A locked or never-unlocked broker now reads **unhealthy** (was false-healthy). Empty-fleet/path-as-identity semantics unchanged; expect previously-green-but-locked brokers to flip to unhealthy until unlocked. The operator unlock hint is now `switchroom vault broker unlock` (the old `switchroom vault unlock` string is gone).
- **RFC J — supervisor never gives up (#1453).** The broker/kernel supervisor now backs off exponentially and retries indefinitely instead of restart-capping. A persistently-failing dependency is retried forever rather than left dead — monitor logs after upgrade.
- **Opt-in strict inter-agent network isolation (#1446).** New and **opt-in** (default unchanged: `network_mode: host`, shared host netns). Operators wanting inter-agent isolation must explicitly enable it; review the tradeoffs before flipping.
- **Security epic #1400 — operator-private surfaces.** `/auth` (#1414), fleet-admin verbs (#1408), and the `apv:` approval callback (#1404) now require operator authz; mutating hostd MCP verbs are no longer pre-approved (#1427). Non-operator chats that previously reached these will now be denied — confirm your operator identity is configured.
- **Security epic #1400 — non-root agent image + UID-collision hard-fail (#1435).** The agent image is now non-root and a UID collision is a hard failure (was a silent overlap). On `apply`/`update`, a previously-tolerated UID collision will now block — resolve duplicate agent UIDs before upgrading.
- **Security epic #1400 — per-agent `credentials/` scoping (#1407).** Compose now scopes credentials per-agent with a migration-safe doctor warn. Run `switchroom doctor` after upgrading and address any credential-scope warnings.
- **Security epic #1400 — plaintext-secret doctor flag (#1434).** `switchroom doctor` now flags inlined plaintext secrets in `switchroom.yaml`. Move flagged secrets into the vault (`switchroom vault`) — these surface as new doctor findings on first run post-upgrade.
- **Security — base images pinned `@sha256` + provenance/SBOM (#1437).** Image pulls now resolve to pinned digests; air-gapped/mirror operators must ensure the pinned digests are available in their registry mirror.
- **Update-flow redesign — new `release` config block (#1415/#1431/#1456/#1461).** New optional `release: { channel | pin }` at every cascade layer; per-agent `release` REPLACES root (does not field-merge). Default unchanged (`latest`), but operators adopting channels/pins should note the replace-not-merge semantics. The `:dev`/`:sha-<7>` tags and the operator `promote` workflow are now live.
- **Install flow reordered (#1422).** `docs/install.md` now brings the fleet up *before* authenticating (the auth-broker is the sole credential writer and does not exist until `up`). Operators following the old order on a fresh install must use the new order.
- **SOUL.md ownership flip (#1458).** Existing `workspace/SOUL.md` files freeze in place as user-owned on first `update` (no content lost); `soul:`/profile changes no longer propagate to running agents on reconcile — edit `workspace/SOUL.md` directly, or run `switchroom soul reset <agent>` to re-seed. The stale `SOUL.md.fingerprint` sidecar becomes vestigial.
- **Legacy `~/.clerk` shims removed in v0.13.0 (#1373).** This release only WARNs. Before upgrading to v0.13.0: `mv ~/.clerk ~/.switchroom` and rename any top-level `clerk:` key in `switchroom.yaml` to `switchroom:` — there is no automatic migration (v0.13.0 treats un-migrated state as a fresh install).
- **Dependabot docker constrained to digest/patch (#1460).** Node major-version bumps via Dependabot docker are now blocked; major base-image moves are deliberate manual changes going forward.

## v0.11.1 — hostd default-on + CI infra-resilience follow-ups

A small follow-up release: RFC C Phase 2 flips the host-control daemon on by default (so `/restart`, `/new`, `/reset`, `/update apply` work on docker-mode installs without per-install opt-in), `/audit hostd` gets its bind-mount, and the GHA queue-fail class (#1336) gets a manual recovery lever plus an alert backstop.

### Changes

#### Features

- **feat(host-control):** RFC C Phase 2 default-flip — `host_control.enabled` defaults to `true` (#1338). An absent `host_control` block now resolves to enabled. Migration-safe: the `existsSync` guard on `~/.switchroom/hostd/<name>` means installs without hostd don't get a broken bind-mount and `compose up` doesn't hard-fail. Operators on legacy systemd-mode installs set `host_control: { enabled: false }` explicitly.
- **feat(auth-broker):** probe-quota op — route `/auth show` quota probes through the broker (#1336).

#### Fixes

- **fix(audit-hostd):** Bind-mount `host-control-audit.log` :ro into admin agents so `/audit hostd` (#1328) can tail privileged-verb history from DM (#1337). Mirrors the vault-audit.log mount pattern; admin-gated; `existsSync`-guarded for fresh installs.

#### CI infra-resilience

- **ci(docker-images):** `workflow_dispatch` recovery trigger so `:latest` can be republished after a GHA queue-fail without another push to main (#1339), plus the same trigger added to the push-gated test workflows (#1340). The tag-computation steps treat a `workflow_dispatch` on `main` like a `push` (full multi-arch, `:latest` + `:sha-<short>`).
- **ci:** `ci-infra-watchdog` — alert-only backstop that distinguishes a GHA queue force-fail (workflow concluded `failure`, zero jobs with `conclusion==failure`) from a genuine regression and opens/de-dupes a `ci-infra-failure` issue so main-red-on-infra is visible in minutes, not hours (#1341).

### Upgrade notes

- `switchroom update` handles the rollout. The #1338 default-flip means admin agents pick up the hostd UDS bind-mount on the next `apply` **if hostd is installed** (`~/.switchroom/hostd/<name>` exists); installs without hostd are unaffected. No image changes beyond the v0.11.0 set.

## v0.11.0 — Drive write-preview lands + hindsight production-hardening + GHA primary CI

The RFC E (Google Drive) write-preview path goes end-to-end: a PreToolUse hook intercepts Drive writes, posts a diff-preview card to Telegram, and waits for approval before letting the model proceed. Hindsight ships its first real-deploy survival kit after a single install loop surfaced five separate latent bugs. CI flips to GitHub Actions as primary (Buildkite stays as a backup) and picks up shared-dist + cache speedups.

### Headline benefits

- **Drive write-preview, end-to-end (RFC E §4.2).** When the model wants to mutate a Drive file (`docs:edit`, `docs:append`, `sheets:update`, `sheets:append`), a PreToolUse hook (#1319) intercepts the call, builds a write-preview spec via the Docs API client (#1316), renders a diff card in Telegram (#1299), and gates the actual write on operator approval (#1295 ships the Open-in-Drive button on granted cards). The reconciler driver (#1307, #1300) closes the loop on background recovery for orphaned approval requests. Folder picker primitives (#1296) and the `/folders` slash command (#1308) let an operator pin Drive scopes per agent. Scope namespace (#1290) and edit-prep helpers (#1297) round out the surface.
- **Hindsight production-hardening.** Five-bug fix from the first real install (#1309) covering CI matrix gaps, Dockerfile uv-vs-pip drift, COPY-chmod dir-mode propagation, tmpfs UID/GID, and per-consumer volume-name prefix mismatch. Stateless MCP (#1326) closes the failure class where bouncing hindsight strands every agent's MCP session. Earlier in the same install loop: pre-create the parent dir before `COPY --chmod` (#1315), use `uv pip install` instead of the nonexistent venv pip (#1311), pin the LLM model to `claude-sonnet-4-6` (#1312), publish `switchroom-hindsight` to GHCR (#1310), query the auth-broker container for the hindsight socket (#1313).
- **Hostd Phase 2 gateway swap (#1306).** Telegram-side `/update apply` now talks to the host-control daemon over UDS instead of trying to docker-shell-out from inside the agent container. Closes the silent failure when an operator triggered apply from chat and got an opaque exit-127 instead of a clean error. `/audit hostd` (#1328) gives the operator a read-only command + CLI to inspect the hostd audit log.
- **GHA as primary CI (#1320).** Dual-run alongside Buildkite landed last release; this release flips the badges (#1322), gates main on the GHA checks, and adds the skip-as-pass pattern (#1331) so narrow-scope PRs don't get blocked by path-filtered required checks. Shared-dist + vitest --changed + docker image cache (#1323) take the typical PR-build wall-clock down materially. Docker image builds skip arm64 on PRs and gain cache mounts (#1330).
- **Telegram-plugin polish.** Silence-poke state drain on flush-backstop turn-end (#1293), post-reply tail flush on substantive terminal text after a soft-commit reply (#1298), sandbox-hint false-positive suppression on successful tools (#1304), tool-aware silence-poke fallback message (#1301).
- **Auth UX (#1317 / #1329).** New Format 2 `/auth` panel + causal auto-fallback. Four follow-ups stabilize the gate primitive, broker honesty, refresh throttle, and retire the legacy poller.

### Changes

#### Features

- **feat(drive):** Folder picker primitives — list + cache + card (#1296)
- **feat(drive):** Folder-picker Telegram glue — `/folders` + `drvpick:` callbacks (#1308)
- **feat(drive):** RFC E §4.2 scope namespace `doc:gdrive:suggest:*` (#1290)
- **feat(drive):** Edit-preparation helpers for the four MCP write tools (#1297)
- **feat(drive):** Open-in-Drive button on granted approval cards (#1295)
- **feat(drive):** Telegram renderer for the diff-preview card (#1299)
- **feat(drive):** Docs API client + write-preview spec builder — RFC E §4.2 PR-2A (#1316)
- **feat(drive):** Gateway IPC verb that posts the diff-preview card — PR-2B (#1318)
- **feat(drive):** PreToolUse hook + scaffold registration — PR-2C (#1319)
- **feat(drive):** Reconciler driver loop, kernel-agnostic core — RFC E §4.4 (#1307)
- **feat(drive):** Recovery wiring helpers — audit + digest + nudge (#1300)
- **feat(hostd):** Complete Phase 2 gateway swap — close silent `/update apply` (#1306)
- **feat(audit):** `/audit hostd` Telegram command + `switchroom hostd audit` CLI (#1328)
- **feat(auth-ux):** Format 2 `/auth` + causal auto-fallback + dispatch fix (#1317)

#### Fixes

- **fix(hindsight):** Five PR #1266 bugs surfaced by the first real deploy (#1309)
- **fix(hindsight):** Enable stateless MCP so hindsight bounces don't strand agent retain (#1326)
- **fix(hindsight):** Pre-create `/usr/local/lib/switchroom` with 0755 — dir-mode bug (#1315)
- **fix(hindsight):** Use `uv pip install` instead of nonexistent venv `pip` (#1311)
- **fix(hindsight):** Pin LLM model to `claude-sonnet-4-6` — switchroom default (#1312)
- **fix(doctor):** Query auth-broker container for hindsight socket, not host (#1313)
- **fix(rfch):** Harmonise boot-probe hints + `/status` auth panel on RFC H verbs (#1327)
- **fix(auth-ux):** Four follow-ups to #1317 — gate primitive + broker honesty + refresh throttle + retire poller (#1329)
- **fix(telegram-plugin):** Drain silence-poke state on flush-backstop turn-end (#1293)
- **fix(telegram-plugin):** Flush post-reply tail when model emits substantive terminal text after a soft-commit reply (#1298)
- **fix(telegram-plugin):** Tool-aware silence-poke fallback message (#1301)
- **fix(telegram-plugin):** Suppress sandbox-hint false positives on successful tools (#1304)
- **fix(ci):** Three GHA followups — plugin test relocation, evals cache, docker-e2e composite (#1321)
- **fix(ci):** Restore exec bits on shared dist/ artifact (#1332)

#### CI / Performance

- **ci(gha):** Dual-run CI on GitHub Actions alongside Buildkite (#1320)
- **ci(gha):** Skip-as-pass pattern for flexible required checks on narrow-scope PRs (#1331)
- **ci(docker-images):** Publish `switchroom-hindsight` to GHCR (#1310)
- **perf(ci):** Three speedups — shared dist/, `vitest --changed`, docker image cache (#1323)
- **perf(docker):** Three image-build optimisations — skip arm64 on PRs, cache mounts, COPY reorder (#1330)

#### Docs / chore

- **docs:** Drop retired `switchroom-scheduler` references (#1294)
- **docs(drive):** `google-workspace.md` user guide + RFC G/E tracking refresh (#1302)
- **docs(rfc-e):** §4.2 amendment — Path A Cut 2 implementation pivot (#1324)
- **docs(readme):** Swap Buildkite badges for GitHub Actions (#1322)
- **docs(claudemd):** Add CI section — GHA primary + gating, Buildkite informational (#1325)
- **chore(auth-fallback,docs):** Retire dead exports + tick RFC E checklist (#1333)

### Upgrade notes

- **`switchroom update` handles the rollout.** Pulls new images (broker, kernel, agent, auth-broker, hostd, hindsight), regenerates compose, recreates containers, stamps restart markers, and runs doctor. No manual `docker compose` is needed.
- **Hindsight host migration.** The v0.10.0 → v0.11.0 update changes the per-consumer broker-socket volume name from `switchroom_auth-broker-hindsight-sock` to `auth-broker-hindsight-sock` (#1309). After `switchroom update`, the old prefixed volume is orphaned; `docker volume rm switchroom_auth-broker-hindsight-sock` cleans it up. The canonical `switchroom memory setup` path now works without any manual `docker run -v ...` workaround.
- **MCP stateless mode.** Hindsight's MCP server now runs in stateless HTTP mode by default (#1326). Operators with bespoke MCP clients that need streaming can override via `docker run -e HINDSIGHT_API_MCP_STATELESS=false`.

## v0.10.0 — Google Workspace via the auth-broker + RFC H tail-fixes

RFC G Phase 3b lands: a Google account is a first-class auth slot alongside the Anthropic accounts RFC H introduced in v0.9.0. The same broker that owns Anthropic OAuth refresh now owns Google OAuth refresh, per-account ACLs, and per-agent / per-consumer credential fan-out. Plus a tail of RFC-H hardening closing two silent-failure regressions that bit the 2026-05-14 install-validation loop.

### Headline benefits

- **Google Workspace per agent (or per fleet).** `switchroom auth google account add <label>` runs an OAuth flow against Google and registers the resulting refresh token with the broker. Agents that need Drive / Gmail / Calendar get a per-agent socket bound at `/run/switchroom/auth-broker/<agent>/sock` and a `get-credentials provider=google` op that mints a fresh access token on demand — same protocol shape as Anthropic credentials.
- **Per-account ACLs.** The `switchroom auth google enable/disable/list` verbs (shipped in #1247 during the v0.9.x window) now have a working broker behind them: Google credentials are actually mintable, and the per-account ACL gates real `get-credentials` calls. Default is **deny** — adding the account doesn't grant fleet-wide access. The setup wizard's Phase 4 prompt (#1248, also v0.9.x) likewise becomes operative this release.
- **Refresh races eliminated for Google too.** The broker holds an exclusive refresh lease per Google account (#1275). Production-hardened: jitter, backoff, lease release on SIGTERM, audit lines for every refresh outcome.
- **`switchroom auth add <label> --via-claude`** (#1286). Broader OAuth scopes than `setup-token` ships with — useful for accounts that need to operate hindsight or other broker consumers without re-running setup. Goes through the `claude` CLI's OAuth flow with the wider scope set, then registers the credentials with the broker.
- **Silent-failure regressions closed.** Two RFC-H aftershocks that bit during the v0.9.0/v0.9.1 install-validation loop are now structurally impossible:
  - Account credentials written without `scopes` / `subscriptionType` claims caused the fleet to boot as "Not logged in" because claude rejected the credential shape. Fixed in #1280 (enrich on write) and reinforced in #1285 (mirror-time enrichment closes the residual boot gap).
  - The broker didn't fan credentials out to per-agent mirrors at boot — only on add. Empty mirrors at boot showed up as fleet-wide auth failures after `switchroom update`. Fixed in #1277 (fanout at boot + wire `SWITCHROOM_AUTH_BROKER_OPERATOR_UID` end-to-end).

### CLI changes

- **`switchroom auth google account add <label>`** (#1274) — real OAuth flow + broker registration. Replaces the stub from RFC G Phase 3b.3.
- **`switchroom auth google account list`** (#1279) — broker-backed list of registered Google accounts, surfacing label, scopes, refresh status.
- **`switchroom auth google enable <agent> <label>`** / **`disable`** / **`list`** — per-account ACL controls (verbs landed in #1247 in v0.9.x; behind them, the get-credentials path is functional as of this release).
- **`switchroom auth add <label> --via-claude`** (#1286) — broader-scope OAuth via the `claude` CLI flow.
- **`switchroom auth use <label>`** + **`auth rotate`** now write `auth.active` to YAML (#1282) — previously these mutated broker state but left `switchroom.yaml` stale, so the next `switchroom apply` would re-bind the old active account. Closes a recurrence of the silent fanout class.
- Stale RFC-pre-H references removed: `auth login`, `auth status` no longer appear in CLI help, docs, or doctor output (#1283).

### Auth-broker internals

- `wrapper-broker.ts` (#1273) — client-side helper that wraps a consumer process and feeds it credentials minted by `get-credentials`. Used by hindsight, the example `personal-google-workspace-mcp` (#1245, shipped in v0.9.0), and forthcoming Drive / Gmail integrations.
- `--operator-uid` flag wired through the compose command (#1278) — the broker needs the host operator UID to chown per-agent socket dirs correctly during boot fanout.
- Audit-log SIGKILL-safety + `AuthCommandContext` rename (#1284) — buffered audit writes now flush on SIGTERM and survive SIGKILL via a fsync-on-write fallback path. Internal rename clarifies the operator-vs-agent caller boundary.
- Test pinning: auth-broker operator-command volume gating is now covered by `tests/docker/compose-generator.test.ts` (#1281).

### Reconcile + scaffolding

- `switchroom apply` regenerates `CLAUDE.md` silently on template drift (#1276). Previously a noisy "drift detected" message fired on every apply when the template had moved underneath an unchanged scaffold. The check + re-render still happens; just stays quiet.

### CI / test infra

- **Fuzz harness promoted to a Buildkite PR gate** (#1145) — the corpus-driven harness from #1132 / #1134 now runs on every PR via Buildkite, blocking merge on regression. Complements the existing GitHub Actions e2e gate.
- **Boot-probes test alignment** (#1287) — `nextStep` assertions now use RFC-H vocabulary (`account`, `consumer`, `fanout-mirror`) instead of pre-H legacy terms.

### Docs

- `docs/auth.md` — Google sections added covering the `auth google` verb tree, per-account ACL semantics, and the broker `get-credentials provider=google` protocol.
- `docs/rfcs/auth-broker.md` — RFC G v3 cross-referenced.
- Install-validation Phase 1-4 retrospective at `docs/install-validation-2026-05.md` (#1253) — what broke during the fresh-VM install loop, what fixed it, and the doctor probes that now catch each class.

### Migration

No-op for Anthropic-only operators — the RFC-H surface from v0.9.0 is unchanged. Operators adding Google:

1. `switchroom auth google account add <label>` and complete the OAuth flow.
2. `switchroom auth google enable <agent> <label>` for each agent that needs the account (default-deny).
3. `switchroom apply` to bind the new sockets.
4. Agent containers pick up the new credentials at next restart.

Per RFC §6, no compatibility shims — agents on a pre-v0.10.0 image are unaffected (they don't ask the broker for Google credentials).

## v0.9.1 — `switchroom-hindsight` on the auth-broker: no API key needed

`reference/vision.md`'s **subscription-honest, no-API-key-routing** outcome reaches the memory backend. Hindsight (the bundled long-term-memory container) now runs against an Anthropic OAuth account that switchroom is already managing on the operator's behalf — the OpenAI API key prompt, vault entry, and `-e HINDSIGHT_API_LLM_API_KEY=...` plumbing are all gone.

### What changed

- Hindsight is now a first-class **auth-broker consumer** (RFC H §4.8). Declare it once in `switchroom.yaml`:
  ```yaml
  auth:
    active: me@example.com
    consumers:
      - name: hindsight
        account: me@example.com
        uid: 11000
  ```
  `switchroom apply` binds `/run/switchroom/auth-broker/hindsight/sock` chowned to UID 11000. The setup wizard adds this entry automatically.
- New image `ghcr.io/switchroom/switchroom-hindsight:latest`, built from `docker/Dockerfile.hindsight`. Extends upstream `vectorize-io/hindsight:latest` with `claude-agent-sdk` (the Python SDK the upstream `claude-code` provider needs) and the `@anthropic-ai/claude-code` CLI on PATH.
- New entrypoint shim `docker/hindsight-entrypoint.sh` fetches OAuth credentials from the broker over UDS at every boot, writes them to a tmpfs dotfile at `/run/claude-creds/.credentials.json`, exports `CLAUDE_CONFIG_DIR`, and exec's into the upstream `/app/start-all.sh`. The credentials never touch persistent disk; the broker remains the single writer of OAuth state.
- `HINDSIGHT_API_LLM_PROVIDER` is pinned to `claude-code`. Memory consolidation and recall now consume Pro/Max session turns on the chosen account — operators with heavy retain can split memory onto its own account with `agents.<name>.auth.override`.

### Doctor

- New probe `hindsight consumer`: warns when `auth.consumers[]` has no `hindsight` entry or the per-consumer socket hasn't been bound yet. Replaces the pre-#1245 `hindsight env leak` probe (the OpenAI-key shape it watched for is no longer in the runtime path).

### Setup wizard

- Step 6 (memory backend) no longer prompts for an OpenAI API key. It registers the hindsight consumer in `switchroom.yaml`, surfaces a one-liner if a stale `HINDSIGHT_API_LLM_API_KEY` env or `hindsight-api-key` vault entry is still around (no longer used; safe to delete), and starts the container in broker-fed mode.

### Migration

Operators on v0.9.0 with a running hindsight container should `switchroom memory --stop` and re-run `switchroom setup` (or manually add the `auth.consumers[]` entry and re-`apply`). No in-place migration shim — per RFC §6, the no-compatibility-shims stance applies.

## v0.9.0 — `switchroom-auth-broker` (RFC H): single-writer OAuth plane

Big release. RFC H operationalises `reference/share-auth-across-the-fleet.md`: the **Anthropic account becomes the unit of authentication**, not the agent. One OAuth flow per account drives N agents. A new singleton container, `switchroom-auth-broker`, owns the refresh loop, per-agent credentials.json mirrors, and per-account quota state. Net diff is **−6,771 LOC** — the cleanup is the win, not just the new daemon.

### Headline benefits

- **One OAuth flow per Anthropic account, not per agent.** Six agents on one Pro subscription used to mean six `claude setup-token` invocations and six independent refresh cycles. Now: `switchroom auth add <label> --from-oauth` once, then every agent that uses that account just works.
- **Quota events propagate in seconds.** When one agent gets 429, the broker marks the account exhausted and fans every co-account agent over to its fallback. No more six-agents-rediscover-the-same-wall.
- **Fleet-wide active account is one verb.** `switchroom auth use <label>` swaps every agent to the new account. The Telegram twin `/auth use <label>` (admin agents only) is the same thing.
- **Per-agent override is the edge case.** Most agents have no `auth:` block in `switchroom.yaml`. Agents that need a different account from the fleet get `agents.<n>.auth.override: <label>`.
- **Visibility.** `switchroom auth show` (and `/auth show` in any agent's chat) prints accounts + agents + consumers + expiries + quota state in one screen. The old `auth status` was empty rows.
- **Refresh races eliminated.** The single-use Anthropic refresh-token endpoint was racing every time multiple consumers refreshed concurrently; the loser silently got an invalid token. Broker holds an exclusive lease per account.
- **Two silent-failure bugs that bit 2026-05-14 are now structurally impossible.** Bug 1 (sudo fanout writing root-owned credentials.json → silent fleet lockout at next restart). Bug 2 (`auth refresh-accounts` last-write-wins overwriting the YAML primary). Both pinned by regression tests at `src/auth/broker/server.test.ts`.
- **Hindsight (and other ephemeral consumers) get a first-class slot.** `auth.consumers[]` schema field + per-consumer UDS socket means a non-agent container can `get-credentials` from the broker and feed claude. Unblocks the parked `feat/hindsight-claude-code` branch.

### CLI changes

| Before | After |
|---|---|
| `auth promote <label> <agents...>` | `auth use <label>` (fleet-wide) |
| `auth enable / auth disable <label> <agents>` | `auth agent override <agent> <label>` (edge case) |
| `auth login <agent>` | `auth add <label> --from-oauth` |
| `auth reauth <agent>` | `auth add <label> --from-oauth --replace` |
| `auth account add / list / rm / rename` | `auth add / list / rm` (no more `account` subcommand) |
| `auth refresh-accounts` | `auth refresh [<label>]` (diagnostic; broker owns the loop) |
| `auth share <label>` | `auth add` + `auth use` (two clear verbs) |
| `auth status` (empty rows) | `auth show [<agent>]` (real state) |
| `auth heal <agent>` | gone (no slot pool to heal); `--json` shim retained for boot-self-test |

### Schema changes

```yaml
# BEFORE (per-agent auth.accounts arrays)
agents:
  ziggy:
    auth_label: "you@example.com"
    auth:
      accounts: [bob@example.com, you@example.com]

# AFTER (one fleet active + per-agent override edge case)
auth:
  active: bob@example.com
  fallback_order: [bob@example.com, you@example.com]
  consumers:
    - name: hindsight
      account: bob@example.com
      uid: 11000

agents:
  ziggy: {}                                # uses fleet active
  clerk:
    admin: true                            # gates /agents, /restart, AND admin /auth verbs
  klanker:
    auth:
      override: you@example.com          # edge case only
```

`switchroom apply` runs an in-place schema upgrade with a `switchroom.yaml.pre-auth-broker` backup. Divergent fleets emit a loud warning explaining both the ordering loss and the tail-account loss (the new schema can't represent per-agent fallback preferences).

### Architecture (read `docs/auth.md` for the operator guide)

- Per-agent UDS socket at `/run/switchroom/auth-broker/<name>/sock`, mode 0660, chowned to the per-agent UID.
- Per-consumer socket at `/run/switchroom/auth-broker/<consumer>/sock`, chowned to the consumer's declared UID.
- Operator socket at `/run/switchroom/auth-broker/operator/sock`, chowned to the operator UID — host operator reaches the broker without sudo.
- Drift detection: broker records sha256 of every credentials.json it writes in `sha-index.json`. Boot-time mismatch is a hard error; recovery is `auth add <label> --replace`. Runbook at `docs/operators/auth-broker-drift.md`.
- Refresh threshold: 60min remaining (broker) vs ≤5min (claude). The 55-min gap is the load-bearing invariant — broker refreshes first, claude reads the new bytes on its next disk-read, no tmp+rename race.
- `CLAUDE_CODE_OAUTH_TOKEN` env injection deleted (Decision 5). Stop hooks, sub-agents, summarizers, cron-launched `claude -p` all read `credentials.json` from disk, same path.
- Per-agent slot tree (`<agentDir>/.claude/accounts/<slot>/`, `.oauth-token`, `.oauth-token.meta.json`, `active` marker) deleted (Decision 6).

### Telegram

The old `/auth` dashboard (1,104 LOC of in-place promote UI built on slot-pool concepts) is gone. Replaced with three chat commands:
- `/auth show` — open to any agent (read-only).
- `/auth use <label>` — admin agents only.
- `/auth rotate` — admin agents only.

### Deletions

- `src/auth/account-promote.ts`, `src/auth/token-refresh.ts`, `src/auth/account-quota-store.ts`, `src/cli/auth-accounts-yaml.ts` — all functionality subsumed by the broker.
- `telegram-plugin/auth-dashboard.ts` (1,104 LOC) and `telegram-plugin/auth-slot-parser.ts` — replaced by the three thin chat commands.
- The fanout half of `src/auth/account-refresh.ts` (`fanoutAccountToAgents`, `refreshAllAccounts`, `enabledAgentsForAccount`). The single-account refresh primitive `refreshAccountIfNeeded` stays — the broker imports it.
- **Standalone `switchroom-foreman` Telegram bot.** `telegram-plugin/foreman/`, the `switchroom setup --foreman` CLI verb, and the `~/.switchroom/foreman/` config dir are all deleted. Fleet-management slash commands are now handled by per-agent gateways on agents with `admin: true` (three-tier command model — see `docs/architecture.md`). The `role: "foreman"` schema flag is **unchanged** — it controls auto-installation of operator skills and is orthogonal to the retired standalone bot. Foreman commands intentionally **not** migrated (run on host): `/create-agent` + `/setup` → `switchroom agent add <name>`; `/delete <agent>` → `switchroom agent destroy <name>`.
- ~2,000 LOC of paired tests for all the above.

### Migration

No long-term migration framework. `switchroom apply` runs an in-place upgrade on first run post-merge and writes `switchroom.yaml.pre-auth-broker` for the audit trail. There are no users in the wild, so the migration is destructive of per-agent fallback ordering on divergent fleets — the loud warning surfaces the loss.

### See also

- `docs/auth.md` — full operator guide.
- `docs/operators/auth-broker-drift.md` — drift recovery runbook.
- `docs/rfcs/auth-broker.md` — the RFC (3 review rounds).
- `reference/share-auth-across-the-fleet.md` — the JTBD design contract this operationalises.
## v0.8.1 — SOUL.md fingerprint re-render (v0.8.0 follow-up)

Single fix. The v0.8.0 voice consolidation (PR #1177) moved the canonical AI-tells ban-list into `SOUL.md` "Never", but `seedWorkspaceBootstrapFiles` was seeding workspace bootstrap files via `writeIfMissing`. Once an agent had a `SOUL.md`, the template was frozen forever — same failure shape as #1122 was for `CLAUDE.md` before that fix.

Result during the v0.8.0 rollout: the new "Never" rules didn't reach any existing agent. Operators had to `rm SOUL.md && switchroom apply` per agent to refresh.

### Fix (#1181)

`SOUL.md` now uses `rerenderWithFingerprint` — the same function `CLAUDE.md` has used since #1122. Other workspace files (`IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`, `USER.md`) keep `writeIfMissing` because they're user-owned scratchpads the agent edits at runtime.

`SOUL.custom.md` sidecar handling is preserved: operator additions are composed into the rendered output, and the sidecar file itself stays `writeIfMissing` so it survives re-renders untouched.

Operator hand-edits to `SOUL.md` itself are backed up to `SOUL.md.before-rerender.<unix-ms>` then the file is rewritten from the new template. Legacy state (file exists, no fingerprint sidecar) migrates cleanly on the next apply — content unchanged, fingerprint installed.

New regression test at `tests/scaffold.rerender-soul-md.test.ts` mirrors `scaffold.rerender-claude-md.test.ts`: first-scaffold-writes-fingerprint, no-op-on-unchanged-template, drift-without-edits, hand-edit-plus-drift, legacy-state-migration, sidecar-survives-rerender.

### npm note

v0.8.0 was briefly unpublished from npm during a force-republish attempt before the SOUL fix was ready. npm policy blocks same-version republish for 24h after unpublish, so v0.8.0 stays unpublished on npm. v0.8.1 carries the same content as v0.8.0 + the fix and is the version to install. GitHub `v0.8.0` tag + GHCR `:v0.8.0` images already point at the SOUL fix commit and remain available.

## v0.8.0 — voice/architecture cleanup + host-control daemon + vault posture toggle

Big release. ~35 PRs since v0.7.16. Three headline themes:

1. **Voice and prompt architecture cleanup (#1177, #1178)** — the agent system prompt was duplicating "don't make AI tells" rules 3-4× across SOUL.md / CLAUDE.md / telegram-style.md.hbs in slightly different forms, while ~57% of `telegram-style.md.hbs` was operational protocol that fires only on specific runtime triggers (interrupted-turn resume, fresh-boot wake audit, "why did you restart" debug, `!` interrupt detail, "status?" UX-failure signal). Anti-AI guidance was drowning in a 6,000-word always-loaded prompt. Two-PR fix: consolidate voice rules into SOUL.md "Never" as the canonical ban-list, add a procedural "Execution Bias" section to CLAUDE.md (verify mutable facts, final answer needs evidence, weak tool result is not a conclusion, one clarifying question not five), and hoist the runtime protocols into a new bundled `switchroom-runtime` skill that loads on demand. Net: assembled CLAUDE.md drops from ~32KB to ~27.7KB per turn, and the voice/persona content sits at the prompt position it deserves.

2. **`switchroom-hostd` host-control daemon — Phase 1 (#1175, RFC C in #1171)** — first cut of the host-control daemon that lets the in-agent gateway reach back to the host for privileged operations (docker compose recreate, vault rotation, etc.) without granting docker.sock to every agent container. Phase 1 ships the protocol, server, client, and compose wiring; subsequent phases add the actual privileged-op handlers. RFC at `docs/proposed/RFC-C-host-control-daemon.md`.

3. **Vault posture toggle (`approvalAuth: passphrase | telegram-id`, #1115 et al.)** — opt-in single-factor approval for vault grant cards (full breakdown below).

### Voice / architecture cleanup (#1177 + #1178)

**Voice consolidation into SOUL.md (#1177).** AI-tells ban-list unified into `profiles/default/workspace/SOUL.md.hbs` "Never" — covers opener/closer phrases ("Certainly!", "I hope this helps", "Let me know if"), promotional adjectives ("powerful", "compelling", "vibrant", "revolutionary"), em-dash rule, rule-of-three / negative-parallelism, hedging filler, excessive bolding, sycophantic preamble, apology-for-prior-responses. The old paragraph at `telegram-style.md.hbs:42` is now a 70-word pointer to SOUL. New "Execution Bias" section in `profiles/default/CLAUDE.md.hbs` between Safety and the telegram-style partial: procedural rules (act in-turn, verify mutable facts before claiming, final answer needs evidence, weak tool result is not a conclusion, one clarifying question not five). Procedural shape inspired by OpenClaw's same-named section; switchroom-flavored wording. Subsumes the prior posture-only "don't guess, don't assume" / "verify before editing" bullets.

**Runtime protocols hoisted to `switchroom-runtime` skill (#1178).** New bundled skill at `skills/switchroom-runtime/SKILL.md` holds the resume protocol, wake audit, "why did you restart" debug commands, `!` interrupt implementation detail, and "status?" UX-failure signal procedure. The always-loaded prompt keeps short trigger sentences ("If `$TELEGRAM_STATE_DIR/.wake-audit-pending` exists, invoke `/switchroom-runtime`") instead of the inline bash snippets. Auto-symlinked into every agent's `.claude/skills/` via the existing default-skills reconciler — no per-agent config required. Operator opt-out via `bundled_skills: { switchroom-runtime: false }`. Size cap test in `tests/scaffold.persona.test.ts` tightened 32000 → 28000 to lock in the budget.

### Host-control daemon — Phase 1 (#1175, RFC #1171)

`switchroom-hostd` is a new host-side daemon that mediates privileged operations the in-agent gateway can't perform directly (docker compose interactions, host-filesystem writes outside the per-agent mount, etc.). Phase 1 ships the NDJSON-over-UDS protocol, server, client library used by the gateway, and the compose wiring that bind-mounts the hostd socket into agent containers. Subsequent phases implement specific privileged ops (the immediate driver is fixing `/update apply` from inside Telegram on docker hosts — see #926). RFC at `docs/proposed/RFC-C-host-control-daemon.md` walks the design space.

### Vault posture (#1115 epic)

- **`vault.broker.approvalAuth` posture toggle (`passphrase` | `telegram-id`)** — opt-in single-factor approval for vault grant cards. Default (`passphrase`) is unchanged: the operator types the vault passphrase on every Approve tap (two-factor — Telegram ID + passphrase). Setting `approvalAuth: telegram-id` (requires `autoUnlock: true`) makes Approve mint immediately with no passphrase prompt, relying on Telegram account identity alone. Threat-model writeup in `docs/configuration.md`; `switchroom doctor` surfaces the active posture. Single-factor mode collapses security to the operator's Telegram account — opt-in only. The gateway hard-fails on boot if `approvalAuth: telegram-id` is set but the auto-unlock blob is missing, unreadable, OR empty/whitespace-only — we never silently downgrade an operator's declared posture.

- **`vault.broker.approvalAuth: telegram-id` works on Docker (#1115 follow-up, #1140)** — the posture was non-functional on the canonical Docker runtime because the gateway inside an agent container couldn't reach the auto-unlock blob (bind-mounted only to the broker singleton). Fixed via broker-mediated attestation: new `attest_via_posture: true` flag on `mint_grant` / `list_grants` / `put`; broker validates its own config opt-in + lock state + per-agent peer, then uses its retained passphrase internally. **Passphrase never crosses the wire.** Plus a **per-agent opt-in allowlist** `vault.broker.postureMintAgents` (default `[]`): under `approvalAuth: telegram-id`, only listed agents can use the silent-mint path. Broker also enforces `req.agent === agentName` so an allowlisted agent can't mint grants naming another agent.

- **Vault-posture config errors exit cleanly (#1135)** — instead of crash-looping, the gateway now exits with `EX_CONFIG` (78) when a vault-posture config combination is invalid (e.g. `approvalAuth: telegram-id` without `autoUnlock: true`). Systemd / docker treat that as a permanent config error, not a transient crash worth restarting.

- **Operator-update restart silence (#1139, #1141, #1142)** — `switchroom update` now stamps a `clean-shutdown.json` marker (`reason: "operator: switchroom update"`) on every agent before the compose recreate so the post-recreate boot card renders as graceful rather than "your agent crashed." Marker freshness window extended to 5min for `operator:` reasons (initial 90s was too tight when the docker pull was slow). Marker stamped via `docker exec` so the inside-container path matches the outside-container path the gateway will read.

### Operator-event card / button-UX foundation (#1150 audit closure)

The #1150 epic was a thorough audit of the inbound button-tap UX surface, surfacing three P0 surfaces and many smaller polish items. All landed:

- **`finalizeCallback` helper (#1152)** — single chokepoint enforcing the three button-UX invariants: atomic status edit + keyboard strip, idempotent under retry, escapes source-text on all paths. Foundation for the rest of the epic.

- **3 P0 button-UX surfaces (#1157, #1158, #1165)** — vault_request_save rename action, reauth re-tappability, atomic status line + keyboard strip on operator-event cards. The keyboard no longer lingers after the action completes.

- **Source-text escape generalization (#1160, #1162)** — every `finalizeCallback`-class callsite now escapes user-provided text consistently. Catches the pre-existing 5 callsites that weren't on the new helper yet.

- **Synthetic-inbound buffering on bridge disconnect (#1156)** — synthetic turns (cron fires, vault-save replays) queued by the gateway during a bridge restart now flush correctly when the bridge comes back, instead of getting dropped.

- **Interrupt marker uses `tmux send-keys` directly (#1133)** — under the v0.7 docker runtime, the prior path through `interruptAgent` was a no-op for in-container tmux because there was no host-side docker-exec wrapper. Direct `tmux send-keys` against the agent container's socket works.

- **Framework-fallback ends wedged turns (#1136)** — when Claude's framework-fallback path fired (context-exhaustion, output-rate-limit, model-error), the turn never ended cleanly on the gateway side, so subsequent inbounds got queued forever. Now `silencePoke.endTurn` fires on all bail paths.

- **Session-scoped always-allow cache (#1169)** — sub-agents now inherit parent approvals so the `/auth slot` reauth flow doesn't re-prompt for every sub-agent dispatched in the same session.

- **Boot-card improvements (#1170)** — quota row plus Claude CLI version on every boot/status card, so operators know what's actually running without `docker exec`.

- **Audit closure (#1167, #1168)** — `ask_user` button-tap end-to-end smoke test + synth-inbound builder refactor with 13 shape-pin tests.

### Bind mounts + compose

- **Admin-gated `bind_mounts:` (#1164, #1166, #1172)** — per-agent admin-gated bind mounts for host paths an agent needs (e.g. an external photo library, a vendor directory). Path normalization, target-path denylist (no `/etc`, `/proc`, `/sys`, `/run` etc.), and a docs reframe to explain the trust model.

- **`TINI_KILL_PROCESS_GROUP=1` (#1176)** — SIGTERM now reaches the gateway sidecar process group, not just tini. Fixes a class of "agent ignored SIGTERM" bugs under docker.

- **Bundled-skills pool at `~/.switchroom/skills/_bundled` (#1173, #1174)** — host-stable pool that survives CLI version changes, so `_bundled/<name>` symlinks in agent dirs don't bit-rot. Mounted into agent containers via the compose wiring.

### CLI + telemetry

- **`switchroom status-ask report` (#1159)** — measures `inbound_status_query` events (the "status?" / "still there?" / "any update?" defect signal) so the rate can be tracked over time. Pairs with #1178's runtime-skill hoist of the same procedure.

### Misc

- **Inbound denials logged with reason (#1137)** — allowlist misconfigs aren't silent anymore.
- **`gh run rerun` actually bumps Claude (#1143)** — `CACHE_BUST=run_attempt` in the docker workflow.
- **UAT framework expansion** — many test additions across #1134, #1144, #1146, #1147, #1148, #1149, #1151, #1153, #1154 covering silence-poke, boot-card reasons, status-ask cause classes, ask_user button taps, reaction lifecycle.

## Unreleased

## v0.7.16 — vault UX epic close-out + host-shell broker socket

## v0.7.16 — vault UX epic close-out + host-shell broker socket

Five PRs landed since v0.7.15: the remaining three phases of the #969
vault UX epic (P2a / P2b / P3 — durable approval-kernel schema,
recent-denials one-tap allow, master-passphrase env deprecation), plus
the long-running host-shell broker socket fix that had bit-rotted as
#905 (now landed via #991 after a clean rebase).

### Durable approval-kernel schema across broker restarts (#969 P2a — #984)

The kernel's schema migration had been running `DROP-IF-EXISTS + CREATE`
on every broker boot, on the assumption that no production deployment
of the kernel had landed yet. That assumption broke in v0.7.15 when
P1a's `vault_request_save` flow started minting durable
`allow_always` decisions and the kernel container went into
production compose. Every broker restart silently wiped operator
approvals — tapping "Always" on a vault-save card was effectively
"Always until next deploy."

Fix: switch all three approval tables (`approval_decisions`,
`approval_nonces`, `approval_audit`) and their indices to
`CREATE IF NOT EXISTS`. Idempotent on a fresh DB; preserves rows on
an existing one. No data migration needed (schema columns stable
since introduction). Locked in by a new regression test that seeds
each table, re-runs the migration, asserts rows survive.

### Recent-denials section + one-tap allow on `/vault audit` (#969 P2b — #985)

Closes the cron-denial loop. When a cron-fired skill hits a broker
DENY (key not in `schedule[i].secrets[]`, or no write-grant for a
new key), the failure was silent in `scheduler.jsonl` — operators
typically found out via "the cron stopped working."

`/vault audit <agent>` now surfaces a "Recent denials (last 7d)"
section grouped by key, with a `[🔓 Allow <key>]` button per unique
denial. Tap → 30-day read-grant minted via the broker
(`mintGrantViaBroker`), token file written, agent picks up the grant
on next CLI invocation.

Pure-functional parser in `telegram-plugin/gateway/recent-denials.ts`
handles malformed JSON, missing fields, stale entries, and tampered
slug shapes defensively. 8 unit tests lock in each filter.

Grants chosen over YAML reconcile because (a) write-grants from P1b
already let agents rotate/create keys without touching
`schedule.secrets[]`, mirroring that for reads is consistent, and
(b) editing `switchroom.yaml` from a Telegram tap requires careful
YAML mutation + restart fan-out — riskier in scope. The grant model
is an additive overlay; operators who want the read pinned into
config can still edit manually.

### `SWITCHROOM_VAULT_PASSPHRASE` deprecation in sandbox + canonical-pattern docs (#969 P3 — #982)

Targets a specific anti-pattern: skills that export the master
passphrase into the agent's environment, defeating the ACL model
and bypassing the broker's audit log. The env var path remains
honoured for backwards compatibility AND for the canonical
gateway-passphrase-attestation flow (P1a) — both legitimate.

  - **`docs/vault-security.md`** — new canonical reference. Three
    auth paths (capability grant, path-as-identity, operator
    passphrase), decision flow, migration notes.
  - **Runtime warning** at `vault` CLI `preAction`. One-shot per
    process. Fires only when env var set AND `SWITCHROOM_RUNTIME=
    docker` AND escape hatch unset. Stderr only. Message includes
    the canonical `vault grant` mint command and a pointer to the
    docs. The gateway's per-spawn invocations set
    `SWITCHROOM_NO_VAULT_DEPRECATION_WARNING=1` to keep the
    canonical P1a flow quiet.
  - **`skills/token-helpers/SKILL.md`** — the in-tree skill that
    documented the env var as a prereq is updated to advertise
    capability grants first.

### Host-shell access to the v0.7 vault broker (#991, supersedes #905)

Eight host-shell CLI verbs were broken under docker mode because the
broker only bound per-agent sockets at
`/run/switchroom/broker/<agent>/sock` and the host CLI defaulted to
the v0.6 host-side path which no longer exists. Every host-shell
broker call returned "broker unreachable":

  - `switchroom vault broker {status,unlock,lock}` → false-negative
  - `switchroom vault doctor` → false-negative
  - `switchroom vault auto-unlock {status,poll}` → false-negative
  - `switchroom agent restart [--name|all]` → preflight blocked
  - `switchroom vault {get,list}` → broker dead → direct-decrypt fallback

This PR adds a host-shell-reachable **operator socket** as the third
identity kind in the broker's path-as-identity model:

```
host:      ~/.switchroom/broker-operator/sock           (mode 0600, chowned to operator UID)
          ↑ docker bind mount
container: /run/switchroom/broker/operator/sock         (broker binds + chowns)
```

Trust model: bind path + chown + 0600 file mode. peercred is bypassed
for this listener (host UID never matches the broker container's root
UID) — same invariant the per-agent sockets already use.

Eight slices:

  1. **peercred** — `socketPathToIdentity()` returns
     `{kind:"agent",name} | {kind:"operator"}`; backward-compat
     `socketPathToAgent()` returns null for the operator path;
     the allocator reserves `"operator"` as an agent name.
  2. **broker server** — `bindOperatorListener()` binds data +
     unlock pair, chowns to operator UID. `isOperator` flag in
     `_handleRequest` routes to operator-mode dispatch: skip
     peercred fail-closed, skip grant-mgmt cron-deny, apply
     entry scope with `agentSlug="operator"` (default-deny on
     agent-scoped keys).
  3. **compose generator** — emits operator bind volume +
     `SWITCHROOM_BROKER_OPERATOR_UID` env when `operatorUid` is
     set; omitting preserves pre-fix behaviour.
  4. **apply** — captures `SUDO_UID` (or `process.getuid()`) and
     threads as `operatorUid`. Pre-creates the host bind dir so
     docker doesn't auto-create it as root.
  5. **CLI broker client** — `resolveBrokerSocketPath()` prefers
     the operator socket under `isDockerRuntime()`, falls back to
     the legacy v0.6 path otherwise.
  6. **preflight + bot-token messages** — distinguishes
     "reachable-but-locked" from "unreachable + docker-mode";
     the new hint points at `docker compose up -d` + Telegram
     `/vault unlock` instead of the host-side daemon command
     that no longer exists.
  7. **`src/runtime-mode.ts` (new)** — consolidates the three
     existing local copies of the `SWITCHROOM_RUNTIME=docker`
     predicate under one module so the operator-socket resolver
     shares the detection contract.
  8. **78 new test assertions** — peercred socket-path
     round-trip, compose-generator operator bind + env emission,
     host-bind absolute-path baking under homeDir override.

#### Upgrade note

The new operator socket only binds when `apply` re-emits the compose
file with `operatorUid` set. Run `switchroom update` (or
`switchroom apply --non-interactive` + `docker compose up -d
--remove-orphans`) after upgrading to v0.7.16 to pick it up. Existing
agent-side flows are unaffected — the change is purely additive.

## v0.7.15 — vault UX epic + PID-file flock

Bundles five PRs landed since v0.7.14: the second half of the #969
vault UX epic (P0b / P1a / P1b / P2c — gateway error rendering,
agent-initiated save, write-grants, unified `/vault audit`) plus the
v0.7.14 sprint's final tier-3 follow-up (#964 PID-file flock).

### Save secrets from Telegram, end-to-end (#969 P1a — #975)

The completion of the #969 epic's product loop. From any Telegram
chat the user can now:

  - paste a secret, OR ask an agent to save one
  - tap a single button to confirm (with optional rename)
  - verify the key landed in the vault

…without ever touching a host shell. Two moving parts:

  1. **`vault_request_save` MCP tool.** Agents call it with `{chat_id,
     key, value, why?}` when the user supplies a secret and asks to
     save it. The gateway stages the value server-side (in memory only;
     never echoed back to the agent or logged), renders an `apv:`-style
     approval card with [✅ Save once] [🚫 Discard] [✏️ Rename]
     buttons in the user's chat.
  2. **Broker passphrase attestation.** New optional `passphrase` field
     on broker PUT requests. When supplied and matching the broker's
     loaded passphrase, the call is authorized as if the operator had
     run `switchroom vault set` from the host shell — bypasses path-
     as-identity, ACL, the unknown-key gate, and the kind-mismatch
     check. Wrong-passphrase fails closed with `method:"passphrase"
     DENIED` (does NOT fall through, so a typo can't mask the wrong-
     attestation signal). Audit logs tag method:"passphrase" so this
     auth path is distinct from grants and peercred.

The `vrs:` callback router (Save/Discard/Rename) carries the cached
operator passphrase forward through `defaultVaultWrite` → CLI →
broker PUT.

### Write-grants — agents can create keys with operator consent (#969 P1b — #973)

Pre-v0.7.15, grants were read-only. Agents could rotate existing
keys via the broker but couldn't *create* new ones, which blocked
the deferred-secret save flow the previous bullet enables.

  - New `write_allow` column on `vault_grants` (JSON array of literal
    keys and/or prefix-globs ending in `*`). Idempotent schema
    migration: `PRAGMA table_info` check + `ALTER TABLE ADD COLUMN`
    with `DEFAULT '[]'` so existing rows stay read-only.
  - `validateGrantForWrite` mirrors the read-side validator, consults
    `write_allow` with prefix-glob support, returns typed
    `WriteDenyReason` so audit logs name the missing capability
    (`grant-write-not-allowed`) distinct from read denials
    (`grant-key-not-allowed`).
  - Broker PUT path consults write-grants BEFORE the legacy
    path-as-identity rule. A valid write-grant is the identity (the
    token IS the caller) — no `<agent>` arg needed.
  - `switchroom vault grant --write <key-or-prefix>` on the CLI; can
    combine with `--read` for full-access grants.

### Telegram-honest error rendering for vault CLI failures (#969 P0b — #972)

P0a (#971, in v0.7.14) made `switchroom vault` emit stable stderr
markers + exit codes when running inside an agent sandbox. P0b
consumes them in the gateway so the user-facing failure UX explains
what to do instead of dumping a raw `Vault file not found …` /
`VAULT-NEEDS-APPROVAL …` blob.

New `telegram-plugin/secret-detect/vault-error.ts`:

```
parseVaultCliError(stderr) → { kind, original, key? }
renderVaultCliError(parsed, { verb, key }) → { html, suppressRaw }
```

Maps each marker to a copy-pasteable host command:

  - `VAULT-SANDBOX-CONTEXT` → "⚠️ This action must run on the host."
    plus `<pre>switchroom vault <verb> <key></pre>`
  - `VAULT-NEEDS-APPROVAL` → "⚠️ New vault key — operator approval
    required." plus forward-pointer to the one-tap save card from
    #975 above.
  - `VAULT-BROKER-UNREACHABLE` → recovery hint pointing at
    `switchroom vault broker status`.

### Unified `/vault audit <agent>` Telegram command (#969 P2c — #980)

One mental model for operators auditing an agent's credential
surface. Single Telegram command renders, in one card:

  - Read grants for the agent (id · keys · expiry)
  - Write grants for the agent (id · keys/globs · expiry — new
    in #969 P1b above)
  - `schedule[i].secrets[]` from `switchroom.yaml` (with cron
    schedule)
  - Summary line: N read, N write, N cron entries

Previously these three surfaces were spread across `/vault grants`,
reading `switchroom.yaml` on the host, and (for write-grants) nowhere
— operators had to mentally union them. With write-grants now in
play, a unified view is load-bearing.

Implementation reuses `listGrantsViaBroker(agent)` once and
partitions by `key_allow.length > 0` (read) and
`write_allow.length > 0` (write); a grant with both capabilities
appears in both sections. Broker failures and config-load failures
render as inline warnings rather than blocking the rest of the
card so partial views still ship.

### PID-file flock with holder PID in busy errors (#964 — #974)

Replaces `proper-lockfile`'s sentinel-directory flock with a
PID-file written to `<vaultPath>.lock`. Closes plan v3 §11's ask
for diagnosable busy errors.

  - Acquisition: `openSync(O_CREAT|O_EXCL)` + write
    `<pid>\n<ts_ms>\n<argv0>\n` and fsync. Kernel-atomic
    create-if-not-exists; file content is human-readable so any
    operator (or peer process) can `cat` it.
  - Contention error gains the holder PID and acquired-ago seconds:
    `vault busy: held by pid 12345 (acquired 2s ago) at <path>
    (retried for 5000ms). …`
  - New `VaultBusyError` carries `holderPid` / `heldForMs` /
    `lockPath` / `budgetMs` as structured fields; threaded through
    `VaultError.cause` so the gateway error renderer from #972 can
    consume them programmatically without re-parsing the message.
  - Stale-lock recovery: dead holder PID → unlink + retry (no
    waiting). Liveness via `/proc/<pid>` on Linux, `kill(pid, 0)`
    portably.

**v0.7.14 → v0.7.15 migration.** v0.7.12-v0.7.14 left
`<vaultPath>.lock` as a directory (proper-lockfile sentinel).
v0.7.15's acquirer detects `EEXIST + statSync.isDirectory()` and
treats it as a stale legacy sentinel: rmdir the contents, retry
the openSync. Safe under the standard `switchroom update` flow
because the recreate step SIGTERMs any v0.7.14 writer. Operators
running the v0.7.15 host CLI against a still-running v0.7.14
broker should bounce the broker first — see #979.

Four follow-ups filed for soft-edge cases identified during
review: PID-reuse defense via `acquiredAtMs` (#976),
unparseable-lockfile + mtime-stale heuristic (#977), real
concurrent-acquirer test via `worker_threads` (#978), and the
v0.7.14 → v0.7.15 upgrade-window operator note (#979).

### Migration

None required beyond restarting the broker. `proper-lockfile`
removed from package.json; no consumer code-change.

Patch release. Update via `switchroom update` from any operator
host; in-Telegram via `/update apply` (docker hosts: host-side
CLI, per the v0.7.13 docker-availability guard).

## v0.7.14 — tier-1 follow-ups + docker e2e CI gate

Five issues from the v0.7.12 / v0.7.13 sprint, closed in PR #966.

### Unit + e2e coverage for the #958 deploy regression class (#961, #962)

The v0.7.12 deploy hotfix (#958) shipped without unit coverage for
the failure mode it fixed — both bugs were caught only by self-
deploying against the operator's actual fleet. v0.7.14 closes the
test gap on two layers.

**Unit (#961).** `apply.ts`'s inline vault-bind-mount-dir guard is
now two pure helpers (`resolveVaultBindMountDir`,
`inspectVaultBindMountDir`) covered by `apply-vault-guard.test.ts`.
Sixteen cases pin the four enumerated path-resolution branches
(default legacy, default new canonical, custom path, no path)
plus the six MigrationResult kinds and the artifact-whitelist
inspection (ok, missing, lockfile, sentinel-dir, atomic-write
sibling-tmp, unexpected operator backups).

**E2e (#962).** `phase2c-vault-integration.test.ts` now exercises
the full op:put rotation flow against a live broker container:
alice rotates her own scoped key, the broker re-encrypts the vault
on disk, the next op:get returns the new value. Asserts the
vault.enc sha changed, the proper-lockfile sentinel-dir was
cleaned up post-write, no cross-agent smear, plus the denial
cases (cross-agent ACL, unknown-key, kind-mismatch). The full
chain runs under the exact mount geometry + cap_drop/cap_add
shape compose emits — both #958-A (missing DAC_OVERRIDE) and
#958-B (wrong vault-dir guard path) would have failed the test
instead of shipping.

### CI gate for docker e2e (#962)

New workflow at `.github/workflows/docker-e2e.yml`. Builds the
phase1b-test image set on a clean-room runner, aliases them as
phase2a/2b-test, runs `tests/docker/` against real containers.
Triggered narrowly: PRs touching `src/vault/**`,
`src/cli/apply.ts`, `src/agents/compose.ts`,
`src/agent-scheduler/**`, the broker/agent/kernel/base
Dockerfiles, or `tests/docker/**`.

Two pre-existing test-isolation bugs were fixed to make the full
suite green in CI:

  - `broker-ipc-race.test.ts:265` — `kernelLookup` defaulted its
    `container` argument to the production container shape
    `switchroom-${agent}`. On a clean-room runner that container
    doesn't exist (every exec returned exit=1, manifesting as
    "0/45 succeed"); on the operator's box where the production
    fleet runs, the test would silently exec into the live
    production kernel socket. Default removed, all callsites pass
    the project-prefixed test fleet container.
  - `_prod-snapshot.ts:27` — the prod-drift filter regex only
    matched `switchroom-phase<digit>` (single-container pattern).
    It missed the compose-project pattern `phase<digit><letter>-`
    used by broker-ipc-race and per-agent-isolation, so any
    orphan from a failed fleet test cascaded into the prod-drift
    assertion of every subsequent docker test. Filter now
    matches both shapes.

### Doctor probe + doc backfill (#960, #963)

**#960.** `switchroom doctor` chromium probe honors
`$PLAYWRIGHT_BROWSERS_PATH` (the env var set by v0.7.13's baked
image at `/opt/playwright/browsers/`) and recognizes the modern
`chrome-linux64/chrome` (Playwright >=1.40) plus
`headless_shell` binary variants. Before v0.7.14, the probe only
checked the legacy `~/.cache/ms-playwright/<entry>/chrome-linux/chrome`
path and reported missing on the v0.7.13 layout even though the
binary was present.

**#963.** Plan v3 §12 deferred docs caught up to the v0.7.12
vault layout:

  - `CLAUDE.md` runtime-architecture section gained a paragraph
    on the file→directory migration, the 5-state migration
    machine in `src/vault/migrate-layout.ts`, and the
    bind-mount artifact whitelist.
  - `README.md` corrected the stale
    `~/.switchroom/vault-broker.sock` reference (post-v0.7 it's
    per-agent at `/run/switchroom/broker/<agent>/sock`) and the
    `switchroom-broker` container name (compose emits
    `switchroom-vault-broker`).
  - `reference/share-auth-across-the-fleet.md` cross-links the
    vault op:put rotation flow as the broker-pattern precedent
    for the proposed auth-broker design.

### Migration

None. Patch release. Update via `switchroom update` from any
operator host; in-Telegram via `/update apply` (docker hosts:
host-side CLI, per the v0.7.13 docker-availability guard).

## v0.7.13 — v0.7.12 deploy hotfix + Playwright in agent image

Two-part patch release. The vault hotfix is forced by the v0.7.12
deploy regression caught when self-deploying against the operator's
fleet (clean unit-test pass, but real-world EACCES on the broker
container's RW write to the host vault dir). The Playwright bake
rides along since v0.7.13 is recreating containers anyway.

### Vault deploy hotfix (#958)

Two bugs in v0.7.12's apply / compose-gen path:

**Bug 1 — vault-dir contents guard scanned the wrong directory.**
`apply.ts` used `dirname(customVaultPath)` to derive the dir to
scan against `KNOWN_VAULT_ARTIFACT_NAMES`. For operators whose
configured `vault.path` was the legacy `~/.switchroom/vault.enc`
(very common — the v0.7.0–.11 default), `customVaultPath`
resolved to that path, so `dirname` returned `~/.switchroom`
itself — the parent of the LEGACY file, NOT the new bind-mount
target. The operator's actual `~/.switchroom/` contains many
sibling dirs (approvals, web-token, worktrees, plus assorted
backups and dotfiles) and the guard correctly refused to mount
because none are in the artifact whitelist.

Fix: only use `dirname(customVaultPath)` for genuinely custom
paths (state `custom-path-skipped`). For default-config
operators, the bind-mount target is always the new canonical
`~/.switchroom/vault/` parent — derive that explicitly.

**Bug 2 — broker couldn't WRITE to the host-owned vault dir.**
`cap_drop: ALL` strips DAC_OVERRIDE. Without it,
container-root (broker runs as uid 0) could READ via
DAC_READ_SEARCH (kept since v0.7.4) but rejected mkdir + write
into the operator's host vault dir. Surfaced as
`EACCES: permission denied, mkdir '/state/vault/vault.enc.lock'`
when the broker's saveVault flock-sentinel-dir step ran.

Fix: add `DAC_OVERRIDE` to broker `cap_add`. Trust posture is
consistent — broker already holds the passphrase + decrypted
secrets in memory; allowing write capability is not an
expansion of access, just of operations.

Both bugs caught by self-deploying v0.7.12 against the
operator's fleet (not by unit tests). After the hotfix:
end-to-end calendar-skill refresh works (broker put → write
persists → re-read returns fresh token → MS Graph 200), and a
real calendar event was created via `calendar.py create-event`
to confirm the full chain.

### Playwright in agent image (#956)

Skills using browser automation (calendar, scrape, UI-test)
called `npx playwright`, which triggered an on-demand download
of chromium binaries (~150MB) into `~/.cache/ms-playwright/`
per agent on first call (~30s latency, plus N copies across
the fleet's home dirs).

v0.7.13 pre-bakes Playwright + chromium into the agent image
via `playwright@^1.49.0` + `playwright install --with-deps
chromium`. `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers`
puts the binaries in an image layer so they're shared across
the fleet, not duplicated per-agent. First-call latency drops
from ~30s to ~0s.

Operators wanting Firefox / Webkit can install them per-agent
via `npx playwright install <browser>` from inside the
agent — chromium is just the bake-in default.

Image size grows ~150MB; net savings on the fleet (one image
layer vs N per-agent home-dir caches). CI rebuilds the image
on each main merge so the playwright npm version + browser
binary stay in lockstep.

Non-blocking follow-up: `switchroom doctor`'s chromium probe
still scans `~/.cache/ms-playwright/`. With the new
`PLAYWRIGHT_BROWSERS_PATH`, the probe will say "chromium: not
found" even though it's baked. Soft warning only ("only
required for playwright-based skills"); fix tracked for v0.7.14.

### Operator action

`switchroom update` runs the migration auto-step and recreates
containers. v0.7.12 → v0.7.13 is a transparent upgrade.

## v0.7.12 — vault layout: dir-mount + atomic-rename + flock (closes #951, #952, #954)

v0.7.11 introduced broker-mediated vault writes (`op:put`) so OAuth-shaped
skills could rotate their refresh tokens without the operator passphrase.
The feature was correct; the **deployment was DOA** because of how the
broker container bind-mounted the vault.

### What was wrong (per #954 RCA)

The broker container had `~/.switchroom/vault.enc` bind-mounted as a
**single-file mount** at `/state/vault.enc`. Two problems stacked:

1. **`:ro` flag** prevented writes outright.
2. **Single-file bind-mount = different filesystem device** than the
   parent dir inside the container (`stat`: `device=66306` for the
   bind-mount target, `device=4194306` for `/state/`).
   `atomicWriteFileSync` writes a sibling temp file in the parent dir
   and `rename()` to the destination. Cross-fs rename is `EXDEV`;
   Linux surfaces it as `EBUSY` for an in-use bind-mount target.

Surface symptom: clerk's calendar skill failing every refresh with
`VAULT-BROKER-DENIED [INTERNAL]: Failed to persist: EBUSY: resource
busy or locked, rename '/state/.vault.enc.7.<ms>.tmp' -> '/state/vault.enc'`.
The bug was structural, not transient — broker did NOT auto-recover;
every retry produced the same EBUSY because the mount layout was the
same. (#954 listed three suspects — process holding fd, fs-lock, sd_notify
— all wrong; the actual cause is the cross-fs rename.)

### Fix — vault parent directory bind-mounted RW

The compose generator now mounts `~/.switchroom/vault/` (parent dir,
RW) at `/state/vault/` instead of mounting `vault.enc` directly.
`saveVault`'s write-temp-then-rename works because temp + dest are on
the same filesystem.

### Layout migration

Existing operators have `~/.switchroom/vault.enc` as a regular file.
`switchroom apply` runs a state-machine migration helper before
compose generation:

| State | Old path | New path | hashes equal? | Action |
|---|---|---|---|---|
| **A: virgin** | absent | absent | — | no-op |
| **B: pre-migration** | regular file | absent | — | migrate |
| **C: partial-finished** | regular file | regular file | yes | finish symlink |
| **D: post-migration** | symlink → vault/vault.enc | regular file | — | no-op |
| **E: divergent** | regular file | regular file | no | REFUSE; print recovery |

State E catches the case where an older switchroom CLI wrote to the
legacy path AFTER migration ran (Linux `rename()` does not follow a
symlink at the destination — it REPLACES the symlink with the new
regular file). The recovery message names exact `mv` commands for
operator-side resolution.

The migration helper acquires the same flock saveVault uses, before
hashing both paths — defeats the broker-writes-between-hashes TOCTOU.

After migration, `~/.switchroom/vault.enc` is a symlink to
`vault/vault.enc`. v0.7.10 and v0.7.11 CLIs reading through the
symlink keep working. The symlink is **sunset in v0.7.14**.

### Concurrent writes — flock in saveVault

Post-#952 (op:put), broker AND host CLI both write the vault file.
`saveVault` now acquires an exclusive lock via `proper-lockfile` with
a 5s retry budget. Migration helper acquires the same lock during
hash-compare so a concurrent broker write doesn't perturb the state
detection.

### Broker-side state-E detection

If `switchroom apply` isn't run (e.g. an older CLI just wrote to the
legacy path), broker startup ALSO checks for the divergent state and
refuses to unlock — producing a fatal error pointing at `switchroom
apply`. Drift is caught either at next apply OR at next broker
restart, whichever comes first.

### Symlink sunset schedule

| Version | Behavior |
|---|---|
| **v0.7.12** | Migration runs; symlink created at old path |
| **v0.7.13** | Migration runs (idempotent); CLI emits warning if writes resolve through the symlink |
| **v0.7.14** | Migration runs (full state machine **plus** cleanup pass); after migration, symlink is removed |

**Critical:** Every v0.7.x release ≥ v0.7.12 runs the full migration
state machine on apply. An operator who pins `switchroom@^0.7` and
skips .12 and .13 → lands on .14 → still gets the full migration
(plus cleanup), not cleanup-only.

### Operator action required: none

The migration runs automatically on the next `switchroom update` /
`switchroom apply`. State A (virgin install) and state D
(already-migrated) are no-ops. State B/C are auto-resolved. State E
is fatal and prints a recovery recipe — one short manual `mv` + `rm`
sequence the operator runs to pick which file to keep.

### Backup tooling note

Backup tools that don't follow symlinks (rsync default, restic, tar
default) will start backing up the symlink at `~/.switchroom/vault.enc`
instead of the file content. Either update your backup path to
`~/.switchroom/vault/vault.enc`, or pass `--copy-links` / `-L`.

### Threat-model trade-off

#952 added passphrase retention in broker memory. v0.7.12 adds vault
file write capability inside the broker container. A pwned broker
that previously could exfiltrate decrypted secrets can now ALSO
persist correctly-encrypted poison content. Mitigations: audit log
every `op:put` (already in #952; ship logs off-broker as a follow-up);
vault-writer sidecar pattern (Option C in plan v3) deferred until CIS
hardening or write-grants are needed.

### Closes

- **#951** asks 1 + 3 (write-capable broker path + auto-refresh-on-stale)
- **#952** end-to-end deployment (was DOA pre-this-release)
- **#954** EBUSY-loop RCA (root cause: cross-fs single-file bind-mount)

### Test plan

- 5270 vitest pass + 6 new flock concurrency tests + 5 new broker-side
  drift detection tests + 16 migration-helper state-machine tests.
- Compose-gen test pins the new mount shape (RW dir-mount, no legacy
  single-file).
- Manual end-to-end smoke deferred until post-deploy: clerk runs
  ms_graph_token.py → token rotates → broker put persists → next read
  returns the fresh token → calendar event creation against MS Graph
  succeeds.

## v0.7.11 — broker `op:put` for agent-driven vault rotation (closes the OAuth refresh-token loop)

This release makes OAuth-shaped skills self-healing. Until now, agents
could read keys from vault via the broker but writes required the
operator passphrase, which agents don't have. Skills that store
rotating refresh tokens — clerk's calendar skill is the canonical case;
any IDP-token pattern is in the same boat — could read their token,
exchange it for fresh access + (possibly-rotated) refresh, then DROP
THE NEW TOKENS ON THE FLOOR because `switchroom vault set` failed
without the passphrase. The skill would silently lose every refresh,
forever.

**Fix (#952).** The broker grows an `op:put` with the same
`schedule.secrets[]` ACL that already gates `op:get`. An agent that
can READ a key can also ROTATE it. Skills that already shell out to
`switchroom vault set` keep working unchanged — the CLI now tries
broker put first when no passphrase is available. Result: clerk's
calendar refresh + persist + next-read cycle works end-to-end without
operator hand-holding.

### Protocol

- New `PutRequestSchema` — `{ v: 1, op: "put", key, entry, token? }`.
  Entry is string OR binary. `kind: "files"` is excluded — multi-file
  rotation stays operator territory.
- New `OkPutResponseSchema` — `{ ok: true, put: true, key }`.

### Server

- The vault passphrase is now retained in a private field after unlock
  so the broker can re-encrypt for op:put. Trade-off documented in a
  block comment: a pwned broker now exposes the passphrase too, but
  the marginal expansion over the already-exposed decrypted secrets
  is small (an attacker who can dump broker memory can already
  exfiltrate every secret; retaining the passphrase additionally lets
  them re-encrypt the on-disk vault). Zeroed on lock.
- `op:put` handler — requires unlocked vault + path-as-identity (token
  grants stay read-only); applies `checkAclByAgent`; refuses to
  introduce new keys (UNKNOWN_KEY); refuses kind mismatch
  (BAD_REQUEST). On success: in-memory update + `saveVault` atomic-
  write. On persist fail: rolls back in-memory state. Audit rows
  mirror op:get format (key name only, NEVER the value).

### Client

- New `putViaBroker(key, entry, opts)` returning a `PutResult`
  discriminated union (`'ok' | 'unreachable' | 'denied' | 'not_found'`)
  matching the existing `getViaBrokerStructured` shape.

### CLI

- `switchroom vault set` routes through the broker BEFORE prompting
  for a passphrase when stdin is piped, no env passphrase, no `--file`,
  no `--allow`/`--deny` scope flags. The skill's existing `_vault_set`
  shell-out hits this path automatically. Operators with
  `SWITCHROOM_VAULT_PASSPHRASE` set in their host shell still get the
  legacy direct-write path.

### Operator impact

After `switchroom update` + recreate:
- The calendar skill self-heals on every refresh window — no more
  operator intervention.
- Other OAuth-style skills (any skill that calls `switchroom vault
  set` from agent context) get the same self-healing for free.
- Existing operator workflows (host-side `switchroom vault set`)
  unchanged.

### Out of scope (follow-ups)

- Token-based grant **writes** — grant tokens stay read-only by
  design; introducing write-grants is a separate design discussion.
- Multi-file entry rotation — `kind: "files"` is excluded from put.
  Operators rotate those via host-side write.
- New-key creation — broker put refuses UNKNOWN_KEY. Agents rotate,
  operators introduce. Could relax with a per-agent prefix-allowlist
  if a use case emerges.
- Reviewer follow-ups: BAD_REQUEST hint should suggest the host-side
  fix; consider gating passphrase retention behind "auto-unlock was
  used"; add a `secrets:` example to `examples/switchroom.yaml`.

## v0.7.10 — `switchroom vault` CLI honors `SWITCHROOM_VAULT_BROKER_SOCK`

Companion patch to v0.7.9. v0.7.9 fixed compose to emit
`SWITCHROOM_VAULT_BROKER_SOCK` (canonical client-side env name) into
agent containers, and verified the broker client + secret-guard hook
+ boot-card probe were all reading it. But the **`switchroom vault`
CLI subcommands** had their own manual broker socket resolution that
**skipped the env entirely** — going straight from
`config.vault?.broker?.socket` to the legacy `~/.switchroom/vault-
broker.sock` fallback (which is a dangling symlink inside an agent
container, via the #910 home-symlink fix).

Operator surface: clerk's calendar skill called `switchroom vault
get microsoft/ken-tokens`, the CLI ignored the canonical env that
v0.7.9 just set, fell through to the dangling fallback, and reported
`VAULT-BROKER-DENIED: broker not running`. Direct broker IPC from
the same container returned the token cleanly. The skill saw "no
token" and refused to add the calendar item.

**Fix (#949).** Five CLI files routed through the canonical
`resolveBrokerSocketPath()` from `src/vault/broker/client.ts`:

  - `src/cli/vault.ts` — vault get/list/put main surface
  - `src/cli/vault-broker.ts` — broker management
  - `src/cli/vault-doctor.ts` — vault doctor
  - `src/cli/vault-grant.ts` — grant management
  - `src/cli/vault-auto-unlock.ts` — auto-unlock setup

Each pre-fix branch did `resolvePath(config?.vault?.broker?.socket
?? "~/.switchroom/vault-broker.sock")`; post-fix uses
`resolveBrokerSocketPath({ vaultBrokerSocket: ... })` which honors:

  1. `opts.socket` (explicit caller override)
  2. `SWITCHROOM_VAULT_BROKER_SOCK` env (compose-set; the regression
     fix)
  3. `opts.vaultBrokerSocket` (config-derived)
  4. `~/.switchroom/vault-broker.sock` (legacy default)

**Tests.** New `src/vault/broker/resolve-socket-path.test.ts` pins
the precedence so a future refactor can't silently drop the env
step again. 6 cases.

**Operator impact.** Existing v0.7.9 fleets needed `switchroom
update` to pick up the corrected compose env. v0.7.10's CLI fix
takes effect inside agent containers automatically once the new
agent image is pulled — the env is already in place from v0.7.9;
this patch just makes the CLI read it.

## v0.7.9 — broker socket env: canonical name + agent-perspective path

Single-fix patch release for a regression discovered during the
v0.7.8 deploy. The compose generator was emitting two stacked bugs
in how the broker / kernel socket paths plumbed into agent
containers, and an operator-side `VAULT-BROKER-DENIED: broker not
running` error was the surface symptom even when the broker
container was up, healthy, and listening.

**Bug 1 — broker env var name drift (#947).** Compose emitted
`SWITCHROOM_BROKER_SOCKET` into agent containers, but the broker
*client* (`src/vault/broker/client.ts:293`) and the secret-guard
hook (`telegram-plugin/hooks/secret-guard-pretool.mjs:36`) both
read `SWITCHROOM_VAULT_BROKER_SOCK`. The set name was the broker
*server*'s bind-path env (which is set inside the broker container,
where the daemon needs it). Clients in agent containers silently
fell through to the legacy `~/.switchroom/vault-broker.sock`
fallback — a dangling symlink inside the container — and reported
"broker not running" even when the broker was fine. Kernel side
was already correct.

**Bug 2 — wrong path value, both broker and kernel (#947).** Compose
emitted `/run/switchroom/broker/<name>/sock` and `/run/switchroom/
kernel/<name>/sock`, the per-agent subdir as seen by the broker /
kernel containers. But the agent mounts the per-agent volume at
`/run/switchroom/broker` and `/run/switchroom/kernel` directly
(one level shallower than the broker / kernel see it), so inside
the agent the actual sockets are at `/run/switchroom/broker/sock`
and `/run/switchroom/kernel/sock`. Even with the right env name
the value was a path that didn't exist inside the agent.

**Operator impact.** Existing v0.7.8 fleets were running with the
broken env — most workflows didn't notice because vault access
goes through several routes and not all of them hit this lookup.
The secret-guard hook (which gates tool calls that touch vault-
ref'd keys) was the surface that consistently failed. Operators
running `switchroom update` will pick up the new env vars
automatically; agents will reconnect to the broker on the next
request without further intervention.

**No new features in this release** — only the regression fix.

## v0.7.8 — Phase 4 cron-fold-in, honest doctor, host-update CLI

This release closes the v0.7 docker migration with the cron-fold-in
cutover, lands the new operator-facing `switchroom update` and
Telegram `/update` verbs, and stops `switchroom doctor` from crying
wolf about per-agent UID-isolated state files. Net: a multi-agent
fleet on a shared host is now self-healing, observable, and updatable
without leaving Telegram.

### Phase 4 — cron in the agent container, `switchroom-cron` retired

The Phase 4 cutover landed across four PRs that gated the change
behind a canary so a regression couldn't break operator fleets
mid-flight:

- **`dispatchAsInbound` primitive (#890)** — synthesizes a cron fire
  as an `InboundMessage` and dispatches it through the same IPC
  path Telegram uses, so cron-originated turns reach the agent
  through one well-understood code path instead of `docker exec`.
- **Phase 2 — in-agent scheduler sibling, gated/opt-in (#891).**
  The new sidecar shipped first as opt-in; operators could enable
  it per-agent and verify before any default change.
- **Phase 3 — canary dual-run + mutual exclusion (#892).** The host-
  side singleton and the in-container sidecar ran together with
  mutual-exclusion gating so neither would double-fire — proves
  the cutover safe under live traffic.
- **Phase 4 — cron-fold-in cutover (#893).** The singleton
  `switchroom-cron` container is gone. Cron now runs in-container
  in every agent as a sibling of the gateway, delivering fires
  through the same `InboundMessage` IPC path Telegram uses
  (synthesized turns tagged `meta.source="cron"`). One less
  container, one less daemon, one less mode of failure. See
  `docs/scheduling.md` for the post-cutover model.

**Robustness across the in-container scheduler.**

- `cronMatchesDate` accepts node-cron's MON-FRI / JAN aliases (#896 /
  #915) — the replay-on-boot path was silently dropping schedule
  entries that used named days/months.
- Boot-time freshness check defends against PID reuse across
  container restarts wedging the supervisor (#895 / #914).
- `restartAgent` uses `up -d --no-deps` instead of `restart` (#857 /
  #916 / #932 / #944) — fixes the kernel-readiness race after a live
  `agent add` and matches the contract the rest of the lifecycle
  code expects.
- `collectScheduleEntries` walks the cascade-resolved config (#917)
  — was reading raw `config.agents[name].schedule` and dropping
  defaults / profile schedule entries silently.
- Empty schedule idles instead of restart-cap'ing (#921 / #928 /
  #936) — agents with no `schedule:` block stay alive for cron
  re-checks on container restart instead of the supervisor giving
  up after 10 cycles.

**Phase 4 follow-on cleanup (#897 / #899 / #913).** Stale
`build.mjs` comment, CI matrix referencing the deleted
`Dockerfile.scheduler`, and `docs/configuration.md` still describing
the v0.6 systemd model — all cleaned up.

### `switchroom update` — one verb for the host-update flow

**`switchroom update` CLI verb (#918 / #923).** Wraps `git pull` +
`bun install` + `npm run build` + `switchroom apply` + `docker
compose up -d --remove-orphans` + `switchroom doctor` into a single
command. `--check` for a dry-run; `--rebuild` for source-checkout
users; `--skip-images` for offline mode; `--status` for a read-only
snapshot.

**`switchroom apply` self-elevates (#920 / #922).** Prior versions
required the operator to type `sudo HOME=$HOME PATH=$PATH bun
/path/to/switchroom apply` because vanilla `sudo switchroom apply`
hit a remapped HOME and lost the bun-resolved CLI. apply now
self-elevates via `sudo` cleanly.

**Telegram `/update` (#919 / #924).** Operator-side host update
without SSH. `/update` is dry-run; `/update apply` actually runs the
update. The agent container has no docker binary or
`/var/run/docker.sock` — `/update apply` probes both and surfaces a
clean error pointing at the host CLI rather than letting the
detached child fail with opaque exit-127 (#926 / #934).

**Telegram `/upgradestatus` (#927 / #938).** Read-only fleet update
status from any paired Telegram chat. Reports local CLI version,
GHCR image digest + pull time, container creation time per service.
Operator can answer "is the fleet up to date?" without SSH.

### Boot card and `/status` — honest about Phase 4

**Boot-card probes match the post-Phase-4 architecture (#925).**
The Crons probe was lying — it returned `ok` with detail
`"managed by switchroom-cron"`, but that container is gone. Replaced
with `probeScheduler` (lockfile + holder PID liveness + last-fire
freshness from `scheduler.jsonl`). Three other surfaces were
silently missing from the probe set:

- `probeBroker` / `probeKernel` — UDS connect-test against the
  per-agent socket paths. Compose has bind-presence healthchecks
  (#898) but the gateway itself never queried either daemon.
- `probeSkills` — walks `<agentDir>/.claude/skills/` and reports
  any entry whose target is unreadable (a renamed/deleted skill in
  `~/.switchroom/skills/` was dangling silently).

The boot card stays silent-when-healthy by design — only red surfaces.

**`/status` grows a `Health` block.** Same probe set as the boot
card, but renders **every** row including the green ones. Boot
card = quiet ack; `/status` = on-demand dashboard.

**Settle-window-aware soften (#935).** `/status` hit during the
first ~30s of a container's life would show a 🔴 row before the
supervisor had time to fork the scheduler. `probeScheduler` now
reads `/proc/1/stat` to compute container PID-1 start time and
softens the missing-lockfile fail to degraded with `(still settling)`
inside the freshness window. Plus env-path overrides
(`SWITCHROOM_AGENT_SCHEDULER_LOCK` / `_JSONL`) for symmetry with the
scheduler's own override behavior.

### Doctor — stops crying wolf

**EACCES vs ENOENT (#945).** Per-agent state files are mode 0600
owned by the agent UID (compose.ts allocates 10001-10999); doctor
running as the host operator gets EACCES when reading `.env` and
`.oauth-token.meta.json`. Pre-fix this manifested as 16 false-positive
fails on every multi-agent host: 8 `TELEGRAM_BOT_TOKEN missing` +
8 `not authenticated`. Now: warn rows with honest detail
(`unreadable from host — agent reads it fine`), real failures stand
out instead of being buried.

**Leaked `$HOME/.switchroom` detector (#910 / #933 / #943).** Agents
that pre-date the `$HOME/.switchroom` symlink fix have a real
directory at `<agentDir>/home/.switchroom/` that shadows the symlink
the new start.sh tries to create. start.sh defensively skips the
symlink when the slot is occupied — silently. Tilde paths in cron
prompts then resolve to a per-container empty dir instead of host
state. Doctor now flags this with a copy-pasteable recovery recipe.

**`start.sh` scheduler block check (#911).** If an operator
upgraded across the Phase 4 cutover without re-running `switchroom
apply`, their per-agent `start.sh` lacks the agent-scheduler sidecar
block. Doctor surfaces it.

**Post-apply doctor sweep (#929 / #937).** Bare `switchroom apply`
now runs `switchroom doctor` automatically on completion.

**Bind-mounts + tilde-paths (#907 / #910 / #911 / #912).** Agent
containers were missing skills/credentials bind mounts; tilde paths
broke under remapped HOME; doctor's stale-`start.sh` check was
unaware of the new scheduler supervisor block. Bundle fix.

**`agent list` scheduler-state column (#931 / #942).** New column
distinguishes `active` (lockfile fresh, recent fire), `idle` (alive
but no schedule entries), `wedged` (lockfile stale or holder PID
dead). Single command for "is cron working across the fleet?".

### Test discipline — phase tests must not clobber production

**The 2026-05-10 incident.** PR #916 un-skipped three destructive
docker phase tests on a host that also runs production switchroom.
Each test's `beforeAll` ran `docker rm -f switchroom-vault-broker`
and `switchroom-approval-kernel` to "clean up" — using the **production
singleton names**. The compose generator hardcoded those fixed
container_names too, so the tests' `docker compose up` collided
with live production containers. After the test's project-scoped
`compose down`, the production fleet had no broker or kernel — the
operator's `klanker` agent failed all `/vault` calls.

**Two-layer fix.**

- `productionFleetIsLive()` / `assertNoProductionFleet()` helpers
  (#939). Detection by `switchroom.fleet=switchroom` label, not by
  container name. Wired as `describe.skipIf(... || PROD_FLEET_LIVE)`
  into per-agent-isolation, broker-ipc-race, v0.7-install-e2e tests.
- `containerNamePrefix` parametrization on `generateCompose` (#939
  + #941). Defaults to `"switchroom"` — production unchanged. Tests
  pass `containerNamePrefix: PROJECT` so emitted names become
  `phase1c-iso-NNN-vault-broker` etc., which cannot collide with
  production. The `switchroom.fleet` label is also parametrized so
  parallel vitest forks don't false-positive each other (#941).

### Refactor

**Drop legacy v0.6 systemd dual-path code (#906).** Pre-Phase-4 the
codebase carried both systemd-supervised-host and
docker-compose-managed paths. Phase 4 makes docker mode the only
shape; this PR deletes the systemd branches entirely. Smaller
surface, cleaner naming.

### Persistent agent home + base packages

**Persistent agent `$HOME` (Layer 1) + Tier 1 base packages
(#887).** Agents now have a stable per-agent `$HOME=/state/agent/home`
that survives container recreation — `~/.bashrc`, `~/.config`,
shell history, anything an interactive session writes. Plus the
agent base image bundles the small set of Tier 1 OS packages
(python3-pip, build-essential, etc.) the common skills depend on,
so first-run `pip install` doesn't immediately fail with "command
not found". Closes the v0.7-era footgun where agents lost their
shell state on every restart.

**Layer 1 follow-ups (#888).** `pip install` resolves the agent's
`$HOME/.local/bin` correctly; agent UID resolves cleanly inside
the container; the v0.7 install e2e test asserts the persistent
HOME survives recreation.

### v0.6 → v0.7 cutover loose ends (operator-impact bugs surfaced
in real migrations)

- **Three migration bugs (#882)** — surfaced when an operator with
  a populated v0.6 install ran the docker cutover. Bundle fix.
- **Two more cutover bugs (#885)** — `.mcp.json` regenerated on
  apply (was inheriting v0.6 paths); gateway boot mutex now
  works under the docker process tree.
- **Docker-aware startup health probes (#886)** — no more
  "systemctl: not found" inside agent containers. The v0.6 health
  surface was systemd-shaped; the v0.7 probes detect docker mode
  and use `/proc` walks instead.

### Telegram surface fixes

**Progress card no longer freezes at "⚠ Stalled" (#889).** When the
streamer's keep-alive watchdog fired during a slow-but-not-stalled
turn, the card edited to "⚠ Stalled" and never recovered even after
the turn completed normally. Fixed.

### Docs

**Architecture docs refresh for post-Phase-4 (#900).** `docs/
architecture.md` and `docs/scheduling.md` updated for the in-
container scheduler model.

**CLAUDE.md refresh for v0.7.8 sprint (#930 / #940).** Operator-
agent runbook updated with new sidecar topology, env knobs
(`SWITCHROOM_INLINE_SCHEDULER`, `SWITCHROOM_AGENT_SCHEDULER_*`),
and self-restart command behavior under `/restart`, `/new`, `/reset`,
`/update apply`.

### Other

- DAC_READ_SEARCH on approval-kernel so the healthcheck works (#901)
- `switchroom apply` exits non-zero when scaffold fails (#903) +
  `--compose-only` escape hatch
- bake `switchroom` CLI into agent image (#904)
- bind-mount skills + credentials (#907 / #912)

## v0.7.7 — Docker migration: completed for fresh installs

This release completes the v0.6 → v0.7 docker migration. v0.7.0–7.3
shipped the compose generator, lifecycle dockerization, and broker
IPC; v0.7.4–7.7 close the gaps that prevented a fresh install from
working end-to-end. After this release, a new operator can install
switchroom, run `switchroom apply` + `docker compose up -d`, and
exchange Telegram messages with their first agent without any host-
side systemd, no dev checkout, and no manual sidecar wiring.

The full set of fixes since v0.7.0:

**v0.7.4 — broker hardening (#872, #873).**

- Broker container regains `DAC_READ_SEARCH` so root-in-container
  can read host-owned (mode 0600) `vault.enc` and `vault-auto-unlock`
  files that the surrounding `cap_drop: ALL` would otherwise block.
- `/etc/machine-id` is bind-mounted from host into the broker so
  the in-container AES key derivation matches what the host's
  `enable-auto-unlock` produced.
- The compose generator emits `/run/switchroom/broker/<agent>/sock`
  per agent (subdir form, matching the kernel pattern); the broker
  enumeration now accepts both flat `<agent>.sock` files and the
  subdir shape, and chowns sockets to the agent UID so non-root
  agent containers can connect.
- Agent containers run with `network_mode: host` so scaffolded
  `start.sh` reaches hindsight at `127.0.0.1:18888` and operator
  LAN devices unchanged from v0.6.
- python3 added to the agent base image so the hindsight memory
  plugin's session_end / session_start hooks work.
- `tty: true` + `stdin_open: true` on agent compose services so
  claude's interactive mode allocates a PTY and doesn't fall through
  to `--print` mode (which immediately errors with no stdin).

**v0.7.5 — in-container tmux supervisor (#874).**

- v0.6 ran tmux + autoaccept-poll outside the agent process (systemd
  ExecStart wrapped in tmux, ExecStartPost spawned the poller on the
  host). v0.7 dockerized neither piece: claude blocked forever on
  the dev-channels acknowledge prompt and `switchroom agent attach`
  failed with no tmux server inside the container.
- `profiles/_base/start.sh.hbs` now has a docker-mode preamble that,
  on first entry under tini, forks autoaccept-poll as a sidecar and
  re-execs into tmux with the same script as the inner command.
  Inside tmux the marker is set, the preamble is skipped, and claude
  starts normally with a real PTY at stdin.
- `docker/Dockerfile.agent` bakes the autoaccept-poll bundle to
  `/opt/switchroom/autoaccept-poll.js` so start.sh has a stable
  in-image path regardless of host install layout.

**v0.7.6 — gateway daemon + plugin baking (#875).**

- The MCP sidecar that claude spawns for the `switchroom-telegram`
  channel exits at boot if no gateway daemon is reachable: "no
  gateway socket; check `systemctl --user status switchroom-telegram-
  gateway`". v0.6 ran the gateway as a sibling systemd unit; v0.7
  had no equivalent.
- `start.sh.hbs`'s docker preamble now also forks
  `bun /opt/switchroom/telegram-plugin/dist/gateway/gateway.js` as
  a supervised sidecar (under a small `_switchroom_supervise` bash
  helper that respawns on crash with a 10-restarts-in-60s cap).
- `docker/Dockerfile.agent` bakes the telegram-plugin (`dist/`,
  `start.js`, `package.json`) into `/opt/switchroom/telegram-plugin/`.
- `scaffold.ts` emits a docker-mode `.mcp.json` (new `dockerMode?`
  parameter on `scaffoldAgent` and `reconcileAgent`) that points
  `--cwd` at the in-image path, `SWITCHROOM_CLI_PATH` at the
  in-image binary, and `SWITCHROOM_CONFIG` at the bind mount.
- The compose generator bind-mounts `switchroom.yaml` into each
  agent service so the gateway daemon can shell out to the
  switchroom CLI with `--config`.

**v0.7.7 — operator UX (#876).**

- `switchroom apply --only=<agent>` for one-at-a-time cutover.
  Scopes scaffold + UID-align to one agent so siblings still on
  systemd keep running while operators migrate piecemeal. Compose
  still walks the full fleet so per-agent socket volumes for
  not-yet-cutover agents stay correct in YAML.
- `docs/operators/migration-v0.7.md` (doc since removed) rewritten
  from the field: auto-unlock as a hard precondition, all-at-once vs
  one-at-a-time guidance, image-source clarification (`pull` vs `--build-local`),
  expanded snapshot step including systemd unit files.

**Also in this release window:**

- `agent list` reports correctly on host-shell systemd fleets
  during the v0.6 → v0.7 transition (#871). Was: every agent
  appeared `inactive`. v0.7 PR-C1 had docker-only-ized
  `getAgentStatus` without keeping the systemd branch.
- Manifest drift cleared (#871).

**Upgrade path for v0.7.0–v0.7.3 fleets:** rebuilt GHCR images
(`ghcr.io/switchroom/switchroom-{base,agent,broker,kernel,scheduler}:v0.7.7`)
include all of the above. `switchroom apply && docker compose pull
&& docker compose up -d` picks up the new images on existing fleets.
Read the updated migration doc — auto-unlock is now a hard
precondition (was an optional knob) and the compose chown loop has
the new `--only` flag.

## v0.7.3 — Runtime detection + audit fixes

Closes the v0.7.2 audit findings that survived into the released code.
Each finding was verified against live source before being patched.

**Fixes:**

- **`isDockerRuntime()` host-shell detection** (BLOCKER from audit §3a).
  v0.7.2 gated docker-aware branches on
  `process.env.SWITCHROOM_RUNTIME === "docker"` — but that env var is
  only set INSIDE containers (by `compose.ts`), never on the host.
  An operator running `switchroom agent status myagent` /
  `switchroom doctor` from their host shell got the systemd fallback
  even on a docker fleet, reporting "inactive" forever. v0.7.3 adds
  a unified helper `src/runtime-mode.ts isDockerRuntime()` that fires
  on EITHER signal: env var (in-container case) OR existence of
  `~/.switchroom/compose/docker-compose.yml` (host-shell case).
  Wired into `src/agents/status.ts:defaultStatusInputs`,
  `src/cli/agent.ts:preflightCheck`, and `src/cli/doctor.ts`'s
  `checkGatewayUnit` gate (which was calling `isDockerMode()` with
  no `composePath`, hitting only the env-var branch).

- **`vault-auto-unlock` placeholder pre-creation** (BLOCKER from audit
  §1a). v0.7.1's `ensureHostMountSources` mkdir'd directories but
  left files alone. The `~/.switchroom/vault-auto-unlock` mount
  source could still be created as a root-owned DIR by docker on
  greenfield installs (the same bug class v0.7.1 claimed to close).
  Apply now writes a 0-byte placeholder file at that path with mode
  0600 if missing; the broker reads empty bytes, fails decrypt,
  falls back to interactive unlock cleanly (per
  `src/vault/broker/server.ts:1503-1518`); a later
  `switchroom vault broker enable-auto-unlock` overwrites the
  placeholder via `writeFileSync` (per `auto-unlock.ts:199`).

- **Inline-button error message wrong service name** (audit §2a).
  v0.7.2's `case 'restart'` callback under docker pointed operators at
  `docker compose -p switchroom restart switchroom-${agent}`. But
  compose generates SERVICE name `agent-${name}` (`compose.ts:408`)
  with `container_name: switchroom-${name}`. `docker compose restart`
  takes a service, not a container — the suggested command would
  error with "no such service". Now correctly emits `agent-${agent}`.

- **`case 'logs'` callback systemd-only** (audit §2d). Sister of the
  audit §2a fix — v0.7.2 fixed `restart` but missed the same
  migration on the operator-events `logs` button. Under docker the
  inline-button log fetch (which shells out to `journalctl --user`)
  errored. Now under docker it returns an actionable message
  ("Run from the host: docker logs --since 30m --tail 30
  switchroom-${agent}") rather than spawning journalctl in a
  container without systemd.

- **`Status === "restarting"` distinct from "inactive"** (audit §3b).
  v0.7.2's `readDockerContainer` collapsed every non-running state
  into `inactive`, hiding the crash-loop signal that the
  now-disabled watchdog used to surface. v0.7.3 maps `restarting`
  to its own bucket so the renderer / status caller can tell a
  flapping container from a cleanly stopped one.

**Tests:** new `src/runtime-mode.test.ts` (4 cases covering env var,
compose file, neither, parent-only). Updated `status-runtime.test.ts`
to mock the runtime-mode helper. Added a `restarting` case for
`readDockerContainer`. 5077 vitest + 3330 bun pass (the 1 bun
failure is the new UAT smoke test from PR #868 which requires
`SWITCHROOM_UAT_CHAT_ID`, unrelated to this PR).

**Audit findings explicitly DEFERRED to v0.7.4+:**

- §2c: `triggerSelfRestart`'s 300ms IPC-flush grace doesn't actually
  drain the socket — the gateway's IPC code should `socket.end()` +
  await `'finish'` before the SIGTERM-to-PID-1 setTimeout fires.
  Architectural change; needs design.
- §4a: crash-loop signal silently lost when watchdog is disabled
  under docker. Either add `restart: on-failure:N` to compose or
  surface `RestartCount` via a periodic host-side scheduler check.
- §5a: under docker, `preflightCheck` only checks `start.sh`;
  docker-mode equivalents (image presence, compose validity, UID
  alignment readback) aren't yet covered. doctor's `runDockerSection`
  partially fills this but isn't invoked from agent lifecycle verbs.
- §6a: gateway code changes ship in `telegram-plugin/gateway/` which
  runs INSIDE the agent container; v0.7.2/v0.7.3 fixes only land on
  hosts that pull republished GHCR images. CHANGELOG should call
  this out at release time, and a tag→GHCR cycle should happen
  before announcing v0.7.3.

## v0.7.2 — Docker runtime alignment

Closes the v0.7-era code paths that still assumed the legacy systemd
runtime. Each was verified against live source (no audit assumptions)
before being patched.

**Fixes:**

- **`telegram-plugin/gateway/gateway.ts` self-restart** — the gateway's
  three `spawn('sh', ['-c', 'sleep … && systemctl --user restart …'])`
  callsites and the inline restart-button `execFileSync('systemctl', …)`
  all branch through a new `triggerSelfRestart(targetAgent, reason)`
  helper. Under `SWITCHROOM_RUNTIME=docker` the helper sends `SIGTERM`
  to PID 1 (tini) of the agent's container after a 300ms grace; tini
  propagates to the whole tree (claude → start.sh → gateway plugin),
  the container exits, and docker compose's `restart: unless-stopped`
  policy recreates it. Cross-agent restart (the inline-button case
  for a target other than this gateway's own agent) is rejected
  cleanly under docker with an actionable message — no docker.sock
  inside agent containers, by design. Under legacy systemd the helper
  preserves the existing detached `systemctl --user restart` shape.

- **`telegram-plugin/gateway/restart-watchdog.ts`** — the watchdog
  polls systemd's `NRestarts` counter to detect crash loops. There's
  no equivalent counter accessible from inside an agent container
  without mounting `docker.sock` (a deliberate security regression
  we avoid). Under `SWITCHROOM_RUNTIME=docker` the gateway now skips
  `startRestartWatchdog` entirely and logs the reason; container
  restart visibility comes from the boot card + gateway boot logs in
  docker mode.

- **`src/agents/status.ts`** — added `readDockerContainer` adapter
  that calls `docker inspect --format '{{json .State}}'` and maps
  `State.{Status,Pid,StartedAt}` into the canonical
  `{pid, activeEnterTs, active}` shape that `buildClaudeStatus` /
  `buildGatewayStatus` already consume. `defaultStatusInputs` picks
  systemd vs docker adapters based on `SWITCHROOM_RUNTIME=docker`.
  Under docker, both the Claude and gateway readers query the same
  `switchroom-<agent>` container — claude and the gateway plugin
  share that container in v0.7. With this, `switchroom agent status
  <name>` reports the right state for docker fleets.

- **`src/cli/agent.ts` `preflightCheck`** — the systemd-unit existence
  check (and the autoaccept-handler check that depends on parsing
  the unit file) is skipped under `SWITCHROOM_RUNTIME=docker`. Only
  the `start.sh` existence check still runs (it's runtime-agnostic).

- **`src/cli/doctor.ts`** — `checkGatewayUnit` (which validates a
  per-agent systemd gateway unit pins `Environment=SWITCHROOM_AGENT_NAME`)
  is now gated on `!isDockerMode()`. Under docker the analogous env
  var is set in compose.ts and verified by the dockerSection's
  compose-shape checks.

- **`profiles/_shared/telegram-style.md.hbs`** — agent skill copy that
  pointed users at `journalctl --user -u switchroom-<agent>` and
  `journalctl --user -t switchroom-watchdog` for restart forensics.
  Updated to lead with the docker equivalents (`docker logs --since
  2h …`, `docker inspect --format '{{.State.StartedAt}}{{println}}{{.RestartCount}}'`)
  and note the systemd commands as legacy fallbacks. Watchdog source
  documented as silent under docker (matching the runtime change above).

**Audit findings that were FALSE on current main** (verified against
live source, not just trusted from the audit):

- `doctor.ts` was claimed to hard-check for `systemctl`. Actually
  `checkBinary("docker", ...)` is the only binary check on line 147;
  there's no systemctl check.
- `README.md` was claimed to still advertise the systemd path. Actually
  every systemd / `--legacy` reference was already removed in the v0.7
  docs sweep.
- `docs/architecture.md` already says "v0.7+ runtime is Docker on
  Linux. The legacy systemd path was removed in v0.7."
- `docs/scheduling.md` has zero systemd references.

**No breaking changes** — every behavior under `SWITCHROOM_RUNTIME != docker`
is byte-identical to v0.7.1.

## v0.7.1 — v0.7 install hotfix

**Fixes (P0 install blockers from v0.7.0):**

- **Compose: vault file mounted as a directory.** The broker mount was
  `${HOME}/.switchroom/vault:/state/vault` but the actual vault file is
  `~/.switchroom/vault.enc` (a top-level file, not a `vault/` subdir).
  Docker auto-created the missing source as an empty root-owned
  directory on the host, the broker found no vault, and the fleet
  restart-looped. Now mounted as the file directly:
  `~/.switchroom/vault.enc:/state/vault.enc:ro` plus an explicit
  `SWITCHROOM_VAULT_PATH` env so the broker doesn't fall back to its
  `~`-expanding default (which resolves to `/root/...` inside the
  container).
- **Compose: agent containers crash-looped on `cd` to a host path.**
  Scaffolded `start.sh` bakes the absolute host path of `agentDir` at
  scaffold time (`cd "/home/<user>/.switchroom/agents/<name>"`), but
  the bind mount destination was `/state/agent` — so the host path
  didn't exist inside the container. Fixed by dual-mounting: the
  same host directory is bound BOTH at the canonical `/state/agent`
  (Dockerfile compatibility) AND at the original host path
  (start.sh compatibility). Same applies to `/state/.claude` and
  `/var/log/switchroom`. No image rebuild required to pick up this
  fix — operators just `switchroom apply` and
  `docker compose -p switchroom up -d`.
- **Apply: defensive `mkdir` on host bind-mount sources.** Before
  generating the compose file, `apply` now creates every directory
  that compose will bind-mount (under the operator's UID), preventing
  docker from auto-creating them as root. Closes the bug class that
  produced both the `~/.switchroom/vault` and
  `~/.switchroom/vault-auto-unlock` root-owned stub directories
  observed during v0.7.0 cutovers.
- **package.json: bump version to `0.7.1`.** It had been stuck at
  `0.5.2` across multiple releases; the gateway boot card reads
  `package.json` via `src/build-info.ts` and was reporting
  `v0.5.2 · #826` even on v0.7 fleets.

**Known v0.7 issues NOT addressed in this release** (filed as
follow-ups; impact: agent self-restart, `switchroom agent status`,
and the boot watchdog still assume systemd in places):

- `telegram-plugin/gateway/gateway.ts` spawns `systemctl --user restart …`
  for graceful restart and quota-rotation flows; needs a docker-aware
  branch (exit 0 and let `restart: unless-stopped` recreate the
  container).
- `telegram-plugin/gateway/restart-watchdog.ts` reads systemd unit
  state to detect crash loops; needs a `docker inspect` fallback.
- `src/cli/agent.ts` checks for `~/.config/systemd/user/switchroom-*.service`
  unit files in several lifecycle verbs even under `SWITCHROOM_RUNTIME=docker`.
- `src/agents/status.ts` `readSystemdUnitStatus()` is the only source
  of agent state for `switchroom agent status`; needs a `docker ps`
  fallback.
- `src/cli/doctor.ts` still hard-checks for `systemctl` and prints
  "Switchroom requires a systemd-based Linux distro".

## v0.7.0 — Docker-only (BREAKING)

**Breaking changes:**
- `switchroom up`, `switchroom init` now deprecation aliases for `switchroom apply`. Removed in v0.8.
- `switchroom update` replaced with deprecation shim that prints the docker upgrade recipe and exits 1.
- `switchroom systemd` verb tree removed entirely.
- `--legacy` flag on `switchroom up` removed; switchroom is docker-only on Linux now.
- Forum-mode prompts removed from `switchroom setup`; default is per-agent DM bots.

**Adds:**
- Static CLI binary distribution via GitHub releases + `install.sh`.
- GHCR image publishing on tag push.
- Compose generator includes top-level `name: switchroom` and absolute HOME paths.
- Vault preflight + compose-v2 detection in `apply`.
- UID alignment for bind-mounted agent state dirs (fail-hard by default; `--allow-unaligned` opt-out).

**Removes:**
- `bin/bridge-watchdog.sh` — Docker `restart: unless-stopped` + per-service healthchecks supersede.
- `src/agents/systemd.ts` and the entire systemd unit-template + reconcile machinery.
- 5 unit-targeted test files; 4 watchdog integration tests.

**Migration:** see `docs/operators/migration-v0.7.md` (doc since removed).

**Scope:** Linux only. Mac (Docker Desktop) validation tracked as Phase 3.5.

## v0.6.0 — Docker substrate (Linux), single-host

**Adds:**
- `switchroom up` runs the fleet under Docker Compose by default on Linux (per-agent containers, broker + approval kernel IPC ported to host-UID sockets).
- `switchroom up --legacy` keeps the systemd path for operators who want it.
- CI snapshot gate guarantees test runs leak zero containers onto host docker.

**Removes (vs the original RFC):**
- No `switchroom migrate to-docker/to-host` command. Fresh installs only.
- No Docker fleet watchdog port — `bin/bridge-watchdog.sh` continues to supervise the legacy systemd path; Docker fleets self-restart via compose `restart: unless-stopped`.
- No GHCR digest-pin workflow. Images build locally on `switchroom up`.

**Scope:** Linux only. Mac (Docker Desktop) validation tracked separately as Phase 3.5.

## v0.5.2 — 2026-05-07

Patch release. Unblocks `npm publish` (the v0.5.1 prepublish hook
failed on pre-existing tsc errors that masked stale field reads in the
approvals-list command).

### Fixed

- **Type-system catch-up to runtime usage (#779)** — declare
  `experimental` (`{ legacy_pty?, legacy_autoaccept_expect? }`),
  `telegram.webhook_dispatch`, and `WebhookHandlerArgs.dispatchConfig`
  on the config schema. Purely additive; no behaviour change. Follow-up
  #780 tracks extracting `ExperimentalSchema` with the
  `tmux_supervisor` → `legacy_pty` migration transform.
- **`/approvals list` field renames (#779)** — bring
  `telegram-plugin/gateway/approvals-commands.ts` field reads in line
  with the real `ApprovalDecisionMeta` shape (`agent_unit`, `action`,
  `ttl_expires_at`). Was silently rendering `undefined` for those
  columns.

## v0.5.1 — 2026-05-07

Twenty commits since v0.5.0. Headlines: approval-kernel RFC B
Phase 1 lands (IPC broker + SQLite kernel + Telegram card primitive),
Google Drive MCP integration ships end-to-end (RFC C — full
integration, desktop-loopback OAuth tier, `drive:` config block, CLI
connect/disconnect), gateway gains a card audit log + structured
`card-events.jsonl` tagging, and operational fixes for vault preflight,
self-restart UX, cron DM routing, and the bg-agent silent-card bug.

### Added

- **Approval kernel RFC B Phase 1 (#762)** — IPC broker + SQLite kernel
  + Telegram card primitive; the substrate for human-in-the-loop
  approval flows.
- **`waitForApproval` short-poll helper (#765)** — ergonomic agent-side
  API on top of the kernel.
- **Google Drive MCP integration — RFC C full landing (#763)**.
- **Drive CLI: `switchroom drive connect` / `disconnect` (#766)**.
- **Drive desktop-loopback OAuth tier (#767)** — RFC C tier 3, no
  service-account JSON required.
- **`drive:` config block (#768)** — first-class config, replaces /
  supplements env-var wiring.
- **Vault pre-flight check on `agent restart` (#773)** — fails fast
  with a clear message instead of looping on a locked vault.
- **Self-restart on non-admin commands + warn on admin cmds (#775)** —
  better UX when the gateway needs to bounce itself.
- **Card audit log (#777)** — `card-events.jsonl`, `tg-post` tagging
  with `turnKey` / `cardMessageId`, `sub_agent_finished` events, and
  50 MB × 5 file rotation for forensic replay.

### Changed

- **RFC docs land for the approval kernel (#756, #764)** — three RFCs
  (A bot-token, B kernel, C gdrive) and a follow-up alignment of RFC B
  with the shipped implementation (TTL default, schema columns, audit
  split).
- **`bun.lock` workspace name reconciled `clerk-ai` → `switchroom`
  (#750)**.

### Fixed

- **Bg-agent progress card goes silent (#759, fixes #757)**.
- **`approval-callback` signature alignment + `materializeBotToken`
  catch tightened (#770, #771)**.
- **Cron DM routing for `dm_only` agents (#774)**.
- **`materialize TELEGRAM_BOT_TOKEN` from vault at startup (#758/#761)**.
- **Webhook dispatch: prepend nvm node bin to spawn PATH (#754)**.
- **`handleWebhookIngest` now receives `dispatchConfig` (#753)**.
- **Autoaccept new `dev-channels` prompt + reconcile systemd-unit drift
  (#749)**.

## v0.5.0 — 2026-05-06

Initial release of `switchroom` (npm package renamed from
`switchroom-ai`). The historical `switchroom-ai` package on npm is
deprecated — see https://www.npmjs.com/package/switchroom for the new
home. Version reset to 0.5.0; the 25 prior `switchroom-ai` tags are
documentation-only and will be cleaned up out-of-band.

This release consolidates the in-flight work from PRs #738 / #740 /
#742 / #743 / #745 / #747 into a single disciplined first cut on the
new package name. Substantive changes from prior `switchroom-ai@0.6.14`:

### Changed

- **tmux supervisor is now the default (#725 PR-1)** — `script -qfc`
  PTY wrapping is replaced by per-agent `tmux new-session` for all
  agents by default. The user-facing flag rename is
  `experimental.tmux_supervisor` → `experimental.legacy_pty` (inverted
  meaning). New default behaviour materialises on the next agent
  restart (`switchroom systemd reconcile && switchroom agent
  restart <name>`); units are not auto-restarted by the upgrade. tmux
  is now a hard prereq (`install.sh` enforces); hosts without tmux
  must opt agents into legacy via `experimental.legacy_pty: true`.
  See `docs/tmux-supervisor-fanout.md` for the rollback runbook.
- **`!` interrupt marker now delivers SIGINT via `tmux send-keys C-c`
  for tmux-supervised agents (#725 PR-3)**, falling back to
  `systemctl kill --signal=INT` on send-keys failure. Better signal
  delivery to runaway tool children.
- **First-run autoaccept now uses a TS pane-poller instead of `expect`
  (#725 PR-4)** — the small set of first-run claude TUI prompts (theme
  picker, MCP trust, dev-channels acknowledgement, API provider) are
  now dispatched by a `tmux capture-pane` + `tmux send-keys` poller
  fired from the agent unit's `ExecStartPost=`. Soft-fail throughout;
  exits cleanly after ~30s of pane idle. The legacy `expect` wrapper
  (`bin/autoaccept.exp`) is preserved as a one-release rollback knob:
  set `experimental.legacy_autoaccept_expect: true` per-agent to revert.
- **`experimental.tmux_supervisor` deprecated** — still parseable for
  one release with a one-time stderr warning. Migration is automatic.

### Added

- **Watchdog crash-time pane capture (#725 PR-2)** — before triggering
  any restart (bridge-disconnect, turn-hang, journal-silence), the
  watchdog now snapshots the agent's tmux pane scrollback to
  `~/.switchroom/agents/<agent>/crash-reports/<ISO8601>-<reason>.txt`
  so RCA has the live screen state at the moment of the kill.
  Retention: 20 most recent files per agent. Size cap: 10 MB per
  file. See `docs/crash-reports.md`.
- **Preflight accepts `autoaccept-poll` wiring (#745)** — the
  `switchroom agent restart` preflight in `src/cli/agent.ts` now
  accepts either the legacy `expect autoaccept.exp` wrapper or the
  new `autoaccept-poll` ExecStartPost, and only requires the `expect`
  binary on PATH when the legacy wrapper is in use.

### Fixed

- **Build now bundles `dist/cli/autoaccept-poll.js` (#747)** — the
  systemd unit's `ExecStartPost=` references the bundled `.js`
  artifact; prior internal cuts shipped without it, breaking
  default-mode units on fresh installs.

### Added

- **Webhook ingest hardening (#714)** — two defenses added to
  `src/web/webhook-handler.ts` before auto-dispatch ships:
  - **Dedup by `X-GitHub-Delivery`**: per-agent LRU (1000 entries, 24h
    retention) backed by `~/.switchroom/agents/<agent>/telegram/webhook-dedup.json`.
    Replay returns 200 `{ok:true,deduped:true}` and skips JSONL append.
    Generic source has no delivery header — dedup is skipped silently.
  - **Per-source token-bucket rate limit**: off by default; opt-in via
    `channels.telegram.webhook_rate_limit.rpm` in switchroom.yaml (set
    e.g. `rpm: 60` for one request/sec sustained, burst equal to rpm).
    When enabled, exceeding the limit returns 429 with `Retry-After`.
    First throttle event per `(agent, source)` per 60s window is written
    to `<agent>/telegram/issues.jsonl` for Telegram visibility.
  - `webhook_rate_limit` added to `TelegramChannelSchema` in
    `src/config/schema.ts`; cascades via the existing channels deep-merge.

### Added

- **Webhook ingest hardening (#714)** — two defenses added to
  `src/web/webhook-handler.ts` before auto-dispatch ships:
  - **Dedup by `X-GitHub-Delivery`**: per-agent LRU (1000 entries, 24h
    retention) backed by `~/.switchroom/agents/<agent>/telegram/webhook-dedup.json`.
    Replay returns 200 `{ok:true,deduped:true}` and skips JSONL append.
    Generic source has no delivery header — dedup is skipped silently.
  - **Per-source token-bucket rate limit**: off by default; opt-in via
    `channels.telegram.webhook_rate_limit.rpm` in switchroom.yaml (set
    e.g. `rpm: 60` for one request/sec sustained, burst equal to rpm).
    When enabled, exceeding the limit returns 429 with `Retry-After`.
    First throttle event per `(agent, source)` per 60s window is written
    to `<agent>/telegram/issues.jsonl` for Telegram visibility.
  - `webhook_rate_limit` added to `TelegramChannelSchema` in
    `src/config/schema.ts`; cascades via the existing channels deep-merge.

## v0.6.14 — 2026-05-05

Bundle re-release. v0.6.13's /reauth removal is in this version too —
v0.6.13 was tagged on GitHub but the npm publish was rejected by
prepublishOnly (the architectural-pin test for `redactAuthCodeMessage`
call sites needed its floor lowered after the /reauth handler was
removed). v0.6.14 ships both:

- **#705** — remove /reauth typed Telegram command
- **#706** — update redactAuthCodeMessage call-site pin (test floor
  3 → 2; docstring updated to reflect the 2 remaining call sites:
  generic intercept + /auth code intent)

The v0.6.13 git tag stays for historical accuracy; npm consumers
should install v0.6.14.

## v0.6.13 — 2026-05-05

### Removed

- **`/reauth` typed Telegram command gone.** Same consolidation
  rationale as `/authfallback` in v0.6.12: the `/auth` dashboard's
  `🔄 Reauth default` button fires the identical flow (calls
  `runSwitchroomAuthCommand` with `auth reauth <agent>` and seeds
  `pendingReauthFlows`). Two paths to the same outcome made the auth
  surface confusing.
  - The OAuth code paste-back still works without a typed command —
    the generic message intercept watches `pendingReauthFlows` and
    exchanges any code-shaped paste automatically.
  - Slash-menu entry, autocomplete name list, and help-text line all
    dropped.
  - The `/auth` slash-menu description updated to reflect the
    consolidated surface ("Auth dashboard — accounts, quota, reauth,
    switch primary").

### Tests

- `welcome-text` regression test pinning that `/reauth` is absent
  from the menu, autocomplete, and as a top-level help entry — same
  shape as the `/authfallback` regression test from v0.6.12.

## v0.6.12 — 2026-05-05

### Removed

- **`/authfallback` typed Telegram command gone.** Duplicated the
  work of the dashboard's Switch primary picker (operator-facing) and
  the auto-fallback poller (transparent on-quota-wall case). Two
  paths to the same outcome confused operators. The
  `runAutoFallbackCheck` function and the `case 'fallback':` callback
  dispatch stay in the codebase: any pinned messages from earlier
  versions still work, and the auto-fallback poller still calls
  `runAutoFallbackCheck` directly.
  - Slash-menu entry, autocomplete name list, and help-text line
    all dropped.
  - Doc comments updated to point at `/auth` Switch primary instead.

### Tests (regression coverage for v0.6.10–v0.6.12)

- `welcome-text` — pin that `/authfallback` is absent from the slash
  menu, autocomplete list, AND help text (3 separate surfaces).
- `auth-dashboard-v3b` — main board renders ≤6 keyboard rows with
  three accounts (catches the v3b 8-button explosion); no Promote
  callback ever targets the active label (catches the screenshot
  bug); `[⚠️ Fall back now]` button stays absent under every quotaHot
  / slot-health / accounts-shape combination.
- `quota-check` — boot-warm + delayed sync-read sequence returns
  last-known data after 8.5min (the screenshot reproduction window);
  `prefetchAccountQuotaIfStale` re-probes once past TTL but no-ops
  while fresh; cache TTL pinned ≥60s so a future PR can't re-create
  the empty-row bug.

## v0.6.11 — 2026-05-05

### Fixed

- **Per-account quota mini-bars now persist past the cache TTL.**
  Pre-v0.6.11 `getCachedAccountQuota` treated stale entries as a
  miss, which meant the boot-warmed cache vanished after 30s and the
  operator saw empty quota rows on the first `/auth` tap of any
  session past that window. Now the sync read returns whatever's
  cached regardless of staleness; the background prefetch
  (`prefetchAccountQuotaIfStale`) keeps the cache fresh on every
  dashboard render. Cache TTL also bumped from 30s → 5min — quota
  doesn't move that fast, and the prefetch path keeps it fresh
  whenever the operator interacts.

### Removed

- **`[⚠️ Fall back now]` button gone from `/auth`.** The Switch
  primary picker (v0.6.10) is the operator-facing surface for "active
  is hot, swap to a fallback"; the auto-fallback poller still handles
  the automatic case when the active hits its quota wall. Two paths
  doing the same thing was confusing. The `fallback` callback verb
  stays in the parser/dispatcher for legacy reachability of any
  pinned messages bearing the pre-v0.6.11 button.

## v0.6.10 — 2026-05-05

### Changed

- **Auth card v3c — Switch primary picker replaces button flood.**
  v3b's per-fallback `⤴ Promote` rows + per-account drilldowns
  produced 6+ buttons stacked vertically with three accounts. v3c
  collapses them into a single `🔀 Switch primary →` entry that
  opens a picker sub-keyboard listing fallbacks as one-tap promote
  targets. The picker IS the confirmation surface (no second confirm
  screen). Cancel returns to the main dashboard via refresh.
  Result: ~4 buttons on the main board instead of 8 with three
  accounts, scaling cleanly to 5+. Legacy `apr`/`cpr` callback verbs
  preserved for messages already pinned with the v3b layout.

### Fixed

- **Per-account quota mini-bars now appear on first `/auth` after
  agent restart** — the gateway boot path eager-warms the in-process
  quota cache for every account. Without this, the cache was cold on
  first render → no mini-bars → operator had to tap Refresh.
- **Cache re-warm after every auth-mutating dashboard tap** — every
  enable / disable / promote / share / account-rm now schedules a
  background quota probe alongside the existing cache invalidation,
  so the post-action dashboard render sees fresh quota.

## v0.6.9 — 2026-05-05

### Added

- **Auth card v3b (#699)** — Telegram `/auth` answers three operator
  questions in one glance:
  - Which account is driving traffic right now? `▶ you@example.com`
    + inline mini-bars (`5h ██░░░░ 47%  ·  7d ░░░░░░ 12%`).
  - Which accounts are failover targets? Indented under
    `Fallback ↓:`, in YAML-list order (the actual failover order,
    load-bearing post-#697).
  - How do I switch primary without leaving Telegram? `⤴ Promote`
    button under each fallback, two-stage confirm.
- **`switchroom auth promote <label> <agents...>`** — moves a label
  to position 0 of each agent's `auth.accounts:`. Refuses when not
  already enabled (promote reorders; enable enables). Idempotent at
  the already-primary boundary.
- **`auth account list --json`** gains `primaryForAgents: string[]`
  so the dashboard can mark each agent's active account.

### Fixed

- **Slots + Pool sections hide when the active account is known
  (#699)** — under the new account model the Slots row and Pool line
  duplicate the `▶ <label>` active-account row 1:1, just with an
  internal slot ID like "default" instead of the operator's email.
  Both sections are now suppressed when an active-account signal is
  present, leaving a single source of truth for "what's active."
  Bootstrap state (no accounts yet) and older CLIs without
  `primaryForAgents` keep the legacy Slots layout for graceful
  degradation.

## v0.6.8 — 2026-05-05

### Added

- **Per-account quota utilization on `/auth` (#696)** — the Telegram
  auth dashboard now renders 5h + 7d quota under each account row
  alongside the existing per-slot probe (`5h: 47% · 7d: 12%`, or
  `exhausted · resets in Nh Mm`). Wired through a new
  `fetchAccountQuota(label)` helper that probes Anthropic's
  `anthropic-ratelimit-unified-*` headers using the account's stored
  access token, with a 30 s in-process cache and background prefetch.
  Cache is invalidated on `enable` / `disable` / `share` / `rm` so
  the dashboard stays consistent with the YAML cascade.

### Fixed

- **`auth enable <fallback>` no longer hot-swaps the active fanout
  (#697)** — adding an account as a fallback used to overwrite each
  agent's runtime credentials with the just-enabled label, silently
  flipping the primary. Now `enable` preserves the YAML-list primary
  on each agent (the first entry in `auth.accounts:`) and only fans
  out the just-enabled label when an agent has no prior accounts
  (fresh-fleet bootstrap). Console output distinguishes
  `fanned out (now active)` from `added as fallback (active stays X)`,
  and the restart hint is suppressed when no runtime change occurred.
  New helper `groupAgentsByPrimaryAccount` unit-tested across 7
  cases. Matters whenever an operator runs a multi-account fleet —
  the bug was invisible on a single-account install.

### Added

- **Webhook ingest hardening (#714)** — two defenses added to
  `src/web/webhook-handler.ts` before auto-dispatch ships:
  - **Dedup by `X-GitHub-Delivery`**: per-agent LRU (1000 entries, 24h
    retention) backed by `~/.switchroom/agents/<agent>/telegram/webhook-dedup.json`.
    Replay returns 200 `{ok:true,deduped:true}` and skips JSONL append.
    Generic source has no delivery header — dedup is skipped silently.
  - **Per-source token-bucket rate limit**: off by default; opt-in via
    `channels.telegram.webhook_rate_limit.rpm` in switchroom.yaml (set
    e.g. `rpm: 60` for one request/sec sustained, burst equal to rpm).
    When enabled, exceeding the limit returns 429 with `Retry-After`.
    First throttle event per `(agent, source)` per 60s window is written
    to `<agent>/telegram/issues.jsonl` for Telegram visibility.
  - `webhook_rate_limit` added to `TelegramChannelSchema` in
    `src/config/schema.ts`; cascades via the existing channels deep-merge.

## v0.6.7 — 2026-05-05

### Added

- **Account labels accept `@` and `+`** (#694) — operators can now
  label Anthropic accounts by the email they signed up with, e.g.
  `you@example.com`, `ken+work@example.com`. Regex expanded from
  `[A-Za-z0-9._-]+` to `[A-Za-z0-9._@+-]+` (max 64 chars) in all
  three places that must stay in sync — CLI canonical
  (`account-store.ts:LABEL_RE`), Telegram verb parser
  (`auth-slot-parser.ts:ACCOUNT_LABEL_RE`), and dashboard
  callback-data validator (`auth-dashboard.ts:isSafeAccountLabel`).
  - **Still rejected:** `:` (callback_data separator), `/` `\\`
    (path-traversal), whitespace, quotes, shell metas, non-ASCII.
  - Use `switchroom auth account rename <old> <new>` (PR #653) to
    relabel an existing account into the email-shape form.

## v0.6.6 — 2026-05-05

### Added

- **Two-zone status card v2 (#662, multi-PR rollup).** Reworked the
  pinned progress card into a clearer top-zone (`Main` agent state)
  and bottom-zone (sub-agents) layout. Includes background sub-agent
  persistence (closes #64), per-fleet-member stuck escalation, fleet
  state + watcher exposure, and the cutover off the legacy renderer
  (`TWO_ZONE_CARD=1` shipped to default-on). PRs: #663, #664, #665,
  #666, #670; design doc at `reference/status-card-design.md` (#661,
  #667).
- **`/auth` v3a — accounts-first dashboard layout (#669).** Telegram
  `/auth` now leads with the account inventory and drills into
  per-account detail on tap, replacing the slot-first nav.
- **`/auth` account rename (#653).** Telegram-native rotation of an
  account's display label without dropping/re-adding.
- **Verbose `tg-post` logging for outbound API calls (#659).**
  Operator-side debugging hook for the gateway's Telegram traffic.

### Fixed

- **Deterministic double-message fix via card takeover (#654/#655).**
  When a long turn (>60s) ended without `reply` / `stream_reply` and
  fell back to turn-flush, the user saw both the pinned progress card
  AND a fresh turn-flush bubble. New `progressDriver.takeOverCard`
  hook lets the gateway preempt the driver's "Done" edit and rewrite
  the pinned card with the answer text in place — single message in
  the chat, no race window. Regression test pins all three branches
  (card not yet posted / card posted / edit failure fallback).
- **`stream_reply` HTML parse failures now edit, not duplicate
  (#657/#685).** Stream-reply's HTML-parse error path was emitting a
  fresh `sendMessage` instead of editing the existing draft, doubling
  up answers when the parser tripped on bad markup.
- **Drop materialize on no-reply turn_end; turn-flush owns the emit
  (#656/#660).** Removed the legacy materialize-on-turn_end that was
  competing with the turn-flush safety net.
- **Boot-time orphan progress card reaper (#689/#692).** Pinned cards
  abandoned by a previous gateway crash get reaped at the next boot
  instead of lingering until the next turn on that chat.
- **Flush progress cards on SIGTERM (#689/#690).** Graceful shutdown
  now closes any in-flight cards so `systemctl --user restart` doesn't
  leave "Working…" pinned forever.
- **Unfreeze progress card timer + surface pin failures (#687).**
  Card heartbeat couldn't recover from a single transient API failure;
  now retries cleanly and surfaces persistent failures to the operator.
- **Emoji header counters + active-in-flight bullet (#684).**
  Status card header counters render correctly on Telegram clients
  that don't support combining-character sequences; in-flight tasks
  get an explicit bullet glyph.
- **Move TTL eviction off the heartbeat (#674).** Old chat states
  were piling up in driver memory because TTL eviction only ran when
  the heartbeat fired — heartbeat dies → memory leak.
- **`firePin` leak and `phaseFor` silent-end precedence (#673).**
  Two narrow correctness bugs in the pin lifecycle.
- **Export `SWITCHROOM_AGENT_NAME` in cron-N.sh template (#676).**
  Cron-spawned turns previously couldn't self-target via slash
  commands because the agent-name env var was missing from the
  scaffolded cron wrappers.

### Changed

- **Worker worktree isolation moved from global defaults to the `coding`
  profile (#682).** `examples/switchroom.yaml` previously shipped
  `defaults.subagents.worker.isolation: worktree`, which hard-failed
  every agent whose cwd was not a git repo (most switchroom agents,
  which run from `~/.switchroom/agents/<name>`). The default now lives
  in an inline `profiles.coding` block; agents pick it up via
  `extends: coding`. Sub-agent merge is now field-level on name
  conflict (a profile or agent overriding one field no longer drops the
  rest of the worker definition). Operators whose existing yaml still
  carries the old global default see a one-time NOTICE on the next
  config load — no auto-rewrite. Migration: add `extends: coding` to
  coding-shaped agents, or paste the two-line override directly under
  those agents.

### Engineering

- **Unified progress-card close path + convergence test (#677).**
  Refactored the four divergent close paths (turn_end, force-complete,
  zombie-close, abandon) into one helper, with a convergence test
  asserting they all reach the same final state.
- **Backfill 10 missing test cases for progress-card driver (#678,
  #681).** Closes coverage gaps in the driver's edge cases:
  cross-turn carry-over, orphan sub-agents, deferred completion
  races.
- **`beginTurnEnd` helper + native `console.warn` cleanup (#688).**
  Internal: extract the turn-end ceremony into a single helper.
- **Bridge-watchdog test isolation (#691/#693).** Watchdog tests
  now run with HOME isolated from real agent JSONLs so they can't
  read live state.

## v0.6.5 — 2026-05-04

### Added

- **Web dashboard trusts Tailscale peer source IPs (#651).** Requests
  whose source IP falls in `100.64.0.0/10` (IPv4 tailnet allocation)
  or `fd7a:115c:a1e0::/48` (IPv6 tailnet ULA) bypass the bearer-token
  gate. Tailscale's WireGuard layer already authenticates every peer
  against the tailnet, so a phone bookmarking
  `http://<host>.taildXXXX.ts.net:8080/` now works with zero token
  ceremony.
  - Bonus while in here: `?token=X` URL → httpOnly cookie redirect.
    Non-tailnet users can bookmark a one-time URL and never need the
    token in a URL afterwards.
  - **Operator override** — set `SWITCHROOM_WEB_REQUIRE_TOKEN=1` to
    disable the implicit-trust path. Use when sharing a tailnet with
    untrusted machines or running a multi-tenant tailnet ACL setup.

### Migration

```
bun add -g switchroom-ai@0.6.5     # or npm i -g
systemctl --user restart switchroom-web   # if running as a unit
```

The bearer-token, cookie, and `Tailscale-User-Login` paths are
unchanged — existing CLI / WebSocket / `tailscale serve` setups keep
working.

## v0.6.4 — 2026-05-03

### Fixed

- **Bundle UTF-8 mojibake (#643, follow-up to #642).** Bun's parser
  misreads raw UTF-8 source bytes as Latin-1 past ~172kB into a large
  bundle, expanding each multi-byte char into multiple JS code units.
  When re-emitted to stdout / `writeFileSync`, those code units get
  UTF-8 encoded a second time → classic double-UTF-8 mojibake. v0.6.3
  symptoms: boot cards rendered as `â AgentName back up Â· v0.6.3`,
  `switchroom agent list` "Uptime" column rendered as garbage, systemd
  unit em-dashes written as `c3 a2 c2 80 c2 94`. Fix: post-build pass
  (`scripts/escape-bundle-non-ascii.mjs`) that ASCII-escapes every
  code unit > 0x7F in built bundles to `\uHHHH` — same defence
  esbuild's `--charset=ascii` flag provides; bun build doesn't expose
  one. Wired into both bundle builders. Regression test asserts all 5
  built bundles contain zero bytes > 0x7F.

### Added

- **dm_only agent flag — suppress noisy boot probe for DM-only bots
  (#644).** Agents marked `dm_only: true` skip the forum-topic
  presence probe at boot, which was producing red boot cards on
  agents that legitimately have no group/topic to monitor. The
  scaffold-time default is `false` so existing behavior is preserved.

## v0.6.3 — 2026-05-03

### Fixed

- **Bundle no longer breaks under bun runtime (#640).** Released
  bundle was inlining `node-fetch@2` (grammy's HTTP dep) when built
  with `--target node`. Under bun runtime that inlined CJS
  node-fetch broke grammy's `getMe`/`sendMessage` calls with a
  generic `HttpError: Network request failed!` — the fleet was
  unresponsive on every restart (👀 reaction succeeded, no replies
  landed). Fix: `--external node-fetch` in the plugin bundle so
  the fetch impl is resolved at runtime (bun's native shim under
  bun, real node-fetch from node_modules under node).

### Added

- **Issue cards render remediation hints (#633).** When an issue's
  `--detail` field starts with `Fix:` or `→`, the pinned issue card
  surfaces it as a `→ <hint>` line under the summary. The cron
  prompt template (`src/agents/sub-agent-telegram-prompt.ts`) now
  teaches agents to record remediation alongside transient issues
  (e.g. `Fix: switchroom vault unlock` when the broker is locked).
  Multi-line stderr-tail details are excluded from the card to
  keep the layout tight; full detail still visible via `/issues`.
- **First-message-after-restart picks up reaction filter (#641,
  closes #613).** Gateway now warms `chatAvailableReactions` for
  every chat in `access.allowFrom` at boot so the very first turn
  in a restricted-reactions supergroup gets the proper filter
  instead of the lazy-on-first-message safety net (which couldn't
  help the first message itself).

### Engineering

- **Telegram-plugin source is now strict-tsc clean (#641, closes
  #623).** `npm run lint` previously filtered tsc output to four
  "dangerous-class" error codes because 52 pre-existing type-debt
  errors would have drowned the signal. All 52 are now fixed
  (possibly-undefined narrowing, discriminated-union narrowing,
  dead-code removal, boundary casts at grammy interfaces). The
  lint check now fails on any tsc error in plugin source — going
  forward, type bugs in `telegram-plugin/` are caught at lint time
  the same as `src/`.

## v0.6.2 — 2026-05-03

### Added

- **Account-level buttons on the `/auth` Telegram dashboard
  (#637).** The dashboard now renders one row per Anthropic account
  with a `✓` marker (enabled on this agent) or `○` marker (account
  exists, not enabled here). Tapping kicks off a two-stage confirm
  → `auth enable / disable <label> <agent>` → restart, mirroring
  the existing `rm`/`confirm-rm` pattern. Health-affix glyphs
  (`⌛` expired/no-refresh, `⚠️` quota-exhausted, `❌`
  missing-credentials) flag accounts that need attention without
  opening the CLI.
- **"🌐 Share to fleet" bootstrap button.** When zero accounts
  exist but this agent has slot credentials we can promote, the
  dashboard surfaces a one-tap `auth share default --from-agent
  <agent>` button. New users go from "fresh OAuth" to
  "shared-across-fleet" in one tap.
- **`switchroom auth account list --json`.** Sorted, deterministic
  account inventory (label, health, subscriptionType, expiresAt,
  quotaExhaustedUntil, email, agents) the gateway probes to
  populate the dashboard. Mirrors `auth refresh-accounts --json`'s
  emission style.

### Behaviour notes

- Dashboard degrades gracefully when the CLI is older than v0.6.x
  (no `--json` flag) — the accounts section just hides; per-slot
  buttons keep working.
- Render-time guard caps callback_data at Telegram's 64-byte limit:
  pathological agent + label lengths fall back to a `noop` button
  labelled `⚠ <label> (use CLI)` rather than overflowing.
- More than 5 accounts in the inventory truncates with a `…
  N more (use CLI)` row.

## v0.6.1 — 2026-05-03

### Fixed

- **Strategic packaging fix — telegram-plugin now ships as a
  self-contained bundle.** The `telegram-plugin/gateway/gateway.ts`
  (and server, bridge, foreman) entry points reach across into `src/`
  for auth, config, vault-broker, build-info — modules that the npm
  package's `files` array does not ship and that .gitignore excluded
  from `dist/`. Result: a fresh `bun add -g switchroom-ai@0.5.x`
  install crashloop'd at gateway boot with `Cannot find module
  '../../src/auth/accounts.js'`. Operators only stayed running by
  having a `bun link` overlay of the dev workspace shadowing the
  npm install.

  The fix bundles each plugin entry point with `bun build` (resolving
  all cross-imports inline) into `telegram-plugin/dist/`. The systemd
  gateway unit + foreman unit + .mcp.json server entry now prefer the
  bundled JS, falling back to the .ts source for dev workspaces that
  haven't built yet. The npm package ships `telegram-plugin/dist/` so
  fresh installs run without any source-tree dependency.

  Closes the same packaging class as v0.5.1's fix at the strategic
  level — instead of patching `files` to ship more `src/` (which
  spreads the cross-import surface further), the plugin becomes a true
  library with no upstream reach.

### Added

- **`bun run build` now builds telegram-plugin too.** Root
  `scripts/build.mjs` invokes `telegram-plugin/scripts/build.mjs`
  after the CLI bundle. Single command, both targets.
- **`telegram-plugin/start.js` shim.** MCP launchers `bun run start`
  through this — picks dist if present, falls back to .ts source.
  Preserves the legacy "edit + restart" dev loop while making the
  installed-package path the production default.
- **Foreman bundled.** `foreman/foreman.ts` now in the plugin build
  alongside server/gateway/bridge.

## v0.6.0 — 2026-05-03

### Added

- **`/auth share <label>` — one-shot account-add + fleet-wide enable
  (#634).** Collapses the two-step "register account, then enable on
  every agent" flow into a single command. CLI: `switchroom auth share
  <label> [--from-agent <name>]`; Telegram: `/auth share <label>
  [--from-agent <name>]`. Auto-defaults `--from-agent` when only one
  agent is configured (the fresh-install case). Auto-restarts every
  affected agent so claude picks up the freshly fanned-out
  credentials. Refuses with a hint when the account already exists
  (*"use 'switchroom auth enable <label> all' instead"*).

- **`all` keyword for `auth enable` / `auth disable` (#634).**
  Operators don't have to enumerate the fleet:
  - `switchroom auth enable <label> all` — wire the account to every
    claude-enabled agent in `switchroom.yaml`.
  - `switchroom auth disable <label> all` — unwire from every agent.
  - Telegram surfaces the same shape: `/auth enable <label> all`.

  Edge case: a literal agent named `all` in `switchroom.yaml` triggers
  a stderr warning and the keyword still wins; rename the agent to
  disambiguate.

### Why

Closes the ergonomic gap from `share-auth-across-the-fleet.md` JTBD.
PR #621 delivered the underlying account-as-unit capability, but the
common case ("one Pro subscription drives my whole fleet") still
required two commands plus N agent names. The new verbs make it one
command, mobile-native.

## v0.5.2 — 2026-05-03

### Fixed

- **Multiple status messages emitted during single turn (#626).** The
  progress-card emit lifecycle had a structural failure mode: when
  `stream_reply(done=true)` finalized the lane, it deleted
  `activeDraftStreams[sKey]` — and any subsequent emit on the same
  lane+turnKey created a fresh `sendMessage` instead of editing the
  pinned card. The 2026-04-23 sub-agent fix covered ONE path; the RCA
  on this issue identified 7 more (deferred completion, zombie close,
  forceDone, dedup-key mismatch, etc.). All collapse to the same
  symptom: the user sees multiple separate status messages where one
  anchor message edited in place was expected.

  Root-cause-shaped fix: a new `lookupExistingMessageId` hook in
  `stream-reply-handler.ts` lets the gateway feed back the anchor
  message id from the pin manager. When the handler is about to create
  a fresh stream because `activeDraftStreams[sKey]` was deleted, it
  consults the hook; if the pin manager already knows the id for this
  turnKey, the new stream initializes with that id so the very next
  update fires `editMessageText` instead of `sendMessage`. Stale ids
  fall back gracefully via the existing not-found path.

  Closes the bug class structurally — every previously-known path now
  collapses to "edit the existing anchor."

### Added

- **`anchorMessageCount(chatId, threadId?)`** harness invariant in
  `real-gateway-harness.ts` — returns the count of fresh `sendMessage`
  calls (NOT edits) for a chat. Anything > 1 across a single logical
  turn IS the duplicate-status-message bug class. New I7 describe
  block in `real-gateway-i6-...` pins the invariant. Catches ANY
  future regression in any of the 8 RCA paths the moment a second
  anchor lands — verified to flag 5/6 historical dup-message bugs
  (#546, #251, #549, #371, #489) and all 8 paths.

- **`initialMessageId`** optional config on `createDraftStream` and
  `createStreamController`. Plumbing for the lookup hook above.
  Purely additive — back-compat verified.
## v0.5.1 — 2026-05-03

### Fixed

- **v0.5.0 release packaging — gateway service unit pointed at
  unshipped paths.** v0.5.0 introduced a split `claude` + `gateway`
  systemd-unit architecture whose `ExecStart` references
  `~/.bun/install/global/node_modules/switchroom-ai/telegram-plugin/gateway/gateway.ts`
  and `~/.bun/install/global/node_modules/switchroom-ai/bin/autoaccept.exp`,
  but the `package.json` `files` array only included `dist`,
  `profiles`, `skills`, `README.md`, `LICENSE`. Result: every
  agent's gateway service failed at boot with
  `Module not found "...telegram-plugin/gateway/gateway.ts"` until
  systemd hit the start-limit. Agents went silent on Telegram.
- **Telegram-plugin runtime deps not in root `dependencies`.**
  `@grammyjs/runner`, `@modelcontextprotocol/sdk`, `@secretlint/*`,
  `@xterm/headless`, `grammy` were declared on the workspace
  package only — not on `switchroom-ai`. Fresh consumer installs
  couldn't resolve these imports from the gateway. Promoted them to
  root `dependencies` so `npm i -g switchroom-ai` pulls them.

### Migration

`bun add -g switchroom-ai@0.5.1` (or `npm i -g switchroom-ai@0.5.1`)
then `switchroom agent restart all` — units pick up the now-shipped
source. v0.5.0 outboundDedup hotfix (#625) and per-agent card
foundations (#624, #627) are inherited from v0.5.0 unchanged.

## v0.5.0 — 2026-05-03

### Added

- **Per-agent pinned status cards (foundations + integration).** Each
  active sub-agent now optionally gets its own pinned Telegram card
  driven by a CLI-style status row (`{glyph} {verb} · {elapsed} ·
  ↓{tokens} · thought {thinking}`) and a ◼/◻/✔ TodoWrite-driven task
  block. Off by default — opt in with
  `PROGRESS_CARD_PER_AGENT_PINS=1`. Pin manager keys on `(turnKey,
  agentId)` composite; new `subagent-card.ts` registry handles
  per-card lifecycle (lazy spawn on first content event, two-pass
  k-of-n labeling, multi-card coalesce, finalize on
  `sub_agent_turn_end`). When the flag is on the parent card's
  `<blockquote expandable>` sub-agent block is suppressed (#624,
  #627).
- **One OAuth per Anthropic account** (#621) — accounts are now
  first-class: a single `claude setup-token` per account covers every
  agent, sub-agent, hook, summarizer, and cron. New
  `src/auth/account-store.ts` + `src/auth/account-refresh.ts` own
  storage, refresh, and quota state at the account level. New
  `auth-accounts` CLI verbs: add, list, label, route. Telegram
  `/auth` router updated to surface accounts.
- **Switchroom-managed token refresh loop** (#612, #429) — switchroom
  now refreshes OAuth tokens on a daemon timer instead of relying on
  Claude Code's per-process refresh. Quota state, refresh failure,
  and account drift are observable from the gateway.
- **Telegram voice-in + webhook verbs** (#619, #587, #586, #578,
  #577) — `switchroom telegram voice-in` enables Whisper
  transcription on inbound voice messages. `switchroom telegram
  webhook` adds HMAC + Bearer-authenticated webhook ingest for
  external systems.
- **Inline keyboard buttons on `reply` / `stream_reply`** (#616,
  #271) — agents can attach inline buttons to outbound messages;
  callbacks route as ordinary inbound steers.
- **Granular `send_typing` chat actions** (#617, #273) — replaces the
  single typing indicator with per-action `record_voice`,
  `upload_photo`, `find_location`, etc.
- **`ask_user` MCP tool with inline-keyboard answers** (#581, #574) —
  agents can prompt the user inline; reply lands as steer.
- **`!`-prefix interrupt marker** (#583, #575) — messages starting
  with `!` are recognised as interrupts even mid-turn.
- **Telegraph Instant View for long replies** (#588, #579) — replies
  over Telegram's 4096-char limit auto-publish to Telegraph and link
  back from the chat.
- **`send_sticker` / `send_gif` MCP tools + animation inbound**
  (#584, #576).
- **Forum topology support** (#606, epic #543) — `agent add` now
  understands forum topics; per-topic routing and pin scoping land
  cleanly.
- **Cascade-aware Telegram features** (#604, #596) — Telegram
  feature config now flows through the standard
  defaults→profile→agent cascade.
- **`switchroom telegram` CLI verb** (#605, #597 phase 1) — single
  entry point for telegram subcommands; replaces fragmented prior
  surface.
- **Opt-in `sendMessageDraft` transport for the pinned card** (#618,
  #354) — `PROGRESS_CARD_DRAFT_TRANSPORT=1` enables continuous
  bouncing-dots animation between explicit tool_use events. Spike
  pending operator validation.
- **Idle/active topic footer**, **interrupted-turn resume protocol**,
  **incremental answer streaming** — see v0.4.0 entries (no
  regressions in this release).
- **TodoWrite reducer + render template foundations** (#624) —
  parent and per-sub-agent task slices on `ProgressCardState`;
  `renderAgentCard`, `projectAgentSlice`, `glyphForTick` exposed as
  pure functions ready for the per-agent card path and reusable for
  future render surfaces.
- **Stateful test harness upgrades** (#607) — catches reaction /
  dedup / lifecycle bug classes that the prior unit tests missed.
- **IPC + bridge lifecycle coverage** (#603) — new tests reproduce
  Bug A/B/C/D regression class.
- **Real-gateway harness scaffolding** (#567, #553 Phase 3) +
  **waiting-UX v2 spec** (#582, #553 PR 1).

### Changed

- **Card gate** (#590, #553 PR 4) — progress card now appears at
  `(elapsed >= 60s) OR (any sub-agent appeared)` rather than after
  N parent tool calls. Tools alone never trigger the card.
- **Faster real-text path** (#585, #553 PR 3) — replies reach the
  user with less coalescing latency.
- **Eliminated fake placeholder text** (#553 PR 5) — the gateway no
  longer inserts synthetic "loading…" strings; placeholders are
  message-level.
- **Stable sub-agent identity** (#615, #378) — sub-agent display
  description now uses a stable fallback chain
  (description → subagentType → first prompt → 'sub-agent') rather
  than letting first emitted text flip the title mid-turn.
- **Sub-agent count must equal rendered row count** (#580) —
  expandable rows and the count badge can no longer drift.
- **Skill descriptions consolidated** — stale cross-references and
  loose descriptions cleaned up across all bundled skills (#593,
  #598).

### Fixed

- **`outboundDedup` ReferenceError class** (#625, #599, #546) —
  every outbound reply was hitting `ReferenceError` on the dedup
  check; declared the variable + added a lint guard for the bug
  class.
- **Restart-storm windows** (#608) — closes four paths where the
  watchdog could waste Claude quota by restarting an agent that was
  already running fine.
- **Watchdog: foreground sub-agent activity refreshes parent
  turn-active marker** (#610, #501) — long-running foreground
  sub-agent calls no longer trip the parent watchdog.
- **👍 reaction fires on real delivery, not turn_end** (#602, Bug
  D + Z) — the thumbs-up that signals "your message landed" now
  reflects actual delivery instead of just the turn boundary.
- **Time-based first-emit promotion** (#570, #553 F3) — single- or
  two-tool turns that take 5–30s now cross the promotion threshold
  and surface a card.
- **Reaction flush before terminal emoji** (#569, #553 F1) and
  **`👀` on raw arrival** (#568, #553 F2).
- **Preamble dedup + chat-allowed-reactions filter** (#609, #549,
  #542).
- **Premature `👍` from disconnect flush** (#600, #553 hotfix).
- **Wake-audit conversation-aware dedup** (#601, #553 follow-up).
- **`chat not found` 400s now log-only, not shutdown** (#564) — a
  single deleted chat can no longer take down the gateway.
- **Auth code redaction failure logging** (#561, #562) — auth
  redaction now reports on its own failures.
- **Graceful model-down UX** (#611, #394) — when the model
  endpoint is down, the gateway suggests `/authfallback` / `/auth`
  / `/usage` rather than a bare error.
- **Progress-card row cleanup** (#615, #378) — redundant rows
  removed; identity stabilized.

### Removed

- **`switchroom-mcp/` management server (#235).** The 4 tools it
  exposed (`switchroom_memory_search`, `switchroom_memory_stats`,
  `workspace_memory_search`, `workspace_memory_get`) had zero
  production callers — every active code path used Hindsight's MCP
  (`mcp__hindsight__*`) directly, plus Claude Code's built-in
  `Read` / `Grep` for workspace files. The server was spawning a
  child process per agent at boot for no observable benefit. New
  agents no longer get the entry; reconcile actively retracts it
  from existing agents' `settings.json` and strips
  `mcp__switchroom__*` from `permissions.allow`. **Migration:** run
  `switchroom agent reconcile <name>` for each existing agent (or
  just restart — Claude Code tolerates a missing MCP server with a
  silent log line).
- **Dead `preAllocatedDraftId` parameter** (#595) — leftover from
  an abandoned approach in #553; no callers.

### Operator notes

- **Soft rollout flags introduced this release** (all default off):
  - `PROGRESS_CARD_PER_AGENT_PINS=1` — per-agent pinned cards
    (this release).
  - `PROGRESS_CARD_DRAFT_TRANSPORT=1` — bouncing-dots draft
    transport for the pinned card (#354 spike).
  - `PROGRESS_CARD_MULTI_AGENT=0` — explicitly disable the
    multi-agent expandable section in the parent card. Default
    behaviour is to auto-activate when sub-agents are present.
- **Migration on update:** existing agents continue to work
  unchanged. To pick up the auth refactor (#621), run
  `switchroom auth accounts add <label>` once per Anthropic
  account, then `switchroom agent reconcile <name>` per agent.

## v0.4.0 — 2026-04-29

### Added
- **Sub-agent registry infrastructure** — SQLite-backed `subagents` and
  `turns` tables track every active sub-agent with liveness updates,
  tool-hook population, and a turns writer wired to gateway enqueue and
  completion. Exposes `/api/agents/:name/{turns,subagents}` REST routes
  (#333, #332, #325, #340, #342, #347).
- **Idle/active topic footer** — pure renderer computes and posts a live
  footer line on every topic reflecting idle vs. active state; wired into
  the gateway render path (#332, #338, #343).
- **Interrupted-turn resume protocol** — gateway stamps turn start/end on
  every path including kill/SIGTERM; scaffold surfaces `SWITCHROOM_PENDING_TURN`
  env-var to the agent on cold start so it can acknowledge the gap; agent
  CLAUDE.md documents the full resume flow (stages 3a–3c, 4, 5; #329–#331,
  #336, #337).
- **Incremental answer streaming** — agent replies stream token-by-token to
  Telegram via `sendMessageDraft` before the turn ends; answer-stream preview
  is retracted when the reply path wins (#195, #201, #261).
- **Vault broker** — full daemon with Unix socket, `SO_PEERCRED` + cgroup
  ACL, append-only audit log, auto-unlock via `LoadCredentialEncrypted` on
  boot, `secrets[]` schedule field, namespaced key names, and Telegram
  `/vault` subcommands (unlock/lock/status/grants list+revoke with inline
  buttons). Cgroup ACL hardened against spoofing under user delegation
  (#112, #113, #117, #153, #154, #158, #206, #207, #209, #213, #221,
  #224–#228, #241–#245).
- **Inline status-accent headers** — `reply` and `stream_reply` accept an
  `accent` parameter that prepends a `🔵 In progress…` / `✅ Done` /
  `⚠️ Issue` status line above the message body (#328).
- **Boot card overhaul** — posts on every gateway start with restart reason,
  live-watches agent service status after boot, and drops the static session
  greeting in favour of a quiet settle-gated probe sequence (#93, #95, #150,
  #178, #208, #210, #279).
- **Humanizer and calibrate skills** bundled as defaults so every agent can
  run `/humanizer` and `/humanizer-calibrate` without extra setup (#292).
- **Switchroom-worktree** MCP + CLI for parallel sub-agent code isolation;
  worktree primitives (schema, modules, env injection) wired in (#74, #75,
  #274).
- **Browser automation by default** — every agent gets Microsoft's official
  `@playwright/mcp` (pinned to `0.0.71`, snapshot mode) wired in via
  `npx -y @playwright/mcp` so `browser_navigate`, `browser_snapshot`,
  `browser_click`, `browser_type`, etc. work out of the box without a
  local Playwright install. Opt out per-agent or globally with
  `mcp_servers: { playwright: false }` (#358).
- Web dashboard `--bind` flag for LAN/Tailscale access; trust
  `Tailscale-User-Login` header for loopback requests.
- `switchroom agent rename` command for slug renames (#168).
- Native Telegram checklist messages (`send_checklist` / `update_checklist`);
  inline keyboard URL buttons on `reply`/`stream_reply`; `protect_content`
  and `quote_text` params; inbound message reaction forwarding (#272, #271,
  #273, #297, #301, #302).
- Hindsight recall now injects active directives as a separate top-of-prompt
  block (#115).
- `/foreman setup` wizard for onboarding new agents (#175).
- Cache-hit telemetry and hook content-dedupe (Phase 1 of perf work) (#110).

### Changed
- **Sub-agent Telegram visibility removed** — sub-agent identity stripped
  from prompt and tool denylist so the parent agent's Telegram session stays
  clean (#256, #260).
- Session greeting dropped; boot card now serves as the sole session-start
  signal (#150).
- `switchroom update` gains `--force` flag; CLI collapsed to
  `update`/`restart`/`version` surface with foreman and Telegram menu aligned
  (#63, #65, #67, #68, #317).
- `🔥` reaction dropped from active-work states; reactions are now
  `👀 → 🤔 → 👍` (#320, #323).
- Agent service units declare `MemoryMax=2G` / `MemoryHigh=1536M` to cap
  unbounded growth; `Restart=on-failure` recovers after OOM kill (#116).
- Progress card native HTML formatting overhaul; deterministic markdown-table
  rendering; `_..._` italic conversion fixed (#265, #275, #277, #284, #287).
- Vault broker ACL replaced with cgroup-based identity; peercred
  `ss`-lookup two-step fixed; spoofing hardened against user-delegation
  cgroup writes (#117).
- `switchroom update` reliability: bun shebang fix, rolling restart with
  settle gate, 4 further defects patched (#249, #291).

### Fixed
- Gateway boot-card crash loop broken: discriminate `unhandledRejection`,
  dedupe boot card, cache quota probe (#99, #102).
- Watchdog: bridge liveness file eliminates false-positive restarts;
  `DISCONNECT_GRACE_SECS` bumped 120 → 600s; journal-silence hang detection
  added (#97, #96, #116).
- Sub-agent watcher: skip pre-existing JSONL files at startup; exclude
  historical entries from active card; escape HTML in last-activity age
  (#83, #89, #90, #91).
- Progress card: elapsed counter stays live during sub-agent silence; cross-turn
  sub-agent visibility restored; deduplicated row rendering; reducer correctness
  (toolCount, lastCompletedTool, preamble); visibility leaks closed; sub-agent
  format redesigned (#313–#316, #318–#319, #321, #326, #334, #350, #352, #356).
- Stream-reply: record delivery before `forceCompleteTurn` (#310, #311).
- Secret-detect: one-tap unlock + auto-write for deferred secrets (#44, #143).
- Boot probe: transient carve-outs, 429 doc, `rateLimited` field; agent slug
  used for systemd probes (#208–#211, #309, #312).
- Answer-stream: honour `NO_REPLY`/`HEARTBEAT_OK` in materialisation path;
  retract preview when reply path wins (#299, #300).
- Vault broker: hard-fail when `BrokerTestOpts` set outside `NODE_ENV=test`;
  `SO_PEERCRED` via `bun:ffi` simplified and hardened (#129, #135).
- Scaffold: validate bot token via `getMe` at init; pre-approve
  `delete_message` and `get_recent_messages` tools (#121, #167, #182).
- Auth-status: lazy sync + restart settle for meta race (#171, #176, #193).
- CI: bktec brace-alternation, parallelism, and golden-test sharding fixes
  (#111, #120, #128).

## v0.3.0 — 2026-04-25

### Added
- `src/agents/create-orchestrator.ts` — new module with `createAgent()` and
  `completeCreation()` that sequences scaffold → systemd install → OAuth start
  → agent start in a single coherent flow. Used by the new `bootstrap` command
  and ready for the Phase 3 foreman bot.
- `switchroom agent bootstrap <name> --profile <p> --bot-token <t>` — one-shot
  CLI verb: scaffolds the agent, validates the BotFather token, starts an OAuth
  session, prints the URL to stdout, reads the code from stdin, and starts the
  agent. Passes `--rollback-on-fail` to remove the scaffold dir on auth failure
  (default: keep artefacts for retry).
- Phase 3a foreman bot skeleton with read-only fleet commands (status, list,
  logs) accessible over Telegram (#22).
- Phase 3b `/create-agent` multi-turn flow and destructive fleet commands
  (restart, stop, delete) with confirmation prompts (#27).
- Phase 4b operator-events: callback handler, IPC server/client, and history
  store for durable event tracking (#29).
- Telegram admin commands in gateway phase 1 — privileged bot commands routed
  directly through the gateway IPC (#33).

### Changed
- **BREAKING (upgrade note):** `scaffoldAgent()` no longer copies
  `~/.claude-home/.credentials.json` (or `~/.claude/.credentials.json`) into
  a new agent's `.claude/` directory. Each agent now gets its own fresh OAuth
  via `switchroom auth login <agent>` or `switchroom agent bootstrap <agent>`.
  Existing agents with their own `.oauth-token` or `.credentials.json` are
  unaffected — only the copy-on-scaffold step is removed.
- Scaffold and fixtures no longer embed personal implementation details;
  import overlay added for cleaner separation (#55, closes #48).
- Architecture doc added and README updated with compliance callout (#42).
- README hero image refreshed with Telegram highlight; compliance attestation
  updated for 2026-04-25 (#39).

### Fixed
- Progress-card orphan-defer race, label noise, and ghost replies resolved;
  multi-sub-agent invariant locked with regression tests (#49, closes #31 #41
  #43 #45).
- Progress-card retries bounded on Telegram 4xx errors (#10).
- Progress-card tool-name prefix stripped for human-authored labels (#9).
- Progress-card multi-sub-agent invariant test added (#12).
- CI unblocked: bktec brace-expansion + `advanceTimersByTimeAsync` polyfill
  (#54).
- CI unblocked: bktec parallelism fix + `TELEGRAM_BOT_TOKEN` stub (#38).
- Secret-detect: Anthropic OAuth browser code redaction added (#46).
- Auth: stale-token capture and `credentials.json` shadowing fixed (#40).
- Bootstrap: rollback scope widened, env-var token supported, missing outcome
  tests added (#20).
- Hardening: slug validation tightened, foreman state guards added,
  `callback_data` safety enforced (#25).
- Auth Phase 1: pane-ready probe, structured outcomes, and boot-sweep filter
  (#17).

## v0.2.5 — 2026-04-24

### Fixed
- Progress card no longer closes prematurely while background sub-agents are still running; deferred-completion visibility now waits for all active sub-agents before dismissing (#4).

### Changed
- MCP tool labels polished in the progress card for cleaner display.
- Preamble nudge added to scaffold to guide agent context on startup.

## v0.2.4 — 2026-04-24

### Fixed
- gateway IPC socket cleanup race on `systemctl restart`: old gateway's delayed `unlinkSync` could arrive after the new gateway had already bound, deleting the new socket's filesystem entry and leaving an orphaned listener. Cleanup now renames the live socket to a `.bak` sidecar at both startup and shutdown so a late old-gateway cleanup cannot destroy the current generation's file; stale `.bak` is unlinked on the next startup when no one is using it.
- session-greeting hook no longer re-fires on every SessionStart when the gateway's socket path is unlinked (orphaned socket); idempotency guard now uses `ss` directly rather than a filesystem-existence check. Added structured logging to `session-greeting.log` for future diagnosability.

## v0.2.3 — 2026-04-24

### Fixed
- gateway SIGTERM handler was clobbering stamped restart reasons, so greetings showed "clean shutdown" with no "why". Handler now preserves fresh reasons from any initiator and falls back to "systemctl: external restart" otherwise.

## v0.2.2 — 2026-04-24

### Fixed
- Removed absolute source paths baked into bundled output (build hygiene). The bundler was inlining `__filename` as a developer-machine absolute path inside `dist/cli/switchroom.js`. Switched `src/memory/scaffold-integration.ts` to `import.meta.dirname` so the resolved `switchroom-mcp/server.ts` anchor is computed at runtime from the bundle's own location. No published behaviour change, no new code paths.

## v0.2.1 — 2026-04-24

### Added
- Secret-detection pipeline: per-turn scanning of tool-use content with staging, rewrite, and audit log, plus PreToolUse and Stop hook scaffolding and a gateway-side intercept so leaked credentials are caught before they leave the agent (#47, #48, #49, #51, #54).
- `switchroom vault sweep` — retroactive scrubber that walks existing transcripts and vault-isches already-stored secrets in place (#50).
- Restart-reason surfaced in the session-greeting card so each agent's greeting tells you *why* the last restart happened (planned, crash, OOM, manual, etc.) (#58).

### Changed
- Telegram gateway hardening: startup mutex prevents duplicate bridges racing on launch, a 35s SIGTERM drain lets in-flight turns finish cleanly, and state transitions are now logged for post-mortems (#52, #53).
- CI pipeline: cache-aware `bun install` and serialized eval steps cut wall time and remove flakes from parallel runs (#57).
- Gateway wiring: pid-file, session-marker, and typing-wrap are now threaded through the gateway consistently (#45).

### Fixed
- "Recovered from unexpected restart" banner no longer fires on planned shutdowns — the 30s clean-shutdown marker preserve window aligns with the 60s banner-suppression window so orderly restarts stay quiet (#55).
- Regenerated `bun.lock` to match `package.json`, unbreaking Buildkite (#56).

## v0.2.0 — 2026-04-23

Bumps the package to v0.2.0 and threads build provenance through to the greeting card so users can see which release each agent is running and how stale it is.
