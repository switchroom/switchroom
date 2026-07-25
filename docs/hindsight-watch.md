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

Per tick: one HTTP GET of `/metrics` (258 741 B today), one `docker inspect`,
and per agent two `readdir`s plus one small `pending-drops.json` read. No
queue **entry** is ever opened — those carry whole transcripts (p50 ~98 KB).
Zero model tokens — no session, no LLM call, ever. At the recommended
15-minute cadence that is 4 requests an hour against a backend whose own
workers issue thousands.

## Signals

| Signal | Fires when | Kind |
|---|---|---|
| `probe` | `/metrics` unreachable, unparseable, or missing the retain series; `docker inspect` fails; the agents dir is unreadable | level |
| `retain-failure-rate` | ≥10 % of retains in the rolling window failed | level |
| `retain-queue-growth` | spool ≥440 entries deep **and** grew by ≥max(88, 10 %) across the window | level |
| `retain-loss` | any new `*.json.dead` marker, `pending-evicted/` entry, or `pending-drops.json` count — memory that left the queue without being persisted | edge |
| `container` | `switchroom-hindsight` unhealthy, restarted, or recreated | edge |

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
  Re-checked live after #3611: 3 failures in 268 retains = 1.1 %.
- **20-retain sample floor** — a "50 % failure rate" over two retains is
  noise, and hindsight goes genuinely idle overnight. Live throughput is
  ~25 retains per 15-minute tick, so a healthy 2 h window carries ~200.
- **spool floor 440 + growth ≥max(88, 10 %)** — the spool is a *retry queue*:
  non-zero is normal, draining is healthy. Growth is measured newest-versus-
  window-start so a drain (5 636 → 616, observed live) stays silent.

  **Both numbers were re-derived for #3610.** A queue entry is no longer one
  memory: an oversized retain is split at 45 000 chars into one entry *per
  part*. Measured against the live queue — 174 entries, 171 of them over the
  bound, expanding to 765 parts — that is `PARTS_PER_MEMORY = 4.4`. The
  operator-meaningful thresholds are still "100 memories deep" and "20 new
  memories", so both are written as `⌈memories × 4.4⌉` in `thresholds.ts`
  (100 → 440, 20 → 88). Without this, five worst-case memories (17 parts
  each = 85 entries) would have paged under the pre-#3610 numbers.
- **no p95 latency signal** — deliberately removed rather than retuned.
  Hindsight's exposition tops out at a finite `le` of 120 s, and a *healthy*
  post-#3610 backend already runs 52 of 268 retains (19.4 %) past it, because
  #3610 sizes content so a max-size part lands ~276 s inside the 280 s client
  deadline. So the instrument is blind across exactly the 120–280 s band
  where an early warning would live, and any threshold it *can* resolve fires
  permanently on a healthy fleet. Restoring the signal needs new `le` edges
  from hindsight — an instrument change, not a constant change.
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
