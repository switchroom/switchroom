# Weekly failure-synthesis cron prompt (one-tap self-improvement, RFC §"failure synthesis")

Serves the JTBD `reference/jobs/get-better-the-longer-they-run.md`
(invariants: `no-self-escalation`, `on-leash`): when an agent keeps hitting
the SAME failure across runs, that lesson should bind on every future run
without re-teaching — and the agent must **propose, never self-create** the
fix. This is the failure-driven sibling of
`reference/prompts/skill-synthesis-cron.md`: skill-synthesis mines what
*worked* and generalizes it; failure-synthesis mines what *broke* and
proposes the smallest durable defense.

This is the prompt body the operator drops into a weekly schedule entry in
`switchroom.yaml`. Recommended cadence: weekly, in the agent's full live
session (Tier 2), **offset from the skill-synthesis cron** so the two
syntheses don't stack in one wake. Cadence and token budget are an
**operator decision** — see `docs/scheduling.md` for the recommended default
(one candidate proposal + one grader run per week) and how to add/tune the
schedule entry.

```yaml
- cron: "0 9 * * 4"        # Thursdays 09:00 (agent timezone) — offset from skill-synthesis (Mon)
  name: failure-synthesis
  context: agent            # FULL live session (Tier 2) — needs own context
  prompt: |
    <paste the SYNTHESIS PROMPT below>
```

The cron drafts AT MOST ONE candidate (or zero) and surfaces it as a one-tap
Telegram Approve/Dismiss card via `switchroom self-improve propose-skill`.
Each proposal ships with 1–3 regression eval cases routed through
`switchroom self-improve add-eval-case` — a one-tap, PII-scanned,
propose-only path that appends to the skill's `evals/evals.json` only after
the operator tap (invariants I1/I4). It must **never** call
`skill_init_personal` / `skill_edit_personal` itself, and **never** write
`evals/evals.json` directly — the operator's tap authorizes every write,
which then runs through the secret-scanning personal-skill / eval-case
pipeline.

**Create/update parity (invariant I6).** A recurring failure whose fix
belongs in a skill the agent already owns becomes a skill-**EDIT** proposal.
A recurring failure with **no** existing home skill becomes a **NEW** personal
skill: the proposal carries `is_new` and rides the existing
`proposalKind: "synthesized-personal-skill"` T2 carve-out
(`src/self-improve/tier-router.ts`), and its provenance is
`origin: "failure-synthesis"` (`SkillProposal.origin` in
`src/self-improve/skill-proposals.ts`). The carve-out means one tap into the
agent's OWN reversible workspace — NOT a T3 explicit-ask — while the hard-T3
floors (new cron / cross-agent / irreversible) stay untouched. A dismissed
proposal is fingerprinted and suppressed for 90 days
(`REJECTION_TTL_MS` / `isSuppressed`) so the same failure isn't re-proposed
every week.

**Non-interactive fire (cron), degrade gracefully.** This cron fires without
an operator in the loop (`meta.source="cron"`). If a Hindsight recall, a
transcript read, or a vault-backed step is unavailable (missing grant, PII
scan tripping fail-closed), do **not** spam approval cards into an empty
topic: note the gap in your output, skip that candidate, and continue. The
operator sees the gap on the next interactive turn and can grant access then.

---

## SYNTHESIS PROMPT

> It's the weekly failure-synthesis review. Your job: find the ONE failure
> you keep repeating across recent sessions and propose the smallest durable
> defense — a skill EDIT if you own a skill that should have prevented it, or
> a NEW personal skill if nothing covers it. Then propose it for one-tap
> approval, with 1–3 regression eval cases — do NOT create, edit, or write
> anything yourself.
>
> **1. Gather failure signal — cheapest source FIRST.** Start with your
> `self-improve:correction`-tagged memories: run `recall` (and, for
> enumeration, `mcp__hindsight__list_memories`) scoped to that tag. These are
> the corrections the self-improve gate already distilled — mining them is
> cheap and precise. Only AFTER you have a cluster, open the **implicated**
> on-disk Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) to read
> "why did it fail" for those specific sessions — and bound it to the **N
> most recent sessions** (default N=8). Never scan the full transcript
> history; the tagged memories are the index, the transcripts are the
> targeted lookup.
>
> **2. Cluster genuinely recurring failures.** A candidate must recur across
> **at least 2 distinct sessions** (cluster on the session retain tag; fall
> back to ≥2 distinct calendar days). A single session that failed once does
> NOT qualify — a one-off is noise, not a pattern. If nothing clears this
> bar, **stop — proposing nothing is the correct, successful outcome.** Do
> not manufacture a failure to have something to say.
>
> **3. Decide EDIT vs NEW (create/update parity).** Read your existing skills
> with `skill_list_personal` and `skill_search` (include shared + bundled).
> - If a skill you **own** should have prevented the failure, propose an
>   **EDIT** to it (`--edit`).
> - If a **bundled/shared** skill covers the area, propose **nothing** (note
>   the operator could clone it to make it editable).
> - If **nothing** covers the failure, propose a **NEW** personal skill. This
>   is a `failure-synthesis`-origin, `synthesized-personal-skill` proposal: it
>   rides the same one-tap T2 carve-out as skill-synthesis (one tap into your
>   own reversible workspace), so routing is unchanged — only the provenance
>   differs.
>
> **4. Respect the caps and the suppression window.** You may hold at most 20
> personal skills — if you're at the cap, only propose **edits**, never a new
> one. If this exact failure was proposed and **dismissed** within the last
> 90 days, it is suppressed — do not re-propose it (a genuinely improved
> redraft for the same slug may still surface; a re-run of the same draft
> will not).
>
> **5. Draft the fix — and NEVER copy personal data, PII, or secrets.**
> Write a clean, generalized SKILL.md edit or new bundle (plus optional
> `scripts/*.{sh,py}` / `reference/*.md`). **Never copy credentials, API
> keys, tokens, passwords, email addresses, phone numbers, names, or any
> other personal/PII data from your conversation history into the skill
> content.** A skill is a reusable *procedure*, not a transcript. Where a
> procedure needs a secret, reference it by its vault key name (e.g.
> `vault:service/key`) — never the value. Keep it to ONE procedure per skill.
>
> **6. Propose the skill (do NOT write it).** Save the drafted bundle to a
> temp JSON file mapping skill-relative paths to contents, e.g.:
> `{"SKILL.md": "...", "scripts/foo.sh": "..."}`, then run:
>
> ```
> switchroom self-improve propose-skill \
>   --slug <skill-slug> \
>   --lesson "<one-line lesson — the failure this defends against>" \
>   --evidence "failed across N sessions" \
>   --draft /tmp/failure-skill-draft.json \
>   --chat <your chat id> \
>   [--edit]            # include ONLY when editing an existing owned skill;
>                       # omit for a NEW skill (is_new) — it rides the
>                       # synthesized-personal-skill T2 carve-out
> ```
>
> This posts a one-tap Approve/Dismiss card. On Approve, you'll receive a
> `skill_proposal_apply` turn telling you to write the stored draft via
> `skill_init_personal` / `skill_edit_personal` — at THAT point (and only
> then) you apply it. The operator's tap is the authorization; you never
> self-apply.
>
> **7. Pin the failure as a regression eval case (1–3, propose-only).** A
> skill edit that doesn't defend against the failure can silently reintroduce
> it. So for the SAME slug, turn the failure into 1–3 regression tests — each
> the failing prompt phrased as a test — via the propose-only, PII-scanned
> path:
>
> ```
> switchroom self-improve add-eval-case --skill <slug> \
>   --prompt "<the failure, phrased as a test prompt>" \
>   --chat <your chat id>
> ```
>
> This writes **nothing** to the skill. It validates, dedups, and runs a
> deterministic PII/secret scan **fail-closed**, then posts a one-tap card;
> on Approve the gateway runs the deterministic `apply-eval-case` applier (no
> model turn) and appends the case byte-exact to `evals/evals.json`. **Never**
> edit or `Write` `evals/evals.json` yourself — an always-on hook hard-blocks
> a raw model write to it. Once a case exists, the apply-guard eval gate
> blocks any future edit whose pass-rate regresses below the floor — the
> failure now defends itself.
>
> **8. NEVER directive-first.** A failure earns a *skill* (edit or new) plus
> *eval cases* — a durable, testable, reversible artifact — not a standing
> directive. Directives are for judgment rules code can't enforce; a
> recurring failure with a reproducible fix is exactly what code (a skill +
> its eval gate) should enforce deterministically. Do not resolve a
> failure-synthesis finding by proposing a directive.
>
> If nothing clears the ≥2-session bar, just note "no recurring failure
> worth a durable fix this week" and end the turn. Emit **at most one**
> skill proposal per run.
