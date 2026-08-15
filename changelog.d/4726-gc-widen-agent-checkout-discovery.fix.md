- **worktree gc: the sweeper looked in two directories nobody uses (#4726)** —
  The fleet root disk hit 85% full with **41 stale git checkouts** scattered
  across agent homes, and the existing sweeper caught almost none of them.
  `defaultTaskTreeRoots()` scanned exactly two subdirectories per agent —
  `home/work` and `home/workspace` — while the real litter sat at
  `<agent>/home/sr-4638`, `<agent>/home/tmp-build/switchroom`,
  `<agent>/home/.cache/sr-review`, `<agent>/.work4481/repo`,
  `<agent>/worktrees/<slug>` and `<agent>/scratchwork/switchroom`. The
  classifier was never broken; it was aimed at a convention nobody follows.
  `discoverAgentCheckouts()` now walks each agent's directory and hands `gc`
  every checkout it finds, wherever the agent put it. The walk is bounded by
  construction — depth 4 below the agent dir, a package-manager/build prune
  list, a 50 000-directory visit budget, symlinks never followed, and a hard
  stop at each checkout boundary so a tree's own `node_modules`, nested
  submodules and nested linked worktrees are never mistaken for independent
  trees. Measured on the reference fleet (37 agents, 52 GiB of agent homes):
  **1 450 `readdir` calls, 32 ms**, 77 checkouts found. Pass `--no-discover` for the old root-only behaviour;
  `home/work` and `home/workspace` coverage is unioned in and unchanged.
- **worktree gc: three new guards, because a wider net catches precious things (#4726)** —
  Widening WHERE gc looks relaxes nothing about WHAT it may reap, but it does
  put trees in front of the classifier that were previously out of reach, so
  the precious/disposable line is now drawn explicitly: an agent's own durable
  furniture (`<agent>/workspace`, `<agent>/home/workspace`, and the stable
  per-repo tree `<agent>/work/<slug>`) is never a candidate; a checkout parked
  on a **trunk** branch (`main`/`master`/`trunk`/`develop`) is a reference
  clone and is `skip-protected` without spending a `gh` call; and a
  **`.switchroom-keep`** marker file in any checkout protects it
  unconditionally. A repo whose `origin` is not switchroom's was, and remains,
  reported `not-ours` and left alone.
- **worktree gc: two quarantined trees with the same basename collided (#4726)** —
  The quarantine destination was `<trash>/<basename>`, which two agents could
  already produce for one dated trash dir (`home/work/switchroom` is not a
  unique name); widened discovery makes it routine — the incident layout alone
  carries three `switchroom` and two `repo` basenames. `mv` would have nested
  the second tree inside the first and lost which agent it came from.
  Destinations now disambiguate with a stable SHA-1 prefix of the source path.
