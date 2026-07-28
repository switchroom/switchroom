import { describe, it, expect } from "vitest";

import {
  collectComponents,
  collectContainerComponents,
  detectComponentDrift,
  formatComponentDrift,
  isSwitchroomReleaseImage,
  resolveDriftTarget,
  versionFromImageRef,
  type ExecFn,
} from "./component-versions.js";

/**
 * The exact `docker ps` output from the operator host on 2026-07-29,
 * trimmed to the switchroom containers. This is the state that motivated
 * #3919: fleet + hostd on v0.19.28, web + the autoheal sidecar stranded
 * on v0.19.26, and (separately) the host CLI on 0.19.23.
 */
const REFERENCE_HOST_PS = [
  "switchroom-hindsight\tghcr.io/switchroom/switchroom-hindsight:v0.19.28",
  "switchroom-klanker\tghcr.io/switchroom/switchroom-agent:v0.19.28",
  "switchroom-test-harness\tghcr.io/switchroom/switchroom-agent:v0.19.28",
  "switchroom-voice-sidecar\tghcr.io/switchroom/switchroom-voice:v0.19.28",
  "switchroom-auth-broker\tghcr.io/switchroom/switchroom-auth-broker:v0.19.28",
  "switchroom-approval-kernel\tghcr.io/switchroom/switchroom-kernel:v0.19.28",
  "switchroom-vault-broker\tghcr.io/switchroom/switchroom-broker:v0.19.28",
  "switchroom-hostd\tghcr.io/switchroom/switchroom-hostd:v0.19.28",
  "switchroom-hindsight-autoheal\tghcr.io/switchroom/switchroom-hostd:v0.19.26",
  "switchroom-web\tghcr.io/switchroom/switchroom-web:v0.19.26",
  "switchroom-hostd-docker-proxy\tghcr.io/tecnativa/docker-socket-proxy:v0.4.2",
  "switchroom-grafana-fwd\talpine/socat",
  "switchroom-uat-runner\tswitchroom-uat-runner:local",
].join("\n");

const execOk = (stdout: string): ExecFn => () => ({ status: 0, stdout });

describe("versionFromImageRef", () => {
  it("reads a vX.Y.Z tag", () => {
    expect(
      versionFromImageRef("ghcr.io/switchroom/switchroom-web:v0.19.26").version,
    ).toBe("v0.19.26");
  });

  it("reports a floating tag as uncomparable rather than dropping it", () => {
    const r = versionFromImageRef("ghcr.io/switchroom/switchroom-hostd:latest");
    expect(r.version).toBeNull();
    expect(r.detail).toContain("latest");
  });

  it("does not mistake a registry port for a tag", () => {
    expect(
      versionFromImageRef("registry.example.com:5000/switchroom-web:v1.2.3")
        .version,
    ).toBe("v1.2.3");
  });

  it("ignores a digest suffix", () => {
    expect(
      versionFromImageRef(
        "ghcr.io/switchroom/switchroom-web:v1.2.3@sha256:" + "a".repeat(64),
      ).version,
    ).toBe("v1.2.3");
  });
});

describe("isSwitchroomReleaseImage", () => {
  it("excludes the third-party docker-socket-proxy despite the switchroom- name", () => {
    expect(
      isSwitchroomReleaseImage(
        "switchroom-hostd-docker-proxy",
        "ghcr.io/tecnativa/docker-socket-proxy:v0.4.2",
      ),
    ).toBe(false);
  });

  it("includes a component that did not exist when this code was written", () => {
    expect(
      isSwitchroomReleaseImage(
        "switchroom-brand-new-thing",
        "ghcr.io/switchroom/switchroom-brand-new-thing:v9.9.9",
      ),
    ).toBe(true);
  });

  it("includes the hindsight singleton — it IS release-tagged", () => {
    // Regression: an earlier draft excluded it by name on the assumption
    // that hindsight was versioned upstream. The live host disagrees, and
    // excluding it would hide exactly the drift this module exists to find.
    expect(
      isSwitchroomReleaseImage(
        "switchroom-hindsight",
        "ghcr.io/switchroom/switchroom-hindsight:v0.19.28",
      ),
    ).toBe(true);
  });

  it("excludes third-party and locally-built images under switchroom- names", () => {
    expect(isSwitchroomReleaseImage("switchroom-grafana-fwd", "alpine/socat")).toBe(
      false,
    );
    expect(
      isSwitchroomReleaseImage("switchroom-uat-runner", "switchroom-uat-runner:local"),
    ).toBe(false);
  });
});

describe("detectComponentDrift — the reference-host regression", () => {
  it("names EVERY stale component, including the autoheal sidecar and the host CLI", () => {
    const components = collectComponents(
      "0.19.23", // the host CLI at the time
      execOk(REFERENCE_HOST_PS),
    );
    const report = detectComponentDrift(components, "v0.19.28");

    const behind = report.behind.map((c) => c.name).sort();
    expect(behind).toEqual([
      "cli (host)",
      "switchroom-hindsight-autoheal",
      "switchroom-web",
    ]);
    expect(report.target).toBe("v0.19.28");
    expect(report.targetSource).toBe("release.pin");
    expect(report.ahead).toEqual([]);
    // The proxy is excluded, not reported as unknown noise.
    const all = [...report.unknown, ...report.current, ...report.behind].map(
      (c) => c.name,
    );
    expect(all).not.toContain("switchroom-hostd-docker-proxy");
    expect(all).not.toContain("switchroom-grafana-fwd");
    expect(all).not.toContain("switchroom-uat-runner");
    // …but the hindsight singleton IS a release-tagged component.
    expect(report.current.map((c) => c.name)).toContain("switchroom-hindsight");
    // And the converged components are accounted for, not silently dropped.
    expect(report.current.map((c) => c.name)).toContain("switchroom-hostd");
    expect(report.current.map((c) => c.name)).toContain("switchroom-klanker");
  });

  it("renders the stale components in the operator summary", () => {
    const report = detectComponentDrift(
      collectComponents("0.19.23", execOk(REFERENCE_HOST_PS)),
      "v0.19.28",
    );
    const text = formatComponentDrift(report);
    expect(text).toContain("BEHIND   switchroom-web — v0.19.26");
    expect(text).toContain("BEHIND   switchroom-hindsight-autoheal — v0.19.26");
    expect(text).toContain("BEHIND   cli (host) — v0.19.23");
  });

  it("reports NOTHING behind once every component is on the pin", () => {
    const converged = REFERENCE_HOST_PS.replace(/v0\.19\.26/g, "v0.19.28");
    const report = detectComponentDrift(
      collectComponents("0.19.28", execOk(converged)),
      "v0.19.28",
    );
    expect(report.behind).toEqual([]);
    expect(report.current.length).toBeGreaterThan(5);
  });
});

describe("resolveDriftTarget", () => {
  it("prefers release.pin — the operator's declared intent", () => {
    const r = resolveDriftTarget(
      collectContainerComponents(execOk(REFERENCE_HOST_PS)),
      "v0.20.0",
    );
    expect(r).toEqual({ target: "v0.20.0", targetSource: "release.pin" });
  });

  it("falls back to the highest deployed version when no pin is set", () => {
    const r = resolveDriftTarget(
      collectContainerComponents(execOk(REFERENCE_HOST_PS)),
      undefined,
    );
    expect(r).toEqual({
      target: "v0.19.28",
      targetSource: "highest-deployed",
    });
  });

  it("still catches the split fleet with no pin at all", () => {
    const report = detectComponentDrift(
      collectComponents("0.19.23", execOk(REFERENCE_HOST_PS)),
      undefined,
    );
    expect(report.behind.map((c) => c.name).sort()).toEqual([
      "cli (host)",
      "switchroom-hindsight-autoheal",
      "switchroom-web",
    ]);
  });

  it("returns no target when nothing is comparable", () => {
    expect(resolveDriftTarget([], undefined)).toEqual({
      target: null,
      targetSource: "none",
    });
  });
});

describe("collectContainerComponents", () => {
  it("degrades to an empty inventory when docker is unreachable", () => {
    expect(collectContainerComponents(() => ({ status: 1, stdout: "" }))).toEqual(
      [],
    );
  });

  it("passes a name-prefix filter rather than hardcoding a component list", () => {
    let seen: string[] = [];
    collectContainerComponents((_cmd, args) => {
      seen = args;
      return { status: 0, stdout: "" };
    });
    expect(seen).toContain("name=switchroom-");
  });
});
