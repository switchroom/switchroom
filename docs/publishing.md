# Publishing the switchroom Claude Code plugin

The switchroom repo doubles as a Claude Code **plugin marketplace**. The marketplace
manifest lives at `.claude-plugin/marketplace.json` and advertises a single
plugin, `switchroom`, sourced from the repo root. The plugin manifest at
`.claude-plugin/plugin.json` points at the existing `skills/` directory at the
repo root (the default location Claude Code looks for skills), so no files need
to move.

## For users: installing

Inside any Claude Code session:

```
/plugin marketplace add switchroom/switchroom
/plugin install switchroom@switchroom
```

The first command registers this GitHub repo as a marketplace named `switchroom`.
The second installs the `switchroom` plugin from that marketplace. Four slash
commands and the existing skills become available under the `switchroom:`
namespace:

- `/switchroom:setup` — Phase 0 on-ramp. Bootstraps a fresh box from
  zero to a paired Telegram agent in one walk-through (deps, `switchroom
  setup` wizard, first agent start). See
  [#84](https://github.com/switchroom/switchroom/issues/84).
- `/switchroom:start [agent]` — start one agent or reconcile and start
  the whole fleet.
- `/switchroom:stop [agent]` — stop one agent without uninstalling.
- `/switchroom:status` — `switchroom agent list` plus fleet health.

Skills also bind to the same namespace: `switchroom-install`,
`switchroom-status`, `switchroom-cli`, `switchroom-health`,
`switchroom-manage`, `switchroom-architecture`.

To pull updates later:

```
/plugin marketplace update switchroom
```

## For maintainers: cutting a release

Releases are **not** cut from this document, and they are **not** cut by
hand-bumping manifests. Do NOT bump `version` in `package.json` or
`.claude-plugin/plugin.json`, and do NOT `git tag && git push --tags` from a
local `main` — the committed `package.json` version is a stale placeholder by
design, the `vX.Y.Z` **git tag is the version source of truth**
(`scripts/build.mjs:resolveVersion()`), and the tag push fires
`.github/workflows/release.yml`, which orchestrates the binaries, images, the
npm publish, and the GitHub Release. An earlier revision of this file
described a manual manifest-bump-and-tag flow; following it cuts a broken
release.

The authoritative, ordered runbook is the **`switchroom-release`** skill:
[`skills/switchroom-release/SKILL.md`](../skills/switchroom-release/SKILL.md),
summarised in [`CONTRIBUTING.md`](../CONTRIBUTING.md) § "Release to npm
(canonical maintainers only)". In short: consolidate the changelog, merge the
CHANGELOG-only `chore: release vX.Y.Z` PR, create the draft GitHub Release on
a pinned SHA, push the tag at that same SHA, and let `release.yml` gate
everything else.

Plugin users need nothing beyond that: `/plugin marketplace update switchroom`
reads this repo, so the plugin ships from the same tagged history. There is no
separate plugin publish step.

## For contributors: developing locally

Point Claude Code at this checkout as a marketplace:

```
/plugin marketplace add /home/testuser/code/switchroom
/plugin install switchroom@switchroom
```

After editing `plugin.json` or `marketplace.json`, re-run `/plugin marketplace
update switchroom` to pick up the changes (or remove and re-add the marketplace).

## Layout notes

Claude Code's plugin convention puts skills under `<plugin-root>/skills/`.
Because switchroom already kept its skills at `<repo-root>/skills/`, the marketplace
entry uses `"source": "./"`. The repo root *is* the plugin root. No skill files
were moved. The only new artifacts are:

- `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json`
- `commands/*.md` (slash commands under `/switchroom:`)
- `docs/publishing.md` (this file)

Reference: <https://docs.claude.com/en/docs/claude-code/plugin-marketplaces>
