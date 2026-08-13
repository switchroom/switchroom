#!/usr/bin/env node
/**
 * check-claude-cli-lockstep — the THREE Claude CLI version pins must agree.
 *
 * Why this script exists
 * ----------------------
 * The bundled Claude CLI version is written down in three places, and a bump
 * has to move all three together (see docs/operators/claude-cli-updates.md):
 *
 *   1. docker/Dockerfile.base       `ARG CLAUDE_CODE_VERSION=` — the agent /
 *      broker / kernel / auth-broker / hostd bundle (all `FROM ${BASE_IMAGE}`)
 *   2. docker/Dockerfile.hindsight  `ARG CLAUDE_CODE_VERSION=` — the hindsight
 *      reflection bundle, installed separately
 *   3. dependencies.json            `.claude.cli` — the pinned-dependency
 *      manifest read by `detectDrift()` (src/manifest.ts), surfaced through
 *      `switchroom doctor` and `switchroom versions`
 *
 * Until this guard existed the invariant was enforced by NOTHING executable —
 * only by prose in the operator doc and by whoever reviewed the bump. Both
 * skews are silent and both bite:
 *
 *   - a stale/bogus `dependencies.json` `.claude.cli` makes every host in the
 *     fleet report a phantom claude-CLI drift, because the declared value no
 *     longer matches what the image actually installs;
 *   - a Dockerfile.hindsight left behind ships a reflection bundle on an older
 *     CLI than the agents, which is exactly the agent/hindsight skew that can
 *     reintroduce the #1978 thinking-block failure class.
 *
 * The floor half of the contract (every pin >= the #1978 fix version) is
 * asserted in tests/doctor-claude-cli.test.ts. This script asserts the
 * lockstep half: whatever the version is, all three say the same thing.
 *
 * Run: `npm run lint:claude-cli-lockstep` (also part of `npm run lint`).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Matches a whole `ARG CLAUDE_CODE_VERSION=<v>` line, which is the same shape
// all three readers of Dockerfile.base require: src/cli/doctor-claude-cli.ts
// (`/^\s*ARG\s+CLAUDE_CODE_VERSION=([0-9][0-9.]*)\s*$/m`) and the anchored grep
// in .github/workflows/ci-claude-latest-canary.yml. So a prose mention of
// `CLAUDE_CODE_VERSION=<other>` elsewhere in the file cannot make one reader
// see a different pin than another.
//
// One residual difference, deliberate: the other two take the FIRST matching
// line, this collects EVERY one. That is strictly stricter, not divergent — a
// multi-stage Dockerfile that re-declares the arg with a different default is
// itself a skew, and this guard fails on it rather than picking a winner.
const ARG_RE = /^[ \t]*ARG[ \t]+CLAUDE_CODE_VERSION=([0-9][0-9.]*)[ \t]*$/gm;

/**
 * Distinct `ARG CLAUDE_CODE_VERSION=` defaults declared in a Dockerfile.
 * An unreadable file yields `[]`, which the caller reports as `<not found>` —
 * the guard fails closed with a message that still names every location,
 * rather than dying on an ENOENT stack trace.
 * @param {string} rel @returns {string[]}
 */
function dockerfilePins(rel) {
  let text;
  try {
    text = readFileSync(join(repoRoot, rel), "utf8");
  } catch {
    return [];
  }
  return [...new Set([...text.matchAll(ARG_RE)].map((m) => m[1]))];
}

/** The manifest's `.claude.cli`, as a 0- or 1-element list. @param {string} rel @returns {string[]} */
function manifestPins(rel) {
  let v;
  try {
    v = JSON.parse(readFileSync(join(repoRoot, rel), "utf8"))?.claude?.cli;
  } catch {
    return [];
  }
  return typeof v === "string" && v.length > 0 ? [v] : [];
}

const sources = [
  {
    label: "docker/Dockerfile.base (ARG CLAUDE_CODE_VERSION)",
    found: dockerfilePins("docker/Dockerfile.base"),
  },
  {
    label: "docker/Dockerfile.hindsight (ARG CLAUDE_CODE_VERSION)",
    found: dockerfilePins("docker/Dockerfile.hindsight"),
  },
  {
    label: "dependencies.json (.claude.cli)",
    found: manifestPins("dependencies.json"),
  },
];

const values = [...new Set(sources.flatMap((s) => s.found))];
const unreadable = sources.filter((s) => s.found.length !== 1);

if (unreadable.length > 0 || values.length > 1) {
  // "Which one disagrees" = the odd one out: the value the majority of
  // readable sources do NOT carry. With three sources a single skew always
  // has a clear majority, so the arrow points at the file to fix rather than
  // at the two that are already correct. Ties fall back to Dockerfile.base
  // (what `switchroom doctor` and the nightly canary already read).
  const tally = new Map();
  for (const s of sources) {
    if (s.found.length === 1) tally.set(s.found[0], (tally.get(s.found[0]) ?? 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const majority =
    top.length > 0 && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : null;
  const reference =
    majority ?? (sources[0].found.length === 1 ? sources[0].found[0] : null);

  console.error("check-claude-cli-lockstep: FAIL\n");
  console.error("The Claude CLI pin must be identical in all three locations:\n");
  for (const s of sources) {
    const read =
      s.found.length === 1
        ? s.found[0]
        : s.found.length === 0
          ? "<not found>"
          : `<conflicting: ${s.found.join(", ")}>`;
    const agrees =
      s.found.length === 1 && reference !== null && s.found[0] === reference;
    console.error(
      `  ${agrees ? "  " : "→ "}${s.label}: ${read}${agrees ? "" : "   <-- disagrees"}`,
    );
  }
  console.error("\nBump all three to the same version in the same PR — see");
  console.error("docs/operators/claude-cli-updates.md ('Routine update procedure').");
  process.exit(1);
}

console.log(`check-claude-cli-lockstep: OK — all three pins agree (${values[0]}).`);
