# screen-handoff

Hands an agent's live Bot Screen (its headed browser and desktop) to a person and gets it back.
Hermes already owns the screen, the viewer in the gateway-served Webapp, single-use display tickets
and the human/agent control lease. This plugin adds the two pieces left to the operator:

- **`screen_handoff` tool** (toolset `browser`, so it exists wherever the browser does):
  - `action=link` starts the screen if needed and returns the Webapp URL to send the person, with
    instructions for the agent (open it, choose Take over, finish the step, Hand back; the agent
    ends its turn and waits). An optional `reason` (one short line) is echoed in the instructions.
  - `action=status` reports whether the screen runs, who holds control, and the URL.
  - `action=take_back` returns control to the agent unconditionally.
- **Automatic take-back** (`post_gateway_admission` hook): when an authorised messaging-platform
  message reaches the agent while a human still holds control, control returns to the agent. Local
  Desktop/Webapp turns never fire the hook, so chatting in the Webapp while holding control does not
  revoke it. The hook never handles the message and never blocks a turn.

It never touches tickets, the RFB bridge or sign-in. Disabling the plugin restores Hermes behaviour.

## Enable (off by default)

The bare image does not load it. Mount `plugins/screen-handoff` into the agent's plugin directory
and enable it in the agent config:

```yaml
plugins:
  enabled: [screen-handoff]
  config:
    screen-handoff:
      url: https://agent.example.com/screen/   # optional; defaults to webapp.public_url
      auto_take_back: true                      # optional; false disables the hook
webapp:
  public_url: https://agent.example.com/
```

The URL must be `https://`; without one, `link` returns an error telling the agent to point the
person at the Screen pane in Hermes Desktop. A URL whose path ends in `/screen` is treated as a
screen-only page and the instructions skip the "Bots, then the bot" navigation.

## Relationship to camoufox-desktop

No import or load-order dependency. When both are enabled, `camoufox-desktop` fences the camofox
tools and `browser_vault` writes while a human holds Take over, and names the browser and live tab in
a `screen_handoff action=link` reason. Without it, `screen_handoff` still works.

## Requirements

Hermes core with `tools.bot_desktop` (`lease`, `runtime`), `hermes_cli.config.load_config_readonly`
and the `post_gateway_admission` hook. Missing config or core modules degrade to an error result or a
no-op, never an agent start failure.

Tests: `tests/test_screen_handoff_plugin.py`.
