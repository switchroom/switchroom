import { describe, expect, it } from "vitest";
import {
  CORE_SINGLETON_SERVICES,
  SINGLETON_SERVICES,
  VOICE_SIDECAR_SERVICE,
  detectSingletonDrift,
  readPinnedSingletonImages,
  reconcileSingletons,
  resolveSingletonServices,
  singletonContainerName,
} from "./singleton-reconcile.js";

const COMPOSE = `
services:
  vault-broker:
    image: ghcr.io/switchroom/switchroom-broker:v0.14.66
    container_name: switchroom-vault-broker
  approval-kernel:
    image: ghcr.io/switchroom/switchroom-kernel:v0.14.66
  switchroom-auth-broker:
    image: ghcr.io/switchroom/switchroom-auth-broker:v0.14.66
  agent-marko:
    image: ghcr.io/switchroom/switchroom-agent:v0.14.66
`;

describe("singleton service/container naming", () => {
  it("covers the three core singletons", () => {
    expect([...CORE_SINGLETON_SERVICES]).toEqual([
      "vault-broker",
      "approval-kernel",
      "switchroom-auth-broker",
    ]);
  });

  it("the full universe also includes voice-sidecar (the conditional singleton)", () => {
    expect([...SINGLETON_SERVICES]).toEqual([
      "vault-broker",
      "approval-kernel",
      "switchroom-auth-broker",
      "voice-sidecar",
    ]);
    expect(VOICE_SIDECAR_SERVICE).toBe("voice-sidecar");
  });

  it("prefixes container names, leaving the already-prefixed auth-broker intact", () => {
    expect(singletonContainerName("vault-broker")).toBe("switchroom-vault-broker");
    expect(singletonContainerName("approval-kernel")).toBe("switchroom-approval-kernel");
    expect(singletonContainerName("switchroom-auth-broker")).toBe("switchroom-auth-broker");
  });
});

const COMPOSE_LOCAL = `
services:
  vault-broker:
    image: ghcr.io/switchroom/switchroom-broker:v0.14.66
  approval-kernel:
    image: ghcr.io/switchroom/switchroom-kernel:v0.14.66
  switchroom-auth-broker:
    image: ghcr.io/switchroom/switchroom-auth-broker:v0.14.66
  voice-sidecar:
    image: ghcr.io/switchroom/switchroom-voice:v0.14.66
`;

describe("resolveSingletonServices — voice-sidecar is verdict-gated (PR-B2)", () => {
  it("includes voice-sidecar ONLY on a local verdict", () => {
    expect(resolveSingletonServices("local")).toEqual([
      "vault-broker",
      "approval-kernel",
      "switchroom-auth-broker",
      "voice-sidecar",
    ]);
  });

  it("omits voice-sidecar on a cloud verdict", () => {
    expect(resolveSingletonServices("cloud")).toEqual([
      "vault-broker",
      "approval-kernel",
      "switchroom-auth-broker",
    ]);
    expect(resolveSingletonServices("cloud")).not.toContain("voice-sidecar");
  });
});

describe("detectSingletonDrift — voice-sidecar gating", () => {
  it("manages voice-sidecar on a local verdict (flags its drift)", () => {
    const running: Record<string, string> = {
      "switchroom-vault-broker": "ghcr.io/switchroom/switchroom-broker:v0.14.66",
      "switchroom-approval-kernel": "ghcr.io/switchroom/switchroom-kernel:v0.14.66",
      "switchroom-auth-broker": "ghcr.io/switchroom/switchroom-auth-broker:v0.14.66",
      "switchroom-voice-sidecar": "ghcr.io/switchroom/switchroom-voice:v0.14.24", // STALE
    };
    const drift = detectSingletonDrift({
      composeFile: "x",
      readCompose: () => COMPOSE_LOCAL,
      voiceEngine: "local",
      inspectImage: (c) => running[c] ?? null,
    });
    const vs = drift.find((d) => d.service === "voice-sidecar")!;
    expect(vs).toBeDefined();
    expect(vs.needsRecreate).toBe(true);
    expect(vs.pinned).toContain("switchroom-voice:v0.14.66");
  });

  it("does NOT manage voice-sidecar on a cloud verdict (never flags it absent)", () => {
    const drift = detectSingletonDrift({
      composeFile: "x",
      readCompose: () => COMPOSE, // no voice-sidecar service
      voiceEngine: "cloud",
      inspectImage: () => null, // everything absent
    });
    // voice-sidecar is not even considered on a cloud host.
    expect(drift.find((d) => d.service === "voice-sidecar")).toBeUndefined();
    expect(drift.map((d) => d.service)).toEqual([
      "vault-broker",
      "approval-kernel",
      "switchroom-auth-broker",
    ]);
  });
});

describe("readPinnedSingletonImages", () => {
  it("extracts the pinned image per singleton, ignoring agents", () => {
    const pinned = readPinnedSingletonImages(COMPOSE);
    expect(pinned["vault-broker"]).toBe("ghcr.io/switchroom/switchroom-broker:v0.14.66");
    expect(pinned["approval-kernel"]).toBe("ghcr.io/switchroom/switchroom-kernel:v0.14.66");
    expect(pinned["switchroom-auth-broker"]).toBe("ghcr.io/switchroom/switchroom-auth-broker:v0.14.66");
  });

  it("omits a singleton with no image (build-local mode emits build:)", () => {
    const buildLocal = `
services:
  vault-broker:
    build:
      context: .
  approval-kernel:
    image: ghcr.io/switchroom/switchroom-kernel:v0.14.66
`;
    const pinned = readPinnedSingletonImages(buildLocal);
    expect(pinned["vault-broker"]).toBeUndefined();
    expect(pinned["approval-kernel"]).toBe("ghcr.io/switchroom/switchroom-kernel:v0.14.66");
  });

  it("returns {} on unparseable yaml", () => {
    expect(readPinnedSingletonImages(":::not yaml:::\n  - [")).toEqual({});
  });
});

describe("detectSingletonDrift", () => {
  it("flags only the singleton whose running image differs from the pin", () => {
    const running: Record<string, string> = {
      "switchroom-vault-broker": "ghcr.io/switchroom/switchroom-broker:v0.14.66", // in sync
      "switchroom-approval-kernel": "ghcr.io/switchroom/switchroom-kernel:v0.14.24", // STALE
      "switchroom-auth-broker": "ghcr.io/switchroom/switchroom-auth-broker:v0.14.66", // in sync
    };
    const drift = detectSingletonDrift({
      composeFile: "x",
      readCompose: () => COMPOSE,
      voiceEngine: "cloud",
      inspectImage: (c) => running[c] ?? null,
    });
    const byService = Object.fromEntries(drift.map((d) => [d.service, d]));
    expect(byService["vault-broker"].needsRecreate).toBe(false);
    expect(byService["approval-kernel"].needsRecreate).toBe(true);
    expect(byService["approval-kernel"].running).toContain("v0.14.24");
    expect(byService["approval-kernel"].pinned).toContain("v0.14.66");
    expect(byService["switchroom-auth-broker"].needsRecreate).toBe(false);
  });

  it("treats an absent container (running=null) as needing recreate", () => {
    const drift = detectSingletonDrift({
      composeFile: "x",
      readCompose: () => COMPOSE,
      voiceEngine: "cloud",
      inspectImage: () => null, // all absent / docker unreachable
    });
    for (const d of drift) {
      expect(d.running).toBeNull();
      expect(d.needsRecreate).toBe(true);
    }
  });

  it("does NOT flag a build-local singleton (no pinned image to compare)", () => {
    const buildLocal = `
services:
  vault-broker:
    build: { context: . }
`;
    const drift = detectSingletonDrift({
      composeFile: "x",
      readCompose: () => buildLocal,
      voiceEngine: "cloud",
      inspectImage: () => "some-local-build:dev",
    });
    const vb = drift.find((d) => d.service === "vault-broker")!;
    expect(vb.pinned).toBeNull();
    expect(vb.needsRecreate).toBe(false);
  });
});

describe("reconcileSingletons", () => {
  it("recreates ONLY drifted singletons and reports them", () => {
    const running: Record<string, string> = {
      "switchroom-vault-broker": "ghcr.io/switchroom/switchroom-broker:v0.14.24", // STALE
      "switchroom-approval-kernel": "ghcr.io/switchroom/switchroom-kernel:v0.14.66", // sync
      "switchroom-auth-broker": "ghcr.io/switchroom/switchroom-auth-broker:v0.14.24", // STALE
    };
    const recreated: string[] = [];
    const res = reconcileSingletons({
      composeFile: "x",
      readCompose: () => COMPOSE,
      voiceEngine: "cloud",
      inspectImage: (c) => running[c] ?? null,
      recreate: (svc) => recreated.push(svc),
      log: () => {},
    });
    expect(recreated.sort()).toEqual(["switchroom-auth-broker", "vault-broker"]);
    expect(res.recreated.sort()).toEqual(["switchroom-auth-broker", "vault-broker"]);
    expect(res.failed).toEqual([]);
  });

  it("is a no-op when everything is in sync", () => {
    const recreated: string[] = [];
    const res = reconcileSingletons({
      composeFile: "x",
      readCompose: () => COMPOSE,
      voiceEngine: "cloud",
      inspectImage: (c) =>
        ({
          "switchroom-vault-broker": "ghcr.io/switchroom/switchroom-broker:v0.14.66",
          "switchroom-approval-kernel": "ghcr.io/switchroom/switchroom-kernel:v0.14.66",
          "switchroom-auth-broker": "ghcr.io/switchroom/switchroom-auth-broker:v0.14.66",
        })[c] ?? null,
      recreate: (svc) => recreated.push(svc),
      log: () => {},
    });
    expect(recreated).toEqual([]);
    expect(res.recreated).toEqual([]);
  });

  it("REGRESSION: includes switchroom-auth-broker (the omitted singleton from the incident)", () => {
    // The live incident was the auth-broker specifically being skipped.
    // Prove the reconcile considers and can recreate it.
    const res = reconcileSingletons({
      composeFile: "x",
      readCompose: () => COMPOSE,
      voiceEngine: "cloud",
      inspectImage: (c) =>
        c === "switchroom-auth-broker"
          ? "ghcr.io/switchroom/switchroom-auth-broker:v0.14.24"
          : ({
              "switchroom-vault-broker": "ghcr.io/switchroom/switchroom-broker:v0.14.66",
              "switchroom-approval-kernel": "ghcr.io/switchroom/switchroom-kernel:v0.14.66",
            })[c] ?? null,
      recreate: () => {},
      log: () => {},
    });
    expect(res.recreated).toContain("switchroom-auth-broker");
  });

  it("collects (does not throw) a recreate failure — best-effort", () => {
    const res = reconcileSingletons({
      composeFile: "x",
      readCompose: () => COMPOSE,
      voiceEngine: "cloud",
      inspectImage: () => "ghcr.io/switchroom/switchroom-x:v0.14.24", // all stale
      recreate: (svc) => {
        if (svc === "approval-kernel") throw new Error("docker daemon down");
      },
      log: () => {},
    });
    expect(res.failed.some((f) => f.service === "approval-kernel")).toBe(true);
    // The other two still recreated despite the one failure.
    expect(res.recreated).toContain("vault-broker");
    expect(res.recreated).toContain("switchroom-auth-broker");
  });
});
