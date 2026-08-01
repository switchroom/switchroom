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
  assetPayloadSkew,
  parseAssetPayloadManifest,
  payloadInstallRoot,
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

// ─── payload version skew (#4163) ────────────────────────────────────────

describe("parseAssetPayloadManifest", () => {
  it("reads the version and normalises the v prefix", () => {
    expect(parseAssetPayloadManifest('{"version":"0.19.44"}')?.version).toBe("v0.19.44");
    expect(parseAssetPayloadManifest('{"version":"v0.19.44"}')?.version).toBe("v0.19.44");
  });

  it("keeps the entry list when present", () => {
    const m = parseAssetPayloadManifest(
      '{"version":"v1.2.3","entries":["profiles","skills",7]}',
    );
    expect(m?.entries).toEqual(["profiles", "skills"]);
  });

  it("returns null rather than a bogus version for unusable input", () => {
    // Each of these previously would have had to be handled by the caller;
    // null here is what makes assetPayloadSkew report `unreadable` instead of
    // silently treating garbage as agreement.
    for (const body of ["", "not json", "{}", '{"version":42}', '{"version":"latest"}']) {
      expect(parseAssetPayloadManifest(body)).toBeNull();
    }
  });
});

describe("assetPayloadSkew", () => {
  const SEA = { bundleDir: BUNFS, execPath: "/usr/local/bin/switchroom", env: {} };
  const MANIFEST = "/usr/local/share/switchroom/switchroom-assets.json";

  it("matches when the payload names the running release", () => {
    const skew = assetPayloadSkew({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: (p) => p === MANIFEST },
      readText: () => '{"version":"v0.19.44"}',
    });
    expect(skew.status).toBe("matched");
    expect(skew.ok).toBe(true);
    expect(skew.manifestPath).toBe(MANIFEST);
  });

  it("reports SKEWED — the silent failure — when the payload is another release", () => {
    const skew = assetPayloadSkew({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: (p) => p === MANIFEST },
      readText: () => '{"version":"v0.19.28"}',
    });
    expect(skew.status).toBe("skewed");
    expect(skew.ok).toBe(false);
    expect(skew.payloadVersion).toBe("v0.19.28");
    expect(skew.message).toContain("v0.19.28");
    expect(skew.message).toContain("v0.19.44");
  });

  it("reports MISSING and names every path it probed", () => {
    const skew = assetPayloadSkew({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: () => false },
    });
    expect(skew.status).toBe("missing");
    expect(skew.ok).toBe(false);
    expect(skew.candidates).toContain(MANIFEST);
    // #4160's lesson: name every location, not just the first.
    for (const c of skew.candidates) expect(skew.message).toContain(c);
  });

  it("reports UNREADABLE — never `matched` — for a corrupt manifest", () => {
    const skew = assetPayloadSkew({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: (p) => p === MANIFEST },
      readText: () => "{ truncated",
    });
    expect(skew.status).toBe("unreadable");
    expect(skew.ok).toBe(false);
  });

  it("treats a throwing reader as unreadable rather than propagating", () => {
    // doctor must not crash on an EACCES manifest.
    const skew = assetPayloadSkew({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: (p) => p === MANIFEST },
      readText: () => {
        throw new Error("EACCES");
      },
    });
    expect(skew.status).toBe("unreadable");
  });
});

describe("payloadInstallRoot", () => {
  it("is the FIRST SEA candidate the resolver probes — installer and resolver cannot disagree", () => {
    const execPath = "/opt/tools/bin/switchroom";
    const root = payloadInstallRoot(execPath);
    const candidates = shippedAssetCandidates(PROFILES_ASSET, {
      bundleDir: BUNFS,
      execPath,
    });
    // Skip the two bundle-relative candidates, which are bunfs garbage here.
    expect(candidates[2]).toBe(`${root}/profiles`);
  });
});

describe("symlinked share root (#4163)", () => {
  // The payload publishes `<prefix>/share/switchroom` as a SYMLINK to
  // `switchroom-<version>` so an update is an atomic rename. Consumers that do
  // a containment check then compared a realpath'd child against the symlink
  // path and refused — observed as `Invalid profile name: default`, which
  // failed every agent scaffold on a real `curl | sh` install.
  const EXEC = "/usr/local/bin/switchroom";
  const LINK = "/usr/local/share/switchroom/profiles";
  const REAL = "/usr/local/share/switchroom-0.19.44/profiles";

  const symlinked = {
    bundleDir: BUNFS,
    execPath: EXEC,
    env: {},
    exists: (p: string) => p === LINK,
    realpath: (p: string) => (p === LINK ? REAL : p),
  };

  it("returns the REAL path of a resolved candidate, not the symlink", () => {
    const res = resolveShippedAsset(PROFILES_ASSET, symlinked);
    expect(res.source).toBe("sea-sibling");
    expect(res.path).toBe(REAL);
  });

  it("still reports the probed (symlink) paths in candidates for diagnostics", () => {
    const res = resolveShippedAsset(PROFILES_ASSET, symlinked);
    expect(res.candidates).toContain(LINK);
  });

  it("canonicalises an env override too", () => {
    const res = resolveShippedAsset(PROFILES_ASSET, {
      ...symlinked,
      env: { [PROFILES_ASSET.envVar]: LINK },
    });
    expect(res.source).toBe("env");
    expect(res.path).toBe(REAL);
  });

  it("falls back to the literal path when realpath throws", () => {
    const res = resolveShippedAsset(PROFILES_ASSET, {
      ...symlinked,
      realpath: () => {
        throw new Error("EACCES");
      },
    });
    expect(res.path).toBe(LINK);
  });
});
