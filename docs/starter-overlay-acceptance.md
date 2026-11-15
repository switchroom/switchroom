# Starter overlay acceptance in real containers

This records the first run of the starter overlay, its sidecars and the rollout
runner in real, throwaway Docker containers. Every agent was synthetic: no real
credentials, no chat platform tokens, no vault, no messaging and no published
host ports. Everything was torn down afterwards.

A default in [`contracts/plugins.json`](../contracts/plugins.json) moves from
`planned` to `shipped` only when this run proved it working in a running
container. The rest stay `planned`, and the reason is given below.

## What ran

| Item | Value |
| --- | --- |
| Fleet source | `main` at `86434b00b6b5d43b5050185e83bc3f3481ee77bc` |
| Agent image | `ghcr.io/mekenthompson/hermes-fleet-public@sha256:445ea377d12074b37baa19f32562683af4d2f84d7eb1926743d2fba4a09ee9ee` (Fleet revision `86434b0`) |
| Rollout images | `…@sha256:275da2bd48ea93a707a31e8e30c8a6b86730e012905cdadee6d276b5612b8d36` (revision `d70db49`) and `…@sha256:237288d8058f080afa77209ac1e26ddc64abf8b3e867fbfa2e71f3b97d9cbc3d` (revision `06a0797`) |
| Overlay | `examples/overlay-repo/` copied as is; `vendor/` fetched with `scripts/fetch-overlay-vendor.py --fleet-revision 86434b0…` |
| Sidecars | `compose.sidecars.yaml` as is: Kokoro CPU, Honcho and its database by digest |

Two acceptance-only Compose overrides were layered on top. Neither is part of
the overlay. One added a gateway healthcheck (`curl` to the gateway's own
`/health` on its loopback API listener) and read-only mounts for the setup
check. The other held the diagnostic Honcho fix described below.

The setup check was run with `--check-files` in a sibling container sharing the
running agent's image, volumes and env file. The agent's own effective settings
were read through Hermes's own loaders (`load_config`, the plugin list, the
skill search roots, and the disk-cleanup plugin's mode reader) and from the
gateway log.

## Results per default

The single agent `ops` started with an empty env file, so every default that
needs a credential had to turn itself off. The gateway reached `running`,
became healthy and stayed up with no restarts and no fatal log lines. A second
agent `worker` was then started with obviously fake values
(`CLAUDE_CONFIG_DIR` pointing at an empty directory, a fake Perplexity key) and
also started and stayed healthy.

| Default | Result | Evidence |
| --- | --- | --- |
| `doctrine-config` | **shipped** | The effective config has the 834-character system prompt (resolved through Hermes's prompt resolver), `approvals.mode: smart`, cron, unattended and single-query approvals `deny`, queue-first busy input, `verify_on_stop: true`. |
| `gateway-per-agent` | **shipped** | `gateway.multiplex_profiles: false` in the effective config. Each container runs its own single default gateway under s6. |
| `quota` | **shipped** | The pinned plugin (3.0.0, git source) is enabled. The gateway mounted its routes at `/api/plugins/quota/`. Agent tool override is denied (`capability=tools.override decision=deny`). |
| `session-reset-policy` | **shipped** | The pinned plugin logged `session-reset-policy v0.3.0 armed (pre_gateway_dispatch)`. The effective `session_reset` is `{mode: idle, idle_minutes: 240}`. |
| `security-guidance` | planned | The image's `security-guidance` plugin is enabled in the effective config. This run did not observe it loaded with its hook registered, or a dangerous-pattern write producing its warning, so it is not proven working. |
| `disk-cleanup` | planned | The mounted plugin's files match every `files_sha256` in its `UPSTREAM.json`, with patch `manual-delete-guard`. The plugin's own reader returns `session_end_mode: report_only` and `allow_manual_delete: false`. This shows the right files and settings, but the run did not observe the plugin loaded in the gateway, `/disk-cleanup quick` and `deep` refused in the container, or a session-end report that deletes nothing, so it is not proven working. |
| `shared-skill-pack` | planned | The pack mounts read-only and `skills.external_dirs` is in the merged config. But Hermes's skill search reads `skills.external_dirs` only from the agent's own `config.yaml`, not from the managed file, so the search roots are only the profile's skills directory. The setup check reports `on` anyway. |
| `secrets-connect` | planned | Off as designed: the setup check said `using the env file`. The Connect path was not run (see Sidecars). |
| `coding-clis` | planned | Claude Code 2.1.323, Codex 0.167.2, Grok 1.0.77 and OpenCode 1.19.5 are on the path. With no logins the setup check reports each one off. Turning on needs a real login. |
| `model-roles` | planned | Off with no granted provider: Hermes kept its own model setting and added no fallback. With `CLAUDE_CONFIG_DIR` set but no login, the setup check still prints `model-roles: on` while both providers in the chain report off. |
| `claude-subscription-directsdk` | planned | Off when `CLAUDE_CONFIG_DIR` is unset. When it is set but has no login, the renderer turns it on: the main provider becomes `claude-subscription-directsdk-experimental` with the plugin enabled, while the setup check reports it off. Start is not blocked, but the default is half-on. |
| `claude-acp-connectors` | planned | Same as above: with an empty `CLAUDE_CONFIG_DIR` the ACP fallback and the connectors plugin (`enabled: true`) are configured while the setup check reports off. |
| `linear` | planned | Off as designed: `plugins.entries.linear.settings.enabled: false` and the plugin is not enabled. Turning it on needs a real Linear app authorization, which this run does not use. |
| `web-search` | planned | With no key the default web backend is used. A fake key configures `web.search_backend: perplexity` and enables `web-perplexity`. A real search needs a real key. |
| `voice` | planned | The Kokoro sidecar on CPU crashes on start (exit 139). The kernel log puts the segfault in `libonnxruntime_providers_cuda.so`: with no GPU visible, the CUDA provider crashes instead of raising, so the sidecar's CPU fallback never runs. Changing STT compute to `float32` did not help. Separately, with voice off the effective `tts.provider` is the Hermes default `edge`, a hosted text-to-speech service, not text-only. |
| `honcho-memory` | planned | The Honcho sidecar as shipped crash-loops. At import it fetches the tiktoken `o200k_base` encoding from the internet, and the starter gives Honcho no egress network. A diagnostic run with a read-only, pre-seeded tiktoken cache (`TIKTOKEN_CACHE_DIR`) started Honcho with summariser, deriver, dreaming, peer cards and embeddings all off. A synthetic message then round-tripped through Honcho from the `ops` agent's network, and `hermes memory status` showed `honcho` active and available. The shipped compose still needs that fix. |

The setup check also needs PyYAML, which the image does not contain (Hermes
uses `ruamel.yaml`). This run supplied PyYAML on `PYTHONPATH` to run it inside
the container.

## Sidecars and isolation

These probes ran with `curl` from inside each container's own network
namespace. Membership was read from Docker.

| From | To | Result |
| --- | --- | --- |
| `ops` (Honcho consumer) | `honcho:8000` | HTTP 200 |
| `worker` (Honcho consumer) | `honcho:8000` | HTTP 200 |
| `ops` (not a database consumer) | `honcho-db:5432` | name does not resolve |
| `honcho` (database consumer) | `honcho-db:5432` | connects (Postgres speaks no HTTP) |
| `honcho` | the internet | name does not resolve (no egress) |
| `worker` (voice opted out) | `voice:8126` | name does not resolve; `worker` is not on the voice network |
| new container on `worker`'s own network | `honcho:8000` | name does not resolve |
| new container on Docker's default bridge | `honcho:8000` | name does not resolve |

`voice`, `honcho`, `honcho-db` and `onepassword` are `internal` networks.
Only `voice-egress` reaches the internet, and it is joined only by the voice
sidecar. Note that `ops` and `worker` share the `honcho` network, so they can
reach each other there.

1Password Connect was **skipped**. It needs a real `1password-credentials.json`
to start, and its sync container then talks to 1Password. Neither fits a
synthetic run.

## Rollout runner

This was a two-agent synthetic project, `alpha` (controller) and `beta`, with
the gateway healthcheck. The runner was `scripts/switchroom-rollout.py` from
the same `main`.

1. A tag-only target was refused with exit 2. The dry run printed
   `beta -> alpha` and changed nothing.
2. Forward, from revision `d70db49` to `06a0797`: `beta` was recreated and
   healthy, then `alpha`. Exit 0, status `passed`.
3. Forced failure, from `06a0797` back to `d70db49`, with `beta`'s healthcheck
   set to fail only when the image provenance names `d70db49`. `beta` came up on
   the target image ID, turned `unhealthy`, and was recreated on its recorded
   previous image (`06a0797`), healthy again. Exit 1, status `failed`,
   `failed_agent: beta`, `rolled_back: true`, `not_started: [alpha]`. `alpha`
   kept the same container and start time throughout.

## Not proven here

- Any default whose on-state needs a real credential: Claude logins, Linear
  authorization, a Perplexity key, a Connect token.
- Voice replies and transcription, until the Kokoro CPU crash is fixed.
- Honcho from the shipped compose, until the tiktoken cache or another fix
  lands.
- The shared skill pack being found by Hermes's skill search.
- `security-guidance` and `disk-cleanup` working in the running gateway (configuration and file checks only).
- Chat delivery on any platform: none was configured.
