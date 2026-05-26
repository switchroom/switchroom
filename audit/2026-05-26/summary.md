# Drift-Audit Summary — 2026-05-26

**Scope:** pilot — 23 units across `reference/` (3 contract, 14 JTBD, 1 artefact-current,
1 rfc-shipped, 1 rfc-draft, 1 archived, 2 historical)
**Total findings:** 306 across 23 units
**Run date:** 2026-05-26

---

## Verdict distribution (all units)

| Verdict | Count |
|---|---|
| aligned | ~167 |
| drift-minor | ~46 |
| drift-major | ~35 |
| contract-example-stale | 7 |
| jtbd-stale-example | 10 |
| outcome-not-realized | 5 |
| code-violates-contract | 1 |
| rfc-status-wrong | 1 |
| dead-pointer | 5 |
| disclaimer-stale | 1 |
| archive-leaks | 4 |
| vision-only | 11 |
| jtbd-too-technical | 1 |

---

## By category

**contract** (3 units, ~33 findings)
- `contract-vision`: 11 findings — 10 aligned, 1 code-violates-contract (escalated)
- `contract-principles`: 14 findings — 4 aligned, 7 contract-example-stale (all update-text), 3 aligned
- `contract-reference-readme`: 8 findings — 2 aligned, 4 drift-minor/major (update-text), 2 drift-major

**jtbd** (14 units, ~195 findings)
- Roughly 120 aligned; ~40 drift-minor; ~20 drift-major/stale-example; 5 outcome-not-realized; 11 vision-only

**artefact-current** (1 unit, 17 findings)
- 12 aligned, 4 drift-minor (update-text), 1 drift-minor (PostHog KPI gap)

**rfc-shipped** (1 unit, 12 findings)
- 4 aligned, 2 drift-minor, 4 drift-major/dead-pointer, 1 low-confidence escalated

**rfc-draft** (1 unit, 14 findings)
- 5 aligned, 4 drift-minor, 2 drift-major, 1 rfc-status-wrong, 1 dead-pointer, 1 drift-minor

**archived** (1 unit, 6 findings)
- 5 aligned, 1 archive-leaks (fix in `telegram-plugin/uat/assertions.ts`)

**historical** (2 units, 17 findings)
- `historical-prd`: 9 non-aligned (disclaimer-stale, drift-major x5, dead-pointer x2, drift-minor)
- `historical-onboarding-gap-analysis`: 3 archive-leaks in external referrers (`reference/README.md`, `docs/workspace-files.md`)

---

## Top-5 hotspots (most non-aligned findings)

1. **historical-prd** — 9 non-aligned. Plugin default inverted, deployment model inverted, npm package name wrong, `switchroom systemd` verbs unreachable, `template:` → `extends:` rename, `switchroom init --docker` never built.
2. **rfc-sub-agent-visibility** — 8 non-aligned. `two-zone-card.ts` never created, line numbers dead (file is 1222 lines not 1921+), `hasLiveBackground` replaced by `hasInFlightSubAgents`, fleet cap `cap()` defined but never called by renderer.
3. **rfc-docker-multi-container** — 8 non-aligned. Frontmatter says Draft when body says shipped v0.7; UID range changed 1100-1899 → 10001-10999; GHCR image count 4 → 7; `switchroom reconcile` → `apply`; `version: "3.9"` removed.
4. **contract-principles** — 7 contract-example-stale. `auth login` removed (RFC H); three-step upgrade → `switchroom update`; `executive` → `executive-assistant` profile; `defaults.skills_auto` does not exist.
5. **jtbd-restart-and-know-what-im-running** — 7 non-aligned. Boot card does not surface model/tools/skills/memory on healthy restart (SessionStart greeting deleted PR #142); five UAT examples test behavior that is only in `/status`.

---

## Recurring themes

- **Auth CLI surface obsoleted by RFC H.** `auth login`, `auth enable`, `auth account add|list` appear in principles.md, fleet-auth JTBD UAT prompts, and RFC H body. All replaced by `auth add / auth use / auth list / auth show`.
- **`switchroom update` (PR #918) not reflected.** Three-step manual upgrade sequence still described in contract-principles c6, jtbd-idempotent-update-and-restart c1/c10/c13, rfc-docker-multi-container c3. `switchroom update` is now canonical.
- **`switchroom reconcile` → `switchroom apply`.** RFC docker body uses `reconcile` throughout; shipped verb is `apply`.
- **Pinned progress card retired #1122 PR3.** Most units handle this correctly, but jtbd-steer-or-queue-mid-flight c10, jtbd-talk-to-agents-from-anywhere c12, and `telegram-plugin/server.ts` L33 still reference the card as current.
- **Boot card vs /status scope confusion.** jtbd-restart-and-know-what-im-running promises model/tools/skills/memory on restart; moved to /status in PR #142. Multiple UAT examples test behaviors that only live in /status.
- **Per-agent workspace provisioning not wired end-to-end.** `ensureAgentWorktree` and `ensureBareClone` exist in `src/repos/` but have zero production call sites. Three JTBD claims are outcome-not-realized.
- **Profile name mismatch.** `executive` vs `executive-assistant` appears in principles.md example and would fail at runtime.

---

## Coverage notes

- `contract-vision` c8 (OpenAI embeddings + Whisper = external API spend) is medium confidence — escalated.
- `jtbd-give-each-agent-its-own-workspace` c2/c3/c12 (worktree provisioning) are high-confidence outcome-not-realized — escalated.
- `jtbd-restart-and-know-what-im-running` c3/c8 (model/tools not surfaced) are high-confidence outcome-not-realized — escalated.
- `jtbd-track-plan-quota-live` c2/c7 (proactive quota push) are medium-confidence outcome-not-realized — escalated.
- `rfc-sub-agent-visibility` c11 (AC-4 stuck-render pipeline) has low confidence — escalated.
- `jtbd-feel-like-a-colleague` c9 (non-technical user cannot tell it's an AI) is vision-only with low evidence — escalated for operator awareness.

---

**Note:** The 23 detailed findings YAML files (`audit/2026-05-26/findings/*.yaml`)
and the 19 fix-batches (`audit/2026-05-26/fix-batches/*.md`) were lost when the
working directory was re-oriented to a fresh upstream clone. This summary and
the `escalations.md` file (with inline recommendations) survived because they
were read into the orchestrator's conversation context. To recover the findings
and fix-batches, re-run Phase 1 and Phase 2 from the orchestrator session.
