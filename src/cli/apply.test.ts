import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Command } from "commander";
import {
  runApply,
  runApplyDryRun,
  runApplyPreflight,
  registerApplyCommand,
  parseComposeServiceNames,
  isInAgentContainer,
  IN_AGENT_CONTAINER_APPLY_MSG,
} from "./apply.js";
import * as scaffoldModule from "../agents/scaffold.js";
import * as profilesModule from "../agents/profiles.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * RFC §3 test-directory leak fix: every temp home/agent dir created via
 * `mkdtemp` used to be left on disk after the test run, so repeated suite
 * runs bled `switchroom-apply-*` / `switchroom-dryrun-*` dirs onto the
 * durable agent-home tree. Route every `mkdtemp` in this file through
 * `makeTmpDir`, which registers the path for teardown; the file-level
 * `afterEach` below removes them after each test regardless of which
 * `describe` block created them. (The `mkdtempSync` sites in the
 * self-elevate block already clean up via their own `try/finally`.)
 */
const _tmpDirs: string[] = [];
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  _tmpDirs.push(dir);
  return dir;
}
async function cleanupTmpDirs(): Promise<void> {
  const dirs = _tmpDirs.splice(0);
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true })),
  );
}
// File-level teardown: applies to every test in every describe below.
afterEach(cleanupTmpDirs);

/**
 * Test seam: bypass the `docker compose` v2 preflight check so these
 * tests can exercise the apply orchestrator on hosts without Docker
 * installed. The real preflight gate is exercised by its own dedicated
 * test under `describe("compose v2 preflight")` further down which
 * uses an emptied PATH instead of the dep injection.
 */
const SKIP_COMPOSE_PREFLIGHT = { detectComposeV2: () => null };

/**
 * Minimal config — `runApply` forwards to `scaffoldAgent` (via
 * `loadConfig` resolution) and `generateCompose` directly. Both are
 * exercised in their own dedicated unit tests; here we only verify
 * the CLI orchestrator writes the compose artifact at the path it
 * was asked to write to and that scaffold ran first (i.e. agent
 * directories exist when the compose file lands on disk).
 */
function makeStubConfig(agentsDir: string): SwitchroomConfig {
  return {
    agents: {
      klanker: {
        profile: "engineer",
        claudeAccount: "default",
      },
    },
    profiles: {},
    defaults: {},
    switchroom: { agents_dir: agentsDir },
    telegram: { forum_chat_id: "0" },
  } as unknown as SwitchroomConfig;
}

describe("runApply", () => {
  // Sandbox HOME so the apply orchestrator's vault-layout migration check
  // (`migrateVaultLayout(homedir(), …)`) doesn't poke the real
  // ~/.switchroom/vault/ on the test host. Without this, every test on a
  // box where vault layout has already migrated to v0.7.12+ (the post-
  // migration "state D" layout) sees the real symlink + vault file and
  // can flip the migration classifier into "divergent" → process.exit(4).
  // Pre-fix this was an env-dependent flake.
  let _origHome: string | undefined;
  let _homeSandbox: string | undefined;
  beforeEach(async () => {
    _origHome = process.env.HOME;
    _homeSandbox = await makeTmpDir("switchroom-apply-home-");
    process.env.HOME = _homeSandbox;
  });
  afterEach(() => {
    if (_origHome !== undefined) {
      process.env.HOME = _origHome;
    } else {
      delete process.env.HOME;
    }
  });

  it("writes the compose YAML to the requested path", async () => {
    const dir = await makeTmpDir("switchroom-apply-test-");
    const outPath = join(dir, "nested", "docker-compose.yml");

    // Drain stdout/stderr through dummy writers so the test doesn't
    // pollute vitest's output.
    const sink: string[] = [];
    const res = await runApply(
      makeStubConfig(join(dir, "agents")),
      { outPath },
      {
        writeOut: (s) => sink.push(s),
        writeErr: (s) => sink.push(s),
        ...SKIP_COMPOSE_PREFLIGHT,
      },
    );

    expect(res.composePath).toBe(outPath);
    expect(res.composeBytes).toBeGreaterThan(0);

    const onDisk = await readFile(outPath, "utf8");
    expect(onDisk).toMatch(/services:/);
  });

  it("preflight throws when config has vault refs but vault.enc is missing", () => {
    // Point vault path at a non-existent file under a temp dir.
    const fakeVault = join(tmpdir(), `nonexistent-vault-${Date.now()}.enc`);
    const cfg = {
      ...makeStubConfig("/tmp/agents"),
      vault: { path: fakeVault },
      telegram: { bot_token: "vault:telegram_bot_token" },
    } as unknown as SwitchroomConfig;
    // SKIP_COMPOSE_PREFLIGHT: this test pins the VAULT-missing throw, but
    // runApplyPreflight computes the compose check first (the in-agent-
    // container redirect needs both signals) — without the dep-injection
    // seam this was the only test in the suite spawning a REAL unbounded
    // `docker compose version` subprocess, which flaked past the 5s test
    // budget on loaded CI runners (PR #2980 shard timeout). Real docker
    // detection stays covered by the dedicated "compose v2 preflight"
    // tests below (deterministic: stubbed error / emptied PATH).
    expect(() => runApplyPreflight(cfg, SKIP_COMPOSE_PREFLIGHT)).toThrow(/vault/i);
  });

  describe("UID alignment failure handling", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scaffoldSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alignSpy: any;

    beforeEach(() => {
      // Force scaffoldAgent to look like it succeeded so we reach the
      // alignAgentUid call site. The real scaffoldAgent needs a fully
      // wired profile / telegram config which is out of scope here.
      // Note: do NOT mockReset/mockClear these spies between tests —
      // that wipes the implementation and the real function runs again.
      scaffoldSpy = vi
        .spyOn(scaffoldModule, "scaffoldAgent")
        .mockImplementation(
          () => ({ created: ["fake.txt"] }) as never,
        );
      alignSpy = vi
        .spyOn(scaffoldModule, "alignAgentUid")
        .mockImplementation(() => {
          throw new Error("simulated chown EPERM");
        });
    });

    afterEach(() => {
      scaffoldSpy.mockRestore();
      alignSpy.mockRestore();
    });

    it("fails hard by default when chown fails", async () => {
      const dir = await makeTmpDir("switchroom-apply-fail-");
      const sink: string[] = [];
      await expect(
        runApply(
          makeStubConfig(join(dir, "agents")),
          { outPath: join(dir, "docker-compose.yml") },
          { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s), ...SKIP_COMPOSE_PREFLIGHT },
        ),
      ).rejects.toThrow(/UID alignment failed|allow-unaligned/i);
      const all = sink.join("");
      expect(all).toMatch(/could not chown/);
      expect(all).toMatch(/--allow-unaligned/);
    });

    it("warns and continues when --allow-unaligned is passed", async () => {
      const dir = await makeTmpDir("switchroom-apply-allow-");
      const sink: string[] = [];
      const res = await runApply(
        makeStubConfig(join(dir, "agents")),
        {
          outPath: join(dir, "docker-compose.yml"),
          allowUnaligned: true,
        },
        { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s), ...SKIP_COMPOSE_PREFLIGHT },
      );
      expect(res.scaffolded).toBe(1);
      const all = sink.join("");
      expect(all).toMatch(/could not chown/);
      expect(all).toMatch(/continuing/i);
    });
  });

  describe("in-agent-container preflight redirect", () => {
    // Snapshot + restore the agent-container env markers so these cases
    // are deterministic regardless of whether the suite itself happens to
    // run inside an agent container.
    let _origName: string | undefined;
    let _origRoot: string | undefined;
    beforeEach(() => {
      _origName = process.env.SWITCHROOM_AGENT_NAME;
      _origRoot = process.env.SWITCHROOM_AGENT_ROOT;
      delete process.env.SWITCHROOM_AGENT_NAME;
      delete process.env.SWITCHROOM_AGENT_ROOT;
    });
    afterEach(() => {
      if (_origName !== undefined) process.env.SWITCHROOM_AGENT_NAME = _origName;
      else delete process.env.SWITCHROOM_AGENT_NAME;
      if (_origRoot !== undefined) process.env.SWITCHROOM_AGENT_ROOT = _origRoot;
      else delete process.env.SWITCHROOM_AGENT_ROOT;
    });

    it("isInAgentContainer detects the env marker regardless of structural signals", () => {
      expect(
        isInAgentContainer(true, true, { SWITCHROOM_AGENT_NAME: "klanker" }),
      ).toBe(true);
      expect(
        isInAgentContainer(true, true, { SWITCHROOM_AGENT_ROOT: "true" }),
      ).toBe(true);
    });

    it("isInAgentContainer detects the structural fingerprint (no vault + no compose v2)", () => {
      expect(isInAgentContainer(false, false, {})).toBe(true);
      // A genuine host missing only ONE of the two is NOT the fingerprint.
      expect(isInAgentContainer(false, true, {})).toBe(false);
      expect(isInAgentContainer(true, false, {})).toBe(false);
    });

    it("preflight throws the DIRECTED hostd-rollout message when the env marker is set", () => {
      process.env.SWITCHROOM_AGENT_NAME = "klanker";
      const fakeVault = join(tmpdir(), `nonexistent-vault-${Date.now()}.enc`);
      const cfg = {
        ...makeStubConfig("/tmp/agents"),
        vault: { path: fakeVault },
        telegram: { bot_token: "vault:telegram_bot_token" },
      } as unknown as SwitchroomConfig;
      // Compose "present" (skip) so only the vault-missing condition trips —
      // the env marker still routes to the directed message.
      expect(() => runApplyPreflight(cfg, SKIP_COMPOSE_PREFLIGHT)).toThrow(
        /mcp__hostd__rollout/,
      );
      expect(() => runApplyPreflight(cfg, SKIP_COMPOSE_PREFLIGHT)).toThrow(
        IN_AGENT_CONTAINER_APPLY_MSG,
      );
    });

    it("preflight throws the DIRECTED message on the structural fingerprint (no vault + no compose v2)", () => {
      const fakeVault = join(tmpdir(), `nonexistent-vault-${Date.now()}.enc`);
      const cfg = {
        ...makeStubConfig("/tmp/agents"),
        vault: { path: fakeVault },
        telegram: { bot_token: "vault:telegram_bot_token" },
      } as unknown as SwitchroomConfig;
      // No env markers (cleared above); force compose v2 "missing".
      expect(() =>
        runApplyPreflight(cfg, { detectComposeV2: () => "compose v2 missing" }),
      ).toThrow(/mcp__hostd__rollout/);
    });
  });

  describe("compose v2 preflight", () => {
    const realPath = process.env.PATH;

    afterEach(() => {
      process.env.PATH = realPath;
    });

    it("preflight throws with friendly message when `docker compose` v2 is missing", () => {
      // Empty PATH so `docker` is not findable — execFileSync throws,
      // detectComposeV2 returns the friendly error string.
      process.env.PATH = "/nonexistent-switchroom-test-path";
      const cfg = makeStubConfig("/tmp/agents");
      expect(() => runApplyPreflight(cfg)).toThrow(
        /docker compose.*v2|Compose v2 plugin/i,
      );
    });
  });

  it("returns the count of agents scaffolded", async () => {
    const dir = await makeTmpDir("switchroom-apply-test-");
    const outPath = join(dir, "docker-compose.yml");

    const res = await runApply(
      makeStubConfig(join(dir, "agents")),
      { outPath },
      { writeOut: () => {}, writeErr: () => {}, ...SKIP_COMPOSE_PREFLIGHT },
    );

    // scaffoldAgent may legitimately fail in this minimal-stub
    // environment (no telegram tokens, no real profile dir). The
    // contract we care about for the test is: `agentsTotal` reflects
    // the config and `composePath`/`composeBytes` are populated
    // regardless. Scaffold robustness is owned by scaffold's own tests.
    expect(res.agentsTotal).toBe(1);
    expect(res.composePath).toBe(outPath);
  });

  describe("--only=<agent> (v0.7.7 — one-at-a-time cutover)", () => {
    // The full v0.6 → v0.7 cutover chowns every agent's state dir to a
    // per-agent UID; that breaks the systemd-managed siblings until
    // they're stopped. --only=<name> scopes scaffold + chown to one
    // agent so siblings keep running while operators migrate piecemeal.
    function multiAgentConfig(agentsDir: string): SwitchroomConfig {
      return {
        agents: {
          alice: { profile: "engineer", claudeAccount: "default" },
          bob: { profile: "engineer", claudeAccount: "default" },
          carol: { profile: "engineer", claudeAccount: "default" },
        },
        profiles: {},
        defaults: {},
        switchroom: { agents_dir: agentsDir },
        telegram: { forum_chat_id: "0" },
      } as unknown as SwitchroomConfig;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scaffoldSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alignSpy: any;

    beforeEach(() => {
      scaffoldSpy = vi
        .spyOn(scaffoldModule, "scaffoldAgent")
        .mockImplementation(() => ({ created: [] }) as never);
      alignSpy = vi
        .spyOn(scaffoldModule, "alignAgentUid")
        .mockImplementation(() => ({ chowned: true, paths: [] }));
    });

    afterEach(() => {
      scaffoldSpy.mockRestore();
      alignSpy.mockRestore();
    });

    it("scaffolds + aligns only the named agent (siblings untouched)", async () => {
      const dir = await makeTmpDir("switchroom-apply-only-");
      const outPath = join(dir, "docker-compose.yml");

      await runApply(
        multiAgentConfig(join(dir, "agents")),
        { outPath, only: "bob", nonInteractive: true },
        { writeOut: () => {}, writeErr: () => {}, ...SKIP_COMPOSE_PREFLIGHT },
      );

      // Only `bob` got scaffolded + aligned — alice and carol are
      // still on whatever state they had before (presumably v0.6 systemd).
      // `alignAgentUid` is called twice for the named agent — once in the
      // per-agent scaffold loop and again in the post-host-mount-sources
      // re-align pass that #1255 added (re-chown the log dir after
      // `ensureHostMountSources` creates it). Both calls must target
      // `bob` only — siblings stay untouched.
      expect(scaffoldSpy).toHaveBeenCalledTimes(1);
      expect(scaffoldSpy.mock.calls[0]![0]).toBe("bob");
      expect(alignSpy).toHaveBeenCalledTimes(2);
      expect(alignSpy.mock.calls[0]![0]).toBe("bob");
      expect(alignSpy.mock.calls[1]![0]).toBe("bob");
    });

    it("regenerates compose for the FULL fleet even with --only", async () => {
      // Compose still needs every agent in YAML for the broker/kernel
      // per-agent socket volumes to be emitted. Otherwise --only=alice
      // would silently strip bob/carol from the compose and break their
      // post-cutover sockets.
      const dir = await makeTmpDir("switchroom-apply-only-");
      const outPath = join(dir, "docker-compose.yml");

      const res = await runApply(
        multiAgentConfig(join(dir, "agents")),
        { outPath, only: "alice", nonInteractive: true },
        { writeOut: () => {}, writeErr: () => {}, ...SKIP_COMPOSE_PREFLIGHT },
      );

      const composeYml = await readFile(outPath, "utf-8");
      // All three agent services in the compose, regardless of --only.
      expect(composeYml).toMatch(/agent-alice:/);
      expect(composeYml).toMatch(/agent-bob:/);
      expect(composeYml).toMatch(/agent-carol:/);
      // agentsTotal still reflects the YAML, not the --only narrow.
      expect(res.agentsTotal).toBe(3);
    });

    it("rejects --only=<unknown-name> with an actionable error", async () => {
      const dir = await makeTmpDir("switchroom-apply-only-");
      const outPath = join(dir, "docker-compose.yml");

      await expect(
        runApply(
          multiAgentConfig(join(dir, "agents")),
          { outPath, only: "frank", nonInteractive: true },
          { writeOut: () => {}, writeErr: () => {}, ...SKIP_COMPOSE_PREFLIGHT },
        ),
      ).rejects.toThrow(/--only=frank.*no such agent/);
    });
  });

  describe("scaffold-failure surfacing (issue #902)", () => {
    /**
     * Pre-fix behaviour: scaffold failures in the per-agent loop were
     * caught silently — printed as `x ${name}` but `runApply` returned
     * normally and the CLI handler exited 0. CI / non-interactive
     * callers ended up with stale start.sh / .mcp.json / settings.json
     * with no signal that anything was wrong.
     */
    function multiAgentConfig(agentsDir: string): SwitchroomConfig {
      return {
        agents: {
          alice: { profile: "engineer", claudeAccount: "default" },
          bob: { profile: "engineer", claudeAccount: "default" },
        },
        profiles: {},
        defaults: {},
        switchroom: { agents_dir: agentsDir },
        telegram: { forum_chat_id: "0" },
      } as unknown as SwitchroomConfig;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scaffoldSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alignSpy: any;

    afterEach(() => {
      if (scaffoldSpy) scaffoldSpy.mockRestore();
      if (alignSpy) alignSpy.mockRestore();
    });

    it("collects per-agent scaffold failures into result.failures with agent name + message", async () => {
      // Half the fleet succeeds, half throws — runApply must return
      // both `scaffolded === 1` and `failures.length === 1`, with the
      // failed agent name on the failure record.
      scaffoldSpy = vi
        .spyOn(scaffoldModule, "scaffoldAgent")
        .mockImplementation((name: string) => {
          if (name === "bob") throw new Error("EACCES: permission denied");
          return { created: ["fake.txt"] } as never;
        });
      alignSpy = vi
        .spyOn(scaffoldModule, "alignAgentUid")
        .mockImplementation(() => ({ chowned: true, paths: [] }));

      const dir = await makeTmpDir("switchroom-apply-fail-");
      const sink: string[] = [];
      const res = await runApply(
        multiAgentConfig(join(dir, "agents")),
        {
          outPath: join(dir, "docker-compose.yml"),
          nonInteractive: true,
        },
        { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s), ...SKIP_COMPOSE_PREFLIGHT },
      );

      expect(res.scaffolded).toBe(1);
      expect(res.failures).toHaveLength(1);
      expect(res.failures[0]!.agent).toBe("bob");
      expect(res.failures[0]!.message).toMatch(/EACCES/);
      // Compose still emitted — partial scaffold doesn't gate compose.
      expect(res.composeBytes).toBeGreaterThan(0);
      // Regression check: the human-readable per-agent error line is
      // still printed alongside the new structured collection. A
      // future refactor that drops failures.push without also dropping
      // the writeOut would silently re-introduce the old "exit 0 on
      // partial failure" bug under a different code path.
      const all = sink.join("");
      expect(all).toMatch(/x bob.*EACCES/);
    });

    it("--compose-only skips the per-agent scaffold loop entirely; compose still emits", async () => {
      // Verify scaffoldAgent is NEVER called when composeOnly is set.
      // This is the CI-friendly path: regenerate compose without
      // touching per-agent dirs we can't write to.
      scaffoldSpy = vi
        .spyOn(scaffoldModule, "scaffoldAgent")
        .mockImplementation(() => {
          throw new Error("should not be called when composeOnly is set");
        });
      alignSpy = vi
        .spyOn(scaffoldModule, "alignAgentUid")
        .mockImplementation(() => {
          throw new Error("should not be called when composeOnly is set");
        });

      const dir = await makeTmpDir("switchroom-apply-co-");
      const outPath = join(dir, "docker-compose.yml");
      const sink: string[] = [];

      const res = await runApply(
        multiAgentConfig(join(dir, "agents")),
        {
          outPath,
          nonInteractive: true,
          composeOnly: true,
        },
        { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s), ...SKIP_COMPOSE_PREFLIGHT },
      );

      expect(scaffoldSpy).not.toHaveBeenCalled();
      expect(alignSpy).not.toHaveBeenCalled();
      expect(res.scaffolded).toBe(0);
      expect(res.failures).toHaveLength(0);
      expect(res.agentsTotal).toBe(2);
      // Compose still on disk + sized.
      expect(res.composeBytes).toBeGreaterThan(0);
      const composeYml = await readFile(outPath, "utf-8");
      expect(composeYml).toMatch(/agent-alice:/);
      expect(composeYml).toMatch(/agent-bob:/);
      // Operator gets a hint about what was skipped.
      expect(sink.join("")).toMatch(/--compose-only.*skipped/);
    });

    it("formatScaffoldFailureResolution emits an actionable resolution block", async () => {
      const { formatScaffoldFailureResolution } = await import("./apply.js");
      const out = formatScaffoldFailureResolution(
        [
          { agent: "alice", message: "EACCES: x" },
          { agent: "bob", message: "EACCES: y" },
        ],
        0,
        2,
      );
      // The block names the right number and points at the two real
      // escape hatches: sudo and --compose-only.
      expect(out).toMatch(/Scaffolded 0\/2.*2 failed/s);
      expect(out).toMatch(/Re-run interactively/);
      expect(out).toMatch(/--compose-only/);
      // Regression: deliberately does NOT tell the operator to type
      // out the `sudo -E bun /path/to/dist/...` incantation by hand
      // anymore — the CLI does it for them via #920 self-elevate.
      expect(out).not.toMatch(/sudo -E switchroom apply/);
    });
  });

  describe("self-elevate (#920)", () => {
    it("findUnwritableAgentDirs returns empty when no per-agent start.sh exists yet", async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "self-elev-"));
      try {
        const { findUnwritableAgentDirs } = await import("./apply.js");
        const config = {
          switchroom: {
            version: 1,
            agents_dir: join(dir, "agents"),
            skills_dir: join(dir, "skills"),
          },
          telegram: { bot_token: "x", forum_chat_id: "-100" },
          vault: { path: join(dir, "vault.enc") },
          agents: { alice: {}, bob: {} },
        };
        // No start.sh yet → fresh fleet; alignAgentUid will chown into
        // place when apply runs. Nothing for us to flag.
        expect(findUnwritableAgentDirs(config as never, {})).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(process.getuid?.() === 0)("findUnwritableAgentDirs flags agents whose start.sh we can't write to", async () => {
      const {
        mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync,
      } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "self-elev-blocked-"));
      try {
        const agentsDir = join(dir, "agents");
        for (const name of ["alice", "bob"]) {
          mkdirSync(join(agentsDir, name), { recursive: true });
          const startSh = join(agentsDir, name, "start.sh");
          writeFileSync(startSh, "#!/bin/bash\n");
          // Read-only file with no write bits for ANY user. We're not
          // root in tests, so accessSync(W_OK) errors here.
          chmodSync(startSh, 0o400);
        }
        const { findUnwritableAgentDirs } = await import("./apply.js");
        const config = {
          switchroom: { version: 1, agents_dir: agentsDir, skills_dir: dir },
          telegram: { bot_token: "x", forum_chat_id: "-100" },
          vault: { path: join(dir, "vault.enc") },
          agents: { alice: {}, bob: {} },
        };
        expect(findUnwritableAgentDirs(config as never, {}).sort())
          .toEqual(["alice", "bob"]);
        // --only narrows the scope.
        expect(findUnwritableAgentDirs(config as never, { only: "alice" }))
          .toEqual(["alice"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writeInstallTypeCache writes install-type.json with mode 0o644", async () => {
      const { writeInstallTypeCache } = await import("./apply.js");
      const { mkdtempSync, statSync, readFileSync, rmSync } = await import("node:fs");
      const home = mkdtempSync(join(tmpdir(), "switchroom-itc-"));
      try {
        const out = writeInstallTypeCache(home);
        expect(out).toBe(join(home, ".switchroom", "install-type.json"));
        const st = statSync(out);
        expect(st.mode & 0o777).toBe(0o644);
        const parsed = JSON.parse(readFileSync(out, "utf-8"));
        expect(typeof parsed.install_type).toBe("string");
        expect(typeof parsed.detected_at).toBe("string");
        expect(parsed.source_paths).toBeTypeOf("object");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("runApply writes ~/.switchroom/install-type.json on every call", async () => {
      const sandbox = await makeTmpDir("switchroom-apply-itc-");
      const agentsDir = join(sandbox, "agents");
      const composePath = join(sandbox, "compose.yml");
      // Sandbox HOME so the write lands inside the test dir.
      const prevHome = process.env.HOME;
      process.env.HOME = sandbox;
      try {
        vi.spyOn(scaffoldModule, "scaffoldAgent").mockResolvedValue(undefined as never);
        vi.spyOn(scaffoldModule, "alignAgentUid").mockResolvedValue(undefined as never);
        const config = makeStubConfig(agentsDir);
        await runApply(
          config,
          { outPath: composePath, nonInteractive: true },
          SKIP_COMPOSE_PREFLIGHT,
        );
        const { existsSync, readFileSync } = await import("node:fs");
        const p = join(sandbox, ".switchroom", "install-type.json");
        expect(existsSync(p)).toBe(true);
        const parsed = JSON.parse(readFileSync(p, "utf-8"));
        expect(typeof parsed.install_type).toBe("string");
      } finally {
        if (prevHome !== undefined) process.env.HOME = prevHome;
        else delete process.env.HOME;
      }
    });

    it("runApply with releaseOverride={channel:'dev'} emits compose with :dev image tags", async () => {
      const sandbox = await makeTmpDir("switchroom-relov-");
      const agentsDir = join(sandbox, "agents");
      const composePath = join(sandbox, "compose.yml");
      const config = makeStubConfig(agentsDir);
      vi.spyOn(scaffoldModule, "scaffoldAgent").mockResolvedValue(undefined as never);
      vi.spyOn(scaffoldModule, "alignAgentUid").mockResolvedValue(undefined as never);
      await runApply(
        config,
        {
          outPath: composePath,
          nonInteractive: true,
          releaseOverride: { channel: "dev" },
        },
        SKIP_COMPOSE_PREFLIGHT,
      );
      const content = await readFile(composePath, "utf-8");
      // Every emitted `image:` line must end with :dev
      const imageLines = content.split("\n").filter((l) => /^\s*image:/.test(l));
      expect(imageLines.length).toBeGreaterThan(0);
      for (const ln of imageLines) {
        expect(ln).toMatch(/:dev\s*$/);
      }
    });

    it("runApply with releaseOverride={pin:'sha-abc1234'} emits compose with :sha-abc1234 image tags", async () => {
      const sandbox = await makeTmpDir("switchroom-relov2-");
      const agentsDir = join(sandbox, "agents");
      const composePath = join(sandbox, "compose.yml");
      const config = makeStubConfig(agentsDir);
      vi.spyOn(scaffoldModule, "scaffoldAgent").mockResolvedValue(undefined as never);
      vi.spyOn(scaffoldModule, "alignAgentUid").mockResolvedValue(undefined as never);
      await runApply(
        config,
        {
          outPath: composePath,
          nonInteractive: true,
          releaseOverride: { pin: "sha-abc1234" },
        },
        SKIP_COMPOSE_PREFLIGHT,
      );
      const content = await readFile(composePath, "utf-8");
      const imageLines = content.split("\n").filter((l) => /^\s*image:/.test(l));
      expect(imageLines.length).toBeGreaterThan(0);
      for (const ln of imageLines) {
        expect(ln).toMatch(/:sha-abc1234\s*$/);
      }
    });

    it("buildSelfElevateArgv preserves env vars and adds the --skip-self-elevate guard", async () => {
      const { buildSelfElevateArgv } = await import("./apply.js");
      const argv = buildSelfElevateArgv();
      // First arg = preserve-env list including HOME so ~/.switchroom
      // resolves under sudo (sudo-rs ignores -E).
      expect(argv[0]).toMatch(/^--preserve-env=.*\bHOME\b/);
      expect(argv[0]).toMatch(/SWITCHROOM_CONFIG/);
      expect(argv[0]).toMatch(/PATH/);
      // Then the absolute interpreter path (not 'bun' on PATH, so
      // sudo's secure PATH doesn't need to know about ~/.bun/bin).
      expect(argv[1]).toBe(process.execPath);
      // Followed by the script path argv[1] of the parent.
      expect(argv[2]).toBe(process.argv[1]);
      // Last arg is the recursion guard.
      expect(argv[argv.length - 1]).toBe("--skip-self-elevate");
    });
  });
});

describe("apply --dry-run", () => {
  // Sandbox HOME so the vault-passphrase probe (auto-unlock blob lookup)
  // and any homedir()-anchored reads don't touch the real ~/.switchroom.
  let _origHome: string | undefined;
  let _homeSandbox: string | undefined;
  beforeEach(async () => {
    _origHome = process.env.HOME;
    _homeSandbox = await makeTmpDir("switchroom-dryrun-home-");
    process.env.HOME = _homeSandbox;
  });
  afterEach(() => {
    if (_origHome !== undefined) process.env.HOME = _origHome;
    else delete process.env.HOME;
  });

  it("registers the --dry-run flag on the apply command", () => {
    const program = new Command();
    registerApplyCommand(program);
    const apply = program.commands.find((c) => c.name() === "apply");
    expect(apply).toBeDefined();
    const flags = apply!.options.map((o) => o.long);
    expect(flags).toContain("--dry-run");
  });

  it("a clean dry-run reports 'would succeed' and writes NOTHING", async () => {
    const dir = await makeTmpDir("switchroom-dryrun-clean-");
    const outPath = join(dir, "nested", "docker-compose.yml");
    const sink: string[] = [];

    const res = await runApplyDryRun(
      makeStubConfig(join(dir, "agents")),
      { outPath, dryRun: true },
      { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s), ...SKIP_COMPOSE_PREFLIGHT },
    );

    expect(res.wouldSucceed).toBe(true);
    expect(res.blocking).toEqual([]);
    // The compose file must NOT have been written — dry-run is read-only.
    expect(existsSync(outPath)).toBe(false);
    // And the whole nested dir the real apply would have mkdir'd stays absent.
    expect(existsSync(join(dir, "nested"))).toBe(false);
    // Report mentions success.
    expect(sink.join("")).toMatch(/would SUCCEED/i);
  });

  it("computes the would-be compose in memory (imageTag + services)", async () => {
    const dir = await makeTmpDir("switchroom-dryrun-compose-");
    const outPath = join(dir, "docker-compose.yml");
    const sink: string[] = [];

    const res = await runApplyDryRun(
      makeStubConfig(join(dir, "agents")),
      { outPath, dryRun: true },
      { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s), ...SKIP_COMPOSE_PREFLIGHT },
    );

    expect(res.imageTag).toBeTruthy();
    // No prior compose on disk → every service is "added".
    expect(res.previousImageTag).toBeNull();
    expect(res.addedServices.length).toBeGreaterThan(0);
    expect(existsSync(outPath)).toBe(false);
  });

  it("exits non-zero (wouldSucceed=false) when a profile fails to resolve", async () => {
    const dir = await makeTmpDir("switchroom-dryrun-badprofile-");
    const outPath = join(dir, "docker-compose.yml");
    const sink: string[] = [];

    // Reproduce the v0.17.0 incident: the profiles dir doesn't resolve in
    // this context, so getProfilePath throws "Profile not found".
    const spy = vi
      .spyOn(profilesModule, "getProfilePath")
      .mockImplementation(() => {
        throw new Error("Profile not found: default (searched /profiles)");
      });
    try {
      const res = await runApplyDryRun(
        makeStubConfig(join(dir, "agents")),
        { outPath, dryRun: true },
        { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s), ...SKIP_COMPOSE_PREFLIGHT },
      );
      expect(res.wouldSucceed).toBe(false);
      expect(res.blocking.some((b) => /Profile not found/.test(b))).toBe(true);
      expect(existsSync(outPath)).toBe(false);
      expect(sink.join("")).toMatch(/would FAIL/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("parseComposeServiceNames extracts top-level service keys only", () => {
    const compose = [
      "services:",
      "  klanker:",
      "    image: ghcr.io/switchroom/switchroom-agent:v1",
      "    volumes:",
      "      - /a:/b",
      "  vault-broker:",
      "    image: ghcr.io/switchroom/switchroom-broker:v1",
      "networks:",
      "  default:",
      "volumes:",
      "  klanker-state:",
    ].join("\n");
    expect(parseComposeServiceNames(compose)).toEqual(["klanker", "vault-broker"]);
  });
});

describe("temp-dir hygiene (RFC §3 leak fix)", () => {
  // Regression guard for the leaked test-home dirs: `makeTmpDir` must
  // register every path so `cleanupTmpDirs` (wired to the file-level
  // `afterEach`) actually removes it. This asserts the OUTCOME — the
  // registered dirs are gone from disk after cleanup — not merely that
  // the code path ran. A future refactor that creates a temp dir via a
  // raw `mkdtemp` (bypassing the registry) would re-leak, but every
  // in-file site now routes through `makeTmpDir`.
  it("cleanupTmpDirs removes every dir created via makeTmpDir", async () => {
    const a = await makeTmpDir("switchroom-apply-hygiene-");
    const b = await makeTmpDir("switchroom-apply-hygiene-");
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);

    await cleanupTmpDirs();

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    // Registry drained, so a later cleanup (e.g. the afterEach) is a no-op.
    expect(_tmpDirs).toHaveLength(0);
  });
});
