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
/plugin marketplace add mekenthompson/switchroom
/plugin install switchroom@switchroom
```

The first command registers this GitHub repo as a marketplace named `switchroom`.
The second installs the `switchroom` plugin from that marketplace. All 11 skills
(`switchroom-install`, `switchroom-status`, `switchroom-cli`, `switchroom-health`,
`switchroom-manage`, `switchroom-architecture`) become available
under the `switchroom:` namespace.

To pull updates later:

```
/plugin marketplace update switchroom
```

## For maintainers: cutting a release

1. Update the version in both manifests so they stay in sync:
   - `package.json` — `version`
   - `.claude-plugin/plugin.json` — `version`
2. Commit the bump:
   ```bash
   git add package.json .claude-plugin/plugin.json
   git commit -m "chore: release vX.Y.Z"
   ```
3. Tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
4. Users running `/plugin marketplace update switchroom` will see the new version on
   their next refresh. There is no separate publish step — GitHub is the
   distribution channel.

### Versioning

Use [semver](https://semver.org):

- **patch** (`0.1.0 → 0.1.1`): skill copy tweaks, doc fixes
- **minor** (`0.1.0 → 0.2.0`): new skills, new capabilities
- **major** (`0.1.0 → 1.0.0`): skill renames or removals (breaking)

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
entry uses `"source": "./"` — the repo root *is* the plugin root. No skill files
were moved. The only new artifacts are:

- `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json`
- `docs/publishing.md` (this file)

Reference: <https://docs.claude.com/en/docs/claude-code/plugin-marketplaces>
