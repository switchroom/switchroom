/**
 * Buzz relay-contract drift guard (Phase 1). The check must stay GREEN against
 * the live constants today, and must WARN (never throw) the instant a kind or
 * an AUTH tag moves away from the pinned Phase-0 relay contract.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  checkRelayCompat,
  computeContractDigest,
  liveRelayContract,
  warnOnRelayContractDrift,
  type PinnedRelayContract,
} from "./compat-check.js";

const here = dirname(fileURLToPath(import.meta.url));
const pinned = JSON.parse(
  readFileSync(join(here, "fixtures", "relay-contract.json"), "utf8"),
) as PinnedRelayContract;

describe("buzz relay-contract compat check", () => {
  it("the vendored fixture matches the LIVE sidecar constants (no drift today)", () => {
    const result = checkRelayCompat(pinned);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("the fixture's pinned digest equals the digest of the live contract", () => {
    expect(pinned.digest).toBe(computeContractDigest(liveRelayContract()));
  });

  it("WARNS when the pinned NIP-42 AUTH kind drifts from code", () => {
    // Drift the pinned scalar AND its digest together (a real relay-side move
    // regenerates the fixture), so both the field-level and digest lines fire.
    const drifted: PinnedRelayContract = { ...pinned, nip42_auth_kind: 20000 };
    drifted.digest = computeContractDigest(drifted);
    const result = checkRelayCompat(drifted);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("AUTH kind drift"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("digest drift"))).toBe(true);
  });

  it("WARNS when the pinned NIP-29 message kind drifts from code", () => {
    const drifted: PinnedRelayContract = { ...pinned, message_kind: 1 };
    const result = checkRelayCompat(drifted);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("message kind drift"))).toBe(true);
  });

  it("WARNS when the pinned AUTH tag-set drifts (renamed/removed tag)", () => {
    const drifted: PinnedRelayContract = { ...pinned, auth_tags: ["challenge", "relays"] };
    const result = checkRelayCompat(drifted);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("tag-set drift"))).toBe(true);
  });

  it("is tag-order and case independent (no false-positive drift)", () => {
    const reordered: PinnedRelayContract = { ...pinned, auth_tags: ["RELAY", "Challenge"] };
    // Recompute the digest for the reordered/cased tags so only order/case differs.
    reordered.digest = computeContractDigest(reordered);
    expect(checkRelayCompat(reordered).ok).toBe(true);
  });

  it("digest catches drift even if a field-level check is bypassed", () => {
    // A fixture whose scalar fields match code but whose digest is stale.
    const staleDigest: PinnedRelayContract = { ...pinned, digest: "deadbeef" };
    const result = checkRelayCompat(staleDigest);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("digest drift"))).toBe(true);
  });

  it("warnOnRelayContractDrift routes each warning to the sink and never throws", () => {
    const sink: string[] = [];
    const drifted: PinnedRelayContract = { ...pinned, message_kind: 42 };
    const result = warnOnRelayContractDrift(drifted, (m) => sink.push(m));
    expect(result.ok).toBe(false);
    expect(sink.length).toBeGreaterThan(0);
    expect(sink.every((l) => l.startsWith("[buzz][compat]"))).toBe(true);
  });

  it("a clean check emits nothing to the sink", () => {
    const sink: string[] = [];
    const result = warnOnRelayContractDrift(pinned, (m) => sink.push(m));
    expect(result.ok).toBe(true);
    expect(sink).toEqual([]);
  });
});
