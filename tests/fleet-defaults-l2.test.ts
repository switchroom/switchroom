import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHostMountSources } from "../src/cli/apply.js";
import { renderFleetDefaultsClaudeMd } from "../src/agents/fleet-defaults.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * L2 fleet defaults (epic #1850 / issue #1855). `ensureHostMountSources`
 * seeds `~/.switchroom/fleet/CLAUDE.md` from `renderFleetDefaultsClaudeMd()`
 * with `writeIfMissing` semantics, so operator edits are never clobbered.
 */
function makeConfig(): SwitchroomConfig {
  return {
    agents: {},
    profiles: {},
    defaults: {},
    switchroom: {},
    telegram: { forum_chat_id: "0" },
  } as unknown as SwitchroomConfig;
}

describe("L2 fleet defaults seeding", () => {
  // ensureHostMountSources resolves the host home via
  // resolveHostHomeForCompose(), which prefers SWITCHROOM_HOST_HOME. Sandbox
  // that (not $HOME, which os.homedir() ignores on Linux).
  let origHostHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    origHostHome = process.env.SWITCHROOM_HOST_HOME;
    home = await mkdtemp(join(tmpdir(), "switchroom-l2-home-"));
    process.env.SWITCHROOM_HOST_HOME = home;
  });
  afterEach(() => {
    if (origHostHome !== undefined) process.env.SWITCHROOM_HOST_HOME = origHostHome;
    else delete process.env.SWITCHROOM_HOST_HOME;
  });

  it("seeds the canonical L2 content on a fresh apply", async () => {
    await ensureHostMountSources(makeConfig());
    const onDisk = await readFile(
      join(home, ".switchroom", "fleet", "CLAUDE.md"),
      "utf8",
    );
    expect(onDisk).toBe(renderFleetDefaultsClaudeMd());
  });

  it("does NOT overwrite an operator-customised file", async () => {
    const fleetDir = join(home, ".switchroom", "fleet");
    await mkdir(fleetDir, { recursive: true });
    const custom = "# My fleet brain\n\nHousehold: the router lives in the closet.\n";
    await writeFile(join(fleetDir, "CLAUDE.md"), custom, "utf8");

    await ensureHostMountSources(makeConfig());

    const onDisk = await readFile(join(fleetDir, "CLAUDE.md"), "utf8");
    expect(onDisk).toBe(custom);
  });
});

describe("L2 fleet defaults content invariants", () => {
  const content = renderFleetDefaultsClaudeMd();

  it("renders all five sections", () => {
    expect(content).toContain("## Operating principles");
    expect(content).toContain("## Privilege and approval map");
    expect(content).toContain("## Concision");
    expect(content).toContain("## Tool families");
    expect(content).toContain("## How your instructions stack");
  });

  it("carries the machine-readable version tag", () => {
    expect(content).toMatch(
      /<!-- switchroom-fleet-defaults-version: \d+\.\d+\.\d+.* -->/,
    );
  });

  it("contains no em-dash character (U+2014)", () => {
    expect(content.includes("—")).toBe(false);
  });

  it("does NOT duplicate the L1 Telegram 5-beats", () => {
    // Distinctive phrase from TELEGRAM_GUIDANCE in scaffold.ts (L1). The
    // 5-beats belong in switchroom-invariants.md, not here.
    expect(content).not.toContain("leave a trail of intent");
    expect(content).not.toContain("Five beats");
  });
});
