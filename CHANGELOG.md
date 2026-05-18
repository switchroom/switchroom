# Changelog

## v0.12.4 — fix: hostd `update_apply`/`apply` stranded the fleet (missing apply assets)

In-Telegram `/update apply` by an admin agent (→ hostd) silently failed and left the **whole fleet stranded on the old image** with the agent's turn wedged. hostd's image baked only the CLI bundle, not the assets `switchroom apply` resolves relative to the CLI module (`profiles/` via `resolve(import.meta.dirname,"../../profiles")`, and the vendored hindsight plugin). So hostd's `apply` died `Profile not found: default (searched /opt/switchroom/profiles)` **after `pull-images`, before `recreate-containers`**. (Agent images deliberately don't bake these either — agents never run `apply`; hostd is the one container that does.)

This makes the operator's intended flow reliable — admin agent initiates `/update apply` from Telegram, operator attests the card, fleet updates — with agents staying unprivileged (hostd remains the audited broker; no container gets host root).

### Changes

#### Fixes

- **fix(hostd):** `Dockerfile.hostd` now bakes `profiles/` → `/opt/switchroom/profiles` and `vendor/hindsight-memory/` → `/opt/switchroom/vendor/hindsight-memory` (exactly the paths the bundled CLI resolves at runtime), so hostd's in-container `apply` behaves like host-side. Plus a **fail-fast asset preflight** in `handleUpdateApply`/`handleApply`: if those assets are missing, hostd refuses with a clear actionable error **before pulling or changing anything** (same principle as the `--rebuild` guard) instead of pulling-then-stranding the fleet — and future-proofs the per-asset fragility. **The behaviour change ships in the rebuilt `switchroom-hostd` GHCR image**; the running daemon picks it up via `switchroom update`'s refresh-hostd step. (#1510)

## v0.12.3 — fix: the v0.12.2 `--rebuild` guard never fired on nvm/npm-global

v0.12.2's `--rebuild` published-install guardrail was ineffective on the exact install model it protects. It detected "source checkout" as *any* `.git` within 10 parent directories — but **nvm is itself a git clone** (`~/.nvm/.git` exists) and an npm-global install lives under `~/.nvm/…`, so the guard saw a `.git` ancestor and **allowed** `--rebuild` on a published host (a dotfiles `$HOME` git repo defeats it the same way). The guard now requires a directory that has **both** a `.git` (dir *or* file — git worktrees still count) **and** a `package.json` whose `name` is `switchroom`, at the same level — so nvm/dotfiles `.git` dirs and installed package dirs both correctly refuse, while real checkouts and worktrees are still allowed. Anyone on v0.12.2 should upgrade: until 0.12.3, `update --rebuild` on a published host silently drifts it off the released artifacts instead of refusing.

### Changes

#### Fixes

- **fix(update):** `--rebuild` guard requires an actual switchroom source checkout (`.git` + switchroom `package.json` at the same dir), not any `.git` ancestor — closes the v0.12.2 defect where nvm's own `~/.nvm/.git` (and dotfiles `$HOME/.git`) made every npm-global install look like a checkout and the guard never fired. New `runningFromSwitchroomCheckout()`; `isGitCheckout` retained (unused by the guard) so nothing else regresses; refusal message corrected. Verified live on a published host. (#1508)

## v0.12.2 — published-install guardrail for `update --rebuild`

`switchroom update --rebuild` (git pull + build from source) is a source-checkout / maintainer-only operation. On a published install (npm-global / GHCR-image host) it is now **hard-refused fail-fast**: a preflight in `runUpdate` refuses *before any step runs* (and before the `--check` plan) with exit 2 and the correct remediation — `npm i -g switchroom@latest && switchroom update`. Previously it died mid-pipeline (after `pull-images`) with advice ("invoke from a source checkout") that's wrong for a consumer host. Source checkouts — including git worktrees — are byte-unchanged; this only makes a published host structurally un-driftable off the reviewed, CI-published release via that flag.

### Changes

#### Fixes

- **fix(update):** `--rebuild` hard-refuses on a published install (fail-fast preflight, exit 2, nothing runs) with the published-path remediation; shared `rebuildRefusalMessage()` is the single source of truth (preflight + in-step defence-in-depth); header/option help corrected (it claimed "auto-skipped"; it refuses). Maintainer source-checkout behaviour unchanged. (#1506)

## v0.12.1 — Claude-native skill authoring; doctor/vault-broker hardening

Headline: skill authoring is now **Claude-native and gated by review, not by tooling**. An agent creates a skill for itself the same way anyone uses Claude — it writes files into its own `$CLAUDE_CONFIG_DIR/skills/<slug>/` (persistent, reconcile-safe, discovered next session), guided by the bundled `skill-creator` skill and a non-blocking validator hook. There is **no** skill-authoring/publish tool, CLI, or broker write path. Sharing a skill with the rest of the fleet is a **reviewed pull request** (it becomes a bundled-default, opt-out per agent, or a `skills:`-cascade entry from `switchroom.skills_dir`), distributed by the normal reconcile path — never a runtime action. Also: more honest `doctor` visibility and several vault-broker ACL correctness fixes.

### Changes

#### Features

- **feat(skill-author):** native-by-default skill authoring. Agent-scope skills are authored with plain `Write`/`Edit` into `$CLAUDE_CONFIG_DIR/skills/<slug>/`; a non-blocking `PreToolUse` linter nudges toward a well-formed skill (the only hard stop is the 2 MiB per-skill cap). The deprecated `skill_create/edit/read/delete` MCP + CLI shim was **removed** (closing the `--version`-shadowing bug class, #1492). An interim runtime `skill_publish`/`skill_unpublish` path was added and then **removed** in favour of review-via-PR — net: no privileged runtime authoring or publish path exists. Fleet-wide sharing = a reviewed PR (bundled-default opt-out via `bundled_skills`, or `skills:` cascade). See [docs/skills.md](docs/skills.md); design record in [docs/rfcs/skill-authoring-native.md](docs/rfcs/skill-authoring-native.md). (#1490–#1502)
- **feat(doctor):** hostd visibility + image-drift WARN (#1471); vault operator-lockout + per-agent secret-access ACL surfacing (#1473).
- **feat(compose):** pin the Claude runtime version for the immutable 24/7 fleet — perf + correctness.

#### Fixes

- **fix(vault-broker):** fall through to the standing ACL when a presented token is unusable (`get`/`list`); an agent may read its OWN configured `bot_token`; generous `unlock` timeout — no false "Timeout" on a slow decrypt (RFC J Phase 4b).
- **fix(gateway):** `vault_request_access` short-circuits when a standing ACL already covers the key.
- **fix(apply):** restore operator ownership of `~/.switchroom` after a self-elevated apply (#1473).
- **fix(docker):** bake the switchroom CLI into the broker image — RFC J Phase 3b (#1485).
- **fix(auth):** remaining user-facing `--from-oauth` → `--via-claude` (doctor + setup).
- **fix(boot-probes):** `/status` lists every skill bucketed by source (#1467).
- **fix(doctor):** MFF probes are per-agent + WS6-F2 agent-private aware.
- **fix(privacy):** scrub operator PII from the tracked tree; extend the PII regression gate (incl. an `sk-ant` rule).
- **fix(ci):** drop the broken docker-smoke spike that permanently failed promote-to-dev.

#### Internal

- **chore(deps):** GitHub Actions bumps — checkout, setup-node, setup-python, paths-filter, docker/build-push-action.
- **docs(readme):** align with the v0.12.0 architecture + command surface.

## v0.12.0 — user-owned SOUL.md + broker healthcheck honesty + legacy-state deprecations

Headline: agent persona (`workspace/SOUL.md`) becomes a user-owned, seed-once file — switchroom seeds it once and never overwrites it again, matching the OpenClaw/Hermes "my persona sticks" expectation while the machinery (`CLAUDE.md`) keeps propagating fleet-wide. Also: the vault-broker healthcheck now reports honestly (a locked/never-unlocked broker reads unhealthy instead of false-healthy), the operator unlock hint is corrected, and the long-lived `clerk → switchroom` rename shims are scheduled for removal. No automatic state migration is performed.

### Changes

#### Features

- **feat(persona):** `workspace/SOUL.md` is now **user-owned** — seeded once (from the setup wizard's new per-agent persona prompts, or the profile `SOUL.md.hbs` + `soul:` config when skipped) and then **never overwritten** by `apply`/`reconcile`/`update`. This is the deliberate inverse of the root `CLAUDE.md`, which stays switchroom-managed so machinery/template updates keep propagating fleet-wide. New `switchroom soul {path,show,reset}` verb; `soul reset <agent>` re-seeds from the agent's current profile after backing the existing file up to `SOUL.md.bak`. `soul:` config and profile `SOUL.md.hbs` are now seed-time inputs only. See [docs/configuration.md § Persona & SOUL.md ownership](docs/configuration.md#persona--soulmd-ownership). (#1458)
- **feat(update-flow):** end-to-end release-channel/pin redesign. A `release` config block (`channel: dev|rc|latest` *or* `pin: sha-…|vX.Y.Z`, mutually exclusive, per-agent REPLACES root) at every cascade layer (#1415); `switchroom apply --channel/--pin` + `resolveImageTag()` threading the resolved tag into compose/CLI/hostd/MCP (#1431); gateway boot-card surfaces the last `update_apply` audit outcome and honors `channels.telegram.enabled` in `start.sh` (#1456); dual-tag (`:dev` + `:sha-<7>`) docker-images workflow + operator `promote.yml` (dev→rc→latest, retag-without-rebuild) (#1461).
- **feat(vault):** auto-unlock is the unattended default — RFC J Phase 1 (#1454).
- **feat(auth-google):** native Google Drive onboarding — self-documenting `auth google connect` wizard (#1344), opt-in Drive **write** scope via `--write` (#1354), refresh-token seed launcher + per-agent scaffold wiring (#1355).
- **feat(web):** dashboard build-out — auth-broker/hindsight/hostd health (#1359), Google Workspace + cron Schedule panels (#1360), read-only Approvals kernel-ledger panel (#1363), real per-account usage % + Summary tab (#1381).
- **feat(audit):** tamper-evident hash-chain for the vault and hostd audit logs — sec WS10-F2 (#1433).
- **feat(doctor):** flags inlined plaintext secrets in `switchroom.yaml` — sec WS6-F3 (#1434).
- **feat(kernel):** read-only host operator socket, deny-by-default (#1362).
- **feat(telegram):** automatic HTML→plaintext fallback on a Telegram 400 parse-reject (#1356).
- **feat(scheduler):** boot-time notice for runs dropped past the replay window (no more silent drops); deprecate the unused `model:` schedule field; rebuilt scheduling docs (#1424).
- **feat(agent-config):** restart-required readback on `skill_install` / `schedule add` / `schedule remove` (#1430).
- **feat(hostd-audit):** persist stderr/stdout tails so failed mutations survive a container recreate (#1351).

#### Fixes

- **fix(install):** fresh-install agents now boot authenticated end-to-end — `createMinimalClaudeConfig()` writes `hasCompletedOnboarding:true`, install docs reorder auth after fleet-up (the 2026-05-17 blank-server validation wedge) (#1422).
- **fix(setup):** persist per-agent bot tokens to the vault (#1428); bootstrap config to `~/.switchroom` mirroring `findConfigFile` (#1426).
- **fix(vault-broker):** route the host CLI to the containerized broker — RFC J Phase 3 (#1457).
- **fix(oauth):** correct device-code client type + 401 `invalid_client` tier-fallthrough (#1352).
- **fix(quota):** align `/auth show` + boot card on the broker-canonical quota (#1345).
- **fix(auth-google):** `account add` resolves `vault:` refs via the broker (#1348); connect wizard writes secrets via the vault-broker, not the file (#1347).
- **fix(drive-mcp):** reliability hardening closing the silent-failure class (#1368); doctor EACCES false-positive + pin-regression (#1369); pin `USER_GOOGLE_EMAIL` to the seeded account (#1367); pin `aiofile==3.8.8` via `uvx --with` (#1365); correct uvx exec name `workspace-mcp` (#1364); inject gdrive into `.mcp.json` not just `settings.json` (#1358); sanitize Pydantic anyOf-root input schemas + boot tool validation (#1388).
- **fix(scaffold):** wire gdrive MCP env + trust scaffolded servers (#1366); honor `SWITCHROOM_MEMORY_BACKEND=none` (#1425).
- **fix(docker):** install `uv`/`uvx` in the agent image — the Drive MCP launcher needs it (#1361).
- **fix(web):** dashboard caught up with v0.7 Docker + RFC-H migrations (#1357); usable under fleet load — batched docker status + tailscale-serve origin (#1380).
- **fix(build):** ship the web dashboard UI in the bundled CLI (`dist/cli/ui`) (#1374).
- **fix(examples):** one bot per agent — ship 1 active agent, others commented with their own `bot_token` (#1423).
- **fix(codex):** correct pre-Docker assumptions on live agent/operator paths (#1376).
- **fix(docs):** `vault.md` wrongly said `set` auto-creates the store (#1379).

#### Security (epic #1400 / workstream hardening)

- **fix(gateway):** require operator authz on the `apv:` approval callback (WS7-F1, #1404); fleet-admin verbs operator-private (WS7-F2, #1408); `/auth` operator-private (WS7-F2b, #1414).
- **fix(hostd):** harden `agent_exec` argv — `--` separator + NUL/CR/LF rejection (#1411); reject all C0/DEL controls + cap argv element size (#1429).
- **fix(scaffold):** de-pre-approve mutating hostd MCP verbs (#1427).
- **fix(approval-kernel):** listener-identity ACL on consume/revoke/record + 128-bit request ids (#1406).
- **fix(auth-broker):** symlink-guard the per-agent credential mirror (#1409).
- **fix(compose):** per-agent `credentials/` scope + migration-safe doctor warn (WS6-F2, #1407); UID-collision hard-fail + non-root agent image + logdir perms (WS6-F4/F5/F6, #1435).
- **fix(atomic):** `O_NOFOLLOW` + `O_EXCL` on the broker tempfile open (#1444).
- **fix(audit,doctor):** canonical `agent_name` attribution + audit-integrity doctor check (WS10-F6/F4, #1436).
- **fix(agent):** image-baked unstrippable security-hooks plugin (WS8-F1, #1432).
- **feat(sec):** opt-in strict inter-agent network isolation (WS6-F1, #1446).
- **ci(security):** close the sentinel path-filter blind spot + SHA-pin all actions (WS9-F1/F6, #1405); image provenance/SBOM + base images pinned `@sha256` (WS9-F3/F4, #1437).
- **docs(CLAUDE.md):** reconcile CI/governance prose to actual posture (WS9-F2, #1412).

#### Reliability / Ops

- **fix(supervisor):** exponential backoff + never-give-up restart policy — RFC J Phase 2 (#1453).
- **fix(broker):** honest, fail-closed healthcheck (a locked/never-unlocked broker reads **unhealthy** instead of false-healthy — the 2026-05-17 install-validation failure mode); corrected operator unlock hint to `switchroom vault broker unlock` — RFC J Phase 4a (#1455).
- **ci:** real sentinel pattern for required checks — docs-only PRs hard-block, fixes #1331 (#1350).

#### Docs

- **docs(audit):** repo-wide documentation audit across all tiers — onboarding-breaking + operator-hazard defects (#1385), hygiene + structure (#1386), coverage gaps + reference Status banners (#1387).
- **docs:** RFC J spec — vault-broker resilience & default auto-unlock (#1450); code-grounded diagram regeneration specs (#1343); `applyCronChangesHot` prose corrected (#1459); retire pre-Docker / pre-RFC-H narrative in user docs + agent CLAUDE.md/skills (#1378, #1377); Drive access model corrected + stale pin literals retired (#1371).

#### Chore / CI

- **chore(deps):** GitHub Actions major-version bumps — `actions/upload-artifact` 4→7, `actions/download-artifact` 4→8, `docker/login-action` 3→4, `docker/setup-qemu-action` 3→4, `docker/setup-buildx-action` 3→4 (Node24 runtime; shared Artifacts-v4 backend, no workflow behavior change) (#1439–#1443).
- **fix(ci):** constrain Dependabot docker to digest/patch, not Node major bumps (#1460).
- **chore/test:** Tier-1/2 dead-code + stale-comment cleanup + CI-eval-summary fix (#1370, #1372); strip residual Buildkite cruft post-GHA-cutover (#1353); evals cover restart-required readback + skip-notice guidance (#1452); docker tests pass `--user 0` to read-only-rootfs + cap_drop probes (#1451); sharpen auth-google edge-case messages (#1349).

#### Deprecations

- **deprecate(state):** `switchroom doctor` now WARNs (exit 0) when legacy `~/.clerk` state or the v0.6 host-side `~/.switchroom/vault-broker.sock` is present; any CLI/agent invocation that reads from `~/.clerk` emits a one-time stderr deprecation notice. These back-compat shims (`src/config/paths.ts` dual-read, the top-level `clerk:` switchroom.yaml alias, and `src/vault/broker/client.ts` `LEGACY_SOCKET_PATH`) are **REMOVED in v0.13.0** (#1373).
- **schema:** the `model:` field on a `schedule:` entry is documented DEPRECATED/IGNORED post cron-fold-in (kept optional, non-breaking) (#1424).

### Upgrade notes

- **RFC J — vault auto-unlock is now the unattended default (#1454).** A broker with a machine-bound auto-unlock blob unlocks itself on boot with no operator interaction. Hosts that deliberately want interactive-only unlock must opt out; review RFC J (#1450) before upgrading where unattended unlock is unacceptable.
- **RFC J — broker healthcheck is fail-closed (#1455).** A locked or never-unlocked broker now reads **unhealthy** (was false-healthy). Empty-fleet/path-as-identity semantics unchanged; expect previously-green-but-locked brokers to flip to unhealthy until unlocked. The operator unlock hint is now `switchroom vault broker unlock` (the old `switchroom vault unlock` string is gone).
- **RFC J — supervisor never gives up (#1453).** The broker/kernel supervisor now backs off exponentially and retries indefinitely instead of restart-capping. A persistently-failing dependency is retried forever rather than left dead — monitor logs after upgrade.
- **Opt-in strict inter-agent network isolation (#1446).** New and **opt-in** (default unchanged: `network_mode: host`, shared host netns). Operators wanting inter-agent isolation must explicitly enable it; review the tradeoffs before flipping.
- **Security epic #1400 — operator-private surfaces.** `/auth` (#1414), fleet-admin verbs (#1408), and the `apv:` approval callback (#1404) now require operator authz; mutating hostd MCP verbs are no longer pre-approved (#1427). Non-operator chats that previously reached these will now be denied — confirm your operator identity is configured.
- **Security epic #1400 — non-root agent image + UID-collision hard-fail (#1435).** The agent image is now non-root and a UID collision is a hard failure (was a silent overlap). On `apply`/`update`, a previously-tolerated UID collision will now block — resolve duplicate agent UIDs before upgrading.
- **Security epic #1400 — per-agent `credentials/` scoping (#1407).** Compose now scopes credentials per-agent with a migration-safe doctor warn. Run `switchroom doctor` after upgrading and address any credential-scope warnings.
- **Security epic #1400 — plaintext-secret doctor flag (#1434).** `switchroom doctor` now flags inlined plaintext secrets in `switchroom.yaml`. Move flagged secrets into the vault (`switchroom vault`) — these surface as new doctor findings on first run post-upgrade.
- **Security — base images pinned `@sha256` + provenance/SBOM (#1437).** Image pulls now resolve to pinned digests; air-gapped/mirror operators must ensure the pinned digests are available in their registry mirror.
- **Update-flow redesign — new `release` config block (#1415/#1431/#1456/#1461).** New optional `release: { channel | pin }` at every cascade layer; per-agent `release` REPLACES root (does not field-merge). Default unchanged (`latest`), but operators adopting channels/pins should note the replace-not-merge semantics. The `:dev`/`:sha-<7>` tags and the operator `promote` workflow are now live.
- **Install flow reordered (#1422).** `docs/install.md` now brings the fleet up *before* authenticating (the auth-broker is the sole credential writer and does not exist until `up`). Operators following the old order on a fresh install must use the new order.
- **SOUL.md ownership flip (#1458).** Existing `workspace/SOUL.md` files freeze in place as user-owned on first `update` (no content lost); `soul:`/profile changes no longer propagate to running agents on reconcile — edit `workspace/SOUL.md` directly, or run `switchroom soul reset <agent>` to re-seed. The stale `SOUL.md.fingerprint` sidecar becomes vestigial.
- **Legacy `~/.clerk` shims removed in v0.13.0 (#1373).** This release only WARNs. Before upgrading to v0.13.0: `mv ~/.clerk ~/.switchroom` and rename any top-level `clerk:` key in `switchroom.yaml` to `switchroom:` — there is no automatic migration (v0.13.0 treats un-migrated state as a fresh install).
- **Dependabot docker constrained to digest/patch (#1460).** Node major-version bumps via Dependabot docker are now blocked; major base-image moves are deliberate manual changes going forward.

## v0.11.1 — hostd default-on + CI infra-resilience follow-ups

A small follow-up release: RFC C Phase 2 flips the host-control daemon on by default (so `/restart`, `/new`, `/reset`, `/update apply` work on docker-mode installs without per-install opt-in), `/audit hostd` gets its bind-mount, and the GHA queue-fail class (#1336) gets a manual recovery lever plus an alert backstop.

### Changes

#### Features

- **feat(host-control):** RFC C Phase 2 default-flip — `host_control.enabled` defaults to `true` (#1338). An absent `host_control` block now resolves to enabled. Migration-safe: the `existsSync` guard on `~/.switchroom/hostd/<name>` means installs without hostd don't get a broken bind-mount and `compose up` doesn't hard-fail. Operators on legacy systemd-mode installs set `host_control: { enabled: false }` explicitly.
- **feat(auth-broker):** probe-quota op — route `/auth show` quota probes through the broker (#1336).

#### Fixes

- **fix(audit-hostd):** Bind-mount `host-control-audit.log` :ro into admin agents so `/audit hostd` (#1328) can tail privileged-verb history from DM (#1337). Mirrors the vault-audit.log mount pattern; admin-gated; `existsSync`-guarded for fresh installs.

#### CI infra-resilience

- **ci(docker-images):** `workflow_dispatch` recovery trigger so `:latest` can be republished after a GHA queue-fail without another push to main (#1339), plus the same trigger added to the push-gated test workflows (#1340). The tag-computation steps treat a `workflow_dispatch` on `main` like a `push` (full multi-arch, `:latest` + `:sha-<short>`).
- **ci:** `ci-infra-watchdog` — alert-only backstop that distinguishes a GHA queue force-fail (workflow concluded `failure`, zero jobs with `conclusion==failure`) from a genuine regression and opens/de-dupes a `ci-infra-failure` issue so main-red-on-infra is visible in minutes, not hours (#1341).

### Upgrade notes

- `switchroom update` handles the rollout. The #1338 default-flip means admin agents pick up the hostd UDS bind-mount on the next `apply` **if hostd is installed** (`~/.switchroom/hostd/<name>` exists); installs without hostd are unaffected. No image changes beyond the v0.11.0 set.

## v0.11.0 — Drive write-preview lands + hindsight production-hardening + GHA primary CI

The RFC E (Google Drive) write-preview path goes end-to-end: a PreToolUse hook intercepts Drive writes, posts a diff-preview card to Telegram, and waits for approval before letting the model proceed. Hindsight ships its first real-deploy survival kit after a single install loop surfaced five separate latent bugs. CI flips to GitHub Actions as primary (Buildkite stays as a backup) and picks up shared-dist + cache speedups.

### Headline benefits

- **Drive write-preview, end-to-end (RFC E §4.2).** When the model wants to mutate a Drive file (`docs:edit`, `docs:append`, `sheets:update`, `sheets:append`), a PreToolUse hook (#1319) intercepts the call, builds a write-preview spec via the Docs API client (#1316), renders a diff card in Telegram (#1299), and gates the actual write on operator approval (#1295 ships the Open-in-Drive button on granted cards). The reconciler driver (#1307, #1300) closes the loop on background recovery for orphaned approval requests. Folder picker primitives (#1296) and the `/folders` slash command (#1308) let an operator pin Drive scopes per agent. Scope namespace (#1290) and edit-prep helpers (#1297) round out the surface.
- **Hindsight production-hardening.** Five-bug fix from the first real install (#1309) covering CI matrix gaps, Dockerfile uv-vs-pip drift, COPY-chmod dir-mode propagation, tmpfs UID/GID, and per-consumer volume-name prefix mismatch. Stateless MCP (#1326) closes the failure class where bouncing hindsight strands every agent's MCP session. Earlier in the same install loop: pre-create the parent dir before `COPY --chmod` (#1315), use `uv pip install` instead of the nonexistent venv pip (#1311), pin the LLM model to `claude-sonnet-4-6` (#1312), publish `switchroom-hindsight` to GHCR (#1310), query the auth-broker container for the hindsight socket (#1313).
- **Hostd Phase 2 gateway swap (#1306).** Telegram-side `/update apply` now talks to the host-control daemon over UDS instead of trying to docker-shell-out from inside the agent container. Closes the silent failure when an operator triggered apply from chat and got an opaque exit-127 instead of a clean error. `/audit hostd` (#1328) gives the operator a read-only command + CLI to inspect the hostd audit log.
- **GHA as primary CI (#1320).** Dual-run alongside Buildkite landed last release; this release flips the badges (#1322), gates main on the GHA checks, and adds the skip-as-pass pattern (#1331) so narrow-scope PRs don't get blocked by path-filtered required checks. Shared-dist + vitest --changed + docker image cache (#1323) take the typical PR-build wall-clock down materially. Docker image builds skip arm64 on PRs and gain cache mounts (#1330).
- **Telegram-plugin polish.** Silence-poke state drain on flush-backstop turn-end (#1293), post-reply tail flush on substantive terminal text after a soft-commit reply (#1298), sandbox-hint false-positive suppression on successful tools (#1304), tool-aware silence-poke fallback message (#1301).
- **Auth UX (#1317 / #1329).** New Format 2 `/auth` panel + causal auto-fallback. Four follow-ups stabilize the gate primitive, broker honesty, refresh throttle, and retire the legacy poller.

### Changes

#### Features

- **feat(drive):** Folder picker primitives — list + cache + card (#1296)
- **feat(drive):** Folder-picker Telegram glue — `/folders` + `drvpick:` callbacks (#1308)
- **feat(drive):** RFC E §4.2 scope namespace `doc:gdrive:suggest:*` (#1290)
- **feat(drive):** Edit-preparation helpers for the four MCP write tools (#1297)
- **feat(drive):** Open-in-Drive button on granted approval cards (#1295)
- **feat(drive):** Telegram renderer for the diff-preview card (#1299)
- **feat(drive):** Docs API client + write-preview spec builder — RFC E §4.2 PR-2A (#1316)
- **feat(drive):** Gateway IPC verb that posts the diff-preview card — PR-2B (#1318)
- **feat(drive):** PreToolUse hook + scaffold registration — PR-2C (#1319)
- **feat(drive):** Reconciler driver loop, kernel-agnostic core — RFC E §4.4 (#1307)
- **feat(drive):** Recovery wiring helpers — audit + digest + nudge (#1300)
- **feat(hostd):** Complete Phase 2 gateway swap — close silent `/update apply` (#1306)
- **feat(audit):** `/audit hostd` Telegram command + `switchroom hostd audit` CLI (#1328)
- **feat(auth-ux):** Format 2 `/auth` + causal auto-fallback + dispatch fix (#1317)

#### Fixes

- **fix(hindsight):** Five PR #1266 bugs surfaced by the first real deploy (#1309)
- **fix(hindsight):** Enable stateless MCP so hindsight bounces don't strand agent retain (#1326)
- **fix(hindsight):** Pre-create `/usr/local/lib/switchroom` with 0755 — dir-mode bug (#1315)
- **fix(hindsight):** Use `uv pip install` instead of nonexistent venv `pip` (#1311)
- **fix(hindsight):** Pin LLM model to `claude-sonnet-4-6` — switchroom default (#1312)
- **fix(doctor):** Query auth-broker container for hindsight socket, not host (#1313)
- **fix(rfch):** Harmonise boot-probe hints + `/status` auth panel on RFC H verbs (#1327)
- **fix(auth-ux):** Four follow-ups to #1317 — gate primitive + broker honesty + refresh throttle + retire poller (#1329)
- **fix(telegram-plugin):** Drain silence-poke state on flush-backstop turn-end (#1293)
- **fix(telegram-plugin):** Flush post-reply tail when model emits substantive terminal text after a soft-commit reply (#1298)
- **fix(telegram-plugin):** Tool-aware silence-poke fallback message (#1301)
- **fix(telegram-plugin):** Suppress sandbox-hint false positives on successful tools (#1304)
- **fix(ci):** Three GHA followups — plugin test relocation, evals cache, docker-e2e composite (#1321)
- **fix(ci):** Restore exec bits on shared dist/ artifact (#1332)

#### CI / Performance

- **ci(gha):** Dual-run CI on GitHub Actions alongside Buildkite (#1320)
- **ci(gha):** Skip-as-pass pattern for flexible required checks on narrow-scope PRs (#1331)
- **ci(docker-images):** Publish `switchroom-hindsight` to GHCR (#1310)
- **perf(ci):** Three speedups — shared dist/, `vitest --changed`, docker image cache (#1323)
- **perf(docker):** Three image-build optimisations — skip arm64 on PRs, cache mounts, COPY reorder (#1330)

#### Docs / chore

- **docs:** Drop retired `switchroom-scheduler` references (#1294)
- **docs(drive):** `google-workspace.md` user guide + RFC G/E tracking refresh (#1302)
- **docs(rfc-e):** §4.2 amendment — Path A Cut 2 implementation pivot (#1324)
- **docs(readme):** Swap Buildkite badges for GitHub Actions (#1322)
- **docs(claudemd):** Add CI section — GHA primary + gating, Buildkite informational (#1325)
- **chore(auth-fallback,docs):** Retire dead exports + tick RFC E checklist (#1333)

### Upgrade notes

- **`switchroom update` handles the rollout.** Pulls new images (broker, kernel, agent, auth-broker, hostd, hindsight), regenerates compose, recreates containers, stamps restart markers, and runs doctor. No manual `docker compose` is needed.
- **Hindsight host migration.** The v0.10.0 → v0.11.0 update changes the per-consumer broker-socket volume name from `switchroom_auth-broker-hindsight-sock` to `auth-broker-hindsight-sock` (#1309). After `switchroom update`, the old prefixed volume is orphaned; `docker volume rm switchroom_auth-broker-hindsight-sock` cleans it up. The canonical `switchroom memory setup` path now works without any manual `docker run -v ...` workaround.
- **MCP stateless mode.** Hindsight's MCP server now runs in stateless HTTP mode by default (#1326). Operators with bespoke MCP clients that need streaming can override via `docker run -e HINDSIGHT_API_MCP_STATELESS=false`.

## v0.10.0 — Google Workspace via the auth-broker + RFC H tail-fixes

RFC G Phase 3b lands: a Google account is a first-class auth slot alongside the Anthropic accounts RFC H introduced in v0.9.0. The same broker that owns Anthropic OAuth refresh now owns Google OAuth refresh, per-account ACLs, and per-agent / per-consumer credential fan-out. Plus a tail of RFC-H hardening closing two silent-failure regressions that bit the 2026-05-14 install-validation loop.

### Headline benefits

- **Google Workspace per agent (or per fleet).** `switchroom auth google account add <label>` runs an OAuth flow against Google and registers the resulting refresh token with the broker. Agents that need Drive / Gmail / Calendar get a per-agent socket bound at `/run/switchroom/auth-broker/<agent>/sock` and a `get-credentials provider=google` op that mints a fresh access token on demand — same protocol shape as Anthropic credentials.
- **Per-account ACLs.** The `switchroom auth google enable/disable/list` verbs (shipped in #1247 during the v0.9.x window) now have a working broker behind them: Google credentials are actually mintable, and the per-account ACL gates real `get-credentials` calls. Default is **deny** — adding the account doesn't grant fleet-wide access. The setup wizard's Phase 4 prompt (#1248, also v0.9.x) likewise becomes operative this release.
- **Refresh races eliminated for Google too.** The broker holds an exclusive refresh lease per Google account (#1275). Production-hardened: jitter, backoff, lease release on SIGTERM, audit lines for every refresh outcome.
- **`switchroom auth add <label> --via-claude`** (#1286). Broader OAuth scopes than `setup-token` ships with — useful for accounts that need to operate hindsight or other broker consumers without re-running setup. Goes through the `claude` CLI's OAuth flow with the wider scope set, then registers the credentials with the broker.
- **Silent-failure regressions closed.** Two RFC-H aftershocks that bit during the v0.9.0/v0.9.1 install-validation loop are now structurally impossible:
  - Account credentials written without `scopes` / `subscriptionType` claims caused the fleet to boot as "Not logged in" because claude rejected the credential shape. Fixed in #1280 (enrich on write) and reinforced in #1285 (mirror-time enrichment closes the residual boot gap).
  - The broker didn't fan credentials out to per-agent mirrors at boot — only on add. Empty mirrors at boot showed up as fleet-wide auth failures after `switchroom update`. Fixed in #1277 (fanout at boot + wire `SWITCHROOM_AUTH_BROKER_OPERATOR_UID` end-to-end).

### CLI changes

- **`switchroom auth google account add <label>`** (#1274) — real OAuth flow + broker registration. Replaces the stub from RFC G Phase 3b.3.
- **`switchroom auth google account list`** (#1279) — broker-backed list of registered Google accounts, surfacing label, scopes, refresh status.
- **`switchroom auth google enable <agent> <label>`** / **`disable`** / **`list`** — per-account ACL controls (verbs landed in #1247 in v0.9.x; behind them, the get-credentials path is functional as of this release).
- **`switchroom auth add <label> --via-claude`** (#1286) — broader-scope OAuth via the `claude` CLI flow.
- **`switchroom auth use <label>`** + **`auth rotate`** now write `auth.active` to YAML (#1282) — previously these mutated broker state but left `switchroom.yaml` stale, so the next `switchroom apply` would re-bind the old active account. Closes a recurrence of the silent fanout class.
- Stale RFC-pre-H references removed: `auth login`, `auth status` no longer appear in CLI help, docs, or doctor output (#1283).

### Auth-broker internals

- `wrapper-broker.ts` (#1273) — client-side helper that wraps a consumer process and feeds it credentials minted by `get-credentials`. Used by hindsight, the example `personal-google-workspace-mcp` (#1245, shipped in v0.9.0), and forthcoming Drive / Gmail integrations.
- `--operator-uid` flag wired through the compose command (#1278) — the broker needs the host operator UID to chown per-agent socket dirs correctly during boot fanout.
- Audit-log SIGKILL-safety + `AuthCommandContext` rename (#1284) — buffered audit writes now flush on SIGTERM and survive SIGKILL via a fsync-on-write fallback path. Internal rename clarifies the operator-vs-agent caller boundary.
- Test pinning: auth-broker operator-command volume gating is now covered by `tests/docker/compose-generator.test.ts` (#1281).

### Reconcile + scaffolding

- `switchroom apply` regenerates `CLAUDE.md` silently on template drift (#1276). Previously a noisy "drift detected" message fired on every apply when the template had moved underneath an unchanged scaffold. The check + re-render still happens; just stays quiet.

### CI / test infra

- **Fuzz harness promoted to a Buildkite PR gate** (#1145) — the corpus-driven harness from #1132 / #1134 now runs on every PR via Buildkite, blocking merge on regression. Complements the existing GitHub Actions e2e gate.
- **Boot-probes test alignment** (#1287) — `nextStep` assertions now use RFC-H vocabulary (`account`, `consumer`, `fanout-mirror`) instead of pre-H legacy terms.

### Docs

- `docs/auth.md` — Google sections added covering the `auth google` verb tree, per-account ACL semantics, and the broker `get-credentials provider=google` protocol.
- `docs/rfcs/auth-broker.md` — RFC G v3 cross-referenced.
- Install-validation Phase 1-4 retrospective at `docs/install-validation-2026-05.md` (#1253) — what broke during the fresh-VM install loop, what fixed it, and the doctor probes that now catch each class.

### Migration

No-op for Anthropic-only operators — the RFC-H surface from v0.9.0 is unchanged. Operators adding Google:

1. `switchroom auth google account add <label>` and complete the OAuth flow.
2. `switchroom auth google enable <agent> <label>` for each agent that needs the account (default-deny).
3. `switchroom apply` to bind the new sockets.
4. Agent containers pick up the new credentials at next restart.

Per RFC §6, no compatibility shims — agents on a pre-v0.10.0 image are unaffected (they don't ask the broker for Google credentials).

## v0.9.1 — `switchroom-hindsight` on the auth-broker: no API key needed

`reference/vision.md`'s **subscription-honest, no-API-key-routing** outcome reaches the memory backend. Hindsight (the bundled long-term-memory container) now runs against an Anthropic OAuth account that switchroom is already managing on the operator's behalf — the OpenAI API key prompt, vault entry, and `-e HINDSIGHT_API_LLM_API_KEY=...` plumbing are all gone.

### What changed

- Hindsight is now a first-class **auth-broker consumer** (RFC H §4.8). Declare it once in `switchroom.yaml`:
  ```yaml
  auth:
    active: me@example.com
    consumers:
      - name: hindsight
        account: me@example.com
        uid: 11000
  ```
  `switchroom apply` binds `/run/switchroom/auth-broker/hindsight/sock` chowned to UID 11000. The setup wizard adds this entry automatically.
- New image `ghcr.io/switchroom/switchroom-hindsight:latest`, built from `docker/Dockerfile.hindsight`. Extends upstream `vectorize-io/hindsight:latest` with `claude-agent-sdk` (the Python SDK the upstream `claude-code` provider needs) and the `@anthropic-ai/claude-code` CLI on PATH.
- New entrypoint shim `docker/hindsight-entrypoint.sh` fetches OAuth credentials from the broker over UDS at every boot, writes them to a tmpfs dotfile at `/run/claude-creds/.credentials.json`, exports `CLAUDE_CONFIG_DIR`, and exec's into the upstream `/app/start-all.sh`. The credentials never touch persistent disk; the broker remains the single writer of OAuth state.
- `HINDSIGHT_API_LLM_PROVIDER` is pinned to `claude-code`. Memory consolidation and recall now consume Pro/Max session turns on the chosen account — operators with heavy retain can split memory onto its own account with `agents.<name>.auth.override`.

### Doctor

- New probe `hindsight consumer`: warns when `auth.consumers[]` has no `hindsight` entry or the per-consumer socket hasn't been bound yet. Replaces the pre-#1245 `hindsight env leak` probe (the OpenAI-key shape it watched for is no longer in the runtime path).

### Setup wizard

- Step 6 (memory backend) no longer prompts for an OpenAI API key. It registers the hindsight consumer in `switchroom.yaml`, surfaces a one-liner if a stale `HINDSIGHT_API_LLM_API_KEY` env or `hindsight-api-key` vault entry is still around (no longer used; safe to delete), and starts the container in broker-fed mode.

### Migration

Operators on v0.9.0 with a running hindsight container should `switchroom memory --stop` and re-run `switchroom setup` (or manually add the `auth.consumers[]` entry and re-`apply`). No in-place migration shim — per RFC §6, the no-compatibility-shims stance applies.

## v0.9.0 — `switchroom-auth-broker` (RFC H): single-writer OAuth plane

Big release. RFC H operationalises `reference/share-auth-across-the-fleet.md`: the **Anthropic account becomes the unit of authentication**, not the agent. One OAuth flow per account drives N agents. A new singleton container, `switchroom-auth-broker`, owns the refresh loop, per-agent credentials.json mirrors, and per-account quota state. Net diff is **−6,771 LOC** — the cleanup is the win, not just the new daemon.

### Headline benefits

- **One OAuth flow per Anthropic account, not per agent.** Six agents on one Pro subscription used to mean six `claude setup-token` invocations and six independent refresh cycles. Now: `switchroom auth add <label> --from-oauth` once, then every agent that uses that account just works.
- **Quota events propagate in seconds.** When one agent gets 429, the broker marks the account exhausted and fans every co-account agent over to its fallback. No more six-agents-rediscover-the-same-wall.
- **Fleet-wide active account is one verb.** `switchroom auth use <label>` swaps every agent to the new account. The Telegram twin `/auth use <label>` (admin agents only) is the same thing.
- **Per-agent override is the edge case.** Most agents have no `auth:` block in `switchroom.yaml`. Agents that need a different account from the fleet get `agents.<n>.auth.override: <label>`.
- **Visibility.** `switchroom auth show` (and `/auth show` in any agent's chat) prints accounts + agents + consumers + expiries + quota state in one screen. The old `auth status` was empty rows.
- **Refresh races eliminated.** The single-use Anthropic refresh-token endpoint was racing every time multiple consumers refreshed concurrently; the loser silently got an invalid token. Broker holds an exclusive lease per account.
- **Two silent-failure bugs that bit 2026-05-14 are now structurally impossible.** Bug 1 (sudo fanout writing root-owned credentials.json → silent fleet lockout at next restart). Bug 2 (`auth refresh-accounts` last-write-wins overwriting the YAML primary). Both pinned by regression tests at `src/auth/broker/server.test.ts`.
- **Hindsight (and other ephemeral consumers) get a first-class slot.** `auth.consumers[]` schema field + per-consumer UDS socket means a non-agent container can `get-credentials` from the broker and feed claude. Unblocks the parked `feat/hindsight-claude-code` branch.

### CLI changes

| Before | After |
|---|---|
| `auth promote <label> <agents...>` | `auth use <label>` (fleet-wide) |
| `auth enable / auth disable <label> <agents>` | `auth agent override <agent> <label>` (edge case) |
| `auth login <agent>` | `auth add <label> --from-oauth` |
| `auth reauth <agent>` | `auth add <label> --from-oauth --replace` |
| `auth account add / list / rm / rename` | `auth add / list / rm` (no more `account` subcommand) |
| `auth refresh-accounts` | `auth refresh [<label>]` (diagnostic; broker owns the loop) |
| `auth share <label>` | `auth add` + `auth use` (two clear verbs) |
| `auth status` (empty rows) | `auth show [<agent>]` (real state) |
| `auth heal <agent>` | gone (no slot pool to heal); `--json` shim retained for boot-self-test |

### Schema changes

```yaml
# BEFORE (per-agent auth.accounts arrays)
agents:
  ziggy:
    auth_label: "you@example.com"
    auth:
      accounts: [bob@example.com, you@example.com]

# AFTER (one fleet active + per-agent override edge case)
auth:
  active: bob@example.com
  fallback_order: [bob@example.com, you@example.com]
  consumers:
    - name: hindsight
      account: bob@example.com
      uid: 11000

agents:
  ziggy: {}                                # uses fleet active
  clerk:
    admin: true                            # gates /agents, /restart, AND admin /auth verbs
  klanker:
    auth:
      override: you@example.com          # edge case only
```

`switchroom apply` runs an in-place schema upgrade with a `switchroom.yaml.pre-auth-broker` backup. Divergent fleets emit a loud warning explaining both the ordering loss and the tail-account loss (the new schema can't represent per-agent fallback preferences).

### Architecture (read `docs/auth.md` for the operator guide)

- Per-agent UDS socket at `/run/switchroom/auth-broker/<name>/sock`, mode 0660, chowned to the per-agent UID.
- Per-consumer socket at `/run/switchroom/auth-broker/<consumer>/sock`, chowned to the consumer's declared UID.
- Operator socket at `/run/switchroom/auth-broker/operator/sock`, chowned to the operator UID — host operator reaches the broker without sudo.
- Drift detection: broker records sha256 of every credentials.json it writes in `sha-index.json`. Boot-time mismatch is a hard error; recovery is `auth add <label> --replace`. Runbook at `docs/operators/auth-broker-drift.md`.
- Refresh threshold: 60min remaining (broker) vs ≤5min (claude). The 55-min gap is the load-bearing invariant — broker refreshes first, claude reads the new bytes on its next disk-read, no tmp+rename race.
- `CLAUDE_CODE_OAUTH_TOKEN` env injection deleted (Decision 5). Stop hooks, sub-agents, summarizers, cron-launched `claude -p` all read `credentials.json` from disk, same path.
- Per-agent slot tree (`<agentDir>/.claude/accounts/<slot>/`, `.oauth-token`, `.oauth-token.meta.json`, `active` marker) deleted (Decision 6).

### Telegram

The old `/auth` dashboard (1,104 LOC of in-place promote UI built on slot-pool concepts) is gone. Replaced with three chat commands:
- `/auth show` — open to any agent (read-only).
- `/auth use <label>` — admin agents only.
- `/auth rotate` — admin agents only.

### Deletions

- `src/auth/account-promote.ts`, `src/auth/token-refresh.ts`, `src/auth/account-quota-store.ts`, `src/cli/auth-accounts-yaml.ts` — all functionality subsumed by the broker.
- `telegram-plugin/auth-dashboard.ts` (1,104 LOC) and `telegram-plugin/auth-slot-parser.ts` — replaced by the three thin chat commands.
- The fanout half of `src/auth/account-refresh.ts` (`fanoutAccountToAgents`, `refreshAllAccounts`, `enabledAgentsForAccount`). The single-account refresh primitive `refreshAccountIfNeeded` stays — the broker imports it.
- **Standalone `switchroom-foreman` Telegram bot.** `telegram-plugin/foreman/`, the `switchroom setup --foreman` CLI verb, and the `~/.switchroom/foreman/` config dir are all deleted. Fleet-management slash commands are now handled by per-agent gateways on agents with `admin: true` (three-tier command model — see `docs/architecture.md`). The `role: "foreman"` schema flag is **unchanged** — it controls auto-installation of operator skills and is orthogonal to the retired standalone bot. Foreman commands intentionally **not** migrated (run on host): `/create-agent` + `/setup` → `switchroom agent add <name>`; `/delete <agent>` → `switchroom agent destroy <name>`.
- ~2,000 LOC of paired tests for all the above.

### Migration

No long-term migration framework. `switchroom apply` runs an in-place upgrade on first run post-merge and writes `switchroom.yaml.pre-auth-broker` for the audit trail. There are no users in the wild, so the migration is destructive of per-agent fallback ordering on divergent fleets — the loud warning surfaces the loss.

### See also

- `docs/auth.md` — full operator guide.
- `docs/operators/auth-broker-drift.md` — drift recovery runbook.
- `docs/rfcs/auth-broker.md` — the RFC (3 review rounds).
- `reference/share-auth-across-the-fleet.md` — the JTBD design contract this operationalises.
## v0.8.1 — SOUL.md fingerprint re-render (v0.8.0 follow-up)

Single fix. The v0.8.0 voice consolidation (PR #1177) moved the canonical AI-tells ban-list into `SOUL.md` "Never", but `seedWorkspaceBootstrapFiles` was seeding workspace bootstrap files via `writeIfMissing`. Once an agent had a `SOUL.md`, the template was frozen forever — same failure shape as #1122 was for `CLAUDE.md` before that fix.

Result during the v0.8.0 rollout: the new "Never" rules didn't reach any existing agent. Operators had to `rm SOUL.md && switchroom apply` per agent to refresh.

### Fix (#1181)

`SOUL.md` now uses `rerenderWithFingerprint` — the same function `CLAUDE.md` has used since #1122. Other workspace files (`IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`, `USER.md`) keep `writeIfMissing` because they're user-owned scratchpads the agent edits at runtime.

`SOUL.custom.md` sidecar handling is preserved: operator additions are composed into the rendered output, and the sidecar file itself stays `writeIfMissing` so it survives re-renders untouched.

Operator hand-edits to `SOUL.md` itself are backed up to `SOUL.md.before-rerender.<unix-ms>` then the file is rewritten from the new template. Legacy state (file exists, no fingerprint sidecar) migrates cleanly on the next apply — content unchanged, fingerprint installed.

New regression test at `tests/scaffold.rerender-soul-md.test.ts` mirrors `scaffold.rerender-claude-md.test.ts`: first-scaffold-writes-fingerprint, no-op-on-unchanged-template, drift-without-edits, hand-edit-plus-drift, legacy-state-migration, sidecar-survives-rerender.

### npm note

v0.8.0 was briefly unpublished from npm during a force-republish attempt before the SOUL fix was ready. npm policy blocks same-version republish for 24h after unpublish, so v0.8.0 stays unpublished on npm. v0.8.1 carries the same content as v0.8.0 + the fix and is the version to install. GitHub `v0.8.0` tag + GHCR `:v0.8.0` images already point at the SOUL fix commit and remain available.

## v0.8.0 — voice/architecture cleanup + host-control daemon + vault posture toggle

Big release. ~35 PRs since v0.7.16. Three headline themes:

1. **Voice and prompt architecture cleanup (#1177, #1178)** — the agent system prompt was duplicating "don't make AI tells" rules 3-4× across SOUL.md / CLAUDE.md / telegram-style.md.hbs in slightly different forms, while ~57% of `telegram-style.md.hbs` was operational protocol that fires only on specific runtime triggers (interrupted-turn resume, fresh-boot wake audit, "why did you restart" debug, `!` interrupt detail, "status?" UX-failure signal). Anti-AI guidance was drowning in a 6,000-word always-loaded prompt. Two-PR fix: consolidate voice rules into SOUL.md "Never" as the canonical ban-list, add a procedural "Execution Bias" section to CLAUDE.md (verify mutable facts, final answer needs evidence, weak tool result is not a conclusion, one clarifying question not five), and hoist the runtime protocols into a new bundled `switchroom-runtime` skill that loads on demand. Net: assembled CLAUDE.md drops from ~32KB to ~27.7KB per turn, and the voice/persona content sits at the prompt position it deserves.

2. **`switchroom-hostd` host-control daemon — Phase 1 (#1175, RFC C in #1171)** — first cut of the host-control daemon that lets the in-agent gateway reach back to the host for privileged operations (docker compose recreate, vault rotation, etc.) without granting docker.sock to every agent container. Phase 1 ships the protocol, server, client, and compose wiring; subsequent phases add the actual privileged-op handlers. RFC at `docs/proposed/RFC-C-host-control-daemon.md`.

3. **Vault posture toggle (`approvalAuth: passphrase | telegram-id`, #1115 et al.)** — opt-in single-factor approval for vault grant cards (full breakdown below).

### Voice / architecture cleanup (#1177 + #1178)

**Voice consolidation into SOUL.md (#1177).** AI-tells ban-list unified into `profiles/default/workspace/SOUL.md.hbs` "Never" — covers opener/closer phrases ("Certainly!", "I hope this helps", "Let me know if"), promotional adjectives ("powerful", "compelling", "vibrant", "revolutionary"), em-dash rule, rule-of-three / negative-parallelism, hedging filler, excessive bolding, sycophantic preamble, apology-for-prior-responses. The old paragraph at `telegram-style.md.hbs:42` is now a 70-word pointer to SOUL. New "Execution Bias" section in `profiles/default/CLAUDE.md.hbs` between Safety and the telegram-style partial: procedural rules (act in-turn, verify mutable facts before claiming, final answer needs evidence, weak tool result is not a conclusion, one clarifying question not five). Procedural shape inspired by OpenClaw's same-named section; switchroom-flavored wording. Subsumes the prior posture-only "don't guess, don't assume" / "verify before editing" bullets.

**Runtime protocols hoisted to `switchroom-runtime` skill (#1178).** New bundled skill at `skills/switchroom-runtime/SKILL.md` holds the resume protocol, wake audit, "why did you restart" debug commands, `!` interrupt implementation detail, and "status?" UX-failure signal procedure. The always-loaded prompt keeps short trigger sentences ("If `$TELEGRAM_STATE_DIR/.wake-audit-pending` exists, invoke `/switchroom-runtime`") instead of the inline bash snippets. Auto-symlinked into every agent's `.claude/skills/` via the existing default-skills reconciler — no per-agent config required. Operator opt-out via `bundled_skills: { switchroom-runtime: false }`. Size cap test in `tests/scaffold.persona.test.ts` tightened 32000 → 28000 to lock in the budget.

### Host-control daemon — Phase 1 (#1175, RFC #1171)

`switchroom-hostd` is a new host-side daemon that mediates privileged operations the in-agent gateway can't perform directly (docker compose interactions, host-filesystem writes outside the per-agent mount, etc.). Phase 1 ships the NDJSON-over-UDS protocol, server, client library used by the gateway, and the compose wiring that bind-mounts the hostd socket into agent containers. Subsequent phases implement specific privileged ops (the immediate driver is fixing `/update apply` from inside Telegram on docker hosts — see #926). RFC at `docs/proposed/RFC-C-host-control-daemon.md` walks the design space.

### Vault posture (#1115 epic)

- **`vault.broker.approvalAuth` posture toggle (`passphrase` | `telegram-id`)** — opt-in single-factor approval for vault grant cards. Default (`passphrase`) is unchanged: the operator types the vault passphrase on every Approve tap (two-factor — Telegram ID + passphrase). Setting `approvalAuth: telegram-id` (requires `autoUnlock: true`) makes Approve mint immediately with no passphrase prompt, relying on Telegram account identity alone. Threat-model writeup in `docs/configuration.md`; `switchroom doctor` surfaces the active posture. Single-factor mode collapses security to the operator's Telegram account — opt-in only. The gateway hard-fails on boot if `approvalAuth: telegram-id` is set but the auto-unlock blob is missing, unreadable, OR empty/whitespace-only — we never silently downgrade an operator's declared posture.

- **`vault.broker.approvalAuth: telegram-id` works on Docker (#1115 follow-up, #1140)** — the posture was non-functional on the canonical Docker runtime because the gateway inside an agent container couldn't reach the auto-unlock blob (bind-mounted only to the broker singleton). Fixed via broker-mediated attestation: new `attest_via_posture: true` flag on `mint_grant` / `list_grants` / `put`; broker validates its own config opt-in + lock state + per-agent peer, then uses its retained passphrase internally. **Passphrase never crosses the wire.** Plus a **per-agent opt-in allowlist** `vault.broker.postureMintAgents` (default `[]`): under `approvalAuth: telegram-id`, only listed agents can use the silent-mint path. Broker also enforces `req.agent === agentName` so an allowlisted agent can't mint grants naming another agent.

- **Vault-posture config errors exit cleanly (#1135)** — instead of crash-looping, the gateway now exits with `EX_CONFIG` (78) when a vault-posture config combination is invalid (e.g. `approvalAuth: telegram-id` without `autoUnlock: true`). Systemd / docker treat that as a permanent config error, not a transient crash worth restarting.

- **Operator-update restart silence (#1139, #1141, #1142)** — `switchroom update` now stamps a `clean-shutdown.json` marker (`reason: "operator: switchroom update"`) on every agent before the compose recreate so the post-recreate boot card renders as graceful rather than "your agent crashed." Marker freshness window extended to 5min for `operator:` reasons (initial 90s was too tight when the docker pull was slow). Marker stamped via `docker exec` so the inside-container path matches the outside-container path the gateway will read.

### Operator-event card / button-UX foundation (#1150 audit closure)

The #1150 epic was a thorough audit of the inbound button-tap UX surface, surfacing three P0 surfaces and many smaller polish items. All landed:

- **`finalizeCallback` helper (#1152)** — single chokepoint enforcing the three button-UX invariants: atomic status edit + keyboard strip, idempotent under retry, escapes source-text on all paths. Foundation for the rest of the epic.

- **3 P0 button-UX surfaces (#1157, #1158, #1165)** — vault_request_save rename action, reauth re-tappability, atomic status line + keyboard strip on operator-event cards. The keyboard no longer lingers after the action completes.

- **Source-text escape generalization (#1160, #1162)** — every `finalizeCallback`-class callsite now escapes user-provided text consistently. Catches the pre-existing 5 callsites that weren't on the new helper yet.

- **Synthetic-inbound buffering on bridge disconnect (#1156)** — synthetic turns (cron fires, vault-save replays) queued by the gateway during a bridge restart now flush correctly when the bridge comes back, instead of getting dropped.

- **Interrupt marker uses `tmux send-keys` directly (#1133)** — under the v0.7 docker runtime, the prior path through `interruptAgent` was a no-op for in-container tmux because there was no host-side docker-exec wrapper. Direct `tmux send-keys` against the agent container's socket works.

- **Framework-fallback ends wedged turns (#1136)** — when Claude's framework-fallback path fired (context-exhaustion, output-rate-limit, model-error), the turn never ended cleanly on the gateway side, so subsequent inbounds got queued forever. Now `silencePoke.endTurn` fires on all bail paths.

- **Session-scoped always-allow cache (#1169)** — sub-agents now inherit parent approvals so the `/auth slot` reauth flow doesn't re-prompt for every sub-agent dispatched in the same session.

- **Boot-card improvements (#1170)** — quota row plus Claude CLI version on every boot/status card, so operators know what's actually running without `docker exec`.

- **Audit closure (#1167, #1168)** — `ask_user` button-tap end-to-end smoke test + synth-inbound builder refactor with 13 shape-pin tests.

### Bind mounts + compose

- **Admin-gated `bind_mounts:` (#1164, #1166, #1172)** — per-agent admin-gated bind mounts for host paths an agent needs (e.g. an external photo library, a vendor directory). Path normalization, target-path denylist (no `/etc`, `/proc`, `/sys`, `/run` etc.), and a docs reframe to explain the trust model.

- **`TINI_KILL_PROCESS_GROUP=1` (#1176)** — SIGTERM now reaches the gateway sidecar process group, not just tini. Fixes a class of "agent ignored SIGTERM" bugs under docker.

- **Bundled-skills pool at `~/.switchroom/skills/_bundled` (#1173, #1174)** — host-stable pool that survives CLI version changes, so `_bundled/<name>` symlinks in agent dirs don't bit-rot. Mounted into agent containers via the compose wiring.

### CLI + telemetry

- **`switchroom status-ask report` (#1159)** — measures `inbound_status_query` events (the "status?" / "still there?" / "any update?" defect signal) so the rate can be tracked over time. Pairs with #1178's runtime-skill hoist of the same procedure.

### Misc

- **Inbound denials logged with reason (#1137)** — allowlist misconfigs aren't silent anymore.
- **`gh run rerun` actually bumps Claude (#1143)** — `CACHE_BUST=run_attempt` in the docker workflow.
- **UAT framework expansion** — many test additions across #1134, #1144, #1146, #1147, #1148, #1149, #1151, #1153, #1154 covering silence-poke, boot-card reasons, status-ask cause classes, ask_user button taps, reaction lifecycle.

## Unreleased

## v0.7.16 — vault UX epic close-out + host-shell broker socket

## v0.7.16 — vault UX epic close-out + host-shell broker socket

Five PRs landed since v0.7.15: the remaining three phases of the #969
vault UX epic (P2a / P2b / P3 — durable approval-kernel schema,
recent-denials one-tap allow, master-passphrase env deprecation), plus
the long-running host-shell broker socket fix that had bit-rotted as
#905 (now landed via #991 after a clean rebase).

### Durable approval-kernel schema across broker restarts (#969 P2a — #984)

The kernel's schema migration had been running `DROP-IF-EXISTS + CREATE`
on every broker boot, on the assumption that no production deployment
of the kernel had landed yet. That assumption broke in v0.7.15 when
P1a's `vault_request_save` flow started minting durable
`allow_always` decisions and the kernel container went into
production compose. Every broker restart silently wiped operator
approvals — tapping "Always" on a vault-save card was effectively
"Always until next deploy."

Fix: switch all three approval tables (`approval_decisions`,
`approval_nonces`, `approval_audit`) and their indices to
`CREATE IF NOT EXISTS`. Idempotent on a fresh DB; preserves rows on
an existing one. No data migration needed (schema columns stable
since introduction). Locked in by a new regression test that seeds
each table, re-runs the migration, asserts rows survive.

### Recent-denials section + one-tap allow on `/vault audit` (#969 P2b — #985)

Closes the cron-denial loop. When a cron-fired skill hits a broker
DENY (key not in `schedule[i].secrets[]`, or no write-grant for a
new key), the failure was silent in `scheduler.jsonl` — operators
typically found out via "the cron stopped working."

`/vault audit <agent>` now surfaces a "Recent denials (last 7d)"
section grouped by key, with a `[🔓 Allow <key>]` button per unique
denial. Tap → 30-day read-grant minted via the broker
(`mintGrantViaBroker`), token file written, agent picks up the grant
on next CLI invocation.

Pure-functional parser in `telegram-plugin/gateway/recent-denials.ts`
handles malformed JSON, missing fields, stale entries, and tampered
slug shapes defensively. 8 unit tests lock in each filter.

Grants chosen over YAML reconcile because (a) write-grants from P1b
already let agents rotate/create keys without touching
`schedule.secrets[]`, mirroring that for reads is consistent, and
(b) editing `switchroom.yaml` from a Telegram tap requires careful
YAML mutation + restart fan-out — riskier in scope. The grant model
is an additive overlay; operators who want the read pinned into
config can still edit manually.

### `SWITCHROOM_VAULT_PASSPHRASE` deprecation in sandbox + canonical-pattern docs (#969 P3 — #982)

Targets a specific anti-pattern: skills that export the master
passphrase into the agent's environment, defeating the ACL model
and bypassing the broker's audit log. The env var path remains
honoured for backwards compatibility AND for the canonical
gateway-passphrase-attestation flow (P1a) — both legitimate.

  - **`docs/vault-security.md`** — new canonical reference. Three
    auth paths (capability grant, path-as-identity, operator
    passphrase), decision flow, migration notes.
  - **Runtime warning** at `vault` CLI `preAction`. One-shot per
    process. Fires only when env var set AND `SWITCHROOM_RUNTIME=
    docker` AND escape hatch unset. Stderr only. Message includes
    the canonical `vault grant` mint command and a pointer to the
    docs. The gateway's per-spawn invocations set
    `SWITCHROOM_NO_VAULT_DEPRECATION_WARNING=1` to keep the
    canonical P1a flow quiet.
  - **`skills/token-helpers/SKILL.md`** — the in-tree skill that
    documented the env var as a prereq is updated to advertise
    capability grants first.

### Host-shell access to the v0.7 vault broker (#991, supersedes #905)

Eight host-shell CLI verbs were broken under docker mode because the
broker only bound per-agent sockets at
`/run/switchroom/broker/<agent>/sock` and the host CLI defaulted to
the v0.6 host-side path which no longer exists. Every host-shell
broker call returned "broker unreachable":

  - `switchroom vault broker {status,unlock,lock}` → false-negative
  - `switchroom vault doctor` → false-negative
  - `switchroom vault auto-unlock {status,poll}` → false-negative
  - `switchroom agent restart [--name|all]` → preflight blocked
  - `switchroom vault {get,list}` → broker dead → direct-decrypt fallback

This PR adds a host-shell-reachable **operator socket** as the third
identity kind in the broker's path-as-identity model:

```
host:      ~/.switchroom/broker-operator/sock           (mode 0600, chowned to operator UID)
          ↑ docker bind mount
container: /run/switchroom/broker/operator/sock         (broker binds + chowns)
```

Trust model: bind path + chown + 0600 file mode. peercred is bypassed
for this listener (host UID never matches the broker container's root
UID) — same invariant the per-agent sockets already use.

Eight slices:

  1. **peercred** — `socketPathToIdentity()` returns
     `{kind:"agent",name} | {kind:"operator"}`; backward-compat
     `socketPathToAgent()` returns null for the operator path;
     the allocator reserves `"operator"` as an agent name.
  2. **broker server** — `bindOperatorListener()` binds data +
     unlock pair, chowns to operator UID. `isOperator` flag in
     `_handleRequest` routes to operator-mode dispatch: skip
     peercred fail-closed, skip grant-mgmt cron-deny, apply
     entry scope with `agentSlug="operator"` (default-deny on
     agent-scoped keys).
  3. **compose generator** — emits operator bind volume +
     `SWITCHROOM_BROKER_OPERATOR_UID` env when `operatorUid` is
     set; omitting preserves pre-fix behaviour.
  4. **apply** — captures `SUDO_UID` (or `process.getuid()`) and
     threads as `operatorUid`. Pre-creates the host bind dir so
     docker doesn't auto-create it as root.
  5. **CLI broker client** — `resolveBrokerSocketPath()` prefers
     the operator socket under `isDockerRuntime()`, falls back to
     the legacy v0.6 path otherwise.
  6. **preflight + bot-token messages** — distinguishes
     "reachable-but-locked" from "unreachable + docker-mode";
     the new hint points at `docker compose up -d` + Telegram
     `/vault unlock` instead of the host-side daemon command
     that no longer exists.
  7. **`src/runtime-mode.ts` (new)** — consolidates the three
     existing local copies of the `SWITCHROOM_RUNTIME=docker`
     predicate under one module so the operator-socket resolver
     shares the detection contract.
  8. **78 new test assertions** — peercred socket-path
     round-trip, compose-generator operator bind + env emission,
     host-bind absolute-path baking under homeDir override.

#### Upgrade note

The new operator socket only binds when `apply` re-emits the compose
file with `operatorUid` set. Run `switchroom update` (or
`switchroom apply --non-interactive` + `docker compose up -d
--remove-orphans`) after upgrading to v0.7.16 to pick it up. Existing
agent-side flows are unaffected — the change is purely additive.

## v0.7.15 — vault UX epic + PID-file flock

Bundles five PRs landed since v0.7.14: the second half of the #969
vault UX epic (P0b / P1a / P1b / P2c — gateway error rendering,
agent-initiated save, write-grants, unified `/vault audit`) plus the
v0.7.14 sprint's final tier-3 follow-up (#964 PID-file flock).

### Save secrets from Telegram, end-to-end (#969 P1a — #975)

The completion of the #969 epic's product loop. From any Telegram
chat the user can now:

  - paste a secret, OR ask an agent to save one
  - tap a single button to confirm (with optional rename)
  - verify the key landed in the vault

…without ever touching a host shell. Two moving parts:

  1. **`vault_request_save` MCP tool.** Agents call it with `{chat_id,
     key, value, why?}` when the user supplies a secret and asks to
     save it. The gateway stages the value server-side (in memory only;
     never echoed back to the agent or logged), renders an `apv:`-style
     approval card with [✅ Save once] [🚫 Discard] [✏️ Rename]
     buttons in the user's chat.
  2. **Broker passphrase attestation.** New optional `passphrase` field
     on broker PUT requests. When supplied and matching the broker's
     loaded passphrase, the call is authorized as if the operator had
     run `switchroom vault set` from the host shell — bypasses path-
     as-identity, ACL, the unknown-key gate, and the kind-mismatch
     check. Wrong-passphrase fails closed with `method:"passphrase"
     DENIED` (does NOT fall through, so a typo can't mask the wrong-
     attestation signal). Audit logs tag method:"passphrase" so this
     auth path is distinct from grants and peercred.

The `vrs:` callback router (Save/Discard/Rename) carries the cached
operator passphrase forward through `defaultVaultWrite` → CLI →
broker PUT.

### Write-grants — agents can create keys with operator consent (#969 P1b — #973)

Pre-v0.7.15, grants were read-only. Agents could rotate existing
keys via the broker but couldn't *create* new ones, which blocked
the deferred-secret save flow the previous bullet enables.

  - New `write_allow` column on `vault_grants` (JSON array of literal
    keys and/or prefix-globs ending in `*`). Idempotent schema
    migration: `PRAGMA table_info` check + `ALTER TABLE ADD COLUMN`
    with `DEFAULT '[]'` so existing rows stay read-only.
  - `validateGrantForWrite` mirrors the read-side validator, consults
    `write_allow` with prefix-glob support, returns typed
    `WriteDenyReason` so audit logs name the missing capability
    (`grant-write-not-allowed`) distinct from read denials
    (`grant-key-not-allowed`).
  - Broker PUT path consults write-grants BEFORE the legacy
    path-as-identity rule. A valid write-grant is the identity (the
    token IS the caller) — no `<agent>` arg needed.
  - `switchroom vault grant --write <key-or-prefix>` on the CLI; can
    combine with `--read` for full-access grants.

### Telegram-honest error rendering for vault CLI failures (#969 P0b — #972)

P0a (#971, in v0.7.14) made `switchroom vault` emit stable stderr
markers + exit codes when running inside an agent sandbox. P0b
consumes them in the gateway so the user-facing failure UX explains
what to do instead of dumping a raw `Vault file not found …` /
`VAULT-NEEDS-APPROVAL …` blob.

New `telegram-plugin/secret-detect/vault-error.ts`:

```
parseVaultCliError(stderr) → { kind, original, key? }
renderVaultCliError(parsed, { verb, key }) → { html, suppressRaw }
```

Maps each marker to a copy-pasteable host command:

  - `VAULT-SANDBOX-CONTEXT` → "⚠️ This action must run on the host."
    plus `<pre>switchroom vault <verb> <key></pre>`
  - `VAULT-NEEDS-APPROVAL` → "⚠️ New vault key — operator approval
    required." plus forward-pointer to the one-tap save card from
    #975 above.
  - `VAULT-BROKER-UNREACHABLE` → recovery hint pointing at
    `switchroom vault broker status`.

### Unified `/vault audit <agent>` Telegram command (#969 P2c — #980)

One mental model for operators auditing an agent's credential
surface. Single Telegram command renders, in one card:

  - Read grants for the agent (id · keys · expiry)
  - Write grants for the agent (id · keys/globs · expiry — new
    in #969 P1b above)
  - `schedule[i].secrets[]` from `switchroom.yaml` (with cron
    schedule)
  - Summary line: N read, N write, N cron entries

Previously these three surfaces were spread across `/vault grants`,
reading `switchroom.yaml` on the host, and (for write-grants) nowhere
— operators had to mentally union them. With write-grants now in
play, a unified view is load-bearing.

Implementation reuses `listGrantsViaBroker(agent)` once and
partitions by `key_allow.length > 0` (read) and
`write_allow.length > 0` (write); a grant with both capabilities
appears in both sections. Broker failures and config-load failures
render as inline warnings rather than blocking the rest of the
card so partial views still ship.

### PID-file flock with holder PID in busy errors (#964 — #974)

Replaces `proper-lockfile`'s sentinel-directory flock with a
PID-file written to `<vaultPath>.lock`. Closes plan v3 §11's ask
for diagnosable busy errors.

  - Acquisition: `openSync(O_CREAT|O_EXCL)` + write
    `<pid>\n<ts_ms>\n<argv0>\n` and fsync. Kernel-atomic
    create-if-not-exists; file content is human-readable so any
    operator (or peer process) can `cat` it.
  - Contention error gains the holder PID and acquired-ago seconds:
    `vault busy: held by pid 12345 (acquired 2s ago) at <path>
    (retried for 5000ms). …`
  - New `VaultBusyError` carries `holderPid` / `heldForMs` /
    `lockPath` / `budgetMs` as structured fields; threaded through
    `VaultError.cause` so the gateway error renderer from #972 can
    consume them programmatically without re-parsing the message.
  - Stale-lock recovery: dead holder PID → unlink + retry (no
    waiting). Liveness via `/proc/<pid>` on Linux, `kill(pid, 0)`
    portably.

**v0.7.14 → v0.7.15 migration.** v0.7.12-v0.7.14 left
`<vaultPath>.lock` as a directory (proper-lockfile sentinel).
v0.7.15's acquirer detects `EEXIST + statSync.isDirectory()` and
treats it as a stale legacy sentinel: rmdir the contents, retry
the openSync. Safe under the standard `switchroom update` flow
because the recreate step SIGTERMs any v0.7.14 writer. Operators
running the v0.7.15 host CLI against a still-running v0.7.14
broker should bounce the broker first — see #979.

Four follow-ups filed for soft-edge cases identified during
review: PID-reuse defense via `acquiredAtMs` (#976),
unparseable-lockfile + mtime-stale heuristic (#977), real
concurrent-acquirer test via `worker_threads` (#978), and the
v0.7.14 → v0.7.15 upgrade-window operator note (#979).

### Migration

None required beyond restarting the broker. `proper-lockfile`
removed from package.json; no consumer code-change.

Patch release. Update via `switchroom update` from any operator
host; in-Telegram via `/update apply` (docker hosts: host-side
CLI, per the v0.7.13 docker-availability guard).

## v0.7.14 — tier-1 follow-ups + docker e2e CI gate

Five issues from the v0.7.12 / v0.7.13 sprint, closed in PR #966.

### Unit + e2e coverage for the #958 deploy regression class (#961, #962)

The v0.7.12 deploy hotfix (#958) shipped without unit coverage for
the failure mode it fixed — both bugs were caught only by self-
deploying against the operator's actual fleet. v0.7.14 closes the
test gap on two layers.

**Unit (#961).** `apply.ts`'s inline vault-bind-mount-dir guard is
now two pure helpers (`resolveVaultBindMountDir`,
`inspectVaultBindMountDir`) covered by `apply-vault-guard.test.ts`.
Sixteen cases pin the four enumerated path-resolution branches
(default legacy, default new canonical, custom path, no path)
plus the six MigrationResult kinds and the artifact-whitelist
inspection (ok, missing, lockfile, sentinel-dir, atomic-write
sibling-tmp, unexpected operator backups).

**E2e (#962).** `phase2c-vault-integration.test.ts` now exercises
the full op:put rotation flow against a live broker container:
alice rotates her own scoped key, the broker re-encrypts the vault
on disk, the next op:get returns the new value. Asserts the
vault.enc sha changed, the proper-lockfile sentinel-dir was
cleaned up post-write, no cross-agent smear, plus the denial
cases (cross-agent ACL, unknown-key, kind-mismatch). The full
chain runs under the exact mount geometry + cap_drop/cap_add
shape compose emits — both #958-A (missing DAC_OVERRIDE) and
#958-B (wrong vault-dir guard path) would have failed the test
instead of shipping.

### CI gate for docker e2e (#962)

New workflow at `.github/workflows/docker-e2e.yml`. Builds the
phase1b-test image set on a clean-room runner, aliases them as
phase2a/2b-test, runs `tests/docker/` against real containers.
Triggered narrowly: PRs touching `src/vault/**`,
`src/cli/apply.ts`, `src/agents/compose.ts`,
`src/agent-scheduler/**`, the broker/agent/kernel/base
Dockerfiles, or `tests/docker/**`.

Two pre-existing test-isolation bugs were fixed to make the full
suite green in CI:

  - `broker-ipc-race.test.ts:265` — `kernelLookup` defaulted its
    `container` argument to the production container shape
    `switchroom-${agent}`. On a clean-room runner that container
    doesn't exist (every exec returned exit=1, manifesting as
    "0/45 succeed"); on the operator's box where the production
    fleet runs, the test would silently exec into the live
    production kernel socket. Default removed, all callsites pass
    the project-prefixed test fleet container.
  - `_prod-snapshot.ts:27` — the prod-drift filter regex only
    matched `switchroom-phase<digit>` (single-container pattern).
    It missed the compose-project pattern `phase<digit><letter>-`
    used by broker-ipc-race and per-agent-isolation, so any
    orphan from a failed fleet test cascaded into the prod-drift
    assertion of every subsequent docker test. Filter now
    matches both shapes.

### Doctor probe + doc backfill (#960, #963)

**#960.** `switchroom doctor` chromium probe honors
`$PLAYWRIGHT_BROWSERS_PATH` (the env var set by v0.7.13's baked
image at `/opt/playwright/browsers/`) and recognizes the modern
`chrome-linux64/chrome` (Playwright >=1.40) plus
`headless_shell` binary variants. Before v0.7.14, the probe only
checked the legacy `~/.cache/ms-playwright/<entry>/chrome-linux/chrome`
path and reported missing on the v0.7.13 layout even though the
binary was present.

**#963.** Plan v3 §12 deferred docs caught up to the v0.7.12
vault layout:

  - `CLAUDE.md` runtime-architecture section gained a paragraph
    on the file→directory migration, the 5-state migration
    machine in `src/vault/migrate-layout.ts`, and the
    bind-mount artifact whitelist.
  - `README.md` corrected the stale
    `~/.switchroom/vault-broker.sock` reference (post-v0.7 it's
    per-agent at `/run/switchroom/broker/<agent>/sock`) and the
    `switchroom-broker` container name (compose emits
    `switchroom-vault-broker`).
  - `reference/share-auth-across-the-fleet.md` cross-links the
    vault op:put rotation flow as the broker-pattern precedent
    for the proposed auth-broker design.

### Migration

None. Patch release. Update via `switchroom update` from any
operator host; in-Telegram via `/update apply` (docker hosts:
host-side CLI, per the v0.7.13 docker-availability guard).

## v0.7.13 — v0.7.12 deploy hotfix + Playwright in agent image

Two-part patch release. The vault hotfix is forced by the v0.7.12
deploy regression caught when self-deploying against the operator's
fleet (clean unit-test pass, but real-world EACCES on the broker
container's RW write to the host vault dir). The Playwright bake
rides along since v0.7.13 is recreating containers anyway.

### Vault deploy hotfix (#958)

Two bugs in v0.7.12's apply / compose-gen path:

**Bug 1 — vault-dir contents guard scanned the wrong directory.**
`apply.ts` used `dirname(customVaultPath)` to derive the dir to
scan against `KNOWN_VAULT_ARTIFACT_NAMES`. For operators whose
configured `vault.path` was the legacy `~/.switchroom/vault.enc`
(very common — the v0.7.0–.11 default), `customVaultPath`
resolved to that path, so `dirname` returned `~/.switchroom`
itself — the parent of the LEGACY file, NOT the new bind-mount
target. The operator's actual `~/.switchroom/` contains many
sibling dirs (approvals, web-token, worktrees, plus assorted
backups and dotfiles) and the guard correctly refused to mount
because none are in the artifact whitelist.

Fix: only use `dirname(customVaultPath)` for genuinely custom
paths (state `custom-path-skipped`). For default-config
operators, the bind-mount target is always the new canonical
`~/.switchroom/vault/` parent — derive that explicitly.

**Bug 2 — broker couldn't WRITE to the host-owned vault dir.**
`cap_drop: ALL` strips DAC_OVERRIDE. Without it,
container-root (broker runs as uid 0) could READ via
DAC_READ_SEARCH (kept since v0.7.4) but rejected mkdir + write
into the operator's host vault dir. Surfaced as
`EACCES: permission denied, mkdir '/state/vault/vault.enc.lock'`
when the broker's saveVault flock-sentinel-dir step ran.

Fix: add `DAC_OVERRIDE` to broker `cap_add`. Trust posture is
consistent — broker already holds the passphrase + decrypted
secrets in memory; allowing write capability is not an
expansion of access, just of operations.

Both bugs caught by self-deploying v0.7.12 against the
operator's fleet (not by unit tests). After the hotfix:
end-to-end calendar-skill refresh works (broker put → write
persists → re-read returns fresh token → MS Graph 200), and a
real calendar event was created via `calendar.py create-event`
to confirm the full chain.

### Playwright in agent image (#956)

Skills using browser automation (calendar, scrape, UI-test)
called `npx playwright`, which triggered an on-demand download
of chromium binaries (~150MB) into `~/.cache/ms-playwright/`
per agent on first call (~30s latency, plus N copies across
the fleet's home dirs).

v0.7.13 pre-bakes Playwright + chromium into the agent image
via `playwright@^1.49.0` + `playwright install --with-deps
chromium`. `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers`
puts the binaries in an image layer so they're shared across
the fleet, not duplicated per-agent. First-call latency drops
from ~30s to ~0s.

Operators wanting Firefox / Webkit can install them per-agent
via `npx playwright install <browser>` from inside the
agent — chromium is just the bake-in default.

Image size grows ~150MB; net savings on the fleet (one image
layer vs N per-agent home-dir caches). CI rebuilds the image
on each main merge so the playwright npm version + browser
binary stay in lockstep.

Non-blocking follow-up: `switchroom doctor`'s chromium probe
still scans `~/.cache/ms-playwright/`. With the new
`PLAYWRIGHT_BROWSERS_PATH`, the probe will say "chromium: not
found" even though it's baked. Soft warning only ("only
required for playwright-based skills"); fix tracked for v0.7.14.

### Operator action

`switchroom update` runs the migration auto-step and recreates
containers. v0.7.12 → v0.7.13 is a transparent upgrade.

## v0.7.12 — vault layout: dir-mount + atomic-rename + flock (closes #951, #952, #954)

v0.7.11 introduced broker-mediated vault writes (`op:put`) so OAuth-shaped
skills could rotate their refresh tokens without the operator passphrase.
The feature was correct; the **deployment was DOA** because of how the
broker container bind-mounted the vault.

### What was wrong (per #954 RCA)

The broker container had `~/.switchroom/vault.enc` bind-mounted as a
**single-file mount** at `/state/vault.enc`. Two problems stacked:

1. **`:ro` flag** prevented writes outright.
2. **Single-file bind-mount = different filesystem device** than the
   parent dir inside the container (`stat`: `device=66306` for the
   bind-mount target, `device=4194306` for `/state/`).
   `atomicWriteFileSync` writes a sibling temp file in the parent dir
   and `rename()` to the destination. Cross-fs rename is `EXDEV`;
   Linux surfaces it as `EBUSY` for an in-use bind-mount target.

Surface symptom: clerk's calendar skill failing every refresh with
`VAULT-BROKER-DENIED [INTERNAL]: Failed to persist: EBUSY: resource
busy or locked, rename '/state/.vault.enc.7.<ms>.tmp' -> '/state/vault.enc'`.
The bug was structural, not transient — broker did NOT auto-recover;
every retry produced the same EBUSY because the mount layout was the
same. (#954 listed three suspects — process holding fd, fs-lock, sd_notify
— all wrong; the actual cause is the cross-fs rename.)

### Fix — vault parent directory bind-mounted RW

The compose generator now mounts `~/.switchroom/vault/` (parent dir,
RW) at `/state/vault/` instead of mounting `vault.enc` directly.
`saveVault`'s write-temp-then-rename works because temp + dest are on
the same filesystem.

### Layout migration

Existing operators have `~/.switchroom/vault.enc` as a regular file.
`switchroom apply` runs a state-machine migration helper before
compose generation:

| State | Old path | New path | hashes equal? | Action |
|---|---|---|---|---|
| **A: virgin** | absent | absent | — | no-op |
| **B: pre-migration** | regular file | absent | — | migrate |
| **C: partial-finished** | regular file | regular file | yes | finish symlink |
| **D: post-migration** | symlink → vault/vault.enc | regular file | — | no-op |
| **E: divergent** | regular file | regular file | no | REFUSE; print recovery |

State E catches the case where an older switchroom CLI wrote to the
legacy path AFTER migration ran (Linux `rename()` does not follow a
symlink at the destination — it REPLACES the symlink with the new
regular file). The recovery message names exact `mv` commands for
operator-side resolution.

The migration helper acquires the same flock saveVault uses, before
hashing both paths — defeats the broker-writes-between-hashes TOCTOU.

After migration, `~/.switchroom/vault.enc` is a symlink to
`vault/vault.enc`. v0.7.10 and v0.7.11 CLIs reading through the
symlink keep working. The symlink is **sunset in v0.7.14**.

### Concurrent writes — flock in saveVault

Post-#952 (op:put), broker AND host CLI both write the vault file.
`saveVault` now acquires an exclusive lock via `proper-lockfile` with
a 5s retry budget. Migration helper acquires the same lock during
hash-compare so a concurrent broker write doesn't perturb the state
detection.

### Broker-side state-E detection

If `switchroom apply` isn't run (e.g. an older CLI just wrote to the
legacy path), broker startup ALSO checks for the divergent state and
refuses to unlock — producing a fatal error pointing at `switchroom
apply`. Drift is caught either at next apply OR at next broker
restart, whichever comes first.

### Symlink sunset schedule

| Version | Behavior |
|---|---|
| **v0.7.12** | Migration runs; symlink created at old path |
| **v0.7.13** | Migration runs (idempotent); CLI emits warning if writes resolve through the symlink |
| **v0.7.14** | Migration runs (full state machine **plus** cleanup pass); after migration, symlink is removed |

**Critical:** Every v0.7.x release ≥ v0.7.12 runs the full migration
state machine on apply. An operator who pins `switchroom@^0.7` and
skips .12 and .13 → lands on .14 → still gets the full migration
(plus cleanup), not cleanup-only.

### Operator action required: none

The migration runs automatically on the next `switchroom update` /
`switchroom apply`. State A (virgin install) and state D
(already-migrated) are no-ops. State B/C are auto-resolved. State E
is fatal and prints a recovery recipe — one short manual `mv` + `rm`
sequence the operator runs to pick which file to keep.

### Backup tooling note

Backup tools that don't follow symlinks (rsync default, restic, tar
default) will start backing up the symlink at `~/.switchroom/vault.enc`
instead of the file content. Either update your backup path to
`~/.switchroom/vault/vault.enc`, or pass `--copy-links` / `-L`.

### Threat-model trade-off

#952 added passphrase retention in broker memory. v0.7.12 adds vault
file write capability inside the broker container. A pwned broker
that previously could exfiltrate decrypted secrets can now ALSO
persist correctly-encrypted poison content. Mitigations: audit log
every `op:put` (already in #952; ship logs off-broker as a follow-up);
vault-writer sidecar pattern (Option C in plan v3) deferred until CIS
hardening or write-grants are needed.

### Closes

- **#951** asks 1 + 3 (write-capable broker path + auto-refresh-on-stale)
- **#952** end-to-end deployment (was DOA pre-this-release)
- **#954** EBUSY-loop RCA (root cause: cross-fs single-file bind-mount)

### Test plan

- 5270 vitest pass + 6 new flock concurrency tests + 5 new broker-side
  drift detection tests + 16 migration-helper state-machine tests.
- Compose-gen test pins the new mount shape (RW dir-mount, no legacy
  single-file).
- Manual end-to-end smoke deferred until post-deploy: clerk runs
  ms_graph_token.py → token rotates → broker put persists → next read
  returns the fresh token → calendar event creation against MS Graph
  succeeds.

## v0.7.11 — broker `op:put` for agent-driven vault rotation (closes the OAuth refresh-token loop)

This release makes OAuth-shaped skills self-healing. Until now, agents
could read keys from vault via the broker but writes required the
operator passphrase, which agents don't have. Skills that store
rotating refresh tokens — clerk's calendar skill is the canonical case;
any IDP-token pattern is in the same boat — could read their token,
exchange it for fresh access + (possibly-rotated) refresh, then DROP
THE NEW TOKENS ON THE FLOOR because `switchroom vault set` failed
without the passphrase. The skill would silently lose every refresh,
forever.

**Fix (#952).** The broker grows an `op:put` with the same
`schedule.secrets[]` ACL that already gates `op:get`. An agent that
can READ a key can also ROTATE it. Skills that already shell out to
`switchroom vault set` keep working unchanged — the CLI now tries
broker put first when no passphrase is available. Result: clerk's
calendar refresh + persist + next-read cycle works end-to-end without
operator hand-holding.

### Protocol

- New `PutRequestSchema` — `{ v: 1, op: "put", key, entry, token? }`.
  Entry is string OR binary. `kind: "files"` is excluded — multi-file
  rotation stays operator territory.
- New `OkPutResponseSchema` — `{ ok: true, put: true, key }`.

### Server

- The vault passphrase is now retained in a private field after unlock
  so the broker can re-encrypt for op:put. Trade-off documented in a
  block comment: a pwned broker now exposes the passphrase too, but
  the marginal expansion over the already-exposed decrypted secrets
  is small (an attacker who can dump broker memory can already
  exfiltrate every secret; retaining the passphrase additionally lets
  them re-encrypt the on-disk vault). Zeroed on lock.
- `op:put` handler — requires unlocked vault + path-as-identity (token
  grants stay read-only); applies `checkAclByAgent`; refuses to
  introduce new keys (UNKNOWN_KEY); refuses kind mismatch
  (BAD_REQUEST). On success: in-memory update + `saveVault` atomic-
  write. On persist fail: rolls back in-memory state. Audit rows
  mirror op:get format (key name only, NEVER the value).

### Client

- New `putViaBroker(key, entry, opts)` returning a `PutResult`
  discriminated union (`'ok' | 'unreachable' | 'denied' | 'not_found'`)
  matching the existing `getViaBrokerStructured` shape.

### CLI

- `switchroom vault set` routes through the broker BEFORE prompting
  for a passphrase when stdin is piped, no env passphrase, no `--file`,
  no `--allow`/`--deny` scope flags. The skill's existing `_vault_set`
  shell-out hits this path automatically. Operators with
  `SWITCHROOM_VAULT_PASSPHRASE` set in their host shell still get the
  legacy direct-write path.

### Operator impact

After `switchroom update` + recreate:
- The calendar skill self-heals on every refresh window — no more
  operator intervention.
- Other OAuth-style skills (any skill that calls `switchroom vault
  set` from agent context) get the same self-healing for free.
- Existing operator workflows (host-side `switchroom vault set`)
  unchanged.

### Out of scope (follow-ups)

- Token-based grant **writes** — grant tokens stay read-only by
  design; introducing write-grants is a separate design discussion.
- Multi-file entry rotation — `kind: "files"` is excluded from put.
  Operators rotate those via host-side write.
- New-key creation — broker put refuses UNKNOWN_KEY. Agents rotate,
  operators introduce. Could relax with a per-agent prefix-allowlist
  if a use case emerges.
- Reviewer follow-ups: BAD_REQUEST hint should suggest the host-side
  fix; consider gating passphrase retention behind "auto-unlock was
  used"; add a `secrets:` example to `examples/switchroom.yaml`.

## v0.7.10 — `switchroom vault` CLI honors `SWITCHROOM_VAULT_BROKER_SOCK`

Companion patch to v0.7.9. v0.7.9 fixed compose to emit
`SWITCHROOM_VAULT_BROKER_SOCK` (canonical client-side env name) into
agent containers, and verified the broker client + secret-guard hook
+ boot-card probe were all reading it. But the **`switchroom vault`
CLI subcommands** had their own manual broker socket resolution that
**skipped the env entirely** — going straight from
`config.vault?.broker?.socket` to the legacy `~/.switchroom/vault-
broker.sock` fallback (which is a dangling symlink inside an agent
container, via the #910 home-symlink fix).

Operator surface: clerk's calendar skill called `switchroom vault
get microsoft/ken-tokens`, the CLI ignored the canonical env that
v0.7.9 just set, fell through to the dangling fallback, and reported
`VAULT-BROKER-DENIED: broker not running`. Direct broker IPC from
the same container returned the token cleanly. The skill saw "no
token" and refused to add the calendar item.

**Fix (#949).** Five CLI files routed through the canonical
`resolveBrokerSocketPath()` from `src/vault/broker/client.ts`:

  - `src/cli/vault.ts` — vault get/list/put main surface
  - `src/cli/vault-broker.ts` — broker management
  - `src/cli/vault-doctor.ts` — vault doctor
  - `src/cli/vault-grant.ts` — grant management
  - `src/cli/vault-auto-unlock.ts` — auto-unlock setup

Each pre-fix branch did `resolvePath(config?.vault?.broker?.socket
?? "~/.switchroom/vault-broker.sock")`; post-fix uses
`resolveBrokerSocketPath({ vaultBrokerSocket: ... })` which honors:

  1. `opts.socket` (explicit caller override)
  2. `SWITCHROOM_VAULT_BROKER_SOCK` env (compose-set; the regression
     fix)
  3. `opts.vaultBrokerSocket` (config-derived)
  4. `~/.switchroom/vault-broker.sock` (legacy default)

**Tests.** New `src/vault/broker/resolve-socket-path.test.ts` pins
the precedence so a future refactor can't silently drop the env
step again. 6 cases.

**Operator impact.** Existing v0.7.9 fleets needed `switchroom
update` to pick up the corrected compose env. v0.7.10's CLI fix
takes effect inside agent containers automatically once the new
agent image is pulled — the env is already in place from v0.7.9;
this patch just makes the CLI read it.

## v0.7.9 — broker socket env: canonical name + agent-perspective path

Single-fix patch release for a regression discovered during the
v0.7.8 deploy. The compose generator was emitting two stacked bugs
in how the broker / kernel socket paths plumbed into agent
containers, and an operator-side `VAULT-BROKER-DENIED: broker not
running` error was the surface symptom even when the broker
container was up, healthy, and listening.

**Bug 1 — broker env var name drift (#947).** Compose emitted
`SWITCHROOM_BROKER_SOCKET` into agent containers, but the broker
*client* (`src/vault/broker/client.ts:293`) and the secret-guard
hook (`telegram-plugin/hooks/secret-guard-pretool.mjs:36`) both
read `SWITCHROOM_VAULT_BROKER_SOCK`. The set name was the broker
*server*'s bind-path env (which is set inside the broker container,
where the daemon needs it). Clients in agent containers silently
fell through to the legacy `~/.switchroom/vault-broker.sock`
fallback — a dangling symlink inside the container — and reported
"broker not running" even when the broker was fine. Kernel side
was already correct.

**Bug 2 — wrong path value, both broker and kernel (#947).** Compose
emitted `/run/switchroom/broker/<name>/sock` and `/run/switchroom/
kernel/<name>/sock`, the per-agent subdir as seen by the broker /
kernel containers. But the agent mounts the per-agent volume at
`/run/switchroom/broker` and `/run/switchroom/kernel` directly
(one level shallower than the broker / kernel see it), so inside
the agent the actual sockets are at `/run/switchroom/broker/sock`
and `/run/switchroom/kernel/sock`. Even with the right env name
the value was a path that didn't exist inside the agent.

**Operator impact.** Existing v0.7.8 fleets were running with the
broken env — most workflows didn't notice because vault access
goes through several routes and not all of them hit this lookup.
The secret-guard hook (which gates tool calls that touch vault-
ref'd keys) was the surface that consistently failed. Operators
running `switchroom update` will pick up the new env vars
automatically; agents will reconnect to the broker on the next
request without further intervention.

**No new features in this release** — only the regression fix.

## v0.7.8 — Phase 4 cron-fold-in, honest doctor, host-update CLI

This release closes the v0.7 docker migration with the cron-fold-in
cutover, lands the new operator-facing `switchroom update` and
Telegram `/update` verbs, and stops `switchroom doctor` from crying
wolf about per-agent UID-isolated state files. Net: a multi-agent
fleet on a shared host is now self-healing, observable, and updatable
without leaving Telegram.

### Phase 4 — cron in the agent container, `switchroom-cron` retired

The Phase 4 cutover landed across four PRs that gated the change
behind a canary so a regression couldn't break operator fleets
mid-flight:

- **`dispatchAsInbound` primitive (#890)** — synthesizes a cron fire
  as an `InboundMessage` and dispatches it through the same IPC
  path Telegram uses, so cron-originated turns reach the agent
  through one well-understood code path instead of `docker exec`.
- **Phase 2 — in-agent scheduler sibling, gated/opt-in (#891).**
  The new sidecar shipped first as opt-in; operators could enable
  it per-agent and verify before any default change.
- **Phase 3 — canary dual-run + mutual exclusion (#892).** The host-
  side singleton and the in-container sidecar ran together with
  mutual-exclusion gating so neither would double-fire — proves
  the cutover safe under live traffic.
- **Phase 4 — cron-fold-in cutover (#893).** The singleton
  `switchroom-cron` container is gone. Cron now runs in-container
  in every agent as a sibling of the gateway, delivering fires
  through the same `InboundMessage` IPC path Telegram uses
  (synthesized turns tagged `meta.source="cron"`). One less
  container, one less daemon, one less mode of failure. See
  `docs/scheduling.md` for the post-cutover model.

**Robustness across the in-container scheduler.**

- `cronMatchesDate` accepts node-cron's MON-FRI / JAN aliases (#896 /
  #915) — the replay-on-boot path was silently dropping schedule
  entries that used named days/months.
- Boot-time freshness check defends against PID reuse across
  container restarts wedging the supervisor (#895 / #914).
- `restartAgent` uses `up -d --no-deps` instead of `restart` (#857 /
  #916 / #932 / #944) — fixes the kernel-readiness race after a live
  `agent add` and matches the contract the rest of the lifecycle
  code expects.
- `collectScheduleEntries` walks the cascade-resolved config (#917)
  — was reading raw `config.agents[name].schedule` and dropping
  defaults / profile schedule entries silently.
- Empty schedule idles instead of restart-cap'ing (#921 / #928 /
  #936) — agents with no `schedule:` block stay alive for cron
  re-checks on container restart instead of the supervisor giving
  up after 10 cycles.

**Phase 4 follow-on cleanup (#897 / #899 / #913).** Stale
`build.mjs` comment, CI matrix referencing the deleted
`Dockerfile.scheduler`, and `docs/configuration.md` still describing
the v0.6 systemd model — all cleaned up.

### `switchroom update` — one verb for the host-update flow

**`switchroom update` CLI verb (#918 / #923).** Wraps `git pull` +
`bun install` + `npm run build` + `switchroom apply` + `docker
compose up -d --remove-orphans` + `switchroom doctor` into a single
command. `--check` for a dry-run; `--rebuild` for source-checkout
users; `--skip-images` for offline mode; `--status` for a read-only
snapshot.

**`switchroom apply` self-elevates (#920 / #922).** Prior versions
required the operator to type `sudo HOME=$HOME PATH=$PATH bun
/path/to/switchroom apply` because vanilla `sudo switchroom apply`
hit a remapped HOME and lost the bun-resolved CLI. apply now
self-elevates via `sudo` cleanly.

**Telegram `/update` (#919 / #924).** Operator-side host update
without SSH. `/update` is dry-run; `/update apply` actually runs the
update. The agent container has no docker binary or
`/var/run/docker.sock` — `/update apply` probes both and surfaces a
clean error pointing at the host CLI rather than letting the
detached child fail with opaque exit-127 (#926 / #934).

**Telegram `/upgradestatus` (#927 / #938).** Read-only fleet update
status from any paired Telegram chat. Reports local CLI version,
GHCR image digest + pull time, container creation time per service.
Operator can answer "is the fleet up to date?" without SSH.

### Boot card and `/status` — honest about Phase 4

**Boot-card probes match the post-Phase-4 architecture (#925).**
The Crons probe was lying — it returned `ok` with detail
`"managed by switchroom-cron"`, but that container is gone. Replaced
with `probeScheduler` (lockfile + holder PID liveness + last-fire
freshness from `scheduler.jsonl`). Three other surfaces were
silently missing from the probe set:

- `probeBroker` / `probeKernel` — UDS connect-test against the
  per-agent socket paths. Compose has bind-presence healthchecks
  (#898) but the gateway itself never queried either daemon.
- `probeSkills` — walks `<agentDir>/.claude/skills/` and reports
  any entry whose target is unreadable (a renamed/deleted skill in
  `~/.switchroom/skills/` was dangling silently).

The boot card stays silent-when-healthy by design — only red surfaces.

**`/status` grows a `Health` block.** Same probe set as the boot
card, but renders **every** row including the green ones. Boot
card = quiet ack; `/status` = on-demand dashboard.

**Settle-window-aware soften (#935).** `/status` hit during the
first ~30s of a container's life would show a 🔴 row before the
supervisor had time to fork the scheduler. `probeScheduler` now
reads `/proc/1/stat` to compute container PID-1 start time and
softens the missing-lockfile fail to degraded with `(still settling)`
inside the freshness window. Plus env-path overrides
(`SWITCHROOM_AGENT_SCHEDULER_LOCK` / `_JSONL`) for symmetry with the
scheduler's own override behavior.

### Doctor — stops crying wolf

**EACCES vs ENOENT (#945).** Per-agent state files are mode 0600
owned by the agent UID (compose.ts allocates 10001-10999); doctor
running as the host operator gets EACCES when reading `.env` and
`.oauth-token.meta.json`. Pre-fix this manifested as 16 false-positive
fails on every multi-agent host: 8 `TELEGRAM_BOT_TOKEN missing` +
8 `not authenticated`. Now: warn rows with honest detail
(`unreadable from host — agent reads it fine`), real failures stand
out instead of being buried.

**Leaked `$HOME/.switchroom` detector (#910 / #933 / #943).** Agents
that pre-date the `$HOME/.switchroom` symlink fix have a real
directory at `<agentDir>/home/.switchroom/` that shadows the symlink
the new start.sh tries to create. start.sh defensively skips the
symlink when the slot is occupied — silently. Tilde paths in cron
prompts then resolve to a per-container empty dir instead of host
state. Doctor now flags this with a copy-pasteable recovery recipe.

**`start.sh` scheduler block check (#911).** If an operator
upgraded across the Phase 4 cutover without re-running `switchroom
apply`, their per-agent `start.sh` lacks the agent-scheduler sidecar
block. Doctor surfaces it.

**Post-apply doctor sweep (#929 / #937).** Bare `switchroom apply`
now runs `switchroom doctor` automatically on completion.

**Bind-mounts + tilde-paths (#907 / #910 / #911 / #912).** Agent
containers were missing skills/credentials bind mounts; tilde paths
broke under remapped HOME; doctor's stale-`start.sh` check was
unaware of the new scheduler supervisor block. Bundle fix.

**`agent list` scheduler-state column (#931 / #942).** New column
distinguishes `active` (lockfile fresh, recent fire), `idle` (alive
but no schedule entries), `wedged` (lockfile stale or holder PID
dead). Single command for "is cron working across the fleet?".

### Test discipline — phase tests must not clobber production

**The 2026-05-10 incident.** PR #916 un-skipped three destructive
docker phase tests on a host that also runs production switchroom.
Each test's `beforeAll` ran `docker rm -f switchroom-vault-broker`
and `switchroom-approval-kernel` to "clean up" — using the **production
singleton names**. The compose generator hardcoded those fixed
container_names too, so the tests' `docker compose up` collided
with live production containers. After the test's project-scoped
`compose down`, the production fleet had no broker or kernel — the
operator's `klanker` agent failed all `/vault` calls.

**Two-layer fix.**

- `productionFleetIsLive()` / `assertNoProductionFleet()` helpers
  (#939). Detection by `switchroom.fleet=switchroom` label, not by
  container name. Wired as `describe.skipIf(... || PROD_FLEET_LIVE)`
  into per-agent-isolation, broker-ipc-race, v0.7-install-e2e tests.
- `containerNamePrefix` parametrization on `generateCompose` (#939
  + #941). Defaults to `"switchroom"` — production unchanged. Tests
  pass `containerNamePrefix: PROJECT` so emitted names become
  `phase1c-iso-NNN-vault-broker` etc., which cannot collide with
  production. The `switchroom.fleet` label is also parametrized so
  parallel vitest forks don't false-positive each other (#941).

### Refactor

**Drop legacy v0.6 systemd dual-path code (#906).** Pre-Phase-4 the
codebase carried both systemd-supervised-host and
docker-compose-managed paths. Phase 4 makes docker mode the only
shape; this PR deletes the systemd branches entirely. Smaller
surface, cleaner naming.

### Persistent agent home + base packages

**Persistent agent `$HOME` (Layer 1) + Tier 1 base packages
(#887).** Agents now have a stable per-agent `$HOME=/state/agent/home`
that survives container recreation — `~/.bashrc`, `~/.config`,
shell history, anything an interactive session writes. Plus the
agent base image bundles the small set of Tier 1 OS packages
(python3-pip, build-essential, etc.) the common skills depend on,
so first-run `pip install` doesn't immediately fail with "command
not found". Closes the v0.7-era footgun where agents lost their
shell state on every restart.

**Layer 1 follow-ups (#888).** `pip install` resolves the agent's
`$HOME/.local/bin` correctly; agent UID resolves cleanly inside
the container; the v0.7 install e2e test asserts the persistent
HOME survives recreation.

### v0.6 → v0.7 cutover loose ends (operator-impact bugs surfaced
in real migrations)

- **Three migration bugs (#882)** — surfaced when an operator with
  a populated v0.6 install ran the docker cutover. Bundle fix.
- **Two more cutover bugs (#885)** — `.mcp.json` regenerated on
  apply (was inheriting v0.6 paths); gateway boot mutex now
  works under the docker process tree.
- **Docker-aware startup health probes (#886)** — no more
  "systemctl: not found" inside agent containers. The v0.6 health
  surface was systemd-shaped; the v0.7 probes detect docker mode
  and use `/proc` walks instead.

### Telegram surface fixes

**Progress card no longer freezes at "⚠ Stalled" (#889).** When the
streamer's keep-alive watchdog fired during a slow-but-not-stalled
turn, the card edited to "⚠ Stalled" and never recovered even after
the turn completed normally. Fixed.

### Docs

**Architecture docs refresh for post-Phase-4 (#900).** `docs/
architecture.md` and `docs/scheduling.md` updated for the in-
container scheduler model.

**CLAUDE.md refresh for v0.7.8 sprint (#930 / #940).** Operator-
agent runbook updated with new sidecar topology, env knobs
(`SWITCHROOM_INLINE_SCHEDULER`, `SWITCHROOM_AGENT_SCHEDULER_*`),
and self-restart command behavior under `/restart`, `/new`, `/reset`,
`/update apply`.

### Other

- DAC_READ_SEARCH on approval-kernel so the healthcheck works (#901)
- `switchroom apply` exits non-zero when scaffold fails (#903) +
  `--compose-only` escape hatch
- bake `switchroom` CLI into agent image (#904)
- bind-mount skills + credentials (#907 / #912)

## v0.7.7 — Docker migration: completed for fresh installs

This release completes the v0.6 → v0.7 docker migration. v0.7.0–7.3
shipped the compose generator, lifecycle dockerization, and broker
IPC; v0.7.4–7.7 close the gaps that prevented a fresh install from
working end-to-end. After this release, a new operator can install
switchroom, run `switchroom apply` + `docker compose up -d`, and
exchange Telegram messages with their first agent without any host-
side systemd, no dev checkout, and no manual sidecar wiring.

The full set of fixes since v0.7.0:

**v0.7.4 — broker hardening (#872, #873).**

- Broker container regains `DAC_READ_SEARCH` so root-in-container
  can read host-owned (mode 0600) `vault.enc` and `vault-auto-unlock`
  files that the surrounding `cap_drop: ALL` would otherwise block.
- `/etc/machine-id` is bind-mounted from host into the broker so
  the in-container AES key derivation matches what the host's
  `enable-auto-unlock` produced.
- The compose generator emits `/run/switchroom/broker/<agent>/sock`
  per agent (subdir form, matching the kernel pattern); the broker
  enumeration now accepts both flat `<agent>.sock` files and the
  subdir shape, and chowns sockets to the agent UID so non-root
  agent containers can connect.
- Agent containers run with `network_mode: host` so scaffolded
  `start.sh` reaches hindsight at `127.0.0.1:18888` and operator
  LAN devices unchanged from v0.6.
- python3 added to the agent base image so the hindsight memory
  plugin's session_end / session_start hooks work.
- `tty: true` + `stdin_open: true` on agent compose services so
  claude's interactive mode allocates a PTY and doesn't fall through
  to `--print` mode (which immediately errors with no stdin).

**v0.7.5 — in-container tmux supervisor (#874).**

- v0.6 ran tmux + autoaccept-poll outside the agent process (systemd
  ExecStart wrapped in tmux, ExecStartPost spawned the poller on the
  host). v0.7 dockerized neither piece: claude blocked forever on
  the dev-channels acknowledge prompt and `switchroom agent attach`
  failed with no tmux server inside the container.
- `profiles/_base/start.sh.hbs` now has a docker-mode preamble that,
  on first entry under tini, forks autoaccept-poll as a sidecar and
  re-execs into tmux with the same script as the inner command.
  Inside tmux the marker is set, the preamble is skipped, and claude
  starts normally with a real PTY at stdin.
- `docker/Dockerfile.agent` bakes the autoaccept-poll bundle to
  `/opt/switchroom/autoaccept-poll.js` so start.sh has a stable
  in-image path regardless of host install layout.

**v0.7.6 — gateway daemon + plugin baking (#875).**

- The MCP sidecar that claude spawns for the `switchroom-telegram`
  channel exits at boot if no gateway daemon is reachable: "no
  gateway socket; check `systemctl --user status switchroom-telegram-
  gateway`". v0.6 ran the gateway as a sibling systemd unit; v0.7
  had no equivalent.
- `start.sh.hbs`'s docker preamble now also forks
  `bun /opt/switchroom/telegram-plugin/dist/gateway/gateway.js` as
  a supervised sidecar (under a small `_switchroom_supervise` bash
  helper that respawns on crash with a 10-restarts-in-60s cap).
- `docker/Dockerfile.agent` bakes the telegram-plugin (`dist/`,
  `start.js`, `package.json`) into `/opt/switchroom/telegram-plugin/`.
- `scaffold.ts` emits a docker-mode `.mcp.json` (new `dockerMode?`
  parameter on `scaffoldAgent` and `reconcileAgent`) that points
  `--cwd` at the in-image path, `SWITCHROOM_CLI_PATH` at the
  in-image binary, and `SWITCHROOM_CONFIG` at the bind mount.
- The compose generator bind-mounts `switchroom.yaml` into each
  agent service so the gateway daemon can shell out to the
  switchroom CLI with `--config`.

**v0.7.7 — operator UX (#876).**

- `switchroom apply --only=<agent>` for one-at-a-time cutover.
  Scopes scaffold + UID-align to one agent so siblings still on
  systemd keep running while operators migrate piecemeal. Compose
  still walks the full fleet so per-agent socket volumes for
  not-yet-cutover agents stay correct in YAML.
- `docs/operators/migration-v0.7.md` (doc since removed) rewritten
  from the field: auto-unlock as a hard precondition, all-at-once vs
  one-at-a-time guidance, image-source clarification (`pull` vs `--build-local`),
  expanded snapshot step including systemd unit files.

**Also in this release window:**

- `agent list` reports correctly on host-shell systemd fleets
  during the v0.6 → v0.7 transition (#871). Was: every agent
  appeared `inactive`. v0.7 PR-C1 had docker-only-ized
  `getAgentStatus` without keeping the systemd branch.
- Manifest drift cleared (#871).

**Upgrade path for v0.7.0–v0.7.3 fleets:** rebuilt GHCR images
(`ghcr.io/switchroom/switchroom-{base,agent,broker,kernel,scheduler}:v0.7.7`)
include all of the above. `switchroom apply && docker compose pull
&& docker compose up -d` picks up the new images on existing fleets.
Read the updated migration doc — auto-unlock is now a hard
precondition (was an optional knob) and the compose chown loop has
the new `--only` flag.

## v0.7.3 — Runtime detection + audit fixes

Closes the v0.7.2 audit findings that survived into the released code.
Each finding was verified against live source before being patched.

**Fixes:**

- **`isDockerRuntime()` host-shell detection** (BLOCKER from audit §3a).
  v0.7.2 gated docker-aware branches on
  `process.env.SWITCHROOM_RUNTIME === "docker"` — but that env var is
  only set INSIDE containers (by `compose.ts`), never on the host.
  An operator running `switchroom agent status myagent` /
  `switchroom doctor` from their host shell got the systemd fallback
  even on a docker fleet, reporting "inactive" forever. v0.7.3 adds
  a unified helper `src/runtime-mode.ts isDockerRuntime()` that fires
  on EITHER signal: env var (in-container case) OR existence of
  `~/.switchroom/compose/docker-compose.yml` (host-shell case).
  Wired into `src/agents/status.ts:defaultStatusInputs`,
  `src/cli/agent.ts:preflightCheck`, and `src/cli/doctor.ts`'s
  `checkGatewayUnit` gate (which was calling `isDockerMode()` with
  no `composePath`, hitting only the env-var branch).

- **`vault-auto-unlock` placeholder pre-creation** (BLOCKER from audit
  §1a). v0.7.1's `ensureHostMountSources` mkdir'd directories but
  left files alone. The `~/.switchroom/vault-auto-unlock` mount
  source could still be created as a root-owned DIR by docker on
  greenfield installs (the same bug class v0.7.1 claimed to close).
  Apply now writes a 0-byte placeholder file at that path with mode
  0600 if missing; the broker reads empty bytes, fails decrypt,
  falls back to interactive unlock cleanly (per
  `src/vault/broker/server.ts:1503-1518`); a later
  `switchroom vault broker enable-auto-unlock` overwrites the
  placeholder via `writeFileSync` (per `auto-unlock.ts:199`).

- **Inline-button error message wrong service name** (audit §2a).
  v0.7.2's `case 'restart'` callback under docker pointed operators at
  `docker compose -p switchroom restart switchroom-${agent}`. But
  compose generates SERVICE name `agent-${name}` (`compose.ts:408`)
  with `container_name: switchroom-${name}`. `docker compose restart`
  takes a service, not a container — the suggested command would
  error with "no such service". Now correctly emits `agent-${agent}`.

- **`case 'logs'` callback systemd-only** (audit §2d). Sister of the
  audit §2a fix — v0.7.2 fixed `restart` but missed the same
  migration on the operator-events `logs` button. Under docker the
  inline-button log fetch (which shells out to `journalctl --user`)
  errored. Now under docker it returns an actionable message
  ("Run from the host: docker logs --since 30m --tail 30
  switchroom-${agent}") rather than spawning journalctl in a
  container without systemd.

- **`Status === "restarting"` distinct from "inactive"** (audit §3b).
  v0.7.2's `readDockerContainer` collapsed every non-running state
  into `inactive`, hiding the crash-loop signal that the
  now-disabled watchdog used to surface. v0.7.3 maps `restarting`
  to its own bucket so the renderer / status caller can tell a
  flapping container from a cleanly stopped one.

**Tests:** new `src/runtime-mode.test.ts` (4 cases covering env var,
compose file, neither, parent-only). Updated `status-runtime.test.ts`
to mock the runtime-mode helper. Added a `restarting` case for
`readDockerContainer`. 5077 vitest + 3330 bun pass (the 1 bun
failure is the new UAT smoke test from PR #868 which requires
`SWITCHROOM_UAT_CHAT_ID`, unrelated to this PR).

**Audit findings explicitly DEFERRED to v0.7.4+:**

- §2c: `triggerSelfRestart`'s 300ms IPC-flush grace doesn't actually
  drain the socket — the gateway's IPC code should `socket.end()` +
  await `'finish'` before the SIGTERM-to-PID-1 setTimeout fires.
  Architectural change; needs design.
- §4a: crash-loop signal silently lost when watchdog is disabled
  under docker. Either add `restart: on-failure:N` to compose or
  surface `RestartCount` via a periodic host-side scheduler check.
- §5a: under docker, `preflightCheck` only checks `start.sh`;
  docker-mode equivalents (image presence, compose validity, UID
  alignment readback) aren't yet covered. doctor's `runDockerSection`
  partially fills this but isn't invoked from agent lifecycle verbs.
- §6a: gateway code changes ship in `telegram-plugin/gateway/` which
  runs INSIDE the agent container; v0.7.2/v0.7.3 fixes only land on
  hosts that pull republished GHCR images. CHANGELOG should call
  this out at release time, and a tag→GHCR cycle should happen
  before announcing v0.7.3.

## v0.7.2 — Docker runtime alignment

Closes the v0.7-era code paths that still assumed the legacy systemd
runtime. Each was verified against live source (no audit assumptions)
before being patched.

**Fixes:**

- **`telegram-plugin/gateway/gateway.ts` self-restart** — the gateway's
  three `spawn('sh', ['-c', 'sleep … && systemctl --user restart …'])`
  callsites and the inline restart-button `execFileSync('systemctl', …)`
  all branch through a new `triggerSelfRestart(targetAgent, reason)`
  helper. Under `SWITCHROOM_RUNTIME=docker` the helper sends `SIGTERM`
  to PID 1 (tini) of the agent's container after a 300ms grace; tini
  propagates to the whole tree (claude → start.sh → gateway plugin),
  the container exits, and docker compose's `restart: unless-stopped`
  policy recreates it. Cross-agent restart (the inline-button case
  for a target other than this gateway's own agent) is rejected
  cleanly under docker with an actionable message — no docker.sock
  inside agent containers, by design. Under legacy systemd the helper
  preserves the existing detached `systemctl --user restart` shape.

- **`telegram-plugin/gateway/restart-watchdog.ts`** — the watchdog
  polls systemd's `NRestarts` counter to detect crash loops. There's
  no equivalent counter accessible from inside an agent container
  without mounting `docker.sock` (a deliberate security regression
  we avoid). Under `SWITCHROOM_RUNTIME=docker` the gateway now skips
  `startRestartWatchdog` entirely and logs the reason; container
  restart visibility comes from the boot card + gateway boot logs in
  docker mode.

- **`src/agents/status.ts`** — added `readDockerContainer` adapter
  that calls `docker inspect --format '{{json .State}}'` and maps
  `State.{Status,Pid,StartedAt}` into the canonical
  `{pid, activeEnterTs, active}` shape that `buildClaudeStatus` /
  `buildGatewayStatus` already consume. `defaultStatusInputs` picks
  systemd vs docker adapters based on `SWITCHROOM_RUNTIME=docker`.
  Under docker, both the Claude and gateway readers query the same
  `switchroom-<agent>` container — claude and the gateway plugin
  share that container in v0.7. With this, `switchroom agent status
  <name>` reports the right state for docker fleets.

- **`src/cli/agent.ts` `preflightCheck`** — the systemd-unit existence
  check (and the autoaccept-handler check that depends on parsing
  the unit file) is skipped under `SWITCHROOM_RUNTIME=docker`. Only
  the `start.sh` existence check still runs (it's runtime-agnostic).

- **`src/cli/doctor.ts`** — `checkGatewayUnit` (which validates a
  per-agent systemd gateway unit pins `Environment=SWITCHROOM_AGENT_NAME`)
  is now gated on `!isDockerMode()`. Under docker the analogous env
  var is set in compose.ts and verified by the dockerSection's
  compose-shape checks.

- **`profiles/_shared/telegram-style.md.hbs`** — agent skill copy that
  pointed users at `journalctl --user -u switchroom-<agent>` and
  `journalctl --user -t switchroom-watchdog` for restart forensics.
  Updated to lead with the docker equivalents (`docker logs --since
  2h …`, `docker inspect --format '{{.State.StartedAt}}{{println}}{{.RestartCount}}'`)
  and note the systemd commands as legacy fallbacks. Watchdog source
  documented as silent under docker (matching the runtime change above).

**Audit findings that were FALSE on current main** (verified against
live source, not just trusted from the audit):

- `doctor.ts` was claimed to hard-check for `systemctl`. Actually
  `checkBinary("docker", ...)` is the only binary check on line 147;
  there's no systemctl check.
- `README.md` was claimed to still advertise the systemd path. Actually
  every systemd / `--legacy` reference was already removed in the v0.7
  docs sweep.
- `docs/architecture.md` already says "v0.7+ runtime is Docker on
  Linux. The legacy systemd path was removed in v0.7."
- `docs/scheduling.md` has zero systemd references.

**No breaking changes** — every behavior under `SWITCHROOM_RUNTIME != docker`
is byte-identical to v0.7.1.

## v0.7.1 — v0.7 install hotfix

**Fixes (P0 install blockers from v0.7.0):**

- **Compose: vault file mounted as a directory.** The broker mount was
  `${HOME}/.switchroom/vault:/state/vault` but the actual vault file is
  `~/.switchroom/vault.enc` (a top-level file, not a `vault/` subdir).
  Docker auto-created the missing source as an empty root-owned
  directory on the host, the broker found no vault, and the fleet
  restart-looped. Now mounted as the file directly:
  `~/.switchroom/vault.enc:/state/vault.enc:ro` plus an explicit
  `SWITCHROOM_VAULT_PATH` env so the broker doesn't fall back to its
  `~`-expanding default (which resolves to `/root/...` inside the
  container).
- **Compose: agent containers crash-looped on `cd` to a host path.**
  Scaffolded `start.sh` bakes the absolute host path of `agentDir` at
  scaffold time (`cd "/home/<user>/.switchroom/agents/<name>"`), but
  the bind mount destination was `/state/agent` — so the host path
  didn't exist inside the container. Fixed by dual-mounting: the
  same host directory is bound BOTH at the canonical `/state/agent`
  (Dockerfile compatibility) AND at the original host path
  (start.sh compatibility). Same applies to `/state/.claude` and
  `/var/log/switchroom`. No image rebuild required to pick up this
  fix — operators just `switchroom apply` and
  `docker compose -p switchroom up -d`.
- **Apply: defensive `mkdir` on host bind-mount sources.** Before
  generating the compose file, `apply` now creates every directory
  that compose will bind-mount (under the operator's UID), preventing
  docker from auto-creating them as root. Closes the bug class that
  produced both the `~/.switchroom/vault` and
  `~/.switchroom/vault-auto-unlock` root-owned stub directories
  observed during v0.7.0 cutovers.
- **package.json: bump version to `0.7.1`.** It had been stuck at
  `0.5.2` across multiple releases; the gateway boot card reads
  `package.json` via `src/build-info.ts` and was reporting
  `v0.5.2 · #826` even on v0.7 fleets.

**Known v0.7 issues NOT addressed in this release** (filed as
follow-ups; impact: agent self-restart, `switchroom agent status`,
and the boot watchdog still assume systemd in places):

- `telegram-plugin/gateway/gateway.ts` spawns `systemctl --user restart …`
  for graceful restart and quota-rotation flows; needs a docker-aware
  branch (exit 0 and let `restart: unless-stopped` recreate the
  container).
- `telegram-plugin/gateway/restart-watchdog.ts` reads systemd unit
  state to detect crash loops; needs a `docker inspect` fallback.
- `src/cli/agent.ts` checks for `~/.config/systemd/user/switchroom-*.service`
  unit files in several lifecycle verbs even under `SWITCHROOM_RUNTIME=docker`.
- `src/agents/status.ts` `readSystemdUnitStatus()` is the only source
  of agent state for `switchroom agent status`; needs a `docker ps`
  fallback.
- `src/cli/doctor.ts` still hard-checks for `systemctl` and prints
  "Switchroom requires a systemd-based Linux distro".

## v0.7.0 — Docker-only (BREAKING)

**Breaking changes:**
- `switchroom up`, `switchroom init` now deprecation aliases for `switchroom apply`. Removed in v0.8.
- `switchroom update` replaced with deprecation shim that prints the docker upgrade recipe and exits 1.
- `switchroom systemd` verb tree removed entirely.
- `--legacy` flag on `switchroom up` removed; switchroom is docker-only on Linux now.
- Forum-mode prompts removed from `switchroom setup`; default is per-agent DM bots.

**Adds:**
- Static CLI binary distribution via GitHub releases + `install.sh`.
- GHCR image publishing on tag push.
- Compose generator includes top-level `name: switchroom` and absolute HOME paths.
- Vault preflight + compose-v2 detection in `apply`.
- UID alignment for bind-mounted agent state dirs (fail-hard by default; `--allow-unaligned` opt-out).

**Removes:**
- `bin/bridge-watchdog.sh` — Docker `restart: unless-stopped` + per-service healthchecks supersede.
- `src/agents/systemd.ts` and the entire systemd unit-template + reconcile machinery.
- 5 unit-targeted test files; 4 watchdog integration tests.

**Migration:** see `docs/operators/migration-v0.7.md` (doc since removed).

**Scope:** Linux only. Mac (Docker Desktop) validation tracked as Phase 3.5.

## v0.6.0 — Docker substrate (Linux), single-host

**Adds:**
- `switchroom up` runs the fleet under Docker Compose by default on Linux (per-agent containers, broker + approval kernel IPC ported to host-UID sockets).
- `switchroom up --legacy` keeps the systemd path for operators who want it.
- CI snapshot gate guarantees test runs leak zero containers onto host docker.

**Removes (vs the original RFC):**
- No `switchroom migrate to-docker/to-host` command. Fresh installs only.
- No Docker fleet watchdog port — `bin/bridge-watchdog.sh` continues to supervise the legacy systemd path; Docker fleets self-restart via compose `restart: unless-stopped`.
- No GHCR digest-pin workflow. Images build locally on `switchroom up`.

**Scope:** Linux only. Mac (Docker Desktop) validation tracked separately as Phase 3.5.

## v0.5.2 — 2026-05-07

Patch release. Unblocks `npm publish` (the v0.5.1 prepublish hook
failed on pre-existing tsc errors that masked stale field reads in the
approvals-list command).

### Fixed

- **Type-system catch-up to runtime usage (#779)** — declare
  `experimental` (`{ legacy_pty?, legacy_autoaccept_expect? }`),
  `telegram.webhook_dispatch`, and `WebhookHandlerArgs.dispatchConfig`
  on the config schema. Purely additive; no behaviour change. Follow-up
  #780 tracks extracting `ExperimentalSchema` with the
  `tmux_supervisor` → `legacy_pty` migration transform.
- **`/approvals list` field renames (#779)** — bring
  `telegram-plugin/gateway/approvals-commands.ts` field reads in line
  with the real `ApprovalDecisionMeta` shape (`agent_unit`, `action`,
  `ttl_expires_at`). Was silently rendering `undefined` for those
  columns.

## v0.5.1 — 2026-05-07

Twenty commits since v0.5.0. Headlines: approval-kernel RFC B
Phase 1 lands (IPC broker + SQLite kernel + Telegram card primitive),
Google Drive MCP integration ships end-to-end (RFC C — full
integration, desktop-loopback OAuth tier, `drive:` config block, CLI
connect/disconnect), gateway gains a card audit log + structured
`card-events.jsonl` tagging, and operational fixes for vault preflight,
self-restart UX, cron DM routing, and the bg-agent silent-card bug.

### Added

- **Approval kernel RFC B Phase 1 (#762)** — IPC broker + SQLite kernel
  + Telegram card primitive; the substrate for human-in-the-loop
  approval flows.
- **`waitForApproval` short-poll helper (#765)** — ergonomic agent-side
  API on top of the kernel.
- **Google Drive MCP integration — RFC C full landing (#763)**.
- **Drive CLI: `switchroom drive connect` / `disconnect` (#766)**.
- **Drive desktop-loopback OAuth tier (#767)** — RFC C tier 3, no
  service-account JSON required.
- **`drive:` config block (#768)** — first-class config, replaces /
  supplements env-var wiring.
- **Vault pre-flight check on `agent restart` (#773)** — fails fast
  with a clear message instead of looping on a locked vault.
- **Self-restart on non-admin commands + warn on admin cmds (#775)** —
  better UX when the gateway needs to bounce itself.
- **Card audit log (#777)** — `card-events.jsonl`, `tg-post` tagging
  with `turnKey` / `cardMessageId`, `sub_agent_finished` events, and
  50 MB × 5 file rotation for forensic replay.

### Changed

- **RFC docs land for the approval kernel (#756, #764)** — three RFCs
  (A bot-token, B kernel, C gdrive) and a follow-up alignment of RFC B
  with the shipped implementation (TTL default, schema columns, audit
  split).
- **`bun.lock` workspace name reconciled `clerk-ai` → `switchroom`
  (#750)**.

### Fixed

- **Bg-agent progress card goes silent (#759, fixes #757)**.
- **`approval-callback` signature alignment + `materializeBotToken`
  catch tightened (#770, #771)**.
- **Cron DM routing for `dm_only` agents (#774)**.
- **`materialize TELEGRAM_BOT_TOKEN` from vault at startup (#758/#761)**.
- **Webhook dispatch: prepend nvm node bin to spawn PATH (#754)**.
- **`handleWebhookIngest` now receives `dispatchConfig` (#753)**.
- **Autoaccept new `dev-channels` prompt + reconcile systemd-unit drift
  (#749)**.

## v0.5.0 — 2026-05-06

Initial release of `switchroom` (npm package renamed from
`switchroom-ai`). The historical `switchroom-ai` package on npm is
deprecated — see https://www.npmjs.com/package/switchroom for the new
home. Version reset to 0.5.0; the 25 prior `switchroom-ai` tags are
documentation-only and will be cleaned up out-of-band.

This release consolidates the in-flight work from PRs #738 / #740 /
#742 / #743 / #745 / #747 into a single disciplined first cut on the
new package name. Substantive changes from prior `switchroom-ai@0.6.14`:

### Changed

- **tmux supervisor is now the default (#725 PR-1)** — `script -qfc`
  PTY wrapping is replaced by per-agent `tmux new-session` for all
  agents by default. The user-facing flag rename is
  `experimental.tmux_supervisor` → `experimental.legacy_pty` (inverted
  meaning). New default behaviour materialises on the next agent
  restart (`switchroom systemd reconcile && switchroom agent
  restart <name>`); units are not auto-restarted by the upgrade. tmux
  is now a hard prereq (`install.sh` enforces); hosts without tmux
  must opt agents into legacy via `experimental.legacy_pty: true`.
  See `docs/tmux-supervisor-fanout.md` for the rollback runbook.
- **`!` interrupt marker now delivers SIGINT via `tmux send-keys C-c`
  for tmux-supervised agents (#725 PR-3)**, falling back to
  `systemctl kill --signal=INT` on send-keys failure. Better signal
  delivery to runaway tool children.
- **First-run autoaccept now uses a TS pane-poller instead of `expect`
  (#725 PR-4)** — the small set of first-run claude TUI prompts (theme
  picker, MCP trust, dev-channels acknowledgement, API provider) are
  now dispatched by a `tmux capture-pane` + `tmux send-keys` poller
  fired from the agent unit's `ExecStartPost=`. Soft-fail throughout;
  exits cleanly after ~30s of pane idle. The legacy `expect` wrapper
  (`bin/autoaccept.exp`) is preserved as a one-release rollback knob:
  set `experimental.legacy_autoaccept_expect: true` per-agent to revert.
- **`experimental.tmux_supervisor` deprecated** — still parseable for
  one release with a one-time stderr warning. Migration is automatic.

### Added

- **Watchdog crash-time pane capture (#725 PR-2)** — before triggering
  any restart (bridge-disconnect, turn-hang, journal-silence), the
  watchdog now snapshots the agent's tmux pane scrollback to
  `~/.switchroom/agents/<agent>/crash-reports/<ISO8601>-<reason>.txt`
  so RCA has the live screen state at the moment of the kill.
  Retention: 20 most recent files per agent. Size cap: 10 MB per
  file. See `docs/crash-reports.md`.
- **Preflight accepts `autoaccept-poll` wiring (#745)** — the
  `switchroom agent restart` preflight in `src/cli/agent.ts` now
  accepts either the legacy `expect autoaccept.exp` wrapper or the
  new `autoaccept-poll` ExecStartPost, and only requires the `expect`
  binary on PATH when the legacy wrapper is in use.

### Fixed

- **Build now bundles `dist/cli/autoaccept-poll.js` (#747)** — the
  systemd unit's `ExecStartPost=` references the bundled `.js`
  artifact; prior internal cuts shipped without it, breaking
  default-mode units on fresh installs.

### Added

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

### Added

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
  - Which account is driving traffic right now? `▶ you@example.com`
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

### Added

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

## v0.6.7 — 2026-05-05

### Added

- **Account labels accept `@` and `+`** (#694) — operators can now
  label Anthropic accounts by the email they signed up with, e.g.
  `you@example.com`, `ken+work@example.com`. Regex expanded from
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
