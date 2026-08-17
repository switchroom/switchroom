- **hindsight: M4 async recall-prefetch buffer + delta-retain fix, dark-by-default (#4756)**

  Lands the M4 6a hardening pass for the memory-v2 async prefetch mechanism:
  a producer/consumer buffer that lets `retain.py`'s Stop hook kick off a
  recall prefetch for the next turn instead of paying the recall latency
  synchronously, plus a fix to the delta-retain path it shares. The entire
  mechanism is internal-only and gated end-to-end behind
  `memoryPrefetchEnabled`, which defaults to off — with the flag unset (the
  fleet default for every agent today), `retain.py` and `recall.py` take the
  exact code paths they did before this PR, and `prefetch.py` is a hard
  no-op. No agent-visible behavior changes at the default flag value; this
  fragment exists to satisfy the changelog gate ahead of a separate,
  tracked pre-flip hardening pass before `memoryPrefetchEnabled` is turned
  on anywhere.

  One exception is NOT dark and ships live on merge: `recall.py`'s
  task-notification junk gate (`recallSkipTaskNotification`, default on),
  which skips recall on synthetic `<task-notification>` / sub-agent-handback
  turns. It is independent of `memoryPrefetchEnabled` and takes effect
  immediately. To keep that live change honest, the gate is now scoped to
  the noisy classes only: **active DIRECTIVES are exempt** — a gated turn
  still fetches and injects the `<active_directives>` block (an agent's
  standing rules apply on every turn, synthetic or not), and only the
  non-directive `recall` result set (observations/world/etc.) is suppressed.
