# Recommendation: Escalation E1 — contract-vision:c2 (hostd deep probe `claude -p`)

**Recommended option:** B
**Confidence:** high

## Why

The `deep` branch of the `agent_smoke` handler in
`src/host-control/server.ts:1574-1578` pushes a probe that runs
`timeout 25 claude -p ok >/dev/null 2>&1` via `docker exec` inside the
target agent container. This is a live inference call — not a static
file check — and it fires under the operator's OAuth credentials.
`reference/vision.md:86-90` is explicit: headless `claude -p` counts as
programmatic usage under the 2026-06-15 Anthropic policy, off the
subscription. `CLAUDE.md` "Hard constraint" section calls this a
compliance boundary, not a preference. The finding is acknowledged in
`tests/bridge-flap-regression-guard.test.ts:171-178` under
`KNOWN_TEMPLATE_GAPS` with tracking issue #1798, but the callsite has
not moved.

The constraint violation here is not purely theoretical. The `deep` flag
is an optional boolean in `AgentSmokeRequestSchema`
(`src/host-control/protocol.ts:246`) and the protocol comment at line
235 already flags it as "quota-costing." Any caller — a developer
crafting a raw hostd request, a future CLI `--deep` flag, or an
automated health dashboard — can trigger a billed inference call with
no visible warning at the call site.

Option B is correct because the probe's stated purpose is auth liveness:
confirming the agent's OAuth token can actually reach Anthropic. That
check does not require a round-trip inference call. The auth-broker
already holds the token and can perform a lightweight token-introspect
without spawning `claude`. Alternatively, the five static probes already
in the `PROBES` array (`auth`, `scheduler`, `mcp`, `bot_token`, `state`)
cover credential presence and service health without any model call.
Adding a sixth probe that calls `curl`-style against the token-introspect
endpoint on the auth-broker UDS socket, or checks `claude --version` for
CLI reachability, closes the liveness gap at zero subscription cost.

Option A (remove `deep` entirely) is also defensible: the `doctor-agent-smoke.ts`
caller at `src/cli/doctor-agent-smoke.ts:83-84` does not pass
`deep: true`, meaning no production codepath currently exercises the
`claude -p` branch. Removing the branch eliminates the violation with
no operator-visible regression.

## Tradeoffs of the recommendation

- Option B requires implementing a replacement check. The auth-broker
  already exposes a socket per-agent; a token-presence or token-expiry
  check via that socket is the right primitive. Cost: ~15 agent-minutes
  to add the probe, update the protocol comment, and delete the
  `KNOWN_TEMPLATE_GAPS` entry.
- The `KNOWN_TEMPLATE_GAPS` entry in `bridge-flap-regression-guard.test.ts`
  must be removed as part of the same PR. The test enforces shrink-only
  semantics; leaving a resolved entry is misleading.
- If Option A is chosen instead, the protocol field `deep` should also be
  removed from `AgentSmokeRequestSchema` so a future caller cannot
  re-introduce the pattern without a schema change as friction.

## If you pick a different option

- **Option A (remove the deep probe entirely):** Lower effort (~8
  agent-minutes). Correct if the operator judges that credential-presence
  (the static `auth` probe) is sufficient liveness signal and no one needs
  a live round-trip confirmation. Risk: if auth-liveness is ever wanted
  again, a future contributor re-adds `claude -p` as the obvious solution.
  Removing the schema field as well mitigates that risk.
- **Option C (gate behind opt-in env var):** Does not resolve the
  compliance violation — it only makes it harder to trigger accidentally.
  The vision's prohibition is not about default-on vs. opt-in; it is about
  whether programmatic usage occurs at all. A "tester-only" label does
  not change the billing classification.
- **Option D (carve-out in vision.md for health probes):** Creates a
  precedent that inference calls are acceptable when framed as
  infrastructure rather than product. The thin-end-of-the-wedge risk is
  real: future contributors will cite the health-probe carve-out to justify
  other "lightweight" model calls. The constraint's value is its
  absoluteness. Do not dilute it.

## Open question for the operator

The `deep` probe was added to give the doctor a live auth-round-trip
signal that static credential-file presence cannot provide. Is that
signal actually needed in the operator workflow — e.g., is there a
scenario where `.credentials.json` is present but the token is expired
or revoked and you need the doctor to surface that — or is the static
`auth` probe sufficient for the intended use?

The answer determines whether Option B (replace with token-introspect
via auth-broker) or Option A (remove entirely) is the right call.
Effort difference: ~8 vs ~15 agent-minutes.
