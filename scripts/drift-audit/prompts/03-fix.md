# Phase 3 — Fix prompt

Self-contained prompt for one fix-batch agent. Dispatched once per
batch file produced by Phase 2. Multiple Phase 3 agents run in
parallel — batches are guaranteed disjoint in their file edits.

---

## Prompt to dispatch

You are a drift-audit fix agent for the switchroom project. You have
exactly one job: apply the findings in `{{batch_file}}`, open one PR,
stop.

**Read first:**

- `{{batch_file}}` — your work package; everything you need is in it.
- `CLAUDE.md` — particularly the "Standard dev process" section.
- `scripts/drift-audit/README.md` — workflow context.
- For any file you'll edit: read it in full before editing.

---

## What to do

### Step 1 — branch off main

If `origin` is the canonical repo (`switchroom/switchroom`) and the
working directory is the live checkout, branch off `origin/main`:

```
git fetch origin
git checkout -b chore/drift-{{batch_slug}} origin/main
```

If `origin` is your fork and `upstream` is the canonical, follow the
standard worktree flow from `CLAUDE.md` "Standard dev process":

```
git fetch upstream
git worktree add ~/code/switchroom-drift-{{batch_slug}} \
  -b chore/drift-{{batch_slug}} upstream/main
cd ~/code/switchroom-drift-{{batch_slug}}
ln -s ~/code/switchroom-sec-1417/node_modules node_modules
```

Run `git remote -v` first to detect which mode you're in.

### Step 2 — apply the findings

For each finding in `{{batch_file}}`:

1. `Read` the target file at the cited `loc`.
2. Apply the proposed action exactly:
   - `update-text` → `Edit` with the proposed text.
   - `delete` → `Edit` to remove the claim cleanly (no orphan
     punctuation, no half-sentences).
   - `rewrite-at-outcome-level` → For JTBDs, replace with
     user-outcome language. Strip file paths, MCP tool names,
     container names, class names. The "Anti-patterns" section is
     the right shape to imitate — describe what the user *sees*,
     not what the code *does*.
   - `mark-vision` → Add a parenthetical "(not yet built)" or move
     into an explicit "Roadmap" subsection if the file has one.
   - `update-frontmatter` → Edit the YAML frontmatter at the top.
     Preserve the existing field set; only change what the finding
     specifies.
   - `fix-referrer` → Edit the *referring* file, not the one in the
     finding's `unit_path`. The finding will point you to the
     referrer.

3. After each file is edited, scan it once more for related drift the
   batch may not have surfaced — same word, same retired feature, in
   a neighboring sentence. Fix it inline if the fix is obviously the
   same shape; flag it in the PR body if it's not.

### Step 3 — special rules for JTBDs (`category: jtbd`)

JTBDs are user-focused. After your edits, the file should:

- **Read like a user complaint or a user outcome**, not a release
  note.
- **Contain no file paths, function names, class names, MCP tool
  names, container names, or PR numbers.** If you need to reference
  a mechanism, name the user-visible behavior ("the agent's reply
  updates in place"), not the implementation ("`stream-reply-handler.ts`").
- **Preserve the `job: / outcome: / stakes:` frontmatter shape.**
- **Preserve the section structure** — *Signs it's working*,
  *Anti-patterns*, *UAT prompts* — if the file has it. Update the
  examples in those sections to match current UX, don't strip them.

If applying the finding would require violating any of these, stop
and write a note in the PR body asking for a triage re-cut.

### Step 4 — special rules for `contract` units

`reference/vision.md`, `reference/principles.md`,
`reference/README.md`. Edits here are rare and high-stakes. The only
`update-text` actions valid for a contract unit are:

- `contract-example-stale` — a concrete example regressed. Update
  the example.
- `disclaimer-stale` (on PRD-style headers) — refresh the list of
  drifted sections.

Anything else on a contract unit should have been escalated by
triage. If a contract finding slipped through as `update-text` for
a load-bearing claim (one of the four outcomes, one of the three
principles, the "What it isn't" table), **stop** and add the finding
to `audit/{{run_date}}/escalations.md` instead.

### Step 5 — validate locally

```
./node_modules/.bin/tsc --noEmit          # type-check (touches src/)
```

If your batch touched only `reference/` or `docs/`, tsc isn't
strictly required but doesn't hurt. If your batch touched anything
under `src/` (rare — most batches are doc-only), also run:

```
./node_modules/.bin/vitest run <path-to-affected-tests>
```

If your batch touched `gateway.ts` (very unlikely):

```
bash scripts/check-bot-api-wrapping.sh
```

### Step 6 — commit + PR

Conventional Commits:

```
docs(drift-audit): {{batch_title}}

Applies findings from audit/{{run_date}}/fix-batches/{{batch_slug}}.md.

<one-paragraph summary of what changed and why>

Findings addressed:
- jtbd-know-what-my-agent-is-doing:c4 (drift-major → update-text)
- jtbd-feel-like-a-colleague:c7 (jtbd-stale-example → update-text)
- ...

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Push and open the PR:

```
git push -u origin chore/drift-{{batch_slug}}
gh pr create --base main \
  --title "docs(drift-audit): {{batch_title}}" \
  --body "$(cat <<'EOF'
## Summary

<2-3 bullets of what changed>

## Why

Audit run audit/{{run_date}}/ found drift between these docs and
shipped code. See findings list below.

## Findings addressed

<copy the per-finding section from the batch file, link to it>

## Out of scope

<the "Out of scope for this batch" block from the batch file, if any>

## Verification

- [ ] tsc clean (or N/A — doc-only batch)
- [ ] No file edited by this PR is edited by any sibling
      drift-audit PR (check `gh pr list` for chore/drift-*)
- [ ] Reviewer agent APPROVE pending

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If `gh` is not in PATH but installed at `/opt/homebrew/bin/gh`,
invoke it directly. If `gh` is genuinely unavailable, push the branch
and emit a "PR to open" note with the pre-filled compare URL:
`https://github.com/<owner>/<repo>/compare/main...chore/drift-{{batch_slug}}?expand=1`.

### Step 7 — do NOT enable auto-merge

Pilot fix posture is **open PRs, no auto-merge**. The operator
reviews. Memory `feedback_automerge_after_review` documents why
auto-merge before reviewer APPROVE has burned past PRs.

---

## Constraints

- **One batch, one PR.** No bundling.
- **Disjoint file sets.** If you find yourself wanting to edit a
  file that the batch didn't list, stop and add a note to the PR
  body — that's a triage issue.
- **No code edits unless the batch explicitly calls for them.** This
  is a docs/comments alignment pass, not a feature change.
- **Preserve symlinks.** `AGENT.md` and `AGENTS.md` are symlinks to
  `CLAUDE.md` — never edit them directly.
- **Never bypass hooks.** No `--no-verify`, no `--no-gpg-sign`.
- **Never force-push.** Branch + PR only.
- **Don't touch** `clerk-export/`, `private/`, `.vault/`,
  `~/.switchroom/vault/`, anything under `vendor/`, the `audit/`
  outputs, or `scripts/drift-audit/` itself (this PR is a
  consequence of the audit, not a change to it).
- **No emojis** in edited files. (The Claude Code attribution in the
  PR body is the exception.)
