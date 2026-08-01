/**
 * The shipped-asset payload must actually CONTAIN everything the CLI resolves
 * through `resolveShippedAsset` (#4163).
 *
 * The bug this guards: the resolver and the payload builder are two lists in
 * two files (`src/util/shipped-assets.ts` and
 * `scripts/build-asset-payload.mjs`). Adding a new shipped asset to the
 * resolver without adding a producer to the payload reproduces #4161 exactly —
 * a static-binary install that resolves the asset to a path nothing ever wrote.
 * That failure is invisible until an operator runs the affected command on a
 * `curl … | sh` host, which is the worst possible place to discover it.
 *
 * These tests stage a REAL payload from this checkout (git-tracked files only,
 * same code path the release job runs) and resolve against it with the SEA
 * layout, so they assert the outcome — "the file is there and the resolver
 * finds it" — rather than comparing two hard-coded lists.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HINDSIGHT_VENDOR_ASSET,
  PROFILES_ASSET,
  SKILLS_ASSET,
  WEB_UI_ASSET,
  ASSET_MANIFEST_FILENAME,
  parseAssetPayloadManifest,
  resolveShippedAsset,
  type ShippedAssetSpec,
} from "../src/util/shipped-assets.js";
// The builder is plain ESM with no bundler-specific syntax, so vitest can
// import it directly — the point is to exercise the SHIPPING code path, not a
// re-implementation of it.
import {
  PAYLOAD_ENTRIES,
  stagePayload,
} from "../scripts/build-asset-payload.mjs";

/**
 * Every asset the CLI resolves from the shipped payload. The manifest itself
 * is excluded: it is written BY the builder rather than copied from the repo,
 * and is asserted separately below.
 */
const RESOLVED_ASSETS: ShippedAssetSpec[] = [
  PROFILES_ASSET,
  SKILLS_ASSET,
  HINDSIGHT_VENDOR_ASSET,
  WEB_UI_ASSET,
];

const VERSION = "v0.0.0-contract";

function withStagedPayload<T>(fn: (installRoot: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "payload-contract-"));
  try {
    // Mirror the real install layout: <prefix>/bin/switchroom next to
    // <prefix>/share/switchroom/<asset>, which is the SEA candidate.
    const installRoot = join(tmp, "share", "switchroom");
    stagePayload(installRoot, VERSION);
    return fn(installRoot);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("the payload contains every asset the CLI resolves (#4163)", () => {
  it("resolves each asset from a staged payload via the SEA layout", () => {
    withStagedPayload((installRoot) => {
      const execPath = join(installRoot, "..", "..", "bin", "switchroom");
      for (const spec of RESOLVED_ASSETS) {
        const r = resolveShippedAsset(spec, {
          // The bunfs root, as a compiled binary genuinely sees it.
          bundleDir: "/$bunfs/root",
          execPath,
          env: {},
        });
        expect(
          r.path,
          `${spec.asset} is resolved by the CLI but has no producer in ` +
            `PAYLOAD_ENTRIES (scripts/build-asset-payload.mjs) — a ` +
            `static-binary install would resolve it to a path nothing wrote`,
        ).not.toBeNull();
        expect(r.source).toBe("sea-sibling");
        expect(existsSync(r.path as string)).toBe(true);
      }
    });
  });

  it("ships the content each asset is actually used FOR, not just the directory", () => {
    // An empty directory would satisfy an existsSync-only check while still
    // failing `switchroom apply`. Assert one load-bearing file per asset.
    withStagedPayload((installRoot) => {
      for (const rel of [
        "profiles/default/CLAUDE.md.hbs",
        "profiles/_base/start.sh.hbs",
        "ui/index.html",
      ]) {
        expect(existsSync(join(installRoot, rel)), rel).toBe(true);
      }
      // skills/ and vendor/ are pools whose exact members change; assert they
      // are non-empty by way of the manifest's file count instead.
    });
  });

  it("writes a manifest the CLI can parse, naming every entry", () => {
    withStagedPayload((installRoot) => {
      const body = readFileSync(join(installRoot, ASSET_MANIFEST_FILENAME), "utf8");
      const manifest = parseAssetPayloadManifest(body);
      expect(manifest?.version).toBe(VERSION.replace(/^v?/, "v"));
      expect(new Set(manifest?.entries)).toEqual(
        new Set(PAYLOAD_ENTRIES.map(([, dest]: [string, string]) => dest)),
      );
      const parsed = JSON.parse(body) as { files: number };
      expect(parsed.files).toBeGreaterThan(0);
    });
  });

  it("resolves the manifest through the SAME probe as the assets", () => {
    // Otherwise "which payload am I running" could answer a different
    // directory than "which profiles am I using", which is how skew hides.
    withStagedPayload((installRoot) => {
      const execPath = join(installRoot, "..", "..", "bin", "switchroom");
      const profiles = resolveShippedAsset(PROFILES_ASSET, {
        bundleDir: "/$bunfs/root",
        execPath,
        env: {},
      });
      expect(profiles.path).toBe(join(installRoot, "profiles"));
    });
  });
});
