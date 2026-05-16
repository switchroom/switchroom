/**
 * Executable regression for the two reactive version pins behind the
 * Drive integration (Drive reliability audit, 2026-05-16).
 *
 * The pure `buildUvxArgs` unit tests guard ARG ASSEMBLY (the entrypoint
 * name, the `--with`/`--refresh-package` ordering, the AIOFILE_PIN
 * floor). They CANNOT catch the actual bug class that bit us ~10 times:
 * the pinned combination failing to *resolve or start* against the
 * upstream SHA at runtime —
 *
 *   - bug-6: wrong uvx entrypoint name → "executable not provided"
 *   - bug-7: aiofile `KeyError: 'Author'` → MCP never starts
 *   - the freshly-released-fix / stale-uv-index case → "no version of
 *     aiofile==<pin>" → MCP never starts
 *
 * Each was a SILENT/DEFERRED failure invisible until an agent was asked
 * to use Drive. This test runs the EXACT pinned invocation
 * (`GOOGLE_WORKSPACE_MCP_PINNED_SHA` + `AIOFILE_PIN` imported from src,
 * not re-typed) inside the agent image (which bakes uv/uvx, #1361) and
 * asserts it reaches the upstream "Starting MCP server" marker with no
 * KeyError / Traceback / resolution failure. Any future pin bump that
 * re-breaks the chain fails CI here instead of in production.
 *
 * Skipped (not failed) when docker or the agent image is unavailable —
 * same contract as the other tests/docker/ suites. Network is required
 * (uvx git-clones the upstream + resolves PyPI); the `e2e` CI job has
 * it. Containers carry the mandatory `switchroom.test=phase1c` +
 * per-run labels and `--rm`; afterAll does a label-scoped sweep.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";

import {
  newRunId,
  dockerRunLabelsArgv,
  safeLabelTeardown,
} from "./_label-helpers.js";
import {
  AIOFILE_PIN,
  AIOFILE_PKG,
} from "../../src/cli/drive-mcp-launcher.js";
import { GOOGLE_WORKSPACE_MCP_PINNED_SHA } from "../../src/memory/scaffold-integration.js";

const RUN_ID = newRunId();
const LABELS_ARGV = dockerRunLabelsArgv(RUN_ID);

afterAll(() => {
  safeLabelTeardown(RUN_ID);
});

const TAG = "phase1b-test";
const AGENT_IMAGE = `switchroom/agent:${TAG}`;

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

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(AGENT_IMAGE);

describe.skipIf(!dockerOk || !imageOk)(
  "drive-mcp pinned uvx invocation actually starts (skipped without docker/agent image)",
  () => {
    it(
      "uvx @PINNED_SHA --refresh-package aiofile --with AIOFILE_PIN workspace-mcp --single-user reaches 'Starting MCP server'",
      () => {
        const fromArg = `git+https://github.com/taylorwilsdon/google_workspace_mcp.git@${GOOGLE_WORKSPACE_MCP_PINNED_SHA}`;
        // Reproduce exactly what buildUvxArgs() emits. `env -i` mirrors
        // Claude Code's sanitized MCP-spawn env (the conditions bug-8
        // surfaced under). stdin from /dev/null so the stdio server
        // sees EOF; `timeout` bounds the cold git-clone + resolve.
        const inner = [
          "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp",
          "timeout 280",
          "uvx",
          "--from",
          fromArg,
          "--refresh-package",
          AIOFILE_PKG,
          "--with",
          AIOFILE_PIN,
          "workspace-mcp",
          "--single-user",
          "--tool-tier",
          "extended",
          "</dev/null 2>&1 | head -60",
        ].join(" ");

        const r = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            ...LABELS_ARGV,
            "--entrypoint",
            "sh",
            AGENT_IMAGE,
            "-c",
            inner,
          ],
          { encoding: "utf8", timeout: 330_000 },
        );

        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

        // The bug classes this guards — each must NOT appear:
        expect(out).not.toMatch(/KeyError: ['"]Author['"]/);
        expect(out).not.toMatch(/Traceback \(most recent call last\)/);
        expect(out).not.toMatch(/No solution found when resolving/);
        expect(out).not.toMatch(/no version of aiofile/i);
        expect(out).not.toMatch(
          /is not provided by package|executable.*not provided/i,
        );
        // The positive proof the whole chain resolved + imported + booted:
        expect(out).toMatch(/Starting MCP server/);
      },
      // Generous: a cold uvx run git-clones upstream + resolves the
      // full dep tree before the server prints anything.
      330_000,
    );
  },
);
