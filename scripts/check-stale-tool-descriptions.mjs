#!/usr/bin/env node
/**
 * Guard against STALE self-descriptions reaching an agent.
 *
 * The failure this prevents (the klanker incident): a capability ships, but
 * its agent-facing description stays frozen at PR-1-skeleton time — "PR 1a —
 * skeleton ... returns E_NOT_IMPLEMENTED ... ships in follow-up PRs". The
 * agent reads its own tool description, believes the feature isn't real, and
 * wrongly refuses a doable action (config_propose_edit / hand-edit-the-yaml).
 *
 * Scope: the strings an AGENT actually reads at tool-selection / prompt time —
 * MCP tool descriptions (src/mcp server.ts files) and the rendered prompt
 * fragments (profiles .hbs files). NOT wire-protocol types or RFC docs (those
 * legitimately discuss build status / retained-but-unreachable codes).
 *
 * Deny-list: unambiguous build-time-status phrases that should never describe
 * a SHIPPED capability. A line carrying `intentional-deferred:` is waived
 * (for genuine not-yet-built scopes — e.g. an MCP tool that truthfully says a
 * sub-capability is deferred). Keep the deny-list narrow: flag "stub" /
 * "skeleton" / "PR N" / "E_NOT_IMPLEMENTED", NOT softer words like "deferred"
 * (which genuine boundaries use correctly).
 *
 * Mirrors the other structural guards (check-bun-test-imports, etc.) wired
 * into `npm run lint`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/mcp", "profiles"];
const EXT = /\.(ts|hbs)$/;
const IS_TEST = /\.(test|spec)\.ts$/; // tests legitimately reference past PRs

const DENY = [
  { re: /\bPR \d/i, label: "PR-number build-status ('PR 1a')" },
  { re: /\bskeleton\b/i, label: "'skeleton'" },
  { re: /E_NOT_IMPLEMENTED/, label: "E_NOT_IMPLEMENTED (dead code in a description)" },
  { re: /ships? in (a |the )?follow-?up/i, label: "'ships in follow-up'" },
  { re: /\bnot yet (wired|implemented|shipped|built)\b/i, label: "'not yet implemented'" },
  { re: /\bcoming soon\b/i, label: "'coming soon'" },
];
const WAIVER = /intentional-deferred:/;
// In .ts we only care about the strings an agent reads (description: / .describe()),
// not code comments that legitimately cite the originating PR. Skip comment-only
// lines. (.hbs is all agent-facing prompt — scanned in full.)
const TS_COMMENT = /^\s*(\/\/|\*|\/\*)/;

function walk(dir) {
  let out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) out = out.concat(walk(p));
    else if (EXT.test(p)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (IS_TEST.test(file)) continue;
    const isTs = file.endsWith(".ts");
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (WAIVER.test(line)) return;
      if (isTs && TS_COMMENT.test(line)) return; // skip code comments in .ts
      for (const { re, label } of DENY) {
        if (re.test(line)) {
          offenders.push({ file, line: i + 1, label, text: line.trim().slice(0, 110) });
          break;
        }
      }
    });
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    "check-stale-tool-descriptions: FAILED — agent-facing description(s) carry " +
      "build-time-status language that contradicts a shipped capability:\n\n",
  );
  for (const o of offenders) {
    process.stderr.write(`  ${o.file}:${o.line}  [${o.label}]\n    ${o.text}\n`);
  }
  process.stderr.write(
    "\nIf the feature SHIPPED: delete the stale status text.\n" +
      "If it is genuinely not built: add an `intentional-deferred:` note on the line.\n",
  );
  process.exit(1);
}
process.stdout.write(
  "check-stale-tool-descriptions: clean (no stale build-status phrases in agent-facing descriptions)\n",
);
