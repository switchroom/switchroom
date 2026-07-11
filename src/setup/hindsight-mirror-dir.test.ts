/**
 * Unit tests for the #2578 hindsight startup path: when the hindsight
 * consumer declares `mirror_dir`, `startHindsight` must back the creds dir
 * with the shared `consumer-creds-hindsight` volume (pre-chowned to the
 * consumer UID) instead of a private tmpfs, and `generateHindsightCompose
 * Snippet` must emit the same volume + a chown init service. Without
 * `mirror_dir`, output is unchanged (tmpfs, pull-only).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  startHindsight,
  generateHindsightComposeSnippet,
  hindsightConsumerMirrorDir,
  HINDSIGHT_CREDS_MIRROR_VOLUME,
  HINDSIGHT_CRED_DIR,
  HINDSIGHT_DEFAULT_UID,
} from "./hindsight.js";

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
});
afterEach(() => {
  vi.clearAllMocks();
});

/** All `docker run` argv arrays captured, joined per-call for substring asserts. */
function dockerCalls(): string[][] {
  return execFileSyncMock.mock.calls
    .filter((c) => c[0] === "docker")
    .map((c) => c[1] as string[]);
}

describe("hindsightConsumerMirrorDir", () => {
  it("returns the hindsight consumer's mirror_dir when set", () => {
    const cfg = {
      auth: { consumers: [{ name: "hindsight", mirror_dir: "/run/consumer-creds/hindsight" }] },
    };
    expect(hindsightConsumerMirrorDir(cfg)).toBe("/run/consumer-creds/hindsight");
  });

  it("returns undefined when the consumer has no mirror_dir", () => {
    expect(hindsightConsumerMirrorDir({ auth: { consumers: [{ name: "hindsight" }] } })).toBeUndefined();
  });

  it("returns undefined when there is no hindsight consumer", () => {
    expect(hindsightConsumerMirrorDir({ auth: { consumers: [{ name: "other", mirror_dir: "/x" }] } })).toBeUndefined();
    expect(hindsightConsumerMirrorDir({})).toBeUndefined();
  });
});

describe("startHindsight — mirror mode (#2578)", () => {
  it("mirror OFF: creds dir is a private tmpfs, no shared volume, no chown init", () => {
    startHindsight();
    const calls = dockerCalls();
    // Exactly one docker call (the `run -d`); no pre-chown container.
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv).toContain("--tmpfs");
    expect(argv.join(" ")).toContain(`${HINDSIGHT_CRED_DIR}:rw,mode=0700`);
    expect(argv.join(" ")).not.toContain(HINDSIGHT_CREDS_MIRROR_VOLUME);
  });

  it("mirror ON: creds dir is the shared volume, tmpfs replaced, and a chown init runs first", () => {
    startHindsight(undefined, undefined, undefined, undefined, "/run/consumer-creds/hindsight");
    const calls = dockerCalls();
    // Two docker calls: the chown init THEN the `run -d`.
    expect(calls).toHaveLength(2);

    const [initArgv, runArgv] = calls;

    // 1. chown init: root user, mounts the shared volume, chowns to the UID.
    expect(initArgv).toContain("--user");
    expect(initArgv).toContain("0");
    expect(initArgv.join(" ")).toContain(`${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`);
    expect(initArgv.join(" ")).toContain(
      `chown ${HINDSIGHT_DEFAULT_UID}:${HINDSIGHT_DEFAULT_UID} ${HINDSIGHT_CRED_DIR}`,
    );

    // 2. run: shared volume mounted at the creds path; NO tmpfs.
    expect(runArgv).toContain("-v");
    expect(runArgv.join(" ")).toContain(`${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`);
    expect(runArgv).not.toContain("--tmpfs");

    // Ordering: init before run.
    const initIdx = execFileSyncMock.mock.calls.findIndex(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).some((a) => typeof a === "string" && a.includes("chown")),
    );
    const runIdx = execFileSyncMock.mock.calls.findIndex(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run" && (c[1] as string[])[1] === "-d",
    );
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(initIdx);
  });
});

describe("generateHindsightComposeSnippet — mirror mode (#2578)", () => {
  it("mirror OFF: tmpfs creds, no init service, no external creds volume", () => {
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toContain("tmpfs:");
    expect(snippet).toContain(`${HINDSIGHT_CRED_DIR}:rw,mode=0700`);
    expect(snippet).not.toContain(HINDSIGHT_CREDS_MIRROR_VOLUME);
    expect(snippet).not.toContain("switchroom-hindsight-creds-init");
  });

  it("mirror ON: shared volume creds, init service with completed-successfully dep, external volume declared", () => {
    const snippet = generateHindsightComposeSnippet(undefined, "/run/consumer-creds/hindsight");

    // Creds dir backed by the shared volume, tmpfs gone.
    expect(snippet).toContain(`- ${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`);
    expect(snippet).not.toContain("tmpfs:");

    // One-shot chown init service + dependency gate.
    expect(snippet).toContain("switchroom-hindsight-creds-init:");
    expect(snippet).toContain("condition: service_completed_successfully");
    expect(snippet).toContain(
      `chown ${HINDSIGHT_DEFAULT_UID}:${HINDSIGHT_DEFAULT_UID} ${HINDSIGHT_CRED_DIR}`,
    );

    // Volume declared external (owned by the broker's compose project).
    expect(snippet).toMatch(new RegExp(`${HINDSIGHT_CREDS_MIRROR_VOLUME}:\\n {4}external: true`));
  });

  it("both branches emit structurally valid YAML (parse + shape asserts)", async () => {
    const { parse } = await import("yaml");

    // Mirror OFF — tmpfs list present under the hindsight service.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const off = parse(generateHindsightComposeSnippet()) as Record<string, any>;
    const offSvc = off.services["switchroom-hindsight"];
    expect(offSvc).toBeDefined();
    expect(Array.isArray(offSvc.tmpfs)).toBe(true);
    expect(offSvc.tmpfs[0]).toContain(HINDSIGHT_CRED_DIR);
    expect(off.services["switchroom-hindsight-creds-init"]).toBeUndefined();
    expect(off.volumes[HINDSIGHT_CREDS_MIRROR_VOLUME]).toBeUndefined();

    // Mirror ON — no tmpfs key; shared volume mounted; init service + dep
    // + external volume all parse into the expected structure.
    const on = parse(
      generateHindsightComposeSnippet(undefined, "/run/consumer-creds/hindsight"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as Record<string, any>;
    const onSvc = on.services["switchroom-hindsight"];
    expect(onSvc.tmpfs).toBeUndefined();
    expect(onSvc.volumes).toContain(`${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`);
    expect(onSvc.depends_on["switchroom-hindsight-creds-init"]).toEqual({
      condition: "service_completed_successfully",
    });
    const init = on.services["switchroom-hindsight-creds-init"];
    expect(init).toBeDefined();
    expect(init.user).toBe("0");
    expect(init.volumes).toContain(`${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`);
    expect(on.volumes[HINDSIGHT_CREDS_MIRROR_VOLUME]).toMatchObject({ external: true });
  });
});
