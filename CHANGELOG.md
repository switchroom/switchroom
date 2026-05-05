# Changelog

## [Unreleased]

### Added

- **tmux supervisor pre-fanout hardening (#725)** — PID resolver walks
  the unit cgroup to pick the heaviest-RSS claude/node process, so
  boot cards and `getAgentStatus` no longer report the ~2 MB tmux
  server PID under `Type=forking`. Mirrors `agent_main_pid()` in
  `bin/bridge-watchdog.sh`. Companion runbook for the canary fanout
  lives at [`docs/tmux-supervisor-fanout.md`](docs/tmux-supervisor-fanout.md).
- **tmux supervisor opt-in flag (#725 Phase 1)** — new per-agent
  `experimental.tmux_supervisor` boolean (default `false`). When `true`,
  the systemd unit replaces `script -qfc` with `tmux new-session` so
  external `tmux send-keys` can drive the running Claude REPL (foundation
  for #163 `/remotecontrol` and broader slash-command passthrough). Ships
  a managed `tmux.conf` per agent (`default-terminal xterm-256color`,
  `history-limit 100000`, `status off`, `remain-on-exit off`).
  Patches `bin/autoaccept.exp` with `set timeout 30` and `interact { eof
  exit }` so external send-keys reaches Claude. `switchroom agent attach`
  now actually attaches to the tmux session when the flag is on.
- **Webhook dispatch (#715)** — verified webhook events now trigger fresh
  `claude -p` invocations so agents can react in Telegram without polling
  `webhook-events.jsonl` manually.
  - New module `src/web/webhook-dispatch.ts`:
    - **Static matcher** (`event`, `actions`, `labels_any`, `labels_all`,
      `exclude_authors`) — no CEL/expression parser; fully JSON-Schema-validatable.
    - **`{{field}}` template rendering** against a flat helper bag:
      `repo`, `number`, `title`, `html_url`, `author`, `labels`, `action`, `event`.
    - **Cooldown** — same `(event, repo, number, rule-index)` combination
      coalesces within the window. State on disk per-agent at
      `<agent>/telegram/webhook-cooldown.json`.
    - **Quiet hours** — wraps midnight when `start > end`. Skips dispatch
      entirely (event still in JSONL for manual review).
    - **`spawnAgentOneShot()`** — same env setup as `buildCronScript` in
      `scaffold.ts`: OAuth forced, `ANTHROPIC_API_KEY` unset, token injected
      from `.oauth-token`, `CLAUDE_CONFIG_DIR` and `SWITCHROOM_AGENT_NAME` set.
  - `WebhookHandlerArgs` gains optional `dispatchConfig` field; handler
    calls `evaluateDispatch()` after JSONL append (non-fatal — dispatch
    errors never downgrade the 202).
  - `webhook_dispatch` added to `TelegramChannelSchema` in
    `src/config/schema.ts`; cascades via existing channels deep-merge.
  - **CLI**: `switchroom telegram dispatch test --agent <name> --payload
    <file.json> --event <type>` — dry-runs matchers offline, prints which
    rules match and the rendered prompt without spawning.
  - Test fixtures in `tests/fixtures/` (GitHub PR opened/labeled/dependabot/push).
  - 35 unit tests covering all matcher combinations, template rendering,
    cooldown state machine, quiet hours, and `evaluateDispatch` integration.

- **Webhook ingest hardening (#714)** — two defenses added to
  `src/web/webhook-handler.ts` before auto-dispatch ships:
  - **Dedup by `X-GitHub-Delivery`**: per-agent LRU (1000 entries, 24h
    retention) backed by `~/.switchroom/agents/<agent>/telegram/webhook-dedup.json`.
    Replay returns 200 `{ok:true,deduped:true}` and skips JSONL append.
    Generic source has no delivery header — dedup is skipped silently.
  - **Per-source token-bucket rate limit**: off by default; opt-in via
    `channels.telegram.webhook_rate_limit.rpm` in switchroom.yaml (set
    e.g. `rpm: 60` for one request/sec sustained, burst equal to rpm).
    When enabled, exceeding the limit returns 429 with `Retry-After`.
    First throttle event per `(agent, source)` per 60s window is written
    to `<agent>/telegram/issues.jsonl` for Telegram visibility.
  - `webhook_rate_limit` added to `TelegramChannelSchema` in
    `src/config/schema.ts`; cascades via the existing channels deep-merge.

## v0.6.14 — 2026-05-05

Bundle re-release. v0.6.13's /reauth removal is in this version too —
v0.6.13 was tagged on GitHub but the npm publish was rejected by
prepublishOnly (the architectural-pin test for `redactAuthCodeMessage`
call sites needed its floor lowered after the /reauth handler was
removed). v0.6.14 ships both:

- **#705** — remove /reauth typed Telegram command
- **#706** — update redactAuthCodeMessage call-site pin (test floor
  3 → 2; docstring updated to reflect the 2 remaining call sites:
  generic intercept + /auth code intent)

The v0.6.13 git tag stays for historical accuracy; npm consumers
should install v0.6.14.

## v0.6.13 — 2026-05-05

### Removed

- **`/reauth` typed Telegram command gone.** Same consolidation
  rationale as `/authfallback` in v0.6.12: the `/auth` dashboard's
  `🔄 Reauth default` button fires the identical flow (calls
  `runSwitchroomAuthCommand` with `auth reauth <agent>` and seeds
  `pendingReauthFlows`). Two paths to the same outcome made the auth
  surface confusing.
  - The OAuth code paste-back still works without a typed command —
    the generic message intercept watches `pendingReauthFlows` and
    exchanges any code-shaped paste automatically.
  - Slash-menu entry, autocomplete name list, and help-text line all
    dropped.
  - The `/auth` slash-menu description updated to reflect the
    consolidated surface ("Auth dashboard — accounts, quota, reauth,
    switch primary").

### Tests

- `welcome-text` regression test pinning that `/reauth` is absent
  from the menu, autocomplete, and as a top-level help entry — same
  shape as the `/authfallback` regression test from v0.6.12.

## v0.6.12 — 2026-05-05

### Removed

- **`/authfallback` typed Telegram command gone.** Duplicated the
  work of the dashboard's Switch primary picker (operator-facing) and
  the auto-fallback poller (transparent on-quota-wall case). Two
  paths to the same outcome confused operators. The
  `runAutoFallbackCheck` function and the `case 'fallback':` callback
  dispatch stay in the codebase: any pinned messages from earlier
  versions still work, and the auto-fallback poller still calls
  `runAutoFallbackCheck` directly.
  - Slash-menu entry, autocomplete name list, and help-text line
    all dropped.
  - Doc comments updated to point at `/auth` Switch primary instead.

### Tests (regression coverage for v0.6.10–v0.6.12)

- `welcome-text` — pin that `/authfallback` is absent from the slash
  menu, autocomplete list, AND help text (3 separate surfaces).
- `auth-dashboard-v3b` — main board renders ≤6 keyboard rows with
  three accounts (catches the v3b 8-button explosion); no Promote
  callback ever targets the active label (catches the screenshot
  bug); `[⚠️ Fall back now]` button stays absent under every quotaHot
  / slot-health / accounts-shape combination.
- `quota-check` — boot-warm + delayed sync-read sequence returns
  last-known data after 8.5min (the screenshot reproduction window);
  `prefetchAccountQuotaIfStale` re-probes once past TTL but no-ops
  while fresh; cache TTL pinned ≥60s so a future PR can't re-create
  the empty-row bug.

## v0.6.11 — 2026-05-05

### Fixed

- **Per-account quota mini-bars now persist past the cache TTL.**
  Pre-v0.6.11 `getCachedAccountQuota` treated stale entries as a
  miss, which meant the boot-warmed cache vanished after 30s and the
  operator saw empty quota rows on the first `/auth` tap of any
  session past that window. Now the sync read returns whatever's
  cached regardless of staleness; the background prefetch
  (`prefetchAccountQuotaIfStale`) keeps the cache fresh on every
  dashboard render. Cache TTL also bumped from 30s → 5min — quota
  doesn't move that fast, and the prefetch path keeps it fresh
  whenever the operator interacts.

### Removed

- **`[⚠️ Fall back now]` button gone from `/auth`.** The Switch
  primary picker (v0.6.10) is the operator-facing surface for "active
  is hot, swap to a fallback"; the auto-fallback poller still handles
  the automatic case when the active hits its quota wall. Two paths
  doing the same thing was confusing. The `fallback` callback verb
  stays in the parser/dispatcher for legacy reachability of any
  pinned messages bearing the pre-v0.6.11 button.

## v0.6.10 — 2026-05-05

### Changed

- **Auth card v3c — Switch primary picker replaces button flood.**
  v3b's per-fallback `⤴ Promote` rows + per-account drilldowns
  produced 6+ buttons stacked vertically with three accounts. v3c
  collapses them into a single `🔀 Switch primary →` entry that
  opens a picker sub-keyboard listing fallbacks as one-tap promote
  targets. The picker IS the confirmation surface (no second confirm
  screen). Cancel returns to the main dashboard via refresh.
  Result: ~4 buttons on the main board instead of 8 with three
  accounts, scaling cleanly to 5+. Legacy `apr`/`cpr` callback verbs
  preserved for messages already pinned with the v3b layout.

### Fixed

- **Per-account quota mini-bars now appear on first `/auth` after
  agent restart** — the gateway boot path eager-warms the in-process
  quota cache for every account. Without this, the cache was cold on
  first render → no mini-bars → operator had to tap Refresh.
- **Cache re-warm after every auth-mutating dashboard tap** — every
  enable / disable / promote / share / account-rm now schedules a
  background quota probe alongside the existing cache invalidation,
  so the post-action dashboard render sees fresh quota.

## v0.6.9 — 2026-05-05

### Added

- **Auth card v3b (#699)** — Telegram `/auth` answers three operator
  questions in one glance:
  - Which account is driving traffic right now? `▶ pixsoul@gmail.com`
    + inline mini-bars (`5h ██░░░░ 47%  ·  7d ░░░░░░ 12%`).
  - Which accounts are failover targets? Indented under
    `Fallback ↓:`, in YAML-list order (the actual failover order,
    load-bearing post-#697).
  - How do I switch primary without leaving Telegram? `⤴ Promote`
    button under each fallback, two-stage confirm.
- **`switchroom auth promote <label> <agents...>`** — moves a label
  to position 0 of each agent's `auth.accounts:`. Refuses when not
  already enabled (promote reorders; enable enables). Idempotent at
  the already-primary boundary.
- **`auth account list --json`** gains `primaryForAgents: string[]`
  so the dashboard can mark each agent's active account.

### Fixed

- **Slots + Pool sections hide when the active account is known
  (#699)** — under the new account model the Slots row and Pool line
  duplicate the `▶ <label>` active-account row 1:1, just with an
  internal slot ID like "default" instead of the operator's email.
  Both sections are now suppressed when an active-account signal is
  present, leaving a single source of truth for "what's active."
  Bootstrap state (no accounts yet) and older CLIs without
  `primaryForAgents` keep the legacy Slots layout for graceful
  degradation.

## v0.6.8 — 2026-05-05

### Added

- **Per-account quota utilization on `/auth` (#696)** — the Telegram
  auth dashboard now renders 5h + 7d quota under each account row
  alongside the existing per-slot probe (`5h: 47% · 7d: 12%`, or
  `exhausted · resets in Nh Mm`). Wired through a new
  `fetchAccountQuota(label)` helper that probes Anthropic's
  `anthropic-ratelimit-unified-*` headers using the account's stored
  access token, with a 30 s in-process cache and background prefetch.
  Cache is invalidated on `enable` / `disable` / `share` / `rm` so
  the dashboard stays consistent with the YAML cascade.

### Fixed

- **`auth enable <fallback>` no longer hot-swaps the active fanout
  (#697)** — adding an account as a fallback used to overwrite each
  agent's runtime credentials with the just-enabled label, silently
  flipping the primary. Now `enable` preserves the YAML-list primary
  on each agent (the first entry in `auth.accounts:`) and only fans
  out the just-enabled label when an agent has no prior accounts
  (fresh-fleet bootstrap). Console output distinguishes
  `fanned out (now active)` from `added as fallback (active stays X)`,
  and the restart hint is suppressed when no runtime change occurred.
  New helper `groupAgentsByPrimaryAccount` unit-tested across 7
  cases. Matters whenever an operator runs a multi-account fleet —
  the bug was invisible on a single-account install.

## v0.6.7 — 2026-05-05

### Added

- **Account labels accept `@` and `+`** (#694) — operators can now
  label Anthropic accounts by the email they signed up with, e.g.
  `pixsoul@gmail.com`, `ken+work@example.com`. Regex expanded from
  `[A-Za-z0-9._-]+` to `[A-Za-z0-9._@+-]+` (max 64 chars) in all
  three places that must stay in sync — CLI canonical
  (`account-store.ts:LABEL_RE`), Telegram verb parser
  (`auth-slot-parser.ts:ACCOUNT_LABEL_RE`), and dashboard
  callback-data validator (`auth-dashboard.ts:isSafeAccountLabel`).
  - **Still rejected:** `:` (callback_data separator), `/` `\\`
    (path-traversal), whitespace, quotes, shell metas, non-ASCII.
  - Use `switchroom auth account rename <old> <new>` (PR #653) to
    relabel an existing account into the email-shape form.

## v0.6.6 — 2026-05-05

### Added

- **Two-zone status card v2 (#662, multi-PR rollup).** Reworked the
  pinned progress card into a clearer top-zone (`Main` agent state)
  and bottom-zone (sub-agents) layout. Includes background sub-agent
  persistence (closes #64), per-fleet-member stuck escalation, fleet
  state + watcher exposure, and the cutover off the legacy renderer
  (`TWO_ZONE_CARD=1` shipped to default-on). PRs: #663, #664, #665,
  #666, #670; design doc at `reference/status-card-design.md` (#661,
  #667).
- **`/auth` v3a — accounts-first dashboard layout (#669).** Telegram
  `/auth` now leads with the account inventory and drills into
  per-account detail on tap, replacing the slot-first nav.
- **`/auth` account rename (#653).** Telegram-native rotation of an
  account's display label without dropping/re-adding.
- **Verbose `tg-post` logging for outbound API calls (#659).**
  Operator-side debugging hook for the gateway's Telegram traffic.

### Fixed

- **Deterministic double-message fix via card takeover (#654/#655).**
  When a long turn (>60s) ended without `reply` / `stream_reply` and
  fell back to turn-flush, the user saw both the pinned progress card
  AND a fresh turn-flush bubble. New `progressDriver.takeOverCard`
  hook lets the gateway preempt the driver's "Done" edit and rewrite
  the pinned card with the answer text in place — single message in
  the chat, no race window. Regression test pins all three branches
  (card not yet posted / card posted / edit failure fallback).
- **`stream_reply` HTML parse failures now edit, not duplicate
  (#657/#685).** Stream-reply's HTML-parse error path was emitting a
  fresh `sendMessage` instead of editing the existing draft, doubling
  up answers when the parser tripped on bad markup.
- **Drop materialize on no-reply turn_end; turn-flush owns the emit
  (#656/#660).** Removed the legacy materialize-on-turn_end that was
  competing with the turn-flush safety net.
- **Boot-time orphan progress card reaper (#689/#692).** Pinned cards
  abandoned by a previous gateway crash get reaped at the next boot
  instead of lingering until the next turn on that chat.
- **Flush progress cards on SIGTERM (#689/#690).** Graceful shutdown
  now closes any in-flight cards so `systemctl --user restart` doesn't
  leave "Working…" pinned forever.
- **Unfreeze progress card timer + surface pin failures (#687).**
  Card heartbeat couldn't recover from a single transient API failure;
  now retries cleanly and surfaces persistent failures to the operator.
- **Emoji header counters + active-in-flight bullet (#684).**
  Status card header counters render correctly on Telegram clients
  that don't support combining-character sequences; in-flight tasks
  get an explicit bullet glyph.
- **Move TTL eviction off the heartbeat (#674).** Old chat states
  were piling up in driver memory because TTL eviction only ran when
  the heartbeat fired — heartbeat dies → memory leak.
- **`firePin` leak and `phaseFor` silent-end precedence (#673).**
  Two narrow correctness bugs in the pin lifecycle.
- **Export `SWITCHROOM_AGENT_NAME` in cron-N.sh template (#676).**
  Cron-spawned turns previously couldn't self-target via slash
  commands because the agent-name env var was missing from the
  scaffolded cron wrappers.

### Changed

- **Worker worktree isolation moved from global defaults to the `coding`
  profile (#682).** `examples/switchroom.yaml` previously shipped
  `defaults.subagents.worker.isolation: worktree`, which hard-failed
  every agent whose cwd was not a git repo (most switchroom agents,
  which run from `~/.switchroom/agents/<name>`). The default now lives
  in an inline `profiles.coding` block; agents pick it up via
  `extends: coding`. Sub-agent merge is now field-level on name
  conflict (a profile or agent overriding one field no longer drops the
  rest of the worker definition). Operators whose existing yaml still
  carries the old global default see a one-time NOTICE on the next
  config load — no auto-rewrite. Migration: add `extends: coding` to
  coding-shaped agents, or paste the two-line override directly under
  those agents.

### Engineering

- **Unified progress-card close path + convergence test (#677).**
  Refactored the four divergent close paths (turn_end, force-complete,
  zombie-close, abandon) into one helper, with a convergence test
  asserting they all reach the same final state.
- **Backfill 10 missing test cases for progress-card driver (#678,
  #681).** Closes coverage gaps in the driver's edge cases:
  cross-turn carry-over, orphan sub-agents, deferred completion
  races.
- **`beginTurnEnd` helper + native `console.warn` cleanup (#688).**
  Internal: extract the turn-end ceremony into a single helper.
- **Bridge-watchdog test isolation (#691/#693).** Watchdog tests
  now run with HOME isolated from real agent JSONLs so they can't
  read live state.

## v0.6.5 — 2026-05-04

### Added

- **Web dashboard trusts Tailscale peer source IPs (#651).** Requests
  whose source IP falls in `100.64.0.0/10` (IPv4 tailnet allocation)
  or `fd7a:115c:a1e0::/48` (IPv6 tailnet ULA) bypass the bearer-token
  gate. Tailscale's WireGuard layer already authenticates every peer
  against the tailnet, so a phone bookmarking
  `http://<host>.taildXXXX.ts.net:8080/` now works with zero token
  ceremony.
  - Bonus while in here: `?token=X` URL → httpOnly cookie redirect.
    Non-tailnet users can bookmark a one-time URL and never need the
    token in a URL afterwards.
  - **Operator override** — set `SWITCHROOM_WEB_REQUIRE_TOKEN=1` to
    disable the implicit-trust path. Use when sharing a tailnet with
    untrusted machines or running a multi-tenant tailnet ACL setup.

### Migration

```
bun add -g switchroom-ai@0.6.5     # or npm i -g
systemctl --user restart switchroom-web   # if running as a unit
```

The bearer-token, cookie, and `Tailscale-User-Login` paths are
unchanged — existing CLI / WebSocket / `tailscale serve` setups keep
working.

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
