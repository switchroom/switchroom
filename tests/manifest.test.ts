import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadManifest,
  detectDrift,
  ManifestSchema,
  type DriftProbers,
} from "../src/manifest.js";
import { checkManifestDrift } from "../src/cli/doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validManifestData() {
  return {
    switchroom_version: "0.4.0",
    tested_at: "2026-04-29T20:30:00+10:00",
    runtime: { bun: "1.3.11", node: "22.22.2" },
    claude: { cli: "2.1.123" },
    playwright_mcp: "0.0.71",
    hindsight: { backend: null as null | string, client: null as null | string },
    vault_broker: { protocol: 1 as number | null },
  };
}

function validManifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...validManifestData(), ...overrides }, null, 2);
}

/** Probers that all return matching versions for the default manifest. */
function matchingProbers(): DriftProbers {
  return {
    bun: () => "1.3.11",
    node: () => "22.22.2",
    claude: () => "2.1.123",
    playwrightMcp: () => null, // not cached — should not appear in drift
  };
}

// ---------------------------------------------------------------------------
// loadManifest — happy path
// ---------------------------------------------------------------------------

describe("loadManifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-manifest-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads and validates a well-formed manifest", () => {
    const path = join(tempDir, "dependencies.json");
    writeFileSync(path, validManifestJson());
    const manifest = loadManifest(path);
    expect(manifest.switchroom_version).toBe("0.4.0");
    expect(manifest.runtime.bun).toBe("1.3.11");
    expect(manifest.runtime.node).toBe("22.22.2");
    expect(manifest.claude.cli).toBe("2.1.123");
    expect(manifest.playwright_mcp).toBe("0.0.71");
    expect(manifest.hindsight.backend).toBeNull();
    expect(manifest.vault_broker.protocol).toBe(1);
  });

  it("throws a clear error when the file does not exist", () => {
    expect(() => loadManifest("/nonexistent/path/dependencies.json")).toThrowError(
      /Failed to read manifest/,
    );
  });

  it("throws a clear error when the file is not valid JSON", () => {
    const path = join(tempDir, "dependencies.json");
    writeFileSync(path, "{ this is not json }");
    expect(() => loadManifest(path)).toThrowError(/not valid JSON/);
  });

  it("throws a clear error when required fields are missing", () => {
    const path = join(tempDir, "dependencies.json");
    writeFileSync(path, JSON.stringify({ switchroom_version: "0.4.0" }));
    expect(() => loadManifest(path)).toThrowError(/schema validation failed/);
  });

  it("throws a clear error when runtime.bun is the wrong type", () => {
    const path = join(tempDir, "dependencies.json");
    const bad = {
      switchroom_version: "0.4.0",
      tested_at: "2026-04-29T20:30:00+10:00",
      runtime: { bun: 123, node: "22.22.2" }, // bun should be string
      claude: { cli: "2.1.123" },
      playwright_mcp: "0.0.71",
      hindsight: { backend: null, client: null },
      vault_broker: { protocol: 1 },
    };
    writeFileSync(path, JSON.stringify(bad));
    expect(() => loadManifest(path)).toThrowError(/schema validation failed/);
  });

  it("accepts hindsight.backend and client as non-null strings", () => {
    const path = join(tempDir, "dependencies.json");
    const content = validManifestJson({
      hindsight: { backend: "1.0.0", client: "1.0.0" },
    });
    writeFileSync(path, content);
    const manifest = loadManifest(path);
    expect(manifest.hindsight.backend).toBe("1.0.0");
    expect(manifest.hindsight.client).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// detectDrift — uses injectable probers to avoid shell-out in tests
// ---------------------------------------------------------------------------

describe("detectDrift", () => {
  let tempDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-drift-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    manifestPath = join(tempDir, "dependencies.json");
    writeFileSync(manifestPath, validManifestJson());
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns ok:true and empty drift when all versions match", async () => {
    const manifest = loadManifest(manifestPath);
    const report = await detectDrift(manifest, matchingProbers());
    expect(report.ok).toBe(true);
    expect(report.drift).toHaveLength(0);
  });

  it("detects mismatch on bun version and sets ok:false on major drift", async () => {
    const manifest = loadManifest(manifestPath);
    const report = await detectDrift(manifest, {
      ...matchingProbers(),
      bun: () => "2.0.0", // major version bump → fail
    });
    expect(report.ok).toBe(false);
    const bunItem = report.drift.find((d) => d.component === "bun");
    expect(bunItem).toBeDefined();
    expect(bunItem?.declared).toBe("1.3.11");
    expect(bunItem?.installed).toBe("2.0.0");
  });

  it("minor bun version drift is reported but ok remains true (same major)", async () => {
    const manifest = loadManifest(manifestPath);
    const report = await detectDrift(manifest, {
      ...matchingProbers(),
      bun: () => "1.4.0", // same major, different minor → warn, not fail
    });
    expect(report.ok).toBe(true);
    const bunItem = report.drift.find((d) => d.component === "bun");
    expect(bunItem).toBeDefined();
  });

  it("handles claude CLI not installed gracefully (null installed) → ok:false", async () => {
    const manifest = loadManifest(manifestPath);
    const report = await detectDrift(manifest, {
      ...matchingProbers(),
      claude: () => null, // not installed
    });
    expect(report.ok).toBe(false);
    const claudeItem = report.drift.find((d) => d.component === "claude CLI");
    expect(claudeItem).toBeDefined();
    expect(claudeItem?.installed).toBeNull();
  });

  it("@playwright/mcp version mismatch is warn-only (ok remains true)", async () => {
    const manifest = loadManifest(manifestPath);
    const report = await detectDrift(manifest, {
      ...matchingProbers(),
      playwrightMcp: () => "0.0.72", // newer patch — warn only
    });
    expect(report.ok).toBe(true);
    const playwrightItem = report.drift.find((d) => d.component === "@playwright/mcp");
    expect(playwrightItem).toBeDefined();
    expect(playwrightItem?.declared).toBe("0.0.71");
    expect(playwrightItem?.installed).toBe("0.0.72");
  });

  it("@playwright/mcp not cached (null) → not reported in drift", async () => {
    const manifest = loadManifest(manifestPath);
    const report = await detectDrift(manifest, {
      ...matchingProbers(),
      playwrightMcp: () => null, // not cached — skip, not drift
    });
    expect(report.ok).toBe(true);
    expect(report.drift.find((d) => d.component === "@playwright/mcp")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Doctor integration — checkManifestDrift
// ---------------------------------------------------------------------------

describe("checkManifestDrift (doctor integration)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-drift-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns empty array when manifest is not found (graceful missing)", async () => {
    // checkManifestDrift calls loadManifest() which auto-discovers the path.
    // When the file is absent, the function should return [] not throw.
    vi.spyOn(await import("../src/manifest.js"), "loadManifest").mockImplementation(() => {
      throw new Error("dependencies.json not found");
    });
    const results = await checkManifestDrift();
    expect(results).toHaveLength(0);
  });

  it("returns ok result when drift is clean", async () => {
    const manifestMod = await import("../src/manifest.js");
    vi.spyOn(manifestMod, "loadManifest").mockReturnValue(
      ManifestSchema.parse(validManifestData()),
    );
    const results = await checkManifestDrift(matchingProbers());
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].name).toBe("dependency manifest");
  });

  it("surfaces bun drift as a check result with fail status on major mismatch", async () => {
    const manifestMod = await import("../src/manifest.js");
    vi.spyOn(manifestMod, "loadManifest").mockReturnValue(
      ManifestSchema.parse(validManifestData()),
    );
    const results = await checkManifestDrift({
      ...matchingProbers(),
      bun: () => "2.0.0", // major drift → fail
    });
    const bunResult = results.find((r) => r.name.includes("bun"));
    expect(bunResult).toBeDefined();
    expect(bunResult?.status).toBe("fail");
    expect(bunResult?.detail).toContain("declared 1.3.11");
    expect(bunResult?.detail).toContain("installed 2.0.0");
  });
});
