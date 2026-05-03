#!/usr/bin/env bun
// MCP-server entry shim. Resolved by `bun run start` (see package.json).
//
// Strategic packaging fix (#634): the production MCP launcher invokes
// `bun run --cwd <pluginDir> --silent start`, which executes this file.
// We prefer the bundled `dist/server.js` because the npm package's
// `files` array doesn't include `src/` — direct `.ts` execution from
// the global install fails with `Cannot find module '../../src/...'`
// against the bundle's cross-imports. The bundle resolves them at
// build time so dist runs everywhere.
//
// Dev workspaces that haven't run `bun run build` yet (or operators
// running pre-#634 packages) fall back to the .ts source. The fallback
// is the legacy behavior — preserves dev ergonomics where editing
// .ts and restarting an agent picks up changes without an explicit
// build step (modulo the documented `bun run build` cycle).
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, "dist/server.js");
const sourcePath = resolve(here, "server.ts");

const target = existsSync(distPath) ? distPath : sourcePath;
await import(target);
