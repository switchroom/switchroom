/**
 * Regenerate the Python-side secret-detection pattern table.
 *
 *   bun scripts/gen-secret-patterns.ts
 *
 * Writes `vendor/hindsight-memory/scripts/lib/secret_patterns.json` from
 * `telegram-plugin/secret-detect/patterns.ts`. Commit the result; `bun
 * lint` (`scripts/check-secret-pattern-parity.ts`) fails when it drifts.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATED_PATTERNS_PATH,
  buildPatternTable,
} from "./secret-patterns-codegen.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(repoRoot, GENERATED_PATTERNS_PATH);
writeFileSync(target, buildPatternTable(), "utf-8");
process.stdout.write(`wrote ${GENERATED_PATTERNS_PATH}\n`);
