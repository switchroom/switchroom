# Switchroom Diagrams — Unified Design System (v3)

All six explanatory diagrams — `deterministic-status-anatomy`,
`approval-grant-flow`, `wake-audit-lifecycle`,
`auth-broker-credential-plane`, `drive-write-approval`, and
`runtime-topology` — MUST share these recipes so they read as a set.
Each has a `<name>.spec.md` (authoritative) plus an authored source
artifact (a `.html` or a `.svg`); a raster export (`.png` at 2x, or a
legacy `.jpg`) is always derived from the source, never the source itself.

This guide has three parts, and they apply in order:

- **Part 1 — Comprehension first** (below): does the diagram make sense to a
  human who has never seen the system? This is the half that was missing in
  earlier versions. Diagrams that nailed the palette still "didn't make sense
  to a human" because nobody wrote down the reader's job. Do this first.
- **Part 2 — Production pipeline**: how a source file becomes a 2x PNG (the
  HTML → chromium method) and when to use HTML/CSS vs Eraser/SVG.
- **Part 3 — Visual recipe** (from `## Canvas` onward): the palette, cards,
  callouts, and typography that make the set read as one system. This half was
  already solid; keep it.

The reference implementation of this whole guide is
[`approval-grant-flow.html`](./approval-grant-flow.html) (rendered to
`approval-grant-flow.png`). When in doubt about how a rule lands, open it.

---

# Part 1 — Comprehension first

A diagram earns its place only if a newcomer walks away understanding one
thing. Beauty is table stakes; comprehension is the product. Work these rules
into the `.spec.md` *before* you draw.

## The one-idea rule

Write the single sentence a first-time reader should walk away with — **at the
top of the spec, before any node or edge**. If you can't state it in one
plain sentence, the diagram isn't ready to draw. Every element then either
serves that sentence or gets cut. Example (approval-grant-flow): "An agent
can't touch anything sensitive until you tap Allow."

## It must read as a story with no prior knowledge

- **One clear direction.** Left-to-right or top-down, never a scatter. The eye
  should start in one corner and finish in the opposite one.
- **Numbered beats.** Break the idea into 3–5 steps and number them (the brass
  → cord → teal callout roles carry the sequence). A reader should be able to
  read only the numbers and titles and still get the story.
- **A concrete, relatable example beats an abstract placeholder.** Show a real
  action — `deploy/config.yaml · replicas: 2 → 4` — not `<action>` or
  `<resource>`. Specifics let the reader picture themselves in the flow;
  placeholders make them decode a template.

## Put the human at the emotional centre

Where a person acts in the flow, make that the visual anchor — the phone with
the approval card, sized larger and given the focal treatment. The system
exists for the person; the diagram should feel that way. Machinery orbits the
human, not the reverse.

## Cut the jargon out of the primary read

- No internal component names, protocol terms, or mechanism words in the main
  labels (no "UDS IPC", "register-and-poll", "kernel decision store" up front).
- If a precise term matters for a technical reader, demote it to **one tiny
  secondary annotation** — never the headline, never a step title.
- The `.spec.md` still cites the real code in its "Source of truth in code"
  block. Rigor lives in the spec; the picture stays legible.

## Text discipline (comprehension layer)

- **Short labels: ≤5 words.** A step title is a title, not a sentence.
- **Sentence case on ALL text** — headings, subtitles, captions, chip labels,
  artefact strings: capital first letter, never all-lowercase. The single
  allowed exception is one uppercase, letterspaced kicker (e.g.
  `HOW APPROVALS WORK`).
- **No em-dashes** anywhere in diagram text (matches the repo voice). Use a
  period, a comma, or restructure.
- **One accent role-colour meaning per diagram.** Don't overload cord to mean
  both "warning" and "this step"; pick the meaning the story needs and hold it.
- **Icons carry meaning**, they don't decorate. A pause glyph on the pause
  step, a shield on the reassurance strip. If an icon doesn't add meaning, drop
  it.

---

# Part 2 — Production pipeline

Two sanctioned ways to author a diagram. Both produce a diffable text source
and a raster build artifact; both obey the Part 2 visual recipe below.

## Method A — HTML/CSS → 2x PNG (narrative diagrams)

Use for **story/narrative diagrams, custom layouts, hero panels, and
phone/card mocks** — anything where CSS flexbox, real rounded phone frames,
and free-form composition beat a node/edge grammar. `approval-grant-flow.html`
is the exemplar.

- **Author self-contained HTML/CSS.** Inline `<style>`, no external files. Use
  a **system-font fallback stack** (`'Inter', system-ui, -apple-system,
  'Segoe UI', sans-serif`) because the render host has **no network for web
  fonts** — the stack degrades gracefully to the system sans.
- **The HTML is the source of truth. The PNG is a build artifact** — re-render,
  never hand-edit the PNG.
- **Render at 2x with headless chromium.** Known-good binary on the fleet is
  the playwright chromium; discover it with:

  ```bash
  find / -path '*chromium*/chrome' -type f 2>/dev/null | head -1
  # e.g. /opt/playwright/browsers/chromium-1228/chrome-linux64/chrome
  ```

  Working invocation (what `scripts/render.sh` runs):

  ```bash
  "$CHROME" --headless --no-sandbox --disable-gpu \
    --force-device-scale-factor=2 --window-size=W,H \
    --screenshot=out.png "file:///abs/path/to/diagram.html"
  ```

  A 2x screenshot of a ~1200-wide canvas produces a **~2400px-wide PNG**. Set
  `W,H` to the `.stage` dimensions in the HTML (the exemplar is `1200x760`).

- **Use the helper.** [`scripts/render.sh`](./scripts/render.sh) takes an HTML
  path and an optional `WxH`, auto-discovers chromium, and writes `<name>.png`
  next to the source:

  ```bash
  docs/diagrams/scripts/render.sh docs/diagrams/approval-grant-flow.html 1200x760
  ```

## Method B — Eraser DSL / hand-authored SVG (node/edge diagrams)

Use for **pure node/edge flowcharts, sequence diagrams, and architecture
graphs** — where a deterministic graph grammar is the right tool and CSS
composition would be busywork. This is the existing `.svg` path documented in
"Source-of-truth & regeneration model" below.

## Which method when

| You are drawing… | Method |
|---|---|
| A story with numbered beats, a phone/card mock, a hero, a custom layout | **A — HTML/CSS → PNG** |
| A node/edge flow, a sequence, an architecture graph | **B — Eraser DSL / hand-SVG** |

Either way, the palette / card / callout / typography recipe in Part 3 governs
the visual layer, and the `.spec.md` remains authoritative.

---

# Part 3 — Visual recipe

## Canvas
- viewBox: `0 0 1200 800`
- Background: `#FAF7EF` (`--paper`)
- Inner padding: `48px` minimum on all edges
- Accent dots: 4× brass (`#E8B657`, r=4, opacity .55) at corners ~80px in;
  2× cord (`#C8302C`, r=3, opacity .5) at offset ~140px. Same coords across all three.

## Cards (the universal primitive)
- `rx = 14`, stroke `#EDE7D7` (`--bone-2`) `1.5px`, fill `#FFFFFF`
- Drop shadow filter `#cardShadow`: `dx=0 dy=6 stdDeviation=10 flood=#14171C opacity=0.18`
- Slight rotation per card: `-1.2°` for primary / focal, `+0.8°` for secondary,
  `-0.6°` for tertiary. Never axis-aligned.
- Dark-card exception (progress-card mock only): fill `#14171C`, otherwise identical
  recipe (same rx, same shadow, same rotation). It's a "guest" card on the light canvas.

## Numbered callouts
- Circle r=16 (32px diameter), `1.5px` stroke matching fill role
- Number font: Inter 700 13px, fill `#FAF7EF`
- Roles (strict):
  - **Brass** `#E8B657` fill = sequence step / numeric label
  - **Teal** `#4A9B8E` fill = success / grant / done
  - **Cord** `#C8302C` fill = pause / wait / warning

## Connecting lines
- **Primary flow arrow:** solid curved `#C8302C` (cord) `2.5px`, round caps,
  arrowhead `marker-end="url(#arrowCord)"`
- **Leader line (callout → label):** dotted `#8A8F98` (ink-300) `1.4px`,
  `stroke-dasharray="2 4"`, no arrowhead

## Icons
- One family: outlined, `1.5px` stroke `#23282F` (ink-700), round caps/joins, no fill.
- Sized at 20×20 inside a 24×24 box.

## Typography (one stack)
- Stack: `'Inter', system-ui, -apple-system, sans-serif`
- Mono (only inside card mocks): `'JetBrains Mono', ui-monospace, monospace`
- Sizes: heading `18px/700`, body `14px/500`, caption `11px/500 italic`
- Body fill `#23282F`, caption fill `#5A6069` (ink-400)

## Palette (exhaustive — no others)
`--paper #FAF7EF`, `--bone #F5F1E8`, `--bone-2 #EDE7D7`,
`--ink-900 #0E1013`, `--ink-700 #23282F`, `--ink-400 #5A6069`,
`--ink-300 #8A8F98`, `--ink-200 #B8BCC3`,
`--brass #E8B657`, `--brass-deep #B8873A`,
`--cord #C8302C`, `--teal #4A9B8E`. No gradients. No invented hues.

## Source-of-truth & regeneration model

A flattened `.jpg` is **not** a source. It can't be diffed in review and
can't be regenerated without re-illustrating from scratch. Every diagram
therefore has up to three artifacts, with strict precedence:

1. **`<name>.spec.md`** — the regeneration contract (authoritative).
   Headline/footer copy, node list, edge list, callout table, and a
   **"Source of truth in code"** block citing `file:line` so the diagram
   can be rebuilt and re-verified against the implementation, not against
   prose docs (RFC drafts and the CLAUDE.md ASCII drift; code does not).
2. **`<name>.html` OR `<name>.svg`** — the authored source (Method A or
   Method B from Part 2). MUST conform to the visual recipe above (canvas,
   cards, callouts, palette). Both are diffable text; the `.svg` also renders
   inline on GitHub. This is what a regeneration produces and edits.
3. **`<name>.png` (or a legacy `<name>.jpg`)** — the raster build artifact for
   docs/social embeds. A `.png` is produced from the `.html` via
   `scripts/render.sh` at 2x; a `.jpg` is derived from the `.svg`. Never
   hand-edited, never the source.

**Correctness rule:** a diagram is correct iff its `.spec.md` matches the
cited code *and* its source (`.html`/`.svg`) matches the spec. Review checks
the spec against `file:line`, not the picture by eye. When code moves, update
the spec first; the source and its raster are regenerated to follow it.

**Spec skeleton** (every `<name>.spec.md` follows this):

```
# <name> — diagram spec
Status: current | needs-revision | new
Source of truth in code: <file:line>, <file:line> …
Headline: "<top copy>"
Footer:   "<bottom copy>"

## Nodes
- id · label · sub-label · role-color (brass|teal|cord|dark|plain)

## Edges
- from → to · label · kind (primary-flow | leader)

## Callouts        (anatomy diagrams only)
- n · target · text

## Style notes
Inherits the v3 recipe above. Note any sanctioned deviation here.
```
