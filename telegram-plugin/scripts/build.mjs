#!/usr/bin/env node
// Build script for @switchroom-ai/telegram-plugin npm publish.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist");

console.log("[build] cleaning dist/");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  execSync("bun --version", { stdio: "ignore" });
} catch {
  console.error("[build] bun is required to build. Install from https://bun.sh");
  process.exit(1);
}

const entries = [
  { src: "server.ts", out: "server.js", label: "server (legacy + dual-mode shim)" },
  { src: "gateway/gateway.ts", out: "gateway/gateway.js", label: "gateway (persistent service)" },
  { src: "bridge/bridge.ts", out: "bridge/bridge.js", label: "bridge (MCP proxy)" },
  { src: "foreman/foreman.ts", out: "foreman/foreman.js", label: "foreman (admin bot)" },
];

for (const { src, out, label } of entries) {
  const srcPath = resolve(root, src);
  const outPath = resolve(outDir, out);
  const outDirForEntry = dirname(outPath);
  mkdirSync(outDirForEntry, { recursive: true });

  console.log(`[build] bundling ${src} -> dist/${out}`);
  execSync(
    `bun build ${JSON.stringify(srcPath)} --outdir ${JSON.stringify(outDirForEntry)} --target node`,
    { stdio: "inherit", cwd: root }
  );

  let content = readFileSync(outPath, "utf8");
  if (content.startsWith("#!/usr/bin/env bun")) {
    content = content.replace(/^#!\/usr\/bin\/env bun/, "#!/usr/bin/env node");
    writeFileSync(outPath, content);
  }
  chmodSync(outPath, 0o755);
}

console.log("[build] done");
