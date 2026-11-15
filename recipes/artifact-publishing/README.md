# Recipe: reviewed artifact publishing

Opt-in. Lets an agent (`ops` in the starter overlay) publish a finished file,
such as a report or a page, but only after a person has reviewed it, and only
while it is still exactly the file they reviewed.

Nothing changes for an agent, or a deployment, that does not layer
[`compose.artifact-publishing.yaml`](compose.artifact-publishing.yaml): no
outbox is mounted, no origin runs and no port is published.

## How it works

```text
agent ── writes ──▶ artifacts/outbox/ops/report.html
person ── reviews, then review_artifact.py approve ──▶ artifacts/review/reviewed.json
artifact-origin ── serves ──▶ 127.0.0.1:8647/artifact/<uuid>/ ──▶ your tunnel or reverse proxy
```

- The agent mounts its outbox read-write at `/opt/data/workspace/outbox`. It
  never mounts `artifacts/review/`, so it cannot approve its own work.
- [`review_artifact.py`](review_artifact.py), run by the reviewer on the
  host, records the file's SHA-256 and size under a fresh UUID.
- [`origin_proxy.py`](origin_proxy.py) serves `GET` or `HEAD
  /artifact/<uuid>/` only for a reviewed UUID, and only while the file still
  has the reviewed SHA-256 and size. A file changed after review is refused
  with `409`. An unreviewed UUID or any other path is `404`. Query strings,
  credentials, cookies, request bodies, percent-encoding and absolute URLs
  are refused. It re-reads the manifest on every request, so approval and
  withdrawal take effect at once.
- The origin is the pinned Python image running the script from the pinned
  Fleet checkout in `vendor/`. It runs as `nobody`, with a read-only root, no
  capabilities and its mounts read-only. It joins only `artifact-ingress`,
  which no agent joins, so agents cannot reach it.
- The one published port is on `127.0.0.1`. `artifact-ingress` is not
  internal only because Docker publishes ports from non-internal networks.

Responses carry `X-Artifact-SHA256`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`,
so a reviewed HTML page cannot run script on your origin.

## Turn it on

From the overlay directory, once:

```bash
install -d -m 0755 artifacts artifacts/review
install -d -m 0755 -o 1000 -g 1000 artifacts/outbox/ops
printf '{"schema_version": 1, "artifacts": {}}\n' > artifacts/review/reviewed.json

docker compose -f compose.yaml -f compose.sidecars.yaml \
  -f vendor/hermes-fleet/recipes/artifact-publishing/compose.artifact-publishing.yaml config -q
docker compose -f compose.yaml -f compose.sidecars.yaml \
  -f vendor/hermes-fleet/recipes/artifact-publishing/compose.artifact-publishing.yaml up -d
```

Keep `artifacts/` out of git. Point your tunnel or reverse proxy at
`127.0.0.1:8647` (`ARTIFACT_ORIGIN_PORT` changes the host port) and pass
`/artifact/` through unchanged.

## Publish one file

```bash
R=vendor/hermes-fleet/recipes/artifact-publishing
# Read the file first. Then:
python3 $R/review_artifact.py approve --outbox artifacts/outbox/ops \
  --manifest artifacts/review/reviewed.json report.html
# -> /artifact/<uuid>/

# Prove the public URL serves exactly those bytes (no redirects, no login page):
python3 $R/verify_artifact.py --url https://<your-origin>/artifact/<uuid>/ \
  --expected-file artifacts/outbox/ops/report.html

# Take it down:
python3 $R/review_artifact.py withdraw --manifest artifacts/review/reviewed.json <uuid>
```

A successful `approve` or an HTTP 2xx is not delivery. `verify_artifact.py`
is: it requires an exact `200` and a byte-for-byte SHA-256 match.

## Turn it off

Drop the `-f …compose.artifact-publishing.yaml` file and run `up -d` again,
then `docker compose … rm -sf artifact-origin`. The outbox and manifest stay
on disk until you remove them.

## Proof

[docs/opt-in-recipes-acceptance.md](../../docs/opt-in-recipes-acceptance.md#artifact-publishing)
records the synthetic run and what it did not prove.
