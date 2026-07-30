#!/usr/bin/env node
/**
 * Lint guard — every TypeScript path that WRITES a Hindsight memory must
 * redact secrets first.
 *
 * ## The failure this exists to prevent
 *
 * A credential written into a memory bank is effectively permanent: it is
 * recalled into future sessions, folded into mental models, and copied into
 * consolidations. So redaction has to happen at intake, and it has to happen
 * on EVERY intake path — a single unguarded `fetch(.../memories)` reopens the
 * hole for the whole fleet.
 *
 * Three chokepoints cover the write surface today:
 *
 *   - Python plugin retains  -> vendor/hindsight-memory/scripts/lib/client.py
 *   - MCP tool calls         -> src/cli/hindsight-mcp-shim.ts (toolsCall)
 *   - direct REST writes     -> src/memory/hindsight-write-redaction.ts
 *
 * Only the third is easy to bypass by accident, because writing one is just
 * `fetch(url, { method: "POST" })` — nothing structurally forces a new caller
 * through the redactor. This guard supplies that force: any file under `src/`
 * that builds a `.../memories` write URL must import the redaction helper.
 *
 * ## What it does and does not prove
 *
 * It proves the redactor is REACHABLE from every write-shaped file, which
 * catches the realistic mistake (copy an existing fetch block, never think
 * about secrets). It does NOT prove the helper is actually called on the body
 * — a determined author can import it and ignore it. Behaviour is pinned by
 * tests (tests/hindsight-write-redaction.test.ts); this guard pins reachability
 * so a new path cannot be added in silence.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(repoRoot, "src");

/** The redaction helper a write-path file must reach for. */
const REDACTOR = "hindsight-write-redaction";

/**
 * Files exempt from the import requirement, each with the reason. Keep this
 * list SHORT and justified — an entry here is a hole in the guarantee.
 */
const EXEMPT = new Map([
  [
    "src/memory/hindsight-write-redaction.ts",
    "is the redactor itself",
  ],
]);

/**
 * A memories-write URL: a template literal or string ending in `/memories`
 * (optionally with a query). Deliberately does NOT match `/memories/list`,
 * `/memories/recall`, or `/memories/{id}` — those are reads and per-row
 * updates, not bulk intake.
 */
const WRITE_URL_RE = /\/memories(?:\$\{[^}]*\})?["'`?]/;

/** True when the file also does a POST — a bare URL constant is not a write. */
const POST_RE = /method:\s*["'`]POST["'`]/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    if (name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk(SRC)) {
  const rel = relative(repoRoot, file);
  if (EXEMPT.has(rel)) continue;
  const text = readFileSync(file, "utf-8");
  if (!WRITE_URL_RE.test(text) || !POST_RE.test(text)) continue;
  if (text.includes(REDACTOR)) continue;
  offenders.push(rel);
}

if (offenders.length > 0) {
  process.stderr.write(
    "check-hindsight-write-redaction: unredacted Hindsight memory write path(s):\n" +
      offenders.map((f) => `  ${f}\n`).join("") +
      "\nA POST to `.../memories` persists text into an agent's memory bank,\n" +
      "where a credential survives rotation and keeps resurfacing in recall.\n" +
      "Wrap the request body:\n\n" +
      '  import { redactMemoryWriteBody } from "../memory/hindsight-write-redaction.js";\n' +
      "  const body = redactMemoryWriteBody({ items: [...] });\n\n" +
      "If the file genuinely does not persist free text, add it to EXEMPT in\n" +
      "scripts/check-hindsight-write-redaction.mjs with the reason.\n",
  );
  process.exit(1);
}
process.stdout.write("check-hindsight-write-redaction: OK\n");
