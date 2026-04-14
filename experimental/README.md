# Experimental / Archived

These directories contain experimental approaches that are **not used** in the current Switchroom architecture.

Switchroom now uses a **one-bot-per-agent** architecture where each agent runs the official Telegram plugin (`plugin:telegram@claude-plugins-official`) with its own bot token. There is no daemon, no router, and no Unix socket.

## Contents

- **switchroom-daemon/** — Experimental centralized Telegram daemon that would poll Telegram once and route messages to agents via Unix socket. Not used.
- **switchroom-channel/** — Experimental custom MCP channel plugin that would connect agents to the daemon. Not used.
- **architecture-poc/** — Proof-of-concept code for the daemon/router architecture. Not used.

These are kept for reference only. They may be revisited in the future if a shared-bot architecture becomes desirable.
