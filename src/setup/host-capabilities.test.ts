/**
 * host-capabilities: the persisted voice-engine verdict writer/reader
 * (voice PR-B1). Round-trips the verdict through
 * `~/.switchroom/host-capabilities.json`.
 *
 * Isolation: `resolveStatePath` derives the path from `process.env.HOME`,
 * so each test points HOME at a fresh tmpdir — NEVER the operator's real
 * `~/.switchroom/` (vault/shared-state test discipline).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveVoiceCapability,
  loadHostCapabilities,
  hostCapabilitiesPath,
  HOST_CAPABILITIES_VERSION,
} from "./host-capabilities.js";
import type { GpuCapabilities } from "./gpu-detect.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchroom-hostcaps-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const LOCAL_CAPS: GpuCapabilities = {
  gpuPresent: true,
  containerToolkit: true,
  engine: "local",
  reason: "GPU detected — voice will run locally (free, private, on-device).",
};

const CLOUD_CAPS: GpuCapabilities = {
  gpuPresent: false,
  containerToolkit: false,
  engine: "cloud",
  reason: "No GPU detected — voice will use cloud providers if you enable it.",
};

describe("saveVoiceCapability / loadHostCapabilities", () => {
  it("round-trips the local verdict with raw booleans + engine + timestamp", () => {
    const fixed = new Date("2026-06-30T12:34:56.789Z");
    const written = saveVoiceCapability(LOCAL_CAPS, () => fixed);

    expect(written.version).toBe(HOST_CAPABILITIES_VERSION);
    expect(written.voice).toEqual({
      gpuPresent: true,
      containerToolkit: true,
      engine: "local",
      detectedAt: "2026-06-30T12:34:56.789Z",
    });

    const loaded = loadHostCapabilities();
    expect(loaded).toEqual(written);
  });

  it("round-trips the cloud verdict (no GPU)", () => {
    saveVoiceCapability(CLOUD_CAPS);
    const loaded = loadHostCapabilities();
    expect(loaded?.voice.engine).toBe("cloud");
    expect(loaded?.voice.gpuPresent).toBe(false);
    expect(loaded?.voice.containerToolkit).toBe(false);
    expect(typeof loaded?.voice.detectedAt).toBe("string");
  });

  it("writes under ~/.switchroom/host-capabilities.json with mode 0600", () => {
    saveVoiceCapability(CLOUD_CAPS);
    const path = hostCapabilitiesPath();
    expect(path).toBe(join(home, ".switchroom", "host-capabilities.json"));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // trailing newline, like the other state writers
    expect(readFileSync(path, "utf-8").endsWith("}\n")).toBe(true);
  });

  it("loadHostCapabilities returns null when the file is absent", () => {
    expect(loadHostCapabilities()).toBeNull();
  });

  it("loadHostCapabilities returns null on malformed JSON", () => {
    const path = hostCapabilitiesPath();
    // create the dir + a junk file
    saveVoiceCapability(CLOUD_CAPS);
    writeFileSync(path, "{ not json");
    expect(loadHostCapabilities()).toBeNull();
  });
});
