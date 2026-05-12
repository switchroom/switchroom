# UAT Harness — One-time Setup

This is the operator runbook for bringing up the Telegram UAT harness
introduced by epic [#863](https://github.com/switchroom/switchroom/issues/863).
Phase 1 ships scaffolding only — every step in this file is a manual
prerequisite that must be completed once before the first scenario can
run against real Telegram.

> ⚠️ **Security floor.** The mtcute *session string* this harness mints
> is **bearer-equivalent to the driver Telegram user account**. Anyone
> holding it can read every chat the user can read and impersonate them
> in messages. Treat it with the same care as a long-lived OAuth refresh
> token:
>
> - **Never** log it. **Never** echo it to a terminal. **Never** commit
>   it. **Never** paste it into chat for "debugging."
> - It lives in vault under key `telegram-uat-driver-session` and that
>   is the only legitimate location.
> - Same rules apply to `telegram-test-bot-token` (a normal bot token,
>   but a bot the harness drives autonomously — leak = remote control).

---

## 1. BotFather: create the test bot

1. Open `@BotFather` from the operator's Telegram account.
2. `/newbot` → name (e.g. `Switchroom UAT`) → username (e.g.
   `@switchroom_uat_bot`).
3. Copy the HTTP API token BotFather returns.
4. **Disable privacy mode** so the test bot sees all messages in groups,
   not just commands: `/setprivacy` → select the bot → `Disable`.
   (Privacy mode does not affect the driver's ability to read the bot —
   bots cannot read other bots regardless. This is for the bot reading
   the driver user.)
5. Vault the token:
   ```bash
   switchroom vault set telegram-test-bot-token
   # paste token at the prompt; do not pass via argv
   ```
6. Sanity check:
   ```bash
   TOKEN=$(switchroom vault get telegram-test-bot-token)
   curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq .ok
   # expect: true
   unset TOKEN
   ```

## 2. Create the test supergroup

1. New Group → add the test bot + the driver user → "Upgrade to
   supergroup" (Settings → Group Type, or just enable Topics; both
   actions imply supergroup).
2. Settings → **Topics: Enabled**.
3. Settings → Administrators → promote both:
   - test bot — needs at least: Manage Topics, Pin Messages, Delete
     Messages.
   - driver user — needs at least: Manage Topics (so per-scenario
     topic creation works without the bot doing it).
4. Note the chat id. Easiest: forward any message from the supergroup
   to `@RawDataBot` and copy `forward_from_chat.id`. It will be
   negative and ~13 digits (`-100…`).
5. Stash the chat id under your shell profile or a UAT env file (NOT
   in the repo):
   ```bash
   echo 'export SWITCHROOM_UAT_CHAT_ID=-1001234567890' >> ~/.config/switchroom/uat.env
   ```

## 3. Driver user: mint the mtcute session

The mtcute MTProto driver runs as a **Telegram user account**, not a
bot, because bots cannot read other bots' messages even with admin
rights. ([Telegram Bots FAQ](https://core.telegram.org/bots/faq).)

You will need:
- An `api_id` and `api_hash` from <https://my.telegram.org/apps> (one
  per developer; reusable across projects).
- The driver user's phone number, the SMS/Telegram login code, and the
  2FA password if set.

Run:
```bash
cd telegram-plugin
TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abcdef0123... bun run uat:login
```

The script prompts for phone, login code, and 2FA password on stdin,
captures the session string in memory, and writes it to vault as
`telegram-uat-driver-session`. It **never prints the session string
to stdout or stderr** — if you see one in your scrollback, file an
incident.

## 4. 2FA / new-device re-login playbook

mtcute session strings can get invalidated when:
- The user changes/sets a 2FA password.
- The user terminates the session from another client (Settings →
  Devices → Active sessions → Terminate).
- Telegram's anti-abuse heuristics decide the session is suspicious
  (rare, but happens after long idle + IP change).

When a scenario fails with `AUTH_KEY_UNREGISTERED`,
`SESSION_REVOKED`, or `SESSION_PASSWORD_NEEDED`:

1. Confirm via the Telegram app (Settings → Devices) that the prior
   session is gone.
2. Re-run `bun run uat:login` from the operator's machine.
3. Enter the current 2FA password when prompted.
4. The script overwrites the vault key. No other action required —
   nothing caches the old string.

If the driver account is locked entirely (e.g. SPAM_WAIT), only the
account owner can resolve it via support@telegram.org. The harness has
no recourse.

## 5. The `test-harness` agent (Phase 2a — DM focus)

Phase 2a tests run against a **persistent** `test-harness` agent
created once via `switchroom agent add`. This pivots from the epic's
original child-process-per-scenario plan (written before the Docker
runtime landed) — the standard runtime now gets us most of the
hermeticity we want without re-inventing the agent lifecycle. Forum
topic + per-scenario STATE_DIR isolation rolls in with Phase 2b.

### One-shot agent creation

```bash
# Resolve the driver's user_id once via mtcute (the helper prints
# only the integer id to stdout; the session string never appears):
cd ~/code/switchroom/telegram-plugin
read -sp "Vault passphrase: " SWITCHROOM_VAULT_PASSPHRASE; echo
export SWITCHROOM_VAULT_PASSPHRASE
DRIVER_UID=$(bun uat/driver-info.ts)
echo "Driver user_id: $DRIVER_UID"

# Then create the agent. `--topology dm --allow-from $DRIVER_UID`
# bypasses the @BotFather DM-pair flow and writes the driver's
# user_id directly into allowFrom — so the bot will respond only
# to DMs from the driver, never from arbitrary Telegram users
# (important: the test bot's token is in vault scoped to
# `test-harness` only, but the bot itself is publicly reachable
# on Telegram).
SWITCHROOM_BOT_TOKEN=$(switchroom vault get --no-broker telegram-test-bot-token) \
  switchroom agent add test-harness \
    --profile default \
    --topology dm \
    --bot-username meken_switchroom_test_bot \
    --allow-from "$DRIVER_UID"
unset SWITCHROOM_BOT_TOKEN SWITCHROOM_VAULT_PASSPHRASE

# Verify the agent is up:
switchroom agent status test-harness
```

`agent add` runs the n+1 wizard: scaffolds the per-agent dir under
`~/.switchroom/agents/test-harness/`, refreshes the compose file,
boots the container, runs a preflight. On success the agent is
running and will reply to DMs from the driver user account.

> **Hosts upgraded from before #1009.** If you set up the
> `test-harness` agent on an older CLI build, its
> `access.json` may carry the two pre-fix shapes — numeric
> `allowFrom` (silently rejected by the gateway, #1001) and a
> placeholder `groups: {"-100…"}` entry (404 boot-probe noise,
> #1002). Both writers were corrected in #1009, but existing
> scaffolds aren't auto-rewritten. To rebuild a clean access.json
> on a host that hit the old shapes:
>
> ```bash
> switchroom agent stop test-harness
> rm ~/.switchroom/agents/test-harness/telegram/access.json
> switchroom apply       # rewrites access.json via the fixed buildAccessJson
> switchroom agent start test-harness
> ```
>
> Fresh agent-add invocations on current main don't need this.

### When this agent should be running

- During UAT runs: yes. Scenarios fail with `expectMessage` timeouts
  if the agent isn't responding.
- Idle: harmless to leave running. It consumes one Claude turn only
  when DMed by the driver — no scheduled work, no MCP polls.

### Resetting state between runs

Phase 2a accepts mild state pollution across scenarios (the agent's
history accumulates). To reset hard:

```bash
switchroom agent stop test-harness
rm -rf ~/.switchroom/agents/test-harness/state
switchroom agent start test-harness
```

Phase 2b adds per-scenario state-dir scoping so this becomes
automatic.

### Optional: force progress-card on every turn (Phase 2c+ card scenarios)

The gateway's `progress_card.delay_ms` defaults to 45 s, so short DM
turns (most of UAT) never trigger the pinned card and the card-
lifecycle scenarios (`progress-card-dm.test.ts`) skip themselves.
To unskip — and validate `expectPinnedCard` / `waitForCardPhase`
against real Telegram — override the delay on `test-harness` only:

Edit `~/.switchroom/switchroom.yaml`, find the `test-harness:`
block, and add the highlighted lines:

```yaml
  test-harness:
    extends: default
    topic_name: Test Harness
    channels:
      telegram:
        progress_card:
          delay_ms: 1000     # short — make every turn flash a card
```

Then apply + restart:

```bash
switchroom apply
switchroom agent restart test-harness
```

Production agents keep the 45 s default; this override is test-only.
Once configured, unskip the card scenario by changing
`describe.skip(...)` → `describe(...)` in
`scenarios/progress-card-dm.test.ts`.

## 6. Running scenarios — env setup

The harness reads four env vars at `spinUp()` time. The recommended
workflow is to materialise them once into `.env`
— the harness loads that file automatically on import (see
`load-env.ts`). The file is gitignored repo-wide (`.env*` in
`/.gitignore`); never commit a populated copy.

Vault file perms (root:root 0600) mean the operator can't read
`vault.enc` directly. Sourcing through the `test-harness` agent
container — which already has these keys in its ACL — is the
cleanest path:

```bash
cd ~/code/switchroom

read -sp "Vault passphrase: " SWITCHROOM_VAULT_PASSPHRASE; echo
export SWITCHROOM_VAULT_PASSPHRASE

( umask 077 && {
  echo "TELEGRAM_API_ID=$(docker exec switchroom-test-harness switchroom vault get telegram-uat-api-id)"
  echo "TELEGRAM_API_HASH=$(docker exec switchroom-test-harness switchroom vault get telegram-uat-api-hash)"
  echo "TELEGRAM_UAT_DRIVER_SESSION=$(docker exec switchroom-test-harness switchroom vault get telegram-uat-driver-session)"
  echo "TELEGRAM_TEST_BOT_USERNAME=meken_switchroom_test_bot"
} > .env )

unset SWITCHROOM_VAULT_PASSPHRASE
```

> `umask 077` in the subshell guarantees the file is never
> world-readable between creation and the redirection's implicit
> chmod.

> The `docker exec` path requires `test-harness` to have the three
> `telegram-uat-*` keys in its `schedule[*].secrets` ACL (see
> `~/.switchroom/switchroom.yaml`). If `vault get` returns
> `VAULT-BROKER-DENIED`, add them and `switchroom apply`. The legacy
> `vault get --no-broker` path no longer works for non-root operators
> because the vault file is owned by the broker container's root user.

After the `.env` is in place, just run the suite — no per-shell
export dance:

```bash
bun test telegram-plugin/uat/scenarios/
```

To rotate or refresh the file, repeat the block above. The harness
prefers existing `process.env` entries over `.env` values, so a
one-off env override still works (`TELEGRAM_API_ID=99999 bun test ...`).

The vault passphrase is unset before the test run so a misbehaving
scenario can't smuggle it into a chat message. The session string in
`.env` is bearer-equivalent to the driver account — treat the file
as a long-lived secret.

## 7. Verification checklist before running scenarios

- [ ] `switchroom vault list` shows `telegram-test-bot-token`,
      `telegram-uat-api-id`, `telegram-uat-api-hash`,
      `telegram-uat-driver-session` (and `telegram-uat-chat-id` for
      Phase 2b).
- [ ] `switchroom agent status test-harness` reports the agent active.
- [ ] Driver user can DM `@meken_switchroom_test_bot` from Telegram
      and get a reply (manual sanity check before automating).

When all three are checked, the env block above + `bun run test:uat`
is safe to run.

## 8. CI gate — `:robot: UAT fuzz` Buildkite step

Since the buildkite gate landed, the fuzz subset of scenarios
(`fuzz-random-prompts-dm.test.ts`, `fuzz-extended-dm.test.ts`,
`fuzz-human-style-dm.test.ts`) runs automatically on every PR that
touches `telegram-plugin/`, `src/agents/`, or `telegram-plugin/uat/`.

The step runs on a self-hosted Buildkite agent tagged
`queue=uat-host` that lives on the same box as the `test-harness`
agent. Secrets come from the Buildkite cluster secret store, not
from local vault. See `.buildkite/README.md` § "UAT fuzz step" for
agent setup + secret rotation.

**Scope (CI):**

| Scenario | In CI? | Why |
|---|---|---|
| `fuzz-random-prompts-dm` | ✅ gates PRs | JTBD-floor invariants; PR #1132. |
| `fuzz-extended-dm` | ✅ gates PRs | Second-pass categories; PR #1134. |
| `fuzz-human-style-dm` | ✅ gates PRs | Human-shape inbounds + meaningful-reply floor. |
| `silent-end-recovery-dm` | ❌ local only | Passes, but the 5-min worst-case budget makes it costly to run every PR. Run nightly + ad-hoc. |
| `jtbd-status-query-dm` | ❌ local only | Passes; defer to a follow-up that batches the cheap JTBD scenarios. |
| `jtbd-soft-commit-dm` | ❌ local only | Already budget-tuned but real-Telegram timing flake risk; defer until we have flake telemetry. |
| `jtbd-interrupt-marker-dm` | ❌ `describe.skip` | Suspected real bug per #1132 overnight. Investigate before unskipping. |
| `jtbd-rapid-followup-dm` | ❌ `describe.skip` | Suspected real classification bug per #1132 overnight. Investigate before unskipping. |
| vault / secret-redaction / voice / location / reactions / progress-card | ❌ local only | Need specific surfaces / config overrides not wired into the gate yet. |

A local `bun run test:uat` runs the full include glob minus the two
`describe.skip`'d JTBDs.

## 9. Port allocator vs unix sockets (Phase 1 scaffold note)

The Phase 1 `port-allocator.ts` is held in reserve for Phase 2b's
child-process flow — Phase 2a (standard-runtime agent) doesn't need
it. Kept rather than deleted because the allocator's bind-probe is
the right shape for what 2b will need.
