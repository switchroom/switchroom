# Phase 0 research — archived

This directory holds historical research artifacts from the Phase 0
docker identity-model spike (2026-05-08). They are **not** load-bearing
for the v0.7+ runtime — the production broker / kernel / compose
generator under `src/` and `docker/` superseded them.

Kept for traceability:

- `spike/` — throwaway Dockerfiles + compose + adversarial test scripts
  used to discover the path-derived peercred identity model. Findings
  written up in `../phase0-peercred-matrix.md` and
  `../phase0-findings.md`.

If you want to re-run the matrix on a new host (Mac, Windows), see the
"Pending-row methodology" section of `../phase0-peercred-matrix.md`.

Don't add new content here. New work belongs under `src/` + `tests/`.
