/**
 * The release asset-name contract (#3633).
 *
 * `install.sh` downloads `switchroom-<platform>-<arch>` + `switchroom-checksums.txt`
 * from the GitHub release page; `.github/workflows/release.yml` is the only thing
 * that produces them. Nothing produced them for two months — four consecutive
 * releases shipped zero assets and the advertised `curl | sh` install was dead on
 * every platform.
 *
 * These tests assert OUTCOMES of the two guards that make that unrepeatable:
 *
 *   - `scripts/check-release-asset-names.mjs` (static, in `npm run lint`) must
 *     PASS on the real repo files and FAIL on every way the two sides can drift.
 *   - `scripts/verify-release-bundle.mjs` (runtime, in the release workflow) must
 *     reject a bundle the installer could not consume — including the subtle
 *     one-space checksums file that looks fine to a human but makes install.sh
 *     die with "No checksum entry".
 *
 * A test that only ran the happy path would not have caught the original bug, so
 * every negative case here mutates a copy of the real files and asserts the guard
 * goes red.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const CHECK = resolve(REPO, "scripts/check-release-asset-names.mjs");
const VERIFY = resolve(REPO, "scripts/verify-release-bundle.mjs");
const REAL_INSTALL_SH = resolve(REPO, "install.sh");
const REAL_WORKFLOW = resolve(REPO, ".github/workflows/release.yml");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "release-contract-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Run = { ok: boolean; out: string };

function runCheck(env: Record<string, string> = {}): Run {
  const r = spawnSync("node", [CHECK], { cwd: REPO, encoding: "utf8", env: { ...process.env, ...env } });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function runVerify(bundleDir: string, env: Record<string, string> = {}): Run {
  const r = spawnSync("node", [VERIFY, bundleDir], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Copy the real install.sh / release.yml into a tmp dir, optionally mutated. */
function stage(mutate: { installSh?: (s: string) => string; workflow?: (s: string) => string } = {}): {
  SWITCHROOM_INSTALL_SH_PATH: string;
  SWITCHROOM_RELEASE_WORKFLOW_PATH: string;
} {
  const d = tmp();
  const installSh = join(d, "install.sh");
  const workflow = join(d, "release.yml");
  const rawInstall = readFileSync(REAL_INSTALL_SH, "utf-8");
  const rawWorkflow = readFileSync(REAL_WORKFLOW, "utf-8");
  writeFileSync(installSh, mutate.installSh ? mutate.installSh(rawInstall) : rawInstall);
  writeFileSync(workflow, mutate.workflow ? mutate.workflow(rawWorkflow) : rawWorkflow);
  return { SWITCHROOM_INSTALL_SH_PATH: installSh, SWITCHROOM_RELEASE_WORKFLOW_PATH: workflow };
}

const ASSETS = [
  "switchroom-linux-amd64",
  "switchroom-linux-arm64",
  "switchroom-macos-amd64",
  "switchroom-macos-arm64",
];
const CHECKSUMS = "switchroom-checksums.txt";

/** Build a bundle dir shaped exactly like the workflow's `dist-bins`. */
function makeBundle(opts: { separator?: string; omit?: string[]; extra?: string[]; corrupt?: string } = {}): string {
  const d = tmp();
  const sep = opts.separator ?? "  ";
  const omit = new Set(opts.omit ?? []);
  const lines: string[] = [];
  for (const asset of ASSETS) {
    if (omit.has(asset)) continue;
    const body = `fake-binary-${asset}\n`;
    writeFileSync(join(d, asset), body);
    const hash =
      opts.corrupt === asset
        ? "0".repeat(64)
        : createHash("sha256").update(Buffer.from(body)).digest("hex");
    lines.push(`${hash}${sep}${asset}`);
  }
  if (!omit.has(CHECKSUMS)) writeFileSync(join(d, CHECKSUMS), `${lines.join("\n")}\n`);
  for (const extra of opts.extra ?? []) writeFileSync(join(d, extra), "stray\n");
  return d;
}

describe("check-release-asset-names (static contract)", () => {
  it("passes on the real install.sh + release.yml, naming all four assets", () => {
    const r = runCheck();
    expect(r.out).toContain("OK release asset contract");
    for (const asset of ASSETS) expect(r.out).toContain(asset);
    expect(r.out).toContain(CHECKSUMS);
    expect(r.ok).toBe(true);
  });

  it("fails when the workflow renames an asset the installer still asks for", () => {
    const env = stage({ workflow: (s) => s.replaceAll("switchroom-macos-arm64", "switchroom-darwin-arm64") });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("switchroom-macos-arm64");
    expect(r.out).toContain("switchroom-darwin-arm64");
  });

  it("fails when the installer gains a platform the workflow does not build", () => {
    const env = stage({
      installSh: (s) => s.replace("Darwin)  platform=macos ;;", "Darwin)  platform=macos ;;\n  FreeBSD) platform=freebsd ;;"),
    });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("switchroom-freebsd-amd64");
  });

  it("fails when the checksums filename differs between the two sides", () => {
    const env = stage({ workflow: (s) => s.replace(/CHECKSUMS_FILE: ".*"/, 'CHECKSUMS_FILE: "switchroom-sha256.txt"') });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("switchroom-sha256.txt");
    expect(r.out).toContain(CHECKSUMS);
  });

  it("fails when the workflow's own RELEASE_ASSETS list drifts from its build matrix", () => {
    const env = stage({
      workflow: (s) =>
        s.replace(
          /RELEASE_ASSETS: ".*"/,
          'RELEASE_ASSETS: "switchroom-linux-amd64 switchroom-linux-arm64 switchroom-macos-amd64"',
        ),
    });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("env.RELEASE_ASSETS");
  });

  it("fails loudly (rather than silently passing) when install.sh's asset template is unrecognisable", () => {
    const env = stage({ installSh: (s) => s.replace('asset="switchroom-${platform}-${arch}"', 'asset="$(mystery)"') });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("could not derive the contract");
  });

  it("fails when the workflow stops using a two-space-format digest tool", () => {
    const env = stage({ workflow: (s) => s.replaceAll("sha256sum", "openssl dgst -sha256") });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("sha256sum");
  });

  it("fails when install.sh's checksum lookup separator stops matching sha256sum output", () => {
    const env = stage({ installSh: (s) => s.replace('grep -F "  ${asset}"', 'grep -F " ${asset}"') });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("separator");
  });

  // ---- #3634: every asset is built on its own OS ----
  //
  // The workflow's smoke run catches a cross-compiled darwin target by
  // accident (Linux cannot exec a Mach-O). That is an emergent property of
  // the build host, not a rule anyone stated — and the signature step is
  // `if: startsWith(matrix.target.runner, 'macos')`, so moving a macOS leg to
  // ubuntu ALSO silently skips the only signature check there is. These cases
  // make the rule explicit and prove it bites.

  it("fails when a macOS asset is moved to a Linux runner (the #3634 regression)", () => {
    const env = stage({ workflow: (s) => s.replace("runner: macos-15 }", "runner: ubuntu-latest }") });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("switchroom-macos-arm64");
    expect(r.out).toContain("ubuntu-latest");
    expect(r.out).toContain("#3634");
  });

  it("fails when a Linux asset is moved to a macOS runner", () => {
    const env = stage({ workflow: (s) => s.replace("runner: ubuntu-24.04-arm }", "runner: macos-15 }") });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("switchroom-linux-arm64");
    expect(r.out).toContain("macos-15");
  });

  it("fails when a build-matrix target declares no runner at all", () => {
    const env = stage({ workflow: (s) => s.replace(", runner: ubuntu-24.04-arm }", " }") });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("no `runner` label");
  });

  it("fails when the macOS signature verification step is dropped", () => {
    const env = stage({ workflow: (s) => s.replaceAll("codesign --verify", "codesign -v") });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("codesign --verify");
  });
});

describe("verify-release-bundle (runtime contract)", () => {
  it("accepts a bundle with all four assets and a sha256sum-format checksums file", () => {
    const r = runVerify(makeBundle());
    expect(r.out).toContain("OK release bundle");
    expect(r.ok).toBe(true);
  });

  it("rejects a bundle missing an asset install.sh would request", () => {
    const r = runVerify(makeBundle({ omit: ["switchroom-macos-arm64"] }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain("missing: switchroom-macos-arm64");
  });

  it("rejects a checksums file written with a single space (install.sh's grep -F would miss it)", () => {
    const r = runVerify(makeBundle({ separator: " " }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain("fixed-string lookup");
  });

  it("rejects a checksum that does not match the file it names", () => {
    const r = runVerify(makeBundle({ corrupt: "switchroom-linux-amd64" }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain("hashes to");
  });

  it("rejects a stray file that would otherwise be published as a release asset", () => {
    const r = runVerify(makeBundle({ extra: ["switchroom-linux-amd64.dSYM"] }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain("unexpected file");
  });

  it("rejects a missing checksums file", () => {
    const r = runVerify(makeBundle({ omit: [CHECKSUMS] }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain(`missing: ${CHECKSUMS}`);
  });

  it("runs with no node_modules at all (the release job verifies on a bare checkout)", () => {
    // The `bundle` job checks the repo out and hashes files; it never runs an
    // npm/bun install. A stray dependency import here would fail the release
    // at its very last step. Copy the scripts somewhere with no resolvable
    // node_modules and prove they still run.
    const d = tmp();
    for (const f of ["release-assets.mjs", "verify-release-bundle.mjs"]) {
      writeFileSync(join(d, f), readFileSync(resolve(REPO, "scripts", f), "utf-8"));
    }
    const bundle = makeBundle();
    const r = spawnSync("node", [join(d, "verify-release-bundle.mjs"), bundle], {
      cwd: d,
      encoding: "utf8",
      env: { ...process.env, SWITCHROOM_INSTALL_SH_PATH: REAL_INSTALL_SH },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(out).toContain("OK release bundle");
    expect(r.status).toBe(0);
  });
});

/**
 * The release workflow's smoke step is a STRING EQUALITY:
 *
 *   out="$("./switchroom-linux-amd64" --version)"
 *   [ "$out" = "${GITHUB_REF#refs/tags/v}" ] || fail
 *
 * so `switchroom --version` must print the bare version and nothing else. A
 * banner, a `v` prefix, a "switchroom " prefix or a second line breaks EVERY
 * build leg and blocks the release — and nothing anywhere asserted that shape.
 * Commander's `.version(VERSION)` gives it today; this makes that a contract.
 */
describe("switchroom --version shape (the release smoke assertion depends on it)", () => {
  const bunAvailable = (() => {
    if (process.env.BUN_BUILD_COMPILE_SKIP) return false;
    const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
    return probe.status === 0;
  })();

  it.skipIf(!bunAvailable)("prints exactly the bare version, one line, no prefix", () => {
    const r = spawnSync("bun", ["bin/switchroom.ts", "--version"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);

    const stdout = r.stdout ?? "";
    // Exactly one line, terminated by a single newline — no banner, no trailer.
    expect(stdout.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    const out = stdout.trim();
    // The same shape release.yml's tag guard accepts, with no decoration: what
    // the workflow compares against is `${tag#v}`, so a leading `v` or a
    // "switchroom " prefix would fail the equality on every leg.
    expect(out).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+([-.+].+)?$/);
    // Belt and braces: no whitespace inside means no "switchroom 1.2.3" form.
    expect(out).not.toMatch(/\s/);
    // And stdout must not be padded — the workflow uses `$( )`, which strips
    // only trailing newlines, so a leading space would break the comparison.
    expect(stdout.startsWith(out)).toBe(true);
  });
});

/**
 * End-to-end: drive the REAL install.sh against a workflow-shaped bundle.
 *
 * Before this, no workflow, test, or script anywhere referenced install.sh — it
 * was entirely unexercised, which is how it stayed broken for two months. A
 * stub `curl` on PATH maps the release-page URLs onto a local bundle dir, so
 * the installer's real download → checksum-verify → install → run path runs
 * against exactly the file layout the release workflow publishes.
 */
describe("install.sh against a workflow-shaped bundle", () => {
  function fakeBinaryBundle(): string {
    const d = makeBundle();
    // Replace the placeholder payload for this host's asset with something
    // runnable, and restate its checksum, so install.sh's final `version`
    // probe exercises the installed file.
    const platform = process.platform === "darwin" ? "macos" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const asset = `switchroom-${platform}-${arch}`;
    const body = '#!/bin/sh\necho "switchroom 0.0.0-test"\n';
    writeFileSync(join(d, asset), body, { mode: 0o755 });
    const hash = createHash("sha256").update(Buffer.from(body)).digest("hex");
    const lines = readFileSync(join(d, CHECKSUMS), "utf-8")
      .split("\n")
      .map((l) => (l.endsWith(`  ${asset}`) ? `${hash}  ${asset}` : l));
    writeFileSync(join(d, CHECKSUMS), lines.join("\n"));
    return d;
  }

  function runInstaller(bundleDir: string): Run {
    // The stub is an EXPORTED bash function, not a file on PATH: a script file
    // would need the exec bit, and a `noexec` tmpdir (common in hardened
    // sandboxes) would silently fall through to the real curl and hit
    // github.com. An exported function is visible to the `bash install.sh`
    // child, shadows PATH, and needs no filesystem permissions.
    const stub = [
      "curl() {",
      "  local out='' url=''",
      "  while [ $# -gt 0 ]; do",
      '    case "$1" in',
      '      -o) out="$2"; shift 2 ;;',
      "      -*) shift ;;",
      '      *) url="$1"; shift ;;',
      "    esac",
      "  done",
      '  local name="${url##*/}"',
      '  local src="$BUNDLE_DIR/$name"',
      // 22 is curl's HTTP-error exit code — what a 404 on the release page
      // looks like to install.sh.
      '  [ -f "$src" ] || return 22',
      '  if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi',
      "}",
      "export -f curl",
      'bash "$INSTALL_SH"',
    ].join("\n");
    const installDir = tmp();
    const r = spawnSync("bash", ["-c", stub], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        INSTALL_SH: REAL_INSTALL_SH,
        BUNDLE_DIR: bundleDir,
        SWITCHROOM_VERSION: "v0.0.0-test",
        SWITCHROOM_INSTALL_DIR: installDir,
      },
    });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("downloads, checksum-verifies and installs from the bundle the workflow publishes", () => {
    const r = runInstaller(fakeBinaryBundle());
    expect(r.out).toContain("Checksum verified");
    expect(r.out).toContain("Installed switchroom to");
    expect(r.ok).toBe(true);
  });

  it("refuses to install when the checksum does not match (tamper guard still bites)", () => {
    const d = fakeBinaryBundle();
    const platform = process.platform === "darwin" ? "macos" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    writeFileSync(join(d, `switchroom-${platform}-${arch}`), '#!/bin/sh\necho tampered\n', { mode: 0o755 });
    const r = runInstaller(d);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("Checksum mismatch");
  });
});
