import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planImport,
  parseSecretsEnv,
  applyPlan,
  formatPlan,
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
  dir: string;
  cleanup: () => void;
}

function makeTree(): SyntheticTree {
  const dir = mkdtempSync(join(tmpdir(), "switchroom-import-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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

describe("planImport", () => {
  let tree: SyntheticTree;

  beforeEach(() => {
    tree = makeTree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  it("maps a known plaintext file to its vault key", () => {
    writeFile(tree.dir, "anthropic-buildkite-token", "sk-ant-xyz\n");
    const plan = planImport(tree.dir);
    expect(plan).toHaveLength(1);
    expect(plan[0].sourceName).toBe("anthropic-buildkite-token");
    expect(plan[0].action).toEqual({
      kind: "set-string",
      vaultKey: "anthropic/buildkite-api-key",
      value: "sk-ant-xyz\n",
    });
  });

  it("preserves JSON files verbatim as string secrets", () => {
    const json = `{"domain":"example","username":"a","password":"b"}`;
    writeFile(tree.dir, "compass-mac.json", json);
    const plan = planImport(tree.dir);
    expect(plan[0].action).toEqual({
      kind: "set-string",
      vaultKey: "compass/credentials",
      value: json,
    });
  });

  it("lifts SSH private keys as string secrets", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nfake==\n-----END OPENSSH PRIVATE KEY-----\n";
    writeFile(tree.dir, "ha-ssh-key", pem);
    const plan = planImport(tree.dir);
    expect(plan[0].action).toMatchObject({
      kind: "set-string",
      vaultKey: "ha/ssh-key",
    });
  });

  it("skips .pub files as not-secrets", () => {
    writeFile(tree.dir, "ha-ssh-key.pub", "ssh-ed25519 AAA...\n");
    const plan = planImport(tree.dir);
    expect(plan[0].action.kind).toBe("skip");
    if (plan[0].action.kind === "skip") {
      expect(plan[0].action.reason).toContain("public key");
    }
  });

  it("skips compass-mac-cookies.json (auto-managed)", () => {
    writeFile(tree.dir, "compass-mac-cookies.json", "{}");
    const plan = planImport(tree.dir);
    expect(plan[0].action.kind).toBe("skip");
    if (plan[0].action.kind === "skip") {
      expect(plan[0].action.reason).toContain("auto-managed");
    }
  });

  it("skips legacy garmin.json and garmin-session.json", () => {
    writeFile(tree.dir, "garmin.json", "{}");
    writeFile(tree.dir, "garmin-session.json", "{}");
    const plan = planImport(tree.dir);
    const skipped = plan.filter((p) => p.action.kind === "skip");
    expect(skipped).toHaveLength(2);
    for (const entry of skipped) {
      if (entry.action.kind === "skip") {
        expect(entry.action.reason).toContain("superseded by garmin-tokens");
      }
    }
  });

  it("lifts a garmin-tokens directory as a multi-file secret", () => {
    const garminDir = join(tree.dir, "garmin-tokens");
    mkdirSync(garminDir);
    writeFileSync(join(garminDir, "oauth1_token.json"), `{"token":"a"}`);
    writeFileSync(join(garminDir, "oauth2_token.json"), `{"refresh":"b"}`);

    const plan = planImport(tree.dir);
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
    writeFile(
      tree.dir,
      "secrets.env",
      "X_BEARER_TOKEN=aaa\nOPENROUTER_API_KEY=bbb\nUNKNOWN_KEY=ccc\n"
    );
    const plan = planImport(tree.dir);
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

  it("warns on unknown files instead of guessing", () => {
    writeFile(tree.dir, "mystery-file", "data");
    const plan = planImport(tree.dir);
    expect(plan[0].action.kind).toBe("warn");
    if (plan[0].action.kind === "warn") {
      expect(plan[0].action.reason).toContain("unknown file");
    }
  });

  it("warns on unknown subdirectories instead of guessing", () => {
    mkdirSync(join(tree.dir, "mystery-dir"));
    const plan = planImport(tree.dir);
    expect(plan[0].action.kind).toBe("warn");
    if (plan[0].action.kind === "warn") {
      expect(plan[0].action.reason).toContain("unknown directory");
    }
  });

  it("returns entries in a stable (sorted) order", () => {
    writeFile(tree.dir, "notion-api-key", "n1");
    writeFile(tree.dir, "anthropic-personal-api-key", "a1");
    writeFile(tree.dir, "buildkite-api-token", "b1");
    const plan = planImport(tree.dir);
    expect(plan.map((p) => p.sourceName)).toEqual([
      "anthropic-personal-api-key",
      "buildkite-api-token",
      "notion-api-key",
    ]);
  });

  it("throws when the source directory does not exist", () => {
    expect(() => planImport(join(tree.dir, "nope"))).toThrow(/not found/);
  });
});

describe("applyPlan", () => {
  let tree: SyntheticTree;
  let vaultPath: string;
  const passphrase = "test-import-pass";

  beforeEach(() => {
    tree = makeTree();
    vaultPath = join(tree.dir, "vault.enc");
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
