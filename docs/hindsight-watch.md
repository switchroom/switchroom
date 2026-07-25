# hindsight-watch — the memory-backend watchdog

`switchroom hindsight-watch` is a **model-free** check that answers one
question on a schedule: *is the fleet's memory backend actually storing
memories?*

It exists because it was once possible for ~28 % of retains to fail for weeks
without anyone noticing — the telemetry was there (hindsight exports 28 metric
families on `/metrics`, and `switchroom doctor` already counts the spool), but
nothing **watched** it and nothing **told a human**. This closes that gap:
a deterministic check on a cron, alerting through the same gateway relay
hostd's degraded-boot notice uses.

Jobs served: `reference/jobs/fleet-stays-healthy.md` (the fleet watches
itself) in service of `reference/jobs/remember-across-sessions.md`.

## What it costs

Per tick: one HTTP GET of `/metrics`, one `docker inspect`, and one `readdir`
per agent. Zero model tokens — no session, no LLM call, ever. At the
recommended 15-minute cadence that is 4 requests an hour against a backend
whose own workers issue thousands.

## Signals

| Signal | Fires when | Kind |
|---|---|---|
| `probe` | `/metrics` unreachable, unparseable, or missing the retain series; `docker inspect` fails; the agents dir is unreadable | level |
| `retain-failure-rate` | ≥10 % of retains in the rolling window failed | level |
| `retain-queue-growth` | spool ≥100 deep **and** grew by ≥max(20, 10 %) across the window | level |
| `retain-dead` | any new `*.json.dead` marker (a permanently lost memory) | edge |
| `container` | `switchroom-hindsight` unhealthy, restarted, or recreated | edge |
| `retain-latency-p95` | retain p95 ≥120 s (the largest bucket the histogram resolves) | level |

A **level** signal needs two consecutive breaching evaluations to fire; an
**edge** signal fires on the first, because it reports a discrete event that
already happened and cannot flap.

`no-data` is a third, inert state: an idle hindsight neither fires an alert
nor silently resolves one.

## Thresholds and where each number came from

Every constant lives in `src/hindsight-watch/thresholds.ts` with its
measurement in the doc comment. Summary:

- **10 % failure rate** — the storm ran at 66–100 % daily; the worst healthy
  hour measured 2.7 %. 10 % sits an order of magnitude above normal noise and
  an order of magnitude below the incident.
- **20-retain sample floor** — a "50 % failure rate" over two retains is
  noise, and hindsight goes genuinely idle overnight.
- **spool floor 100 + growth ≥max(20, 10 %)** — the spool is a *retry queue*:
  non-zero is normal, draining is healthy. Growth is measured newest-versus-
  window-start so a drain (5 636 → 616, observed live) stays silent.
- **p95 ≥120 s** — measured steady-state retain p95 is ~70 s and the client
  timeout is 300 s (`HINDSIGHT_API_RETAIN_LLM_TIMEOUT`). 120 s is the top
  finite histogram bucket, so it is both a real early warning and the largest
  latency the exposition can resolve.
- **window: 8 samples, max 3 h old** — 2 h at a 15-minute cadence, with the
  age cap so a stopped cron re-baselines instead of paging about a stale era.
- **re-notify quiet period: 6 h** — a firing signal DMs once, then at most
  once per 6 h while it stays firing.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | ran, nothing firing |
| `10` | ran, at least one signal firing |
| `1` | could **not** complete — probe failure, unwritable state, or an alert that reached no gateway |

Exit `1` is deliberate and loud: a watchdog that cannot see, or cannot speak,
is an incident rather than a no-op. An undelivered alert is never recorded as
notified — the next tick retries it.

## Arming it (operator)

1. Dry-run first — evaluates and prints, sends nothing, writes no state:

   ```bash
   switchroom hindsight-watch --dry-run
   ```

2. Install the cron (15-minute cadence, `flock` so ticks cannot overlap):

   ```
   # /etc/cron.d/hindsight-watch
   */15 * * * * kenthompson /usr/bin/flock -n /run/lock/hindsight-watch.lock \
     /usr/local/bin/switchroom hindsight-watch \
     >> /var/log/hindsight-watch.log 2>&1
   ```

   Run it as the **operator** user, not root: the state file and the agents
   scaffold both live under the operator's `~/.switchroom`.

3. Confirm delivery by watching the log for the first tick, and
   `~/.switchroom/hindsight-watch/state.json` for the persisted window.

Alerts arrive as a plain operator DM through the first agent gateway socket
that accepts them. The gateway fences delivery to its own operator chat, so
the watchdog cannot address a foreign chat.

## Flags

```
--dry-run             evaluate and print; send no DM and write no state
--json                machine-readable output
--metrics-url <url>   default http://127.0.0.1:18888/metrics
--container <name>    default switchroom-hindsight
--state <path>        default ~/.switchroom/hindsight-watch/state.json
--agents-dir <path>   default ~/.switchroom/agents
```
