# drift-audit

A repeatable workflow for keeping docs, comments, and JTBDs aligned to
the code that actually ships.

Switchroom is built by many agents at speed. Docs and comments drift —
PRs reference retired features, JTBDs leak implementation detail,
`docs/` describes behavior the code no longer has. This workflow
applies the existing **verdict rule** from `CLAUDE.md` retroactively
to every existing artefact:

> A change ships when it (a) advances one of the four vision outcomes,
> (b) satisfies its JTBD, and (c) passes all three principle checks.

**Code is authoritative** unless an artefact is explicitly vision or
roadmap of something not yet built. If `docs/` says X and code does Y,
docs change. If `vision.md` says X and code does Y, that's flagged for
human decision — vision may be the target the code hasn't reached yet,
or the vision needs to retreat.

## The five phases

| Phase | Who | What | Output |
|---|---|---|---|
| 0 — Inventory | Operator (one-off per run) | Decide which units this run covers | `manifest.yaml` (pilot included) |
| 1 — Audit | Many parallel agents | One agent per unit; lists claims, verifies against code, emits verdicts | `audit/<date>/findings/<unit-id>.yaml` |
| 2 — Triage | One coordinator agent | Reads all findings, groups into fix-batches, escalates ambiguous cases | `audit/<date>/{summary.md, fix-batches/*.md, escalations.md}` |
| 3 — Fix | Many parallel agents | One agent per fix-batch; applies actions, opens PR | One PR per batch (branch pushed direct to origin) |
| 4 — Re-verify | One agent | Re-runs Phase 1 on touched units after PRs merge | `audit/<date>/regressions.md` |

## Invocation (Claude Code session, this repo)

You drive the workflow from a Claude Code session in this directory.
The runner is the `Agent` tool — Claude dispatches sub-agents in
parallel per phase.

Natural-language commands:

```
Run drift-audit phase 1 on the pilot manifest
Run drift-audit phase 2 on audit/<date>/
Run drift-audit phase 3 on audit/<date>/fix-batches/<batch>.md
Run drift-audit phase 4 on audit/<date>/
```

Each command tells Claude to read the matching prompt template from
`scripts/drift-audit/prompts/`, expand it with the unit/batch
specifics, and dispatch the appropriate number of `Agent` calls.

Phase 1 fans out to ~10 agents per dispatch; a 23-unit pilot is two
or three waves.

## Layout

```
scripts/drift-audit/
├── README.md                # this file
├── manifest.yaml            # units in scope (pilot: 23)
├── EXAMPLE.md               # worked example: claim → verdict → fix
├── prompts/
│   ├── 01-audit.md          # Phase 1 prompt template
│   ├── 02-triage.md         # Phase 2 prompt template
│   ├── 03-fix.md            # Phase 3 prompt template
│   └── 04-reverify.md       # Phase 4 prompt template
└── schema/
    └── finding.schema.yaml  # JSON Schema for Phase 1 output

audit/                       # timestamped outputs, committed
└── <YYYY-MM-DD>/
    ├── findings/
    │   └── <unit-id>.yaml
    ├── summary.md
    ├── fix-batches/
    │   └── <topic>.md
    ├── escalations.md       # includes inline recommendations after Phase 2.5
    ├── recommendations/     # standalone recommendation files
    │   └── escalation-NN.md
    └── regressions.md       # only after Phase 4
```

## Unit categories

Not every doc gets audited the same way. The manifest tags each unit
with a category that selects the right Phase 1 prompt branch:

| Category | Examples | Code-vs-doc verdict rule |
|---|---|---|
| `jtbd` | `reference/jobs/feel-like-a-colleague.md` | Code is authoritative. If the outcome isn't realized, flag drift. If JTBD leaks implementation, flag too-technical. |
| `contract` | `reference/vision.md`, `reference/principles.md` | Vision is authoritative. Code drift here is escalated, not auto-fixed. |
| `artefact-current` | `reference/rfcs/conversational-pacing.md` | Code is authoritative. Update artefact text if shipped behavior diverged. |
| `rfc-shipped` | `reference/rfcs/sub-agent-visibility.md` | Verify `status: shipped` still true; flag if reverted. |
| `rfc-draft` | `reference/rfcs/docker-multi-container.md` | Verify Draft hasn't been overtaken by reality. If shipped, mark superseded or promote to a shipped artefact. |
| `archived` | `reference/rfcs/status-card-design.md` | Confirm `status: archived` still appropriate; flag references elsewhere that treat it as current. |
| `historical` | `reference/rfcs/onboarding-gap-analysis.md` | Verify the historical disclaimer still holds; flag if anyone is using it as current spec. |
| `docs` | `docs/*.md` (post-pilot) | Code is authoritative. Standard drift verdicts. |
| `src-comments` | `src/<module>/` (post-pilot) | Code is authoritative. Comments referencing dead code/PRs/versions get deleted or updated. |

## Adding new units

Append to `manifest.yaml`. The schema is documented inline at the top
of the file. A new unit needs only:

```yaml
- id: <kebab-case-id>          # used as the findings filename
  path: <repo-relative-path>   # the file being audited
  category: <category>         # from the table above
  anchors_hint: |              # optional: claims worth checking first
    ...
```

## Re-runs

Each run lives in its own timestamped `audit/<date>/` directory. To
diff drift over time:

```
diff <(yq -o=json audit/2026-05-26/findings/<id>.yaml) \
     <(yq -o=json audit/2026-08-15/findings/<id>.yaml)
```

To re-audit only units whose tracked files changed since a tag, filter
the manifest by `git diff --name-only <tag>` before Phase 1 dispatch.

## Fix posture

The pilot posture is **open PRs, no auto-merge** (decision: 2026-05-26).
Phase 3 agents push branches and open PRs following the standard dev
process in `CLAUDE.md`. A reviewer agent must APPROVE before you enable
auto-merge.

In environments where `gh` isn't available, Phase 3 falls back to
pushing the branch to origin (`switchroom/switchroom`) and reporting a
pre-filled GitHub compare URL for the operator to open the PR via web.

## Why this exists in-repo

`scripts/drift-audit/` and the `audit/` outputs are committed so that
(a) the prompt templates evolve alongside the code they audit,
(b) any maintainer with a clone can re-run, and
(c) drift history is visible to upstream — repeat findings on the same
artefact are a signal that the underlying design has slid and needs a
deeper conversation, not another patch.
