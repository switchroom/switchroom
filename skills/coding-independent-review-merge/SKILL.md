---
name: coding-independent-review-merge
description: "Use when a session opens, reviews or merges a PR. The author never merges."
---

# Independent review and merge

The default closeout for any source change. The agent that wrote the change never merges it.
A separate reviewer with no access to the author's reasoning reviews the exact head commit and
merges only when required checks on that commit are green.

## When to use

Load this whenever the session writes source, opens a pull request, is asked to review, or is
asked to merge. Skip it only when there is no repository change.

This skill takes precedence over generic merge recipes in other skills. A merge example in a
PR-workflow skill does not authorize the author to merge.

## Author

1. Implement, run the repository's tests, push the branch and open the PR.
2. Read back the PR URL, base branch and **exact head SHA**.
3. Do not merge: no `gh pr merge`, no auto-merge, no API merge.
4. Start the reviewer with a cold brief containing only:
   - repository
   - PR URL or branch name
   - exact head SHA (or the rule for finding it)
   - the original acceptance criteria
5. Do not pass your transcript, your reasoning, your test claims or a suggested verdict.
6. When the reviewer returns, do not merge. Report its verified result.

## Start the reviewer up front

If the author is itself a background job or delegated child, its completion may arrive in a
turn that cannot start new work. Avoid a stalled chain:

- Start the reviewer in the same turn as the implementer, briefed with the fixed branch name and
  acceptance criteria, and told to find the PR and review the exact head it records.
- For long or restart-sensitive work, use a durable task for the implementer with the review
  task as a dependent child, so review starts when implementation completes.
- When a review fails, make the fix and start the next reviewer in the same turn.

Never end a turn asking a person to send a message so review can begin.

## Reviewer

The reviewer starts with no author context and is read-only on the branch.

1. Fetch the PR yourself. Confirm the head SHA matches the brief. If it moved, stop.
2. Review the diff against the acceptance criteria. Do not trust the author's summary; run the
   tests yourself where you can.
3. Wait for required checks on that exact head. Pending is not green. Do not hold a worker in a
   `sleep` loop or a blocking watch call: where the repository allows auto-merge, arm it bound to
   the reviewed SHA once the review passes (`gh pr merge <url> --auto --match-head-commit <sha>
   --<method>`); inside a native task, park on CI with a `CI gate:` block (see
   `linear-work-tracking`) and continue from its verdict when the task resumes.
4. **PASS:** merge with the repository's required method (rebase, squash or merge commit, from
   repository settings or `AGENTS.md`), bound to the reviewed commit:

   ```bash
   gh pr merge 123 --repo example-org/example-repo --rebase --match-head-commit <reviewed-sha>
   ```

   Read back the merged state and the resulting base-branch SHA.
5. **FAIL:** do not merge. Return concrete, actionable required changes. The author fixes them
   and a new reviewer reviews the new SHA.

## Isolation

- A fresh delegated child or a separate durable task is the default isolation: new
  conversation, own terminal, no parent history.
- Do not use an in-session `/review` as the merge gate; its verdict lands back in the author's
  context.
- A new session of the same profile is acceptable as reviewer. Do not seed it with the author's
  memory or notes.
- A tracker issue or task card records the outcome; neither replaces this review.

## Never

- Merge your own change, or ask the reviewer to "just approve".
- Merge on failed or pending required checks.
- Rebase, force-push or edit the branch as the reviewer.
- Treat a green unit run as publication or deployment. Opened, merged, published and deployed
  are separate claims.
