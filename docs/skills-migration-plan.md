# Skills Migration Plan — OpenClaw → Switchroom

Status: **In progress — 9.1 through 9.5 complete, 9.6 pending**
Owner: unassigned
Slots into PRD as: **Phase 9 — Skills Migration** (after Phase 6 dashboard)

---

## Scope

Migrate the user's **11 custom skills** from OpenClaw to Switchroom. These are the skills the user actually runs day-to-day — enumerated in `clerk-export/skills/` and analyzed in `clerk-export/skill-rewrite-notes.md`.

**In scope:**
- `compass`, `coolify`, `coolify-deploy`, `doctor-appointments`, `fully-kiosk`, `garmin`, `home-assistant`, `ken-voice`, `my-family-finance`, `x-api`, `ziggy-relay`
- Credential migration for each (hardcoded `/data/openclaw-config/credentials/...` paths → Switchroom vault)
- Runtime-dependency resolution (Playwright, compass-education npm pkg, Chromium, Python packages)

**Out of scope (explicitly):**
- The 53 **public catalog** skills shipped with OpenClaw at `~/code/openclaw/skills/` (1password, notion, slack, github, things-mac, etc.). They are reusable building blocks and would land in a later phase if/when needed. Not daily-driver work.
- The 56 **framework tool files** under `openclaw/src/agents/tools/` (gateway, message, memory_search, image-tool, cron-tool, etc.). These are replaced structurally by Claude Code native tools + MCP servers and do not migrate 1:1.
- Docker packaging — already tracked in Phase 8.

---

## Architecture decision (blocks everything else)

From `switchroom-import-prompt.md`: *"How should skills work in Switchroom? Claude Code slash commands? MCP servers? Files in the agent's skills/ dir?"*

This must be answered before any skill is ported. Three candidate shapes:

| Shape | Fit | Cost |
| --- | --- | --- |
| **A. Claude Code slash commands** (`.claude/commands/*.md`) | Lightweight, text-only triggers | No programmatic tools, no long-running state |
| **B. MCP servers** (stdio subprocess per skill group) | Full tool interface, persistent state, matches `telegram-plugin/` pattern | Heavier — one extra process, own lifecycle, restart story |
| **C. `skills/` dir + `SKILL.md` + scripts** (current Switchroom + OpenClaw pattern) | Already working for `buildkite-*`, `switchroom-*`, and profile skills. Matches OpenClaw's existing skill layout — shortest porting path. | No long-running state; each invocation is a fresh process |

**Recommendation — hybrid:**
- **C (skills dir)** as the default shape. Every OpenClaw skill is already a `SKILL.md` + `scripts/` bundle, so porting is mostly path fixes.
- **B (MCP server)** for skills that need a persistent connection or long-running state. Today that's **only `ziggy-relay`** (Discord gateway daemon).
- **A (slash commands)** for purely conversational triggers that carry no code. Candidate: `ken-voice` (a style guide consulted by the model, no scripts).

Confirm this split before any port work begins.

---

## Prerequisite cross-cutting work

Must land before Tier 1 ports can start.

1. **Vault schema extension — multi-file secrets.** `garmin` stores tokens as a *directory* of files, not a single value. **Decision (2026-04-15):** extend the vault schema natively with a discriminated `VaultEntry` union:
   ```ts
   type VaultEntry =
     | { kind: "string"; value: string }
     | { kind: "binary"; value: string /* base64 */ }
     | { kind: "files"; files: Record<string /* filename */, { encoding: "utf8"|"base64"; value: string }> };
   ```
   Legacy `Record<string,string>` entries auto-migrate to `{kind:"string",value}` on load. Resolver materializes `kind:"files"` entries to a secure per-invocation temp dir under `$XDG_RUNTIME_DIR/switchroom/vault/<ref>/` (mode 0700) and substitutes the reference with the dir path. Reference syntax: `vault:<key>` (string or dir path) and `vault:<key>#<filename>` (specific file contents as string).
2. **Env-var naming convention.** Standardize `<SKILL>_<FIELD>` — e.g. `GARMIN_TOKEN_DIR`, `COMPASS_CREDS`, `HOTDOC_CREDS`, `HA_SSH_KEY`. Document in `docs/configuration.md`.
3. **Python dependency strategy.** **Decision (2026-04-15):** per-skill `requirements.txt` with a venv cached at `~/.switchroom/deps/python/<skill>/`, built lazily on first invocation. `switchroom health` reports missing/stale caches. No system-level installs, no per-agent duplication.
4. **Node dependency strategy.** **Decision (2026-04-15):** same shape as Python — per-skill `package.json` with `node_modules` cached at `~/.switchroom/deps/node/<skill>/`, installed lazily on first invocation.
5. **Browser binary.** Playwright + Puppeteer skills (`compass`, `doctor-appointments`) need Chromium. Document install path and decide whether Switchroom should check for it at `switchroom health`.
6. **Token refresh helpers.** **Decision (2026-04-15):** port `google-cal-token` and `ms-graph-token` as a shared `token-helpers` skill (shell scripts that read refresh tokens from the vault and write updated access tokens back). *Not* an MCP server — that's reserved for cases where cross-agent cached token state matters. Promote later only if needed.

---

## Per-skill tier + estimates

Priority ordering reflects daily-use value and rewrite depth, from `clerk-export/skill-rewrite-notes.md`.

### Tier 1 — shallow rewrite, high value (~1 week)

| Skill | Shape | Work |
| --- | --- | --- |
| `ken-voice` | Slash command (A) | Static style guide. Copy `SKILL.md`, drop scripts. Trivial. |
| `home-assistant` | Skills dir (C) | SSH key → vault, hostname → env. Path replacements only, scripts untouched otherwise. |
| `garmin` | Skills dir (C) | Requires prereq 1 (multi-file vault). Script rewrites are a single `TOKEN_DIR` line per file. Also depends on the calendar-token helpers (prereq 6). |

### Tier 2 — moderate rewrite (~1 week)

| Skill | Shape | Work |
| --- | --- | --- |
| `doctor-appointments` | Skills dir (C) | Hotdoc creds → vault, Playwright + Python deps (prereq 3, 5), MS Graph token helper (prereq 6). |
| `compass` | Skills dir (C) | `compass-education` npm install (prereq 4), Chromium path (prereq 5), cookie cache → writable temp. |
| `x-api` | Skills dir (C) | Twitter OAuth creds → vault, refresh path. Straightforward once credential story is settled. |
| `fully-kiosk` | Skills dir (C) | Tablet API creds → vault. Minimal logic. |

### Tier 3 — deep rewrite or replacement (~2+ weeks)

| Skill | Shape | Work |
| --- | --- | --- |
| `coolify` + `coolify-deploy` | Skills dir (C) | Self-hosted PaaS API client. Credential + endpoint env. Moderate but self-contained. |
| `my-family-finance` | Skills dir (C) | Custom **Ed25519 JWT auth flow** — non-trivial port. May need a dedicated helper module. |
| `ziggy-relay` | **MCP server (B)** | 100% OpenClaw-specific Discord relay daemon. Full rewrite — stand up a new `ziggy-plugin/` alongside `telegram-plugin/`, or replace with a native Telegram↔Discord bridge and retire the skill. Decide replace-vs-port before starting. |

---

## Phase breakdown

Maps to PRD phase format:

### Phase 9.1 — Architecture + prerequisites

Concrete execution steps (in order):

1. **Vault multi-file schema (src/vault/vault.ts)**
   - Introduce `VaultEntry` discriminated union (string | binary | files).
   - Change internal `VaultData.secrets` type from `Record<string,string>` to `Record<string,VaultEntry>`.
   - Auto-migrate legacy string entries on read (`typeof value === "string"` → wrap as `{kind:"string",value}`).
   - Update `setSecret`/`getSecret` to accept/return `VaultEntry`; add convenience helpers `setStringSecret`, `setFilesSecret`.
   - Tests in `tests/vault.test.ts`: legacy read, round-trip all three kinds, concurrent write safety.

2. **Resolver materialization (src/vault/resolver.ts)**
   - Extend `resolveValue`: when a `vault:<key>` reference points at a `kind:"files"` entry, materialize to `$XDG_RUNTIME_DIR/switchroom/vault/<agent>/<key>/` (fallback `/tmp/switchroom-vault-<uid>-<agent>/<key>/`), mode 0700, and substitute with the dir path.
   - Support `vault:<key>#<filename>` syntax for inlining a specific file's contents.
   - Cleanup hook: temp dirs wiped on agent process exit (or on next resolve).
   - Tests: materialization creates expected files, permissions correct, cleanup fires.

3. **Dependency cache helpers (new src/deps/python.ts + src/deps/node.ts)**
   - `ensurePythonEnv(skillName, requirementsPath)` → lazy-builds venv at `~/.switchroom/deps/python/<skill>/`, returns bin path. Stamps a hash of `requirements.txt` and rebuilds on mismatch.
   - `ensureNodeEnv(skillName, packageJsonPath)` → same shape for `~/.switchroom/deps/node/<skill>/`.
   - CLI exposure: `switchroom deps rebuild <skill>` for manual recovery.
   - Tests: lazy build, hash invalidation, rebuild idempotency.

4. **Env-var convention doc (docs/configuration.md)**
   - Document `<SKILL>_<FIELD>` naming, vault reference syntax (`vault:<key>` and `vault:<key>#<filename>`), and the `deps/python` + `deps/node` layout.

5. **`token-helpers` skill (skills/token-helpers/)**
   - `SKILL.md` describing when to use it.
   - `google-cal-token.sh` and `ms-graph-token.sh`: read refresh token from vault via `switchroom vault get`, POST to respective OAuth endpoint, persist new access token back to vault.
   - Tests: mocked OAuth endpoint, vault round-trip.

6. **`switchroom health` checks**
   - Chromium/Playwright presence, Python 3.11+, Node 18+, `~/.switchroom/deps/` writable.
   - Emit actionable warnings per missing dep.

7. **Import OpenClaw tokens (bulk lift)**
   - One-shot script `scripts/import-openclaw-credentials.ts` that reads existing `/data/openclaw-config/credentials/` tree and populates the vault using the new schema. Run once per host, then the path goes away.

### Phase 9.2 — Tier 1 ports
- `ken-voice`, `home-assistant`, `garmin`
- Per-skill: vault migration, smoke test via the telegram agent, integration test covering the happy path

### Phase 9.3 — Tier 1 validation
- Run Tier 1 skills in production (parallel with OpenClaw) for 1 week
- Capture any missed hardcoded paths or credential gaps
- Backport fixes to the migration playbook

### Phase 9.4 — Tier 2 ports
- `doctor-appointments`, `compass`, `x-api`, `fully-kiosk`
- Same migration + validation loop

### Phase 9.5 — Tier 3 ports + decisions
- `coolify`, `coolify-deploy`, `my-family-finance`
- `ziggy-relay`: port-vs-replace decision → execute chosen path
- Stand up MCP server infra if replacement route

### Phase 9.6 — OpenClaw retirement
- Cut over Home Assistant addon cherry-picks
- Retire OpenClaw Docker containers
- Archive `clerk-export/` bundle
- Update `docs/vs-openclaw.md` with final "migration complete" note

---

## Open questions (need user input before Phase 9.1 closes)

1. ~~**Credential refresh policy.**~~ **Resolved 2026-04-15:** Lift existing OpenClaw tokens into the Switchroom vault as-is. Only force re-auth when a token has actually expired — no forced rotation during migration.
2. ~~**`ziggy-relay` disposition.**~~ **Deferred 2026-04-15:** Out of scope for this phase — revisit later.
3. ~~**Parallel vs. cutover.**~~ **Resolved 2026-04-15:** Run OpenClaw and Switchroom in parallel throughout migration. User manages OpenClaw lifecycle; Switchroom migration can proceed without coordinated cutover.
4. ~~**Catalog skills.**~~ **Resolved 2026-04-15:** None of the 53 OpenClaw public catalog skills migrate. Scope is strictly the 11 custom skills.

---

## Success criteria

- All 11 custom skills run under Switchroom with identical user-visible behavior
- Zero references to `/data/openclaw-config/` or `/data/openclaw-home/` in any ported skill
- Every credential lives in the Switchroom vault (or is documented as a host-level prerequisite)
- `switchroom health` passes on the production host with all Tier 1+2 dependencies satisfied
- OpenClaw containers retired; the Home Assistant addon switched over
