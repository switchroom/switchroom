import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Importing setup.ts transitively loads vault-broker.js → broker/server.ts
// → grants-db.ts → bun:sqlite, which vitest can't resolve. Mock the same
// modules the existing setup.test.ts mocks so the import graph is safe.
vi.mock("../src/vault/vault.js", () => ({
  openVault: vi.fn(),
  createVault: vi.fn(),
  setStringSecret: vi.fn(),
  getStringSecret: vi.fn(),
}));
vi.mock("../src/vault/grants-db.ts", () => ({}));
vi.mock("../src/vault/broker/server.js", () => ({
  VaultBroker: vi.fn(),
  registerShutdownHandlers: vi.fn(),
}));

import {
  persistDangerousMode,
  persistApprovalAuthTelegramId,
} from "../src/cli/setup.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

// A canonical config with agents nested under `agents:`. `omega` is LAST
// so it exercises the end-of-block boundary that the `\Z` bug broke.
const CANONICAL_YAML = `switchroom:
  version: 1

vault:
  path: ~/.switchroom/vault/vault.enc
  broker:
    socket: ~/.switchroom/vault/broker.sock

agents:
  alpha:
    model: claude-sonnet-5
  omega:
    model: claude-sonnet-5
`;

describe("persistDangerousMode", () => {
  let dir: string;
  let canonicalPath: string;
  let cwdDir: string;
  let decoyPath: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-canonical-"));
    canonicalPath = join(dir, "switchroom.yaml");
    writeFileSync(canonicalPath, CANONICAL_YAML, "utf-8");

    // A DIFFERENT directory that we chdir into — with a decoy config the
    // buggy cwd-resolving code would have written to instead.
    cwdDir = mkdtempSync(join(tmpdir(), "sr-cwd-"));
    decoyPath = join(cwdDir, "switchroom.yaml");
    writeFileSync(decoyPath, CANONICAL_YAML, "utf-8");
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  it("writes dangerous_mode to the canonical config, not cwd", () => {
    const config = {
      agents: { alpha: {}, omega: {} },
    } as unknown as SwitchroomConfig;

    persistDangerousMode(config, canonicalPath);

    const canonical = readFileSync(canonicalPath, "utf-8");
    // BOTH agents get it — including `omega`, the last block, which the
    // literal-`\Z` regex previously failed to match (silent drop).
    expect(canonical).toMatch(/alpha:\n    dangerous_mode: true/);
    expect(canonical).toMatch(/omega:\n    dangerous_mode: true/);

    // The decoy in cwd is untouched — the choice landed canonically.
    const decoy = readFileSync(decoyPath, "utf-8");
    expect(decoy).not.toContain("dangerous_mode");

    // In-memory config mirrors the write.
    expect(config.agents.alpha.dangerous_mode).toBe(true);
    expect(config.agents.omega.dangerous_mode).toBe(true);
  });

  it("is idempotent — does not double-insert on a second run", () => {
    const config = { agents: { alpha: {}, omega: {} } } as unknown as SwitchroomConfig;
    persistDangerousMode(config, canonicalPath);
    persistDangerousMode(config, canonicalPath);
    const canonical = readFileSync(canonicalPath, "utf-8");
    expect(canonical.match(/dangerous_mode: true/g)?.length).toBe(2);
  });

  it("fails loud when the canonical config does not exist", () => {
    const config = { agents: { alpha: {} } } as unknown as SwitchroomConfig;
    expect(() =>
      persistDangerousMode(config, join(dir, "does-not-exist.yaml")),
    ).toThrow(/config not found/);
  });
});

describe("persistApprovalAuthTelegramId", () => {
  let dir: string;
  let canonicalPath: string;
  let cwdDir: string;
  let decoyPath: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-canonical-"));
    canonicalPath = join(dir, "switchroom.yaml");
    writeFileSync(canonicalPath, CANONICAL_YAML, "utf-8");

    cwdDir = mkdtempSync(join(tmpdir(), "sr-cwd-"));
    decoyPath = join(cwdDir, "switchroom.yaml");
    writeFileSync(decoyPath, CANONICAL_YAML, "utf-8");
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  it("writes approvalAuth to the canonical config, not cwd", () => {
    const kind = persistApprovalAuthTelegramId(canonicalPath);
    expect(kind).toBe("rewritten");

    const canonical = readFileSync(canonicalPath, "utf-8");
    expect(canonical).toContain("approvalAuth: telegram-id");

    const decoy = readFileSync(decoyPath, "utf-8");
    expect(decoy).not.toContain("approvalAuth");
  });

  it("returns already-set on a second run without duplicating", () => {
    expect(persistApprovalAuthTelegramId(canonicalPath)).toBe("rewritten");
    expect(persistApprovalAuthTelegramId(canonicalPath)).toBe("already-set");
    const canonical = readFileSync(canonicalPath, "utf-8");
    expect(canonical.match(/approvalAuth/g)?.length).toBe(1);
  });

  it("returns not-found when there is no vault.broker block", () => {
    const noBroker = join(dir, "no-broker.yaml");
    writeFileSync(noBroker, "switchroom:\n  version: 1\nagents:\n  a:\n    model: x\n", "utf-8");
    expect(persistApprovalAuthTelegramId(noBroker)).toBe("not-found");
  });

  it("fails loud when the canonical config does not exist", () => {
    expect(() =>
      persistApprovalAuthTelegramId(join(dir, "does-not-exist.yaml")),
    ).toThrow(/config not found/);
  });
});
