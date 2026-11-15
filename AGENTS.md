# AGENTS.md

Instructions for humans and coding agents working in `mekenthompson/hermes-fleet`.

This is the **public** Hermes Fleet distribution. It owns generic implementation, the opinionated Fleet child image, independent sidecar source, and public GHCR publication. Deployment overlays, identities, and private binaries live elsewhere.

Product decisions live in [`reference/`](reference/). Read that before changing behaviour that operators will feel.

## Product contract

A change ships only when **all** hold:

1. It advances a named vision outcome in `reference/vision.md` / `reference/product-spec.md`.
2. It satisfies its Job Spec, proven by that job's outcome UAT.
3. It passes every principle check in `reference/principles.md`.
4. It crosses no invariant in `reference/invariants.md`.

Else: out of scope, however clever.

Humans own the vision, principles, invariants, and ratifying the job statement. Agents consume those anchors; they never author them.

Review is a **separate fresh-process reviewer**, never the author. Unit-green, outcome UAT, and production-readiness are three gates. None implies the others. **Built, published, and deployed are different claims.**

Do not add ledgers, dashboards, confidence scores, or standalone formulation documents. Record assumptions and findings inside the spec, RFC, or post-launch review.

Do not change policy merely to make documentation agree with code. Reconcile the explanation with the intended policy.

Ceremony matches user-visible change. Not every patch is a launch. Lighter evidence does not mean optional invariants.

## Hard rules

- Pin images by immutable digest. Never teach people to run mutable tags.
- Do not add credentials, vault URIs, OAuth state, sessions, memories, logs, or live topology.
- Do not add household names, private hostnames, or real profile identities.
- Do not vendor private binaries or unpublished local CLIs. Private binaries belong in the private overlay repository, with a hashed manifest and a COPY+sha256sum install.
- Do not enable anything by default outside the reviewed default set in `contracts/plugins.json` and `reference/rfcs/default-on-distribution.md`. A default must degrade cleanly when its credential is missing, never block an agent from starting, and add no model or paid path the principal did not grant. Mark a default `shipped` only when the starter overlay actually enables it.
- Do not treat a green unittest run as publication approval. Image publication still requires the Fleet image workflow.
- Do not bounce, start, or pin live household services from this repository.

## Layout

```text
Dockerfile                 Fleet child only
compose.example.yaml       Synthetic example, not a production baseline
contracts/                 Public product boundaries
docs/                      Human docs for public behavior
examples/overlay-repo/     Placeholder overlay repository
plugins/                   Mounted plugin source; off in the bare image, reviewed defaults via the overlay
release/                   Pinned Agent parent handoff
scripts/                   Build, compose, and verification wrappers
sidecars/                  Independent sidecar source and image workflows
tests/                     Public product and sidecar tests
reference/                 ProductOS: vision, principles, invariants, product spec, jobs
```

There is no `sidecars/` copy in the private overlay, and no private compose in this tree.

## Tests you must run

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/verify-public-tree.py
```

If you change the Dockerfile or anything it copies, also expect `.github/workflows/fleet-image.yml` to bake. Keep `scripts/fleet-image-change-scope.py` in sync with every `COPY` source.

## Pull requests

- Small, one topic. Rebase onto current `main`.
- Independent review before merge. Reviewers are read-only.
- Public repo merges with rebase. Do not force-push `main`.
- Do not add reviewers, do not merge on failed CI, do not publish from a PR.

## Image changes

The child must keep:

- Digest-pinned Agent parent
- `USER 1000:1000` after rebinding `hermes`
- Inherited Agent entrypoint and command
- No Docker socket, no host network, no privileged mode

If you add a tool, pin it (version + sha256 or lockfile) and prove it in `fleet-image.yml` on both preflight and publish.

## Docs

Update `README.md` when the public product shape changes. Keep this file honest about the public/private split. Overlay layout and Hermes config layers: `docs/overlay-repository.md` and `examples/overlay-repo/`. Product scope and jobs live in `reference/`. `SECURITY.md` is the vulnerability path.
