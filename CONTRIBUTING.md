# Contributing to Clerk

Thanks for your interest in contributing to Clerk!

## Getting Started

1. Fork the repo
2. Clone your fork
3. Create a branch for your work
4. Make your changes
5. Submit a PR

## Development

```bash
bun install
bun run build
bun run test
```

## Project Structure

See [PRD.md](PRD.md) for architecture details.

## Profiles

Community profiles are welcome! Add them to `profiles/<name>/` with:
- `CLAUDE.md.hbs` — agent behavior
- `SOUL.md.hbs` — agent persona
- Optional `skills/` for domain-specific skills

Agents inherit a profile via `extends: <name>` in `clerk.yaml`. See
[docs/configuration.md](docs/configuration.md) for the cascade semantics.

## Code Style

- TypeScript (ESM)
- Bun runtime
- Zod for schema validation
- Prefer simplicity over abstraction

## Issues

Each GitHub issue is designed to be a self-contained unit of work. If you want to contribute, pick an unassigned issue and comment that you're working on it.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
