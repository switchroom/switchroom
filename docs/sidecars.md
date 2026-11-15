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
  agent joins: the one-time Honcho tokenizer fetch, and 1Password Connect to
  sync with 1Password. The CPU voice server has its weights built in and gets
  none.
- No host networking, privileged mode or Docker socket. Agents reach sidecars
  by service name. The only published port is the Linear webhook receiver's,
  bound to `127.0.0.1` for your tunnel or reverse proxy; its network
  (`linear-receiver-ingress`) is not internal, because Docker publishes ports
  only from a non-internal network, and no agent joins it.
- Every image is pinned by digest. Secrets come from files under `secrets/`,
  which the overlay's `.gitignore` keeps out of git.

| Sidecar | Image | Used by | Notes |
| --- | --- | --- | --- |
| `voice` | upstream `ghcr.io/remsky/kokoro-fastapi-cpu` | `voice` default | CPU-only; Apache-2.0, not vendored |
| `honcho`, `honcho-db` | upstream `ghcr.io/plastic-labs/honcho`, `pgvector/pgvector` | `honcho-memory` default | AGPL-3.0, not vendored |
| `honcho-tiktoken` | the same Honcho image | `honcho-memory` default | one-time tokenizer fetch, then exits |
| `onepassword-connect-api`, `onepassword-connect-sync` | `1password/connect-api`, `1password/connect-sync` | `secrets-connect` default | optional profile `onepassword` |
| `linear-receiver`, `linear-inbox-init` | upstream `python` (Alpine), running `sidecars/linear-receiver/receiver.py` from the pinned Fleet checkout | assigning work from Linear | off until configured; see [Linear setup, Part 2](linear-setup.md#part-2-assign-from-linear) |

**Linear webhook receiver.** It accepts Linear's webhooks and files each
verified one in the agent's own inbox volume, which the agent mounts at the
Linear plugin's default `/opt/data/workspace/linear`. It runs as UID 1000 with
every capability dropped and a read-only root filesystem, holds no OAuth token
and never calls Linear. `linear-inbox-init` runs first, with no network and
only the chown capability, to hand each new inbox volume to UID 1000, then
exits. Without `LINEAR_RECEIVER_PUBLIC_URL` and a signing secret in
`secrets/linear-receiver.env` the receiver prints why it is off and exits.

**Kokoro.** The CPU default is the upstream CPU build of
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (`v0.10.0`,
Apache-2.0), `ghcr.io/remsky/kokoro-fastapi-cpu`, pinned by its multi-arch
index digest. It has no CUDA libraries, so nothing tries a GPU, and its model
weights are built into the image, so it runs with `DOWNLOAD_MODEL=false` and no
egress network. Agents use `HERMES_KOKORO_SIDECAR_URL=http://voice:8880/v1` (a
URL ending in `/v1` selects this server's OpenAI-compatible speech route in
the `kokoro-voice` plugin) and the same token the server lists in `API_KEYS`
(a JSON list in `secrets/voice.env`). This server only speaks. **The CPU
server has no transcription**: agents get Kokoro voice replies and voice notes
are not transcribed. The explicit `stt.provider: kokoro_sidecar` keeps Hermes
from falling back to a hosted transcription service, and the renderer and the
setup check refuse a voice-on config that names any other transcription
provider.

Voice turns on only when its sidecar is configured and answers. The renderer
asks the sidecar's health route (`/health` for a URL ending in `/v1`, else
`/healthz`, the same routes the `kokoro-voice` plugin reads) and keeps voice
text-only if it does not answer healthy. Only the agent's own network can see
the sidecar, so this check runs with `--check-files` inside the agent
container (quick start step 7). A render on the host leaves voice off with
`the voice sidecar was not checked`, the same way it treats the Claude logins.

The Fleet image `ghcr.io/mekenthompson/hermes-fleet-kokoro` is the GPU
variant, and the option for local transcription. It adds local
faster-whisper transcription and needs an NVIDIA GPU:
its speech engine loads the CUDA runtime at start and crashes without one.
To use it, replace the `voice` service image with its digest, add `gpus: all`
and `user: "65532:65532"`, set `VOICE_STT_DEVICE=cuda`,
`VOICE_STT_COMPUTE_TYPE=float16`, `VOICE_STT_PORT=8126` and
`VOICE_MODEL_CACHE=/models`, mount a model cache at `/models`, give it an
egress network no agent joins for the one-time weight download, and point the
agents at `HERMES_KOKORO_SIDECAR_URL=http://voice:8126` with the same token as
its `VOICE_SIDECAR_TOKEN`.

**Honcho.** Switchroom references the upstream Honcho image by digest and never
vendors its source; Honcho is AGPL-3.0. Its summariser, deriver, dreaming and
embeddings call a language model. That model must come from a provider the
operator granted, or those features stay off. The starter grants none, so it
sets `SUMMARY_ENABLED`, `DERIVER_ENABLED`, `DREAM_ENABLED`, `PEER_CARD_ENABLED`
and `EMBED_MESSAGES` to `false`, sets no model key, and gives Honcho no egress
network. To turn one on, point it at a provider you granted, put that key in
`secrets/honcho.env` and attach an egress network. Agents use
`HONCHO_BASE_URL=http://honcho:8000`.

Honcho loads the tiktoken `o200k_base` tokenizer when it starts, and tiktoken
downloads it unless it is cached. Honcho has no egress, so `honcho-tiktoken`
runs first: Honcho's own image and Python, stdlib only, on the
`honcho-tiktoken-egress` network, every capability dropped and a read-only
root filesystem. It fetches the file once into the `honcho-tiktoken` volume,
under the name tiktoken gives it (the SHA-1 of its URL), refuses any file
whose SHA-256 differs from the pin (tiktoken's own expected hash,
`446a9538...1a2d`), and exits. Honcho starts only after it succeeds, mounts the
volume read-only and reads it through `TIKTOKEN_CACHE_DIR`.

**1Password Connect.** Optional. Start it with `--profile onepassword` and put
the Connect server's `1password-credentials.json` under `secrets/`. Each agent
gets its own `OP_CONNECT_HOST=http://onepassword-connect-api:8080` and
`OP_CONNECT_TOKEN` in its env file. Without Connect, the same variables come
from the agent's env file directly. See the overlay README for the one-time
mapping step.

## Opt-in recipes

Browser handoff (Camofox plus a loopback VNC forwarder), gated A2A and
reviewed artifact publishing are not starter sidecars. Each is a fragment in
[`recipes/`](../recipes/) that you layer over the same overlay compose files,
under the same isolation rules. Without the fragment nothing changes.

## Out of scope

Household compose, identities, secret names, and live digest pins stay in the
private deployment overlay. This tree ships generic images and synthetic
examples only. Browser-broker chrome reads `BRAND`, `LOCAL_TZ`, and a required
matching `PUBLIC_BASE`/`PUBLIC_ORIGIN` from the environment.

The Fleet Kokoro image is a CUDA runtime image for GPU hosts; its model
weights are not baked in. The starter overlay's CPU voice server is the
upstream Kokoro-FastAPI CPU build instead.

Camofox bakes pinned `jo-inc/camofox-browser` `v1.18.1` plus window, screen,
media, and Camoufox `152.0.4-beta.30` patches from `sidecars/camofox`. Overlay
entrypoints and secret loaders stay private.
