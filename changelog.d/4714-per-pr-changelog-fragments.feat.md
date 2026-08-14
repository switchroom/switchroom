- **ci: changelog notes are now per-PR fragment files under `changelog.d/`,
  killing the `## Unreleased` merge-conflict class.** Every PR staged its entry
  in the single shared `## Unreleased` section, so any two in-flight PRs
  conflicted on CHANGELOG.md even when their entries never disagreed — three
  merge-queue ejections in one day (#4678→#4679, #4679→#4712, #4678→#4712).
  Now `bun run changelog:generate` writes `changelog.d/<pr>-<slug>.<type>.md`
  (one file per PR — two PRs can never conflict), `check-changelog-entry.mjs`
  accepts a NEW fragment as the staged note (a merely-edited one stages
  nothing, and hand-written `## Unreleased` entries still count during the
  transition), and the release cut is `bun run changelog:cut -- --version
  vX.Y.Z --summary "…"` — `scripts/cut-changelog-release.mjs` assembles the
  fragments (plus anything hand-staged) into the `## vX.Y.Z` section grouped
  by category, re-seeds an empty `## Unreleased`, deletes the consumed
  fragments, and refuses an empty or double cut.
