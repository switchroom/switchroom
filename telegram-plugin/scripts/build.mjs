#!/usr/bin/env node
// Build script for @clerk-ai/telegram-plugin npm publish.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist");
const outFile = resolve(outDir, "server.js");

console.log("[build] cleaning dist/");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  execSync("bun --version", { stdio: "ignore" });
} catch {
  console.error("[build] bun is required to build. Install from https://bun.sh");
  process.exit(1);
}

console.log("[build] bundling server.ts -> dist/server.js");
execSync(
  `bun build ${JSON.stringify(resolve(root, "server.ts"))} --outdir ${JSON.stringify(outDir)} --target node`,
  { stdio: "inherit", cwd: root }
);

let src = readFileSync(outFile, "utf8");
if (src.startsWith("#!/usr/bin/env bun")) {
  src = src.replace(/^#!\/usr\/bin\/env bun/, "#!/usr/bin/env node");
  writeFileSync(outFile, src);
}
chmodSync(outFile, 0o755);

console.log("[build] done");
