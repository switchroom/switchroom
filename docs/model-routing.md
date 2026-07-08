# Model Routing & Subscription Compliance

> **Status:** describes v0.17.11; see [Known Gaps](#known-gaps--follow-ups) for
> divergences from the target.

How switchroom decides which model an agent (or the Hindsight memory singleton)
talks to, and how it keeps that traffic subscription-native even when an
optional metering gateway sits in the path. Related reading:
[`docs/architecture.md`](architecture.md) (process model),
[`docs/vault-broker.md`](vault-broker.md) (per-consumer virtual keys),
[`docs/operators/hindsight-memory.md`](operators/hindsight-memory.md) (the
`hindsight.llm` operator surface), and
[`reference/invariants.md`](../reference/invariants.md) §"Operator-controlled
gateway carve-out".

## Vision

Switchroom is native Claude Code on a native Claude subscription **first**;
everything else layers on top and never replaces it.

- The default posture of every agent and of the Hindsight memory singleton is
  to run the real `claude` CLI authenticated with a Claude Pro/Max subscription
  over OAuth. No API keys and no bring-your-own-model are required for the
  system to be fully functional.
- **LiteLLM is an optional gateway layer.** Its only jobs are to *measure*
  usage and *enforce guardrails* (budgets, rate limits, per-consumer tracking).
  Enabling it must never change the fact that Claude subscription traffic
  remains subscription traffic.
- **Non-Claude models** (OpenRouter `gpt-oss`, `glm`, `gemini`, etc.) are
  *additionally* supported — for whole agents and for individual Hindsight
  activities. Even then the agent is still driving the native `claude` CLI; the
  alternate model is merely selected and routed through LiteLLM.

## Invariants

These must always hold.

- **I1 — Claude subscription = OAuth, always.** Whenever we consume a
  Claude/Anthropic model on the subscription we use the subscription OAuth
  token, never an `sk-ant` API key. This holds even when the request passes
  through LiteLLM: the gateway *meters*, it does not re-auth.
- **I2 — Compliant metering.** LiteLLM observes subscription traffic by
  forwarding the client's `Authorization: Bearer <oauth>` header straight
  through to Anthropic via `forward_client_headers_to_llm_api: true`, scoped to
  Claude models only. Non-Claude / OpenRouter model entries must never forward
  the `Authorization` header. The proxy holds no Anthropic key of its own for
  these models and must not substitute one.
- **I3 — The auth broker owns OAuth.** The `switchroom-auth-broker` singleton
  is the sole writer of every consumer's `.claude/credentials.json` (agents and
  Hindsight alike) and owns the refresh loop; this is what enables account
  failover and token refresh. No consumer injects `ANTHROPIC_AUTH_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN` — `claude` reads the broker-written credential file
  (RFC H).
- **I4 — Two credentials, cleanly layered.** On a metered request the OAuth
  token (identity to Anthropic) rides `Authorization` and is forwarded
  unchanged; the LiteLLM virtual key (identity to the proxy) rides the
  `x-litellm-api-key` header and is consumed by the proxy, never forwarded
  upstream.
- **I5 — Non-Claude models still traverse LiteLLM.** Selecting `gpt-oss` /
  `glm` / etc. changes the model token, not the transport: the request still
  goes to the LiteLLM proxy for metering and guardrails.

## Architecture (as-is)

File:line citations are against the v0.17.11 tree.

### Agents

- Compose sets `ANTHROPIC_BASE_URL` to the LiteLLM `/anthropic` **pass-through**
  endpoint — a raw byte-forward, deliberately **not** the model-mapped
  `/v1/messages` route, which re-chunks the stream and stalled long Opus
  responses ("Response stalled mid-stream" — the 2026-07-05 incident). The
  injection is gated on `litellm.enabled && keyConfirmed && baseUrl`
  (`src/agents/compose.ts:2207-2212`; rationale in the comment at
  `:2189-2199`). The three inputs are resolved per agent by `describeAgents`
  (`src/agents/compose.ts:830-845`): `keyConfirmed` is true only when the
  agent's virtual key was vault-probed at apply time (fail-safe: no key ⇒ no
  routing env ⇒ the agent keeps the direct broker-OAuth Anthropic path).
- `start.sh` fetches the per-agent virtual key from the vault at
  `litellm/<agent>/api-key`, runs a bounded liveliness probe against
  `<root>/health/liveliness`, and exports `ANTHROPIC_CUSTOM_HEADERS` carrying
  `x-litellm-api-key` / `x-litellm-customer-id` / `x-litellm-tags`
  (`profiles/_base/start.sh.hbs:946-985`).
- Per-consumer keys are provisioned by `src/litellm/provision.ts`
  (`ensureTeam` at `:90`, `ensureKey` at `:124`), driven from
  `src/cli/apply.ts` (per-agent enablement resolution at `:205-216`, the
  provisioning + vault-idempotency step at `:222-237`).
- **Enablement default.** The code/schema default is **OFF**
  (`src/config/schema.ts:3714-3719`, "Default OFF"). An operator turns the
  whole fleet on by setting the top-level `litellm.enabled: true`; every agent
  then routes through LiteLLM *unless* it sets its own `litellm: {enabled:
  false}` to opt out. The one-level-deep merge that makes the defaults-cascade
  work lives in `src/config/merge.ts:468-497`. (This corrects an earlier draft
  that described `defaults.litellm.enabled: true` as the shipped default — it
  is opt-in fleet-wide, not on by default.)

### Auth broker

- `switchroom-auth-broker` is the sole writer of `.claude/credentials.json`.
  A per-agent UDS socket is mounted at `/run/switchroom/auth-broker`.
- `CLAUDE_CODE_OAUTH_TOKEN` injection was removed with RFC H; `start.sh`
  explicitly `unset`s it and relies on the broker-written credential file
  (`profiles/_base/start.sh.hbs:391-394`).

### Hindsight

- Schema `hindsight.llm` carries a global `provider`/`model` plus per-op
  `retain` / `reflect` / `consolidation` blocks, each accepting
  `model`/`provider`/`base_url`/`api_key` (all optional)
  (`src/config/schema.ts` — `HindsightLlmConfigSchema` and
  `HindsightPerOpLlmSchema`, ~`:1704-1790`).
- `src/setup/hindsight.ts` emits `HINDSIGHT_API_LLM_PROVIDER` /
  `HINDSIGHT_API_LLM_MODEL` plus, per configured op,
  `HINDSIGHT_API_<OP>_LLM_MODEL` / `_PROVIDER` / `_BASE_URL` / `_API_KEY`
  (`resolveHindsightPerOpLlm` at `:630`; docker-run emission at `:723-746`,
  compose-snippet emission at `:1015-1024`). When the provider is `claude-code`
  it also sets `ANTHROPIC_MODEL` to the resolved model
  (`:752-753`, `:1024`).
- **Only when a `litellm` config is passed** does it set `ANTHROPIC_BASE_URL`
  (`= <root>/anthropic` for a Claude global model, `= <root>` for a non-Claude
  global) plus `ANTHROPIC_CUSTOM_HEADERS` carrying the Hindsight virtual key
  (`src/setup/hindsight.ts:756-787`; the pass-through-vs-model-mapped decision
  is `isClaudeModel(llmModel)` at `:768-770`, resolved from the **global**
  model returned by `resolveHindsightLlm` at `:657-672`).
- Hindsight **always** mounts the auth-broker socket (broker = sole OAuth
  writer) — unconditional, outside the `litellm` branch
  (`src/setup/hindsight.ts:844`) — and runs `--network host` only when LiteLLM
  is active (`:824-826`).
- The `claude-code` provider itself lives in the *upstream* Hindsight image,
  not this repo; switchroom steers it only via env, and the spawned `claude`
  subprocess inherits `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADERS`.

`isClaudeModel` (`telegram-plugin/gateway/model-command.ts:79`) is a pure
model-token test — a known alias or a `claude-` prefix — which is why the
routing decision keys off the model string alone.

## Known Gaps / Follow-ups

Ranked, highest-leverage first.

- **G1 — Hindsight per-op routing is not actually per-op.** The
  pass-through-vs-model-mapped decision (`isClaudeModel(globalModel)` in
  `src/setup/hindsight.ts:768`) and the single container-level
  `ANTHROPIC_BASE_URL` are derived from the **global** model only. Per-op
  `MODEL` is honored, but per-op **routing** is not — so a per-op Claude
  override under a non-Claude global (or vice-versa) can hit the wrong
  endpoint. This blocks the "configurable per-activity, Claude natively /
  non-Claude via LiteLLM" target.
- **G2 — LiteLLM is not a hard guarantee (fail-open).** When the virtual key is
  missing or the proxy is unreachable at boot, both agents and Hindsight drop
  to direct Anthropic OAuth (untracked). This is a deliberate
  availability-over-tracking choice (operator decision 2026-06-28,
  `profiles/_base/start.sh.hbs:927-932`) — logged loudly, not enforced. Record
  it as an explicit, accepted trade-off, not a silent bug.
- **G3 — Hindsight global default is internally inconsistent when LiteLLM is
  on.** `resolveHindsightLlm` defaults `provider` to `claude-code` but shifts
  the default `model` to a non-Claude OpenRouter model
  (`openrouter/google/gemini-3.1-flash-lite`,
  `src/setup/hindsight.ts:151-152`, `:657-672`), which may not be registered in
  the live proxy. Consolidation inherits this default. Flag for reconciliation.
- **G4 — Per-op `base_url`/`api_key` are unvalidated.** They are emitted
  verbatim with no check that they point at the LiteLLM proxy or use broker
  OAuth — an operator could point a per-op at an endpoint that bypasses both the
  broker and metering.
- **G5 — The `claude-code` provider is an upstream black box.** Switchroom can
  only steer it via env and cannot enforce that a non-`claude-code` per-op
  provider still traverses LiteLLM.
