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

See `README.md` for the user-facing description and `PRD.md` for the
(partially dated) product intent.

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
reference/              Internal reference notes (JTBDs, design notes)
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
