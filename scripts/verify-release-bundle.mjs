#!/usr/bin/env node
/**
 * Runtime half of the release asset-name contract (#3633).
 *
 * Given the directory of built release artifacts, assert that what is actually
 * on disk is exactly what `install.sh` will try to download and verify:
 *
 *   1. every asset name the installer derives is present and non-empty;
 *   2. nothing unexpected is in the bundle (a stray file would get published);
 *   3. the checksums file is named what the installer downloads;
 *   4. each checksum line is findable by the installer's literal
 *      `grep -F "  <asset>"` and its hash matches the real file.
 *
 * (4) is the one a human eyeball misses: `sha256sum`'s two-space separator is
 * load-bearing, and a checksums file written with one space or with `*name`
 * (binary-mode) passes casual inspection while making the installer die with
 * "No checksum entry for …".
 *
 * Usage: node scripts/verify-release-bundle.mjs <dir>
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Deliberately depends on nothing outside node stdlib — this runs on a bare
// checkout in the release workflow, with no `npm install` before it.
import { CHECKSUM_SEPARATOR, ContractError, loadInstallerContract } from "./release-assets.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/verify-release-bundle.mjs <bundle-dir>");
  process.exit(2);
}

let installer;
try {
  ({ installer } = loadInstallerContract());
} catch (err) {
  if (err instanceof ContractError) {
    console.error(`FAIL release bundle: could not derive the install.sh contract\n  ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const problems = [];
const expected = new Set([...installer.assets, installer.checksumsFile, installer.payloadAsset]);
// Everything the installer downloads AND verifies against the checksums file.
// The checksums file itself is the trust root and cannot check itself.
const checksummed = [...installer.assets, installer.payloadAsset];

let present;
try {
  present = readdirSync(dir);
} catch (err) {
  console.error(`FAIL release bundle: cannot read ${dir}\n  ${err.message}`);
  process.exit(1);
}

for (const name of expected) {
  if (!present.includes(name)) {
    problems.push(`missing: ${name} (install.sh will 404 on it)`);
    continue;
  }
  const size = statSync(join(dir, name)).size;
  if (size === 0) problems.push(`empty: ${name} is 0 bytes`);
}
for (const name of present) {
  if (!expected.has(name)) problems.push(`unexpected file in the bundle: ${name}`);
}

// Checksum-line shape + correctness, exactly as install.sh consumes it.
if (present.includes(installer.checksumsFile)) {
  const lines = readFileSync(join(dir, installer.checksumsFile), "utf-8").split("\n");
  for (const asset of checksummed) {
    if (!present.includes(asset)) continue;
    // install.sh: grep -F "  ${asset}" | awk '{print $1}' | head -n 1
    const needle = `${CHECKSUM_SEPARATOR}${asset}`;
    const line = lines.find((l) => l.includes(needle));
    if (!line) {
      problems.push(
        `${installer.checksumsFile}: no line matching the installer's fixed-string lookup ` +
          `${JSON.stringify(needle)} for ${asset}`,
      );
      continue;
    }
    const declared = line.trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(readFileSync(join(dir, asset))).digest("hex");
    if (declared !== actual) {
      problems.push(`${asset}: checksums file says ${declared}, file hashes to ${actual}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`FAIL release bundle at ${dir}\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `OK release bundle at ${dir}: ${installer.assets.length} binaries + ` +
    `${installer.payloadAsset} + ${installer.checksumsFile}`,
);
for (const asset of checksummed) console.log(`   ${asset}`);
