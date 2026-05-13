import { z } from "zod";

/**
 * A single entry in an agent's code_repos list.
 * Declares a git repo the agent is allowed to claim worktrees from,
 * with an optional short alias and per-repo concurrency cap.
 */
export const CodeRepoEntrySchema = z.object({
  name: z.string().describe("Short alias used when claiming (e.g. 'switchroom')"),
  source: z
    .string()
    .describe("Absolute or home-relative path to the repo (e.g. ~/code/switchroom)"),
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max simultaneous worktrees for this repo (default 5)"),
});

/**
 * A single entry in an agent's bind_mounts list (#1164).
 *
 * Adds a host path to the agent container's bind-mount set, on top of the
 * standard dual-mount baseline (agent state dir, .claude project dir, logs,
 * read-only skills + credentials). Intended use case: dogfooding /
 * self-modification — an admin agent that needs to read or edit the
 * switchroom source tree at `~/code/switchroom`, or another repo not
 * covered by the default mount policy.
 *
 * Admin-gated: the compose generator refuses to emit bind_mounts for an
 * agent without `admin: true`. The denylist (`/`, `/etc`, `/proc`, `/sys`,
 * `/dev`, `/run`, `/var/run`, `/boot`, `/var/lib/docker`, and the docker
 * socket) is enforced in `src/agents/compose.ts`.
 */
export const AgentBindMountSchema = z.object({
  source: z
    .string()
    .describe(
      "Absolute host path to bind-mount into the container. Tilde-expansion " +
      "is not performed — use the literal absolute path (e.g. " +
      "'/home/me/code/switchroom'). The compose generator refuses sources " +
      "under system paths (/, /etc, /proc, /sys, /dev, /run, /var/run, " +
      "/boot, /var/lib/docker) and the docker socket.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "Container path the source mounts to. Must be absolute. Defaults to " +
      "the same path as `source` (matches switchroom's existing dual-mount " +
      "convention so absolute paths in scaffolded scripts Just Work).",
    ),
  mode: z
    .enum(["ro", "rw"])
    .optional()
    .describe(
      "Read-only (default) or read-write. Use `rw` only when the agent " +
      "must mutate the host path (e.g. editing switchroom source). " +
      "Default: 'ro'.",
    ),
});

export const ScheduleEntrySchema = z.object({
  cron: z.string().describe("Cron expression (e.g., '0 8 * * *')"),
  prompt: z.string().describe("Prompt to send at the scheduled time"),
  model: z
    .string()
    .optional()
    .describe(
      "Model for this task. Defaults to claude-sonnet-4-6 (cheap, fast). " +
      "Use claude-opus-4-7 for tasks needing complex reasoning.",
    ),
  secrets: z
    .array(z.string().regex(/^[a-zA-Z0-9_\-/]+$/, "Secret key names must contain only alphanumeric characters, underscores, hyphens, and forward slashes"))
    .default([])
    .describe(
      "Vault key names this cron task may read via the vault-broker daemon. " +
      "Empty by default — broker requests for unlisted keys are denied. " +
      "Note: this is misconfiguration protection (a typo in cron-A doesn't " +
      "accidentally read cron-B's keys) rather than a security boundary — " +
      "anyone who can edit cron scripts can also edit switchroom.yaml, and " +
      "anyone with the vault passphrase can read the vault file directly. " +
      "See docs/configuration.md for the full framing.",
    ),
});

export const AgentSoulSchema = z
  .object({
    name: z.string().describe("Agent persona name (e.g., 'Coach', 'Sage')"),
    style: z.string().describe("Communication style description"),
    boundaries: z
      .string()
      .optional()
      .describe("Behavioral boundaries and disclaimers"),
  })
  .optional();

export const AgentToolsSchema = z
  .object({
    allow: z
      .array(z.string())
      .default([])
      .describe("Allowed tools (use ['all'] for unrestricted)"),
    deny: z
      .array(z.string())
      .default([])
      .describe("Denied tools (overrides allow)"),
  })
  .optional();

export const AgentMemorySchema = z
  .object({
    collection: z.string().describe("Hindsight collection name for this agent"),
    auto_recall: z
      .boolean()
      .default(true)
      .describe("Auto-search memories before each response"),
    isolation: z
      .enum(["default", "strict"])
      .default("default")
      .describe(
        "strict = never shared cross-agent, default = eligible for reflect"
      ),
    bank_mission: z
      .string()
      .optional()
      .describe("Bank-level mission statement used during recall to contextualize results"),
    retain_mission: z
      .string()
      .optional()
      .describe("Instructions for the fact extraction LLM during retain"),
    recall: z
      .object({
        max_memories: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Cap on the number of memories injected into the prompt by " +
            "auto-recall, regardless of token budget. Plugin default is 12. " +
            "0 disables the cap (all memories Hindsight returns are injected).",
          ),
        cache_ttl_secs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Per-session recall cache TTL in seconds. When > 0, identical " +
            "(prompt, bank) within the same session reuse the cached recall " +
            "result instead of round-tripping to Hindsight. 0 disables. " +
            "Default is 600 (10 min) for switchroom-managed agents.",
          ),
        min_overlap: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Minimum Jaccard token overlap [0.0–1.0] between the user " +
            "prompt and a memory's text for the memory to be injected. " +
            "Drops low-relevance matches before the count cap so weak hits " +
            "don't fill the slot on real queries. 0.0 disables (default — " +
            "current behaviour). Try 0.10–0.20 to start; observe the " +
            "`overlap_dropped` field via `switchroom memory recall-log`.",
          ),
      })
      .optional()
      .describe("Auto-recall tuning knobs"),
  })
  .optional();

/**
 * A single hook entry in switchroom.yaml. We accept the ergonomic flat form
 * (`{ command, timeout?, async?, env?, matcher? }`) and translate to
 * Claude Code's nested `{ hooks: [{ type: "command", ... }] }` shape in
 * scaffold.ts. Keeping the flat form in YAML makes the common case
 * (just run this script on this event) a two-line declaration.
 */
export const HookEntrySchema = z.object({
  command: z.string().describe("Shell command to run. Supports ${CLAUDE_CONFIG_DIR} and ${CLAUDE_PLUGIN_ROOT} substitution."),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in seconds before Claude Code aborts the hook"),
  async: z
    .boolean()
    .optional()
    .describe(
      "If true (valid on Stop only), the hook does not block the agent response"
    ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra env vars passed to the hook process"),
  matcher: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Condition gates (e.g., { channel: 'telegram' })"),
});

/**
 * Per-event arrays of hook entries. Switchroom accepts any Claude Code hook
 * lifecycle event; the list below is the current set as of 2026-04.
 * Unknown event names pass through as-is so future Claude Code events
 * don't break the schema.
 */
export const AgentHooksSchema = z
  .object({
    SessionStart: z.array(HookEntrySchema).optional(),
    UserPromptSubmit: z.array(HookEntrySchema).optional(),
    PreToolUse: z.array(HookEntrySchema).optional(),
    PostToolUse: z.array(HookEntrySchema).optional(),
    Stop: z.array(HookEntrySchema).optional(),
    SessionEnd: z.array(HookEntrySchema).optional(),
  })
  .catchall(z.array(HookEntrySchema))
  .optional();

/**
 * A sub-agent definition that switchroom renders into a
 * `.claude/agents/<name>.md` file. Maps 1:1 onto Claude Code's
 * custom sub-agent frontmatter spec (code.claude.com/docs/en/sub-agents).
 *
 * Only `description` is required here; `name` is derived from the
 * YAML key in `subagents: { <name>: { ... } }`.
 */
export const SubagentSchema = z.object({
  description: z
    .string()
    .describe("When the main agent should delegate to this sub-agent"),
  model: z
    .string()
    .optional()
    .describe("Model: 'sonnet', 'opus', 'haiku', full ID, or 'inherit' (default)"),
  background: z
    .boolean()
    .optional()
    .describe("Run in background by default (non-blocking). Default false"),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe("'worktree' gives the sub-agent its own git branch"),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tool allowlist. Inherits all if omitted"),
  disallowedTools: z
    .array(z.string())
    .optional()
    .describe("Tools to deny (removed from inherited set)"),
  maxTurns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max agentic turns before auto-stop"),
  permissionMode: z
    .enum(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"])
    .optional()
    .describe("Permission mode override for this sub-agent"),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Effort level override"),
  color: z
    .enum(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])
    .optional()
    .describe("Display color in the task list"),
  memory: z
    .enum(["user", "project", "local"])
    .optional()
    .describe("Persistent memory scope for cross-session learning"),
  skills: z
    .array(z.string())
    .optional()
    .describe("Skills to preload into the sub-agent's context"),
  prompt: z
    .string()
    .optional()
    .describe("System prompt (becomes the markdown body after frontmatter)"),
});

/**
 * Session lifecycle policy. Controls whether the agent resumes its
 * previous Claude Code session on restart or starts fresh.
 *
 * At agent startup, start.sh inspects the most recent session JSONL:
 *   - If the session has been idle longer than `max_idle`, start fresh
 *   - If the session has more user turns than `max_turns`, start fresh
 *   - Otherwise, pass `--continue` to resume
 *
 * A fresh session gets a clean context window with Hindsight recall
 * bringing back relevant memories. The previous session's data stays
 * on disk (Claude Code doesn't delete old sessions).
 */
export const SessionSchema = z
  .object({
    max_idle: z
      .string()
      .regex(
        /^\d+[smh]$/,
        "Duration must be a number followed by s, m, or h (e.g. '2h', '30m')",
      )
      .optional()
      .describe(
        "Start a fresh session if the previous one has been idle " +
        "longer than this duration. Examples: '2h', '30m', '7200s'.",
      ),
    max_turns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Start a fresh session if the previous one has more user " +
        "turns than this. Useful for preventing context bloat on " +
        "long-running agents.",
      ),
  })
  .optional();

/**
 * Session-handoff continuity. Fresh sessions start with a clean context
 * window; to avoid losing "where were we?" between sessions, a Stop hook
 * summarizes the previous session into a compact briefing that the next
 * start.sh injects via --append-system-prompt. The telegram plugin also
 * prepends a one-shot "↩️ Picked up where we left off — <topic>" line to
 * the first assistant reply of the new session.
 *
 *   - enabled: master switch. When false, no Stop hook is installed and
 *     start.sh skips all handoff logic.
 *   - show_handoff_line: if false, the plugin still gets the briefing in
 *     its system prompt but suppresses the user-visible continuity line.
 *   - summarizer_model: which Anthropic model produces the briefing.
 *     Haiku is the cost-sensitive default; swap for testing.
 *   - max_turns_in_briefing: hard cap on how many recent user/assistant
 *     turn pairs are fed to the summarizer. Bounds cost and latency.
 */
export const SessionContinuitySchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe("Master switch for the session-handoff briefing (default true)."),
    show_handoff_line: z
      .boolean()
      .optional()
      .describe(
        "Whether the telegram plugin prepends a visible '↩️ Picked up…' " +
        "line to the first assistant reply after a restart (default true).",
      ),
    summarizer_model: z
      .string()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
        "Model name must be alphanumeric with ._-/[]: only",
      )
      .optional()
      .describe("Anthropic model used to produce the handoff briefing."),
    max_turns_in_briefing: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Cap on recent user/assistant turn pairs fed to the summarizer."),
    resume_mode: z
      .enum(["auto", "continue", "handoff", "none"])
      .optional()
      .describe(
        "How to resume the next session. 'handoff' (default as of #362) " +
        "never passes --continue; a fresh Claude starts each restart and " +
        "reads a briefing assembled from recent Telegram messages, Hindsight " +
        "recall, and today's daily memory file. 'auto' uses --continue when " +
        "the latest JSONL is smaller than resume_max_bytes, else falls back " +
        "to the handoff briefing. 'continue' always passes --continue. " +
        "'none' starts completely fresh every time.",
      ),
    resume_max_bytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Byte threshold above which 'auto' mode falls back to handoff " +
        "instead of --continue. Default 2_000_000 (~2MB). Large transcripts " +
        "can blow out the context window even with prefix caching, and " +
        "--continue replay is known-fragile at scale.",
      ),
  })
  .optional();

/**
 * Per-channel configuration. Today the only channel is Telegram but
 * the shape is designed to expand (Slack, Discord, Matrix, Email) —
 * each channel lives under its own key with channel-specific options.
 *
 * Telegram options:
 *  - plugin: "switchroom" (default) uses the enhanced switchroom-telegram MCP
 *    with streaming edits, emoji reactions, SQLite history, formatted
 *    output, and per-agent access control. Loaded via
 *    --dangerously-load-development-channels. "official" falls back to
 *    the upstream plugin:telegram@claude-plugins-official marketplace
 *    plugin (basic send/receive only).
 *  - format: default reply format for the channel. Passed to the
 *    plugin via env var. "html" (default) auto-converts markdown.
 *  - rate_limit_ms: minimum delay between outgoing messages.
 *
 * format and rate_limit_ms are pass-through — the plugin reads them
 * from env vars at startup but may not act on every field yet. We
 * define them in the schema so users can start setting them now.
 */
export const TelegramChannelSchema = z
  .object({
    plugin: z
      .enum(["switchroom", "official"])
      .optional()
      .describe(
        "Which Telegram MCP plugin to load. Default is 'switchroom' — the " +
        "enhanced fork with streaming edits, reactions, history, and " +
        "access control. Set to 'official' for the upstream marketplace " +
        "plugin (basic send/receive only)."
      ),
    format: z
      .enum(["html", "markdownv2", "text"])
      .optional()
      .describe("Default reply format passed to the plugin"),
    rate_limit_ms: z
      .number()
      .optional()
      .describe("Minimum delay between outgoing messages in ms"),
    stream_mode: z
      .enum(["pty", "checklist"])
      .optional()
      .describe(
        "How live progress is streamed to Telegram during a turn. " +
        "'pty' (default) surfaces text snapshots of Claude Code's TUI — " +
        "compatible but can flicker as Ink re-renders. 'checklist' drives " +
        "a structured progress card from session-tail events — stable " +
        "order, per-tool status emojis, fires only on semantic transitions."
      ),
    hotReloadStable: z
      .boolean()
      .optional()
      .describe(
        "If true, the stable workspace prefix (AGENTS.md, SOUL.md, USER.md, " +
        "IDENTITY.md, TOOLS.md, HEARTBEAT.md) is re-injected on every turn via " +
        "the UserPromptSubmit hook instead of baked into --append-system-prompt " +
        "at session start. Lets workspace edits propagate without a restart. " +
        "Costs ~5-10% per-turn latency/spend since the stable prefix is no " +
        "longer prompt-cached."
      ),
    /**
     * Progress-card driver tuning. These knobs are only effective when
     * stream_mode is 'checklist' (the default). All values are in
     * milliseconds unless noted. Omit a field to keep the built-in default.
     */
    orphan_promotion_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "How long (ms) a parent turn waits for a sub-agent JSONL watcher " +
        "to deliver sub_agent_started before the heartbeat promotes the spawn " +
        "to a synthesised 'running' row. Default 5000. Set to 0 to disable " +
        "orphan promotion entirely."
      ),
    cold_sub_agent_threshold_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "JSONL-cold threshold (ms). When a running sub-agent emits no events " +
        "for this long, the heartbeat synthesises a turn_end for it so the " +
        "deferred-completion path can proceed. Default 30000. Set to 0 to " +
        "disable the synthetic close."
      ),
    deferred_completion_timeout_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Force-close timeout (ms) for deferred sub-agent completion. After " +
        "the parent turn_end arrives while sub-agents are still running, the " +
        "card is force-closed after this many ms even if sub-agents never " +
        "finish. Watcher-disconnect safety net. Default 180000 (3 min)."
      ),
    sub_agent_tick_interval_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Heartbeat tick interval (ms) for sub-agent rendering. Forces a " +
        "re-render of the elapsed-time counter while sub-agents are running, " +
        "even during silent stretches between tool calls. Default 10000 (10 s). " +
        "Set to 0 to disable the elapsed-ticker path."
      ),
    edit_budget_threshold: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Telegram API edit budget per minute before the progress-card driver " +
        "falls back to a slower coalesce window. When a chat accumulates more " +
        "than this many card edits in the trailing 60 s, the driver switches " +
        "to a wider coalesce interval until the rate drops back. Default 18. " +
        "Increase if your gateway frequently bumps the Telegram edit-rate ceiling " +
        "with many parallel sub-agents; decrease for a more conservative buffer."
      ),
    // progress_card block removed in #1122 PR3 (the pinned progress card
    // was replaced by conversational pacing + silence-poke). Existing
    // YAML files with a stale progress_card key will be silently
    // ignored by Zod's strict-passthrough; intentional — operators
    // don't need to clean their YAML for the upgrade to apply.
    stickers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Sticker aliases for the `send_sticker` MCP tool (#576). Maps a " +
        "short alias name (e.g. 'happy', 'thinking') to a Telegram file_id. " +
        "Operator-curated — capture file_ids from inbound stickers the user " +
        "sends and add them here. The agent calls send_sticker(chat_id, " +
        "alias='happy') and the gateway resolves to the file_id at send " +
        "time. Aliases enable persona-flavored expressiveness without " +
        "exposing raw file_ids in the agent prompt. Personal-assistant / " +
        "health-coach personas benefit; coding agents typically don't " +
        "configure any."
      ),
    voice_in: z
      .object({
        enabled: z.boolean().optional().describe("Master switch for voice-message transcription."),
        provider: z.enum(["openai"]).optional().describe(
          "Transcription provider. Only 'openai' (Whisper API) supported in the spike (#578); " +
          "Groq/Deepgram/local-whisper-cli are follow-up choices.",
        ),
        language: z.string().optional().describe(
          "Optional ISO-639-1 language hint (e.g. 'en', 'fr'). Skips Whisper's auto-detection.",
        ),
      })
      .optional()
      .describe(
        "Inbound voice-message transcription (#578). When enabled, voice/audio " +
        "messages from allowlisted users are downloaded, transcribed via the " +
        "configured provider, and surface to the agent as the user's text. " +
        "API key read from ~/.switchroom/openai-api-key (mode 0600). Off by " +
        "default — opt-in per agent. Cascades from defaults.channels.telegram.voice_in. " +
        "(Migrated from per-agent root in #596 — see consistency unification.)"
      ),
    telegraph: z
      .object({
        enabled: z.boolean().optional().describe("Master switch for Telegraph Instant View publishing."),
        threshold: z.number().int().positive().optional().describe(
          "Char count above which a reply is published to Telegraph instead of " +
          "HTML-chunked into multiple Telegram messages. Default 3000 (≈3 chunks).",
        ),
        short_name: z.string().optional().describe(
          "Telegraph account display name. Defaults to the agent's slug. Used at " +
          "first-publish to lazily create the account; cached thereafter.",
        ),
        author_name: z.string().optional().describe(
          "Telegraph article byline. Defaults to soul.name when set.",
        ),
      })
      .optional()
      .describe(
        "Long-reply publishing via Telegraph (#579). When enabled, replies " +
        "above the threshold publish as a Telegraph article rendered in " +
        "Telegram via native Instant View. Off by default — content " +
        "residency is real for some personas (lawyer, health-coach with PHI). " +
        "Cascades from defaults.channels.telegram.telegraph. " +
        "(Migrated from per-agent root in #596.)"
      ),
    webhook_sources: z
      .array(z.enum(["github", "generic"]))
      .optional()
      .describe(
        "External webhook sources allowed to ingest events into this agent's " +
        "log. POST /webhook/<agent>/<source> on the switchroom web server. " +
        "Each source has its own signature verification ('github' = " +
        "X-Hub-Signature-256 HMAC-SHA256, 'generic' = Bearer token). " +
        "Per-source secret read from ~/.switchroom/webhook-secrets.json " +
        "keyed by [agent][source]. Verified events append to " +
        "<agent>/telegram/webhook-events.jsonl for the agent to read on " +
        "demand. Off by default — webhook is the only untrusted-inbound " +
        "surface in the system, so opt-in is mandatory. " +
        "Cascades from defaults.channels.telegram.webhook_sources. " +
        "(Migrated from per-agent root in #596 — see #577.)",
      ),
    webhook_dispatch: z
      .object({
        github: z
          .array(
            z.object({
              description: z.string().optional(),
              match: z
                .object({
                  event: z.string(),
                  actions: z.array(z.string()).optional(),
                  labels_any: z.array(z.string()).optional(),
                  labels_all: z.array(z.string()).optional(),
                  exclude_authors: z.array(z.string()).optional(),
                })
                .passthrough(),
              prompt: z.string(),
              cooldown: z.string().optional(),
              quiet_hours: z
                .object({
                  start: z.number().int().min(0).max(23),
                  end: z.number().int().min(0).max(23),
                  tz: z.string().optional(),
                })
                .optional(),
              model: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional()
      .describe(
        "Auto-dispatch rules: when a verified webhook event matches a rule, " +
        "spawn a one-shot `claude -p` turn for the agent with the rendered " +
        "prompt. Supports cooldowns, quiet hours, and label/action matchers. " +
        "Off by default — opt in per agent. See src/web/webhook-dispatch.ts.",
      ),
    webhook_rate_limit: z
      .object({
        rpm: z.number().int().positive(),
      })
      .optional()
      .describe(
        "Per-source rate limit for the webhook ingest path (#714). " +
        "Off by default — when this key is absent the handler skips " +
        "rate-limit checks entirely. Opt in by setting `rpm` to an " +
        "integer requests-per-minute (token bucket per (agent, source); " +
        "burst equal to rpm). When enabled, exceeding the limit returns " +
        "429 with Retry-After header; first throttle event per " +
        "(agent, source) per 60s window is written to " +
        "<agent>/telegram/issues.jsonl. " +
        "Cascades from defaults.channels.telegram.webhook_rate_limit.",
      ),
  })
  .optional();

export const ChannelsSchema = z
  .object({
    telegram: TelegramChannelSchema,
  })
  .optional();

/**
 * A Profile is a named bundle of config that agents inherit from via
 * `extends: <name>`. Profiles can be defined two ways:
 *
 *   1. Inline in switchroom.yaml under top-level `profiles: { name: {...} }`
 *   2. As a filesystem directory at `profiles/<name>/` inside the
 *      switchroom repo, containing CLAUDE.md.hbs + SOUL.md.hbs + skills/
 *
 * Inline profiles take priority when both exist with the same name.
 *
 * The schema is the same shape as AgentDefaultsSchema below — every
 * field is optional, no zod defaults — because a profile is literally
 * "a partial agent config". AgentDefaultsSchema is a specialization
 * (the implicit profile that applies to ALL agents).
 *
 * Per-agent-identity fields (topic_name, topic_emoji, topic_id) are
 * intentionally excluded from profiles for the same reason they're
 * excluded from defaults — defaulting a topic name across multiple
 * agents would collapse them onto the same Telegram thread.
 */
/**
 * Rough IANA timezone validator. Accepts canonical Region/City (and
 * Region/Sub/City, e.g. America/Argentina/Buenos_Aires) plus the bare
 * "UTC" string. Explicitly rejects three-letter aliases (EST, PST),
 * bare offsets (UTC+10, +10:00), and empty strings — those are exactly
 * the values that mislead the `date` CLI and Claude Code's clocks in
 * subtle ways on edge-case hosts (Windows-style aliases, containers
 * inheriting a broken $TZ).
 *
 * The pattern is:
 *   - exactly "UTC", OR
 *   - at least one "/"-separated segment group, each segment starting
 *     with a capital and containing [A-Za-z0-9_+-] thereafter.
 *
 * The inner class includes `+-` and `0-9` so real IANA zones like
 * `Etc/GMT+1`, `Etc/GMT-10`, and `America/Port-au-Prince` are accepted.
 * Bare offsets like `UTC+10` and `+10:00` are still rejected because
 * the first (anchored) alternative requires exactly "UTC" and the
 * second requires a capital-letter prefix followed by at least one "/".
 *
 * The "/" requirement is what excludes EST / PST / MST — they have no
 * slash, they aren't "UTC", so they're out. Any real IANA zone carries
 * at least a Region/City pair.
 *
 * Not exhaustive: we don't ship the IANA database itself. If `date -u`
 * accepts a name we reject, add it to the pattern. Cheap validator here
 * beats a 600KB zone bundle we'd never refresh.
 */
const TIMEZONE_REGEX = /^UTC$|^[A-Z][A-Za-z0-9_+-]+(\/[A-Z][A-Za-z0-9_+-]+){1,2}$/;

const ApproverIdSchema = z.union([z.number(), z.string().regex(/^\d+$/)]);

/**
 * Top-level drive config block. Centralizes Google OAuth client credentials
 * and the approver allowlist used by `switchroom drive connect` so operators
 * don't have to manage env vars. The block is optional — when omitted, the
 * CLI falls back to env vars (SWITCHROOM_GOOGLE_CLIENT_ID/_SECRET,
 * SWITCHROOM_APPROVER_USER_ID). When both are set, env wins (deliberate:
 * env is for one-off overrides; config is the persistent baseline).
 */
export const DriveConfigSchema = z
  .object({
    google_client_id: z
      .string()
      .min(1)
      .describe(
        "Google OAuth client ID (literal string or vault reference e.g. 'vault:google-oauth-client-id')"
      ),
    google_client_secret: z
      .string()
      .min(1)
      .describe(
        "Google OAuth client secret (literal string or vault reference e.g. 'vault:google-oauth-client-secret')"
      ),
    approvers: z
      .array(ApproverIdSchema)
      .min(1)
      .describe(
        "Array of numeric Telegram user IDs authorized to approve drive onboarding. " +
        "At least one must be specified."
      ),
  })
  .optional();

/**
 * Per-agent drive override. Currently just narrows the approver set for a
 * single agent. google_client_id/secret are not per-agent — those live at
 * the top level (one OAuth client per switchroom install).
 */
export const AgentDriveConfigSchema = z
  .object({
    approvers: z
      .array(ApproverIdSchema)
      .min(1)
      .optional()
      .describe(
        "Per-agent approver override. When set, replaces (does not extend) " +
        "the top-level drive.approvers list for this agent's onboarding card."
      ),
  })
  .optional();

/**
 * Reaction-trigger configuration — controls when an emoji reaction on a
 * bot message is forwarded to the agent as a synthetic inbound turn
 * (`<channel source="reaction">`). See `docs/configuration.md` and
 * `telegram-plugin/gateway/reaction-trigger.ts`.
 *
 * The reaction-persistence path (`recordReaction` → user_reaction column)
 * is independent of this config — reactions are always persisted regardless
 * of trigger outcome. This block only governs the synthetic-inbound path.
 *
 * Cascade modes:
 *   - enabled / debounce_ms / per_hour_cap / group_admin_only: override.
 *     Simple scalars; agent wins, defaults fall through when unset.
 *   - trigger_emojis: replace (NOT union). Operators must be able to
 *     narrow the allowlist — including to `[]` to disable triggering
 *     without flipping `enabled: false`. A union mode would silently
 *     keep defaults visible, defeating the per-agent narrowing case.
 */
export const ReactionsSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Master switch for the reaction-trigger path. When false, " +
        "reactions are still persisted via recordReaction but never " +
        "dispatched to the agent as synthetic inbound turns. Default true.",
      ),
    trigger_emojis: z
      .array(z.string())
      .optional()
      .describe(
        "Emoji allowlist that triggers a synthetic inbound when reacted " +
        "to a bot message. Default ['👎', '❌', '👍', '✅']. Cascade " +
        "mode: REPLACE (not union) — setting this at a layer replaces " +
        "lower layers entirely, so an operator can narrow to [] to " +
        "disable triggering without flipping `enabled`.",
      ),
    debounce_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Per-chat debounce window in ms. A qualifying reaction holds for " +
        "this long; a second qualifying reaction within the window " +
        "collapses both into a single batched synthetic turn. Default 30000.",
      ),
    per_hour_cap: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Max reaction-triggered synthetic turns per chat per rolling hour. " +
        "Refusals are stderr-logged but not surfaced to the agent. " +
        "Default 10. Set to 0 to disable triggering via the cap path.",
      ),
    group_admin_only: z
      .boolean()
      .optional()
      .describe(
        "In groups/supergroups (negative chat_id), only trigger a synthetic " +
        "turn when the reacter is a chat admin (creator or administrator). " +
        "Failing the lookup is treated as non-admin (fail-closed). " +
        "DMs are never affected by this flag — the reacter IS the user. " +
        "Default true.",
      ),
  })
  .optional();

const profileFields = {
  extends: z.string().optional(),
  bot_token: z.string().optional(),
  timezone: z
    .string()
    .regex(
      TIMEZONE_REGEX,
      "timezone must be an IANA zone name like 'Australia/Melbourne' or 'UTC' " +
      "(three-letter aliases like EST/PST and bare offsets like UTC+10 are not accepted)",
    )
    .optional()
    .describe(
      "IANA timezone name (e.g. 'Australia/Melbourne', 'America/New_York', " +
      "'UTC'). Used to generate the per-turn local-time hint the agent's " +
      "UserPromptSubmit timezone hook emits, and baked into the systemd " +
      "unit as TZ= so subprocess `date`/`Date.now()` are correct. If unset " +
      "at every cascade layer, switchroom auto-detects from /etc/timezone " +
      "and warns on `reconcile` when the detected zone is UTC.",
    ),
  soul: z
    .object({
      name: z.string().optional(),
      style: z.string().optional(),
      boundaries: z.string().optional(),
    })
    .optional(),
  tools: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  memory: z
    .object({
      collection: z.string().optional(),
      auto_recall: z.boolean().optional(),
      isolation: z.enum(["default", "strict"]).optional(),
      recall: z
        .object({
          max_memories: z.number().int().min(0).optional(),
          cache_ttl_secs: z.number().int().min(0).optional(),
          min_overlap: z.number().min(0).max(1).optional(),
        })
        .optional(),
    })
    .optional(),
  schedule: z.array(ScheduleEntrySchema).optional(),
  reactions: ReactionsSchema,
  model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Model name must be alphanumeric with ._-/[]: only",
    )
    .optional(),
  thinking_effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe(
      "Adaptive-thinking effort level passed as --effort to the claude CLI. " +
      "lower = faster/cheaper, higher = more reasoning. Omit to use Claude's default.",
    ),
  permission_mode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
    .optional()
    .describe(
      "Permission mode passed as --permission-mode to the claude CLI. " +
      "Omit to use Claude's default (acceptEdits for switchroom agents). " +
      "Warning: bypassPermissions and dontAsk skip all safety checks — use only in trusted sandboxes.",
    ),
  fallback_model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Fallback model name must be alphanumeric with ._-/[]: only",
    )
    .optional()
    .describe(
      "Fallback model passed as --fallback-model to the claude CLI. " +
      "Used when the primary model is overloaded. Note: only functional in --print (non-interactive) mode per Claude CLI docs; silently no-ops in interactive sessions.",
    ),
  mcp_servers: z.record(z.string(), z.unknown()).optional(),
  hooks: AgentHooksSchema,
  env: z.record(z.string(), z.string()).optional(),
  system_prompt_append: z.string().optional(),
  skills: z.array(z.string()).optional(),
  bundled_skills: z
    .record(z.string(), z.boolean())
    .optional()
    .describe(
      "Opt-out map for switchroom's bundled-default skills " +
      "(e.g. skill-creator, mcp-builder, webapp-testing, pdf, docx, " +
      "xlsx, pptx, switchroom-cli, switchroom-status, switchroom-health). " +
      "Set a key to `false` to suppress that default for this agent. " +
      "Cascades from defaults.bundled_skills.",
    ),
  subagents: z
    .record(z.string(), SubagentSchema)
    .optional()
    .describe("Named sub-agent definitions rendered to .claude/agents/<name>.md"),
  session: SessionSchema,
  session_continuity: SessionContinuitySchema,
  channels: ChannelsSchema,
  dangerous_mode: z.boolean().optional(),
  skip_permission_prompt: z.boolean().optional(),
  settings_raw: z.record(z.string(), z.unknown()).optional(),
  claude_md_raw: z.string().optional(),
  cli_args: z.array(z.string()).optional(),
  extra_stable_files: z
    .array(z.string())
    .optional()
    .describe(
      "Extra filenames (relative to the agent's workspace directory) to append " +
      "to the stable bootstrap render. Loaded once at session start via " +
      "`--append-system-prompt`. Missing files are silently skipped. " +
      "Example: ['BRIEF.md', 'CONTEXT.md'].",
    ),
  resources: z
    .object({
      memory: z
        .string()
        .regex(
          /^\d+(\.\d+)?[kmgKMG]?$/,
          "memory must be a Docker size string like '6g', '512m', '1.5g'",
        )
        .optional()
        .describe(
          "Hard memory cap (Docker `mem_limit` → cgroup memory.max). When the " +
          "container exceeds this, the kernel OOM-kills processes in the cgroup. " +
          "Format: '6g', '1.5g', '512m'. When unset at every cascade layer the " +
          "compose generator falls back to the hard-coded per-profile defaults " +
          "in src/agents/compose.ts (klanker 6g, coding 2g, conversational 1.5g, " +
          "lightweight 1g, default 1.5g).",
        ),
      memory_reservation: z
        .string()
        .regex(
          /^\d+(\.\d+)?[kmgKMG]?$/,
          "memory_reservation must be a Docker size string like '4g', '256m'",
        )
        .optional()
        .describe(
          "Soft memory floor (Docker `mem_reservation` → cgroup memory.low). " +
          "Under host-wide memory pressure, the kernel protects at least this " +
          "much from being reclaimed from the cgroup. Must be ≤ memory. Use to " +
          "keep an agent RAM-resident when the host has other tenants that " +
          "might push the box (Coolify apps, build jobs). Default: unset.",
        ),
      pids_limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max processes the cgroup can spawn (cgroup pids.max). Prevents " +
          "fork bombs and runaway test runners. Counts every process in the " +
          "cgroup including bash subprocesses, claude itself, sidecars, and " +
          "any test/build worker. A typical agent at idle uses ~30 PIDs; " +
          "`npm test`-style workloads can spike to 200+. Set generously " +
          "(2000 is a comfortable cap for test-running agents). Default: " +
          "unset (no cgroup pid cap).",
        ),
      cpus: z
        .number()
        .positive()
        .optional()
        .describe(
          "CPU quota (Docker `cpus`). Fractional values OK (e.g. 0.5, 2.0). " +
          "When unset at every cascade layer the compose generator falls " +
          "back to the per-profile default (klanker/coding 2.0, default 1.0, " +
          "lightweight 0.5).",
        ),
    })
    .optional()
    .describe(
      "Per-agent resource limits. Cascades through defaults → profile → " +
      "per-agent with per-field merge (agent wins on each field independently). " +
      "Any field left unset at every layer falls back to the hard-coded " +
      "per-profile defaults in src/agents/compose.ts.",
    ),
  experimental: z
    .object({
      legacy_pty: z
        .boolean()
        .optional()
        .describe(
          "Opt out of the default tmux supervisor (#725) and run the agent under " +
          "the legacy PTY supervisor instead. Default: false (tmux is the default).",
        ),
      legacy_autoaccept_expect: z
        .boolean()
        .optional()
        .describe(
          "Opt the autoaccept gateway back into the legacy expect-script behaviour " +
          "instead of the tmux send-keys path. Default: false.",
        ),
    })
    .optional()
    .describe(
      "Opt-in flags for experimental / legacy behaviours. Cascades through " +
      "defaults → profile → per-agent.",
    ),
};

/**
 * Profiles are named partial configs that agents inherit from via
 * `extends: <name>`. See `profileFields` above for the full shape.
 */
export const ProfileSchema = z.object(profileFields);

/**
 * AgentDefaultsSchema is the implicit profile applied to every agent
 * before their own per-agent config and their `extends:` target. It
 * has the same shape as a profile but doesn't itself support
 * `extends:` (the defaults block IS the bottom of the cascade).
 */
const { extends: _omitExtends, ...defaultsFields } = profileFields;
export const AgentDefaultsSchema = z.object(defaultsFields).optional();

/**
 * Name of the implicit filesystem profile used when no `extends:`
 * field is declared and no inline profile matches. Corresponds to the
 * `profiles/default/` directory bundled with switchroom.
 */
export const DEFAULT_PROFILE = "default";

export const AgentSchema = z.object({
  extends: z
    .string()
    .optional()
    .describe(
      "Name of a profile to inherit from (e.g., 'coding', 'health-coach'). " +
      "Profiles may be defined inline under switchroom.yaml `profiles:` or as a " +
      "filesystem directory `profiles/<name>/`. Defaults to DEFAULT_PROFILE " +
      "('default') when unset.",
    ),
  bot_token: z
    .string()
    .optional()
    .describe("Per-agent Telegram bot token or vault reference (overrides global telegram.bot_token)"),
  bot_username: z
    .string()
    .optional()
    .describe(
      "Per-agent Telegram bot username (without leading @) when it doesn't " +
      "contain the agent slug. Replaces the default 'username includes slug' " +
      "preflight check with an exact (case-insensitive) match. Use when an " +
      "agent and its bot have intentionally divergent names (e.g. agent " +
      "'lawgpt' paired with bot '@meken_law_bot').",
    ),
  timezone: z
    .string()
    .regex(
      TIMEZONE_REGEX,
      "timezone must be an IANA zone name like 'Australia/Melbourne' or 'UTC' " +
      "(three-letter aliases like EST/PST and bare offsets like UTC+10 are not accepted)",
    )
    .optional()
    .describe(
      "Per-agent IANA timezone override. Wins over any profile/defaults " +
      "value and over the top-level switchroom.timezone global. Controls " +
      "the UserPromptSubmit timezone hook's emitted local time and the " +
      "systemd unit's TZ= env.",
    ),
  auth_label: z
    .string()
    .optional()
    .describe(
      "Human-readable identity for the session-start greeting (e.g. 'user@example.com'). " +
      "Anthropic does not expose a public user-profile endpoint for OAuth tokens, so the " +
      "email/account cannot be read locally; the user declares it here. Appears in the Auth " +
      "row as '✓ max · <label> · expires ...'."
    ),
  auth: z
    .object({
      accounts: z
        .array(z.string())
        .optional()
        .describe(
          "Ordered list of Anthropic account labels (from `~/.switchroom/accounts/`) " +
          "this agent can use. The first non-quota-exhausted account is the active one; " +
          "subsequent entries are auto-fallback targets. switchroom-auth-broker keeps " +
          "`<agentDir>/.claude/credentials.json` in sync with the active account on " +
          "every refresh and on every quota event. When unset, the agent falls back to " +
          "a single 'default' account; if no `default` account exists, the boot self-test " +
          "surfaces a one-line nudge to run `switchroom auth account add`.",
        ),
    })
    .optional()
    .describe(
      "Account routing for switchroom-auth-broker. See " +
      "reference/share-auth-across-the-fleet.md for the unit-of-authentication model.",
    ),
  dm_only: z
    .boolean()
    .optional()
    .describe(
      "Mark this agent as a DM-only bot — has its own bot_token and lives " +
      "exclusively in a private chat with the operator. Suppresses " +
      "scaffolding's default behavior of inheriting the global " +
      "telegram.forum_chat_id into the agent's access.json `groups` entry " +
      "(the forum chat the bot isn't a member of, which would otherwise " +
      "trigger a 'boot-probe-failed: 400 chat not found' warning every " +
      "restart). topic_name is still schema-required but unused — set it " +
      "to a display label like 'DM' for /switchroom status output.",
    ),
  topic_name: z.string().describe("Telegram forum topic display name"),
  topic_emoji: z
    .string()
    .optional()
    .describe("Emoji for the topic (e.g., '🏋️')"),
  purpose: z
    .string()
    .max(140)
    .optional()
    .describe(
      "One-line description of what this agent does (≤140 chars). Shown to " +
      "peer agents when they call the agent-config MCP `peers_list` tool, so " +
      "every agent on the instance can answer 'is there an agent that does X' " +
      "without baking the fleet into prompts. Sourced live from " +
      "switchroom.yaml — never memorized into Hindsight. Falls back to " +
      "`topic_name` when absent.",
    ),
  role: z
    .enum(["assistant", "foreman"])
    .optional()
    .describe(
      "Agent role. Default (omitted) is `assistant` — a fleet agent doing " +
      "user-facing tasks. `foreman` opts the agent in to switchroom's bundled " +
      "operator skills (switchroom-architecture / cli / health / install / manage " +
      "/ status), auto-symlinked into the agent's .claude/skills/ on scaffold and " +
      "reconcile. Fleet agents (assistant role) get no operator skills; reconcile " +
      "actively retracts them if the role flips back. See docs/skills.md for the model.",
    ),
  topic_id: z
    .number()
    .optional()
    .describe("Telegram topic thread ID (auto-populated by switchroom topics sync)"),
  // ─── Deprecated locations (#596) — read but migrate ──────────────────────
  // These three fields originally lived at the per-agent root. They've
  // moved under `channels.telegram.*` to inherit the cascade like every
  // other adjacent feature. The root locations stay for backwards-compat
  // but the resolved-config layer (mergeAgentConfig) folds them into the
  // canonical channels.telegram.* spot and logs a deprecation warning.
  // Remove these fields once no live switchroom.yaml uses them.
  webhook_sources: z
    .array(z.enum(["github", "generic"]))
    .optional()
    .describe(
      "[DEPRECATED — moved to channels.telegram.webhook_sources in #596] " +
      "Old per-agent location. Still read but logs a deprecation warning. " +
      "See channels.telegram.webhook_sources for the canonical spot."
    ),
  voice_in: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(["openai"]).optional(),
      language: z.string().optional(),
    })
    .optional()
    .describe(
      "[DEPRECATED — moved to channels.telegram.voice_in in #596] " +
      "Old per-agent location. Still read but logs a deprecation warning."
    ),
  telegraph: z
    .object({
      enabled: z.boolean().optional(),
      threshold: z.number().int().positive().optional(),
      short_name: z.string().optional(),
      author_name: z.string().optional(),
    })
    .optional()
    .describe(
      "[DEPRECATED — moved to channels.telegram.telegraph in #596] " +
      "Old per-agent location. Still read but logs a deprecation warning."
    ),
  soul: AgentSoulSchema,
  tools: AgentToolsSchema,
  memory: AgentMemorySchema,
  schedule: z.array(ScheduleEntrySchema).default([]),
  reactions: ReactionsSchema,
  model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Model name must be alphanumeric with ._-/[]: only (no spaces or shell specials)",
    )
    .optional()
    .describe("Claude model override (e.g., 'claude-sonnet-4-6')"),
  thinking_effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe(
      "Adaptive-thinking effort level passed as --effort to the claude CLI. " +
      "Per-agent override wins over defaults.thinking_effort. " +
      "lower = faster/cheaper, higher = more reasoning. Omit to use Claude's default.",
    ),
  permission_mode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
    .optional()
    .describe(
      "Permission mode passed as --permission-mode to the claude CLI. " +
      "Per-agent override wins over defaults.permission_mode. " +
      "Warning: bypassPermissions and dontAsk skip all safety checks — use only in trusted sandboxes.",
    ),
  fallback_model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Fallback model name must be alphanumeric with ._-/[]: only",
    )
    .optional()
    .describe(
      "Fallback model passed as --fallback-model to the claude CLI. " +
      "Per-agent override wins over defaults.fallback_model. " +
      "Used when the primary model is overloaded. Note: only functional in --print (non-interactive) mode per Claude CLI docs; silently no-ops in interactive sessions.",
    ),
  mcp_servers: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional MCP server configurations"),
  hooks: AgentHooksSchema.describe(
    "Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, Stop, etc). " +
    "Written to settings.json.hooks in Claude Code's native shape.",
  ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables exported in start.sh before claude runs"),
  system_prompt_append: z
    .string()
    .optional()
    .describe(
      "Text passed via claude's --append-system-prompt flag. " +
      "Appended to the default or CLAUDE.md-derived system prompt.",
    ),
  skills: z
    .array(z.string())
    .optional()
    .describe(
      "Names of skills from switchroom.skills_dir to symlink into this " +
      "agent's skills/ directory. Unioned with defaults.skills.",
    ),
  bundled_skills: z
    .record(z.string(), z.boolean())
    .optional()
    .describe(
      "Per-agent override of switchroom's bundled-default skills " +
      "(skill-creator, mcp-builder, webapp-testing, pdf, docx, xlsx, " +
      "pptx, switchroom-cli/status/health). Set a key to `false` to " +
      "opt out for this agent. Per-agent value wins over defaults.bundled_skills.",
    ),
  humanizer_voice_file: z
    .string()
    .optional()
    .describe(
      "Optional path to a voice-calibration template (markdown). " +
      "When set, exported as HUMANIZER_VOICE_FILE so the bundled " +
      "humanizer skill matches the user's writing style instead of " +
      "applying generic 'human' rules. Generate one with the " +
      "humanizer-calibrate skill, or hand-write it. Resolved relative " +
      "to the agent's directory if not absolute.",
    ),
  subagents: z
    .record(z.string(), SubagentSchema)
    .optional()
    .describe(
      "Sub-agent definitions rendered to .claude/agents/<name>.md. " +
      "Each sub-agent is a specialized worker the main agent can " +
      "delegate to. Merged with defaults/profile sub-agents by name.",
    ),
  session: SessionSchema.describe(
    "Session lifecycle policy. Controls --continue vs fresh start on " +
    "agent restart based on idle time and turn count thresholds.",
  ),
  session_continuity: SessionContinuitySchema.describe(
    "Handoff-briefing settings. When enabled (default), a Stop hook " +
    "summarizes each session at shutdown and start.sh injects that " +
    "briefing into the next session via --append-system-prompt.",
  ),
  channels: ChannelsSchema.describe(
    "Per-channel configuration. Today only `telegram` is defined; the " +
    "shape is designed to expand to other channels (Slack, Discord, " +
    "Matrix, Email) as they're added.",
  ),
  dangerous_mode: z
    .boolean()
    .optional()
    .describe("If true, include --dangerously-skip-permissions in start.sh"),
  skip_permission_prompt: z
    .boolean()
    .optional()
    .describe(
      "DEPRECATED no-op (accepted for backwards compatibility). Claude Code " +
      "ignores skipDangerousModePermissionPrompt at project scope; autoaccept " +
      "(src/agents/autoaccept.ts) handles the bypass-mode prompt instead. " +
      "Safe to remove from switchroom.yaml.",
    ),
  admin: z
    .boolean()
    .optional()
    .describe(
      "If true, the agent's Telegram gateway intercepts admin slash commands " +
      "(/agents, /logs, /restart, /delete, /update, /auth, /reconcile, etc.) " +
      "locally before forwarding to Claude. Commands are handled silently — " +
      "Claude never sees them. Requires the agent to use the switchroom-telegram " +
      "plugin. When false or absent, all messages pass through to Claude unchanged.",
    ),
  settings_raw: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Escape hatch: raw object deep-merged into the generated " +
      "settings.json as the final step. Use for Claude Code settings " +
      "keys switchroom doesn't wrap directly (e.g. effort, apiKeyHelper). " +
      "Power-user-only — prefer the typed fields when they exist."
    ),
  claude_md_raw: z
    .string()
    .optional()
    .describe(
      "Escape hatch: markdown text appended verbatim to CLAUDE.md on " +
      "initial scaffold. Not re-applied on reconcile (CLAUDE.md is " +
      "user-protected). Use for one-off persona tuning that isn't " +
      "worth a template."
    ),
  cli_args: z
    .array(z.string())
    .optional()
    .describe(
      "Escape hatch: extra arguments appended to the `exec claude` " +
      "invocation in start.sh. Use for Claude Code CLI flags switchroom " +
      "doesn't expose directly (e.g. --effort high, " +
      "--exclude-dynamic-system-prompt-sections)."
    ),
  add_dirs: z
    .array(z.string())
    .optional()
    .describe(
      "Additional filesystem paths the agent's tools can access. Passed " +
      "as repeated --add-dir <path> on the claude invocation. Use to grant " +
      "an agent reach into shared dirs (e.g. '/share/collab') without " +
      "scaffold hacks. Per-agent only — paths are persona-specific. See #199. " +
      "Note: this only adjusts the claude CLI's --add-dir tool-reach allowlist. " +
      "If the path is not already inside the agent's container, also declare " +
      "it in `bind_mounts:` (admin agents only) — otherwise the path doesn't " +
      "exist inside the sandbox and --add-dir is a no-op."
    ),
  bind_mounts: z
    .array(AgentBindMountSchema)
    .optional()
    .describe(
      "Extra host paths bind-mounted into this agent's container, on top of " +
      "the standard dual-mount baseline. ADMIN-ONLY: the compose generator " +
      "refuses to emit bind_mounts unless `admin: true` is also set on the " +
      "same agent. Use to dogfood / self-modify switchroom or another repo " +
      "(see issue #1164). Pair with `add_dirs:` so claude's tool-reach " +
      "allowlist also covers the mounted path. System paths (/, /etc, " +
      "/proc, /sys, /dev, /run, /var/run, /boot, /var/lib/docker, " +
      "/var/run/docker.sock) are denylisted regardless of mode."
    ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Granular tool allowlist passed verbatim to Claude Code's --allowedTools " +
      "flag. Supports patterns like 'Bash(git *)' or 'Edit(*.md)' that the " +
      "coarse `tools.allow` field can't express. When set, Claude Code OR-merges " +
      "with `tools.allow` (granular only when present, otherwise coarse — chosen " +
      "via #199 to keep blast radius minimal for existing operators on tools.allow). " +
      "See #199."
    ),
  disallowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Granular tool denylist passed verbatim to Claude Code's --disallowedTools " +
      "flag. Same pattern syntax as allowed_tools (e.g. 'Bash(rm *)'). See #199."
    ),
  extra_stable_files: z
    .array(z.string())
    .optional()
    .describe(
      "Extra filenames (relative to the agent's workspace directory) to append " +
      "to the stable bootstrap render. Loaded once at session start via " +
      "`--append-system-prompt`. Missing files are silently skipped. " +
      "Example: ['BRIEF.md', 'CONTEXT.md'].",
    ),
  code_repos: z
    .array(CodeRepoEntrySchema)
    .optional()
    .describe(
      "Git repositories this agent is allowed to claim worktrees from. " +
      "Each entry provides a short name alias, a source path, and an " +
      "optional concurrency cap (default 5). When code_repos is set, " +
      "claim_worktree accepts the alias as the repo argument. " +
      "Absolute paths may always be passed regardless of this list.",
    ),
  drive: AgentDriveConfigSchema.describe(
    "Per-agent drive onboarding overrides (currently just approvers). " +
    "When set, replaces the top-level drive.approvers list for this agent. " +
    "google_client_id/secret are not per-agent — they live at the top level.",
  ),
  repos: z
    .record(
      z.string().regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "Repo slug must be kebab-case ASCII: start with a lowercase letter or digit, contain only lowercase letters, digits, and hyphens",
      ),
      z.object({
        url: z
          .string()
          .min(1)
          .describe(
            "Git remote URL for the repo (e.g. 'git@github.com:org/repo.git' or " +
            "'https://github.com/org/repo.git'). Used verbatim for git clone.",
          ),
        branch_default: z
          .string()
          .optional()
          .describe(
            "Default branch to track (defaults to the remote's HEAD, typically 'main'). " +
            "The per-agent branch 'agent/<agentName>/main' fast-forwards to this branch " +
            "when the worktree is clean on session start.",
          ),
      }),
    )
    .optional()
    .describe(
      "Repos this agent operates on. Switchroom provisions a dedicated worktree for each " +
      "repo at <agentDir>/work/<slug>/ on branch agent/<agentName>/main, backed by a " +
      "shared bare clone at ~/.switchroom/repos/<slug>.git. The worktree path is injected " +
      "into the agent's environment as SWITCHROOM_REPO_<SLUG_UPPER>. " +
      "Agents without this field continue to work unchanged.",
    ),
  experimental: z
    .object({
      legacy_pty: z
        .boolean()
        .optional()
        .describe(
          "Opt out of the default tmux supervisor (#725) and run the agent " +
          "under the legacy PTY supervisor instead. Default: false.",
        ),
      legacy_autoaccept_expect: z
        .boolean()
        .optional()
        .describe(
          "Opt the autoaccept gateway back into the legacy expect-script " +
          "behaviour instead of the tmux send-keys path. Default: false.",
        ),
    })
    .optional()
    .describe(
      "Opt-in flags for experimental / legacy behaviours. Cascades through " +
      "defaults → profile → per-agent.",
    ),
  // Mirror of profileFields.resources — must be repeated here because
  // AgentSchema does not spread profileFields. Without this, the
  // inferred AgentConfig type lacks `resources` and typed reads in
  // compose.ts / merge.ts fail tsc (runtime works because zod doesn't
  // strip unknown keys by default). See profileFields.resources at
  // schema.ts above for the full description; keep the two in sync.
  resources: z
    .object({
      memory: z
        .string()
        .regex(/^\d+(\.\d+)?[kmgKMG]?$/)
        .optional(),
      memory_reservation: z
        .string()
        .regex(/^\d+(\.\d+)?[kmgKMG]?$/)
        .optional(),
      pids_limit: z.number().int().positive().optional(),
      cpus: z.number().positive().optional(),
    })
    .optional(),
});

export const TelegramConfigSchema = z.object({
  bot_token: z
    .string()
    .describe(
      "Telegram bot token or vault reference (e.g., 'vault:telegram-bot-token')"
    ),
  forum_chat_id: z
    .string()
    .describe("Telegram forum group chat ID (negative number as string)"),
});

export const MemoryBackendConfigSchema = z.object({
  backend: z
    .enum(["hindsight", "none"])
    .default("hindsight")
    .describe("Memory backend to use"),
  shared_collection: z
    .string()
    .default("shared")
    .describe("Collection name for cross-agent shared memories"),
  config: z
    .object({
      provider: z
        .string()
        .default("ollama")
        .describe("Embedding provider (ollama, openai, anthropic)"),
      model: z
        .string()
        .optional()
        .describe("Embedding model (e.g., 'nomic-embed-text')"),
      api_key: z
        .string()
        .optional()
        .describe("API key or vault reference for embedding provider"),
      docker_service: z
        .boolean()
        .default(true)
        .describe("Whether to include Hindsight in docker-compose"),
      url: z
        .string()
        .url("Hindsight URL must be a valid URL (no shell-special characters)")
        .optional()
        .describe("Hindsight MCP endpoint URL (e.g., http://localhost:18888/mcp/). Defaults to http://localhost:8888/mcp/."),
    })
    .optional(),
});

export const VaultConfigSchema = z.object({
  path: z
    .string()
    .default("~/.switchroom/vault/vault.enc")
    .describe(
      "Path to encrypted vault file. v0.7.12+ canonical default is " +
      "`~/.switchroom/vault/vault.enc` (parent-dir bind-mount enables " +
      "atomic-rename writes from the broker container). Older installs " +
      "with `~/.switchroom/vault.enc` are auto-migrated on `switchroom " +
      "apply`; the legacy path becomes a symlink for v0.7.10/.11 CLI " +
      "compatibility (sunset in v0.7.14).",
    ),
  broker: z
    .object({
      socket: z
        .string()
        .default("~/.switchroom/vault-broker.sock")
        .describe("Unix domain socket path for the vault-broker daemon"),
      enabled: z
        .boolean()
        .default(true)
        .describe("Whether to start the vault-broker daemon on agent launch"),
      autoUnlock: z.boolean().default(false).describe(
        "Auto-unlock the vault at broker start using a machine-bound " +
        "encrypted blob. Off by default. When enabled, the broker reads " +
        "the configured blob path, derives the AES key from /etc/machine-id, " +
        "decrypts the passphrase, and unlocks the vault — no sudo, no " +
        "systemd-creds, no TPM. Run `switchroom vault broker " +
        "enable-auto-unlock` once to write the blob."
      ),
      autoUnlockCredentialPath: z.string().default("~/.switchroom/vault-auto-unlock").describe(
        "Path to the machine-bound auto-unlock blob (see " +
        "src/vault/auto-unlock.ts for the format). Default lives under " +
        "~/.switchroom so it can be bind-mounted into the vault-broker " +
        "container by docker compose. Tilde-expansion happens " +
        "at read time."
      ),
      approvalAuth: z
        .enum(["passphrase", "telegram-id"])
        .default("passphrase")
        .describe(
          "Posture for tap-to-Approve on vault grant cards. `passphrase` " +
          "(default) prompts the operator to type the vault passphrase on " +
          "every Approve — two-factor (Telegram ID + passphrase). " +
          "`telegram-id` mints immediately on Approve with no passphrase " +
          "prompt — single-factor (Telegram ID only); REQUIRES " +
          "`autoUnlock: true` so the broker already holds the passphrase. " +
          "Trades a factor of security for smoother UX; opt-in only."
        ),
      postureMintAgents: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Per-agent opt-in for posture-attested broker calls (`mint_grant` / " +
          "`list_grants` / `put` with `attest_via_posture: true`). Only agents " +
          "whose names are in this list can use the silent-mint path under " +
          "`approvalAuth: telegram-id`. Default `[]` — no agent can self-mint " +
          "until the operator explicitly opts it in. The request's `agent` " +
          "field must also equal the calling peer's resolved agent name " +
          "(broker rejects cross-agent posture mints). When `approvalAuth` is " +
          "`passphrase` this list is ignored — passphrase attestation still " +
          "works as before. Each entry is an agent slug exactly as it appears " +
          "under `agents:` in this config."
        ),
    })
    .default({})
    .superRefine((broker, ctx) => {
      if (broker.approvalAuth === "telegram-id" && broker.autoUnlock !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "`vault.broker.approvalAuth: telegram-id` requires `autoUnlock: true` — single-factor approval needs the broker already unlocked at startup.",
          path: ["approvalAuth"],
        });
      }
    })
    .describe(
      "Vault-broker daemon configuration. The broker holds the decrypted vault " +
      "in memory and serves secrets to cron scripts via a Unix socket, so the " +
      "vault passphrase is entered once at startup rather than per-cron invocation.",
    ),
});

/**
 * Optional spend budgets used by the session greeting to render a
 * Quota row ("wk $12 / $50 (24%) · mo $103 / $200 (52%)"). Values are
 * in USD and compared against `ccusage` local usage totals at runtime
 * inside the greeting shell script — no network call, no subscription
 * API (Anthropic exposes none). When a budget is unset, the greeting
 * falls back to raw usage without a ratio.
 */
export const QuotaConfigSchema = z.object({
  weekly_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Weekly USD spend budget. If unset, the greeting shows raw usage only."),
  monthly_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Monthly USD spend budget. If unset, the greeting shows raw usage only."),
});

/**
 * Host-control daemon (`switchroom-hostd`) — opt-in Phase 1 surface
 * defined in `docs/rfcs/host-control-daemon.md`. When enabled, the
 * compose generator emits per-agent UDS bind mounts for admin agents
 * so the daemon (a systemd user unit on the host) can dispatch a
 * closed set of operator verbs reached from inside the containers.
 */
export const HostControlConfigSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .describe(
      "Opt-in to the host-control daemon. Default: false. " +
      "When true, the compose generator emits per-agent bind mounts " +
      "at `~/.switchroom/hostd/<name>/sock` for every admin-flagged " +
      "agent. Install the daemon with `switchroom hostd install` — " +
      "it runs as a docker container in its own compose project " +
      "(`switchroom-hostd`), separate from the agent fleet's compose " +
      "project so `up -d --remove-orphans` cycles of the fleet " +
      "can't recreate the daemon mid-RPC. See RFC C §5.1. " +
      "Since Phase 2 (#1175 PR γ) the gateway's /restart, /new, /reset, " +
      "and /update apply slash-commands automatically dispatch through " +
      "hostd when enabled — replacing the in-container " +
      "`spawnSwitchroomDetached` shellout that requires docker access. " +
      "Set enabled: true on docker-mode installs to make those verbs work " +
      "(they otherwise fail because the agent container has no docker " +
      "binary/socket).",
    ),
});

export const SwitchroomConfigSchema = z.object({
  switchroom: z.object({
    version: z.literal(1).describe("Config schema version"),
    agents_dir: z
      .string()
      .regex(
        /^[a-zA-Z0-9~._\-/]+$/,
        "agents_dir must not contain shell-special characters ($, `, \", ', \\, etc.)",
      )
      .default("~/.switchroom/agents")
      .describe("Base directory for agent installations"),
    skills_dir: z
      .string()
      .regex(
        /^[a-zA-Z0-9~._\-/]+$/,
        "skills_dir must not contain shell-special characters ($, `, \", ', \\, etc.)",
      )
      .default("~/.switchroom/skills")
      .describe(
        "Shared skills pool. Each subdirectory is a named skill " +
        "(matching a switchroom.yaml `skills:` entry). Scaffold symlinks " +
        "selected skills into each agent's skills/ directory."
      ),
    timezone: z
      .string()
      .regex(
        TIMEZONE_REGEX,
        "timezone must be an IANA zone name like 'Australia/Melbourne' or 'UTC'",
      )
      .optional()
      .describe(
        "Global default IANA timezone applied to every agent unless the " +
        "agent (or its profile) declares its own. See the per-agent " +
        "timezone field for the full cascade and auto-detection fallback.",
      ),
  }),
  telegram: TelegramConfigSchema,
  memory: MemoryBackendConfigSchema.optional(),
  vault: VaultConfigSchema.optional(),
  drive: DriveConfigSchema.describe(
    "Optional drive onboarding configuration. When set, supplies Google " +
    "OAuth client credentials and the approver allowlist for `switchroom " +
    "drive connect`. Env vars (SWITCHROOM_GOOGLE_CLIENT_ID, " +
    "SWITCHROOM_GOOGLE_CLIENT_SECRET, SWITCHROOM_APPROVER_USER_ID) take " +
    "precedence over this block when set, preserving back-compat with " +
    "the env-only flow shipped in #766.",
  ),
  quota: QuotaConfigSchema.optional().describe(
    "Optional weekly/monthly USD spend budgets rendered in the session " +
    "greeting. Usage is read from ccusage at runtime; no network calls.",
  ),
  host_control: HostControlConfigSchema.optional().describe(
    "Optional host-control daemon configuration. See RFC C " +
    "(docs/rfcs/host-control-daemon.md) and the field-level help on " +
    "`enabled` for the Phase 1 scope.",
  ),
  defaults: AgentDefaultsSchema.describe(
    "Implicit bottom-of-cascade profile applied to every agent before " +
    "per-agent config and `extends:` resolution. Tools, mcp_servers, and " +
    "schedule are unioned/concatenated; scalars and nested objects are " +
    "shallow-merged with per-agent values winning.",
  ),
  profiles: z
    .record(z.string(), ProfileSchema)
    .optional()
    .describe(
      "Named profile definitions. Agents reference via `extends: <name>`. " +
      "Inline profiles declared here take priority over filesystem " +
      "profiles/<name>/ directories when both exist.",
    ),
  agents: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{0,50}$/, {
        message: "Agent name must start with a letter/digit, contain only lowercase letters/digits/hyphens/underscores, and be at most 51 characters (Telegram callback_data byte limit)",
      }),
      AgentSchema,
    )
    .describe("Map of agent name to agent configuration"),
});

export type SwitchroomConfig = z.infer<typeof SwitchroomConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type AgentHooks = z.infer<typeof AgentHooksSchema>;
export type HookEntry = z.infer<typeof HookEntrySchema>;
export type Channels = z.infer<typeof ChannelsSchema>;
export type TelegramChannel = z.infer<typeof TelegramChannelSchema>;
export type AgentSoul = z.infer<typeof AgentSoulSchema>;
export type AgentTools = z.infer<typeof AgentToolsSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type MemoryBackendConfig = z.infer<typeof MemoryBackendConfigSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
export type DriveConfig = z.infer<typeof DriveConfigSchema>;
export type AgentDriveConfig = z.infer<typeof AgentDriveConfigSchema>;
export type VaultBrokerConfig = z.infer<typeof VaultConfigSchema>["broker"];
export type QuotaConfig = z.infer<typeof QuotaConfigSchema>;
export type HostControlConfig = z.infer<typeof HostControlConfigSchema>;
export type CodeRepoEntry = z.infer<typeof CodeRepoEntrySchema>;
export type AgentBindMount = z.infer<typeof AgentBindMountSchema>;
export type AgentRepoEntry = NonNullable<z.infer<typeof AgentSchema>["repos"]>[string];
