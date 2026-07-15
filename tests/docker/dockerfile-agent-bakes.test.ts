/**
 * Pin the agent-image bake list. The in-container telegram-plugin gateway
 * sidecar shells out to the switchroom CLI for /auth, /vault, /agent
 * (post-fallback restart) and friends — see
 * `telegram-plugin/gateway/gateway.ts:switchroomExec`. Under v0.6 systemd
 * the host CLI was on PATH; under v0.7+ docker the agent container is
 * its own filesystem, so the CLI bundle has to be baked into the image
 * and symlinked onto PATH. Without it, every gateway shell-out hits
 * ENOENT and Telegram-driven auth/vault flows fail silently.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(resolve(root, "docker/Dockerfile.agent"), "utf8");

describe("Dockerfile.agent bakes", () => {
  it("bakes the switchroom CLI bundle", () => {
    expect(dockerfile).toMatch(
      /COPY\s+dist\/cli\/switchroom\.js\s+\/opt\/switchroom\/switchroom\.js/,
    );
  });

  it("symlinks the CLI onto PATH at /usr/local/bin/switchroom", () => {
    expect(dockerfile).toMatch(
      /ln\s+-s\s+\/opt\/switchroom\/switchroom\.js\s+\/usr\/local\/bin\/switchroom/,
    );
  });

  it("bakes the autoaccept-poll bundle", () => {
    expect(dockerfile).toMatch(
      /COPY\s+dist\/cli\/autoaccept-poll\.js\s+\/opt\/switchroom\/autoaccept-poll\.js/,
    );
  });

  it("bakes the telegram-plugin dist tree", () => {
    expect(dockerfile).toMatch(
      /COPY\s+telegram-plugin\/dist\s+\/opt\/switchroom\/telegram-plugin\/dist/,
    );
  });

  it("bakes the agent-scheduler bundle", () => {
    expect(dockerfile).toMatch(
      /COPY\s+dist\/agent-scheduler\/index\.js\s+\/opt\/switchroom\/agent-scheduler\/index\.js/,
    );
  });

  // #2805: fleet-wide webkite render config baked at a non-HOME image path
  // (start.sh.hbs seeds it to ~/.config/webkite/config.toml at boot). Without
  // the COPY the image ships no render config and JS-heavy SPA pages return
  // only the static shell.
  it("bakes the fleet webkite render config", () => {
    expect(dockerfile).toMatch(
      /COPY\s+docker\/webkite\/config\.toml\s+\/opt\/switchroom\/webkite\/config\.toml/,
    );
  });
});

describe("Dockerfile.agent ships every hook script the scaffold invokes", () => {
  // Cross-reference the Dockerfile against scaffold.ts's ACTUAL hook-script
  // references (via DOCKER_BIN_PATH). #2273 added bin/turn-pacing-hook.sh +
  // wired it into the agent's UserPromptSubmit hooks but never added the COPY
  // line, so the script was absent from the image and the hook exec-failed
  // 127 every turn, fleet-wide. This guard ties the image to what the runtime
  // needs: any referenced hook script that isn't shipped fails the build gate.
  const scaffold = readFileSync(resolve(root, "src/agents/scaffold.ts"), "utf8");
  const referenced = [
    ...new Set(
      [...scaffold.matchAll(/join\(DOCKER_BIN_PATH,\s*"([^"]+\.sh)"\)/g)].map((m) => m[1]),
    ),
  ];
  const copiesViaGlob = /COPY\s+bin\/\*\.sh\s+\/opt\/switchroom\/bin\//.test(dockerfile);

  it("sanity: scaffold references the known hook scripts incl. turn-pacing-hook.sh", () => {
    expect(referenced).toContain("turn-pacing-hook.sh");
    expect(referenced).toContain("workspace-dynamic-hook.sh");
    expect(referenced.length).toBeGreaterThanOrEqual(5);
  });

  for (const script of referenced) {
    it(`ships ${script} into the agent image (glob or explicit COPY)`, () => {
      const copiesExplicit = new RegExp(
        `COPY\\s+bin/${script.replace(/\./g, "\\.")}\\s`,
      ).test(dockerfile);
      expect(
        copiesViaGlob || copiesExplicit,
        `Dockerfile.agent must COPY bin/${script} (the scaffold runs it via DOCKER_BIN_PATH) — ` +
        `add it to the bake list, or use the bin/*.sh glob`,
      ).toBe(true);
    });
  }
});

/**
 * Playwright is delivered through TWO bindings — the JS binding for the
 * `@playwright/mcp` default MCP, and the Python binding for the bundled
 * `webapp-testing` skill (`from playwright.sync_api import ...`). Both
 * share the browser binaries under $PLAYWRIGHT_BROWSERS_PATH, which is
 * only safe when the two bindings are the SAME version: Playwright pins
 * an exact browser revision per version, so a JS/Python skew surfaces
 * as "browser not found" at runtime. These tests pin the single-source-
 * of-truth invariant so a future bump can't silently desync the pair.
 */
describe("Dockerfile.agent Playwright provisioning", () => {
  it("declares a single PLAYWRIGHT_VERSION build arg with a pinned value", () => {
    const args = dockerfile.match(/ARG\s+PLAYWRIGHT_VERSION=/g) ?? [];
    expect(args).toHaveLength(1);
    // Exact pin (X.Y.Z) — no caret/tilde range, so the browser revision
    // is deterministic across image rebuilds.
    expect(dockerfile).toMatch(/ARG\s+PLAYWRIGHT_VERSION=\d+\.\d+\.\d+\s*$/m);
  });

  it("pins PLAYWRIGHT_VERSION to the current baked version (1.61.0, chromium 1228)", () => {
    // Lock the exact bumped value so a stray/partial revert is caught. Bump
    // this string in lockstep with the ARG (and re-verify JS==Python share
    // one chromium revision) on the next Playwright upgrade. NB the pin must
    // exist on BOTH npm and PyPI — npm can lead PyPI by a patch (npm had
    // 1.61.1 while PyPI topped out at 1.61.0), and the Python `pip install`
    // fails if the version isn't on PyPI.
    expect(dockerfile).toMatch(/ARG\s+PLAYWRIGHT_VERSION=1\.61\.0\s*$/m);
  });

  it("installs the JS binding at the pinned version", () => {
    expect(dockerfile).toMatch(
      /npm\s+install\s+-g\s+playwright@\$\{PLAYWRIGHT_VERSION\}/,
    );
  });

  it("installs the Python binding at the SAME pinned version", () => {
    expect(dockerfile).toMatch(
      /pip3?\s+install\s+[^\n]*playwright==\$\{PLAYWRIGHT_VERSION\}/,
    );
  });

  it("installs chromium + system deps for the JS binding", () => {
    expect(dockerfile).toMatch(/playwright\s+install\s+--with-deps\s+chromium/);
  });

  it("ensures the Python binding's chromium is resolved", () => {
    expect(dockerfile).toMatch(
      /python3\s+-m\s+playwright\s+install\s+chromium/,
    );
  });

  it("does not pin the JS binding to a floating npm range", () => {
    // `playwright@^…` / `playwright@~…` would let the JS binding drift
    // away from the exact-pinned Python binding on the next rebuild.
    expect(dockerfile).not.toMatch(/playwright@[\^~]/);
  });
});

/**
 * Cloakbrowser — the local stealth Chromium driver used by webkite's
 * `webkite mcp` stdio MCP. The webkite binary itself is operator-
 * mounted (private beta); cloakbrowser's Python tool is baked here
 * because (a) it's public OSS and (b) baking-in avoids a fragile
 * per-agent pipx install in the boot path.
 *
 * The 700MB Chromium binary cloakbrowser spawns is NOT baked — it's
 * shared across the fleet via a host bind mount of `~/.cloakbrowser/`
 * (see src/agents/compose.ts).
 */
describe("Dockerfile.agent webkite/cloakbrowser provisioning", () => {
  it("apt-installs pipx (the package manager cloakbrowser ships through)", () => {
    expect(dockerfile).toMatch(
      /apt-get\s+install[^\n]*\bpipx\b/,
    );
  });

  it("pipx-installs cloakbrowser at a stable image-path PIPX_HOME", () => {
    // PIPX_HOME must be a deterministic image path (not user $HOME, which
    // the per-agent compose mount would shadow at runtime).
    expect(dockerfile).toMatch(
      /PIPX_HOME=\$\{CLOAKBROWSER_PIPX_HOME\}\s+PIPX_BIN_DIR=\/usr\/local\/bin\s+\\?\s*\n?\s*pipx\s+install\s+cloakbrowser/,
    );
  });

  it("CLOAKBROWSER_PIPX_HOME is an absolute /opt path (not under HOME)", () => {
    expect(dockerfile).toMatch(/ENV\s+CLOAKBROWSER_PIPX_HOME=\/opt\//);
  });
});
