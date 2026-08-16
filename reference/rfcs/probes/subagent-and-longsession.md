# Probe: sub-agent memory surface + long-session/compaction behaviour

Probe date: 2026-08-16 (Australia/Melbourne). All paths are the DEPLOYED tree
under `~/.switchroom/agents/klanker/` (identical listing at
`/host-home/.switchroom/agents/klanker/`), plus live reads against the running
engine at `127.0.0.1:18888` and the deployed recall log. This probe was itself
run from a `researcher` sub-agent, so several claims are first-person empirical.

## 1. What each sub-agent type can reach

### 1.1 Tool allowlists (deployed `.claude/agents/*.md`, verified live)

| Agent type | tools frontmatter | Hindsight MCP reach |
|---|---|---|
| `worker` | `Read, Edit, Write, Bash, Grep, Glob, TodoWrite, WebSearch, mcp__webkite__*, mcp__switchroom-telegram__progress_update` (`worker.md:5`) | **NONE** — design-v2's claim confirmed |
| `researcher` | no `tools:` key (`researcher.md:1-6`) → inherits "All tools" | full `mcp__hindsight__*` |
| `reviewer` | no `tools:` key (`reviewer.md:1-5`) → inherits "All tools" | full `mcp__hindsight__*` |
| `general-purpose` / `claude` | `Tools: *` (harness agent listing) | full |
| `Explore` / `Plan` | "All tools except Agent, Artifact, ExitPlanMode, Edit, Write, NotebookEdit" (harness listing) | full — the exclusion list does not touch MCP |

Empirical proof of the researcher row: from THIS researcher session,
`mcp__hindsight__recall(query="Ken preferences Telegram switchroom fleet", bank_id="klanker")`
returned 2 results (scores 0.996 / 0.994) against the live engine. So a
sub-agent that has the tool hits the SAME bank as the parent.

**Footgun found while proving it:** the same MCP recall with
`budget:"low", max_tokens:200` returned `{"results":[]}` twice for the same
query, while a direct HTTP POST to
`/v1/default/banks/klanker/memories/recall` with `budget:"low",
max_tokens:300` returned hits. The MCP tool with small non-default budgets
silently returns empty where content exists; with its defaults
(`budget:"high", max_tokens:4096`) it works. Any "pull path" design that
tells agents to call recall with a trimmed budget should retest this.

### 1.2 Auto-recall (push) never reaches a sub-agent

- The only injection hook is `UserPromptSubmit` → `recall.py`
  (`.claude/plugins/hindsight-memory/hooks/hooks.json`, UserPromptSubmit block).
  Per the Claude Code hook contract, `UserPromptSubmit` fires on user prompt
  submission to the main loop; an Agent/Task dispatch is not one.
- Empirical: this researcher's own prompt arrived with **no injected memory
  block** (no "Relevant memories from past conversations" preamble,
  `HINDSIGHT_RECALL_PROMPT_PREAMBLE` absent from my context).
- The deployed recall log
  (`.claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl`,
  5000 rows) contains only main-session-shaped queries (Telegram inbounds,
  cron fires, `<task-notification>` wakeups) — no Task-prompt-shaped queries.

### 1.3 Sub-agent work IS retained — into the parent's bank, tagged

- `SubagentStop` → `subagent_retain.py` (hooks.json). It retains the last
  N=40 human turns of the sidechain transcript, **text-only**
  (`retainToolCalls` forced False, `subagent_retain.py:538`), into the
  **parent's bank** (`derive_bank_id` keys on cwd/session —
  `subagent_retain.py:446-449`), tagged
  `sidechain`, `parent_session:<id>`, `agent_type:<type>`
  (`subagent_retain.py:539-543`).
- Live confirmation: recall with `tags:["sidechain"]` against bank `klanker`
  returned 7 results carrying exactly those tags incl. `agent_type:worker`.
- `HINDSIGHT_RECALL_TAG_WEIGHTS={"sidechain":0.8}` (live env) is applied at
  recall-merge time as a score **multiplier that reorders without dropping**
  (`recall.py:918` `_apply_tag_weights`, comment at `recall.py:2380`).
- Known intake trade (documented in `subagent_retain.py:519-526`): facts that
  existed only in tool output are NOT retained — only sub-agent prose survives.

### 1.4 Net position for a `worker`

A `worker` sub-agent starts from its dispatch prompt plus whatever the parent
pasted in. It gets **no auto-recall injection** (1.2) and has **no Hindsight
tools to pull with** (1.1) — zero memory read path of any kind. Its prose
output is captured into the parent bank on SubagentStop (1.3), so it writes
to memory it can never read. Implementation work is delegated to exactly the
agent type with the blankest memory; `researcher`/`reviewer`/built-ins could
pull, but nothing in their prompts tells them to, and this researcher's
system prompt contains no mention of Hindsight tools.

## 2. Long sessions and compaction

### 2.1 Query derivation (deployed `recall.py` + `lib/content.py`)

Pipeline, per `recall.py:2003-2042`:
1. Latest prompt (envelope-stripped) + transcript messages read from the last
   `HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES=262144` bytes — but
   `compose_recall_query` only uses the last
   `HINDSIGHT_RECALL_CONTEXT_TURNS=2` user-boundary turns
   (`content.py:68-140`). The 256KB is a read bound, not a context window.
2. `truncate_recall_query` caps at `MAX_QUERY_CHARS=800`, dropping oldest
   context lines first, always preserving the latest message
   (`content.py:143-189`).
3. `shape_recall_query` caps at `QUERY_MAX_TOKENS=24` BM25 terms with
   merit-reserve + latest-turn-reserve + recency-weighted fill, stop terms
   incl. `switchroom`, `agent`, `sidechain` (`content.py:388-547`; live
   `HINDSIGHT_RECALL_QUERY_STOP_TERMS`).

**Verdict on length-degradation:** the query window is constantly myopic
(latest turn + 1 prior), so a long topic-drifting session does not produce a
progressively worse query — it produces the same *recent-2-turns* query it
always did. Recall quality per turn is independent of session length. What a
long session DOES lose is any recall keyed to the drifted-away earlier topic:
nothing re-queries older context. (This paragraph is reasoning from the
deployed code, not measurement.)

### 2.2 Measured long-session degradation vector: task-notification recall

Empirical, from the live recall log: **984 of 5000 rows (19.7%; 61 of the
last 200 = 30.5%)** are recalls fired on `<task-notification>` prompts — the
synthesized wakeups when a background sub-agent completes. Each is built from
task IDs, tool-use IDs and output-file paths (`query_chars: 800`, observed),
and each injected up to the full cap (observed `result_count: 16`,
`injected_own_bank_count: 14`; cap is `RECALL_MAX_MEMORIES=16` /
`RECALL_MAX_TOKENS=6144` live). Injected score medians ranged 0.065–0.95 on
the last three. In a delegation-heavy session this is the dominant recall
traffic: a large fraction of the session's memory-injection token budget is
spent on machine-generated prompts the user never wrote, with query text the
ack/trivial gates (`recall.py:1740-1770`) do not skip.

### 2.3 What is actually wired at compaction (deployed `settings.json` + plugin hooks.json)

- **`PreCompact` / `PostCompact`: NOT wired anywhere.** grep over the agent's
  `settings.json`, `settings.local.json`, and the plugin `hooks.json` finds
  zero matches.
- **`SessionStart` matcher `"compact"`** → `working-state-reload-hook.sh`
  (`settings.json` SessionStart block). Verified against
  `/opt/switchroom/bin/working-state-reload-hook.sh`: it (1) always injects a
  static "you were just compacted, the native summary is lossy" orientation
  block, (2) appends `$TELEGRAM_STATE_DIR/.working-state.md` verbatim if
  non-empty, (3) runs `handoff-briefing.sh --lean` — a recent-Telegram tail
  plus ONE Hindsight recall with the fixed query "what was happening
  recently?" (`handoff-briefing.sh:11-12,395-412`), 3s-capped,
  fail-graceful. Its header explicitly states PreCompact stdout is NOT
  injected while SessionStart(compact) stdout IS.
- **Plugin `SessionStart`** → `session_start.py` fires on compact too
  (matcher-less), but **injects nothing** — its docstring states every
  return path is a pure side effect (health probe + drain/reconcile), which
  is why it runs async.

So post-compaction footing today = native summary + static recovery block +
optional working-state file + one generic-query recall + Telegram tail. There
is no topic-specific memory re-seat: the lean briefing's recall query is
fixed, not derived from what the session was doing. The compacted session's
next real user prompt fires normal auto-recall (2-turn window over the
POST-compaction transcript), which does restore topic-keyed recall from the
first genuine message onward.

### 2.4 The honest gap vs design-v2 §2.2 / §2.3

- **§2.2 (Surface B, orientation-model read at SessionStart): does not exist
  in the deployment.** No hook anywhere calls `get_mental_model`; the only
  SessionStart injectors are the two above. §2.2's own text says the
  briefing "does NOT survive compaction … Post-compaction the agent
  re-orients on demand via `get_mental_model` as a tool (Surface C)" — i.e.
  the design as written makes post-compaction re-orientation a *pull*, and
  as wired today nothing would fire it. Note: if Surface B ships as a
  matcher-less SessionStart hook it WOULD re-fire at `source=compact`
  (SessionStart fires there — working-state-reload's header and our wiring
  confirm), so the design could get compaction re-seat for free by choosing
  the matcher deliberately; the current text doesn't claim it.
- **§2.3 (pull tools): mechanism exists for the MAIN session** —
  `mcp__hindsight__recall` / `get_mental_model` / `reflect` survive
  compaction because tool availability isn't context. But it is
  prompt-discipline-dependent (the design admits "residual pull-miss risk"),
  and the only post-compaction nudge toward pulling is the static block in
  working-state-reload-hook.sh, which names "recovery tools" generically.
  For sub-agents, §2.3's pull path is unavailable to `worker` entirely (§1.1).
- Judgment: after a compaction, the agent's footing is the native summary
  plus deterministic-but-generic re-seat. Whether that is "restored" depends
  almost wholly on native-summary quality plus whether the agent maintains
  `.working-state.md`; the design's claimed §2.2/§2.3 answer is not yet
  wired, and §2.3 alone would not fire without the model choosing to call it.

## Evidence index

- `worker.md:5`, `researcher.md:1-6`, `reviewer.md:1-5` (deployed agent defs)
- `.claude/plugins/hindsight-memory/hooks/hooks.json` (deployed hook wiring)
- `scripts/recall.py:1697-1770` (gates), `:2003-2042` (query pipeline),
  `:918/:2380` (tag weights), `:995` (log path)
- `scripts/lib/content.py:68-140, 143-189, 388-547`
- `scripts/subagent_retain.py:446-449, 519-543`
- `scripts/session_start.py:1-40` (inject-nothing SessionStart)
- `/opt/switchroom/bin/working-state-reload-hook.sh`,
  `/opt/switchroom/bin/handoff-briefing.sh:11-12,395-412`
- `.claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl`
  (5000 rows; 984 task-notification)
- Live engine: recall on bank `klanker` over HTTP and MCP (this session);
  sidechain-tagged recall returned 7 tagged results.
- Live env: `HINDSIGHT_RECALL_*` values captured 2026-08-16.
