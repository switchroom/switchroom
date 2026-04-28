---
name: humanizer-calibrate
version: 0.1.0
description: |
  Build a personal voice template for the humanizer skill from the user's
  recent Telegram messages. Reads the local message buffer, summarises
  vocabulary / sentence shape / formatting habits, writes a markdown
  template the humanizer will match against.
license: MIT
compatibility: claude-code
allowed-tools:
  - Read
  - Write
  - Edit
  - mcp__switchroom-telegram__get_recent_messages
  - mcp__hindsight__recall
---

# Humanizer voice calibration

Companion skill to `humanizer`. Generates a markdown voice template from
the user's actual Telegram writing so future humanizer passes match
their style instead of producing generically "human" prose.

## When to use

The user invokes you (`/humanizer-calibrate`) when:
- They want the humanizer to sound more like them
- They've just changed channels and want a fresh template
- Their previous template feels stale

You can also propose calibration if you notice the user pushing back on
humanizer output ("that doesn't sound like me").

## Output target

Write the voice template to the path in the env var
`HUMANIZER_VOICE_FILE` if set. Otherwise default to
`~/.switchroom/voice.md`.

If the file already exists, read it first, generate a new draft, and
present the user with a diff via the `Read` tool. Don't overwrite a
hand-edited template without showing the changes.

## Procedure

### 1. Gather a corpus

Use `mcp__switchroom-telegram__get_recent_messages` to fetch the most
recent N messages from the active chat (default N=200, adjust based on
the user's request). The buffer holds both inbound (user → bot) and
outbound (bot → user) messages.

You only want **inbound** messages — those are the user's own writing.
Outbound is the bot's voice and should be excluded.

Discard:
- Single-word acknowledgements: "ok", "thanks", "yep"
- Slash commands: `/queue ...`, `/q ...`, `/auth ...`
- Pure URLs / file paths with no surrounding text
- Forwarded content (often signalled by leading `>`)

You want at minimum 30 substantive inbound messages for a usable
template. If you don't have that many, tell the user and ask whether to
proceed anyway or wait.

### 2. Extract observable features

For each kept message, note:

- **Average sentence length** (words per sentence, mean + spread)
- **Vocabulary register** — formal / casual / technical / playful;
  pick adjectives that fit. Note signature phrases that recur.
- **Sentence-fragment frequency** — does the user often write fragments
  ("Done."  "Cool, that works.") or always complete sentences?
- **Em-dash density** — em-dashes per 100 words. Note if the user
  prefers `—` vs ` - ` vs `, `.
- **Bold/italic markdown use** — frequent? sparing? never?
- **Code-fence style** — backticks for filenames? fenced blocks for
  multi-line commands? plain text?
- **Capitalisation** — Sentence Case? lowercase? Title?
- **Punctuation density** — period at end of single-sentence message?
  trailing ellipses? exclamation marks?
- **Common openings / closings** — does the user start replies with
  "Yeah," or "Hmm," or skip a greeting? Sign off with "thx" or
  nothing?

### 3. Distil into a voice template

Write a markdown file that the humanizer will read alongside its
generic rules. Keep it under 2000 characters — it's a style brief, not
a corpus dump. Structure:

```markdown
# Voice template — <user-or-agent name>
*Calibrated from N inbound messages on <date>.*

## Sentence shape
- Average length: <N> words. Range: <min>-<max>.
- Fragment frequency: <often / sometimes / rare>.
- Em-dash density: <high / medium / low / never>.

## Register
<one paragraph describing tone, e.g. "Casual and direct. Drops
articles and uses lowercase 'i' in informal contexts. Comfortable
with technical jargon but rarely formal.">

## Habits
- Bold: <frequent / sparing / never>. <when>.
- Italic: <pattern>.
- Lists: <pattern>.
- Code: <inline backticks for filenames? fenced for commands?>.
- Capitalisation: <Sentence-Case / lowercase / mixed>.
- Punctuation: <pattern>.

## Signature phrases
- "<phrase>" — <when used>
- "<phrase>" — <when used>

## Counter-patterns (avoid these in humanized output)
- <thing the user never does, e.g. "Promotional adjectives like 'compelling', 'powerful'">
- <e.g. "Bold for emphasis on more than one phrase per paragraph">
```

### 4. Write and confirm

1. Determine the output path (`$HUMANIZER_VOICE_FILE` or
   `~/.switchroom/voice.md`).
2. If existing, read it first; show the user a brief diff of what
   changed.
3. Write the file.
4. Tell the user the path written and the corpus size used. Suggest
   they re-invoke after major writing-style shifts (new audience,
   new project, mood change).

## Notes

- This skill produces a **template**, not a model. The humanizer reads
  it as guidance. The user can hand-edit the template directly.
- Avoid storing actual message content in the template — store
  observed patterns. Templates may end up in version control.
- If the user has multiple agents, each can have its own
  `humanizer_voice_file` per-agent in switchroom.yaml, or share one
  via `defaults.humanizer_voice_file`.
