/**
 * Unit coverage for the pure `prior_pin` resolver.
 *
 * The wiring-level regression (config pin already == target) lives in
 * `tests/host-control/rollout-prior-pin-source.test.ts`. These pin the
 * two invariants the module exists to hold, at the level where they are
 * decided: the target is never the answer, and a mixed fleet is recorded
 * honestly with a deterministic single pick.
 */

import { describe, it, expect } from "vitest";
import { resolvePriorPinFromFleet } from "./prior-pin.js";
import type { ComponentVersion } from "../cli/component-versions.js";

const AGENT_IMAGE = "ghcr.io/switchroom/switchroom-agent";

function agent(name: string, version: string | null): ComponentVersion {
  return {
    name: `switchroom-${name}`,
    kind: "container",
    version,
    imageRef: `${AGENT_IMAGE}:${version ?? "latest"}`,
  };
}

function container(
  name: string,
  imageRef: string,
  version: string | null,
): ComponentVersion {
  return { name, kind: "container", version, imageRef };
}

describe("resolvePriorPinFromFleet", () => {
  it("returns the single version a uniform fleet is running", () => {
    expect(
      resolvePriorPinFromFleet(
        [agent("clerk", "v1.9.0"), agent("marko", "v1.9.0")],
        "v2.0.0",
      ),
    ).toEqual({ prior_pin: "v1.9.0", prior_pin_source: "running-fleet" });
  });

  it("INVARIANT 1: never returns the target", () => {
    const r = resolvePriorPinFromFleet(
      [agent("clerk", "v2.0.0"), agent("marko", "v2.0.0")],
      "v2.0.0",
    );
    expect(r.prior_pin).toBeUndefined();
    expect(r.prior_pin_source).toBe("all-on-target");
    expect(r.prior_pin_observed).toEqual(["v2.0.0"]);
  });

  it("INVARIANT 1 holds when the target tag is written bare (no leading v)", () => {
    const r = resolvePriorPinFromFleet([agent("clerk", "v2.0.0")], "2.0.0");
    expect(r.prior_pin).toBeUndefined();
    expect(r.prior_pin_source).toBe("all-on-target");
  });

  it("INVARIANT 2: a mixed fleet picks the LOWEST candidate and records the whole set", () => {
    const r = resolvePriorPinFromFleet(
      [
        agent("clerk", "v1.9.0"),
        agent("marko", "v1.7.2"),
        agent("ghost", "v1.10.0"),
      ],
      "v2.0.0",
    );
    // Lowest: a rollback must never be an UPGRADE for any in-scope agent.
    expect(r.prior_pin).toBe("v1.7.2");
    expect(r.prior_pin_source).toBe("running-fleet-mixed");
    // Semver ordering, not lexical: v1.10.0 > v1.9.0.
    expect(r.prior_pin_observed).toEqual(["v1.10.0", "v1.9.0", "v1.7.2"]);
  });

  it("a mixed fleet that includes the target still excludes it from the pick", () => {
    const r = resolvePriorPinFromFleet(
      [agent("clerk", "v2.0.0"), agent("marko", "v1.9.0"), agent("ghost", "v1.8.0")],
      "v2.0.0",
    );
    expect(r.prior_pin).toBe("v1.8.0");
    expect(r.prior_pin_observed).toEqual(["v2.0.0", "v1.9.0", "v1.8.0"]);
  });

  it("one candidate beside the target is unambiguous but still discloses the set", () => {
    const r = resolvePriorPinFromFleet(
      [agent("clerk", "v2.0.0"), agent("marko", "v1.9.0")],
      "v2.0.0",
    );
    expect(r.prior_pin).toBe("v1.9.0");
    expect(r.prior_pin_source).toBe("running-fleet");
    expect(r.prior_pin_observed).toEqual(["v2.0.0", "v1.9.0"]);
  });

  it("reports `unobserved` — not a guess — when nothing readable is running", () => {
    expect(resolvePriorPinFromFleet([], "v2.0.0")).toEqual({
      prior_pin_source: "unobserved",
    });
  });

  it("ignores agents whose image tag carries no semver", () => {
    const r = resolvePriorPinFromFleet(
      [container("switchroom-clerk", `${AGENT_IMAGE}:latest`, null)],
      "v2.0.0",
    );
    expect(r.prior_pin_source).toBe("unobserved");
  });

  it("ignores non-agent components — hostd/web/hindsight advance separately", () => {
    const r = resolvePriorPinFromFleet(
      [
        container(
          "switchroom-web",
          "ghcr.io/switchroom/switchroom-web:v1.0.0",
          "v1.0.0",
        ),
        container(
          "switchroom-hostd",
          "ghcr.io/switchroom/switchroom-hostd:v1.1.0",
          "v1.1.0",
        ),
        container(
          "switchroom-hindsight",
          "ghcr.io/switchroom/switchroom-hindsight:v1.2.0",
          "v1.2.0",
        ),
        agent("clerk", "v1.9.0"),
      ],
      "v2.0.0",
    );
    expect(r.prior_pin).toBe("v1.9.0");
    expect(r.prior_pin_source).toBe("running-fleet");
  });

  it("ignores the CLI component", () => {
    const r = resolvePriorPinFromFleet(
      [
        { name: "cli (host)", kind: "cli", version: "v1.0.0" },
        agent("clerk", "v1.9.0"),
      ],
      "v2.0.0",
    );
    expect(r.prior_pin).toBe("v1.9.0");
  });

  it("restricts to the --agents subset when one was given", () => {
    const r = resolvePriorPinFromFleet(
      [agent("clerk", "v1.9.0"), agent("marko", "v1.0.0")],
      "v2.0.0",
      ["clerk"],
    );
    expect(r.prior_pin).toBe("v1.9.0");
    expect(r.prior_pin_source).toBe("running-fleet");
  });

  it("an empty scope array means the whole fleet, not an empty fleet", () => {
    const r = resolvePriorPinFromFleet(
      [agent("clerk", "v1.9.0"), agent("marko", "v1.9.0")],
      "v2.0.0",
      [],
    );
    expect(r.prior_pin).toBe("v1.9.0");
  });

  it("with no target given, the highest-observed is still not assumed — the lowest rule holds", () => {
    const r = resolvePriorPinFromFleet(
      [agent("clerk", "v1.9.0"), agent("marko", "v1.7.0")],
      undefined,
    );
    expect(r.prior_pin).toBe("v1.7.0");
    expect(r.prior_pin_source).toBe("running-fleet-mixed");
  });
});
