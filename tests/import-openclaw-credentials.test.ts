import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planImport,
  parseSecretsEnv,
  applyPlan,
  formatPlan,
  loadOverlay,
  mergeMaps,
  DEFAULT_FILE_MAP,
  type ImportPlanEntry,
} from "../scripts/import-openclaw-credentials.js";
import {
  createVault,
  openVault,
  getSecret,
} from "../src/vault/vault.js";

function writeFile(root: string, name: string, content: string): void {
  writeFileSync(join(root, name), content);
}

interface SyntheticTree {
  /** Credentials directory scanned by planImport */
  creds: string;
  /** Separate directory for overlay files — never scanned */
  overlays: string;
  cleanup: () => void;
}

function makeTree(): SyntheticTree {
  const root = mkdtempSync(join(tmpdir(), "switchroom-import-test-"));
  const creds = join(root, "creds");
  const overlays = join(root, "overlays");
  mkdirSync(creds);
  mkdirSync(overlays);
  return {
    creds,
    overlays,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Write a YAML overlay file and return its path */
function writeOverlay(overlaysDir: string, name: string, yaml: string): string {
  const p = join(overlaysDir, name);
  writeFileSync(p, yaml);
  return p;
}

/** Blank overlay — no user-specific additions */
function blankOverlay(overlaysDir: string): string {
  return writeOverlay(overlaysDir, "blank.yaml", "");
}

describe("parseSecretsEnv", () => {
  it("parses KEY=VALUE lines", () => {
    const env = parseSecretsEnv("FOO=bar\nBAZ=qux\n");
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips surrounding quotes", () => {
    const env = parseSecretsEnv(`TOK="abc 123"\nOTHER='hello'\n`);
    expect(env).toEqual({ TOK: "abc 123", OTHER: "hello" });
  });

  it("skips comments and blank lines", () => {
    const env = parseSecretsEnv("# comment\n\nFOO=bar\n");
    expect(env).toEqual({ FOO: "bar" });
  });

  it("ignores lines without =", () => {
    const env = parseSecretsEnv("just-a-value\nFOO=bar\n");
    expect(env).toEqual({ FOO: "bar" });
  });
});

describe("loadOverlay", () => {
  let tree: SyntheticTree;

  beforeEach(() => {
    tree = makeTree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  it("returns empty maps when overlay file is empty YAML", () => {
    const path = blankOverlay(tree.overlays);
    const overlay = loadOverlay(path);
    expect(overlay.files).toEqual({});
    expect(overlay.skip).toEqual({});
    expect(overlay.secrets_env).toEqual({});
    expect(overlay.directories).toEqual({});
  });

  it("loads a well-formed overlay file", () => {
    const yaml = [
      "files:",
      "  my-custom-key: custom/vault-key",
      "skip:",
      "  legacy.json: deprecated",
      "secrets_env:",
      "  MY_TOKEN: myservice/token",
      "directories:",
      "  my-dir: myservice/dir",
    ].join("\n");
    const path = writeOverlay(tree.overlays, "overlay.yaml", yaml);
    const overlay = loadOverlay(path);
    expect(overlay.files).toEqual({ "my-custom-key": "custom/vault-key" });
    expect(overlay.skip).toEqual({ "legacy.json": "deprecated" });
    expect(overlay.secrets_env).toEqual({ MY_TOKEN: "myservice/token" });
    expect(overlay.directories).toEqual({ "my-dir": "myservice/dir" });
  });

  it("throws an actionable error for malformed YAML", () => {
    const path = writeOverlay(tree.overlays, "bad.yaml", "files: [\n  bad yaml");
    expect(() => loadOverlay(path)).toThrow(/not valid YAML/);
  });

  it("throws an actionable error for schema violations", () => {
    // files should be a record of strings, not a list
    const path = writeOverlay(tree.overlays, "bad-schema.yaml", "files:\n  - not-a-record");
    expect(() => loadOverlay(path)).toThrow(/schema error/);
  });

  it("throws when an explicit overlay path does not exist", () => {
    expect(() => loadOverlay(join(tree.overlays, "missing.yaml"))).toThrow(
      /not found/
    );
  });
});

describe("mergeMaps", () => {
  it("returns combined map when no collisions", () => {
    const merged = mergeMaps({ a: "1" }, { b: "2" });
    expect(merged).toEqual({ a: "1", b: "2" });
  });

  it("overlay wins on key collision", () => {
    const merged = mergeMaps({ a: "default" }, { a: "override" });
    expect(merged).toEqual({ a: "override" });
  });
});

describe("planImport", () => {
  let tree: SyntheticTree;

  beforeEach(() => {
    tree = makeTree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  it("no overlay → defaults only — file matching default key resolves clean", () => {
    writeFile(tree.creds, "anthropic-personal-api-key", "sk-ant-xyz\n");
    const overlayPath = blankOverlay(tree.overlays);
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan).toHaveLength(1);
    const action = plan[0].action;
    expect(action.kind).toBe("set-string");
    if (action.kind === "set-string") {
      expect(action.vaultKey).toBe("anthropic/personal-api-key");
    }
  });

  it("overlay key wins on collision — overlay remap of a default filename uses overlay value", () => {
    // anthropic-personal-api-key is in defaults → anthropic/personal-api-key
    // overlay remaps it to a different vault key
    const overlayPath = writeOverlay(
      tree.overlays,
      "overlay.yaml",
      "files:\n  anthropic-personal-api-key: custom/my-anthropic-key\n"
    );
    writeFile(tree.creds, "anthropic-personal-api-key", "sk-ant-abc\n");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan).toHaveLength(1);
    const action = plan[0].action;
    expect(action.kind).toBe("set-string");
    if (action.kind === "set-string") {
      expect(action.vaultKey).toBe("custom/my-anthropic-key");
    }
  });

  it("overlay adds unknown filename — file not in defaults but in overlay → clean set-string", () => {
    const overlayPath = writeOverlay(
      tree.overlays,
      "overlay.yaml",
      "files:\n  my-custom-token: myservice/token\n"
    );
    writeFile(tree.creds, "my-custom-token", "secret-value\n");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan).toHaveLength(1);
    const action = plan[0].action;
    expect(action.kind).toBe("set-string");
    if (action.kind === "set-string") {
      expect(action.vaultKey).toBe("myservice/token");
    }
    // No warn entries
    expect(plan.filter((p) => p.action.kind === "warn")).toHaveLength(0);
  });

  it("unknown file → warn — assert warn message points at overlay path", () => {
    const overlayPath = writeOverlay(tree.overlays, "overlay.yaml", "files: {}\n");
    writeFile(tree.creds, "totally-unknown-file", "data");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan).toHaveLength(1);
    const action = plan[0].action;
    expect(action.kind).toBe("warn");
    if (action.kind === "warn") {
      expect(action.reason).toContain(overlayPath);
    }
  });

  it("overlay malformed → throws actionable error", () => {
    const overlayPath = writeOverlay(tree.overlays, "bad.yaml", "files: [\n  oops");
    writeFile(tree.creds, "buildkite-api-token", "tok\n");
    expect(() => planImport(tree.creds, { overlayPath })).toThrow(/not valid YAML/);
  });

  it("maps a known plaintext file to its vault key", () => {
    const overlayPath = blankOverlay(tree.overlays);
    writeFile(tree.creds, "buildkite-api-token", "bk-token\n");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan).toHaveLength(1);
    expect(plan[0].sourceName).toBe("buildkite-api-token");
    expect(plan[0].action).toEqual({
      kind: "set-string",
      vaultKey: "buildkite/api-token",
      value: "bk-token\n",
    });
  });

  it("preserves JSON files verbatim as string secrets", () => {
    const overlayPath = writeOverlay(
      tree.overlays,
      "overlay.yaml",
      "files:\n  compass-mac.json: compass/credentials\n"
    );
    const json = `{"domain":"example","username":"a","password":"b"}`;
    writeFile(tree.creds, "compass-mac.json", json);
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan[0].action).toEqual({
      kind: "set-string",
      vaultKey: "compass/credentials",
      value: json,
    });
  });

  it("lifts SSH private keys as string secrets", () => {
    const overlayPath = blankOverlay(tree.overlays);
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nfake==\n-----END OPENSSH PRIVATE KEY-----\n";
    writeFile(tree.creds, "ha-ssh-key", pem);
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan[0].action).toMatchObject({
      kind: "set-string",
      vaultKey: "ha/ssh-key",
    });
  });

  it("skips .pub files as not-secrets", () => {
    const overlayPath = blankOverlay(tree.overlays);
    writeFile(tree.creds, "ha-ssh-key.pub", "ssh-ed25519 AAA...\n");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan[0].action.kind).toBe("skip");
    if (plan[0].action.kind === "skip") {
      expect(plan[0].action.reason).toContain("public key");
    }
  });

  it("skips files listed in the overlay skip table", () => {
    const overlayPath = writeOverlay(
      tree.overlays,
      "overlay.yaml",
      "skip:\n  compass-mac-cookies.json: auto-managed by compass skill (8h TTL cache)\n"
    );
    writeFile(tree.creds, "compass-mac-cookies.json", "{}");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan[0].action.kind).toBe("skip");
    if (plan[0].action.kind === "skip") {
      expect(plan[0].action.reason).toContain("auto-managed");
    }
  });

  it("skips legacy garmin.json and garmin-session.json (built-in defaults)", () => {
    const overlayPath = blankOverlay(tree.overlays);
    writeFile(tree.creds, "garmin.json", "{}");
    writeFile(tree.creds, "garmin-session.json", "{}");
    const plan = planImport(tree.creds, { overlayPath });
    const skipped = plan.filter((p) => p.action.kind === "skip");
    expect(skipped).toHaveLength(2);
    for (const entry of skipped) {
      if (entry.action.kind === "skip") {
        expect(entry.action.reason).toContain("superseded by garmin-tokens");
      }
    }
  });

  it("lifts a garmin-tokens directory as a multi-file secret", () => {
    const overlayPath = blankOverlay(tree.overlays);
    const garminDir = join(tree.creds, "garmin-tokens");
    mkdirSync(garminDir);
    writeFileSync(join(garminDir, "oauth1_token.json"), `{"token":"a"}`);
    writeFileSync(join(garminDir, "oauth2_token.json"), `{"refresh":"b"}`);

    const plan = planImport(tree.creds, { overlayPath });
    expect(plan).toHaveLength(1);
    const action = plan[0].action;
    expect(action.kind).toBe("set-files");
    if (action.kind === "set-files") {
      expect(action.vaultKey).toBe("garmin/tokens");
      expect(Object.keys(action.files).sort()).toEqual([
        "oauth1_token.json",
        "oauth2_token.json",
      ]);
      expect(action.files["oauth1_token.json"].encoding).toBe("utf8");
      expect(action.files["oauth1_token.json"].value).toBe(`{"token":"a"}`);
    }
  });

  it("splits secrets.env into per-key entries with known mappings", () => {
    // Use overlay to map the env keys for this test
    const overlayPath = writeOverlay(
      tree.overlays,
      "overlay.yaml",
      [
        "secrets_env:",
        "  X_BEARER_TOKEN: x-api/bearer-token",
        "  OPENROUTER_API_KEY: openrouter/api-key",
      ].join("\n")
    );
    writeFile(
      tree.creds,
      "secrets.env",
      "X_BEARER_TOKEN=aaa\nOPENROUTER_API_KEY=bbb\nUNKNOWN_KEY=ccc\n"
    );
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan).toHaveLength(3);

    const byName = Object.fromEntries(plan.map((p) => [p.sourceName, p]));
    expect(byName["secrets.env:X_BEARER_TOKEN"].action).toEqual({
      kind: "set-string",
      vaultKey: "x-api/bearer-token",
      value: "aaa",
    });
    expect(byName["secrets.env:OPENROUTER_API_KEY"].action).toEqual({
      kind: "set-string",
      vaultKey: "openrouter/api-key",
      value: "bbb",
    });
    expect(byName["secrets.env:UNKNOWN_KEY"].action.kind).toBe("warn");
  });

  it("maps user-specific credentials via overlay (replaces Ken-specific hardcoding)", () => {
    // This test exercises the overlay mechanism with a representative set of
    // user-specific filenames, now supplied at runtime via an overlay instead
    // of being hardcoded in source.
    const overlayPath = writeOverlay(
      tree.overlays,
      "overlay.yaml",
      [
        "files:",
        "  discord-bot-token-ziggy: discord/ziggy-bot-token",
        "  microsoft-tokens-user.json: microsoft/user-tokens",
        "  telegram-bot-token-mybot: telegram/mybot-bot-token",
        "  telegram-mybot-allowFrom.json: telegram/mybot-allowfrom",
        "  telegram-mybot-pairing.json: telegram/mybot-pairing",
        "  bank-agent-private-key: bank/agent-private-key",
        "  email-user.json: email/user-client",
        "  custom-server-key: ssh/custom-server",
        "  synology-user.json: synology/user",
        "skip:",
        "  compass-mac-cookies.json: auto-managed by compass skill (8h TTL cache)",
        "secrets_env:",
        "  X_BEARER_TOKEN: x-api/bearer-token",
        "  OPENROUTER_API_KEY: openrouter/api-key",
      ].join("\n")
    );

    writeFile(tree.creds, "discord-bot-token-ziggy", "ziggy-token\n");
    writeFile(tree.creds, "microsoft-tokens-user.json", `{"access":"x"}`);
    writeFile(tree.creds, "telegram-bot-token-mybot", "mybot-token\n");
    writeFile(tree.creds, "telegram-mybot-allowFrom.json", `{"ids":[1]}`);
    writeFile(tree.creds, "telegram-mybot-pairing.json", `{"dm":true}`);
    writeFile(tree.creds, "bank-agent-private-key", "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n");
    writeFile(tree.creds, "email-user.json", `{"client_id":"e"}`);
    writeFile(tree.creds, "custom-server-key", "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n");
    writeFile(tree.creds, "synology-user.json", `{"host":"nas"}`);

    const plan = planImport(tree.creds, { overlayPath });
    const byName = Object.fromEntries(plan.map((p) => [p.sourceName, p]));

    expect(byName["discord-bot-token-ziggy"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "discord/ziggy-bot-token",
    });
    expect(byName["microsoft-tokens-user.json"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "microsoft/user-tokens",
    });
    expect(byName["telegram-bot-token-mybot"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "telegram/mybot-bot-token",
    });
    expect(byName["telegram-mybot-allowFrom.json"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "telegram/mybot-allowfrom",
    });
    expect(byName["telegram-mybot-pairing.json"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "telegram/mybot-pairing",
    });
    expect(byName["bank-agent-private-key"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "bank/agent-private-key",
    });
    expect(byName["email-user.json"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "email/user-client",
    });
    expect(byName["custom-server-key"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "ssh/custom-server",
    });
    expect(byName["synology-user.json"].action).toMatchObject({
      kind: "set-string",
      vaultKey: "synology/user",
    });

    const warns = plan.filter((p) => p.action.kind === "warn");
    expect(warns).toHaveLength(0);
  });

  it("warns on unknown files instead of guessing", () => {
    const overlayPath = blankOverlay(tree.overlays);
    writeFile(tree.creds, "mystery-file", "data");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan[0].action.kind).toBe("warn");
    if (plan[0].action.kind === "warn") {
      expect(plan[0].action.reason).toContain("unknown file");
    }
  });

  it("warns on unknown subdirectories instead of guessing", () => {
    const overlayPath = blankOverlay(tree.overlays);
    mkdirSync(join(tree.creds, "mystery-dir"));
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan[0].action.kind).toBe("warn");
    if (plan[0].action.kind === "warn") {
      expect(plan[0].action.reason).toContain("unknown directory");
    }
  });

  it("returns entries in a stable (sorted) order", () => {
    const overlayPath = blankOverlay(tree.overlays);
    writeFile(tree.creds, "notion-api-key", "n1");
    writeFile(tree.creds, "anthropic-personal-api-key", "a1");
    writeFile(tree.creds, "buildkite-api-token", "b1");
    const plan = planImport(tree.creds, { overlayPath });
    expect(plan.map((p) => p.sourceName)).toEqual([
      "anthropic-personal-api-key",
      "buildkite-api-token",
      "notion-api-key",
    ]);
  });

  it("throws when the source directory does not exist", () => {
    expect(() => planImport(join(tree.creds, "nope"))).toThrow(/not found/);
  });
});

describe("applyPlan", () => {
  let tree: SyntheticTree;
  let vaultPath: string;
  const passphrase = "test-import-pass";

  beforeEach(() => {
    tree = makeTree();
    vaultPath = join(tree.overlays, "vault.enc");
    createVault(passphrase, vaultPath);
  });

  afterEach(() => {
    tree.cleanup();
  });

  it("writes string secrets to the vault and reports them", () => {
    const plan: ImportPlanEntry[] = [
      {
        sourcePath: "/src/a",
        sourceName: "a",
        action: { kind: "set-string", vaultKey: "svc/a", value: "alpha" },
      },
      {
        sourcePath: "/src/b",
        sourceName: "b",
        action: { kind: "set-string", vaultKey: "svc/b", value: "bravo" },
      },
    ];
    const result = applyPlan(plan, vaultPath, passphrase);
    expect(result.written).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);

    const secrets = openVault(passphrase, vaultPath);
    expect(secrets["svc/a"]).toEqual({ kind: "string", value: "alpha" });
    expect(secrets["svc/b"]).toEqual({ kind: "string", value: "bravo" });
  });

  it("writes files secrets as kind=files entries", () => {
    const plan: ImportPlanEntry[] = [
      {
        sourcePath: "/src/dir",
        sourceName: "dir",
        action: {
          kind: "set-files",
          vaultKey: "garmin/tokens",
          files: {
            "oauth1_token.json": { encoding: "utf8", value: `{"t":"a"}` },
            "oauth2_token.json": { encoding: "utf8", value: `{"t":"b"}` },
          },
        },
      },
    ];
    applyPlan(plan, vaultPath, passphrase);
    const entry = getSecret(passphrase, vaultPath, "garmin/tokens");
    expect(entry?.kind).toBe("files");
    if (entry?.kind === "files") {
      expect(Object.keys(entry.files).sort()).toEqual([
        "oauth1_token.json",
        "oauth2_token.json",
      ]);
    }
  });

  it("reports conflicts and preserves existing values by default", () => {
    // Seed an existing value.
    const existing: ImportPlanEntry[] = [
      {
        sourcePath: "/seed",
        sourceName: "seed",
        action: { kind: "set-string", vaultKey: "svc/a", value: "original" },
      },
    ];
    applyPlan(existing, vaultPath, passphrase);

    // Try to reimport with a different value.
    const overwrite: ImportPlanEntry[] = [
      {
        sourcePath: "/new",
        sourceName: "new",
        action: { kind: "set-string", vaultKey: "svc/a", value: "replaced" },
      },
    ];
    const result = applyPlan(overwrite, vaultPath, passphrase);
    expect(result.written).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain("svc/a");

    // Original value still there.
    const secrets = openVault(passphrase, vaultPath);
    expect(secrets["svc/a"]).toEqual({ kind: "string", value: "original" });
  });

  it("overwrites when --overwrite is set", () => {
    const seed: ImportPlanEntry[] = [
      {
        sourcePath: "/seed",
        sourceName: "seed",
        action: { kind: "set-string", vaultKey: "svc/a", value: "original" },
      },
    ];
    applyPlan(seed, vaultPath, passphrase);

    const overwrite: ImportPlanEntry[] = [
      {
        sourcePath: "/new",
        sourceName: "new",
        action: { kind: "set-string", vaultKey: "svc/a", value: "replaced" },
      },
    ];
    const result = applyPlan(overwrite, vaultPath, passphrase, {
      overwrite: true,
    });
    expect(result.written).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);

    const secrets = openVault(passphrase, vaultPath);
    expect(secrets["svc/a"]).toEqual({ kind: "string", value: "replaced" });
  });

  it("collects skip and warn entries without touching the vault", () => {
    const plan: ImportPlanEntry[] = [
      {
        sourcePath: "/x",
        sourceName: "x.pub",
        action: { kind: "skip", reason: "public key, not a secret" },
      },
      {
        sourcePath: "/y",
        sourceName: "mystery",
        action: { kind: "warn", reason: "unknown file" },
      },
    ];
    const result = applyPlan(plan, vaultPath, passphrase);
    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.warned).toHaveLength(1);

    const secrets = openVault(passphrase, vaultPath);
    expect(Object.keys(secrets)).toHaveLength(0);
  });

  it("does not save the vault at all when the plan has no writes", () => {
    // If saveVault were called with an empty plan we'd still write a
    // new IV/tag, which is harmless but wastes cycles. Assert no write
    // by checking mtime stays constant.
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const before = statSync(vaultPath).mtimeMs;
    const plan: ImportPlanEntry[] = [
      {
        sourcePath: "/x",
        sourceName: "x.pub",
        action: { kind: "skip", reason: "public key" },
      },
    ];
    applyPlan(plan, vaultPath, passphrase);
    const after = statSync(vaultPath).mtimeMs;
    expect(after).toBe(before);
  });
});

describe("formatPlan", () => {
  it("summarizes counts in the footer", () => {
    const plan: ImportPlanEntry[] = [
      {
        sourcePath: "/a",
        sourceName: "a",
        action: { kind: "set-string", vaultKey: "svc/a", value: "1" },
      },
      {
        sourcePath: "/b",
        sourceName: "b.pub",
        action: { kind: "skip", reason: "public key" },
      },
      {
        sourcePath: "/c",
        sourceName: "c",
        action: { kind: "warn", reason: "unknown" },
      },
    ];
    const rendered = formatPlan(plan);
    expect(rendered).toContain("Total: 3");
    expect(rendered).toContain("set=1");
    expect(rendered).toContain("skip=1");
    expect(rendered).toContain("warn=1");
  });
});
