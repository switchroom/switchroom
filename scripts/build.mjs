#!/usr/bin/env node
// Build script for npm publish — bundles CLI + fixes shebang for Node.
// Runs under bun (preferred) or node (with esbuild fallback if bun missing).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist/cli");
const outFile = resolve(outDir, "clerk.js");

console.log("[build] cleaning dist/");
rmSync(resolve(root, "dist"), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Prefer bun (already a dev dep / runtime). Fall back to a clear error if missing.
let hasBun = false;
try {
  execSync("bun --version", { stdio: "ignore" });
  hasBun = true;
} catch {}

if (!hasBun) {
  console.error("[build] bun is required to build. Install from https://bun.sh");
  process.exit(1);
}

console.log("[build] bundling bin/clerk.ts -> dist/cli/clerk.js");
execSync(
  `bun build ${JSON.stringify(resolve(root, "bin/clerk.ts"))} --outdir ${JSON.stringify(outDir)} --target node`,
  { stdio: "inherit", cwd: root }
);

// Rewrite shebang from `bun` to `node` so npm-installed users don't need bun.
console.log("[build] rewriting shebang -> node");
let src = readFileSync(outFile, "utf8");
if (src.startsWith("#!/usr/bin/env bun")) {
  src = src.replace(/^#!\/usr\/bin\/env bun/, "#!/usr/bin/env node");
  writeFileSync(outFile, src);
}
chmodSync(outFile, 0o755);

console.log("[build] done");
