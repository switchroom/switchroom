/**
 * Tests for the I2 lint guard (`scripts/check-litellm-config-guard.mjs`).
 * Runs the real script over temp fixture files via LITELLM_CONFIG_PATH and
 * asserts exit code + output for the four design cases: good / global-flag /
 * openrouter-flag / absent-file (skip-notice asserted).
 *
 * Plus the discovery cases: when the LIVE config path cannot be resolved (the
 * Coolify services dir is absent, owns no litellm-config.yaml, or owns several)
 * the guard must SKIP *visibly* and still exit 0 — a silent pass would be
 * indistinguishable from a live config that was checked and approved.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  BARE_ANTHROPIC_FAMILY_ALIASES,
  discoverLiveLitellmConfigPath,
} from "../src/litellm/header-passthrough-guard.js";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(REPO, "scripts/check-litellm-config-guard.mjs");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function runWith(configPath: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("node", [SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, LITELLM_CONFIG_PATH: configPath },
  });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Run the guard with NO explicit `LITELLM_CONFIG_PATH`, pointing discovery at a
 * temp stand-in for the Coolify services dir (the .mjs script's substitute for
 * the TS core's injectable `servicesDir` option).
 */
function runWithDiscovery(servicesDir: string): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env, SWITCHROOM_COOLIFY_SERVICES_DIR: servicesDir };
  delete env.LITELLM_CONFIG_PATH;
  const r = spawnSync("node", [SCRIPT], { cwd: REPO, encoding: "utf8", env });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A temp services dir containing one sub-dir per named service; each listed in
 *  `withConfig` gets a (valid, non-violating) `litellm-config.yaml`. */
function servicesDir(services: string[], withConfig: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "litellm-services-"));
  dirs.push(root);
  for (const s of services) {
    mkdirSync(join(root, s), { recursive: true });
    if (withConfig.includes(s)) {
      writeFileSync(
        join(root, s, "litellm-config.yaml"),
        "model_group_settings:\n  sonnet:\n    forward_client_headers_to_llm_api: true\n",
      );
    }
  }
  return root;
}

function fixture(yaml: string): string {
  const d = mkdtempSync(join(tmpdir(), "litellm-guard-"));
  dirs.push(d);
  const p = join(d, "litellm-config.yaml");
  writeFileSync(p, yaml);
  return p;
}

describe("check-litellm-config-guard.mjs", () => {
  it("absent file → exit 0 with a visible SKIP notice", () => {
    const r = runWith("/definitely/not/here/litellm-config.yaml");
    expect(r.ok).toBe(true);
    expect(r.stdout).toMatch(/SKIP.*absent/);
  });

  it("good config → exit 0, OK", () => {
    const r = runWith(
      fixture(`
model_group_settings:
  claude-opus-4:
    forward_client_headers_to_llm_api: true
  sonnet:
    forward_client_headers_to_llm_api: true
`),
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toMatch(/OK/);
  });

  it("global flag → exit 1, FAIL", () => {
    const r = runWith(
      fixture(`
litellm_settings:
  forward_client_headers_to_llm_api: true
`),
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/FAIL/);
    expect(r.stderr).toMatch(/litellm_settings/);
  });

  it("openrouter-group flag → exit 1, FAIL naming the group", () => {
    const r = runWith(
      fixture(`
model_group_settings:
  claude-sonnet-5-openrouter:
    forward_client_headers_to_llm_api: true
`),
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/claude-sonnet-5-openrouter/);
  });

  // The unresolved-live-path branch: discovery yields nothing usable. Each case
  // must exit 0 (the repo copy still passed) AND print a live SKIP naming why.
  describe("unresolvable live config path → visible SKIP, never a silent pass", () => {
    it("services dir absent (hermetic CI/dev) → SKIP (live) naming the missing dir", () => {
      const missing = join(tmpdir(), "litellm-services-does-not-exist-6dd41f");
      const r = runWithDiscovery(missing);
      expect(r.ok).toBe(true);
      expect(r.stdout).toMatch(/SKIP \(live\)/);
      expect(r.stdout).toContain(missing);
      expect(r.stdout).toMatch(/no Coolify services dir/);
      // The repo-managed copy is still checked — the skip is live-only.
      expect(r.stdout).toMatch(/OK — header passthrough correctly scoped/);
    });

    it("no service owns a litellm-config.yaml → SKIP (live), not a pass", () => {
      const root = servicesDir(["svc-a", "svc-b"], []);
      const r = runWithDiscovery(root);
      expect(r.ok).toBe(true);
      expect(r.stdout).toMatch(/SKIP \(live\)/);
      expect(r.stdout).toMatch(/owns a litellm-config\.yaml/);
    });

    it("several candidates → SKIP (live) listing them, refusing to guess", () => {
      const root = servicesDir(["svc-a", "svc-b"], ["svc-a", "svc-b"]);
      const r = runWithDiscovery(root);
      expect(r.ok).toBe(true);
      expect(r.stdout).toMatch(/SKIP \(live\)/);
      expect(r.stdout).toMatch(/2 candidate live configs/);
      expect(r.stdout).toContain(join(root, "svc-a", "litellm-config.yaml"));
      expect(r.stdout).toContain(join(root, "svc-b", "litellm-config.yaml"));
      expect(r.stdout).toMatch(/refusing to guess/);
      expect(r.stdout).toMatch(/LITELLM_CONFIG_PATH/);
    });

    it("exactly one candidate → discovered and CHECKED (the skip is not blanket)", () => {
      const root = servicesDir(["svc-a", "svc-b"], ["svc-a"]);
      const live = join(root, "svc-a", "litellm-config.yaml");
      const r = runWithDiscovery(root);
      expect(r.ok).toBe(true);
      expect(r.stdout).not.toMatch(/SKIP \(live\)/);
      expect(r.stdout).toContain(`OK — header passthrough correctly scoped (${live})`);
    });

    it("a discovered live config that VIOLATES still fails lint", () => {
      const root = mkdtempSync(join(tmpdir(), "litellm-services-"));
      dirs.push(root);
      mkdirSync(join(root, "svc-a"), { recursive: true });
      writeFileSync(
        join(root, "svc-a", "litellm-config.yaml"),
        "litellm_settings:\n  forward_client_headers_to_llm_api: true\n",
      );
      const r = runWithDiscovery(root);
      expect(r.ok).toBe(false);
      expect(r.stderr).toMatch(/FAIL/);
      expect(r.stderr).toMatch(/litellm_settings/);
    });
  });

  // Drift guard: the .mjs script re-implements discovery because it cannot
  // import the TS core. Assert the two agree on the same filesystem, so a fix
  // to one that is not mirrored into the other fails CI instead of silently
  // leaving the lint step and the fleet-health sensor disagreeing on-host.
  describe("discovery parity with src/litellm/header-passthrough-guard.ts", () => {
    const cases: Array<{ label: string; services: string[]; withConfig: string[] }> = [
      { label: "found (exactly one)", services: ["svc-a", "svc-b"], withConfig: ["svc-a"] },
      { label: "not-found (zero)", services: ["svc-a", "svc-b"], withConfig: [] },
      { label: "ambiguous (two)", services: ["svc-a", "svc-b"], withConfig: ["svc-a", "svc-b"] },
    ];
    for (const { label, services, withConfig } of cases) {
      it(`agrees on ${label}`, () => {
        const root = servicesDir(services, withConfig);
        const ts = discoverLiveLitellmConfigPath({ servicesDir: root });
        const r = runWithDiscovery(root);
        if (ts.path === null) {
          expect(r.stdout).toMatch(/SKIP \(live\)/);
        } else {
          expect(r.stdout).not.toMatch(/SKIP \(live\)/);
          expect(r.stdout).toContain(ts.path);
        }
      });
    }
  });

  // Allowlist parity: the .mjs guard re-implements `isClaudeAllowlistedGroup`
  // because it cannot import the TS core. Drive BOTH from the TS set so adding a
  // bare alias to one copy and not the other fails CI instead of producing a
  // false-positive OAuth-leak FAIL on-host (the bare `opus` regression).
  describe("bare Anthropic family aliases are allowlisted in both copies", () => {
    for (const alias of BARE_ANTHROPIC_FAMILY_ALIASES) {
      it(`'${alias}' with the flag → exit 0, OK`, () => {
        const r = runWith(
          fixture(`
model_group_settings:
  ${alias}:
    forward_client_headers_to_llm_api: true
`),
        );
        expect(r.stderr).not.toMatch(/FAIL/);
        expect(r.ok).toBe(true);
        expect(r.stdout).toMatch(/OK/);
      });

      it(`'${alias}-openrouter' with the flag → exit 1, FAIL (no suffix hole)`, () => {
        const r = runWith(
          fixture(`
model_group_settings:
  ${alias}-openrouter:
    forward_client_headers_to_llm_api: true
`),
        );
        expect(r.ok).toBe(false);
        expect(r.stderr).toMatch(new RegExp(`${alias}-openrouter`));
      });
    }
  });

  it("4b: claude group with num_retries>1 and no fallbacks → WARN, still exit 0", () => {
    const r = runWith(
      fixture(`
model_group_settings:
  claude-opus-4:
    num_retries: 3
`),
    );
    expect(r.ok).toBe(true);
    expect(r.stderr).toMatch(/WARN.*num_retries/);
  });
});
