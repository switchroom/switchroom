/**
 * `getHindsightStatus()` must report the AUTHORITY container's status, not the
 * recall-pool sibling's.
 *
 * `docker ps --filter name=switchroom-hindsight` is a SUBSTRING match, so on a
 * split deployment it returns BOTH `switchroom-hindsight` and
 * `switchroom-hindsight-recall`. `docker ps` orders newest-created first and
 * the pool is always created after the authority, so the pool's row comes
 * FIRST. A `{{.Status}}`-only projection therefore reported the POOL's health
 * as the authority's — on exactly the two surfaces an operator reaches for
 * during an outage (`switchroom memory --status` and the web dashboard), a
 * crash-looping authority would read "Up 2 minutes (healthy)".
 */

import { describe, expect, it } from "vitest";

import { getHindsightStatus } from "./hindsight.js";

describe("getHindsightStatus — exact-name match against the pool sibling", () => {
  it("reports the AUTHORITY's status when the pool row is listed first", () => {
    const status = getHindsightStatus(() =>
      // Newest-created first: the pool, then the dead authority.
      "switchroom-hindsight-recall\tUp 2 minutes (healthy)\n" +
      "switchroom-hindsight\tExited (1) 5 minutes ago\n",
    );
    expect(status).toBe("Exited (1) 5 minutes ago");
  });

  it("returns null when only the pool exists (the authority is gone)", () => {
    const status = getHindsightStatus(
      () => "switchroom-hindsight-recall\tUp 2 minutes (healthy)\n",
    );
    expect(status).toBeNull();
  });

  it("reports the sole container's status on the single-container topology", () => {
    const status = getHindsightStatus(
      () => "switchroom-hindsight\tUp 3 hours (healthy)\n",
    );
    expect(status).toBe("Up 3 hours (healthy)");
  });

  it("returns null when docker fails", () => {
    const status = getHindsightStatus(() => {
      throw new Error("docker daemon unreachable");
    });
    expect(status).toBeNull();
  });
});
