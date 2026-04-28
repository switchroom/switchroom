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

export const ScheduleEntrySchema = z.object({
  cron: z.string().describe("Cron expression (e.g., '0 8 * * *')"),
  prompt: z.string().describe("Prompt to send at the scheduled time"),
  model: z
    .string()
    .optional()
    .describe(
      "Model for this task. Defaults to claude-sonnet-4-6 (cheap, fast). " +
      "Use claude-opus-4-6 for tasks needing complex reasoning.",
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
  suppress_stdout: z
    .boolean()
    .default(false)
    .describe(
      "DEPRECATED — accepted but ignored as of #269. All cron tasks now " +
      "deliver their Telegram message via the MCP `reply` tool, with stdout " +
      "always discarded. Existing configs that set this field will not error, " +
      "but the value has no effect. The field will be removed in a future " +
      "release.",
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
        "How to resume the next session. 'auto' (default) uses --continue " +
        "when the latest JSONL is smaller than resume_max_bytes, else " +
        "falls back to the summarized handoff briefing. 'continue' always " +
        "passes --continue. 'handoff' always uses the summarized briefing. " +
        "'none' starts fresh every time.",
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
    })
    .optional(),
  schedule: z.array(ScheduleEntrySchema).optional(),
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
  topic_name: z.string().describe("Telegram forum topic display name"),
  topic_emoji: z
    .string()
    .optional()
    .describe("Emoji for the topic (e.g., '🏋️')"),
  topic_id: z
    .number()
    .optional()
    .describe("Telegram topic thread ID (auto-populated by switchroom topics sync)"),
  soul: AgentSoulSchema,
  tools: AgentToolsSchema,
  memory: AgentMemorySchema,
  schedule: z.array(ScheduleEntrySchema).default([]),
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
    .describe("If true, add skipDangerousModePermissionPrompt to settings.json"),
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
    .default("~/.switchroom/vault.enc")
    .describe("Path to encrypted vault file"),
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
        "Auto-unlock the broker at start via systemd LoadCredentialEncrypted=. " +
        "Off by default. When enabled, broker reads the passphrase from " +
        "$CREDENTIALS_DIRECTORY/vault-passphrase. Run `switchroom vault " +
        "broker enable-auto-unlock` once to set up the encrypted credential."
      ),
      autoUnlockCredentialPath: z.string().default("~/.config/credstore.encrypted/vault-passphrase").describe(
        "Path to the systemd-creds-encrypted passphrase file. Default is " +
        "the systemd-idiomatic user credential store. Tilde-expansion happens " +
        "at install time."
      ),
    })
    .default({})
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
  quota: QuotaConfigSchema.optional().describe(
    "Optional weekly/monthly USD spend budgets rendered in the session " +
    "greeting. Usage is read from ccusage at runtime; no network calls.",
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
export type VaultBrokerConfig = z.infer<typeof VaultConfigSchema>["broker"];
export type QuotaConfig = z.infer<typeof QuotaConfigSchema>;
export type CodeRepoEntry = z.infer<typeof CodeRepoEntrySchema>;
export type AgentRepoEntry = NonNullable<z.infer<typeof AgentSchema>["repos"]>[string];
