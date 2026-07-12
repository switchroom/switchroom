---
artifact: Session-scoped /model stickiness — a durable session-model override that survives switchroom-managed relaunches and reverts on deliberate restarts, crashes, and external container restarts
serves: jobs/steer-or-queue-mid-flight.md
backs: chat-is-the-single-source-of-truth
advances-outcome: hold-the-leash
status: Accepted — revised per adversarial review + operator decision (default REVERT)
---

# RFC — Session-scoped `/model` stickiness

**Status:** Accepted (rev 4 — session-scoped consume-once, #3183; rev 3 keep-by-default and rev 2 revert-by-default are superseded where §0.1 says so)
**Author:** (agent-authored, operator-directed; semantics decided by the operator 2026-07)
**Targets:** `origin/main` @ v0.18.7
**Builds on:** #2982 (in-memory `sessionModelSource` + one-shot `.session-model-override` carrier), #2983 (live model on progress cards), #3178 (durable /model ack/trace/queue)

---

## 0.1 Rev 4 amendment (#3183, operator decision 2026-07-12) — session-scoped, consume-once

The operator requirement (verbatim): *"/model overrides should only last until
that agent is restarted; on restart the agent should default back to switchroom
config."* This **supersedes** the rev-3 §0 keep-by-default contract (and the
rev-2 revert-by-default rows). A `/model` override is now **session-scoped**:
it lives for the current session and any restart drops it back to the
`switchroom.yaml` `model:`.

Mechanism — **consume-once carrier** (no intent file):

- **Live Claude switches write NO carrier.** A typed `/model <claude>` or a
  Claude menu tap applies in-session via claude's native picker; the explicit
  `claude --model <configured>` flag start.sh always execs reverts it on the
  next boot for free. `sessionModelSource.setOverride` still records it live so
  `/status` and progress cards stay truthful for the running session.
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
- **`/effort` is unchanged** — `.session-effort` remains keep-across-restarts
  (rev 3). Whether `/effort` should also become session-scoped is deferred to
  the operator (#3183 open question).
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
