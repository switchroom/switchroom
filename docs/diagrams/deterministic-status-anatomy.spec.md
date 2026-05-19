# deterministic-status-anatomy — diagram spec

Status: new
(Supersedes the retired `progress-card-anatomy` spec/SVG/JPG. The
pinned progress card no longer exists: `unpinProgressCardForChat` is
hard-wired `null` in the gateway. The current UX is a deterministic,
never-silent status surface, posted and edited in the topic, never
pinned. Regenerate the SVG/JPG from this spec.)

Source of truth in code:
- `telegram-plugin/idle-footer.ts:52` — `formatIdleFooter()`; the three
  honest states: `🟡 quiet · no turns yet` / `⚙️ working since <ago>` /
  `🟢 idle · last reply <ago>` (`:53`, `:61`, `:64`); `formatAgo` buckets
  `<1m/Nm/Nh/Nd ago` (`:32-42`)
- `telegram-plugin/card-format.ts:39` — `formatDuration`: `<n>ms` sub-second,
  else `MM:SS`, cap `99:59` (NOT "12s"/"4s")
- `telegram-plugin/fleet-state.ts:157` — `cap(members, n=5)`: ≤5 visible
  fleet rows, remainder as a hidden count
- `telegram-plugin/fleet-state.ts:179` — `sanitiseToolArg`: path-bearing
  tools → basename only; Bash/URL → token-shaped substrings `[redacted]`;
  hard cap 120 chars (`:22` statuses running/background/done/failed/stuck)
- `telegram-plugin/gateway/gateway.ts:2419` — `unpinProgressCardForChat
  = null` (the pinned-card lifecycle is retired by construction)
- `telegram-plugin/stream-reply-handler.ts:512` — `throttleMs ?? 600`
  (status edits land ~1/sec, not one delayed dump)
- `telegram-plugin/steering.ts:56` — `parseSteerPrefix`; the persistent
  Steer affordance on a long-running turn

Headline: "Never a black box. Never silent. Never pinned."
Footer:   "Deterministic status: you always know the state and what it is waiting on."

## Nodes

- One dark card (the v3 dark-card exception, `#14171C`, focal `-1.2°`)
  rendering the live working state, top to bottom:
  - quoted user message (reply style): "refactor the auth module to use JWT"
  - header row: `⚙️ Working…  ·  00:12` (phase + `MM:SS` elapsed)
  - streamed tool rows: `✅ Read session.ts` · `✅ Grep "cookie"` ·
    `🔵 Edit jwt.ts  ·  00:04` (in-flight row bold, `MM:SS` duration)
  - sub-agent block: `Sub-agents · 2 running` then member rows
    `🔵 implement · Edit jwt.ts`, `🔵 test-runner · Bash npm test`
    (role · current tool; ≤5 rows then a `+N more` line)
  - a Telegram inline `[ Steer ]` button under the message
- A small left-side state strip (NOT a card; three plain rows) showing
  the deterministic per-topic status across a turn lifecycle:
  `🟡 quiet · no turns yet` → `⚙️ working since 2m ago` →
  `🟢 idle · last reply 5m ago`

## Callouts (monotonic, reading order)

1. Quoted user message — reply style, anchors the turn
2. Header: phase `⚙️ Working…` + `MM:SS` elapsed (formatDuration)
3. Streamed tool row — completed (`✅`), edited in place ~1/sec
4. In-flight row — bold, live `MM:SS`; args sanitised (basename only,
   secrets redacted — a secret never reaches the surface)
5. Sub-agent fleet block — ≤5 live rows (role · current tool), then
   `+N more`; not a separate pinned card, not a `(1/N)` label
6. `[ Steer ]` — redirect a long-running turn mid-flight without killing it
7. The three-state strip — the never-silent guarantee: every topic is
   always quiet / working / idle, deterministically, never nothing
8. Inset link: a Drive write is a *separate* gated approval (sibling
   card) — point to `drive-write-approval.spec.md`, do not conflate

## Style notes

Inherits the v3 recipe. The working card is the dark-card exception
(`#14171C`, same rx/shadow/rotation as the old anatomy mock so the set
still reads as one family). The state strip uses plain body text rows,
no card frame, so it reads as "ambient status", not a component. No
`📌` pin glyph anywhere — its absence is the point. Leader lines stay
dotted `--ink-300`; callout circles keep their role colors
(brass=sequence, teal=done/clean, cord=wait/attention).
