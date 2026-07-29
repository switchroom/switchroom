/**
 * Lint guard — the TS and Python secret redactors must share ONE pattern
 * table.
 *
 * Agent memory is written from Python (`vendor/hindsight-memory/scripts/`)
 * and from TypeScript (the MCP shim, the handoff mirror, the profile CLI).
 * Both redact with the same rules only because
 * `vendor/hindsight-memory/scripts/lib/secret_patterns.json` is GENERATED
 * from `telegram-plugin/secret-detect/patterns.ts`. If someone adds a
 * pattern to the TS table and forgets to regenerate, the Python write path
 * silently stops matching the TS one — the exact fork this guard exists to
 * make impossible.
 *
 * Failure is actionable: run `bun scripts/gen-secret-patterns.ts` and
 * commit the result.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATED_PATTERNS_PATH,
  buildPatternTable,
} from "./secret-patterns-codegen.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(repoRoot, GENERATED_PATTERNS_PATH);

let onDisk: string;
try {
  onDisk = readFileSync(target, "utf-8");
} catch {
  process.stderr.write(
    `check-secret-pattern-parity: ${GENERATED_PATTERNS_PATH} is missing.\n` +
      `Run: bun scripts/gen-secret-patterns.ts\n`,
  );
  process.exit(1);
}

const expected = buildPatternTable();
if (onDisk !== expected) {
  process.stderr.write(
    `check-secret-pattern-parity: ${GENERATED_PATTERNS_PATH} is STALE — the\n` +
      `Python write-path redactor would apply a different rule set than the\n` +
      `TypeScript one.\n\n` +
      `Run: bun scripts/gen-secret-patterns.ts   (then commit the result)\n`,
  );
  process.exit(1);
}
process.stdout.write("check-secret-pattern-parity: OK\n");
