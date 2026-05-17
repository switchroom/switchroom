/**
 * Install-type detector for the switchroom update flow.
 *
 * Categorises how the currently-running switchroom CLI is installed so
 * downstream code (hostd audit, update flow, MCP introspection) can
 * decide whether `switchroom apply` should attempt a self-update,
 * delegate to `npm i -g`, or stay out of the way (docker / unknown).
 *
 * Pure function — performs only synchronous fs reads (existsSync /
 * lstatSync / readlinkSync) and never throws. Any error during
 * detection collapses to `"unknown"`.
 *
 * Probes:
 *   - `/usr/local/bin/switchroom`               — the globally-linked CLI
 *   - `$HOME/code/switchroom/dist/cli/switchroom.js` — source build artifact
 *     (matches the `bin` entry in this repo's package.json)
 *
 * Categories (decided in this order):
 *   - `binary`           — `/usr/local/bin/switchroom` exists AND is a
 *                          regular file OR a symlink whose target is NOT
 *                          under `$HOME/code/switchroom/` (e.g. npm-global
 *                          install path).
 *   - `source`           — `/usr/local/bin/switchroom` is a symlink AND
 *                          its target lives under
 *                          `$HOME/code/switchroom/dist/`.
 *   - `source-unlinked`  — the source build artifact exists but
 *                          `/usr/local/bin/switchroom` does not (developer
 *                          forgot to `npm link`).
 *   - `docker`           — neither artifact is present (running inside a
 *                          container with the CLI shipped elsewhere).
 *   - `unknown`          — any thrown error during probing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type InstallType =
  | "binary"
  | "source"
  | "source-unlinked"
  | "docker"
  | "unknown";

export interface InstallContext {
  install_type: InstallType;
  source_paths: { bin?: string; repo?: string };
}

const BIN_PATH = "/usr/local/bin/switchroom";

/**
 * Path to the source build artifact, derived from the project's
 * package.json `bin` entry (`./dist/cli/switchroom.js`). Anchored at
 * `$HOME/code/switchroom/` to match the canonical source-checkout
 * location.
 */
function sourceArtifactPath(): string {
  return path.join(os.homedir(), "code", "switchroom", "dist", "cli", "switchroom.js");
}

/**
 * Anchor for the source-build directory tree. Used to decide whether a
 * symlink target counts as a "source" install.
 */
function sourceDistPrefix(): string {
  return path.join(os.homedir(), "code", "switchroom", "dist") + path.sep;
}

export function detectInstallType(): InstallContext {
  try {
    const repoArtifact = sourceArtifactPath();
    const distPrefix = sourceDistPrefix();

    const binExists = fs.existsSync(BIN_PATH);
    const repoExists = fs.existsSync(repoArtifact);

    if (binExists) {
      const lst = fs.lstatSync(BIN_PATH);
      if (lst.isSymbolicLink()) {
        const target = fs.readlinkSync(BIN_PATH);
        const resolved = path.isAbsolute(target)
          ? target
          : path.resolve(path.dirname(BIN_PATH), target);
        if (resolved.startsWith(distPrefix)) {
          return {
            install_type: "source",
            source_paths: { bin: BIN_PATH, repo: repoExists ? repoArtifact : undefined },
          };
        }
        // Symlink to somewhere other than the source dist tree (e.g.
        // npm-global). Treat as a binary install.
        return {
          install_type: "binary",
          source_paths: { bin: BIN_PATH },
        };
      }
      // Regular file at /usr/local/bin/switchroom.
      return {
        install_type: "binary",
        source_paths: { bin: BIN_PATH },
      };
    }

    if (repoExists) {
      return {
        install_type: "source-unlinked",
        source_paths: { repo: repoArtifact },
      };
    }

    return { install_type: "docker", source_paths: {} };
  } catch {
    return { install_type: "unknown", source_paths: {} };
  }
}
