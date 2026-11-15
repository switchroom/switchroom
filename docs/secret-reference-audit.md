# 1Password secret-reference audit

Each agent should read only its own secrets. With 1Password, an agent's
`config.yaml` maps environment variables to secret references (vault, item,
field), and a reference to another agent's vault is easy to copy by mistake.
`scripts/switchroom-secret-reference-audit.py` checks a declared map of who may
read what, and optionally each agent's live mapping against it.

**It never resolves a reference and never prints a value.** It does not run
`op`, opens no network connection and reads no secret store. Findings name the
agent, the variable and the vault, nothing else. A literal value pasted into a
config is reported by variable name only.

**Status:** proven by unit tests (`tests/test_secret_reference_audit.py`) on a
synthetic map with one deliberate cross-agent violation, with a stand-in `op`
binary on `PATH` that would record any call.

## The secret-reference map

A JSON file in your overlay repository. It holds names only. Schema:
[`examples/overlay-repo/ops-kit/secret-reference-map.schema.json`](../examples/overlay-repo/ops-kit/secret-reference-map.schema.json).
Synthetic example:
[`examples/overlay-repo/ops-kit/secret-reference-map.json`](../examples/overlay-repo/ops-kit/secret-reference-map.json).

```json
{
  "schema": "switchroom-secret-references/1",
  "agents": {
    "ops": {
      "vaults": ["example-ops"],
      "references": {
        "PERPLEXITY_API_KEY": {"vault": "example-ops", "item": "perplexity", "field": "credential"},
        "HERMES_KOKORO_SIDECAR_TOKEN": {"vault": "example-shared", "item": "voice-sidecar", "field": "token"}
      }
    },
    "worker": {
      "vaults": ["example-worker"],
      "references": {
        "PERPLEXITY_API_KEY": {"vault": "example-worker", "item": "perplexity", "field": "credential"},
        "HERMES_KOKORO_SIDECAR_TOKEN": {"vault": "example-shared", "item": "voice-sidecar", "field": "token"}
      }
    }
  },
  "shared": [
    {"vault": "example-shared", "item": "voice-sidecar", "readers": ["ops", "worker"],
     "reason": "one voice sidecar serves both agents"}
  ]
}
```

- `agents.<name>.vaults`: the vaults that agent owns. No two agents may own
  the same vault. Give each agent its own vault and its own Connect token
  scoped to it.
- `agents.<name>.references`: each environment variable and the vault item
  (`vault`, `item`, optional `section`, `field`) that fills it.
- `shared`: an item more than one agent genuinely needs, named once with
  every reader. Anything not listed here is private to its owner.

## Findings

| Kind | Meaning |
| --- | --- |
| `cross-agent` | An agent reads from a vault another agent owns, and the item is not shared with it. |
| `unowned-vault` | An agent reads from a vault no agent owns and nothing shares. |
| `vault-owned-twice` | Two agents claim the same vault. |
| `literal-value` | A config maps a variable to something that is not a secret reference. Likely a pasted secret: move it into the vault. |
| `unmapped` | A config maps a variable the map does not list for that agent. |
| `mismatch` | A config maps a variable to a different item than the map says. |
| `missing` | The map lists a variable the config does not map. |

## Run it

```bash
# The map on its own: who may read what.
python3 scripts/switchroom-secret-reference-audit.py --map secret-reference-map.json

# Also compare each agent's own Hermes config (where `hermes secrets onepassword set` writes).
python3 scripts/switchroom-secret-reference-audit.py --map secret-reference-map.json \
  --agent-config ops=/path/to/ops/config.yaml \
  --agent-config worker=/path/to/worker/config.yaml
```

Exit `0` no findings, `1` findings, `2` a map or usage error. Output is one
JSON object with `status`, `findings` and `resolved_values: 0`.

Reading `config.yaml` needs PyYAML or `ruamel.yaml` (the Hermes image ships
`ruamel.yaml`), so run the comparison inside the agent container or on a host
that has one; the map check needs only the standard library. Hermes reads
`secrets.onepassword` only from the agent's own `config.yaml`, never from the
managed file the starter overlay renders, so that is the file to compare.

## Turn it on

It is off by default: nothing runs it. Copy the example map into your overlay,
replace the names with yours, and run the audit by hand, in your overlay's CI,
or from cron. The map holds no values, so it can live in git.

## What it does not do

- It does not prove a reference works or that a vault's access policy matches
  the map. Use 1Password's own access controls for that; this checks that the
  configuration you wrote stays inside the lines you drew.
- It does not read env files or tokens.
