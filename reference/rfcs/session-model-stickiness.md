---
artifact: Session-scoped /model stickiness — a durable session-model override that survives involuntary relaunches and reverts only on deliberate restarts
serves: jobs/steer-or-queue-mid-flight.md
backs: chat-is-the-single-source-of-truth
advances-outcome: hold-the-leash
status: Draft — spec only, no implementation yet
---

# RFC — Session-scoped `/model` stickiness

**Status:** Draft (spec only)
**Author:** (agent-authored, operator-directed; semantics decided by the operator 2026-07)
**Targets:** `origin/main` @ v0.18.7
**Builds on:** #2982 (in-memory `sessionModelSource` + one-shot `.session-model-override` carrier), #2983 (live model on progress cards)

---

## 1. Problem

`start.sh` always launches `claude --model {{modelQ}}` from the cascade-resolved
`switchroom.yaml` `model:` (`profiles/_base/start.sh.hbs`, launch block around
the `_EFFECTIVE_MODEL` resolution). The explicit flag outranks
`settings.json` *and* claude's own `/model` persistence, so a user's confirmed
`/model X` switch survives exactly until the next relaunch — any relaunch.

#2982 papered over one edge with the **one-shot** `.session-model-override`
carrier: the gateway writes the token, gracefully restarts, and start.sh
consumes it with `rm -f` on that single boot. Nothing survives the boot after
that. The original bug remains for every *involuntary* relaunch: a
hang-watchdog kill, a crash, an OOM, a `restart: always` recreation — each
re-runs start.sh with no carrier, and the session silently snaps back to the
configured default mid-work. The user asked for a model; the machine forgot
because the machine hiccuped. That violates *silent resurrection is the bug*
(`jobs/survive-reboots-and-real-life.md`).

## 2. Operator-decided semantics (hard requirements)

1. A **positively-confirmed** `/model X` switch (typed inject, menu tap,
   Claude aliases/ids, and sr-* relaunch paths) becomes a **durable session
   override**: the gateway writes a `.session-model` state file on every
   confirmed switch.
2. `/new` (force-fresh-session restart) and `/clear` (in-session context
   clear) **keep** the override — a fresh *conversation* stays on the selected
   model.
3. A deliberate restart — the `/restart` chat command, hostd `agent_restart`
   (and the `switchroom agent restart` CLI it shells through), a sanctioned
   container restart — **reverts** to the `switchroom.yaml` model.
4. Involuntary relaunches — hang-watchdog kill, gateway bounce, crash resume,
   handoff relaunch — **keep** the override.
5. Changing `model:` in `switchroom.yaml` (or a `switchroom apply` that
   changes the resolved default) **invalidates** the override.
6. `/model default` (exists today: `default` is in `MODEL_ALIASES`,
   `telegram-plugin/gateway/model-command.ts`) explicitly **clears** it.
7. `/status`, the model menu, and progress cards stay truthful across all of
   the above.
8. The existing sr-* + LiteLLM-down drop guard in start.sh is preserved.

## 3. Architecture ground truth (verified, drives the design)

These facts were verified against `origin/main` @ 21478348 and constrain the
detection mechanism in §5:

- **There is no in-container claude relaunch.** PID 1 is tini; the entrypoint
  is start.sh, which ends in `exec claude …` (`docker/Dockerfile.agent`,
  `profiles/_base/start.sh.hbs`). When claude exits — for any reason — the
  container exits and compose's `restart: always` recreates it, re-running
  start.sh. **Every relaunch flavor converges on the same start.sh re-exec.**
- The in-gateway restart primitive is `triggerSelfRestart()` →
  `process.kill(1, 'SIGTERM')` (`telegram-plugin/gateway/gateway.ts`,
  "restart-via-SIGTERM-PID1"). It is used by *both* deliberate paths
  (`/restart`, sr-to-claude model switch) *and* recovery/watchdog paths
  (`schedule-restart-immediate`, `restart-drain-cap-forced`,
  `turn-complete-pending-restart`, `fleet-fallback-resume`). **The hang-
  watchdog kill IS a container bounce** — so "container boot" cannot be the
  deliberate-reset boundary. The task's suspected mismatch is real, and §5
  handles it via intent markers instead.
- Existing intent stamps, written *before* the bounce by the initiating path:
  - `restart-pending.json` (`writeRestartMarker`) — user `/restart` (and
    model-relaunch restarts, for chat routing of the boot card).
  - `telegram/clean-shutdown.json` reason strings —
    `stampUserRestartReason('user: /restart from chat')`,
    `'user: /new from chat'`, `'user: /model … (session-only relaunch)'`,
    `'cli: restart'` / `'cli: deploying …'` (host CLI,
    `src/agents/lifecycle.ts` `writeRestartReasonMarker`, with
    `preserveExisting` so a fresh gateway-stamped user reason wins),
    `'operator: switchroom update'` (`src/cli/update.ts`). But the plain
    SIGTERM handler *also* writes this marker with no user reason on **every**
    SIGTERM — including watchdog kills — so presence/freshness of
    `clean-shutdown.json` alone cannot discriminate either. Only the *reason
    string* carries intent, and it is free-form.
  - `.force-fresh-session` — one-shot, written by `/new`, consumed by
    start.sh (`rm -f`).
- hostd `agent_restart` does not touch agent state itself — it shells through
  `switchroom agent restart <name>` (`src/host-control/server.ts`
  `handleAgentRestart` → `runSwitchroom(["agent","restart",…])`), and the CLI
  writes the `cli:` reason marker. **The host CLI is therefore a single choke
  point for every host-initiated deliberate restart** (operator CLI, hostd MCP
  verb, `/restart` fallback spawn).
- `.active-session-model` — start.sh already records the *effective launched*
  model each boot (overwrite, not consumed); the gateway reads it at boot to
  re-hydrate `sessionModelSource` (gateway.ts ~27840). This RFC keeps it.
- `sessionModelSource` (`telegram-plugin/gateway/session-model-source.ts`) —
  freshness-sequenced transcript-vs-override resolution for `/status`.
  Unchanged by this RFC; only its boot seeding gains a source.

## 4. Design

### 4.1 State file: `.session-model`

Location: `{{agentDir}}/.session-model` (sibling of the existing
`.session-model-override` / `.active-session-model` / `.force-fresh-session`
sentinels; inside the bind-mounted agent state dir so it survives container
recreation and is visible to the host CLI and hostd).

Format — single-line JSON, atomically written (tmp + rename, matching
`clean-shutdown-marker.ts`):

```json
{"model": "sr-x-ai/grok-4", "configuredDefaultAtWrite": "claude-opus-4-8", "ts": 1783948123456}
```

- `model` — the canonical `claude --model` token (alias, `claude-*` id, or
  `sr-*` id), same shape gate as the #2982 carrier (`MODEL_ARG_RE` ↔ the
  start.sh grep). Never a display label (`canonicalClaudeToken` already
  guards this on the menu path).
- `configuredDefaultAtWrite` — the resolved configured default at the moment
  of the switch, for §4.4 invalidation. Sourced from
  `.configured-default-model` (new, §4.2), NOT from the gateway's own config
  read, so both sides of the comparison come from the same resolver
  (`{{modelQ}}`).
- `ts` — wall-clock ms, observability only (boot notice, staleness debugging).
  Deliberately NOT used as a TTL: the override lives until an event in the
  §6 contract table ends it, however long that takes.

**Ownership:** the *gateway* is the only writer/deleter at runtime (confirmed
switches, `/model default`, sr-to-claude transitions). *start.sh* deletes it
on deliberate-reset boot and on invalidation (§4.4) — boot-time consumption is
start.sh's side of the round-trip, same split as `.force-fresh-session`. The
*host CLI* never writes it; it writes only the reset-intent sentinel (§5).

### 4.2 New boot record: `.configured-default-model`

start.sh writes `{{modelQ}}` (the scaffold-resolved configured default) to
`{{agentDir}}/.configured-default-model` on every boot, before override
resolution (overwrite, not consumed — sibling of `.active-session-model`).
The gateway copies this value into `configuredDefaultAtWrite` when writing
`.session-model`. This keeps the invalidation comparison resolver-exact: a
`switchroom apply` that changes the resolved default regenerates start.sh
with a new `{{modelQ}}`, and the *next boot's* comparison (§4.4) catches it
even though the gateway never re-read the cascade.

### 4.3 Write paths (gateway)

`.session-model` is written on every **positively-confirmed** switch — the
exact call sites that today call `sessionModelSource.setOverride(...)`:

1. Typed `/model <claude>` confirmed inject (`reply.selectedModel` set —
   gateway `bot.command('model')` handler).
2. Menu tap confirmed (same confirmation-parse gate; "Kept model as X" is
   excluded per `isKeptModelConfirmation` — nothing changed, nothing stored).
3. `scheduleModelRelaunch` (sr-* switch, typed or menu): write
   `.session-model` at the same point the one-shot carrier is written today.
   The existing rollback branch (dispatch failed, not `restart_in_flight`)
   rolls back `.session-model` to its previous content (or deletes it if
   there was none) exactly as it rolls back the carrier + in-memory override.
4. sr-to-claude restart (`scheduleRestart` from a Claude selection while on
   sr-*): write `.session-model` with the selected Claude token before
   dispatch — the switch must survive its own restart.

Clear paths:

- `/model default` (typed or the menu's "Default (recommended)" row, which
  already resolves to "write no carrier" via `canonicalClaudeToken → null`):
  delete `.session-model`, `sessionModelSource.setOverride(null)`, and — when
  currently on an sr-* session — the existing graceful-restart-to-default
  path proceeds with no file, so boot lands on the configured default.
- Claude's own "saved as your default" confirmation (v2.1.205 arg form):
  this changes the *configured/CLI* default semantics, not the session
  override; no `.session-model` write (matches today's non-override
  handling of that confirmation).

### 4.4 Boot resolution (start.sh)

Replaces the one-shot `.session-model-override` block (migration in §10).
Order of operations after `_LITELLM_OK` probing, before the `exec claude`:

```
_EFFECTIVE_MODEL={{modelQ}}
write .configured-default-model                       # §4.2, every boot
if fresh .model-reset-intent exists:                  # §5 — deliberate reset
    rm -f .model-reset-intent .session-model
    log "session-model: deliberate restart — reverting to configured default"
elif .session-model exists:
    parse JSON (jq not assumed — POSIX grep/sed extraction, shape-gated)
    if unparsable OR model fails MODEL_ARG_RE shape gate:
        rm -f .session-model                          # corrupt → delete, loud log
    elif configuredDefaultAtWrite != {{modelQ}}:
        rm -f .session-model                          # config changed → invalidate
        write .session-model-alert ("configured default changed …
          your session override to <model> was cleared")
    elif model is sr-* AND ! _LITELLM_OK:
        # sr-*+litellm-down guard, KEPT from the carrier logic — but the
        # durable file is NOT deleted: this boot runs the configured
        # default; the override re-applies on the next boot when the
        # proxy is back. Alert sentinel tells the user exactly that.
        write .session-model-alert (proxy down, booted default, override
          retained and will re-apply next relaunch; /model default to drop)
    else:
        _EFFECTIVE_MODEL=<model>                      # KEEP — the normal case
rm -f .model-reset-intent                             # never let a stale intent linger
… existing sr-* passthrough→router repoint on _EFFECTIVE_MODEL …
printf _EFFECTIVE_MODEL > .active-session-model       # unchanged (#2983 feed)
```

Note `.session-model` is **never consumed by a keep-path boot** — that is the
whole point. It is deleted only by: deliberate reset (§5), invalidation,
corruption, or the gateway's explicit clear paths (§4.3).

### 4.5 Truthful surfaces

- **Boot seeding:** the gateway keeps reading `.active-session-model` (the
  effective launched model) as today. Additionally, when `.session-model`
  exists and its `model` matches the launched model, seed
  `sessionModelSource.setOverride(model)` so `/status` shows the *override*
  provenance ("session override, sticky") rather than bare transcript state.
  When `.session-model` exists but the launched model is the default (the
  sr-*+proxy-down degraded boot), do NOT seed the override — `/status` must
  show the default as live, with the retained-override note below.
- **/status + model menu:** when a sticky override is active, the session
  line reads e.g. `Model: sr-x-ai/grok-4 (session override — sticky until
  /restart or /model default)`. In the degraded-retained state: `Model:
  claude-opus-4-8 (default; retained override sr-x-ai/grok-4 will re-apply
  on next relaunch — LiteLLM was down at boot)`.
- **Boot notice:** the `.session-model-alert` sentinel → Telegram message
  mechanism from #2982 is reused verbatim for the invalidation and
  proxy-down cases. Additionally, any boot that *kept* an override appends a
  one-line note to the boot card ("Model: session override `<model>` kept
  across restart") so an involuntary bounce never silently continues on a
  non-default model.
- **Progress cards (#2983)** already read the live model via
  `sessionModelSource` — truthful for free once boot seeding is right.
- **User-facing copy change:** the `/model` reply footers currently promise
  "_Session-only — reverts to the configured default on the next restart._"
  These must be rewritten: "_Sticky for this session — survives crashes and
  fresh conversations; reverts on `/restart` or `/model default`._"

## 5. Deliberate vs involuntary: the reset-intent sentinel

**Chosen mechanism: an explicit one-shot `.model-reset-intent` sentinel,
written only by the paths whose semantics are "revert the model", consumed
(`rm -f`) by the next start.sh boot.** Default is KEEP: a boot with no fresh
sentinel keeps the override.

Why not the alternatives (evidence in §3):

- *"Container boot deletes the file"* — unsound. Watchdog kills, crash
  resumes, and gateway-initiated recovery restarts ALL bounce the container;
  there is no in-container relaunch to distinguish from (verified: `exec
  claude` under tini, `restart: always`, `triggerSelfRestart` = SIGTERM PID 1).
- *Keying on `clean-shutdown.json` presence/class* — unsound. The gateway's
  SIGTERM handler writes it on every SIGTERM, including watchdog kills;
  `determineRestartReason`'s `graceful` class covers both deliberate and
  recovery bounces.
- *Parsing `clean-shutdown.json` reason strings* — workable but fragile:
  free-form strings, `preserveExisting` 30s races, 60s/5min freshness windows
  tuned for boot-card cosmetics, and every new restart path would silently
  default to the wrong side. An explicit sentinel makes intent a first-class
  bit with a single meaning.

The sentinel mirrors the proven `.force-fresh-session` gateway↔start.sh
round-trip (one-shot marker, consumed on the next boot, freshness-bounded).

### 5.1 Writers

| Path | Writer | Notes |
|---|---|---|
| `/restart` chat command (self and `all`) | gateway, in the `/restart` handler, alongside `stampUserRestartReason` and before hostd dispatch | |
| Inline restart button (`inline-button-restart`) | gateway, same handler family | operator-deliberate |
| `switchroom agent restart <name>` CLI | host CLI (`src/cli/agent.ts`, alongside `writeRestartReasonMarker`) — **this covers hostd `agent_restart`**, which shells through the CLI (§3) | see guard below |
| `switchroom agent stop` → `start` | host CLI `start` path | a stop/start is deliberate |
| `switchroom update` / `apply` restarts | not needed for correctness — if the resolved default changed, §4.4 invalidation clears the override anyway; if it didn't change, the operator's intent was "deploy", not "reset my model". **Decision: update/apply does NOT write reset-intent** (keep). Flagged as open question §11.1. |

**Keep-path guard at the CLI choke point:** `/new` and `/model <sr-*>`
relaunches ALSO dispatch hostd `agent_restart` → the same CLI. The CLI must
not stomp them. Rule: the CLI skips writing `.model-reset-intent` when a
**fresh (<60s) keep marker** exists — `.force-fresh-session` (written by
`/new` before dispatch) or `.session-model-override`-successor write, i.e. a
fresh `.model-keep-intent` stamped by the gateway's model-relaunch and `/new`
paths immediately before their hostd dispatch. To keep the rule simple and
not multiply sentinels, the spec standardizes on `.model-keep-intent`
`{ts, reason}` written by exactly those two gateway paths; `.force-fresh-
session` remains purely the fresh-session carrier. Freshness 60s matches the
restart debounce (15s) with headroom, same reasoning as
`PLANNED_RESTART_FRESHNESS_MS`.

### 5.2 Consumption + race safety

- start.sh consumes `.model-reset-intent` at most once (`rm -f` in the reset
  branch AND unconditionally after resolution, §4.4) — a stale sentinel from
  a crashed deliberate restart cannot revert a *later* involuntary bounce
  beyond the very next boot, which is the boot the operator asked for anyway.
- Freshness gate on read: a sentinel older than 10 minutes is ignored (and
  deleted) — covers "CLI wrote intent, container never actually restarted"
  (e.g. docker daemon down); an hours-later crash must not consume it.
- The keep-intent guard runs on the host CLI side *before* it writes reset
  intent; both writes are tmp+rename atomic. The 15s in-gateway restart
  debounce already serializes competing same-agent restarts, so the
  keep/reset decision is not meaningfully concurrent in practice; the
  freshness windows bound the damage if it ever is (worst case: one restart
  lands on the wrong side of the table, self-corrects on the next event —
  never a wedged state).

### 5.3 The honest gap

A **raw `docker restart switchroom-<agent>`** (or `docker stop`/`start`,
host reboot, dockerd restart) is indistinguishable from a crash from inside
the container: no sanctioned path runs, no sentinel is written, the SIGTERM
handler's marker is reason-less. Under this spec those boots **keep** the
override. The operator semantics say "container restart reverts" — this spec
interprets that as *sanctioned* container restarts (chat `/restart`, hostd,
CLI), which all do revert. The raw-docker gap is documented behavior, not a
silent surprise: the boot card's "override kept across restart" line (§4.5)
names it every time, and `/model default` / `/restart` are the escape
hatches. Flagged in §11.2 for operator sign-off.

## 6. Contract table (event → override)

| # | Event | Override | Mechanism |
|---|---|---|---|
| 1 | Confirmed `/model X` (typed, Claude) | **written** | gateway writes `.session-model` on confirmed inject |
| 2 | Confirmed `/model X` (menu, Claude) | **written** | same, menu callback path |
| 3 | `/model <sr-*>` (typed or menu, relaunch) | **written** | `scheduleModelRelaunch` writes file + keep-intent; boot applies |
| 4 | sr-* → Claude switch (restart path) | **written** (new model) | `scheduleRestart` path writes file + keep-intent |
| 5 | Unconfirmed / failed / "Kept model as X" switch | unchanged | no write without positive confirmation |
| 6 | `/clear` (in-session context clear) | **kept** | no relaunch at all; claude session process unchanged |
| 7 | `/new` (force-fresh-session restart) | **kept** | gateway writes `.model-keep-intent`; CLI skips reset-intent; boot keeps |
| 8 | `/restart` chat command | **reverted** | gateway writes `.model-reset-intent`; boot consumes + deletes file |
| 9 | hostd `agent_restart` (admin agent MCP) | **reverted** | shells through CLI → CLI writes reset-intent (no fresh keep-intent) |
| 10 | `switchroom agent restart` / `stop`+`start` (host CLI) | **reverted** | CLI writes reset-intent |
| 11 | Hang-watchdog kill (SIGTERM PID 1, recovery) | **kept** | no reset-intent written → boot keeps |
| 12 | Crash / OOM / `restart: always` recreation | **kept** | no reset-intent → boot keeps |
| 13 | Gateway bounce / handoff relaunch / resume_interrupted | **kept** | no reset-intent → boot keeps |
| 14 | Raw `docker restart` / host reboot / dockerd restart | **kept** (documented gap, §5.3) | indistinguishable from crash; boot card names it |
| 15 | `switchroom update` / `apply`, resolved default unchanged | **kept** (§11.1) | no reset-intent from update path |
| 16 | `switchroom apply` / yaml edit changing resolved `model:` | **invalidated** | `configuredDefaultAtWrite != {{modelQ}}` at next boot → delete + alert |
| 17 | `/model default` (typed or menu Default row) | **cleared** | gateway deletes `.session-model`, clears in-memory override |
| 18 | sr-* override + LiteLLM unreachable at boot | **retained, not applied this boot** | boot runs default, keeps file, alert sentinel (§4.4) |
| 19 | Corrupt / malformed `.session-model` | **deleted** | shape-gate fail → rm + loud log, boot default |
| 20 | Stale `.model-reset-intent` (>10 min) | **kept** | freshness gate ignores + deletes the sentinel |

## 7. Failure modes

- **Corrupt file** (row 19): parse or shape-gate failure → delete, boot the
  configured default, loud stderr log. Never launch `claude --model` with an
  unvalidated string (shell-injection surface is already closed by the
  MODEL_ARG_RE grep; keep it byte-identical to the gateway regex).
- **Stale override lingering:** no TTL by design — but three bounded exits
  exist (deliberate restart, invalidation, `/model default`), and every boot
  that keeps it says so on the boot card, so it can never linger *silently*.
- **Reset-intent written, restart never happens:** 10-min freshness gate +
  unconditional post-resolution `rm -f` (§5.2).
- **Keep-intent written, hostd dispatch fails:** the existing
  `scheduleModelRelaunch` rollback also deletes `.model-keep-intent`; a
  leftover keep-intent is harmless anyway (it only suppresses reset-intent
  for 60s).
- **Gateway crashes between `.session-model` write and restart dispatch**
  (sr-* path): the file exists, no restart comes; the *next* relaunch of any
  kind applies it. Acceptable: the switch was positively initiated, and
  /status shows the pending state via the in-memory override until then.
- **Two agents / wrong dir:** all paths resolve `{{agentDir}}` /
  `resolveAgentDirFromEnv()` exactly as the #2982 carrier does; no new
  cross-agent surface.

## 8. Observability

- `/status` + model menu wording per §4.5 (sticky vs default vs
  retained-degraded — three distinct, truthful states).
- Boot card line whenever an override is kept: `Model: session override
  \`<model>\` kept (set <relative-ts>; /model default to clear)`.
- `.session-model-alert` → Telegram message on: invalidation by config
  change; sr-*+proxy-down retained-degraded boot (reworded from #2982's
  "dropped" to "retained, re-applies next relaunch").
- stderr breadcrumbs in start.sh for every branch of §4.4 (grep-able
  `session-model:` prefix, as today).

## 9. Test plan

**Unit (vitest / bun per repo boundary rules):**

- `session-model-file.test.ts` (new, pure): serialize/parse round-trip;
  corrupt JSON → null; shape-gate parity with `MODEL_ARG_RE` (share the
  regex source, test both sides against one fixture list).
- `tests/scaffold.session-model.test.ts` (successor to
  `scaffold.session-model-override.test.ts`): rendered start.sh contains the
  §4.4 branch structure; `{{modelQ}}` comparison literal matches
  `.configured-default-model` write; one-shot `rm -f` of
  `.model-reset-intent` both in-branch and post-resolution.
- start.sh behavioral harness (sh-level, pattern of the existing scaffold
  tests): each row of the §6 table that resolves at boot (rows 8–20) as a
  fixture — given {files on disk, `_LITELLM_OK`} assert `_EFFECTIVE_MODEL`,
  surviving files, and alert-sentinel content.
- Gateway: `model-command` deps tests — confirmed switch writes file with
  `configuredDefaultAtWrite` from `.configured-default-model`; "Kept model
  as" writes nothing; `/model default` deletes; `scheduleModelRelaunch`
  rollback restores prior file content; keep-intent stamped on `/new` and
  relaunch dispatch paths (extend
  `telegram-plugin/tests/gateway-session-model-relaunch.test.ts`).
- CLI: `agent restart` writes reset-intent; skips when fresh keep-intent;
  freshness boundary cases.
- Boot seeding: `.session-model` present + matching `.active-session-model`
  → override seeded; degraded case → not seeded.

**UAT (live scenarios, one per outcome-bearing contract row):**

- `/model sonnet` → watchdog-killable hang → verify post-bounce `/status`
  still shows sonnet override (rows 1, 11) — this is the original bug's
  regression test.
- `/model <sr-*>` → `/new` → verify fresh conversation still on sr-* (7).
- `/model sonnet` → `/restart` → verify default restored + boot card says so
  (8).
- Admin agent hostd `agent_restart` → default restored (9).
- Edit `model:` in yaml + restart → override invalidated with alert (16).
- `/model default` on an sr-* session → graceful restart to default, file
  gone (17).
- LiteLLM stopped + container bounce with sr-* override → boots default,
  alert says retained, restart LiteLLM + bounce → sr-* re-applies (18).

## 10. Rollout / migration from the one-shot carrier

1. **PR 1 (scaffold + gateway, one release):** start.sh gains the §4.4 block
   and *keeps* reading a leftover `.session-model-override` for exactly one
   boot (consume-and-convert: if present and `.session-model` absent, treat
   its token as a just-confirmed switch — write `.session-model` from it,
   then `rm -f` as today). This makes the upgrade seamless for an agent that
   was mid-switch when the fleet updated. Gateway stops writing the old
   carrier and writes `.session-model` (+ keep-intent) instead.
2. **PR 2 (CLI + hostd path):** reset-intent writer in `src/cli/agent.ts`
   with the keep-intent guard; boot-card + `/status` wording; UAT scenarios.
3. **Cleanup (next release):** delete the consume-and-convert shim and the
   old carrier references; retire `scaffold.session-model-override.test.ts`
   in favor of the successor suite.
4. No data migration: absence of `.session-model` is the well-defined default
   state everywhere.

Compose/scaffold note: new sentinels live in the already-mounted agent dir —
no compose regeneration needed; a normal `switchroom update` (which restarts
agents with regenerated start.sh) suffices.

## 11. Open questions

1. **§5.1 update/apply row (15):** this spec keeps the override across a
   deploy when the resolved default didn't change. If the operator intended
   *every* sanctioned restart — including deploys — to revert, add a
   reset-intent write to `src/cli/update.ts` next to the
   `operator: switchroom update` marker stamp. One-line change; needs an
   operator call.
2. **§5.3 raw-docker gap (row 14):** keep-by-default with a boot-card notice
   is the honest option available from inside the container. If revert is
   required even here, the only sound lever is host-side (a dockerd event
   listener or wrapper), which this spec considers out of proportion.
3. Should `/model default` on a *Claude* override also inject claude's own
   `/model default` (so the CLI's saved default realigns), or only clear the
   file + in-memory state? Current behavior injects; spec assumes keep that.

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
