- **worktree gc: stop swallowing git stderr, and handle cross-uid ownership (#4722)** —
  GC ran every git probe with stderr discarded, so a git *failure* and a git
  *negative answer* were the same value. Combined with `fatal: detected dubious
  ownership` on per-agent trees (owned by each agent's uid, inspected by the
  operator's), every probe failed and every unreadable tree was silently
  misfiled as "not a switchroom dir" — a live host reported `Ignored
  non-switchroom dirs: 67` and classified 2 trees. Git is now invoked with a
  **scoped** `safe.directory` exception (plus `core.fsmonitor=false` and
  `core.hooksPath=/dev/null`, without which the ownership bypass would let an
  agent-writable `.git/config` execute code as the invoking user), and a failed
  probe is now reported separately as `Unreadable dirs — git probe failed,
  kept`, never as a negative result. Same host after: 53 trees classified, 12
  ignored, 4 genuinely-broken dirs surfaced with their real git errors — and
  nothing newly eligible to be acted on.
