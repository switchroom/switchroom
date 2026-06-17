# Supergroup mode

By default every switchroom agent talks to you in a **private DM** — one
bot, one chat. **Supergroup mode** is the alternative topology: a single
agent **owns a Telegram forum supergroup** and routes all of its traffic —
your conversations *and* its automated events — into **per-topic threads**
inside that one group.

Use it when one agent does enough varied work that a flat DM becomes a
firehose. A marketing agent, say, can keep "Meta Campaigns", "CRM", and
"Planning" as separate topics, so each thread reads as its own focused
conversation instead of an interleaved scroll.

DM mode stays the default and needs zero of this. Supergroup mode is
opt-in and per-agent — you can run a mixed fleet (most agents DM, one owns
a supergroup).

> Internals and the routing design live in
> [rfcs/supergroup-mode.md](../reference/rfcs/supergroup-mode.md) and
> [rfcs/supergroup-easy-defaults.md](../reference/rfcs/supergroup-easy-defaults.md).
> This page is the operator how-to.

## What you get

When an agent owns a supergroup:

- **Replies follow the conversation.** A message you send in the "CRM"
  topic gets answered in the "CRM" topic — the agent threads its reply
  back to the topic the inbound came from.
- **Automated events route by class.** Boot cards, watchdog alerts, and
  compaction notices go to your `alerts` topic; vault / permission /
  fleet-mutation events go to your `admin` topic; everything else falls
  back to General. You name those topics once (see `topic_aliases`).
- **Cron picks its topic.** Each scheduled task can name the topic it
  posts into — see [scheduling.md → Targeting a forum
  topic](scheduling.md#targeting-a-forum-topic-supergroup-owned-agents).

## Set it up

### 1. Create the supergroup in Telegram

In Telegram: create a **group**, open its settings, and enable **Topics**
(this turns it into a *forum* supergroup). Add the agent's bot as an
**admin** with permission to manage topics and send messages. Create the
topics you want (e.g. *General*, *Planning*, *Alerts*, *Admin*).

> One agent, one supergroup. Each agent that owns a supergroup needs its
> **own** BotFather bot — the same rule as DM agents.

### 2. Find the numeric ids

- **Supergroup `chat_id`** — open any message in the group and copy its
  link (`t.me/c/<id>/<thread>/<msg>`). The `<id>` is your supergroup,
  written with a `-100` prefix: link id `1234567890` → `chat_id:
  "-1001234567890"`. It is always a **negative integer as a string**.
- **Topic `thread_id`** — open the topic and read the trailing number in a
  message link, or read it off an inbound the agent already received in
  that topic. **General is always thread `1`.**

### 3. Configure the agent

`switchroom setup` offers this as an **optional step** ("Supergroup mode")
— answer yes, pick the agent, and paste the `chat_id`. That writes the one
required field for you; you add the topic names afterward.

Or edit `switchroom.yaml` by hand:

```yaml
agents:
  social:
    topic_name: "Social"
    bot_token: "vault:telegram-social-bot-token"   # its own bot
    channels:
      telegram:
        chat_id: "-1001234567890"   # the forum supergroup this agent owns
        default_topic_id: 1         # fallback topic (1 = General); optional
        topic_aliases:              # name → topic id
          alerts: 12                # boot / watchdog / compaction events
          admin: 7                  # vault / permission / mutation events
          planning: 3
```

Only `chat_id` is required. When you omit `default_topic_id`, switchroom
smart-defaults it to **General (topic 1)**. `topic_aliases` is optional —
add it to route automated events and to give cron entries friendly topic
names. Aliases are validated at config load, so a typo fails `switchroom
apply` instead of mis-routing silently.

### 4. Apply

```bash
switchroom apply              # regenerate compose + scaffold
switchroom agent restart social --wait --force
```

Send a message in one of the topics and confirm the reply threads back
into the same topic.

## Field reference

| Field | Required | Default | Meaning |
|---|---|---|---|
| `channels.telegram.chat_id` | Yes (to enable) | — | The forum supergroup this agent owns. Negative integer as a string (e.g. `"-1001234567890"`). Setting it is what turns supergroup mode on. Forbidden when `dm_only: true`. |
| `channels.telegram.default_topic_id` | No | `1` (General) | The forum topic untargeted outbounds fall back to. Auto-defaults to General when `chat_id` is set. |
| `channels.telegram.topic_aliases` | No | `{}` | `name → numeric thread_id` map. Referenced by automated-event routing (`alerts`, `admin`) and per-cron `topic:` fields. |

## Notes & gotchas

- **DM agents are unaffected.** No `chat_id` → DM mode, exactly as before.
  An empty/0 thread id is a Telegram `400 message thread not found`, so
  switchroom never attaches a topic to a DM send.
- **`dm_only: true` and `chat_id` are mutually exclusive** — the schema
  rejects setting both.
- **Reserved alias names** `alerts` and `admin` drive automated-event
  routing. Other alias names are free for your own cron targeting.
- **Discovering topic ids has no CLI shortcut yet** — use the
  message-link method above. (The General topic is always `1`.)

## See also

- [scheduling.md](scheduling.md) — per-cron topic targeting.
- [configuration.md](configuration.md) — the full `switchroom.yaml`
  cascade.
- [rfcs/supergroup-mode.md](../reference/rfcs/supergroup-mode.md) — design + routing
  internals.
