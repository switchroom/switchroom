/**
 * Shared parser for the release ASSET-NAME CONTRACT.
 *
 * Two files have to agree, forever, or the advertised `curl | sh` install is
 * dead: `install.sh` (which downloads `switchroom-<platform>-<arch>` plus a
 * checksums file from the release page) and `.github/workflows/release.yml`
 * (which produces and attaches them). They disagreed by omission for two
 * months — no workflow existed at all, every release shipped zero assets
 * (#3633).
 *
 * A comment saying "keep these in sync" is not a mechanism. This module
 * derives the contract from each side's real text so two consumers can assert
 * agreement deterministically:
 *
 *   - scripts/check-release-asset-names.mjs — static, runs in `npm run lint`.
 *   - scripts/verify-release-bundle.mjs     — runtime, runs in the release
 *                                             workflow over the real files.
 *
 * Every parser here FAILS LOUDLY when it cannot find what it is looking for.
 * If someone restructures `install.sh` past recognition, lint goes red and a
 * human updates the contract — which is the point. A parser that silently
 * matched nothing would re-create the exact "quietly broken" failure mode.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const INSTALL_SH_PATH = fileURLToPath(new URL("../install.sh", import.meta.url));
export const RELEASE_WORKFLOW_PATH = fileURLToPath(
  new URL("../.github/workflows/release.yml", import.meta.url),
);

/**
 * The two-space separator between hash and filename in `sha256sum` output.
 * `install.sh` matches its checksum line with `grep -F "  ${asset}"`, so the
 * separator is load-bearing: a single-space checksums file verifies nothing
 * and the installer dies with "No checksum entry".
 */
export const CHECKSUM_SEPARATOR = "  ";

class ContractError extends Error {}

function fail(message) {
  throw new ContractError(message);
}

/**
 * Derive what `install.sh` will ask the release page for.
 *
 * @param {string} text contents of install.sh
 * @returns {{assets: string[], platforms: string[], arches: string[],
 *            checksumsFile: string, template: string}}
 */
export function parseInstallerContract(text) {
  // `Linux) platform=linux ;;` / `Darwin) platform=macos ;;`
  const platforms = [...text.matchAll(/\bplatform=([A-Za-z0-9_.-]+)\s*;;/g)].map((m) => m[1]);
  if (platforms.length === 0) {
    fail("install.sh: found no `platform=<value> ;;` case arms — the platform contract cannot be derived");
  }

  // `x86_64|amd64) arch=amd64 ;;` / `aarch64|arm64) arch=arm64 ;;`
  const arches = [...text.matchAll(/\barch=([A-Za-z0-9_.-]+)\s*;;/g)].map((m) => m[1]);
  if (arches.length === 0) {
    fail("install.sh: found no `arch=<value> ;;` case arms — the arch contract cannot be derived");
  }

  // `asset="switchroom-${platform}-${arch}"`
  const assetLine = text.match(/\basset="([^"]*\$\{platform\}[^"]*\$\{arch\}[^"]*)"/);
  if (!assetLine) {
    fail(
      'install.sh: could not find `asset="…${platform}…${arch}…"`. If the asset name is now built ' +
        "differently, update scripts/release-assets.mjs to match — the workflow must emit whatever this builds.",
    );
  }
  const template = assetLine[1];

  const assets = [];
  for (const platform of platforms) {
    for (const arch of arches) {
      assets.push(template.replace("${platform}", platform).replace("${arch}", arch));
    }
  }

  // The checksums file, e.g. `switchroom-checksums.txt`. Every mention must
  // agree — the installer downloads it and then greps it by the same name.
  const checksumNames = new Set([...text.matchAll(/\b(switchroom-[A-Za-z0-9_.-]*\.txt)\b/g)].map((m) => m[1]));
  if (checksumNames.size === 0) {
    fail("install.sh: found no `switchroom-*.txt` checksums filename");
  }
  if (checksumNames.size > 1) {
    fail(`install.sh: ambiguous checksums filename — found ${[...checksumNames].join(", ")}`);
  }
  const checksumsFile = [...checksumNames][0];

  // The installer's fixed-string checksum lookup. Its literal leading spaces
  // are the format contract the workflow's `sha256sum` output must satisfy.
  const grepLine = text.match(/grep -F "(\s+)\$\{asset\}"/);
  if (!grepLine) {
    fail('install.sh: could not find the `grep -F "  ${asset}"` checksum lookup');
  }
  if (grepLine[1] !== CHECKSUM_SEPARATOR) {
    fail(
      `install.sh: checksum lookup separator is ${JSON.stringify(grepLine[1])} but the contract ` +
        `(sha256sum output) is ${JSON.stringify(CHECKSUM_SEPARATOR)}`,
    );
  }

  return { assets, platforms, arches, checksumsFile, template };
}

/**
 * Derive what `.github/workflows/release.yml` produces and attaches.
 *
 * @param {string} text contents of release.yml
 * @returns {{matrixAssets: string[], declaredAssets: string[], checksumsFile: string}}
 */
export async function parseWorkflowContract(text) {
  // `yaml` is imported lazily and ONLY on this path. The release workflow runs
  // scripts/verify-release-bundle.mjs on a bare checkout with no node_modules
  // (that job only hashes files); a top-level dependency import would make the
  // release fail at the last step for no reason.
  const { parse: parseYaml } = await import("yaml");
  const doc = parseYaml(text);
  if (!doc || typeof doc !== "object") fail("release.yml: not a YAML mapping");

  const targets = doc.jobs?.build?.strategy?.matrix?.target;
  if (!Array.isArray(targets) || targets.length === 0) {
    fail("release.yml: jobs.build.strategy.matrix.target is missing or empty");
  }
  const matrixAssets = targets.map((t, i) => {
    if (!t || typeof t.asset !== "string" || t.asset.length === 0) {
      fail(`release.yml: build matrix entry ${i} has no \`asset\` name`);
    }
    return t.asset;
  });

  const declared = doc.env?.RELEASE_ASSETS;
  if (typeof declared !== "string" || declared.trim().length === 0) {
    fail("release.yml: workflow-level env.RELEASE_ASSETS is missing or empty");
  }
  const declaredAssets = declared.trim().split(/\s+/);

  const checksumsFile = doc.env?.CHECKSUMS_FILE;
  if (typeof checksumsFile !== "string" || checksumsFile.length === 0) {
    fail("release.yml: workflow-level env.CHECKSUMS_FILE is missing or empty");
  }

  // The two-space checksum format the installer depends on comes from
  // `sha256sum`. If the workflow switches to another tool (shasum -a 256 emits
  // the same format; `openssl dgst` does not), that decision has to be made
  // deliberately — here.
  if (!/\bsha256sum\b/.test(text)) {
    fail(
      "release.yml: no `sha256sum` invocation found. install.sh matches checksum lines by their " +
        "two-space `<hash>  <name>` shape; a different digest tool must be verified to emit it.",
    );
  }

  return { matrixAssets, declaredAssets, checksumsFile };
}

/**
 * Read + parse the INSTALLER side only. Dependency-free (node stdlib), so the
 * release workflow can run the bundle verifier without an npm install.
 * Paths are overridable for tests.
 */
export function loadInstallerContract({
  installShPath = process.env.SWITCHROOM_INSTALL_SH_PATH || INSTALL_SH_PATH,
} = {}) {
  return { installShPath, installer: parseInstallerContract(readFileSync(installShPath, "utf-8")) };
}

/** Read + parse both sides. Paths are overridable for tests. */
export async function loadContracts({
  installShPath = process.env.SWITCHROOM_INSTALL_SH_PATH || INSTALL_SH_PATH,
  workflowPath = process.env.SWITCHROOM_RELEASE_WORKFLOW_PATH || RELEASE_WORKFLOW_PATH,
} = {}) {
  return {
    installShPath,
    workflowPath,
    installer: parseInstallerContract(readFileSync(installShPath, "utf-8")),
    workflow: await parseWorkflowContract(readFileSync(workflowPath, "utf-8")),
  };
}

/**
 * Compare the two contracts. Returns a list of human-readable problems;
 * empty means the installer and the workflow agree.
 */
export function diffContracts(installer, workflow) {
  const problems = [];
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const sorted = (xs) => [...xs].sort();

  if (!same(sorted(installer.assets), sorted(workflow.matrixAssets))) {
    problems.push(
      `install.sh downloads [${sorted(installer.assets).join(", ")}] but the release.yml build matrix ` +
        `produces [${sorted(workflow.matrixAssets).join(", ")}]`,
    );
  }
  if (!same(sorted(workflow.declaredAssets), sorted(workflow.matrixAssets))) {
    problems.push(
      `release.yml env.RELEASE_ASSETS [${sorted(workflow.declaredAssets).join(", ")}] does not match its own ` +
        `build matrix [${sorted(workflow.matrixAssets).join(", ")}] — the checksum + upload steps would ` +
        `then operate on a different set than was built`,
    );
  }
  if (installer.checksumsFile !== workflow.checksumsFile) {
    problems.push(
      `install.sh downloads checksums as '${installer.checksumsFile}' but release.yml publishes ` +
        `'${workflow.checksumsFile}'`,
    );
  }
  if (new Set(workflow.matrixAssets).size !== workflow.matrixAssets.length) {
    problems.push(`release.yml build matrix has duplicate asset names: [${workflow.matrixAssets.join(", ")}]`);
  }
  return problems;
}

export { ContractError };
