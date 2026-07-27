/**
 * host-capabilities: the persisted voice-engine verdict writer/reader
 * (voice PR-B1). Round-trips the verdict through
 * `~/.switchroom/host-capabilities.json`.
 *
 * Isolation: `resolveStatePath` derives the path from `process.env.HOME`,
 * so each test points HOME at a fresh tmpdir — NEVER the operator's real
 * `~/.switchroom/` (vault/shared-state test discipline).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveVoiceCapability,
  loadHostCapabilities,
  readHostCapabilities,
  isDegradedHostCapabilitiesRead,
  resetHostCapabilitiesWarnings,
  hostCapabilitiesPath,
  HOST_CAPABILITIES_VERSION,
} from "./host-capabilities.js";
import type { GpuCapabilities } from "./gpu-detect.js";

/**
 * Capture `process.stderr.write` for the duration of a block.
 *
 * The point of these assertions is that the operator SEES something, so they
 * are made against the real stream the library writes to rather than a
 * refactor-friendly injected logger — a logger seam could be silently
 * disconnected and every test would still pass.
 */
function captureStderr(): { text: () => string; restore: () => void } {
  let buf = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    });
  return { text: () => buf, restore: () => spy.mockRestore() };
}

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

/**
 * The 2026-07-28 GPU regression, at its source.
 *
 * `loadHostCapabilities` used to answer `null` for four different situations —
 * absent, denied, not-JSON, wrong-shape — and every GPU gate downstream read
 * that `null` as "this host has no GPU". A verdict file the process could not
 * READ therefore turned `--gpus all` and the GPU-gated reranker defaults off
 * with no output on any stream.
 *
 * These assert the distinction itself, and that the failure is audible.
 */
describe("readHostCapabilities distinguishes cannot-read from no-GPU", () => {
  beforeEach(() => resetHostCapabilitiesWarnings());

  it("reports `absent` and stays SILENT when the file was never written", () => {
    const warn = captureStderr();
    try {
      const read = readHostCapabilities();
      expect(read.status).toBe("absent");
      expect(read.caps).toBeNull();
      expect(isDegradedHostCapabilitiesRead(read)).toBe(false);
      // A fresh install has legitimately never probed. No noise for it.
      expect(warn.text()).toBe("");
    } finally {
      warn.restore();
    }
  });

  it("reports `unreadable` — NOT absent, NOT a no-GPU verdict — when the read fails", () => {
    // EISDIR rather than EACCES so the assertion holds for a root runner too
    // (root bypasses mode bits; the EACCES shape is pinned separately below).
    mkdirSync(hostCapabilitiesPath(), { recursive: true });

    const read = readHostCapabilities();
    expect(read.status).toBe("unreadable");
    expect(isDegradedHostCapabilitiesRead(read)).toBe(true);
    expect(read.caps).toBeNull();
    expect(read.code).toBe("EISDIR");
    expect(read.path).toBe(hostCapabilitiesPath());
    // The status must NOT be collapsible with the absent case — that
    // collapse IS the bug.
    expect(read.status).not.toBe("absent");
  });

  it("reports `unreadable` with EACCES when permissions deny the read", () => {
    // The literal production trigger: `sudo switchroom setup` wrote the file
    // root:root 0600 into a uid-1000 home. Root ignores mode bits, so this
    // cannot be asserted as root — the EISDIR case above covers that runner.
    if (process.getuid?.() === 0) return;
    saveVoiceCapability(LOCAL_CAPS);
    chmodSync(hostCapabilitiesPath(), 0o000);

    const read = readHostCapabilities();
    expect(read.status).toBe("unreadable");
    expect(read.code).toBe("EACCES");
    expect(isDegradedHostCapabilitiesRead(read)).toBe(true);
  });

  it("reports `malformed` for junk bytes and for a right-JSON/wrong-shape doc", () => {
    saveVoiceCapability(CLOUD_CAPS);

    writeFileSync(hostCapabilitiesPath(), "{ not json");
    const junk = readHostCapabilities();
    expect(junk.status).toBe("malformed");
    expect(isDegradedHostCapabilitiesRead(junk)).toBe(true);

    writeFileSync(hostCapabilitiesPath(), JSON.stringify({ version: 1 }) + "\n");
    const shape = readHostCapabilities();
    expect(shape.status).toBe("malformed");
    expect(shape.detail).toContain("voice");
  });

  it("reports `ok` with the document when the file is readable", () => {
    saveVoiceCapability(LOCAL_CAPS);
    const read = readHostCapabilities();
    expect(read.status).toBe("ok");
    expect(read.caps?.voice.gpuPresent).toBe(true);
    expect(isDegradedHostCapabilitiesRead(read)).toBe(false);
  });
});

describe("a degraded verdict read is loud", () => {
  beforeEach(() => resetHostCapabilitiesWarnings());

  it("warns on stderr, names the file and the consequence, and does not stay quiet", () => {
    mkdirSync(hostCapabilitiesPath(), { recursive: true });
    const warn = captureStderr();
    let text: string;
    try {
      expect(loadHostCapabilities()).toBeNull();
      text = warn.text();
    } finally {
      warn.restore();
    }
    // The pre-fix behaviour was an empty string here. That is the regression.
    expect(text).not.toBe("");
    expect(text).toContain(hostCapabilitiesPath());
    expect(text).toContain("unreadable");
    // It must say WHY this matters, or an operator scrolling past learns nothing.
    expect(text).toContain("--gpus all");
    expect(text.toLowerCase()).toContain("not because this host lacks a gpu");
    // And it must name a way out.
    expect(text).toContain("hindsight.gpu: true");
  });

  it("warns once per process for the same problem, so it cannot spam a rollout", () => {
    mkdirSync(hostCapabilitiesPath(), { recursive: true });
    const warn = captureStderr();
    try {
      loadHostCapabilities();
      loadHostCapabilities();
      loadHostCapabilities();
      expect(warn.text().match(/WARNING: host capabilities file/g)?.length).toBe(1);
    } finally {
      warn.restore();
    }
  });

  it("emits nothing for an absent or healthy verdict", () => {
    const absent = captureStderr();
    try {
      loadHostCapabilities();
      expect(absent.text()).toBe("");
    } finally {
      absent.restore();
    }

    saveVoiceCapability(LOCAL_CAPS);
    const healthy = captureStderr();
    try {
      expect(loadHostCapabilities()?.voice.engine).toBe("local");
      expect(healthy.text()).toBe("");
    } finally {
      healthy.restore();
    }
  });
});
