# Probe: dynamic bank IDs — openclaw's mechanism, and whether multi-agent repos should adopt them

Status: REPORT-ONLY probe, 2026-08-16. No edits to reference/rfcs/design-v2.md, the ledger, or
existing probes. Sources are deployed artefacts per the ledger convention: the
**published npm package** `@vectorize-io/hindsight-openclaw@0.10.0` (fetched via
`npm pack` this probe — this IS openclaw's shipped artefact, so the
vendored-tree trap does not apply to it), the official docs page (fetched
2026-08-16, content sha256 `aa70cac8…70b0de`), the Hermes tree at the design's
pin `460d345` (raw.githubusercontent at that SHA), this repo's shipped shim at
HEAD, and the running engine at `127.0.0.1:18888` (read-only GETs only — see
§F2 for the one thing deliberately left unverified because verifying it is a
write).

Question (verbatim): *How does openclaw use dynamic bank IDs, and should we
adopt them — specifically for repos that multiple agents work on?*

**Answer in one line: openclaw's dynamic banks are an identity-ISOLATION
mechanism (finer-grained bank-per-context), not a sharing mechanism; they add
nothing for a multi-agent repo, and §10's shared single-writer repo bank +
our already-deployed `additional_banks` fan-out remain the right composition.
No revision to P5 or §10; one wording sharpening to W-2.**

---

## F1 — openclaw's actual mechanism, from published source

Mechanism, verified in the shipped bundle (`package/dist/index.js`, 0.10.0):

- **Derivation is per-message-context, not per-session.** Every memory event
  resolves its bank at use time: `const bankId = usesStaticBank(config) ?
  getStaticBankId(config) : deriveBankId(ctx, config)` (`dist/index.js:334`),
  where `ctx` is the current message's session/identity context. Identity is
  cached (`resolveAndCacheIdentity`, used at `:960-968`), but the bank is
  re-derived on each retain/recall — a gateway serving many
  channels/users writes to many banks concurrently within one process.
- **The key is a template over identity fields.** `deriveBankId()`
  (`dist/index.js:903-938`) joins the configured `dynamicBankGranularity`
  fields — valid set `agent`, `channel`, `user`, `provider` — with `::`, URL-
  encoding each segment, optional `bankIdPrefix` prepended. Default
  granularity is `["agent","channel","user"]`
  (`DEFAULT_DYNAMIC_BANK_GRANULARITY`, `:345-346`; docs concur). Fallbacks are
  `"default"`, `"unknown"`, `"anonymous"` per field (`:928-936`).
- **Dynamic is the DEFAULT** (`dynamicBankId` default `true` — docs page and
  `dist/index.js:1278`: `dynamicBankId: config.dynamicBankId !== false`).
  Static mode (`dynamicBankId: false`) uses `bankId` if set, else the constant
  `DEFAULT_BANK_NAME = "openclaw"` (`:344`, `:358-369`).
- **Purpose, in the docs' own words:** "each unique combination gets its own
  **isolated** memory store" (docs page, Bank Segmentation section). Loosening
  granularity (e.g. `["provider","user"]`) *widens the isolation unit* — "the
  same user shares memories across all channels within a provider" — it never
  makes two distinct agents/users share by design.
- **Knowledge tools follow the same path and fail closed on weak identity:**
  `resolveBankIdForKnowledgeTools()` (`dist/index.js:955-997`) refuses to run
  the `agent_knowledge_*` tools when user-scoped banking can't resolve a
  stable sender ("Knowledge tools use the same per-user memory bank as
  auto-recall/retain", `:975-996`) — i.e. even openclaw treats "which bank"
  as infrastructure-resolved identity, never a model-suppliable argument.
  There is no `bank_id` parameter on any of its agent-facing tools.
- **Known failure mode acknowledged in their own source:** a granularity typo
  "silently produce[s] 'unknown' segments" (runtime warn, `:915-921`), and a
  missing `senderId` yields an `anonymous` segment (`:925-927`). Dynamic
  derivation buys flexibility at the cost of silent misroute-to-a-new-bank
  failure modes — the docs even ship a hint string for the surprise
  ("If unexpected, set dynamicBankGranularity to … or use static banking",
  `:729`).

## F2 — what happens on a bank that doesn't exist yet

- The plugin never checks existence. First use per gateway process optionally
  stamps configured bank defaults via `ensureBankDefaultsApplied()`
  (`dist/index.js:118-131`), which calls `applyConfiguredBankDefaults` →
  `createBank` — documented as an **upsert** ("createBank upserts each mission
  column … unset fields are left untouched", comment at `:106-110`). Docs:
  options are "stamped onto each bank **on first use**, before its first
  retain or recall"; "Each bank is configured at most once per gateway
  process."
- So under openclaw, banks are **lazily auto-created by writing to them** —
  there is no operator gate on bank creation at all. Combined with F1's
  fallback segments, a misconfiguration mints new empty banks silently.
- **Not established on OUR engine:** whether a `recall` POST against a
  nonexistent bank creates the bank row on the deployed image. Verifying that
  is itself a write, so this probe did not run it (rules: read-only). What was
  verified read-only: `GET /v1/default/banks/<nonexistent>` is 405 (no
  per-bank GET route) and the fleet bank list contains no probe artefacts
  (live curl, 2026-08-16: 15 banks — 11 agent banks + `ken-profile`,
  `lisa-profile`, `test-harness`, `switchroom-dev`).

## F3 — openclaw's multi-writer story: there isn't one

- Each derived bank is written by exactly one conversational context
  (agent+channel+user tuple) within one gateway process. The docs pitch
  external-API mode for "Shared memory across multiple OpenClaw instances" and
  "Team environments where agents share knowledge" (docs page, External API
  section), but the plugin carries **zero concurrent-writer machinery**: no
  writer-identity plumbed into adjudication, no contradiction handling — the
  only provenance is document-level metadata on retain (`agent_id`,
  `sender_id`, `session_key`, `channel_id` in `buildRetainRequest`,
  `dist/index.js:2263-2276`), which is retrieval metadata, not an input to the
  engine's consolidation adjudication. Nothing here touches, let alone fixes,
  E-38's engine-side finding (no contradiction detector, writer identity
  stripped, silent arbitrary resolution). openclaw doesn't solve concurrent
  writers; it **avoids** them by making banks smaller.

## F4 — Hermes contrast, at pin 460d345

- **Static by default, dynamic opt-in, resolved once at init.** Default
  `bank_id: "hermes"` (`plugins/memory/hindsight/__init__.py:447`, `:1073`,
  `config_schema.py:55-59`). Optional `bank_id_template` with placeholders
  `{profile} {workspace} {platform} {user} {session}`
  (`__init__.py:692-724`, advertised at `:1179-1180`), resolved in provider
  initialization (`:1650-1660`) — i.e. **per provider instance / session**,
  not per message like openclaw. Segments are sanitized and empty placeholders
  collapse (`:670-689`).
- **Same purpose: isolation.** README, line 63: "`hermes-{profile}` **isolates
  memory per active Hermes profile**."
- So across the three integrations the pattern is settled and directional:
  **bank resolution is configurable everywhere, dynamic-by-default only in
  openclaw** (the multi-channel/multi-user gateway, where identity partitions
  are plentiful), static-single-bank in Hermes and in our shim. In all three,
  one bank ↔ one writing identity; dynamic granularity only changes how fine
  that identity is cut. openclaw is the outlier in *default*, not in *model* —
  consistent with P-13/E-65 (vendor coding-agents package: resolution
  configurable) and with P5's E-49/E-50 grounding (vendor deployment model is
  bank-per-identity).

## F5 — our shim: what's actually pinned, and what dynamic/multi-bank reach would take

Current state (`src/cli/hindsight-mcp-shim.ts` at HEAD):

- **Backend engine tools already accept `bank_id` pass-through.** The
  fallback manifest lists `bank_id` among optional props on `recall`,
  `reflect`, `retain`, `get_mental_model`, etc. (`FALLBACK_TOOL_TABLE`,
  `hindsight-mcp-shim.ts:191-222`). Cross-bank *recall* reach is deployed
  fact, not future work (E-75; and the additional-banks path in F6). Dynamic
  reach for the recall family requires **zero shim changes**.
- **The pin binds only the five SYNTHESIZED tools**: `deactivate_directive`,
  `reactivate_directive`, and the three GET-only page reads. Their schemas
  deliberately omit `bank_id` ("NOTE the deliberate absence of a `bank_id`
  property. The bank is pinned from `HINDSIGHT_BANK_ID`; a caller cannot name
  one" — `:259-262`), `bankId` enters only via constructor options
  (`ShimOptions.bankId` `:920`, threaded to DirectiveAdmin/KnowledgeAdmin at
  `:1352`/`:1368`, sourced from env at `:1686`), and `synthesizedCall()`
  hard-rejects an unknown `bank_id` argument with the message §10.2 quotes
  (`:1396-1404`).
- **What the refusal protects — read before relaxing it.** Three documented
  intents, none of which is "security":
  1. **Anti-silent-drop:** "Silently ignoring `bank_id` would leave a caller
     believing it had targeted another bank when it had in fact edited its
     own" (`:1379-1384`). The refusal is the loud alternative to a lie.
  2. **Provenance/usability boundary, explicitly NOT a security one:**
     `src/memory/hindsight-directive-admin.ts:21-34` — a tool call physically
     cannot address a peer's bank, but the engine is open REST and "a
     prompt-injected agent can still curl any bank directly, bypassing this
     module entirely." Relaxing the pin therefore weakens no security
     property that exists; what it would weaken is the *provenance* property
     that every directive mutation and page read attributable to an agent's
     tool surface targeted that agent's own bank.
  3. **The retirement seam:** `withSynthesizedTools()` drops any same-named
     backend tool so behaviour "never silently widens to accept a `bank_id`"
     if a future engine image registers real tools (`:461-467`), with the
     fixture test as tripwire.
- **What multi-bank page reads therefore need** — exactly W-2's shape, with
  one sharpening: the constructor grows an operator-granted set
  (`HINDSIGHT_KNOWLEDGE_EXTRA_BANKS`-shape env, rendered per agent at apply),
  and the three page tools (only — directive verbs stay pinned) accept an
  optional bank selector **validated against that set**, rejecting anything
  else with the existing loud message. That preserves all three protections:
  no silent drop (unlisted bank → loud reject), grants stay operator config
  rather than caller authority (the caller merely *selects among* grants —
  necessary once an agent is granted two repo banks, which W-2's current
  "config, not a tool argument" wording doesn't quite accommodate), and the
  directive-write provenance boundary is untouched. What must NOT be built:
  openclaw-style *derived* bank IDs (template over runtime context) — F1/F2
  show the failure modes (silent misroute, ungated lazy creation), and our
  fleet's agent→bank mapping is small, static, operator-owned config where a
  template saves nothing.

## F6 — the deployed `additional_banks` fan-out, verified

- Config: `memory.recall.additional_banks` plus `knows:` (user →
  `profile_bank`, else raw bank name) union into per-agent additional banks
  (`src/config/users.ts:66-73`); scaffold stamps them into the agent's
  settings.json as `recallAdditionalBanks` (`src/agents/scaffold.ts:4042-4051`
  — "recall these extra banks on every turn, merged into the agent's own bank
  results… 8s timeout… non-fatal on failure", per-speaker-memory-routing RFC
  ship-B).
- Live: `ken-profile` and `lisa-profile` exist on the engine (bank list curl,
  2026-08-16). This is exactly topology (c): per-identity banks, single
  writing pipeline each, explicit operator-configured read fan-out — and it
  already works, so extending an agent's `additional_banks` with a repo bank
  makes repo *facts* land in auto-recall with zero new code.

---

## Recommendation — decision rule, not a blanket answer

**Do not adopt dynamic bank IDs.** Per repo-shaped need:

| Need | Topology | Why |
|---|---|---|
| Durable repo knowledge (architecture, conventions, decisions) read by several agents | **(b) §10 as designed**: one shared repo bank, pages + facts, single-writer ingestion pipeline | Identity-free document-shaped knowledge (§10.1); E-38 never arises because concurrency is excluded by construction, not adjudicated (§10.2) — the same move openclaw itself makes, just partitioned by *repo* instead of by *conversation* |
| Repo facts surfacing in an agent's normal recall/auto-recall | **(c) `additional_banks` fan-out** onto the repo bank (deployed mechanism, F6) + explicit `recall(bank_id: repo-…)` (E-75) | Zero new code; read-only, so no writer question exists |
| Agents *authoring* repo lessons | E-78's gated `lesson_learned` path with `author:` provenance, off in R1 (§10.2 pt 2) | The only concurrent-writer case; E-38's silent-arbitrary-resolution is countered by provenance tags + operator-declared write set + a bounded verb — never by hoping the engine adjudicates, because it demonstrably doesn't (E-38; F3 confirms openclaw adds nothing engine-side) |
| Per-context isolation (many users/channels on one gateway) | openclaw's dynamic banks — **the case we don't have**: switchroom is one bank per agent with per-user profile banks already carved out | Dynamic derivation is an isolation tool; our isolation unit (the agent) is static and already keyed by operator config |

**Rejected: (a) "shared dynamic bank keyed on repo."** The word "dynamic" adds
only the derivation mechanism, and F1/F2 show what that mechanism costs
(silent `unknown`/`anonymous` misroutes, ungated lazy bank creation) in
exchange for flexibility a ~15-bank single-tenant fleet doesn't need. The
"shared" half is either §10's single-writer bank (fine — that's (b)) or a
multi-writer pool (E-38, unmitigated by anything found in this probe). Neither
half wants "dynamic".

## Does this change §10 or P5?

**No revision needed to either; the probe strengthens both.**

- **P5 stands as written.** Both comparators' bank resolution is
  bank-per-identity, exactly E-49/E-50's model; openclaw's dynamic default
  just cuts identity finer. No comparator has concurrent-writer machinery, so
  E-38's ground is unchanged. (If a future rev wants it, one optional
  evidence-line addition: "comparators confirm dynamic banks are isolation,
  not sharing" — cosmetic, not structural.)
- **§10 stands as written**, and its single-writer discipline turns out to be
  the same shape openclaw uses to stay out of E-38's blast radius. One
  **wording sharpening to W-2** (small, non-architectural): the granted-banks
  mechanism should let the caller *select among* operator-granted banks via a
  validated optional argument (loud-reject on anything ungranted), because an
  agent granted two repo banks needs a selector; W-2's current "the grant is
  config, not a tool argument" phrasing reads as forbidding any bank argument
  at all. The invariant that matters — grants are operator config rendered at
  apply; no caller can *mint* reach — is preserved either way.

## Not established (named, not reasoned out)

- Whether the **deployed** engine auto-creates a bank on a recall/retain POST
  to a nonexistent bank (write-shaped test, out of scope for a read-only
  probe; openclaw's behaviour implies the engine tolerates it, but that's
  their deployment, not measured on ours).
- Whether openclaw's `agent_id` retain metadata influences engine
  consolidation adjudication in any way (nothing in the plugin suggests it
  can; E-38 says writer identity is stripped — this probe did not re-open the
  engine internals).
- The openclaw *host* (openclaw.ai gateway) side of identity resolution —
  only the Hindsight plugin's published bundle was examined; the plugin is
  where bank IDs are minted, so this bounds the claim adequately.
