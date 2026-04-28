# Vendored from blader/humanizer

Source: https://github.com/blader/humanizer
License: MIT (see LICENSE in this directory)
Pinned to commit: 8b3a17889fbf12bedae20974a3c9f9de746ed754

## Why vendored

The humanizer skill ships with switchroom by default so agents can scrub
AI-writing patterns out of replies before they reach Telegram. Vendoring
keeps the skill content available without an extra clone step at install
time.

## Switchroom additions

The vendored SKILL.md is unmodified upstream content. Switchroom-specific
augmentations live elsewhere:

- `skills/humanizer-calibrate/` — companion skill that builds a per-user
  voice template from the local Telegram message buffer.
- `defaults.humanizer_voice_file` (yaml) — points the humanizer at a
  voice template for personalised matching.
- `profiles/_shared/telegram-style.md.hbs` — agent-side guidance to
  invoke the skill before each reply.

## Resyncing

To pull a newer upstream:

```bash
gh api -H "Accept: application/vnd.github.raw" \
  /repos/blader/humanizer/contents/SKILL.md > skills/humanizer/SKILL.md
gh api /repos/blader/humanizer/commits/main --jq '.sha'   # update VENDORED.md
```

Review the diff before committing — upstream changes may interact with
switchroom's voice-file augmentation (currently overlaid via the
calibrate skill, not via SKILL.md edits).
