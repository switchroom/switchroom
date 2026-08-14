/**
 * Regression guard: the `/etc/localtime` bind mount must not clobber
 * `/usr/share/zoneinfo/Etc/UTC`.
 *
 * THE BUG (live-verified on a v0.21 fleet, agent zone Australia/Melbourne):
 *
 *   `src/agents/compose.ts` emits
 *       - /usr/share/zoneinfo/<zone>:/etc/localtime:ro
 *   Docker resolves a bind mount's DESTINATION through symlinks inside
 *   the container rootfs BEFORE mounting. Stock Debian tzdata ships
 *       /etc/localtime -> /usr/share/zoneinfo/Etc/UTC
 *   so the daemon mounted the agent's local zonefile onto
 *   /usr/share/zoneinfo/Etc/UTC. Evidence from the running container:
 *
 *       $ findmnt /usr/share/zoneinfo/Etc/UTC
 *       TARGET                       SOURCE
 *       /usr/share/zoneinfo/Etc/UTC  ...[/usr/share/zoneinfo/Australia/Melbourne]
 *
 *       $ python3 -c 'from datetime import datetime
 *                     from zoneinfo import ZoneInfo
 *                     print(datetime.now(ZoneInfo("UTC")))'
 *       2026-08-13 07:23:28+10:00        # should be +00:00
 *
 *   /etc/localtime read the right local time by accident, while every
 *   by-NAME UTC lookup in the tzdata db returned LOCAL time: ten hours
 *   wrong, silently, with no error surfaced anywhere. Node is immune
 *   (bundled full-ICU), which is why the gateway/scheduler looked fine
 *   and nothing ever tripped.
 *
 * WHY THE OLD TEST DIDN'T CATCH IT: `compose-generator-localtime.test.ts`
 * asserts the generated compose STRING and never mounts anything. The
 * string was always correct — the defect lives entirely in Docker's
 * destination-path resolution, which only a real mount can observe.
 *
 * WHAT THIS FILE PROVES
 *
 *   1. (always, no docker) `docker/Dockerfile.agent` still contains the
 *      de-symlink step, before `USER`. Guards deletion of the fix.
 *   2. (docker required) The MECHANISM, end to end, against the real
 *      docker daemon: mounting onto a symlinked `/etc/localtime`
 *      corrupts the link target, and mounting onto a regular-file
 *      `/etc/localtime` does not — while still delivering the mounted
 *      content at `/etc/localtime`. This test FAILS if run against the
 *      pre-fix image shape, which is the bar the old test missed.
 *   3. (docker + built agent image) The real `switchroom/agent` image
 *      has a regular-file `/etc/localtime` and survives a live mount
 *      with `Etc/UTC` intact.
 *
 * WHAT IT DOES NOT PROVE: (2) uses a busybox stand-in with a synthetic
 * zoneinfo tree, not the agent image, so it pins Docker's behaviour and
 * the shape of the fix rather than the agent build itself. (3) closes
 * that gap but only runs where the agent image has already been built —
 * on a runner without it, (1)+(2) are the guard.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newRunId, dockerRunLabelsArgv, safeLabelTeardown } from "./_label-helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN_ID = newRunId();
const LABELS_ARGV = dockerRunLabelsArgv(RUN_ID);

/** Tiny, ubiquitous base — same idiom as the other docker e2e tests. */
const BASE = "busybox:latest";
/** Built by tests/docker/build-images.sh; absent on a plain runner. */
const AGENT_IMAGE = "switchroom/agent:phase1b-test";

const SYMLINK_IMAGE = `switchroom-tz-symlink:${RUN_ID}`;
const REGULAR_IMAGE = `switchroom-tz-regular:${RUN_ID}`;

/** Sentinel bytes so a clobber is unambiguous in the assertion. */
const PRISTINE_UTC = "PRISTINE-ETC-UTC";
const LOCAL_ZONE = "LOCAL-ZONE-BYTES";

/**
 * Timeout for every test below that shells out to `docker build` / `docker
 * run`. These drive a real daemon, so vitest's 5000ms default does not apply.
 *
 * Not a blanket hedge against slowness: 5000ms is measurably ON the line for
 * the FIRST e2e test in this file, which pays the runner's one-off BuildKit
 * builder warm-up that every later build skips. Two observed CI failures, both
 * this file's first e2e test, both a hair over the default, and both followed
 * by a sibling doing identical work in a quarter of the time:
 *
 *   run 31659633813 (main @ 4ae73296)         6063ms → FAIL, sibling 1300ms
 *   run 31675696938 (ci/vacuous-test-guard)   5825ms → FAIL, sibling 1352ms
 *
 * BASE is already pulled at collection time (see DOCKER above), so the pull is
 * not the variable — the warm-up is. 30s matches the idiom the other docker
 * suites here use (hindsight-entrypoint.test.ts:162).
 */
const DOCKER_TEST_TIMEOUT_MS = 30_000;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pullImage(ref: string): boolean {
  try {
    execSync(`docker pull ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// busybox is ~5MB, so pull it rather than skipping when it is absent —
// same idiom as docker-exec-argv-e2e.test.ts. Without the pull this whole
// layer reported green-by-skip on CI: nothing in `.github/` or
// tests/docker/build-images.sh preloads busybox, and the `docker save`
// cache only covers `switchroom/*`. docker-e2e.yml also shards across
// three runners and DOCKER is evaluated at module-collection time, so a
// sibling test having pulled busybox is not something this file can rely on.
const DOCKER = hasDocker() && (hasImage(BASE) || pullImage(BASE));

/** Build a throwaway image from an inline Dockerfile. */
function buildImage(tag: string, dockerfile: string): void {
  const r = spawnSync(
    "docker",
    ["build", "-q", "-t", tag, "--label", "switchroom.test=phase1c",
     "--label", `switchroom.test.run=${RUN_ID}`, "-f", "-", "."],
    { input: dockerfile, encoding: "utf8", cwd: tmpdir() },
  );
  if (r.status !== 0) {
    throw new Error(`docker build ${tag} failed: ${r.stderr}`);
  }
}

function removeImage(tag: string): void {
  spawnSync("docker", ["image", "rm", "-f", tag], { stdio: "ignore" });
}

afterAll(() => {
  safeLabelTeardown(RUN_ID);
  if (DOCKER) {
    removeImage(SYMLINK_IMAGE);
    removeImage(REGULAR_IMAGE);
  }
});

// ---------------------------------------------------------------------------
// 1. Static: the fix is still in Dockerfile.agent, and still before USER.
// ---------------------------------------------------------------------------

describe("Dockerfile.agent — /etc/localtime is a regular file", () => {
  const dockerfile = readFileSync(resolve(root, "docker/Dockerfile.agent"), "utf8");

  it("de-symlinks /etc/localtime at build time", () => {
    // The mount destination must be a real path, not a link into
    // /usr/share/zoneinfo. Without this RUN the compose mount silently
    // overwrites the link's target zonefile instead.
    expect(dockerfile).toMatch(/readlink -f \/etc\/localtime/);
    expect(dockerfile).toMatch(/cp "\$src" \/etc\/localtime\.desymlink\.tmp/);
    expect(dockerfile).toMatch(/mv -f \/etc\/localtime\.desymlink\.tmp \/etc\/localtime/);
  });

  it("never deletes /etc/localtime before the copy reads it", () => {
    // If a future base image ships /etc/localtime as a regular file,
    // `readlink -f` resolves it to itself — an `rm` before the `cp` would
    // then delete the copy's own source and fail the build. The step must
    // write a temp file and rename it into place instead.
    expect(dockerfile).not.toMatch(/rm -f \/etc\/localtime;/);
  });

  it("asserts the invariant at build time so a base-image change fails the build", () => {
    expect(dockerfile).toMatch(/if \[ -L \/etc\/localtime \]/);
  });

  it("runs the de-symlink as root, i.e. before USER", () => {
    const runIdx = dockerfile.search(/^\s*mv -f \/etc\/localtime\.desymlink\.tmp/m);
    const userIdx = dockerfile.search(/^USER /m);
    expect(runIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeLessThan(userIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end mechanism against the real docker daemon.
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER)(
  "docker bind-mount onto /etc/localtime — symlink vs regular file",
  () => {
    let tmp: string;
    let zoneFile: string;

    function setup(): void {
      tmp = mkdtempSync(join(tmpdir(), "sr-tz-mount-"));
      zoneFile = join(tmp, "localzone");
      writeFileSync(zoneFile, LOCAL_ZONE);
    }

    function teardown(): void {
      rmSync(tmp, { recursive: true, force: true });
    }

    /**
     * Mount `zoneFile` onto /etc/localtime in `image` and read back both
     * the mount destination and the synthetic Etc/UTC zonefile.
     */
    function probe(image: string): { localtime: string; etcUtc: string } {
      const r = spawnSync(
        "docker",
        [
          "run", "--rm", ...LABELS_ARGV,
          "-v", `${zoneFile}:/etc/localtime:ro`,
          image,
          "sh", "-c", "cat /etc/localtime; echo; cat /zoneinfo/Etc/UTC",
        ],
        { encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
      const [localtime, etcUtc] = r.stdout.split("\n");
      return { localtime: localtime.trim(), etcUtc: (etcUtc ?? "").trim() };
    }

    it("mounting onto a SYMLINKED /etc/localtime corrupts the link target (the bug)", () => {
      setup();
      try {
        // Reproduces the stock-tzdata shape the agent image had.
        buildImage(
          SYMLINK_IMAGE,
          `FROM ${BASE}\n` +
            `RUN mkdir -p /zoneinfo/Etc && printf '${PRISTINE_UTC}' > /zoneinfo/Etc/UTC ` +
            `&& ln -sf /zoneinfo/Etc/UTC /etc/localtime\n`,
        );
        const { localtime, etcUtc } = probe(SYMLINK_IMAGE);
        // Local time looks right...
        expect(localtime).toBe(LOCAL_ZONE);
        // ...but UTC is now local time. This is the silent multi-hour error.
        expect(etcUtc).toBe(LOCAL_ZONE);
        expect(etcUtc).not.toBe(PRISTINE_UTC);
      } finally {
        teardown();
      }
    }, DOCKER_TEST_TIMEOUT_MS);

    it("mounting onto a REGULAR-FILE /etc/localtime leaves Etc/UTC pristine (the fix)", () => {
      setup();
      try {
        // The shape docker/Dockerfile.agent now produces.
        buildImage(
          REGULAR_IMAGE,
          `FROM ${BASE}\n` +
            `RUN mkdir -p /zoneinfo/Etc && printf '${PRISTINE_UTC}' > /zoneinfo/Etc/UTC ` +
            `&& rm -f /etc/localtime && cp /zoneinfo/Etc/UTC /etc/localtime\n`,
        );
        const { localtime, etcUtc } = probe(REGULAR_IMAGE);
        // Original intent preserved: local zone still delivered.
        expect(localtime).toBe(LOCAL_ZONE);
        // Collateral damage gone: UTC is still UTC.
        expect(etcUtc).toBe(PRISTINE_UTC);
      } finally {
        teardown();
      }
    }, DOCKER_TEST_TIMEOUT_MS);
  },
);

// ---------------------------------------------------------------------------
// 3. The real agent image, when it has been built on this runner.
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER || !hasImage(AGENT_IMAGE))(
  "switchroom/agent image — real tzdata survives the localtime mount",
  () => {
    it("ships /etc/localtime as a regular file", () => {
      const r = spawnSync(
        "docker",
        ["run", "--rm", ...LABELS_ARGV, "--entrypoint", "sh", AGENT_IMAGE,
         "-c", "test ! -L /etc/localtime && test -f /etc/localtime"],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(0);
    }, DOCKER_TEST_TIMEOUT_MS);

    it("keeps Etc/UTC at a zero offset with a non-UTC zone mounted on /etc/localtime", (ctx) => {
      // Skip on an exotic runner with no tzdata for the probe zone.
      // ctx.skip(), not a bare `return` — a return marks the test PASSED,
      // which reports a missing zone as a green assertion that never ran.
      const hostZone = "/usr/share/zoneinfo/Australia/Melbourne";
      try {
        readFileSync(hostZone);
      } catch {
        ctx.skip(`host has no ${hostZone}`);
        return;
      }
      const r = spawnSync(
        "docker",
        [
          "run", "--rm", ...LABELS_ARGV,
          "-v", `${hostZone}:/etc/localtime:ro`,
          "--entrypoint", "python3", AGENT_IMAGE,
          "-c",
          "from datetime import datetime;" +
            "from zoneinfo import ZoneInfo;" +
            'print(int(datetime.now(ZoneInfo("Etc/UTC")).utcoffset().total_seconds()),' +
            'int(datetime.now(ZoneInfo("UTC")).utcoffset().total_seconds()))',
        ],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(0);
      // Pre-fix this printed "36000 36000" (Melbourne) instead of "0 0".
      expect(r.stdout.trim()).toBe("0 0");
    }, DOCKER_TEST_TIMEOUT_MS);
  },
);
