# Fleet Health — operator guide (live detection pipeline)

Fleet Health is the operator-facing, job-spec-anchored issue tracker: the fleet
watches itself against the 23 job specs in `reference/jobs/`, ranks its own recurring
failures by impact, tracks each in a GitHub issue, and closes it on a verified
count-drop.

Design: [`reference/rfcs/fleet-health.md`](../reference/rfcs/fleet-health.md)
(serves `reference/jobs/fleet-stays-healthy.md`, outcome `always-available`).

This page is the operator's how-to for the machinery: the `switchroom
fleet-health` CLI, the ledger, and the two crons the owner agent runs.

## The pieces

- **The model-free sensor** — `switchroom fleet-health scan`. Reads every
  agent's `turns.jsonl` + `logs/<agent>/gateway-supervisor.log`, runs the L0
  detectors (zero tokens, no LLM call), classifies each finding into the RFC's
  9-class failure-mode taxonomy, maps it to a job spec, scores it, and writes
  `~/.switchroom/fleet-health/ledger.json` — the ranked index the admin **Fleet
  Health** page reads.
- **The GitHub issue lifecycle** — `scan --sync-issues` opens/updates/closes one
  issue per distinct problem (`dedup_key`), labelled `fleet-health`,
  `severity:1|2|3`, and `job:<slug>`.
- **The weekly deep-dive brief** — `switchroom fleet-health deep-dive-targets`
  prints the top-N ledger records as a structured brief for the owner agent's
  weekly Opus deep-dive.

## Enabling it

1. Assign a dedicated **admin** owner agent (see
   [`configuration.md`](./configuration.md#fleet-health-fleet_health)):

   ```yaml
   fleet_health:
     owner_agent: klanker   # admin: true
   ```

   Unset → the feature is inert (no crons, admin page renders its empty state).

2. Schedule the two crons **on the owner agent** (operator-committed, or the
   owner agent self-schedules them via `schedule_add` after merge — never a
   self-authored loop; on-leash):

   | Cadence | Cron | Command | Tier |
   |---|---|---|---|
   | Nightly 02:00 | `0 2 * * *` | `switchroom fleet-health scan --sync-issues` | model-free (zero tokens) |
   | Weekly Mon 02:30 | `30 2 * * 1` | `fleet-health deep-dive-targets` → Opus deep-dive | budgeted, top 1-2 only |

   The nightly cron is the L0/L1 sensor pass and the GitHub sync. The weekly
   cron reads the brief, does the transcript-level root-cause on the top 1-2
   ranked records (joining occurrences by `turn_id`), and writes the finding
   into the linked GitHub issue. The deep-dive is Opus reasoning run **inside
   the owner agent's own budgeted session** — the CLI only produces the brief,
   never calls a model itself (claude-native; no `claude -p`).

### The owner agent's weekly deep-dive cron prompt

Phrased from the owner agent's future-self perspective (what a `schedule_add`
`prompt` should say):

> Time for the weekly Fleet Health deep-dive. Run `switchroom fleet-health
> deep-dive-targets --top 2` to get this week's worst 1-2 job records. For each,
> read the flagged turns' transcripts (join by `turn_id`), root-cause the
> failure, and update the linked GitHub issue with your finding. Budget: at most
> 2 deep-dives. Do not open new issues — the nightly sensor owns issue creation.

## The CLI

```
switchroom fleet-health scan [--dry-run] [--json] [--sync-issues]
                             [--window-days <n>] [--repo <owner/name>]
switchroom fleet-health deep-dive-targets [--top <n>] [--json]
switchroom fleet-health mapping
```

- `scan` writes the ledger. `--dry-run` prints it and writes nothing (and
  skips GitHub sync). `--sync-issues` performs the GitHub issue lifecycle;
  it is **default-off** so CI and ad-hoc runs never hit the network, and it
  no-ops with a clear log line if `gh` is unavailable/unauthenticated.
- `deep-dive-targets` prints the top-N open records as the deep-dive brief.
- `mapping` prints the signal → job-spec mapping table.

## The scoring

`priority_score = severity × frequency × reach × recency` (exactly as
implemented in `src/fleet-health/mapping.ts`):

- **severity** ∈ {1,2,3} from the failure-mode taxonomy.
- **frequency** = `log10(1 + count)` over the scan window (default 30 days).
- **reach** = distinct agents exhibiting the issue (floored at 1).
- **recency** = 1.0 within 24h, decaying linearly to 0.1 at the window edge,
  0 if there are no occurrences. This is what sinks a fixed issue's score as
  occurrences stop.

A record's `priority_score` is the max over its open issues (the worst open
problem drives the ranking). The admin page ranks the 23 records worst-first.

## Signal → job-spec mapping

The model-free sensor's explicit, documented mapping (source of truth:
`src/fleet-health/mapping.ts`, `SIGNAL_MAP`):

| L0 signal | Failure mode | Severity | Job spec |
|---|---|---|---|
| `silent-no-op-candidate` (complete, 0 tools, real turn) | silent-no-op | 3 | `know-what-my-agent-is-doing` |
| `duplicate-delivery-represent` (`represent duplicate-send`) | duplicate | 2 | `talk-to-agents-from-anywhere` |
| `reply-delivery-failure` (`sendRichMessage … status=err` — terminal only; a retried attempt logs `status=retry`, #3931) | success-theater | 3 | `talk-to-agents-from-anywhere` |
| `hang-long-stalled` (>6 min AND ≤2 tools) | partial | 2 | `steer-or-queue-mid-flight` |
| `killed-incomplete-turn` (status ∉ complete/no_reply) | missed-trigger | 3 | `steer-or-queue-mid-flight` |
| `represent-escalation` (`obligation escalation delivered + closed` / `PERMANENTLY undeliverable` — terminal outcomes only; a per-attempt retry and the `deferred — bridge down` suppression line are not escalations) | drift | 1 | `feel-like-a-colleague` |
| `orphaned-db-handle` (`orphaned-db-sweep DETECTED …` with a lane left un-recovered) | success-theater | 3 | `survive-reboots-and-real-life` |
| `orphaned-db-handle-recovered` (same alarm, but the alarm names only `history.db*` targets and the tick's next sweep line is the reopen-succeeded one) | drift | 1 | `survive-reboots-and-real-life` |

Tuned L0 constants (load-bearing; ported verbatim from the validated reference
detector): `HANG_MS = 360000`, `HANG_MAXTOOLS = 2`, `synthetic-` turn ids
excluded, and the precise gateway signatures above so a `getUpdates` network
blip never counts as a delivery failure.

## The ledger

`~/.switchroom/fleet-health/ledger.json` — per-deployment state, **never
committed** (same rule as agent scaffolds and the scheduler ledger). Written by
the owner agent's sensor, read read-only by the web container. Shape: see
`src/web/fleet-health-read.ts` (the typed reader is the contract).
