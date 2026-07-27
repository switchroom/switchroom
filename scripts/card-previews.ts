#!/usr/bin/env bun
/**
 * Card preview harness — renders EVERY status/progress card variant through the
 * REAL renderers (no mockups) and writes `card-previews.md`.
 *
 * Run: bun scripts/card-previews.ts > card-previews.md
 *
 * Not a test; not wired into CI. The fixtures live in
 * `telegram-plugin/tests/card-variants.ts` — the SAME catalogue the golden
 * suite (`telegram-plugin/tests/card-golden.test.ts`) pins byte-for-byte, so
 * this doc and the regression alarm can never drift apart.
 */
import { CARD_VARIANTS } from '../telegram-plugin/tests/card-variants.js'

// ── emit ───────────────────────────────────────────────────────────────────
const vis = (s: string): string =>
  s.replace(/\u2800/g, '\u2800').replace(/\u00A0/g, '\u00A0')

const now = new Date().toISOString()
let md = `# Switchroom status/progress card previews

Generated **verbatim** from the real renderers by \`scripts/card-previews.ts\`
(\`bun scripts/card-previews.ts\`). Nothing here is a mockup.

Generated: \`${now}\`
Branch: \`${process.env.PREVIEW_BRANCH ?? 'fix/3839-deindent-worker-card'}\`

## Reading these

Card bodies are **Telegram markdown**, sent verbatim by the gateway. Two
characters are invisible in the fenced blocks below:

- \`U+2800\` BRAILLE PATTERN BLANK — the indent glyph. It renders blank-width on
  a phone but is category **So**, not whitespace, so Telegram's parser cannot
  left-trim it. Three of them = one indent level.
- \`U+00A0\` NO-BREAK SPACE — the \`collapseSafe\` separator appended to every line
  so the card stays legible when Telegram's pinned bar collapses it to one line.

Lines are joined with a GFM hard break (\`  \\n\`).

## Verdict on centralisation

**Yes — one renderer.** Every variant below is composed by the single card
layout core, \`telegram-plugin/card-layout.ts\`: \`renderCardTitleLine\` +
\`metricsRun\` compose every header, \`emitSection\` draws every step block, and
\`fitCardToBudget\` is the ONLY char-budget enforcement. The 🤖 agent card, the
single-worker 🛠 card and the 2+ worker 🛠 WORKERS card are now three
\`CardSpec\` *configurations* of that core, not three implementations.

One deliberate exception: \`WORKER_CARD_SUPERSEDED_BODY\` stays a constant. It
carries no live state — no steps, no metrics, no window and no budget to
enforce — so there is nothing for a renderer to compute. Its title line is
composed by the shared \`renderCardTitleLine\`, so its chrome cannot drift from
the live cards.

Regression alarm: \`telegram-plugin/tests/card-golden.test.ts\` pins every
variant's exact bytes; \`telegram-plugin/tests/card-lifecycle-render.test.ts\`
drives the real feed manager through the full worker lifecycle and asserts the
text actually sent to Telegram.

---

`

md += '## Inventory\n\n'
md += '| # | Variant | Renderer | Shared layout core? |\n|---|---|---|---|\n'
CARD_VARIANTS.forEach((v, i) => {
  const shared = v.layout === 'constant' ? 'constant (title line shared)' : 'shared (`card-layout.ts`)'
  md += `| ${i + 1} | ${v.name} | \`${v.fn}\` | ${shared} |\n`
})
md += '\n---\n\n'

for (const v of CARD_VARIANTS) {
  md += `## ${v.name}\n\n`
  md += `**Renderer:** \`${v.fn}\`\n\n`
  md += `**When:** ${v.when}\n\n`
  md += '```\n' + vis(v.render() ?? '(null — renderer returned nothing)') + '\n```\n\n---\n\n'
}

process.stdout.write(md)
