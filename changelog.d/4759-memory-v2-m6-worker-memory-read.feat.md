- **memory: M6 worker read-only Hindsight recall + cross-bank guard (#4759)**

  Worker sub-agents now carry a small, read-only Hindsight tool grant
  (`recall`, `get_mental_model`, `get_knowledge_tree`, `get_knowledge_page`,
  `search_knowledge_pages`) on the default worker allowlist, so a delegated
  worker can pull its own bank's prior context instead of only inheriting
  whatever the parent pasted into the dispatch prompt. No write verb
  (`retain`, `create_directive`, …) and no `mcp__hindsight__*` wildcard are
  granted.

  Because `recall`, `get_mental_model`, and every other read-only Hindsight
  MCP tool that accepts a caller-supplied `bank_id` (`reflect`, `get_memory`,
  `list_memories`, `list_directives`, `get_bank`, `get_bank_stats`,
  `get_document`, `get_operation`, `list_documents`, `list_mental_models`,
  `list_operations`, `list_tags`) forward it to the engine verbatim with no
  grant validation of their own (M6/E-86 red-team §1 — low-entropy,
  agent-name-shaped bank ids make cross-bank reads guessable, and this
  applies to any prompt-injected caller of the shim, worker or main agent),
  **over the stdio MCP transport** (the fleet default) the shim now rejects
  any `bank_id` on those read tools that does not match the caller's own
  pinned bank (`guardBankScope` / `BANK_SCOPE_GUARDED_TOOLS` in
  `src/cli/hindsight-mcp-shim.ts`). The guard is deliberately scoped to
  READ tools only — `retain`'s documented cross-bank write pattern
  (`bank_id="switchroom-dev"`, routing durable repo knowledge to the shared
  repo bank) is untouched, and any other write tool's `bank_id` is likewise
  unguarded.

  **This guard does not cover a hypothetical `mcp_transport: http`
  deployment.** Under stdio, every `tools/call` this shim's process makes
  passes through `guardAndClampToolCall`. If an operator instead sets
  `mcp_transport: http`, agents talk to the Hindsight engine directly over
  HTTP with an `X-Bank-Id` header and never touch this shim process at all,
  so the guard is bypassed entirely. Not exploitable today — the fleet's
  default (and every current deployment) is stdio — but must be closed
  before http transport is enabled for any agent. Tracked as a follow-up.
