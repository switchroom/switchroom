- **memory: Memory v2 M3 (Surface-A) — per-agent directive-injection flip (#4766)**
  Adds a `memory.inject_directives` flag (default true). Flipped off, the
  recall hook stops injecting the always-on `<active_directives>` block once
  the agent's CLAUDE.md rules block carries the same guardrails — suppressing
  at all three emit surfaces, gated deterministically on the 6144-byte
  rules-block budget, and failing safe (keeps injecting + a degraded-canary
  notice) if a rules block is missing. `switchroom doctor` gains an M3
  cross-check. Per-agent, default-off fleet-wide; ziggy is the designated
  canary.
