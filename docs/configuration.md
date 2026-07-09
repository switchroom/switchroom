# Configuration Reference

Everything lives in one file: `switchroom.yaml`. Switchroom uses a **three-layer cascade** for agent config:

1. **`defaults:`** — global baseline for every agent
2. **`profiles:`** — named presets agents inherit via `extends:`
3. **`agents:`** — per-agent overrides (only express differences)

## Cascade Semantics

Each field type has specific merge behavior when values exist at multiple layers:

| Merge type | Fields | Behavior |
|---|---|---|
| **Union** | `tools.allow`, `tools.deny`, `skills` | Combine across layers, dedup |
| **Per-key merge** | `mcp_servers`, `bundled_skills`, `env`, `subagents` | Agent wins on key conflict |
| **Per-field merge** | `soul`, `memory`, `session`, `channels` | Agent wins per sub-field |
| **Per-event concat** | `hooks` | Defaults first, then agent |
| **Concatenate** | `schedule`, `system_prompt_append`, `claude_md_raw`, `cli_args` | Defaults prepended/joined |
| **Override** | `model`, `extends`, `dangerous_mode`, all other scalars | Agent wins entirely |
| **Deep merge** | `settings_raw` | Recursive object merge, agent wins |

## Full Field Reference

| Field | Cascade | Description |
|-------|---------|-------------|
| `model` | override | Claude model (`claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`). Haiku is the default for the handoff summarizer; agents typically use opus or sonnet. |
| `thinking_effort` | override | Adaptive-thinking effort passed as `--effort` (`low`/`medium`/`high`/`xhigh`/`max`). Defaults to `low` when unset. **On Opus 4.x keep this at `low`** — `medium`+ emits thinking blocks that the bundled claude CLI can mis-merge under concurrent sub-agents, causing `400 'thinking blocks cannot be modified'` (issue #1978). `switchroom doctor` warns on the risky combo. Removing the field does *not* help: Opus 4.8 defaults `effort=high` when `--effort` is omitted. |
| `permission_mode` | override | Permission mode for the agent's Claude session. Drives the `--permission-mode` CLI flag AND the `.claude/settings.json` `permissions.defaultMode`. **The switchroom built-in default is `acceptEdits`** — every agent auto-accepts edits with no yaml needed. Override per-agent here or fleet-wide via `defaults.permission_mode`; per-agent wins. Valid values: `acceptEdits`, `default`, `plan`, `bypassPermissions` (settings.json `defaultMode`), plus `auto`/`dontAsk` (CLI-flag only — these fall back to `acceptEdits` for `defaultMode`). See [Permission mode & auto-accept](#permission-mode--auto-accept). |
| `extends` | — | Named profile to inherit from |
| `tools.allow` / `tools.deny` | union | Tool permissions |
| `soul` | per-field (**seed-time only**) | Agent persona (name, style, boundaries). Cascades per-field, but **only at first scaffold** — it seeds `workspace/SOUL.md`, which is then user-owned (see [Persona & SOUL.md ownership](#persona--soulmd-ownership)). Editing `soul:` later does **not** change an agent whose SOUL.md already exists. |
| `memory` | per-field | Hindsight collection and recall settings |
| `hooks` | per-event concat | Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) |
| `env` | per-key | Environment variables for start.sh |
| `mcp_servers` | per-key | Additional MCP server configurations. Set a key to `false` to suppress a built-in default (e.g. `playwright: false`) |
| `secrets` | union | **Operator-set** standing vault grant: vault keys this agent may read via the broker, independent of any cron or MCP server. Use for credentials an agent needs both interactively and in its own (agent-managed) schedules. Agents cannot self-grant — this is operator-only by design ([vision.md](../reference/vision.md) outcome 2). See [§ Standing vault grants](#standing-vault-grants-agentsnamesecrets). |
| `system_prompt_append` | concatenate | Appended to the system prompt via `--append-system-prompt` |
| `skills` | union | Named skills from the global skills pool (`switchroom.skills_dir`) |
| `bundled_skills` | per-key | Opt-out map for switchroom's bundled-default skills. Set a key to `false` to suppress (e.g. `pdf: false`). See [docs/skills.md](./skills.md). |
| `subagents` | per-key | Sub-agent definitions rendered to `.claude/agents/<name>.md` |
| `schedule` | concatenate | Cron-based scheduled tasks (in-agent scheduler sidecar — see [scheduling.md](./scheduling.md)) |
| `reactions.enabled` | override | Master switch for the reaction-trigger path (#1074). When `false`, reactions are still persisted but never forwarded to the agent as synthetic inbound turns. Default `true`. |
| `reactions.trigger_emojis` | replace | Emoji allowlist that triggers a synthetic `<channel source="reaction">` inbound when reacted to a bot message. **Replace semantics**, not union — set to `[]` to disable triggering without flipping `enabled`. Default `['👎', '❌', '👍', '✅']`. |
| `reactions.debounce_ms` | override | Per-chat debounce window in ms. Reactions within the window collapse into one batched synthetic. Default `30000`. |
| `reactions.per_hour_cap` | override | Max reaction-triggered synthetic turns per chat per rolling hour. Refusals are stderr-logged but not surfaced to the agent. Default `10`. |
| `reactions.group_admin_only` | override | In groups/supergroups, only trigger when the reacter is `creator` or `administrator`. Failing the lookup is treated as non-admin (fail-closed). DMs are never affected by this flag. Default `true`. |
| `reaction_dispatch.enabled` | override | Master switch for the event-driven reaction-dispatch path (#2291). When `true`, an emoji reaction on **any** message is forwarded to the agent as a `<channel source="switchroom-telegram" event="reaction" …>` inbound turn (button-callback shape) carrying the reacted message's text. Distinct from `reactions` (which only handles reactions on the bot's own messages). Default `false`. |
| `reaction_dispatch.emojis` | replace | Emoji allowlist that triggers a dispatch. Only additions/changes matching the list fire; removals never do. **Replace semantics** — narrow per-agent or set `[]` to disable. Default `[]` (nothing fires). |
| `session.max_idle` | override | Fresh session after idle period (`2h`, `30m`) |
| `session.max_turns` | override | Fresh session after N user turns |
| `session.idle_clear_after` | override | Auto-run `/clear` (wipe working context) after this much idle. Default `3h` (on by default); `0s` disables. Long-term memory stays in Hindsight. |
| `channels.telegram.plugin` | override | `switchroom` (default, enhanced) or `official` |
| `channels.telegram.format` | override | Reply format (`html`, `markdownv2`, `text`) |
| `channels.telegram.rate_limit_ms` | override | Min delay between outgoing messages |
| `channels.telegram.orphan_promotion_ms` | override | Progress-card: ms before an unmatched spawn is promoted to a running row (default 5000) |
| `channels.telegram.cold_sub_agent_threshold_ms` | override | Progress-card: ms of JSONL silence before a sub-agent is synthesised as finished (default 30000) |
| `channels.telegram.deferred_completion_timeout_ms` | override | Progress-card: force-close timeout (ms) after parent `turn_end` while sub-agents are still running (default 180000) |
| `channels.telegram.sub_agent_tick_interval_ms` | override | Progress-card: elapsed-counter tick interval (ms) while a sub-agent is running (default 10000) |
| `channels.telegram.approval_timeout_minutes` | override | Operator approval-card lifetime (minutes) for the tool-use "Allow once" card and the vault grant decision wait. After this long with no tap, the card auto-denies as a TIMEOUT (the agent is told not to retry). Default 60. |
| `channels.telegram.edit_budget_threshold` | override | Progress-card: card-edit budget per minute before throttled mode (default 18) |
| `channels.telegram.clear_status_on_completion` | override | When `true`, the live activity/status feed (the in-place "what it's doing" message) is **deleted** when the turn's final answer lands, leaving only the reply. Default `false`: the status message **stays** in the chat as a record (finalized to an all-done render) — no post-then-delete flicker. |
| `channels.telegram.pin_status_while_working` | override | When `true` (default), the framework **silently pins** the already-rendered status message while its work is in-flight and **auto-unpins** it on completion — the per-turn activity/status message (foreground) and the `🛠 Worker` background-worker message. Keeps in-flight work in view when the conversation scrolls past it (fast turns, stacked background workers, long turns). It pins a message the chat **already owns** — no new surface is rendered — and never buzzes the device. The one sanctioned pin under `chat-is-the-single-source-of-truth`. Set `false` to disable. |
| `channels.telegram.coalesce.window_ms` | override | Sliding-window (ms) for merging consecutive inbound messages from the same sender+topic into ONE Claude turn. A forwarded burst or a long paste that Telegram splits across several messages arrives as a single shared-context turn instead of N rapid-fire turns. Each new message resets the timer. Default `500`. Set `0` to disable coalescing (each message is its own turn). The 👀 acknowledgement still fires immediately, so perceived latency is unchanged. |
| `channels.telegram.coalesce.max_attachments` | override | Max media attachments folded into one coalesced turn. Default `1` (single-attachment behaviour — a second photo/document or an album starts its own turn). Raise to fold a forwarded album or a text+multi-image burst into one turn; the agent sees numbered fields (`image_path_2`, `attachment_file_id_2`, …) plus `attachment_count`. Attachments past the cap spill into the next turn. |
| `channels.telegram.interrupt.safe_boundary` | override | When `true`, a `!`-prefix interrupt that lands **mid-tool-call** is deferred: the SIGINT and the replacement turn wait until the in-flight tool finishes (a clean boundary) instead of `C-c`-ing the agent mid-write/mid-bash. If no tool is in flight the interrupt still fires immediately. Bounded by `max_wait_ms`. An empty `!` (halt-now, no body) always fires immediately. Default `false` (historical synchronous behaviour). |
| `channels.telegram.interrupt.max_wait_ms` | override | Upper bound (ms) to wait for a safe boundary before firing a deferred `!` interrupt anyway. Only consulted when `safe_boundary` is `true`. Default `8000`. Keep it short — the user explicitly asked to interrupt, so a long-running tool shouldn't ghost them. |
| `channels.telegram.voice_out.enabled` | per-field merge | Master switch for outbound spoken replies (TTS). Off by default — opt-in per agent. When on, the gateway can synthesize the agent's text reply into an OGG/Opus voice note. |
| `channels.telegram.voice_out.engine` | override | `kokoro` (default, local voice sidecar — only active when the host voice verdict is local) or `openai` (honest-exception cloud path gated on an `api_key` vault ref). |
| `channels.telegram.voice_out.reply_mode` | override | How the spoken reply accompanies the text. `voice+text` (default) sends both the text and a voice note; `voice-only` sends the voice note and suppresses the text body; `on-demand` sends the text with a single **🔊 Listen** inline button and synthesizes **no** audio until the user taps it — zero GPU/sidecar work unless requested, keeping the voice pipeline subscription-honest and visible. **Collision gate:** the Listen button is injected only when the reply carries no agent-authored buttons — a mixed keyboard would break the agent's `single_use` double-fire protection, so agent buttons present → the Listen button is skipped for that message. In every mode the text reply is always still sent when synthesis fails or the reply exceeds `max_chars`. |
| `channels.telegram.voice_out.voice` | override | Engine-specific voice id (a Kokoro voice name or an OpenAI voice like `alloy`). Optional — the engine has its own default. |
| `channels.telegram.voice_out.speed` | override | Kokoro playback speed, clamped 0.5–2.0. Default 1.1. Ignored by the OpenAI engine. |
| `channels.telegram.voice_out.max_chars` | override | Per-voice-note chunk size for the OpenAI engine (chars). Default 600; clamped to the engine cap (1200). A longer reply is spoken across sequential notes, never truncated. The kokoro sidecar owns length and ignores this. |
| `channels.telegram.voice_out.api_key` | override | OpenAI TTS key as a `vault:<key>` reference (only used when `engine='openai'`; default `vault:openai/api-key`). Resolved through the vault broker at use-time. |
| `settings_raw` | deep merge | Escape hatch: raw settings.json overrides |
| `claude_md_raw` | concatenate | Escape hatch: append to CLAUDE.md on scaffold |
| `cli_args` | concatenate | Escape hatch: extra `exec claude` flags |
| `google_workspace` | deep merge | Google Drive/Docs/Sheets/Calendar integration. `google_client_id` / `google_client_secret` are install-wide (top level only); `tier` + `approvers` cascade per-agent. See § Google Workspace below. |
| `notion_workspace` | deep merge top-level; per-agent `databases:` list REPLACES (does not concatenate) | Notion integration. Top-level `vault_key` + `databases:` map cascade via deep merge so a profile can add a DB without clobbering top-level entries. The per-agent `databases:` allowlist is **override** — an agent's list replaces the parent's, so a specialist agent inheriting a profile can narrow to fewer DBs. See § Notion Workspace below and [notion-integration.md](notion-integration.md). |

## Permission mode & auto-accept

Switchroom sets `.claude/settings.json` `permissions.defaultMode` to
**`acceptEdits`** for **every** agent out of the box — auto-accept of file
edits is the switchroom default on **any** install, with **no yaml needed**.
This is deliberately decoupled from the `tools.allow: [all]` wildcard (which
only drives allow-list expansion): a plain agent with a read-only tool set
still gets `acceptEdits`.

Override it two ways, with the usual switchroom precedence (per-agent wins):

```yaml
# Fleet-wide default for every agent
defaults:
  permission_mode: plan

agents:
  scout:
    # Per-agent override — beats the fleet default AND the built-in default,
    # even for an [all]-wildcard agent.
    permission_mode: default
```

Resolution (highest wins):

1. `agents.<name>.permission_mode` — per-agent override
2. `defaults.permission_mode` — fleet-wide override
3. `acceptEdits` — the switchroom built-in default

Valid values: `acceptEdits`, `default`, `plan`, `bypassPermissions` map
directly to the settings.json `defaultMode`. `auto` and `dontAsk` are also
accepted (they drive the `--permission-mode` CLI flag) but have **no**
settings.json `defaultMode` equivalent, so for `defaultMode` they fall back to
`acceptEdits` with a warning — the CLI flag still carries the raw value. An
unrecognized value is rejected at config-parse time by the schema.

`permission_mode` is independent of `dangerous_mode` (the
`--dangerously-skip-permissions` path), which is unchanged.

## Built-in MCP Servers

The scaffold wires the following MCP servers automatically:

- **switchroom** — management CLI wrapper (list/start/stop agents, check auth). Always wired.
- **playwright** — Microsoft's `@playwright/mcp` browser automation server, launched via `npx -y @playwright/mcp@<pinned-version> --snapshot`. Always wired by default; opt out with `mcp_servers: { playwright: false }`. Runs in accessibility-tree (snapshot) mode, which is token-cheap and reliable for most web automation tasks. Exposes `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and related tools directly to the agent without requiring a local Playwright installation. The version is pinned in `src/memory/scaffold-integration.ts` — bump deliberately when validating against a newer release.
- **hindsight** — semantic memory bank, wired only when `memory.backend` is `hindsight`. Agents using a different memory backend (or none) don't get this server.

### Tuning auto-recall — `memory.recall.max_memories`

Hindsight's auto-recall hook injects relevant memories into every inbound prompt. Without a cap, a busy bank can return 16–22 memories per turn (forensic on real fleets), bloating the prompt and risking irrelevant memories steering the response.

```yaml
defaults:
  memory:
    recall:
      max_memories: 12   # workspace default (also the plugin default)

agents:
  coach:
    memory:
      recall:
        max_memories: 8  # tighter for a chatty agent

  research:
    memory:
      recall:
        max_memories: 0  # 0 = uncapped; let the token budget alone bound the block
```

The cap applies to the *combined* result list across the primary bank and any `recallAdditionalBanks`, not per-bank. Lower values reduce noise; very low values (≤3) can starve the agent of useful long-term context. The plugin's own default is `12`; omit the field to inherit it. Setting `0` (or any non-positive value) disables the cap entirely.

Operationally: the cap is set via the `HINDSIGHT_RECALL_MAX_MEMORIES` env var that `start.sh` exports. The vendored plugin's `recall.py` slices results client-side before formatting (plugin v0.4.0 has no `recallTopK` setting on the Claude Code integration — only Openclaw exposes it).

### Shared / profile recall banks — `memory.recall.additional_banks`

By default an agent recalls only its own bank. Point `additional_banks` at one or more extra Hindsight banks and the recall hook queries them too on every turn, **merging** their hits into the agent's own results (each extra bank gets an 8s timeout and is non-fatal on failure). Use this for a shared operator/household profile every agent should know — preferences, projects, people — kept consistent fleet-wide.

```yaml
defaults:
  memory:
    recall:
      additional_banks: ["operator-profile"]   # every agent also recalls this bank

agents:
  coach:
    memory:
      recall:
        additional_banks: ["operator-profile", "fitness-context"]
```

This stays within the **single tenant**: every bank is your own data, in your own Hindsight instance, fully visible to you (see the [`single-tenant`](../reference/invariants.md#single-tenant) invariant). It is additive recall scoping, never an access boundary.

**Authoring a profile bank — `switchroom memory profile`:**

```
switchroom memory profile add operator-profile "Ken prefers concise, direct answers and dislikes preamble."
switchroom memory profile add operator-profile "Primary project this quarter is the switchroom fleet."
switchroom memory profile list operator-profile        # inspect what's in the bank
```

`add` retains an operator-authored fact into the named bank (creating it on first write); fact extraction runs in the background, so `list` may lag a few seconds. After authoring, wire the bank in via `additional_banks` (above), then `switchroom apply` + restart the agent(s).

### Per-speaker recall — `memory.recall.sender_banks`

When an agent serves **multiple trusted users**, route recall to the *speaker's* profile bank with a `sender_banks` map. On each inbound, the agent recalls its own bank **plus** the bank mapped to whoever sent the message — so each user gets their own context instead of a blended pool. This is the per-user isolation the [`single-tenant`](../reference/invariants.md#single-tenant) invariant calls for, and it keeps recall relevant + token-efficient.

```yaml
agents:
  clerk:
    memory:
      recall:
        sender_banks:
          "@lisa": lisa-profile      # by Telegram username (leading @ optional) …
          "123456789": ken-profile   # … or by numeric user_id
```

The key is matched against the sender's Telegram username (when they have one) or their numeric user id — both are emitted in the message envelope. A leading `@` is optional: `@lisa` and `lisa` both match (the gateway emits the bare handle). Author the target banks with `switchroom memory profile add <bank> "..."` (above).

**It is additive recall scoping, never an access boundary.** Who may *drive* an agent stays the per-agent assignment in `access.allowFrom` — the sender hint only changes which memory is *recalled*, never who is allowed to talk to the agent. All banks remain your own data in your own Hindsight instance, fully visible to you. Combine with `additional_banks` for a shared bank everyone sees *plus* a per-person bank.

### First-class users — `users:` + agent `serves` / `knows`

Rather than hand-maintaining `sender_banks` and `additional_banks` maps per agent, define each trusted person **once** as a user and assign them to agents. See [`reference/rfcs/user-concept.md`](../reference/rfcs/user-concept.md).

```yaml
users:
  ken:  { telegram_ids: ["mekenthompson"], profile_bank: ken-profile }
  lisa: { telegram_ids: ["8201250670"],    profile_bank: lisa-profile }

agents:
  ziggy:  { serves: [lisa] }                       # Lisa's own agent
  marko:  { serves: [ken, lisa] }                  # serves both
  gymbro: { serves: [ken] }                        # Ken only
  clerk:  { serves: [ken], knows: [lisa, kids] }   # Ken drives; always knows the family
```

- **`serves: [<user>…]`** — users this agent works for. When a served user messages it, their `profile_bank` is recalled (generates `sender_banks`).
- **`knows: [<user-or-bank>…]`** — profiles this agent always knows as *subjects*, even when that person isn't the speaker (generates `additional_banks`). A user name resolves to their profile bank; any other string is a raw bank name (e.g. a `kids` bank with no Telegram identity).

`serves`/`knows` accept a fleet-wide default (`defaults.serves: [ken]` → every agent serves Ken) which **unions** with per-agent values. Generated maps also union with any explicit per-agent `sender_banks`/`additional_banks`. A `serves` entry must name a user in the `users:` block (a typo is a config error); `knows` is permissive.

> **Note:** this generates the *memory* wiring only. Who may **drive** an agent (`access.allowFrom`) is still paired at agent creation as today — generating access from `users:` is a future phase.

### Specializing a bank — missions & disposition

A persona without its own memory is cosplay: banks should be *specialized*, not merely isolated. Four `memory.*` fields steer how a bank extracts, recalls, and synthesizes — a coach should read its notes differently than a lawyer.

| Field | Type | Cascade | Steers |
| --- | --- | --- | --- |
| `reflect_mission` | string | override | The bank's "who am I / what matters" framing applied during recall/reflect. Engine-accurate name for what `bank_mission` sets. |
| `bank_mission` | string | override | **Alias** for `reflect_mission` (retained for back-compat — switchroom's `bank_mission` lands in the engine's `reflect_mission`). If both are set, `reflect_mission` wins. |
| `retain_mission` | string | override | What the fact-extraction LLM keeps during auto-retain. Defaults to a curated mission on fresh agents. |
| `observations_mission` | string | override | What the observation-consolidation LLM synthesizes from raw facts (the higher-order "what patterns matter" lens). |
| `disposition` | object | **per-key merge** | Personality traits (`skepticism` / `literalism` / `empathy`, each `1`–`5`, engine default `3`) shaping recall/reflect/observation framing. |

```yaml
agents:
  gymbro:
    extends: health-coach
    memory:
      observations_mission: "Track motivation, adherence, and how setbacks connect to encouragement."
      disposition:
        empathy: 5        # overrides just this trait; skepticism/literalism
                          # inherit the health-coach profile default (2/2)
```

`disposition` deep-merges one level (like `recall`): overriding a single trait leaves the profile's other traits in place. The other three fields override wholesale.

**Zero-config defaults.** Built-in profiles ship differentiated dispositions so a fresh `switchroom setup` needs no YAML — `health-coach` leans empathy-high (`2/2/5`), `executive-assistant` leans precise (`4/4/3`), `coding` leans skeptical + literal (`4/5/2`). Operator config overrides these per-key.

All four apply at **both** scaffold (fresh agents) and reconcile (`switchroom apply` updates existing banks) — except the `retain_mission` *default*, which is seeded only at scaffold so a customized retain mission is never clobbered.

### Demoting individual memories from auto-recall

If one specific memory keeps surfacing in the recall block and isn't useful (over-broad world fact, stale context, etc.), tag it with `[demote-from-recall]` — or `demote-from-recall` / `no-recall`, all three work. The memory stays in the bank, `mcp__hindsight__reflect` and manual recall can still find it, but auto-recall skips it.

```
# inside an agent, against its own bank
mcp__hindsight__update_memory(memory_id="abc-123", tags=["[demote-from-recall]"])
```

The filter runs before the `max_memories` cap, so demoting a noisy memory doesn't waste a slot.

### Inspecting auto-recall in production — `switchroom memory recall-log`

Every auto-recall run (cache hit or miss) appends a JSONL record to the agent's plugin-state dir. View via:

```
switchroom memory recall-log [agent] [-n N] [--json]
```

Per-agent output looks like:

```
clerk:
  last 20 turns: avg=11.4 max=12 cache_hits=2 capped=8
  2026-04-30T07:53:45Z OK    n=12 ids=mem-a1,mem-c4,mem-9f…+9
  2026-04-30T07:52:10Z CAP   n=12/18 ids=mem-a1,mem-c4,mem-7e…+9
  2026-04-30T07:51:33Z CACHE n=—
```

`OK` = uncapped recall fired; `CAP` = recall returned more than `max_memories` and was sliced; `CACHE` = served from the per-session cache (#424 4.1).

Use this to answer "is 12 the right cap?" — if `CAP` fires on most turns, the bank has more relevant content than 12 lets through; consider raising. If `CAP` rarely fires and `avg` stays well below the cap, the cap isn't the lever and other tuning (`recallBudget`, retain hygiene) probably matters more.

The log is bounded to the last ~5000 events per agent.

### Making corrections stick — `memory.directive_capture_nudge`

Hindsight **directives** are the primitive that makes a standing rule survive a restart: user-authored, verbatim, and re-injected into every turn. But whether a correction actually *becomes* a directive was, historically, guidance-only — the model is told to call `create_directive` when you give it a durable rule, and inconsistently does. An audit (issue #2848) measured a **~55% miss rate** on clear-cut durable corrections: the same broadcast correction was captured by one agent and silently dropped by two others.

`memory.directive_capture_nudge` (default **on**) closes that gap. On every inbound the auto-recall hook runs a **deterministic regex** over the message; when it looks correction- or standing-rule-shaped — `always`/`never`, `from now on`, `stop doing …`, a stated preference, `call me …`, `that's wrong, it's …` — it appends a terse advisory to the turn's context reminding the model that *if* this is a durable rule (not a one-off), it should persist it with `create_directive` before answering.

Two things it deliberately does **not** do (both are hard invariants):

- **No extra model call.** Detection is pure regex; the *judgment* — is this actually a standing rule? — happens inside the interactive `claude` session, on the operator's subscription. There is no classifier callsite.
- **No silent write.** The hook only nudges. The model decides and calls `create_directive` itself, visible in chat — the hook never writes a directive you didn't see.

Detection is intentionally inclusive (the nudge is cheap and advisory, so a false positive just costs a few tokens and is ignored), with a guard against the obvious pleasantry shapes (`always happy to help`, `never mind`).

**Post-turn verification (the same knob).** The advisory nudge still relies on the model *choosing* to act on it. To close the residual gap for the clear-cut case, a **Stop-hook verifier** runs after the turn: it re-checks the human turn against a **narrow, high-precision** durable-rule regex — a strict subset of the nudge detector (explicit framings only: `from now on`, `as a rule`, `you should always`, `call me …`, `remember to …`, `don't … again`; bare `always`/`stop …` and world-fact corrections are excluded) — and if the turn stated a durable rule but the model recorded **no** `create_directive` call, it **blocks the stop once** to re-prompt the model to persist it. This keeps the two invariants above: no model call (pure regex), no silent write (the block is a re-prompt; the model still authors the directive itself, visibly). The block fires **at most once per turn** (a `stop_hook_active` loop guard), and its reason explicitly authorizes "if this was really a one-off, don't create a directive — just finish", so a false positive costs one bounded continuation, never a spurious directive. This verifier shares the `memory.directive_capture_nudge` knob — disabling the nudge disables the verifier too.

```yaml
defaults:
  memory:
    directive_capture_nudge: false   # disable fleet-wide (not recommended — Stage A proved a real gap)

agents:
  clerk:
    memory:
      directive_capture_nudge: true  # per-agent opt back in
```

**Cascade: override** (per-agent wins over profile/defaults). Omit the field to inherit the on-by-default. Operationally the knob threads the same way as the other recall tuning: the switchroom default is pinned in the plugin's `settings.json`, and `start.sh` exports `HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE` only when you override it (the env value wins at plugin load). Serves the `remember-across-sessions` job.

### Server-side caps on the Hindsight container

`switchroom memory --start` launches the bundled Hindsight container with `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=1000` already set. The same default is baked into the `--compose` snippet output.

What this actually caps: per-*tag scope* observation count. Switchroom's vendored plugin retains with `retainTags: ["{session_id}"]`, so each session becomes its own scope and the cap bounds a single very-long session at 1000 observations. Most sessions stay well below 1000 — this is a safety rail for the worst case (a Telegram session running uninterrupted for weeks), not an active limit on most agents. Tagless observations are unaffected.

This is **not** a fix for vectorize-io/hindsight#1284 (the upstream unbounded-growth bug for whole-bank consolidation) — that's their work to do. It's a companion guardrail.

You don't need to do anything to opt in. Override by stopping the bundled container and re-running `docker run` with a different `-e HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=N` value, or by editing the generated docker-compose snippet before applying it.

If you run your own Hindsight container outside `switchroom memory --start` (e.g. you point `memory.config.url` at an external server), switchroom doesn't manage that container's env — set the cap on your own image.

Any server from `defaults.mcp_servers` also flows to all agents via the normal cascade.

To suppress the built-in `playwright` server for a specific agent:

```yaml
agents:
  my-agent:
    mcp_servers:
      playwright: false   # opt-out: don't include the browser MCP for this agent
```

Or globally for every agent (in `defaults`):

```yaml
defaults:
  mcp_servers:
    playwright: false   # opt-out: no agent gets the browser MCP unless they explicitly enable it
```

### Wiring an MCP server that needs vault secrets

The common pattern for adding a third-party MCP server is:

1. **Drop a launcher script** into `~/.switchroom/mcp-launchers/`. The directory is bind-mounted into every agent container at the same path (since v0.13.36 / PR #1787) so any executable there is reachable from inside an agent without rebuilding the image.
2. **Store the API key** in the vault: `switchroom vault set <service>/api-key`.
3. **Have the launcher fetch the key at spawn** via `switchroom vault get <service>/api-key` (this asks the vault-broker, no operator prompt needed).
4. **Declare the MCP server + its vault dependency** in `switchroom.yaml`:

```yaml
defaults:
  mcp_servers:
    perplexity:
      command: /home/<operator>/.switchroom/mcp-launchers/perplexity-mcp.sh
      # Vault keys the launcher will fetch via `switchroom vault get`.
      # The broker grants these to every agent that inherits this MCP
      # entry through the cascade. Without this declaration, the
      # launcher will hit VAULT-BROKER-DENIED at spawn time.
      secrets: [ perplexity/api-key ]
```

The `secrets:` array is the **broker-ACL declaration**: it tells the vault-broker which keys an agent running this MCP is allowed to fetch under its own peercred identity. No per-agent `vault grant` ceremony required.

Example launcher (`~/.switchroom/mcp-launchers/perplexity-mcp.sh`):

```bash
#!/bin/bash
set -euo pipefail
export PERPLEXITY_API_KEY="$(switchroom vault get perplexity/api-key)"
exec npx -y @perplexity-ai/mcp-server "$@"
```

**Opt-out per agent** works as usual:

```yaml
agents:
  some-agent:
    mcp_servers:
      perplexity: false   # this agent doesn't get perplexity (or its vault grant)
```

### Standing vault grants — `agents.<name>.secrets`

`mcp_servers[].secrets` ties a grant to an MCP server, and a cron's
`schedule[].secrets` ties it to one schedule entry. When an agent needs a
vault key **independent of any server or cron** — typically a skill the
agent runs both interactively *and* in its own (agent-managed) schedules
(e.g. a calendar/mail skill that reads an OAuth token via `switchroom vault
get`) — declare a **standing grant**:

```yaml
agents:
  clerk:
    # Vault keys clerk may read via the broker, always — not welded to a
    # specific cron or MCP server. Cascades UNION across defaults → profile
    # → agent. Exact key names.
    secrets:
      - microsoft/ken-tokens
      - microsoft/azure-app
      - compass/credentials
```

This is the clean home for "**what this agent may access**", separate from
"**when it runs**". With it in place, the agent's schedules can be moved to
agent-managed overlays (which deliberately **cannot** carry `secrets:`) and
still work, because the standing grant covers the keys.

**Operator-only, by design.** Agents cannot edit `switchroom.yaml` and
cannot self-grant — only the operator sets `secrets:`. This is
[vision.md](../reference/vision.md) outcome 2 ("you hold the leash; only
your tap grants it"): a standing grant *is* the tap, expressed as config.
Grant another agent's or operator-owned secret only after a deliberate
decision; never as a way to let an agent reach for credentials it wasn't
given. Enforced by the vault-broker in `src/vault/broker/acl.ts`.

The `false` opt-out drops the ACL grant too — the broker won't serve `perplexity/api-key` to an agent that disabled the MCP.

**Multiple secrets per server** are supported — list them all:

```yaml
defaults:
  mcp_servers:
    notion:
      command: /home/operator/.switchroom/mcp-launchers/notion-mcp.sh
      secrets: [ notion/api-key, notion/workspace-id ]
```

**Special cases that don't need this declaration:**

- **gdrive** — wired through `google_workspace.google_client_secret` + `google_accounts.<email>.enabled_for[]` (RFC G §4.4). The broker's ACL has a dedicated clause for the Google OAuth client credential and per-account token slots; `mcp_servers.gdrive.secrets:` is not required. See [google-workspace.md](google-workspace.md) for the full setup.
- **switchroom-telegram** — agent's effective `bot_token` is granted to that agent via a dedicated ACL clause (the per-agent `bot_token` override or the global `telegram.bot_token`).
- **hindsight** — runs as an HTTP server on the host; no vault keys at launcher spawn.

If you're wiring **any other** third-party MCP that needs a vault key, use the `secrets:` field above. The fault-mode for a missing declaration is silent: `claude mcp list` will report the server as "Failed to connect" because the launcher hits `VAULT-BROKER-DENIED` and the upstream MCP rejects on missing env.

The `switchroom doctor` health check confirms the broker is reachable; an MCP-specific reachability probe is on the follow-up list.

## Progress-Card Tunable Thresholds

When `channels.telegram.stream_mode` is `checklist` (the default), the progress-card driver manages an edit-in-place Telegram message that tracks tool calls and sub-agent activity during a turn. The five knobs below control how it handles edge cases — timeouts, JSONL gaps, and Telegram API rate limits.

All values are in milliseconds unless otherwise noted. Omit a field to keep the built-in default. These fields are only effective when `stream_mode` is `checklist`.

| Field | Default | Description | When to tune |
|---|---|---|---|
| `orphan_promotion_ms` | 5000 (5 s) | How long a parent turn waits for a sub-agent JSONL watcher to deliver `sub_agent_started` before the heartbeat promotes the spawn to a synthesised "running" row. | Increase if fast sub-agents are appearing as orphan rows before their JSONL watcher can connect; decrease if you want orphan detection to fire sooner. Set to `0` to disable orphan promotion entirely. |
| `cold_sub_agent_threshold_ms` | 30000 (30 s) | JSONL-cold threshold. When a running sub-agent emits no events for this long, the heartbeat synthesises a `turn_end` for it so the deferred-completion path can proceed — avoids cards pinned forever on a dead watcher. | Increase if legitimate long-running sub-agents (e.g. waiting on a slow external API) are being falsely closed; decrease to recover faster from a genuinely dead watcher. |
| `deferred_completion_timeout_ms` | 180000 (3 min) | Force-close timeout after the parent `turn_end` arrives while sub-agents are still running. The card is force-closed after this many ms even if the sub-agents never finish. | Increase for agents that routinely spawn very long-running background sub-agents; decrease to shorten the worst-case delay before the card and pin are cleaned up. |
| `sub_agent_tick_interval_ms` | 10000 (10 s) | Elapsed-counter tick interval while a sub-agent is running. Forces a re-render so the elapsed counter advances even during silent stretches between tool calls. | Decrease for a more real-time counter (costs extra edits); increase to reduce edit traffic when many parallel sub-agents are active. Set to `0` to disable. |
| `approval_timeout_minutes` | 60 (1 h) | Operator approval-card lifetime, in minutes, for the tool-use "Allow once" card and the vault grant decision wait. After this long with no operator tap, the card auto-denies — surfaced to the agent as a TIMEOUT (not a denial), so it does not retry the exact action. Threaded to the plugin as `SWITCHROOM_TG_APPROVAL_TIMEOUT_MS` (ms) and to the vault grant wait via the same env. hostd-gated verbs (`mcp__hostd__*`) keep their own window (at least 30 min); the hostd config-propose card keeps a fixed 60-min window (coupled to the MCP wire timeout, not governed by this key). | Increase when the operator is often away and you would rather the request wait than time out; decrease for a snappier "the agent gave up" beat. Cascade: `override` — an agent-level value replaces the profile/default. |
| `edit_budget_threshold` | 18 | Card-edit budget per minute before the driver falls back to a slower coalesce window. When a chat exceeds this many edits in the trailing 60 s, the coalesce interval widens until the rate drops. | Increase if your gateway frequently hits the Telegram edit-rate ceiling with many parallel sub-agents; decrease for a more conservative buffer. |

Example: an agent with many parallel sub-agents that hit the Telegram rate ceiling:

```yaml
agents:
  worker:
    channels:
      telegram:
        stream_mode: checklist
        edit_budget_threshold: 12
        sub_agent_tick_interval_ms: 15000
```

### Advanced env: orphaned-reply liveness window

`SWITCHROOM_ORPHANED_REPLY_STREAM_WINDOW_MS` (default `120000` = 2 min) is an
env-only advanced override on the gateway's orphaned-reply backstop. The
backstop force-ends a turn that has captured assistant text but never called
`reply`; its 30 s fuse used to be reset only by `tool_label` / `text` stream
events, so a long model reasoning pause (which emits neither) could force-end a
genuinely-live turn mid-work. The gateway now stamps a per-turn liveness marker
on *any* genuine stream event; if one landed within this window the fuse re-arms
instead of firing. Raise it to make longer reasoning pauses survivable at the
cost of slower detection of a genuine hang; lower it to catch a wedged turn
sooner at the risk of clipping a long think. Most operators never touch this —
the default is tuned for real production reasoning pauses. Set as a plugin
environment variable, not a `switchroom.yaml` field.

## Profiles

Profiles are named partial configs that agents inherit from via `extends: <name>`. They can be defined in two places:

1. **Inline** in switchroom.yaml under `profiles:` — takes priority
2. **Filesystem** at `profiles/<name>/` — contains `CLAUDE.md.hbs`, `SOUL.md.hbs`, and optional `skills/`

```yaml
profiles:
  advisor:
    tools:
      deny: [Bash, Edit, Write]
    soul:
      style: warm, empathetic
      boundaries: not a licensed professional
    system_prompt_append: |
      Prioritize listening over advising.

agents:
  coach:
    extends: advisor
    topic_name: "Coach"
```

## Persona & SOUL.md ownership

Switchroom splits agent customization into two files with **opposite ownership**:

| File | Owner | Lifecycle |
|------|-------|-----------|
| `CLAUDE.md` (agent root) | **Switchroom** | Cascade-rendered from the profile; regenerated on every `apply`/`reconcile`/`update` so machinery + smart-default changes propagate fleet-wide. Hand-edits are backed up to `CLAUDE.md.before-rerender.*` and replaced. |
| `workspace/SOUL.md` (persona) | **You** | Seeded **once** — from the setup wizard's persona prompts, or the profile's `SOUL.md.hbs` + `soul:` config when skipped. After that it is a plain user file: `update`/`reconcile` **never** overwrite it. |

This is deliberate. `CLAUDE.md` is the operating manual — you want switchroom's updates to reach it. `SOUL.md` is who the agent *is* — you want your words to stick, the way they do in OpenClaw/Hermes. The `soul:` config and profile `SOUL.md.hbs` are therefore **seed-time inputs only**; changing them later does not touch an agent whose `SOUL.md` already exists.

**Editing the persona.** Just edit `workspace/SOUL.md` directly (it's tracked in the workspace git repo, so your edits are versioned and recoverable). `switchroom soul path <agent>` prints the path; `switchroom soul show <agent>` prints the current content.

**Re-seeding from the profile.** To discard the current persona and regenerate from the agent's *current* profile (e.g. after changing `extends:`), run:

```
switchroom soul reset <agent>
```

It backs the existing file up to `SOUL.md.bak` (or `SOUL.md.bak.<ts>` if one already exists) before writing, so a reset is always recoverable.

**Migration.** Existing agents already have a rendered `SOUL.md`. The first `update` after upgrading simply stops regenerating it — your agent's current persona freezes in place as your owned file. No content is lost; the stale `SOUL.md.fingerprint` sidecar becomes vestigial and can be ignored or deleted.

## Global Skills Pool

Skills live in `switchroom.skills_dir` (default `~/.switchroom/skills/`). Each subdirectory is a named skill. Agents select skills via `skills: [name1, name2]` — scaffold symlinks them into the agent's `skills/` directory.

## Skill Secrets, Env Vars, and Dependency Caches

Ported skills follow a few conventions that keep them decoupled from the host filesystem.

### Env-var naming

Each skill exposes its secrets to scripts via env vars of the form `<SKILL>_<FIELD>`, upper-snake-case. The skill's `SKILL.md` is authoritative for the exact names; examples:

| Skill | Env var | Resolved from |
|---|---|---|
| `garmin` | `GARMIN_TOKEN_DIR` | `vault:garmin-tokens` (kind="files" → temp dir path) |
| `compass` | `COMPASS_CREDS` | `vault:compass-creds` (kind="string") |
| `doctor-appointments` | `HOTDOC_CREDS` | `vault:hotdoc-creds` (kind="string") |
| `home-assistant` | `HA_SSH_KEY` | `vault:ha-ssh-key#id_rsa` (specific file inlined) |

The left side (`<SKILL>_<FIELD>`) is the runtime contract with the skill's scripts; the right side is the Switchroom vault reference that fills it in. Use `env:` in the agent config to wire them together — vault references resolve at scaffold/start time.

### Vault reference syntax

References use the `vault:` scheme and accept an optional `#<filename>` fragment:

| Reference | Kind | Substituted with |
|---|---|---|
| `vault:<key>` | `string` | the raw string value |
| `vault:<key>` | `binary` | the base64 payload as-is |
| `vault:<key>` | `files` | path to a per-process temp dir materialized from the files |
| `vault:<key>#<filename>` | `files` | the named file's contents inlined as a string |

Materialized `kind="files"` dirs land under `$XDG_RUNTIME_DIR/switchroom/vault/<pid>/<key>/` (fallback `$TMPDIR/switchroom-vault-<uid>-<pid>/<key>/`), dir mode `0700`, files mode `0600`. They are wiped on process exit (SIGINT/SIGTERM/normal exit) and re-wiped whenever the same key is re-resolved within the same process, so a file removed from the vault between resolves never lingers on disk.

Manage entries with `switchroom vault set <key>`, `switchroom vault get <key>`, and `switchroom vault list`. Multi-line string values are preserved verbatim via piped stdin or `--file <path>`; file-kind entries are set programmatically via `setFilesSecret` (a CLI surface for multi-file set is tracked separately).

### Vault broker (Linux only)

For scheduled tasks that need vault access, switchroom runs a long-lived **vault broker** container that holds the decrypted vault in memory after a one-time passphrase entry (or via auto-unlock; see [vault-broker.md](./vault-broker.md)). Cron-fired prompts then ask the broker for keys instead of re-prompting on every run. The broker is **Linux-only by design** — its access control relies on socket-path-as-identity (each agent gets its own UDS bound by the broker at `/run/switchroom/broker/<agent>/sock`), which only composes on Linux. On non-Linux platforms `switchroom vault get` always reads the vault file directly with the user's passphrase.

```yaml
agents:
  myagent:
    schedule:
      - cron: "0 8 * * *"
        prompt: "morning briefing"
        secrets: [google_calendar_token, weather_api_key]   # NEW
```

The `secrets:` array is **misconfiguration protection, not a security boundary**: it prevents a typo in cron-A from accidentally reading cron-B's keys, and it makes the per-cron secret surface area explicit at config-review time. It does not prevent attack — anyone who can edit cron scripts on the host can also edit `switchroom.yaml` to declare any keys, and anyone who has the vault passphrase can read the vault file directly. Frame it as: "the cron-A script that asks for `weather_api_key` was clearly meant to ask for it" — not "the cron-A script can't reach `bank_token` even if compromised."

The broker runs as a `docker compose` singleton service alongside the agent containers (see `~/.switchroom/compose/docker-compose.yml`). `switchroom apply` regenerates the compose file and `docker compose up -d` brings the broker up with `restart: unless-stopped`, so it auto-restarts on crash and at host boot. CLI verbs `switchroom vault broker {status,unlock,lock,enable-auto-unlock}` talk to the running container.

For interactive use — `switchroom vault get key`, `switchroom vault set key`, etc. — the CLI does **not** go through the broker. It reads the vault file directly with your passphrase. The broker's ACL would deny an interactive caller anyway (the bind-time path-as-identity ACL only grants the per-agent UID), and the user already has the passphrase.

#### Approval posture (`vault.broker.approvalAuth`)

When an agent requests vault access via Telegram, the operator gets an inline card with **Approve** / **Deny** buttons. The factor an Approve tap relies on is configurable via `vault.broker.approvalAuth`:

```yaml
vault:
  broker:
    autoUnlock: true
    approvalAuth: telegram-id   # default: passphrase
    postureMintAgents:           # required when approvalAuth is telegram-id;
      - test-harness             # otherwise no agent can self-mint via posture.
```

| `approvalAuth` | `autoUnlock` | Approve tap result |
|---|---|---|
| `passphrase` (default) | either | Prompts for the vault passphrase before minting the grant. **Two-factor**: Telegram identity + passphrase. |
| `telegram-id` | `true` (required) | Mints immediately with no passphrase prompt. **Single-factor**: Telegram identity only. Agent must also be in `postureMintAgents`. |
| `telegram-id` | `false` | Config error at startup — the schema rejects this combination. |

**Threat model.**

- `passphrase` (default): an attacker who compromises the operator's Telegram account still needs the vault passphrase to mint grants. The passphrase never leaves the operator's device → broker → vault path.
- `telegram-id`: the broker is auto-unlocked at boot and holds the passphrase in memory. The gateway never holds the passphrase — it signals operator-tap intent to the broker via `attest_via_posture: true` on the mint call; the broker uses its retained passphrase internally and never sends it over the wire (#1115 follow-up rev 3). The on-callback gate is the sender's Telegram user ID matching the allowlist; the broker's gate adds (a) `approvalAuth: telegram-id` configured, (b) broker unlocked, (c) calling agent's name is in `postureMintAgents`, (d) request's `agent` field equals the calling agent (no cross-agent posture mint). **An attacker with Telegram account access can mint grants on opted-in agents.** Acceptable when (a) the operator has Telegram 2FA enabled, (b) the host is not multi-tenant, (c) the convenience of zero-friction approvals outweighs the lost factor.

**`postureMintAgents` (per-agent opt-in).** Under `approvalAuth: telegram-id`, only agents on this list can mint grants without a passphrase. **Default `[]`** — even with `telegram-id` enabled, no agent self-mints until you explicitly add its slug. This blocks the in-container threat: claude inside an agent container shares socket access with the gateway, so without this list a tool or skill could call the broker directly and mint without an operator tap. With the list, only the agents you trust at the "broker-auto-unlock-equivalent" level can use the silent-mint path. Suggested rollout: start with `test-harness` only; never add a production agent without thinking explicitly about the trust expansion.

**Architectural residual risk** (telegram-id, allowlisted agents only): an allowlisted agent's claude can theoretically call `mint_grant attest_via_posture` for keys it already has read access to via the existing broker ACL — without an operator tap. This is the documented trade-off of single-factor mode on the current Docker runtime (gateway + claude share UID inside the agent container). To close this gap fully requires a gateway-UID-split (separate UID for gateway vs claude inside each agent) — tracked as a future hardening; not in scope for this feature. Operators who require "every grant requires an explicit tap" should stay on `passphrase` mode.

`telegram-id` is fully opt-in — the default behaviour is unchanged, and `switchroom doctor` surfaces the active posture so it's obvious which mode the host is running.

### Per-skill dependency caches

Skills that need a Python venv or a Node `node_modules` tree get a lazy, hash-stamped cache per skill — no system-level installs, no per-agent duplication.

| Kind | Source file | Cache layout |
|---|---|---|
| Python | `skills/<skill>/requirements.txt` | `~/.switchroom/deps/python/<skill>/` (standard venv; `bin/python`, `bin/pip`) |
| Node | `skills/<skill>/package.json` (+ lockfile) | `~/.switchroom/deps/node/<skill>/` (with `node_modules/`, `node_modules/.bin/`) |

First invocation builds the env and stamps a sha256 of the inputs (`.requirements.sha256` / `.package.sha256`). Subsequent invocations short-circuit when the hash matches; any change to `requirements.txt`, `package.json`, or any recognized lockfile (`bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) busts the cache and triggers a clean rebuild.

Manual recovery: `switchroom deps rebuild <skill>` force-rebuilds one skill's caches; pass `--python` or `--node` to scope.

Host prerequisites:
- Python venvs need `python3-venv` (on Debian/Ubuntu: `apt install python3.12-venv`). `switchroom health` reports missing deps.
- Node envs use `bun` by default. `npm` is available as an alternate installer.

## Multi-Account OAuth (auth-broker)

Authentication is **account-scoped and fleet-wide**, not per-agent. One
OAuth flow per Anthropic account; "use this account on these agents" is
configuration, not another OAuth round. The `switchroom-auth-broker`
compose singleton is the **sole writer** of every agent's
`<agentDir>/.claude/.credentials.json` — agents never refresh tokens or
write credentials themselves. There is no per-agent OAuth slot tree and
no `CLAUDE_CODE_OAUTH_TOKEN` injection; `start.sh` defensively unsets
that env var and `claude` reads `.credentials.json` directly.

`switchroom.yaml` carries the fleet-wide `auth.active` (plus an
optional `fallback_order` and rare per-agent `auth.override`):

```yaml
auth:
  active: me@example.com        # fleet-wide active account
  fallback_order:               # cycle list for `auth rotate` / 429 failover
    - me@example.com
    - work
```

Bootstrap and day-to-day verbs:

```bash
switchroom auth add me --from-oauth   # browser OAuth flow
switchroom auth add me --via-claude   # drives claude's native OAuth (broader scope)
switchroom auth use me                # make it the fleet active account
switchroom auth list                  # state of the fleet
switchroom auth rotate                # cycle to next non-exhausted account
switchroom auth refresh               # force a broker refresh tick
```

> `switchroom auth login` and `switchroom auth status` were **removed**
> with the auth-broker migration (RFC H). Use `auth add` / `auth use`
> to authenticate and `auth list` / `auth show` to inspect state.

### Auto-fallback on quota exhaustion

Quota handling is broker-internal — there is no plugin-polled fallback
loop. When any consumer (agent or hindsight) hits a 429 it calls the
broker's `mark-exhausted` verb; the broker marks the account exhausted,
walks every agent on it, looks up each agent's next non-exhausted
account from `fallback_order`, and atomically rewrites their per-agent
`.credentials.json`. Failover propagates in seconds without per-agent
restarts. When the exhaustion window passes the broker clears the mark
and agents that prefer the cleared account drift back on next idle.

### Broker-internal token refresh

The broker runs one refresh loop per account (not per agent) and
rewrites the canonical credentials when an access token's remaining
lifetime drops below the refresh threshold. `switchroom auth refresh`
forces a refresh tick; the broker decides which accounts actually need
it. There is no host-side `refresh-tick` verb or cron line to wire up —
the broker owns the cadence.

See [`docs/auth.md`](auth.md) for the full model (mental model,
filename conventions, refresh windows, drift detection, the Telegram
`/auth` surface, and ephemeral consumers).

## Google Workspace (`google_workspace:`)

Centralizes the Google OAuth client + the Drive/Docs/Sheets/Calendar
tier knob. The legacy RFC D key `drive:` is an accepted alias (identical
shape); the loader errors if both are set to different values.

```yaml
google_workspace:
  google_client_id: "vault:google-oauth-client-id"
  google_client_secret: "vault:google-oauth-client-secret"
  approvers: [123456789]      # ≥1 Telegram numeric user id
  tier: core                  # core | extended | complete
```

| Field | Cascade | Notes |
|---|---|---|
| `google_client_id` | top level only | OAuth client id. Literal or `vault:<key>` ref. One client per install (Google ToS) — **not** per-agent. Env override: `SWITCHROOM_GOOGLE_CLIENT_ID`. |
| `google_client_secret` | top level only | OAuth client secret. Literal or `vault:<key>` ref. Env override: `SWITCHROOM_GOOGLE_CLIENT_SECRET`. |
| `approvers` | override (per-agent may narrow) | ≥1 Telegram numeric user id authorized to approve Drive onboarding. Env override: `SWITCHROOM_APPROVER_USER_ID`. |
| `tier` | override | Upstream `google_workspace_mcp` tool tier. `core` (default, ~16 tools: Drive+Docs+Sheets+Calendar), `extended` (~40: +Slides/Forms/Tasks/Chat), `complete` (~60+: +Gmail — not recommended; Gmail's per-thread approval shape is unsuitable today, see RFC G §5). |

The block is optional. When absent, `switchroom auth google account
add` and the rest of the fleet Drive surface error with a guided
next-step (run `switchroom auth google connect`, the one-time
onboarding wizard). The wizard writes this block for you. Full setup
walkthrough — including the GCP Console steps and why switchroom ships
no shared client — is in `docs/google-workspace.md` § Prerequisite.

`google_client_id` / `google_client_secret` are deliberately top-level
only: one OAuth client per switchroom install. A per-agent
`google_workspace:` override may narrow `approvers` or pick a different
`tier`, but not the client credentials (RFC G Phase 1).

### Per-account ACL + per-agent selection (`google_accounts:` + `google_workspace.account`)

The `google_workspace:` block above only configures the OAuth *client*.
Two more pieces gate whether a given agent can actually reach Drive —
**both are required; one without the other silently fails:**

```yaml
google_accounts:                 # top-level; keyed by the Google EMAIL
  alice@example.com:             #   (validated + lowercased — NOT an
    enabled_for: [carrie, finn]  #   arbitrary label)

agents:
  carrie:
    google_workspace:
      account: alice@example.com  # the account THIS agent uses
```

| Field | Notes |
|---|---|
| `google_accounts.<email>.enabled_for[]` | The cross-agent ACL: which agents may read that account's broker-held refresh token. Set by `switchroom auth google enable <email> <agents…>` (or by hand). |
| `agents.<name>.google_workspace.account` | The account the broker returns for that agent. The launcher passes **no** account — the broker derives it from this field (path-as-identity) and then enforces `enabled_for[]`. Must be a key in `google_accounts:`. |

Being listed in `enabled_for[]` is **necessary but not sufficient**: an
agent with no `google_workspace.account` gets `ACCOUNT_NOT_FOUND` from
the broker; an agent with `account:` set but absent from that account's
`enabled_for[]` gets `ACCESS_DENIED`. Both are silent at config time and
only surface when the agent tries to use Drive — so `switchroom doctor`
has a **Google Drive** section that flags every such mismatch (and the
deployed `.mcp.json`/trust wiring) up front. Run it after any change
here.

## Escape Hatches

For Claude Code settings switchroom doesn't wrap:

- **`settings_raw:`** — deep-merged into settings.json as the final step
- **`claude_md_raw:`** — appended verbatim to CLAUDE.md on initial scaffold
- **`cli_args:`** — extra flags appended to `exec claude` in start.sh (POSIX-quoted)

## Admin-Only: Extra Bind-Mounts (`bind_mounts:`)

Agent containers ship with a fixed bind-mount set (state dir, .claude
project dir, logs, read-only skills + credentials). That is the right
default for the typical fleet — sandboxed agents stay isolated from
the host's source trees and operator state.

### Which primitive solves which problem

`bind_mounts:` is the catch-all *extra host paths* escape hatch.
Before reaching for it, check whether one of the more focused
primitives is the right tool:

- **"Agent should edit a git repo (incl. switchroom itself)."** Use
  `repos:` (see `src/config/schema.ts` `AgentRepoEntry`). Switchroom
  provisions a dedicated worktree at `<agentDir>/work/<slug>/` from
  a shared bare clone — the agent edits *inside its own sandbox*,
  not on a mounted host checkout. `bind_mounts:` is not needed and
  doesn't help: the worktree pattern lets the agent commit + push +
  open a PR using its own git identity without touching host state.
- **"Admin agent should deploy a merged change (`switchroom apply`,
  `agent restart`, `update apply`)."** That's the host-control
  daemon's job — see `reference/rfcs/host-control-daemon.md`. `bind_mounts:`
  does not give an agent host-side control; even with the source
  tree mounted, the agent can't run docker commands or `sudo` on
  the host. The daemon is the right surface.
- **"Operator + agent need to share a host directory that isn't a
  git repo and isn't operator config."** *That's* what `bind_mounts:`
  is for. Examples: a shared `~/shared/notes` dir two agents
  collaborate in; a read-only NAS path; a small operator file the
  agent maintains.

If none of the above fit and you still want filesystem reach for a
non-admin agent, the right answer is to run a separate Claude
session from outside switchroom (a host shell), not to relax the
admin gate.

### Shape

```yaml
agents:
  collab-bot:
    admin: true                      # required — see "Admin gating" below
    bind_mounts:
      - source: /home/me/shared/notes
        target: /home/agent/notes    # optional; defaults to `source`
        mode: rw                     # default is `ro`
    add_dirs:
      - /home/me/shared/notes        # also extend claude's tool-reach
```

Each entry takes:

- **`source:`** (required) — absolute host path. Tilde-expansion is
  **not** performed; pass the literal path. Refused if the path is
  under a system-path denylist (`/`, `/etc`, `/proc`, `/sys`, `/dev`,
  `/run`, `/var/run`, `/boot`, `/var/lib/docker`) or equals
  `/var/run/docker.sock`. Repeated `/`, `.` segments, and trailing
  `/` are normalized before the denylist check, so `//etc`,
  `/etc/.`, and `/etc/` are all refused as expected.
- **`target:`** (optional) — container path the mount appears at.
  Defaults to the same path as `source`, matching switchroom's
  existing dual-mount convention so absolute paths in scaffolded
  scripts and tool invocations Just Work. Refused if it shadows a
  switchroom-owned container path (`/state`, `/run/switchroom`,
  `/opt/switchroom`, `/var/log/switchroom`) or an OS path inside
  the container (`/etc`, `/bin`, `/sbin`, `/usr/{bin,sbin,lib}`,
  `/lib`, `/lib64`, `/proc`, `/sys`, `/dev`, `/boot`).
- **`mode:`** (optional, default `ro`) — `ro` or `rw`.

> **Note (symlinks):** the source-path denylist is *textual*. If
> `source` points at a host path that is itself a symlink to a
> denylisted directory (e.g. `/home/me/proj` → `/etc`), Docker
> resolves the symlink at mount time and the agent ends up with
> `/etc` regardless. Admin-trusted: the operator who set `admin:
> true` is the same principal who controls host filesystem layout,
> so the textual check is the right tradeoff against doing
> `fs.realpathSync` in the compose generator (which would couple
> compose generation to filesystem state). If you want defense
> here, declare absolute paths only and avoid symlinking your
> mount sources.

### Admin gating

`bind_mounts:` requires `admin: true` on the same agent. `switchroom
apply` hard-fails if a non-admin agent declares it — silently
dropping the entries would mask an intended privilege grant. The two
are coupled deliberately: the same operator who already trusts an
agent with vault grant-management (`/grant`) and fleet-admin slash
commands (`/agents`, `/logs`, `/update`) is the right principal for
extra-bind-mount access.

### Pair with `add_dirs:`

`bind_mounts:` makes the path **exist** inside the container.
`add_dirs:` makes the claude CLI's tool-allowlist **include** it.
You typically want both. Without `add_dirs:`, claude's Read/Edit
tools will reject the path as outside the working set even though
the file is there. Without `bind_mounts:`, the path doesn't exist in
the sandbox and `add_dirs:` is a no-op.

## Notion Workspace (`notion_workspace:`)

The Notion integration (`reference/rfcs/notion-integration.md`) is configured
with one top-level block + one per-agent block. Unlike
`google_workspace` / `microsoft_workspace`, there's no per-account
concept — one integration token = one Notion workspace.

```yaml
notion_workspace:
  # vault key holding the integration token (default shown).
  vault_key: notion/integration-token

  # friendly-name → Notion-DB-UUID map. Source of truth for the fleet.
  # Populate with `switchroom notion list-dbs` after putting the
  # integration token in the vault.
  databases:
    essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
    tasks:  "b2c3d4e5-f6a7-8901-2345-67890abcdef0"

  # OPTIONAL — pin a non-default @notionhq/notion-mcp-server version.
  # mcp_version: 1.8.1

  # OPTIONAL — global rate-limit budget (rps), shared across all agents.
  # Defaults to 3 (Notion's documented public-API limit). Lower it if
  # you also use the integration token from outside switchroom.
  # rate_limit_rps: 3
```

Per-agent grant:

```yaml
agents:
  clerk:
    notion_workspace: {}              # full access (within upstream-shared set)
  carrie:
    notion_workspace:
      databases: [essays]             # restrict to essays DB only
```

| Field | Cascade mode | Notes |
|---|---|---|
| `notion_workspace.vault_key` | override | Top-level only; per-agent override not supported. |
| `notion_workspace.databases` (top-level map) | deep merge | Profile-level entries merge with top-level. |
| `agents.<name>.notion_workspace.databases` (list) | **override** | Per-agent list REPLACES the parent (profile) list, not concatenate — so a specialist agent inheriting a profile can narrow access. |
| `notion_workspace.mcp_version` | override | Top-level only. |
| `notion_workspace.rate_limit_rps` | override | Top-level only. |

The `notion_workspace` per-agent block has two valid shapes:

- `notion_workspace: {}` — opt in, full access (within whatever the
  upstream integration was shared with in Notion's UI).
- `notion_workspace: { databases: [name, …] }` — opt in, restricted.
  Names must resolve in top-level `notion_workspace.databases`; an
  empty list `[]` is rejected at config-load time.

Absent: agent has no Notion access (no MCP entry scaffolded, no
broker grant, no hook installed).

### Per-agent ACL (vault key + YAML config)

The broker ACL on `notion/integration-token` (set via
`switchroom vault set notion/integration-token --allow <agent1>,<agent2>`) AND the agent's
`notion_workspace:` YAML config must agree. Drift is caught by the
doctor probe `notion:vault-acl-aligned` (RFC §9). If you add an agent
to one without the other, the launcher fails 503 at runtime; doctor
surfaces this at config-edit time.

Setup walkthrough:
[`docs/notion-integration.md`](notion-integration.md).

## Fleet Health (`fleet_health:`)

Fleet Health is the operator-facing, job-spec-anchored issue tracker: the
fleet watches itself against the jobs in `reference/jobs/`, ranks its own
recurring failures by impact, and surfaces them on the admin **Fleet Health**
page (design: [`reference/rfcs/fleet-health.md`](../reference/rfcs/fleet-health.md),
serves the job spec `fleet-stays-healthy`).

It is **top-level and operator-owned** — not part of the per-agent
`defaults → profiles → agents` cascade. The one field assigns WHICH agent
owns the detection work, so every scan and deep-dive is attributable and
on-leash.

| Field | Cascade | Description |
|-------|---------|-------------|
| `fleet_health.owner_agent` | override (top-level only) | The admin agent that runs the nightly model-free sensor + weekly budgeted deep-dive that populate `~/.switchroom/fleet-health/ledger.json`. Default **unset** → the feature is inert: no crons scheduled, the admin page renders its empty state. The named agent must be `admin: true`. A dedicated owner (not any admin) keeps the fleet-health memory scoped and the token spend accountable. The detection runs **only** as operator-set schedules on this agent — never a self-authored loop. |

The ledger at `~/.switchroom/fleet-health/ledger.json` is per-deployment state
written by the owner agent; it is **never committed to the repo** (same rule
as agent scaffolds and the scheduler ledger). The admin page reads it
read-only and ranks the 22 job records worst-first by `priority_score`
(`severity × frequency × reach × recency`).

```yaml
fleet_health:
  owner_agent: klanker   # admin: true; runs the sensor + deep-dive crons
```

The live detection pipeline (the `switchroom fleet-health` CLI, the scoring, the
GitHub issue lifecycle, and the two owner-agent crons) is documented in
[`fleet-health.md`](./fleet-health.md).

## Minimal Example

```yaml
switchroom:
  version: 1

telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "-1001234567890"

memory:
  backend: hindsight

agents:
  assistant:
    topic_name: "General"
```

Two lines per agent. Everything else inherited from sensible defaults.
