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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
/** #4163 — the shipped-asset payload, alongside the four binaries. */
const PAYLOAD = "switchroom-assets.tar.gz";
const PAYLOAD_VERSION = "v0.0.0-test";

/**
 * A real gzip tarball shaped like the one scripts/build-asset-payload.mjs
 * produces: a version manifest at the root plus the asset directories the CLI
 * probes for. Real, not a stub, because install.sh actually untars it and
 * reads the manifest back out.
 */
function makePayloadTarball(dest: string, opts: { version?: string } = {}): void {
  const stage = tmp();
  mkdirSync(join(stage, "profiles/_base"), { recursive: true });
  writeFileSync(join(stage, "profiles/_base/start.sh.hbs"), "#!/bin/sh\n");
  mkdirSync(join(stage, "skills"), { recursive: true });
  writeFileSync(join(stage, "skills/.keep"), "");
  writeFileSync(
    join(stage, "switchroom-assets.json"),
    `${JSON.stringify({ version: opts.version ?? PAYLOAD_VERSION, entries: ["profiles", "skills"], files: 2 }, null, 2)}\n`,
  );
  const r = spawnSync("tar", ["-czf", dest, "-C", stage, "."], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
}

/** Build a bundle dir shaped exactly like the workflow's `dist-bins`. */
function makeBundle(
  opts: {
    separator?: string;
    omit?: string[];
    extra?: string[];
    corrupt?: string;
    payloadVersion?: string;
  } = {},
): string {
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
  if (!omit.has(PAYLOAD)) {
    makePayloadTarball(join(d, PAYLOAD), { version: opts.payloadVersion });
    const hash =
      opts.corrupt === PAYLOAD
        ? "0".repeat(64)
        : createHash("sha256").update(readFileSync(join(d, PAYLOAD))).digest("hex");
    lines.push(`${hash}${sep}${PAYLOAD}`);
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
    const env = stage({ installSh: (s) => s.replace('grep -F "  ${1}"', 'grep -F " ${1}"') });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("separator");
  });

  // ---- #4163: the shipped-asset payload is part of the contract ----
  //
  // A release that ships four binaries and no payload installs a CLI that
  // cannot scaffold a single agent. That failure surfaces LATER than a 404 —
  // on the user's host, at `switchroom apply` — so the naming contract has to
  // cover the tarball exactly as it covers the binaries.

  it("names the asset payload on the real files", () => {
    const r = runCheck();
    expect(r.ok).toBe(true);
    expect(r.out).toContain(PAYLOAD);
  });

  it("fails when the workflow renames the payload the installer still asks for", () => {
    const env = stage({ workflow: (s) => s.replace(/PAYLOAD_ASSET: ".*"/, 'PAYLOAD_ASSET: "switchroom-share.tgz"') });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("switchroom-share.tgz");
    expect(r.out).toContain(PAYLOAD);
  });

  it("fails loudly when install.sh stops fetching a payload at all", () => {
    const env = stage({ installSh: (s) => s.replace(/assets_payload="[^"]*"/, 'assets_payload_gone=""') });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("could not derive the contract");
    expect(r.out).toContain("#4163");
  });

  it("fails when the workflow declares a payload but never builds one", () => {
    const env = stage({ workflow: (s) => s.replaceAll("scripts/build-asset-payload.mjs", "scripts/nope.mjs") });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("build-asset-payload.mjs");
  });

  it("fails when the payload is smuggled into the per-platform RELEASE_ASSETS list", () => {
    // Four build legs would then race to upload the same architecture-
    // independent file, and `bundle`'s flatten step would look for it in an
    // artifact that never contained it.
    const env = stage({
      workflow: (s) => s.replace(/RELEASE_ASSETS: "(.*)"/, `RELEASE_ASSETS: "$1 ${PAYLOAD}"`),
    });
    const r = runCheck(env);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("env.RELEASE_ASSETS");
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

  it("rejects a bundle with every binary but no asset payload (#4163)", () => {
    const r = runVerify(makeBundle({ omit: [PAYLOAD] }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain(`missing: ${PAYLOAD}`);
  });

  it("checksum-verifies the payload, not just the binaries", () => {
    const r = runVerify(makeBundle({ corrupt: PAYLOAD }));
    expect(r.ok).toBe(false);
    expect(r.out).toContain(PAYLOAD);
    expect(r.out).toContain("hashes to");
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

  function runInstaller(bundleDir: string, out?: { shareDir?: string }): Run {
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
    const prefix = tmp();
    const installDir = join(prefix, "bin");
    mkdirSync(installDir, { recursive: true });
    // Pinned INSIDE the test's tmp prefix. The default is
    // `<dirname install_dir>/share/switchroom`, which for a real install is
    // `/usr/local/share/switchroom` — never write there from a test.
    const shareDir = join(prefix, "share/switchroom");
    if (out) out.shareDir = shareDir;
    const r = spawnSync("bash", ["-c", stub], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        INSTALL_SH: REAL_INSTALL_SH,
        BUNDLE_DIR: bundleDir,
        SWITCHROOM_VERSION: PAYLOAD_VERSION,
        SWITCHROOM_INSTALL_DIR: installDir,
        SWITCHROOM_SHARE_DIR: shareDir,
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

  // ---- #4163: the payload has to actually land where the CLI probes ----

  it("extracts the asset payload to <prefix>/share/switchroom via a versioned dir + symlink", () => {
    const out: { shareDir?: string } = {};
    const r = runInstaller(fakeBinaryBundle(), out);
    expect(r.ok, r.out).toBe(true);
    const shareDir = out.shareDir as string;

    // The published path is a SYMLINK to a versioned directory. That is what
    // makes the swap on the next install a rename of a link rather than a
    // recursive delete of a live directory.
    expect(lstatSync(shareDir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(shareDir)).toBe(`switchroom-${PAYLOAD_VERSION.replace(/^v/, "")}`);

    // And the contents are the ones src/util/shipped-assets.ts probes for.
    expect(existsSync(join(shareDir, "profiles/_base/start.sh.hbs"))).toBe(true);
    expect(existsSync(join(shareDir, "skills"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(shareDir, "switchroom-assets.json"), "utf-8"));
    expect(manifest.version).toBe(PAYLOAD_VERSION);
  });

  it("refuses to install a payload whose checksum does not match", () => {
    const d = fakeBinaryBundle();
    writeFileSync(join(d, PAYLOAD), "tampered\n");
    const out: { shareDir?: string } = {};
    const r = runInstaller(d, out);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("Checksum mismatch");
    expect(r.out).toContain(PAYLOAD);
    // Nothing published: a payload that failed verification must not become
    // the templates every agent is scaffolded from.
    expect(existsSync(out.shareDir as string)).toBe(false);
  });

  it("refuses a payload whose manifest names a different release than the binary", () => {
    // The skew guard the issue calls non-negotiable, at INSTALL time: a CLI
    // must never be paired with someone else's templates.
    const d = fakeBinaryBundle();
    makePayloadTarball(join(d, PAYLOAD), { version: "v9.9.9" });
    const hash = createHash("sha256").update(readFileSync(join(d, PAYLOAD))).digest("hex");
    writeFileSync(
      join(d, CHECKSUMS),
      readFileSync(join(d, CHECKSUMS), "utf-8")
        .split("\n")
        .map((l) => (l.endsWith(`  ${PAYLOAD}`) ? `${hash}  ${PAYLOAD}` : l))
        .join("\n"),
    );
    const out: { shareDir?: string } = {};
    const r = runInstaller(d, out);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("9.9.9");
    expect(existsSync(out.shareDir as string)).toBe(false);
  });

  it("warns loudly, and does not silently succeed, on a release that predates the payload", () => {
    // Installing an old tag is legal. Getting a CLI that dies at `switchroom
    // apply` with no warning is not.
    const d = makeBundle({ omit: [PAYLOAD] });
    const platform = process.platform === "darwin" ? "macos" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const asset = `switchroom-${platform}-${arch}`;
    const body = '#!/bin/sh\necho "switchroom 0.0.0-test"\n';
    writeFileSync(join(d, asset), body, { mode: 0o755 });
    const hash = createHash("sha256").update(Buffer.from(body)).digest("hex");
    writeFileSync(
      join(d, CHECKSUMS),
      readFileSync(join(d, CHECKSUMS), "utf-8")
        .split("\n")
        .map((l) => (l.endsWith(`  ${asset}`) ? `${hash}  ${asset}` : l))
        .join("\n"),
    );
    const out: { shareDir?: string } = {};
    const r = runInstaller(d, out);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain(PAYLOAD);
    expect(r.out).toMatch(/WILL fail/);
    expect(existsSync(out.shareDir as string)).toBe(false);
  });
});
