- **worktree reaper: a process working inside a checkout counted as "free" (#4724)** —
  The in-use probe answered with `fuser <path>` / `lsof -t <path>`, both of
  which match the path **exactly**. A process whose cwd was a nested
  subdirectory of a worktree — i.e. an agent actually working in the checkout —
  was invisible to it, so the probe returned `free` for a live tree. `free` is
  precisely what clears the reaper's third fail-safe ("an in-use probe can
  DEFINITIVELY report the path as free"), so anything automating this would have
  `git worktree remove --force`d live work; the same probe is the idle guard for
  the task-tree sweep. The probe now walks procfs: a process holds the tree when
  its **cwd is the root or any directory beneath it**, or when an open **fd**
  resolves inside it. Because these verbs run host-side while the holders are
  usually processes inside agent containers (same directory, different path),
  the cwd test also walks `/proc/<pid>/cwd/..` upward comparing `(dev, ino)`,
  which the kernel resolves in *our* namespace. A sweep that could not inspect
  every process now reports `unavailable` (⇒ keep) rather than `free`; `lsof` is
  invoked with `+D` and `fuser` retained as a positive-only signal.
- **New `switchroom worktree reap-report` — report-only, deletes nothing (#4724)** —
  Runs both classifiers on a schedule and prints what they *would* reclaim,
  grouped per agent against a size budget (`--budget-gb`, default 5 GB, or
  `SWITCHROOM_AGENT_TREE_BUDGET_GB`) and ordered oldest-first — the eviction
  order a budget-driven reaper would use (RFC `agent-home-lifecycle.md` §2).
  Only trees that already clear every safety guard are ever marked over-budget;
  when the guards keep an agent over, the report says how much stays over rather
  than widening eligibility. The safety default is structural, not a flag: the
  module composes only plan-only predicates and imports no removal primitive,
  and the verb has no `--yes`. Deleting remains the separate, explicit
  `worktree gc --yes` / `worktree reap`.
