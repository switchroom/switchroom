/**
 * Tests for `switchroom hostd` — Phase 1.5 packaging verb.
 *
 * Scope: the pure compose-rendering logic and the install verb's
 * config-validation surface. Does NOT exercise `docker compose` itself;
 * those calls go through spawnSync and are stubbed implicitly by not
 * running `install` in these tests.
 */

import { describe, it, expect } from "vitest";
import { renderHostdComposeFile } from "./hostd.js";

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
    // mount time.
    expect(out).toContain(
      "/home/alice/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro",
    );
    // docker.sock is a fixed host path; bind-mount is host-home-agnostic.
    expect(out).toContain("/var/run/docker.sock:/var/run/docker.sock:rw");
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

  it("byte-deterministic for the same inputs", () => {
    const a = renderHostdComposeFile({ hostHome: "/h", imageTag: "v1" });
    const b = renderHostdComposeFile({ hostHome: "/h", imageTag: "v1" });
    expect(a).toBe(b);
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
