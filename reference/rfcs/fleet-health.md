---
artifact: Fleet Health — operator-facing, job-spec-anchored fleet issue tracking
serves: fleet-stays-healthy
advances-outcome: always-available
status: Draft
---

# RFC: Fleet Health — the fleet surfaces its own recurring failures

Status: Draft
Author: Ken (CPO) via klanker pair-design
Date: 2026-07-03
Serves: [`fleet-stays-healthy.md`](../jobs/fleet-stays-healthy.md) → outcome `always-available`
Kill-clause: `chat-is-the-single-source-of-truth`, `no-self-escalation`, `on-leash`, `single-tenant`
Builds on: `see-my-whole-fleet-from-one-screen.md` (fleet dashboard), `crons-use-the-model-only-when-it-earns-it.md` (tiered crons), `agent-self-improvement.md` (evidence tiers, failure-mode taxonomy)

> A ship-coupled RFC against the Job Spec. The Job Spec is the durable home
> of the job; this is one effort against it. Solution shape, not solution.

## TL;DR

1. **The job:** the fleet watches itself against the 23 job specs, ranks its
   own recurring failures by impact, and puts the worst ones in front of the
   operator with evidence and a GitHub issue tracking the fix.
2. **Success:** a recurring failure is detected from the fleet's own logs
   (not a principal complaint), ranked by `severity × frequency × reach ×
   recency`, tracked in a GitHub issue, and closed on a verified count-drop.
3. **Biggest constraint:** the nightly sensor that touches all 23 jobs is
   **model-free (zero tokens)**; the model spend is gated behind it and
   budgeted to the top 1-2 issues; everything runs as operator-set schedules
   on one operator-assigned owner agent.

## The Job

> **When** an agent quietly fails at one of the jobs it is supposed to do
> (a silent no-op, a late delivery, a duplicate send, a missed trigger),
> **the operator wants** the fleet to surface that failure ranked by impact
> with the evidence attached, **so they can** spend their attention on the
> worst-affecting issues instead of auditing every turn by hand.

Durable home: [Job Spec](../jobs/fleet-stays-healthy.md). Serves
`always-available`; governed by `chat-is-the-single-source-of-truth`,
`no-self-escalation`, `on-leash`, `single-tenant`.

## Validation (this is real, not hypothetical)

Validated end-to-end on live fleet data the week of 2026-07:

- The 4-layer funnel below detected that **clerk** and **marko** were writing
  answers as plain text and never calling the reply tool (clerk 200/201
  turns, marko 282/282). That tripped the gateway's `represent` safety net —
  answers delivered 2-4 min late plus a wasted represent turn each time.
- Root-caused by reading the transcripts (an L2 deep-dive), fixed, and the
  represent-duplicate-send count dropped toward ~2.
- **carrie**, a clean control, had only ~2 escalations — the sensor did not
  false-positive on it.

The failure was invisible to the operator until the sensor found it: no
error was ever raised, the answers *did* eventually arrive. This is exactly
the silent-failure class the job exists to catch.

## The health ledger

One persistent record **per job spec** (23 records). It is the standing,
ranked state the admin page reads and the sensor updates.

**Where it lives:** `~/.switchroom/fleet-health/ledger.json` — per-agent /
per-deployment state under `~/.switchroom`, **never committed to the repo**
(same rule as agent scaffolds and the scheduler ledger). The owner agent
writes it in-container at `/state/fleet-health/ledger.json`, host-mounted to
`~/.switchroom/fleet-health/`. The web container reads it read-only.

**Record shape** (per job spec):

```jsonc
{
  "job_spec": "fleet-stays-healthy",        // the jobs/<slug>.md id — join key
  "open_issue_count": 3,                     // distinct open problems for this job
  "last_scanned": "2026-07-03T02:00:00Z",    // last nightly sensor pass
  "priority_score": 42.7,                    // severity × frequency × reach × recency
  "gh_issues": [1841, 1842],                 // linked GitHub issue numbers
  "last_deep_dive": "2026-06-30T02:14:00Z",  // last L2 Opus pass (null if never)
  "issues": [                                // the distinct problems, with evidence
    {
      "dedup_key": "represent-duplicate-send:reply-tool-not-called",
      "failure_mode": "silent-no-op",        // from the taxonomy below
      "severity": 3,                         // 1-3
      "frequency": 282,                      // occurrences in the scan window
      "reach": ["clerk", "marko"],           // agents exhibiting it
      "recency": "2026-07-02T21:03:00Z",     // newest occurrence
      "occurrences": [                       // hard-artifact evidence
        { "agent": "clerk", "turn_id": "12345:_#12673",
          "log_pointer": "logs/clerk/gateway-supervisor.log:represent duplicate-send" }
      ],
      "gh_issue": 1841,
      "status": "open"                       // open | resolved-pending-verify | closed
    }
  ]
}
```

The `job_spec` id and the per-issue `turn_id` are the two **join keys**:
`job_spec` joins a record to `reference/jobs/<slug>.md` and to its GitHub
label; `turn_id` (origin_turn_id, e.g. `12345:_#12673`) joins an
occurrence across `turns.jsonl`, the gateway log, and the transcript.

## Priority score

`priority_score = severity × frequency × reach × recency`. Ranking by real
impact, not raw event count — a rare-but-severe issue must outrank a
frequent-but-cosmetic one.

- **severity** ∈ {1,2,3} — from the failure-mode taxonomy. Silent no-op /
  constraint-violation = 3 (the fleet did the wrong thing or nothing while
  reporting success); partial / duplicate / late-delivery = 2; drift /
  ux-friction = 1. Assigned by the sensor from the signature that matched.
- **frequency** — count of occurrences of this `dedup_key` in the scan
  window (default 30 days), normalized as `log10(1 + count)` so 282 vs 20
  is a meaningful gap but doesn't swamp the other three factors.
- **reach** — number of distinct agents exhibiting the issue (`|reach|`). A
  failure across the whole fleet outweighs a one-agent quirk. A single
  systemic issue (2 agents) already ranks above a noisy one-agent issue.
- **recency** — decay on the newest occurrence: `1.0` if within 24h,
  linearly decaying to `0.1` at the window edge. A failure fixed a month ago
  sinks; a fresh one floats. This is what closes the loop after a fix: as
  occurrences stop, recency decays the score toward zero.

All four are computed **from the model-free sensor's output** (below) — no
model judgment enters the score. The web page ranks the 23 records by
`priority_score` descending.

## The 4-layer detection funnel

Cheap filters gate expensive reasoning. Each layer only escalates what the
one below flagged.

### L0 — model-free sensor (nightly, zero tokens)

Reads `turns.jsonl` + the gateway log per agent. **No model call, no `claude
-p`** (claude-native + subscription-honest hold trivially — L0 spends no
tokens at all). Emits a structured signal digest; only flagged turns
escalate. This is the canonical sensor — inlined here so the owner agent runs
it verbatim:

```python
#!/usr/bin/env python3
"""Layer-0 spec-conformance detector (read-only, zero-token).

Validated sources only:
  turns.jsonl   -> per-turn status/tools/duration/turn_id  (structured oracle)
  gateway log   -> precise failure signatures + delivery artifacts

Emits a structured signal digest; only flagged turns escalate to a paid pass.
"""
import json, sys, subprocess
from collections import Counter, defaultdict

agent = sys.argv[1] if len(sys.argv) > 1 else "overlord"
HANG_MS = 360_000           # tuned: >6min (data p99=303s) AND low-progress
HANG_MAXTOOLS = 2           # long+productive = deep work; long+stalled = hang
TURNS = f"/host-home/.switchroom/agents/{agent}/turns.jsonl"
GW    = f"/host-home/.switchroom/logs/{agent}/gateway-supervisor.log"

turns = []
for line in open(TURNS):
    line = line.strip()
    if line:
        try: turns.append(json.loads(line))
        except: pass

flags = defaultdict(list)   # failure_mode -> [evidence]
for t in turns:
    tid = t.get("turn_id", "?"); st = t.get("status"); tl = t.get("tools", 0)
    dur = t.get("duration_ms", 0)
    synthetic = "synthetic-" in tid          # gateway-injected, not a real job
    if st not in ("complete", "no_reply"):
        flags["killed/incomplete turn"].append(f"{tid} status={st}")
    # tuned hang: long AND stalled (few tools) — long+productive is deep work
    if dur > HANG_MS and tl <= HANG_MAXTOOLS:
        flags["hang (long+stalled)"].append(f"{tid} {dur//1000}s tools={tl}")
    # silent no-op: completed, zero tools, real (non-synthetic, non-no_reply)
    if st == "complete" and tl == 0 and not synthetic:
        flags["silent no-op candidate"].append(f"{tid} tools=0")

def gcount(pat):
    try:
        out = subprocess.run(["grep", "-cE", pat, GW], capture_output=True, text=True)
        return int(out.stdout.strip() or 0)
    except: return 0

# precise gateway signatures (precision-filtered — getUpdates blips excluded)
sig = {
  "duplicate delivery (represent duplicate-send)": "represent duplicate-send",
  "represent escalation":                          "obligation escalation",
  "reply delivery failure":                        r"tg-post method=sendRichMessage[^\n]*status=err",
}
gw_hits = {name: gcount(pat) for name, pat in sig.items()}

esc = bool(flags.get("killed/incomplete turn") or flags.get("hang (long+stalled)")
           or flags.get("silent no-op candidate")
           or gw_hits["duplicate delivery (represent duplicate-send)"]
           or gw_hits["reply delivery failure"])
print(json.dumps({
    "agent": agent, "turns": len(turns),
    "status_mix": dict(Counter(t.get("status") for t in turns)),
    "flags": {k: v for k, v in flags.items()}, "gw_hits": gw_hits,
    "escalate": esc,
}))
```

**Tuned constants (load-bearing — do not casually change):** `HANG_MS =
360000` (>6 min, data p99 = 303 s), `HANG_MAXTOOLS = 2` (long+productive is
deep work, long+stalled is a hang), exclude `synthetic-` turn ids
(gateway-injected, not real jobs), and precise gateway signatures
(`represent duplicate-send`, `tg-post method=sendRichMessage ... status=err`)
so a `getUpdates` network blip never counts as a delivery failure.

L0 runs nightly across **all** agents and updates the ledger counts for
**all 23** job records cheaply. It never spends a token.

### L1 — cheap reflect confirm (nightly, only on L0 hits)

For each L0-flagged issue, a cheap `reflect` (Sonnet, run as an ordinary
synthesized turn on the owner agent — never `claude -p`) confirms the signal
is a real failure vs a benign explanation, and assigns the failure-mode
class + severity. Confirmed issues update the ledger and get/refresh a
GitHub issue. Idle nights (no L0 hit) never reach L1 → zero model cost.

### L2 — Opus deep root-cause (weekly, BUDGETED, top 1-2 only)

Weekly, the owner agent takes the **top one or two** ledger records by
`priority_score` and runs an Opus deep-dive: read the flagged turns'
transcripts (joined by `turn_id`), root-cause, and write the finding into the
GitHub issue. **Budgeted** — never more than 2 deep-dives per week — so the
expensive layer is bounded regardless of how many issues exist. This is the
layer that read the clerk/marko transcripts and root-caused the reply-tool
gap.

### L3 — weekly synthesis

A weekly `reflect` over the ledger + closed issues: what got fixed, what's
trending, which jobs are chronically fragile. Written into the ledger's
top-level summary and surfaced on the page header. Cheap (one reflect over a
small ledger), not per-turn.

**Self-verifying via count-drop.** After a fix, the nightly L0 sensor's count
for the `dedup_key` falls (e.g. 282 → ~2). When it stays below a
resolved-threshold for the verify window, the issue flips
`resolved-pending-verify` → `closed` and its GitHub issue closes — proof from
the fleet's own numbers, not a self-report.

## GitHub issue lifecycle (the identify + resolve system-of-record)

GitHub issues are where the *work* lives — both identification and
resolution. The owner agent (via `gh`, authenticated through a vault-held
token, `no-self-escalation`-clean):

- **Opens** one issue per distinct problem, keyed by `dedup_key` (e.g.
  `represent-duplicate-send:reply-tool-not-called`). The dedup key prevents a
  fresh duplicate issue every night — an existing open issue for the key is
  **updated**, not re-created.
- **Labels** it `fleet-health`, a severity label (`severity:1|2|3`), and the
  job-spec label (`job:fleet-stays-healthy`). The labels are what the admin
  page and any operator `gh` query filter on.
- **Links occurrences** into the issue body: the turn ids and log pointers
  from the ledger's `occurrences`, so the operator can jump straight to the
  evidence.
- **Closes** on verified count-drop (above). The close is triggered by the
  sensor's numbers, so the tracker can't fill with stale "fixed" issues.

The ledger stores the issue **numbers**; the admin page optionally reads the
GitHub API for live open/closed status. GitHub is the durable
system-of-record for the work; the ledger is the fast, rankable index.

## Owner agent (attribution + on-leash)

A **dedicated, operator-assigned admin agent** runs the sensor + deep-dive
crons, so every scan and deep-dive is attributable to a named agent (not an
anonymous host cron, and not some arbitrary agent that happened to have a
schedule slot).

- **Assignment:** a top-level config field `fleet_health.owner_agent:
  <name>` (cascade mode **override**; documented in
  `docs/configuration.md`). Default unset → the feature is inert (no crons
  scheduled, page renders the empty state). The named agent must be
  `admin: true`.
- **Why a dedicated agent, not any admin:** the detection reads every agent's
  `turns.jsonl` + logs and opens GitHub issues on the fleet's behalf. That is
  a distinct standing responsibility with its own memory (what's been
  triaged, what's chronic) and its own attributable audit trail. Folding it
  into an arbitrary admin agent muddies attribution and mixes the
  fleet-health memory into an unrelated persona's context. One owner keeps
  the work legible and the token spend accountable.
- **On-leash:** the sensor and deep-dive run only as **operator-set
  schedules** (nightly L0/L1, weekly L2/L3) on that agent — never a
  self-authored loop. The owner agent proposes nothing autonomously; the
  operator commits the crons and the owner assignment.

## Admin page data contract

A new **Fleet Health** page on the operator dashboard (`src/web/`). It reads:

- **The ledger** (`~/.switchroom/fleet-health/ledger.json`) — the 23 records,
  ranked by `priority_score`. This is the primary, always-available source.
- **Optionally the GitHub API** — live open/closed status per linked issue
  number, when a token is available; degrades to the ledger's own `status`
  when not.

It shows:

- The 23 job specs **ranked worst-first** by `priority_score`, each row:
  score, open-issue count, severity of the worst open issue, frequency/trend,
  last-scanned, last-deep-dive.
- **Per-spec drill-down** to its distinct issues: count, frequency/trend,
  severity, failure-mode class.
- **Per-issue** links: to occurrences (turn ids + log pointers) and to the
  GitHub issue.

It is an **operator surface** — same posture as the fleet dashboard
(`see-my-whole-fleet-from-one-screen`): authenticated, single-tenant, never a
principal channel, and it renders no parallel status mirror into a Telegram
thread. `telegram-and-buzz-only` and `chat-is-the-single-source-of-truth` hold.

## Evidence tiers + failure-mode taxonomy (the sensor's classification)

**Evidence tiers** (highest trust first) — an issue's confidence is capped by
its best evidence:

1. **Hard artifact** — a structured record in `turns.jsonl` or a precise
   gateway log signature. What L0 emits. Independently verifiable.
2. **Process trace** — a transcript read (L2 deep-dive) showing the causal
   path. Verifiable but interpretive.
3. **Self-report** — a model's assertion with no backing artifact. Lowest
   trust; never sufficient to open a severity-3 issue on its own.

The count-drop close is a **hard-artifact** verification — never a
self-report.

**Failure-mode taxonomy** — the classes the sensor + L1 assign, which drive
severity:

- **silent no-op** — completed, zero tools, real turn (reported success,
  did nothing). severity 3.
- **success theater** — reported done but the artifact/effect is absent.
  severity 3.
- **partial** — did some of the job, silently dropped the rest. severity 2.
- **wrong-but-plausible** — produced a confident, incorrect result.
  severity 3.
- **missed trigger** — a schedule/reaction/inbound that should have woken the
  agent didn't. severity 2.
- **constraint violation** — crossed a stated boundary (e.g. an off-plan
  callsite, an ungated action). severity 3.
- **duplicate** — the same effect delivered twice (the represent
  duplicate-send). severity 2.
- **drift** — behaviour slowly diverging from spec over time. severity 1.
- **spec-side failure** — the job spec itself is wrong/stale and the agent is
  correctly following a bad contract. severity 2; routes to a spec edit, not
  an agent fix.

## Bets & Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| L2 Opus runs too often → cost tax | Med | High | L0/L1 model-free gate; L2 budgeted to top 1-2/week |
| Duplicate GitHub issues every night | Med | Med | `dedup_key` — update existing issue, never re-create |
| Ranking buries a severe-rare issue | Med | High | severity × reach factors, not raw count; fuzz corpus |
| Stale "fixed" issues pile up | Low | Med | close on verified count-drop, not self-report |
| Owner agent becomes a self-authored loop | Low | High | operator-set schedules only; owner assignment operator-committed |

## Rollout

**Opt-in, off by default.** No `fleet_health.owner_agent` → inert (no crons,
empty page). The operator assigns the owner and commits the L0/L1 (nightly)
and L2/L3 (weekly) schedules. Conservatism comes from the model-free gate and
the deep-dive budget, not a staged audience.

**Slice 1 (merged, #2748):** the job spec, this design, and a working+tested
admin **page skeleton** that renders the ledger (typed reader + clearly-marked
empty state), plus the `fleet_health.owner_agent` config field.

**Slice 2 (this PR):** the live detection pipeline — the model-free sensor, the
priority ledger writer, and the GitHub issue lifecycle, all behind the
`switchroom fleet-health` CLI. See "Implementation" below. The owner-agent crons
are documented (this section + `docs/fleet-health.md`) and wired by the operator
or the owner agent via `schedule_add` after merge — never a self-authored loop.

## Implementation (as shipped in slice 2)

**Code:** `src/fleet-health/{detect,mapping,ledger,gh-sync,scan}.ts` +
`src/cli/fleet-health.ts` (verb `switchroom fleet-health`, subcommands `scan`,
`deep-dive-targets`, `mapping`). Operator how-to: `docs/fleet-health.md`.

### Signal → job-spec mapping (the model-free classification table)

`src/fleet-health/mapping.ts` `SIGNAL_MAP` is the source of truth. Each L0
signal is a hard artifact, pinned to the best-fit job spec (derived by reading
the 23 `reference/jobs/*.md`) and a taxonomy class + severity:

| L0 signal | Failure mode | Severity | Job spec | Rationale |
|---|---|---|---|---|
| `silent-no-op-candidate` | silent-no-op | 3 | `know-what-my-agent-is-doing` | completed with 0 tools while reporting success — the operator can't tell it did nothing |
| `duplicate-delivery-represent` | duplicate | 2 | `talk-to-agents-from-anywhere` | the represent-duplicate-send (the validated clerk/marko case) — delivery to the principal happened twice |
| `reply-delivery-failure` | success-theater | 3 | `talk-to-agents-from-anywhere` | `sendRichMessage … status=err` — the answer never reached the principal |
| `hang-long-stalled` | partial | 2 | `steer-or-queue-mid-flight` | a turn stalled mid-flight (>6 min, ≤2 tools) — an in-flight-control failure |
| `killed-incomplete-turn` | missed-trigger | 3 | `steer-or-queue-mid-flight` | the turn was abandoned incomplete while in progress |
| `represent-escalation` | drift | 1 | `feel-like-a-colleague` | the gateway had to nudge on the agent's behalf — UX-friction, informational (does not alone open a sev-3 issue) |

Note: `represent-escalation` is an added sev-1 *informational* signal beyond the
two precise delivery signatures — it flags UX-friction, not a delivery failure,
and does not alone open a sev-3 issue, so it is not scope creep on the
delivery-signature detection. Its signature matches the two TERMINAL escalation
outcomes only (`delivered + closed`, `PERMANENTLY undeliverable`), for the same
attempt-vs-outcome reason as `reply-delivery-failure` (#3931): the bare
`/obligation escalation/` substring also matched the per-attempt retry line and
the `deferred — bridge down` SUPPRESSION line, so the guard *declining* to
escalate while the bridge was down was booked as a failure.

`orphaned-db-handle` splits on recovery rather than on attempt: an alarm whose
sweep tick also logged `reopened history.db — writes are durable again`, with no
lane left un-recovered, is emitted as `orphaned-db-handle-recovered` (drift, sev
1, `survive-reboots-and-real-life`). A tick that left `registry.db`, an unowned
handle, or a FAILED reopen behind stays `orphaned-db-handle` at sev 3 — that is
genuine silent loss.

**The verdict is derived from the tick's CONTENT, never from how many lines
follow it.** Which lanes a tick hit is stated by the alarm line itself (it
interpolates every orphaned fd's target), and `history.db*` is the only lane
with an in-process recovery; whether that lane recovered is stated by the first
`orphaned-db-sweep` line after the alarm, which the emitter logs with no `await`
in between. A line-count lookahead would instead make the answer depend on when
the scan ran — the same alarm+reopen pair reading sev 1 at the log tail and sev
3 once ordinary traffic accumulated behind it — and because the two verdicts
carry different signatures, a flip would migrate the finding between dedup_keys
and empty the old one, which the writer reads as a fix-to-zero.

A gateway finding is one EVENT, not one log line: matched lines carrying the
same `origin=` turn id fold into a single finding for that signal, so ledger
`frequency` counts distinct affected turns. Lines with no origin id keep
one-finding-per-line.

**A change of counting UNIT is not a count-drop.** `frequency` is a count, and
the count-drop self-verify below closes an issue when it falls — so changing
what an occurrence *is* makes every open issue on that signal look fixed, with
nothing fixed. Each issue therefore records the `counting_unit` its `frequency`
was measured in (`log-line` or `gateway-event`; absent means the legacy
`log-line`). When the unit differs from the prior ledger's, the writer holds the
issue's status for exactly one scan instead of advancing it toward closure. The
issue is rewritten carrying the new unit, so the next scan compares like with
like and a genuine drop still closes it — a real close is delayed by one scan,
never suppressed. Reopening is still allowed: a count above the threshold cannot
produce a false "fixed" claim. Without this the fold above would have flipped
every live gateway issue to `resolved-pending-verify` on the first post-merge
scan and had `gh-sync` comment "Verified count-drop … Closed by the Fleet Health
sensor." on issues nobody touched — the board lying, which is the one failure
this ledger exists to prevent.

"Never suppressed" is only true because the count-drop arm tests `count <
prior.frequency`, not `prior.frequency > RESOLVED_THRESHOLD`. The hold REWRITES
`frequency` to the post-fold count, so an issue held at 3 carries a prior
frequency of 3 from then on and would never satisfy `> 3` again — under that
test a held issue could only ever leave the board through the zero path, i.e.
stale-open on GitHub however much of it got fixed.

**A key emptied by RECLASSIFICATION is not a verified fix either.** The unit
guard compares a prior issue with this scan's issue under the SAME dedup_key,
but findings that re-sort into a sibling signature (`orphaned-db-handle` →
`orphaned-db-handle-recovered`, `silent-no-op-candidate` →
`flush-recovered-turn`) EMPTY the old key and fill the sibling's, which reads as
a drop to zero. Zero occurrences really is zero, so the issue does close — but
the writer records `close_reason: "reclassified"` (naming the sibling keys the
evidence moved to) and `gh-sync` posts that instead of a "Verified count-drop"
claim nobody earned. And because any close can turn out to be premature, an
issue whose defect reappears after closing is marked `reopened` and `gh-sync`
runs `gh issue reopen` — `gh issue edit` refreshes a closed issue's body without
reopening it, so without that the board would say "fixed" forever while the
sensor found the defect every night.

**The reopen path is a one-scan window.** The close-on-zero loop only carries a
prior key forward when its status is `open` or `resolved-pending-verify`
(`ledger.ts:283-287`), so a `closed` issue that stays quiet is dropped from the
ledger on the very NEXT scan and its `gh_issue` number goes with it. A defect
that returns on the immediately following scan is reopened on the original
thread; one that returns two or more scans later has nothing left to reopen and
falls through to `gh-sync`'s create path, filing a FRESH issue for the same
`dedup_key`. That is deliberate — the alternative is an unbounded tombstone list
of every key ever closed — and it costs continuity, not correctness: the board
never claims "fixed" while the defect is live either way. It is stated here
because the window is invisible in the code, and a change to it silently changes
which incidents keep their history.

The dedup key is `<job_spec>:<signature>` (one GitHub issue per key).

### Priority score (as implemented)

`priority_score = severity × frequency × reach × recency`, computed in
`mapping.ts`:

- **severity** — from the table above.
- **frequency** — `log10(1 + count)` over the scan window (default 30 days).
- **reach** — distinct-agent count, floored at 1.
- **recency** — `1.0` within 24h, linear decay to `0.1` at the window edge,
  `0` if there are no occurrences.

A record's score is the **max** over its open issues (the worst open problem
drives the ranking). The `resolved-pending-verify → closed` count-drop
transition fires when a previously-noisy `dedup_key` falls to ≤3 occurrences.

### Owner-agent crons (documented, not committed)

Two operator-set (or owner-agent-self-scheduled) crons on the owner agent —
no per-agent cron config or per-agent state is committed to the repo:

| Cadence | Cron | Command | Tier |
|---|---|---|---|
| Nightly 02:00 | `0 2 * * *` | `switchroom fleet-health scan --sync-issues` | model-free (zero tokens) |
| Weekly Mon 02:30 | `30 2 * * 1` | `fleet-health deep-dive-targets` → Opus deep-dive | budgeted, top 1-2 only |

The weekly deep-dive is Opus reasoning run **inside the owner agent's own
budgeted session** (claude-native; no `claude -p`). The CLI only produces the
structured brief; the model spend stays in the agent's cron session. Full cron
prompt + cadence: `docs/fleet-health.md`.

## Verdict

Per `reference/vision.md`'s verdict rule, this ships when it:

- **Advances a vision outcome** — `always-available` (a fleet that stays *up
  and correct*, not just alive).
- **Satisfies the new job spec** — [`fleet-stays-healthy.md`](../jobs/fleet-stays-healthy.md),
  proven by its detect/rank/close UATs.
- **Passes the three principle checks** — *docs:* the page + CLI explain
  themselves, no `docs/` required; *defaults:* inert until the operator
  assigns an owner (opt-in complexity); *consistency:* same operator-page
  shape as the fleet dashboard, same config cascade, same tiered-cron model.
- **Crosses no invariant** — `chat-is-the-single-source-of-truth` (operator
  surface, no parallel mirror), `no-self-escalation` (operator-committed owner
  + schedules), `on-leash` (no self-authored loop), `single-tenant` (reads
  this one deployment), `claude-native` (L0 model-free; L1-L3 are ordinary
  synthesized turns, never `claude -p`).

## Related

- [Job Spec](../jobs/fleet-stays-healthy.md)
- [`see-my-whole-fleet-from-one-screen.md`](../jobs/see-my-whole-fleet-from-one-screen.md) — the sibling operator fleet view
- [`crons-use-the-model-only-when-it-earns-it.md`](../jobs/crons-use-the-model-only-when-it-earns-it.md) — the tiered-cron discipline the funnel follows
- [`agent-self-improvement.md`](./agent-self-improvement.md) — the evidence tiers + failure-mode taxonomy origin (agent-facing sibling)
- [product-spec.md](../product-spec.md) — outcome `always-available`
- [principles.md](../principles.md), [invariants.md](../invariants.md)

**Last Updated:** 2026-07-03
