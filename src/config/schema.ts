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

export const AgentSchema = z.object({
  template: z
    .string()
    .default("default")
    .describe("Template to scaffold from (e.g., 'health-coach')"),
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
export type AgentSoul = z.infer<typeof AgentSoulSchema>;
export type AgentTools = z.infer<typeof AgentToolsSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type MemoryBackendConfig = z.infer<typeof MemoryBackendConfigSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
