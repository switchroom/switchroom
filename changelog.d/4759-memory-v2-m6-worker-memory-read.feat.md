- **memory: M6 worker read-only Hindsight recall + cross-bank guard (#4759)**

  Worker sub-agents now carry a small, read-only Hindsight tool grant
  (`recall`, `get_mental_model`, `get_knowledge_tree`, `get_knowledge_page`,
  `search_knowledge_pages`) on the default worker allowlist, so a delegated
  worker can pull its own bank's prior context instead of only inheriting
  whatever the parent pasted into the dispatch prompt. No write verb
  (`retain`, `create_directive`, …) and no `mcp__hindsight__*` wildcard are
  granted.

  Because `recall` and `get_mental_model` both accept a caller-supplied
  `bank_id` that the engine forwards verbatim with no grant validation
  (M6/E-86 red-team §1 — low-entropy, agent-name-shaped bank ids make
  cross-bank reads guessable), the shim now rejects any `bank_id` on those
  two tools that does not match the caller's own pinned bank
  (`guardBankScope` / `BANK_SCOPE_GUARDED_TOOLS` in
  `src/cli/hindsight-mcp-shim.ts`). The guard is deliberately scoped to just
  those two tools — `retain`'s documented cross-bank write pattern
  (`bank_id="switchroom-dev"`, routing durable repo knowledge to the shared
  repo bank) is untouched.
