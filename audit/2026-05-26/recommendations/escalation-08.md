# Recommendation: Escalation 8 — run-a-fleet-of-specialists:c9 (Hindsight memory orphans on destroy)

**Recommended option:** B

**Confidence:** high

## Why

The core question for this escalation is whether an orphaned Hindsight bank is a leak or a recovery feature. The answer is: it is a recovery feature in disguise, and that changes the calculus significantly.

The `bankId` for any agent is derived as `agentMemory?.collection ?? agentName` (see `src/agents/scaffold.ts:1613` and `src/memory/hindsight.ts:76`). When no explicit `memory.collection` override is set — which is the default for every agent — the bank ID is simply the agent name. The `createBank` call in scaffold.ts (line 2896) is explicitly documented as idempotent: "Create a new memory bank or get an existing one — so calling this on an already-existing bank is a no-op and returns success" (`src/memory/hindsight.ts:392-394`). This means if an agent named `clerk` is destroyed and then re-created with the same name, its first scaffold run will call `createBank("clerk")`, Hindsight will recognize the existing bank, and the agent will silently resume with its full memory history. The orphaned bank was actually a restoration point, not waste.

This re-attach behaviour is architecturally desirable. Accidental destroys, name collisions after a reconfiguration, or a fleet rebuild from scratch all benefit from memory persistence in the backing store. The JTBD claim "removing an agent is clean ... no orphaned processes or dangling config" is specifically about processes and config — not about persistent data stores. The wording does not promise data erasure, only operational cleanliness. Interpreting it to mandate automatic bank deletion would be the wrong reading; the analogous expectation would be that destroying a database-backed service should also DROP the database schema, which is almost never correct behavior.

There is also a practical implementation blocker for Option A. Neither the vendored `HindsightClient` (`vendor/hindsight-memory/scripts/lib/client.py`) nor the switchroom Hindsight bindings (`src/memory/hindsight.ts`) expose a `delete_bank` call. A search across the entire repository finds no `DELETE /banks/{id}` call anywhere. Whether Hindsight's upstream REST API even exposes a bank deletion endpoint is not confirmed by any code in this repository. Wiring Option A would require: confirming the upstream API supports bank deletion, adding a `deleteBank` function to `src/memory/hindsight.ts`, calling it in the destroy flow, and handling the case where Hindsight is unreachable at destroy time (should destroy be blocked, or should the orphan be left anyway?). The failure mode where destroy aborts because Hindsight is offline is strictly worse UX than the current silent orphan.

## Tradeoffs of the recommendation

- Operators who destroy an agent permanently and never re-create it accumulate storage in the Hindsight database with no self-service cleanup path. On a fleet that cycles agents regularly, this compounds.
- The current `mcp__hindsight__delete_memory` tool (available to agents in-session) only deletes individual memories, not the whole bank. Operators have no single-command purge path today.
- Updating the JTBD claim in `reference/run-a-fleet-of-specialists.md` to be accurate about Hindsight data persistence is low-risk and takes 1-2 lines.
- A documentation path to the cleanup command is achievable now; a product path (Option A or C) is achievable later without reopening this decision.
- Option B does not preclude adding a `switchroom agent destroy --purge-memory` flag in a later PR once the upstream delete API is confirmed.

## If you pick a different option

- **Option A:** Wire memory purge in the destroy flow. Before implementing, confirm that `DELETE /v1/default/banks/{bank_id}` exists in the Hindsight REST API — it is absent from the vendored client. If it exists, add `deleteBank()` to `src/memory/hindsight.ts`, call it in the destroy flow after `rmSync`, and handle the offline case gracefully (warn, do not block destroy). If the bank ID was overridden via `memory.collection`, destroying the wrong name is possible — read the config before removing the agent directory. Risk: breaks the re-attach recovery path; any accidental destroy loses memory permanently.
- **Option C:** Soft-delete / archive the collection. Requires Hindsight to support an archival state (not confirmed from current API surface), adds a separate cleanup command, and introduces a two-phase delete UX that operators will find confusing. Adds complexity with limited benefit over Option B + a future `--purge-memory` flag.

## Open question for the operator

Does Hindsight's REST API expose a bank deletion endpoint (`DELETE /v1/default/banks/{id}`)? This single fact determines whether Option A is even wirable without a custom workaround, and should be confirmed before any implementation work begins.
