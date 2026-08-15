- **claude-cli: bump the pinned Claude CLI to 2.1.233 (#4729)** — all three
  lockstep pins (`docker/Dockerfile.base`, `docker/Dockerfile.hindsight`,
  `dependencies.json`) move 2.1.229 → 2.1.233. Upstream never published
  2.1.230. The nightly `claude@latest` canary had not yet seen 2.1.233, so the
  flag contract was run manually against a real 2.1.233 binary instead; the
  behavioural check (manual DM + group round-trip) is still required before a
  fleet roll.
