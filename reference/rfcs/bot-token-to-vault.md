# RFC A: Complete the bot-token-to-vault migration

Status: Draft v2 — **hygiene, not a boundary (2026-06-02)**
Author: klanker (sub-agent draft)
Date: 2026-05-06

> **Scope note (2026-06-02).** Worth doing as **hygiene** — one revocation
> surface, no plaintext token `cat`-able on disk. But per
> [`reference/rfcs/access-model.md`](access-model.md) it is
> **not** a security boundary: a same-uid agent is out of scope by
> construction, so vaulting the token does not "stop the agent reading
> it." Don't frame this migration as closing a forgery hole; frame it as
> consolidating secrets. The approval model does not depend on it.

## 1. Summary

Vault-backed bot tokens **already exist** in switchroom. The `vault:` reference resolver is shipped (`src/vault/resolver.ts:23` `isVaultReference`, `src/vault/resolver.ts:223` resolver path) and the schema accepts a `vault:` reference for `telegram.bot_token` (`src/config/schema.ts:797`, `:945`, `:1308`). Per-agent bot tokens already flow through the resolver via `resolveBotToken` (`src/cli/topics.ts:53`).

This RFC is **not** a proposal to build that machinery. It's the operational task of **completing the migration in Ken's deployment**: rotating the currently-on-disk token, moving it into a vault slot, switching the running config to a `vault:` reference, and documenting the operational pattern so the same migration can be repeated for other long-lived secrets that still sit on disk.

## 2. Motivation

The bot token sits on disk in plaintext (`TELEGRAM_BOT_TOKEN=...` in agent env files; see `src/setup/onboarding.ts:163` `writeAgentEnv`). Any process running as `kenthompson` can read it. That includes every agent. An agent that reads the token can post messages and approval cards as the bot, intercept callbacks, and impersonate the gateway to the user.

The fix in code is already done — what's left is the operational cutover. The kernel work in RFC B leans on this being completed: if an agent can lift the bot token, the kernel's audit trail is undermined because the agent can post fake "Allow this scary thing?" cards.

## 3. Threat model framing — what the vault actually buys us

Per `docs/vault.md:227`, the vault ACL is **misconfiguration protection, not a security boundary**. Same-uid attackers are out of scope. An agent process running as `kenthompson` can in principle read the encrypted vault file, the broker socket, and any decrypted material the broker hands out to authorized callers; the broker's peercred + cgroup checks are also misconfiguration protection, not a security boundary against a determined same-uid adversary.

What the migration **does** buy us:

- **No more plaintext-on-disk.** The token is no longer sitting in a file `cat`able by anything that wanders past it (a stray `find` script, a backup tool, a misbehaving agent that was never meant to talk to Telegram at all).
- **A single revocation surface.** Once the token lives in a vault slot, rotation goes through `switchroom token rotate` and one place updates; today the token is duplicated across whatever env files reference it.
- **Equal trust level with other vault secrets.** The bot token sits at the same trust level as any other vault entry — no better, no worse. It is not "only the gateway can read it"; it is "the broker hands it out under the same ACL machinery as everything else, which is misconfiguration protection." This honest framing replaces an earlier draft's overclaim.

The bot token is not made magically safer than e.g. an OpenAI API key in the same vault. It is made *no worse* than any other secret the user has decided to consolidate there.

## 4. What's already shipped (do not rebuild)

- `vault:` reference syntax in config (`src/vault/resolver.ts`).
- Resolver pipeline that substitutes `vault:<key>` references at config-load time (`src/vault/resolver.ts:277`).
- Schema acceptance of `vault:` references on `telegram.bot_token` and per-agent `bot_token` (`src/config/schema.ts:797`, `:945`, `:1308`).
- Broker auto-unlock at boot so the gateway can resolve the reference before posting its first message (`src/vault/auto-unlock.ts`).
- `resolveBotToken` call site (`src/cli/topics.ts:53`).
- Setup-time bot identity verification that already understands vault-backed tokens (`src/setup/telegram-api.ts:83`–`:93`).

## 5. Operational migration steps

### 5.1 Pre-flight

- Confirm the vault is unlocked (or auto-unlock is enabled). If not: `switchroom vault unlock` or `switchroom vault broker enable-auto-unlock`. Migration aborts here on failure.
- Take a backup of current agent env file(s) containing `TELEGRAM_BOT_TOKEN=...`.
- Note the current bot username for post-migration verification.

### 5.2 Rotate then store

The current plaintext token has been on disk and possibly in shell history; treat it as compromised at the threshold of moving to vault. **Rotate before storing.**

1. Call Telegram's `revokeToken` for the current token; capture the new token from the response.
2. Write the new token to a vault slot (e.g. `telegram:bot_token`, or per-agent `telegram:<agent>:bot_token`) via `switchroom vault set`.
3. Verify by reading it back through the broker (e.g. `switchroom vault get telegram:bot_token`).

### 5.3 Switch config references

- Update `switchroom.yaml` so `telegram.bot_token` (or per-agent `agents.<name>.bot_token`) reads `vault:telegram:bot_token` (or the per-agent slot).
- Remove `TELEGRAM_BOT_TOKEN=...` lines from any agent env files. (`src/setup/onboarding.ts:163` is the writer; the corresponding lines in already-written `.env` files are what you're cleaning up.)
- Restart the gateway. It will resolve the `vault:` reference at boot via the existing resolver pipeline.

### 5.4 Smoke-verify

- Post-restart, send a one-line "bot token migration complete" DM to the operator from the gateway. Migration is considered successful only after this lands.
- `setup/telegram-api.ts`'s username-vs-expected check at `:83` will already validate the new token resolves to the right bot; lean on it.

### 5.5 Shred the old plaintext

**Only after the smoke message has landed**, `shred -u` (or `trash` then secure-delete) the env-file backups taken in 5.1. If `shred` fails (e.g. on a CoW filesystem like btrfs), log loudly — the rotated old token is already dead at Telegram's edge per 5.2.1 so the failure is recoverable, but it should not pass silently.

## 6. Rollback

- **Vault write fails (5.2.2)** → token has been rotated; the old one is dead. Recovery is to retry the write or run `switchroom token rotate` to mint another and store. There is no rollback to "the original plaintext token" because step 5.2.1 already invalidated it. This is intentional — half-rotated state is worse than committing forward.
- **Vault read after write fails (5.2.3)** → same as above; the rotation is durable at Telegram, the only path is forward (fix vault, retry write).
- **Smoke message fails (5.4)** → the gateway is reading from vault but cannot post; debug as a normal gateway boot failure (broker unreachable, peercred mismatch, etc.) rather than reverting config.
- **Config syntax error (5.3)** → revert the `switchroom.yaml` edit; the token is already in vault and rotated, so re-applying once the syntax is fixed is the path forward.

The asymmetry is deliberate: rotation in 5.2.1 is the point of no return. Pre-flight is your last off-ramp.

## 7. After this RFC: the same pattern for other secrets

Other long-lived secrets currently on disk (Anthropic OAuth refresh tokens, OpenAI API keys, etc.) follow the same migration shape:

1. Pre-flight (vault unlocked, env backed up).
2. Rotate at the upstream provider where possible; otherwise just store.
3. Move to a vault slot.
4. Switch config to a `vault:` reference.
5. Smoke-verify.
6. Shred old plaintext.

Each migration is its own small ticket; no further design work is needed because the resolver and broker already handle them.

## 8. Effort

~0.5 day for the operational cutover, mostly in 5.4 smoke-verification and confirming the `setup/telegram-api.ts` checks pass against the new token.

## 9. Out of scope

- Building vault-backed bot-token plumbing — already shipped.
- Forcing the migration on other deployments via tooling — this RFC is about Ken's deployment specifically; the pattern is documented for reuse but not automated.
- The approval kernel itself — see RFC B, which depends on this migration being complete.
