# Linear Markdown for the human record

People read the issue, not the chat thread. Formatting is part of the payload.

## Before sending

- Short sentences, headings, bullets and checklists where they help scanning. A one-line update
  is fine; do not pad it with empty headings.
- Send real newlines, not literal `\n` text, HTML or an escaped Markdown document. Put a blank
  line between headings, paragraphs and lists.
- Lead with current state and what remains. Keep logs and debugging off the first screen.
- Read back the target after delivery. Linear may normalize bullets and heading spacing; check
  that text, checklists, code and links survived.

## Issue description

```markdown
### Outcome
Publish the weekly inventory report for the example warehouse.

### Current status
- The export job runs nightly.
- The report template is reviewed.

### Remaining
- [ ] Wire the report into the shared drive.
- [ ] Confirm the first scheduled run.

### Acceptance
- [ ] Last week's report is readable by the team.
```

This is a formatting example only. "Job installed" is a setup milestone, not the outcome.

## Progress comment

```markdown
### Progress
- Verified milestone, with an evidence link.

### Remaining
- [ ] Outstanding outcome or dependency.

### Next action
- What happens next.
```

Add `### Blocker` only for a real blocker, naming the exact decision or access needed and who
must provide it. Waiting on an external reply is not waiting on a person.

## Closing note

```markdown
### Delivered
- What changed, with a PR or check link.

### Evidence
- What the checks proved.

### Remaining
- Nothing.
```

## Content actions

Inspect the deployed tool schema; source changes do not appear in a running gateway.

- A description update replaces the whole description. Read it first, preserve the human's
  scope and acceptance, and pass the expected previous text where the action supports it. If
  the guard or readback fails, reconcile instead of retrying blindly.
- A comment is a non-terminal progress update. Reuse the same stable request ID when
  reconciling a lost reply. A comment must not start an executor.

## Syntax that works

- `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``
- `#` to `####` headings; `-` bullets (Linear rewrites `*` to `-`); `1.` numbered lists
- `- [ ]` and `- [x]` checklists
- `[label](https://example.com)` links, `>` quotes, fenced code with a language tag
- Mermaid fences and GitHub-style tables
- Collapsible sections in API comments: `+++ Title`, the body, then `+++` on its own line

Official references: [editor](https://linear.app/docs/editor) and
[API](https://linear.app/developers/graphql).

Mentions through the API need the full Linear URL of the issue, user or agent; a bare `@name`
does not mention anyone. Do not invent upload URLs or embed local files; link a PR or check
instead.

## Avoid

- Slack-style `*bold*` (renders as italic)
- ALL-CAPS labels and one-line status walls
- HTML tags
- Pasting a chat answer unchanged
