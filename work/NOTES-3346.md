# Fix #3346 — Profile not found: default (searched /profiles)

## Root cause (verified in real source)
- `src/agents/profiles.ts:13` (and `src/setup/profile-picker.ts:104`) resolved
  `PROFILES_ROOT = resolve(import.meta.dirname, "../../profiles")`.
- npm/dev layout: bundle at `<pkg>/dist/cli/switchroom.js` → `../../profiles` =
  `<pkg>/profiles`. Works.
- Agent Docker image (`docker/Dockerfile.agent`): bundle COPYed to
  `/opt/switchroom/switchroom.js` → `../../profiles` = `/profiles`. The image
  ships NO `/profiles`, so in-container `rollout`/`apply` throws
  `Profile not found: default (searched /profiles)`.
- Cross-cutting: same const feeds getProfilePath / listAvailableProfiles /
  base + shared fragments and the picker — so it's not rollout-only.

## Options considered
- A. `--no-profiles` skip flag for pure version bumps — hack, only patches the
  rollout path, leaves scaffold/apply broken in-container. Rejected.
- B. Ship profiles in image only — works but leaves the resolver brittle
  (single hardcoded relative path).
- C. Layout-aware resolver + ship profiles in image (chosen). Durable: the
  resolver probes ordered candidates and an env override; the image ships
  profiles at a candidate path. Fixes every in-container consumer, not just
  rollout.

## Fix (single concern)
1. `resolveProfilesRoot()` in profiles.ts: `SWITCHROOM_PROFILES_ROOT` env
   override → `../../profiles` (npm/dev) → `./profiles` (image, bundle at
   /opt/switchroom) → first existing wins; falls back to npm-layout path so
   the error message stays meaningful. Exported + reused by profile-picker.ts
   (single source of truth).
2. `docker/Dockerfile.agent`: `COPY profiles /opt/switchroom/profiles`.

## Tests
- `src/agents/profiles.test.ts`: resolveProfilesRoot — env override wins;
  probes to an existing dir; never resolves to `/profiles` (exact regression).
- `tests/docker/dockerfile-agent-bakes.test.ts`: asserts the profiles COPY.
