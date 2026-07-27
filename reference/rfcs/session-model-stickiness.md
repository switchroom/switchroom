---
artifact: Session-scoped /model stickiness — a durable session-model override that survives switchroom-managed relaunches and reverts on deliberate restarts, crashes, and external container restarts
serves: jobs/steer-or-queue-mid-flight.md
backs: chat-is-the-single-source-of-truth
advances-outcome: hold-the-leash
status: Accepted — revised per adversarial review + operator decision (default REVERT)
---

# RFC — Session-scoped `/model` stickiness

**Status:** Accepted (rev 6 — bounded-retry consume, §0.03, #3284, 2026-07-16, refines rev 4/5's "start.sh deletes the carrier before apply"; rev 5 — deterministic switch, §0.05, operator decision 2026-07-16; rev 4 session-scoped consume-once §0.1 stands EXCEPT its "live Claude switches write no carrier" bullet, now superseded by §0.05, and its "start.sh deletes the carrier on apply" mechanic, now refined by §0.03; rev 3 keep-by-default and rev 2 revert-by-default superseded where §0.1 says so)
**Author:** (agent-authored, operator-directed; semantics decided by the operator 2026-07)
**Targets:** `origin/main` @ v0.18.7
**Builds on:** #2982 (in-memory `sessionModelSource` + one-shot `.session-model-override` carrier), #2983 (live model on progress cards), #3178 (durable /model ack/trace/queue)

---

## 0.03 Rev 6 amendment (#3284, 2026-07-16) — BOUNDED-RETRY consume (who deletes the carrier, and when)

**Problem.** Rev 4/5 had start.sh `rm` the `.session-model` carrier **before**
apply/exec (pure consume-once). But a boot that reads the carrier can **wedge
before its gateway acquires the boot lock** — e.g. the
`boot.lock_stale_recovered_boot_mismatch` race a proxy-only `fable` apply-boot
hit on marko/klanker (2026-07-16Z): two boots overlapped, the LOSER consumed
(deleted) the carrier, and the WINNER's start.sh then found no carrier and
booted the configured default (`opus`). The requested model was lost with no
alert until a later boot happened to re-apply it. Deleting the carrier on the
apply boot hands it to whichever start.sh runs first, which is **not
necessarily the surviving healthy session**.

**Decision.** The carrier is **APPLIED by start.sh but consumed by the
gateway** on a healthy boot:

- **start.sh applies, does NOT delete.** The boot that reads the carrier sets
  `_EFFECTIVE_MODEL` and `exec claude --model <token>` as before, then **leaves
  the carrier in place**. So a wedge before a healthy gateway leaves the carrier
  for the retry boot to RE-APPLY instead of silently reverting. The lock-WINNER
  always runs the applied model, because its start.sh read the carrier (present
  until consumed) before exec.
- **The gateway consumes on `boot.lock_acquired`.** Once this gateway acquires
  the boot lock (`startup-mutex.ts` → `consumeSessionModelCarrierOnHealthyBoot`
  in `session-model-file.ts`, called from `gateway.ts`), it deletes BOTH the
  carrier and the attempt counter. Lock acquisition is the deterministic
  "this boot is the surviving healthy session" signal a wedged boot cannot fake.
  The consume is post-application cleanup for FUTURE boots — the running process
  already has the model baked into its `exec`.
- **Crashloop bound (REVIVED `.session-model-boot-attempts`).** start.sh
  increments a persisted attempt counter on every apply boot and **gives up
  after `_SM_MAX_ATTEMPTS` (3)** — deletes the carrier + counter, reverts to the
  configured default, and writes a `.session-model-alert`. A genuinely BAD token
  (one that crashes claude before lock-acquire on every boot) therefore reverts
  after a hard finite bound, NEVER an unbounded wedge→retry→wedge crashloop.
  This restores rev 4's "a bad token crashes at most one boot then reverts"
  guarantee as "at most `_SM_MAX_ATTEMPTS` boots then reverts". The counter is
  swept as stale by start.sh whenever no carrier is present.
- **Unchanged.** All invalidation branches (corrupt / shape-gate-fail /
  configured-default-changed / proxy-only+LiteLLM-down) still drop the carrier
  immediately and alert — they now also drop the counter. The LiteLLM-down guard
  stays a terminal revert (the 120s probe already elapsed, so "still down" is a
  real down-state, not the transient boot-lock wedge the counter covers).

This refines rev 4/5's consume mechanic; the session-scoped semantics
(override reverts on the next ordinary restart) are unchanged — a healthy boot
consumes, so the next restart finds no carrier.

## 0.05 Rev 5 amendment (operator decision 2026-07-16) — DETERMINISTIC switch (reverses §0.1's "live Claude switches write no carrier")

**Decision:** ALL `/model` switches — Claude→Claude, Claude→sr-*, sr-*→Claude,
the Fable/alias button, and the picker SELECT — go through the consume-once
`.session-model` carrier relaunch (`scheduleModelRelaunch` /
`scheduleModelDefaultRelaunch`). The typed-inject-into-tmux + terminal-scrape
switch path is **RETIRED**. This **supersedes §0.1 bullet 1** ("Live Claude
switches write NO carrier … apply in-session via claude's native picker").
Everything else in §0.1 (session-scoped revert on the next restart, consume-once,
`/effort` unchanged, the invalidation/down-guard branches) still holds.

- **Rationale.** The inject path silently no-op'd — keystrokes were swallowed
  when the pane was not idle (and, per operator report, on idle panes too) — then
  **optimistically recorded** the requested model as a success, an unverifiable
  lie to `/status`. The carrier relaunch is deterministic: start.sh's
  `exec claude --model <token>` cannot silently no-op, and `.active-session-model`
  is a real post-boot signal. Success is reported ONLY from that signal (the
  in-memory override is re-hydrated from `.active-session-model` at boot; the
  transcript's `message.model` reclaims it on the first assistant line), never
  from a scraped pane.

- **Trade-off accepted.** A Claude→Claude switch now costs a fresh session
  (~30s) and loses live in-session scrollback. Acceptable per operator: Hindsight
  memory + the handoff briefing carry context. No `--continue`/`--resume`.

- **Determinism scope (honest).** `.active-session-model` records the token
  start.sh wrote *before* `exec claude` (the REQUESTED token), not a post-launch
  confirmation. If a shape-valid but UNKNOWN Claude id is requested,
  `--fallback-model` can mask it — claude serves the fallback while
  `.active-session-model` holds the requested token. This is NOT a persistent
  lie: the transcript's `message.model` reclaims the source on the first
  assistant line, correcting `/status` to the model actually serving calls. The
  pre-first-assistant window is the only optimistic window (bounded). Since
  #3427 item 4 the correction is LOUD, not silent: (a) the `/model` ack for a
  free-text `claude-*` full id carries an immediate caveat that the id cannot
  be pre-validated (Claude-native constraint — no raw API probe) and that the
  fallback may substitute; (b) the session-model source verifies the first
  LIVE post-boot transcript line against the requested token
  (`servedModelMatchesRequested`, conservative — never accuses a
  non-comparable pair; verification arms ONLY at the boot-rehydration
  `setOverride(…, { verify: true })` site, and first-attach REPLAY lines from
  the pre-relaunch session are flagged and skipped — the #3437 H1/H2
  false-positive guards) and on mismatch the gateway logs
  `gw /model served-model DIVERGENCE` and sends a one-shot ⚠️ card to the
  initiating chat naming BOTH candidate causes (invalid id, or transient
  unavailability — `--fallback-model` substitutes for either). The override
  record is kept: a transient substitution self-corrects on later replies,
  and freshness rules already point /status at the served model. The honest-FAILURE surface at boot
  remains the three `.session-model-alert` modes (corrupt carrier /
  configured-default changed / proxy-only + LiteLLM-down).

- **`default` reverts via relaunch.** With inject retired, `/model default`
  clears the carrier + in-memory override and RELAUNCHES so the live session
  actually reverts to the configured `model:` (rather than a live no-op clear).

- **Fable via the router (F2).** Routing the Fable BUTTON through the carrier
  newly exposes that `fable`/`claude-fable-5` needs the LiteLLM **router root**,
  not the `/anthropic` passthrough: `claude-fable-5` is a retired codename that
  4xxs direct-to-Anthropic and only resolves via the router
  (maps `fable`/`claude-fable-5` → `anthropic/claude-fable-5`, forwarding the
  OAuth). start.sh's passthrough→router repoint `case` and its LiteLLM-down guard
  are extended from `sr-*` to also cover `fable`/`claude-fable-5`. Verified live
  against the litellm config + router `/v1/models`. Other Claude sessions
  (opus/sonnet/haiku/default) keep the passthrough (it dodges the Opus SSE
  re-chunk stall); Fable trades that for being routable at all.

- **No restart storm.** Unchanged: the 15s `scheduleRestart` debounce (one
  relaunch per switch; a second `/model` inside the window surfaces "~15s"),
  consume-once (`rm -f` before apply), and last-write-wins on the carrier.

- **Retired code.** `recordTypedModelSwitch`, `recordModelMenuSideEffects`, the
  `isSrToClaudeTransition` wiring, the `inject`/`select` model-deps, and the
  scrape helpers (`modelSwitchConfirmationLine`, `modelSwitchErrorLine`,
  `isKeptModelConfirmation`, `sessionModelFromConfirmation`,
  `optimisticModelRecordLabel`, `MODEL_SWITCH_*` regexes) are deleted; the
  `optimistic` / scrape-derived `selectedModel` reply fields are removed.

- **Copy.** All user-facing strings that claimed Claude switches are
  instant/in-session are corrected to: *"A `/model` switch relaunches the session
  (~30s) on the chosen model; session-only, reverts to the configured `model:` on
  the next restart. Live scrollback is replaced by a fresh session — memory and
  the handoff briefing carry the context."* §4.5's "applies in-session via
  claude's native picker" copy is superseded accordingly.

---

## 0.1 Rev 4 amendment (#3183, operator decision 2026-07-12) — session-scoped, consume-once

The operator requirement (verbatim): *"/model overrides should only last until
that agent is restarted; on restart the agent should default back to switchroom
config."* This **supersedes** the rev-3 §0 keep-by-default contract (and the
rev-2 revert-by-default rows). A `/model` override is now **session-scoped**:
it lives for the current session and any restart drops it back to the
`switchroom.yaml` `model:`.

Mechanism — **consume-once carrier** (no intent file):

- **Live Claude switches write NO carrier.** _[SUPERSEDED by §0.05 (rev 5).]_
  This bullet described the retired inject-into-tmux path (a typed `/model
  <claude>` or Claude menu tap applied in-session via claude's native picker,
  writing no carrier). Rev 5 routes EVERY switch — including Claude→Claude and
  the picker/Fable buttons — through the consume-once `.session-model` carrier
  relaunch, because the inject path silently no-op'd then optimistically lied to
  `/status`. See §0.05.
- **Relaunch-requiring switches write a consume-once `.session-model`.** The
  sr-* and sr→Claude paths (`scheduleModelRelaunch` / the menu sr→Claude
  transition) and a queued /model persisted at graceful shutdown write the
  carrier **immediately before the relaunch that applies it**. start.sh applies
  the carrier on the single boot that reads it and then **deletes it**. That
  deletion is the marker that distinguishes the model-apply relaunch from any
  later restart.
- **Every SUBSEQUENT restart reverts** — deploy, `/restart`, `/new`/`/reset`,
  inline restart button, hostd/CLI restart, watchdog recovery, crash, raw
  `docker restart`, host reboot. The carrier was consumed on the apply-boot, so
  these boots find no carrier and launch the configured default.
- **The `.relaunch-model-intent` keep/revert subsystem is retired** (writers,
  readers, `intentForRestartReason`, `clearStaleGatewayShutdownIntent`,
  `GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX`) and so is the **crashloop self-heal
  counter** (`.session-model-boot-attempts`): a consume-once carrier can crash
  at most one boot before it is gone, so no self-heal is needed.
- **Clearing / invalidation.** `/model default` deletes the carrier and clears
  the in-memory override live. start.sh drops (without applying) a corrupt
  carrier or one whose `configuredDefaultAtWrite` no longer matches the current
  configured default, and writes a `.session-model-alert` the gateway relays.
  The normal apply-boot is silent — the gateway already acked the `/model` in
  chat. The 7-day staleness bound is moot (a carrier never survives one boot).
- **sr-* + LiteLLM-down at the apply-boot:** the carrier cannot apply and
  consume-once forbids retaining it for a later relaunch, so start.sh boots the
  configured default and alerts the operator to re-issue once the proxy is back.
- **`/effort` is session-scoped too** (#3186, operator decision 2026-07-12,
  resolving the #3183 open question). A live `/effort <level>` applies
  in-session via the applyEffort driver and records in gateway memory only —
  no carrier — so start.sh's explicit `--effort <configured>` reverts it on
  the next boot. `.session-effort` remains solely as the queued-command
  shutdown carrier and is consume-once at boot, with the same LOW-3-style
  crash-recovery exception as `/model`. start.sh records the effective
  launched effort to `.active-session-effort` (sibling of
  `.active-session-model`) so the gateway re-hydrates the menu's live level
  after a queued-apply boot. The CONFIGURED `thinking_effort` resolution is
  untouched — the configured `thinking_effort` (#1978, `thinking-effort-risk.ts`;
  see Appendix A) resolves exactly as before.
- **#3178 preserved.** Instant ack, the durable receipt log + history row, the
  mid-turn queue-and-apply, and explicit failures are untouched; the queued
  apply persists a consume-once carrier at shutdown so it still applies as the
  agent boots (its apply-relaunch), then reverts on the next restart.
  **Deliberate exception (#3184 review LOW-3):** that persist runs on every
  shutdown path INCLUDING crashes, so a mid-turn queued `/model` + crash
  applies on the crash-recovery boot — honoring the acked pending request
  ("a queued /model never silently vanishes") rather than the literal
  crash-reverts reading; gated to offline-trusted tokens and bounded by
  consume-once to that single recovery boot, after which any restart reverts.

The rev-2/rev-3 §0 and §§2-6 below are the historical design record; where they
describe keep-by-default, intent files, the crashloop counter, or the 7-day
expiry they are **superseded by this §0.1**.

---

## 0. Rev 3 amendment (#3039, operator decision 2026-07-11) — keep by default

The operator requirement (verbatim intent): *"a user-set session model/effort
override must survive agent restarts and deploys, and is cleared only on
explicit user action; if it can't apply, ack, apply deterministically when
possible, and confirm."* This **supersedes** the rev-2 revert-by-default
rows below. The new contract:

- **Boot default is KEEP.** `.session-model` is honored on every boot —
  deploy, `/restart`, inline restart button, hostd/CLI restart, watchdog
  bounce, raw `docker restart`, host reboot, crash. Rows 8, 9, 10, 12, 14,
  15 and 20 of the §6 table now read **kept**.
- `.relaunch-model-intent` remains, but only a **fresh explicit "revert"**
  intent reverts at boot. Current gateway code never stamps revert
  (`intentForRestartReason` always returns keep); the path exists for
  compatibility and future explicit-revert flows.
- **The 7-day staleness expiry is removed** (row 21). An override the user
  never revoked is never silently dropped.
- **Clearing paths** are exactly: `/model default` (live delete), a
  configured `model:` change (invalidation, row 16 — unchanged), and a
  corrupt file (row 19 — now also writes a `.session-model-alert` chat
  notice instead of a stderr-only drop). Every clearing path notifies the
  operator chat once at boot via the existing alert relay.
- **`/effort` gains the same contract** via a sibling `.session-effort`
  carrier (`{"level","configuredDefaultAtWrite","ts"}`, allowlist-gated
  low|medium|high|xhigh|max): written on every positively-confirmed effort
  apply, resolved by start.sh into `--effort`, cleared only by the new
  `/effort default` or invalidation (with a boot alert appended to
  `.session-model-alert`).
- **Queued commands survive the bounce.** When the gateway shuts down (or a
  session relaunch is already pending) with a queued mid-turn `/model` /
  `/effort`, the typed choice is persisted to the durable carriers and the
  ack card says "saved — applies as the agent boots" instead of "re-issue".
  Only an unresolvable `mdl:s:<tag>` menu selection still asks for a
  re-issue.
- **Unconfirmed queued tokens are gated before durable persist** (#3042
  blocker 2a): a queued typed `/model <arg>` persisted at shutdown was never
  validated by claude, so only offline-trustable tokens (static Claude
  aliases, curated sr-* alias targets — `isOfflineTrustedModelToken`) are
  written to the carrier; anything else gets an honest "couldn't verify —
  re-issue after restart" card. Belt-and-braces, start.sh self-heals a
  crashlooping override (#3042 blocker 2b): three consecutive fast boots
  (<150s apart, tracked in `.session-model-boot-attempts`) with an override
  active clear the carrier, boot the configured default, and alert once —
  this also covers a confirmed model later retired upstream.
- **Kept-alert dedup** (#3042 item 4): the "override kept across this
  relaunch" chat notice fires once per kept value
  (`.session-model-kept-notified` sentinel), so a watchdog bounce loop
  cannot storm the chat; every clearing path drops the sentinel.
- **Version skew** (#3042 item 3): `.session-effort` boot resolution and the
  crashloop self-heal live in the RE-SCAFFOLDED `start.sh` — until the
  operator runs `switchroom apply` (or the agent is re-scaffolded), "applies
  at boot" holds only for the model path on switchroom-managed bounces; a
  persisted effort override is honored from the first boot on the new
  scaffold.
- **Quota-failover interaction** (#3042 item 7): keep-by-default means a
  pinned expensive model now survives quota-exhaustion restarts indefinitely
  — the fleet-fallback flow still switches the LIVE session, but the boot
  carrier re-asserts the pinned model on the next relaunch until the user
  runs `/model default`. Operators relying on exhaustion restarts to shed an
  expensive pin must clear it explicitly.
- **No user-visible dead-ends.** The idle drain re-enqueues on a
  turn-in-flight race or a handler busy-refusal instead of stamping the
  refusal onto the ack card; the mid-turn `/model` menu renders a static
  alias/external keyboard whose taps queue, instead of "try again in a
  moment".

## 1. Problem

`start.sh` always launches `claude --model {{modelQ}}` from the cascade-resolved
`switchroom.yaml` `model:` (`profiles/_base/start.sh.hbs`). The explicit flag
outranks `settings.json` *and* claude's own `/model` persistence, so a user's
confirmed `/model X` switch survives exactly until the next relaunch — any
relaunch.

#2982 papered over one edge with the **one-shot** `.session-model-override`
carrier: the gateway writes the token, gracefully restarts, and start.sh
consumes it with `rm -f` on that single boot. Nothing survives the boot after
that. The original bug remains for every *switchroom-managed involuntary*
relaunch: a gateway restart-watchdog kill, a drain-cap forced bounce, a
fleet-fallback resume — each re-runs start.sh with no carrier, and the session
silently snaps back to the configured default mid-work. The user asked for a
model; the machine forgot because the machine hiccuped.

## 2. Operator-decided semantics (hard requirements, rev 2)

The operator decision (2026-07, superseding draft row 14): a **raw
`docker restart` / host reboot must REVERT** to the yaml model. Since that is
indistinguishable from a crash from inside the container, **the boot default
is REVERT-when-no-intent**, and every KEEP path must write intent before the
bounce.

1. A **positively-confirmed** `/model X` switch (typed inject with anchored
   confirmation, menu tap, sr-* relaunch paths) becomes a **durable session
   override**: the gateway writes a `.session-model` state file on every
   confirmed switch, always with a **canonical `claude --model` token** (never
   a display label like "Opus 4.8").
2. `/new` (force-fresh-session restart) and `/clear` (in-session context
   clear) **keep** the override.
3. Deliberate restarts — the `/restart` chat command, the inline restart
   button, hostd `agent_restart`, `switchroom agent restart` CLI, `stop`+
   `start` — **revert** to the `switchroom.yaml` model.
4. **Switchroom-initiated involuntary relaunches keep** the override: the
   in-gateway restart watchdog kill, gateway recovery bounces
   (`schedule-restart-immediate`, `restart-drain-cap-forced`,
   `turn-complete-pending-restart`, `fleet-fallback-resume`), handoff/resume
   relaunches, and the sr-to-claude model-switch restart. All of these run
   gateway code that can (and MUST) stamp keep-intent before signalling.
5. Crash / OOM / raw `docker restart` / host reboot / dockerd restart — no
   gateway code runs, no intent lands — **revert** (operator-accepted; the
   boot notice announces it).
6. **Deploys revert.** `switchroom update` / `apply` / `rollout` restarts
   write no keep-intent, so they revert by default. Correctness never depends
   on the host CLI writing anything.
7. Changing `model:` in `switchroom.yaml` (or an apply that changes the
   resolved default) **invalidates** the override.
8. `/model default` explicitly **clears** it (and still injects claude's
   native `/model default` on the Claude path, keeping the live process
   truthful).
9. `/status`, the model menu, and progress cards stay truthful across all of
   the above.
10. The existing sr-* + LiteLLM-down guard in start.sh is preserved (retain
    the file, don't apply this boot, alert).

## 3. Architecture ground truth (verified, drives the design)

Verified against `origin/main` @ 21478348:

- **There is no in-container claude relaunch.** PID 1 is tini; the entrypoint
  is start.sh, which ends in `exec claude …`. When claude exits — for any
  reason — the container exits and compose's `restart: always` recreates it,
  re-running start.sh. **Every relaunch flavor converges on the same start.sh
  re-exec.**
- The in-gateway restart primitive is `triggerSelfRestart()` →
  `process.kill(1, 'SIGTERM')` (`telegram-plugin/gateway/gateway.ts`). Its
  callers, enumerated (rev-2 invariant — every caller's intent classification
  is stated here and enforced by the per-reason table in code):
  - `schedule-restart-immediate` — recovery → **keep**
  - `restart-drain-cap-forced` — recovery → **keep**
  - `turn-complete-pending-restart` — deferred restart completing (covers the
    deferred sr-to-claude switch) → **keep**
  - `fleet-fallback-resume` — recovery → **keep**
  - `sr-to-claude-model-switch` — model switch → **keep**
  - the generic `sweepBeforeSelfRestart().finally(...)` dispatcher used by
    the scheduled-restart path → **keep**
  - `inline-button-restart` — operator-deliberate → **revert**
- **Watchdog terminology.** Two watchdogs exist and only one bounces the
  container: the **in-gateway restart watchdog** restarts via
  `triggerSelfRestart` — gateway code runs, so it stamps keep-intent. The
  **host-side wedge-watchdog** only sends tmux `C-c` into the pane and never
  bounces the container — no intent involved. A gateway-initiated
  crash-*resume* bounce keeps; a true dead-process crash (no gateway code ran)
  writes nothing and therefore reverts.
- hostd `agent_restart` shells through `switchroom agent restart <name>`
  (`src/host-control/server.ts` `handleAgentRestart`). Under rev-2 default-
  revert semantics the CLI needs **no intent writer at all**: absence of
  intent already means revert. This also removes two draft hazards outright:
  the deploy-flavored `agent restart --pin` rollout path (review finding 1)
  and the cron-only hot-reload branch in `reconcileAndRestartAgent` that
  returns `restarted: false` without a bounce (finding 2) — with no CLI
  writer, neither can strand or mis-apply an intent.
- `.active-session-model` — start.sh records the *effective launched* model
  each boot (overwrite, not consumed); the gateway reads it at boot to
  re-hydrate `sessionModelSource`. Kept.
- `sessionModelSource` (`telegram-plugin/gateway/session-model-source.ts`) —
  freshness-sequenced transcript-vs-override resolution for `/status`.
  Unchanged; only boot seeding gains the durable file as a source.

## 4. Design

### 4.1 Durable state file: `.session-model`

Location: `{{agentDir}}/.session-model` (bind-mounted agent state dir —
survives container recreation, visible to host CLI and hostd).

Format — single-line JSON, atomically written (tmp + rename):

```json
{"model":"sr-x-ai/grok-4","configuredDefaultAtWrite":"claude-opus-4-8","ts":1783948123456}
```

- `model` — the canonical `claude --model` token (alias, `claude-*` id, or
  `sr-*` id), same shape gate as the #2982 carrier (`MODEL_ARG_RE` ↔ the
  start.sh grep, byte-identical). **Every write site canonicalizes**: the
  typed path writes the *requested token* (never the confirmation's display
  name); the menu path writes `selectedModelToken` (already canonical via
  `canonicalClaudeToken`); a selection with no derivable token writes nothing.
- `configuredDefaultAtWrite` — the resolved configured default at the moment
  of the switch, sourced from `.configured-default-model` (§4.2) so both
  sides of the invalidation comparison come from the same resolver.
- `ts` — wall-clock ms. Used for (a) observability and (b) a **7-day
  staleness bound**: a `.session-model` older than 7 days is ignored+deleted
  at boot even under keep-intent (guards version-rollback resurrection and
  forgotten overrides; see §5.3).

**Ownership:** the *gateway* is the only runtime writer/deleter (confirmed
switches, `/model default`, rollback). *start.sh* deletes it on
revert/invalidation/corruption/staleness at boot. The *host CLI never touches
it*.

### 4.2 Boot record: `.configured-default-model`

start.sh writes the configured default to
`{{agentDir}}/.configured-default-model` on every boot, before override
resolution (overwrite, not consumed). **Exact rendering:** the write is
`printf '%s\n' "$_EFFECTIVE_MODEL" > …` executed immediately after
`_EFFECTIVE_MODEL={{{modelQ}}}` and before any override is applied — i.e. the
file holds the RAW UNQUOTED resolved token (`{{modelQ}}` is shell-single-
quoted by the scaffold; assigning it bare and printf-ing the variable strips
the quoting). The gateway copies this file's value into
`configuredDefaultAtWrite` when writing `.session-model`.

**Comparison semantics are literal-string compare** of two outputs of the
same resolver (`resolveMainModel`):
- An **alias repoint** (e.g. `opus` newly resolving to a different id
  upstream) does NOT invalidate — the stored and current strings are both
  the alias/resolved token from the same resolver and stay equal. Correct:
  the operator's config didn't change.
- A **token rename** in yaml that is semantically the same model (e.g.
  `opus` → `claude-opus-4-8`) spuriously invalidates. Accepted: it is
  announced by the alert, and re-issuing `/model` is cheap.
- **No `model:` in yaml**: `resolveMainModel(undefined)` yields the
  switchroom default id; that string is what's stored and compared. The
  "unset" case is therefore just another literal value, never empty. An
  empty `.configured-default-model` at gateway write time falls back to the
  gateway's own `resolveMainModel(configured)` read.

### 4.3 The intent file: `.relaunch-model-intent` (single, last-writer-wins)

**One** intent file replaces the draft's competing keep/reset sentinels
(review findings 4+8): `{{agentDir}}/.relaunch-model-intent`, one-line JSON

```json
{"intent":"keep","reason":"user: /new from chat","ts":1783948123456}
```

- `intent` — `"keep"` or `"revert"`. Atomic write (tmp+rename),
  last-writer-wins by construction.
- One-shot: start.sh `rm -f`s it unconditionally after resolution, every
  boot.
- **Freshness gate: 10 minutes, for BOTH intents** (the draft's separate 60s
  CLI keep window is gone along with the CLI writer). Stale or corrupt intent
  = no intent = revert. The freshness clock is the **embedded `ts` field**
  (not file mtime) — one clock, used identically by the sh resolver and the
  TS writer; mtime is not consulted anywhere.

**Boot rule (the whole contract):** a fresh `keep` intent → apply
`.session-model` (through the shape / invalidation / staleness / LiteLLM
gates). Anything else — `revert` intent, absent, stale, corrupt — →
`rm -f .session-model`, boot the yaml default, and (when an override was
actually removed) emit a boot notice naming why.

**Writers are gateway-only:**

| Path | Intent | Where |
|---|---|---|
| `triggerSelfRestart(reason)` — every caller | per-reason table (§3): all recovery/model reasons `keep`; `inline-button-restart` `revert` | written **synchronously inside `triggerSelfRestart`, before the SIGTERM is scheduled** — the ordering invariant, pinned by test |
| `/restart` chat command | `revert` (reason honesty — absence would revert anyway) | `/restart` handler, before hostd dispatch |
| `/new` / `/reset` | `keep` | handler, before hostd dispatch (alongside `.force-fresh-session`) |
| model-switch restart dispatch (`scheduleRestart` in buildModelDeps — only ever called for model switches) | `keep` | before hostd dispatch |
| `scheduleModelRelaunch` (sr-* switch, typed or menu) | `keep` | with the `.session-model` write, before dispatch; rolled back with it on non-in-flight dispatch failure |

**Non-writers (deliberate):** `switchroom agent restart` / `stop`+`start`,
`switchroom update` / `apply` / `rollout`, hostd's CLI shell-through — all
write nothing, so all revert. Rationale: (a) correctness must not depend on a
host binary that may be older/newer than the container's start.sh; (b) a CLI
revert-writer would race the gateway's keep-intent on the hostd
shell-through path (`/new` and `scheduleModelRelaunch` dispatch hostd →
`switchroom agent restart` — an unconditional CLI revert would clobber the
just-written keep and break the model switch itself). An *optional* CLI
revert write purely for boot-notice honesty was considered and rejected for
that clobber hazard; the clean-shutdown reason marker already carries the
human-readable cause.

### 4.4 Boot resolution (start.sh)

Replaces the one-shot `.session-model-override` block. Order of operations
after `_LITELLM_OK` probing, before `exec claude`:

```
_EFFECTIVE_MODEL={{{modelQ}}}                      # bare — scaffold-quoted
printf … > .configured-default-model               # §4.2, every boot

# migration (§7): a leftover one-shot carrier is a NEWER user intent than
# any .session-model on disk — convert it (overwrite) and treat as a
# just-confirmed switch: apply THIS boot (implicit keep), then rm -f.

read .relaunch-model-intent (if present); rm -f it
_SM_KEEP=1 iff intent parses, intent=="keep", and now-ts < 10min

if .session-model exists:
    if ! _SM_KEEP:            rm .session-model; notice "reverted to default
                              (<intent reason> | no keep intent — crash,
                              external restart, or deploy)"
    elif unparsable/shape-gate fail:  rm; loud stderr log
    elif configuredDefaultAtWrite != current default:
                              rm; notice "configured default changed —
                              override cleared"
    elif ts older than 7 days: rm; notice "override expired (stale)"
    elif model is sr-* AND ! _LITELLM_OK:
                              KEEP FILE, boot default, notice "proxy down;
                              override retained, re-applies next relaunch"
    else:                     _EFFECTIVE_MODEL=<model>; notice "session
                              override <model> kept across relaunch"

… existing sr-* passthrough→router repoint on _EFFECTIVE_MODEL …
printf _EFFECTIVE_MODEL > .active-session-model    # unchanged (#2983 feed)
```

JSON extraction is POSIX `sed` (no jq dependency), shape-gated with the
byte-identical `MODEL_ARG_RE` grep.

### 4.5 Truthful surfaces

- **Boot seeding:** unchanged mechanically — the gateway reads
  `.active-session-model` and sets the override when the launched model
  differs from the resolved configured default. The durable `.session-model`
  is the *carrier*; the launched-model record remains the seed of record for
  what is actually running (including the degraded sr-*+proxy-down boot,
  where launched == default and no override is seeded — correct).
- **Boot notices:** every branch of §4.4 that changed or preserved a
  non-default state writes the `.session-model-notice`/alert sentinel
  (`.session-model-alert`, mechanism reused verbatim from #2982) which the
  gateway turns into an operator Telegram message at boot: kept / reverted /
  invalidated / expired / proxy-down-retained. An involuntary bounce never
  silently continues on (or silently drops) a non-default model.
- **User-facing copy:** the `/model` footers are rewritten to:
  _"Sticky across switchroom-managed relaunches (`/new`, watchdog recovery);
  reverts on `/restart`, agent restart, crash, or external container
  restart. `/model default` clears it."_
- **Progress cards (#2983)** read the live model via `sessionModelSource` —
  truthful for free once boot seeding is right.

## 5. Failure modes

- **Corrupt `.session-model`** — parse/shape failure → delete, boot default,
  loud stderr. Never launch `claude --model` with an unvalidated string.
- **Stale override lingering** — bounded by the 7-day `ts` expiry plus three
  explicit exits (any deliberate restart, invalidation, `/model default`),
  and every keep boot announces itself.
- **Intent written, restart never happens** — 10-min freshness gate +
  unconditional post-resolution `rm -f`. A stale keep from a failed dispatch
  cannot make a *later* crash keep.
- **Gateway crashes between `.session-model` write and dispatch** (sr-*
  path): file exists, no keep-intent ever lands, next boot reverts and the
  notice explains. The user re-issues `/model` — never a wedged state. (This
  is stricter than the draft, a deliberate consequence of default-revert.)
- **Competing initiators** (e.g. `/new` racing an operator restart): single
  file, atomic write, last-writer-wins; the 15s in-gateway restart debounce
  serializes in practice; worst case one restart lands on the wrong row and
  self-corrects at the next event.
- **Version rollback** (new code writes `.session-model`, fleet rolls back
  to pre-RFC start.sh): old start.sh ignores the file entirely (it only
  knows the one-shot carrier) — the agent just boots its default. Rolling
  forward again, the file only re-applies under a fresh keep-intent, which a
  rollback bounce never writes, so the first new-code boot deletes it. The
  7-day bound is belt-and-braces on top. Self-healing; no resurrection.

## 6. Contract table (event → override)

| # | Event | Override | Mechanism |
|---|---|---|---|
| 1 | Confirmed `/model X` (typed, Claude) | **written** | gateway writes `.session-model` with the requested canonical token |
| 2 | Confirmed `/model X` (menu, Claude) | **written** | `selectedModelToken` (canonical) → file |
| 3 | `/model <sr-*>` (typed or menu, relaunch) | **written** | `scheduleModelRelaunch` writes file + keep intent; boot applies |
| 4 | sr-* → Claude switch (restart path) | **written** (new model) | token file + keep intent before dispatch/SIGTERM |
| 5 | Unconfirmed / failed / "Kept model as X" | unchanged | no write without positive confirmation |
| 6 | `/clear` (in-session context clear) | **kept** | no relaunch at all |
| 7 | `/new` / `/reset` | **kept** | gateway writes keep intent before dispatch |
| 8 | `/restart` chat command | **reverted** | gateway writes revert intent (reason honesty); boot deletes file |
| 9 | Inline restart button | **reverted** | `triggerSelfRestart` per-reason table → revert |
| 10 | hostd `agent_restart` / `switchroom agent restart` / `stop`+`start` | **reverted** | no intent written → default revert |
| 11 | In-gateway restart-watchdog / recovery bounce (`schedule-restart-immediate`, `restart-drain-cap-forced`, `turn-complete-pending-restart`, `fleet-fallback-resume`) | **kept** | `triggerSelfRestart` writes keep before SIGTERM |
| 12 | Crash / OOM / dead-process kill | **reverted** | no gateway code ran → no intent → revert; boot notice says so |
| 13 | Gateway-initiated handoff/resume relaunch | **kept** | routed through `triggerSelfRestart` → keep |
| 14 | Raw `docker restart` / host reboot / dockerd restart | **reverted** (operator decision) | indistinguishable from crash; no intent → revert + notice |
| 15 | `switchroom update` / `apply` / `rollout` | **reverted** | deploys write no keep intent (rev-2 decision) |
| 16 | yaml/apply changes resolved `model:` | **invalidated** | `configuredDefaultAtWrite` mismatch at next boot → delete + notice |
| 17 | `/model default` (typed or menu Default row) | **cleared** | gateway deletes file, clears in-memory override, still injects native `/model default` on the Claude path |
| 18 | sr-* override + LiteLLM unreachable at boot (under keep) | **retained, not applied this boot** | boot runs default, keeps file, notice |
| 19 | Corrupt / malformed `.session-model` | **deleted** | shape-gate fail → rm + loud log |
| 20 | Stale (>10 min) or corrupt intent | treated as **no intent → revert** | freshness gate on embedded `ts` |
| 21 | `.session-model` older than 7 days | **deleted** | staleness bound, notice |

## 7. Rollout / migration from the one-shot carrier

1. Single PR: start.sh gains the §4.4 block. Migration shim: when the old
   `.session-model-override` carrier exists at boot, it is the **newer**
   intent (an old gateway wrote it immediately before this very bounce) — it
   **wins over any `.session-model`**: overwrite-convert (write
   `.session-model` from its token with the current default and now-ts),
   `rm -f` the carrier, and apply THIS boot (implicit keep — the carrier's
   presence is itself the keep signal, exactly its old one-shot semantics).
   The gateway stops writing the old carrier.
2. Cleanup (next release): delete the shim; retire
   `scaffold.session-model-override.test.ts` in favor of the successor suite.
3. No data migration otherwise: absence of `.session-model` is the
   well-defined default state.

New sentinels live in the already-mounted agent dir — no compose
regeneration needed; a normal `switchroom update` (regenerated start.sh +
restart) suffices, and per row 15 that deploy itself reverts any live
override (announced).

## 8. Test plan

**Unit (vitest / bun per repo boundary rules):**

- `session-model-file` (gateway helpers, pure): serialize/parse round-trip;
  canonicalization at every write site (typed-confirmation path can never
  persist "Opus 4.5" — regression for review finding 7); intent
  classification table (every `triggerSelfRestart` reason → keep/revert).
- Rendered-start.sh scaffold suite (`tests/scaffold.session-model.test.ts`,
  successor to `scaffold.session-model-override.test.ts`): sh-harness
  fixtures executed with bash against the RENDERED block, one per
  boot-resolving contract row — including: **no intent on disk → revert +
  notice** (covers rows 10/12/14/15 — the raw-docker-restart fixture);
  fresh keep → apply; revert intent → revert; stale/corrupt intent → revert;
  invalidation; corrupt file; 7-day staleness; sr-*+LiteLLM-down retain;
  migration carrier-wins-over-file; **MODEL_ARG_RE byte-parity against the
  RENDERED start.sh** (not the template).
- Rendered notice text asserted (the outbound alert string the gateway
  relays), not just sentinel existence.
- Gateway source-pins (pattern of `gateway-session-model-relaunch.test.ts`):
  intent write ordered **before** `process.kill` in `triggerSelfRestart`;
  keep-intent + file write ordered before dispatch in
  `scheduleModelRelaunch`; `/new` keep and `/restart` revert stamps;
  rollback restores prior file.
- Watchdog-vs-crash divergence: keep-intent fixture (watchdog) applies;
  no-intent fixture (kill -9) reverts.

**UAT (live, follow-up):** `/model sonnet` → watchdog-killable hang →
post-bounce `/status` still sonnet (rows 1+11, the original bug); `/model
<sr-*>` → `/new` → still sr-* (7); `/restart` → default + notice (8); raw
`docker restart` → default + notice (14); yaml model edit → invalidation
notice (16); LiteLLM-down retain/re-apply (18).

## 9. Resolved review findings (disposition record)

1. hostd rollout via `agent restart --pin` — **moot**: no CLI intent writer
   exists; deploys revert by design (rev-2 operator-flagged semantics).
2. cron-only hot-reload branch (`restarted:false`) — **moot**: same.
3. Intent staleness clock — pinned to the embedded `ts` field, one clock in
   sh and TS; write happens immediately before signal/dispatch.
4/8. Competing sentinels — single `.relaunch-model-intent`, atomic,
   last-writer-wins; every `triggerSelfRestart` caller classified (§3).
5. Version-rollback resurrection — self-heals under default-revert (§5);
   7-day `.session-model` bound added.
6. Comparison hygiene — §4.2 pins the unquoted rendering and literal-compare
   semantics incl. the no-`model:` case.
7. Canonical token at every write site + test — §4.1, test plan.
9. Test plan upgraded per §8 (rendered text, rows 10/12/14/15 fixtures,
   byte-parity vs rendered start.sh).
10. Caller enumeration — §3.

---

## Appendix A — Correction of record: the fleet `model: opus` effort-floor pin

Separate, small, operator-owned-config item recorded here so the rationale is
in the design record (the yaml itself is edited by the operator, not by a PR).

The comment above `thinking_effort: low` in the operator's `switchroom.yaml`
(next to the fleet `model: opus` pin) currently attributes the
`400 … 'thinking'/'redacted_thinking' blocks … cannot be modified` failure to
**the framework's em-dash scrubber invalidating thinking-block signatures.
That attribution is wrong.** The real, verified basis is the **upstream
claude CLI streaming-merge bug** tracked in
`src/config/thinking-effort-risk.ts` (issue #1978): with concurrent sub-agent
dispatch, the bundled CLI can mis-merge interleaved streaming content blocks,
after which the API rejects the turn with that 400. `effort: low` keeps
adaptive thinking near-zero (nothing to mis-merge) and is the safe floor;
`medium`+ reliably reproduced it on Opus 4.x. The guard module and its
docstring are the source of truth; the yaml comment should be corrected by
the operator to cite #1978 / `thinking-effort-risk.ts` instead of the
scrubber.

**Follow-up validation task (file as an issue when this RFC lands):** the
upstream fix is credited in claude's own changelog for the concurrent-agent
interleaved-streaming merge path. Re-test `thinking_effort: medium` on Opus
4.x under bundled CLI **2.1.205** with concurrent background sub-agents (the
#1978 reproduction shape) before relaxing either the yaml floor or the
`isAdaptiveThinkingOpus` doctor guard. Until that test passes, the floor
stays.

### Resolution, 2026-07-27 — guard narrowed to Opus 4.x; the Opus 4.x floor stays

The validation above is now partly discharged, for Opus 5 only:

- The upstream fix shipped in claude-code **2.1.156** and switchroom pinned it
  in **v0.14.8** (CHANGELOG, "Claude CLI pinned to `@2.1.156` (the 400-fix
  build)"). `docker/Dockerfile.base` now pins **2.1.219**, 63 builds past it.
- The field re-test happened on Opus 5, not Opus 4.x: klanker and overlord have
  run `thinking_effort: medium` on the `opus` alias since 2026-07-25 with no
  recurrence of the 400.
- The scrubber theory is independently disproved, as this appendix already
  says: `normalizePunctuation` runs only in the Telegram send path and never
  rewrites the session `.jsonl`, so it cannot alter what is replayed to the API.

So `isAdaptiveThinkingOpus()` was narrowed to **pinned `claude-opus-4*` ids
only** — dropping the bare `opus` alias (which now resolves to Opus 5, so
matching it flagged Opus 5 by proxy) and both `claude-opus-5` forms that #3525
had added. Before the narrowing, `switchroom doctor` WARNed on a correct
Opus 5 + `medium` config; that false positive is gone.

What did NOT change: the `low` floor for **pinned Opus 4.x** agents. Nobody has
re-run the #1978 reproduction on Opus 4.x under a post-2.1.156 CLI, so the
guard keeps warning there. When that test passes, delete
`src/config/thinking-effort-risk.ts` and its `doctor` check outright.
