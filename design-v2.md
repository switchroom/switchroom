---
artefact: Memory v2 — comparator-hardened every-turn injection + reflect-once-from-cache + pull, on the disk-reload path
status: Draft (2026-08-16, rev 11) — DESIGN v2, rebuilt from first principles on the memory-redesign-2026-08 evidence ledger; rev 2 incorporated E-59/E-60/E-61; rev 3 incorporates E-62 and the second adversarial review (B-1, M-1..M-5, m-1..m-7); rev 4 incorporates E-63..E-68 (vendor coding-agents package verified at reference + source — adoption evaluated and rejected, P-13 corrected, recall-vs-reflect split re-checked against vendor guidance); rev 5 incorporates the comparator-convergence review (E-69..E-72, P-14; P-07..P-12 re-verified at Hermes pin 460d345 + openclaw live docs/source) — recall-types defect fixed (E-70), step 6 split into a comparator-hardened transitional arm (6a) and an evidence-gated tools-only arm (6b), P1 scoped to what E-57 actually measured; rev 6 incorporates the knowledge-page reach correction and the repo-knowledge composition (E-73..E-78) — E-59's "pages unreachable" corrected (the shipped hindsight-mcp-shim exposes three GET-only page reads plus directive deactivate/reactivate; §2.5 marked already-shipped minus the version pin), new §10: repo knowledge on a shared single-writer repo bank with engine-automatic page refresh, no `claude -p`; rev 7 folds in the five validation probes (E-79..E-83) — E-57 downgraded to a vendor anecdote (its delta is on the order of run-to-run noise; the replicated 9/9 reflect-arm campaign survives as the evidenced result, and step 6b is now explicitly gated on evidence only a self-run harness arm can generate, ~$300 triplicate), recall types measured (ship all three types, E-80), step 6a's async prefetch join is ours to build (native timing guarantee refuted, E-81, asyncTimeout rail added), compaction re-injection confirmed at file level (step 1(f) demoted from gate to post-flip canary), the sub-agent surface resolved (workers carry no Hindsight tools; enable_observations is the real config key, E-82), and §10's git-only page reach quantified with a falsifying test gating R1 (E-83); rev 8 applies the rev-7 audit — localized spec and wording work, no evidence or architecture changes: §9's verdict check extended over §10 and its P5, cost, and winning-pattern claims corrected to the document's own register (§10.2, §6, §8.2a — rev 7's verdict contradicted rev 7's own content), step 6b's rollout flag specified as a real config key (`memory.injection`, two values, Hermes's `context` mode deliberately dropped with cause, P-07), the E-71 retain-cadence gap resolved by pulling per-turn delta retain + the read-after-write ordering forward into 6a rather than leaving it to a tripwire that cannot see it, 6a's E-80 claim scoped to the measured types change only, §2.1a's deny-rule granularity stated and its `# --- Yours ---` side-effect resolved via the sanctioned writer, phantom citations fixed to resolvable form (E-45 recommendation (b), E-38 mechanism 1, E-50 items 4/7), the deferred job-spec rewrite recorded as a tracked obligation (§5), and the post-triage directive count-watch (doctor WARN >24 / FAIL >30) named in §4.2; rev 9 is a refutation pass, no new architecture: E-70 is REFUTED (2026-08-16 — the deployed fleet already recalls `["world","experience","observation"]` with `prefer_observations` effective on every agent; the entry had read the vendored snapshot's DEFAULTS tier, the exact trap `vendor/hindsight-memory/CLAUDE.md` documents as "actively misleading", instead of the scaffold override site / operator schema / deployed settings.json, all verified live), §2.3's types-and-prefer change is restated as shipped status quo, step 6a shrinks to the timing-and-cadence work only (async off-path prefetch join + per-turn delta retain — the content half is already live), E-80 is re-scoped as a directional validation of the deployed default rather than a case for change (its arms stand; its "current config" label meant the opt-out config), the E-70 legs in §0/P1/§2.2/§3/§6/§7/§8.11 are corrected without upgrading any confidence level, and the same snapshot-vs-deployed trap turned out to have a second victim: P-01/P-05's "ours 1024" recall cap is corrected to the deployed operator default of 16 memories / 6144 tokens (switchroom.yaml, 2026-08-03), with §2.3/§5/§6's cap citations and the recall-block cost bound restated accordingly; the knowledge-pages probe (`probes/knowledge-pages-09.md`) folded in two more items of the same class — E-53's line anchor corrected to the deployed engine (`memory_engine.py:13578`, the docstring and claim verified true on the running container; the cited `:14252` was a different snapshot, the third confirmed snapshot-vs-deployed instance, now named as an explicit ledger convention), and the "`search_knowledge_pages` … 6.7% R@1" shorthand clarified at both design sites (§7, §10.3): the number is the recall pipeline measured rerank-free on LoComo, never a benchmark of page search — kept as the informative analogy it is, with the fetch-whole discipline standing on the verified reranker absence; rev 10 rewrites the central position on the injection-cadence probe's accepted verdict (probes/injection-cadence.md) plus the sub-agent/long-session probe (probes/subagent-and-longsession.md), both verified against deployed artefacts this rev per the ledger convention — **every-turn injection, comparator-hardened, is now the END STATE (P1 inverted), not a waypoint**: every argument surviving E-57's collapse attacks the block's tuning and placement, both fixable inside every-turn and both fixed by the comparators the operator steered toward, while the comparators' stated premise ("models don't pull reliably") is the design's own pull-miss risk answered by the deterministic-mechanism rule; tools-only (6b) is demoted from framed destination to a per-agent experiment arm behind its evidentiary gate (the ~$300 triplicate, plus a named ~$0 live A/B); five new ledger entries land — E-84 (live hook latency p50 ~1.28s / p90 ~5.5s / max ~9.2s: the four sites citing E-28's 0.6–0.75s corrected — that figure was the single-bank MCP tool, not the deployed reply-path hook), E-85 (full-cap no-floor grab-bag live: 6a gains the budget convergence 6144→4096 tokens / 16→8 memories and the observation-only-vs-combined tension is engaged explicitly rather than silently picked; the probe's score-floor recommendation is REFUSED on E-13's 330-query measurement, stated in §7), E-86 (workers have ZERO memory read path — no tools AND no injection — while SubagentStop retains their prose into the parent bank: named defect §2.6, W-6 upgraded from optional and extended with recall/get_mental_model, budget-footgun precondition recorded), E-87 (~20–30% of all logged recalls fire on machine-generated task-notification prompts at full cap: deterministic skip gate added to 6a, §6 restated), E-88 (no PreCompact/PostCompact wired anywhere and nothing calls get_mental_model — §2.2 now states its read is UNBUILT step-7 spec, and adopts the free matcher-less SessionStart re-fire at source=compact as Surface B's deterministic post-compaction re-seat); §8.2a's F5 residue (Surface B shipping half the benchmarked winning arm) is resolved in §2.2's re-injection bullet: per-session + per-compaction default with the benchmarked per-N-turns cadence as a first-class knob (`memory.orientation_reinject_turns`, default off, priced at up to ~55M/30d nominal every-turn — the stated justification for the divergence); P1's "both comparators 1024-token-capped" corrected (openclaw 1024, Hermes 4096 — P-05 already carried it); §6's recall-share ceiling restated as persisting by design, roughly halved to ~75–90M nominal by the junk gate + caps, with no point estimate asserted; no evidence renumbering, no confidence upgrades — probe reasoning carried as reasoning; rev 11 folds in two report-only probes (`probes/dynamic-banks.md`, `probes/knowledge-pages-docs.md`), neither of which overturns the design — small, contained, no renumbering, no confidence upgrades, probe reasoning carried with its labels; seven evidence entries land, each re-verified at fold-in against the deployed artefact per the ledger convention — E-89 (openclaw's dynamic bank IDs are identity **isolation**, not sharing: bank re-derived per message from `["agent","channel","user"]`, dynamic-by-default, knowledge tools fail closed on unresolved identity and no agent-facing tool takes a bank argument at all, banks lazily auto-created by writing to them with no operator gate — published bundle `@vectorize-io/hindsight-openclaw@0.10.0`), E-90 (Hermes at pin `460d345`: static default, opt-in `bank_id_template` resolved once at provider init, pitched in its own README as isolation — so across all three integrations the model is one bank ↔ one writing identity and openclaw differs in *default*, not in *model*: a direct corroboration of **P5**, now stated at P5 itself), E-91 (no comparator has any concurrent-writer machinery; E-38 stands untouched and this design leans on nobody else's solution), E-92 (the vendor states outright that "a knowledge page *is* a mental model" — a page is a mental model with defaults pre-set for the document use case, on the ladder mental models → observations → raw facts, with the explicit boundary "use page search to pick a document; use recall for a specific fact": independent corroboration of **P4** and of §2.2's choice of the mental model as the primitive, recorded as corroboration only), E-93 (the docs matched the deployed engine on every mechanism previously verified live, in places down to identical JSON — a positive reliability signal for the engine notes, explicitly NOT a licence to cite docs in place of deployed artefacts), E-94 (**named gap**: multi-writer bank semantics and shared/team-bank pages are not addressed in the vendor docs at all, so §10's concurrent-writer argument has no vendor position to defer to and must not be framed as vendor agreement), and E-95 (**framing correction**: the `bank_id` restriction on the page tools is OUR shim's, not a platform limit — every deployed REST route is `/v1/default/banks/{bank_id}/knowledge-base/...` (live openapi, seven paths) and `FALLBACK_TOOL_TABLE` already passes `bank_id` through on every backend tool, so dynamic cross-bank recall reach needs zero code; the limit lives in the five synthesized tools alone, and the three protections it exists for — anti-silent-drop, the provenance-not-security boundary, the retirement seam — are named so a relaxation can preserve them); the framing is corrected in place at §2.5, §10.2 pt 3, §8's resolved list and §10.6 W-2; **W-2 is sharpened** — page tools accept a bank selector *validated against an operator-granted set*, loud-rejecting anything outside it, because rev 10's "config, not a tool argument" phrasing cannot serve an agent granted two repo banks; the corrected invariant is that a caller may SELECT among grants but never MINT reach, and the text states explicitly that the relaxation preserves all three protections; **recommendation recorded** in §7 — do not adopt dynamic bank IDs, keep §10's shared single-writer repo bank composed with the already-deployed `additional_banks` read fan-out, because dynamic banks solve identity isolation that a static operator-owned agent→repo mapping already gives us while adding silent-misroute and ungated-lazy-creation failure modes; and §8 gains open item 12 — whether OUR deployed engine auto-creates a bank on a POST to a missing one is **not established** (the probe was read-only and settling it requires a write), with the one-write/one-list/one-delete test that would settle it and why it is a P7 question; and an **eighth entry, E-96, records counter-evidence found at fold-in that neither probe reached** — the vendor publishes a how-to for SHARING one dynamic bank across several agents ("remove `agent` from the bank key, keep the user dimension"), so E-89's "isolation, not sharing" is qualified in place: true of the mechanism's construction and default, too strong as a claim about vendor guidance. The §7 recommendation is unchanged but its reason narrows honestly — the sharing dynamic banks buy is per-USER sharing this fleet already runs statically as `ken-profile`/`lisa-profile` + `additional_banks`, not §10's repo-shaped case, paid for with derivation failure modes and no gain against E-38, whose only answer in that guide is a shared retain *mission* (a content filter, not adjudication). E-94's "not stated" stands exactly as scoped — over the four *developer* docs pages — which is why that scope is stated rather than generalised
serves: remember-across-sessions
advances-outcome: standing-team
relates:
  - reference/rfcs/memory-redesign-2026-08.md   (evidence ledger; every E-nn / P-nn / C-nn below resolves there)
  - reference/jobs/remember-across-sessions.md
  - reference/invariants.md
supersedes:
  - design-draft.md ("pull-first with a bounded push floor" — superseded in full; rev 7 note — the push floor was originally rejected on E-57, since downgraded to a vendor anecdote (E-79); the rejection now rests on E-46/E-63/P-14 and the absence of any supporting evidence for the floor — rev 9: E-70 removed from these grounds, refuted)
  - reference/rfcs/hindsight-memory-reimagined.md
---

# Memory v2: comparator-hardened every-turn injection + reflect-once from cache + pull, with standing content on the disk-reload path

Every design claim cites the ledger by anchor. Claims the ledger does not
cover are marked **UNVERIFIED** inline and collected in §8. The full live
MCP tool list is now enumerated (E-59, 32 tools); every tool this design
calls is on it: `recall`, `reflect`, `retain`, `sync_retain`,
`invalidate_memory`, `create_directive`, `list_directives`,
`delete_directive`, `create_bank`/`delete_bank` (throwaway-bank probes),
and the complete mental-model lifecycle (`get_mental_model`,
`list_mental_models`, `create_mental_model`, `update_mental_model`,
`refresh_mental_model`, `clear_mental_model`, `delete_mental_model`).
Definitively absent from the **engine's** MCP surface (E-59): every
knowledge-page tool, and any directive deactivate/reactivate/update —
directive lifecycle on the engine MCP is create/list/delete only.
**Corrected at rev 6 (E-73):** the surface agents actually call is the
`switchroom hindsight-mcp-shim`, which synthesizes five more tools over
REST — `deactivate_directive`, `reactivate_directive`, and the three
GET-only knowledge-page reads (`search_knowledge_pages`,
`get_knowledge_page`, `get_knowledge_tree`) — live-verified at 37 tools
total. §2.5's shimmed endpoint is therefore already shipped, and
knowledge pages are readable (own bank only) from every agent today —
and rev 11 names the layer that "own bank only" lives in: **the shim's,
not the platform's** (E-95; the engine's knowledge-base REST routes are
bank-parameterised on every path). Repo-scoped standing knowledge on
that surface is §10.

Transport honesty (review Axis-1 clarification, adopted): hook and plugin
code paths (SessionStart read, index regeneration, doctor probes) run
outside the agent's MCP session and reach these same tools as
**MCP-over-HTTP** (`POST /mcp` — the method E-59's own enumeration used).
That is still the MCP protocol and the E-59 surface. The **only non-MCP
REST calls** this design touches are directive-deactivate and the
knowledge-page reads — both already encapsulated inside the shipped shim
(§2.5, E-73) — plus §10's operator-side page seeding.

## 0. Why the prior draft is superseded, in one paragraph

The prior draft's central move was "delete the directive block, keep the
per-turn recall push as a healthy floor." Rev 7 correction (E-79): the
"worse than no memory" number that rev 1–6 leaned on (E-57's 1.06 vs
0.97) is a **vendor anecdote, not a measurement** — one paragraph of blog
prose on an unpublished run from an unspecified earlier suite version,
with run count, agent, model and recall config all unstated, and a delta
(0.09) on the order of the published campaign's run-to-run noise
(sd ≈ 0.03–0.07). So the floor is no longer *measured* as harmful; it is
merely **without any supporting evidence anywhere**, argued against by
the vendor in prose (E-46), abandoned by both comparators (P-09/P-12) and
by the vendor's own production default (E-63). (Rev 9: the fourth leg
revs 5–8 carried here — "defective as we ship it, E-70: observations
excluded, `prefer_observations` a no-op" — is withdrawn. E-70 is
REFUTED: the shipped block already injects the consolidated observation
tier fleet-wide, with `prefer_observations` live and effective. The
grounds above carry without it.) What IS
measured — published per-task, replicated, and independently recomputed
to two decimals — is the winning pattern: **reflect-once synthesis beat
vanilla in 9/9 runs with non-overlapping per-agent ranges, injecting
genuinely synthesized memory** (E-79). That is the pattern this design
serves. (Rev 10: hardened per-turn injection is no longer an open
waypoint — it is the end state, P1; what remains empirically open is
only the per-agent tools-only arm's sign, step 6b.)
Separately, the draft's pull pillar was built on
`search_knowledge_pages` as a *retrieval* path, and that path is rerank-free
— ~10× worse top-1 precision than reranked recall (E-53). (Rev 6 note: the
tool itself turned out to be reachable after all, via the shipped shim —
E-73 correcting E-59's reach claim — but E-53 is unaffected and the pillar
stays dead as a precision path; pages return in §10 as whole-document
reads only.)
This design starts over from the winning pattern, with the standing-
knowledge surface on **mental models** — the same primitive as a page with
the mechanics pre-decided (E-48), fully MCP-native (E-59), LLM-free at read
time (E-52).

## 0a. Build-vs-adopt, settled: the vendor's own package is not adoptable here

The standing assumption that switchroom keeps building its own plugin had
never been tested against `@vectorize-io/hindsight-coding-agents` — the
vendor's current, maintained integration that superseded their per-agent
plugins (P-13). It has now been tested against the full reference and the
package source (E-63..E-67). **Verdict: do not adopt — no code, no
installer, no `--import-conversations`.** Three findings decide it:

1. **Its central mechanism cannot run here.** The package's entire
   session-orientation surface is a once-per-session live `reflect`
   hard-capped at 25s inside the hook window (`HOOK_REFLECT_CAP_MS`,
   E-64); on timeout it caches empty, never retries, and the session runs
   memoryless. Our reflect is 51–87s at the same `budget: "low"` (E-28),
   architecturally, on the invariant-pinned `claude-code` provider (E-61).
   On this fleet the package degrades permanently to its no-memory mode.
2. **Its pipeline is coding-shaped where it counts.** Bank *resolution* is
   configurable (per-agent banks are expressible, E-65 — correcting
   P-13), but the ingestion — git-history seed, headless codebase survey,
   coding-session import, architecture/convention knowledge pages — is the
   product, and it feeds wrong or empty content for 12 persona agents
   doing mostly non-repo work. The survey default also shells
   `claude -p --max-budget-usd` (E-66), colliding with the fleet's
   claude-p elimination and subscription-honesty rails, and its installer
   writes the hook/MCP/skill surfaces that switchroom's `apply` owns.
3. **It carries none of the curation layer this design exists for.** No
   directive tools, no mental-model tools, no rules lifecycle; 8 pull
   tools total (E-67, E-63). Everything §2.1/§4 specifies would still be
   ours to build.

What the test *did* yield is the strongest corroboration in the ledger:
the package's runtime is **reflect-once + pull-tools + Stop-write with
per-turn injection deliberately removed** — its own comments call per-turn
page injection "phantom research" and one-shot synthesis replay "random
noise" (E-63). The vendor's production default is this design's shape.
Where we diverge — serving the "reflect once" slot from a cron-refreshed
mental model instead of a live 25s-capped call — we are strictly better
than the package's degraded mode on our provider, which is no orientation
at all (E-64), and the cache primitive is the vendor's own "saved reflect
responses" concept used as documented (E-68).

## 1. Principles

**P1 — Every-turn injection, comparator-hardened, is the end state.
What stays dead is the *shape* everything argues against — raw
fragments, synchronously, on the reply path — not the cadence.**
Rewritten at rev 10 on the injection-cadence probe's verdict, which the
document accepts: after E-57's collapse (rev 7 — vendor anecdote, delta
within run-to-run noise, E-79), every argument still standing against
per-turn injection attacks our block's **tuning and placement** — the
hot-path timing (p50 ~1.3s / p90 ~5.5s reply-path blocking, E-84, which
revs 1–9 understated ~2× at median and ~7× at p90 by citing E-28's
tool-call figure), the full-cap grab-bag with no floor in normal mode
(E-85), the every-Nth retain lag (E-71) — all fixable *inside* an
every-turn shape and all already fixed by the comparators this fleet
was steered toward. Meanwhile the comparators' reason for shipping
every-turn is stated, verified, and applies here: "models don't use
[pull tools] consistently. Auto-recall solves this by injecting
memories automatically before every turn" (openclaw docs, verbatim;
Hermes's hybrid default says the same by construction, P-07/P-12) —
which is this design's own pull-miss risk (§2.3) answered by the
fleet's own rule that a deterministic mechanism beats prompt hope.
Injection IS the deterministic mechanism for "memory is present." So:
the **raw-fragment synchronous variant** stays dead on its convergent
grounds — vendor prose (E-46), the vendor's removal of it from their
production default (E-63), both comparators abandoning its shape
(P-09/P-12) — and it is nobody's shipped config, ours included (rev 9,
E-70 refuted: our block already injects the consolidated observation
tier; what it still shares with that variant is the reply-path timing,
E-84, and the retain lag, E-71 — exactly step 6a's remaining work).
The variant both chat-domain comparators actually ship —
observation-only, capped (openclaw 1024, Hermes 4096 tokens — P-05,
corrected rev 10; rev 9's "both 1024" misread Hermes), trivia-gated,
and (Hermes) fully off the reply path (P-09, P-12, P-08) — is the 6a
end state's template. **Tools-only is no longer the framed
destination**: retrieval the agent invoked remains the inspectability
gold-standard (C-01) and 6a's design preserves that property
(transcript-visible degraded notices, the pull surface intact), but a
tools-only flip is quality-unmeasured in either direction (P-14, E-79)
and is available only as a per-agent experiment arm behind the explicit
evidentiary gate at step 6b — never asserted, never the default
trajectory.

**P2 — Standing content lives on the documented disk-reload path, never the
render-once path and never an undocumented one.** After compaction, Claude
Code re-injects **root `CLAUDE.md` and unscoped rules from disk**; hook-
rendered `additionalContext` does not survive (E-51). Whether `@path`
imports are *re-expanded* at that moment is **undocumented — a coin-flip
whose losing side silently resurrects retired rules** (E-62). So standing
rules live in the root `CLAUDE.md` file itself, the one surface whose
reload is documented, and imports are not used for anything load-bearing.
This is the deterministic fix for review BLOCKER 2, restated on the
evidence that survives E-62.

**P3 — The hot path uses only LLM-free primitives.** `recall` makes no LLM
call (E-52; E-28: 0.6–0.75s as a single-bank tool call — the deployed
multi-bank hook runs p50 ~1.3s / p90 ~5.5s on the reply path, E-84,
which is 6a's off-path motivation); mental-model reads are cached database reads,
no LLM, cost paid once at refresh (E-52, E-48). `reflect` is **decided off
the hot path** (E-61): it runs on the `claude-code` provider, an agentic
loop of up to 10 iterations each a full CLI round trip — 51–87s is
architectural, not mistuning, and the fast-provider fix would trade the
claude-native invariant for a benchmark. Reflect is reserved for explicit
user asks (the user chose to wait) and scheduled refreshes.

**P4 — Standing knowledge is a document fetched whole, never a precision
retrieval path.** `search_knowledge_pages` has no reranker, and rerank-free
retrieval measures 6.7% R@1 vs 69.7% reranked (E-53). Rev 6 correction:
the tools are not absent after all — the shipped shim exposes three
GET-only page reads to every agent (E-73, correcting E-59's reach claim;
E-60's no-filesystem-projection finding stands). That changes reach, not
the principle: pages are documents to fetch whole (tree → page), never a
substitute for `recall`. **Rev 11 — the vendor states this principle
outright (E-92):** "Use page search to pick a document; use recall for a
specific fact", and page search's missing reranker is a stated design
choice ("fast enough to be the first thing an agent reaches for"), not an
oversight. For **persona** standing knowledge the primitive
remains the **mental model** — the same thing as a page with mechanics
pre-decided (E-48; and the vendor now says it in exactly those terms —
"A knowledge page *is* a mental model … a page comes with those
decisions already made", E-92) — read whole by name via
`get_mental_model`; pages
carry §10's repo knowledge, where the folder-tree/document shape earns its
keep. Fact-level precision belongs to `recall`, which is reranked (E-52).

**P5 — One bank per agent; fleet consistency by template, not by shared
state.** The engine has no concurrent-writer machinery: no contradiction
detector, writer identity stripped before adjudication, silent arbitrary
resolution (E-38). The vendor's own deployment model is bank-per-identity
(E-49, E-50). **Rev 11 — directly corroborated at both comparators
(E-90):** Hermes is static-by-default with an opt-in `bank_id_template`
resolved once at provider init and pitched in its own README as
*isolation*; openclaw is dynamic-by-default but derives its bank from an
identity tuple, also for isolation (E-89). Across all three integrations
the model is the same — **one bank ↔ one writing identity** — and
openclaw differs in *default*, not in *model*: dynamic granularity only
changes how finely that one identity is cut, never who shares a bank.
Nor does either comparator carry any concurrent-writer machinery, so
E-38's ground is unchanged and this design does not get to lean on
anyone else's solution (E-91). Cross-bank reads are explicit fan-out (E-32); fleet-wide
common config (shared guardrails, missions, disposition) ships as a bank
template (E-49) — noting E-49 pitches templates for *onboarding*, so the
retrofit onto live banks is a mechanical create+deactivate pass, not a
vendor-evidenced operation (§5 step 3, review m-5).

**P6 — Every lifecycle verb is as cheap as creation, and switchroom carries
the provenance.** The engine's directives have no provenance, no telemetry
(E-29, E-44), no deactivate on the engine MCP (E-09, E-59 — reachable for
agents only because the switchroom shim synthesizes it, E-73), no enforced
cap (E-30) — and the measured consequence is a fleet where **nothing has
ever been retired, in any bank** (E-42). Whatever surface holds rules must
have create/retire/supersede as first-class, logged, reversible operations
owned by switchroom — **and the surface must be tamper-evident**, because
a durable rule surface writable by an ordinary file edit would hand any
prompt-injected turn persistent authority (§2.1a, review M-5).

**P7 — Failure surfaces; silence is a never-ship.** Zero-extraction retains
report success (E-36); comparators fail open and silent (P-11); silent
forgetting is the job spec's explicit never-ship (C-01). Every memory
subsystem here has a named failure mode and a visible signal — including
the new ones this design itself introduces: a dead refresh cron (§2.2), an
unloadable rules block (§2.1), and an out-of-band rules edit (§2.1a). The
fleet's own history makes these non-hypothetical: overlay-file crons died
silently **for weeks** before anyone noticed.

## 2. The architecture

Four surfaces replace today's two per-turn injections. Per turn, **nothing
is pushed on the reply path** — the directive block is deleted outright,
and the recall block converges on the comparator-hardened shape
(off-reply-path, capped into the comparator band, junk-gated — step 6a)
**as the end state** (rev 10, P1). Per-agent removal (tools-only, step
6b) remains available behind its evidentiary gate; it is no longer the
trajectory.

### 2.1 Surface A — the standing block layer (always-on, compaction-durable)

Two switchroom-managed, marker-delimited blocks written **directly into the
agent's root `CLAUDE.md`**, inside the preserved `# --- Yours ---` section
(which survives `apply` regeneration). Root `CLAUDE.md` is the one surface
documented as re-injected from disk after compaction (E-51, E-62); `@path`
imports are **not used** — their compaction behaviour is undocumented and
the losing side of the ambiguity silently resurrects retired rules (E-62).
No import fallback is kept: the documented route is the route.

1. **The rules block** (`<!-- switchroom:rules:begin/end -->`) — the
   standing-rules ledger. Per rule an `id`, the rule text, `created_at`,
   `source` (the chat turn or operator edit that created it). Retired
   rules move to `memory/rules-archive.md` — a plain file that is never
   loaded into context (provenance kept, tokens not paid). Lifecycle in
   §4.
2. **The knowledge-index block** (`<!-- switchroom:index:begin/end -->`) —
   a titles-only index of the bank's mental models (name + one-line scope
   each, tens of tokens). This solves the pull architecture's cold-start
   hole — the agent cannot fetch a standing answer it doesn't know exists
   — deterministically, not by prompt hope (prior review MAJOR-3's fix).
   **Regeneration trigger (review m-3):** the mutation/proposal tool
   rewrites the block on its own model writes, and a daily doctor check
   diffs the block against live `list_mental_models` (MCP-over-HTTP) and
   FAILs on divergence — catching out-of-band creations too, which the
   unauthenticated engine permits (E-33).

**Budget.** Corrected per E-62: the 25KB hard cap applies to auto-memory
`MEMORY.md`, **not** `CLAUDE.md`, which carries only a 200-line guideline
and no documented hard limit — and imports would not have reduced context
anyway, since expansion counts in full. The budget is therefore ours to
set and enforce: both blocks together ≤ 6KB rendered (~1.5k tokens),
enforced on the **write path** (the mutation tool refuses a write that
would blow the budget), doctor-checked against the fully-expanded root
`CLAUDE.md` total. No invented per-rule count cap (prior review MAJOR-1):
the byte budget binds, and the operational split is set after the first
heavy-agent triage measures the real always-on residue (§5 step 4).

**Load canary (review M-4).** After migration step 5 this block is the
*only* always-on rules surface, so "did it actually load" must be checked,
not assumed. The rules block carries a sentinel line (block hash + rule
count); the SessionStart hook re-reads root `CLAUDE.md` from disk,
verifies the sentinel parses and matches the block, and on any failure —
file unreadable (the fleet's known root-chown/EACCES failure mode),
markers missing, sentinel mismatch — emits a **visible one-line notice**
into the session and a doctor FAIL. An unloadable rules block is loud,
never silent (C-01, P7).

### 2.1a Integrity: the rules block is tamper-evident (review M-5)

The failure this guards: agents are deliberately prompt-injectable
(E-33a's framing), and a compaction-durable rules surface writable by an
ordinary `Edit` would convert one injected turn into **persistent** rule
authority — strictly worse than today, where injected context dies with
the session. Mechanism:

- Every legitimate mutation goes through the switchroom rules tool, which
  atomically (a) rewrites the block, (b) appends an entry to an
  **append-only mutation log** in the plugin state directory — rule id,
  action, actor/source, timestamp, and the resulting block hash, each
  entry chaining the previous entry's hash.
- At SessionStart and in doctor, the current block hash is compared to the
  log head. **Any unexplained delta fails loud**: doctor FAIL plus a
  visible next-turn notice quoting the diff, and the divergence stands
  until an operator resolves it (accept-as-legit re-signs the log; reject
  restores from the log's last good state). No silent reconciliation in
  either direction.
- Defence in depth, deterministic: a permission deny-rule on direct
  `Edit`/`Write` of root `CLAUDE.md` for the agent's ordinary tools, so
  the mutation tool is the only sanctioned writer. **Granularity, checked
  against how switchroom actually expresses deny-rules (rev 8):** these
  are Claude Code `settings.json` `permissions.deny` entries — plain
  string rules of tool name plus at most a path specifier
  (`Edit(<path>)`-shape; the fleet's scaffold-seeded denies are exactly
  this form, e.g. the `WebFetch` fleet baseline). They match a tool
  against a file path, never a byte range: **a deny scoped to the
  marker-delimited blocks is not expressible**, so the rule necessarily
  covers the whole root `CLAUDE.md` — including the `# --- Yours ---`
  free-text section the fleet template explicitly invites the agent to
  edit for non-rules content. That side-effect is resolved by routing,
  not by weakening the deny: the rules tool (§4.3's sanctioned writer)
  gains a plain edit-Yours-content verb for non-rules text in the
  preserved section — same atomic write, same mutation-log append, and
  it refuses to touch the marker-delimited blocks — so the invited
  capability survives through the sanctioned writer while a
  prompt-injected turn's direct file edit stays blocked. Trade-off
  accepted and stated: Yours-section edits become tool-mediated and
  logged rather than raw `Edit` calls.

**Honest boundary:** this is *tamper-evidence against ordinary-tool
edits*, not cryptographic protection against an attacker with arbitrary
code execution in the container (who could rewrite the log too). That is
the right threat model here: the realistic vector is a prompt-injected
turn using the agent's normal file tools, and that vector is both blocked
(permission rule) and detected (hash-vs-log) by construction.

### 2.2 Surface B — orientation at session start, served from cache

The reflect branch is **decided: Branch B** (E-61). Reflect cannot reach
the vendor's 800–3000ms band on the `claude-code` provider, and switching
provider is invariant-barred — so the "reflect once" half of the
benchmarked winning pattern (E-79: the replicated 9/9 reflect-arm
campaign; formerly cited as E-57) is served from a **pre-computed
cache**: a per-agent **orientation mental model**, refreshed by cron via
`reflect`-class synthesis, read at session start as a cached no-LLM
lookup (E-52). This preserves the winning pattern — "reflect once" still
happens, just off-turn — and per-turn pushed *fragment* injection is
removed regardless, on its own grounds (E-46, E-63; P1 — rev 9: E-70
dropped from this list, refuted). Two
honest divergences from the vendor's winning arm, stated
here and priced in §6: their "reflect once" synthesised over the
*current* bank at session start, ours is up to ~a day old (review m-7);
and their winning arm **re-injected the synthesis every turn**, while
this surface's default injects it once per session plus once per
compaction — the cadence divergence is argued and priced in the
re-injection bullet below (rev 10, resolving §8.2a), not smoothed over.

**Deployment status (rev 10, E-88): this surface is unbuilt.** No hook
in the deployment calls `get_mental_model`; the only SessionStart
injectors today are the switchroom working-state-reload hook (matcher
`compact` — static recovery block + working-state file + a lean
briefing whose one recall uses a fixed generic query) and the plugin's
`session_start.py`, which injects nothing by design. Revs 1–9 described
the read mechanism in the present tense a reader could mistake for
wiring; everything below is **specification for step 7**, and today's
post-compaction footing is the native summary plus the generic re-seat
E-88 documents. Two vendor
corroborations landed with E-63/E-64/E-68: the vendor's own production
harness treats hook-time reflect as best-effort under a **25s hard cap**
and ships memoryless sessions when it misses — so on a slow provider the
industry alternative to this cache is *nothing*, not a fresher synthesis
(E-64); and the cache primitive is the vendor's documented concept —
"mental models are **saved reflect responses** that you create for
frequently asked questions", checked first in reflect's own retrieval
hierarchy (E-68). The orientation model is that concept applied to the
standing question "what context should this agent hold".

**A third corroboration lands at rev 11 (E-92)**, from the vendor's
mental-models doc rather than the harness: "Fetching a mental model is a
database read. No retrieval, no synthesis, no LLM call, no waiting. An
agent that boots by loading its mental models starts with a page of
settled knowledge instead of spending its first few seconds
rediscovering it" — which is this surface's mechanism and its
justification, stated by the vendor as the primitive's intended use. The
same doc gives the ladder the design's primitive choice sits at the top
of: mental models (a whole document per question) → observations (one
belief per fact cluster) → raw facts, "each layer a cheaper, more
settled version of the one below it". Corroboration only: it changes no
spec below and lifts no confidence level — the surface remains
**unbuilt** per E-88.

Concrete specification:

- **The model.** One mental model per bank, name `orientation`,
  operator-approved at creation (no auto-seeding — E-16's dead end stays
  dead). **`source_query`:** *"What standing context should this agent
  hold right now: active projects and their current status; significant
  decisions and corrections from the last two weeks; open commitments and
  scheduled obligations; current constraints on how work should be done.
  Most recent first. Exclude user identity and biography — profile banks
  own those."* The exclusion clause is load-bearing: E-16 ripped out
  auto-seeded profile models precisely because they duplicated and
  contradicted the dedicated profile banks.
- **Read.** A **matcher-less** SessionStart hook (to build, step 7 —
  E-88) calls `get_mental_model` (MCP-over-HTTP; cached, no LLM,
  milliseconds, E-52) and injects the content via `additionalContext`,
  ≤ 2048 tokens. Matcher-less is deliberate (rev 10, adopting E-88's
  lever): SessionStart demonstrably fires at `source=compact`, so the
  same hook re-seats the orientation briefing **after every
  compaction** for free — deterministic push, replacing revs 1–9's
  post-compaction position ("re-orients on demand via
  `get_mental_model`"), which was a pull the model might never make and
  which E-88 shows nothing today would prompt. The injected content
  still does not itself survive compaction (E-51) — it doesn't need to;
  the re-fire replaces it.
- **Re-injection cadence (rev 10 — resolving the §8.2a residue rather
  than leaving it).** The benchmark this surface cites as its
  foundation rewarded **every-turn** re-injection of the synthesis
  (E-79's winning arm; cadence per blog prose, E-69 — labelled
  interpretation); once-per-session was the vendor's *post-benchmark*
  refinement, justified in a source comment ("random noise once the
  session drifts") that is engineering judgment, not measurement
  (E-63). This design's default — **once per session start + once per
  compaction** (the matcher-less read above) — therefore **diverges
  from the benchmarked configuration, deliberately**, on two stated
  grounds: (a) the vendor's own current production default made the
  same move after the benchmark, and (b) price — at the fleet's logged
  turn volume (~26,773 recall-eligible turns/30d, §6), every-turn
  re-injection at ≤2048 tokens is up to ~55M tokens/30d nominal,
  re-creating a directive-block-sized standing spend (E-41) to chase a
  cadence whose benefit over per-session+compaction is unmeasured.
  Because the divergence is judgment, not evidence, the benchmarked
  cadence stays reachable as a first-class knob, not a footnote:
  `memory.orientation_reinject_turns: N` (default off) re-injects the
  cached model every N turns — a milliseconds cached read (E-52), token
  cost the only price — and per-N-turns is the named fallback if the
  step-7 watch shows late-session context loss (§8.2a). If the harness
  matrix (step 6b's gate) ever adds an orientation-cadence arm, its
  result decides this knob's default; until then the divergence stands
  as stated here.
- **Refresh cadence.** `refresh_mental_model` on a per-agent cron,
  staggered across the fleet, **once per 24h**, plus a full
  `clear_mental_model` + refresh every ~48h to bound delta-mode drift —
  the vendor's own recommendation for long-lived delta models (E-50
  item 7).
  A user-visible "orient me now" ask may always run live `reflect`
  (51–87s, the user chose to wait).
- **Staleness guard (review M-3).** "At most ~24h stale" holds only while
  the cron fires, and this fleet has lived through crons dying silently
  for weeks. So freshness is checked, not assumed: the SessionStart read
  compares the model's refresh timestamp against the cadence; past 1.5×
  cadence (~36h) the injected briefing is prefixed with a **visible
  staleness line** ("orientation briefing is N days old — refresh cron may
  be dead"), past 3× it degrades to the cold-model notice instead of
  serving stale content as fresh; doctor FAILs on refresh recency
  regardless of sessions. Silent wrong context at session start is
  exactly the failure class this design exists to remove (C-01, P7).
- **Cold/missing model.** `get_mental_model` returns nothing (model never
  created, or cleared and not yet refreshed) → the session starts without
  a briefing and **says so** in one visible line (same shape as the
  degraded-recall notice — our measured inspectability lead, P-01, P-11),
  and the hook enqueues a background `refresh_mental_model`. Boot is never
  blocked; failure is never silent (P7).
- **Fleet-wide refresh load, at 12 agents.** Cadence as specified is ~2
  runs/agent/day → ~24 runs/day fleet-wide ≈ **~20–35 min/day** of
  off-turn, staggered wall-clock at E-28's 51–87s per run (arithmetic per
  review m-1). Token cost is deliberately **not asserted here** — see §6:
  `refresh_mental_model` has never been measured, E-28 is two live-reflect
  runs on one bank, and the engine ceiling is an order of magnitude above
  it (E-52: 10 iterations, 100K context cap). Step 1(e) measures it, and
  step 7's cadence is **gated on** the measurement, not merely tuned by
  it.

### 2.3 Surface C — memory as tools (the pull path)

Agent-invoked, transcript-visible, nothing automatic:

1. **`recall`** (MCP, E-59; LLM-free, reranked — E-52; 0.6–0.75s as a
   single-bank tool call, E-28 — the *hook*'s multi-bank fan-out is
   slower, E-84, but that is the injection path's problem, not this
   tool's) — for specific facts: "what did Ken say about X." The
   deployed budget is the operator-raised **16 memories / 6144 tokens**
   (switchroom.yaml, 2026-08-03; rev 9 correction of P-05's "ours
   1024"). Rev 10 revises rev 9's "the budget was never the problem
   either way": on the *injection* path the full-cap fill IS part of
   the measured grab-bag (E-85 — 16 slots filled whenever candidates
   exist, score floor never applied outside degraded mode), and step 6a
   converges that budget into the comparator band; as a *pull tool* the
   budget stands. One rail from E-86's footgun: pull-path guidance must
   NOT tell agents to trim recall budgets — the MCP tool with
   `budget:"low"` / small `max_tokens` silently returned empty where
   the same query over HTTP returned hits; call it with defaults until
   that is root-caused.
   **Types: ALREADY SHIPPED, verified live (rev 9 — E-70 REFUTED; was
   framed as a change at revs 5–8).** The deployed default IS
   `["world", "experience", "observation"]` with `prefer_observations`
   on and effective: stamped at scaffold for every agent
   (`scaffold.ts:3968` — "the ON-BY-DEFAULT value for every agent on
   every install"), documented as the switchroom default with
   `["world","experience"]` as the opt-OUT (`schema.ts:863-871`),
   present on all 12 deployed agents' `settings.json` with zero
   exceptions, and `HINDSIGHT_RECALL_PREFER_OBSERVATIONS=true` live in
   the agent environment — since observation and raw types are both
   requested, the engine schema's conditionality clause ("No effect
   unless 'observation' and at least one raw type are both requested")
   is satisfied, not tripped. There is nothing to ship here; this
   paragraph describes the status quo. The live A/B (E-80: 15 queries ×
   3 banks, one pass) now reads as **validation of that deployed
   default**: combined never lost to the raw-only opt-out config and
   strictly won on 5/15 queries — surfacing top-ranked, materially
   useful observations the opt-out config never returns — and it beat
   the comparators' observation-only shape on redundancy
   (observation-only tails carry consolidation's near-duplicate
   paraphrases; combined's payload tracks the raw-only arm's cost).
   The starvation worry recorded against observation-heavy recall is
   unsupported: observations are 16–33% of corpus in every bank measured
   (E-80). Sample limits carried as stated: 15 queries, one pass, 3 banks
   query-probed with the largest bank stats-only, single-rater relevance
   judgment — suggestive, not conclusive; the larger run is still owed
   (§8.11), now as due diligence on a shipped default rather than a gate
   on a proposed one. `prefer_observations`'s incremental effect *under
   combined types* remains unmeasured — and unlike revs 5–8 believed,
   that untested combination is what production runs today (the A/B's
   arms held it at false). Including raw types alongside keeps
   just-retained, not-yet-consolidated facts reachable. The
   degraded notice moves into the tool result — model-visible failure,
   better than P-11's silent empty.
2. **`get_mental_model`** (MCP, E-59) — standing answers, fetched whole by
   name, cached and LLM-free (E-52). The knowledge-index block (Surface A)
   is how the agent knows which models exist. This carries the load the
   superseded drafts assigned to knowledge pages, on the same primitive
   (E-48) minus the folder-tree ergonomics we cannot reach anyway (E-60).
3. **`reflect`** (MCP, E-59) — live synthesis, for **explicit user asks
   only** ("summarize where Y stands", "what do you believe about my
   preferences") where 51–87s is a price the user knowingly pays (E-61,
   E-28), and for crons. Never on a latency-sensitive path.

This split matches the vendor's own decision table verbatim (E-68):
`recall` for "raw facts / simple fact lookup / maximum control", `reflect`
for "reasoned interpretation / disposition-consistent responses / forming
recommendations" — and their guidance is about capability, never
placement: nothing in it puts reflect on a per-turn or hot path, and
their own harness caps it at 25s in hooks (E-64). One coupling the table
implies and this design must carry explicitly: **directives bind only
during reflect** (E-03, reconfirmed at current docs, E-68), so a hot path
without reflect has no engine-side directive enforcement — which is
precisely why always-on rules live in the switchroom-owned rules block
(§4.1) and engine directives are scoped to reflect-time guardrails that
apply when the orientation model refreshes (§4.2, E-27).

The standing `CLAUDE.md` guidance ("reach for recall for facts, a mental
model for standing answers — the index lists them — and reflect when the
user asks for synthesis and can wait") is one short paragraph, and it is
*informed* prompt guidance, not blind hope: the index makes the available
knowledge visible every turn (P1 + prior MAJOR-3 fix). Residual pull-miss
risk is real and accepted — re-scoped at rev 7: the replicated reflect-arm
campaign (E-79) supports the quality of the reflect-once + pull *core*,
but the specific claim that dropping injection for tools-only wins on
quality is **unmeasured** (P-14, E-79) — the honest position is "loses
tokens, gains trust, quality sign unknown," which is why 6b is per-agent
and evidence-gated rather than fleet-asserted.

### 2.4 Surface D — the write path (unchanged shape, hardened)

Auto-retain via the Stop hook continues as today (`retain` / `sync_retain`,
both MCP-native, E-59) — every argument in this design is about the
*injection* path, not the write path, and retain is background and
LLM-cheap on the vendor's own tiering
(E-54: our extraction model is their retain-tier winner at their
recommended batch size, E-61). Hardening that rides along:

- **Zero-extraction alarm:** `memory_unit_count: 0` / `outcome="no_facts"`
  surfaces to doctor and as a next-turn notice (E-36; C-01).
- **Verify `enable_observations` is ON** — the difference between
  recoverable and gone when consolidation overwrites (E-38). Rev 7 naming
  correction (E-82): the previously-written key
  `enable_observation_history` **does not exist** in the deployed config
  schema (repo-wide grep: zero hits); the real field is
  `enable_observations` (`doctor-observation-scopes.ts:381,697`),
  live-verified `true` on klanker's bank — remaining banks checked at
  step 1(a).
- **Correction verb:** "that's wrong, it's actually…" → `invalidate_memory`
  (MCP-native, confirmed E-59 — no shim needed) on the bad fact + retain
  the superseding fact naming what it corrects — the time-ordered
  single-writer case is the one consolidation is actually written for
  (E-34, E-38 mechanism 1). Soft-demote ("true but stop surfacing") remains
  unbuildable — no tag-write path at 0.9.0 (E-31, E-20); recency cannot do
  it either, ±10% max (E-56). Named as an upstream ask.
- **Cadence gap, named (rev 5, E-71) — resolved at rev 8 by pulling the
  fix forward into step 6a.** Both comparators retain every turn (Hermes
  with append-mode delta + a bounded read-after-write wait so the next
  recall sees the just-written turn; openclaw on every `agent_end`); we
  retain every Nth (3 or 8), and nothing equivalent to Hermes's
  `prefetch_waits_for_retain` read-after-write guard exists on our side
  (E-71). Under a pull architecture that lag is user-visible: "what did
  I just tell you?" via `recall` can miss up to N-1 turns. Rev 7 left
  this to step 6a's watch — but by §5's own honest labelling that watch
  is a gross-regression tripwire, structurally incapable of resolving an
  effect this size (E-44, review M-2), so its only detector for this
  specific gap would have been user complaints, which is exactly the
  silent-failure class P7 exists to remove. So step 6a now carries the
  comparator shape directly: per-turn delta retain on the async Stop
  hook (writes are background and LLM-cheap on the vendor's own tiering,
  E-54; every-turn is both comparators' shipped shape, E-71), ordered
  **retain → prefetch recall → sentinel** inside the same hook, so the
  turn-N+1 injection sees turn N's write — Hermes's read-after-write
  guard reproduced as an ordering constraint rather than a new wait
  mechanism (§5 6a).

### 2.5 The REST shim — ALREADY SHIPPED (rev 6 status change), version-pin still owed

Rev 5 and earlier specified this as work to build. **It exists and is
deployed** (E-73): every agent's `hindsight` MCP entry is
`switchroom hindsight-mcp-shim`, which synthesizes `deactivate_directive`
/ `reactivate_directive` (the capability this section existed for —
`DirectiveAdmin` over `PATCH /directives/{id}`, E-09) plus the three
GET-only knowledge-page reads (`KnowledgeAdmin`), pinned to the agent's
own bank, contract-pinned by a fixture snapshot test. **Framing
correction (rev 11, E-95): that own-bank pin is OURS, not the
platform's.** The engine's knowledge-base REST surface is
bank-parameterised on every route — live `GET /openapi.json` on the
deployed 0.9.0 engine returns seven paths, all of the form
`/v1/default/banks/{bank_id}/knowledge-base/...` — and the shim already
forwards `bank_id` on every backend tool (`FALLBACK_TOOL_TABLE`,
`hindsight-mcp-shim.ts:190-222`). The restriction exists in exactly one
place: the five shim-synthesized tools, whose schemas omit `bank_id` by
deliberate design (`:258-262`) and whose `synthesizedCall()`
loud-rejects it (`:1379-1405`). Anywhere this design reasons about
widening page reach, the layer to change is the shim; no engine
capability is missing. What this section
still owes from the prior spec: the **engine version pin** from
`/openapi.json` (E-01's method, prior review MAJOR-4) and a doctor
contract probe against a throwaway bank — a grep of the shipped shim
finds no `/openapi.json` reference, so the pin is **not built** and stays
on the work list (its absence is what the snapshot-fixture test only
partially covers: names/props, not response shapes). Everything
else in this design — correction, mental-model lifecycle, retain, recall,
reflect — is on the engine MCP surface (E-59; over `POST /mcp` from hook
contexts), so no shadow client exists beyond the shim's two synthesized
families.

### 2.6 Named defect (rev 10, E-86): workers write memory they can never read

The sub-agent surface, completed beyond E-82's tool-allowlist half:

- A `worker` sub-agent has **zero memory read path of any kind**. Its
  explicit `tools:` allowlist carries no `mcp__hindsight__*`
  (`worker.md:5`), AND auto-recall never fires for a Task dispatch —
  the only injection hook is `UserPromptSubmit`, which fires on main-loop
  prompt submission, not sub-agent dispatch (verified empirically: a
  probe run as a `researcher` arrived with no injected block, and the
  5000-row recall log carries only main-session-shaped queries, E-86).
- Yet `SubagentStop` → `subagent_retain.py` retains the worker's prose
  into the **parent's** bank, tagged `sidechain` / `agent_type:worker`
  (E-86, verified live). The write path works; the read path does not
  exist — and `worker` is where implementation happens, so the fleet
  delegates its execution to exactly the agent type with the blankest
  memory. `researcher`/`reviewer` inherit the full tool surface and do
  reach Hindsight (verified live), but nothing in their prompts tells
  them to.

**Fix, specified:**

1. **Amend the `worker` allowlist with the read-only pull surface**:
   `mcp__hindsight__recall` and `mcp__hindsight__get_mental_model`
   (plus the three GET-only page reads already tracked as §10.6 W-6 —
   this extends W-6 rather than opening a second work item). One
   frontmatter line, deliberately scoped to reads; retain verbs stay
   off the worker surface (SubagentStop already owns the write).
2. **Dispatch-prompt discipline** (the deterministic half): the parent
   pre-fetches obviously-relevant standing context (orientation model,
   repo tree roster) into the dispatch prompt, and the worker prompt
   template names the pull tools it now carries — the §10.3 roster
   stops being inert.
3. **Not proposed:** auto-recall injection for sub-agent dispatches.
   There is no hook event for it, and the dispatch prompt is already
   the parent's deliberate context selection — new machinery would
   duplicate that with a worse query (cf. E-87's machine-generated-query
   pathology).
4. **Precondition:** the E-86 budget footgun (silent empty results at
   trimmed budgets) is root-caused or documented-around before worker
   pull guidance ships — otherwise the fix teaches workers to call a
   tool that silently returns nothing.

## 3. The reflect question — measured, decided

Rev 1 branched on whether reflect was tunable to the vendor's 800–3000ms
band (E-47's hypothesis: cloud-tuned concurrency and/or a small reflect
model). **The deployment config has now been read and both candidate
causes are disproved (E-61):** `LLM_MAX_CONCURRENT` is 28 (already under
the 32 default the vendor warns about), and reflect runs
`claude-sonnet-5` — not a small local model. Consolidation already runs
the vendor's own benchmark winner at their recommended batch size (E-54,
E-61). Nothing is mistuned.

The 51–87s (E-28) is **architectural**: reflect is an agentic loop of up
to 10 iterations (E-52), and every iteration is a full round trip through
the `claude-code` provider — the Claude CLI, not a low-latency API. The
only fix is switching provider, and `claude-code` is precisely what
satisfies the claude-native / subscription-honest invariant (C-03).
Trading an invariant for a benchmark is out of scope by definition
(invariants bind absolutely).

The decision now also carries vendor-side confirmation from their own
shipping code (E-64): the coding-agents package hard-caps hook-time
reflect at 25s (`HOOK_REFLECT_CAP_MS`, with an in-source INVARIANT
comment tying it to the host's 30s hook window), and on timeout ships the
session **without memory**, never retrying. At our measured 51–87s, the
vendor's own architecture concedes the point this section decides: live
reflect does not fit a hook window on a provider like ours.

**Decision: Branch B, permanently** (unless the provider landscape
changes under the invariant). Surface B is the cron-refreshed orientation
mental model (§2.2); reflect is a deliberate, visible, user-priced tool
(§2.3) and a cron workhorse (§2.2 refresh, §4.3 review). The benchmarked
winning pattern (E-79's replicated campaign) survives in adapted form,
with the divergences stated rather than smoothed (rev 8; §2.2, §8.2a):
"reflect once" is served from cache, but the winning arm re-injected the
cached reflect synthesis **every turn** and synthesised over the
*current* bank at session start, while Surface B injects once per
session from a cache that is up to ~a day old (stated and priced,
review m-7); "reflect as tool" is served live where waiting is
acceptable — and
per-turn pushed *fragment* injection is gone in every branch that was
ever on the table (P1's convergent grounds: E-46, E-63; rev 9 — E-70
dropped from the grounds, refuted, and today's shipped block is not the
fragment variant on the content axis).

## 4. Rule and directive lifecycle

### 4.1 Where rules live

Always-on behavioural rules ("never ship on Fridays," "always ask before
emailing") live in the root-`CLAUDE.md` rules block (Surface A) — not in
Hindsight directives. Reasons: the engine MCP cannot deactivate a
directive (E-09, E-59 — create/list/delete only; the shim's synthesized
deactivate, E-73, restores the verb but none of the rest); directives carry no
provenance and no telemetry (E-29, E-44); no cap is enforced server-side
(E-30); and the measured outcome of that surface is zero retirements ever,
fleet-wide (E-42). A switchroom-owned block gives every verb for free, and
root `CLAUDE.md` is the one surface whose post-compaction reload from disk
is documented (E-51, E-62).

### 4.2 What directives are for

Hindsight directives return to their designed role: **reflect-scoped
compliance guardrails only** (E-03), applied by the engine with zero client
work (E-27: `based_on: {directives: 24}` live), tag-scoped where
appropriate (E-04). Post-triage counts should be low single digits per
bank — and the count stays watched, not assumed: today's doctor
machinery already WARNs above 24 active directives and FAILs above 30
per bank (`MAX_DIRECTIVES`, `doctor-memory.ts`), and it remains in place
post-triage as the ongoing re-accumulation tripwire on the engine
directive count. Fleet-common guardrails — `no-confabulation` above all, today pasted
verbatim into 13 banks with one sibling drifted into two incompatible
copies (E-43) — are consolidated to one source of truth via a **bank
template** (E-49). Honest scoping (review m-5): E-49 evidences templates
as an *onboarding* mechanism; applying one to 13 live banks is a
mechanical pass — create the canonical directives, deactivate the per-bank
copies via the shim — using the template as the canonical definition, not
a vendor-evidenced retrofit verb. And because E-43's drift happened *after*
creation over time, reconciling once is a reset, not a cure: a periodic
doctor check diffs each bank's template-owned directives against the
template and WARNs on divergence (review m-6).

The template also carries missions and audited `disposition_*` values
(E-40: klanker's disposition is already populated by nobody — audit before
leaning on it).

### 4.3 The lifecycle verbs

All rule mutations go through one switchroom tool (plugin-owned, no engine
dependency) — the only sanctioned writer of the rules block (§2.1a):

- **Create:** user states a standing preference → agent invokes the rules
  tool, which writes the rule with id/source/timestamp, appends the
  mutation log, and announces in chat ("added standing rule R-14: …").
  Write path enforces the byte budget (§2.1) and runs a contradiction
  check against the small active set; a conflict surfaces to the user at
  creation ("this contradicts R-04 — replace it?") and the loser gets
  `status: superseded-by R-14` in the archive. This is where most
  retirement actually happens: at the moment the user states the new
  preference.
- **Retire:** block rewrite + log append + archive entry, announced,
  reversible. Directives: `deactivate_directive` — already live on every
  agent via the shipped shim (E-73, §2.5; PATCH-backed per E-09). Mental models:
  `update_mental_model` / `clear_mental_model` / `delete_mental_model`,
  all MCP-native (E-59) — and a deleted model loses nothing durable, since
  it re-synthesises from the bank (E-48).
- **Review:** a low-frequency cron posts one consolidated card over rules
  with no activity signal, using the two deterministic retirement signals
  the ledger validates — **supersession** and **mechanization** (a rule now
  enforced by code) — plus category errors (a fact filed as a rule → retain
  it as memory instead) (E-45). **Citation counts are never a retirement
  signal** — they preferentially kill rules that work quietly (E-44). Age
  alone is the weakest signal and never sufficient (E-45). An operator
  keep-tap on the card stamps the rule (prior review MINOR-4's fix), so a
  vital old rule stops being re-nagged. The cron may use `reflect` to
  summarise what the bank currently believes — off-path latency is fine
  (E-61).

### 4.4 How retirement survives compaction — BLOCKER 2, answered on documented ground

The mechanism inverts the failure, and rev 3 moves it onto the only
surface the docs actually cover (E-62). Under the superseded draft, rules
were rendered once into conversation history; compaction dropped the
mid-session retirement exchange while the stale render survived, silently
resurrecting the retired rule. Rev 2 fixed this with an `@path`-imported
file — resting on a re-read claim E-51 never made; E-62 confirms import
re-expansion at compaction is undocumented in both directions. So:

- Rules live **in root `CLAUDE.md` itself**, whose post-compaction
  re-injection from disk is documented ("Project-root CLAUDE.md and
  unscoped rules — re-injected from disk", E-51, E-62).
- Retire R-07 at turn 5 → the block changes on disk immediately; the chat
  announcement covers the live window.
- Compaction at turn 80 → root `CLAUDE.md` is re-injected from disk,
  already lacking R-07. Compaction *applies* the retirement rather than
  undoing it.
- The only exposure window is [mutation → next re-injection] within one
  uncompacted stretch, and the in-transcript announcement covers exactly
  that window — it is recent history by construction; if compaction drops
  it, the re-injected block is already correct.

Rev 7 resolution (E-81): the "does the preserved section count as
unscoped?" question was **malformed and dissolves** — the
unscoped/path-scoped distinction is file-level, not section-level; root
`CLAUDE.md` is injected as one whole-file unit (observed live in a
v2.1.233 session, `# --- Yours ---` marker and all — the CLI is blind to
the marker) and re-read from disk after compaction per the docs. The
honest limit, carried from the probe verbatim: the definitive in-situ
test (mutate the preserved section → force `/compact` → ask for the
mutated text) "has NOT been run and remains the definitive test" — it is
kept as a cheap **post-step-5 canary** (§5 step 1(f)), no longer a gate.
The fallback direction remains known: if the canary ever fails, the
block moves higher into the root file's regenerated body via the apply
template — same surface, same mechanism.

## 5. Migration — ordered, each step independently shippable and reversible

**Step 0 — the non-step, recorded because it was formally evaluated
(§0a, E-63..E-67): migration does NOT route through
`@vectorize-io/hindsight-coding-agents`.** Concretely ruled out:

- **No `install claude-code`** on any agent: the installer writes
  `~/.claude/settings.json` hooks, user-scope MCP, and a skill — surfaces
  `apply` owns — and the runtime it wires is dead on arrival here (its
  25s-capped session reflect times out against our 51–87s reflect,
  E-64). Its hooks would also double-retain alongside ours (E-66).
- **No `--import-conversations`**: it exists to rebuild the *vendor's*
  old per-agent-plugin banks from local coding transcripts, splitting by
  recorded repo cwd (E-67). Our banks are already live on the target
  engine and share no lineage with those plugins (P-04); re-extracting
  persona-agent transcripts into per-repo-keyed banks is the wrong
  topology and a pure token cost.
- **Nothing else in the package transfers**: it has no directive,
  mental-model, or rules-lifecycle surface to migrate onto (E-67). Its
  one architectural lesson — per-turn injection removed, reflect-once +
  pull, loud memoryless-session diagnostics — is already this design
  (§0a), and steps 5–7 below implement our version of it.

Re-evaluate only if the package grows a persona/non-repo mode **and**
hook-time reflect becomes feasible under the claude-native invariant —
the two disqualifiers are independent, and both currently stand.

1. **Probes and instrumentation (no behaviour change).**
   (a) Verify `enable_observations` is ON fleet-wide (E-38; key name
   corrected per E-82 — `enable_observation_history` does not exist in
   the deployed schema; klanker already verified `true` live, remaining
   banks to enumerate).
   (b) Fleet audit of `disposition_*` (E-40).
   (c) Log injected directive IDs into `recall_log` rows (E-45
   recommendation (b)) — turns
   exposure measurable *before* we change it, giving a real before/after.
   (d) Fix the stale scores comment at `recall.py:344-345` (E-24).
   (e) **Mental-model cost probe** on a throwaway bank:
   `create_mental_model` → `refresh_mental_model` (full and delta) →
   `get_mental_model`, measuring read latency (expected milliseconds,
   E-52) and — the number §6 needs — **actual refresh cost, full and
   delta, including on a heavy bank's data volume**. Note the fleet
   constraint: mental-model writes are operator-approved here, so this
   probe ships as an **operator approval card**, not an agent-initiated
   call (stated so nobody scripts around the approval gate).
   (f) **Compaction re-injection canary** for the preserved-section rules
   block (§4.4, E-62, E-81): mutate → force compaction → diff. Rev 7:
   **demoted from gate to canary** — E-81 confirmed the
   unscoped/path-scoped distinction is file-level and root `CLAUDE.md` is
   injected whole-file and re-read from disk after compaction (preserved
   section included). The probe is retained because it is the one direct
   observation not yet made; it runs as a post-step-5 canary, and its
   result still becomes a ledger entry.
   Reversible: all read-only, additive, or throwaway-bank scoped.
2. **Directive-deactivate reach: DONE (rev 6, E-73)** — the shim ships
   `deactivate_directive`/`reactivate_directive` on every agent already.
   Remaining in this step: the engine **version pin + doctor contract
   probe** (§2.5, not built), and the rules tool + mutation log, dark
   (blocks written but root `CLAUDE.md` not yet carrying them / old block
   still live). Reversible: nothing consumes it yet. *(Ordered before the
   template hoist so step 3's rollback mechanism — deactivation — exists
   under the design's own discipline, review m-2.)*
3. **Bank template for fleet-common guardrails** (E-49, scoped per §4.2):
   create canonical directives from the template, deactivate the 13
   per-bank `no-confabulation` copies and reconcile the drifted
   `windows-boxes-access-and-full-stop` pair (E-43) via the step-2 shim.
   Standalone win — ~1KB per injection saved fleet-wide immediately, zero
   behaviour change. Reversible: reactivate the per-bank copies (same
   shim).
4. **Triage one heavy agent** (overlord — worst case, E-41): sort its 26
   directives into rules-block / reflect-directive / disposition / retire /
   retain-as-memory (E-45's categories), operator-reviewed as one card.
   **Measure the always-on residue and set the operational rules budget
   from that data** — triage first, cap after (prior review MAJOR-1).
   Reversible: retirements are deactivations.
5. **Flip Surface A per-agent** (step 1(f)'s gate lifted at rev 7 per
   E-81; the mutate-and-compact canary rides behind the flip): write the
   rules + index blocks into the preserved section, enable the load canary
   and integrity check, stop injecting `<active_directives>`. Per-agent
   flag; block code kept dead-off for one release after fleet-wide flip
   (prior review MINOR-6). Reversible: flag.
6. **Converge the recall path on the comparators, in two arms (rev 5,
   P-14; re-based rev 7, E-79).** Rev 4 deleted injection outright on
   E-57's sign; rev 5 established that sign was claimed for the
   raw-fragment synchronous variant in the coding domain (E-69), that
   both chat-domain comparators ship a materially hardened variant
   instead (P-08/P-09/P-12), and that the operator's steer names those
   comparators as the behavioural target. **Rev 7 removed the sign
   itself:** E-57 is a vendor anecdote whose delta is on the order of
   single-run noise (within ~1.3–3 sd of the published campaign's
   between-run spread), and E-69's account of the losing arm is
   interpretation of blog prose (E-79). So:

   **6a — harden the injection to the comparator shape (the fleet
   default, and — rev 10 — the END STATE, not a transition).
   Scope at rev 9 (E-70 REFUTED): the types half is already live
   fleet-wide; rev 10 adds back the tuning work the live log shows is
   real (E-85, E-87), so 6a is timing, cadence, budget, and gating.** Revs 5–8 had 6a shipping `recall_types` = all three types
   with `prefer_observations` effective as "E-70's fix"; that
   configuration is the deployed status quo, verified at the scaffold
   override site, the operator schema, and all 12 deployed
   `settings.json` (E-70 rev 9 correction) — there is nothing to change
   and nothing to flip. E-80 stands as directional validation of that
   shipped default (combined never lost to the raw-only opt-out arm,
   strictly won 5/15; `prefer_observations`'s increment under combined
   types unmeasured, §2.3). What 6a still ships, and today's block still
   lacks: recall moved **off the reply path** via an `async` Stop-hook
   prefetch at end of turn N + buffer read at the UserPromptSubmit of
   N+1 — today's recall is synchronous on the reply path at **p50
   ~1.3s / p90 ~5.5s / max ~9.2s live** (E-84; revs 1–9 cited E-28's
   0.6–0.75s here, which measured the single-bank MCP tool, so the
   off-path move is worth ~2× more at median and ~7× at p90 than this
   document previously claimed) — plus the per-turn delta retain and
   pipeline ordering below (today's retain is every-Nth, E-71). **Rev 7 correction (E-81): the
   mechanism is native but the timing guarantee is not — the join is
   ours to build.** Nothing makes turn N+1 wait for turn N's async hook,
   so a fast reply reads a stale buffer or nothing; the spec is
   therefore: the Stop hook writes its buffer then a `buffer.done`
   sentinel last, and the **synchronous** UserPromptSubmit hook (which
   blocks model processing inside its 30s default window) polls for a
   sentinel newer than last-consumed, capped at ~2–3s — Hermes's 3s join,
   hand-rolled — then reads whatever exists. The **stale-buffer fallback
   is specified, not left to chance** (it WILL happen on fast replies):
   inject the previous turn's recall explicitly marked stale, or skip
   with the degraded notice. **Pipeline order inside the Stop hook is
   fixed (rev 8, pulled forward from §2.4 per E-71): per-turn delta
   retain first, then the prefetch recall, then the sentinel.**
   Retaining every turn (delta — just the new turns) removes the
   up-to-N-1-turn recall lag of the every-Nth cadence, which is both
   comparators' shipped shape (E-71) and background/LLM-cheap on the
   vendor's own tiering (E-54); the ordering makes the turn-N+1
   injection see turn N's write, reproducing Hermes's
   `prefetch_waits_for_retain` read-after-write guard by construction
   instead of leaving the "what did I just tell you" miss to
   user-complaint detection. The retain's latency now lands inside the
   async hook window — one more reason the explicit `asyncTimeout` rail
   matters. Two rails from E-81: set `asyncTimeout`
   explicitly on the Stop hook (the 15000ms default kills a slower
   recall pipeline), and keep the hook silent on stdout (async stdout is
   delivered as a next-turn attachment).

   **The comparator-hardening of the block itself (added rev 10 — the
   probe attributes our grab-bag to tuning, not cadence, and the live
   log agrees, E-85):** rev 9 kept the deployed caps saying "the budget
   was never the problem either way"; E-85 refutes that for the
   injection path — the block fills all 16 slots whenever candidates
   exist (42% of logged rows capped), with injected score minima at
   1e-4 and the deployed 0.01 floor scoped to degraded mode only, i.e.
   never applied on a healthy turn. Against the comparators (Hermes:
   observation-only, 4096 tokens, background prefetch + 3s join;
   openclaw: observation-only, 1024 tokens, awaited in
   `before_prompt_build` under a 10s cap — P-08/P-09/P-12, re-verified
   at source for the cadence probe), 6a specifies:
   - **Budget converges into the comparator band:** token ceiling
     6144 → 4096 (Hermes's default — rev 10 also corrects P1's rev-9
     "both comparators 1024"), count cap 16 → 8. Labelled honestly:
     these are comparator-alignment tuning moves with a named live
     signal (E-85's capped-fraction and score distribution), not a
     measured quality claim; both are config, reversible, and the
     injected-score fields now logged per row are the data the final
     numbers get set from.
   - **The junk-query gate (E-87):** the deterministic skip gate
     extends to machine-generated `<task-notification>` prompts —
     ~20–30% of all logged recalls, each eligible for a full-cap
     injection over a query of task IDs and file paths the user never
     wrote. Skip auto-recall on those turns entirely: anything the
     parent needs while processing a worker result is reachable by
     pull, and the high-scoring hits these queries do produce are
     mostly the sidechain retain of the same task — self-referential
     similarity, near-zero new information (E-87). Detection is the
     envelope tag: deterministic, no model judgment.
   - **No score floor — the probe's recommendation (e) is REFUSED on
     measured evidence, and the refusal is stated rather than
     silent:** the cadence probe recommends "a real score floor outside
     degraded mode"; E-13 measured (330 replayed queries) that scores
     are not calibrated across queries — a rank-1 relevant hit can
     score ~0.001 — so every candidate floor trimmed no bad tail and
     only emptied result sets (0.001 → 28.2% zero-result), and the
     vendor independently warns the same (E-50 item 4). The junk cut
     comes from the count cap, the E-87 gate, and the observation-lean
     arm below — the levers the comparators actually use — not from a
     floor.
   - **Observation-only vs combined types — the honest tension, not a
     silent pick:** both comparators ship observation-only with a
     stated reason (raw types re-ship the evidence observations already
     summarize, burning the budget — Hermes source comment, verified),
     while E-80 measured combined beating the raw-only opt-out AND
     beating observation-only on redundancy **on our banks** (15
     queries, one pass — suggestive, not conclusive, §8.11). Combined
     stays the shipped default because it is the deployed status quo
     with the only on-our-data measurement behind it; observation-only
     remains the cheapest A/B there is and SHOULD be run per-agent
     under 6a — if it wins at the reduced caps, the comparators' shape
     is adopted whole. Neither outcome is pre-asserted.

   Keep the trivia gate and our degraded notice (the one axis we lead
   both comparators on, P-01/P-11). Staleness trade (injected memories
   answer the previous turn's query) accepted exactly as Hermes accepts
   it, with `recall_sync`-style opt-back-in per agent (P-08). This
   removes the remaining failure mechanism the vendor's autopsy names
   (E-69, as interpretation) — the hot-path round-trip; the
   fragment-content mechanism is already absent from the shipped block
   (rev 9, E-70 refuted) — while landing the behaviour the operator
   steered toward: every-turn injection, shaped like Hermes and
   openclaw, as the place this design stops.

   **6b — tools-only flip, per-agent: an experiment arm behind an
   explicit evidentiary gate — NOT the destination (reframed rev 10;
   revs 5–9 carried it as the end-state 6a transitioned toward, which
   outran the evidence in the other direction).** Disable the
   (now-hardened) injection, enable the tool-path guidance +
   knowledge-index block — the rev-4 step 6, now per-agent and demoted:
   rejected as a fleet trajectory unless the gate below is met.
   **The switch, specified (rev 8 — previously one adjective):**

   - **Key and location:** `memory.injection` in `switchroom.yaml` —
     declared once on `AgentMemorySchema` and mirrored at the
     `defaults.memory` / profile tier like every other memory knob
     (`src/config/schema.ts`'s existing declare-once pattern), cascading
     per-key defaults → profile → agent.
   - **Values:** `hybrid-hardened` | `tools-only`.
   - **Default:** `hybrid-hardened` at the `defaults` tier — this IS the
     6a fleet default, now stated rather than implied. `tools-only` is
     the per-agent 6b override.
   - **Semantics:** `hybrid-hardened` = the full 6a pipeline (hardened
     async injection, per-turn delta retain, plus the tool surface that
     every agent carries anyway); `tools-only` = injection disabled,
     tool-path guidance + knowledge-index block active. Both values keep
     Surfaces A, B, and D; the flag governs only the per-turn injection
     endpoint, and flipping it is reversible per agent. The existing
     `memory.auto_recall` boolean is today's injection kill-switch; at
     step 6 the enum becomes the operator-facing contract and
     `auto_recall: false` maps onto `tools-only` (implementation detail
     of the flip, not a second independent knob).
   - **Engagement with Hermes's enum (P-07):** Hermes's `memory_mode`
     carries three values — `context` / `tools` / `hybrid` — and this
     flag carries two. `context` (injection-only: no memory tools at
     all, `get_tool_schemas()` returns `[]`) is **deliberately dropped,
     not silently**: on Hermes the memory tools are plugin-emitted
     schemas that can be withheld per mode, whereas here they are the
     Hindsight MCP surface every agent carries, and withdrawing them
     would be per-agent allowlist surgery serving no design goal; more
     decisively, Surface C is load-bearing in this design — the
     knowledge-index block, the correction verb, and post-compaction
     re-orientation all presume the pull path, and agent-invoked
     retrieval is the inspectability gold-standard (C-01) — so an
     injection-only mode would amputate the design's own core. If a use
     case ever appears, adding the enum value is additive and cheap;
     until then two values is the honest shape. Otherwise this is the
     exact parameterisation Hermes shipped rather than deciding
     architecturally (P-07): a config choice, defaulted, per-agent.

   **Stated plainly (rev 7): the
   fleet-wide "delete per-turn injection" position has no surviving
   evidence in either direction (E-79, P-14), and the evidence could
   only be generated by us.** The public sde-bench harness carries a
   recall arm (`--history hindsight`) alongside reflect and vanilla; a
   single-run recall-vs-vanilla pass is ~$60–80 and, given the measured
   between-run sd (E-79), could not carry the decision — **a ~$300
   triplicate matrix is the only defensible shape**, ideally plus a
   fourth arm configured like what we actually ship (capped
   observation-only async recall), which is the comparison the decision
   needs and which no vendor run, published or promised, provides.
   Commissioning that run is an operator call (real dollars, and the
   harness drives agent CLIs with API-billing semantics — it needs its
   own rails conversation). **A cheaper interim signal exists (rev 10,
   carried from the cadence probe as its reasoning, ~$0):** A/B two
   live agents for a week — one 6a-hardened, one tools-only — scoring
   only deterministic signals already logged ("you already told me"
   incidents + spontaneous recall-tool invocation rate per turn). It
   cannot measure the quality sign (E-44's limit stands), but if the
   tools-only agent's pull rate is high and misses rare, the openclaw
   premise ("models don't pull") weakens for Claude-class models and 6b
   regains a case worth the $300 run; if pulls are rare, 6b stays shut
   without spending anything. Until one of those reports, any 6b flip
   is a labelled judgment call per agent, flag-reversible, never
   presented as evidence-backed — and the fleet's stated end state
   remains 6a.

   **Honest labelling (review M-2, restated for both arms): the one-week
   watch is a gross-regression tripwire, not a validation of any sign.**
   E-44 establishes influence is not measurable in our telemetry, and a
   ~9% effect of the kind E-57 anecdotally reported is on the order of
   single-run noise even on the purpose-built harness (E-79) — a week on
   one agent cannot resolve it. What it catches: obvious quality collapse, "you
   already told me this" complaints, gross behaviour change. The
   hardened-variant-vs-tools-only sign is **unmeasured in either
   direction** (P-14, E-79) — which is precisely why 6b is per-agent and
   flag-reversible, and why 6a (which only removes mechanisms everything
   argues against and nothing argues for) is the fleet default and, at
   rev 10, the end state. Surfaces
   A, B, D and the directive-block deletion stand on independent
   evidence (E-06/E-27/E-41) regardless of where each agent lands.
7. **Orientation mental model per agent** (§2.2): operator-approved
   create, refresh cron + staleness guard, SessionStart read. Staggered
   rollout; **cadence and rollout gated on step 1(e)'s measured refresh
   cost keeping §6's net within bounds the operator accepts.** Reversible:
   `delete_mental_model` — nothing durable is lost (E-48) — and the
   SessionStart read degrades to its cold-model notice.

Sequencing rule: the directive block (step 5) and recall block (step 6a/6b)
are never removed before their replacement surface is live on that agent.

**Deferred obligation — DISCHARGED at rev 11 (commit `22e1d9f`).** The
job spec `reference/jobs/remember-across-sessions.md` has been rewritten
against this design; five defects in the old text are corrected there
(the withdrawn "decays sensibly" half, the missing rule-retirement story
against E-42's zero-retirements, the orientation read relabelled from
achieved to target per E-88, cadence stated, and the sub-agent /
never-pooled clauses added). The original obligation text is retained
below for provenance.

**Deferred obligation, tracked (rev 8): the job-spec update.**
`reference/jobs/remember-across-sessions.md` — this design's `serves:`
target, whose acceptance criteria are C-01 — still describes the job
against the pre-redesign memory shape. The operator asked for the jobs
docs to be brought up to date; that work is **deliberately deferred until
this design stops changing shape** (revs 5–7 each moved load-bearing
pieces — the step-6 split, §10, the probe corrections — and rewriting the
job doc against a moving target would churn it once per rev). What the
update covers when it lands: how each Good / never-ship criterion is now
met (inspectable agent-invoked pulls, loud failure modes, the correction
verb, compaction-durable rules), the four-surface architecture in the job
doc's own vocabulary, and §10's repo-knowledge composition. It is not
gated on 6b — the surfaces it documents ship regardless of where agents
land on the injection flag. Recorded here so the obligation cannot be
silently dropped.

## 6. What this costs — the solid number, the unknown number, and the quality claim

**Today, measured and estimated:** ~48.7M directive input tokens per 30
days fleet-wide, measured (E-41), dominated by overlord (~27.4M / 4,048
injections) and klanker (~11.0M / 2,989). The recall block adds an
**unmeasured** amount whose nominal ceiling, corrected at rev 9, is
~164M (26,773 logged rows/30d × the **deployed 6144-token budget** —
revs 1–8's ~27M used the vendored 1024, the same snapshot-vs-deployed
trap as E-70; see P-05's correction). That ceiling is nominal twice
over: rows may be small or empty (E-42 counts rows not tokens; review
m-4), and the deployed 16-memory count cap binds before the token cap
does (switchroom.yaml's own rationale). Rev 10 adds the composition of
that traffic: **~20–30% of the logged rows are machine-generated
`<task-notification>` recalls** (E-87 — 19.7% of 5000 rows, 30.5% of
the last 200 at probe time, re-measured same day at 22.4% and growing),
each eligible for a full-cap injection over a query the user never
wrote. Today's injected-memory bill is
therefore **~49M measured + an unmeasured recall share with a ~164M
nominal ceiling that nothing suggests it approaches** — the honest
statement is that the recall share is unmeasured, wider than revs
1–8 stated, and a fifth-to-a-third of it is spent on queries that
step 6a's E-87 gate deletes outright.

**After — three claims at three confidence levels:**

1. **Solid: the measured ~49M/30d directive block is deleted outright**
   (E-41 baseline), replaced by ≤ ~1.5k tokens of Surface A per context
   assembly plus ≤ 2048 tokens of Surface B per session — hundreds of
   loads per 30 days fleet-wide, not tens of millions. **Amended rev 5:**
   the recall block's share (unmeasured; nominal ceiling ~164M at the
   deployed caps, rev 9 correction above) **persists by design** —
   every-turn injection is the end state (rev 10, P1), so this spend is
   permanent fleet posture, not a transitional cost. What 6a does to it
   (rev 10): the E-87 junk gate removes ~20–30% of rows and the budget
   convergence (6144→4096 tokens, 16→8 memories) cuts the per-row
   ceiling by a third — together roughly halving the nominal ceiling to
   **~75–90M/30d, still nominal twice over and still unmeasured**; no
   point inside that range is asserted. It goes to zero only per-agent
   at 6b, which is no longer the destination: the >95% "injected
   tokens" drop of rev 4 is 6b-arm arithmetic, not this design's
   trajectory; day one still deletes the larger, measured directive
   block. (The optional orientation re-inject knob, §2.2, is priced
   there: off by default; every-turn at ≤2048 tokens would be up to
   ~55M/30d nominal, which is exactly why it defaults off.)
2. **Unknown pending measurement: the net total.** The new spend is
   Surface B refreshes on the `claude-code` provider — the subscription
   (E-61). `refresh_mental_model` has **never been measured**; the only
   adjacent datum is two live-reflect runs on one bank (~35k input each,
   E-28), and the engine ceiling is an order of magnitude higher (E-52:
   10 iterations × 100K context cap). At ~720 runs/30d the plausible
   range spans **~10M tokens/30d (delta refreshes cheap) to ~50M+ (heavy
   banks near the E-28 shape or above)** — i.e. the net change versus
   today is **anywhere from roughly neutral to a ~65% reduction**, and it
   is dishonest to pick a point in that range before step 1(e) reports.
   Step 7 is gated on that measurement, and the cadence is the knob that
   keeps the net inside what the operator accepts (halving cadence halves
   the bound; the cost is staleness, guarded visibly, §2.2).
3. **Qualitative, and the actual point (re-scoped rev 7):** the spend
   that is removed is on-turn injected context with **no surviving
   evidence of benefit** — the vendor's "worse than no memory" number is
   an anecdote with a delta on the order of run-to-run noise (E-79), but nothing anywhere
   shows the raw-fragment block helping either, and both comparators
   abandoned its shape (rev 9: "and our config was defective, E-70" is
   withdrawn from this list — E-70 refuted; today's block already
   carries the consolidated tier, so the spend 6a re-times is not
   fragment-shaped content, it is hot-path timing and retain lag). The spend
   that is added is off-turn synthesis in the pattern the vendor
   measured *helping* — replicated, 9/9 runs, non-overlapping ranges
   (E-79). Even a token-neutral outcome is a defensible trade; what it
   is NOT is the measured-quality-win rev 4 claimed. Generating a real
   measurement of the injection question is itself priced: ~$300 for a
   defensible triplicate self-run (§5 step 6b, E-79) — a cost this
   section names rather than hides, and refuses to pre-judge.

Non-token costs, stated: a second store (the rules block + mutation log —
small, plain, user-readable; accepted because shimming lifecycle onto an
engine surface with no provenance/no deactivate/no cap is more moving
parts, E-09/E-29/E-30); the shim's two synthesized REST families — both
already shipped and fixture-pinned, with the version pin still owed
(E-73, §2.5); triage
operator-work once per agent; pull-miss risk on turns where the agent
should have reached and didn't (bounded by the index + guidance; accepted
as an honest unknown at rev 7 — the quality evidence that used to cover
it, E-57, is downgraded, which is part of why 6a keeps a hardened
injection as the fleet default and, at rev 10, the end state — the
pull-miss cost is then bounded to 6b arms only); orientation staleness — up to ~24h behind the
live vendor pattern by design (a 9pm correction is absent from the 7am
briefing; recall-as-tool and the correction verb cover it on demand,
review m-7), unboundedly stale only if the cron dies, which is guarded
visibly rather than assumed away (§2.2, review M-3); and ~20–35 min/day of
off-turn fleet wall-clock for refreshes (review m-1).

## 7. Explicitly rejected

- **Adopting `@vectorize-io/hindsight-coding-agents`** (wholesale or
  partial) — evaluated against the full reference and package source
  (§0a, E-63..E-67). Its session-orientation mechanism is structurally
  inoperative on our provider (25s hook cap vs 51–87s reflect, E-64);
  its ingestion pipeline is coding-domain (E-65); its survey default
  shells `claude -p --max-budget-usd` (E-66); it carries no curation
  layer (E-67); and its installer contends with `apply` for the hook/MCP
  surfaces (E-66). Its architecture is adopted as *corroboration*, not
  as code. Revisit condition named in §5 step 0.
- **Per-turn recall injection in the raw-fragment synchronous shape**
  (the prior draft's "push floor") — retitled at rev 9: revs 5–8 called
  this "its current shape", but E-70's refutation established that
  today's shipped block is NOT that shape on the content axis (it
  already carries the consolidated observation tier); what today's block
  still shares with it is the synchronous reply path and the every-Nth
  retain lag, which is 6a's remaining work. The raw-fragment variant is
  rejected at rev 7 on convergent grounds rather than the retracted
  measurement (E-79): the vendor argues against it in prose (E-46) and
  removed it from their own coding-domain default (E-63); both
  comparators moved off its shape (P-09/P-12); and no evidence anywhere
  shows it helping. (Rev 9: the "our instance was additionally
  defective" ground is withdrawn — E-70 refuted.) E-57's "worse than no
  memory" number no longer carries weight
  (vendor anecdote, delta within noise — E-79); E-69's mechanism-level
  autopsy is carried as labelled interpretation. The **hardened
  comparator variant** (observation-inclusive, off-reply-path, capped
  into the comparator band, junk-gated) is NOT rejected — it is the
  design's end state (rev 10, P1): its content half is the shipped
  status quo, its timing/budget/gating half is step 6a. Tools-only is
  a per-agent experiment arm behind 6b's evidentiary gate, no longer
  the framed endpoint.
- **Per-turn directive block** — premise expired with upstream #1269
  (E-06); engine applies directives itself in reflect (E-27); measured at
  ~48.7M tokens/30d (E-41); switchroom-original with no analogue anywhere
  (P-01).
- **`@path` imports for any load-bearing standing content** — compaction
  re-expansion is undocumented in both directions (E-62), and the losing
  side of the coin-flip silently resurrects retired rules with the
  accidental backstop (the directive block) already deleted. Root
  `CLAUDE.md` is the documented surface; no import fallback is kept.
- **Knowledge pages for PERSONA standing knowledge — still not adopted
  (rev 6 re-scope of what was "deferred").** The rev 2–5 grounds (zero
  MCP tools, bespoke shim to build) are gone — the shim's page reads
  shipped (E-73) — but the persona-side verdict survives on the grounds
  that remain: a persona agent's standing answers are Q&A-shaped, which
  is the bare mental model's case by the vendor's own choose-by-shape
  rule (E-48); page creation would still need a new gated write path
  (E-74); and E-60's no-filesystem-projection finding stands (no
  `hindsight` CLI, no `/dev/fuse`; FUSE means `SYS_ADMIN` × 12 against an
  unauthenticated service, E-33). Pages ARE adopted for repo knowledge —
  §10 — where the document/tree shape is the point, not ceremony.
- **`hindsight fs mount` as a read path** — dead in this topology (E-60).
- **Live reflect on any latency-sensitive path** (rev 1's "Branch A") —
  the latency is architectural on the `claude-code` provider, and the
  provider is invariant-pinned (E-61, C-03). Not a tuning backlog item; a
  closed door.
- **`search_knowledge_pages` as a retrieval path** — rerank-free; the
  6.7% R@1 vs 69.7% figure (E-53) is the vendor's measurement of
  rerank-free RRF on the **recall pipeline** (300-candidate fact
  retrieval, LoComo), carried here as an upper-bound analogy for what an
  unreranked path costs — page search itself (doc-level, ~10 pages) was
  never benchmarked (rev 9 clarification; the rejection rests on the
  verified absence of a reranker plus that analogy, E-53's rev 9 note).
  Rev 6: the tool IS reachable now (E-73), which
  makes this rejection *more* load-bearing, not moot — in §10 it is
  bounded to doc-level lookup over a ≤10-page taxonomy where tree-browse
  is the primary read; it must never stand in for `recall`.
- **Shared cross-agent banks for conversational memory, or with
  concurrent free-form writers** — no contradiction detection, writer
  identity stripped before adjudication, silent arbitrary overwrite
  (E-38); vendor's own model is bank-per-identity (E-49, E-50). Fan-out
  reads only (E-32, refined by E-75: the `bank_id` argument makes the
  fan-out native). Rev 6 scope note: §10's shared **repo** bank does not
  reopen this — it is single-writer by construction (one deterministic
  ingestion pipeline; agent writes only via E-78's explicit gated lesson
  path, if ever enabled), and it never receives conversational retains.
- **Dynamic (derived) bank IDs, openclaw-style** *(added rev 11)* — a
  bank key templated over runtime context. **Do not adopt.** Keep §10's
  shared single-writer repo bank composed with the already-deployed
  `additional_banks` read fan-out. One-line reason: dynamic banks solve
  *identity isolation*, which a static operator-owned agent→repo mapping
  already gives us, while adding silent-misroute (`unknown` /
  `anonymous` fallback segments, E-89) and ungated-lazy-bank-creation
  failure modes. Supporting detail: openclaw's mechanism is
  identity-derived and its docs section is titled *Memory Isolation* —
  "each unique combination gets its own **isolated** memory store"
  (E-89); Hermes reaches the same model from the opposite default
  (E-90); neither adds any concurrent-writer machinery, so nothing about
  going dynamic touches E-38 (E-91). Our fleet's bank mapping is ~15
  static entries in operator config, where a template saves nothing and
  costs the failure modes. **Counter-evidence carried, not smoothed
  (E-96):** the vendor does publish a how-to for *sharing* one dynamic
  bank across agents — drop `agent` from the granularity, keep the user
  dimension — so "dynamic banks can't share" would be false, and the
  rejection does not rest on it. It rests on what that sharing buys
  here: a bank keyed on the **user**, which is the `ken-profile` /
  `lisa-profile` + `additional_banks` topology this fleet already runs
  statically (E-96 pt 2), not §10's repo-shaped case — bought with
  derivation failure modes and no gain against E-38, whose only answer
  in that guide is a retain *mission*, i.e. a content filter, not
  adjudication (E-96 pt 3).
- **Session-start render of rules into conversation history** — the
  original draft's mechanism; fails compaction (review BLOCKER 2), and
  E-51 shows the render-once path is exactly the one that doesn't reload.
- **A recall relevance floor (`min_scores`)** — scores uncalibrated across
  queries; floors only empty result sets (E-13; vendor independently
  confirms, E-50 item 4; E-25 does not license it). Rev 10: re-tested
  against the cadence probe's recommendation to "apply a real score
  floor outside degraded mode" after E-85's live grab-bag (injected
  minima at 1e-4, floor never applied on healthy turns) — the rejection
  **stands**: E-13 is a 330-query measurement that floors trim no bad
  tail and only empty result sets, and it beats the probe's reasoning.
  The grab-bag is cut instead by 6a's count cap, the E-87
  task-notification gate, and the observation-only A/B (§5 6a).
- **Lexical-overlap gating** (E-14), **rerank-candidate caps** (E-15),
  **DB-level latency levers** (E-17) — all shipped-or-tried, measured,
  dead.
- **Auto-seeded per-agent profile mental models** — ripped out with cause;
  profile banks own identity (E-16). The orientation model's query
  excludes identity for exactly this reason (§2.2).
- **Citation counts as a retirement signal** — kills rules that work
  quietly (E-44).
- **Recency decay as a fade/demote mechanism** — bounded to ±10%, the
  cross-encoder dominates; old memories do not fade (E-56).
- **`apply_all_directives: true` to keep the block cheaper** — answers the
  wrong question; the problem is per-turn injection, not reflect's tag
  filter (E-04; the cost case is E-41's measured ~48.7M/30d, which needs
  no benchmark).
- **Client-side caps as enforcement** (`MAX_DIRECTIVES` shape) —
  inject-path-only, bypassable, unenforced server-side (E-08, E-30);
  enforcement moved to write paths we own, with tamper-evidence (§2.1a).
- **Hindsight Cloud RBAC as an answer to anything** — different product;
  the move is invariant-barred (P-06, C-02).
- **Fixing E-33/E-33a from inside this design** — network isolation is the
  operator's call; this design doesn't worsen it (no new listeners, no new
  cross-bank writes, and E-60's refusal of fleet-wide `SYS_ADMIN` keeps it
  that way) and doesn't pretend `bank_id` secrecy is a control (P-02).

## 8. Unverified assumptions — the prove-or-disprove list

Rev 2 carried six; E-62 closed the import question (as "undocumented — do
not use") and reopened its successor; rev 7's probes resolved items 1 and
8, rebuilt item 2 on E-57's collapse, and added 10–11. Current list
(numbering kept stable; resolved items are struck to the resolved
paragraph below):

1. **RESOLVED (rev 7, E-81) — the preserved `# --- Yours ---` section
   rides the documented whole-file re-injection.** The
   unscoped/path-scoped distinction is file-level; root `CLAUDE.md` is
   one injection unit, re-read from disk after compaction, and the CLI is
   blind to the section marker (whole-file injection observed live at
   v2.1.233). Step 1(f)'s gate is lifted; the mutate-and-compact probe
   survives as a post-step-5 canary because it is the one direct
   observation still unrun (E-81 carries that limit verbatim).
2. **The injection-vs-tools-only question has no evidence in either
   direction — rebuilt at rev 7 on E-57's collapse (E-79).** Rev 5
   scoped E-57's sign to the raw-fragment arm; rev 7 removed the sign
   entirely: the losing run is one paragraph of blog prose, unpublished,
   with a delta on the order of run-to-run noise, and E-69's config account is
   labelled interpretation. What survives as evidence is the positive
   half only (reflect-once beat vanilla 9/9, non-overlapping ranges —
   E-79), which supports Surfaces B/C, not the deletion of hardened
   injection. The **hardened-variant-vs-tools-only** comparison is
   unmeasured in any domain (P-14); the only path to measurement is a
   self-run harness arm (~$300 triplicate — the defensible minimum given
   the sd finding — ideally plus an arm shaped like our actual config,
   E-79). 6b therefore carries it as a per-agent judgment call, labelled
   as such. Rev 10 framing note: the *absence* of evidence now cuts
   against tools-only rather than for it — with no quality sign in
   either direction, the deterministic-mechanism rule and the
   comparators' verified premise ("models don't pull reliably") decide
   the default, so 6a is the end state and tools-only is the arm that
   must earn its way in (P1; the ~$0 live A/B named at 6b is the cheap
   first probe of that premise). The step-6 watch remains a
   gross-regression tripwire,
   structurally incapable of resolving an effect of this size (E-44;
   review M-2; E-79). Blast radius if wrong: steps 6a/6b only,
   flag-reversible.
2a. **Once-only orientation injection matches the vendor's *current*
   source, not their *benchmarked* configuration.** The winning arm
   re-injected the cached reflect synthesis **every turn** (blog prose,
   E-69 — the per-task published `context` fields confirm synthesized
   injection, E-79, though the per-turn cadence itself is prose); the
   once-only injection was a post-benchmark refinement whose comment
   ("random noise once the session drifts") is engineering judgement, not
   measurement (E-63, E-69). Rev 10, resolving the cadence probe's F5
   ("motivated residue — the half of the winning pattern that was kept
   is the half that fit the pull-shaped thesis"): the divergence is now
   **argued and priced in §2.2's re-injection bullet** rather than
   conceded here and left standing — per-session + per-compaction
   default (the compaction re-fire is new at rev 10, via the
   matcher-less SessionStart read, E-88), with the benchmarked
   per-N-turns cadence a first-class knob
   (`memory.orientation_reinject_turns`, default off, ~55M/30d nominal
   at every-turn — the price that justifies the default) and the step-7
   watch's late-session-context-loss signal as the named trigger for
   flipping it. The divergence stands, stated, not smoothed; this item
   stays open until a cadence arm is ever measured.
3. **`refresh_mental_model` cost, full and delta.** Never measured; E-28's
   two live-reflect runs are the only adjacent datum and the E-52 ceiling
   is far above them. §6's net-cost claim is explicitly conditional on
   step 1(e); step 7 is gated on it. Note 1(e) requires an operator
   approval card (mental-model writes are gated in this fleet).
4. **Retain quality is unaffected by removing injection.** Nothing in the
   ledger measures retain-side interaction with the injection change.
   Assumed independent; the step-6 tripwire watches for gross
   effects only.
5. **The orientation model's synthesis quality at our bank scale.** No
   published quality curve exists at ~265K facts / ~7.7M links (E-55), and
   reflect has no relevance floor (E-18) — a thin or drifted orientation
   model would mislead at session start. Mitigations in-design:
   operator-approved creation, 48h clear+refresh (E-50 item 7), the seeded
   `no-confabulation` guardrail applying at refresh time (E-27, §4.2),
   and the staleness guard (§2.2). Judged at step 7's staggered rollout.
6. **The rules budget suffices post-triage.** Unknown until step 4
   measures the always-on residue on overlord — which is exactly why the
   cap is set after triage, not before.
7. **SessionStart `additionalContext` carries the orientation read
   cleanly.** The mechanism is documented with no size cap (E-51), and
   rev 7 adds an empirical floor: `SessionStart:compact` injected a
   14.7KB payload in a live production session (E-81) — capacity is
   proven; only the specific orientation composition remains asserted
   rather than probed.
8. **RESOLVED (rev 7, E-82) — worker sub-agents do NOT see the
   `hindsight` MCP tools; the other types do, pinned to the parent's
   bank.** `worker.md`'s explicit `tools:` allowlist omits
   `mcp__hindsight__*` entirely; researcher/reviewer/general-purpose
   inherit the full surface, same bank as the parent (two independent
   code paths agree). The degraded path §8.8 predicted is the real one
   for workers — roster as prompt text, parent does the reads — unless
   the allowlist is amended (§10.6 W-6). A `SubagentStop` retain hook
   captures worker output regardless (text-only, volume-gated, tagged
   `sidechain`). **Rev 10 (E-86): the resolution was half the picture —
   auto-recall also never fires for a Task dispatch, so a worker has
   zero read path of any kind while still writing into the parent's
   bank. Promoted from a resolved footnote to a named defect with a
   specified fix (§2.6: read-only pull tools on the worker allowlist,
   dispatch-prompt pre-fetch discipline, the budget-footgun
   precondition).**
9. **Synthesis quality of repo pages over a commit-message corpus.** The
   vendor ships exactly this (E-77), but no quality measurement exists
   for it anywhere in the ledger, and reflect-class synthesis has no
   relevance floor (E-18) — and rev 7 sharpens the prior: the
   mission-prompt analysis predicts 3 of 5 page categories come back
   near-empty or wrong on a git-only seed (E-83). Now carries a designed
   measurement: the E-83 falsifying test **gates R1** (§10.6) — kill
   criterion and validation criterion both specified, scored against
   ground truth, not vibes.
10. **The self-built prefetch join behaves as specified under fast
   replies (rev 7, E-81).** Docs and binary agree on every element the
   step-6a spec composes (async detach, no native join, synchronous
   UserPromptSubmit blocking, sentinel-file persistence), but the
   two-turn live race probe is unrun (~5 min of operator time —
   confirmation, not open risk, per E-81). Two adjacent unknowns ride
   with it: `PostCompact` injection semantics (event exists at
   v2.1.233, output behaviour unverified — and, rev 10, E-88: nothing
   in the deployment wires `PreCompact`/`PostCompact` at all, so
   nothing rides on it today; Surface B's compaction re-seat uses the
   verified `SessionStart source=compact` path instead) and the async
   process's fate at session
   END (do not design a cross-restart dependency on it).
11. **Combined recall types hold up at production scale (rev 7, E-80;
   re-scoped rev 9 — E-70 REFUTED).** Combined types are not something
   step 6a ships: they are the deployed fleet default already, and E-80
   is a directional validation of that status quo (its "current config"
   arm was in fact the opt-out config — E-80's rev 9 note). The A/B is
   15 queries, 3 banks, one pass, single-rater, largest bank
   stats-only — suggestive, not conclusive, and the probe's own verdict
   ("should not ship without a larger run") now reads as: the larger run
   is owed as **due diligence on a default the fleet is already
   running**, not as a gate on a change. Two production-scale unknowns
   remain live: whether combined holds up beyond the sampled banks and
   query mix, and `prefer_observations`'s increment under combined
   types — which the A/B held at false but production runs at true, so
   the deployed configuration itself is the unmeasured arm.
12. **Whether OUR deployed engine auto-creates a bank on a write to a
   nonexistent one** *(added rev 11, E-89)*. openclaw relies on lazy
   creation — its plugin never checks bank existence and `createBank` is
   an upsert — but that is *their* deployment, not a measurement on
   ours, and the dynamic-banks probe was read-only, so it could not
   settle it: establishing the behaviour requires a write. What was
   verified read-only on 2026-08-16: `GET
   /v1/default/banks/<nonexistent>` answers 405 (no per-bank GET route),
   and the live bank list carries no probe artefacts. **The test that
   settles it:** `POST` a single `retain` (or a `recall`) against a
   throwaway bank name that does not exist, then `list_banks` and check
   whether the row appeared; delete it via `delete_bank` either way.
   One write, one list, one delete — operator-approved, sub-minute.
   **Why it matters here:** the answer decides whether an
   operator-granted bank name typo in W-2's grant set or §10.4's
   ingestion config fails loudly (404) or silently mints an empty bank
   that every subsequent read finds plausibly empty — which is a P7
   question, not a curiosity. Until measured, §10.4's seed step must
   treat bank creation as explicit (it already does — W-1 creates the
   bank) and no code may depend on lazy creation either way.

Resolved and absorbed (recorded so they aren't re-litigated): the full MCP
tool list — engine surface per E-59, agent-facing surface 37 tools per
E-73's correction (the shim adds five, including the page reads);
page-creation mechanics — pages are never projected from existing mental
models, and no page-write path exists on our rails today (E-74);
cross-bank reads — native via the `bank_id` tool argument, verified live
(E-75), with the deliberate exception that the three synthesized page
tools refuse any cross-bank access by coded design (E-82) — **a
shim-layer choice, not a platform limit: the engine's knowledge-base
REST routes are bank-parameterised on every path and the backend tools
already pass `bank_id` through (rev 11, E-95)**; fs-mount
viability — dead (E-60); reflect tunability —
no, architectural (E-61); `@path` import compaction behaviour —
undocumented, therefore unused (E-62); preserved-section compaction
survival — file-level, documented, whole-file injection observed live
(E-81; canary retained); the sub-agent Hindsight surface — split by type,
worker excluded, parent-bank-pinned otherwise, SubagentStop retain path
(E-82; rev 10 — completed by E-86 and promoted to the §2.6 named
defect: workers also get no injection, hence zero read path); the `enable_observations` key naming (E-82); E-69's losing-arm
configuration — permanently unverifiable from public sources, carried as
labelled interpretation (E-79); **build-vs-adopt against the
vendor's coding-agents package — evaluated at reference + source and
rejected, with the package's architecture standing as corroboration of
this design's shape (§0a, E-63..E-67, P-13 corrected)**; the
recall-vs-reflect verb split — vendor guidance read in full and it
supports the split including the cached-orientation move, with the
directive-enforcement coupling carried explicitly (E-68, §2.3);
Hindsight's LLM backend locality —
read from config (E-61): consolidation on a local litellm endpoint,
embeddings on local ONNX, reflect on the `claude-code` provider, which is
the invariant-sanctioned Claude path, not a third-party egress (C-02,
C-03).

## 9. Verdict check (four-part rule)

Run twice (rev 8): first over §§1–8, then over §10's repo-knowledge
build — rev 7's check predated §10 and asserted blanket compliance
("no pooling") that rev 7's own §10.2 had already carefully argued an
exception to; a verdict that contradicts its own document is worse than
no verdict.

**Over §§1–8:**

- **Advances a named outcome:** `standing-team` — memory that compounds
  and is inspectable. The cost claim in §6's register, not rev 4's: the
  measured ~49M/30d directive block is deleted outright, the recall
  block's unmeasured share **persists by design as the end state**
  (rev 10 — nominal ceiling ~164M at the deployed caps, roughly halved
  to ~75–90M by 6a's junk gate and budget convergence, §6; going to
  zero only per-agent at 6b, which is no longer the destination), and
  the net total is
  refused as a point estimate pending step 1(e)'s refresh-cost
  measurement (§6). The vendor's benchmarked reflect-arm pattern (E-79's
  replicated campaign) is served in adapted form within our invariants
  (E-61): per session start plus per compaction (rev 10, E-88's
  matcher-less re-fire) from a cache up to ~a day old, where the
  winning arm re-injected its cached synthesis every turn over the
  current bank (§2.2, §8.2a — divergences stated, priced, and carried
  as a first-class knob, not smoothed).
- **Satisfies the job spec (C-01):** corrections stick across compaction
  by construction on the documented reload surface (§4.4, confirmed at
  file level per E-81, with the step-1(f) canary riding behind); rules
  set once persist and never stop silently (block
  + announcement + archive + load canary + integrity check); unprompted
  relevance is carried by the cached orientation briefing (re-seated at
  every compaction, rev 10) plus, as the 6a end state, a
  comparator-shape hardened injection (observation-inclusive,
  off-path, capped into the comparator band, junk-gated) — dropped to
  tools-only per-agent only if evidence
  ever supports it, never asserted from a coding-benchmark anecdote
  (§5 6a/6b, §8.2, P-14, E-79); the user can inspect (plain block in
  a file they can read, transcript-visible pulls, recall_log, mutation
  log), correct (§2.4), and delete (retire verbs, reversible); no
  pooling of conversational or persona memory (P5) — §10's shared repo
  bank is the one deliberate exception, argued rather than asserted:
  single-writer by construction, identity-free repo knowledge only,
  never receiving conversational retains (§10.2), so no specialist's
  memory is conflated into a pool; no equal weighting (curated rules
  block vs ranked recall vs whole standing answers); and the design's
  own new failure modes fail loud (§2.1, §2.1a, §2.2).
- **Principle checks:** defaults improve with no operator action (steps
  1–3 alone save ~1KB/injection and add measurement); rides existing
  machinery (hooks, doctor, approval cards, cron, the preserved
  `CLAUDE.md` section, the mental-model approval flow).
- **Crosses no invariant:** unmodified `claude` CLI, no protocol
  interception, reflect stays on the `claude-code` provider precisely
  because the invariant pins it there (C-03, E-61); memory text stays
  on-box or on the sanctioned Claude path (C-02, E-61); retirement verbs
  reversible and announced; hard deletes stay gated; no new privileges
  (E-60's FUSE escalation refused; §2.1a adds a permission *deny*, not a
  grant).

**Over §10's repo-knowledge build (added rev 8):**

- **Advances a named outcome:** `standing-team` — repo understanding
  that compounds across agents instead of being re-derived per session.
  §10.7's build verdict is explicitly **conditional on the E-83
  falsifying test**; this check inherits that conditionality rather than
  upgrading it.
- **Satisfies the job spec (C-01):** the pooling never-ship is engaged
  head-on, not waved through — the shared bank is a conscious P5
  exception: one deterministic writer, identity-free content, agent
  conversational retains structurally excluded (`derive_bank_id` keeps
  resolving to the agent's own bank, E-78; §10.2). Failure is loud, not
  silent: dead-ingestion watermark doctor FAIL, `no_facts` alarm,
  `is_stale` surfaced as-is (§10.5, E-36). Inspectable and correctable:
  reads are agent-invoked, transcript-visible pulls; the write path is a
  deterministic pipeline whose inputs (git history) are themselves
  inspectable; hard deletes stay gated.
- **Principle checks:** rides existing machinery almost entirely — the
  shipped shim reads (E-73), engine-automatic refresh (E-76), cron and
  doctor; the new code is one gated CLI verb, one env-gated shim
  extension, and a cron script (§10.6). Defaults change nothing until an
  operator seeds a bank; reversible by deleting the bank.
- **Crosses no invariant:** no `claude -p` anywhere in the pipeline —
  the vendor's survey component is deliberately not rebuilt (§10.4);
  engine-side LLM work stays on the sanctioned providers (E-61,
  C-02/C-03); page authorship stays off the agent tool surface (W-1 is
  operator-side) and W-2 preserves the no-caller-*minted*-reach property
  (§10.2; sharpened rev 11 — the caller may select among operator-granted
  banks, ungranted ones are loud-rejected, and all three protections the
  shim's refusal existed for are preserved, E-95); the repo bank adds no
  new listener or privilege to the E-33
  surface, and §10.2's security honesty is carried, not laundered.

## 10. Repo knowledge — pages on a shared repo bank, composed with working memory (rev 6)

Operator question, verbatim: *"think about how we combine working agent
memory, but also leverage the knowledge pages for repos that agents work
on."* This section is the answer. It became designable at rev 6 because
E-73 corrected E-59: the three knowledge-page reads are already on every
agent's tool surface, so the read half of a repo-knowledge system costs
nothing to build. The write half is small and deterministic. The verdict
(§10.7) is **build it, narrowly and gated** — but one premise correction
first.

**Premise correction, against the probe that prompted this section.** The
shim's empty-tree message — "Pages are synthesized from mental models —
propose one to start it" — implies the pipeline *mental model → page*.
The engine says otherwise (E-74): a page is created only via
`POST .../knowledge-base/pages`, which mints its **own** backing mental
model; an approved `mental_model_propose` produces a bare model that
never appears in the tree and is invisible to page search. There is no
mental-model→page promotion path, and today there is **no page-write path
at all on switchroom rails** — `KnowledgeAdmin` is GET-only by
construction. So "leverage the knowledge pages" requires building the
authoring/ingestion side; only the reading side is free. The shim message
itself is filed as a fix (§10.6, W-4).

### 10.1 The two memory shapes, and why they must not share a store

- **Working memory** (everything in §§1–9): persona-scoped, born from
  conversation, one bank per agent (P5), identity-adjacent, curated
  through operator-gated writes. Its standing-answer primitive is the
  bare mental model (E-48's Q&A shape).
- **Repo knowledge**: durable architectural understanding of a codebase
  — components, conventions, decisions, initiatives. It is
  **identity-free and agent-independent** (klanker's understanding of the
  switchroom repo and overlord's should be the same document); it moves
  with commits, not conversations; and it is document-shaped, not
  Q&A-shaped — exactly the case E-48's choose-by-shape rule assigns to
  pages, and the case the vendor's own taxonomy targets (E-77).

Putting repo pages in each agent's bank fails on both economics and
correctness: N agents × the same 5 syntheses = N× the unmeasured refresh
cost, and N copies that drift apart with no reconciliation mechanism —
E-43's divergent-directive pathology reproduced at page scale. Repo
knowledge therefore lives in **one shared bank per repo** (e.g.
`repo-switchroom`, `repo-hindsight-memory`), and working memory stays
exactly as §§1–9 specify. Nothing in this section touches Surfaces A–D.

### 10.2 Why a shared bank does not reopen E-38 — the single-writer discipline

E-38's rejection of shared banks is specifically about **concurrent
writers asserting incompatible facts**: no contradiction detector, writer
identity stripped, silent arbitrary resolution. The repo bank is designed
so that case cannot arise:

1. **One writer: the ingestion pipeline** (§10.4) — deterministic retains
   of git history. A repo's history is a single time-ordered narrative,
   which is precisely the "later corrects earlier" case the engine's
   consolidation is actually written for (E-34). No agent's Stop-hook
   auto-retain ever points here (`derive_bank_id` keeps resolving to the
   agent's own bank — the same by-construction guarantee the
   shared-knowledge-banks RFC states, E-78).
2. **Agent writes, if ever enabled, go through E-78's explicit gated
   path** (`lesson_learned`-class verb with `author:<agent>` provenance
   tags, operator-declared write set, no `auto` expressible). Phase R1
   ships with agent writes **off**.
3. **Reads are unrestricted and free**: every agent reaches the repo bank
   today via the `bank_id` argument on `recall`/`reflect`/
   `get_mental_model` — verified live, zero new code (E-75), and the
   argument is on the shipped manifest for every backend tool
   (`FALLBACK_TOOL_TABLE`, `hindsight-mcp-shim.ts:190-222`, E-95), so
   dynamic cross-bank *recall* reach needs no code at all. The three
   page tools are the exception, and rev 7 sharpens what kind of
   exception (E-82): the shim's refusal of cross-bank page access is a
   **deliberate, coded design decision, not a small gap** — the tools'
   schemas omit `bank_id` on purpose and `synthesizedCall()` rejects it
   with an explicit message ("This tool always operates on your own
   memory bank; there is no way to target another agent's bank through
   it.", `hindsight-mcp-shim.ts:1401-1404`), with `KnowledgeAdmin`
   taking `bankId` only from constructor options. **Rev 11 correction to
   the layer this lives in (E-95):** it is *ours*, not a platform limit.
   The engine's knowledge-base REST routes are all
   `/v1/default/banks/{bank_id}/knowledge-base/...` (live `openapi.json`
   on the deployed engine, seven paths) and every documented SDK call
   passes a bank explicitly, so nothing upstream forbids what W-2 wants.
   §10.6 W-2 is therefore a *conscious relaxation of our own designed
   invariant*, and it must preserve the three things the refusal
   protects (E-95): no silent drop, the provenance-not-security
   boundary, and the retirement seam — never by reading the shim's pin
   as an engine capability gap.

**What the vendor does NOT say, recorded as a gap rather than as
agreement (rev 11, E-94).** Multi-writer bank semantics — what happens
when independent writers retain into one bank concurrently, whether page
refreshes serialize, any locking or race behaviour around a shared page
— and shared/team-bank pages are **not addressed anywhere in the vendor
docs**. The nearest documented behaviour is observation dedup within a
tag scope, which is a different question. So this subsection's argument
has no vendor position to defer to and must not be presented as
vendor-sanctioned: it stands on E-38 (the engine has no
concurrent-writer machinery) plus E-91 (neither does any comparator —
openclaw *avoids* concurrent writers by making banks smaller rather than
solving them, which is the same move made here, partitioned by repo
instead of by conversation). **The nearest thing to a vendor position,
found at rev 11 and stated for accuracy (E-96):** a how-to guide for
sharing one bank across several agents exists, and its entire answer to
shared-bank hygiene is a common retain *mission* — what gets written —
with nothing on what happens when two writers disagree. That is not a
position on E-38; it is the question left unanswered, which is why this
subsection excludes concurrency by construction instead of managing it.

Security honesty, restated rather than laundered: the pin and the write
discipline are provenance and hygiene, not security. The engine is
unauthenticated and fleet-open (E-33/E-33a); a shared repo bank adds no
new exposure to that surface and must never be argued to. A
prompt-injected agent could poison the repo bank by raw REST exactly as
it could poison any bank today; the mitigations remain the operator-level
network-isolation call (E-33a) plus E-78's poisoned-lesson analysis when
agent writes are considered.

### 10.3 The page set and the retrieval discipline (E-53 held)

**Pages.** The vendor's 5-page taxonomy is adopted nearly verbatim (E-77
— Component map, Core concepts, Conventions and patterns, Key decisions
and rationale, Initiatives and enhancements), seeded idempotently by
name, with the engine's page defaults (observation-only delta,
`refresh_after_consolidation`, 4096 tokens — E-76). Fact routing uses the
vendor's `entity_labels` mechanism (`knowledge:<tier>`, `tag: true`) —
pure bank config; the engine's extraction does the classification with
its existing local model (E-61), no client-side LLM (E-77). The page
count is deliberately fixed and small; per-initiative pages
(`captureInitiative`-class) are a later phase, not R1.

**Retrieval, tied to E-68's table.** E-53 stands in full: page search is
rerank-free — verified on the deployed engine (E-53 rev 9 note,
`memory_engine.py:13578`) — and being reachable (E-73) does not change
what it is. (The 6.7% R@1 figure is the recall pipeline measured with
the reranker off, not a benchmark of page search — an analogy for the
unreranked regime, per E-53's rev 9 note; the discipline holds on the
mechanism.) The discipline, extending §2.3:

| need | verb | why |
|---|---|---|
| "how is this repo put together / what are the conventions" | `get_knowledge_tree` (bank: repo) → `get_knowledge_page`, fetched whole | P4's document rule; the tree roster is tens of tokens, and at ≤10 pages browse beats search |
| locate a page in a grown tree (initiatives phase) | `search_knowledge_pages` | doc-level lookup is what an RRF-only path is for (E-53's own caveat); never fact lookup |
| a specific fact ("which PR changed X", "what did the CI trap turn out to be") | `recall(bank_id: repo-…)` | the reranked path (E-52); verified cross-bank live (E-75) |
| synthesis across the repo's history, user willing to wait | `reflect(bank_id: repo-…)` | E-61 latency, priced by the user; repo-bank directives apply (E-68 coupling) |

One rev-7 flag on the table above (E-83): on a git-only seed, three of
the five nodes — Component map, Core concepts, Conventions — are
predicted to come back near-empty or wrong (§10.4 point 4), so the
"how is this repo put together / what are the conventions" row must not
be presented as equally live across all 5 pages until the R1 gate test
(§10.6) reports.

**No page content is pushed per turn** — the vendor's own runtime calls
per-turn page injection "phantom research" (E-63). (Rev 10 scope note:
P1's every-turn end state is the *recall* block; it does not extend to
pages — pushed page content would be exactly the raw-document shape P1
keeps dead.) Two bounded index surfaces make pull informed rather than
hopeful (the MAJOR-3 pattern): the Surface-A knowledge-index block gains
one line per repo bank the agent is granted ("repo:switchroom pages —
`get_knowledge_tree`"), and **worker dispatch prompts carry the tree
roster** (titles only, tens of tokens) — the roster is the same
titles-only move the vendor re-injects every 10 turns (E-63). **Rev 7
correction (E-82): a `worker` sub-agent cannot call the page tools at
all** — its explicit `tools:` allowlist carries no `mcp__hindsight__*`
entry (researcher/reviewer/general-purpose inherit the full surface,
pinned to the parent's bank). So the roster is inert for a worker unless
either (a) the parent pre-fetches the relevant page content into the
dispatch prompt, or (b) the worker allowlist is amended to add the three
GET-only page tools — a one-line frontmatter edit, tracked as W-6 (rev
10: upgraded from optional and extended with the recall/mental-model
reads, per the §2.6 defect, E-86).
Until one of those lands, repo-page reads route through the parent or a
researcher, not the worker.

### 10.4 Build and refresh, with no `claude -p` anywhere

The pipeline, end to end — every LLM invocation is engine-side on
already-sanctioned providers (E-61: extraction/consolidation on local
litellm, reflect-class synthesis on `claude-code`; C-02/C-03 clean):

1. **Seed (operator-approved, once per repo):** create the bank, apply
   the `entity_labels` vocabulary + missions via `update_bank`, POST the
   5 pages. Runs as an operator-side switchroom CLI verb
   (`switchroom memory repo-bank create <repo>`-shape) — page authorship
   stays off the agent tool surface, preserving E-73's GET-only
   construction; gating class same as `mental_model_propose`.
2. **Ingest (cron, deterministic, client-LLM-free):** retain new commit
   messages since the last run, idempotent by `document_id: git:<sha>`
   (E-77's mechanism). Default is the cheap aggregate-gitlog mode
   ("orders of magnitude cheaper", E-77); per-commit full-diff ingestion
   is opt-in per repo. Optionally merged-PR titles/descriptions via `gh`
   — same shape. This is a `kind: action`-adjacent script cron, not an
   agent turn: zero subscription tokens client-side.
3. **Refresh (engine-automatic):** ingestion → consolidation →
   `refresh_after_consolidation` fires for pages whose scope is actually
   stale (E-76's tag prefilter + exact staleness check). No cron calls
   `refresh_mental_model` for repo pages at all; refresh frequency is
   bounded by ingestion cadence, and an idle repo costs zero.
4. **The vendor piece deliberately NOT rebuilt:** the codebase survey —
   the one `claude -p` component (E-77, E-66). Consequence, quantified at
   rev 7 (E-83) rather than merely stated: the cost is **not spread
   evenly across the 5 pages — it guts 3 of 5 categories.** Read off the
   vendor's own mission prompts: `GITLOG_MISSION` self-excludes the
   evidence a component map needs ("no diff… do NOT extract per-line
   code detail"), and the survey's four fixed documents map almost 1:1
   onto the three weak tiers. Only Initiatives is well-supported by
   commit messages; Decisions is partial (only messages that state
   rationale); Component map, Core concepts and Conventions are the
   categories the survey exists specifically to produce. Nor does
   consolidation rescue it: the consolidator only dedups and refines
   facts already extracted at retain time — "consolidation launders
   extraction quality, it doesn't add missing information" (E-83). The
   honest framing: git-only R1 ships an Initiatives page and a thin
   Decisions page, not a 5-page repo knowledge base — which is why the
   E-83 falsifying test gates R1 (§10.6). Partial cover: workers' design
   reports and RFCs can be retained into the repo bank through the
   pipeline (they are documents, not conversation — single-writer
   discipline holds). Full cover would need a sanctioned in-session
   survey: rev 7 names the mechanism — a dispatched sub-agent via the
   normal Agent tool doing the same read-only survey and retaining
   documents is a legitimate claude-native substitute for `survey.ts`
   (E-83), at **real subscription-token cost per repo and per re-run**,
   the one non-client-LLM-free piece of this section; if ever adopted it
   must keep the vendor's one-shot cold-start framing (triggered at
   bank-seed time, W-1) to avoid becoming a recurring cost center. Out
   of scope until the R1 evidence says pages earn it.

### 10.5 Staleness and failure visibility (P7 applied)

- `is_stale` on the tree is an approximation — False exact, True "may
  need refresh" (E-76) — and is surfaced to readers as-is by the shim.
- The failure that matters is a **dead ingestion cron**: pages freeze
  silently at the last consolidation — the §2.2 failure class exactly.
  Guard the same way: doctor compares the repo bank's newest `git:`
  document against the repo's actual HEAD (`git log -1` date vs bank
  watermark) and FAILs past 3× the ingest cadence; the discrepancy is a
  one-line visible notice, never silence (C-01).
- Zero-extraction retains (`no_facts`) on commit ingestion surface to
  doctor per Surface D's alarm (E-36) — commit messages are exactly the
  borderline-document case the vendor warns yields facts
  non-deterministically.

### 10.6 Work list — small, and mostly not code

- **W-1** Operator-side seed verb (bank + labels + 5 pages). New code,
  small, gated.
- **W-2** *(sharpened rev 11, E-89/E-95)* Shim: allow the three page
  tools to read **operator-granted extra banks**. The grant set is
  config — `HINDSIGHT_KNOWLEDGE_EXTRA_BANKS`-shape env from
  switchroom.yaml, rendered per agent at apply, threaded into
  `KnowledgeAdmin` alongside today's constructor `bankId`. The tools
  then accept an **optional bank selector validated against that set**,
  loud-rejecting anything outside it with the existing message shape.
  Rev 10 and earlier said "the grant is config, not a tool argument";
  that phrasing cannot serve an agent granted two repo banks, which has
  to be able to say *which one*. The corrected invariant is narrower and
  is the one that actually mattered: **a caller may SELECT among
  operator-granted banks; it can never MINT reach.** The relaxation
  preserves all three properties the refusal exists for (E-95),
  explicitly:
  1. **Anti-silent-drop** — an ungranted bank is still *rejected
     loudly*, never silently coerced to the agent's own bank, so no
     caller can believe it targeted a bank it did not.
  2. **The provenance-not-security boundary** — unchanged and still not
     claimed as security (the transport is unauthenticated; E-33/E-33a);
     what is preserved is that every page read attributable to an
     agent's tool surface hit a bank an operator granted it. Directive
     writes stay fully pinned — this relaxation touches the three
     GET-only page reads only.
  3. **The retirement seam** — `withSynthesizedTools()` still drops any
     same-named backend tool, so a future engine image registering real
     page tools reds the fixture test rather than silently widening the
     schema; the fixture snapshot must be updated deliberately for the
     new selector property.

  Layer note (E-95): this is a **shim** change and only a shim change —
  the engine's knowledge-base routes are already bank-parameterised
  (`/v1/default/banks/{bank_id}/knowledge-base/...`, live openapi) and
  cross-bank `recall`/`reflect`/`get_mental_model` needs zero code
  today. ~The one design-bearing code change.
- **W-3** Ingestion cron script + doctor recency check (§10.4–10.5).
- **W-4** Fix the shim's empty-tree message (E-74) — it names a pipeline
  that does not exist; have it name the real one ("pages are seeded and
  refreshed by the repo-knowledge pipeline / operator").
- **W-5** One line per granted repo bank in the Surface-A index block;
  tree roster in worker dispatch prompts (§10.3).
- **W-6** *(added rev 7, E-82; extended and upgraded from optional at
  rev 10, E-86 / §2.6)* Amend the `worker` sub-agent `tools:` allowlist
  to add the read-only memory surface: the three GET-only page tools
  PLUS `mcp__hindsight__recall` and `mcp__hindsight__get_mental_model`.
  One frontmatter line; deliberately reads-only (SubagentStop owns the
  write). No longer optional polish: E-86 established workers have zero
  memory read path while writing into the parent's bank — this is the
  fix's first half, with §2.6's dispatch-prompt discipline and
  budget-footgun precondition as the rest.

Phasing: **R1** = the switchroom repo only, reads-everywhere,
single-writer ingestion, agent writes off. **Two gates, both required:**

1. **Cost:** R1 ships only after step 1(e)'s refresh-cost probe reports
   (§8.3) — repo-page refresh is the same unmeasured
   `refresh_mental_model` quantity, and §6's refuse-the-point-estimate
   stance applies unchanged: client-side ingestion is ~zero subscription
   tokens, engine-side extraction is local-model wall-clock (E-17's
   single-accelerator queueing is the real constraint to watch), and
   synthesis is ~5 pages × (commits-driven refresh rate) × an unmeasured
   per-refresh cost on `claude-code`. The bounding knobs are ingest
   cadence and the fixed page count; no number is asserted until 1(e)
   reports.
2. **Quality — the E-83 falsifying test** *(added rev 7)*: run the
   git-log-only ingestion exactly as §10.4 step 2 specifies (last ~300
   commits, one aggregated `gitlog` document) into a scratch bank; apply
   `CODING_BANK_TEMPLATE` and seed the 5 pages as `seedPages()` does;
   let consolidation run; read all 5 pages; score 3–5 concrete
   new-contributor questions — one per weak category — against the
   answer a human who knows the repo would give (ground truth, not
   vibes). **Kill criterion:** Component map / Core concepts /
   Conventions come back empty, near-empty, or generically
   wrong/hallucinated → re-scope R1 to Initiatives + Decisions pages
   only, shipped explicitly labelled partial — not shipped as five live
   nodes of which three are hollow. **Proceed criterion:** Initiatives
   and Decisions genuinely useful (concrete, correct, citing real
   commits/PRs) → proceed as scoped, still labelled partial on the weak
   three. Test cost: one aggregated retain, engine-side consolidation, a
   read-and-score pass over 5 ≤4096-token pages; no survey needed.

**R2** (evidence-gated on R1 actually being read — the
shim's tool calls are transcript-visible and countable): second repo,
per-initiative pages, and E-78's explicit lesson-write path if the
operator wants agent-authored lessons.

### 10.7 Verdict, and what would have made it "don't build"

Build — because the expensive halves already exist: the read surface
shipped (E-73), the refresh machinery is engine-automatic (E-76), the
ingestion is deterministic scripts (E-77), and the bank-sharing shape has
a prior sanctioned design (E-78). What remains is one gated CLI verb, one
env-gated shim extension, and a cron. The answer would have been "don't
build" if any of: page reads still needed a new shim (they don't —
E-73); refresh required client-driven `claude -p` or per-page crons (it
doesn't — E-76); or the only bank topology were per-agent duplication or
an E-38-violating multi-writer pool (it isn't — §10.2). The honest
unknowns that could still kill it at the gate: refresh cost (§8.3) and
whether synthesis quality over commit-message corpora is worth reading —
both measured before R1 ships, neither assumed. Rev 7 sharpens the
second: the mission-prompt analysis (E-83) predicts the specific failure
shape — 3 of 5 pages hollow on a git-only seed — and §10.6 now carries
the falsifying test with named kill/proceed criteria, so "measured
before R1 ships" is a designed experiment, not a promise. E-83's own
verdict is carried honestly: worth-building is **undecidable without
that test** — this section's "build" verdict is conditional on it.
