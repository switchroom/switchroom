# Weekly skill-synthesis cron prompt (#2670, one-tap self-improvement)

Serves the JTBD `reference/jobs/get-better-the-longer-they-run.md`
(invariants: `no-self-escalation`, `on-leash`): when an agent finds a path
it will reuse, that lesson should bind on every future run without
re-teaching — and the agent must **propose, never self-create** a new
skill.

This is the prompt body the operator drops into a weekly schedule entry in
`switchroom.yaml`. Recommended cadence: weekly, in the agent's full live
session (Tier 2), so the synthesis can read the agent's own existing skills
and reason over accumulated context.

```yaml
- cron: "0 9 * * 1"        # Mondays 09:00 (agent timezone)
  name: skill-synthesis
  context: agent            # FULL live session (Tier 2) — needs own context
  prompt: |
    <paste the SYNTHESIS PROMPT below>
```

The cron drafts ONE candidate (or zero) and surfaces it as a one-tap
Telegram Approve/Dismiss card via
`switchroom self-improve propose-skill`. It must **not** call
`skill_init_personal` / `skill_edit_personal` itself — the operator's tap
authorizes the write, which then runs through the secret-scanning personal-
skill pipeline.

---

## SYNTHESIS PROMPT

> It's the weekly skill-synthesis review. Your job: look at what you've done
> repeatedly across recent sessions and decide whether ONE reusable
> procedure deserves to become (or update) a personal skill. Then propose
> it for one-tap approval — do NOT create or edit the skill yourself.
>
> **1. Gather signal.** Use `mcp__hindsight__list_memories` (paginate) over
> `type="experience"` and `type="observation"` to enumerate what you've
> actually done. Use `recall` only as a secondary semantic pass — it's
> relevance-ranked and lossy for enumeration. Cap your working set.
>
> **2. Find a genuinely recurring procedure.** A candidate must:
> - recur across **at least 2 distinct sessions** (cluster on the session
>   retain tag; fall back to ≥2 distinct calendar days). A single long
>   session does NOT qualify.
> - have a **procedural shape**: ≥3 ordered steps you'd repeat unprompted,
>   not a one-off fact or preference.
> If nothing clears this bar, **stop — proposing nothing is the correct,
> successful outcome.** Do not manufacture a skill to have something to say.
>
> **3. Dedup.** Read your existing skills with `skill_list_personal` and
> `skill_search` (include shared + bundled). If the procedure is already
> well covered by a personal skill, propose an **edit** to it. If it's
> covered by a bundled/shared skill, propose **nothing** (or note that the
> operator could clone it). Only propose a NEW skill when nothing covers it.
>
> **4. Respect the cap.** You may hold at most 20 personal skills. If you're
> at the cap, only propose **edits** to existing skills, never a new one.
>
> **5. Draft the skill — and NEVER copy personal data, PII, or secrets.**
> Write a clean, generalized SKILL.md (plus optional `scripts/*.{sh,py}` /
> `reference/*.md`). **Never copy credentials, API keys, tokens, passwords,
> email addresses, phone numbers, names, or any other personal/PII data
> from your conversation history into the skill content.** A skill is a
> reusable *procedure*, not a transcript. Where a procedure needs a secret,
> reference it by its vault key name (e.g. `vault:service/key`) — never the
> value. Keep it to ONE procedure per skill.
>
> **6. Propose it (do NOT write it).** Save the drafted bundle to a temp
> JSON file mapping skill-relative paths to contents, e.g.:
> `{"SKILL.md": "...", "scripts/foo.sh": "..."}`, then run:
>
> ```
> switchroom self-improve propose-skill \
>   --slug <skill-slug> \
>   --lesson "<one-line lesson>" \
>   --evidence "seen across N sessions" \
>   --draft /tmp/skill-draft.json \
>   --chat <your chat id> \
>   [--edit]            # include only when updating an existing skill
> ```
>
> This posts a one-tap Approve/Dismiss card. On Approve, you'll receive a
> `skill_proposal_apply` turn telling you to write the stored draft via
> `skill_init_personal` / `skill_edit_personal` — at THAT point (and only
> then) you apply it. The operator's tap is the authorization; you never
> self-apply.
>
> If you proposed nothing, just note "no skill-worthy recurring procedure
> this week" and end the turn.
```
