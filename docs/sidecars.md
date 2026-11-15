# Public Fleet sidecar images

Hermes Fleet publishes sidecar images from this repository to GHCR. They are
not baked into the agent child image. Deployments pin an immutable digest.

## Packages

| Sidecar | Image | Status |
|---|---|---|
| REST lock-proxy | `ghcr.io/mekenthompson/hermes-fleet-rest-lock-proxy` | publishing |
| TCP / noVNC proxy | `ghcr.io/mekenthompson/hermes-fleet-tcp-proxy` | publishing |
| Browser broker | `ghcr.io/mekenthompson/hermes-fleet-browser-broker` | publishing |
| Kokoro | `ghcr.io/mekenthompson/hermes-fleet-kokoro` | publishing |
| Camofox | `ghcr.io/mekenthompson/hermes-fleet-camofox` | publishing |

Pin form:

```text
ghcr.io/mekenthompson/hermes-fleet-rest-lock-proxy@sha256:<64 lowercase hex>
```

`scripts/sidecar_image_ref.py` rejects tags and unprefixed legacy names.

## Layout

- `sidecars/packages.json` is the machine-readable package list. It is not
  copied into the Fleet child image, so sidecar-only changes do not rebuild
  `hermes-fleet-public`.
- Source lives under `sidecars/<sidecar>/`.
- Path-filtered workflows under `.github/workflows/sidecar-*.yml` bake only that
  sidecar directory and its workflow file. Shared catalog files
  (`sidecars/packages.json`, `scripts/sidecar_image_ref.py`,
  `tests/test_sidecar_packages.py`) are covered by source CI, not by image bakes.

## Starter overlay sidecars

`examples/overlay-repo/compose.sidecars.yaml` runs the sidecars the starter
defaults use. It lives in the overlay, not next to
`examples/compose.sidecars.example.yaml`, because it attaches the overlay's own
`ops` and `worker` agents to sidecar networks; the older example is a
standalone list of the published sidecars with no agents. Layer it over the overlay
compose file:

```bash
docker compose -f compose.yaml -f compose.sidecars.yaml config
docker compose -f compose.yaml -f compose.sidecars.yaml up -d
docker compose -f compose.yaml -f compose.sidecars.yaml --profile onepassword up -d
```

Isolation rules, enforced by `tests/test_starter_overlay_sidecars.py`:

- Each sidecar has its own `internal` network. Only the agents that use the
  sidecar join it; the worker opts out of voice, so it is not on the voice
  network.
- A sidecar that needs the internet gets a separate `*-egress` network that no
  agent joins: Kokoro to download model weights once, 1Password Connect to
  sync with 1Password.
- No host networking, privileged mode, Docker socket or published ports.
  Agents reach sidecars by service name.
- Every image is pinned by digest. Secrets come from files under `secrets/`,
  which the overlay's `.gitignore` keeps out of git.

| Sidecar | Image | Used by | Notes |
| --- | --- | --- | --- |
| `voice` | `ghcr.io/mekenthompson/hermes-fleet-kokoro` | `voice` default | CPU by default |
| `honcho`, `honcho-db` | upstream `ghcr.io/plastic-labs/honcho`, `pgvector/pgvector` | `honcho-memory` default | AGPL-3.0, not vendored |
| `onepassword-connect-api`, `onepassword-connect-sync` | `1password/connect-api`, `1password/connect-sync` | `secrets-connect` default | optional profile `onepassword` |

**Kokoro.** The CPU-only setting is the default: `VOICE_STT_DEVICE=cpu` with
`int8` compute. The image is built on a CUDA runtime, but transcription
follows `VOICE_STT_DEVICE` and speech falls back to CPU when no GPU is visible.
The GPU variant is optional: add `gpus: all` to the `voice` service and set
`VOICE_STT_DEVICE=cuda` and `VOICE_STT_COMPUTE_TYPE=float16`. Agents use
`HERMES_KOKORO_SIDECAR_URL=http://voice:8126` and the same token as the
sidecar's `VOICE_SIDECAR_TOKEN`.

**Honcho.** Switchroom references the upstream Honcho image by digest and never
vendors its source; Honcho is AGPL-3.0. Its summariser, deriver, dreaming and
embeddings call a language model. That model must come from a provider the
operator granted, or those features stay off. The starter grants none, so it
sets `SUMMARY_ENABLED`, `DERIVER_ENABLED`, `DREAM_ENABLED`, `PEER_CARD_ENABLED`
and `EMBED_MESSAGES` to `false`, sets no model key, and gives Honcho no egress
network. To turn one on, point it at a provider you granted, put that key in
`secrets/honcho.env` and attach an egress network. Agents use
`HONCHO_BASE_URL=http://honcho:8000`.

**1Password Connect.** Optional. Start it with `--profile onepassword` and put
the Connect server's `1password-credentials.json` under `secrets/`. Each agent
gets its own `OP_CONNECT_HOST=http://onepassword-connect-api:8080` and
`OP_CONNECT_TOKEN` in its env file. Without Connect, the same variables come
from the agent's env file directly. See the overlay README for the one-time
mapping step.

## Out of scope

Household compose, identities, secret names, and live digest pins stay in the
private deployment overlay. This tree ships generic images and synthetic
examples only. Browser-broker chrome reads `BRAND`, `LOCAL_TZ`, and a required
matching `PUBLIC_BASE`/`PUBLIC_ORIGIN` from the environment.

Kokoro is a CUDA runtime image; the starter overlay runs it on CPU. Model
weights are not baked into the image.

Camofox bakes pinned `jo-inc/camofox-browser` `v1.18.1` plus window, screen,
media, and Camoufox `152.0.4-beta.30` patches from `sidecars/camofox`. Overlay
entrypoints and secret loaders stay private.
