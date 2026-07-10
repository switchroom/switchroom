---
backs: claude-native
artifact: litellm-max-subscription-invariants
---

# LiteLLM Max Subscription Invariants

**Context:** Switchroom routes the unmodified `claude` CLI through a self-hosted
LiteLLM proxy (`ANTHROPIC_BASE_URL=http://127.0.0.1:4010`). The subscription
invariant (pillar 3 of `reference/vision.md`) says Anthropic models MUST be paid
via the operator's Claude Max OAuth credential, never via an `ANTHROPIC_API_KEY`.
LiteLLM is scaffolding around the CLI, not a billing bypass.

Source: https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription

---

## I1 — OAuth forwarding MUST be per-model via `model_group_settings`, never global

**Rule:** OAuth header forwarding MUST be set per-model in `model_group_settings`,
not in `litellm_settings`. The `litellm_settings.forward_client_headers_to_llm_api`
field is `Optional[bool]`. A list value (e.g. a list of model names) is coerced
to `true` (truthy), making forwarding global. That leaks the OAuth token to
OpenRouter, OpenAI, VoyageAI, etc.

```yaml
# CORRECT — per-model scoping via model_group_settings
model_group_settings:
  claude-opus-4-8:
    forward_client_headers_to_llm_api: true
  claude-sonnet-4-6:
    forward_client_headers_to_llm_api: true
  claude-haiku-4-5-20251001:
    forward_client_headers_to_llm_api: true

# WRONG — global; OAuth token forwarded to ALL providers
litellm_settings:
  forward_client_headers_to_llm_api: true

# ALSO WRONG — list value in litellm_settings is coerced to true (truthy) → global
litellm_settings:
  forward_client_headers_to_llm_api:
    - claude-opus-4-8    # non-empty list = truthy bool = forwards everywhere
```

**Why:** Global forwarding sends the Anthropic OAuth Bearer token to every
upstream provider configured in the proxy. OpenRouter, OpenAI, and VoyageAI
will reject or mis-attribute it; worse, it leaks the credential outside Anthropic.

**How to apply:** Every time a new Anthropic model is added to `model_list`, add
a matching `model_group_settings.<model_name>.forward_client_headers_to_llm_api: true`
entry. Omitting it causes that model to send without OAuth → 401.

---

## I2 — Anthropic OAuth models MUST NOT carry an `api_key`

**Rule:** Any `model_list` entry whose upstream is `anthropic/claude-*` and that
relies on Max OAuth MUST omit `api_key` entirely.

```yaml
# CORRECT — credential comes from forwarded Authorization header
- model_name: claude-sonnet-4-6
  litellm_params:
    model: anthropic/claude-sonnet-4-6   # no api_key

# WRONG — overrides the forwarded OAuth; fails unless ANTHROPIC_API_KEY is set
- model_name: claude-sonnet-4-6
  litellm_params:
    model: anthropic/claude-sonnet-4-6
    api_key: os.environ/ANTHROPIC_API_KEY
```

**Why:** An explicit `api_key` on the LiteLLM side takes precedence over the
forwarded client `Authorization` header, breaking the Max subscription path and
potentially routing to a paid API endpoint instead.

---

## I3 — All non-Anthropic models MUST have an explicit `api_key`

**Rule:** OpenRouter, OpenAI, VoyageAI, and any other non-Anthropic upstream
MUST have `api_key: os.environ/<KEY>` in their `litellm_params`.

**Why:** Without an explicit key, LiteLLM falls back to looking for the forwarded
client header (or a global env fallback). For non-Anthropic providers, the OAuth
token is meaningless and will result in a 401.

---

## I4 — Model names MUST exactly match what Claude Code sends on the wire

**Rule:** `model_name` in `model_list` and entries in
`forward_client_headers_to_llm_api` must be the literal string Claude Code
places in the `model` field of its API requests, NOT prefixed with `anthropic/`.

```yaml
# CORRECT — Claude Code sends "claude-sonnet-4-6"
- model_name: claude-sonnet-4-6
  litellm_params:
    model: anthropic/claude-sonnet-4-6   # litellm_params CAN have the prefix

# WRONG — Claude Code never sends "anthropic/claude-sonnet-4-6" as the model name
- model_name: anthropic/claude-sonnet-4-6
```

**Current verified list (2026-06-28):**
- `claude-opus-4-8`
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001`

Update this list (and `forward_client_headers_to_llm_api`) whenever the CLI
ships a new model. The CLI's `/model` picker is the authoritative source.

**Sanctioned drift-aliases (deliberate, live).** The fleet runs a small set of
`model_aliases` that map a name an *older* CLI still sends on the wire to the
current live model, so an agent on a lagging CLI build keeps routing instead of
4xxing on an unknown model. These are intentional and NOT a violation of the
"names must match" rule above — the alias target is another **Anthropic** model,
so OAuth forwarding (I1/I2) is unaffected and no credential crosses to a
non-Anthropic upstream (contrast I6, which bars aliasing a Claude name to a
non-Anthropic target). Currently sanctioned:

- `claude-opus-4-7` → `claude-opus-4-8`
- `claude-sonnet-4-6` → `claude-sonnet-5`

Retire a drift-alias once no fleet CLI emits the stale name. Keep both the
source and the target present in `model_list` with a matching
`forward_client_headers_to_llm_api` entry while the alias is live.

---

## I5 — Virtual key header format is `x-litellm-api-key: Bearer <key>`

**Rule:** `ANTHROPIC_CUSTOM_HEADERS` in `start.sh` must send the virtual key in
the `x-litellm-api-key` header with the literal `Bearer ` prefix.

```bash
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: Bearer $sr_ll_key
x-litellm-customer-id: $SWITCHROOM_AGENT_NAME
x-litellm-tags: agent:$SWITCHROOM_AGENT_NAME,profile:${SWITCHROOM_AGENT_PROFILE:-default}"
```

**Why:** This is the format specified in the LiteLLM Claude Code tutorial.
The Claude CLI forwards these as literal HTTP headers. LiteLLM reads
`x-litellm-api-key` to authenticate the virtual key (budget/rate tracking)
separately from the `Authorization` header (the OAuth credential for Anthropic).

**Two-header model (must both succeed):**

| Header | Value | Used by |
|--------|-------|---------|
| `x-litellm-api-key` | `Bearer <virtual-key>` | LiteLLM (gateway auth, spend tracking) |
| `Authorization` | `Bearer <oauth-token>` | Anthropic API (Max subscription billing) |

---

## I6 — Model-alias redirect MUST NOT forward OAuth to non-Anthropic upstreams

**Rule:** When Ship D's virtual-key `model_aliases` redirect a Claude model name
(e.g. `claude-sonnet-4-6`) to a non-Anthropic target (e.g.
`openrouter/google/gemini-2.5-pro`), the OAuth token MUST NOT be forwarded to
the OpenRouter endpoint.

**Status:** UNVERIFIED at time of writing (2026-06-28). LiteLLM's
`forward_client_headers_to_llm_api` scoping is against `model_name` entries in
the proxy config. The critical question is whether the forwarding check runs
against the *requested* model name (before alias resolution) or the *resolved*
upstream target (after alias). If before, a `claude-sonnet-4-6` request aliased
to `openrouter/google/gemini-2.5-pro` would forward the OAuth token to
OpenRouter, a credential leak.

**Required pre-check before enabling Ship D model aliases in production:**
1. Set a test alias `claude-haiku-4-5-20251001 → openrouter/google/gemini-2.5-flash`
   on a test agent's virtual key.
2. Send a `claude-haiku-4-5-20251001` request through the proxy.
3. Inspect LiteLLM logs (`log_raw_request_response: true` is already set) to
   confirm the outbound call to OpenRouter does NOT carry the `Authorization`
   header with the Anthropic OAuth token.
4. If it does forward, mitigation is to remove the aliased model from
   `forward_client_headers_to_llm_api` dynamically, or do not use model
   aliases for Anthropic model names; use a separate non-Claude `model_name`
   as the alias target instead (e.g. `sr-gemini` → `openrouter/google/gemini-2.5-pro`)
   so there is no entry in the forwarding list to match.

---

## I7 — Availability on proxy trouble is split by cause (fail-open ONLY on a missing key)

**Rule:** the boot gate (`_LITELLM_OK` / `sr_ll_*` in
`profiles/_base/start.sh.hbs`, ~1002-1011) handles two failure modes
DIFFERENTLY. This contract applies to both the interactive session and the
cron session (`profiles/_base/cron-session.sh.hbs`).

- **Missing virtual key** (no `litellm/<agent>/api-key` in the vault): **fail
  open** — strip the routing env and fall back to direct Anthropic OAuth,
  logged LOUDLY as untracked/unguarded. Without a key there is nothing to
  authenticate to the proxy with, so there is no metered route to self-heal
  into.
- **Proxy unreachable at boot, key present** (the bounded liveliness probe
  fails within its retry window): **keep routing and warn — do NOT fall
  open.** Leave `ANTHROPIC_BASE_URL` / `SWITCHROOM_LITELLM*` pointed at the
  proxy and emit a loud warning. Claude traffic fails+retries until the proxy
  returns, then routes through it automatically (the socat forwarder at
  `127.0.0.1:4010` reconnects per-connection). The metered path stays the
  metered path.

**What fail-open (missing-key case) loses:** spend tracking, guardrails, model
alias routing, per-agent virtual key budget limits. A log line is emitted so
the operator knows.

**History — this SUPERSEDES the original "always fail open" rule.** I7 once
mandated falling back to direct OAuth whenever the proxy was unreachable OR the
key was absent. That was removed (#2940 / start.sh commit `6106036c`): an agent
that booted during a brief litellm blip fell open to **silent untracked** direct
Anthropic and never routed through litellm again until a manual restart — which
violates the cost-tracking invariant (the observation half of the
`reference/invariants.md` gateway carve-out). The unreachable-with-key path now
keeps routing so the fleet self-heals; only a genuinely missing key fails open.
Do NOT re-introduce the removed blanket fallback.

---

## Checklist for adding a new Anthropic model

1. Add entry to `model_list` (no `api_key`):
   ```yaml
   - model_name: claude-<id>
     litellm_params:
       model: anthropic/claude-<id>
   ```
2. Add `claude-<id>` to `forward_client_headers_to_llm_api` list.
3. Reload LiteLLM (`docker restart litellm-<service>`).
4. Verify: `curl /v1/models` shows the new name; a test request returns 200
   and spend logs show the Anthropic model, not a fallback.

## Checklist for adding a new non-Anthropic model (OpenRouter, etc.)

1. Add entry to `model_list` WITH `api_key: os.environ/<KEY>`:
   ```yaml
   - model_name: openrouter/<provider>/<model>
     litellm_params:
       model: openrouter/<provider>/<model>
       api_key: os.environ/OPENROUTER_API_KEY
   ```
2. Do NOT add to `forward_client_headers_to_llm_api`.
3. Reload LiteLLM. Verify via `/v1/models`.
