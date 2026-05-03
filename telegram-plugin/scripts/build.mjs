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
  // `--external node-fetch`: grammy depends on node-fetch@2 which is a
  // CJS package using node's `http`/`stream` directly. When bundled with
  // `--target node`, bun's bundler INLINES node-fetch as the fetch
  // implementation. Under bun runtime that inlined node-fetch breaks
  // grammy's API calls with a generic "Network request failed!" — the
  // gateway boot then loops 8x retrying getMe and exits, rendering the
  // entire fleet unresponsive (every reply path fails, agent thumbs-up
  // works but no message lands).
  //
  // Externalizing node-fetch keeps the bundle target-node compatible
  // for npm-i-g users on a node runtime (grammy declares node-fetch as
  // a dep so it'll be present in node_modules) AND lets bun's native
  // fetch shim take over when the bundle runs under bun (the actual
  // production deployment via `systemd ExecStart=bun gateway.js`).
  //
  // Verified: the un-externalized bundle reproducibly fails under bun
  // with "HttpError: Network request for 'getMe' failed!" within 1s of
  // boot. The externalized bundle boots cleanly and polls successfully.
  execSync(
    `bun build ${JSON.stringify(srcPath)} --outdir ${JSON.stringify(outDirForEntry)} --target node --external node-fetch`,
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
