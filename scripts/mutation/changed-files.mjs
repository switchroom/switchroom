/**
 * The diff gate — the one part of the mutation check whose failure mode is
 * "run nothing at all".
 *
 * Split out of `check-mutation-coverage.mjs` for the same reason `run.mjs` and
 * `operators.mjs` were: everything else in that file is manifest bookkeeping
 * around a `main()` that executes on import, which makes this function
 * untestable in place. It is also the function that most needs a test — every
 * other failure in the harness is loud (a red baseline, a stale symbol, a
 * drifted mutant count, a survivor), while this one is silent by construction:
 * return the wrong thing and the check reports `0/1 target(s) touched by this
 * diff` and exits 0 having perturbed nothing.
 *
 * Every fallback here is deliberately in the SAFE direction — "run everything"
 * rather than "run nothing":
 *
 *   - No base ref at all (local run, `push: main`, `merge_group` — GitHub sets
 *     `GITHUB_BASE_REF` on `pull_request` only) → null → run everything.
 *   - Base ref set but not resolvable (shallow checkout with no remote-tracking
 *     ref, deleted base branch) → both `git diff` specs fail → null → run
 *     everything, with a warning.
 *
 * A `false` here costs CI seconds. A `true` costs the guarantee.
 */

import { spawnSync } from "node:child_process";

/**
 * Files changed against the PR base, or `null` when no base is resolvable.
 * `null` means "run everything" — see the module header.
 *
 * @param {string|null} [base]  Explicit base ref (`--base`). Falls back to
 *        `GITHUB_BASE_REF`, then to null.
 * @param {object} [opts]
 * @param {string} opts.cwd     Repository to diff in.
 * @param {(msg: string) => void} [opts.warn]
 * @returns {Set<string>|null}
 */
export function changedFiles(base, { cwd, warn = console.warn } = {}) {
  const ref = base ?? process.env.GITHUB_BASE_REF ?? null;
  if (!ref) return null;
  for (const spec of [`origin/${ref}...HEAD`, `${ref}...HEAD`]) {
    const r = spawnSync("git", ["diff", "--name-only", spec], {
      cwd,
      encoding: "utf8",
    });
    if (r.status === 0) {
      return new Set(
        r.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }
  warn(
    `check-mutation-coverage: could not diff against "${ref}" — running ALL targets`,
  );
  return null;
}
