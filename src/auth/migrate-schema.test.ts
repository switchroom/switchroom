/**
 * In-place YAML migration tests — RFC H §6.
 *
 * Three fixture shapes per the RFC:
 *   - uniform-single  (one agent, one account)
 *   - uniform-multi   (multiple agents, all primaries identical, some
 *                      with extra fallbacks)
 *   - divergent       (multiple agents, multiple primaries — primary
 *                      preference per-agent is LOST)
 *
 * Plus an idempotency check (re-running on already-migrated YAML is a
 * no-op).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isLegacyAuthSchema,
  migrateAuthSchema,
  migrateAuthSchemaFile,
} from "./migrate-schema.js";

const FIXED_DATE = () => "2026-05-14";

describe("migrate-schema — detection", () => {
  it("recognises legacy auth.accounts as needing migration", () => {
    const yaml = `
agents:
  ziggy:
    topic_name: ziggy
    auth:
      accounts: [me@kt]
`;
    expect(isLegacyAuthSchema(yaml)).toBe(true);
  });

  it("recognises legacy auth_label as needing migration", () => {
    const yaml = `
agents:
  ziggy:
    topic_name: ziggy
    auth_label: me@kt
`;
    expect(isLegacyAuthSchema(yaml)).toBe(true);
  });

  it("returns false when neither legacy field is present", () => {
    const yaml = `
auth:
  active: me@kt
agents:
  ziggy:
    topic_name: ziggy
`;
    expect(isLegacyAuthSchema(yaml)).toBe(false);
  });
});

describe("migrate-schema — uniform-single fleet", () => {
  it("lifts a single account into auth.active and drops the per-agent list", () => {
    const yaml = `
agents:
  ziggy:
    topic_name: ziggy
    auth:
      accounts: [me@kt]
`;
    const { yaml: out, report } = migrateAuthSchema(yaml, { now: FIXED_DATE });
    expect(report.migrated).toBe(true);
    expect(report.active).toBe("me@kt");
    expect(report.divergent).toBe(false);
    expect(report.overriddenAgents).toEqual([]);
    expect(out).toMatch(/^auth:\n\s+active:\s+me@kt/m);
    // Single-account fleet: no fallback_order emitted.
    expect(out).not.toMatch(/fallback_order:/);
    // Per-agent auth.accounts gone; agent block now empty under auth: or
    // entirely missing.
    expect(out).not.toMatch(/accounts:\s*\[/);
  });
});

describe("migrate-schema — uniform-multi fleet", () => {
  it("lifts the shared primary and emits first-seen-union fallback_order", () => {
    const yaml = `
agents:
  ziggy:
    topic_name: ziggy
    auth:
      accounts: [me@kt, pixsoul]
  clerk:
    topic_name: clerk
    auth:
      accounts: [me@kt, ken-outlook]
`;
    const { yaml: out, report } = migrateAuthSchema(yaml, { now: FIXED_DATE });
    expect(report.migrated).toBe(true);
    expect(report.active).toBe("me@kt");
    expect(report.divergent).toBe(false);
    expect(report.fallbackOrder).toEqual(["me@kt", "pixsoul", "ken-outlook"]);
    expect(report.overriddenAgents).toEqual([]);

    expect(out).toMatch(/^auth:\n\s+active:\s+me@kt/m);
    expect(out).toMatch(/fallback_order:/);
    expect(out).toMatch(/-\s+me@kt/);
    expect(out).toMatch(/-\s+pixsoul/);
    expect(out).toMatch(/-\s+ken-outlook/);
    expect(out).not.toMatch(/auth:\n\s+accounts:/);
  });
});

describe("migrate-schema — divergent fleet", () => {
  it("warns loudly, picks most-common primary, synthesises overrides", () => {
    const yaml = `
agents:
  ziggy:
    topic_name: ziggy
    auth:
      accounts: [me@kt, pixsoul]
  clerk:
    topic_name: clerk
    auth:
      accounts: [me@kt]
  klanker:
    topic_name: klanker
    auth:
      accounts: [ken-outlook, me@kt]
`;
    const warnings: string[] = [];
    const { yaml: out, report } = migrateAuthSchema(yaml, {
      now: FIXED_DATE,
      warn: (m) => warnings.push(m),
    });
    expect(report.migrated).toBe(true);
    expect(report.divergent).toBe(true);
    // me@kt is primary twice, ken-outlook once → me@kt wins.
    expect(report.active).toBe("me@kt");
    expect(report.fallbackOrder).toEqual(["me@kt", "pixsoul", "ken-outlook"]);
    expect(report.overriddenAgents).toEqual(["klanker"]);

    // Warning surfaced and mentions BOTH ordering loss AND tail loss.
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const combined = warnings.join("\n");
    expect(combined).toMatch(/ORDERING/);
    expect(combined).toMatch(/TAIL/);
    expect(combined).toMatch(/divergent/i);

    // Output shape: fleet active + fallback_order, klanker has override.
    expect(out).toMatch(/^auth:\n\s+active:\s+me@kt/m);
    expect(out).toMatch(/klanker:\n\s+topic_name:\s+klanker\n\s+auth:\n\s+override:\s+ken-outlook/);
    // ziggy and clerk should NOT carry an override (their primary == active).
    const ziggyBlock = out.split(/^\s+ziggy:/m)[1]?.split(/^\s+[a-z]+:$/m)[0] ?? "";
    expect(ziggyBlock).not.toMatch(/override:/);
  });

  it("tiebreaks on first-seen YAML order when histogram counts are equal", () => {
    const yaml = `
agents:
  ziggy:
    topic_name: ziggy
    auth:
      accounts: [me@kt]
  clerk:
    topic_name: clerk
    auth:
      accounts: [pixsoul]
`;
    const { report } = migrateAuthSchema(yaml, { now: FIXED_DATE });
    expect(report.divergent).toBe(true);
    // Both 1-1 → first-seen wins (me@kt).
    expect(report.active).toBe("me@kt");
  });
});

describe("migrate-schema — auth_label-only fleets", () => {
  it("strips auth_label and reports migration with no active", () => {
    const yaml = `
agents:
  ziggy:
    topic_name: ziggy
    auth_label: me@kt
`;
    const { yaml: out, report } = migrateAuthSchema(yaml, { now: FIXED_DATE });
    expect(report.migrated).toBe(true);
    expect(report.active).toBeUndefined();
    expect(out).not.toMatch(/auth_label:/);
  });
});

describe("migrate-schema — idempotency", () => {
  it("returns migrated:false on already-migrated YAML", () => {
    const yaml = `
auth:
  active: me@kt
  fallback_order:
    - me@kt
    - pixsoul
agents:
  ziggy:
    topic_name: ziggy
  clerk:
    topic_name: clerk
    auth:
      override: pixsoul
`;
    const { yaml: out, report } = migrateAuthSchema(yaml, { now: FIXED_DATE });
    expect(report.migrated).toBe(false);
    // Output unchanged.
    expect(out).toBe(yaml);
  });
});

describe("migrate-schema — file IO with backup", () => {
  it("writes pre-upgrade backup and rewrites the config", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-schema-"));
    const cfg = join(dir, "switchroom.yaml");
    const before = `
agents:
  ziggy:
    topic_name: ziggy
    auth:
      accounts: [me@kt]
`;
    writeFileSync(cfg, before, "utf-8");
    const report = migrateAuthSchemaFile(cfg, { now: FIXED_DATE });
    expect(report.migrated).toBe(true);
    expect(report.backupPath).toBe(`${cfg}.pre-auth-broker`);
    expect(existsSync(report.backupPath!)).toBe(true);
    expect(readFileSync(report.backupPath!, "utf-8")).toBe(before);
    const after = readFileSync(cfg, "utf-8");
    expect(after).toMatch(/active:\s+me@kt/);
    expect(after).not.toMatch(/accounts:\s*\[/);
  });

  it("does not overwrite an existing backup on re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-schema-"));
    const cfg = join(dir, "switchroom.yaml");
    const original = `
agents:
  ziggy:
    topic_name: ziggy
    auth:
      accounts: [me@kt]
`;
    writeFileSync(cfg, original, "utf-8");
    migrateAuthSchemaFile(cfg, { now: FIXED_DATE });
    const firstBackup = readFileSync(`${cfg}.pre-auth-broker`, "utf-8");

    // Hand-mangle the migrated yaml to look legacy again, re-migrate.
    writeFileSync(cfg, original, "utf-8");
    migrateAuthSchemaFile(cfg, { now: FIXED_DATE });
    const secondBackup = readFileSync(`${cfg}.pre-auth-broker`, "utf-8");
    expect(secondBackup).toBe(firstBackup);
  });

  it("no-op on already-migrated file (no backup, no rewrite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-schema-"));
    const cfg = join(dir, "switchroom.yaml");
    const newshape = `
auth:
  active: me@kt
agents:
  ziggy:
    topic_name: ziggy
`;
    writeFileSync(cfg, newshape, "utf-8");
    const report = migrateAuthSchemaFile(cfg, { now: FIXED_DATE });
    expect(report.migrated).toBe(false);
    expect(existsSync(`${cfg}.pre-auth-broker`)).toBe(false);
    expect(readFileSync(cfg, "utf-8")).toBe(newshape);
  });
});
