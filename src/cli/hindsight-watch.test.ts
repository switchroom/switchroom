import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PREFERRED_RELAY_AGENT,
  collectRelayCandidates,
  orderRelayCandidates,
} from "./hindsight-watch.js";

/**
 * The relay picks the FIRST candidate whose gateway socket accepts the write
 * (`postOperatorNoticeViaGateways` is first-success-wins over candidate
 * order). These tests pin the candidate ORDER — the one lever that decides
 * which agent's bot the operator sees the alert come from — so an alert is
 * attributed to the root debugging agent while never regressing delivery when
 * that agent's gateway is down.
 */
describe("orderRelayCandidates", () => {
  it("puts the preferred agent first while keeping the rest in place", () => {
    const candidates = ["carrie", "dana", "overlord", "zed"].map((agent) => ({
      agent,
      sock: `/sock/${agent}`,
    }));
    const ordered = orderRelayCandidates(candidates);
    expect(ordered.map((c) => c.agent)).toEqual(["overlord", "carrie", "dana", "zed"]);
  });

  it("leaves the alphabetical list untouched when the preferred agent is absent", () => {
    const candidates = ["carrie", "dana", "zed"].map((agent) => ({
      agent,
      sock: `/sock/${agent}`,
    }));
    const ordered = orderRelayCandidates(candidates);
    expect(ordered.map((c) => c.agent)).toEqual(["carrie", "dana", "zed"]);
  });

  it("defaults its preferred agent to the root debugging agent", () => {
    expect(PREFERRED_RELAY_AGENT).toBe("overlord");
  });
});

describe("collectRelayCandidates (live gateway sockets)", () => {
  let dir: string;

  const seedGatewaySocket = (agent: string): void => {
    const sockDir = join(dir, agent, "telegram");
    mkdirSync(sockDir, { recursive: true });
    // A plain file is enough: collectRelayCandidates only checks existsSync.
    writeFileSync(join(sockDir, "gateway.sock"), "");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hw-relay-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("orders overlord first when its gateway socket is live", () => {
    // Alphabetically, carrie sorts first — the pre-fix behaviour delivered
    // through carrie. With overlord's socket live it must now lead.
    for (const agent of ["carrie", "dana", "overlord", "zed"]) seedGatewaySocket(agent);

    const ordered = collectRelayCandidates(dir);
    expect(ordered.map((c) => c.agent)).toEqual(["overlord", "carrie", "dana", "zed"]);
  });

  it("falls back to a non-overlord agent when overlord's socket is absent", () => {
    // overlord has no live gateway socket — delivery must still be attempted,
    // via the alphabetically-first live agent.
    for (const agent of ["carrie", "dana", "zed"]) seedGatewaySocket(agent);

    const ordered = collectRelayCandidates(dir);
    expect(ordered.map((c) => c.agent)).toEqual(["carrie", "dana", "zed"]);
    expect(ordered[0]?.agent).not.toBe("overlord");
  });

  it("ignores an agent dir that has no live gateway socket", () => {
    seedGatewaySocket("overlord");
    // dana exists as a dir but never opened a gateway socket.
    mkdirSync(join(dir, "dana", "telegram"), { recursive: true });

    const ordered = collectRelayCandidates(dir);
    expect(ordered.map((c) => c.agent)).toEqual(["overlord"]);
  });
});
