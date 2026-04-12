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
 * Subset of AgentSchema fields that can be set at the global `defaults:`
 * level in clerk.yaml. Every field is optional and no zod defaults are
 * applied — `mergeAgentConfig` (src/config/merge.ts) layers the parsed
 * defaults onto each per-agent config before scaffold/reconcile runs.
 *
 * Per-agent-only fields (topic_name, topic_emoji, topic_id) are
 * intentionally excluded because they're identity-ish — defaulting a
 * topic name across all agents would collapse them onto the same
 * Telegram thread.
 */
export const AgentDefaultsSchema = z
  .object({
    template: z.string().optional(),
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
    model: z.string().optional(),
    mcp_servers: z.record(z.string(), z.unknown()).optional(),
    dangerous_mode: z.boolean().optional(),
    skip_permission_prompt: z.boolean().optional(),
    use_clerk_plugin: z.boolean().optional(),
  })
  .optional();

/**
 * Fallback template name when neither an agent's config nor the global
 * `defaults:` block specifies one. Consumers should read template via
 * `agentConfig.template ?? DEFAULT_TEMPLATE` to get the effective value.
 *
 * We keep this as an explicit constant (rather than a zod default) so
 * the `defaults.template` cascade can actually reach an agent whose
 * field is left unset — zod defaults would fire at parse time and
 * make the agent's template indistinguishable from an explicit choice.
 */
export const DEFAULT_TEMPLATE = "default";

export const AgentSchema = z.object({
  template: z
    .string()
    .optional()
    .describe(
      "Template to scaffold from (e.g., 'health-coach'). " +
      "Defaults to 'default' via DEFAULT_TEMPLATE if unset at both " +
      "agent and clerk.yaml `defaults:` levels.",
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
    .optional()
    .describe("Claude model override (e.g., 'claude-sonnet-4-6')"),
  mcp_servers: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional MCP server configurations"),
  dangerous_mode: z
    .boolean()
    .optional()
    .describe("If true, include --dangerously-skip-permissions in start.sh"),
  skip_permission_prompt: z
    .boolean()
    .optional()
    .describe("If true, add skipDangerousModePermissionPrompt to settings.json"),
  use_clerk_plugin: z
    .boolean()
    .optional()
    .describe("If true, use clerk's enhanced Telegram plugin instead of the official one (requires native Linux for auto-accept)"),
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
      .default("~/.clerk/agents")
      .describe("Base directory for agent installations"),
  }),
  telegram: TelegramConfigSchema,
  memory: MemoryBackendConfigSchema.optional(),
  vault: VaultConfigSchema.optional(),
  defaults: AgentDefaultsSchema.describe(
    "Global defaults merged into every agent before per-agent config. " +
    "Tools, mcp_servers, and schedule are unioned/concatenated; scalars and " +
    "nested objects are shallow-merged with per-agent values winning.",
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
export type AgentSoul = z.infer<typeof AgentSoulSchema>;
export type AgentTools = z.infer<typeof AgentToolsSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type MemoryBackendConfig = z.infer<typeof MemoryBackendConfigSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
