/**
 * Tests for the 2026-06-23 fleet-outage detection checks:
 *
 *   1. checkDeployMounts (doctor.ts) — detects:
 *      (a) ~/.docker/cli-plugins/docker-compose as a DIR (docker-compose plugin shadow)
 *      (b) /state or /host-home existing as root-level dirs (auto-dir deploy artifacts)
 *
 *   2. checkContainerRuntimeHealth (doctor-docker.ts) — detects:
 *      vault-broker / auth-broker / approval-kernel stuck in "Restarting" or "Created",
 *      and/or configured agent containers stuck in those states.
 *      Does NOT false-positive on a legitimately-empty fleet.
 *
 * All checks use injectable deps — no real docker calls or filesystem access.
 */

import { describe, it, expect } from "vitest";
import {
  checkDeployMounts,
  type DeployMountsDeps,
} from "../src/cli/doctor.js";
import {
  checkContainerRuntimeHealth,
  classifyContainerStatus,
  type ContainerRow,
  type DockerPsDeps,
} from "../src/cli/doctor-docker.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(agents: Record<string, unknown> = {}): SwitchroomConfig {
  return { agents } as unknown as SwitchroomConfig;
}

/** Build a fake pathKind map from a record of path → kind. */
function fakePaths(
  map: Record<string, "dir" | "file-or-symlink" | "absent">,
): DeployMountsDeps {
  return {
    pathKind: (p) => map[p] ?? "absent",
  };
}

/** Build a fake docker-ps dep from a list of ContainerRow. */
function fakeDockerPs(rows: ContainerRow[]): DockerPsDeps {
  return { listContainers: () => rows };
}

/** docker ps is unavailable */
const unavailableDockerPs: DockerPsDeps = { listContainers: () => null };

// ---------------------------------------------------------------------------
// classifyContainerStatus
// ---------------------------------------------------------------------------

describe("classifyContainerStatus", () => {
  it("running-healthy when Up with (healthy)", () => {
    expect(classifyContainerStatus("Up 3 hours (healthy)")).toBe("running-healthy");
    expect(classifyContainerStatus("Up 2 minutes (healthy)")).toBe("running-healthy");
  });

  it("running-no-healthcheck for plain Up", () => {
    expect(classifyContainerStatus("Up 2 minutes")).toBe("running-no-healthcheck");
    expect(classifyContainerStatus("Up 9 days")).toBe("running-no-healthcheck");
  });

  it("restarting for Restarting status", () => {
    expect(classifyContainerStatus("Restarting (1) 30 seconds ago")).toBe("restarting");
    expect(classifyContainerStatus("Restarting (137) Less than a second ago")).toBe("restarting");
  });

  it("created for Created status", () => {
    expect(classifyContainerStatus("Created")).toBe("created");
    expect(classifyContainerStatus("created")).toBe("created");
  });

  it("exited for Exited status", () => {
    expect(classifyContainerStatus("Exited (1) 5 minutes ago")).toBe("exited");
  });

  it("other for unrecognised strings", () => {
    expect(classifyContainerStatus("")).toBe("other");
    expect(classifyContainerStatus("Paused")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// checkDeployMounts
// ---------------------------------------------------------------------------

describe("checkDeployMounts — docker-compose plugin shadow", () => {
  const home = "/home/testuser";
  const pluginPath = `${home}/.docker/cli-plugins/docker-compose`;

  it("fails when docker-compose plugin path is a DIR", () => {
    const results = checkDeployMounts({
      home,
      deps: fakePaths({ [pluginPath]: "dir" }),
    });
    const r = results.find((r) => r.name.includes("docker-compose plugin shadow"));
    expect(r).toBeDefined();
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain("DIRECTORY");
    expect(r!.fix).toContain("sudo rmdir");
    expect(r!.fix).toContain(pluginPath);
  });

  it("ok when docker-compose plugin path is absent", () => {
    const results = checkDeployMounts({
      home,
      deps: fakePaths({ [pluginPath]: "absent" }),
    });
    const r = results.find((r) => r.name.includes("docker-compose plugin shadow"));
    expect(r!.status).toBe("ok");
    expect(r!.detail).toContain("absent");
  });

  it("ok when docker-compose plugin path is a file/symlink (normal)", () => {
    const results = checkDeployMounts({
      home,
      deps: fakePaths({ [pluginPath]: "file-or-symlink" }),
    });
    const r = results.find((r) => r.name.includes("docker-compose plugin shadow"));
    expect(r!.status).toBe("ok");
    expect(r!.detail).toContain("file/symlink");
  });
});

describe("checkDeployMounts — bogus /state and /host-home dirs", () => {
  const home = "/home/testuser";

  it("fails when /state is a dir (auto-dir artifact)", () => {
    const results = checkDeployMounts({
      home,
      deps: fakePaths({ "/state": "dir" }),
    });
    const r = results.find((r) => r.name.includes("bogus /state dir"));
    expect(r).toBeDefined();
    expect(r!.status).toBe("fail");
    expect(r!.detail).toContain("auto-dir artifact");
    expect(r!.fix).toContain("sudo rm -rf /state");
  });

  it("fails when /host-home is a dir (auto-dir artifact)", () => {
    const results = checkDeployMounts({
      home,
      deps: fakePaths({ "/host-home": "dir" }),
    });
    const r = results.find((r) => r.name.includes("bogus /host-home dir"));
    expect(r).toBeDefined();
    expect(r!.status).toBe("fail");
    expect(r!.fix).toContain("sudo rm -rf /host-home");
  });

  it("ok when /state and /host-home are absent (clean host)", () => {
    const results = checkDeployMounts({
      home,
      deps: fakePaths({}),
    });
    const stateRow = results.find((r) => r.name.includes("bogus /state dir"));
    const hostHomeRow = results.find((r) => r.name.includes("bogus /host-home dir"));
    expect(stateRow!.status).toBe("ok");
    expect(hostHomeRow!.status).toBe("ok");
  });

  it("returns all four check results (plugin shadow + /state + /host-home)", () => {
    const results = checkDeployMounts({ home, deps: fakePaths({}) });
    expect(results).toHaveLength(3);
    const names = results.map((r) => r.name);
    expect(names.some((n) => n.includes("docker-compose plugin shadow"))).toBe(true);
    expect(names.some((n) => n.includes("bogus /state dir"))).toBe(true);
    expect(names.some((n) => n.includes("bogus /host-home dir"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkContainerRuntimeHealth
// ---------------------------------------------------------------------------

describe("checkContainerRuntimeHealth — docker unavailable", () => {
  it("skips gracefully when docker ps is unavailable", () => {
    const results = checkContainerRuntimeHealth(cfg(), unavailableDockerPs);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("skip");
    expect(results[0].detail).toContain("docker ps unavailable");
  });
});

describe("checkContainerRuntimeHealth — empty/healthy fleet", () => {
  it("ok when no switchroom containers exist (empty fleet, no agents)", () => {
    const results = checkContainerRuntimeHealth(cfg({}), fakeDockerPs([]));
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
  });

  it("ok when singletons are running-healthy and no agents configured", () => {
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Up 2 hours (healthy)" },
      { name: "switchroom-auth-broker", status: "Up 2 hours (healthy)" },
      { name: "switchroom-approval-kernel", status: "Up 2 hours (healthy)" },
    ];
    const results = checkContainerRuntimeHealth(cfg({}), fakeDockerPs(rows));
    expect(results[0].status).toBe("ok");
  });

  it("ok when singletons are healthy and configured agents are also healthy", () => {
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Up 3 hours (healthy)" },
      { name: "switchroom-auth-broker", status: "Up 3 hours (healthy)" },
      { name: "switchroom-approval-kernel", status: "Up 3 hours (healthy)" },
      { name: "switchroom-clerk", status: "Up 1 hour" },
      { name: "switchroom-gymbro", status: "Up 1 hour" },
    ];
    const results = checkContainerRuntimeHealth(
      cfg({ clerk: {}, gymbro: {} }),
      fakeDockerPs(rows),
    );
    expect(results[0].status).toBe("ok");
  });

  it("does NOT false-positive on missing singletons when there are no agents (empty fleet)", () => {
    // On a legitimately-empty fleet the broker bind-presence healthcheck
    // shows "unhealthy" but the containers themselves aren't "Restarting"
    // or "Created" — they're just not present in docker ps yet (or running
    // without a healthcheck passing). As long as they aren't stuck in
    // Restarting/Created we should not flag.
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Up 5 minutes" },
      { name: "switchroom-auth-broker", status: "Up 5 minutes" },
    ];
    const results = checkContainerRuntimeHealth(cfg({}), fakeDockerPs(rows));
    expect(results[0].status).toBe("ok");
  });
});

describe("checkContainerRuntimeHealth — 2026-06-23 incident signature", () => {
  it("fails when vault-broker is Restarting (crash-loop)", () => {
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Restarting (1) 30 seconds ago" },
      { name: "switchroom-auth-broker", status: "Up 2 minutes (healthy)" },
      { name: "switchroom-approval-kernel", status: "Up 2 minutes (healthy)" },
    ];
    const results = checkContainerRuntimeHealth(cfg({}), fakeDockerPs(rows));
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("switchroom-vault-broker");
    expect(results[0].detail).toContain("restarting");
    expect(results[0].fix).toContain("bind-source");
  });

  it("fails when auth-broker is Created (stuck before first start)", () => {
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Up 3 hours (healthy)" },
      { name: "switchroom-auth-broker", status: "Created" },
      { name: "switchroom-approval-kernel", status: "Up 2 minutes" },
    ];
    const results = checkContainerRuntimeHealth(cfg({}), fakeDockerPs(rows));
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("switchroom-auth-broker");
    expect(results[0].detail).toContain("created");
  });

  it("fails when multiple singletons are stuck simultaneously (full incident reproduction)", () => {
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Restarting (3) 5 seconds ago" },
      { name: "switchroom-auth-broker", status: "Created" },
      { name: "switchroom-approval-kernel", status: "Restarting (2) 10 seconds ago" },
      { name: "switchroom-clerk", status: "Created" },
    ];
    const results = checkContainerRuntimeHealth(
      cfg({ clerk: {} }),
      fakeDockerPs(rows),
    );
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("switchroom-vault-broker");
    expect(results[0].detail).toContain("switchroom-auth-broker");
    expect(results[0].detail).toContain("switchroom-approval-kernel");
    expect(results[0].detail).toContain("switchroom-clerk");
  });

  it("fails when only a configured agent is stuck (singletons healthy)", () => {
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Up 3 hours (healthy)" },
      { name: "switchroom-auth-broker", status: "Up 3 hours (healthy)" },
      { name: "switchroom-approval-kernel", status: "Up 3 hours (healthy)" },
      { name: "switchroom-clerk", status: "Created" },
    ];
    const results = checkContainerRuntimeHealth(
      cfg({ clerk: {} }),
      fakeDockerPs(rows),
    );
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("switchroom-clerk");
  });

  it("does NOT flag an agent container that is NOT in the config (other tool's container)", () => {
    // A container named "switchroom-something" that isn't in our agent config
    // should not be flagged as our agent stuck — it might be some other
    // unrelated switchroom-prefixed container.
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Up 2 hours (healthy)" },
      { name: "switchroom-auth-broker", status: "Up 2 hours (healthy)" },
      { name: "switchroom-approval-kernel", status: "Up 2 hours (healthy)" },
      { name: "switchroom-unrelated-tool", status: "Restarting (1) 1 minute ago" },
    ];
    // Config has NO agents, so "unrelated-tool" is not checked.
    const results = checkContainerRuntimeHealth(cfg({}), fakeDockerPs(rows));
    expect(results[0].status).toBe("ok");
  });

  it("ok when approval-kernel is absent from docker ps (not yet created)", () => {
    // Container not in docker ps at all → skip, not flagged as stuck.
    const rows: ContainerRow[] = [
      { name: "switchroom-vault-broker", status: "Up 3 hours (healthy)" },
      { name: "switchroom-auth-broker", status: "Up 3 hours (healthy)" },
      // approval-kernel absent
    ];
    const results = checkContainerRuntimeHealth(cfg({}), fakeDockerPs(rows));
    expect(results[0].status).toBe("ok");
  });
});
