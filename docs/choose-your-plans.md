# Choose your plans

Switchroom runs your agents on the AI subscriptions you already pay for. The
starter overlay knows three plans:

| Plan | Hermes provider | Login, inside the agent container |
| --- | --- | --- |
| `claude` | `claude-subscription-directsdk-experimental` and `claude-acp` | Claude Code login in `CLAUDE_CONFIG_DIR` (`claude login`) |
| `chatgpt` | `openai-codex` | `hermes auth add openai-codex --type oauth` |
| `grok` | `xai-oauth` (SuperGrok) | `hermes auth add xai-oauth --type oauth` |

`hermes model` and picking the plan does the same login. Hermes keeps the
ChatGPT and SuperGrok logins in its own `auth.json` under `HERMES_HOME`.

A plan is used only when **both** hold:

1. its provider is in `granted_providers` in `fleet-config/defaults.yaml`
   (an agent file may narrow that list, never widen it), and
2. its login really exists inside that agent's container. The renderer and
   the setup check look with `--check-files`; on the host, without it, a
   plan stays off.

A plan without both is left out of every role. Nothing is half on, and there
is no API-key fallback: an API key stored for `openai-codex` or `xai-oauth`
is never counted as a plan login, and the setup check warns if one sits
next to a plan login, because Hermes could bill that key instead.

## Switch the lead plan

The lead plan picks the main chat model. One line in
`fleet-config/defaults.yaml`, under `model-roles`:

```yaml
    primary_plan: chatgpt   # claude, chatgpt or grok
```

or for one agent only, one line in `fleet-config/agents/<name>.yaml`:

```yaml
primary_plan: grok
```

This changes the main model only. Every other role keeps its own plan.

## Route each task to a plan

Each task role has its own lead plan:

| Role | What it drives in Hermes |
| --- | --- |
| `main` | the chat model (`model`, `fallback_providers`); follows `primary_plan` |
| `coding` | delegated subagents (`delegation`) |
| `fast` | titles, profile blurbs and group-chat routing (`auxiliary.title_generation`, `profile_describer`, `group_router`) |
| `approvals` | the smart-approval classifier (`auxiliary.approval`) |
| `compression` | context compression (`auxiliary.compression`) |

Set them under `model-roles.roles` in `defaults.yaml`, or override some for
one agent:

```yaml
# fleet-config/agents/<name>.yaml
roles:
  coding: chatgpt
  approvals: grok
```

Each plan's model for each role is listed under `model-roles.plans` in
`defaults.yaml`. A plan may only list its own providers, so a ChatGPT role
can never reach a Claude or xAI API account. When a lab ships a better model,
change that one line.

## Fallbacks

A role uses its lead plan's models first, then the models of the other plans
in the order `plans` lists them, skipping every plan that is not granted or
not logged in. With only one plan logged in, every role uses that plan and
has no cross-plan fallback.

## Check what is on

```bash
python3 scripts/switchroom-doctor.py --config <rendered>.yaml --env-file <agent>.env --check-files
```

prints, after the `model-roles` line, one line per plan and per role:

```text
model-roles: on
model-roles.plan.claude: on
model-roles.plan.chatgpt: on
model-roles.plan.grok: off: no SuperGrok login in /opt/data/auth.json; run hermes auth add xai-oauth --type oauth inside the agent container
model-roles.main: on: chatgpt openai-codex/gpt-6-sol, then claude claude-subscription-directsdk-experimental/opus, then claude claude-acp/sonnet
model-roles.coding: on: claude claude-subscription-directsdk-experimental/opus, then claude claude-acp/sonnet, then chatgpt openai-codex/gpt-6-sol
...
```

`render-overlay-config.py --report` prints the same lines. Re-render after
logging a plan in or out; until then the setup check reports a role whose
plan lost its login as off.

To turn model routing off for one agent and choose its models yourself, set
`model-roles: false` under `defaults:` in that agent's file, then set
`model.provider` and `model.default` in its `values`.
