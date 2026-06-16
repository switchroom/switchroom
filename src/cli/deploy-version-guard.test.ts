import { describe, it, expect } from "vitest";
import { deployedImageTag, checkDowngrade, type DockerRunner } from "./deploy-version-guard.js";

/** A docker runner stub that returns a fixed `docker inspect` image ref. */
function inspectReturning(image: string | null): DockerRunner {
  return (args) => {
    // Only the inspect call is exercised by these helpers.
    if (args[0] === "inspect") {
      return image === null
        ? { ok: false, stdout: "", stderr: "No such object" }
        : { ok: true, stdout: image + "\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

describe("deployedImageTag", () => {
  it("extracts the tag from a ghcr image ref", () => {
    expect(
      deployedImageTag("switchroom-web", inspectReturning("ghcr.io/switchroom/switchroom-web:v0.15.34")),
    ).toBe("v0.15.34");
  });
  it("returns null when the container is absent (inspect fails)", () => {
    expect(deployedImageTag("switchroom-web", inspectReturning(null))).toBeNull();
  });
  it("returns null for a digest-pinned ref (no human tag)", () => {
    expect(
      deployedImageTag("x", inspectReturning("ghcr.io/switchroom/switchroom-web@sha256:abcd")),
    ).toBeNull();
  });
  it("does not mistake a registry:port for a tag", () => {
    // `registry:5000/img` has a colon but the part after it contains `/`.
    expect(deployedImageTag("x", inspectReturning("registry:5000/switchroom-web"))).toBeNull();
  });
  it("handles a registry:port WITH a tag", () => {
    expect(deployedImageTag("x", inspectReturning("registry:5000/switchroom-web:v0.15.34"))).toBe("v0.15.34");
  });
});

describe("checkDowngrade", () => {
  const run = (running: string | null): DockerRunner =>
    inspectReturning(running === null ? null : `ghcr.io/switchroom/switchroom-web:${running}`);

  it("SKIPS a clear semver downgrade (the concurrent-rollout revert)", () => {
    const r = checkDowngrade({ container: "switchroom-web", targetTag: "v0.15.32", run: run("v0.15.34") });
    expect(r.skip).toBe(true);
    expect(r.running).toBe("v0.15.34");
    expect(r.message).toContain("v0.15.34");
    expect(r.message).toContain("--allow-downgrade");
  });

  it("PROCEEDS on an upgrade", () => {
    expect(checkDowngrade({ container: "x", targetTag: "v0.15.34", run: run("v0.15.32") }).skip).toBe(false);
  });

  it("PROCEEDS on a same-version re-deploy", () => {
    expect(checkDowngrade({ container: "x", targetTag: "v0.15.34", run: run("v0.15.34") }).skip).toBe(false);
  });

  it("PROCEEDS on a first install (no running container)", () => {
    const r = checkDowngrade({ container: "x", targetTag: "v0.15.32", run: run(null) });
    expect(r.skip).toBe(false);
    expect(r.running).toBeNull();
  });

  it("PROCEEDS when either tag is unorderable (channel/sha/latest)", () => {
    expect(checkDowngrade({ container: "x", targetTag: "latest", run: run("v0.15.34") }).skip).toBe(false);
    expect(checkDowngrade({ container: "x", targetTag: "v0.15.32", run: run("dev") }).skip).toBe(false);
    expect(checkDowngrade({ container: "x", targetTag: "sha-abc1234", run: run("v0.15.34") }).skip).toBe(false);
  });

  it("allowDowngrade forces a downgrade through", () => {
    const r = checkDowngrade({
      container: "x",
      targetTag: "v0.15.32",
      allowDowngrade: true,
      run: run("v0.15.34"),
    });
    expect(r.skip).toBe(false);
    expect(r.running).toBe("v0.15.34");
  });
});
