import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  accountDir,
  accountCredentialsPath,
  accountExists,
  accountHealth,
  accountMetaPath,
  accountsRoot,
  getAccountInfos,
  listAccounts,
  patchAccountMeta,
  readAccountCredentials,
  readAccountMeta,
  removeAccount,
  renameAccount,
  validateAccountLabel,
  writeAccountCredentials,
  writeAccountMeta,
  type AccountCredentials,
} from "../src/auth/account-store.js";

let home: string;

beforeEach(() => {
  home = resolve(
    tmpdir(),
    `switchroom-acct-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("validateAccountLabel", () => {
  it("accepts valid labels", () => {
    expect(() => validateAccountLabel("default")).not.toThrow();
    expect(() => validateAccountLabel("work-pro")).not.toThrow();
    expect(() => validateAccountLabel("personal_max")).not.toThrow();
    expect(() => validateAccountLabel("ken.example.com")).not.toThrow();
    expect(() => validateAccountLabel("a")).not.toThrow();
  });

  it("accepts email-shaped labels (@ + . _ - allowed)", () => {
    // The headline reason for allowing @: operators want to label
    // accounts by the Anthropic email they signed up with.
    expect(() => validateAccountLabel("pixsoul@gmail.com")).not.toThrow();
    expect(() => validateAccountLabel("ken+work@example.com")).not.toThrow();
    expect(() => validateAccountLabel("a@b")).not.toThrow();
    expect(() => validateAccountLabel("user.name+tag@subdomain.example.co")).not.toThrow();
  });

  it("rejects empty / overlong", () => {
    expect(() => validateAccountLabel("")).toThrow();
    expect(() => validateAccountLabel("a".repeat(65))).toThrow();
  });

  it("rejects path-traversal shapes", () => {
    expect(() => validateAccountLabel(".")).toThrow();
    expect(() => validateAccountLabel("..")).toThrow();
    expect(() => validateAccountLabel("foo/bar")).toThrow();
    expect(() => validateAccountLabel("foo\\bar")).toThrow();
  });

  it("rejects invalid characters", () => {
    expect(() => validateAccountLabel("foo bar")).toThrow();
    // `:` would corrupt callback_data parsing in the Telegram dashboard.
    expect(() => validateAccountLabel("foo:bar")).toThrow();
    expect(() => validateAccountLabel("foo!")).toThrow();
    // Quotes / shell metas / control chars stay out.
    expect(() => validateAccountLabel("foo\"bar")).toThrow();
    expect(() => validateAccountLabel("foo'bar")).toThrow();
    expect(() => validateAccountLabel("foo;rm -rf")).toThrow();
    expect(() => validateAccountLabel("foo|bar")).toThrow();
    expect(() => validateAccountLabel("foo&bar")).toThrow();
    expect(() => validateAccountLabel("foo<bar")).toThrow();
    expect(() => validateAccountLabel("foo>bar")).toThrow();
    // Unicode lookalikes — keep ASCII for filesystem + regex sanity.
    expect(() => validateAccountLabel("fooébar")).toThrow(); // é
    expect(() => validateAccountLabel("ken@gmaіl.com")).toThrow(); // Cyrillic і
  });
});

describe("path helpers", () => {
  it("resolve under ~/.switchroom/accounts/<label>/", () => {
    expect(accountsRoot(home)).toBe(resolve(home, ".switchroom", "accounts"));
    expect(accountDir("foo", home)).toBe(
      resolve(home, ".switchroom", "accounts", "foo"),
    );
    expect(accountCredentialsPath("foo", home)).toBe(
      resolve(home, ".switchroom", "accounts", "foo", "credentials.json"),
    );
    expect(accountMetaPath("foo", home)).toBe(
      resolve(home, ".switchroom", "accounts", "foo", "meta.json"),
    );
  });
});

describe("listAccounts", () => {
  it("returns [] when accounts dir is missing", () => {
    expect(listAccounts(home)).toEqual([]);
  });

  it("returns sorted list of subdirectories", () => {
    writeAccountCredentials("zeta", { claudeAiOauth: { accessToken: "x" } }, home);
    writeAccountCredentials("alpha", { claudeAiOauth: { accessToken: "y" } }, home);
    writeAccountCredentials("mu", { claudeAiOauth: { accessToken: "z" } }, home);
    expect(listAccounts(home)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("ignores stray files in the accounts root", () => {
    writeAccountCredentials("real", { claudeAiOauth: { accessToken: "x" } }, home);
    writeFileSync(
      resolve(accountsRoot(home), "stray.txt"),
      "not an account\n",
    );
    expect(listAccounts(home)).toEqual(["real"]);
  });
});

describe("credentials roundtrip", () => {
  it("write then read returns the same shape", () => {
    const creds: AccountCredentials = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-aaaa",
        refreshToken: "sk-ant-ort01-bbbb",
        expiresAt: 1_700_000_000_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    };
    writeAccountCredentials("work-pro", creds, home);
    expect(readAccountCredentials("work-pro", home)).toEqual(creds);
    expect(accountExists("work-pro", home)).toBe(true);
  });

  it("returns null when credentials are absent", () => {
    expect(readAccountCredentials("nope", home)).toBeNull();
    expect(accountExists("nope", home)).toBe(false);
  });

  it("returns null when credentials are malformed JSON", () => {
    mkdirSync(accountDir("broken", home), { recursive: true });
    writeFileSync(accountCredentialsPath("broken", home), "{ not: json");
    expect(readAccountCredentials("broken", home)).toBeNull();
  });
});

describe("meta roundtrip + patch", () => {
  it("write then read returns the same shape", () => {
    writeAccountMeta(
      "work-pro",
      {
        createdAt: 1000,
        email: "ken@example.com",
        subscriptionType: "max",
        lastRefreshedAt: 2000,
      },
      home,
    );
    expect(readAccountMeta("work-pro", home)).toEqual({
      createdAt: 1000,
      email: "ken@example.com",
      subscriptionType: "max",
      lastRefreshedAt: 2000,
    });
  });

  it("patchAccountMeta merges fields, preserving the rest", () => {
    writeAccountMeta(
      "work-pro",
      { createdAt: 1000, email: "ken@example.com" },
      home,
    );
    patchAccountMeta(
      "work-pro",
      { lastRefreshedAt: 9999, quotaExhaustedUntil: 8888 },
      home,
    );
    expect(readAccountMeta("work-pro", home)).toEqual({
      createdAt: 1000,
      email: "ken@example.com",
      lastRefreshedAt: 9999,
      quotaExhaustedUntil: 8888,
    });
  });

  it("patchAccountMeta on a missing meta synthesises createdAt", () => {
    patchAccountMeta("fresh", { email: "x@y.z" }, home);
    const meta = readAccountMeta("fresh", home);
    expect(meta?.email).toBe("x@y.z");
    expect(typeof meta?.createdAt).toBe("number");
  });
});

describe("accountHealth", () => {
  const NOW = 1_700_000_000_000;

  it("returns missing-credentials when no token file", () => {
    expect(accountHealth("ghost", NOW, home)).toBe("missing-credentials");
  });

  it("returns missing-credentials when accessToken is empty", () => {
    writeAccountCredentials("ghost", { claudeAiOauth: {} }, home);
    expect(accountHealth("ghost", NOW, home)).toBe("missing-credentials");
  });

  it("returns healthy when token is fresh and no quota mark", () => {
    writeAccountCredentials(
      "live",
      {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "y",
          expiresAt: NOW + 60 * 60 * 1000,
        },
      },
      home,
    );
    expect(accountHealth("live", NOW, home)).toBe("healthy");
  });

  it("returns quota-exhausted when meta says so", () => {
    writeAccountCredentials(
      "live",
      {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "y",
          expiresAt: NOW + 60 * 60 * 1000,
        },
      },
      home,
    );
    writeAccountMeta(
      "live",
      { createdAt: NOW, quotaExhaustedUntil: NOW + 30 * 60 * 1000 },
      home,
    );
    expect(accountHealth("live", NOW, home)).toBe("quota-exhausted");
  });

  it("quota mark in the past does not count as exhausted", () => {
    writeAccountCredentials(
      "live",
      {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "y",
          expiresAt: NOW + 60 * 60 * 1000,
        },
      },
      home,
    );
    writeAccountMeta(
      "live",
      { createdAt: NOW, quotaExhaustedUntil: NOW - 1 },
      home,
    );
    expect(accountHealth("live", NOW, home)).toBe("healthy");
  });

  it("returns expired when access token expired and refresh present", () => {
    writeAccountCredentials(
      "stale",
      {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "y",
          expiresAt: NOW - 1,
        },
      },
      home,
    );
    expect(accountHealth("stale", NOW, home)).toBe("expired");
  });

  it("returns missing-refresh-token when expired and no refresh", () => {
    writeAccountCredentials(
      "dead",
      { claudeAiOauth: { accessToken: "x", expiresAt: NOW - 1 } },
      home,
    );
    expect(accountHealth("dead", NOW, home)).toBe("missing-refresh-token");
  });
});

describe("getAccountInfos", () => {
  it("merges credentials + meta into one row per account", () => {
    const NOW = 1_700_000_000_000;
    writeAccountCredentials(
      "work-pro",
      {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "y",
          expiresAt: NOW + 60 * 60 * 1000,
          subscriptionType: "max",
        },
      },
      home,
    );
    writeAccountMeta(
      "work-pro",
      { createdAt: NOW - 1000, email: "ken@example.com", lastRefreshedAt: NOW - 500 },
      home,
    );
    writeAccountCredentials(
      "personal",
      { claudeAiOauth: { accessToken: "p" } },
      home,
    );

    const infos = getAccountInfos(NOW, home);
    expect(infos).toHaveLength(2);
    const work = infos.find((i) => i.label === "work-pro")!;
    expect(work.health).toBe("healthy");
    expect(work.email).toBe("ken@example.com");
    expect(work.subscriptionType).toBe("max");
    expect(work.lastRefreshedAt).toBe(NOW - 500);

    const personal = infos.find((i) => i.label === "personal")!;
    // missing expiresAt → not expired path; healthy if accessToken present + no quota
    expect(personal.health).toBe("healthy");
    expect(personal.subscriptionType).toBeUndefined();
  });
});

describe("removeAccount", () => {
  it("deletes the account directory", () => {
    writeAccountCredentials("doomed", { claudeAiOauth: { accessToken: "x" } }, home);
    writeAccountMeta("doomed", { createdAt: 1 }, home);
    expect(accountExists("doomed", home)).toBe(true);
    removeAccount("doomed", home);
    expect(accountExists("doomed", home)).toBe(false);
    expect(listAccounts(home)).not.toContain("doomed");
  });

  it("throws when account does not exist", () => {
    expect(() => removeAccount("ghost", home)).toThrow(/does not exist/);
  });

  it("validates the label", () => {
    expect(() => removeAccount("../etc", home)).toThrow();
  });
});

describe("atomic write — no tempfile remnants on success", () => {
  it("leaves only the destination file in the dir", () => {
    writeAccountCredentials("clean", { claudeAiOauth: { accessToken: "x" } }, home);
    writeAccountMeta("clean", { createdAt: 1 }, home);
    const entries = readdirSync(accountDir("clean", home)).sort();
    expect(entries).toEqual(["credentials.json", "meta.json"]);
  });
});

describe("renameAccount", () => {
  it("moves the account directory + preserves credentials and meta", () => {
    writeAccountCredentials(
      "old-label",
      { claudeAiOauth: { accessToken: "sk-ant-oat01-keep" } },
      home,
    );
    writeAccountMeta(
      "old-label",
      { createdAt: 12345, email: "ken@example.com" },
      home,
    );
    renameAccount("old-label", "new-label", home);
    expect(accountExists("old-label", home)).toBe(false);
    expect(accountExists("new-label", home)).toBe(true);
    expect(readAccountCredentials("new-label", home)?.claudeAiOauth?.accessToken).toBe(
      "sk-ant-oat01-keep",
    );
    expect(readAccountMeta("new-label", home)?.email).toBe("ken@example.com");
  });

  it("refuses when source does not exist", () => {
    expect(() => renameAccount("ghost", "anything", home)).toThrow(/does not exist/);
  });

  it("refuses when destination already exists (no silent merge)", () => {
    writeAccountCredentials(
      "src",
      { claudeAiOauth: { accessToken: "src-tok" } },
      home,
    );
    writeAccountCredentials(
      "dest",
      { claudeAiOauth: { accessToken: "dest-tok" } },
      home,
    );
    expect(() => renameAccount("src", "dest", home)).toThrow(
      /an account with that label already exists/,
    );
    // Both untouched.
    expect(readAccountCredentials("src", home)?.claudeAiOauth?.accessToken).toBe("src-tok");
    expect(readAccountCredentials("dest", home)?.claudeAiOauth?.accessToken).toBe("dest-tok");
  });

  it("refuses no-op rename (same label)", () => {
    writeAccountCredentials("same", { claudeAiOauth: { accessToken: "x" } }, home);
    expect(() => renameAccount("same", "same", home)).toThrow(/already has that name/);
  });

  it("validates both labels", () => {
    writeAccountCredentials("legit", { claudeAiOauth: { accessToken: "x" } }, home);
    expect(() => renameAccount("../etc", "legit", home)).toThrow();
    expect(() => renameAccount("legit", "foo bar", home)).toThrow();
  });
});
