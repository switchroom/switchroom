/**
 * setup wizard Step 7 (Voice engine) — asserts the verdict is recorded to
 * host-capabilities.json AND the right inline message branch fires (voice
 * PR-B1). The detector is mocked so the test never touches a real GPU; HOME
 * is an isolated tmpdir so the writer never hits the operator's
 * ~/.switchroom/ (vault/shared-state test discipline).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// setup.ts statically imports vault-broker → broker/server → grants-db →
// bun:sqlite, which vitest can't resolve. Mock the same chain tests/setup.test.ts does.
vi.mock("../vault/vault.js", () => ({
  openVault: vi.fn(),
  createVault: vi.fn(),
  setStringSecret: vi.fn(),
  getStringSecret: vi.fn(),
}));
vi.mock("../vault/grants-db.ts", () => ({}));
vi.mock("../vault/broker/server.js", () => ({
  VaultBroker: vi.fn(),
  registerShutdownHandlers: vi.fn(),
}));

// The injectable seam for this test: mock the detector so we drive each branch.
import * as gpuDetect from "../setup/gpu-detect.js";
import { stepVoiceEngine } from "./setup.js";

let home: string;
let prevHome: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchroom-voice-step-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
}

function persisted(): { engine: string; gpuPresent: boolean; containerToolkit: boolean } {
  const path = join(home, ".switchroom", "host-capabilities.json");
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf-8")).voice;
}

describe("stepVoiceEngine", () => {
  it("GPU + toolkit → records local verdict + prints the local message", () => {
    vi.spyOn(gpuDetect, "detectGpuCapabilities").mockReturnValue({
      gpuPresent: true,
      containerToolkit: true,
      engine: "local",
      reason: "GPU detected — voice will run locally (free, private, on-device).",
    });

    stepVoiceEngine();

    expect(persisted().engine).toBe("local");
    expect(output()).toMatch(/run locally/i);
  });

  it("GPU, no toolkit → records cloud verdict + prints the install-hint message", () => {
    vi.spyOn(gpuDetect, "detectGpuCapabilities").mockReturnValue({
      gpuPresent: true,
      containerToolkit: false,
      engine: "cloud",
      reason:
        "GPU detected but nvidia-container-toolkit isn't installed — install it to run voice locally, " +
        "or voice will use cloud providers. See: https://example.invalid/install",
    });

    stepVoiceEngine();

    const p = persisted();
    expect(p.engine).toBe("cloud");
    expect(p.gpuPresent).toBe(true);
    expect(output()).toMatch(/nvidia-container-toolkit/i);
  });

  it("no GPU → records cloud verdict + prints the no-GPU message", () => {
    vi.spyOn(gpuDetect, "detectGpuCapabilities").mockReturnValue({
      gpuPresent: false,
      containerToolkit: false,
      engine: "cloud",
      reason: "No GPU detected — voice will use cloud providers if you enable it.",
    });

    stepVoiceEngine();

    expect(persisted().engine).toBe("cloud");
    expect(output()).toMatch(/no gpu detected/i);
  });

  it("detector throwing degrades to a recorded cloud verdict (setup never breaks)", () => {
    vi.spyOn(gpuDetect, "detectGpuCapabilities").mockImplementation(() => {
      throw new Error("probe blew up");
    });

    expect(() => stepVoiceEngine()).not.toThrow();
    expect(persisted().engine).toBe("cloud");
  });
});
