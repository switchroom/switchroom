# Recommendation: Escalation 2 — give-each-agent-its-own-workspace:c2,c3,c12 (worktree provisioning never wired)

**Recommended option:** A (wire the provisioning)

**Confidence:** high

## Why

The partial implementation is not a stub — it is a complete, well-reasoned implementation. `src/repos/bare-clone.ts` (72 lines) handles idempotent bare-clone creation and fetch-all refresh with graceful network-failure handling. `src/repos/agent-worktree.ts` (323 lines) handles first-create, clean-ff, dirty-skip, dirty-commit surfacing, removal, prune, and orphan detection — the full lifecycle described in the JTBD's "Decisions" section. Both files have proper docstrings, match the design exactly (bare clone at `~/.switchroom/repos/<slug>.git`, worktree at `<agentDir>/work/<slug>/`, branch `agent/<agentName>/main`), and are idempotent and safe to call on every reconcile. This is not a half-written sketch that would require architectural decisions; it is a complete feature waiting for a two-line call site.

The gap is entirely at the integration layer. `src/agents/scaffold.ts` imports all five symbols (`ensureBareClone`, `bareClonePath`, `ensureAgentWorktree`, `removeAgentWorktree`, `listAgentWorktrees`) but calls only `agentWorktreePath` — to compute a deterministic path that gets injected as `SWITCHROOM_REPO_<SLUG_UPPER>` into `start.sh` via `buildRepoEnvVars` (scaffold.ts:1135-1148, called at lines 1817 and 3855). The env var injection is fully wired in both `scaffoldAgent` and `reconcileAgent`. The bare-clone creation and worktree provisioning that those paths point at are not. The result is exactly as the escalation states: the env var is injected pointing to a path that does not exist on disk.

The `repos:` schema field is complete and documented (`src/config/schema.ts:1592-1623`), `docs/configuration.md:544-550` already tells operators to use `repos:` for the git-repo use case (not `bind_mounts:`), and `docs/rfcs/host-control-daemon.md` references the pattern as the canonical path for repo-editing agents. The feature is committed to in user-facing documentation. Option B (remove) would invalidate that documentation and require operators who read it to get a confusing silent failure. Option C (disclaim) is awkward given that the schema already validates and accepts `repos:` entries — operators can configure it today and will receive broken behavior with no warning.

The wiring delta is small and low-risk: in `reconcileAgent`, after the existing agentDir existence check (scaffold.ts:3678), call `ensureBareClone` for each entry in `agentConfig.repos`, then call `ensureAgentWorktree` with the returned clone path. Mirror `removeAgentWorktree` in the agent-remove path (wherever `scaffoldAgent` teardown lives). Both functions are already idempotent; calling them on a reconcile that has no `repos:` config is a no-op (the `if (!repos) return {}` guard at scaffold.ts:1141 shows the pattern). The only non-trivial question is whether `reconcileAgent` needs to become `async` — it is currently synchronous, and both provisioning functions are async (they shell out via `execFileSync`, so they could be sync too, but are declared async). That is the one real decision point.

## Tradeoffs of the recommendation

- Wiring the provisioning makes `reconcileAgent` either async (ripple through callers) or requires wrapping in `spawnSync`-style calls — the implementation functions use `execFileSync` internally so could be synchronous, but their exported signatures are `async`. A small refactor to make them synchronous, or a `Promise.resolve` wrapper at the call site, would avoid the async refactor.
- The `removeAgentWorktree` teardown path needs to be found and wired — it was not located during this audit. If the agent-remove path exists in `src/cli/agent.ts` or `src/agents/lifecycle.ts`, adding the removal call there is required for the "removal is symmetric" JTBD contract.
- First reconcile after a user adds `repos:` will block on `git clone --bare` — network-latency at reconcile time. The existing `ensureBareClone` already handles the non-fatal fetch-fail path gracefully.
- The env var injection is already shipping to agents configured with `repos:`. Those agents currently get a valid-looking env var pointing at a nonexistent path. Wiring the provisioning fixes this silently on the next restart with no user action needed.

## If you pick a different option

- **Option B (remove):** Requires removing the `repos:` schema field, `buildRepoEnvVars`, all five imports, and the `docs/configuration.md:544-550` guidance that tells operators to use `repos:` for this use case. Net deletion of ~430 lines of tested implementation. Configuration breakage is silent — operators who followed the docs will have invalid YAML after the schema removal (or worse, their configs will silently stop working if the field becomes unknown). Given the volume of surrounding documentation that already commits to this design, removal is disruptive without a clear payoff.
- **Option C (disclaim):** The schema accepts `repos:` today with no warning. An operator who configures it and restarts an agent will see `SWITCHROOM_REPO_<SLUG>` in their agent's environment pointing at a path that does not exist — the agent will silently fail to find the repo. A disclaimer in the JTBD file does not surface at the point of failure. This is worse than the current state, which at least doesn't fail with mysterious side effects on most operators (since few will have discovered `repos:` without documentation that currently says it works).

## Open question for the operator

`reconcileAgent` is synchronous today — do you want the worktree-provisioning call sites to refactor the provisioning functions to synchronous signatures (straightforward, since they already use `execFileSync` internally), or do you want `reconcileAgent` to become async (larger ripple through callers in `src/cli/agent.ts` and `src/cli/apply.ts`)?
