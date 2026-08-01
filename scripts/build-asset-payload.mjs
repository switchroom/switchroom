#!/usr/bin/env node
/**
 * Build the shipped-asset payload tarball (#4163).
 *
 * WHY THIS EXISTS
 *
 * `bun build --compile` embeds the JS bundle in a virtual bunfs and NOTHING
 * else. `profiles/`, `skills/`, `vendor/hindsight-memory/` and the web UI are
 * plain directories the CLI reads at runtime, so the four release binaries
 * shipped an install that could not scaffold a single agent: `switchroom
 * apply` died with `Profile not found: default`. #4162 taught every call site
 * to PROBE `<prefix>/share/switchroom/<asset>`; this script produces the thing
 * that lands there.
 *
 * WHAT GOES IN, AND WHAT DELIBERATELY DOES NOT
 *
 * Exactly the directories a host-side CLI reads off disk at runtime — see
 * PAYLOAD_ENTRIES. `bin/` is NOT one of them: every `bin/*.sh` consumer is the
 * agent container, which gets them from `/opt/switchroom/bin` (COPYed by
 * Dockerfile.agent, referenced through `DOCKER_BIN_PATH` in scaffold.ts).
 * `examples/` is not either: `src/cli/embedded-examples.ts` bundles the YAML
 * into the binary as `with { type: "text" }` imports. Shipping a payload
 * directory nothing reads is how a payload rots without anyone noticing.
 *
 * ONLY GIT-TRACKED FILES SHIP. The file list comes from `git ls-files`, so a
 * stray `__pycache__/`, a local `.env`, a build artifact or an editor swap
 * file in a maintainer's checkout can never end up on the release page. It
 * also makes the tarball reproducible from a tag.
 *
 * THE MANIFEST IS THE ANTI-SKEW MECHANISM. `switchroom-assets.json` at the
 * payload root records the version this payload was cut from. `switchroom
 * update` refuses to leave a host where that version disagrees with the
 * installed binary's, and `switchroom doctor` reports the skew. A payload
 * with no manifest is treated as unknown-version, i.e. skewed.
 *
 * Usage:
 *   node scripts/build-asset-payload.mjs --version <vX.Y.Z> --out <file.tar.gz>
 *   node scripts/build-asset-payload.mjs --version <vX.Y.Z> --stage-only <dir>
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The payload contents, as `[repo path, path inside the payload]`.
 *
 * The destination names are what `src/util/shipped-assets.ts` probes for, so
 * these two lists are one contract — `tests/asset-payload-contract.test.ts`
 * asserts every `ShippedAssetSpec.asset` the CLI resolves has a producer here.
 */
export const PAYLOAD_ENTRIES = [
  // Handlebars templates for every agent scaffold (`switchroom apply`).
  ["profiles", "profiles"],
  // Bundled skills pool, mirrored to ~/.switchroom/skills/_bundled.
  ["skills", "skills"],
  // The hindsight-memory plugin installed into each agent's .claude/plugins.
  ["vendor/hindsight-memory", "vendor/hindsight-memory"],
  // Web dashboard static assets. `npm run build` copies these to dist/cli/ui;
  // the compiled binary has no such sibling, so `switchroom web` served a
  // 404-only dashboard from a static-binary install.
  ["src/web/ui", "ui"],
];

/** Filename of the version manifest at the payload root. */
export const ASSET_MANIFEST_FILENAME = "switchroom-assets.json";

/** Every git-tracked file under `dir`, repo-relative. Throws if empty. */
function trackedFiles(dir) {
  const out = execFileSync("git", ["ls-files", "-z", "--", dir], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = out.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error(
      `asset payload: \`git ls-files -- ${dir}\` returned nothing. The payload ` +
        `would ship without ${dir}, and every install would be broken in exactly ` +
        `the way #4163 is about. Refusing to build.`,
    );
  }
  return files;
}

/**
 * Stage the payload into `stageDir` (created if absent) and write the
 * manifest. Returns the manifest object.
 */
export function stagePayload(stageDir, version) {
  mkdirSync(stageDir, { recursive: true });
  let fileCount = 0;
  for (const [src, dest] of PAYLOAD_ENTRIES) {
    for (const rel of trackedFiles(src)) {
      // rel is repo-relative and starts with `src`; re-root it under `dest`.
      const suffix = rel.slice(src.length).replace(/^\//, "");
      const target = join(stageDir, dest, suffix);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(REPO_ROOT, rel), target, { dereference: true });
      fileCount += 1;
    }
  }
  const manifest = {
    // `vX.Y.Z`. Compared against the CLI's own version by
    // `assetPayloadSkew()` in src/util/shipped-assets.ts.
    version: version.startsWith("v") ? version : `v${version}`,
    entries: PAYLOAD_ENTRIES.map(([, dest]) => dest),
    files: fileCount,
  };
  writeFileSync(
    join(stageDir, ASSET_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/** Stage + tar. Returns the manifest. */
export function buildPayloadTarball(outFile, version) {
  const stage = mkdtempSync(join(tmpdir(), "switchroom-assets-"));
  try {
    const manifest = stagePayload(stage, version);
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    // Deterministic-ish: sorted names, fixed owner, no per-file mtime noise
    // beyond the checkout's. GNU tar flags; the release job runs on ubuntu.
    execFileSync(
      "tar",
      [
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        resolve(outFile),
        "-C",
        stage,
        ".",
      ],
      { stdio: "inherit" },
    );
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const version = argValue("--version");
  if (!version) {
    console.error("usage: build-asset-payload.mjs --version <vX.Y.Z> (--out <file.tar.gz> | --stage-only <dir>)");
    process.exit(2);
  }
  const stageOnly = argValue("--stage-only");
  if (stageOnly) {
    const m = stagePayload(resolve(stageOnly), version);
    console.log(`staged ${m.files} files (${m.version}) -> ${resolve(stageOnly)}`);
  } else {
    const out = argValue("--out");
    if (!out) {
      console.error("build-asset-payload.mjs: --out or --stage-only is required");
      process.exit(2);
    }
    const m = buildPayloadTarball(out, version);
    console.log(`built ${resolve(out)}: ${m.files} files, version ${m.version}`);
  }
}
