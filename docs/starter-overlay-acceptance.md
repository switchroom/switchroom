# Starter overlay acceptance in real containers

This records three runs of the starter overlay, its sidecars and the rollout
runner in real, throwaway Docker containers: the first run, a
[rerun after the real-boot fixes](#rerun-after-the-real-boot-fixes), and a
[short rerun of voice and the skill pack](#short-rerun-of-voice-and-the-skill-pack). Every
agent was synthetic: no real credentials, no chat platform tokens, no vault, no
messaging and no published host ports. Everything was torn down afterwards.

A default in [`contracts/plugins.json`](../contracts/plugins.json) moves from
`planned` to `shipped` only when a run below proved it working in a running
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
| `security-guidance` | planned | The image's `security-guidance` plugin is enabled in the effective config. This run did not observe it loaded with its hook registered, or a dangerous-pattern write producing its warning, so it is not proven working in this run. Proven in the [rerun](#rerun-after-the-real-boot-fixes). |
| `disk-cleanup` | planned | The mounted plugin's files match every `files_sha256` in its `UPSTREAM.json`, with patch `manual-delete-guard`. The plugin's own reader returns `session_end_mode: report_only` and `allow_manual_delete: false`. This shows the right files and settings, but the run did not observe the plugin loaded in the gateway, `/disk-cleanup quick` and `deep` refused in the container, or a session-end report that deletes nothing, so it is not proven working in this run. Proven in the [rerun](#rerun-after-the-real-boot-fixes). |
| `shared-skill-pack` | planned | The pack mounts read-only and `skills.external_dirs` is in the merged config. But Hermes's skill search reads `skills.external_dirs` only from the agent's own `config.yaml`, not from the managed file, so the search roots are only the profile's skills directory. The setup check reports `on` anyway. |
| `secrets-connect` | planned | Off as designed: the setup check said `using the env file`. The Connect path was not run (see Sidecars). |
| `coding-clis` | planned | Claude Code 2.1.326, Codex 0.172.0, Grok 1.0.92 and OpenCode 1.19.5 are on the path. With no logins the setup check reports each one off. Turning on needs a real login. |
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
- `security-guidance` and `disk-cleanup` working in the running gateway (configuration and file checks only); the [rerun](#rerun-after-the-real-boot-fixes) proved both.
- Chat delivery on any platform: none was configured.

## Rerun after the real-boot fixes

The second run re-tested what the first run could not prove, after the fixes
for the defects above landed, and re-checked the defaults already shipped. The
same rules applied: synthetic agents, fake or missing credentials only, no
messaging, no published host ports, and everything torn down afterwards.

| Item | Value |
| --- | --- |
| Fleet source | `main` at `86c2167e8f941cdaa8e40a81108360916bd203be` |
| Agent image | `ghcr.io/mekenthompson/hermes-fleet-public@sha256:efbdce603e15814909a1ddb0f370a42552916b8c05994ccadde85b244e6cd49c` (Fleet revision `79ef9e7`) |
| Overlay | `examples/overlay-repo/` copied as is; `vendor/` fetched with `scripts/fetch-overlay-vendor.py --fleet-revision 86c2167…` |
| Sidecars | `compose.sidecars.yaml` as is: Kokoro-FastAPI CPU, the one-time tokenizer fetch, Honcho and its database, all by digest |
| Overrides | one, acceptance only: a gateway healthcheck. No extra Python modules and no Honcho fix |

`86c2167` changed no image input, so no image was published for it, and the
newest image (`79ef9e7`) has the same image inputs. The Kokoro plugin and the
renderer and setup check that this run needed are mounted from `vendor/`, so
`vendor/` was fetched at `86c2167`, not at the image's revision. Fetching at
the image's revision, as the quick start says, would mount the Kokoro plugin
and scripts from before the fixes. The first image whose revision includes
them is the next published one.

The checks ran in sibling containers that share the running agent's image,
volumes, mounts and env file, through Hermes's own code: the plugin manager's
discovery (`get_plugin_manager().discover_and_load()`, the same discovery the
gateway runs, which found the same 67 plugins with 63 enabled as the gateway
log), the agent loop's tool dispatch (`model_tools.handle_function_call`,
which runs `pre_tool_call`, the real tool, `post_tool_call` and
`transform_tool_result`), the gateway's plugin command call
(`invoke_plugin_command` on the handler from `get_plugin_command_handler`),
and `invoke_hook` for session end. No chat platform or model was configured,
so slash commands were not typed into a chat.

Both agents and every sidecar stayed up for the whole run with no restarts,
no GPU requested, and no fatal or segfault lines in their logs.

| Default | Result | Evidence |
| --- | --- | --- |
| `security-guidance` | **shipped** | Loaded and enabled with both hooks registered (`pre_tool_call`, `transform_tool_result`). A `write_file` of code calling `pickle.loads`, through the tool dispatch, wrote the file and returned `⚠️ Security guidance — 1 pattern matched (pickle_deserialization)`. A harmless write returned no warning. |
| `disk-cleanup` | **shipped** | Loaded and enabled with its three hooks and the `/disk-cleanup` command. A `test_*.py` file written through the tool dispatch was tracked by the plugin's own hook. Through the registered command handler, `quick` and `deep` each returned `refused: session_end_mode is report_only ... Nothing was deleted.` The `on_session_end` hook returned `{mode: report_only, auto_candidates: 1, prompt_candidates: 0}`. The tracked file and every other file were still there afterwards. |
| `voice` | planned (proven working, held) | Held at `planned` only because `voice` covers the `voice-provider` component, and the contract still pins that no component is on (`default_enabled`) and no shipped default covers one. Marking it shipped needs that rule decided first. What this run proved: the Kokoro CPU sidecar started with no GPU and stayed up. With the voice variables set, the effective `tts.provider` is `kokoro`, and Hermes's `text_to_speech` tool returned success from provider `kokoro` with an Ogg (`OggS`) file of about 32 KB. On CPU there is no transcription: the provider reports `this Kokoro server has no transcription`, Hermes's transcription reports the `kokoro_sidecar` provider unavailable, and nothing falls back to a hosted service. With voice off (`worker`), the effective `tts.provider` is the local `text-only` command engine and the only TTS provider configured, `tts` is in `agent.disabled_toolsets`, automatic voice replies and transcription are off, and `text_to_speech` fails from `text-only` with no hosted engine tried. |
| `honcho-memory` | **shipped** | From the shipped compose: the one-time tokenizer fetch filled its volume and exited 0, then Honcho started with no egress network and no restarts. A synthetic message round-tripped through Honcho from both agents' own network namespaces, and `hermes memory status` showed `honcho` active and available. |
| `shared-skill-pack` | planned (defect) | Found now: the search root is the agent's skills directory, Hermes's `skills_list` tool lists all four pack skills, and `skill_view` loads one. But Docker creates that skills directory as root (mode `755`) on a fresh state volume to hold the pack's mount point, so the agent can no longer write it: `skill_manage create` fails with `Permission denied` on the skills lock directory. The pack is found, but agents lose the ability to save their own skills. |
| `claude-subscription-directsdk` | planned | Off with no login file and with an empty `.credentials.json`. The host render, the in-container render with `--check-files` and the setup check agree (`no Claude login found in CLAUDE_CONFIG_DIR`). The in-container render equals the host render. No model provider, fallback or Claude plugin is set or enabled, so nothing is half-on. Turning it on needs a real login. |
| `claude-acp-connectors` | planned | Same as above, and `claude-account-connectors` has `settings.enabled: false`. Turning it on needs a real login. |
| `model-roles` | planned | The renderer and the setup check both say off (`no granted model provider is available`), matching both providers being off. The effective model setting is Hermes's own, with no fallbacks. Turning it on needs a granted provider with a login. |
| `linear` | planned | Off with fake IDs and a missing or empty token file; `settings.enabled: false` and the plugin is not enabled. For an empty token file the reason says the file `does not exist`, which is the wrong wording. Turning it on needs a real authorization. |
| `coding-clis` | planned | Inside the container each CLI reports off with no login. An empty Claude login file makes `coding-clis.claude` report on, while the Claude defaults call the same file no login. Turning it on needs real logins. |

The four defaults already shipped still hold on both agents: the 834-character
doctrine prompt with smart approvals and cron, unattended and single-query runs
denied, queue-first input and verify-on-stop; `gateway.multiplex_profiles:
false`; the quota plugin enabled with its routes mounted and tool override
denied; and `session-reset-policy v0.3.0 armed` with `session_reset` idle after
240 minutes.

The setup check and the renderer ran inside the image with its own `python3`
and nothing added: `import yaml` fails there, both scripts read YAML with the
image's `ruamel.yaml`, and both exited 0.

### Isolation

| From | To | Result |
| --- | --- | --- |
| `ops` (voice consumer) | `voice:8880/health` | HTTP 200 |
| `ops` | speech, no token or a wrong token | HTTP 401 |
| `worker` (voice off) | `voice` | name does not resolve |
| new container on Docker's default bridge or on `worker`'s own network | `voice` | name does not resolve |
| `voice` | the internet | name does not resolve (no egress) |
| `ops` and `worker` (Honcho consumers) | `honcho:8000` | HTTP 200 |
| `ops` (not a database consumer) | `honcho-db` | name does not resolve |
| `honcho` | the internet | name does not resolve (no egress) |
| new container on Docker's default bridge or on `ops`'s own network | `honcho` | name does not resolve |

The voice sidecar is now on its internal `voice` network only. Only the
tokenizer fetch joins `honcho-tiktoken-egress`, and no agent does. No container
published a port.

### Other defect found

The agent's workspace volume comes up owned by root (mode `755`), so the agent
cannot write its own workspace: `write_file` there fails with
`Permission denied`. This is not one of the defaults, but it affects every
agent the starter overlay starts.

### Fixed after the rerun, not yet re-run in containers

These changes landed after this run, with unit tests only. The
[short rerun](#short-rerun-of-voice-and-the-skill-pack) then proved voice and
the skill pack in containers.

- **Voice guard.** A component may now be on only under a `shipped` default
  that carries the enable guard (`enable_guard`: sidecar configured and
  reachable, no hosted fallback). `voice` carries it. Voice turns on only when
  the in-container render (`--check-files`) sees the sidecar answer its health
  route; a host render leaves it off as not checked. Voice on must name
  `stt.provider: kokoro_sidecar`. The contract summary now says the CPU server
  has no transcription and the GPU sidecar is the option for it.
- **Skill pack mount point.** Each agent has a one-shot `<agent>-skills-init`
  service that creates `/opt/data/skills/switchroom-shared` as the agent user
  before the agent starts, so Docker no longer creates the skills directory as
  root. The setup check reports the pack off if the agent cannot write its
  skills directory.
- **`coding-clis.claude`** uses the same real-login check as the Claude
  defaults, so an empty login file is off.
- **Linear.** An empty token file is reported as `is empty`.

The root-owned workspace volume is a separate defect and is not fixed here.

### Not proven in the rerun

- Any default whose on-state needs a real credential: Claude logins, Linear
  authorization, a Perplexity key, a Connect token.
- Transcription: the CPU server has none, and the GPU variant was not run.
  The `voice` summary in the contract still says local transcription, which
  holds only for the GPU sidecar.
- The gateway process's own plugin list over its API, which needs an
  `API_SERVER_KEY` the starter does not set; plugin loading was shown through
  the same discovery code with the same files and settings.
- Slash commands and voice notes typed into a chat platform: none was
  configured.
- 1Password Connect, for the reason given above.

## Short rerun of voice and the skill pack

The third run re-tested only voice and the shared skill pack after the fixes
listed above, and re-checked the seven defaults already shipped. Same rules:
synthetic agents `ops` and `worker`, fake or missing credentials only, no
messaging, no host ports except the Linear receiver's loopback port, and
everything torn down afterwards.

| Item | Value |
| --- | --- |
| Fleet source | `main` at `689fea031abd35a2f7d9002cdb737fdf15a9b403` |
| Agent image | `ghcr.io/mekenthompson/hermes-fleet-public@sha256:50175d9daa68ac436c97eadf10dcae6570cbce91224e7260ed15c24c0f3a7930` (Fleet revision `689fea0`, the image published for that commit) |
| Overlay | `examples/overlay-repo/` copied as is; `vendor/` fetched with `scripts/fetch-overlay-vendor.py --fleet-revision 689fea0…`, the image's own revision, as the quick start says |
| Compose | `compose.yaml` and `compose.sidecars.yaml` as is, from fresh volumes. No overrides |

The Linear receiver printed `linear-receiver: off: LINEAR_RECEIVER_PUBLIC_URL
is not set` and exited 0, as designed. Every service stayed up for the whole
run with no restarts, no GPU requested, and no fatal or segfault lines in any
log. Checks ran in sibling containers sharing the running agent's image,
volumes, mounts and env file as the agent user, through Hermes's own code
(`model_tools.handle_function_call` for tools), as in the rerun.

| Default | Result | Evidence |
| --- | --- | --- |
| `shared-skill-pack` | **shipped** | `ops-skills-init` and `worker-skills-init` (the agent image, the agent user, no network, read-only root, all capabilities dropped) exited 0 before their agents started. On the fresh state volumes `/opt/data/skills` is owned by the agent user. On both agents Hermes's `skills_list` tool lists all four pack skills, `skill_view` loads one, and `skill_manage create` of a synthetic skill succeeds in the agent's own skills directory, not in the pack; `skills_list` then lists it. The pack mount is `ro`: a direct write fails with `Read-only file system`, and so does `write_file` through the tool dispatch. The gateway logs show no read-only or permission errors. The in-container setup check prints `shared-skill-pack: on`. |
| `voice` | **shipped** | A host render leaves voice off with `the voice sidecar was not checked`. The quick start's step 7 render inside the container (both compose files, `--check-files`) turns it on because the CPU Kokoro sidecar answers: `tts.provider: kokoro`, `stt.provider: kokoro_sidecar`. After the step 7 recreate, Hermes's `text_to_speech` tool returned success from provider `kokoro` with an Ogg (`OggS`) file of about 32 KB. Transcription reports the `kokoro_sidecar` provider unavailable (`this Kokoro server has no transcription`), and nothing falls back to a hosted service. The same render with the sidecar unreachable turns voice off, text-only, with `the voice sidecar named by HERMES_KOKORO_SIDECAR_URL does not answer`: `tts.provider` is the local `text-only` engine, `tts` is in `agent.disabled_toolsets`, transcription and automatic voice replies are off, and the Kokoro plugin is not enabled. The setup check agrees in each case. `worker` (opted out) stays text-only, and `text_to_speech` fails from `text-only` with no hosted engine tried. |

How the voice-off case was made: the sidecar was not stopped. The tool
running this test refused to stop the container, so the same step 7 render ran
in a sibling of `ops` with no network, so the renderer's health probe could not
reach the sidecar. An identical sibling on `ops`'s own network, with the
sidecar running, rendered voice on. Reachability was the only difference. The
renderer sees an unreachable sidecar and a stopped one the same way: its
health request fails.

The seven defaults already shipped still hold on both agents:
`doctrine-config` (the 834-character prompt, smart approvals, cron, unattended
and single-query runs denied, queue-first input, verify-on-stop);
`gateway-per-agent` (`gateway.multiplex_profiles: false`); `quota` (enabled,
routes mounted, tool override denied); `session-reset-policy` (`v0.3.0 armed`,
idle after 240 minutes); `security-guidance` (loaded with both hooks; a
`pickle.loads` write returned its warning and a harmless write did not);
`disk-cleanup` (loaded with three hooks; `quick` and `deep` refused, the
session-end report counted one candidate and deleted nothing); and
`honcho-memory` (`memory.provider: honcho`; a synthetic message round-tripped
from both agents).

Isolation held as in the rerun: only `ops` resolves `voice`, speech without a
token or with a wrong one returns 401, `worker` and new containers on Docker's
default bridge or on `worker`'s own network cannot resolve `voice`, and `voice`
has no egress.

### Still open after the short rerun

- The agent's workspace volume still comes up owned by root, so `write_file`
  into the workspace fails. It is not one of the defaults.
- Transcription on CPU: the CPU server has none. The GPU sidecar was not run.
- Stopping the voice sidecar itself was not run, for the reason above.
- Defaults whose on-state needs a real credential, chat platforms, and
  1Password Connect, as in the rerun.
