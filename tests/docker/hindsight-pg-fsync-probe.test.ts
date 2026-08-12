/**
 * Effective-outcome guard for embedded-PostgreSQL durability.
 *
 * WHAT THIS PINS. `docker/hindsight-entrypoint.sh` pre-starts pg0 with
 * `-c fsync=on`, because pg0's own default is `-F` — PostgreSQL with fsync
 * DISABLED. Under `-F` an unclean stop can lose a write that `data_checksums`
 * still validates (the stale page checksums correctly; it is a lost write, not
 * a corrupt one), so the database comes back "healthy" with silent damage.
 * That is not hypothetical here: the live `switchroom-hindsight` container
 * logs 6–20 unclean shutdowns per day, and on 2026-07-29 one of them preceded
 * silent corruption of an HNSW index on `memory_units` by ~13 minutes, wedging
 * one bank's consolidation for ~2.5 hours behind ~38,000 queued memories. See
 * `HINDSIGHT_PG_DEFAULT_FSYNC` in `src/setup/hindsight-pg-defaults.ts`.
 *
 * WHY THE OTHER TESTS ARE NOT ENOUGH. Two cheaper layers already exist:
 * `src/setup/hindsight-pg-defaults.test.ts` pins the env switchroom emits, and
 * `tests/docker/hindsight-entrypoint.test.ts` drives the real entrypoint with a
 * FAKE pg0 and asserts `fsync=on` reaches its argv. Neither can see the thing
 * that actually decides the outcome, which is external to this repo: whether
 * PostgreSQL honours a trailing `-c fsync=on` over the `-F` pg0 emits earlier
 * in the same argv. It does — postgres applies command-line options in order,
 * and `-F` is positional and always precedes pg0's merged `-c` block — but that
 * is an upstream property of a pinned third-party binary, not of our code. If a
 * future pg0 appends its own `-c fsync=off`, reorders the argv, or switches to
 * writing `postgresql.conf`, every cheaper test in this repo stays green while
 * the database silently goes back to losing writes. Only reading `SHOW fsync`
 * out of a real server started by the real entrypoint catches that.
 *
 * HOW IT RUNS. The pinned upstream image, a throwaway container, the REAL
 * `docker/hindsight-entrypoint.sh` (copied in, not reimplemented), a fake
 * auth-broker UDS and a fake credential fetcher so the entrypoint's pre-flight
 * passes, and `true` as the CMD so it reaches the pre-start and exits. Then
 * `SHOW fsync` on the instance the entrypoint actually started.
 *
 * `--network none`, like the other probes in this directory: pg0 ships the
 * PostgreSQL distribution inside its own binary and unpacks it locally, so a
 * cold `pg0 start` needs no network (verified — 2s, offline).
 *
 * BOTH ARMS RUN. The GREEN arm is the default configuration and must report
 * `on`. The RED arm sets `SWITCHROOM_HINDSIGHT_PG_FSYNC=off` and must report
 * `off` — without it, a probe that read `fsync` from somewhere other than the
 * server we started, or that silently no-op'd, would pass forever.
 *
 * SKIP DISCIPLINE: identical to the sibling probes. Locally, with no docker or
 * no cached image, this skips (never pull a 6.4GB third-party image onto a dev
 * box). CI's `hindsight-probe` job pulls the pinned digest and sets
 * SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an unavailable
 * docker/image is a HARD FAILURE rather than a green skip.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { execFileAsync } from "./_exec-async.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRYPOINT = resolve(root, "docker/hindsight-entrypoint.sh");
const dockerfile = readFileSync(resolve(root, "docker/Dockerfile.hindsight"), "utf8");

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-pg-fsync-probe";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** Stands in for the auth-broker: the entrypoint only waits for the socket. */
const FAKE_BROKER = `const net = require("node:net");
net.createServer(() => {}).listen(process.argv[2]);
setTimeout(() => process.exit(0), 300000);
`;

/** Stands in for hindsight-fetch-creds.cjs: write the dotfile, exit 0. */
const FAKE_FETCHER = `require("node:fs").writeFileSync(
  process.env.CRED_FILE,
  JSON.stringify({ probe: true }) + "\\n",
);
`;

/**
 * Read `fsync` back out of the instance the entrypoint started, through pg0's
 * own psql so we resolve the port/credentials the same way hindsight_api does.
 * `pg_settings.source` comes with it: `command line` is the proof the value
 * arrived on the argv rather than from a conf file we did not write.
 */
const READBACK = `set -e
PG0=$(ls /app/api/.venv/lib/python3.*/site-packages/pg0/bin/pg0)
echo "ARGV=$(ps -eo args= | grep '[i]nstances/hindsight/data' | head -1)"
echo "FSYNC=$("$PG0" psql --name hindsight -tAc \\
  "SELECT setting || ':' || source FROM pg_settings WHERE name = 'fsync'" \\
  | tr -d '[:cntrl:]')"
`;

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

/**
 * CI marker. When set, this suite MUST really execute — an absent docker or an
 * absent upstream image becomes a hard failure instead of a green skip.
 * `.github/workflows/docker-e2e.yml` sets it after pulling the pinned digest.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { fsync: string; source: string; argv: string; log: string };

/**
 * Boot the real entrypoint in a throwaway container and read `fsync` back.
 *
 * `extraEnv` is layered over the configuration switchroom actually ships, so
 * the GREEN arm exercises the production values and the RED arm differs from
 * it by exactly one variable.
 */
async function probe(label: string, extraEnv: Record<string, string>): Promise<ProbeResult> {
  const name = `sr-hs-fsync-${label}-${RUN_ID.slice(0, 8)}`;
  const stage = mkdtempSync(join(tmpdir(), "sr-fsync-probe-"));
  try {
    writeFileSync(join(stage, "fake-broker.cjs"), FAKE_BROKER);
    writeFileSync(join(stage, "fake-fetch.cjs"), FAKE_FETCHER);

    await execFileAsync("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `switchroom.test=${TEST_PHASE}`,
        "--label",
        `switchroom.test.run=${RUN_ID}`,
        // NOT --user root: postgres refuses to run as uid 0, and the image's
        // own `hindsight` user is who runs it in production anyway.
        "--network",
        "none",
        // shared_buffers is mmap here, but parallel-query DSM segments are not
        // — the default 64MB /dev/shm is too small for pg0's own worker flags.
        "--shm-size=1g",
        "--entrypoint",
        "sleep",
        UPSTREAM_IMAGE,
        "300",
      ]);

    for (const f of ["fake-broker.cjs", "fake-fetch.cjs"]) {
      await execFileAsync("docker", ["cp", join(stage, f), `${name}:/tmp/${f}`]);
    }
    // The REAL entrypoint, byte for byte — never a reimplementation.
    await execFileAsync("docker", ["cp", ENTRYPOINT, `${name}:/tmp/entrypoint.sh`]);

    await execFileAsync("docker", ["exec", "-d", name, "node", "/tmp/fake-broker.cjs", "/tmp/fake.sock"]);

    const env: Record<string, string> = {
      SWITCHROOM_AUTH_BROKER_SOCKET: "/tmp/fake.sock",
      SWITCHROOM_HINDSIGHT_CRED_DIR: "/tmp/creds",
      SWITCHROOM_HINDSIGHT_WAIT_S: "30",
      // No refresh loop and no reaper: both hold the stdio pipes open, and
      // neither is what this probe is about.
      SWITCHROOM_HINDSIGHT_REFRESH_S: "0",
      SWITCHROOM_HINDSIGHT_REAP_STALE_S: "0",
      SWITCHROOM_HINDSIGHT_FETCHER: "/tmp/fake-fetch.cjs",
      // Production sizing, scaled down to what a CI runner can allocate. The
      // values are irrelevant to fsync; passing them keeps the argv shaped
      // like the real one so a pg0 flag-merge regression shows up here too.
      SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE: "1024MB",
      SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS: "256MB",
      ...extraEnv,
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    // The entrypoint logs to stderr; fold it into stdout so the pre-start line
    // is available for assertions and for the failure message.
    const log = (
      await execFileAsync("docker", [
        "exec",
        ...envArgs,
        name,
        "sh",
        "-c",
        "sh /tmp/entrypoint.sh true 2>&1",
      ])
    ).stdout;

    const out = (
      await execFileAsync("docker", ["exec", "-i", name, "sh", "-s"], {
        input: READBACK,
      })
    ).stdout;
    const [setting = "", source = ""] = (out.match(/^FSYNC=(.*)$/m)?.[1] ?? "").split(":");
    return {
      fsync: setting,
      source,
      argv: out.match(/^ARGV=(.*)$/m)?.[1] ?? "",
      log,
    };
  } finally {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      /* already gone */
    }
    rmSync(stage, { recursive: true, force: true });
  }
}

describe("the hindsight fsync probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the fsync probe is " +
          "advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`,
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable",
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite",
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "embedded PostgreSQL comes up with fsync ON",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(`docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`, {
          encoding: "utf8",
        })
          .split("\n")
          .filter(Boolean);
        if (ids.length) {
          execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
        }
      } catch {
        /* nothing to clean */
      }
    });

    it("the shipping configuration yields fsync=on, sourced from the command line", async () => {
      const r = await probe("green", {});
      // THE assertion. Everything else in this file exists to make this one
      // mean something.
      expect(r.fsync, `pre-start log:\n${r.log}\nargv: ${r.argv}`).toBe("on");
      // `command line` proves it came from the argv the entrypoint composed.
      // A `default`/`configuration file` source reading `on` would mean pg0
      // changed mechanism underneath us and our flag is no longer what is
      // holding the property.
      expect(r.source).toBe("command line");
      // pg0 still emits its `-F`; we are overriding it, not removing it. If
      // this stops being true the ordering argument in the entrypoint header
      // needs re-verifying rather than silently inheriting a pass.
      expect(r.argv).toContain(" -F ");
      expect(r.argv).toContain("-c fsync=on");
      expect(r.log).toMatch(/pg0 pre-start ok: .*fsync=on/);
    }, 180_000);

    it("the RED arm really reads off, so the GREEN arm is not a tautology", async () => {
      const r = await probe("red", { SWITCHROOM_HINDSIGHT_PG_FSYNC: "off" });
      expect(r.fsync, `pre-start log:\n${r.log}\nargv: ${r.argv}`).toBe("off");
      // With the flag omitted, pg0's `-F` is unopposed and postgres reports
      // the value as a command-line one too — which is exactly why a source
      // check alone could not substitute for reading the setting.
      expect(r.argv).not.toContain("-c fsync=");
    }, 180_000);
  },
);
