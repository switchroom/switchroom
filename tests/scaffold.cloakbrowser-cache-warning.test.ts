/**
 * #TBD — the rendered start.sh must warn (non-fatally) when the shared
 * cloakbrowser Chromium cache is missing.
 *
 * Background: switchroom intends every agent to share ONE ~700MB stealth
 * Chromium via a read-only bind mount. Before this change the mount was
 * silently inert (the probe pointed at `~/.cloakbrowser`, outside the only
 * subtree hostd can see), and every agent quietly downloaded its own private
 * copy — 5 agents × 697MB observed on the live host. Nothing anywhere said so.
 *
 * The image now pins CLOAKBROWSER_CACHE_DIR to a root-owned image path, so a
 * missing mount can no longer self-heal into a private copy (cloakbrowser
 * aborts with `[Errno 13] Permission denied`). That makes the boot warning the
 * operator's only signal — so it is asserted here, not left to review.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

describe("start.sh: shared cloakbrowser cache boot warning (#TBD)", () => {
  let tmpDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-cloakbrowser-warn-"));
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("warns to stderr when no chromium-* is present in the cache dir", () => {
    const name = "carrie";
    const config = { extends: "default", topic_name: "T", schedule: [] } as unknown as AgentConfig;
    const switchroomConfig = {
      switchroom: { version: 1, agents_dir: "~/.switchroom/agents", skills_dir: "~/.switchroom/skills" },
      telegram: telegramConfig,
      agents: { [name]: config },
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent(
      name,
      config,
      join(tmpDir, ".switchroom", "agents"),
      telegramConfig,
      switchroomConfig,
    );
    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");

    // Probes the image-pinned cache dir (with the same default the Dockerfile
    // bakes, so an older image without the ENV still gets a truthful probe).
    expect(startSh).toContain(
      'sr_cb_dir="${CLOAKBROWSER_CACHE_DIR:-/opt/switchroom/cloakbrowser-cache}"',
    );
    expect(startSh).toContain('ls -d "$sr_cb_dir"/chromium-*/');
    // Warns, on stderr, with the working repair command.
    expect(startSh).toMatch(/WARNING \(cloakbrowser shared cache\)[^\n]*cloakbrowser[^\n]*>&2/);
    expect(startSh).toContain(
      "CLOAKBROWSER_CACHE_DIR=~/.switchroom/cloakbrowser cloakbrowser install",
    );
    // Non-fatal: no exit/abort in the guard body.
    const guard = startSh.slice(
      startSh.indexOf('sr_cb_dir="${CLOAKBROWSER_CACHE_DIR'),
      startSh.indexOf("unset sr_cb_dir"),
    );
    expect(guard).not.toMatch(/\bexit\s+[1-9]/);
  });
});
