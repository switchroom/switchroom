import { z } from "zod";

export const ScheduleEntrySchema = z.object({
  cron: z.string().describe("Cron expression (e.g., '0 8 * * *')"),
  prompt: z.string().describe("Prompt to send at the scheduled time"),
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
  })
  .optional();

/**
 * A single hook entry in clerk.yaml. We accept the ergonomic flat form
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
 * Per-event arrays of hook entries. Clerk accepts any Claude Code hook
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
 * Per-channel configuration. Today the only channel is Telegram but
 * the shape is designed to expand (Slack, Discord, Matrix, Email) —
 * each channel lives under its own key with channel-specific options.
 *
 * Telegram options:
 *  - plugin: "clerk" (default) uses the enhanced clerk-telegram MCP
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
      .enum(["clerk", "official"])
      .optional()
      .describe(
        "Which Telegram MCP plugin to load. Default is 'clerk' — the " +
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
 *   1. Inline in clerk.yaml under top-level `profiles: { name: {...} }`
 *   2. As a filesystem directory at `profiles/<name>/` inside the
 *      clerk repo, containing CLAUDE.md.hbs + SOUL.md.hbs + skills/
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
const profileFields = {
  extends: z.string().optional(),
  bot_token: z.string().optional(),
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
  mcp_servers: z.record(z.string(), z.unknown()).optional(),
  hooks: AgentHooksSchema,
  env: z.record(z.string(), z.string()).optional(),
  system_prompt_append: z.string().optional(),
  skills: z.array(z.string()).optional(),
  session: SessionSchema,
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
 * `profiles/default/` directory bundled with clerk.
 */
export const DEFAULT_PROFILE = "default";

export const AgentSchema = z.object({
  extends: z
    .string()
    .optional()
    .describe(
      "Name of a profile to inherit from (e.g., 'coding', 'health-coach'). " +
      "Profiles may be defined inline under clerk.yaml `profiles:` or as a " +
      "filesystem directory `profiles/<name>/`. Defaults to DEFAULT_PROFILE " +
      "('default') when unset.",
    ),
  bot_token: z
    .string()
    .optional()
    .describe("Per-agent Telegram bot token or vault reference (overrides global telegram.bot_token)"),
  topic_name: z.string().describe("Telegram forum topic display name"),
  topic_emoji: z
    .string()
    .optional()
    .describe("Emoji for the topic (e.g., '🏋️')"),
  topic_id: z
    .number()
    .optional()
    .describe("Telegram topic thread ID (auto-populated by clerk topics sync)"),
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
      "Names of skills from clerk.skills_dir to symlink into this " +
      "agent's skills/ directory. Unioned with defaults.skills.",
    ),
  session: SessionSchema.describe(
    "Session lifecycle policy. Controls --continue vs fresh start on " +
    "agent restart based on idle time and turn count thresholds.",
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
  settings_raw: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Escape hatch: raw object deep-merged into the generated " +
      "settings.json as the final step. Use for Claude Code settings " +
      "keys clerk doesn't wrap directly (e.g. effort, apiKeyHelper). " +
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
      "invocation in start.sh. Use for Claude Code CLI flags clerk " +
      "doesn't expose directly (e.g. --effort high, " +
      "--exclude-dynamic-system-prompt-sections)."
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
    .default("~/.clerk/vault.enc")
    .describe("Path to encrypted vault file"),
});

export const ClerkConfigSchema = z.object({
  clerk: z.object({
    version: z.literal(1).describe("Config schema version"),
    agents_dir: z
      .string()
      .regex(
        /^[a-zA-Z0-9~._\-/]+$/,
        "agents_dir must not contain shell-special characters ($, `, \", ', \\, etc.)",
      )
      .default("~/.clerk/agents")
      .describe("Base directory for agent installations"),
    skills_dir: z
      .string()
      .regex(
        /^[a-zA-Z0-9~._\-/]+$/,
        "skills_dir must not contain shell-special characters ($, `, \", ', \\, etc.)",
      )
      .default("~/.clerk/skills")
      .describe(
        "Shared skills pool. Each subdirectory is a named skill " +
        "(matching a clerk.yaml `skills:` entry). Scaffold symlinks " +
        "selected skills into each agent's skills/ directory."
      ),
  }),
  telegram: TelegramConfigSchema,
  memory: MemoryBackendConfigSchema.optional(),
  vault: VaultConfigSchema.optional(),
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
      z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, {
        message: "Agent name must start with a letter/digit and contain only lowercase letters, digits, hyphens, and underscores",
      }),
      AgentSchema,
    )
    .describe("Map of agent name to agent configuration"),
});

export type ClerkConfig = z.infer<typeof ClerkConfigSchema>;
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
