/**
 * Tests for `switchroom webd` — Phase 3 web-service packaging verb.
 *
 * Scope: the pure compose-rendering logic. Does NOT exercise `docker
 * compose` itself; those calls go through spawnSync and are not invoked
 * by these tests.
 *
 * The web container's compose shape has three invariants that diverge
 * from hostd and are the whole point of this image — they're each
 * pinned below:
 *   1. network_mode: host (owns host loopback 127.0.0.1:8080).
 *   2. runs as the operator uid (peercred gate on per-agent webhook.sock).
 *   3. NO docker.sock, NO cap_add (minimal internet-facing surface).
 */

import { describe, it, expect } from "vitest";
import { renderWebComposeFile, resolveWebImageTag } from "./webd.js";

describe("renderWebComposeFile", () => {
  it("renders a valid yaml-shaped string for the switchroom-web service", () => {
    const out = renderWebComposeFile({
      hostHome: "/home/operator",
      imageTag: "v0.14.12",
      operatorUid: 1000,
    });
    expect(out).toContain("services:");
    expect(out).toContain("web:");
    expect(out).toContain("container_name: switchroom-web");
  });

  it("uses network_mode: host so the container owns host loopback :8080", () => {
    // The cloudflared tunnel (webhooks) and tailscale serve (dashboard)
    // both reach the server on 127.0.0.1:8080, and the dashboard CSRF
    // gate trusts the Tailscale-User-Login header only on loopback
    // (PR #1380). Only host networking preserves that.
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out).toContain("network_mode: host");
  });

  it("runs as the operator uid so webhook.sock forwards pass the gateway peercred ACL", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out).toContain('user: "1000:1000"');

    // Different operator uid → different user line, verbatim.
    const other = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1234 });
    expect(other).toContain('user: "1234:1234"');
  });

  it("does NOT mount the docker socket (minimal internet-facing surface)", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out).not.toContain("docker.sock");
  });

  it("drops ALL caps and re-adds NONE (web server never chowns or shells docker)", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out).toContain("cap_drop:");
    expect(out).toMatch(/cap_drop:\s*\n\s+- ALL/);
    expect(out).not.toContain("cap_add:");
    expect(out).not.toContain("SYS_ADMIN");
    expect(out).not.toContain("privileged: true");
  });

  it("sets no-new-privileges:true", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out).toContain("no-new-privileges:true");
  });

  it("substitutes the host home into the bind mounts (rw tree + ro symlink-safe yaml)", () => {
    const out = renderWebComposeFile({ hostHome: "/home/alice", imageTag: "latest", operatorUid: 1000 });
    // Whole ~/.switchroom tree rw — the receiver reads secrets and
    // connects per-agent webhook.sock under it.
    expect(out).toContain("/home/alice/.switchroom:/host-home/.switchroom:rw");
    // Dashboard only READS the config → symlink-safe direct file bind, :ro.
    expect(out).toContain(
      "/home/alice/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro",
    );
  });

  it("pins the image tag exactly as passed", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "v0.14.12", operatorUid: 1000 });
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-web:v0.14.12");
    expect(out).not.toContain("ghcr.io/switchroom/switchroom-web:latest");
  });

  it("sets HOME, SWITCHROOM_CONFIG, PATH env", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out).toContain("HOME: /host-home");
    expect(out).toContain("SWITCHROOM_CONFIG: /state/config/switchroom.yaml");
    expect(out).toContain("PATH:");
  });

  it("byte-deterministic for the same inputs", () => {
    const a = renderWebComposeFile({ hostHome: "/h", imageTag: "v1", operatorUid: 1000 });
    const b = renderWebComposeFile({ hostHome: "/h", imageTag: "v1", operatorUid: 1000 });
    expect(a).toBe(b);
  });

  it("warns against operator hand-edits at the top of the file", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out.split("\n")[0]).toContain("AUTO-GENERATED");
    expect(out).toContain("do not hand-edit");
  });

  it("uses a 15s stop_grace_period for clean bun shutdown on docker stop", () => {
    const out = renderWebComposeFile({ hostHome: "/h", imageTag: "latest", operatorUid: 1000 });
    expect(out).toContain("stop_grace_period: 15s");
  });
});

describe("resolveWebImageTag (honor release.pin like the agent fleet)", () => {
  it("uses an explicit --tag override above everything", () => {
    expect(resolveWebImageTag("v9.9.9", { pin: "v0.15.7" })).toBe("v9.9.9");
    expect(resolveWebImageTag("v9.9.9", undefined)).toBe("v9.9.9");
  });

  it("defaults to release.pin when no --tag (the gap this closes)", () => {
    expect(resolveWebImageTag(undefined, { pin: "v0.15.7" })).toBe("v0.15.7");
    expect(resolveWebImageTag(undefined, { pin: "sha-abc1234" })).toBe("sha-abc1234");
  });

  it("falls back to a release channel when no pin", () => {
    expect(resolveWebImageTag(undefined, { channel: "rc" })).toBe("rc");
  });

  it("falls back to 'latest' when neither --tag nor release is set", () => {
    expect(resolveWebImageTag(undefined, undefined)).toBe("latest");
    expect(resolveWebImageTag(undefined, {})).toBe("latest");
  });
});
