import { describe, it, expect } from "vitest";
import {
  needsSelfBump,
  bumpHostdComposeImageTag,
  encodePendingRolloutMarker,
  parsePendingRolloutMarker,
  isMarkerFresh,
  selfBumpHelperArgs,
  SELF_BUMP_HELPER_CONTAINER,
  SELF_BUMP_MARKER_MAX_AGE_MS,
  type PendingRolloutMarker,
} from "./self-bump.js";

describe("needsSelfBump", () => {
  it("true when the daemon CLI is strictly older than the pin", () => {
    expect(needsSelfBump("0.16.49", "v0.17.0")).toBe(true);
    expect(needsSelfBump("v0.16.49", "v0.16.50")).toBe(true);
  });

  it("false when equal or newer", () => {
    expect(needsSelfBump("0.17.0", "v0.17.0")).toBe(false);
    expect(needsSelfBump("0.17.1", "v0.17.0")).toBe(false);
  });

  it("false (never blocks) on dev/sha/unparseable versions", () => {
    expect(needsSelfBump(undefined, "v0.17.0")).toBe(false);
    expect(needsSelfBump("dev", "v0.17.0")).toBe(false);
    expect(needsSelfBump("0.16.49", "sha-abc1234")).toBe(false);
  });
});

describe("bumpHostdComposeImageTag", () => {
  const yaml = [
    "services:",
    "  hostd:",
    "    image: ghcr.io/switchroom/switchroom-hostd:v0.16.49",
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock",
  ].join("\n");

  it("rewrites only the hostd image tag, preserving registry/owner", () => {
    const r = bumpHostdComposeImageTag(yaml, "v0.17.0");
    expect(r).not.toBeNull();
    expect(r!.oldImageRef).toBe(
      "ghcr.io/switchroom/switchroom-hostd:v0.16.49",
    );
    expect(r!.newImageRef).toBe("ghcr.io/switchroom/switchroom-hostd:v0.17.0");
    expect(r!.yaml).toContain(
      "image: ghcr.io/switchroom/switchroom-hostd:v0.17.0",
    );
    expect(r!.yaml).not.toContain("v0.16.49");
    // Everything else is untouched.
    expect(r!.yaml).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("works for a fork's registry prefix", () => {
    const forked = yaml.replace(
      "ghcr.io/switchroom/switchroom-hostd",
      "registry.example.com/me/switchroom-hostd",
    );
    const r = bumpHostdComposeImageTag(forked, "v1.2.3");
    expect(r!.newImageRef).toBe(
      "registry.example.com/me/switchroom-hostd:v1.2.3",
    );
  });

  it("returns null when no switchroom-hostd image line exists", () => {
    expect(
      bumpHostdComposeImageTag("services:\n  web:\n    image: nginx:1", "v1.0.0"),
    ).toBeNull();
  });

  it("does not touch a non-hostd switchroom image", () => {
    const mixed =
      "    image: ghcr.io/switchroom/switchroom-agent:v0.16.49\n" + yaml;
    const r = bumpHostdComposeImageTag(mixed, "v0.17.0");
    expect(r!.yaml).toContain("switchroom-agent:v0.16.49");
    expect(r!.yaml).toContain("switchroom-hostd:v0.17.0");
  });
});

describe("pending-rollout marker", () => {
  const marker: PendingRolloutMarker = {
    v: 1,
    request_id: "mcp-rollout-123-abc",
    pin: "v0.17.0",
    agents: ["test-harness", "klanker"],
    skip_web: true,
    caller: { kind: "agent", name: "overlord" },
    created_at: "2026-07-05T00:00:00.000Z",
    prior_hostd_version: "0.16.49",
  };

  it("round-trips through encode/parse", () => {
    expect(parsePendingRolloutMarker(encodePendingRolloutMarker(marker))).toEqual(
      marker,
    );
  });

  it("round-trips the minimal (no-optionals, operator) shape", () => {
    const min: PendingRolloutMarker = {
      v: 1,
      request_id: "r1",
      pin: "v1.0.0",
      caller: { kind: "operator" },
      created_at: "2026-07-05T00:00:00.000Z",
      prior_hostd_version: "0.16.49",
    };
    expect(parsePendingRolloutMarker(encodePendingRolloutMarker(min))).toEqual(min);
  });

  it.each([
    ["not json", "{"],
    ["wrong version", JSON.stringify({ ...marker, v: 2 })],
    ["missing request_id", JSON.stringify({ ...marker, request_id: undefined })],
    ["non-semver pin", JSON.stringify({ ...marker, pin: "sha-abc1234" })],
    ["bad created_at", JSON.stringify({ ...marker, created_at: "yesterday" })],
    ["bad caller kind", JSON.stringify({ ...marker, caller: { kind: "root" } })],
    [
      "agent caller without name",
      JSON.stringify({ ...marker, caller: { kind: "agent" } }),
    ],
    ["empty agents", JSON.stringify({ ...marker, agents: [] })],
    [
      "agent name with shell metachars",
      JSON.stringify({ ...marker, agents: ["ok", "bad;rm -rf"] }),
    ],
    ["non-boolean skip_web", JSON.stringify({ ...marker, skip_web: "yes" })],
  ])("rejects a malformed marker: %s", (_label, raw) => {
    expect(parsePendingRolloutMarker(raw)).toBeNull();
  });

  it("isMarkerFresh honours the cutoff", () => {
    const created = Date.parse(marker.created_at);
    expect(isMarkerFresh(marker, created + 1000)).toBe(true);
    expect(
      isMarkerFresh(marker, created + SELF_BUMP_MARKER_MAX_AGE_MS - 1),
    ).toBe(true);
    expect(isMarkerFresh(marker, created + SELF_BUMP_MARKER_MAX_AGE_MS)).toBe(
      false,
    );
  });
});

describe("selfBumpHelperArgs", () => {
  const args = selfBumpHelperArgs({
    hostdDirHostPath: "/home/op/.switchroom/hostd",
    helperImage: "ghcr.io/switchroom/switchroom-hostd:v0.16.49",
    targetImage: "ghcr.io/switchroom/switchroom-hostd:v0.17.0",
  });

  it("is a detached, self-removing, labeled sibling", () => {
    expect(args.slice(0, 3)).toEqual(["run", "-d", "--rm"]);
    expect(args).toContain(SELF_BUMP_HELPER_CONTAINER);
    expect(args).toContain("switchroom.hostd-selfbump=true");
  });

  it("mounts ONLY the docker socket and the hostd dir, at identical host paths", () => {
    const mounts = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
    expect(mounts).toEqual([
      "/var/run/docker.sock:/var/run/docker.sock",
      "/home/op/.switchroom/hostd:/home/op/.switchroom/hostd",
    ]);
  });

  it("runs the helper on the OLD (local) image, never the target", () => {
    // The target image would make `docker run -d` pull multi-GB
    // synchronously and blow the caller's wire timeout; the old image is
    // pinned local by the running container. The target is only fetched
    // by the script's own `compose pull`.
    // argv tail is [..., "--entrypoint", "/bin/sh", <image>, "-c", <script>]
    expect(args[args.length - 3]).toBe(
      "ghcr.io/switchroom/switchroom-hostd:v0.16.49",
    );
    // The target ref appears only inside the script (log line), never as
    // the `docker run` image argument.
    expect(args.slice(0, -1)).not.toContain(
      "ghcr.io/switchroom/switchroom-hostd:v0.17.0",
    );
  });

  it("pulls then ups the hostd compose project", () => {
    const script = args[args.length - 1]!;
    expect(script).toContain(
      'docker compose -p switchroom-hostd -f "/home/op/.switchroom/hostd/docker-compose.yml" pull',
    );
    expect(script).toContain(
      'docker compose -p switchroom-hostd -f "/home/op/.switchroom/hostd/docker-compose.yml" up -d',
    );
    // pull failure must short-circuit the up (old hostd keeps serving).
    expect(script.indexOf("pull")).toBeLessThan(script.indexOf("up -d"));
    expect(script).toContain("&&");
  });

  it("PROPAGATES the pull/up exit status as the container exit code", () => {
    // A trailing bare `echo` would mask every failure as exit 0, making
    // the daemon's docker-wait watcher blind and leaving the
    // fleet-mutation lock held forever on a failed bump.
    const script = args[args.length - 1]!;
    expect(script).toContain("rc=$?");
    expect(script.trimEnd().endsWith("exit $rc")).toBe(true);
  });
});
