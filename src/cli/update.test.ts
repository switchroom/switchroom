/**
 * Unit tests for `switchroom update` (#918). Drives the planUpdate
 * step builder + runUpdate dispatch with a fake runner so no real
 * docker / git / bun is invoked.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planUpdate,
  resolveHindsightPinTag,
  runUpdate,
  isGitCheckout,
  rebuildRefusalMessage,
  isHostdContext,
  encodeUpdateResultLine,
  parseUpdateResultLine,
  UPDATE_RESULT_SENTINEL,
} from "./update.js";

function fakeRunner() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let nextStatus = 0;
  return {
    calls,
    setNextStatus(n: number) { nextStatus = n; },
    fn: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const s = nextStatus;
      nextStatus = 0;
      return { status: s };
    },
  };
}

describe("planUpdate", () => {
  it("produces 11 steps in default mode (no --rebuild)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-plan-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({
        composePath,
        hostControlEnabled: false,
        webServiceManaged: false,
        memoryBackendHindsight: false,
      });
      expect(steps.map((s) => s.name)).toEqual([
        // self-update-cli is FIRST by design (#3919): apply-config renders
        // scaffolds from templates shipped inside the CLI, so updating the
        // CLI afterwards would render this run from the old templates.
        "self-update-cli",
        "pull-images",
        "apply-config",
        "reconcile-hindsight-watch-cron",
        "reconcile-mental-model-refresh-cron",
        "reconcile-config-repo-cron",
        "install-self-heal-timer",
        "refresh-hostd",
        "refresh-web",
        "refresh-hindsight",
        "sync-bundled-skills",
        "verify-bundled-skills",
        "stamp-restart-marker",
        "recreate-containers",
        "doctor",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe("reconcile-hindsight-watch-cron step (#silent-cli-drift)", () => {
    const OLD_ENV = { ...process.env };
    function stepFor(opts: Parameters<typeof planUpdate>[0]) {
      return planUpdate({ composePath: "unused", ...opts }).find(
        (s) => s.name === "reconcile-hindsight-watch-cron",
      )!;
    }

    it("REWRITES the cron when it differs, then is a NO-OP when identical", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-cron-"));
      try {
        process.env.SWITCHROOM_BINARY = "/usr/local/bin/switchroom";
        const cronPath = join(tmp, "hindsight-watch");
        // Armed earlier as `ada` at a STALE binary path.
        writeFileSync(
          cronPath,
          [
            "# switchroom hindsight-watch — model-free memory watchdog.",
            "# Managed by `switchroom hindsight-watch --install-cron`; edits are overwritten.",
            "# Exit 0 = clean, 10 = a signal is firing (DM sent), 1 = the check could not complete.",
            "SHELL=/bin/sh",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "*/15 * * * * ada /usr/bin/flock -n /run/lock/hindsight-watch.lock /opt/old/switchroom hindsight-watch >> /var/log/hindsight-watch.log 2>&1",
            "",
          ].join("\n"),
        );
        const before = readFileSync(cronPath, "utf8");

        // First run: the stale binary path is corrected → file changes.
        stepFor({ watchCronPath: cronPath }).run();
        const after = readFileSync(cronPath, "utf8");
        expect(after).not.toBe(before);
        expect(after).toContain("/usr/local/bin/switchroom hindsight-watch");
        expect(after).not.toContain("/opt/old/switchroom");
        // The operator's chosen user is preserved, not overwritten to root.
        expect(after).toContain("*/15 * * * * ada ");

        // Second run: definition already current → byte-identical no-op.
        stepFor({ watchCronPath: cronPath }).run();
        expect(readFileSync(cronPath, "utf8")).toBe(after);
      } finally {
        process.env = { ...OLD_ENV };
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("is a NO-OP when the host was never armed (no fragment present)", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-cron-absent-"));
      try {
        const cronPath = join(tmp, "hindsight-watch");
        // Must not throw and must not create the file — arming stays opt-in.
        expect(() => stepFor({ watchCronPath: cronPath }).run()).not.toThrow();
        expect(existsSync(cronPath)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("is deferred (skipReason) in hostd-context — /etc/cron.d is on the host", () => {
      expect(stepFor({ hostdContext: true }).skipReason).toMatch(/hostd-context/);
      expect(stepFor({ hostdContext: false }).skipReason).toBeUndefined();
    });
  });

  describe("reconcile-config-repo-cron step (auto-backup drift repair)", () => {
    const OLD_ENV = { ...process.env };
    function stepFor(opts: Parameters<typeof planUpdate>[0]) {
      return planUpdate({ composePath: "unused", ...opts }).find(
        (s) => s.name === "reconcile-config-repo-cron",
      )!;
    }

    it("REWRITES the config-sync cron when it differs, then is a NO-OP when identical", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-cfgcron-"));
      try {
        process.env.SWITCHROOM_BINARY = "/usr/local/bin/switchroom";
        const cronPath = join(tmp, "switchroom-config-sync");
        // Armed earlier as `ada` at a STALE binary path.
        writeFileSync(
          cronPath,
          [
            "# switchroom config-repo auto-backup — scheduled sync of ~/.switchroom-config.",
            "# Managed by `switchroom config-repo --install-cron`; edits are overwritten.",
            "# 30-min leg: commit+push live config / workspace / mirrored personal skills.",
            "# vault backup: daily at 17 3 * * * (config_repo.include_vault_backup: daily).",
            "SHELL=/bin/sh",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "*/30 * * * * ada /usr/bin/flock -n /run/lock/switchroom-config-sync.lock /opt/old/switchroom config-repo sync >> /var/log/switchroom-config-sync.log 2>&1",
            "17 3 * * * ada /usr/bin/flock -n /run/lock/switchroom-config-sync.lock /bin/sh -c '/opt/old/switchroom vault backup && /opt/old/switchroom config-repo sync' >> /var/log/switchroom-config-sync.log 2>&1",
            "",
          ].join("\n"),
        );
        const before = readFileSync(cronPath, "utf8");

        // First run: the stale binary path is corrected → file changes.
        stepFor({ configSyncCronPath: cronPath }).run();
        const after = readFileSync(cronPath, "utf8");
        expect(after).not.toBe(before);
        expect(after).toContain("/usr/local/bin/switchroom config-repo sync");
        expect(after).not.toContain("/opt/old/switchroom");
        // The operator's chosen user is preserved, not overwritten to root.
        expect(after).toContain("*/30 * * * * ada ");

        // Second run: definition already current → byte-identical no-op.
        stepFor({ configSyncCronPath: cronPath }).run();
        expect(readFileSync(cronPath, "utf8")).toBe(after);
      } finally {
        process.env = { ...OLD_ENV };
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("is a NO-OP when the host was never armed (no fragment present) — reconcile never ARMS", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-cfgcron-absent-"));
      try {
        const cronPath = join(tmp, "switchroom-config-sync");
        expect(() => stepFor({ configSyncCronPath: cronPath }).run()).not.toThrow();
        expect(existsSync(cronPath)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("is deferred (skipReason) in hostd-context — /etc/cron.d is on the host", () => {
      expect(stepFor({ hostdContext: true }).skipReason).toMatch(/hostd-context/);
      expect(stepFor({ hostdContext: false }).skipReason).toBeUndefined();
    });
  });

  describe("install-self-heal-timer step (#host-cli-converge)", () => {
    function stepFor(opts: Parameters<typeof planUpdate>[0]) {
      return planUpdate({ composePath: "unused", ...opts }).find(
        (s) => s.name === "install-self-heal-timer",
      )!;
    }

    it("systemd present + privileged: writes both units (non-root User=) and enables the timer", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-selfheal-"));
      try {
        const servicePath = join(tmp, "switchroom-self-heal.service");
        const timerPath = join(tmp, "switchroom-self-heal.timer");
        const calls: string[][] = [];
        const step = stepFor({
          selfHealTimerDeps: {
            env: { SUDO_USER: "alice", SWITCHROOM_BINARY: "/usr/local/bin/switchroom" },
            systemdBooted: () => true,
            geteuid: () => 0,
            homeForUser: () => "/home/alice",
            runner: (cmd, args) => {
              calls.push([cmd, ...args]);
              return { status: 0 };
            },
            servicePath,
            timerPath,
          },
        });
        step.run();

        const svc = readFileSync(servicePath, "utf8");
        expect(svc).toContain("User=alice");
        expect(svc).not.toContain("User=root");
        expect(svc).toContain("ExecStart=/usr/local/bin/switchroom update --skip-images");
        expect(readFileSync(timerPath, "utf8")).toContain("OnUnitActiveSec=30min");
        expect(calls).toEqual([
          ["systemctl", "daemon-reload"],
          ["systemctl", "enable", "--now", "switchroom-self-heal.timer"],
        ]);

        // Second run: byte-identical no-op — units unchanged, still idempotently enabled.
        const before = readFileSync(servicePath, "utf8");
        step.run();
        expect(readFileSync(servicePath, "utf8")).toBe(before);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("no systemd: writes NOTHING and does not throw (manual fallback emitted)", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-selfheal-nosd-"));
      try {
        const servicePath = join(tmp, "switchroom-self-heal.service");
        const timerPath = join(tmp, "switchroom-self-heal.timer");
        const calls: string[][] = [];
        const step = stepFor({
          selfHealTimerDeps: {
            env: { SUDO_USER: "alice", SWITCHROOM_BINARY: "/usr/local/bin/switchroom" },
            systemdBooted: () => false,
            geteuid: () => 0,
            runner: (cmd, args) => {
              calls.push([cmd, ...args]);
              return { status: 0 };
            },
            servicePath,
            timerPath,
          },
        });
        expect(() => step.run()).not.toThrow();
        expect(existsSync(servicePath)).toBe(false);
        expect(existsSync(timerPath)).toBe(false);
        expect(calls).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("is deferred (skipReason) in hostd-context — /etc/systemd/system is on the host", () => {
      expect(stepFor({ hostdContext: true }).skipReason).toMatch(/hostd-context/);
      expect(stepFor({ hostdContext: false }).skipReason).toBeUndefined();
    });
  });

  it("refresh-hindsight runs when memory.backend is hindsight, skips otherwise / on --skip-images", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-hs-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const find = (steps: ReturnType<typeof planUpdate>) =>
        steps.find((s) => s.name === "refresh-hindsight")!;
      // backend = hindsight → step is active (no skipReason).
      expect(
        find(planUpdate({ composePath, memoryBackendHindsight: true })).skipReason,
      ).toBeUndefined();
      // backend != hindsight → skipped.
      expect(
        find(planUpdate({ composePath, memoryBackendHindsight: false })).skipReason,
      ).toMatch(/not hindsight/);
      // --skip-images → skipped even when backend is hindsight.
      expect(
        find(planUpdate({ composePath, memoryBackendHindsight: true, skipImages: true }))
          .skipReason,
      ).toMatch(/skip-images/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #2851: `memory setup` never reads release.pin, so the refresh-hindsight
  // step must thread the resolved target through as `--tag <version>` (like
  // `switchroom rollout` does) — otherwise the recreate floats to `:latest`
  // and the memory singleton drifts a version behind the pinned fleet.
  describe("refresh-hindsight pins the recreate to the release target (#2851)", () => {
    const findRefresh = (opts: Parameters<typeof planUpdate>[0]) =>
      planUpdate({ composePath: "unused-for-run", memoryBackendHindsight: true, ...opts }).find(
        (s) => s.name === "refresh-hindsight",
      )!;

    it("threads --tag <version> when this run passes --pin vX.Y.Z", () => {
      const runner = fakeRunner();
      findRefresh({ pin: "v0.17.5", runner: runner.fn }).run();
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]!.args.slice(-5)).toEqual([
        "memory",
        "setup",
        "--recreate",
        "--tag",
        "v0.17.5",
      ]);
    });

    it("omits --tag (floating :latest) when there is no pin", () => {
      const runner = fakeRunner();
      // hindsightPinTag:"" is the explicit floating override — avoids reading
      // the developer's real ~/.switchroom config in this unit test.
      findRefresh({ hindsightPinTag: "", runner: runner.fn }).run();
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]!.args.slice(-3)).toEqual(["memory", "setup", "--recreate"]);
      expect(runner.calls[0]!.args).not.toContain("--tag");
    });

    it("leaves hindsight floating under a --channel override", () => {
      const runner = fakeRunner();
      // channel short-circuits before any config read.
      findRefresh({ channel: "dev", runner: runner.fn }).run();
      expect(runner.calls[0]!.args).not.toContain("--tag");
    });

    it("does not pin a sha-<hash> --pin (no per-sha hindsight image published)", () => {
      const runner = fakeRunner();
      findRefresh({ pin: "sha-abc1234", runner: runner.fn }).run();
      expect(runner.calls[0]!.args).not.toContain("--tag");
    });
  });

  describe("resolveHindsightPinTag", () => {
    it("returns a vX.Y.Z --pin verbatim, undefined for sha / channel / empty override", () => {
      expect(resolveHindsightPinTag({ pin: "v0.17.5" })).toBe("v0.17.5");
      expect(resolveHindsightPinTag({ pin: "sha-deadbeef" })).toBeUndefined();
      expect(resolveHindsightPinTag({ pin: "v0.17.5", channel: "dev" })).toBeUndefined();
      // Explicit floating override wins over everything (and reads no config).
      expect(resolveHindsightPinTag({ hindsightPinTag: "", pin: "v0.17.5" })).toBeUndefined();
      expect(resolveHindsightPinTag({ hindsightPinTag: "v0.16.11" })).toBe("v0.16.11");
    });

    it("normalizes a bare X.Y.Z --pin to canonical vX.Y.Z (parity with hindsightImageRef)", () => {
      // Regression for #2857: a release.pin stored without the leading `v`
      // used to fall through the strict /^v\d+\.\d+\.\d+$/ gate and float to
      // :latest, silently un-pinning hindsight while the rest of the fleet
      // stayed on the pinned tag.
      expect(resolveHindsightPinTag({ pin: "0.17.5" })).toBe("v0.17.5");
      // A sha pin has no per-version image published → still floats.
      expect(resolveHindsightPinTag({ pin: "sha-cafebabe" })).toBeUndefined();
      // Garbage still floats.
      expect(resolveHindsightPinTag({ pin: "not-a-version" })).toBeUndefined();
    });
  });

  it("inserts regen-compose-for-release-override BEFORE pull-images when --channel is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-chan-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({
        composePath,
        hostControlEnabled: false,
        channel: "dev",
      });
      const idxRegen = steps.findIndex(
        (s) => s.name === "regen-compose-for-release-override",
      );
      const idxPull = steps.findIndex((s) => s.name === "pull-images");
      expect(idxRegen).toBeGreaterThanOrEqual(0);
      expect(idxRegen).toBeLessThan(idxPull);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inserts regen-compose-for-release-override when --pin is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-pin-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({
        composePath,
        hostControlEnabled: false,
        pin: "sha-abc1234",
      });
      expect(steps.map((s) => s.name)).toContain(
        "regen-compose-for-release-override",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inserts persist-release-pin BEFORE regen-compose when --pin is set, and its run persists the pin", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-persist-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const persisted: string[] = [];
      const steps = planUpdate({
        composePath,
        hostControlEnabled: false,
        pin: "v0.15.19",
        persistPinFn: (p) => persisted.push(p),
      });
      const names = steps.map((s) => s.name);
      // persist must come before the compose regen (so apply reads the persisted pin)
      expect(names).toContain("persist-release-pin");
      expect(names.indexOf("persist-release-pin")).toBeLessThan(
        names.indexOf("regen-compose-for-release-override"),
      );
      // running the step persists exactly the pin
      steps.find((s) => s.name === "persist-release-pin")!.run();
      expect(persisted).toEqual(["v0.15.19"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT insert persist-release-pin when --channel (not --pin) is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-chan-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, hostControlEnabled: false, channel: "latest" });
      expect(steps.map((s) => s.name)).not.toContain("persist-release-pin");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT insert regen-compose-for-release-override when neither --channel nor --pin set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-norel-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, hostControlEnabled: false });
      expect(steps.map((s) => s.name)).not.toContain(
        "regen-compose-for-release-override",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inserts the rebuild-source step when --rebuild is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-rebuild-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({
        composePath,
        rebuild: true,
        hostControlEnabled: false,
        webServiceManaged: false,
        memoryBackendHindsight: false,
      });
      expect(steps.map((s) => s.name)).toEqual([
        "self-update-cli",
        "pull-images",
        "rebuild-source",
        "apply-config",
        "reconcile-hindsight-watch-cron",
        "reconcile-mental-model-refresh-cron",
        "reconcile-config-repo-cron",
        "install-self-heal-timer",
        "refresh-hostd",
        "refresh-web",
        "refresh-hindsight",
        "sync-bundled-skills",
        "verify-bundled-skills",
        "stamp-restart-marker",
        "recreate-containers",
        "doctor",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe("--rebuild guardrail (published-install refusal)", () => {
    it("rebuildRefusalMessage: allow ONLY a real switchroom checkout", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-guard-"));
      try {
        // (a) No .git anywhere up the chain → published install → refuse.
        const noGit = join(tmp, "lib", "node_modules", "switchroom", "x.js");
        const msg = rebuildRefusalMessage(noGit);
        expect(msg).not.toBeNull();
        expect(msg!).toContain("npm i -g switchroom@latest && switchroom update");

        // (b) REGRESSION for the v0.12.2 defect: a .git ancestor that
        // is NOT a switchroom checkout (e.g. ~/.nvm is a git clone, or
        // a dotfiles $HOME). An npm-global install lives under such a
        // path. MUST still refuse — a bare ".git ancestor" check did
        // not, so the guard never fired on the very host it protects.
        const nvmLike = join(tmp, ".nvm");
        mkdirSync(join(nvmLike, ".git"), { recursive: true }); // nvm's own repo, no switchroom pkg
        const installed = join(
          nvmLike, "versions", "node", "vX", "lib",
          "node_modules", "switchroom", "dist", "cli", "switchroom.js",
        );
        mkdirSync(join(nvmLike, "versions", "node", "vX", "lib",
          "node_modules", "switchroom"), { recursive: true });
        // even with switchroom's own package.json present (no .git there):
        writeFileSync(
          join(nvmLike, "versions", "node", "vX", "lib", "node_modules",
            "switchroom", "package.json"),
          JSON.stringify({ name: "switchroom", version: "0.0.0" }),
        );
        expect(rebuildRefusalMessage(installed)).not.toBeNull();

        // (c) Real switchroom checkout: .git AND switchroom package.json
        // at the SAME dir → allowed.
        const repo = join(tmp, "repo");
        mkdirSync(join(repo, ".git"), { recursive: true });
        writeFileSync(
          join(repo, "package.json"),
          JSON.stringify({ name: "switchroom", version: "0.0.0" }),
        );
        const inCheckout = join(repo, "dist", "cli", "switchroom.js");
        expect(rebuildRefusalMessage(inCheckout)).toBeNull();

        // (d) git worktree of switchroom: .git is a FILE (gitlink),
        // package.json still name=switchroom → allowed.
        const wt = join(tmp, "wt");
        mkdirSync(wt, { recursive: true });
        writeFileSync(join(wt, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n");
        writeFileSync(
          join(wt, "package.json"),
          JSON.stringify({ name: "switchroom", version: "0.0.0" }),
        );
        expect(
          rebuildRefusalMessage(join(wt, "dist", "cli", "switchroom.js")),
        ).toBeNull();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("runUpdate hard-refuses --rebuild on a published install (exit 2, nothing runs)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-guard-run-"));
      try {
        const composePath = join(tmp, "docker-compose.yml");
        writeFileSync(composePath, "services: {}\n");
        const out: string[] = [];
        const err: string[] = [];
        const runner = fakeRunner();
        const code = await runUpdate({
          rebuild: true,
          scriptPath: join(tmp, "node_modules", "switchroom", "cli.js"), // no .git
          composePath,
          stdout: (s) => out.push(s),
          stderr: (s) => err.push(s),
          runner: runner.fn,
        });
        expect(code).toBe(2);
        expect(runner.calls).toHaveLength(0); // preflight: nothing executed
        expect(err.join("")).toContain("npm i -g switchroom@latest");
        expect(err.join("")).toMatch(/published install/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("the refusal fires even under --check (no plan printed)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-guard-check-"));
      try {
        const composePath = join(tmp, "docker-compose.yml");
        writeFileSync(composePath, "services: {}\n");
        const out: string[] = [];
        const err: string[] = [];
        const code = await runUpdate({
          check: true,
          rebuild: true,
          scriptPath: join(tmp, "bin", "switchroom"), // no .git
          composePath,
          stdout: (s) => out.push(s),
          stderr: (s) => err.push(s),
          runner: fakeRunner().fn,
        });
        expect(code).toBe(2);
        expect(out.join("")).not.toMatch(/dry-run/);
        expect(err.join("")).toContain("switchroom update");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("in-step defence-in-depth: planUpdate's rebuild-source.run() throws on a published install", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-guard-step-"));
      try {
        const composePath = join(tmp, "docker-compose.yml");
        writeFileSync(composePath, "services: {}\n");
        const steps = planUpdate({
          composePath,
          rebuild: true,
          hostControlEnabled: false,
          scriptPath: join(tmp, "node_modules", "switchroom", "cli.js"),
        });
        const rebuild = steps.find((s) => s.name === "rebuild-source")!;
        expect(rebuild).toBeDefined();
        expect(() => rebuild.run()).toThrow(/npm i -g switchroom@latest/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("does NOT refuse when running from a real source checkout", () => {
      const tmp = mkdtempSync(join(tmpdir(), "update-guard-ok-"));
      try {
        mkdirSync(join(tmp, ".git"), { recursive: true });
        writeFileSync(
          join(tmp, "package.json"),
          JSON.stringify({ name: "switchroom", version: "0.0.0" }),
        );
        const scriptPath = join(tmp, "dist", "cli", "switchroom.js");
        expect(rebuildRefusalMessage(scriptPath)).toBeNull();
        const composePath = join(tmp, "docker-compose.yml");
        writeFileSync(composePath, "services: {}\n");
        const steps = planUpdate({
          composePath,
          rebuild: true,
          hostControlEnabled: false,
          scriptPath,
        });
        // rebuild-source present and its guard does not throw.
        const rebuild = steps.find((s) => s.name === "rebuild-source")!;
        expect(rebuild).toBeDefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  // refresh-hostd: PR ε — closes the gap that hostd lives in a separate
  // compose project and was previously not refreshed by `update`.
  describe("refresh-hostd step", () => {
    function planFor(opts: Parameters<typeof planUpdate>[0]) {
      const tmp = mkdtempSync(join(tmpdir(), "update-hostd-"));
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, ...opts });
      const refresh = steps.find((s) => s.name === "refresh-hostd")!;
      rmSync(tmp, { recursive: true, force: true });
      return { steps, refresh };
    }

    it("is placed AFTER apply-config and BEFORE sync-bundled-skills", () => {
      const { steps } = planFor({ hostControlEnabled: true });
      const idxApply = steps.findIndex((s) => s.name === "apply-config");
      const idxRefresh = steps.findIndex((s) => s.name === "refresh-hostd");
      const idxSync = steps.findIndex((s) => s.name === "sync-bundled-skills");
      const idxRecreate = steps.findIndex((s) => s.name === "recreate-containers");
      expect(idxApply).toBeLessThan(idxRefresh);
      expect(idxRefresh).toBeLessThan(idxSync);
      expect(idxRefresh).toBeLessThan(idxRecreate);
    });

    it("runs (no skipReason) when host_control.enabled is true and --skip-images is not set", () => {
      const { refresh } = planFor({ hostControlEnabled: true });
      expect(refresh.skipReason).toBeUndefined();
    });

    it("skips with a clear reason when host_control is disabled", () => {
      const { refresh } = planFor({ hostControlEnabled: false });
      expect(refresh.skipReason).toMatch(/host_control\.enabled is not true/);
    });

    it("skips when --skip-images is set even with host_control enabled", () => {
      const { refresh } = planFor({
        hostControlEnabled: true,
        skipImages: true,
      });
      expect(refresh.skipReason).toMatch(/--skip-images/);
    });

    it("invokes `switchroom hostd install` via re-exec when run()", () => {
      const runner = fakeRunner();
      const { refresh } = planFor({
        hostControlEnabled: true,
        runner: runner.fn,
      });
      refresh.run();
      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      // First positional arg after process.execPath is the CLI script
      // path (process.argv[1]). The next two are the verb + subverb.
      expect(call.args.slice(-2)).toEqual(["hostd", "install"]);
    });

    it("throws if hostd install exits non-zero", () => {
      const runner = fakeRunner();
      runner.setNextStatus(1);
      const { refresh } = planFor({
        hostControlEnabled: true,
        runner: runner.fn,
      });
      expect(() => refresh.run()).toThrow(/switchroom hostd install failed/);
    });
  });

  // refresh-web: Phase 3 — the web service lives in a separate compose
  // project (switchroom-web) and is opt-in (web_service.managed) so
  // existing systemd-mode installs aren't surprised.
  describe("refresh-web step", () => {
    function planFor(opts: Parameters<typeof planUpdate>[0]) {
      const tmp = mkdtempSync(join(tmpdir(), "update-web-"));
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, ...opts });
      const refresh = steps.find((s) => s.name === "refresh-web")!;
      rmSync(tmp, { recursive: true, force: true });
      return { steps, refresh };
    }

    it("runs (no skipReason) when web_service.managed is true and --skip-images is not set", () => {
      const { refresh } = planFor({ webServiceManaged: true });
      expect(refresh.skipReason).toBeUndefined();
    });

    it("skips with a clear reason when web_service.managed is false (default — legacy systemd unit)", () => {
      const { refresh } = planFor({ webServiceManaged: false });
      expect(refresh.skipReason).toMatch(/web_service\.managed is not true/);
    });

    it("skips when --skip-images is set even with web_service.managed enabled", () => {
      const { refresh } = planFor({
        webServiceManaged: true,
        skipImages: true,
      });
      expect(refresh.skipReason).toMatch(/--skip-images/);
    });

    it("invokes `switchroom webd install` via re-exec when run()", () => {
      const runner = fakeRunner();
      const { refresh } = planFor({
        webServiceManaged: true,
        runner: runner.fn,
      });
      refresh.run();
      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      expect(call.args.slice(-2)).toEqual(["webd", "install"]);
    });

    it("throws if webd install exits non-zero", () => {
      const runner = fakeRunner();
      runner.setNextStatus(1);
      const { refresh } = planFor({
        webServiceManaged: true,
        runner: runner.fn,
      });
      expect(() => refresh.run()).toThrow(/switchroom webd install failed/);
    });
  });

  it("stamp-restart-marker runs before recreate-containers and writes a marker per agent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const writes: Array<{ agent: string; reason: string }> = [];
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["clerk", "klanker", "test-harness"],
        writeMarkerFn: (agent, reason) => { writes.push({ agent, reason }); },
      });
      const stampIdx = steps.findIndex((s) => s.name === "stamp-restart-marker");
      const recreateIdx = steps.findIndex((s) => s.name === "recreate-containers");
      expect(stampIdx).toBeGreaterThan(-1);
      expect(stampIdx).toBeLessThan(recreateIdx);
      // Execute the stamp step in isolation.
      steps[stampIdx]?.run();
      expect(writes).toEqual([
        { agent: "clerk", reason: "operator: switchroom update" },
        { agent: "klanker", reason: "operator: switchroom update" },
        { agent: "test-harness", reason: "operator: switchroom update" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stamp-restart-marker uses docker exec by default (Docker-runtime fix: host-side write fails with EACCES on UID-owned dirs)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-exec-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const runner = fakeRunner();
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["carrie", "klanker"],
        runner: runner.fn,
      });
      const stamp = steps.find((s) => s.name === "stamp-restart-marker");
      stamp?.run();
      expect(runner.calls).toHaveLength(2);
      // Both calls target docker exec into the named container.
      expect(runner.calls[0]?.cmd).toBe("docker");
      expect(runner.calls[0]?.args[0]).toBe("exec");
      expect(runner.calls[0]?.args[1]).toBe("switchroom-carrie");
      expect(runner.calls[0]?.args[2]).toBe("sh");
      expect(runner.calls[0]?.args[3]).toBe("-c");
      // The command writes a JSON marker with the canonical reason text
      // to the in-container path (which is the same file the host sees
      // via the compose bind-mount).
      expect(runner.calls[0]?.args[4]).toMatch(/printf/);
      expect(runner.calls[0]?.args[4]).toMatch(/"reason":"operator: switchroom update"/);
      expect(runner.calls[0]?.args[4]).toMatch(/\/state\/agent\/telegram\/clean-shutdown\.json/);
      expect(runner.calls[1]?.args[1]).toBe("switchroom-klanker");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stamp-restart-marker falls back to host-writer when docker exec fails (systemd-runtime / no-container path)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-fallback-"));
    const prevAgentsDir = process.env.SWITCHROOM_AGENTS_DIR;
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      // Point the host writer at our tmp dir so we can observe what
      // would normally land in ~/.switchroom/agents/<name>/telegram/.
      process.env.SWITCHROOM_AGENTS_DIR = tmp;
      mkdirSync(join(tmp, "carrie", "telegram"), { recursive: true });
      const runner = fakeRunner();
      // Force every docker exec to fail (status 127 == "sh not found"
      // / no such container in practice).
      runner.setNextStatus(127);
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["carrie"],
        runner: runner.fn,
      });
      const stamp = steps.find((s) => s.name === "stamp-restart-marker");
      stamp?.run();
      // Exactly one docker exec attempt, then fallback fires.
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.args[0]).toBe("exec");
      // Host writer must have produced the marker file at the
      // bind-mount location — that's the regression-catch: if the
      // fallback ever gets accidentally removed (e.g. someone inverts
      // the status check), this assertion fails.
      const markerPath = join(tmp, "carrie", "telegram", "clean-shutdown.json");
      expect(existsSync(markerPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as {
        reason?: string;
        signal?: string;
      };
      expect(parsed.reason).toBe("operator: switchroom update");
      expect(parsed.signal).toBe("SIGTERM");
    } finally {
      if (prevAgentsDir === undefined) {
        delete process.env.SWITCHROOM_AGENTS_DIR;
      } else {
        process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDir;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stamp-restart-marker tolerates per-agent write failures without aborting", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-stamp-err-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const writes: string[] = [];
      const steps = planUpdate({
        composePath,
        agentNamesFn: () => ["a", "b", "c"],
        writeMarkerFn: (agent) => {
          if (agent === "b") throw new Error("simulated EACCES");
          writes.push(agent);
        },
      });
      const stamp = steps.find((s) => s.name === "stamp-restart-marker");
      // Should NOT throw — failures are best-effort.
      expect(() => stamp?.run()).not.toThrow();
      expect(writes).toEqual(["a", "c"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips pull-images with a clear reason when --skip-images is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-skip-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, skipImages: true });
      const pull = steps.find((s) => s.name === "pull-images");
      expect(pull?.skipReason).toContain("--skip-images");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips pull-images with the right reason when compose file doesn't exist", () => {
    const steps = planUpdate({ composePath: "/nonexistent/compose.yml" });
    const pull = steps.find((s) => s.name === "pull-images");
    expect(pull?.skipReason).toContain("compose file not found");
    expect(pull?.skipReason).toContain("apply --compose-only");
  });

  it("never skips recreate-containers — even with --skip-images, apply may have changed compose (#923 reviewer)", () => {
    const steps = planUpdate({ skipImages: true });
    const recreate = steps.find((s) => s.name === "recreate-containers");
    expect(recreate?.skipReason).toBeUndefined();
  });
});

describe("--status (#927)", () => {
  it("formatStatusReport renders CLI version + per-service ages", async () => {
    const { formatStatusReport } = await import("./update.js");
    // Fixed clock for deterministic age strings.
    const now = Date.parse("2026-05-10T18:00:00Z");
    const out = formatStatusReport({
      cliVersion: "0.7.7",
      cliBuiltAt: new Date(now - 30 * 60 * 1000).toISOString(), // 30m ago
      services: [
        {
          name: "agent-clerk",
          image: "ghcr.io/x/switchroom-agent:latest",
          imageDigestShort: "abc123def456",
          imagePulledAt: new Date(now - 4 * 3600 * 1000).toISOString(), // 4h
          containerCreatedAt: new Date(now - 1 * 3600 * 1000).toISOString(), // 1h
          status: "running",
        },
      ],
      warnings: [],
    });
    expect(out).toContain("CLI: 0.7.7");
    expect(out).toContain("agent-clerk");
    expect(out).toContain("running");
    expect(out).toContain("[abc123def456]");
  });

  it("runUpdate --status uses statusProbe seam, never invokes runner", async () => {
    const { runUpdate } = await import("./update.js");
    const out: string[] = [];
    let runnerCalled = false;
    let probedComposePath = "";
    const code = await runUpdate({
      status: true,
      composePath: "/some/compose.yml",
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      runner: () => { runnerCalled = true; return { status: 0 }; },
      statusProbe: (p) => {
        probedComposePath = p;
        return {
          cliVersion: "test",
          cliBuiltAt: null,
          services: [],
          warnings: [],
        };
      },
    });
    expect(code).toBe(0);
    expect(runnerCalled).toBe(false); // status mode runs no steps
    expect(probedComposePath).toBe("/some/compose.yml");
    expect(out.join("")).toContain("CLI: test");
  });

  it("runUpdate --json without --status fails loud (exit 2) — #938 reviewer", async () => {
    const { runUpdate } = await import("./update.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpdate({
      json: true,
      composePath: "/x.yml",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      runner: () => ({ status: 0 }),
    });
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/--json is only honored under --status/);
  });

  it("formatStatusReport handles long service names without breaking column alignment", async () => {
    const { formatStatusReport } = await import("./update.js");
    const now = Date.parse("2026-05-14T18:00:00Z");
    const out = formatStatusReport({
      cliVersion: "0.7.13",
      cliBuiltAt: null,
      services: [
        {
          name: "vault-broker",
          image: "ghcr.io/x/sw-broker:latest",
          imageDigestShort: "abc",
          imagePulledAt: new Date(now - 3600 * 1000).toISOString(),
          containerCreatedAt: new Date(now - 1800 * 1000).toISOString(),
          status: "running",
        },
        {
          name: "switchroom-auth-broker",
          image: "ghcr.io/x/sw-auth-broker:latest",
          imageDigestShort: "def",
          imagePulledAt: new Date(now - 3600 * 1000).toISOString(),
          containerCreatedAt: new Date(now - 1800 * 1000).toISOString(),
          status: "running",
        },
      ],
      warnings: [],
    });
    // The auth-broker line should appear, and the vault-broker line
    // should be padded out to align with the longer name.
    expect(out).toContain("switchroom-auth-broker");
    expect(out).toContain("vault-broker");
    // Pulled-from-padding: vault-broker should be padded with at least
    // (len(switchroom-auth-broker) - len(vault-broker)) = 10 trailing spaces
    // before the status column. We assert the [abc] digest comes after
    // a run of >= 2 spaces on the vault-broker line.
    const vaultLine = out.split("\n").find((l) => l.includes("vault-broker"))!;
    expect(vaultLine).toMatch(/vault-broker {10,}/);
  });

  it("serviceToContainerName maps every compose-service shape", async () => {
    const { serviceToContainerName } = await import("./update.js");
    expect(serviceToContainerName("agent-clerk")).toBe("switchroom-clerk");
    expect(serviceToContainerName("vault-broker")).toBe("switchroom-vault-broker");
    expect(serviceToContainerName("approval-kernel")).toBe("switchroom-approval-kernel");
    // Already-prefixed services (e.g. the auth-broker service that's
    // named `switchroom-auth-broker` in compose) must NOT be double-
    // prefixed — that would land on `switchroom-switchroom-auth-broker`
    // and `docker inspect` would always miss.
    expect(serviceToContainerName("switchroom-auth-broker")).toBe(
      "switchroom-auth-broker",
    );
  });

  it("runUpdate --status --json emits parseable JSON with the report shape", async () => {
    const { runUpdate } = await import("./update.js");
    const out: string[] = [];
    await runUpdate({
      status: true,
      json: true,
      composePath: "/x.yml",
      stdout: (s) => out.push(s),
      runner: () => ({ status: 0 }),
      statusProbe: () => ({
        cliVersion: "0.7.8",
        cliBuiltAt: "2026-05-10T18:00:00Z",
        services: [
          { name: "vault-broker", image: "ghcr.io/x:latest", imageDigestShort: "deadbeef", imagePulledAt: null, containerCreatedAt: null, status: "running" },
        ],
        warnings: ["test warning"],
      }),
    });
    const parsed = JSON.parse(out.join(""));
    expect(parsed.cliVersion).toBe("0.7.8");
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0].name).toBe("vault-broker");
    expect(parsed.warnings).toEqual(["test warning"]);
  });
});

describe("--rebuild against a non-checkout install fails loudly (#923 reviewer)", () => {
  it("rebuild-source step throws when scriptPath has no .git ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rebuild-no-git-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      // Spoof argv[1] to a path with no .git ancestor for the duration
      // of the plan() + run() calls.
      const origArgv1 = process.argv[1];
      process.argv[1] = join(tmp, "fake-installed-cli.js");
      try {
        const steps = planUpdate({ composePath, rebuild: true });
        const rebuild = steps.find((s) => s.name === "rebuild-source");
        expect(rebuild).toBeDefined();
        expect(rebuild?.skipReason).toBeUndefined(); // not silently skipped
        // Message was upgraded to point at the published path (the
        // preflight in runUpdate now refuses before this even runs;
        // this remains as in-step defence-in-depth).
        expect(() => rebuild!.run()).toThrow(/npm i -g switchroom@latest/);
      } finally {
        process.argv[1] = origArgv1;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runUpdate", () => {
  it("dry-runs cleanly under --check, no runner calls", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-check-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      const code = await runUpdate({
        check: true,
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
      });
      expect(code).toBe(0);
      expect(runner.calls).toHaveLength(0);
      const joined = out.join("");
      expect(joined).toMatch(/dry-run/);
      expect(joined).toMatch(/pull-images/);
      expect(joined).toMatch(/apply-config/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs the steps in order via the injected runner", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-run-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      const code = await runUpdate({
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
        // Stamp-marker step fans out to `docker exec` per agent; pin the
        // agent set deterministically here so the assertions don't read
        // the host's real switchroom.yaml.
        agentNamesFn: () => ["a", "b"],
        // No-op the sync-bundled-skills filesystem effect under tests.
        syncBundledSkillsFn: () => { /* intentional no-op */ },
        // Pin host_control as disabled so refresh-hostd is skipped —
        // separate test below covers the enabled case. Without this
        // override, this test would pick up the host's real
        // switchroom.yaml and the call count would depend on whether
        // the developer running tests has hostd enabled.
        hostControlEnabled: false,
        // Likewise pin web_service.managed + memory.backend off so the
        // refresh-web / refresh-hindsight steps are skipped — otherwise the
        // host's real switchroom.yaml leaks in and a dev/operator box adds
        // extra calls ("length 6 got 7+" on the live host).
        webServiceManaged: false,
        memoryBackendHindsight: false,
      });
      expect(code).toBe(0);
      // 6 calls total:
      //   [0] docker compose pull
      //   [1] <execPath> apply --non-interactive --no-doctor
      //   [2] docker exec switchroom-a sh -c '…'  ← stamp-restart-marker
      //   [3] docker exec switchroom-b sh -c '…'  ← stamp-restart-marker
      //   [4] docker compose up -d --remove-orphans
      //   [5] <execPath> doctor
      expect(runner.calls).toHaveLength(6);
      expect(runner.calls[0]?.cmd).toBe("docker");
      expect(runner.calls[0]?.args).toContain("pull");
      expect(runner.calls[1]?.cmd).toBe(process.execPath);
      expect(runner.calls[1]?.args).toContain("apply");
      expect(runner.calls[1]?.args).toContain("--non-interactive");
      expect(runner.calls[1]?.args).toContain("--no-doctor");
      // Marker writes: one docker exec per agent, targeting the
      // in-container clean-shutdown.json path.
      expect(runner.calls[2]?.cmd).toBe("docker");
      expect(runner.calls[2]?.args.slice(0, 3)).toEqual(["exec", "switchroom-a", "sh"]);
      expect(runner.calls[2]?.args.at(-1)).toMatch(/operator: switchroom update/);
      expect(runner.calls[2]?.args.at(-1)).toMatch(/\/state\/agent\/telegram\/clean-shutdown\.json/);
      expect(runner.calls[3]?.cmd).toBe("docker");
      expect(runner.calls[3]?.args.slice(0, 3)).toEqual(["exec", "switchroom-b", "sh"]);
      // [4] docker compose up -d --remove-orphans
      expect(runner.calls[4]?.cmd).toBe("docker");
      expect(runner.calls[4]?.args).toContain("up");
      expect(runner.calls[4]?.args).toContain("--remove-orphans");
      // [5] <execPath> doctor
      expect(runner.calls[5]?.cmd).toBe(process.execPath);
      expect(runner.calls[5]?.args).toContain("doctor");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("invokes `switchroom hostd install` between apply and stamp-marker when host_control is enabled (PR ε)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-hostd-on-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      const code = await runUpdate({
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
        agentNamesFn: () => ["a"],
        syncBundledSkillsFn: () => { /* intentional no-op */ },
        hostControlEnabled: true,
        // Pin web_service.managed + memory.backend off so the refresh-web /
        // refresh-hindsight steps don't leak in from the host's real
        // switchroom.yaml (would make this 7+ calls).
        webServiceManaged: false,
        memoryBackendHindsight: false,
      });
      expect(code).toBe(0);
      // 6 calls total:
      //   [0] docker compose pull
      //   [1] <execPath> apply --non-interactive --no-doctor
      //   [2] <execPath> hostd install                 ← NEW (PR ε)
      //   [3] docker exec switchroom-a sh -c '…'  (stamp marker)
      //   [4] docker compose up -d --remove-orphans
      //   [5] <execPath> doctor
      expect(runner.calls).toHaveLength(6);
      // hostd install lands at position 2 (right after apply).
      expect(runner.calls[2]?.cmd).toBe(process.execPath);
      expect(runner.calls[2]?.args.slice(-2)).toEqual(["hostd", "install"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails fast on a step error and reports which step", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-fail-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      runner.setNextStatus(1); // first call (pull) fails
      const code = await runUpdate({
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
      });
      expect(code).toBe(1);
      // Should NOT have proceeded to apply / up / doctor.
      expect(runner.calls).toHaveLength(1);
      expect(out.join("")).toMatch(/pull-images failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("isGitCheckout", () => {
  it("returns true for a path under a directory containing .git", () => {
    const tmp = mkdtempSync(join(tmpdir(), "git-detect-"));
    try {
      mkdirSync(join(tmp, ".git"), { recursive: true });
      mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
      const scriptPath = join(tmp, "dist", "cli", "switchroom.js");
      writeFileSync(scriptPath, "");
      expect(isGitCheckout(scriptPath)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false for a path with no .git ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "no-git-detect-"));
    try {
      mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
      const scriptPath = join(tmp, "dist", "cli", "switchroom.js");
      writeFileSync(scriptPath, "");
      expect(isGitCheckout(scriptPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── #2458 hostd-context deferral ──────────────────────────────────────────────

describe("isHostdContext", () => {
  it("returns true when SWITCHROOM_HOSTD_CONTEXT is '1'", () => {
    expect(isHostdContext({ SWITCHROOM_HOSTD_CONTEXT: "1" })).toBe(true);
  });

  it("returns false when SWITCHROOM_HOSTD_CONTEXT is absent", () => {
    expect(isHostdContext({})).toBe(false);
  });

  it("returns false when SWITCHROOM_HOSTD_CONTEXT is set to another value", () => {
    expect(isHostdContext({ SWITCHROOM_HOSTD_CONTEXT: "true" })).toBe(false);
    expect(isHostdContext({ SWITCHROOM_HOSTD_CONTEXT: "0" })).toBe(false);
  });
});

describe("encodeUpdateResultLine / parseUpdateResultLine", () => {
  it("round-trips { ok: true, deferred: ['refresh-hostd', 'refresh-web'] }", () => {
    const payload = { ok: true, deferred: ["refresh-hostd", "refresh-web"] };
    const line = encodeUpdateResultLine(payload);
    expect(line.startsWith(UPDATE_RESULT_SENTINEL)).toBe(true);
    const parsed = parseUpdateResultLine(line);
    expect(parsed).toEqual(payload);
  });

  it("round-trips { ok: false, deferred: ['refresh-hostd'] }", () => {
    const payload = { ok: false, deferred: ["refresh-hostd"] };
    const line = encodeUpdateResultLine(payload);
    const parsed = parseUpdateResultLine(line);
    expect(parsed).toEqual(payload);
  });

  it("returns null for stdout with no sentinel", () => {
    expect(parseUpdateResultLine("no sentinel here\n")).toBeNull();
    expect(parseUpdateResultLine("")).toBeNull();
  });

  it("returns null for malformed JSON after the sentinel", () => {
    expect(parseUpdateResultLine(`${UPDATE_RESULT_SENTINEL}not-json`)).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    expect(
      parseUpdateResultLine(`${UPDATE_RESULT_SENTINEL}{"ok":true}`),
    ).toBeNull();
    expect(
      parseUpdateResultLine(`${UPDATE_RESULT_SENTINEL}{"deferred":[]}`),
    ).toBeNull();
  });

  it("finds the LAST sentinel line when stdout has multiple occurrences", () => {
    const first = encodeUpdateResultLine({ ok: false, deferred: ["refresh-hostd"] });
    const second = encodeUpdateResultLine({ ok: true, deferred: ["refresh-hostd", "refresh-web"] });
    const combined = `some preamble\n${first}\nmore output\n${second}\n`;
    const parsed = parseUpdateResultLine(combined);
    // Must return the LAST sentinel (ok: true), not the first (ok: false).
    expect(parsed?.ok).toBe(true);
    expect(parsed?.deferred).toEqual(["refresh-hostd", "refresh-web"]);
  });
});

describe("planUpdate — hostdContext deferral (#2458)", () => {
  it("refresh-hostd gets skipReason containing 'deferred' and isHostdDeferred=true when hostdContext=true and hostControlEnabled=true", () => {
    const steps = planUpdate({
      hostControlEnabled: true,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: true,
    });
    const step = steps.find((s) => s.name === "refresh-hostd")!;
    expect(step).toBeDefined();
    expect(step.skipReason).toMatch(/deferred/);
    expect(step.skipReason).toMatch(/#2458/);
    expect(step.isHostdDeferred).toBe(true);
  });

  it("refresh-web gets skipReason containing 'deferred' and isHostdDeferred=true when hostdContext=true and webServiceManaged=true", () => {
    const steps = planUpdate({
      hostControlEnabled: false,
      webServiceManaged: true,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: true,
    });
    const step = steps.find((s) => s.name === "refresh-web")!;
    expect(step).toBeDefined();
    expect(step.skipReason).toMatch(/deferred/);
    expect(step.skipReason).toMatch(/#2458/);
    expect(step.isHostdDeferred).toBe(true);
  });

  it("refresh-hostd still skips with existing reason when hostControlEnabled=false (hostdContext is not checked)", () => {
    const steps = planUpdate({
      hostControlEnabled: false,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: true,
    });
    const step = steps.find((s) => s.name === "refresh-hostd")!;
    expect(step.skipReason).toMatch(/host_control.enabled is not true/);
    expect(step.skipReason).not.toMatch(/deferred/);
    expect(step.isHostdDeferred).toBeFalsy();
  });

  it("refresh-hostd has NO skipReason and isHostdDeferred is falsy when hostdContext=false and hostControlEnabled=true", () => {
    const steps = planUpdate({
      hostControlEnabled: true,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: false,
    });
    const step = steps.find((s) => s.name === "refresh-hostd")!;
    expect(step.skipReason).toBeUndefined();
    expect(step.isHostdDeferred).toBeFalsy();
  });

  it("--skip-images reason still wins over hostdContext deferral; isHostdDeferred is false", () => {
    const steps = planUpdate({
      hostControlEnabled: true,
      webServiceManaged: true,
      memoryBackendHindsight: false,
      skipImages: true,
      hostdContext: true,
    });
    const hostd = steps.find((s) => s.name === "refresh-hostd")!;
    const web = steps.find((s) => s.name === "refresh-web")!;
    expect(hostd.skipReason).toBe("--skip-images flag set");
    expect(web.skipReason).toBe("--skip-images flag set");
    // --skip-images is not a hostd-context deferral; isHostdDeferred must be false
    expect(hostd.isHostdDeferred).toBeFalsy();
    expect(web.isHostdDeferred).toBeFalsy();
  });

  it("deferred sentinel uses isHostdDeferred flag (not skipReason string match) to identify deferred steps", async () => {
    // This test ensures the sentinel emitted by runUpdate correctly identifies
    // deferred steps via the explicit isHostdDeferred flag, not string coupling.
    const lines: string[] = [];
    const code = await runUpdate({
      hostControlEnabled: true,
      webServiceManaged: true,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: true,
      runner: () => ({ status: 0 }),
      composePath: "/dev/null",
      syncBundledSkillsFn: () => {},
      agentNamesFn: () => [],
      writeMarkerFn: () => {},
      stdout: (s) => lines.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    const allOut = lines.join("");
    const parsed = parseUpdateResultLine(allOut);
    // The deferred list must contain exactly the isHostdDeferred=true steps
    expect(parsed?.deferred).toContain("refresh-hostd");
    expect(parsed?.deferred).toContain("refresh-web");
    // Steps whose skipReason doesn't include "deferred" must NOT appear
    expect(parsed?.deferred).not.toContain("pull-images");
    expect(parsed?.deferred).not.toContain("apply-config");
  });
});

describe("runUpdate — hostdContext sentinel emission (#2458)", () => {
  it("emits SWITCHROOM_UPDATE_RESULT sentinel with deferred steps on success", async () => {
    const lines: string[] = [];
    const code = await runUpdate({
      hostControlEnabled: true,
      webServiceManaged: true,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: true,
      // Supply a no-op runner so pull-images / apply-config etc. succeed without docker.
      runner: () => ({ status: 0 }),
      // Provide a composePath so the pull-images step doesn't skip on missing file.
      composePath: "/dev/null",
      // Prevent sync-bundled-skills from writing to real ~/.switchroom.
      syncBundledSkillsFn: () => {},
      // Prevent stamp-restart-marker from reading real config.
      agentNamesFn: () => [],
      writeMarkerFn: () => {},
      stdout: (s) => lines.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    const allOut = lines.join("");
    expect(allOut).toContain(UPDATE_RESULT_SENTINEL);
    const parsed = parseUpdateResultLine(allOut);
    expect(parsed?.ok).toBe(true);
    expect(parsed?.deferred).toContain("refresh-hostd");
    expect(parsed?.deferred).toContain("refresh-web");
  });

  it("does NOT emit sentinel when hostdContext=false (no deferred steps)", async () => {
    const lines: string[] = [];
    await runUpdate({
      hostControlEnabled: false,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: false,
      runner: () => ({ status: 0 }),
      composePath: "/dev/null",
      syncBundledSkillsFn: () => {},
      agentNamesFn: () => [],
      writeMarkerFn: () => {},
      stdout: (s) => lines.push(s),
      stderr: () => {},
    });
    const allOut = lines.join("");
    expect(allOut).not.toContain(UPDATE_RESULT_SENTINEL);
  });

  it("emits sentinel with ok=false when a non-deferred step fails mid-run", async () => {
    const lines: string[] = [];
    let callCount = 0;
    const code = await runUpdate({
      hostControlEnabled: true,
      webServiceManaged: false,
      memoryBackendHindsight: false,
      skipImages: false,
      hostdContext: true,
      runner: () => {
        // Fail only the first real step (pull-images) to trigger the failure path.
        callCount++;
        return { status: callCount === 1 ? 1 : 0 };
      },
      composePath: "/dev/null",
      syncBundledSkillsFn: () => {},
      agentNamesFn: () => [],
      writeMarkerFn: () => {},
      stdout: (s) => lines.push(s),
      stderr: () => {},
    });
    expect(code).toBe(1);
    const allOut = lines.join("");
    // Sentinel IS emitted on failure when there are deferred steps.
    expect(allOut).toContain(UPDATE_RESULT_SENTINEL);
    const parsed = parseUpdateResultLine(allOut);
    expect(parsed?.ok).toBe(false);
    expect(parsed?.deferred).toContain("refresh-hostd");
  });
});
