# CLAUDE.md — vendor/hindsight-memory

**This directory is a VENDORED SNAPSHOT of the hindsight-memory plugin. It is
not the specification, and it is not what runs.** Treat it as evidence about
one commit of the implementation, nothing more.

The load-bearing copy of this rule is the repo-root `CLAUDE.md`
("Third-party docs — the official site is the spec"); nothing auto-loads a
subdirectory `CLAUDE.md`, so this file only reaches an agent that opens it.

## Where the truth is

1. **Official docs site** — <https://hindsight.vectorize.io/>. Curation and
   the memory-unit endpoints: `/developer/api/memories`. Also
   `/developer/api/retain`, `/developer/api/recall`,
   `/developer/observations`, `/developer/configuration`, index at
   `/api-reference`. (`/developer/` itself has no index page — it 404s.)
2. **context7** — prefer `/websites/hindsight_vectorize_io` (the docs site)
   over `/vectorize-io/hindsight` (the OSS repo).
3. **This tree** — last, and only for "what does the code here actually do".

Not finding something here is not evidence it doesn't exist. Search the docs
before you tell anyone a knob, endpoint or config path is unsupported.

## Trap: `settings.json` here is NOT what switchroom installs

`installHindsightPlugin` (`src/agents/scaffold.ts`) copies this tree into each
agent's `.claude/plugins/hindsight-memory/` and then **stamps switchroom's own
overrides over `settings.json`** — additional banks, the retain cadence knobs,
and the recall types. Concretely, this file has
`"recallTypes": ["world", "experience"]` while switchroom writes
`["world", "experience", "observation"]` (`scaffold.ts:3449` as of writing;
line anchors drift — grep `settings.recallTypes`).

So reading the vendored `settings.json` to learn live behaviour is actively
misleading. Read the override site in `scaffold.ts`, or the deployed
`~/.switchroom/agents/<name>/.claude/plugins/hindsight-memory/settings.json`.

## Editing

Don't hand-edit vendored upstream files without a reason (repo-root
`CLAUDE.md` § Secrets & safety rails). This file and switchroom's local
patches are the exceptions; changes here ship to every agent on the next
`apply`/reconcile, and the Python under `scripts/` is gated by the required
`python-ok` check (`python3 -m unittest discover` in `scripts`).
