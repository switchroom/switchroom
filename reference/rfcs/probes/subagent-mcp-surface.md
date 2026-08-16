# Probe: does a sub-agent inherit the Hindsight MCP surface? (design-v2 §8.8)

**Verdict: Mostly yes, but tool-type-dependent, and NOT hook-symmetric.**
`researcher`/`reviewer`/`general-purpose` sub-agents get the full `mcp__hindsight__*`
surface pinned to the SAME bank as the parent agent. `worker` sub-agents are
explicitly denied all Hindsight tools by an allowlist. All sub-agent types DO
feed memory back via a dedicated `SubagentStop` hook (not hook-free), but only
as a bounded, text-only, LLM-filtered retain — no live recall inside the
sub-agent turn itself.

Repo used: `/host/~/switchroom` (git HEAD `6979a932989f`,
2026-08-10 03:51:51 +1000 — see caveat #6 on staleness).

## 1. Do sub-agents get the Hindsight MCP tools at all?

Checked klanker's own agent definitions (this agent's actual runtime config,
not the target repo's defaults):
`~/.switchroom/agents/klanker/.claude/agents/{worker,researcher,reviewer}.md`

- `worker.md:5` — explicit `tools:` frontmatter: `Read, Edit, Write, Bash, Grep,
  Glob, TodoWrite, WebSearch, mcp__webkite__*, mcp__switchroom-telegram__progress_update`.
  **No `mcp__hindsight__*` entry.** This is an allowlist, so worker sub-agents
  cannot call any Hindsight tool — confirmed both by reading the file and by
  the live agent-type listing this session was given ("worker: ... Tools: Read,
  Edit, Write, Bash, Grep, Glob, TodoWrite, WebSearch, mcp__webkite__*,
  mcp__switchroom-telegram__progress_update" — no hindsight tools).
- `researcher.md` and `reviewer.md` carry **no `tools:` key at all** — per
  Claude Code's subagent semantics, omitting `tools:` inherits the full parent
  toolset. Confirmed live: the system's own agent-type listing this turn shows
  "researcher: ... (Tools: All tools)" and "reviewer: ... (Tools: All tools)",
  and "general-purpose: ... (Tools: *)". All three therefore DO get
  `mcp__hindsight__*`.

So the answer is split by sub-agent type, not uniform. This directly
contradicts any design assumption that "sub-agents" as a class either all have
or all lack the surface — it depends on which of the four types is dispatched,
and `worker` (the type used for repo-editing work per klanker's own
CLAUDE.md Delegation section: "changes code (`@worker`)") is the one that is
CUT OFF.

## 2. Which bank does a sub-agent that DOES get the tools reach?

`src/cli/hindsight-mcp-shim.ts:39,63-67` — the shim is spawned as the `hindsight`
MCP stdio server and pins `HINDSIGHT_BANK_ID` from its env at spawn time (an
`env` block on the `.mcp.json` entry, set once per agent container). MCP
servers in Claude Code are registered once per top-level session and shared by
in-process Task-tool sub-agents — there is no evidence in this codebase of a
per-sub-agent respawn of the `hindsight` MCP server or a different bank id
threaded to one. So a `researcher`/`reviewer`/`general-purpose` sub-agent that
calls `mcp__hindsight__recall` etc. reaches **the identical parent agent's own
bank**, not a separate one and not none.

This is corroborated independently by the `SubagentStop` retain hook (item 4
below): `subagent_retain.py` calls `derive_bank_id(hook_input, config)` from
`vendor/hindsight-memory/scripts/lib/bank.py:31-48`, which in static mode
(the default; `dynamicBankId: false`) returns the single configured
`config["bankId"]` — the same value the parent session's recall/retain hooks
use, since `hook_input` for a sub-agent still carries the parent's
`session_id`/`cwd`/config. Two independent code paths (MCP env pin, hook bank
derivation) agree: same bank as parent, always.

## 3. Can a sub-agent reach a DIFFERENT bank via `bank_id`?

Confirmed still true, and narrower than the RFC's framing suggests:

- For the 32 real upstream Hindsight tools (`recall`, `retain`, `list_memories`,
  etc.), `bank_id` IS a real, accepted argument
  (`FALLBACK_TOOL_TABLE` throughout `hindsight-mcp-shim.ts:190-223`, e.g.
  `recall: [["query"], ["bank_id", "budget", ...]]`) and is forwarded upstream
  unmodified via `guardAndClampToolCall`/`toolsCall` (`hindsight-mcp-shim.ts:1511-1588`).
  So a cross-bank READ via `bank_id` on `recall`/`list_memories`/etc. is
  possible from any sub-agent that has the tool at all — consistent with the
  engine resolving `arguments.get("bank_id") or session bank` cited in the
  task brief (not independently re-verified here; upstream `mcp_tools.py` is
  not vendored into this repo — see caveat #6).
- For the three shim-**synthesized** knowledge-page tools
  (`search_knowledge_pages`, `get_knowledge_page`, `get_knowledge_tree`),
  `bank_id` is **deliberately absent** from the schema —
  `hindsight-mcp-shim.ts:259-262`: "NOTE the deliberate absence of a `bank_id`
  property. The bank is pinned from `HINDSIGHT_BANK_ID`; a caller cannot name
  one." Enforced in code, not just documented: `synthesizedCall()`
  (`hindsight-mcp-shim.ts:1385-1436`) rejects any unknown arg, and explicitly
  special-cases `bank_id` in the error text
  (`hindsight-mcp-shim.ts:1401-1404`: "This tool always operates on your own
  memory bank; there is no way to target another agent's bank through it.").
  `KnowledgeAdmin` (`src/memory/hindsight-knowledge-admin.ts:133-189`) takes
  `bankId` only from constructor options, never from a request parameter.

**Implication for the repo-knowledge-pages proposal**: an agent (main session
or a `researcher`/`reviewer`/`general-purpose` sub-agent — never a `worker`)
CAN read another bank's raw memories via `recall(bank_id=...)`, but CANNOT read
another bank's curated knowledge PAGES at all — own-bank only, no escape
hatch. If §8.8's design has agents reading a shared "repo bank"'s knowledge
pages from their own agent identity, that specific mechanism does not exist
today; only a shared bank's raw `recall` is reachable cross-bank, and only from
tool-types that have `mcp__hindsight__*` in the first place.

## 4. Does sub-agent memory activity hit hooks, or is it hook-free?

Not hook-free, but asymmetric between recall and retain:

- **Recall side**: `vendor/hindsight-memory/hooks/hooks.json:15-25` wires
  `recall.py` only to `UserPromptSubmit`. `UserPromptSubmit` fires on
  top-level user prompts to the main session, not on a sub-agent's internal
  turns — there is no `SubagentPromptSubmit` event in this hooks.json. So a
  sub-agent that DOES have `mcp__hindsight__recall` must call it explicitly;
  it gets no automatic pre-turn recall injection the way the main session
  does.
- **Retain side**: `hooks.json:26-58` wires TWO different hooks:
  `Stop` → `retain.py` (main session only, reads the parent `transcript_path`)
  and **`SubagentStop` → `subagent_retain.py`** (dedicated). So sub-agent work
  — including a `worker` sub-agent that has NO Hindsight MCP tools at all —
  still gets captured into memory, just via a hook path rather than a live
  tool call the sub-agent itself makes.

`subagent_retain.py` (`vendor/hindsight-memory/scripts/subagent_retain.py`)
specifics, read directly:
- Resolves the sidechain transcript from `agent_transcript_path` (first-class
  SubagentStop field, probe-confirmed against Claude Code 2.1.215 per the
  file's own docstring), falling back to a derived path or a bounded dir scan.
- Volume gate: skips sub-agents under `MIN_HUMAN_TURNS=6` or
  `MIN_NON_TOOL_RESULT_CHARS=2000` (lines 92-93) — short/trivial forks are
  never retained.
- Retains only the **text-only** formatting path (`retainToolCalls=False`
  forced) — tool_use inputs, tool_result bodies, file contents/diffs are
  dropped; only the sub-agent's own prose (reasoning, findings, final report)
  is eligible (lines 12-16).
- Tagged `sidechain` + `parent_session:<id>`, deterministic content-derived
  `document_id` so re-fires upsert (lines 21, 27).
- Failures enqueue to the same durability queue `retain.py` uses, drained at
  next `SessionStart` (line 28).

Net: a `worker` sub-agent's substantive findings CAN still land in the bank —
via this async, filtered, post-hoc hook — even though the sub-agent itself
could never call `retain` or `recall` live during its own turn.

## 5. `enable_observation_history` — does not exist; the real flag is on

Grepped the whole repo (excluding worktrees/node_modules) for
`enable_observation_history` — zero hits, in either `.ts` or `.py`. The
config key that actually exists and gates observation writes is
**`enable_observations`** (`src/cli/doctor-observation-scopes.ts:381,697`,
also present in `docker/Dockerfile.hindsight`'s migration notes).

Live probe, `GET http://127.0.0.1:18888/v1/default/banks/klanker/config`
(this agent's own bank, run this turn): the config blob returned includes
`"enable_observations": true` and `"enable_auto_consolidation": true`. So
whatever migration step 1(a) needs is satisfied for at least this bank — but
if the design doc's step literally depends on a field spelled
`enable_observation_history`, that field is not part of Hindsight's schema as
deployed here; the RFC text should be corrected to `enable_observations`
before anyone treats it as an actionable migration precondition.

## 6. What was NOT verified / caveats

- Did not empirically dispatch a live `researcher`/`worker` sub-agent and
  watch its actual tool list at runtime — the evidence for item 1 is (a) the
  frontmatter files read directly and (b) this session's own live
  agent-type roster shown by the harness (not something I could have
  fabricated formatting for; it's system-injected), which is strong but is
  still declarative config, not an observed `tools/list` call from inside a
  spawned sub-agent.
- Did not independently re-verify the `mcp_tools.py:521`
  `arguments.get("bank_id") or session bank` claim — that file is upstream
  Hindsight engine source, not vendored into `switchroom` (`find` for
  `mcp_tools.py` under the repo returned nothing). Took the task brief's
  "recent finding (verified)" at face value for item 3's first half; only the
  shim-side `bank_id`-forwarding behavior and the knowledge-tools' absence of
  `bank_id` were independently confirmed from source in this repo.
- Repo checkout used (`/host/~/switchroom`) is HEAD
  `6979a932` at 2026-08-10 03:51:51 +1000, six days stale against today
  (2026-08-16); a sibling checkout `/host/~/code/switchroom` is
  at a different, older commit (`d8e9d246`, 2026-08-09). Did not check
  `git status`/diff between them or against `origin/main` — if `reference/rfcs/design-v2.md`
  or the RFC ledger assume a newer unmerged change to the shim or hooks, this
  probe would miss it.
- `enable_observation_history` was checked against exactly one bank's live
  config (`klanker`); did not enumerate every bank on the service to see if
  any carries a differently-spelled or bank-specific override, though the
  schema dump shows the full accepted key set and no such key exists for any
  bank under this config schema.
