---
name: dev-protocol
description: >
  Use when starting substantive development work — a code change, refactor,
  bug fix, infra change, or multi-step debugging task in any repo. Load BEFORE
  writing code: it is the fleet development protocol (orient/ground, clarify
  vs proceed, design-align on larger tasks, the branch→test→review→CI
  pipeline, communication rules). Also use when deciding whether a task needs
  a design report first, when dispatching an adversarial review of a diff, or
  when writing a re-review verdict. Do NOT use for: quick lookups, answering
  questions about code without changing it, or pure conversation.
---

# Development Protocol — the playbook

The always-loaded CLAUDE.md "Development Protocol" section is the summary.
This skill is the long-form procedure. Work through the five phases in order;
they are checkpoints, not vibes.

## 1. Orient — ground before you build

Before forming any theory or plan:

- **Read the real source.** The repo's source files at the current HEAD — not
  build artifacts (`dist/`, generated files, caches), not your memory of the
  code, not the task description's paraphrase. If a claim matters, open the
  file.
- **Verify the root cause, not the first plausible cause.** Reproduce or trace
  the failure to a specific mechanism before fixing. "This line looks wrong"
  is a lead; the fix ships only when you can say *why* it produced the
  observed symptom.
- **Report contradicting evidence.** If what you find contradicts the task
  description, the ticket, or your own working theory — say so explicitly and
  stop to re-plan. Never force-fit evidence to the plan you already had.
- **Cite everything.** Claims about the codebase carry `file:line`, commit
  hashes, or PR numbers. "The scaffold appends fragments at
  `src/agents/scaffold.ts:4113`" is a claim; "the scaffold appends fragments
  somewhere" is not.

## 2. Clarify vs proceed

- **Infer first.** Most questions are answerable from the codebase, git
  history, existing tests, or docs. Exhaust those before asking.
- **One question at a time.** If genuinely unsure after inferring, ask the
  single question whose answer unblocks the most work. Phrase it as a
  decision with a default: state what you found, the 2–3 viable options, which
  you'd pick and why, and ask for confirmation — e.g. *"The config loader
  supports both YAML and JSON overlays; the task says 'config file' without
  specifying. I'd extend the YAML path since all existing overlays are YAML
  (src/config/merge.ts:88) — confirm, or should JSON be covered too?"* Never
  send a questionnaire.
- **Phase discipline.** Clarify during *planning*. Once the plan is agreed,
  execute autonomously: make the reasonable call on small ambiguities, record
  the assumption in your report, and keep moving. Mid-execution questions are
  reserved for discoveries that invalidate the plan.

## 3. Design-align on larger tasks

**Classify the task first.** Treat it as "larger" (design-align before
implementing) when ANY of these hold:

- It changes a public interface, schema, config shape, or on-disk format.
- It cuts across 3+ modules or touches a load-bearing invariant.
- Two or more genuinely different approaches exist and the choice is
  expensive to reverse.
- The task description is a goal ("make X reliable") rather than a change
  ("add flag Y").
- It will land as more than one PR.

Small, single-concern, obvious-approach changes skip straight to phase 4.

For larger tasks:

1. **Design report before code.** Send the user an evidence-grounded report:
   what exists today (with citations), what will change, the chosen approach
   and its rejected alternatives, and the PR staging plan. Get alignment
   before implementation.
2. **Red-team your own plan adversarially.** Review the design item by item.
   Each item gets a verdict — `SOUND`, `RISK`, or `WRONG` — backed by
   evidence (a file you read, a test you ran, a documented behavior), not
   intuition. Fix every `WRONG` and address every `RISK` before starting.
3. **Stage delivery as focused single-concern PRs.** One concern per PR:
   reviewable in one sitting, revertable in one command. Never bundle a
   refactor with a behavior change.

## 4. Pipeline — how a change ships

1. **Branch off fresh main.** `git fetch && git checkout -b <branch> origin/main`.
2. **Implement with durable fixes.** Fix root causes. A workaround is
   acceptable only with an explicit reason stated and a follow-up filed.
   Prefer deterministic mechanisms (a check, a hook, a schema, a lint gate)
   over model-dependent behavior — if code can enforce the guarantee, don't
   leave it to prompt discipline.
3. **Tests assert outcomes.** Every test must fail if the bug it guards
   returns. A test that merely exercises the code path without asserting the
   observable outcome is not a test.
4. **Scoped tests + lint locally.** Run the test files covering what you
   touched, plus the repo's lint gate. Local runs are a fast filter; **CI is
   the full-suite authority** — never claim done off a local run alone.
5. **Adversarial review of the diff.** Dispatch a reviewer (sub-agent or
   fresh pass) with this structure:
   - Input: the full diff, the task statement, and the design report if one
     exists.
   - Charge: *find reasons this change is wrong* — correctness, missed edge
     cases, untested behavior, inconsistency with surrounding code, docs
     drift, security/data-loss risk.
   - Output: a findings list, each carrying an explicit severity field —
     `blocker` / `major` / `low`, one per finding, never omitted — plus the
     evidence (`file:line`) and a concrete fix. The severity field is what
     the merge gate reads, so an unlabelled finding is an invalid finding:
     send it back for a severity rather than guessing one. A structured
     findings tool (e.g. `ReportFindings`) already emits this shape; use it
     rather than inventing a parallel format.
6. **Severity gates the merge — mechanically.** Every `blocker` and `major`
   finding is fixed before merge; those are the gate. **Lows do not block:**
   fix a low inline only if it is a genuine one-liner, otherwise file it as a
   follow-up issue and merge. Filing is mandatory — a low is tracked, never
   waived. If a finding is genuinely invalid, rebut it with evidence in
   writing; silence is not a rebuttal. Review terminates here: a reviewer
   whose verdict is "mergeable, file the lows" is not talked into another
   round, by you or by itself.
7. **Re-review only a behavioural fix.** A fix commit confined to docs,
   comments, log strings, or tests does not earn another adversarial pass —
   read it and ship. When the fix changed behaviour, the re-review verdict
   must contain, per original finding: the finding ID, what changed
   (`file:line` of the fix), whether it fully resolves the finding
   (`RESOLVED` / `PARTIAL` / `REBUTTED` with evidence), and whether the fix
   introduced anything new. A bare "fixed" is not a verdict.
8. **Two rounds is the cap, and it is enforced outside your judgement.**
   Every commit answering a review round is subject-prefixed `review-fix:`
   (or carries a `Review-Round:` trailer). `scripts/check-review-rounds.mjs`
   counts them from git history and the `review-rounds` CI check fails a
   third round. There is exactly one way past it: an operator adds the
   `review-cap-override` label to the PR — a durable, visible artifact, not
   a re-run and not a self-persuaded exception. When you hit the cap, the
   correct move is the one the failure message names: file the remaining
   findings as follow-up issues and merge.
9. **Merge only on CI green.** No exceptions. A red or flaky CI run is a
   blocker to investigate, not to override.

## 5. Communicate while you work

- **Consolidated messages.** Batch related findings and results into one
  substantive update; never send five fragments where one message serves.
- **Always-visible progress.** Long-running work surfaces status the user can
  see (progress card, interim edit, explicit "still running: X"). Never go
  dark mid-task.
- **No foreground watches over 30 seconds.** Anything longer — builds, CI
  waits, deploys — runs in the background with a notification on completion.
  Don't block a turn polling.
- **Max 15 parallel sub-agents.** Fan out for genuinely parallel work
  (independent reviews, independent modules), but cap the swarm at 15.
