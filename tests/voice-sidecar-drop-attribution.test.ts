/**
 * A defaulted voice verdict must never remove `voice-sidecar` silently.
 *
 * The bug: both voice gates read the verdict through `loadHostCapabilities()`,
 * whose own docstring says to prefer `readHostCapabilities` "anywhere the null
 * would silently become a behaviour change". Dropping an already-emitted
 * service from the fleet compose is exactly such a change, and `absent` is
 * deliberately quiet at the reader layer — so a moved/lost
 * `host-capabilities.json` deleted a running GPU service and the operator's
 * only signal was an unattributed `compose: services removed: voice-sidecar.`
 *
 * These assert the OUTCOME the operator gets (a reason naming the verdict path,
 * on a defaulted read only), not that a particular helper was called.
 *
 * Isolation: `resolveStatePath` derives from `process.env.HOME`, so HOME points
 * at a fresh tmpdir — never the operator's real `~/.switchroom/`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveVoiceEngine,
  isDefaultedVoiceEngine,
  resetHostCapabilitiesWarnings,
  hostCapabilitiesPath,
} from "../src/setup/host-capabilities.js";
import {
  detectVoiceSidecarDrop,
  parseComposeServiceNames,
} from "../src/cli/write-compose.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchroom-voicedrop-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  resetHostCapabilitiesWarnings();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** Write a verdict file with the given engine. */
function writeVerdict(engine: "local" | "cloud"): void {
  const path = hostCapabilitiesPath();
  mkdirSync(join(home, ".switchroom"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      voice: {
        gpuPresent: engine === "local",
        containerToolkit: engine === "local",
        engine,
        detectedAt: "2026-06-30T21:10:45.000Z",
      },
    }),
  );
}

/** Write bytes that are readable but are not a capabilities document. */
function writeGarbageVerdict(): void {
  mkdirSync(join(home, ".switchroom"), { recursive: true });
  writeFileSync(hostCapabilitiesPath(), '{"version":1}');
}

const WITH_SIDECAR = [
  "services:",
  "  clerk:",
  "    image: ghcr.io/switchroom/switchroom-agent:v1",
  "  voice-sidecar:",
  "    image: ghcr.io/switchroom/switchroom-voice:v1",
  "",
].join("\n");

const WITHOUT_SIDECAR = [
  "services:",
  "  clerk:",
  "    image: ghcr.io/switchroom/switchroom-agent:v1",
  "",
].join("\n");

describe("resolveVoiceEngine — reports HOW the engine was decided", () => {
  it("a readable local verdict is a read, not a default", () => {
    writeVerdict("local");
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("local");
    expect(r.reason).toBe("verdict");
    expect(isDefaultedVoiceEngine(r)).toBe(false);
  });

  it("a readable cloud verdict is a read, not a default", () => {
    writeVerdict("cloud");
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("cloud");
    expect(r.reason).toBe("verdict");
    expect(isDefaultedVoiceEngine(r)).toBe(false);
  });

  it("an absent verdict defaults to cloud and says so", () => {
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("cloud");
    expect(r.reason).toBe("no-verdict");
    expect(isDefaultedVoiceEngine(r)).toBe(true);
    // The path is what makes the message actionable.
    expect(r.path).toBe(hostCapabilitiesPath());
  });

  it("a malformed verdict defaults to cloud and is distinguishable from absent", () => {
    writeGarbageVerdict();
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("cloud");
    expect(r.reason).toBe("malformed");
    expect(isDefaultedVoiceEngine(r)).toBe(true);
    expect(r.detail).not.toBe("");
  });
});

describe("detectVoiceSidecarDrop — fires only when a default costs a service", () => {
  it("attributes the removal when the verdict file is missing", () => {
    const drop = detectVoiceSidecarDrop(
      WITH_SIDECAR,
      WITHOUT_SIDECAR,
      resolveVoiceEngine(),
    );
    expect(drop).not.toBeNull();
    expect(drop!.reason).toBe("no-verdict");
    // The operator must be told WHERE to look and that this is not a
    // GPU-absence finding — that conflation is the bug.
    expect(drop!.message).toContain(hostCapabilitiesPath());
    expect(drop!.message).toContain("REMOVED");
    expect(drop!.message).toContain("could not tell");
  });

  it("attributes the removal when the verdict file is unusable", () => {
    writeGarbageVerdict();
    const drop = detectVoiceSidecarDrop(
      WITH_SIDECAR,
      WITHOUT_SIDECAR,
      resolveVoiceEngine(),
    );
    expect(drop).not.toBeNull();
    expect(drop!.reason).toBe("malformed");
    expect(drop!.message).toContain("malformed");
  });

  it("stays quiet on a genuine cloud verdict — that removal is intended", () => {
    writeVerdict("cloud");
    expect(
      detectVoiceSidecarDrop(WITH_SIDECAR, WITHOUT_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });

  it("stays quiet on a fresh install with no previous compose", () => {
    expect(
      detectVoiceSidecarDrop(null, WITHOUT_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });

  it("stays quiet when the previous compose never had the sidecar", () => {
    expect(
      detectVoiceSidecarDrop(WITHOUT_SIDECAR, WITHOUT_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });

  it("stays quiet when the sidecar survives the regeneration", () => {
    writeVerdict("local");
    expect(
      detectVoiceSidecarDrop(WITH_SIDECAR, WITH_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });
});

describe("parseComposeServiceNames — the single parse both surfaces use", () => {
  it("extracts top-level service keys only", () => {
    expect(parseComposeServiceNames(WITH_SIDECAR)).toEqual([
      "clerk",
      "voice-sidecar",
    ]);
  });
});
