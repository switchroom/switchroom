# Drift audit -- run pilot-2026-05-26

**Date:** 2026-05-26
**Scope:** pilot -- 23 units in `reference/` (3 contract, 14 jtbd, 1 artefact-current, 1 rfc-shipped, 1 rfc-draft, 1 archived, 2 historical)
**Triage date:** 2026-05-27
**Total findings:** 193 claims across 23 units

## Verdict distribution

| Verdict | Count |
|---|---|
| aligned | 113 |
| drift-minor | 24 |
| drift-major | 22 |
| outcome-not-realized | 17 |
| code-violates-contract | 1 |
| contract-example-stale | 6 |
| jtbd-too-technical | 1 |
| jtbd-stale-example | 4 |
| dead-pointer | 7 |
| archive-leaks | 4 |
| rfc-status-wrong | 1 |
| vision-only | 5 |

Fix-eligible (drift-minor + drift-major + stale examples + dead-pointer + rfc-status-wrong + archive-leaks): 69 findings -> 10 fix batches
Escalated (outcome-not-realized + code-violates-contract): 18 escalations + 2 low-confidence flags

## By category

| Category | Units | Total claims | aligned | drift | escalated |
|---|---|---|---|---|---|
| contract | 3 | 33 | 21 | 11 | 1 |
| jtbd | 14 | 134 | 86 | 28 | 20 |
| artefact-current | 1 | 12 | 10 | 2 | 0 |
| rfc-shipped | 1 | 12 | 4 | 6 | 0 |
| rfc-draft | 1 | 10 | 3 | 7 | 0 |
| archived | 1 | 4 | 3 | 1 | 0 |
| historical | 2 | 8 | 4 | 2 | 0 |

## Top-5 hotspots by non-aligned finding count

1. **jtbd-restart-and-know-what-im-running** (7 non-aligned). 6 outcome-not-realized + 1 drift-minor. PR #142 moved model/tools/skills/memory visibility off the proactive boot card and onto the on-demand `/status` command. The JTBD says "no need to ask" but every config-visibility UAT scenario requires the user to ask.

2. **rfc-docker-multi-container** (7 non-aligned). 1 rfc-status-wrong + 6 drift-major. Frontmatter says Draft while the body says shipped (v0.7). Body has stale UIDs (1100-range vs actual 10001-10999), image count (4 vs 7), CLI verb (`reconcile` vs `apply`), process topology (MCP-child vs supervised sidecar), and compose skeleton (`version: "3.9"` vs current output).

3. **rfc-sub-agent-visibility** (7 non-aligned). 5 dead-pointer + 1 drift-major + 1 drift-minor. The progress-card-driver.ts was deleted in PR #1122; `progressDriver` is permanently null in gateway.ts. All five ACs describe a deleted mechanism.

4. **jtbd-give-each-agent-its-own-workspace** (7 non-aligned). 4 outcome-not-realized + 2 drift-major + 1 vision-only. `ensureAgentWorktree` and `ensureBareClone` are imported in scaffold.ts but never called from production lifecycle paths. Every "Signs it's working" scenario describes behavior that cannot happen at runtime.

5. **contract-principles** (6 non-aligned). All 6 are contract-example-stale. Stale CLI examples: `auth login` (removed), privacy-mode detection (static not dynamic), `vault set` success message, `--profile executive` (should be `executive-assistant`), three-command upgrade (superseded by `switchroom update`), and `defaults.skills_auto` (field does not exist).

## Recurring themes

- **`switchroom update` not reflected.** `jtbd-idempotent-update-and-restart`, `contract-principles:c8`, and `jtbd-share-auth-across-the-fleet` still name the pre-#918 three-command incantation (`apply + docker compose pull + up -d`). Shipped surface is `switchroom update`.

- **Stale auth verbs.** Three units cite `auth login`, `auth enable`, or `switchroom auth account list` -- all removed under RFC H. Correct verbs: `auth add`, `auth reauth`, `auth use`, `auth show`.

- **UID range discrepancy in rfc-docker-multi-container.** Four sites in the RFC body cite `1100 + hash % 800`; shipped code uses `AGENT_UID_MIN=10001` / `AGENT_UID_MAX=10999`.

- **Boot card vs. `/status` gap.** PR #142 decision: model/tools/skills/memory-backend moved off the boot card. The JTBD ("no need to ask") is aspirational, not realized. Requires product decision, not a doc edit.

- **Progress card retirement ripple.** `rfc-sub-agent-visibility` has 5 dead-pointers for `progress-card-driver.ts`, `two-zone-card.ts`, and related UAT infrastructure. The card was deleted in #1122 PR3.

- **Quota push gap.** `jtbd-track-plan-quota-live` has 4 outcome-not-realized findings: no threshold-tier warning (only fatal push), no window-roll recovery push, no ambient ongoing display. Current design is pull-only (`/usage`) plus fatal-only push.

- **`ensureAgentWorktree` dead import.** Imported in `scaffold.ts` but never called from `scaffoldAgent` or `reconcileAgent`. The entire `jtbd-give-each-agent-its-own-workspace` outcome is paper-only.

- **Wrong emoji sequence in design artefact and agent prompt.** Both `reference/conversational-pacing.md` and `profiles/_shared/telegram-style.md.hbs` cite `+->+->+->+` as the reaction lifecycle. The code reserves + for 5xx operator-events; the working-state emoji is +. This misinforms the model itself via the prompt template.

- **`reference/PRD.md` deleted.** Was deleted in PR #534. The audit manifest and README still list it as a unit to audit.

## Coverage notes

- **`historical-prd`:** `reference/PRD.md` does not exist (deleted PR #534, commit 8bdb86cb). No content audit was possible. This is manifest hygiene only. The manifest entry and `scripts/drift-audit/README.md` table row both need updating.

- **`jtbd-give-each-agent-its-own-workspace`:** Three `vision-only` findings (c5, c10, c15) with low confidence on c15. These mark design intent that has code structure but no production wiring.

- **`rfc-sub-agent-visibility`:** Dead-pointer findings reference code only in `node_modules/@switchroom-ai/telegram-plugin/` (published npm snapshot), not the active source tree. The UAT scenario `bg-sub-agent-dispatch-dm.test.ts` tests infrastructure (`expectPinnedCard`) that would fail immediately in a live run.

- **`jtbd-share-auth-across-the-fleet`:** `src/auth/migrate-schema.ts` exists and is tested but is not imported from any production code path. The "first apply" wiring referenced in schema comments appears absent from `apply.ts`. Flagged in escalations as a low-confidence wiring question.

- **`jtbd-talk-to-agents-from-anywhere:c10`:** Dead-zone recovery is `vision-only` with `low` confidence. The long-poll gateway resumes naturally after a connectivity gap, but there is no specific dead-zone detection or recovery message path.
