# Runbook — changing Hindsight per-op LLM models

How to change which model runs Hindsight's LLM operations (retain /
reflect / consolidation — recall is local-only, no LLM) **without**
accidentally leaving the traffic on the wrong lane or the old config
silently live. Each step below encodes a mistake that was actually made
in production; don't skip the verification.

Background surfaces: schema + inheritance in
[`hindsight-memory.md` § "LLM model selection"](hindsight-memory.md#llm-model-selection-hindsightllm);
routing internals and known gaps (G1–G7) in
[`docs/model-routing.md`](../model-routing.md).

## 1. The yaml shape

Per-op routing lives in the operator's `switchroom.yaml` under
`hindsight.llm.{retain,reflect,consolidation}`. Any field an op omits
inherits the global `hindsight.llm.provider`/`model`.

```yaml
hindsight:
  llm:
    # global default (omit to keep the fleet default)
    # provider: claude-code
    # model: claude-sonnet-5
    retain:
      provider: litellm
      model: openai/gpt-oss-20b
      base_url: "http://127.0.0.1:4010/v1"
      api_key: "vault:litellm/hindsight-virtual-key"   # LiteLLM virtual key
    reflect:
      provider: litellm
      model: openai/gpt-oss-20b
      base_url: "http://127.0.0.1:4010/v1"
      api_key: "vault:litellm/hindsight-virtual-key"
    consolidation:
      provider: litellm
      model: openai/gpt-oss-20b
      base_url: "http://127.0.0.1:4010/v1"
      api_key: "vault:litellm/hindsight-virtual-key"
```

## 2. Pick the routing lane — `model:` alone does NOT reroute

This is the #1 repeat mistake (`docs/model-routing.md` G1/G5): when the
**global** provider is `claude-code`, setting only a per-op `model:` does
not change where the traffic goes. The container-level
`ANTHROPIC_BASE_URL`/OAuth path is derived from the **global** model
only, and the upstream `claude-code` provider ignores `ANTHROPIC_BASE_URL`
under OAuth auth regardless. Two correct lanes:

**Lane A — non-Claude model via LiteLLM** (move burn off the Anthropic
subscription onto e.g. `openai/gpt-oss-20b`). The op MUST carry all four
fields — `provider: litellm` selects hindsight's real OpenAI-compatible
client (no OAuth), and it needs its own endpoint + credential:

```yaml
retain:
  provider: litellm
  model: openai/gpt-oss-20b
  base_url: "http://127.0.0.1:4010/v1"     # LiteLLM proxy, /v1
  api_key: "vault:litellm/hindsight-virtual-key"
```

**Lane B — subscription Claude via the broker OAuth passthrough**. Use
`provider: claude-code` + a Claude model-group name, with **no**
`base_url` / `api_key` (the broker-written OAuth credential and the
LiteLLM `/anthropic` passthrough handle routing):

```yaml
retain:
  provider: claude-code
  model: claude-sonnet-5
```

Mixing the lanes (e.g. `provider: claude-code` + `base_url`) or taking a
half-lane (`provider: litellm` without `base_url`/`api_key`) is a
misconfiguration — expect hard-failed memory ops or, worse, traffic
silently landing on the subscription.

## 3. Apply — recreate the container, from the HOST

Env is read only at container launch. A plain `docker restart
switchroom-hindsight` does **not** re-derive env from yaml — you must
recreate:

```bash
switchroom memory setup --recreate            # follows release.pin if set
switchroom memory setup --recreate --tag vX.Y.Z   # explicit fleet-release pin
```

**Run this on the host, not inside an agent container.** Agent containers
export `SWITCHROOM_CONFIG=/state/config/switchroom.yaml` — a read-only,
apply-time **snapshot**. A CLI run in that environment silently reads the
stale snapshot and recreates hindsight with the OLD config, reporting
success. If you must run it from a container that mounts the host, point
the CLI at the real yaml explicitly:

```bash
SWITCHROOM_CONFIG=/host/home/<operator>/.switchroom/switchroom.yaml \
  switchroom memory setup --recreate
```

## 4. Verify — env, then health

Don't trust the recreate's exit code; check what the container actually
got:

```bash
docker inspect switchroom-hindsight --format '{{json .Config.Env}}' \
  | tr ',' '\n' | grep -E 'HINDSIGHT_API_(RETAIN|REFLECT|CONSOLIDATION)?_?LLM'
docker inspect switchroom-hindsight --format '{{.State.Health.Status}}'
```

Expect `HINDSIGHT_API_<OP>_LLM_MODEL` / `_PROVIDER` (and `_BASE_URL` for
lane A) to match the new yaml, and health to reach `healthy`. If an op's
vars are absent, it inherits the global `HINDSIGHT_API_LLM_*` — confirm
that's what you intended.

## 5. Rollouts can silently REVERT your change — refresh hostd's config view

Observed live (v0.19.1 rollout, 2026-07-19): a hostd-driven
`switchroom rollout` recreated hindsight from hostd's **own** view of
`/state/config/switchroom.yaml`, which was hours stale, and silently
reverted a just-applied retain model change. The host yaml edit was
intact; only hostd's view of it was stale.

Why: the singletons bind-mount the yaml as a **single file**
(`<home>/.switchroom/switchroom.yaml:/state/config/switchroom.yaml`,
`src/cli/hostd.ts:316`). Switchroom's config writers are atomic
(write-temp + `rename`, e.g. `src/config/overlay-writer.ts:181`), and many
editors save the same way — the rename swaps the **inode**, while Docker's
file bind mount stays pinned to the old inode. From that moment the
container reads a frozen pre-edit snapshot until it restarts (restart
re-resolves the bind path).

So, after editing `hindsight.llm` in the host yaml:

- **Refresh hostd's view**: `docker restart switchroom-hostd` (do the same
  for any singleton that will act on the config) so a later rollout
  carries your edit instead of the stale inode.
- **After ANY fleet rollout or hostd-driven recreate**, re-run the step-4
  `docker inspect` verification — assume a rollout may have reverted the
  hindsight env until proven otherwise.
- Recovery if it did revert: re-run `switchroom memory setup --recreate`
  on the host against the live yaml, then re-verify.

## 6. Rollback — keep the previous config in a comment

Before editing, copy the outgoing per-op block into a dated yaml comment
next to the new one ("interim config, restore if X fails again: …").
Rollback is then: uncomment / re-paste the old block, re-run the recreate
(step 3), re-verify (step 4). The live host yaml carries examples of this
comment convention.

## Known failure modes to watch after a swap

- **Proxy down ⇒ hindsight hard-fails** memory ops (no boot probe, no
  fallback — `docs/model-routing.md` G2).
- **OpenRouter credit exhaustion ⇒ op-class goes dark silently** (G6);
  consolidation stalls and re-polls until credits are topped up.
