# Model Routing & Subscription Compliance

> **Status:** describes v0.17.11; see [Known Gaps](#known-gaps--follow-ups) for
> divergences from the target.

How switchroom decides which model an agent (or the Hindsight memory singleton)
talks to, and how it keeps that traffic subscription-native even when an
optional metering gateway sits in the path. Related reading:
[`docs/architecture.md`](architecture.md) (process model),
[`docs/vault-broker.md`](vault-broker.md) (per-consumer virtual keys),
[`docs/operators/hindsight-memory.md`](operators/hindsight-memory.md) (the
`hindsight.llm` operator surface),
[`docs/operators/hindsight-model-change.md`](operators/hindsight-model-change.md)
(runbook for swapping hindsight per-op models — routing lanes, recreate,
verification, rollback), and
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
- **I2 — Compliant metering (convention-enforced, not code-guaranteed).**
  LiteLLM observes subscription traffic by forwarding the client's
  `Authorization: Bearer <oauth>` header straight through to Anthropic via
  `forward_client_headers_to_llm_api: true`, and this flag must be scoped to
  Claude models only. Non-Claude / OpenRouter model entries must never forward
  the `Authorization` header; the proxy holds no Anthropic key of its own for
  these models and must not substitute one.
  **This scoping now has a repo-managed source of truth** (KEN-125):
  `docker/litellm-proxy/litellm-config.yaml` is the reviewed, lint-guarded
  (`scripts/check-litellm-config-guard.mjs` — always checks the repo copy) and
  tested (`src/litellm/repo-config.test.ts`) config; the operator syncs it to
  the Coolify-hosted live file at
  `/host/data/coolify/services/<litellm-service-id>/litellm-config.yaml`
  (the service id is deployment-specific and deliberately never committed —
  the lint guard and fleet-health sensor discover the live file by scanning
  `/data/coolify/services/*/litellm-config.yaml`, or take `LITELLM_CONFIG_PATH`)
  (procedure in `docker/litellm-proxy/README.md` — switchroom itself never
  mutates or restarts the live proxy, and the live file must be reconciled
  into the repo copy on first rollout). The config places
  `forward_client_headers_to_llm_api: true` under individual Claude entries in
  `model_group_settings` and leaves it off both globally (in `litellm_settings`,
  where it is a Boolean master switch) and on every `openrouter/*` /
  non-Claude entry. **Concrete risk — a one-line misconfig is an OAuth leak:**
  setting the flag globally under `litellm_settings`, or adding it to any
  `openrouter/*` `model_group_settings` entry, would forward the subscription
  OAuth `Authorization: Bearer` token to OpenRouter (a third party). The live
  config currently does this correctly — the flag appears only under Claude
  model groups (`claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*`,
  `claude-fable-5`, plus the bare family aliases `opus`, `sonnet`, `fable`),
  never in `litellm_settings` or under any
  OpenRouter/OpenAI entry, and the config's own comments warn against the
  global form — but I2 holds **only** as long as that operator convention is
  maintained. It is not automatically guaranteed.
  The allowlist the guard enforces is `claude-*` (minus any `*-openrouter`
  suffix) plus the exact bare aliases in `BARE_ANTHROPIC_FAMILY_ALIASES`
  (`src/litellm/header-passthrough-guard.ts`). **Registering a new bare
  Anthropic family alias in `model_list` means adding it to that set in the
  same change** — otherwise the guard reports it as a non-Claude group and
  lint / the fleet-health sensor raise a false-positive OAuth-leak violation
  (this is what happened when the bare `opus` group was added 2026-07-25).
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
- **Hindsight DOES hold a live OAuth credential.** The broker socket is mounted
  unconditionally and the broker writes a real subscription OAuth credential to
  the container's `/run/claude-creds/.credentials.json` (a `mode=0700` tmpfs at
  `src/setup/hindsight.ts:851`; the broker keeps it re-pointed on account
  failover — see `src/auth/broker/server.test.ts:3169`). So the safeguard that
  stops hindsight's background memory ops from burning the Claude subscription
  is **not** credential-absence — the credential is present. It is purely that
  `ANTHROPIC_BASE_URL` points at LiteLLM (`http://127.0.0.1:4010`, verified
  live) and the configured models are non-Anthropic (the live global is
  `openrouter/z-ai/glm-5.2`), so `claude` never opens a direct Anthropic
  connection. If hindsight were ever booted with a Claude *global* model **and**
  the apply-time litellm branch were skipped (see G2), that same mounted
  credential would route Claude traffic on the subscription.
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
- **G2 — LiteLLM is not a hard guarantee — but only AGENTS fail-open; Hindsight
  fails-CLOSED.** These two consumers behave oppositely on a proxy outage, and
  an earlier draft wrongly claimed both fail-open.
  - **Agents fail-open.** `start.sh` runs a bounded boot liveliness probe
    (`profiles/_base/start.sh.hbs:927-932` for the rationale; the probe/strip
    logic at `:946-994`). If the virtual key is missing or the proxy is
    unreachable after the retry window, it strips the routing env
    (`unset ANTHROPIC_BASE_URL …`) and the `claude` CLI falls back to the direct
    broker-OAuth Anthropic path (untracked, unguarded). This is a deliberate
    availability-over-tracking choice (operator decision 2026-06-28) — logged
    loudly, re-probed every boot, an explicit accepted trade-off, not a silent
    bug.
  - **Hindsight does NOT do this.** `src/setup/hindsight.ts` sets
    `ANTHROPIC_BASE_URL` **statically at apply / container-create time** inside
    the `if (litellm)` branch (`:756`, the env emitted at `:786`) with **no
    boot probe** and no runtime fallback. If the proxy is DOWN at request time,
    hindsight **hard-fails the memory op** (the `claude` subprocess cannot reach
    its base URL) rather than falling back to the subscription. Hindsight's
    *only* direct-OAuth mode is the apply-time case where **no** `litellm`
    config is passed at all (the whole `if (litellm)` block is skipped, so
    `ANTHROPIC_BASE_URL` is never set and `claude` talks to Anthropic directly).
    There is no availability-over-tracking fallback for a proxy that dies
    *after* apply.
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
- **G6 — OpenRouter account-credit exhaustion takes a memory op-class dark with
  no fallback and no alerting.** Hindsight's non-Claude ops route through a
  single funded OpenRouter account; when its credit runs out, every affected
  op-class fails silently. **Observed 2026-07-07:** ~1,616 `Insufficient
  credits` 402s for `openrouter/z-ai/glm-5.2` (customer=`hindsight`) spanning
  ~22:08→00:20 UTC. Consolidation — which inherits the live global model
  `openrouter/z-ai/glm-5.2` (an operator override of the G3 code default) —
  stalled and kept re-polling for the whole window; it self-recovered only once
  the credits were topped up. There is **no degradation path**: memory ops
  depend on a funded OpenRouter account, and nothing falls back, alerts, or
  down-shifts when it empties. Complements G2 (proxy-down hard-fail) — this is
  the *account-out-of-funds* failure mode, equally undegraded and additionally
  unmonitored.
- **G7 — LiteLLM `tpm_limit`/`rpm_limit` caps are not yet enabled on the
  fleet.** The classification prerequisite is DONE: a 429 raised by the
  proxy's own limiters is recognized as `litellm-local` (distinct from an
  Anthropic account 429) and takes the calm path — no quota-ledger mark, no
  failover (`classify429Detail` in `telegram-plugin/throttle-tier.ts`;
  signal provenance in `litellmProxyLocal429Signals`,
  `telegram-plugin/model-unavailable.ts`; behavior documented in
  docs/auth.md § "LiteLLM-proxy-local 429s"). Every classified 429 emits a
  `rate_limit_429_classified` runtime metric so account-scoped 429s can be
  correlated with fleet TPM. The operator surface is also DONE: a
  `litellm-local` 429 posts a calm, per-agent-debounced "fleet token limiter
  engaged" notice (default 15-min window,
  `channels.telegram.litellm_notice.window_ms`; docs/auth.md §
  "LiteLLM-proxy-local 429s") instead of the generic rate-limited card, so
  when caps are enabled their trips are legible and quiet. Follow-up: pick
  cap values from the metric and enable `tpm_limit` on the per-consumer
  virtual keys / deployments in the operator-maintained proxy config.
- **G8 — LiteLLM-side retry churn on Claude groups fights the broker's
  failover authority.** The auth broker is the retry/failover authority for
  subscription accounts: on a real 429 it marks the account exhausted and rolls
  the fleet to a healthy account (`markExhaustedAndRoll`,
  `src/auth/broker/server.ts`). A Claude `model_group_settings` entry with
  `num_retries > 1` and no `fallbacks` chain just re-hammers the SAME walled
  account inside LiteLLM before the broker's failover can take effect — added
  latency, no benefit. **Recommended shape** (advisory-warned by
  `scripts/check-litellm-config-guard.mjs` and the fleet-health litellm-config
  sensor): set `num_retries: 1` on Claude groups and configure a `fallbacks`
  chain (e.g. `claude-opus → claude-sonnet`) so a single in-proxy failure hands
  off to a different group rather than retrying the exhausted one, leaving the
  broker's mark-exhausted / roll as the account-level failover authority. This
  is a WARN, not an enforced invariant — the operator owns the proxy config.

## Verification

The 2026-07-08 revision (I2 reframing, the G2 agents-vs-Hindsight correction,
the Hindsight-credential clarification, and G6) came from a **live adversarial
review on 2026-07-08**. Findings were confirmed against ground truth, not
inferred: LiteLLM spend logs + tags and Hindsight container logs were read
directly, and `/proc/<pid>/environ` of the spawned `claude` binary was
inspected to confirm the routing env. That check verified non-Claude models
(`gpt-oss-120b`, `openrouter/z-ai/glm-5.2`, etc.) are **genuinely served via
OpenRouter through LiteLLM** — `api.anthropic.com` cannot serve
`gpt-oss-120b`, so a successful response to that model is proof the request
did not touch the Anthropic subscription endpoint. The live LiteLLM config
(`/host/data/coolify/services/<litellm-service-id>/litellm-config.yaml`)
and Hindsight's live container env (`ANTHROPIC_BASE_URL=http://127.0.0.1:4010`,
global model `openrouter/z-ai/glm-5.2`) were also read directly for the I2 and
Hindsight-credential claims above.

## Boot-time model resolution is LIVE (Defect B fix, 2026-07-17)

The model an agent boots with is **no longer frozen at `switchroom apply`
time**. `profiles/_base/start.sh.hbs` ("Live configured-default resolution")
resolves the configured model at every boot by shelling
`switchroom agent effective-model <name>` against the live-mounted
`$SWITCHROOM_CONFIG` — the same `resolveMainModel` resolver the gateway's
/status and `agent list --json` use, so what-you-see and what-runs come from
one implementation. Editing `model:` in switchroom.yaml + `docker restart`
now applies the change; no full apply needed for Claude↔Claude switches.

Bounded fallback chain (never silent past the live read): live yaml →
`.configured-default-model` (last-known-good from the prior boot) → the
apply-time bake, with a `.session-model-alert` relayed to the operator on any
fallback. Two deliberate boundaries:

- **Claude↔sr-\* class flips still require a real `switchroom apply`** —
  routing (`ANTHROPIC_BASE_URL` passthrough vs router root, litellm
  provisioning) is rendered into compose at apply time. The launcher detects
  a class flip between the live value and the bake, refuses to half-apply it,
  boots the baked model, and alerts "run switchroom apply".
- **A proxy-only configured default (`fable`) with LiteLLM unreachable at
  boot degrades to `opus` with an alert** instead of 4xx-ing every call
  (the codename is retired direct-to-Anthropic; only the router serves it).

Known residual (tracked follow-up): the single-file yaml bind mount is
inode-pinned per container start, and host-side CLI writers save via atomic
rename — so a LONG-RUNNING gateway's mid-life `agent list` reads reflect the
yaml as of its last container start. Boot-time reads (the path above) always
re-resolve and are unaffected.
