import { describe, it, expect } from "vitest";

import type { DockerRunner } from "./deploy-version-guard.js";
import {
  HEAL_HELPER_CONTAINER,
  HEAL_PREFIX_MOUNT,
  healHelperArgs,
  planHostCliHeal,
  resolveHelperImage,
  runHostCliHeal,
  type HostCliHealPlan,
} from "./host-cli-heal.js";
import { encodeHostCliUpgradeResult } from "./host-cli-upgrade.js";
import type { HostCliStamp } from "./host-cli-stamp.js";

const STAMP: HostCliStamp = {
  version: "0.21.0",
  installKind: "static-binary",
  path: "/usr/local/bin/switchroom",
  ownerUser: "ken",
  ownerUid: 1000,
};

const HEAL_PLAN: Extract<HostCliHealPlan, { action: "heal" }> = {
  action: "heal",
  prefixHostPath: "/usr/local",
  containerBinaryPath: `${HEAL_PREFIX_MOUNT}/bin/switchroom`,
  from: "0.21.0",
  target: "v0.22.0",
};

describe("planHostCliHeal", () => {
  it("heals a static-binary host install, binding the PREFIX not the bindir", () => {
    const plan = planHostCliHeal({ stamp: STAMP, target: "v0.22.0", hostdCtx: true });
    expect(plan).toEqual(HEAL_PLAN);
  });

  it("handles a per-user prefix", () => {
    const plan = planHostCliHeal({
      stamp: { ...STAMP, path: "/home/ken/.local/bin/switchroom" },
      target: "v0.22.0",
      hostdCtx: true,
    });
    expect(plan).toMatchObject({
      action: "heal",
      prefixHostPath: "/home/ken/.local",
      containerBinaryPath: "/hostcli/bin/switchroom",
    });
  });

  it("skips on the host shell, where the operator can just run the command", () => {
    const plan = planHostCliHeal({ stamp: STAMP, target: "v0.22.0", hostdCtx: false });
    expect(plan).toMatchObject({ action: "skip" });
    expect((plan as { reason: string }).reason).toContain("hostd context");
  });

  it("skips an npm-global install with a quotable reason", () => {
    const plan = planHostCliHeal({
      stamp: { ...STAMP, installKind: "npm-global", npmPrefix: "/home/ken/.nvm/versions/node/v22" },
      target: "v0.22.0",
      hostdCtx: true,
    });
    expect(plan).toMatchObject({ action: "skip" });
    expect((plan as { reason: string }).reason).toContain("npm-global");
  });

  it("skips when there is no stamp to act on", () => {
    expect(
      planHostCliHeal({ stamp: undefined, target: "v0.22.0", hostdCtx: true }),
    ).toMatchObject({ action: "skip" });
  });

  it("skips a non-release target", () => {
    expect(
      planHostCliHeal({ stamp: STAMP, target: "main", hostdCtx: true }),
    ).toMatchObject({ action: "skip" });
  });

  it("refuses a traversal in the recorded path rather than binding it", () => {
    const plan = planHostCliHeal({
      stamp: { ...STAMP, path: "/usr/local/bin/../../../etc/switchroom" },
      target: "v0.22.0",
      hostdCtx: true,
    });
    expect(plan).toMatchObject({ action: "skip" });
    expect((plan as { reason: string }).reason).toContain("plain absolute path");
  });

  it("refuses a recorded path that is not named `switchroom`", () => {
    const plan = planHostCliHeal({
      stamp: { ...STAMP, path: "/usr/local/bin/sshd" },
      target: "v0.22.0",
      hostdCtx: true,
    });
    expect(plan).toMatchObject({ action: "skip" });
    expect((plan as { reason: string }).reason).toContain("not named");
  });

  it("refuses to mount the host root when there is no prefix", () => {
    const plan = planHostCliHeal({
      stamp: { ...STAMP, path: "/switchroom" },
      target: "v0.22.0",
      hostdCtx: true,
    });
    expect(plan).toMatchObject({ action: "skip" });
    expect((plan as { reason: string }).reason).toContain("host root");
  });
});

describe("healHelperArgs", () => {
  const args = healHelperArgs({ plan: HEAL_PLAN, helperImage: "ghcr.io/x/hostd:v0.22.0" });

  it("binds exactly one host directory, rw, and nothing else", () => {
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toEqual([`/usr/local:${HEAL_PREFIX_MOUNT}:rw`]);
  });

  it("gives the helper no docker socket and no ~/.switchroom", () => {
    const joined = args.join(" ");
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain(".switchroom:");
    expect(joined).not.toContain("--privileged");
    expect(joined).not.toContain("--network");
  });

  it("runs detached under a fixed name so a strand can be reaped", () => {
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--name", HEAL_HELPER_CONTAINER]);
  });

  it("passes the IN-CONTAINER binary path, the pin and the from-version", () => {
    expect(args.slice(-8)).toEqual([
      "switchroom",
      "host-cli-upgrade",
      "--binary",
      `${HEAL_PREFIX_MOUNT}/bin/switchroom`,
      "--pin",
      "v0.22.0",
      "--from",
      "0.21.0",
    ]);
  });

  it("runs from the image it is given, not a hardcoded one", () => {
    expect(args).toContain("ghcr.io/x/hostd:v0.22.0");
    expect(
      healHelperArgs({ plan: HEAL_PLAN, helperImage: "mirror.example/hostd:v1" }),
    ).toContain("mirror.example/hostd:v1");
  });
});

/** A scripted docker, recording every argv it was handed. */
function fakeDocker(
  script: Partial<Record<string, { ok: boolean; stdout?: string; stderr?: string }>>,
): { docker: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const docker: DockerRunner = (args) => {
    calls.push(args);
    const r = script[args[0] as string] ?? { ok: true };
    return { ok: r.ok, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { docker, calls };
}

describe("resolveHelperImage", () => {
  it("reads the image off the running hostd container", () => {
    const { docker, calls } = fakeDocker({
      inspect: { ok: true, stdout: "ghcr.io/switchroom/switchroom-hostd:v0.22.0\n" },
    });
    expect(resolveHelperImage(docker)).toBe("ghcr.io/switchroom/switchroom-hostd:v0.22.0");
    expect(calls[0]).toContain("switchroom-hostd");
  });

  it("returns null when the inspect fails or is empty", () => {
    expect(resolveHelperImage(fakeDocker({ inspect: { ok: false } }).docker)).toBeNull();
    expect(
      resolveHelperImage(fakeDocker({ inspect: { ok: true, stdout: "  \n" } }).docker),
    ).toBeNull();
  });
});

describe("runHostCliHeal", () => {
  const ok = encodeHostCliUpgradeResult({
    ok: true,
    version: "v0.22.0",
    binaryPath: "/hostcli/bin/switchroom",
  });

  it("reports the version the helper PROVED, not the pin it was asked for", () => {
    const { docker } = fakeDocker({
      inspect: { ok: true, stdout: "hostd:v0.22.0" },
      run: { ok: true, stdout: "deadbeef" },
      wait: { ok: true, stdout: "0\n" },
      logs: { ok: true, stdout: `noise\n${ok}\n` },
    });
    const out = runHostCliHeal({ plan: HEAL_PLAN, docker });
    expect(out.ok).toBe(true);
    expect(out.version).toBe("v0.22.0");
    // The message names the HOST path, not the in-container one.
    expect(out.message).toContain("/usr/local/bin/switchroom");
    expect(out.message).not.toContain(HEAL_PREFIX_MOUNT);
  });

  it("reaps a stranded helper before spawning, and removes its own after", () => {
    const { docker, calls } = fakeDocker({
      inspect: { ok: true, stdout: "hostd:v0.22.0" },
      wait: { ok: true, stdout: "0" },
      logs: { ok: true, stdout: ok },
    });
    runHostCliHeal({ plan: HEAL_PLAN, docker });
    const verbs = calls.map((c) => c.slice(0, 2).join(" "));
    expect(verbs[1]).toBe("rm -f");
    expect(verbs[2]).toBe("run -d");
    expect(verbs.at(-1)).toBe("rm -f");
  });

  it("fails, without spawning anything, when hostd's image cannot be resolved", () => {
    const { docker, calls } = fakeDocker({ inspect: { ok: false } });
    const out = runHostCliHeal({ plan: HEAL_PLAN, docker });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("no image to run the upgrade helper from");
    expect(calls.map((c) => c[0])).toEqual(["inspect"]);
  });

  it("surfaces the helper's own diagnostic when it exits non-zero", () => {
    const { docker } = fakeDocker({
      inspect: { ok: true, stdout: "hostd:v0.22.0" },
      wait: { ok: true, stdout: "1" },
      logs: {
        ok: true,
        stdout: encodeHostCliUpgradeResult({ ok: false, error: "checksum mismatch" }),
      },
    });
    const out = runHostCliHeal({ plan: HEAL_PLAN, docker });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("checksum mismatch");
  });

  it("does not claim success when the helper exited 0 without a sentinel", () => {
    // A helper killed mid-run can exit 0 with no verdict; treating that as a
    // heal would let the roll proceed against a still-stale host CLI.
    const { docker } = fakeDocker({
      inspect: { ok: true, stdout: "hostd:v0.22.0" },
      wait: { ok: true, stdout: "0" },
      logs: { ok: true, stdout: "downloading...\n" },
    });
    const out = runHostCliHeal({ plan: HEAL_PLAN, docker });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("downloading");
  });

  it("fails when the helper could not be started", () => {
    const { docker, calls } = fakeDocker({
      inspect: { ok: true, stdout: "hostd:v0.22.0" },
      run: { ok: false, stderr: "permission denied while trying to connect" },
    });
    const out = runHostCliHeal({ plan: HEAL_PLAN, docker });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("permission denied");
    expect(calls.map((c) => c[0])).not.toContain("wait");
  });

  it("degrades to a failure — never a throw — when docker blows up mid-flight", () => {
    // The roll handles a failed heal by falling through to the pre-existing
    // refusal. A thrown error would escape that path entirely.
    const calls: string[][] = [];
    const docker: DockerRunner = (args) => {
      calls.push(args);
      if (args[0] === "inspect") return { ok: true, stdout: "hostd:v0.22.0", stderr: "" };
      if (args[0] === "wait") throw new Error("dockerd went away");
      return { ok: true, stdout: "", stderr: "" };
    };
    const out = runHostCliHeal({ plan: HEAL_PLAN, docker });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("dockerd went away");
    // …and the helper is still reaped.
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["rm", "-f"]);
  });

  it("fails when `docker wait` itself fails", () => {
    const { docker } = fakeDocker({
      inspect: { ok: true, stdout: "hostd:v0.22.0" },
      wait: { ok: false, stderr: "no such container" },
      logs: { ok: true, stdout: "" },
    });
    const out = runHostCliHeal({ plan: HEAL_PLAN, docker });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("no such container");
  });
});
