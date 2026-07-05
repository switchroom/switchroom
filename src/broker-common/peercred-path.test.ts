/**
 * Tests for the shared broker-plane path-as-identity primitive (#2795).
 *
 * These assert the SECURITY-load-bearing contract the three brokers now
 * share: an authorized bind path yields the right identity, and every
 * unauthorized / malformed / reserved-name path fails closed to null
 * ("unidentified → DENIED"). The per-broker peercred tests
 * (vault/auth/host-control) additionally pin that each site's regexes +
 * reserved sets, fed through this primitive, reproduce their exact
 * pre-#2795 behaviour.
 */

import { describe, expect, it } from "vitest";
import {
  matchSocketName,
  parseSocketIdentity,
} from "./peercred-path.js";

const SUBDIR = /^\/run\/switchroom\/broker\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/sock$/;
const FLAT = /^\/run\/switchroom\/broker\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\.sock$/;
const reserved = new Set(["operator", "hostd"]);

describe("matchSocketName", () => {
  it("returns the captured name for an authorized path", () => {
    expect(matchSocketName("/run/switchroom/broker/alice/sock", [SUBDIR])).toBe(
      "alice",
    );
    expect(matchSocketName("/run/switchroom/broker/bob.sock", [FLAT])).toBe(
      "bob",
    );
  });

  it("returns the reserved name verbatim (no gate at this layer)", () => {
    expect(matchSocketName("/run/switchroom/broker/operator/sock", [SUBDIR])).toBe(
      "operator",
    );
  });

  it("tries patterns in order, first match wins", () => {
    expect(matchSocketName("/run/switchroom/broker/carol/sock", [FLAT, SUBDIR])).toBe(
      "carol",
    );
  });

  it("fails closed to null on non-string / empty / no-match", () => {
    for (const bad of [
      undefined,
      null,
      123,
      {},
      "",
      "/etc/passwd",
      "/run/switchroom/broker//sock",
      "/run/switchroom/broker/alice/sock/extra",
      "/run/switchroom/auth-broker/alice/sock",
    ]) {
      expect(matchSocketName(bad, [SUBDIR]), `expected null for ${String(bad)}`)
        .toBeNull();
    }
  });

  it("enforces the optional length guard (defence in depth)", () => {
    const ok = "a".repeat(63);
    const tooLong = "a".repeat(64);
    expect(
      matchSocketName(`/run/switchroom/broker/${ok}/sock`, [SUBDIR], 63),
    ).toBe(ok);
    expect(
      matchSocketName(`/run/switchroom/broker/${tooLong}/sock`, [SUBDIR], 63),
    ).toBeNull();
  });
});

describe("parseSocketIdentity", () => {
  const spec = { patterns: [FLAT, SUBDIR], reservedNames: reserved };

  it("accepts an authorized agent peer", () => {
    expect(parseSocketIdentity("/run/switchroom/broker/alice/sock", spec)).toEqual({
      kind: "agent",
      name: "alice",
    });
    expect(parseSocketIdentity("/run/switchroom/broker/bob.sock", spec)).toEqual({
      kind: "agent",
      name: "bob",
    });
  });

  it("maps the operator name to {kind:operator} from either bind shape", () => {
    expect(
      parseSocketIdentity("/run/switchroom/broker/operator/sock", spec),
    ).toEqual({ kind: "operator" });
    // operator is ALSO in the reserved set — it must still resolve to
    // operator (matched before the reserved-name rejection), never null.
    expect(
      parseSocketIdentity("/run/switchroom/broker/operator.sock", spec),
    ).toEqual({ kind: "operator" });
  });

  it("rejects a reserved (non-operator) name as an agent — no bypass", () => {
    expect(
      parseSocketIdentity("/run/switchroom/broker/hostd/sock", spec),
    ).toBeNull();
    expect(
      parseSocketIdentity("/run/switchroom/broker/hostd.sock", spec),
    ).toBeNull();
  });

  it("rejects unauthorized / malformed paths (fail-closed)", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "/run/switchroom/broker/alice", // missing suffix
      "/run/switchroom/broker/foo;bar/sock", // shell-special
      "/run/switchroom/hostd/alice/sock", // wrong broker root
    ]) {
      expect(parseSocketIdentity(bad, spec), `expected null for "${bad}"`)
        .toBeNull();
    }
  });

  it("honours a custom operator name", () => {
    const custom = {
      patterns: [SUBDIR],
      reservedNames: new Set(["root"]),
      operatorName: "root",
    };
    expect(
      parseSocketIdentity("/run/switchroom/broker/root/sock", custom),
    ).toEqual({ kind: "operator" });
  });
});
