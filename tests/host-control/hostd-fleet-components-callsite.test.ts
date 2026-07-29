/**
 * The `fleetComponents` wiring is load-bearing and silent when missing.
 *
 * `HostdServer` deliberately does NOT reach for `docker` on its own: a
 * self-servicing default would make every unit test's `prior_pin` depend
 * on whatever containers the host running the suite happens to have. The
 * price of that choice is that the real inventory reader has to be
 * injected at the composition root — and if someone drops that injection,
 * NOTHING fails loudly. Rolls keep succeeding; they just stop recording a
 * `prior_pin`, and `rollout --allow-downgrade` quietly loses its default
 * target. The regression would only surface the day someone needed to
 * roll back.
 *
 * A behavioural test cannot catch this: it would have to construct the
 * daemon the way `main.ts` does, which is the very thing at issue. So
 * this is a static callsite assertion — same shape as
 * `singleton-cleanup-callsite.test.ts` — pinning the one wiring that
 * exists to the one place it belongs.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainSrc = readFileSync(
  join(repoRoot, "src", "host-control", "main.ts"),
  "utf8",
);
const serverSrc = readFileSync(
  join(repoRoot, "src", "host-control", "server.ts"),
  "utf8",
);

describe("hostd wires the running-fleet inventory at its composition root", () => {
  it("main.ts passes fleetComponents into HostdServer", () => {
    expect(mainSrc).toMatch(/fleetComponents:\s*\(\)\s*=>\s*dockerFleetComponents\(/);
  });

  it("main.ts imports the real docker-backed collector", () => {
    expect(mainSrc).toContain("dockerFleetComponents");
    expect(mainSrc).toMatch(
      /import\s*\{\s*dockerFleetComponents\s*\}\s*from\s*"\.\/prior-pin\.js"/,
    );
  });

  it("server.ts does NOT shell out to docker for the inventory itself", () => {
    // The whole point of the injection: a server built in a test must not
    // read the host's containers. If a `docker ps` reappears in the
    // daemon, unit-test `prior_pin` becomes host-dependent again.
    //
    // Matched as CALLS, so the `{@link dockerFleetComponents}` reference in
    // the seam's own doc comment (which is documentation, not a call) does
    // not trip the guard.
    expect(serverSrc).not.toMatch(/\bcollectContainerComponents\s*\(/);
    expect(serverSrc).not.toMatch(/\bdockerFleetComponents\s*\(/);
  });
});
