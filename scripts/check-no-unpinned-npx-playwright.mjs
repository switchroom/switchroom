#!/usr/bin/env node
/**
 * Guard against the unpinned-`npx playwright` version-skew trap.
 *
 * The agent image bakes Playwright ONCE, version-pinned (docker/Dockerfile.agent
 * `ARG PLAYWRIGHT_VERSION`): the global `playwright` JS binary, the Python
 * binding, and one matching chromium revision under $PLAYWRIGHT_BROWSERS_PATH.
 *
 * The trap: a bare `npx playwright ...` run from an agent HOME dir (which has
 * NO local playwright install) makes npx fetch `playwright@latest` on the fly.
 * That latest wants a chromium revision that ISN'T baked into the image, so it
 * fails with the classic "Executable doesn't exist ... run npx playwright
 * install" error. The baked global `playwright` bin and the Python binding are
 * both fine — only the unpinned `npx playwright` is the hazard.
 *
 * This guard fails CI if a bare unpinned `npx playwright` is introduced in any
 * agent-executable surface (skills, hooks, commands, plugin/runtime scripts).
 * The durable fix is a mechanism, not prompt discipline: use the baked global
 * `playwright` binary, the Python binding, or pin `npx playwright@<version>`.
 *
 * Waivers:
 *   - docker/ is excluded: the Dockerfile's build-time `npx playwright install`
 *     runs immediately after `npm install -g playwright@${VERSION}`, so npx
 *     resolves the pinned global — not the trap.
 *   - A line carrying `pinned-npx-ok:` is waived (an explicit, reviewed pin).
 *
 * Mirrors the other structural guards wired into `npm run lint`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Agent-executable surfaces — the places code actually runs inside an agent
// HOME (where the trap bites). NOT docs/prose (CHANGELOG, src comments), which
// legitimately describe the historical `npx playwright` behaviour.
const ROOTS = ["skills", "bin", "commands", "telegram-plugin/gateway"];
const EXT = /\.(sh|py|mjs|cjs|js|ts|md)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

// Bare `npx playwright` NOT pinned with `@<version>` right after the package.
const UNPINNED = /npx\s+(?:--yes\s+|-y\s+)?playwright(?!@\d)/;

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("pinned-npx-ok:")) return;
      if (UNPINNED.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}

if (offenders.length > 0) {
  console.error(
    "check-no-unpinned-npx-playwright: bare unpinned `npx playwright` found in\n" +
      "agent-executable surface(s). From an agent HOME this fetches\n" +
      "playwright@latest and demands an unbaked chromium revision → runtime\n" +
      '"Executable doesn\'t exist" failure. Use the baked global `playwright`\n' +
      "binary, the Python binding, or pin `npx playwright@<version>` (or add a\n" +
      "reviewed `pinned-npx-ok:` waiver comment):\n",
  );
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}

console.log("check-no-unpinned-npx-playwright: OK");
