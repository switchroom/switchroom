import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  HINDSIGHT_VENDOR_ASSET,
  PROFILES_ASSET,
  SKILLS_ASSET,
  describeShippedAssetSearch,
  resolveShippedAsset,
  shippedAssetCandidates,
} from "./shipped-assets.js";

/**
 * #4160 / #4161. The published `bun build --compile` binary sees
 * `import.meta.dirname === "/$bunfs/root"` (verified against a real
 * compiled probe), so `resolve(import.meta.dirname, "../../profiles")`
 * is `/profiles` and `resolve(import.meta.dirname, "../../skills")` is
 * `/skills` — neither has ever existed on any host. `switchroom apply`
 * failed for EVERY agent and `sync-bundled-skills` silently no-op'd.
 *
 * Every test here drives the resolver with an injected `exists`, so the
 * layouts (SEA, npm/dev, Docker image) are exercised for real instead of
 * being asserted about.
 */

const BUNFS = "/$bunfs/root";

/** An `exists` probe that answers true for exactly these paths. */
const only = (...present: string[]) => {
  const set = new Set(present);
  return (p: string): boolean => set.has(p);
};

describe("resolveShippedAsset — SEA (bun build --compile) layout", () => {
  const seaProbe = {
    bundleDir: BUNFS,
    execPath: "/usr/local/bin/switchroom",
    env: {},
  };

  it("never lands on the historically-broken /profiles when nothing exists", () => {
    // The pre-fix fall-through returned candidates[0] === "/profiles".
    const r = resolveShippedAsset(PROFILES_ASSET, {
      ...seaProbe,
      exists: () => false,
    });
    expect(r.path).toBeNull();
    expect(r.source).toBe("none");
  });

  it("finds profiles staged beside the binary at <prefix>/share/switchroom", () => {
    const staged = "/usr/local/share/switchroom/profiles";
    const r = resolveShippedAsset(PROFILES_ASSET, {
      ...seaProbe,
      exists: only(staged),
    });
    expect(r.path).toBe(staged);
    // /usr/local/bin/switchroom -> ../share/switchroom is the FIRST
    // execPath-derived candidate, so it wins before the absolute FHS list.
    expect(r.source).toBe("sea-sibling");
  });

  it("finds skills under an absolute FHS share root for a binary elsewhere", () => {
    const r = resolveShippedAsset(SKILLS_ASSET, {
      bundleDir: BUNFS,
      execPath: "/opt/tools/switchroom",
      env: {},
      exists: only("/usr/share/switchroom/skills"),
    });
    expect(r.path).toBe("/usr/share/switchroom/skills");
    expect(r.source).toBe("fhs");
  });

  it("still produces the FHS candidates when execPath is unavailable", () => {
    const candidates = shippedAssetCandidates(SKILLS_ASSET, {
      bundleDir: BUNFS,
      execPath: "",
    });
    expect(candidates).toContain("/usr/local/share/switchroom/skills");
    expect(candidates).toContain("/usr/share/switchroom/skills");
  });
});

describe("resolveShippedAsset — layouts that already worked must keep working", () => {
  it("npm / dev: <pkg>/dist/cli -> <pkg>/<asset>", () => {
    const r = resolveShippedAsset(PROFILES_ASSET, {
      bundleDir: "/srv/app/node_modules/switchroom/dist/cli",
      execPath: "/usr/local/bin/node",
      env: {},
      exists: only("/srv/app/node_modules/switchroom/profiles"),
    });
    expect(r.path).toBe("/srv/app/node_modules/switchroom/profiles");
    expect(r.source).toBe("npm");
  });

  it("agent / hostd Docker image: /opt/switchroom -> /opt/switchroom/<asset>", () => {
    const r = resolveShippedAsset(SKILLS_ASSET, {
      bundleDir: "/opt/switchroom",
      execPath: "/usr/local/bin/bun",
      env: {},
      exists: only("/opt/switchroom/skills"),
    });
    expect(r.path).toBe("/opt/switchroom/skills");
    expect(r.source).toBe("image");
  });

  it("prefers the npm candidate over the image one when BOTH exist", () => {
    // Ordering is load-bearing: a source checkout has <repo>/profiles at
    // ../.. and must not be shadowed by a stray adjacent dir.
    const r = resolveShippedAsset(PROFILES_ASSET, {
      bundleDir: "/repo/dist/cli",
      execPath: "/usr/local/bin/bun",
      env: {},
      exists: only("/repo/profiles", "/repo/dist/cli/profiles"),
    });
    expect(r.path).toBe("/repo/profiles");
  });

  it("handles a nested asset path (vendor/hindsight-memory)", () => {
    const r = resolveShippedAsset(HINDSIGHT_VENDOR_ASSET, {
      bundleDir: BUNFS,
      execPath: "/usr/local/bin/switchroom",
      env: {},
      exists: only("/usr/local/share/switchroom/vendor/hindsight-memory"),
    });
    expect(r.path).toBe("/usr/local/share/switchroom/vendor/hindsight-memory");
  });
});

describe("resolveShippedAsset — env override", () => {
  it("wins outright and is not existence-checked", () => {
    const r = resolveShippedAsset(PROFILES_ASSET, {
      bundleDir: "/repo/dist/cli",
      execPath: "/usr/local/bin/bun",
      env: { [PROFILES_ASSET.envVar]: "/tmp/my-profiles" },
      exists: only("/repo/profiles"),
    });
    expect(r.path).toBe(resolve("/tmp/my-profiles"));
    expect(r.source).toBe("env");
  });

  it("each asset has its own override key", () => {
    expect(PROFILES_ASSET.envVar).toBe("SWITCHROOM_PROFILES_ROOT");
    expect(SKILLS_ASSET.envVar).toBe("SWITCHROOM_SKILLS_ROOT");
    expect(
      new Set([
        PROFILES_ASSET.envVar,
        SKILLS_ASSET.envVar,
        HINDSIGHT_VENDOR_ASSET.envVar,
      ]).size,
    ).toBe(3);
  });
});

describe("failure reporting names every path tried (#4160)", () => {
  it("lists all candidates, not just the first", () => {
    const r = resolveShippedAsset(PROFILES_ASSET, {
      bundleDir: BUNFS,
      execPath: "/usr/local/bin/switchroom",
      env: {},
      exists: () => false,
    });
    const described = describeShippedAssetSearch(r);
    // The pre-fix message was "searched /profiles" and nothing else —
    // an operator staging profiles anywhere plausible was told switchroom
    // had looked in a place it never could have found them.
    expect(r.candidates.length).toBeGreaterThanOrEqual(4);
    for (const c of r.candidates) expect(described).toContain(c);
    expect(described).toContain("/usr/local/share/switchroom/profiles");
    expect(described).toContain("/usr/share/switchroom/profiles");
  });

  it("de-duplicates candidates so the list stays honest", () => {
    // /usr/local/bin/switchroom's sibling candidate IS
    // /usr/local/share/switchroom/<asset>, which is also an FHS root.
    const candidates = shippedAssetCandidates(SKILLS_ASSET, {
      bundleDir: BUNFS,
      execPath: "/usr/local/bin/switchroom",
    });
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("the real repo layout still resolves (no simulation)", () => {
  // Outcome check against this checkout: the resolver must find the
  // genuine shipped payloads from the vitest bundle dir.
  const devProbe = { bundleDir: join(import.meta.dirname, "..", "cli"), execPath: process.execPath };

  it("resolves profiles/ and it contains the default profile", () => {
    const r = resolveShippedAsset(PROFILES_ASSET, { ...devProbe, env: {} });
    expect(r.path).not.toBeNull();
    expect(existsSync(join(r.path as string, "default"))).toBe(true);
  });

  it("resolves skills/", () => {
    const r = resolveShippedAsset(SKILLS_ASSET, { ...devProbe, env: {} });
    expect(r.path).not.toBeNull();
    expect(existsSync(r.path as string)).toBe(true);
  });
});
