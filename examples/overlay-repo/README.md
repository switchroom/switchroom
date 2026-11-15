# Example overlay repository

Placeholder overlay for a Hermes Fleet deployment, and the Switchroom starter
overlay. Copy this directory into a new git repository. Replace image digests,
agent names, and config values. Do not copy secrets into git.

## Layout

```text
compose.yaml                 Digest-pinned Fleet child. No secrets.
fleet-config/schema.yaml     Allowlisted desired-state keys
fleet-config/defaults.yaml   Shared defaults and the starter defaults
fleet-config/agents/         One YAML file per agent
managed/                     Optional /etc/hermes/config.yaml mounts
```

## Config split

- `fleet-config/defaults.yaml` — every agent. No `profile:` key.
- `fleet-config/agents/*.yaml` — one file per agent. `profile:` matches the
  filename stem.
- `managed/*.yaml` — optional `/etc/hermes/config.yaml` mounts. Restart-gated.
- live `/opt/data/config.yaml` — not in this repo
- secrets — runtime injection only. Never git.

`fleet-config/` is overlay desired-state for a renderer. Compose does not mount
it. Set `HERMES_FLEET_IMAGE` to an immutable `@sha256:` reference before
`docker compose config`.

## Starter defaults

The bare Fleet image turns nothing on. This overlay turns on the reviewed
default set from `contracts/plugins.json` that is pure configuration:

| Default | Turned on by | Off when |
| --- | --- | --- |
| `doctrine-config` | ownership-and-judgement system prompt, smart approvals with cron, unattended and single-query runs denied, queue-first busy input, verify-on-stop | never |
| `gateway-per-agent` | `gateway.multiplex_profiles: false` | never |
| `claude-subscription-directsdk` | main model provider, no API-key fallback | `CLAUDE_CONFIG_DIR` unset |
| `claude-acp-connectors` | Claude ACP provider plus `claude-account-connectors` | `CLAUDE_CONFIG_DIR` unset |
| `model-roles` | main model then fallbacks, granted providers only | no granted provider has its login |
| `linear` | Linear plugin with a token file, bound to the app's user and workspace IDs ([Linear setup](../../docs/linear-setup.md) steps 4 and 5) | `LINEAR_TOKEN_FILE`, `LINEAR_VIEWER_ID` or `LINEAR_ORGANIZATION_ID` unset |
| `voice` | Kokoro voice replies and local transcription | `HERMES_KOKORO_SIDECAR_URL` or `HERMES_KOKORO_SIDECAR_TOKEN` unset |
| `honcho-memory` | `memory.provider: honcho` | `HONCHO_BASE_URL` unset |
| `web-search` | Perplexity search | `PERPLEXITY_API_KEY` unset |

A default whose variable is not set is rendered off, so the agent still
starts. `granted_providers` in `defaults.yaml` lists the model providers you
granted; the model chain uses nothing else. An agent file may narrow that
list, never widen it.

The other reviewed defaults (1Password Connect secrets, coding CLIs, quota,
session reset policy, security guidance, disk cleanup, the shared skill pack)
are not configured here yet, and the setup check says so.

## Quick start

From a checkout of this repository:

```bash
# 1. Copy the overlay into your own repository.
cp -r examples/overlay-repo ~/my-fleet-overlay

# 2. Write the agent's runtime env file outside git. Leave out any line you
#    do not have; that default turns itself off.
mkdir -p ~/my-fleet-overlay/secrets
cat > ~/my-fleet-overlay/secrets/ops.env <<'EOF'
CLAUDE_CONFIG_DIR=/opt/data/.claude
LINEAR_TOKEN_FILE=/opt/data/secrets/linear-token
LINEAR_VIEWER_ID=replace-with-viewer.id
LINEAR_ORGANIZATION_ID=replace-with-organization.id
HERMES_KOKORO_SIDECAR_URL=http://voice:8880
HERMES_KOKORO_SIDECAR_TOKEN=replace-me
HONCHO_BASE_URL=http://honcho:8000
PERPLEXITY_API_KEY=replace-me
EOF

# 3. Render the agent's managed config. --report prints one line per default.
python3 scripts/render-overlay-config.py \
  --fleet-config ~/my-fleet-overlay/fleet-config \
  --agent ops \
  --env-file ~/my-fleet-overlay/secrets/ops.env \
  --output ~/my-fleet-overlay/rendered/ops.yaml \
  --report

# 4. Run the setup check against the rendered config.
python3 scripts/switchroom-doctor.py \
  --config ~/my-fleet-overlay/rendered/ops.yaml \
  --env-file ~/my-fleet-overlay/secrets/ops.env \
  --no-process-env
```

The renderer and the setup check need PyYAML. They read only which variables
are set, never print a value, and write `${NAME}` references that Hermes
expands at start. `secrets/` is in `.gitignore`.

The setup check prints `<default>: on` or `<default>: off: <reason>` for every
default in the contract. Missing credentials are reported, not fatal: it exits
0. It exits 1 only for a contract problem, such as a model provider outside
`--granted`. Inside the agent container, add `--check-files` to also require
the Claude login and Linear token files themselves.

## Turning a default off for one agent

One line under `defaults:` in that agent's file. `agents/worker.yaml` turns
voice off and lists the line for every other default:

```yaml
defaults:
  voice: false
```

Opting out of `model-roles` hands model selection back to the agent's own
`values` (`model.provider`, `model.default`).
