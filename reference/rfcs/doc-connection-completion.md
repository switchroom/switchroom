# RFC E: Make Google Drive a real collaboration surface

Status: Draft v3 (v3.1 amendment 2026-05-15 — implementation pivot in §4.2)
Author: Ken (with Claude pair-design)
Date: 2026-05-14

**v3.1 amendment** (2026-05-15):
- §4.2 — implementation shipped as **Path A Cut 2**: a Claude Code
  PreToolUse hook intercepting upstream `taylorwilsdon/google_workspace_mcp`
  write tools, not a purpose-built switchroom wrapper. Trade-off:
  no Suggesting-mode default (upstream MCP doesn't expose it), but
  the wrapper-attested anchor + metrics + diff-preview card all
  ship as designed. See §4.2's pivot banner for the full delta.

**v3 changes** (addressing PR #1227 review):
- §3 dropped `extend-without-forking` JTBD claim (overstated — that JTBD is about adding new agents/skills/tools, not config-surface affordances inside an existing integration).
- §4.5 added a third anchor primitive: text-snippet anchor (`after_line_containing: "..."` resolved by wrapper). Covers the 80% of real-world meeting-notes / draft-prose docs that have no headings without forcing a "agent must add headings first" hard contract.
- §4.2 hardened the diff-preview against intent-lies (not just size-lies): wrapper-attested anchor name appears on the primary card, agent-supplied summary appears below it. User has wrapper truth to sanity-check the agent's framing against.
- §6.3 added explicit acknowledgment that approval cards are the existing exception to the "chat IS the artifact" sub-principle, per RFC B §8.1 — preempt the next reviewer re-litigating it.
- §9 added two risks: anchor-fragmentation (covered in §4.5 expansion) + summary-lies-about-intent variant.

Prerequisites — both shipped:
- **RFC B — Approval kernel** (`approval-kernel.md`) — landed v0.6.0 (#762).
- **RFC D — Google Drive MCP integration** (`gdrive-mcp.md`) — landed v0.6.0 (#763, #766, #767, #768).

This spec finishes the Google Drive integration so it stops being a
read-only data fetcher and becomes a proper place to **collaborate
with the agent on docs**. Drive is the focused surface; Notion and
the other doc sources are explicitly deferred to a follow-up spec
once the Drive collab loop is real.

## 0. Goal

A user can give an agent a Google Doc, ask it to draft into the doc,
review the agent's changes inline in Drive, and resume the
conversation in Telegram — all without leaving the
phone-or-laptop-they-already-have-open. The agent is a collaborator
on the user's docs, not a one-shot reader-and-summarizer.

## 1. Outcome

The user can do this end-to-end from a Telegram thread on a phone:

```
User:   "Klanker, take the meeting notes from /Work/2026/Q3 and
         draft a hiring section into the Q3 Strategy doc."

Agent:  [posts approval card]
        🔐 klanker wants to read 4 docs in /Work/2026/Q3
        "Q3 Strategy Notes", "Hiring plan", "+2 more"
        [ ✅ Allow this folder ]  [ See all ]  [ 🚫 Deny ]

User:   [taps Allow this folder]

Agent:  "Read 4 docs. Drafting a Hiring section into Q3 Strategy
         Notes — will post a preview in a sec."

Agent:  [posts write-approval card]
        ✏️  klanker wants to add to "Q3 Strategy Notes"
        +47 lines · "Added Hiring section after 'Goals'"
        [ 📖 Open in Drive ]  [ ✅ Apply as suggestion ]
        [ ⚠ Apply directly ]  [ 🚫 Cancel ]

User:   [taps Apply as suggestion]

Agent:  "Done — open https://docs.google.com/document/d/.../edit
         to review. I'll wait."

User:   [opens link in Drive app, reviews, accepts the suggestion,
         comes back to Telegram]
        "Looks good, can you tighten the second paragraph?"

Agent:  [posts write-approval card with new diff]
        ...
```

Today this loop is impossible. The agent can read the doc but can't
write back, can't propose changes the user can review in Drive's UI,
can't link the user back to the doc from chat, and the folder-grant
step requires the user to type a scope string. Every one of those
gaps blocks the collaboration JTBD.

## 2. Vision alignment

Maps to three of the four outcomes in `reference/vision.md`:

- **Multi-agent fleet (#2)** — Specialists become specific *because*
  they have a real working relationship with the user's docs. A
  research agent that can draft into your reading-notes is a
  research agent; one that can only read is a search box.
- **Subscription-honest (#3)** — Per-user OAuth, refresh tokens in
  vault, no service accounts. Same posture as RFC D §4.
- **Always-on (#4)** — Refresh tokens survive reboots; the
  reconciler's missing→present recovery (§4.4) means a doc the user
  un-trashes mid-week doesn't leave the agent stuck.

Visibility (#1) is served by the existing approval card UX from RFC
D plus the new diff-preview surface in §4.2 — the user always sees
what the agent is about to do *before* it touches their doc.

## 3. JTBD alignment

- **`share-auth-across-the-fleet.md`** — Drive OAuth = once per
  Google account. Adding a second agent that needs the same Drive
  doesn't re-prompt; the cascade resolves the shared vault slot.
  (Note: this JTBD is the load-bearing one for **RFC G** — RFC E
  inherits its OAuth posture but doesn't drive that JTBD by itself.)
- **`talk-to-agents-from-anywhere.md`** — Folder browsing, write
  approvals with diff preview, deep-link to Drive, reconnect-on-
  token-revocation — every step is reachable from a phone. The
  headless OAuth tier from RFC D §3.2 covers initial connect;
  nothing else needs a desktop browser.
- **`know-what-my-agent-is-doing.md`** — The diff-preview-before-
  write pattern is the JTBD's "see every step" applied to mutations.
  The user never finds out the agent edited a doc by re-opening it
  later. The wrapper-attested anchor name on the diff-preview card
  (§4.2) is the load-bearing detail that makes this JTBD honest —
  without it, "see every step" reduces to "see whatever the agent
  chose to summarize."

## 4. Scope — five pieces, all Drive

### 4.1 Folder picker (deferred from RFC D §6) — Phase 1

**Today:** per-doc grant works fine; folder grants require typing
`doc:gdrive:folder/<id>/**` by hand. RFC D §6 acknowledged this is
worse than either default and explicitly punted.

**Design:**

- New CLI verb: `switchroom drive folders <agent>` — does *not*
  render in the terminal. Posts a card in the agent's Telegram
  topic.
- Card surface: paginated folder list, top-level first, breadcrumb
  on long names. One tap on a folder = expand into its children +
  back arrow. One tap on `[ ✅ Allow this folder ]` = write
  `allow_always` at `doc:gdrive:folder/<id>/**` and surface the
  standard granted-card confirmation (with `· /approvals revoke
  <id>` inline per RFC B §9).
- The same picker is reachable from inside an in-flight per-doc
  approval card via a new `[ 📁 Allow folder instead ]` button —
  the primary mitigation for the prompt-flood path RFC D §5 warns
  about.
- Listing source: `files.list` with
  `q="mimeType='application/vnd.google-apps.folder' and 'me' in
  owners and trashed=false"`, paginated 50 per card. Cached for 5
  min per agent.
- Staleness digest from RFC B §9.1 also gets a `[ 📁 Browse ]`
  button next to each folder grant so the user can audit before
  keeping.

**Pagination is not optional.** Drive accounts with deep folder
trees (>100 top-level folders) are common. Ship paginated on day 1.

### 4.2 Write operations with Suggesting as the default (deferred from RFC D §12) — Phase 1

> **Implementation pivot — Path A Cut 2 (2026-05-15).** §4.2 as
> originally specified assumed switchroom would ship its own MCP
> wrapper exposing `gdrive_suggest_edit` / `gdrive_apply_edit` /
> `gdrive_create_doc` / `gdrive_append_to_doc` — purpose-built so the
> wrapper could default writes to Drive's Suggesting mode and pre-
> resolve every anchor before posting the diff-preview card.
>
> Implementation landed differently. Agents reach Drive via the
> upstream `taylorwilsdon/google_workspace_mcp` server (pinned to the
> commit in `GOOGLE_WORKSPACE_MCP_PINNED_SHA`, single-sourced in
> `src/memory/scaffold-integration.ts`), which exposes 9
> direct write tools (`modify_doc_text`, `find_and_replace_doc`,
> `insert_doc_elements`, `insert_doc_image`, `batch_update_doc`,
> `create_table_with_data`, `update_doc_headers_footers`,
> `update_paragraph_style`, `manage_doc_tab`) and **no Suggesting
> mode** at all. Building our own wrapper to add Suggesting was
> scoped out — the upstream MCP is already shipped, our agents
> already use it, and forking it would mean carrying the diff
> indefinitely.
>
> The chosen mechanism is a **Claude Code PreToolUse hook**
> registered against `^mcp__google-workspace__` write tools. The
> hook intercepts every write, resolves the doc state (Docs API
> `documents.get`), builds the wrapper-attested diff preview,
> requests an approval through the kernel + gateway, polls until
> the user taps Allow/Cancel, and returns `{decision:"block"}` if
> denied. Same trust boundary as the §4.2 design — the wrapper still
> attests the anchor + metrics — but no Suggesting affordance.
>
> **What this preserves from §4.2:**
> - Wrapper-attested anchor name on the diff-preview card (`📍`
>   line, computed via `describeOffset` over the Docs API
>   `body.content[]` half-open ranges).
> - Wrapper-attested diff metrics (`+lines / -lines`).
> - Agent-supplied summary rendered below the wrapper truth.
> - Same audit fidelity (`action: write` in the audit row).
> - `[ 📖 Open in Drive ]` button per §4.3.
>
> **What this does NOT preserve:**
> - Suggesting as the default. Every gated write is a direct write
>   when applied — agents have no way to propose a non-destructive
>   suggestion. (User can still revert via Drive's version history.)
> - Two-button "Apply as suggestion" + "Apply directly" affordance.
>   The card shows Allow / Cancel only.
> - `doc:gdrive:suggest:*` scope namespace. Only `doc:gdrive:write:*`
>   is wired up. Agents already holding a `read` grant can attempt
>   writes — each one prompts.
> - `gdrive_apply_edit` / `gdrive_create_doc` / `gdrive_append_to_doc`
>   as named tools. Agents use the upstream tool names directly.
>
> **Closing the suggest-mode gap** would require either:
> (a) forking upstream and adding a `--suggest` flag to the Docs
> write methods (load-bearing diff to maintain; rejected for now);
> (b) shipping a thin switchroom wrapper MCP that re-exports the
> upstream tools with Suggesting-by-default behavior (still
> requires the underlying Docs API to expose Suggesting — it does
> via `suggestionsViewMode` on read, but for write, the API only
> creates `Suggestions` if the requesting Drive account is not the
> doc owner; agent-owned docs would still apply directly).
>
> Implementing PRs: **#1314** (reverse anchor, ancestrally bundled
> into #1316), **#1316** (Docs API client + write-preview spec
> builder), **#1318** (gateway IPC verb posting the diff-preview
> card), **#1319** (PreToolUse hook + scaffold registration).
> Card UX (no separate suggest/write modes — Allow/Cancel only) is
> a v0.10.x decision, not the long-term RFC E §4.2 contract.

**Today:** read-only by design. RFC D §12 stipulates writes need
their own scope namespace so a read grant never silently authorizes
a write.

**Why "Suggesting" is the default, not direct write:** Drive has a
first-class Suggesting mode (the same one human collaborators use).
Suggestions are non-destructive — the user reviews and accepts them
in Drive's UI just like a peer's edit. **Defaulting to Suggesting
mode is the difference between "agent writes to my doc" (scary) and
"agent proposes edits I review" (collaboration).** Direct writes
remain available behind a one-extra-tap affordance for cases where
suggesting doesn't fit (creating a brand-new doc, scripted bulk
edits, etc.).

**Design:**

- New scope namespaces (read scopes unchanged):
  - `doc:gdrive:suggest:<id>` and `doc:gdrive:suggest:folder/<id>/**`
    — non-destructive proposals.
  - `doc:gdrive:write:<id>` and `doc:gdrive:write:folder/<id>/**`
    — direct writes.
- A `suggest` grant does NOT imply `write`. `write` implies
  `suggest`.
- MCP wrapper exposes:
  - `gdrive_suggest_edit(doc_id, anchor, text)` — primary edit
    tool.
  - `gdrive_create_doc(title, content, parent_folder)` — new docs
    only; uses `write` scope on the parent folder.
  - `gdrive_apply_edit(doc_id, anchor, text)` — direct write; uses
    `write` scope.
  - `gdrive_append_to_doc(doc_id, text)` — append; uses `write` (no
    Suggesting equivalent in the API for pure append).
- Approval card for a suggestion edit (anchor + line-count are
  **wrapper-attested**; summary is agent-supplied):
  ```
  ✏️ klanker wants to add to "Q3 Strategy Notes"
  📍 after heading 'Goals' (level 2)         ← wrapper, not agent
  +47 lines / -0 lines                       ← wrapper, not agent
  💬 "Added Hiring section after 'Goals'"     ← agent-supplied summary
  [ 📖 Open in Drive ]  [ ✅ Apply as suggestion ]
  [ ⚠ Apply directly ]  [ 🚫 Cancel ]
  ```
  - **Wrapper-attested anchor name** sits on its own line above the
    diff metrics, prefixed `📍`. The wrapper has just resolved the
    anchor (per §4.5) so it knows the actual heading / line-snippet
    / position the edit will land at — and surfaces it independently
    of whatever the agent says in its summary. This is the
    load-bearing detail that makes the JTBD `know-what-my-agent-is-
    doing` honest for mutations: even if the agent's summary says
    *"Added Hiring section"*, if the resolved anchor reads `📍 after
    heading 'Goals'` and the edit actually lands in Goals, the user
    sees the truth.
  - **Wrapper-attested diff metrics** (`+47 / -0 lines`) — the
    wrapper computes these from the proposed edit relative to the
    current doc state. Agent cannot lie about size.
  - **Agent-supplied summary** (`💬 "..."`) is the agent's
    explanation of *why*, not *what* — the wrapper-attested anchor
    and metrics already cover *what*. Audit row stores both for
    post-hoc review of agent intent vs. wrapper truth.
  - Primary action is **Apply as suggestion** — single tap, lands
    as a Drive Suggestion the user reviews in Drive's UI.
  - **Apply directly** is a secondary, badged with `⚠`. Standing
    direct-write grants are opt-in via expand only — never on the
    primary card row.
  - **Open in Drive** is always present. See §4.3.
- Audit row records `action: suggest` or `action: write` so
  `/approvals stats` separates collaboration traffic from outright
  writes.
- The §5 onboarding card from RFC D gains a new expand option:
  `[ ✏️ Also enable suggesting (per-action approval) ]`. This flips
  the agent into write-aware mode without granting any standing
  edit access. Direct writes remain a deeper, expand-only choice.

### 4.3 Open-in-Drive deep links — Phase 1

**Today:** every reference to a doc in chat is a title; the user
has to find the doc themselves to look at it. Breaks the collab
loop — the user can't tap from "agent edited X" to "let me see X."

**Design:**

- Every approval card that names a doc renders the title as a
  `[ 📖 Open in Drive ]` inline-keyboard button that opens
  `https://docs.google.com/document/d/<id>/edit` (or the
  spreadsheet/presentation equivalent based on `mimeType`).
- Granted-card confirmations (RFC B §8.1) gain the same button so
  the user can jump straight from "agent has access" to the doc
  itself.
- Suggestion-write approvals (§4.2) also include
  `?disco=<thread_id>` on the URL when Drive's API exposes a
  discussion thread for the proposed edit, so the link lands the
  user directly on the suggestion they're reviewing.
- No new permission needed — these are the same shareable URLs the
  user would copy from Drive's "Share" dialog.

### 4.4 Reconciler missing→present recovery (deferred from RFC D §12) — Phase 1

**Today:** when a doc is in Missing state (deleted/trashed) and the
user later un-trashes it, the agent re-discovers on next access.
Fine for ad-hoc reads; means scheduled tasks ("scan my reading list
weekly") that hit a transient missing window stay broken for a
week even after the user fixes it.

**Why it's promoted from "Phase 4 cleanup" to Phase 1:** in a
collab loop the missing→present transition is *common*. The user
trashes their draft, asks the agent to start over, un-trashes the
original to compare — they expect both versions to be live for the
agent.

**Design:** trivial extension of `src/drive/reconciler.ts` —

- When a missing-state grant transitions back to Present on its
  next scheduled check, write a `recover` row to `approval_audit`
  and surface a `[ ↻ Re-enabled ]` line in the next staleness
  digest + a one-line nudge in the agent's chat:
  *"↻ 'Q3 Strategy Notes' is back — let me know if you want me to
  pick up where I left off."*
- No retro-active state-management. No automatic re-trigger of the
  scheduled task. Just don't *hide* the recovery from the user.

### 4.5 Section-anchor editing primitive — Phase 1

The `gdrive_suggest_edit(doc_id, anchor, text)` tool from §4.2
needs an anchor model that's robust enough for an agent to use.
Naive "insert after byte offset N" breaks the moment the doc
shifts.

**Three anchor types, in priority order:**

1. **Heading-based** (preferred for headed docs):
   ```
   anchor: { after_heading: "Goals", level: 2 }
   anchor: { append_to_section: "Hiring", level: 2 }
   ```
   Wrapper resolves against `documents.get` → structural tree
   walk. If multiple headings match (`level` not specified or
   ambiguous), the first match wins; agent can disambiguate by
   adding `level` or `nth_match`.

2. **Text-snippet anchor** (covers unheaded docs — meeting notes,
   draft prose, the long tail):
   ```
   anchor: { after_line_containing: "we agreed to ship by Q3" }
   anchor: { before_line_containing: "Action items:" }
   anchor: { replace_line_matching: /TBD: hiring section/ }
   ```
   Wrapper resolves by walking paragraph-level text content,
   matching the snippet (case-insensitive substring by default;
   regex if the value is a `RegExp`-shaped object). If multiple
   matches, the agent gets `MULTIPLE_MATCHES` with the first 3
   surrounding-context excerpts and must pick one — no "first
   wins" silent guess for snippets, because the user can't
   visually verify which match the agent meant.

3. **Document-position fallback** (last resort, for empty / very
   short docs only):
   ```
   anchor: { at_start: true }
   anchor: { at_end: true }
   ```

**Resolution failure** at any tier:

- Heading not found → `HEADING_NOT_FOUND` with suggestion to
  switch to a snippet anchor: *"⚠ Couldn't find heading 'Goals'.
  Try `after_line_containing: \"...\"` or pick a different
  anchor."*
- Snippet not found / matches multiple → `SNIPPET_NOT_FOUND` or
  `SNIPPET_AMBIGUOUS` with the actual match excerpts. Agent must
  re-decide; no silent fallback to `at_end`.
- All three resolved successfully → wrapper computes the
  **resolved anchor name** that gets surfaced on the diff-preview
  card per §4.2 (e.g. `'Goals' (heading)` or `line 47: "we agreed
  to ship by Q3"` or `at end of doc`). This is the
  wrapper-attested anchor the user sees — the agent cannot
  override it.

## 5. Out of scope (this spec)

- **Notion / Slack / Gmail** — deferred to RFC F. The Drive collab
  loop has to land first as proof that the picker + write +
  deep-link + reconciler-recovery model is real before we
  generalize.
- **Drive Sheets / Slides as first-class collaboration surfaces** —
  reads work today via the same MCP; suggesting/writing into Sheets
  cells and Slides components is its own UX problem (cell anchors,
  slide layouts) and warrants its own spec.
- **Track-changes / blame** — the user reviews suggestions in
  Drive's own UI, which already has these; switchroom doesn't
  reinvent them.
- **Agent-initiated comments / @-mentions on Drive comments** —
  separate from the edit loop; would need its own approval shape.
- **Local-filesystem doc indexing** — agent-workspace concern, not
  external-surface concern.
- **Service-account auth** — same reason as RFC D §12: collapses
  approval semantics.
- **Two-way doc sync** (treating Drive as a backing store for
  agent-state) — out. The contract is the user owns the doc; the
  agent collaborates on it.

## 6. Principle checks

Per `reference/principles.md`, applied to this spec:

### 6.1 Docs test — *"Can someone use this without opening `docs/`?"*

- ✅ `switchroom drive folders klanker` posts a card with inline
  guidance. No prerequisite reading.
- ✅ Approval card copy explains the suggestion vs direct-write
  trade-off in one line — no glossary needed.
- ✅ `[ 📖 Open in Drive ]` is self-explanatory. Tap → doc opens.
- ✅ Anchor-resolution errors give the user a next step
  (*"Want me to suggest a heading-by-heading rewrite?"*).

### 6.2 Defaults test — *"Does it work on a fresh `switchroom setup`?"*

- ✅ Drive remains opt-in (must run `connect`); once connected,
  the picker and Open-in-Drive surfaces are reachable with zero
  further config.
- ✅ Writes default to Suggesting mode. The single most dangerous
  affordance (standing direct-write grants) is opt-in via expand,
  not surfaced as a primary button.
- ✅ Anchor model defaults to heading-based (the only model that
  survives doc evolution). No setting to choose.

### 6.3 Consistency test — *"Does this feel like one product?"*

- ✅ Same `apv:` callback shape across reads, suggests, writes
  (RFC B §6.1).
- ✅ Same `vault:gdrive:*` slot pattern (no new vault concepts).
- ✅ Same approval card states (pristine / expanded / granted /
  denied / expired) — RFC B §8.1.
- ✅ Same `/approvals list|revoke|add|stats` surface — adding
  `suggest` and `write` action types adds rows, not commands.
- ✅ Same headed-doc model the user already lives in for any Drive
  doc; agent anchors mean what they look like they mean.

**Sub-principle: "the chat IS the artifact" — explicit
acknowledgment.** `principles.md` §3 sub-principle warns against
adding new pinned cards / status bars / live widgets when the
model could communicate naturally instead. The diff-preview
approval card in §4.2 looks like a violation of that rule. It
isn't, and the spec says so explicitly so the next reviewer
doesn't have to re-litigate:

> Approval cards are the existing exception per RFC B §8.1. The
> rule is "build the model to communicate; let the framework be
> the safety net, not the headline." Approvals are the framework
> safety net for **mutations under operator authorization** —
> they're the one place where the chat alone can't carry the
> semantic weight (a tap is structurally different from a
> message). The diff-preview card in §4.2 is the same primitive
> RFC B §8.1 already established, applied to write-shaped
> approvals; it does not introduce a new pinned-card-shaped
> object. Open-in-Drive is an inline-keyboard button on the
> existing card, not a separate widget. If the user taps "Apply
> directly" repeatedly the model can still narrate ("you've
> approved 6 direct writes today, want me to suggest instead?")
> in chat — the card never replaces the chat as the source of
> truth.

## 7. Migration / rollout

All five pieces are scoped as **Phase 1 — Drive collab experience**.
Substructure for sequencing within the phase:

1. **1a — Folder picker (§4.1) + Open-in-Drive (§4.3).** The
   lowest-risk pair; folder picker is contained UX, Open-in-Drive
   is additive. Ships independently of writes.
2. **1b — Anchor primitive (§4.5).** Foundation for §4.2; ship +
   test in isolation against a fixture doc before wiring it to the
   approval card.
3. **1c — Suggesting writes + diff preview (§4.2).** The headline
   feature. Lands on top of the anchor primitive and the
   Open-in-Drive button.
4. **1d — Reconciler recovery (§4.4).** Lowest-effort, ships last
   — useful but not blocking the headline collab loop.

Phase 2+ (Notion as second surface, framework extraction, broader
doc surfaces) lives in a follow-up RFC and is explicitly out of
scope here. Doing Drive collab first means RFC F (whenever it
lands) has a real working model to copy from instead of a designed
abstraction.

## 8. Effort estimate

Per CLAUDE.md, in **agent minutes** (wall-clock for a current-gen
agent, end-to-end including tests):

| Sub-phase | Item | Estimate |
|---|---|---|
| 1a | Folder picker (§4.1) — picker card + pagination + 5min cache + tests | ~45 min |
| 1a | Open-in-Drive deep links (§4.3) — wired into approval cards + grant confirmations + tests | ~20 min |
| 1b | Anchor primitive (§4.5) — heading resolver + fallback modes + tests | ~45 min |
| 1c | Suggesting writes + diff preview (§4.2) — scope namespaces + MCP tools + approval defaults + tests | ~75 min |
| 1d | Reconciler recovery (§4.4) — recover event + digest line + chat nudge | ~25 min |
| — | Doc updates (`docs/drive.md`, RFC cross-refs) | ~20 min |

**~3.75 hours agent time** for the full Phase 1. One focused day,
shippable as four PRs (1a, 1b, 1c, 1d) for incremental review.

## 9. Risks and open questions

- **Drive's Suggestions API has gaps.** Some operations (creating
  a doc, pure append) have no Suggesting equivalent — those stay
  on the direct `write` scope. Document this clearly in the agent-
  facing tool descriptions so the agent picks the right tool.
- **Anchor type selection by the agent.** Three anchor types in
  §4.5 (heading / snippet / position) means the agent has to pick
  the right one. Wrong pick = `*_NOT_FOUND` error and a wasted
  tool call, not user-visible damage — but it does add a class of
  agent confusion. Mitigation: prompt-pack guidance + tool
  descriptions explicitly call out the priority order (try
  heading first, fall back to snippet, position only for
  empty/very-short docs). After 3 wasted tool calls in a session
  on the same doc, the wrapper returns the doc's structural tree
  in the error response so the agent can re-plan from ground
  truth instead of guessing again.
- **Snippet anchor ambiguity in long docs.** A snippet that
  appears multiple times forces the agent to pick a specific
  match. In a long doc with repetitive structure (meeting notes
  with a "Action items:" section in every entry), this becomes a
  multi-round conversation. Mitigation: `MULTIPLE_MATCHES` error
  returns the first 3 surrounding-context excerpts (per §4.5);
  agent picks by `nth_match` index. Acceptable friction for the
  collab loop; not a blocker.
- **Diff preview — size lies and intent lies, separately
  defended.** Two distinct attacks on the diff-preview card:
  (a) *size lie* — agent claims `+5 lines` for a 47-line change;
  (b) *intent lie* — agent's summary says "Added Hiring section"
  but the edit lands in Goals. Mitigation: §4.2 surfaces both
  the wrapper-attested anchor name (`📍 after heading 'Goals'`)
  and the wrapper-attested line counts (`+47 / -0 lines`)
  alongside the agent's summary, on the primary card row. User
  has wrapper truth to sanity-check the agent's framing.
  Audit row stores all three for post-hoc review of agent intent
  vs. wrapper resolution.
- **Folder picker cache invalidation.** 5-min cache is right for
  most users but wrong for someone reorganizing their Drive in the
  same window. Add a `[ ↻ Refresh ]` affordance on the picker card
  that bypasses cache. Cheap.
- **Open-in-Drive auth assumption.** The deep-link assumes the
  user is logged into Google in their browser/app on the device
  they tap from. If they're not, Drive's own login flow handles it
  — not our problem, but the link doesn't pre-validate.
- **Discoverability of Suggesting vs Write.** A user who taps
  `Apply directly` once might not realise Suggesting was the safer
  default. After 3 direct-applies in a 24h window, surface a
  one-time tip: *"You're approving direct writes a lot — want to
  set 'always suggest' as the default for this doc?"*

## 10. Tracking

### Phase 1 primitives — all merged

- [x] Phase 1a — Open-in-Drive deep-link builders — #1251
- [x] Phase 1a — Open-in-Drive button on granted approval cards — #1295
- [x] Phase 1a — Folder picker primitives (list + cache + card) — #1296
- [x] Phase 1b — Section-anchor editing primitive — #1250
- [x] Phase 1c — `doc:gdrive:suggest:*` scope namespace — #1290
- [x] Phase 1c — Diff-preview builder — #1252
- [x] Phase 1c — Edit-prep helpers for the four MCP tools — #1297
- [x] Phase 1c — Telegram diff-preview card renderer — #1299
- [x] Phase 1d — Reconciler missing→present recovery detector — #1249
- [x] Phase 1d — Recovery audit / digest / nudge formatters — #1300
- [x] Cross-cutting — `docs/google-workspace.md` user guide

### Follow-up wiring — all merged

The Phase 1 plan deliberately followed a *ship-the-helper-then-wire*
pattern (so each PR is independently reviewable and the
kernel-agnostic surface area stabilises before the Telegram /
kernel / MCP-server glue lands). All three follow-up pieces landed
2026-05-15:

- [x] Gateway `drvpick:` callback dispatcher + `switchroom drive
      folders <agent>` CLI verb (folder-picker glue — consumes #1296) — #1308
- [x] Reconciler-driver loop that iterates grants, fetches Drive
      metadata on a schedule, and fans recoveries through #1300's
      audit-write + chat-nudge + staleness-digest paths — #1307
- [x] Write-side wiring — shipped as **Path A Cut 2** (PreToolUse
      hook intercepting upstream `taylorwilsdon/google_workspace_mcp`
      write tools instead of a purpose-built switchroom wrapper).
      See §4.2's pivot banner for the trade-off. Three PRs:
      Docs API client + write-preview spec builder (#1316),
      gateway IPC verb that posts the diff-preview card (#1318),
      PreToolUse hook + scaffold registration (#1319).

End-to-end is operator-visible now; what remains is a real-world
shakeout pass on a live agent (try `/folders`, tap to grant,
attempt a suggest-mode write, confirm the diff-preview card +
approval flow + Drive update all line up).

### Phase 2+

- **RFC F (separate)** — Second doc surface (Notion candidate)
  + framework extraction once Drive collab is real.
