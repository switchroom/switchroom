# PostHog Analytics, Error Tracking & Logs

Switchroom reports anonymous usage and error telemetry to PostHog so we can
catch regressions and understand how the CLI is used in the wild. This file is
the source of truth for agents and humans editing any telemetry code.

## Scope

Three PostHog products are wired in:

| Product          | SDK / Transport                     | Default   |
|------------------|-------------------------------------|-----------|
| Product analytics| `posthog-node` (`captureImmediate`) | Enabled   |
| Error tracking   | `posthog-node` (`captureException`) | Enabled   |
| Logs             | OpenTelemetry OTLP/HTTP             | Off (opt-in) |

## Where the code lives

- [`src/analytics/posthog.ts`](../src/analytics/posthog.ts) — singleton PostHog client, `captureEvent`, `captureException`, `installGlobalErrorHandlers`, `shutdownAnalytics`.
- [`src/analytics/logs.ts`](../src/analytics/logs.ts) — OTel log forwarder (`initLogs`, `getLogger`, `shutdownLogs`). Lazy imports keep OTel out of short-lived CLI commands.
- [`src/cli/index.ts`](../src/cli/index.ts) — installs global error handlers and a `preAction` hook that fires `cli_command_invoked` on every command.

## Environment variables

| Variable                          | Default                         | Purpose                                   |
|-----------------------------------|---------------------------------|-------------------------------------------|
| `SWITCHROOM_POSTHOG_KEY`          | baked-in project token          | Override the PostHog project API key.     |
| `SWITCHROOM_POSTHOG_HOST`         | `https://us.i.posthog.com`      | Override the PostHog host (use EU if needed). |
| `SWITCHROOM_TELEMETRY_DISABLED`   | `0`                             | Set to `1` to disable **all** telemetry.  |
| `SWITCHROOM_LOGS_ENABLED`         | `0`                             | Set to `1` to enable OTel log forwarding. |

The project token (`phc_*`) is public — it's safe to bake into distributed
builds. PostHog rejects writes to any project you're not authorised for.

## Distinct ID

A random UUID is generated on first run and persisted at
`~/.switchroom/analytics-id`. That file is the only personally identifiable
value we keep. It's not tied to any OS-level identifier (username, MAC, etc.).

If you run `switchroom auth login` and we gain access to a user-scoped identity
in the future, call `client.identify({ distinctId, $anon_distinct_id: <uuid> })`
to merge the anonymous ID into the real one. We don't do that today.

## Event catalogue

Event names use `snake_case` verbs — `<noun>_<past_tense_verb>`.

| Event                   | Source                          | Key properties                                     |
|-------------------------|---------------------------------|----------------------------------------------------|
| `cli_command_invoked`   | [src/cli/index.ts](../src/cli/index.ts) (preAction hook) | `command`, `version`, `node_version`, `platform`   |
| `setup_completed`       | [src/cli/setup.ts](../src/cli/setup.ts)                  | `agent_count`, `interactive`                       |
| `init_completed`        | [src/cli/init.ts](../src/cli/init.ts)                    | `agents_total`, `agents_scaffolded`, `example`     |
| `web_server_started`    | [src/cli/web.ts](../src/cli/web.ts)                      | `port`, `agent_count`, `auth_configured`           |
| `agent_started`         | [src/web/api.ts](../src/web/api.ts)                      | `agent`, `source`                                  |
| `agent_stopped`         | [src/web/api.ts](../src/web/api.ts)                      | `agent`, `source`                                  |
| `agent_restarted`       | [src/web/api.ts](../src/web/api.ts)                      | `agent`, `source`                                  |
| `integration_verified`  | [scripts/posthog-smoke-test.mjs](../scripts/posthog-smoke-test.mjs) | smoke-test only                        |

### Adding a new event

1. Pick a name that matches the `<noun>_<past_tense_verb>` pattern.
2. Call `void captureEvent("my_event", { ... })` at the point the action
   succeeds. Use `void` so the call is fire-and-forget — `captureImmediate`
   under the hood awaits the HTTP response, so the event lands before
   `process.exit()` even without an explicit `await`.
3. Add a row to the table above.
4. If the event is high-value (conversion, churn signal), add an insight to
   the **Switchroom Product** dashboard.

Don't track:
- Passive events like page views or tick loops.
- PII (email, real name, IP address — PostHog auto-captures IP; disable via
  `disableGeoip: true` if that's a concern for your jurisdiction).
- Raw user input or message content.

## Error tracking

Every `Error` that bubbles past `uncaughtException` / `unhandledRejection`
is auto-reported. In addition, action-level boundaries call
`captureException(err, { action: "..." })` to attach useful context.

Current boundaries:

- `src/cli/setup.ts` — setup wizard catch-all (`action: "setup"`)
- `src/cli/init.ts` — init catch-all (`action: "init"`)
- `src/web/api.ts` — agent start/stop/restart handlers

### Adding a new boundary

```ts
import { captureException } from "../analytics/posthog.js";

try {
  await doRiskyThing();
} catch (err) {
  void captureException(err, { action: "risky_thing", foo: "bar" });
  // ... existing error handling ...
}
```

Rules of thumb:
- **Do** add at action boundaries (CLI command top-level, web route handlers, systemd unit entry points).
- **Don't** add to every `catch` block — the global handlers catch anything that escapes, and low-level catches often swallow expected failures.
- **Do** include enough context in `additionalProperties` that you can tell one error from another without reading the stack trace.

## Log forwarding

Logs are off by default because OpenTelemetry pulls in ~65 extra packages. To
enable:

```bash
SWITCHROOM_LOGS_ENABLED=1 switchroom web
```

In long-running surfaces (web server, agent runtimes), call:

```ts
import { initLogs, getLogger, shutdownLogs } from "../analytics/logs.js";

await initLogs("switchroom-web");
const log = await getLogger();
log?.emit({
  severityText: "info",
  body: "server started",
  attributes: { port: 8080 },
});
// ... on exit:
await shutdownLogs();
```

Logs go to `${SWITCHROOM_POSTHOG_HOST}/i/v1/logs` using the project token.

### When to log vs capture an event

- **Event** = discrete user action with properties you'd query as a funnel
  step ("setup_completed", "agent_started"). Used in Product Analytics.
- **Log** = free-form diagnostic output you'd grep through when debugging
  ("config file not found at /path/x", "websocket closed after 3s").

If you're tempted to capture an event for an error, use `captureException`
instead — it's its own product in PostHog and has deduplication + issue
grouping.

## Shutdown semantics

- CLI commands: `captureImmediate` awaits HTTP before the action runs, so
  events are delivered before any `process.exit(code)` call. No explicit
  shutdown needed.
- Long-running servers (`switchroom web`, agents): call
  `await shutdownAnalytics()` and `await shutdownLogs()` on `SIGINT`/`SIGTERM`.

## Dashboards

Live in PostHog under the `switchroom` project (id 387841). All three are
pinned. Add new insights via the PostHog MCP (`npx @posthog/wizard mcp add`)
and keep this list in sync with the actual dashboards.

### [Switchroom Product](https://us.posthog.com/project/387841/dashboard/1483940)

Product analytics funnel from install → setup → init → agent running.

| Insight                                                                | Query            |
|------------------------------------------------------------------------|------------------|
| [Daily active users](https://us.posthog.com/project/387841/insights/9PAy6DqN)      | DAU on `cli_command_invoked` |
| [Commands used](https://us.posthog.com/project/387841/insights/b7BBKjSw)           | Total by `command` property |
| [Setup funnel](https://us.posthog.com/project/387841/insights/AfKr1yAT)            | `cli_command_invoked` (command=setup) → `setup_completed` |
| [Init funnel](https://us.posthog.com/project/387841/insights/492QgS1K)             | `cli_command_invoked` (command=init) → `init_completed` |
| [Agent lifecycle actions](https://us.posthog.com/project/387841/insights/rKdIHTCW) | `agent_started` / `agent_stopped` / `agent_restarted` |
| [Platform breakdown](https://us.posthog.com/project/387841/insights/DZe3CyPa)      | DAU breakdown by `platform` |

### [Switchroom Errors](https://us.posthog.com/project/387841/dashboard/1483941)

Error tracking — uncaught exceptions, unhandled rejections, and manual
`captureException` boundaries all land here via `$exception` events.

| Insight                                                                 | Query |
|-------------------------------------------------------------------------|-------|
| [Exceptions over time](https://us.posthog.com/project/387841/insights/kEgfv9Q9)     | Total `$exception` per day |
| [Errors by action boundary](https://us.posthog.com/project/387841/insights/mT2JnemR) | `$exception` breakdown by `action` |
| [Users affected by errors](https://us.posthog.com/project/387841/insights/bPmL9Lqq)  | DAU of `$exception` |
| [Errors by version](https://us.posthog.com/project/387841/insights/7hphD1gG)         | `$exception` breakdown by `version` |

For issue-level triage (grouping, assignment, resolution), use PostHog's
[Error tracking UI](https://us.posthog.com/project/387841/error_tracking).

### [Switchroom Logs](https://us.posthog.com/project/387841/dashboard/1483943)

Log volume from OpenTelemetry. Only populated when `SWITCHROOM_LOGS_ENABLED=1`.

| Insight                                                                  | Query |
|--------------------------------------------------------------------------|-------|
| [Log-emitting surfaces active](https://us.posthog.com/project/387841/insights/7U0vXVaX) | `web_server_started` + `agent_started` — proxy for when long-running processes are emitting logs |

For deeper log analysis, use PostHog's
[Logs UI](https://us.posthog.com/project/387841/logs) — log-level insights
don't embed cleanly as dashboard tiles.

### Editing

If you change event names or properties in the code, update the matching
dashboard's filters — or ask an agent to do it via the PostHog MCP.

## Opt-out

Users can set `SWITCHROOM_TELEMETRY_DISABLED=1` in their shell profile to
silence the client entirely. The wrapper short-circuits before constructing
the PostHog client, so no network calls happen.

## References

- Project skill bundle: <https://github.com/PostHog/skills>
- posthog-node docs: <https://posthog.com/docs/libraries/node>
- PostHog logs (OTel): <https://posthog.com/docs/logs/installation>
- Error tracking: <https://posthog.com/docs/error-tracking>
