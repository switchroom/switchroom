- **memory: reflect cardinality guard in the hindsight shim (#4748)** —
  memory-redesign RFC P9. On the `reflect` `tools/call` path the
  hindsight-mcp-shim now returns an explicit "no relevant memories" answer
  instead of the engine's synthesized prose when the returned evidence set is
  genuinely empty, so an empty retrieval produces a machine-legible absence
  rather than a fluent-but-sourceless answer (the false-positive that defeats
  the abstention signal). The gate keys off the REAL returned evidence
  cardinality, not a heuristic: the shim forces `include_based_on:true` onto
  the forwarded call (the caller's explicit value still wins) and abstains only
  when `based_on` is present and totals zero across every bucket; when the
  evidence set cannot be seen the synthesized answer passes through unchanged,
  and on a non-empty result the injected evidence is stripped back out unless
  the caller asked for it. Shim-only — no engine, retain, or recall change.
