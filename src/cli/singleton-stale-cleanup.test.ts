/**
 * Tests for singleton stale-container reconciliation.
 *
 * Scenario reproduced: during `switchroom update`, the refresh-hostd /
 * refresh-web steps invoke `docker compose up -d` for each singleton in
 * its own compose project. When a singleton was previously installed from
 * a DIFFERENT compose project (e.g. old containerized-path install:
 * project `hostd`, workdir `/wd/hostd`), docker compose treats the setups
 * as different instances and tries to CREATE (not RECREATE) the container.
 * The CREATE fails with a container-name conflict because the stale old
 * container still holds the name, aborting the whole update.
 *
 * Fix: `removeStaleContainerIfNeeded` detects a stale container (one whose
 * `com.docker.compose.project` label differs from the target project) and
 * force-removes it before the `compose up -d` runs. Idempotent and logged.
 *
 * Broke the v0.15.48 rollout for both hostd and web.
 */

import { describe, it, expect } from "vitest";
import { removeStaleContainerIfNeeded, type DockerRunner } from "./singleton-stale-cleanup.js";

/** Build a mock DockerRunner from a map of args[0..] → result. */
function mockDocker(calls: Array<{ args: string[]; ok: boolean; stdout: string; stderr: string }>): {
  runner: DockerRunner;
  recorded: string[][];
} {
  const recorded: string[][] = [];
  const runner: DockerRunner = (args) => {
    recorded.push(args);
    const match = calls.find(
      (c) => c.args.length === args.length && c.args.every((a, i) => a === args[i]),
    );
    if (!match) {
      throw new Error(`Unexpected docker call: ${JSON.stringify(args)}`);
    }
    return { ok: match.ok, stdout: match.stdout, stderr: match.stderr };
  };
  return { runner, recorded };
}

describe("removeStaleContainerIfNeeded", () => {
  it("is a no-op when the container does not exist (inspect fails)", () => {
    const { runner, recorded } = mockDocker([
      {
        args: ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', "switchroom-hostd"],
        ok: false,
        stdout: "",
        stderr: "No such container: switchroom-hostd",
      },
    ]);
    const logs: string[] = [];
    const result = removeStaleContainerIfNeeded("switchroom-hostd", "switchroom-hostd", (l) => logs.push(l), runner);

    expect(result.removed).toBe(false);
    expect(result.oldProject).toBeUndefined();
    expect(result.error).toBeUndefined();
    // Only the inspect call was made — no rm.
    expect(recorded).toHaveLength(1);
    expect(logs).toHaveLength(0);
  });

  it("is a no-op when the container exists and belongs to the target project (will RECREATE cleanly)", () => {
    const { runner, recorded } = mockDocker([
      {
        args: ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', "switchroom-hostd"],
        ok: true,
        stdout: "switchroom-hostd\n",
        stderr: "",
      },
    ]);
    const logs: string[] = [];
    const result = removeStaleContainerIfNeeded("switchroom-hostd", "switchroom-hostd", (l) => logs.push(l), runner);

    expect(result.removed).toBe(false);
    expect(result.oldProject).toBeUndefined();
    // No rm issued.
    expect(recorded).toHaveLength(1);
    expect(logs).toHaveLength(0);
  });

  it("removes a stale container that belongs to a different old project (the v0.15.48 scenario for hostd)", () => {
    // Old containerized-path install had project="hostd"; new target is "switchroom-hostd".
    const { runner, recorded } = mockDocker([
      {
        args: ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', "switchroom-hostd"],
        ok: true,
        stdout: "hostd\n",
        stderr: "",
      },
      {
        args: ["rm", "-f", "switchroom-hostd"],
        ok: true,
        stdout: "switchroom-hostd\n",
        stderr: "",
      },
    ]);
    const logs: string[] = [];
    const result = removeStaleContainerIfNeeded("switchroom-hostd", "switchroom-hostd", (l) => logs.push(l), runner);

    expect(result.removed).toBe(true);
    expect(result.containerName).toBe("switchroom-hostd");
    expect(result.oldProject).toBe("hostd");
    expect(result.error).toBeUndefined();
    // Both inspect and rm were called.
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toEqual(["rm", "-f", "switchroom-hostd"]);
    // A log line was emitted mentioning the old project.
    expect(logs.some((l) => l.includes("hostd"))).toBe(true);
    expect(logs.some((l) => l.includes("switchroom-hostd"))).toBe(true);
  });

  it("removes a stale container that belongs to a different old project (the v0.15.48 scenario for web)", () => {
    // Old project="web", new target="switchroom-web".
    const { runner, recorded } = mockDocker([
      {
        args: ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', "switchroom-web"],
        ok: true,
        stdout: "web\n",
        stderr: "",
      },
      {
        args: ["rm", "-f", "switchroom-web"],
        ok: true,
        stdout: "switchroom-web\n",
        stderr: "",
      },
    ]);
    const logs: string[] = [];
    const result = removeStaleContainerIfNeeded("switchroom-web", "switchroom-web", (l) => logs.push(l), runner);

    expect(result.removed).toBe(true);
    expect(result.containerName).toBe("switchroom-web");
    expect(result.oldProject).toBe("web");
    expect(result.error).toBeUndefined();
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toEqual(["rm", "-f", "switchroom-web"]);
  });

  it("removes a stale container with NO compose project label (manually-created container holding the name)", () => {
    // A container created with `docker run --name switchroom-hostd ...` has no
    // compose.project label — inspect returns an empty string.
    const { runner, recorded } = mockDocker([
      {
        args: ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', "switchroom-hostd"],
        ok: true,
        stdout: "\n",
        stderr: "",
      },
      {
        args: ["rm", "-f", "switchroom-hostd"],
        ok: true,
        stdout: "switchroom-hostd\n",
        stderr: "",
      },
    ]);
    const logs: string[] = [];
    const result = removeStaleContainerIfNeeded("switchroom-hostd", "switchroom-hostd", (l) => logs.push(l), runner);

    expect(result.removed).toBe(true);
    expect(result.oldProject).toBe("");
    expect(recorded).toHaveLength(2);
    // Log should mention "(none)" since the old project label was empty.
    expect(logs.some((l) => l.includes("(none)"))).toBe(true);
  });

  it("surfaces an error (but does not throw) when docker rm fails", () => {
    const { runner } = mockDocker([
      {
        args: ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', "switchroom-hostd"],
        ok: true,
        stdout: "old-project\n",
        stderr: "",
      },
      {
        args: ["rm", "-f", "switchroom-hostd"],
        ok: false,
        stdout: "",
        stderr: "permission denied",
      },
    ]);
    const logs: string[] = [];
    const result = removeStaleContainerIfNeeded("switchroom-hostd", "switchroom-hostd", (l) => logs.push(l), runner);

    expect(result.removed).toBe(false);
    expect(result.error).toMatch(/permission denied/);
    // The warning was logged, not thrown.
    expect(logs.some((l) => l.includes("warning"))).toBe(true);
  });

  it("is idempotent: calling twice when the first call already removed the container", () => {
    // Second call: inspect returns non-zero (container gone) → no-op.
    const { runner, recorded } = mockDocker([
      {
        args: ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', "switchroom-hostd"],
        ok: false,
        stdout: "",
        stderr: "No such container: switchroom-hostd",
      },
    ]);
    const logs: string[] = [];
    const result = removeStaleContainerIfNeeded("switchroom-hostd", "switchroom-hostd", (l) => logs.push(l), runner);

    expect(result.removed).toBe(false);
    expect(recorded).toHaveLength(1);
    expect(logs).toHaveLength(0);
  });
});
