- **hindsight: floor MCP recall's `max_tokens` and mark trimmed payloads loud (#4755)**
  A too-small `max_tokens` could crater `recall`'s tail-trim loop to a
  silent, structurally-valid `{"results": []}` — indistinguishable from
  "nothing matched" (E-86). `max_tokens` is now floored at 256, and any
  payload the trim loop actually shortens is stamped
  `truncated: true` / `dropped_count: N`.
