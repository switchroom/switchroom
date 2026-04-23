# Contributing to Switchroom

Switchroom is MIT-licensed and welcomes contributions. This guide covers the
fork-and-PR flow, local dev loop, and what we look for in PRs.

## Repo layout

- **`switchroom/switchroom`** — the canonical public repo. Source of truth for
  releases. All `npm publish` output comes from here. Tagged versions
  (`v0.X.Y`) live here.
- **Your fork (e.g. `<your-username>/switchroom`)** — where you do your work.
  Feature branches land on your fork; PRs target the canonical repo's `main`.

Switchroom uses the standard GitHub fork workflow. You do not need commit
access to `switchroom/switchroom` to contribute.

## Getting started

1. **Fork** `switchroom/switchroom` via the GitHub UI (top-right → Fork).
   Keep the name `switchroom` under your username.
2. **Clone** your fork locally:
   ```
   git clone https://github.com/<your-username>/switchroom.git
   cd switchroom
   ```
3. **Add upstream** so you can pull canonical changes:
   ```
   git remote add upstream https://github.com/switchroom/switchroom.git
   ```
4. **Install deps** and build:
   ```
   bun install
   bun run build
   ```
5. **Run the tests**:
   ```
   bun run test
   ```

## The dev loop

There are three distinct workflows. Know which one you're in:

### 1. Code-change dev loop (most common)

Editing source, iterating, eating your own dogfood.

```
# edit files
bun run build                  # regenerates dist/cli/switchroom.js (~1s)
switchroom agent restart all   # reconciles + restarts running agents
```

Why the restart? Agents load code at process start and hold it in memory.
A rebuild updates the CLI and the bundled plugin, but running agents
still have the old code. `switchroom agent restart` picks up the latest
build (and also runs reconcile first, so any scaffold changes go live).

If you're using the bun-linked global install (`~/.bun/bin/switchroom`
symlinked to the workspace `dist/`), the CLI is always fresh after
`bun run build` — no `npm i -g` needed.

### 2. Release to npm (canonical maintainers only)

When the canonical `switchroom/switchroom:main` is ready to ship:

```
# On switchroom/switchroom:main
# 1. Bump package.json version
# 2. Update CHANGELOG.md
# 3. Commit: "chore: release vX.Y.Z"
# 4. Tag: git tag vX.Y.Z && git push origin vX.Y.Z
# 5. Publish: npm publish
```

npm publishes come from the canonical repo only. Forks don't publish.

### 3. Local deploy (optional)

If you maintain your own fleet of switchroom-managed agents on a personal
server, the dev loop above is also your deploy path. Pull, build, restart —
your agents are on the latest code.

## Submitting a PR

1. Branch off your fork's `main`:
   ```
   git checkout -b feature/my-feature
   ```
2. Keep PRs focused. One concern per PR. If you find yourself writing
   "and also" in the PR description, split it.
3. Add tests for new behavior. Bug fixes should include a regression test
   that would have caught the bug.
4. Run `bun run lint` (tsc noEmit) and `bun run test` before pushing.
5. Push to your fork and open a PR against `switchroom/switchroom:main`:
   ```
   gh pr create --repo switchroom/switchroom --base main \
     --head <your-username>:feature/my-feature
   ```
   Or use the GitHub UI.
6. PR title: conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`,
   `refactor:`, `test:`) + short imperative description.
7. PR body: what changed, why, and how to test it. A short test-plan
   checklist is appreciated.

## What we look for

- **Focused scope.** No surprise refactors bundled with a bug fix.
- **Tests.** New code and bug fixes should have coverage.
- **Clean commits.** Squash-merge is the default; within a PR, tidy
  commits are nice but not required — one good commit beats many bad ones.
- **No secrets.** The repo has secret detection (`secret-detect/`). Don't
  commit real tokens even in tests — if you need a fixture, construct it
  at runtime via string concatenation so the source file doesn't contain
  a contiguous token pattern. See
  [`telegram-plugin/tests/secret-detect-secretlint.test.ts`](telegram-plugin/tests/secret-detect-secretlint.test.ts)
  for the pattern.

## Profiles

Community agent profiles are welcome. Add them under `profiles/<name>/`:

- `CLAUDE.md.hbs` — agent behavior template
- `SOUL.md.hbs` — agent persona template
- Optional `skills/` for domain-specific skill bundles

Agents inherit a profile via `extends: <name>` in their `switchroom.yaml`
entry. See [`docs/configuration.md`](docs/configuration.md) for the
profile/agent cascade semantics.

## Code style

- TypeScript (ESM), Bun runtime
- Zod for schema validation at boundaries
- Prefer clear naming over comments
- Avoid premature abstraction; three similar lines beats a helper used once
- Match surrounding code — consistency over novelty

## Issues

Each issue should be a self-contained unit of work. If you want to
contribute, pick an unassigned issue and comment that you're on it. For
larger work or design changes, open a discussion first so we can align
on approach before you invest time.

## License

By contributing you agree that your contributions will be licensed under
the MIT License. See [`LICENSE`](LICENSE).
