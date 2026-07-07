/**
 * Per-pane drive serialization (PR #2263 review blocker 1).
 *
 * Anything that types keys into a claude tmux pane and reads the
 * rendered result (the /model picker driver, slash-command inject)
 * MUST NOT overlap with another such drive on the same pane: a second
 * drive's Enter landing while the first drive's picker modal is open
 * acts as the picker's "set as default" — applying whatever row the
 * cursor happens to be on. A simple promise-chain mutex keyed by
 * `socket:session` serializes drives; callers queue rather than
 * interleave.
 *
 * The chain never accumulates rejected state (failures are swallowed
 * in the stored tail; the caller still sees its own rejection), and
 * entries are dropped once their tail settles so the map can't grow
 * unboundedly across agent lifetimes.
 */

const tails = new Map<string, Promise<void>>();

export function withPaneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = tails.get(key) ?? Promise.resolve();
  const run = tail.then(() => fn());
  const next = run.then(
    () => {},
    () => {},
  );
  tails.set(key, next);
  void next.then(() => {
    if (tails.get(key) === next) tails.delete(key);
  });
  return run;
}
