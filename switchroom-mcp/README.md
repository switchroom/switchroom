# Switchroom Management MCP Server

A small MCP server that exposes switchroom's memory commands as tools, so Claude
Code agents can search and inspect agent memories without shelling out to
Bash.

## Scope

This server is intentionally narrow: it wraps `switchroom memory` only. Agent
lifecycle (`start`/`stop`/`restart`), auth status, and topic listing are
**not** exposed here — they live in the Telegram plugin's `/switchroomstart`,
`/stop`, `/restart`, `/auth`, `/topics` slash commands (see
[`telegram-plugin/README.md`](../telegram-plugin/README.md)).

If you want the agent itself to be able to manage other agents, use the
slash commands from chat or grant the agent Bash access to the `switchroom` CLI.

## How it works

The server is a thin wrapper around the `switchroom` CLI. Each tool invocation
calls the corresponding `switchroom` subcommand and returns the output. The
server runs as a child process of each agent via stdio transport.

## Configuration

Set the `SWITCHROOM_CONFIG` environment variable to the path of your
`switchroom.yaml` file. If not set, the switchroom CLI uses its default config
search behavior.

## Available tools

| Tool | Description | Input |
|------|-------------|-------|
| `switchroom_memory_search` | Search agent memories via Hindsight | `{ query: string, agent?: string }` |
| `switchroom_memory_stats` | Show per-agent memory collection info and stats | none |

## Setup

The server is added to each agent's `settings.json` automatically during
scaffolding. Manual setup:

```json
{
  "mcpServers": {
    "switchroom": {
      "command": "bun",
      "args": ["run", "/path/to/switchroom-mcp/server.ts"],
      "env": {
        "SWITCHROOM_CONFIG": "/path/to/switchroom.yaml"
      }
    }
  }
}
```

## Running standalone

```bash
SWITCHROOM_CONFIG=/path/to/switchroom.yaml bun run server.ts
```
