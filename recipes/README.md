# Opt-in recipes

Three pieces stay out of the reviewed default set because each reaches
outside an agent's own box: a browser a person can take over, another agent's
trust, and a publication target
([decision record](../reference/rfcs/default-on-distribution.md#opt-in-not-default)).
Each is a Compose fragment you layer over the starter overlay
(`examples/overlay-repo/`). Without the fragment nothing changes.

| Recipe | Fragment | Adds |
| --- | --- | --- |
| [Browser handoff](browser-handoff/) | `compose.browser-handoff.yaml` | a Camofox browser for one agent, VNC takeover on loopback |
| [Gated A2A](a2a/) | `compose.a2a.yaml` | A2A between allowlisted agents on an internal network |
| [Artifact publishing](artifact-publishing/) | `compose.artifact-publishing.yaml` | a read-only origin that serves only reviewed files |

Layer one or more, from the overlay directory:

```bash
docker compose -f compose.yaml -f compose.sidecars.yaml \
  -f vendor/hermes-fleet/recipes/a2a/compose.a2a.yaml config -q
```

`vendor/hermes-fleet` is the Fleet checkout `scripts/fetch-overlay-vendor.py`
pins to the image's own revision, so the recipe matches the image you run.

Every recipe follows the same rules as the starter sidecars
([docs/sidecars.md](../docs/sidecars.md)): images pinned by digest, internal
networks joined only by the agents that opt in, no host networking,
privileged mode or Docker socket, published ports on `127.0.0.1` only, and
secrets in `secrets/` env files. `tests/test_recipes.py` enforces them.

The synthetic acceptance run for all three is recorded in
[docs/opt-in-recipes-acceptance.md](../docs/opt-in-recipes-acceptance.md).
