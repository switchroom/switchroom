import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

import {
  enabledAgentsForAccount,
  fanoutAccountToAgents,
  refreshAccountIfNeeded,
  refreshAllAccounts,
  type Fetcher,
} from "../src/auth/account-refresh.js";
import {
  readAccountCredentials,
  readAccountMeta,
  writeAccountCredentials,
} from "../src/auth/account-store.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

let home: string;
let agentsDir: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = resolve(tmpdir(), `switchroom-acct-refresh-${stamp}`);
  mkdirSync(home, { recursive: true });
  agentsDir = resolve(home, "agents");
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

const okFetcher = (
  body: Record<string, unknown>,
  status = 200,
): Fetcher =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

const errFetcher = (status: number, body: string): Fetcher =>
  async () => ({
    ok: false,
    status,
    text: async () => body,
  });

const throwingFetcher: Fetcher = async () => {
  throw new Error("network down");
};

describe("refreshAccountIfNeeded — skip paths", () => {
  it("skipped-no-credentials when account doesn't exist", async () => {
    const out = await refreshAccountIfNeeded("ghost", { now: () => NOW, home });
    expect(out.kind).toBe("skipped-no-credentials");
  });

  it("skipped-malformed when accessToken missing", async () => {
    writeAccountCredentials("a", { claudeAiOauth: {} }, home);
    const out = await refreshAccountIfNeeded("a", { now: () => NOW, home });
    expect(out.kind).toBe("skipped-malformed");
  });

  it("skipped-malformed when expiresAt is not a number", async () => {
    writeAccountCredentials(
      "a",
      // @ts-expect-error - intentionally bad shape
      { claudeAiOauth: { accessToken: "x", expiresAt: "soon" } },
      home,
    );
    const out = await refreshAccountIfNeeded("a", { now: () => NOW, home });
    expect(out.kind).toBe("skipped-malformed");
  });

  it("skipped-fresh when token has plenty of life left", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "r",
          expiresAt: NOW + 4 * 60 * 60 * 1000, // 4 hours
        },
      },
      home,
    );
    const out = await refreshAccountIfNeeded("a", { now: () => NOW, home });
    expect(out.kind).toBe("skipped-fresh");
  });

  it("skipped-no-refresh-token when expiring soon but no refresh token", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "x",
          expiresAt: NOW + 5 * 60 * 1000, // 5 minutes
        },
      },
      home,
    );
    const out = await refreshAccountIfNeeded("a", { now: () => NOW, home });
    expect(out.kind).toBe("skipped-no-refresh-token");
  });
});

describe("refreshAccountIfNeeded — refresh path", () => {
  it("refreshes and writes new credentials when expiring soon", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    const out = await refreshAccountIfNeeded("a", {
      now: () => NOW,
      home,
      fetcher: okFetcher({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      }),
    });
    expect(out.kind).toBe("refreshed");
    if (out.kind !== "refreshed") return;
    expect(out.newExpiresAt).toBe(NOW + 28800 * 1000);

    const written = readAccountCredentials("a", home);
    expect(written?.claudeAiOauth?.accessToken).toBe("new-access");
    expect(written?.claudeAiOauth?.refreshToken).toBe("new-refresh");
    expect(written?.claudeAiOauth?.expiresAt).toBe(NOW + 28800 * 1000);

    const meta = readAccountMeta("a", home);
    expect(meta?.lastRefreshedAt).toBe(NOW);
  });

  it("preserves old refreshToken when Anthropic does not rotate it", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "old",
          refreshToken: "keep-me",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    const out = await refreshAccountIfNeeded("a", {
      now: () => NOW,
      home,
      fetcher: okFetcher({ access_token: "new", expires_in: 3600 }),
    });
    expect(out.kind).toBe("refreshed");
    expect(readAccountCredentials("a", home)?.claudeAiOauth?.refreshToken).toBe(
      "keep-me",
    );
  });
});

describe("refreshAccountIfNeeded — failure path", () => {
  it("returns failed on network error", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "old",
          refreshToken: "r",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    const out = await refreshAccountIfNeeded("a", {
      now: () => NOW,
      home,
      fetcher: throwingFetcher,
    });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.error).toContain("network down");
  });

  it("returns failed on HTTP 401", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "old",
          refreshToken: "r",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    const out = await refreshAccountIfNeeded("a", {
      now: () => NOW,
      home,
      fetcher: errFetcher(401, "invalid_grant"),
    });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.httpStatus).toBe(401);
  });

  it("returns failed when response missing access_token", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "old",
          refreshToken: "r",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    const out = await refreshAccountIfNeeded("a", {
      now: () => NOW,
      home,
      fetcher: okFetcher({ expires_in: 3600 }),
    });
    expect(out.kind).toBe("failed");
  });

  it("does NOT clobber existing credentials on a failed refresh", async () => {
    writeAccountCredentials(
      "a",
      {
        claudeAiOauth: {
          accessToken: "untouchable",
          refreshToken: "r",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    await refreshAccountIfNeeded("a", {
      now: () => NOW,
      home,
      fetcher: errFetcher(500, "server-error"),
    });
    expect(readAccountCredentials("a", home)?.claudeAiOauth?.accessToken).toBe(
      "untouchable",
    );
  });
});

describe("fanoutAccountToAgents", () => {
  it("copies credentials.json to each enabled agent", () => {
    writeAccountCredentials(
      "work-pro",
      {
        claudeAiOauth: {
          accessToken: "shared-token",
          refreshToken: "r",
          expiresAt: NOW + 60 * 60 * 1000,
        },
      },
      home,
    );
    const fooDir = join(agentsDir, "foo");
    const barDir = join(agentsDir, "bar");
    mkdirSync(fooDir, { recursive: true });
    mkdirSync(barDir, { recursive: true });

    const outcomes = fanoutAccountToAgents(
      "work-pro",
      [
        { name: "foo", agentDir: fooDir },
        { name: "bar", agentDir: barDir },
      ],
      { home },
    );
    expect(outcomes.every((o) => o.kind === "fanned-out")).toBe(true);

    const fooCreds = JSON.parse(
      readFileSync(join(fooDir, ".claude", "credentials.json"), "utf-8"),
    );
    expect(fooCreds.claudeAiOauth.accessToken).toBe("shared-token");
    const barCreds = JSON.parse(
      readFileSync(join(barDir, ".claude", "credentials.json"), "utf-8"),
    );
    expect(barCreds.claudeAiOauth.accessToken).toBe("shared-token");
  });

  it("also writes the legacy .oauth-token + meta mirrors so start.sh sees the new token", () => {
    writeAccountCredentials(
      "work-pro",
      {
        claudeAiOauth: {
          accessToken: "current-access",
          refreshToken: "r",
          expiresAt: NOW + 60 * 60 * 1000,
        },
      },
      home,
    );
    const fooDir = join(agentsDir, "foo");
    mkdirSync(fooDir, { recursive: true });

    fanoutAccountToAgents(
      "work-pro",
      [{ name: "foo", agentDir: fooDir }],
      { home },
    );

    const oauthTokenPath = join(fooDir, ".claude", ".oauth-token");
    const oauthMetaPath = join(fooDir, ".claude", ".oauth-token.meta.json");
    expect(readFileSync(oauthTokenPath, "utf-8").trim()).toBe("current-access");
    const meta = JSON.parse(readFileSync(oauthMetaPath, "utf-8"));
    expect(meta.source).toBe("account:work-pro");
    expect(typeof meta.expiresAt).toBe("number");
  });

  it("does NOT write legacy mirror when account credentials lack accessToken", () => {
    writeAccountCredentials("broken", { claudeAiOauth: {} }, home);
    const fooDir = join(agentsDir, "foo");
    mkdirSync(fooDir, { recursive: true });

    const outcomes = fanoutAccountToAgents(
      "broken",
      [{ name: "foo", agentDir: fooDir }],
      { home },
    );
    // The credentials.json itself does fan out (caller can deal with the
    // empty oauth block), but the legacy mirror that would inject a
    // garbage env var stays untouched.
    expect(outcomes[0].kind).toBe("fanned-out");
    expect(
      existsSync(join(fooDir, ".claude", ".oauth-token")),
    ).toBe(false);
  });

  it("agent file is bit-identical to the global file", () => {
    writeAccountCredentials(
      "work-pro",
      {
        claudeAiOauth: {
          accessToken: "abc",
          refreshToken: "def",
          expiresAt: NOW + 60 * 60 * 1000,
          scopes: ["user:inference"],
        },
      },
      home,
    );
    const fooDir = join(agentsDir, "foo");
    mkdirSync(fooDir, { recursive: true });

    fanoutAccountToAgents(
      "work-pro",
      [{ name: "foo", agentDir: fooDir }],
      { home },
    );

    const globalContent = readFileSync(
      join(home, ".switchroom", "accounts", "work-pro", "credentials.json"),
      "utf-8",
    );
    const agentContent = readFileSync(
      join(fooDir, ".claude", "credentials.json"),
      "utf-8",
    );
    expect(agentContent).toBe(globalContent);
  });

  it("skips fanout when agent dir does not exist", () => {
    writeAccountCredentials(
      "a",
      { claudeAiOauth: { accessToken: "x" } },
      home,
    );
    const outcomes = fanoutAccountToAgents(
      "a",
      [{ name: "ghost", agentDir: join(agentsDir, "ghost") }],
      { home },
    );
    expect(outcomes[0].kind).toBe("fanout-skipped-no-agent-dir");
  });

  it("fails fanout when account credentials are missing", () => {
    const fooDir = join(agentsDir, "foo");
    mkdirSync(fooDir, { recursive: true });
    const outcomes = fanoutAccountToAgents(
      "ghost-account",
      [{ name: "foo", agentDir: fooDir }],
      { home },
    );
    expect(outcomes[0].kind).toBe("fanout-failed");
  });
});

describe("enabledAgentsForAccount", () => {
  it("returns agents whose auth.accounts list includes the account", () => {
    const config = {
      agents: {
        foo: { auth: { accounts: ["work-pro", "personal"] } },
        bar: { auth: { accounts: ["personal"] } },
        baz: { auth: { accounts: ["work-pro"] } },
        qux: {},
      },
    } as unknown as SwitchroomConfig;

    const enabled = enabledAgentsForAccount("work-pro", config, agentsDir);
    expect(enabled.map((a) => a.name).sort()).toEqual(["baz", "foo"]);
    expect(enabled[0].agentDir.startsWith(agentsDir)).toBe(true);
  });

  it("returns [] when no agent uses the account", () => {
    const config = {
      agents: {
        foo: { auth: { accounts: ["other"] } },
      },
    } as unknown as SwitchroomConfig;
    expect(enabledAgentsForAccount("missing", config, agentsDir)).toEqual([]);
  });

  it("ignores agents without auth.accounts", () => {
    const config = {
      agents: { foo: {}, bar: { auth: {} } },
    } as unknown as SwitchroomConfig;
    expect(enabledAgentsForAccount("work-pro", config, agentsDir)).toEqual([]);
  });
});

describe("refreshAllAccounts", () => {
  it("fans out even when refresh was skipped-fresh (so newly enabled agents catch up)", async () => {
    writeAccountCredentials(
      "work-pro",
      {
        claudeAiOauth: {
          accessToken: "fresh",
          refreshToken: "r",
          expiresAt: NOW + 4 * 60 * 60 * 1000,
        },
      },
      home,
    );
    const fooDir = join(agentsDir, "foo");
    mkdirSync(fooDir, { recursive: true });

    // Build a minimal config object — only the fields refreshAllAccounts reads.
    const config = {
      switchroom: { agents_dir: agentsDir },
      agents: {
        foo: { auth: { accounts: ["work-pro"] } },
      },
    } as unknown as SwitchroomConfig;

    const summary = await refreshAllAccounts(config, {
      now: () => NOW,
      home,
    });

    expect(summary.counts.skippedFresh).toBe(1);
    expect(summary.counts.fannedOut).toBe(1);

    const agentCreds = JSON.parse(
      readFileSync(join(fooDir, ".claude", "credentials.json"), "utf-8"),
    );
    expect(agentCreds.claudeAiOauth.accessToken).toBe("fresh");
  });

  it("counts are accurate across mixed outcomes", async () => {
    writeAccountCredentials(
      "fresh",
      {
        claudeAiOauth: {
          accessToken: "x",
          refreshToken: "r",
          expiresAt: NOW + 4 * 60 * 60 * 1000,
        },
      },
      home,
    );
    writeAccountCredentials(
      "needs-refresh",
      {
        claudeAiOauth: {
          accessToken: "old",
          refreshToken: "r",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    writeAccountCredentials(
      "no-refresh",
      {
        claudeAiOauth: {
          accessToken: "old",
          expiresAt: NOW + 5 * 60 * 1000,
        },
      },
      home,
    );
    const config = {
      switchroom: { agents_dir: agentsDir },
      agents: {},
    } as unknown as SwitchroomConfig;

    const summary = await refreshAllAccounts(config, {
      now: () => NOW,
      home,
      fetcher: okFetcher({ access_token: "new", expires_in: 3600 }),
    });

    expect(summary.counts.skippedFresh).toBe(1);
    expect(summary.counts.refreshed).toBe(1);
    expect(summary.counts.skippedNoRefreshToken).toBe(1);
    expect(summary.counts.fannedOut).toBe(0); // no enabled agents
  });
});
