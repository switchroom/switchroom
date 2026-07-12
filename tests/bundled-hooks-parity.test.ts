import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSettingsHooksBlock,
  DOCKER_BUNDLED_HOOKS_PATH,
} from "../src/agents/scaffold.js";
import type { AgentConfig } from "../src/config/schema.js";

/**
 * Registration parity for BUNDLED hooks (PR #3159 review, pre-existing gap).
 *
 * A hook registered in the scaffold's settings.json from the bundled-hooks
 * path (/opt/switchroom/hooks) only exists at runtime when BOTH:
 *   (a) scripts/build.mjs bundles src/cli/<name>.ts -> dist/cli/<name>.mjs
 *   (b) docker/Dockerfile.agent COPYs dist/cli/<name>.mjs into the image
 * A missing leg means settings.json points at a file that isn't there and
 * Claude Code silently never fires the hook — the exact #1811 failure class.
 * This test derives the list from the scaffold (the single source of truth
 * for what agents load) and string-scans the other two files, so adding a
 * bundled hook without all three legs fails here instead of in production.
 */
describe("bundled hooks parity (scaffold ⇄ build.mjs ⇄ Dockerfile.agent)", () => {
  const agentConfig = {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
  } as unknown as AgentConfig;

  const hooksBlock = buildSettingsHooksBlock({
    agentName: "parity-agent",
    agentConfig,
    hindsightEnabled: true,
    useSwitchroomPlugin: true,
  });

  // Every command string across every hook event.
  const commands: string[] = Object.values(hooksBlock).flatMap((entries) =>
    (entries as Array<{ hooks: Array<{ command: string }> }>).flatMap((e) =>
      e.hooks.map((h) => h.command),
    ),
  );

  // Bundled-hook filenames referenced from settings.json.
  const bundledRe = new RegExp(
    `${DOCKER_BUNDLED_HOOKS_PATH.replace(/\//g, "\\/")}\\/([a-z0-9-]+\\.mjs)`,
    "g",
  );
  const bundledNames = [
    ...new Set(
      commands.flatMap((c) => [...c.matchAll(bundledRe)].map((m) => m[1]!)),
    ),
  ];

  const buildMjs = readFileSync(join(process.cwd(), "scripts", "build.mjs"), "utf-8");
  const dockerfile = readFileSync(
    join(process.cwd(), "docker", "Dockerfile.agent"),
    "utf-8",
  );

  it("finds a non-trivial set of bundled hooks in the scaffold output", () => {
    // Guard against the scan going vacuous after a refactor: as of #3159
    // there are 6+ (drive-write, ms-365-write, notion-write, skill-validate,
    // hindsight-mental-model, self-improve-stop, self-improve-apply-guard,
    // foreground-hog).
    expect(bundledNames.length).toBeGreaterThanOrEqual(6);
    expect(bundledNames).toContain("foreground-hog-pretool.mjs");
  });

  it("every scaffold-registered bundled hook is bundled by scripts/build.mjs", () => {
    for (const name of bundledNames) {
      const src = `src/cli/${name.replace(/\.mjs$/, ".ts")}`;
      expect(buildMjs, `build.mjs must bundle ${src}`).toContain(src);
      expect(buildMjs, `build.mjs must emit ${name}`).toContain(name);
    }
  });

  it("every scaffold-registered bundled hook is COPY'd by Dockerfile.agent", () => {
    for (const name of bundledNames) {
      expect(
        dockerfile,
        `Dockerfile.agent must ship ${name} to ${DOCKER_BUNDLED_HOOKS_PATH}`,
      ).toContain(`COPY dist/cli/${name} ${DOCKER_BUNDLED_HOOKS_PATH}/${name}`);
    }
  });
});
