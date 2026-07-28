import { describe, it, expect } from "vitest";

import {
  classifyComponent,
  gatedOwners,
  imageRepoName,
  partitionDrift,
  remediationFor,
} from "./component-scope.js";
import type { ComponentVersion } from "./component-versions.js";

/** Terse ComponentVersion builder — only the fields classification reads. */
function comp(
  name: string,
  imageRef?: string,
  version = "v0.19.26",
): ComponentVersion {
  return imageRef === undefined
    ? { name, kind: "cli", version }
    : { name, kind: "container", version, imageRef };
}

describe("imageRepoName", () => {
  it("extracts the switchroom repo from tagged, digested and registry-port refs", () => {
    expect(imageRepoName("ghcr.io/switchroom/switchroom-hostd:v0.19.30")).toBe(
      "switchroom-hostd",
    );
    expect(
      imageRepoName("ghcr.io/switchroom/switchroom-web@sha256:abc123"),
    ).toBe("switchroom-web");
    expect(imageRepoName("registry:5000/switchroom/switchroom-agent:v1.0.0")).toBe(
      "switchroom-agent",
    );
  });

  it("refuses non-switchroom and bare-name images", () => {
    // `switchroom-hostd-docker-proxy` runs a THIRD-PARTY image under a
    // switchroom-prefixed container name. Classifying it as a deploy unit
    // would gate the roll on a component no switchroom command can move.
    expect(imageRepoName("ghcr.io/tecnativa/docker-socket-proxy:0.3")).toBeNull();
    expect(imageRepoName("alpine/socat:latest")).toBeNull();
    expect(imageRepoName("switchroom-uat-runner:local")).toBeNull();
    expect(imageRepoName(undefined)).toBeNull();
  });
});

describe("classifyComponent", () => {
  it("classifies the hindsight-autoheal sidecar as hostd-owned — the #3928 escapee", () => {
    // THE regression. The sidecar's container name matches no allowlist
    // any previous scope list carried, which is precisely how it stayed
    // on v0.19.26 through a green roll to v0.19.30. Keyed on the IMAGE it
    // lands on hostd automatically, because it runs the hostd image
    // (src/cli/hostd.ts:406).
    expect(
      classifyComponent(
        comp(
          "switchroom-hindsight-autoheal",
          "ghcr.io/switchroom/switchroom-hostd:v0.19.26",
        ),
      ),
    ).toEqual({ kind: "hostd" });
  });

  it("maps each deploy unit onto its owning mechanism", () => {
    expect(
      classifyComponent(
        comp("switchroom-web", "ghcr.io/switchroom/switchroom-web:v0.19.26"),
      ),
    ).toEqual({ kind: "web" });
    expect(
      classifyComponent(
        comp("switchroom-hostd", "ghcr.io/switchroom/switchroom-hostd:v0.19.26"),
      ),
    ).toEqual({ kind: "hostd" });
    expect(
      classifyComponent(
        comp(
          "switchroom-hindsight",
          "ghcr.io/switchroom/switchroom-hindsight:v0.19.26",
        ),
      ),
    ).toEqual({ kind: "hindsight" });
    expect(classifyComponent(comp("cli (host)"))).toEqual({ kind: "cli" });
  });

  it("carries the AGENT name for per-agent fleet containers", () => {
    expect(
      classifyComponent(
        comp("switchroom-klanker", "ghcr.io/switchroom/switchroom-agent:v0.19.26"),
      ),
    ).toEqual({ kind: "fleet", agent: "klanker" });
  });

  it("classifies fleet singletons as fleet with NO agent name", () => {
    // vault-broker / kernel / auth-broker / voice ride the agent compose
    // project and self-heal on the first agent restart (#2170) — they are
    // gated, but not attributable to any one agent.
    for (const [name, repo] of [
      ["switchroom-vault-broker", "switchroom-broker"],
      ["switchroom-approval-kernel", "switchroom-kernel"],
      ["switchroom-auth-broker", "switchroom-auth-broker"],
      ["switchroom-voice-sidecar", "switchroom-voice"],
    ] as const) {
      expect(
        classifyComponent(comp(name, `ghcr.io/switchroom/${repo}:v0.19.26`)),
      ).toEqual({ kind: "fleet" });
    }
  });

  it("defaults an UNKNOWN switchroom image to fleet, so a new component is gated the day it ships", () => {
    expect(
      classifyComponent(
        comp(
          "switchroom-something-new",
          "ghcr.io/switchroom/switchroom-something-new:v0.19.26",
        ),
      ),
    ).toEqual({ kind: "fleet" });
  });
});

describe("remediationFor", () => {
  it("names the per-owner command the operator (or an agent) can actually run", () => {
    expect(remediationFor({ kind: "web" }, "v0.19.30")).toContain(
      "switchroom webd install --tag v0.19.30",
    );
    expect(remediationFor({ kind: "hostd" }, "v0.19.30")).toContain(
      "switchroom hostd install --tag v0.19.30",
    );
    expect(remediationFor({ kind: "hindsight" }, "v0.19.30")).toContain(
      "switchroom memory setup",
    );
    expect(remediationFor({ kind: "cli" }, "v0.19.30")).toContain(
      "switchroom update",
    );
    expect(remediationFor({ kind: "fleet", agent: "klanker" }, "v0.19.30")).toContain(
      "--agents klanker",
    );
  });
});

describe("gatedOwners", () => {
  it("gates web / hostd / hindsight exactly when the plan carries their refresh step", () => {
    const full = gatedOwners(
      ["apply", "refresh-web", "refresh-hostd", "refresh-hindsight"],
      false,
    );
    expect([...full].sort()).toEqual(["fleet", "hindsight", "hostd", "web"]);

    // `--skip-web` drops all three refresh steps on the host-shell path.
    const skipped = gatedOwners(["apply", "restart-agent"], false);
    expect([...skipped].sort()).toEqual(["fleet"]);
  });

  it("gates hostd on the hostd-driven path even though refresh-hostd is absent", () => {
    // hostd deliberately does not recreate itself mid-roll (that would
    // SIGKILL the in-flight child), but it DOES self-bump its compose
    // project before spawning — so a hostd-project component left behind
    // (exactly switchroom-hindsight-autoheal in #3928) is a real finding.
    expect(gatedOwners(["apply", "restart-agent"], true).has("hostd")).toBe(true);
  });

  it("NEVER gates the host CLI", () => {
    // No plan step converges `npm i -g switchroom` on the host. Gating it
    // would fail every hostd-driven roll whenever the operator's host CLI
    // lagged the tag — the normal state right after a release, and true
    // on the #3928 host itself.
    for (const hostd of [false, true]) {
      expect(
        gatedOwners(
          ["apply", "refresh-web", "refresh-hostd", "refresh-hindsight"],
          hostd,
        ).has("cli"),
      ).toBe(false);
    }
  });
});

describe("partitionDrift", () => {
  const behind: ComponentVersion[] = [
    comp("switchroom-web", "ghcr.io/switchroom/switchroom-web:v0.19.26"),
    comp(
      "switchroom-hindsight-autoheal",
      "ghcr.io/switchroom/switchroom-hostd:v0.19.26",
    ),
    comp("switchroom-klanker", "ghcr.io/switchroom/switchroom-agent:v0.19.26"),
    comp("switchroom-ghost", "ghcr.io/switchroom/switchroom-agent:v0.19.26"),
    comp("cli (host)"),
  ];

  it("gates web + autoheal + the ROLLED agent, and exempts the rest (#3928)", () => {
    const { gated, exempt } = partitionDrift(behind, {
      owners: gatedOwners(
        ["apply", "restart-agent", "refresh-web", "refresh-hostd"],
        false,
      ),
      rolledAgents: new Set(["klanker"]),
    });
    expect(gated.map((c) => c.name)).toEqual([
      "switchroom-web",
      "switchroom-hindsight-autoheal",
      "switchroom-klanker",
    ]);
    // `switchroom-ghost` was not in this roll's agent set; the host CLI is
    // never gated. Both are still REPORTED, never silently dropped.
    expect(exempt.map((c) => c.name)).toEqual(["switchroom-ghost", "cli (host)"]);
  });

  it("exempts web when the operator explicitly asked to skip it", () => {
    const { gated, exempt } = partitionDrift(behind, {
      owners: gatedOwners(["apply", "restart-agent"], false),
      rolledAgents: new Set(["klanker", "ghost"]),
    });
    expect(gated.map((c) => c.name)).toEqual([
      "switchroom-klanker",
      "switchroom-ghost",
    ]);
    expect(exempt.map((c) => c.name)).toEqual([
      "switchroom-web",
      "switchroom-hindsight-autoheal",
      "cli (host)",
    ]);
  });

  it("returns nothing gated when nothing drifted", () => {
    expect(
      partitionDrift([], {
        owners: gatedOwners(["apply", "refresh-web"], false),
        rolledAgents: new Set(["klanker"]),
      }),
    ).toEqual({ gated: [], exempt: [] });
  });
});
