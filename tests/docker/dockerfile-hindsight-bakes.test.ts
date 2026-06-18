/**
 * Pin the docker/Dockerfile.hindsight bake list. PR #1266 introduced
 * this Dockerfile but four shape-bugs slipped through because no
 * structural test pinned them; each surfaced only on a real build +
 * runtime under the pinned UID 11000:
 *
 *   1. `pip install` against /app/api/.venv/bin/pip — but upstream
 *      :latest's venv is uv-managed and ships no `pip` binary, so the
 *      command exits 127 at build time.
 *   2. `COPY --chmod=0644` propagated the mode to the implicitly-
 *      created parent dir /usr/local/lib/switchroom, leaving it
 *      non-traversable from non-root → entrypoint Node fetcher fails
 *      with `Cannot find module …` at boot under USER hindsight.
 *   3. (Out of scope here, see CI matrix test.) The image was never
 *      added to .github/workflows/docker-images.yml so no CI build
 *      ever caught (1) or (2).
 *
 * These are grep-on-file structural tests — fast, no docker required,
 * sufficient to catch a regression that puts back the broken shape.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8",
);

describe("Dockerfile.hindsight shape", () => {
  it("extends the canonical upstream image", () => {
    expect(dockerfile).toMatch(
      /^FROM\s+ghcr\.io\/vectorize-io\/hindsight:latest\b/m,
    );
  });

  it("installs claude-agent-sdk via `uv pip install` (NOT bare .venv/bin/pip)", () => {
    // Upstream :latest builds the venv with `uv sync`, which leaves
    // no `pip` binary in .venv/bin/. Calling .venv/bin/pip directly
    // → exit 127 at build time. The canonical uv-into-existing-venv
    // pattern is `VIRTUAL_ENV=<path> uv pip install …`.
    expect(dockerfile).toMatch(
      /VIRTUAL_ENV=\/app\/api\/\.venv\s+uv\s+pip\s+install[^\n]+claude-agent-sdk/,
    );
    // And must NOT use the broken form even as a fallback / OR-chain.
    expect(dockerfile).not.toMatch(
      /\/app\/api\/\.venv\/bin\/pip\s+install/,
    );
  });

  it("verifies the SDK import works at build time (fail-loud guard)", () => {
    expect(dockerfile).toMatch(
      /from\s+claude_agent_sdk\s+import\s+query/,
    );
  });

  it("installs the @anthropic-ai/claude-code CLI globally", () => {
    // Allow the install to be quoted + version-pinned, e.g.
    // `npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"`.
    expect(dockerfile).toMatch(
      /npm\s+install\s+-g\s+"?@anthropic-ai\/claude-code/,
    );
  });

  it("pins the runtime UID to 11000 to match HINDSIGHT_DEFAULT_UID", () => {
    // The auth-broker chowns the per-consumer socket to UID 11000 at
    // mode 0600; if the runtime UID differed, the entrypoint would
    // EACCES on the socket connect. The Dockerfile rewrites the
    // upstream `hindsight` user to UID 11000 at build time.
    expect(dockerfile).toMatch(/NEW_UID=11000\b/);
    expect(dockerfile).toMatch(/usermod\s+-u\s+"\$NEW_UID"\s+hindsight/);
  });

  it("restores 0755 on /usr/local/lib/switchroom after the COPY", () => {
    // `COPY --chmod=0644 docker/foo.cjs /usr/local/lib/switchroom/foo.cjs`
    // creates the parent dir implicitly AND propagates the file mode
    // (0644) onto the dir. A dir without `x` is not traversable; the
    // entrypoint shim then fails to find the .cjs file under USER 11000
    // with `Cannot find module '/usr/local/lib/switchroom/...'` and
    // crash-loops the container.
    //
    // Pin the explicit chmod that follows the COPY.
    expect(dockerfile).toMatch(
      /chmod\s+0755\s+\/usr\/local\/lib\/switchroom\b/,
    );
  });

  it("bakes the credential-fetcher .cjs at the canonical path", () => {
    expect(dockerfile).toMatch(
      /COPY\s+--chmod=\d+\s+docker\/hindsight-fetch-creds\.cjs\s+\/usr\/local\/lib\/switchroom\/hindsight-fetch-creds\.cjs/,
    );
  });

  it("bakes the entrypoint shim at the canonical path with executable mode", () => {
    expect(dockerfile).toMatch(
      /COPY\s+--chmod=0755\s+docker\/hindsight-entrypoint\.sh\s+\/usr\/local\/bin\/switchroom-hindsight-entrypoint\.sh/,
    );
  });

  it("bakes the maintenance sidecar (backup/autovacuum/retention) as executable", () => {
    expect(dockerfile).toMatch(
      /COPY\s+--chmod=0755\s+docker\/hindsight-maintenance\.sh\s+\/usr\/local\/lib\/switchroom\/hindsight-maintenance\.sh/,
    );
  });

  it("ends as USER hindsight (so the entrypoint runs as UID 11000)", () => {
    expect(dockerfile).toMatch(/^USER\s+hindsight\b/m);
  });

  it("declares ENTRYPOINT pointing at the switchroom shim, not upstream's CMD", () => {
    expect(dockerfile).toMatch(
      /^ENTRYPOINT\s+\["\/usr\/local\/bin\/switchroom-hindsight-entrypoint\.sh"\]/m,
    );
  });

  it("preserves upstream's start-all.sh as the post-shim CMD", () => {
    // The shim does broker auth, then `exec "$@"` which is whatever
    // CMD docker passes — must be upstream's start-all.sh so the
    // image continues to behave like upstream once boot creds are in
    // place.
    expect(dockerfile).toMatch(/^CMD\s+\["\/app\/start-all\.sh"\]/m);
  });
});
