/**
 * Outcome tests for the per-agent scratch volume.
 *
 * Every assertion here is anchored on an observable outcome — a line in the
 * generated compose file, an env value, a directory on disk, a chown call —
 * rather than on a code path. Specifically:
 *
 *   - drop the mount line and the "non-admin agent gets it" and per-agent
 *     isolation tests fail;
 *   - drop or rename ONE env redirect and the redirect table test fails,
 *     naming the variable;
 *   - make the feature fire on a host with no bulk volume and the
 *     degradation tests fail;
 *   - drop the chown and the ownership test fails (via the injected seam, so
 *     it fails on an unprivileged CI runner too);
 *   - re-route this through `bind_mounts:` and the non-admin tests throw,
 *     because that key is an admin-only escalation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose } from "./compose.js";
import { allocateAgentUid } from "./agent-uid.js";
import {
  DEFAULT_SCRATCH_SUBDIR,
  SCRATCH_CONTAINER_DIR,
  SCRATCH_SUBDIRS,
  agentScratchHostDir,
  ensureAgentScratchDirs,
  resolveScratchConfig,
  scratchEnv,
} from "./scratch.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** Absolute path that cannot exist — the "single-disk dev machine" host. */
const NO_SUCH_VOLUME = "/nonexistent-switchroom-bulk-volume";

let volume: string;

beforeEach(() => {
  volume = mkdtempSync(join(tmpdir(), "switchroom-scratch-test-"));
});

afterEach(() => {
  rmSync(volume, { recursive: true, force: true });
});

function baseConfig(scratch?: Record<string, unknown>): SwitchroomConfig {
  return {
    agents: {
      // NOT admin, NOT root — the case the whole design exists for. carrie
      // and clerk on the reference fleet are the biggest cache consumers and
      // neither is admin, so a `bind_mounts:`-based implementation would
      // throw for exactly these agents.
      carrie: { profile: "default", claudeAccount: "default" },
      clerk: { profile: "default", claudeAccount: "default" },
    },
    profiles: {},
    defaults: {},
    switchroom: { agents_dir: "/home/op/.switchroom/agents" },
    telegram: { forum_chat_id: "0" },
    ...(scratch ? { scratch } : {}),
  } as unknown as SwitchroomConfig;
}

function gen(config: SwitchroomConfig, warn: (m: string) => void = () => {}): string {
  return generateCompose({
    config,
    homeDir: "/home/op",
    // Keep the generator from touching the host: `homeDir` alone would flip
    // `precreateHostDirs` on and mkdir under a real /home/op.
    precreateHostDirs: false,
    warn,
  });
}

/** Slice the compose text for one agent's service block. */
function serviceBlock(yaml: string, agent: string): string {
  const start = yaml.indexOf(`  agent-${agent}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = yaml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("scratch volume — mount injection", () => {
  it("a NON-ADMIN agent gets the scratch bind mount (the reason this is framework-injected)", () => {
    const yaml = gen(baseConfig({ volume }));
    const carrie = serviceBlock(yaml, "carrie");

    expect(carrie).toContain(
      `- ${join(volume, DEFAULT_SCRATCH_SUBDIR, "carrie")}:${SCRATCH_CONTAINER_DIR}:rw`,
    );
    // And it did NOT arrive via the operator-facing escalation.
    expect(baseConfig({ volume }).agents.carrie).not.toHaveProperty("bind_mounts");
  });

  it("declaring the same thing via bind_mounts on a non-admin agent still throws — the escalation was not weakened", () => {
    const config = baseConfig({ volume });
    (config.agents.carrie as unknown as Record<string, unknown>).bind_mounts = [
      { source: volume, target: "/scratch" },
    ];
    expect(() => gen(config)).toThrow(/admin-only escalation/);
  });

  it("each agent sees only its OWN scratch dir, never a sibling's and never the shared parent", () => {
    const yaml = gen(baseConfig({ volume }));
    const carrie = serviceBlock(yaml, "carrie");
    const clerk = serviceBlock(yaml, "clerk");

    expect(carrie).toContain(join(volume, DEFAULT_SCRATCH_SUBDIR, "carrie"));
    expect(carrie).not.toContain(join(volume, DEFAULT_SCRATCH_SUBDIR, "clerk"));
    expect(clerk).toContain(join(volume, DEFAULT_SCRATCH_SUBDIR, "clerk"));
    expect(clerk).not.toContain(join(volume, DEFAULT_SCRATCH_SUBDIR, "carrie"));

    // The shared parent is never a bind source on its own.
    expect(yaml).not.toContain(
      `- ${join(volume, DEFAULT_SCRATCH_SUBDIR)}:${SCRATCH_CONTAINER_DIR}`,
    );
  });

  it("honours an operator-configured subdir", () => {
    const yaml = gen(baseConfig({ volume, subdir: "caches" }));
    expect(yaml).toContain(
      `- ${join(volume, "caches", "carrie")}:${SCRATCH_CONTAINER_DIR}:rw`,
    );
  });
});

describe("scratch volume — env redirects", () => {
  it("every cache env var points inside the mount, so caches actually land there", () => {
    const yaml = gen(baseConfig({ volume }));
    const carrie = serviceBlock(yaml, "carrie");

    const expected: Record<string, string> = {
      SWITCHROOM_AGENT_SCRATCH: "/scratch",
      XDG_CACHE_HOME: "/scratch/cache",
      TMPDIR: "/scratch/tmp",
      npm_config_cache: "/scratch/cache/npm",
      BUN_INSTALL_CACHE_DIR: "/scratch/cache/bun",
      PYTHONUSERBASE: "/scratch/python",
      PLAYWRIGHT_BROWSERS_PATH: "/scratch/cache/ms-playwright",
      PUPPETEER_CACHE_DIR: "/scratch/cache/puppeteer",
    };
    for (const [k, v] of Object.entries(expected)) {
      expect(carrie, `missing cache redirect ${k}`).toContain(`${k}: "${v}"`);
    }
    // The table above IS the contract: a new redirect added to scratchEnv
    // without a matching expectation here fails, so the test can't silently
    // stop covering a variable.
    expect(Object.keys(scratchEnv()).sort()).toEqual(Object.keys(expected).sort());
  });

  it("overrides the image's baked PLAYWRIGHT_BROWSERS_PATH, which otherwise keeps browsers on the root disk", () => {
    // Anchored on the real image: Dockerfile.agent bakes the browsers path at
    // a HOME (root-disk) location, and playwright ignores XDG_CACHE_HOME, so
    // the umbrella redirect alone would leave ~150MB+ per version behind.
    const dockerfile = readFileSync(
      join(import.meta.dirname, "..", "..", "docker", "Dockerfile.agent"),
      "utf-8",
    );
    const baked = /^ENV PLAYWRIGHT_BROWSERS_PATH=(.+)$/m.exec(dockerfile)?.[1];
    expect(baked, "Dockerfile.agent no longer bakes PLAYWRIGHT_BROWSERS_PATH").toBeTruthy();
    expect(baked).toContain("/state/agent/home");

    const carrie = serviceBlock(gen(baseConfig({ volume })), "carrie");
    expect(carrie).toContain('PLAYWRIGHT_BROWSERS_PATH: "/scratch/cache/ms-playwright"');
    expect(carrie).not.toContain(`PLAYWRIGHT_BROWSERS_PATH: "${baked}"`);
  });

  it("leaves NPM_CONFIG_PREFIX (global install prefix, not a cache) on the persistent HOME", () => {
    const carrie = serviceBlock(gen(baseConfig({ volume })), "carrie");
    expect(carrie).toContain('NPM_CONFIG_PREFIX: "/state/agent/home/.npm-global"');
  });

  it("an operator env: key cannot half-shadow the redirect set", () => {
    const config = baseConfig({ volume });
    (config.agents.carrie as unknown as Record<string, unknown>).env = {
      TMPDIR: "/state/agent/home/tmp",
    };
    const carrie = serviceBlock(gen(config), "carrie");
    expect(carrie).toContain('TMPDIR: "/scratch/tmp"');
    expect(carrie).not.toContain('TMPDIR: "/state/agent/home/tmp"');
  });
});

describe("scratch volume — degradation when there is no bulk volume", () => {
  it("emits NO mount and NO env redirect when the volume does not exist", () => {
    const yaml = gen(baseConfig({ volume: NO_SUCH_VOLUME }));

    expect(yaml).not.toContain(`:${SCRATCH_CONTAINER_DIR}:rw`);
    expect(yaml).not.toContain(NO_SUCH_VOLUME);
    for (const k of Object.keys(scratchEnv())) {
      expect(yaml, `${k} leaked without a scratch mount`).not.toContain(`${k}: "/scratch`);
    }
    // The pre-existing HOME-cache behaviour is untouched: with no scratch
    // volume the compose file sets NO cache env at all, so the image's baked
    // PLAYWRIGHT_BROWSERS_PATH (Dockerfile.agent) keeps winning.
    expect(yaml).not.toContain("PLAYWRIGHT_BROWSERS_PATH");
  });

  it("output with no bulk volume is byte-identical to output with no scratch block at all", () => {
    expect(gen(baseConfig({ volume: NO_SUCH_VOLUME }))).toBe(gen(baseConfig()));
  });

  it("warns when an EXPLICIT scratch block names a volume that isn't there", () => {
    const warnings: string[] = [];
    gen(baseConfig({ volume: NO_SUCH_VOLUME }), (m) => warnings.push(m));
    expect(warnings.join("\n")).toContain(NO_SUCH_VOLUME);
  });

  it("stays SILENT on a single-disk machine with no scratch block (the dev-machine default)", () => {
    const warnings: string[] = [];
    gen(baseConfig(), (m) => warnings.push(m));
    expect(warnings.join("\n")).not.toMatch(/scratch/i);
  });

  it("enabled: false opts out even when the volume IS mounted", () => {
    const yaml = gen(baseConfig({ volume, enabled: false }));
    expect(yaml).not.toContain(`:${SCRATCH_CONTAINER_DIR}:rw`);
    expect(yaml).not.toContain('SWITCHROOM_AGENT_SCRATCH');
  });

  it("a file (not a directory) at the volume path does not engage the feature", () => {
    const cfg = resolveScratchConfig({ scratch: { volume: "/etc/hostname" } });
    expect(agentScratchHostDir(cfg, "carrie")).toBeNull();
  });
});

describe("scratch volume — host directory creation and ownership", () => {
  it("creates the per-agent dir plus its subdirs, chowned to that agent's container uid", () => {
    const chowns: Array<[string, number, number]> = [];
    const cfg = resolveScratchConfig({ scratch: { volume } });

    ensureAgentScratchDirs(cfg, ["carrie", "clerk"], (p, uid, gid) =>
      chowns.push([p, uid, gid]),
    );

    for (const agent of ["carrie", "clerk"]) {
      const dir = join(volume, DEFAULT_SCRATCH_SUBDIR, agent);
      const uid = allocateAgentUid(agent);
      expect(existsSync(dir)).toBe(true);
      expect(chowns).toContainEqual([dir, uid, uid]);
      for (const sub of SCRATCH_SUBDIRS) {
        expect(existsSync(join(dir, sub))).toBe(true);
        expect(chowns).toContainEqual([join(dir, sub), uid, uid]);
      }
    }
    // Two different agents must not share a uid-owned directory.
    expect(allocateAgentUid("carrie")).not.toBe(allocateAgentUid("clerk"));
  });

  it("TMPDIR's target directory exists after creation — a missing TMPDIR breaks mkdtemp in every toolchain", () => {
    const cfg = resolveScratchConfig({ scratch: { volume } });
    ensureAgentScratchDirs(cfg, ["carrie"], () => {});
    const tmpTarget = join(volume, DEFAULT_SCRATCH_SUBDIR, "carrie", "tmp");
    expect(existsSync(tmpTarget)).toBe(true);
    expect(scratchEnv().TMPDIR).toBe(`${SCRATCH_CONTAINER_DIR}/tmp`);
  });

  it("creates nothing when there is no bulk volume", () => {
    const cfg = resolveScratchConfig({ scratch: { volume: NO_SUCH_VOLUME } });
    const chowns: string[] = [];
    expect(ensureAgentScratchDirs(cfg, ["carrie"], (p) => chowns.push(p))).toEqual([]);
    expect(chowns).toEqual([]);
    expect(existsSync(NO_SUCH_VOLUME)).toBe(false);
  });

  it("refuses an agent name that could escape the volume", () => {
    const cfg = resolveScratchConfig({ scratch: { volume } });
    expect(agentScratchHostDir(cfg, "../../etc")).toBeNull();
    expect(agentScratchHostDir(cfg, "/etc")).toBeNull();
  });
});

describe("scratch volume — config resolution", () => {
  it("defaults to the documented bulk mountpoint and subdir", () => {
    const cfg = resolveScratchConfig({});
    expect(cfg.volume).toBe("/mnt/bulkdata");
    expect(cfg.subdir).toBe(DEFAULT_SCRATCH_SUBDIR);
    expect(cfg.enabled).toBe(true);
    expect(cfg.explicit).toBe(false);
  });

  it("marks an operator-written block as explicit so a bad path can be warned about", () => {
    expect(resolveScratchConfig({ scratch: {} }).explicit).toBe(true);
  });
});
