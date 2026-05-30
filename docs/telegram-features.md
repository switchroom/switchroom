# Telegram features

Several features tune how an agent talks on Telegram. They all land
under `channels.telegram.*` in `switchroom.yaml` and cascade through
the standard defaults → profile → agent layering. The first three are
opt-in; inbound coalescing is default-on.

The `switchroom telegram` CLI verb is the supported way to turn each
one on. Hand-editing `switchroom.yaml` works too — the CLI just edits
the same keys.

```sh
switchroom telegram status
# Agent    Voice-in       Telegraph   Webhook sources
# gymbro   ✓ openai (en)  —           —
# lawgpt   —              ✓ 3000      —
# klanker  —              —           ✓ github

switchroom telegram enable telegraph --agent lawgpt --threshold 2500
switchroom telegram disable telegraph --agent lawgpt
```

## Telegraph long-reply publishing

**What:** replies above a threshold are published to telegra.ph; the
agent sends a single message linking to the article, which Telegram
renders as an Instant View card.

**Why:** keeps a chat scrollable when an agent produces a long
research write-up or a multi-paragraph briefing.

**Tradeoff (content residency):** the article body is hosted by
Telegraph (Telegram's pastebin-style service), not on your machine.
Don't enable for agents whose output may include secrets or
client-confidential material.

**Enable:**

```sh
switchroom telegram enable telegraph --agent lawgpt --threshold 3000
```

Optional flags: `--short-name`, `--author-name` (Telegraph article
metadata).

## Voice-in transcription

**What:** inbound voice / audio messages are downloaded and
transcribed via OpenAI Whisper, then surfaced to the agent as the
user's text input.

**Why:** lets you talk to an agent on the move without typing.

**Tradeoff (subscription-honest):** Whisper requires an OpenAI API
key. That's the one place Switchroom asks you to leave the
Pro/Max-only ceiling — there's no Anthropic-side voice transcription
yet. The key only ships voice bytes for transcription; the agent
itself still runs through your Pro/Max subscription.

**Enable** (will land in a follow-up PR after #604):

```sh
switchroom telegram enable voice-in --agent gymbro --api-key sk-...
# stores the key in the vault, sets channels.telegram.voice_in.enabled
```

## Inbound coalescing

**What:** consecutive inbound messages from the same sender in the same
topic are buffered for a short sliding window and merged into ONE Claude
turn. When you forward a handful of messages at once, or paste a long
block of text that Telegram silently splits into several messages, the
agent sees them as a single shared-context turn instead of replying to
each fragment in isolation.

**Why:** a forwarded burst is usually one thought. Without coalescing
the agent answers message 1 before messages 2–4 have even arrived, so
it reasons with partial context and fires several disjoint replies.

**Default-on, no setup.** This runs at the default 500ms window with
zero config. The 👀 acknowledgement still fires the moment your first
message lands, so the wait for the window to close is invisible.

**Tune it** (yaml only — no CLI verb):

```yaml
channels:
  telegram:
    coalesce:
      window_ms: 500   # default; raise for slower forwards, 0 to disable
```

Cascades through defaults → profile → agent like every other
`channels.telegram.*` knob. `window_ms: 0` disables coalescing (each
message becomes its own turn). Takes effect on the next message after
`switchroom apply` + agent restart.

**Scope (v1):** a coalesced turn carries the merged text plus at most
one attachment. A second photo/document — or an album — starts a fresh
turn rather than dropping the extra media, so nothing is silently lost.
Full multi-attachment / album grouping is a follow-up.

## Webhook ingest

**What:** an external service (e.g. GitHub) POSTs events to
`https://<your-host>/webhook/<agent>/<source>` and the agent receives
them as inbound messages.

**Why:** notify an agent when a PR is opened, a build fails, an
incident page lands — without you forwarding it manually.

**Tradeoff (security perimeter):** a webhook secret must be set per
agent and source; the web endpoint validates the signature. A
mis-configured secret means events are silently rejected with a 401.

**Enable** (will land in a follow-up PR after #604):

```sh
switchroom telegram enable webhook --agent klanker \
  --source github --secret whsec_...
```

See `docs/webhook-ingest.md` for the underlying signature scheme.

## /usage & account usage

**`/usage`** shows where your Claude Pro/Max plan stands across both
rolling rate-limit windows. Any allowed sender can call it (it is *not*
admin-gated) — it has to work even when the model is unreachable.

When the auth-broker is reachable and the fleet has one or more
accounts, `/usage` renders the **fleet snapshot**: every account in the
broker's known set, live-probed in parallel, grouped by health
(blocked-first, then throttling, then healthy). Each account row shows
its `5h` and `7d` utilisation percentages plus a per-window reset line
("5h refills 11:00 AM (in 6m) · 7d resets Sun 11:00 AM"). The
fleet-active account is marked. This is the same renderer `/auth show`
uses, so the two commands speak one dialect.

If the broker is unreachable (boot timing, broken socket), `/usage`
falls back to a single-agent block:

```
Claude plan quota

5h window  29% · resets in 4h 12m
7d window  33% · resets in 3d 6h

Binding window: five hour
```

The *binding window* line names which limit is the closer ceiling
(whichever resets first / is more utilised); an `Overage:` line appears
only if the account has overage disabled.

The percentages and reset times come straight from Anthropic's
`anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}` response
headers — Switchroom does not estimate them.

*Grounded in:* `telegram-plugin/gateway/gateway.ts` (`bot.command('usage')`),
`telegram-plugin/quota-check.ts` (`formatQuotaBlock`, `parseQuotaHeaders`),
`telegram-plugin/auth-snapshot-format.ts` (`renderAuthSnapshotFormat2`).

### Web dashboard

`switchroom web` starts a local HTTP dashboard for watching the fleet
from a browser (read-mostly, with a few action buttons).

```sh
switchroom web                      # http://127.0.0.1:8080 (localhost-only)
switchroom web --port 9000          # different port
switchroom web --bind 0.0.0.0       # LAN-accessible (prints a token to use)
```

The default bind is `127.0.0.1` (localhost-only). Binding to a
network-reachable address prints a short-lived access token that the
browser must present — don't expose it to an untrusted network without
a reverse proxy in front.

Tabs:

- **Summary** (landing tab) — fleet overview tiles built client-side
  from the cheap endpoints: agents up/total, broker / hindsight / hostd
  health, pending approvals, schedule status, and the worst-account
  quota headroom. Each tile degrades independently if its endpoint is
  down. Loaded on open and on tab-switch only — *not* on the 10s poll.
- **Agents** — per-agent status, recent turns, sub-agents, logs, plus
  start / stop / restart buttons.
- **Accounts** — auth accounts with health badges and quota
  utilisation. Quota percentages are cached: the default load shows the
  last cached value (and flags it stale); a per-account or "refresh
  all" button triggers a live broker probe (a real billed Anthropic
  call) with a TTL so the poll and the buttons can't storm the API.
  A "use" action performs a fleet-wide active-account swap.
- **System** — broker / kernel / hindsight / hostd health.
- **Google**, **Schedule**, **Approvals** — Google Drive accounts,
  scheduled cron entries, and pending approval requests.

The page auto-refreshes most tabs every 10 seconds.

*Grounded in:* `src/cli/web.ts`, `src/web/server.ts` (route table),
`src/web/api.ts` (account/quota endpoints + cache), `src/web/ui/index.html`
(tabs).

## /queue & mid-flight steering

A message that arrives while the agent's previous turn is still running
is **queued by default** — it waits for the in-flight turn to finish,
then runs as its own turn (the model sees `queued="true"` on the
channel meta so it knows the message was held).

To instead treat a mid-flight message as a *course-correction for the
running turn* (not a new task), prefix it:

- `/steer <text>` or `/s <text>` — mark this as steering the in-flight
  turn (`steering="true"`).
- `/queue <text>` or `/q <text>` — legacy alias for the default queued
  behaviour; still accepted so old muscle-memory and scripts keep
  working.

The prefix rules are strict: exactly one leading slash, the keyword
must be `queue`/`q`/`steer`/`s` exactly, and a mandatory single space
must follow (`/queue` with no trailing space is treated as literal
text, not a prefix). Only the first prefix is stripped — `/queue /q
foo` queues with body `/q foo`.

*Grounded in:* `telegram-plugin/steering.ts` (`parseQueuePrefix`,
`parseSteerPrefix`, `buildChannelMetaAttributes`),
`telegram-plugin/gateway/gateway.ts` (queue/steer parse on inbound).

## Fleet & host commands

These slash commands are surfaced in any agent's chat (mutating ones
are admin-gated against the per-agent `admin: true` flag — the same
flag that gates `/restart`, `/update`, `/agents`).

| Command | Admin-gated | What it does |
|---|---|---|
| `/upgradestatus` | no (read-only) | Snapshot of where the host stands — CLI version, image age, container age per service. Wraps `switchroom update --status`. (Telegram forbids hyphens in command names, so it's `/upgradestatus`, not `/upgrade-status`; `/upgrade` is a polite redirect.) |
| `/folders` | operator (allowFrom) | Google Drive folder-picker card — browse the connected account's Drive and grant an agent a scoped `allow_always` write capability on a folder by tapping it. This is the Telegram surface for Google Drive write approvals; there is no `/drive` slash command (Drive is managed from the CLI via `switchroom drive`). |
| `/audit hostd` | admin | Tail / filter the hostd (host-control daemon) audit log — privileged-verb call history (`update_apply`, `agent_restart`, …). Mirrors `/vault audit`. There is no standalone `/hostd` command; hostd is dispatched-into transparently by `/update apply`, `/restart`, etc. when configured. |

> **Note on `/handoff` and `/hostd`:** these are *not* Telegram slash
> commands. `switchroom handoff <agent>` is an internal CLI verb run by
> the Stop hook to write the cross-session briefing; `switchroom hostd`
> is the host-side CLI for the host-control daemon. Telegram only
> exposes hostd observability via `/audit hostd` (above). See the CLI
> reference for both verbs: [`docs/cli-reference.md`](cli-reference.md).

*Grounded in:* `telegram-plugin/gateway/gateway.ts`
(`bot.command('upgradestatus')`, `bot.command('folders')`,
`bot.command('audit')`), `telegram-plugin/welcome-text.ts`
(`TELEGRAM_MENU_COMMANDS`, `switchroomHelpText`).
