import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, toHostHomePath } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Regression for the 2026-06-14 fleet-wide scaffold poison (carrie + 11
// landmines). hostd shells out `switchroom apply` from INSIDE its container,
// where $HOME=/host-home (a bind mount point, not a host filesystem path).
// The compose bind SOURCES were already protected (write-compose.ts prefers
// SWITCHROOM_HOST_HOME) but the SCAFFOLD path was the unprotected sibling: it
// baked $HOME-rooted paths into start.sh's `cd "{{agentDir}}"`,
// `--plugin-dir {{agentDir}}/...` and the `$HOME/.switchroom` symlink target.
// Agent containers mount ~/.switchroom at its REAL host path (same path in/out,
// network_mode: host) and have NO /host-home mount, so every such path dangled
// and claude fell to the login screen. The config_propose_edit reconcile path
// (unblocked by the v0.15.23 EROFS fix) is exactly this in-hostd apply.

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  };
}

describe("toHostHomePath (in-hostd bake translation)", () => {
  let savedHome: string | undefined;
  let savedHostHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedHostHome = process.env.SWITCHROOM_HOST_HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHostHome === undefined) delete process.env.SWITCHROOM_HOST_HOME;
    else process.env.SWITCHROOM_HOST_HOME = savedHostHome;
  });

  it("translates a $HOME-rooted path to SWITCHROOM_HOST_HOME when they differ", () => {
    process.env.HOME = "/host-home";
    process.env.SWITCHROOM_HOST_HOME = "/home/op";
    expect(toHostHomePath("/host-home/.switchroom/agents/carrie")).toBe(
      "/home/op/.switchroom/agents/carrie",
    );
    // exact-home match (no trailing slash) also translates
    expect(toHostHomePath("/host-home")).toBe("/home/op");
  });

  it("is a no-op on the host (SWITCHROOM_HOST_HOME unset)", () => {
    process.env.HOME = "/home/op";
    delete process.env.SWITCHROOM_HOST_HOME;
    expect(toHostHomePath("/home/op/.switchroom/agents/carrie")).toBe(
      "/home/op/.switchroom/agents/carrie",
    );
  });

  it("is a no-op when SWITCHROOM_HOST_HOME equals $HOME", () => {
    process.env.HOME = "/home/op";
    process.env.SWITCHROOM_HOST_HOME = "/home/op";
    expect(toHostHomePath("/home/op/.switchroom/agents/carrie")).toBe(
      "/home/op/.switchroom/agents/carrie",
    );
  });

  it("leaves non-$HOME paths untouched (e.g. /state/config, /opt)", () => {
    process.env.HOME = "/host-home";
    process.env.SWITCHROOM_HOST_HOME = "/home/op";
    expect(toHostHomePath("/state/config/switchroom.yaml")).toBe(
      "/state/config/switchroom.yaml",
    );
    expect(toHostHomePath("/opt/switchroom/security-plugin")).toBe(
      "/opt/switchroom/security-plugin",
    );
    // a path that merely shares a prefix string but isn't a child must NOT match
    expect(toHostHomePath("/host-home-evil/x")).toBe("/host-home-evil/x");
  });
});

describe("scaffoldAgent: start.sh bakes HOST paths, not /host-home (carrie incident)", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedHostHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-hosthome-bake-"));
    savedHome = process.env.HOME;
    savedHostHome = process.env.SWITCHROOM_HOST_HOME;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedHostHome === undefined) delete process.env.SWITCHROOM_HOST_HOME;
    else process.env.SWITCHROOM_HOST_HOME = savedHostHome;
  });

  it("bakes SWITCHROOM_HOST_HOME into start.sh when apply runs in-hostd ($HOME=container mount)", () => {
    const name = "carrie";
    // Simulate the in-hostd shell-out: $HOME is the in-container bind mount
    // (where files are WRITTEN — keep it inside the tmpdir so the test never
    // touches the real ~/.switchroom), SWITCHROOM_HOST_HOME is the real host
    // home (what must be BAKED into start.sh).
    process.env.HOME = tmpDir;
    process.env.SWITCHROOM_HOST_HOME = "/home/op";

    // agentsDir under $HOME → agentDir starts with the container home, exactly
    // as resolveAgentsDir(~/.switchroom/agents) yields inside hostd.
    const agentsDir = join(tmpDir, ".switchroom", "agents");
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const res = scaffoldAgent(name, config, agentsDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");

    // BAKED agentDir is the HOST path — the agent container can resolve it.
    expect(startSh).toContain(`/home/op/.switchroom/agents/${name}`);
    expect(startSh).toContain(`cd "/home/op/.switchroom/agents/${name}"`);
    // The $HOME/.switchroom symlink target (#910) is the host home, not the
    // in-container /host-home equivalent. hostHomeQ is shell-single-quoted.
    expect(startSh).toContain(`ln -sfn '/home/op'/.switchroom "$HOME/.switchroom"`);

    // The container home must NOT leak into any BAKED value — that was the
    // poison (a /host-home that the agent container can't see).
    expect(startSh).not.toContain(`${tmpDir}/.switchroom/agents/${name}`);
  });

  it("bakes $HOME on a plain host apply (SWITCHROOM_HOST_HOME unset)", () => {
    const name = "carrie";
    process.env.HOME = tmpDir;
    delete process.env.SWITCHROOM_HOST_HOME;

    const agentsDir = join(tmpDir, ".switchroom", "agents");
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const res = scaffoldAgent(name, config, agentsDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");

    // No translation on the host: the real (tmp) home is baked, and that IS
    // the path the file lives at, so the agent resolves it fine.
    expect(startSh).toContain(`${tmpDir}/.switchroom/agents/${name}`);
  });
});
