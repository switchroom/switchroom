# Overlay repository

Hermes Fleet is the public distribution. A separate **overlay repository** holds
deployment configuration: compose, fleet-wide Hermes defaults, per-agent
overrides, and unpublished binaries. That overlay is usually private.

This repository does not contain a real overlay. Copy
`examples/overlay-repo/` into a new git repo and replace the placeholders.

## Recommended layout

```text
your-fleet-overlay/
  compose.yaml                 Digest-pinned images. No secrets.
  compose.sidecars.yaml        Sidecars the starter defaults use (docs/sidecars.md)
  vendor.lock.json             Exact commits for mounted plugins and the skill pack
  fleet-config/
    schema.yaml                Allowlisted desired-state keys
    defaults.yaml              Shared defaults (every agent)
    agents/
      ops.yaml                 Per-agent overrides
      worker.yaml
  managed/
    ops.yaml                   Optional /etc/hermes/config.yaml mount
  image/                       Optional unpublished binaries + hashed manifest
  secrets/                     Not in git. Runtime injection only.
```

Sidecar *source* stays in hermes-fleet. The overlay pins sidecar *images* by
digest and supplies brand, timezone, and public URL skins as environment.

## Hermes config layers

`contracts/config.json` is the machine-readable split:

| Layer | Owner | Typical path | Notes |
| --- | --- | --- | --- |
| Image | public product | the Fleet child | Immutable. No profile identity. |
| Desired state | overlay repo | `fleet-config/` | Shared defaults, then role, then profile. |
| Managed policy | administrator | `/etc/hermes/config.yaml` | Small restart-gated policy. Not a secret boundary. |
| Temporary override | operator | not git | Expiring, audited. |
| Live profile | the agent | `/opt/data/config.yaml` | Exclusive profile state after first boot. |
| Secrets | external source | runtime injection | Never git, never image, never managed YAML. |

Desired-state precedence in that contract is `shared` → `role` → `profile` →
`temporary_override`. In this overlay sample:

- `fleet-config/defaults.yaml` is **shared**. Do not set `profile:`. `{profile}`
  in a string is replaced with the agent name at render time.
- `fleet-config/agents/<profile>.yaml` is **profile**. `profile:` must match the
  filename stem. Keys must be in `schema.yaml`.
- `managed/*.yaml` is the optional **managed** mount, not desired-state.

`fleet-config/` is renderer input in the overlay repo. Compose does not mount
it. Compose only shows the optional managed policy file.

`scripts/render-overlay-config.py` renders one agent from `fleet-config/`:
shared values, then the reviewed starter defaults, then the agent's own
values, each leaf allowlisted and type-checked against `schema.yaml`. A
default whose credential variable is unset is rendered off.
`scripts/switchroom-doctor.py` reports every default as on or off with the
reason. Steps are in `examples/overlay-repo/README.md`. Which subscription
plan leads each task role is in [Choose your plans](choose-your-plans.md).

Do not put credentials, OAuth state, memories, or sessions in the overlay git
tree. Secret values fail closed: never git, never image, never managed YAML.
Pin images by `@sha256:...`. Mutable tags are not a supported interface.

## Unpublished binaries

If a local CLI is not a public product yet, keep the hashed binary in the
overlay. Record it in a manifest, COPY it, and `sha256sum -c` during the
overlay image or foundation build. Do not vendor it into hermes-fleet.

## What the public repo is for

- Fleet child image and its plugins
- Independent sidecar source and GHCR workflows
- Contracts and examples

## What the overlay repo is for

- Who the agents are
- Compose topology
- Fleet-wide and per-agent Hermes defaults
- Digest pins for this deployment
- Private binaries and deployment overlays
