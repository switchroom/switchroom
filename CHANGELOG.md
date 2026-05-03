# Changelog

## [Unreleased]

## v0.6.4 — 2026-05-03

### Fixed

- **Bundle UTF-8 mojibake (#643, follow-up to #642).** Bun's parser
  misreads raw UTF-8 source bytes as Latin-1 past ~172kB into a large
  bundle, expanding each multi-byte char into multiple JS code units.
  When re-emitted to stdout / `writeFileSync`, those code units get
  UTF-8 encoded a second time → classic double-UTF-8 mojibake. v0.6.3
  symptoms: boot cards rendered as `â AgentName back up Â· v0.6.3`,
  `switchroom agent list` "Uptime" column rendered as garbage, systemd
  unit em-dashes written as `c3 a2 c2 80 c2 94`. Fix: post-build pass
  (`scripts/escape-bundle-non-ascii.mjs`) that ASCII-escapes every
  code unit > 0x7F in built bundles to `\uHHHH` — same defence
  esbuild's `--charset=ascii` flag provides; bun build doesn't expose
  one. Wired into both bundle builders. Regression test asserts all 5
  built bundles contain zero bytes > 0x7F.

### Added

- **dm_only agent flag — suppress noisy boot probe for DM-only bots
  (#644).** Agents marked `dm_only: true` skip the forum-topic
  presence probe at boot, which was producing red boot cards on
  agents that legitimately have no group/topic to monitor. The
  scaffold-time default is `false` so existing behavior is preserved.

## v0.6.3 — 2026-05-03

### Fixed

- **Bundle no longer breaks under bun runtime (#640).** Released
  bundle was inlining `node-fetch@2` (grammy's HTTP dep) when built
  with `--target node`. Under bun runtime that inlined CJS
  node-fetch broke grammy's `getMe`/`sendMessage` calls with a
  generic `HttpError: Network request failed!` — the fleet was
  unresponsive on every restart (👀 reaction succeeded, no replies
  landed). Fix: `--external node-fetch` in the plugin bundle so
  the fetch impl is resolved at runtime (bun's native shim under
  bun, real node-fetch from node_modules under node).

### Added

- **Issue cards render remediation hints (#633).** When an issue's
  `--detail` field starts with `Fix:` or `→`, the pinned issue card
  surfaces it as a `→ <hint>` line under the summary. The cron
  prompt template (`src/agents/sub-agent-telegram-prompt.ts`) now
  teaches agents to record remediation alongside transient issues
  (e.g. `Fix: switchroom vault unlock` when the broker is locked).
  Multi-line stderr-tail details are excluded from the card to
  keep the layout tight; full detail still visible via `/issues`.
- **First-message-after-restart picks up reaction filter (#641,
  closes #613).** Gateway now warms `chatAvailableReactions` for
  every chat in `access.allowFrom` at boot so the very first turn
  in a restricted-reactions supergroup gets the proper filter
  instead of the lazy-on-first-message safety net (which couldn't
  help the first message itself).

### Engineering

- **Telegram-plugin source is now strict-tsc clean (#641, closes
  #623).** `npm run lint` previously filtered tsc output to four
  "dangerous-class" error codes because 52 pre-existing type-debt
  errors would have drowned the signal. All 52 are now fixed
  (possibly-undefined narrowing, discriminated-union narrowing,
  dead-code removal, boundary casts at grammy interfaces). The
  lint check now fails on any tsc error in plugin source — going
  forward, type bugs in `telegram-plugin/` are caught at lint time
  the same as `src/`.

## v0.6.2 — 2026-05-03

### Added

- **Account-level buttons on the `/auth` Telegram dashboard
  (#637).** The dashboard now renders one row per Anthropic account
  with a `✓` marker (enabled on this agent) or `○` marker (account
  exists, not enabled here). Tapping kicks off a two-stage confirm
  → `auth enable / disable <label> <agent>` → restart, mirroring
  the existing `rm`/`confirm-rm` pattern. Health-affix glyphs
  (`⌛` expired/no-refresh, `⚠️` quota-exhausted, `❌`
  missing-credentials) flag accounts that need attention without
  opening the CLI.
- **"🌐 Share to fleet" bootstrap button.** When zero accounts
  exist but this agent has slot credentials we can promote, the
  dashboard surfaces a one-tap `auth share default --from-agent
  <agent>` button. New users go from "fresh OAuth" to
  "shared-across-fleet" in one tap.
- **`switchroom auth account list --json`.** Sorted, deterministic
  account inventory (label, health, subscriptionType, expiresAt,
  quotaExhaustedUntil, email, agents) the gateway probes to
  populate the dashboard. Mirrors `auth refresh-accounts --json`'s
  emission style.

### Behaviour notes

- Dashboard degrades gracefully when the CLI is older than v0.6.x
  (no `--json` flag) — the accounts section just hides; per-slot
  buttons keep working.
- Render-time guard caps callback_data at Telegram's 64-byte limit:
  pathological agent + label lengths fall back to a `noop` button
  labelled `⚠ <label> (use CLI)` rather than overflowing.
- More than 5 accounts in the inventory truncates with a `…
  N more (use CLI)` row.

## v0.6.1 — 2026-05-03

### Fixed

- **Strategic packaging fix — telegram-plugin now ships as a
  self-contained bundle.** The `telegram-plugin/gateway/gateway.ts`
  (and server, bridge, foreman) entry points reach across into `src/`
  for auth, config, vault-broker, build-info — modules that the npm
  package's `files` array does not ship and that .gitignore excluded
  from `dist/`. Result: a fresh `bun add -g switchroom-ai@0.5.x`
  install crashloop'd at gateway boot with `Cannot find module
  '../../src/auth/accounts.js'`. Operators only stayed running by
  having a `bun link` overlay of the dev workspace shadowing the
  npm install.

  The fix bundles each plugin entry point with `bun build` (resolving
  all cross-imports inline) into `telegram-plugin/dist/`. The systemd
  gateway unit + foreman unit + .mcp.json server entry now prefer the
  bundled JS, falling back to the .ts source for dev workspaces that
  haven't built yet. The npm package ships `telegram-plugin/dist/` so
  fresh installs run without any source-tree dependency.

  Closes the same packaging class as v0.5.1's fix at the strategic
  level — instead of patching `files` to ship more `src/` (which
  spreads the cross-import surface further), the plugin becomes a true
  library with no upstream reach.

### Added

- **`bun run build` now builds telegram-plugin too.** Root
  `scripts/build.mjs` invokes `telegram-plugin/scripts/build.mjs`
  after the CLI bundle. Single command, both targets.
- **`telegram-plugin/start.js` shim.** MCP launchers `bun run start`
  through this — picks dist if present, falls back to .ts source.
  Preserves the legacy "edit + restart" dev loop while making the
  installed-package path the production default.
- **Foreman bundled.** `foreman/foreman.ts` now in the plugin build
  alongside server/gateway/bridge.

## v0.6.0 — 2026-05-03

### Added

- **`/auth share <label>` — one-shot account-add + fleet-wide enable
  (#634).** Collapses the two-step "register account, then enable on
  every agent" flow into a single command. CLI: `switchroom auth share
  <label> [--from-agent <name>]`; Telegram: `/auth share <label>
  [--from-agent <name>]`. Auto-defaults `--from-agent` when only one
  agent is configured (the fresh-install case). Auto-restarts every
  affected agent so claude picks up the freshly fanned-out
  credentials. Refuses with a hint when the account already exists
  (*"use 'switchroom auth enable <label> all' instead"*).

- **`all` keyword for `auth enable` / `auth disable` (#634).**
  Operators don't have to enumerate the fleet:
  - `switchroom auth enable <label> all` — wire the account to every
    claude-enabled agent in `switchroom.yaml`.
  - `switchroom auth disable <label> all` — unwire from every agent.
  - Telegram surfaces the same shape: `/auth enable <label> all`.

  Edge case: a literal agent named `all` in `switchroom.yaml` triggers
  a stderr warning and the keyword still wins; rename the agent to
  disambiguate.

### Why

Closes the ergonomic gap from `share-auth-across-the-fleet.md` JTBD.
PR #621 delivered the underlying account-as-unit capability, but the
common case ("one Pro subscription drives my whole fleet") still
required two commands plus N agent names. The new verbs make it one
command, mobile-native.

## v0.5.2 — 2026-05-03

### Fixed

- **Multiple status messages emitted during single turn (#626).** The
  progress-card emit lifecycle had a structural failure mode: when
  `stream_reply(done=true)` finalized the lane, it deleted
  `activeDraftStreams[sKey]` — and any subsequent emit on the same
  lane+turnKey created a fresh `sendMessage` instead of editing the
  pinned card. The 2026-04-23 sub-agent fix covered ONE path; the RCA
  on this issue identified 7 more (deferred completion, zombie close,
  forceDone, dedup-key mismatch, etc.). All collapse to the same
  symptom: the user sees multiple separate status messages where one
  anchor message edited in place was expected.

  Root-cause-shaped fix: a new `lookupExistingMessageId` hook in
  `stream-reply-handler.ts` lets the gateway feed back the anchor
  message id from the pin manager. When the handler is about to create
  a fresh stream because `activeDraftStreams[sKey]` was deleted, it
  consults the hook; if the pin manager already knows the id for this
  turnKey, the new stream initializes with that id so the very next
  update fires `editMessageText` instead of `sendMessage`. Stale ids
  fall back gracefully via the existing not-found path.

  Closes the bug class structurally — every previously-known path now
  collapses to "edit the existing anchor."

### Added

- **`anchorMessageCount(chatId, threadId?)`** harness invariant in
  `real-gateway-harness.ts` — returns the count of fresh `sendMessage`
  calls (NOT edits) for a chat. Anything > 1 across a single logical
  turn IS the duplicate-status-message bug class. New I7 describe
  block in `real-gateway-i6-...` pins the invariant. Catches ANY
  future regression in any of the 8 RCA paths the moment a second
  anchor lands — verified to flag 5/6 historical dup-message bugs
  (#546, #251, #549, #371, #489) and all 8 paths.

- **`initialMessageId`** optional config on `createDraftStream` and
  `createStreamController`. Plumbing for the lookup hook above.
  Purely additive — back-compat verified.
## v0.5.1 — 2026-05-03

### Fixed

- **v0.5.0 release packaging — gateway service unit pointed at
  unshipped paths.** v0.5.0 introduced a split `claude` + `gateway`
  systemd-unit architecture whose `ExecStart` references
  `~/.bun/install/global/node_modules/switchroom-ai/telegram-plugin/gateway/gateway.ts`
  and `~/.bun/install/global/node_modules/switchroom-ai/bin/autoaccept.exp`,
  but the `package.json` `files` array only included `dist`,
  `profiles`, `skills`, `README.md`, `LICENSE`. Result: every
  agent's gateway service failed at boot with
  `Module not found "...telegram-plugin/gateway/gateway.ts"` until
  systemd hit the start-limit. Agents went silent on Telegram.
- **Telegram-plugin runtime deps not in root `dependencies`.**
  `@grammyjs/runner`, `@modelcontextprotocol/sdk`, `@secretlint/*`,
  `@xterm/headless`, `grammy` were declared on the workspace
  package only — not on `switchroom-ai`. Fresh consumer installs
  couldn't resolve these imports from the gateway. Promoted them to
  root `dependencies` so `npm i -g switchroom-ai` pulls them.

### Migration

`bun add -g switchroom-ai@0.5.1` (or `npm i -g switchroom-ai@0.5.1`)
then `switchroom agent restart all` — units pick up the now-shipped
source. v0.5.0 outboundDedup hotfix (#625) and per-agent card
foundations (#624, #627) are inherited from v0.5.0 unchanged.

## v0.5.0 — 2026-05-03

### Added

- **Per-agent pinned status cards (foundations + integration).** Each
  active sub-agent now optionally gets its own pinned Telegram card
  driven by a CLI-style status row (`{glyph} {verb} · {elapsed} ·
  ↓{tokens} · thought {thinking}`) and a ◼/◻/✔ TodoWrite-driven task
  block. Off by default — opt in with
  `PROGRESS_CARD_PER_AGENT_PINS=1`. Pin manager keys on `(turnKey,
  agentId)` composite; new `subagent-card.ts` registry handles
  per-card lifecycle (lazy spawn on first content event, two-pass
  k-of-n labeling, multi-card coalesce, finalize on
  `sub_agent_turn_end`). When the flag is on the parent card's
  `<blockquote expandable>` sub-agent block is suppressed (#624,
  #627).
- **One OAuth per Anthropic account** (#621) — accounts are now
  first-class: a single `claude setup-token` per account covers every
  agent, sub-agent, hook, summarizer, and cron. New
  `src/auth/account-store.ts` + `src/auth/account-refresh.ts` own
  storage, refresh, and quota state at the account level. New
  `auth-accounts` CLI verbs: add, list, label, route. Telegram
  `/auth` router updated to surface accounts.
- **Switchroom-managed token refresh loop** (#612, #429) — switchroom
  now refreshes OAuth tokens on a daemon timer instead of relying on
  Claude Code's per-process refresh. Quota state, refresh failure,
  and account drift are observable from the gateway.
- **Telegram voice-in + webhook verbs** (#619, #587, #586, #578,
  #577) — `switchroom telegram voice-in` enables Whisper
  transcription on inbound voice messages. `switchroom telegram
  webhook` adds HMAC + Bearer-authenticated webhook ingest for
  external systems.
- **Inline keyboard buttons on `reply` / `stream_reply`** (#616,
  #271) — agents can attach inline buttons to outbound messages;
  callbacks route as ordinary inbound steers.
- **Granular `send_typing` chat actions** (#617, #273) — replaces the
  single typing indicator with per-action `record_voice`,
  `upload_photo`, `find_location`, etc.
- **`ask_user` MCP tool with inline-keyboard answers** (#581, #574) —
  agents can prompt the user inline; reply lands as steer.
- **`!`-prefix interrupt marker** (#583, #575) — messages starting
  with `!` are recognised as interrupts even mid-turn.
- **Telegraph Instant View for long replies** (#588, #579) — replies
  over Telegram's 4096-char limit auto-publish to Telegraph and link
  back from the chat.
- **`send_sticker` / `send_gif` MCP tools + animation inbound**
  (#584, #576).
- **Forum topology support** (#606, epic #543) — `agent add` now
  understands forum topics; per-topic routing and pin scoping land
  cleanly.
- **Cascade-aware Telegram features** (#604, #596) — Telegram
  feature config now flows through the standard
  defaults→profile→agent cascade.
- **`switchroom telegram` CLI verb** (#605, #597 phase 1) — single
  entry point for telegram subcommands; replaces fragmented prior
  surface.
- **Opt-in `sendMessageDraft` transport for the pinned card** (#618,
  #354) — `PROGRESS_CARD_DRAFT_TRANSPORT=1` enables continuous
  bouncing-dots animation between explicit tool_use events. Spike
  pending operator validation.
- **Idle/active topic footer**, **interrupted-turn resume protocol**,
  **incremental answer streaming** — see v0.4.0 entries (no
  regressions in this release).
- **TodoWrite reducer + render template foundations** (#624) —
  parent and per-sub-agent task slices on `ProgressCardState`;
  `renderAgentCard`, `projectAgentSlice`, `glyphForTick` exposed as
  pure functions ready for the per-agent card path and reusable for
  future render surfaces.
- **Stateful test harness upgrades** (#607) — catches reaction /
  dedup / lifecycle bug classes that the prior unit tests missed.
- **IPC + bridge lifecycle coverage** (#603) — new tests reproduce
  Bug A/B/C/D regression class.
- **Real-gateway harness scaffolding** (#567, #553 Phase 3) +
  **waiting-UX v2 spec** (#582, #553 PR 1).

### Changed

- **Card gate** (#590, #553 PR 4) — progress card now appears at
  `(elapsed >= 60s) OR (any sub-agent appeared)` rather than after
  N parent tool calls. Tools alone never trigger the card.
- **Faster real-text path** (#585, #553 PR 3) — replies reach the
  user with less coalescing latency.
- **Eliminated fake placeholder text** (#553 PR 5) — the gateway no
  longer inserts synthetic "loading…" strings; placeholders are
  message-level.
- **Stable sub-agent identity** (#615, #378) — sub-agent display
  description now uses a stable fallback chain
  (description → subagentType → first prompt → 'sub-agent') rather
  than letting first emitted text flip the title mid-turn.
- **Sub-agent count must equal rendered row count** (#580) —
  expandable rows and the count badge can no longer drift.
- **Skill descriptions consolidated** — stale cross-references and
  loose descriptions cleaned up across all bundled skills (#593,
  #598).

### Fixed

- **`outboundDedup` ReferenceError class** (#625, #599, #546) —
  every outbound reply was hitting `ReferenceError` on the dedup
  check; declared the variable + added a lint guard for the bug
  class.
- **Restart-storm windows** (#608) — closes four paths where the
  watchdog could waste Claude quota by restarting an agent that was
  already running fine.
- **Watchdog: foreground sub-agent activity refreshes parent
  turn-active marker** (#610, #501) — long-running foreground
  sub-agent calls no longer trip the parent watchdog.
- **👍 reaction fires on real delivery, not turn_end** (#602, Bug
  D + Z) — the thumbs-up that signals "your message landed" now
  reflects actual delivery instead of just the turn boundary.
- **Time-based first-emit promotion** (#570, #553 F3) — single- or
  two-tool turns that take 5–30s now cross the promotion threshold
  and surface a card.
- **Reaction flush before terminal emoji** (#569, #553 F1) and
  **`👀` on raw arrival** (#568, #553 F2).
- **Preamble dedup + chat-allowed-reactions filter** (#609, #549,
  #542).
- **Premature `👍` from disconnect flush** (#600, #553 hotfix).
- **Wake-audit conversation-aware dedup** (#601, #553 follow-up).
- **`chat not found` 400s now log-only, not shutdown** (#564) — a
  single deleted chat can no longer take down the gateway.
- **Auth code redaction failure logging** (#561, #562) — auth
  redaction now reports on its own failures.
- **Graceful model-down UX** (#611, #394) — when the model
  endpoint is down, the gateway suggests `/authfallback` / `/auth`
  / `/usage` rather than a bare error.
- **Progress-card row cleanup** (#615, #378) — redundant rows
  removed; identity stabilized.

### Removed

- **`switchroom-mcp/` management server (#235).** The 4 tools it
  exposed (`switchroom_memory_search`, `switchroom_memory_stats`,
  `workspace_memory_search`, `workspace_memory_get`) had zero
  production callers — every active code path used Hindsight's MCP
  (`mcp__hindsight__*`) directly, plus Claude Code's built-in
  `Read` / `Grep` for workspace files. The server was spawning a
  child process per agent at boot for no observable benefit. New
  agents no longer get the entry; reconcile actively retracts it
  from existing agents' `settings.json` and strips
  `mcp__switchroom__*` from `permissions.allow`. **Migration:** run
  `switchroom agent reconcile <name>` for each existing agent (or
  just restart — Claude Code tolerates a missing MCP server with a
  silent log line).
- **Dead `preAllocatedDraftId` parameter** (#595) — leftover from
  an abandoned approach in #553; no callers.

### Operator notes

- **Soft rollout flags introduced this release** (all default off):
  - `PROGRESS_CARD_PER_AGENT_PINS=1` — per-agent pinned cards
    (this release).
  - `PROGRESS_CARD_DRAFT_TRANSPORT=1` — bouncing-dots draft
    transport for the pinned card (#354 spike).
  - `PROGRESS_CARD_MULTI_AGENT=0` — explicitly disable the
    multi-agent expandable section in the parent card. Default
    behaviour is to auto-activate when sub-agents are present.
- **Migration on update:** existing agents continue to work
  unchanged. To pick up the auth refactor (#621), run
  `switchroom auth accounts add <label>` once per Anthropic
  account, then `switchroom agent reconcile <name>` per agent.

## v0.4.0 — 2026-04-29

### Added
- **Sub-agent registry infrastructure** — SQLite-backed `subagents` and
  `turns` tables track every active sub-agent with liveness updates,
  tool-hook population, and a turns writer wired to gateway enqueue and
  completion. Exposes `/api/agents/:name/{turns,subagents}` REST routes
  (#333, #332, #325, #340, #342, #347).
- **Idle/active topic footer** — pure renderer computes and posts a live
  footer line on every topic reflecting idle vs. active state; wired into
  the gateway render path (#332, #338, #343).
- **Interrupted-turn resume protocol** — gateway stamps turn start/end on
  every path including kill/SIGTERM; scaffold surfaces `SWITCHROOM_PENDING_TURN`
  env-var to the agent on cold start so it can acknowledge the gap; agent
  CLAUDE.md documents the full resume flow (stages 3a–3c, 4, 5; #329–#331,
  #336, #337).
- **Incremental answer streaming** — agent replies stream token-by-token to
  Telegram via `sendMessageDraft` before the turn ends; answer-stream preview
  is retracted when the reply path wins (#195, #201, #261).
- **Vault broker** — full daemon with Unix socket, `SO_PEERCRED` + cgroup
  ACL, append-only audit log, auto-unlock via `LoadCredentialEncrypted` on
  boot, `secrets[]` schedule field, namespaced key names, and Telegram
  `/vault` subcommands (unlock/lock/status/grants list+revoke with inline
  buttons). Cgroup ACL hardened against spoofing under user delegation
  (#112, #113, #117, #153, #154, #158, #206, #207, #209, #213, #221,
  #224–#228, #241–#245).
- **Inline status-accent headers** — `reply` and `stream_reply` accept an
  `accent` parameter that prepends a `🔵 In progress…` / `✅ Done` /
  `⚠️ Issue` status line above the message body (#328).
- **Boot card overhaul** — posts on every gateway start with restart reason,
  live-watches agent service status after boot, and drops the static session
  greeting in favour of a quiet settle-gated probe sequence (#93, #95, #150,
  #178, #208, #210, #279).
- **Humanizer and calibrate skills** bundled as defaults so every agent can
  run `/humanizer` and `/humanizer-calibrate` without extra setup (#292).
- **Switchroom-worktree** MCP + CLI for parallel sub-agent code isolation;
  worktree primitives (schema, modules, env injection) wired in (#74, #75,
  #274).
- **Browser automation by default** — every agent gets Microsoft's official
  `@playwright/mcp` (pinned to `0.0.71`, snapshot mode) wired in via
  `npx -y @playwright/mcp` so `browser_navigate`, `browser_snapshot`,
  `browser_click`, `browser_type`, etc. work out of the box without a
  local Playwright install. Opt out per-agent or globally with
  `mcp_servers: { playwright: false }` (#358).
- Web dashboard `--bind` flag for LAN/Tailscale access; trust
  `Tailscale-User-Login` header for loopback requests.
- `switchroom agent rename` command for slug renames (#168).
- Native Telegram checklist messages (`send_checklist` / `update_checklist`);
  inline keyboard URL buttons on `reply`/`stream_reply`; `protect_content`
  and `quote_text` params; inbound message reaction forwarding (#272, #271,
  #273, #297, #301, #302).
- Hindsight recall now injects active directives as a separate top-of-prompt
  block (#115).
- `/foreman setup` wizard for onboarding new agents (#175).
- Cache-hit telemetry and hook content-dedupe (Phase 1 of perf work) (#110).

### Changed
- **Sub-agent Telegram visibility removed** — sub-agent identity stripped
  from prompt and tool denylist so the parent agent's Telegram session stays
  clean (#256, #260).
- Session greeting dropped; boot card now serves as the sole session-start
  signal (#150).
- `switchroom update` gains `--force` flag; CLI collapsed to
  `update`/`restart`/`version` surface with foreman and Telegram menu aligned
  (#63, #65, #67, #68, #317).
- `🔥` reaction dropped from active-work states; reactions are now
  `👀 → 🤔 → 👍` (#320, #323).
- Agent service units declare `MemoryMax=2G` / `MemoryHigh=1536M` to cap
  unbounded growth; `Restart=on-failure` recovers after OOM kill (#116).
- Progress card native HTML formatting overhaul; deterministic markdown-table
  rendering; `_..._` italic conversion fixed (#265, #275, #277, #284, #287).
- Vault broker ACL replaced with cgroup-based identity; peercred
  `ss`-lookup two-step fixed; spoofing hardened against user-delegation
  cgroup writes (#117).
- `switchroom update` reliability: bun shebang fix, rolling restart with
  settle gate, 4 further defects patched (#249, #291).

### Fixed
- Gateway boot-card crash loop broken: discriminate `unhandledRejection`,
  dedupe boot card, cache quota probe (#99, #102).
- Watchdog: bridge liveness file eliminates false-positive restarts;
  `DISCONNECT_GRACE_SECS` bumped 120 → 600s; journal-silence hang detection
  added (#97, #96, #116).
- Sub-agent watcher: skip pre-existing JSONL files at startup; exclude
  historical entries from active card; escape HTML in last-activity age
  (#83, #89, #90, #91).
- Progress card: elapsed counter stays live during sub-agent silence; cross-turn
  sub-agent visibility restored; deduplicated row rendering; reducer correctness
  (toolCount, lastCompletedTool, preamble); visibility leaks closed; sub-agent
  format redesigned (#313–#316, #318–#319, #321, #326, #334, #350, #352, #356).
- Stream-reply: record delivery before `forceCompleteTurn` (#310, #311).
- Secret-detect: one-tap unlock + auto-write for deferred secrets (#44, #143).
- Boot probe: transient carve-outs, 429 doc, `rateLimited` field; agent slug
  used for systemd probes (#208–#211, #309, #312).
- Answer-stream: honour `NO_REPLY`/`HEARTBEAT_OK` in materialisation path;
  retract preview when reply path wins (#299, #300).
- Vault broker: hard-fail when `BrokerTestOpts` set outside `NODE_ENV=test`;
  `SO_PEERCRED` via `bun:ffi` simplified and hardened (#129, #135).
- Scaffold: validate bot token via `getMe` at init; pre-approve
  `delete_message` and `get_recent_messages` tools (#121, #167, #182).
- Auth-status: lazy sync + restart settle for meta race (#171, #176, #193).
- CI: bktec brace-alternation, parallelism, and golden-test sharding fixes
  (#111, #120, #128).

## v0.3.0 — 2026-04-25

### Added
- `src/agents/create-orchestrator.ts` — new module with `createAgent()` and
  `completeCreation()` that sequences scaffold → systemd install → OAuth start
  → agent start in a single coherent flow. Used by the new `bootstrap` command
  and ready for the Phase 3 foreman bot.
- `switchroom agent bootstrap <name> --profile <p> --bot-token <t>` — one-shot
  CLI verb: scaffolds the agent, validates the BotFather token, starts an OAuth
  session, prints the URL to stdout, reads the code from stdin, and starts the
  agent. Passes `--rollback-on-fail` to remove the scaffold dir on auth failure
  (default: keep artefacts for retry).
- Phase 3a foreman bot skeleton with read-only fleet commands (status, list,
  logs) accessible over Telegram (#22).
- Phase 3b `/create-agent` multi-turn flow and destructive fleet commands
  (restart, stop, delete) with confirmation prompts (#27).
- Phase 4b operator-events: callback handler, IPC server/client, and history
  store for durable event tracking (#29).
- Telegram admin commands in gateway phase 1 — privileged bot commands routed
  directly through the gateway IPC (#33).

### Changed
- **BREAKING (upgrade note):** `scaffoldAgent()` no longer copies
  `~/.claude-home/.credentials.json` (or `~/.claude/.credentials.json`) into
  a new agent's `.claude/` directory. Each agent now gets its own fresh OAuth
  via `switchroom auth login <agent>` or `switchroom agent bootstrap <agent>`.
  Existing agents with their own `.oauth-token` or `.credentials.json` are
  unaffected — only the copy-on-scaffold step is removed.
- Scaffold and fixtures no longer embed personal implementation details;
  import overlay added for cleaner separation (#55, closes #48).
- Architecture doc added and README updated with compliance callout (#42).
- README hero image refreshed with Telegram highlight; compliance attestation
  updated for 2026-04-25 (#39).

### Fixed
- Progress-card orphan-defer race, label noise, and ghost replies resolved;
  multi-sub-agent invariant locked with regression tests (#49, closes #31 #41
  #43 #45).
- Progress-card retries bounded on Telegram 4xx errors (#10).
- Progress-card tool-name prefix stripped for human-authored labels (#9).
- Progress-card multi-sub-agent invariant test added (#12).
- CI unblocked: bktec brace-expansion + `advanceTimersByTimeAsync` polyfill
  (#54).
- CI unblocked: bktec parallelism fix + `TELEGRAM_BOT_TOKEN` stub (#38).
- Secret-detect: Anthropic OAuth browser code redaction added (#46).
- Auth: stale-token capture and `credentials.json` shadowing fixed (#40).
- Bootstrap: rollback scope widened, env-var token supported, missing outcome
  tests added (#20).
- Hardening: slug validation tightened, foreman state guards added,
  `callback_data` safety enforced (#25).
- Auth Phase 1: pane-ready probe, structured outcomes, and boot-sweep filter
  (#17).

## v0.2.5 — 2026-04-24

### Fixed
- Progress card no longer closes prematurely while background sub-agents are still running; deferred-completion visibility now waits for all active sub-agents before dismissing (#4).

### Changed
- MCP tool labels polished in the progress card for cleaner display.
- Preamble nudge added to scaffold to guide agent context on startup.

## v0.2.4 — 2026-04-24

### Fixed
- gateway IPC socket cleanup race on `systemctl restart`: old gateway's delayed `unlinkSync` could arrive after the new gateway had already bound, deleting the new socket's filesystem entry and leaving an orphaned listener. Cleanup now renames the live socket to a `.bak` sidecar at both startup and shutdown so a late old-gateway cleanup cannot destroy the current generation's file; stale `.bak` is unlinked on the next startup when no one is using it.
- session-greeting hook no longer re-fires on every SessionStart when the gateway's socket path is unlinked (orphaned socket); idempotency guard now uses `ss` directly rather than a filesystem-existence check. Added structured logging to `session-greeting.log` for future diagnosability.

## v0.2.3 — 2026-04-24

### Fixed
- gateway SIGTERM handler was clobbering stamped restart reasons, so greetings showed "clean shutdown" with no "why". Handler now preserves fresh reasons from any initiator and falls back to "systemctl: external restart" otherwise.

## v0.2.2 — 2026-04-24

### Fixed
- Removed absolute source paths baked into bundled output (build hygiene). The bundler was inlining `__filename` as a developer-machine absolute path inside `dist/cli/switchroom.js`. Switched `src/memory/scaffold-integration.ts` to `import.meta.dirname` so the resolved `switchroom-mcp/server.ts` anchor is computed at runtime from the bundle's own location. No published behaviour change, no new code paths.

## v0.2.1 — 2026-04-24

### Added
- Secret-detection pipeline: per-turn scanning of tool-use content with staging, rewrite, and audit log, plus PreToolUse and Stop hook scaffolding and a gateway-side intercept so leaked credentials are caught before they leave the agent (#47, #48, #49, #51, #54).
- `switchroom vault sweep` — retroactive scrubber that walks existing transcripts and vault-isches already-stored secrets in place (#50).
- Restart-reason surfaced in the session-greeting card so each agent's greeting tells you *why* the last restart happened (planned, crash, OOM, manual, etc.) (#58).

### Changed
- Telegram gateway hardening: startup mutex prevents duplicate bridges racing on launch, a 35s SIGTERM drain lets in-flight turns finish cleanly, and state transitions are now logged for post-mortems (#52, #53).
- CI pipeline: cache-aware `bun install` and serialized eval steps cut wall time and remove flakes from parallel runs (#57).
- Gateway wiring: pid-file, session-marker, and typing-wrap are now threaded through the gateway consistently (#45).

### Fixed
- "Recovered from unexpected restart" banner no longer fires on planned shutdowns — the 30s clean-shutdown marker preserve window aligns with the 60s banner-suppression window so orderly restarts stay quiet (#55).
- Regenerated `bun.lock` to match `package.json`, unbreaking Buildkite (#56).

## v0.2.0 — 2026-04-23

Bumps the package to v0.2.0 and threads build provenance through to the greeting card so users can see which release each agent is running and how stale it is.
