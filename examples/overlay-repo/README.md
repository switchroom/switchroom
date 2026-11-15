# Example overlay repository

Placeholder overlay for a Hermes Fleet deployment, and the Switchroom starter
overlay. Copy this directory into a new git repository. Replace image digests,
agent names, and config values. Do not copy secrets into git.

## Layout

```text
compose.yaml                 Digest-pinned Fleet child, read-only plugin mounts. No secrets.
compose.sidecars.yaml        Kokoro, Honcho and optional 1Password Connect sidecars
vendor.lock.json             Exact commits for the skill pack and plugins compose mounts
fleet-config/schema.yaml     Allowlisted desired-state keys
fleet-config/defaults.yaml   Shared defaults and the starter defaults
fleet-config/agents/         One YAML file per agent
managed/                     /etc/hermes/config.yaml mounts (the rendered config goes here)
vendor/                      Pinned checkouts, fetched, not committed
secrets/                     Env files and credentials, not committed
```

## Config split

- `fleet-config/defaults.yaml` — every agent. No `profile:` key.
- `fleet-config/agents/*.yaml` — one file per agent. `profile:` matches the
  filename stem.
- `managed/*.yaml` — `/etc/hermes/config.yaml` mounts. Restart-gated.
- live `/opt/data/config.yaml` — not in this repo
- secrets — runtime injection only. Never git.

`fleet-config/` is overlay desired-state for a renderer. Compose does not mount
it. Set `HERMES_FLEET_IMAGE` to an immutable `@sha256:` reference before
`docker compose config`.

## Starter defaults

The bare Fleet image turns nothing on. This overlay configures every default in
the reviewed set from `contracts/plugins.json`:

| Default | Turned on by | Off when |
| --- | --- | --- |
| `doctrine-config` | ownership-and-judgement system prompt, smart approvals with cron, unattended and single-query runs denied, queue-first busy input, verify-on-stop | never |
| `gateway-per-agent` | `gateway.multiplex_profiles: false` | never |
| `secrets-connect` | 1Password Connect for this agent's secrets ([Secrets](#secrets)) | `OP_CONNECT_HOST` or `OP_CONNECT_TOKEN` unset: the env file is used |
| `coding-clis` | Claude Code, Codex, Grok and OpenCode from the image, each on this agent's own login | a CLI has no login (setup check, `--check-files`) |
| `claude-subscription-directsdk` | main model provider, no API-key fallback | `CLAUDE_CONFIG_DIR` unset |
| `claude-acp-connectors` | Claude ACP provider plus `claude-account-connectors` | `CLAUDE_CONFIG_DIR` unset |
| `model-roles` | main model then fallbacks, granted providers only | no granted provider has its login |
| `linear` | Linear plugin with a token file, bound to the app's user and workspace IDs ([Linear setup](../../docs/linear-setup.md) steps 4 and 5) | `LINEAR_TOKEN_FILE`, `LINEAR_VIEWER_ID` or `LINEAR_ORGANIZATION_ID` unset |
| `voice` | Kokoro voice replies and local transcription | `HERMES_KOKORO_SIDECAR_URL` or `HERMES_KOKORO_SIDECAR_TOKEN` unset |
| `honcho-memory` | `memory.provider: honcho` | `HONCHO_BASE_URL` unset |
| `web-search` | Perplexity search | `PERPLEXITY_API_KEY` unset |
| `quota` | the quota plugin, pinned in `vendor.lock.json` | never (not fetched: absent and reported) |
| `session-reset-policy` | `session_reset` idle after 240 minutes, through the pinned `hermes-session-reset-policy` plugin | never (not fetched: absent and reported) |
| `security-guidance` | the `security-guidance` plugin in the Hermes image | never |
| `disk-cleanup` | `plugins/disk-cleanup` with `session_end_mode: report_only` | never |
| `shared-skill-pack` | `skills/` mounted read-only at `/opt/skill-packs/shared`, listed in `skills.external_dirs` | never (not fetched: absent and reported) |

A default whose variable is not set is rendered off, so the agent still
starts. `granted_providers` in `defaults.yaml` lists the model providers you
granted; the model chain uses nothing else. An agent file may narrow that
list, never widen it.

Notes on the newer defaults:

- **Session reset.** Hermes core no longer rotates conversations on a timer;
  it only reads `session_reset` through the community
  [`hermes-session-reset-policy`](https://github.com/fastfinge/hermes-session-reset-policy)
  plugin (MIT), pinned by commit. The setup check reports values that plugin
  would silently ignore.
- **Quota.** The [quota plugin](https://github.com/mekenthompson/hermes-quota-plugin)
  (MIT, a public fork of `rarf/hermes-quota-plugin`), pinned by commit. It
  makes no model calls; its optional Agent Monitor stays off.
- **Disk cleanup.** The plugin treats a missing mode as `cleanup`, so the
  renderer refuses a config without `report_only` and the setup check flags it
  as a problem. At session end it only counts candidates. The only deleting
  paths are the operator's own `/disk-cleanup quick` and `/disk-cleanup deep`
  commands; the model has no tool for them.
- **Coding CLIs.** The image already installs them. The overlay declares the
  expected set under `_switchroom`, a top-level key Hermes ignores, so the
  setup check can report each login.

## Pinned sources

`compose.yaml` mounts the skill pack and every plugin the starter turns on,
read-only, from `vendor/`. `scripts/fetch-overlay-vendor.py` fills `vendor/` at
exactly the commits `vendor.lock.json` pins and refuses a checkout at any other
commit or with local changes:

| Entry | Commit | Licence | Provides |
| --- | --- | --- | --- |
| `hermes-fleet` | the image's revision | MIT | skill pack, `plugins/` |
| `hermes-quota-plugin` | `41fea5a9e1c57e2eae43e9b0e2b4c9f80dfd6f2a` | MIT | `quota` |
| `hermes-session-reset-policy` | `493df020496d2782d3fe15308cc3b6672c2224c4` | MIT | `session-reset-policy` |

The Fleet checkout follows the image, so the skills and Fleet plugins come
from the same release as the image you run. A source that was never fetched
mounts as an empty directory: that default is absent, the setup check reports
it, and the agent still starts.

## Secrets

Each agent reads its variables from `secrets/<agent>.env`, which compose loads
as the agent's env file. That file is the fallback, and on its own it is a
complete setup.

To use 1Password Connect instead:

1. Start Connect with `--profile onepassword` (see `compose.sidecars.yaml` and
   [docs/sidecars.md](../../docs/sidecars.md)), with the Connect server's
   `1password-credentials.json` in `secrets/`.
2. Give each agent its own Connect token: put
   `OP_CONNECT_HOST=http://onepassword-connect-api:8080` and that agent's
   `OP_CONNECT_TOKEN` in its env file. Never share a token between agents.
3. Inside the agent container, map each variable Connect should supply. Hermes
   reads these settings only from the agent's own `config.yaml`, never from the
   managed file this overlay renders, and references never go in git:

   ```bash
   hermes secrets onepassword setup --binary-path /usr/local/bin/op
   hermes secrets onepassword set PERPLEXITY_API_KEY '<1Password secret reference>'
   ```

4. List the mapped names in `_switchroom.connect_provides` under
   `secrets-connect` in `defaults.yaml`. While Connect is set, those names
   count as present for the other defaults, so the env file no longer needs
   them.

The setup check says which source is active: `secrets-connect: on` for
Connect, `secrets-connect: off: using the env file: ...` otherwise. With
`--check-files` it also requires the `op` binary and a mapping for every
listed name. It prints names, never values or references.

## Quick start

From a checkout of this repository:

```bash
# 1. Copy the overlay into your own repository.
cp -r examples/overlay-repo ~/my-fleet-overlay

# 2. Fetch the pinned sources. Use the revision of the image you run.
python3 scripts/fetch-overlay-vendor.py \
  --overlay ~/my-fleet-overlay \
  --fleet-revision "$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$HERMES_FLEET_IMAGE")"

# 3. Write the agent's runtime env file outside git. Leave out any line you
#    do not have; that default turns itself off.
mkdir -p ~/my-fleet-overlay/secrets
cat > ~/my-fleet-overlay/secrets/ops.env <<'EOF'
CLAUDE_CONFIG_DIR=/opt/data/.claude
LINEAR_TOKEN_FILE=/opt/data/secrets/linear-token
LINEAR_VIEWER_ID=replace-with-viewer.id
LINEAR_ORGANIZATION_ID=replace-with-organization.id
HERMES_KOKORO_SIDECAR_URL=http://voice:8126
HERMES_KOKORO_SIDECAR_TOKEN=replace-me
HONCHO_BASE_URL=http://honcho:8000
PERPLEXITY_API_KEY=replace-me
EOF

# 4. Render the agent's managed config into the file compose mounts.
#    --report prints one line per default.
python3 scripts/render-overlay-config.py \
  --fleet-config ~/my-fleet-overlay/fleet-config \
  --agent ops \
  --env-file ~/my-fleet-overlay/secrets/ops.env \
  --output ~/my-fleet-overlay/managed/ops.yaml \
  --report

# 5. Run the setup check against the rendered config.
python3 scripts/switchroom-doctor.py \
  --config ~/my-fleet-overlay/managed/ops.yaml \
  --env-file ~/my-fleet-overlay/secrets/ops.env \
  --no-process-env

# 6. Check the compose files, then start the agents and sidecars.
cd ~/my-fleet-overlay
docker compose -f compose.yaml -f compose.sidecars.yaml config -q
docker compose -f compose.yaml -f compose.sidecars.yaml up -d
```

The renderer and the setup check need PyYAML. They read only which variables
are set, never print a value, and write `${NAME}` references that Hermes
expands at start. `secrets/` and `vendor/` are in `.gitignore`.

The setup check prints `<default>: on` or `<default>: off: <reason>` for every
default in the contract. Missing credentials are reported, not fatal: it exits
0. It exits 1 only for a contract problem, such as a model provider outside
`--granted` or disk cleanup in a deleting mode. Inside the agent container, add
`--check-files` to also require the login files, the mounted plugins, the skill
pack and the 1Password mapping. That mode adds one `coding-clis.<cli>` line per
CLI; a login file is evidence of a login, not proof that it still works.

## Turning a default off for one agent

One line under `defaults:` in that agent's file. `agents/worker.yaml` turns
voice off and lists the line for every other default:

```yaml
defaults:
  voice: false
```

Opting out of `model-roles` hands model selection back to the agent's own
`values` (`model.provider`, `model.default`).
