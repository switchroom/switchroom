/**
 * Fence for the "test file runs in NEITHER CI runner" class (#3756).
 *
 * The repo has two runners wired independently — vitest (everything minus
 * `vitest.config.ts`'s `exclude`) and `bun test` with an explicit target list
 * in `telegram-plugin/scripts/bun-test-ci.sh`. A file excluded from vitest and
 * never named in the bun list is executed by nothing, and nothing goes red.
 * That is how `telegram-plugin/uat/feed-matcher.test.ts` — a file whose own
 * docblock calls it "the CI-verifiable floor" for the worker-feed matcher, and
 * which #3821 extended with `stripCardNesting` assertions — sat unexecuted.
 *
 * The regression assertions below read the REAL config off disk, so they fail
 * on `origin/main` at f9314b89e and can only be made green by actually giving
 * those files a runner.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs lint script, no type declarations by design.
import { findOrphanTestFiles, loadRepoInputs } from "../../scripts/check-test-runner-coverage.mjs";

type Inputs = {
  files: string[];
  excludeGlobs: string[];
  bunTargets: string[];
  allowGlobs: string[];
};

const findOrphans = findOrphanTestFiles as (i: Inputs) => string[];
const realInputs = loadRepoInputs as () => Inputs;

describe("findOrphanTestFiles (detection logic)", () => {
  const base: Inputs = { files: [], excludeGlobs: [], bunTargets: [], allowGlobs: [] };

  it("flags a vitest-excluded file that no bun target names", () => {
    expect(
      findOrphans({
        ...base,
        files: ["telegram-plugin/uat/feed-matcher.test.ts"],
        excludeGlobs: ["**/telegram-plugin/uat/**"],
      }),
    ).toEqual(["telegram-plugin/uat/feed-matcher.test.ts"]);
  });

  it("does not flag a file vitest still runs", () => {
    expect(
      findOrphans({ ...base, files: ["telegram-plugin/tests/status-pin.test.ts"] }),
    ).toEqual([]);
  });

  it("does not flag a vitest-excluded file the bun job names by path", () => {
    expect(
      findOrphans({
        ...base,
        files: ["telegram-plugin/uat/feed-matcher.test.ts"],
        excludeGlobs: ["**/telegram-plugin/uat/**"],
        bunTargets: ["uat/feed-matcher.test.ts"],
      }),
    ).toEqual([]);
  });

  it("does not flag a vitest-excluded file the bun job covers by directory", () => {
    expect(
      findOrphans({
        ...base,
        files: ["telegram-plugin/tests/history.test.ts"],
        excludeGlobs: ["**/telegram-plugin/tests/history.test.ts"],
        bunTargets: ["tests"],
      }),
    ).toEqual([]);
  });

  it("a bun target only covers files UNDER telegram-plugin/ (that is the job's cwd)", () => {
    // The bun job runs `working-directory: telegram-plugin`, so a repo-root
    // path can never be matched by its filters — the exact reason the whole
    // src/vault bun suite is orphaned.
    expect(
      findOrphans({
        ...base,
        files: ["src/vault/broker/server.test.ts"],
        excludeGlobs: ["**/src/vault/broker/server.test.ts"],
        bunTargets: ["src/vault/broker/server.test.ts"],
      }),
    ).toEqual(["src/vault/broker/server.test.ts"]);
  });

  it("honours the allowlist", () => {
    expect(
      findOrphans({
        ...base,
        files: ["telegram-plugin/uat/scenarios/smoke-dm-reply.test.ts"],
        excludeGlobs: ["**/telegram-plugin/uat/**"],
        allowGlobs: ["**/telegram-plugin/uat/scenarios/**"],
      }),
    ).toEqual([]);
  });
});

describe("real repo configuration", () => {
  it("has no un-allowlisted orphans", () => {
    expect(findOrphans(realInputs())).toEqual([]);
  });

  // The specific regression. All five are hosted (no creds, no live Telegram)
  // and were swallowed wholesale by vitest's `**/telegram-plugin/uat/**`
  // exclude with nothing on the bun side naming them.
  it.each([
    "telegram-plugin/uat/feed-matcher.test.ts",
    "telegram-plugin/uat/load-env.test.ts",
    "telegram-plugin/uat/uat-driver.test.ts",
    "telegram-plugin/uat/runners/scorer.test.ts",
    "telegram-plugin/uat/runners/skill-coverage.test.ts",
  ])("%s is executed by a CI runner", (file) => {
    const inputs = realInputs();
    expect(inputs.files).toContain(file);
    // Not merely allowlisted away — genuinely covered by a runner.
    expect(findOrphans({ ...inputs, allowGlobs: [] })).not.toContain(file);
  });

  it("no bun target is broad enough to drag in the live-Telegram scenarios", () => {
    // The other half of the contract. `uat/scenarios/**` drives a real MTProto
    // session; a bare `uat` filter in BUN_TEST_ARGS would pull every scenario
    // into the ordinary bun-test job, where it would fail (or worse, message a
    // real chat). Assert no scenario file is reachable from the bun list.
    const inputs = realInputs();
    const scenarios = inputs.files.filter((f) =>
      f.startsWith("telegram-plugin/uat/scenarios/"),
    );
    expect(scenarios.length).toBeGreaterThan(50);
    const reachable = scenarios.filter((f) =>
      inputs.bunTargets.some((t) => f.slice("telegram-plugin/".length).includes(t)),
    );
    expect(reachable).toEqual([]);
  });
});
