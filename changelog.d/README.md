# changelog.d — per-PR changelog fragments

Every PR that changes shippable code stages its changelog note here as a
**new file**, instead of editing the shared `## Unreleased` section of
`CHANGELOG.md`.

Why: a single shared section makes any two in-flight PRs conflict on
`CHANGELOG.md` even when their entries never disagree — that ejected three
PRs from the merge queue in one day (#4678→#4679, #4679→#4712, #4678→#4712).
Two PRs can never conflict on two different files.

## Adding a note

The easy way — derives everything from your conventional-commit title:

```bash
bun run changelog:generate
```

Or write the file by hand:

- **Name:** `<pr-number>-<slug>.<type>.md` — e.g. `4720-add-a-verb.feat.md`.
  `<type>` is your conventional-commit type (`feat`, `fix`, `perf`,
  `refactor`, `docs`, `build`, `ci`, `revert`); it decides which `###`
  category the note lands under at release time (`feat` → Features, `fix` →
  Bug fixes, …). An unknown or missing type is fine — the note just lands
  ungrouped. Flat files only (no subdirectories); `README.md` (this file)
  never counts as a note.
- **Content:** the markdown bullet(s) exactly as they should appear in the
  release notes, house style:

  ```markdown
  - **scope: what changed (#4720)**
  ```

  Multi-line bodies are fine — the file is pasted into the release section
  verbatim.

CI (`scripts/check-changelog-entry.mjs`, part of `npm run lint`) fails a
shippable PR that neither **adds** a fragment here nor grows `## Unreleased`.
It must be a *new* file: editing an existing fragment stages nothing.
Docs/chore/test-only PRs opt out with the `no-changelog` label or a
`[skip changelog]` token on its own line in the PR body or a commit message.

## At release time

`bun run changelog:cut -- --version vX.Y.Z --summary "<one-liner>"`
(`scripts/cut-changelog-release.mjs`) assembles every fragment (plus anything
hand-staged under `## Unreleased`) into the `## vX.Y.Z — <summary>` section of
`CHANGELOG.md`, grouped by category, then **deletes the consumed fragments**
and re-seeds an empty `## Unreleased`. See
`skills/switchroom-release/SKILL.md`, Step 1.
