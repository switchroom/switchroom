#!/usr/bin/env node
/**
 * Lint guard — the release asset-name contract (#3633).
 *
 * `install.sh` downloads `switchroom-<platform>-<arch>` + a checksums file
 * from the GitHub release page; `.github/workflows/release.yml` is the only
 * thing that produces them. If those names drift apart, the advertised
 * `curl | sh` install breaks silently — which is exactly what happened when
 * no release workflow existed at all and four consecutive releases shipped
 * zero assets.
 *
 * This guard derives BOTH sides from their real text (see
 * scripts/release-assets.mjs) and fails lint when they disagree. It is
 * deliberately a code check rather than a comment: the previous state of the
 * world was "documented, unenforced, wrong for two months".
 *
 * Run: `npm run lint:release-asset-contract` (also part of `npm run lint`).
 * Override paths for tests with SWITCHROOM_INSTALL_SH_PATH /
 * SWITCHROOM_RELEASE_WORKFLOW_PATH.
 */

import { ContractError, diffContracts, loadContracts } from "./release-assets.mjs";

let contracts;
try {
  contracts = await loadContracts();
} catch (err) {
  if (err instanceof ContractError) {
    console.error("FAIL release asset contract: could not derive the contract\n");
    console.error(`  ${err.message}`);
    process.exit(1);
  }
  if (err?.code === "ENOENT") {
    console.error("FAIL release asset contract: a required file is missing\n");
    console.error(`  ${err.message}`);
    console.error(
      "\n  Both install.sh and .github/workflows/release.yml must exist — the installer is dead without the workflow.",
    );
    process.exit(1);
  }
  throw err;
}

const { installer, workflow, installShPath, workflowPath } = contracts;
const problems = diffContracts(installer, workflow);

if (problems.length > 0) {
  console.error("FAIL release asset contract: install.sh and release.yml disagree\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\n  Fix the WORKFLOW to emit what the installer asks for (already-shipped installers cannot be" +
      "\n  changed retroactively), unless the installer itself is the wrong side.",
  );
  console.error(`\n  installer: ${installShPath}\n  workflow:  ${workflowPath}`);
  process.exit(1);
}

console.log(
  `OK release asset contract: ${installer.assets.length} binaries + ${installer.payloadAsset} + ` +
    `${installer.checksumsFile} agree between install.sh and release.yml`,
);
console.log(`   ${[...installer.assets, installer.payloadAsset].join("\n   ")}`);
