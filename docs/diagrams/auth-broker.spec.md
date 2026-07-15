# auth-broker — diagram spec

Status: new

**One idea (comprehension-first):** Your agents ride your existing Claude
subscription. No API keys, no second bill — the auth broker keeps one login,
hands it to every agent, and fails over when a credential is spent.

**Source of truth = `auth-broker.html`** (Method A, HTML/CSS → 2x PNG;
see DESIGN.md Part 2). The `.html` is authored and diffable; regenerate the
raster with
`docs/diagrams/scripts/render.sh docs/diagrams/auth-broker.html 1200x760`
(writes `auth-broker.png` at 2x, 2400×1520). This is the newcomer-facing,
one-concept companion to the mechanism-level `auth-broker-credential-plane`.

Source of truth in code:
- `src/auth/broker/server.ts:1-14` — sole writer of per-agent
  `<agentDir>/.claude/.credentials.json`; path-as-identity.
- `src/agents/compose.ts:978` — `switchroom-auth-broker:` root singleton
  service; owns the OAuth refresh loop, holds fleet-wide `auth.active`.
- `src/auth/broker/anthropic-provider.ts`, `google-provider.ts` — refresh-loop
  owners; the credential set the broker fails over across.
- `reference/rfcs/auth-broker.md` — design intent (RFC = intent; citations
  above are the shipped contract).

Headline: "Your agents ride your existing Claude subscription."
Footer:   "No API keys. No second bill."

## Nodes

1. `your agents` · klanker, worker, researcher — each needs a Claude login ·
   dark card · brass step
2. `auth broker` · one keeper of your Claude credentials, shared to every
   agent on demand · focal brass card · brass step
3. `failover + usage` · one credential rate-limited/spent, switches to the
   next active one, watches usage · cord dot marks the spent credential ·
   brass step (red reserved for the spent-credential warning only)
4. `your Claude Pro/Max` · the plan you already pay for; no keys to mint, no
   separate invoice · brass-filled done card

## Edges

- 1 → 2 · agents → broker: need a login · primary-flow (brass)
- 2 → 3 · broker selects/refreshes credentials · primary-flow (brass)
- 3 → 4 · resolves to your own subscription · primary-flow (brass)

## Style notes

Inherits v3. Success/done role = solid brass fill with a charcoal glyph (the
"brass-filled check"), replacing the retired off-brand teal. Red (cord) is
used once, on the spent/rate-limited credential chip, as a warning — not on
any step badge. Mirror the broker-card treatment of
`auth-broker-credential-plane` and `runtime-topology` so the auth singleton
reads as the same brass-highlighted component across the set.
