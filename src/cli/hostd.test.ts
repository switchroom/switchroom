/**
 * Tests for `switchroom hostd` — Phase 1.5 packaging verb.
 *
 * Scope: the pure compose-rendering logic and the install verb's
 * config-validation surface. Does NOT exercise `docker compose` itself;
 * those calls go through spawnSync and are stubbed implicitly by not
 * running `install` in these tests.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderHostdComposeFile,
  resolveHostdHostHome,
  resolveHostdImageTag,
  resolveHostdSkillsTarget,
} from "./hostd.js";

describe("renderHostdComposeFile", () => {
  it("renders a valid yaml-shaped string", () => {
    const out = renderHostdComposeFile({
      hostHome: "/home/operator",
      imageTag: "v0.9.0",
    });
    // Sanity checks — we don't parse as yaml in the test (yaml has
    // no zero-dep parser in this repo and the file is small enough
    // that substring + regex on key lines is more direct).
    expect(out).toContain("services:");
    expect(out).toContain("hostd:");
    expect(out).toContain("container_name: switchroom-hostd");
  });

  it("substitutes the host home path into all bind mounts", () => {
    const out = renderHostdComposeFile({
      hostHome: "/home/alice",
      imageTag: "latest",
    });
    // Bind-mount line for ~/.switchroom; the dir is mapped to
    // /host-home/.switchroom inside the container so HOME=/host-home
    // resolves correctly.
    expect(out).toContain("/home/alice/.switchroom:/host-home/.switchroom:rw");
    // Symlink-safe direct file bind for switchroom.yaml. Operators
    // who keep the yaml in a sibling git-tracked repo (the canonical
    // setup) symlink it into ~/.switchroom/. The dir bind preserves
    // the symlink as a symlink (with a host-path target the container
    // can't resolve); the direct file bind follows the symlink at
    // mount time. MUST be :rw — hostd is the sanctioned config writer
    // (config_propose_edit applies an operator-approved diff in place);
    // :ro makes every config edit fail EROFS and roll back. Regression
    // guard for that bug.
    expect(out).toContain(
      "/home/alice/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:rw",
    );
    expect(out).not.toContain(
      "/home/alice/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro",
    );
    // docker.sock is a fixed host path; bind-mount is host-home-agnostic.
    expect(out).toContain("/var/run/docker.sock:/var/run/docker.sock:rw");
    // machine-id must be mounted so resolveOperatorVaultPassphrase can
    // decrypt the auto-unlock blob and provision LiteLLM keys during rollout.
    expect(out).toContain("/etc/machine-id:/etc/machine-id:ro");
  });

  it("exports SWITCHROOM_HOST_HOME = the REAL host home (so in-container apply emits host bind sources, not /host-home)", () => {
    const out = renderHostdComposeFile({ hostHome: "/home/alice", imageTag: "latest" });
    // The 2026-06-11/12 outages: without this, in-container apply did
    // homedir()→/host-home and poisoned every bind source. HOME stays
    // /host-home (socket convention) but SWITCHROOM_HOST_HOME must be real.
    expect(out).toContain("HOME: /host-home");
    expect(out).toContain("SWITCHROOM_HOST_HOME: /home/alice");
  });

  it("pins the image tag exactly as passed", () => {
    const out = renderHostdComposeFile({
      hostHome: "/home/x",
      imageTag: "v0.8.2",
    });
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-hostd:v0.8.2");
    expect(out).not.toContain("ghcr.io/switchroom/switchroom-hostd:latest");
  });

  it("drops ALL caps and re-adds only CHOWN/DAC_OVERRIDE/FOWNER", () => {
    const out = renderHostdComposeFile({ hostHome: "/h", imageTag: "latest" });
    expect(out).toContain("cap_drop:");
    expect(out).toMatch(/cap_drop:\s*\n\s+- ALL/);
    expect(out).toMatch(/cap_add:[\s\S]*?- CHOWN/);
    expect(out).toMatch(/cap_add:[\s\S]*?- DAC_OVERRIDE/);
    expect(out).toMatch(/cap_add:[\s\S]*?- FOWNER/);
    // Negative space: no SYS_ADMIN, no NET_ADMIN, no privileged
    expect(out).not.toContain("SYS_ADMIN");
    expect(out).not.toContain("NET_ADMIN");
    expect(out).not.toContain("privileged: true");
  });

  it("sets no-new-privileges:true", () => {
    const out = renderHostdComposeFile({ hostHome: "/h", imageTag: "latest" });
    expect(out).toContain("no-new-privileges:true");
  });

  it("sets HOME, SWITCHROOM_CONFIG, PATH env so spawned switchroom CLI works", () => {
    const out = renderHostdComposeFile({ hostHome: "/h", imageTag: "latest" });
    expect(out).toContain("HOME: /host-home");
    // SWITCHROOM_CONFIG points at /state/config/switchroom.yaml — the
    // symlink-safe direct file bind. Mirrors the agent container's
    // config path convention.
    expect(out).toContain("SWITCHROOM_CONFIG: /state/config/switchroom.yaml");
    expect(out).toContain("PATH:");
  });

  it("emits SWITCHROOM_HOSTD_OPERATOR_UID only when operatorUid is provided", () => {
    const without = renderHostdComposeFile({ hostHome: "/h", imageTag: "latest" });
    expect(without).not.toContain("SWITCHROOM_HOSTD_OPERATOR_UID");

    const withUid = renderHostdComposeFile({
      hostHome: "/h",
      imageTag: "latest",
      operatorUid: 1234,
    });
    expect(withUid).toContain('SWITCHROOM_HOSTD_OPERATOR_UID: "1234"');
    // Still valid env block — sits alongside the existing keys.
    expect(withUid).toContain("HOME: /host-home");
    expect(withUid).toContain("SWITCHROOM_CONFIG: /state/config/switchroom.yaml");
  });

  it("emits the skills bind mount only when skillsTarget is provided", () => {
    // Symlinked skills pool (operator keeps skills in a sibling git-tracked
    // repo): without this bind the symlink dangles inside hostd and
    // `switchroom apply` skips every agent's skills. The direct bind onto the
    // resolved real target forces docker to follow it host-side at mount time.
    const withTarget = renderHostdComposeFile({
      hostHome: "/home/alice",
      imageTag: "latest",
      skillsTarget: "/home/alice/.switchroom-config/skills",
    });
    expect(withTarget).toContain(
      "/home/alice/.switchroom-config/skills:/host-home/.switchroom/skills:rw",
    );
    // rw to match the ~/.switchroom mount, never ro.
    expect(withTarget).not.toContain(
      "/home/alice/.switchroom-config/skills:/host-home/.switchroom/skills:ro",
    );

    // No skillsTarget (real dir / absent / dangling) → true no-op: no skills
    // bind line at all, so existing operators are unaffected.
    const without = renderHostdComposeFile({ hostHome: "/home/alice", imageTag: "latest" });
    expect(without).not.toContain("/host-home/.switchroom/skills");
  });

  it("byte-deterministic for the same inputs (incl. skillsTarget)", () => {
    const a = renderHostdComposeFile({ hostHome: "/h", imageTag: "v1" });
    const b = renderHostdComposeFile({ hostHome: "/h", imageTag: "v1" });
    expect(a).toBe(b);
    const c = renderHostdComposeFile({
      hostHome: "/h",
      imageTag: "v1",
      skillsTarget: "/cfg/skills",
    });
    const d = renderHostdComposeFile({
      hostHome: "/h",
      imageTag: "v1",
      skillsTarget: "/cfg/skills",
    });
    expect(c).toBe(d);
  });

  it("warns about no operator hand-edits at the top of the file", () => {
    const out = renderHostdComposeFile({ hostHome: "/h", imageTag: "latest" });
    expect(out.split("\n")[0]).toContain("AUTO-GENERATED");
    expect(out).toContain("do not hand-edit");
  });

  it("uses a stop_grace_period long enough for in-flight async shellouts", () => {
    const out = renderHostdComposeFile({ hostHome: "/h", imageTag: "latest" });
    // 15s matches server.ts's shutdown TimeoutStopSec; aligning here
    // keeps SIGTERM → graceful-close → SIGKILL behavior predictable.
    expect(out).toContain("stop_grace_period: 15s");
  });

  it("declares its own network so the hostd project doesn't accidentally join the agent fleet's net", () => {
    const out = renderHostdComposeFile({ hostHome: "/h", imageTag: "latest" });
    expect(out).toContain("name: switchroom-hostd-net");
  });
});

describe("resolveHostdHostHome (in-container /host-home guard, #2279 gap)", () => {
  it("prefers SWITCHROOM_HOST_HOME over homedir()", () => {
    // In-container: homedir() is the poison /host-home, but the env carries
    // the real host home (baked by a host-side install). Env wins.
    expect(
      resolveHostdHostHome({ SWITCHROOM_HOST_HOME: "/home/operator" }, "/host-home"),
    ).toBe("/home/operator");
  });

  it("falls back to homedir() when SWITCHROOM_HOST_HOME is unset", () => {
    expect(resolveHostdHostHome({}, "/home/alice")).toBe("/home/alice");
  });

  it("treats empty/whitespace SWITCHROOM_HOST_HOME as unset", () => {
    expect(resolveHostdHostHome({ SWITCHROOM_HOST_HOME: "   " }, "/home/alice")).toBe(
      "/home/alice",
    );
  });

  it("THROWS when the resolved home is /host-home (the in-container poison)", () => {
    // The exact fleet-killer: in-container install, no SWITCHROOM_HOST_HOME,
    // homedir() === /host-home. Must fail loud, not emit a poisoned compose.
    expect(() => resolveHostdHostHome({}, "/host-home")).toThrow(/refusing to generate/);
    expect(() => resolveHostdHostHome({}, "/host-home")).toThrow(/run.*from the HOST/i);
  });

  it("THROWS when SWITCHROOM_HOST_HOME itself is /host-home (self-perpetuation guard)", () => {
    // A previously-poisoned compose baked SWITCHROOM_HOST_HOME=/host-home;
    // reading it back must not re-poison — the backstop catches it too.
    expect(() =>
      resolveHostdHostHome({ SWITCHROOM_HOST_HOME: "/host-home" }, "/home/alice"),
    ).toThrow(/refusing to generate/);
  });

  it("THROWS for any path UNDER /host-home", () => {
    expect(() => resolveHostdHostHome({}, "/host-home/nested")).toThrow(
      /refusing to generate/,
    );
  });

  it("accepts a real host home unchanged", () => {
    expect(resolveHostdHostHome({}, "/home/operator")).toBe("/home/operator");
    expect(resolveHostdHostHome({ SWITCHROOM_HOST_HOME: "/root" }, "/home/x")).toBe("/root");
  });
});

describe("resolveHostdSkillsTarget (symlinked skills-pool bind, this fix)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hostd-skills-"));
    mkdirSync(join(tmp, ".switchroom"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns undefined when skills is a real dir (covered by parent mount)", () => {
    mkdirSync(join(tmp, ".switchroom", "skills"));
    expect(resolveHostdSkillsTarget(tmp)).toBeUndefined();
  });

  it("returns the resolved absolute target when skills is a symlink to an existing dir", () => {
    const realPool = join(tmp, ".switchroom-config", "skills");
    mkdirSync(realPool, { recursive: true });
    symlinkSync(realPool, join(tmp, ".switchroom", "skills"));
    expect(resolveHostdSkillsTarget(tmp)).toBe(realPool);
  });

  it("returns undefined (and warns) for a dangling symlink", () => {
    symlinkSync(join(tmp, "nonexistent-pool"), join(tmp, ".switchroom", "skills"));
    expect(resolveHostdSkillsTarget(tmp)).toBeUndefined();
  });

  it("returns undefined when there is no skills entry at all", () => {
    expect(resolveHostdSkillsTarget(tmp)).toBeUndefined();
  });
});

describe("resolveHostdImageTag (honor release.pin like the agent fleet)", () => {
  it("uses an explicit --tag override above everything", () => {
    expect(resolveHostdImageTag("v9.9.9", { pin: "v0.15.7" })).toBe("v9.9.9");
    expect(resolveHostdImageTag("v9.9.9", undefined)).toBe("v9.9.9");
  });

  it("defaults to release.pin when no --tag (the gap this closes)", () => {
    // Previously hardcoded "latest" → hostd lagged the pinned fleet. Now it
    // tracks the same pin the agents/brokers resolve.
    expect(resolveHostdImageTag(undefined, { pin: "v0.15.7" })).toBe("v0.15.7");
    expect(resolveHostdImageTag(undefined, { pin: "sha-abc1234" })).toBe("sha-abc1234");
  });

  it("falls back to a release channel when no pin", () => {
    expect(resolveHostdImageTag(undefined, { channel: "rc" })).toBe("rc");
  });

  it("falls back to 'latest' when neither --tag nor release is set", () => {
    expect(resolveHostdImageTag(undefined, undefined)).toBe("latest");
    expect(resolveHostdImageTag(undefined, {})).toBe("latest");
  });
});
