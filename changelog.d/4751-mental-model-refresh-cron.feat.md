- **memory: scheduled stale mental-model refresh cron (#4751)** —
  memory-redesign RFC P10. Mental models are hindsight's only synthesis layer
  and nothing refreshed them unattended (the doctor WARNs at `>7d since
  refresh` but cannot fix). New model-free host verb `switchroom
  mental-model-refresh`, armed via `/etc/cron.d` (`--install-cron`, mirroring
  the `hindsight-watch` pattern: `flock -n`, pre-created log, logrotate,
  reconcile-on-`update`), runs off-peak and daily. Per tick it lists each
  bank's models, selects only those past the staleness interval (default 7d,
  `--stale-days`) using the same `staleMentalModels` selector the doctor
  reports, and refreshes each via one `refresh_mental_model` MCP `tools/call`
  over `/mcp/` — one bank at a time. NOT a `switchroom.yaml` `schedule:` entry
  (the `action` engine is egress-only and cannot reach the loopback `/mcp/`; a
  `prompt` entry would wake a model for deterministic work) and NOT
  `trigger.refresh_cron` (not on the MCP surface). Zero model tokens. Never
  throws; exits `1` only when every bank fails inspection (engine
  unreachable) — individual per-model refresh failures are logged, not fatal.
