# Clerk Management MCP Server

A small MCP server that exposes clerk's memory commands as tools, so Claude
Code agents can search and inspect agent memories without shelling out to
Bash.

## Scope

This server is intentionally narrow: it wraps `clerk memory` only. Agent
lifecycle (`start`/`stop`/`restart`), auth status, and topic listing are
**not** exposed here — they live in the Telegram plugin's `/clerkstart`,
`/stop`, `/restart`, `/auth`, `/topics` slash commands (see
[`telegram-plugin/README.md`](../telegram-plugin/README.md)).

If you want the agent itself to be able to manage other agents, use the
slash commands from chat or grant the agent Bash access to the `clerk` CLI.

## How it works

The server is a thin wrapper around the `clerk` CLI. Each tool invocation
calls the corresponding `clerk` subcommand and returns the output. The
server runs as a child process of each agent via stdio transport.

## Configuration

Set the `CLERK_CONFIG` environment variable to the path of your
`clerk.yaml` file. If not set, the clerk CLI uses its default config
search behavior.

## Available tools

| Tool | Description | Input |
|------|-------------|-------|
| `clerk_memory_search` | Search agent memories via Hindsight | `{ query: string, agent?: string }` |
| `clerk_memory_stats` | Show per-agent memory collection info and stats | none |

## Setup

The server is added to each agent's `settings.json` automatically during
scaffolding. Manual setup:

```json
{
  "mcpServers": {
    "clerk": {
      "command": "bun",
      "args": ["run", "/path/to/clerk-mcp/server.ts"],
      "env": {
        "CLERK_CONFIG": "/path/to/clerk.yaml"
      }
    }
  }
}
```

## Running standalone

```bash
CLERK_CONFIG=/path/to/clerk.yaml bun run server.ts
```
