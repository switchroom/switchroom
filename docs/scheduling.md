# Scheduled Tasks

Switchroom runs scheduled tasks via an **in-container scheduler sibling** that lives inside every agent container alongside the gateway. At fire time the sibling injects a synthesized inbound turn into the agent's running session — so cron-triggered work appears in the agent's transcript and Hindsight context as ordinary turns tagged `<channel source="cron">`, not as out-of-band one-shot processes. Surviving host reboots is handled by docker's restart policy plus an at-least-once boot replay (see below).

## Two ways to schedule

### 1. Operator-declared (central config)

Declare schedules in `switchroom.yaml`. They cascade like every other config key (see [Cascade behavior](#cascade-behavior)):

```yaml
defaults:
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Morning briefing: today's calendar, top priorities, and blockers"
    - cron: "0 20 * * 0"
      prompt: "Weekly review: summarize this week's progress and next week's goals"
```

Run `switchroom agent create <name>` or `switchroom agent reconcile <name>` to materialize the schedule. The in-container scheduler **hot-reloads** the change within ~30s — no restart needed (see "no restart required" below).

### 2. Conversational / per-agent overlay (no YAML edit)

You don't have to hand-edit the central config. The `schedule` verb writes a per-agent **overlay** under `~/.switchroom/agents/<agent>/schedule.d/<slug>.yaml`, which is appended to the agent's resolved schedule:

```bash
# Add (defaults to $SWITCHROOM_AGENT_NAME inside a container; --agent on the host)
switchroom schedule add \
  --cron "0 8 * * 1-5" \
  --prompt "Morning briefing: calendar, priorities, blockers" \
  --name morning-briefing

# Remove (by name, or by the 12-hex content hash shown in schedule.d/cron-<hash>.yaml)
switchroom schedule remove --name morning-briefing
switchroom schedule remove --cron-hash 1a2b3c4d5e6f

# Read the agent's resolved schedule as JSON
switchroom cron list

# Health-check the schedule (duplicate crons, name conflicts) as JSON
switchroom cron doctor
```

This same surface is exposed over the **agent-config MCP broker**, so an agent can manage *its own* schedule when you ask it in chat ("set up a daily 8am briefing"). Identity is pinned to `$SWITCHROOM_AGENT_NAME`; cross-agent writes are denied (exit 7). Run `switchroom schedule --help` for the full flag list.

**`cron list` is self-describing.** Each entry carries, alongside its original fields: `source` (`base-config` for a `switchroom.yaml` entry, `overlay` for a `schedule.d/` one), `file` (the on-disk path), the resolved `tier`/`context` (which session a fire takes — see "Controlling per-fire cost" below), and a `duplicate_of` back-reference naming any *other* entry that shares the same cron expression. The agent can read where each cron lives and whether it owns a duplicate, instead of inferring it from prose. `cron doctor` (and the `cron_doctor` MCP tool) returns the same findings as a `{healthy, findings[]}` report — duplicate cron expressions (the double-fire hazard), base-vs-overlay name conflicts, and entries whose tier can't be resolved.

Either way, a schedule change takes effect **automatically, without a restart**. The in-container scheduler **hot-reloads**: it re-reads `switchroom.yaml` + the `schedule.d` overlay on a short poll (default 30s, `SWITCHROOM_SCHEDULER_RELOAD_POLL_MS`) and, when the effective schedule changes, swaps the live cron timers in place — the tmux/agent session is untouched. So a removed entry stops firing and a new one starts within ~30s. An agent that authors its *first* cron (previously schedule-less) restarts its own scheduler sibling once to activate (a clean ~1s self-restart, no container bounce). A restart is no longer required for schedule edits to take effect.

Hot-reload is on by default; set `SWITCHROOM_SCHEDULER_HOT_RELOAD=0` to freeze the schedule at boot (the pre-reload behaviour). A schedule edit that doesn't take effect within a minute is the signal to check `SWITCHROOM_SCHEDULER_HOT_RELOAD` and the `agent-scheduler.log` for a `reload skipped (config error…)` line (an overlay file caught mid-write keeps the current schedule and retries next tick).

### Release-triggered fleet restart (opt-in, #1743)

Plugin / gateway fixes that ship via a `:latest` retag don't change the agent container's image digest, so `docker compose up -d --remove-orphans` is a no-op and the running `bun` process keeps the pre-fix code in memory until an unrelated restart cycles it. To close that lag, the hostd daemon can poll the remote release tag and roll the fleet automatically.

Enable in `switchroom.yaml`:

```yaml
host_control:
  auto_release_check:
    enabled: true
    interval_minutes: 5            # floor 5, ceiling 1440
    apply_on_detect: true          # false → log-only (dogfood mode)
    notify_on_detect: false        # KEN-129 — operator approval card, see below
    image_ref: ghcr.io/switchroom/switchroom-agent:latest
```

When `enabled: true`, hostd polls `docker manifest inspect <image_ref>` every `interval_minutes`. If the remote digest diverges from the local image's `RepoDigests`, it runs `switchroom update` then `switchroom restart all` (graceful — drains in-flight Telegram turns via the existing `decideRestart` path). Events land at `~/.switchroom/release-watcher-events.jsonl` (`release_detected` → `apply_started/succeeded/failed` → `restart_started` → `fleet_caught_up`), with `duration_ms` on `fleet_caught_up` giving the AC's `time_from_release_to_fleet_caught_up_seconds` counter. Failures log and drop the tick — no retry-storm.

Default is `enabled: false` so existing deployments don't suddenly self-roll. Pair with `apply_on_detect: false` to dogfood the detector without rolling the fleet.

### Operator-in-the-loop update card (KEN-129, stage 1 of KEN-128)

With `apply_on_detect: false` and `notify_on_detect: true`, a detected release doesn't roll the fleet — instead hostd posts **one operator approval card** ("⬆️ Switchroom update available — fleet is behind", with the `switchroom update --check` plan in the body) through an admin agent's Telegram gateway. Tapping ✅ Approve starts the standard hostd `update_apply` path (fleet-mutation-locked, durable status rows, `get_status`-pollable, in-chat rollout narration). Deny / timeout simply dismisses the card.

Guarantees: **one card per release id** — the last-notified digest persists at `~/.switchroom/release-notify-state.json`, so restarts and repeat ticks never re-card the same release (a card that failed to *reach* the operator is retried next tick); no card posts while a fleet mutation is already in flight; no card when the fleet is current.

## Guardrails on agent-authored entries

Operator-authored entries in `switchroom.yaml` are trusted. Entries written through the `schedule add` / MCP path are gated (structured error code → exit code):

| Gate | Code | Rule |
|---|---|---|
| Too frequent | `E_CRON_TOO_FREQUENT` (9) | minimum 5-minute interval |
| Duplicate | `E_CRON_DUPLICATE` (9) | the agent already owns an overlay entry with the same cron expression or the same `--name` — prevents the silent double-fire |
| Too many | `E_QUOTA_EXCEEDED` (9) | at most 20 entries per agent |
| Secrets escalation | `E_OVERLAY_SECRETS_REQUIRES_APPROVAL` (9) | an overlay entry may **not** grant itself vault `secrets:` |
| Bad input | `E_INVALID_CRON` / `E_INVALID_PROMPT` (1) | malformed cron or prompt |

With `--stage-on-reject` (the MCP path uses this), a *security*-gated entry (`E_OVERLAY_SECRETS_REQUIRES_APPROVAL`, `E_CRON_TOO_FREQUENT`, `E_QUOTA_EXCEEDED`) is staged under `.pending/` and surfaced to the operator via `switchroom schedule pending` instead of being rejected outright. `E_CRON_DUPLICATE` is a *fix-it* error, not an approval gate — it hard-rejects on both paths so the agent removes the conflicting entry rather than queuing a second one for approval. Overlay entries can only *append*; they cannot override or replace operator-declared entries.

## How it works

Each agent's container runs a small `agent-scheduler` sidecar (started by `start.sh` as a sibling of the telegram-plugin gateway). The sidecar:

1. Reads its own agent's cascade-resolved `schedule:` (central config + `schedule.d/` overlays) from `/state/config/switchroom.yaml`.
2. Registers each `cron:` expression with `node-cron`.
3. On fire, synthesizes an `InboundMessage` tagged `meta.source="cron"`, `meta.schedule_index`, `meta.prompt_key`.
4. Sends an `inject_inbound` IPC message to the gateway socket in the same container; the gateway forwards it to the bridge, which delivers it to the agent's running claude session.
5. Audits each fire to `/state/agent/scheduler.jsonl` (one row per fire, append-only).

The scheduler itself never reads secrets — the agent resolves any vault refs the prompt needs via the broker socket once the turn starts.

### Timezone

Cron expressions are evaluated in the **agent's resolved timezone**, not hard-coded UTC. The container's `TZ` is set from a four-step cascade (`src/config/timezone.ts`):

1. `agents.<name>.timezone` (explicit per-agent override)
2. profile `timezone` (via `extends:`)
3. `switchroom.timezone` (global default)
4. server detection (`/etc/timezone` → `/etc/localtime` → `UTC` fallback)

So `0 8 * * *` means 08:00 in that resolved zone. If you've set `switchroom.timezone: "Australia/Melbourne"`, the morning briefing fires at 08:00 Melbourne time. If nothing is set and the server can't be detected, the fallback is UTC — set `switchroom.timezone` explicitly if your host clock isn't where your users are. `switchroom cron list` and the agent's session-time hint both reflect the resolved zone. There is currently no per-entry timezone field.

### At-least-once replay

When an agent container restarts (image pull, OOM bounce, host reboot), any cron fires that would have happened during the downtime are replayed on boot — bounded to the past 30 minutes by default (`SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN`). The scheduler reads its JSONL audit log, finds the most-recent past minute each cron expression matched, and replays any minute with no successful audit row within ±90 s.

This is *at-least-once*, not *exactly-once* — a fire started but interrupted before audit-write may replay. The window is intentionally small so a long outage doesn't resurrect yesterday's morning briefing.

### Skipped-run notice (downtime longer than the replay window)

If the agent was offline long enough that a scheduled run fell **outside** the replay window, that run is *not* re-run (cron is not a queue). Rather than dropping it silently, on boot the scheduler sends **one summary turn** naming every schedule that had a skipped run:

> [switchroom scheduler notice] While this agent was offline, the following scheduled task(s) had at least one run skipped. They were older than the 30-minute catch-up window, so they will NOT be re-run: …

The agent relays this to the user in plain language. This satisfies the *survive-reboots* contract: scheduled jobs are *fired on return or explicitly skipped, never silently dropped*. The notice is de-duplicated — once delivered, a per-entry sentinel row in `scheduler.jsonl` stops it re-firing on subsequent boots. If the gateway isn't connected at boot, the notice is retried next boot rather than swallowed. The lookback ceiling for this scan is 14 days (`SWITCHROOM_AGENT_SCHEDULER_STALE_MAX_MIN`); an agent down longer than that gets one notice, not a backlog.

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `cron` | Yes | — | Standard 5-field cron expression, evaluated in the agent's resolved timezone |
| `prompt` | Yes | — | The prompt that becomes the synthesized turn's text |
| `model` | No | — | **Deprecated / ignored.** Pre-v0.8 the singleton scheduler ran each task as an isolated `claude -p` and could set `--model` per task. Post cron-fold-in the fire runs in the agent's existing session, so it always uses the **agent's** configured model. Accepted only so old configs keep validating; set the model at the agent level. |
| `secrets` | No | `[]` | Vault keys this task may read. Operator-config only — rejected on agent-authored overlays. See [configuration.md#vault-broker-linux-only](configuration.md#vault-broker-linux-only) |
| `topic` | No | agent's `default_topic_id` | **Supergroup-owned agents only.** The forum topic this cron fires into — a string alias resolved against `channels.telegram.topic_aliases`, or a raw numeric `message_thread_id`. Falls back to `default_topic_id` (General) when unset. Ignored for `fleet-shared` / `dm_only` agents. See [Targeting a forum topic](#targeting-a-forum-topic-supergroup-owned-agents). |

### Cron expression examples

| Expression | Meaning (in the agent's resolved timezone) |
|---|---|
| `0 8 * * *` | Every day at 8:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `0 20 * * 0` | Sundays at 8:00 PM |
| `0 9,17 * * *` | 9:00 AM and 5:00 PM daily |
| `0 */3 * * *` | Every 3 hours |

### Targeting a forum topic (supergroup-owned agents)

When an agent owns a Telegram supergroup (`channels.telegram.chat_id` is
set — the [supergroup-owned topology](../reference/rfcs/supergroup-easy-defaults.md)),
each schedule entry can choose **which forum topic** it posts into via the
per-entry `topic:` field. Without it, cron output lands in the agent's
`default_topic_id` (General, topic `1`).

Name your topics once under `channels.telegram.topic_aliases` (a
map of `alias → numeric thread_id`), then reference them by alias from any
cron entry. Aliases are resolved at config load, so a typo fails
`switchroom apply` immediately rather than silently mis-routing at fire
time. You can also pass a raw numeric `message_thread_id` instead of an
alias.

```yaml
agents:
  marko:
    channels:
      telegram:
        chat_id: "-1001234567890"      # the supergroup this agent posts into
        default_topic_id: 1            # General — where untargeted crons land
        topic_aliases:
          meta: 3                      # "Meta Campaigns"
          crm: 4                       # "CRM (Brevo)"
    schedule:
      - cron: "0 8 * * 1-5"
        prompt: "Morning Meta campaign pacing check — flag any ad set off target."
        topic: meta                    # alias → posts into the Meta Campaigns topic
      - cron: "0 9 * * 1"
        prompt: "Weekly CRM digest: new Brevo contacts and list growth."
        topic: crm                     # alias → CRM (Brevo)
      - cron: "30 17 * * 5"
        prompt: "Wrap-up: anything for next week?"
        topic: 7                       # a raw thread_id also works
      - cron: "0 7 * * *"
        prompt: "Daily standup."
        # no topic → lands in General (default_topic_id)
```

**Finding a topic's `thread_id`:** open the topic in Telegram and the
`message_thread_id` is the trailing number in a message link
(`t.me/c/<chat>/<thread_id>/<msg>`), or read it from an inbound message
the agent has already received in that topic. The topic the operator calls
"General" is always thread `1`.

Resolution precedence (highest first): per-entry numeric `topic:` →
per-entry alias `topic:` (looked up in `topic_aliases`) → the agent's
`default_topic_id`. An unknown alias defends to `default_topic_id` at fire
time, but config-load validation should reject it before then.

## How cron tasks deliver to Telegram

Because cron fires arrive as ordinary inbound turns in the running session, the agent's normal reply path runs — `mcp__switchroom-telegram__reply` writes to the chat the same way it does for a user-typed message. Markdown→HTML conversion, smart chunking, and sanitization are identical. If the agent decides the prompt has nothing meaningful to say, no reply is sent — a silent run is correct behaviour, not an error.

This replaces the pre-v0.8 flow (singleton `switchroom-cron` container running `docker exec agent-<name> claude -p ...`), which created a fresh isolated process per fire with no awareness of the running session.

## Cascade behavior

Schedule entries are **concatenated** across cascade layers (defaults first, then profile, then agent, then `schedule.d/` overlays last):

```yaml
defaults:
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Global morning briefing"

agents:
  coach:
    schedule:
      - cron: "0 7 * * *"
        prompt: "Daily check-in: sleep, energy"
```

The coach agent gets BOTH schedules: the global 8 AM briefing AND its own 7 AM check-in.

## Cron fires and the agent session

Pre-v0.8, scheduled tasks ran as **isolated** one-shot `claude -p` calls — no session, no transcript, no memory. Post-fold-in, fires arrive in the running session, so:

- The fire **does** consume context in the agent's conversation (it's just another turn).
- The fire **sees** the agent's recent conversation history and Hindsight memories.
- The fire **uses** the agent's configured model (`model:` is no longer per-task — see Configuration).
- The fire is **rendered** in the transcript as a `<channel source="cron">` turn so the agent (and operator) can tell it apart from human messages.

Trade-off: scheduled tasks now share session context (better for "remember what we discussed yesterday morning" follow-ups), at the cost of cron fires consuming token budget. For agents that need pure isolation (e.g. an audit role), a separate agent dedicated to scheduled tasks is the cleanest pattern.

If the agent is down at fire time, the in-container sidecar can't deliver — the boot-time replay window catches up to 30 minutes; anything older is explicitly reported via the [skipped-run notice](#skipped-run-notice-downtime-longer-than-the-replay-window), not silently dropped.

### Controlling per-fire cost (tiers)

A cron pays for a model only when the model earns it. By default a **frequent** cron (≤60min) auto-routes to a cheap Tier-1 session and a **daily/weekly** cron runs a full Tier-2 turn (see "Automatic Tier-1 routing" below); entries (and `schedule_add`) can also set explicit tier hints. The whole system is on by default — `SWITCHROOM_CHEAP_CRON=0` is the master kill-switch (see `reference/rfcs/cheap-cron-sessions.md`):

| You want… | Use | Cost |
|---|---|---|
| The fire to act *as the agent* (persona, accumulated chat context) | `context: agent` (or just a daily/weekly cadence) — **Tier 2** | full live-session turn |
| Light, self-contained work (summarise/format) — no live-session context needed | `model: sonnet` / `context: fresh`, **or any frequent (≤60min) cron by default** — **Tier 1** | a fresh minimal-context cheap session (still shares memory + tools) |
| "Only do something when X changes" (a webpage/API) | `kind: poll` (operator-set; egress-gated) — **Tier 0** | model-free check; a model fire only on a *hit* |
| "Do this exact mechanical thing on a schedule" (post a fixed message, ping a webhook) | `kind: action` (operator-set) — **Tier 0** | model-free; the action *completes* the work — **no model at all** |
| "Do something when a message is reacted to" | **`reaction_dispatch`** (event-driven, #2291) — not a cron at all | zero polling; the reaction wakes the agent |

Agents can self-author the `model`/`context` hints (no security gate). `kind: poll`, `kind: action`, and `reaction_dispatch` need an operator config commit (egress / identity gates), so an agent should *request* them. **The `SWITCHROOM_CHEAP_CRON=0` master kill-switch** disables the whole cheap-cron machinery: every `model`/`context` hint goes inert and each `prompt`/`poll` cron runs as a full Tier-2 turn (a `kind: poll` fires its escalation prompt directly — disabling cheap-cron can never silently *drop* a prompt/poll cron). `kind: action` and `kind: poll` are model-free by **routing** in every state — they never escalate to a model fire — but they execute through the cheap-cron machinery, so with the master kill-switch off a `kind: action` is **skipped** (audited `exit -4`), not run (there is no model turn to fall back to). In the default state (cheap-cron on) actions fire normally.

**Automatic Tier-1 routing (DEFAULT ON since v0.15.17, #2307).** A **hint-less** cron whose cadence is **frequent** (≤ 60 min, tunable via `SWITCHROOM_CRON_FREQUENT_GAP_MIN`) is auto-routed to the cheap Tier-1 session — you don't set `context: fresh` by hand for routine checks. Daily/weekly crons, and any cron whose cadence can't be read, stay on the full session; explicit `kind`/`context`/`model` hints always win, so a cron that genuinely needs the full session just sets `context: agent`. `SWITCHROOM_CRON_AUTO_TIER=0` (or `false`/`off`) is the **safety kill-switch** — set it (on the host for `apply` + in `defaults.env` for the containers) to revert the whole fleet to full Tier-2 turns. Watch it via `switchroom doctor` → the *Cron Session* section and the `cron_fell_back_to_main` metric. Graceful fallback means it never drops a cron — a fire with no cron bridge just runs on the main session.

#### `kind: action` — model-free mechanical verbs (#2307)

An action *replaces* a model turn with a deterministic verb. Two types (operator-config only — an agent cannot self-author one):

```yaml
schedule:
  # Post a fixed message into the agent's own chat every morning. No model.
  - cron: "0 8 * * *"
    kind: action
    action:
      type: telegram-message
      text: "Morning — heartbeat {{date}} ✅"   # {{date}}/{{time}}/{{agent}} only; NO secrets
  # Ping a status webhook hourly. Same egress fence as a poll.
  - cron: "0 * * * *"
    kind: action
    action:
      type: webhook
      url: "https://hooks.example.com/heartbeat"   # host must be in cron.egress.allowed_hosts
      method: POST
      secrets: ["status_token"]                     # host-pinned via cron.egress.secret_bindings
      headers: { authorization: "Bearer {{status_token}}" }
```

The action `text` is rendered as full GFM markdown (`**bold**`, `_italic_`, `` `code` ``, `~~strikethrough~~`, links) — so a literal `*` or `_` in fixed text becomes formatting unless you set `parse_mode: text`, which sends the string verbatim (the escape hatch).

`telegram-message` posts only to the agent's **own** chat (no `chat_id` field — fenced by construction) and substitutes only the deterministic `{{date}}`/`{{time}}`/`{{agent}}` placeholders — **no vault secrets in a message body, no model output**. `webhook` reuses the poll egress allowlist + host-pinned secret bindings. Anything that needs the model to *write* something (a summary, a Linear issue body) is not an action — use `kind: poll` + an escalation prompt, or `reaction_dispatch`.

## Managing the scheduler

```bash
# List the agent's resolved schedule as JSON
switchroom cron list --agent <name>

# Tail the agent's scheduler audit log (which task fired when, and skip notices)
tail -f ~/.switchroom/agents/<name>/scheduler.jsonl

# Tail the agent-scheduler supervisor's stderr/stdout
docker logs -f switchroom-<name>  # the agent-scheduler line is prefixed "agent-scheduler:"

# Restart the in-container scheduler (after editing switchroom.yaml + reconciling,
# or after a `schedule add`/`remove`)
switchroom agent restart <name>

# Disable in-agent scheduling on a single container without removing the schedule
docker compose -p switchroom \
  -f ~/.switchroom/compose/docker-compose.yml \
  exec --env SWITCHROOM_INLINE_SCHEDULER=0 agent-<name> sh
```

## Weekly skill-synthesis (one-tap self-improvement, #2670)

A recommended weekly schedule entry lets an agent review what it has done
repeatedly and **propose** (never auto-create) a personal-skill improvement,
which surfaces as a one-tap Telegram Approve/Dismiss card:

```yaml
- cron: "0 9 * * 1"        # Mondays 09:00 (agent timezone)
  name: skill-synthesis
  context: agent            # full live session (Tier 2)
  prompt: |
    <see reference/prompts/skill-synthesis-cron.md for the full prompt>
```

The prompt drafts at most one candidate and runs
`switchroom self-improve propose-skill` to post the card. The synthesis
prompt **forbids copying any PII/secrets** from conversation history into the
skill body (the chosen PII approach — a prompt instruction, not a separate
scanner). On Approve, the gateway injects a `skill_proposal_apply` turn and
the agent writes the stored draft through the personal-skill pipeline, so the
merged `scanBundleForSecrets` gate runs and the 20-skill cap is enforced. On
Dismiss, a rejection fingerprint suppresses the same proposal for 90 days so
it isn't re-proposed every week. Approval is **T2 one-tap** (a synthesized
personal skill lives in the agent's own reversible workspace), not a T3
explicit ask — the operator tap is still required (`no-self-escalation`).

### Corrections become eval cases

The same review loop can turn a **correction** into a durable **regression
test** rather than a skill edit. When the review decides a past mistake should
be pinned so a future edit can't silently reintroduce it, it runs:

```
switchroom self-improve add-eval-case --skill <slug> \
  --prompt "<the correction, phrased as a test prompt>"
```

This is **propose-only** — it writes nothing to the skill. It validates and
dedups the case, runs a deterministic **PII/secret scan fail-closed** (a real
scanner, not just a prompt instruction), then posts a one-tap Telegram card.
On Approve the gateway runs the **deterministic `apply-eval-case` applier** (no
model turn), which re-scans fail-closed and appends the case byte-exact to the
skill's `evals/evals.json`. A skill's `evals/evals.json` is therefore
**machine-managed**: an always-on hook hard-blocks a raw model `Write`/`Edit`
to it on every turn (set `SWITCHROOM_SELF_IMPROVE=0` to hand-author with
skill-creator instead). Once a case exists, the apply-guard eval gate blocks
any future skill edit whose pass-rate regresses below the eval floor — the
correction now defends itself. Silent auto-apply of a verified edit stays OFF
by default (`SWITCHROOM_SELF_IMPROVE_T1_LIVE` opt-in); until set, every
otherwise-allowable edit is downgraded to a T2 one-tap proposal.

## Weekly failure-synthesis (one-tap self-improvement, RFC §"failure synthesis")

The failure-driven sibling of skill-synthesis. Where skill-synthesis mines
what **worked** and generalizes it, failure-synthesis mines what **broke** —
the `self-improve:correction`-tagged memories the self-improve gate distilled
— and proposes the smallest durable defense: a skill **EDIT** to a skill the
agent owns, or a **NEW** personal skill where none covers the failure
(create/update parity, RFC invariant 6). A NEW-skill-from-failure reuses the
existing `synthesized-personal-skill` T2 carve-out
(`src/self-improve/tier-router.ts`) — one tap into the agent's own reversible
workspace, hard-T3 floors untouched — and records `origin: "failure-synthesis"`
on the proposal. Every proposal ships with 1–3 regression eval cases routed
through the propose-only `switchroom self-improve add-eval-case` path (never a
direct `evals.json` write), so the fix defends itself against re-introduction.

```yaml
- cron: "0 9 * * 4"        # Thursdays 09:00 — OFFSET from skill-synthesis (Mon)
  name: failure-synthesis
  context: agent            # full live session (Tier 2)
  prompt: |
    <see reference/prompts/failure-synthesis-cron.md for the full prompt>
```

**Cadence and token budget are an operator decision — this cron is NOT
auto-enabled fleet-wide.** Ship the prompt + docs; the operator adds and tunes
the schedule entry. The **recommended default** is **one candidate proposal +
one grader run per week** — enough to catch a recurring failure without
burning a full Tier-2 live session more than weekly. Offset the day-of-week
from the skill-synthesis cron (e.g. skill-synthesis Monday, failure-synthesis
Thursday) so the two syntheses don't stack their token cost in a single wake.
The cron mines the cheap `self-improve:correction` memories FIRST and only
then reads the **implicated** on-disk transcripts, bounded to the N most
recent sessions (default N=8) — so its cost stays close to skill-synthesis's,
not a full-history scan. If a step is unavailable on the non-interactive cron
fire (missing vault grant, PII scan fail-closed), it degrades gracefully and
skips the candidate rather than card-spamming an empty topic.

## Comparison with Claude Code's native scheduling

| | Switchroom (in-agent scheduler) | Claude Code CronCreate | Claude Code Desktop |
|---|---|---|---|
| **Survives restart** | Yes (docker `restart: unless-stopped` + at-least-once replay + skip notice) | No (session-scoped) | Yes (app must be open) |
| **Headless** | Yes | Yes | No (Desktop app only) |
| **Model selection** | Inherits agent's model | Inherits session | Per-task |
| **Context isolation** | Shares session | Shares session | Isolated |
| **Persistence bug** | No | Yes (#40228) | No |
