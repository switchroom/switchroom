/**
 * `docker/Dockerfile.base` bakes /etc/claude-code/managed-settings.json, the
 * Linux endpoint-managed-settings path — highest precedence over user, repo,
 * and project settings. Two things ride on its CONTENT, and both are silent
 * failures if the line is ever edited without knowing why:
 *
 *  - `channelsEnabled: true` is what lets every agent load the telegram
 *    plugin channel without the dev flag (#2598).
 *  - `crossSessionInbound: "refuse"` opts every agent out of the
 *    cross-session messaging inbox Claude Code 2.1.224 added (#4589).
 *    Leaving it UNSET is not neutral: with no explicit value the resolver's
 *    bypassPermissions branch accepts a `selfSent` peer message outright —
 *    one sent by any process in the claude PID's ancestry — and
 *    CLAUDE_CODE_MESSAGING_SOCKET is exported into every child process
 *    claude spawns. Every switchroom agent runs bypassed, so dropping this
 *    key hands any Bash-tool descendant a way to enqueue a user-role turn
 *    with no approval. An explicit value short-circuits that branch.
 *
 * Assert the shipped artifact, not a restatement of it: parse the JSON the
 * Dockerfile actually writes.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOCKERFILE = resolve(import.meta.dirname, "../docker/Dockerfile.base");

/** The single-quoted printf payload baked into managed-settings.json. */
function readBakedManagedSettings(): Record<string, unknown> {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const match = dockerfile.match(
    /printf\s+'(\{.*?\})\\n'\s*>\s*\/etc\/claude-code\/managed-settings\.json/,
  );
  if (!match) {
    throw new Error(
      "Dockerfile.base no longer writes /etc/claude-code/managed-settings.json " +
        "via a single-quoted printf of a JSON object — update this test to " +
        "match the new shape, do not delete it.",
    );
  }
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

describe("Dockerfile.base managed settings", () => {
  it("writes parseable JSON (a malformed payload makes claude ignore the file)", () => {
    expect(() => readBakedManagedSettings()).not.toThrow();
  });

  it("keeps channelsEnabled on so agents load the telegram channel (#2598)", () => {
    expect(readBakedManagedSettings().channelsEnabled).toBe(true);
  });

  it("refuses cross-session inbound so a bypassed agent has no selfSent hole (#4589)", () => {
    expect(readBakedManagedSettings().crossSessionInbound).toBe("refuse");
  });
});
