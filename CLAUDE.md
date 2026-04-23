# CLAUDE.md — Switchroom

This file orients Claude Code (and other agentic tools) to this repo.
`AGENTS.md` and `AGENT.md` are symlinks to this file — edit here, not
there.

## What this project is

Switchroom is a Telegram plugin + agent lifecycle layer sitting on top of
the unmodified `claude` CLI. Users run Claude Code agents 24/7 on a Linux
box, talk to them from Telegram, and authenticate with their Claude
Pro/Max subscription via OAuth (no API keys, no Docker, no custom
runtime). The headline feature is a live **progress card** that pins into
each Telegram topic while an agent works.

See `README.md` for the user-facing description. Deeper design notes
live in `reference/`: outcome-focused JTBDs (`reference/*.md`) describe
what the product is *for*, and `reference/PRD.md` is the (partially
dated) original product-intent doc kept for architectural rationale.

## Repo layout

```
src/                    TypeScript source for the `switchroom` CLI
  agents/               Agent scaffolding, lifecycle, workspace bootstrap
  auth/                 OAuth + multi-account slot pool (accounts.ts, manager.ts)
  cli/                  One file per top-level CLI verb (auth, agent,
                        workspace, debug, memory, topics, vault, ...)
  config/               YAML loader + three-layer cascade (defaults → profiles → agents)
  memory/               Hindsight memory integration
  setup/                Interactive `switchroom setup` wizard
  telegram/             Shared telegram helpers used by the CLI
  vault/                AES-256-GCM encrypted secrets store
  web/                  Web dashboard

telegram-plugin/        The enhanced MCP Telegram plugin (own Bun tests)
  server.ts             MCP stdio server entry
  progress-card.ts      Pinned progress-card renderer
  tool-labels.ts        Tool-use label formatting
  auth-slot-parser.ts   /auth router (add/use/list/rm)
  auto-fallback.ts      Quota-exhaustion auto-fallback
  tests/                Bun tests

profiles/               Built-in agent profiles (CLAUDE.md.hbs + SOUL.md.hbs)
skills/                 Bundled Claude Code skills (symlinked into agents)
docs/                   User-facing docs
reference/              Internal reference notes — outcome-focused JTBDs
                        (*.md) + PRD.md (original product-intent doc)
scripts/                Build + release helpers
tests/                  Vitest suite for src/
```

Agent scaffolds are written **outside** this repo (default
`~/.switchroom/agents/<name>/`) — never commit per-user agent state here.

## Commands

```bash
bun install              # install deps (project uses bun.lock)
bun run dev -- <args>    # run the CLI directly from src/ via bin/switchroom.ts
npm run build            # compile src/ + telegram-plugin/ → dist/
npm run lint             # tsc --noEmit (type-check only, no emit)
npm test                 # vitest (src/) + bun test (telegram-plugin/)
npm run test:vitest      # src/ only
npm run test:bun         # telegram-plugin/ only
npm run test:watch       # vitest --watch
```

The build output (`dist/`) is what `switchroom` resolves when installed
globally. During local work on src/, prefer `bun run dev` over rebuilding.

## Conventions

- **Language:** TypeScript, ES modules, Node ≥ 20.11. Strict TS config.
- **Tests:** vitest for `src/` + `tests/`, bun test for
  `telegram-plugin/tests/` (some rely on Bun's native APIs). Both run
  under `npm test`.
- **No commented-out code.** Don't leave `// TODO: rename` or half-dead
  blocks — either fix it or open an issue.
- **CLI structure:** each top-level verb gets its own file in `src/cli/`
  with a `register<Name>Command(program)` export wired into
  `src/cli/index.ts`. Follow the existing shape when adding a verb.
- **Config cascade** is the central abstraction — see
  `docs/configuration.md` and `src/config/merge.ts`. New fields need a
  documented cascade mode (union / override / per-key merge / concat /
  deep-merge).
- **Commit style:** Conventional Commits (`feat(scope):`, `fix(scope):`,
  `docs(scope):`, `test(scope):`, `chore(scope):`). Recent history is a
  good reference — `git log --oneline -20`.

## Repo model & dev flow

Switchroom uses a **fork + canonical** model. Read this before pushing.

- **`switchroom/switchroom`** — canonical public repo, source of truth
  for releases. All `npm publish` output comes from here. Tagged
  versions (`v0.X.Y`) live here.
- **Your fork** (e.g. `<your-username>/switchroom`) — where you work.
  Feature branches + PRs on the fork for iteration; release-time PRs
  from the fork's `main` → `switchroom:main`.

**Local git remotes** should be:
- `origin` → your fork (for push)
- `upstream` → `switchroom/switchroom` (for pulling canonical updates)

Agent working on this repo: when you open a PR, **target
`switchroom/switchroom:main`** as the base, not the fork's main. The fork
is a staging area for your own iteration; the canonical repo is where
review + merge + release happens.

### Three workflows — know which one you're in

**1. Code-change dev loop (most common).** Editing source, iterating.
```
bun run build                  # ~1s, regenerates dist/cli/switchroom.js
switchroom agent restart all   # reconciles + restarts running agents
```

**2. Release to npm (canonical maintainers).** Bump `package.json`,
update `CHANGELOG.md`, commit `chore: release vX.Y.Z`, tag, push, then
`npm publish`. Publishes come from the canonical repo only.

**3. Local deploy.** Same as the dev loop — pull, build, restart.

### Code ≠ runtime

A rebuild updates the CLI + dist/. It does **not** update running agent
processes — those loaded the code at boot and hold it in memory.
**Changes only go live after the runtime restarts post-build.** When
your work affects the CLI, the telegram-plugin, or scaffolded assets,
expect a `switchroom agent restart all` to be part of verification.

Since PR #59, `switchroom agent restart` always runs reconcile first
(regenerating systemd units + daemon-reload if changed). So a restart is
also a mini-deploy of any scaffold changes.

### Install paths

`~/.bun/bin/switchroom` is typically a symlink to the workspace's
`dist/cli/switchroom.js`. If you built with `bun run build`, the global
CLI is already fresh — no `npm i -g` needed. An `npm i -g switchroom-ai`
installs a separate, pinned copy at `~/.nvm/…/node_modules/switchroom-ai`;
PATH resolution order determines which wins. Prefer the bun-linked install
on dev machines, the npm-global install on consumer machines.

### Secrets in tests

The repo has GitHub Push Protection enabled. Don't commit real-looking
tokens — even as test fixtures — as contiguous string literals. If you
need a token-shaped fixture for testing secret detectors, construct it
at runtime via string concatenation so the source file never contains a
contiguous token pattern. See
`telegram-plugin/tests/secret-detect-secretlint.test.ts` for the pattern.

## Safety rails

- **Never bypass hooks** (`--no-verify`, `--no-gpg-sign`) without an
  explicit instruction. If a hook fails, fix the cause.
- **Never force-push `main`.** Feature work → branch + PR, unless the
  user explicitly asks for a direct push.
- **Don't touch** `clerk-export/`, `private/`, `.vault/`,
  `~/.switchroom/vault/`, or anything under `vendor/` without a reason —
  those hold secrets or third-party code.
- Telegram bot tokens, OAuth tokens, and vault keys must never land in
  commits. The vault CLI (`switchroom vault`) exists so you don't have
  to.

## Where to look first

- **"Why is feature X the way it is?"** → `reference/` (JTBD notes,
  design rationale) then `docs/`.
- **"How does config resolution work?"** → `src/config/merge.ts` +
  `docs/configuration.md`.
- **"How does the progress card render?"** →
  `telegram-plugin/progress-card.ts` + `docs/telegram-plugin.md`
  (streaming modes section).
- **"How does auth work?"** → `src/auth/accounts.ts` (slot storage) +
  `src/auth/manager.ts` (OAuth flow). Telegram `/auth` routing lives in
  `telegram-plugin/auth-slot-parser.ts`.
- **"What can I inspect at runtime?"** → `switchroom debug turn <agent>`
  dumps exact prompt layering; `switchroom workspace render <agent>`
  prints the bootstrap block.
