- **memory: pin the hindsight shim's REST route contract to /openapi.json** —
  design-v2.md §2.5's engine version pin, previously "not built": the
  hindsight-mcp-shim's five synthesized tools (`deactivate_directive`,
  `reactivate_directive`, `search_knowledge_pages`, `get_knowledge_page`,
  `get_knowledge_tree`) are REST calls that `tools/list`'s existing contract
  check can never see move. The shim now fetches `/openapi.json` and, when a
  route is CONFIRMED missing, rejects that tool's call loudly before ever
  attempting the doomed REST request — consistent with the shim's existing
  anti-silent-drop guard. An unreachable/malformed spec degrades to
  "proceed" rather than blocking every synthesized tool on a flaky probe.
  `switchroom doctor` gains a matching contract probe: fail rows when a
  synthesized tool's route is missing, and a row comparing the live
  engine's declared version against the pin. Adversarial review: doctor now
  emits a `warn` row (not silence) when the engine is reachable but
  `/openapi.json` is not, and `ShimContractPin` gained a short negative/
  positive cache TTL so a permanently-missing (or later-restored) route no
  longer re-pays the fetch timeout on every synthesized call forever.
