- **agent caches move off the root disk onto a bulk scratch volume (#4723)** —
  Every agent's package caches lived under its HOME on the operator's root
  disk (`~/.cache/uv`, `~/.npm`, `~/.bun/install/cache`, `~/.cache/puppeteer`,
  `~/.cache/ms-playwright`, `~/.local/lib`). On the reference fleet that
  reached ~20 GiB and pushed the root filesystem to 85% full; a manual sweep
  reclaimed 32 GiB and the caches regrew within hours. Every agent now gets a
  per-agent directory on the host's bulk device bind-mounted read-write at
  `/scratch`, plus the env redirects that make the package managers actually
  write there (`XDG_CACHE_HOME`, `TMPDIR`, `npm_config_cache`,
  `BUN_INSTALL_CACHE_DIR`, `PYTHONUSERBASE`, `PLAYWRIGHT_BROWSERS_PATH`,
  `PUPPETEER_CACHE_DIR`, and `SWITCHROOM_AGENT_SCRATCH` as the discovery
  contract). The last two are not covered by `XDG_CACHE_HOME` — playwright's
  path is baked into `Dockerfile.agent` at a HOME location and puppeteer reads
  `os.homedir()` directly, so an umbrella redirect alone would have left both
  on the root disk. Configure with `scratch: {enabled, volume, subdir}`;
  `volume` defaults to `/mnt/bulkdata` and must already exist, so a
  single-disk machine gets a hard no-op with byte-identical compose output.
  The mount is **framework-injected** for every agent rather than routed
  through `bind_mounts:` — that key is an admin-only escalation (#1164) and
  the biggest cache consumers on a real fleet are ordinary non-admin agents.
  Directories are pre-created and chowned to each agent's deterministic
  container uid at apply time, so the read-only-rootfs non-root container can
  actually write to them. One behaviour change: `PYTHONUSERBASE` moves
  python's user-site, so packages installed with `pip install` before the
  cutover need reinstalling once.
