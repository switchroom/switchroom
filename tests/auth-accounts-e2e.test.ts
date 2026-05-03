/**
 * End-to-end happy-path: a fresh install, adding two accounts, enabling
 * each on a different agent, running a refresh tick, and verifying every
 * consumer (parent claude env-var path AND subprocess credentials.json
 * fallback) sees the right token for its agent.
 *
 * Exercises the four modules the foundation PR introduces, composed:
 *   - account-store (storage)
 *   - account-refresh (refresh + fanout)
 *   - auth-accounts-yaml (YAML editor)
 *   - schema (auth.accounts field)
 *
 * Does NOT spawn a real `claude` subprocess — that would couple the test
 * to the user's installed claude CLI version. The proof here is that the
 * files the runtime depends on land in the right places with the right
 * contents; the runtime's behaviour against those files is covered by
 * the existing per-agent tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

import {
  fanoutAccountToAgents,
  refreshAllAccounts,
  type Fetcher,
} from "../src/auth/account-refresh.js";
import {
  accountCredentialsPath,
  accountExists,
  getAccountInfos,
  writeAccountCredentials,
} from "../src/auth/account-store.js";
import {
  appendAccountToAgent,
  getAccountsForAgent,
} from "../src/cli/auth-accounts-yaml.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

let home: string;
let agentsDir: string;
let yamlPath: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = resolve(tmpdir(), `switchroom-acct-e2e-${stamp}`);
  mkdirSync(home, { recursive: true });
  agentsDir = resolve(home, "agents");
  mkdirSync(agentsDir, { recursive: true });
  // Pre-create the agents the scenario references.
  for (const name of ["foo", "bar", "baz"]) {
    mkdirSync(join(agentsDir, name), { recursive: true });
  }
  yamlPath = resolve(home, "switchroom.yaml");
  writeFileSync(
    yamlPath,
    [
      "switchroom:",
      `  agents_dir: ${JSON.stringify(agentsDir)}`,
      "telegram:",
      "  bot_token: vault:telegram/bot",
      "agents:",
      "  foo:",
      "    topic_name: Foo",
      "  bar:",
      "    topic_name: Bar",
      "  baz:",
      "    topic_name: Baz",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

describe("end-to-end: two accounts, three agents, one tick", () => {
  it("delivers the right credentials to each consumer path", async () => {
    // 1. Operator runs `auth account add work-pro --from-credentials <path>`
    //    (simulated here via direct write — the CLI wrapper just routes to
    //    writeAccountCredentials).
    writeAccountCredentials(
      "work-pro",
      {
        claudeAiOauth: {
          accessToken: "work-token",
          refreshToken: "work-refresh",
          expiresAt: NOW + 4 * 60 * 60 * 1000, // 4h — well above the 1h refresh threshold
          subscriptionType: "max",
        },
      },
      home,
    );
    writeAccountCredentials(
      "personal",
      {
        claudeAiOauth: {
          accessToken: "personal-token",
          refreshToken: "personal-refresh",
          expiresAt: NOW + 4 * 60 * 60 * 1000,
          subscriptionType: "pro",
        },
      },
      home,
    );
    expect(accountExists("work-pro", home)).toBe(true);
    expect(accountExists("personal", home)).toBe(true);

    // 2. Operator runs `auth enable work-pro foo bar` and
    //    `auth enable personal baz` (simulated via YAML helpers + immediate
    //    fanout, mirroring the CLI's behaviour).
    let yaml = readFileSync(yamlPath, "utf-8");
    yaml = appendAccountToAgent(yaml, "foo", "work-pro");
    yaml = appendAccountToAgent(yaml, "bar", "work-pro");
    yaml = appendAccountToAgent(yaml, "baz", "personal");
    writeFileSync(yamlPath, yaml);

    expect(getAccountsForAgent(yaml, "foo")).toEqual(["work-pro"]);
    expect(getAccountsForAgent(yaml, "bar")).toEqual(["work-pro"]);
    expect(getAccountsForAgent(yaml, "baz")).toEqual(["personal"]);

    // Immediate fanout (the CLI does this without waiting for the refresh tick).
    fanoutAccountToAgents(
      "work-pro",
      [
        { name: "foo", agentDir: join(agentsDir, "foo") },
        { name: "bar", agentDir: join(agentsDir, "bar") },
      ],
      { home },
    );
    fanoutAccountToAgents(
      "personal",
      [{ name: "baz", agentDir: join(agentsDir, "baz") }],
      { home },
    );

    // 3. The cron tick runs (simulated via refreshAllAccounts on a config
    //    that mirrors the in-memory state).
    const config = {
      switchroom: { agents_dir: agentsDir },
      agents: {
        foo: { auth: { accounts: ["work-pro"] } },
        bar: { auth: { accounts: ["work-pro"] } },
        baz: { auth: { accounts: ["personal"] } },
      },
    } as unknown as SwitchroomConfig;
    const summary = await refreshAllAccounts(config, { now: () => NOW, home });

    // Both accounts had plenty of life left → skipped-fresh.
    expect(summary.counts.refreshed).toBe(0);
    expect(summary.counts.skippedFresh).toBe(2);
    // Fanout always runs — three agents, three fanouts.
    expect(summary.counts.fannedOut).toBe(3);

    // 4. Verify each agent dir has the right files (parent env-var path
    //    AND subprocess credentials.json fallback).
    const fooCreds = JSON.parse(
      readFileSync(join(agentsDir, "foo", ".claude", "credentials.json"), "utf-8"),
    );
    const barCreds = JSON.parse(
      readFileSync(join(agentsDir, "bar", ".claude", "credentials.json"), "utf-8"),
    );
    const bazCreds = JSON.parse(
      readFileSync(join(agentsDir, "baz", ".claude", "credentials.json"), "utf-8"),
    );

    expect(fooCreds.claudeAiOauth.accessToken).toBe("work-token");
    expect(barCreds.claudeAiOauth.accessToken).toBe("work-token");
    expect(bazCreds.claudeAiOauth.accessToken).toBe("personal-token");

    // Legacy .oauth-token mirror (for start.sh env-var injection) matches
    // the access token in credentials.json, per agent.
    expect(
      readFileSync(join(agentsDir, "foo", ".claude", ".oauth-token"), "utf-8").trim(),
    ).toBe("work-token");
    expect(
      readFileSync(join(agentsDir, "bar", ".claude", ".oauth-token"), "utf-8").trim(),
    ).toBe("work-token");
    expect(
      readFileSync(join(agentsDir, "baz", ".claude", ".oauth-token"), "utf-8").trim(),
    ).toBe("personal-token");

    // Per-agent .oauth-token vs .credentials.json access token agree —
    // this is the property that closes the parent/subprocess split-brain
    // class of bugs.
    for (const agent of ["foo", "bar", "baz"]) {
      const envVarToken = readFileSync(
        join(agentsDir, agent, ".claude", ".oauth-token"),
        "utf-8",
      ).trim();
      const fileToken = JSON.parse(
        readFileSync(join(agentsDir, agent, ".claude", "credentials.json"), "utf-8"),
      ).claudeAiOauth.accessToken;
      expect(envVarToken).toBe(fileToken);
    }

    // 5. Operator's view from `auth account list` reflects the fleet.
    const infos = getAccountInfos(NOW, home);
    expect(infos.find((i) => i.label === "work-pro")?.subscriptionType).toBe(
      "max",
    );
    expect(infos.find((i) => i.label === "personal")?.subscriptionType).toBe(
      "pro",
    );
  });

  it("propagates a refresh: new token reaches every enabled agent in one tick", async () => {
    writeAccountCredentials(
      "shared",
      {
        claudeAiOauth: {
          accessToken: "old",
          refreshToken: "r",
          expiresAt: NOW + 5 * 60 * 1000, // expiring soon → triggers refresh
        },
      },
      home,
    );

    // Wire two agents to the same account.
    let yaml = readFileSync(yamlPath, "utf-8");
    yaml = appendAccountToAgent(yaml, "foo", "shared");
    yaml = appendAccountToAgent(yaml, "bar", "shared");
    writeFileSync(yamlPath, yaml);

    const config = {
      switchroom: { agents_dir: agentsDir },
      agents: {
        foo: { auth: { accounts: ["shared"] } },
        bar: { auth: { accounts: ["shared"] } },
      },
    } as unknown as SwitchroomConfig;

    const fetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "shiny-new",
          refresh_token: "shiny-refresh",
          expires_in: 28800,
        }),
    });

    const summary = await refreshAllAccounts(config, {
      now: () => NOW,
      home,
      fetcher,
    });
    expect(summary.counts.refreshed).toBe(1);
    expect(summary.counts.fannedOut).toBe(2);

    // One Anthropic POST; both agents received the new token.
    for (const agent of ["foo", "bar"]) {
      const tok = JSON.parse(
        readFileSync(
          join(agentsDir, agent, ".claude", "credentials.json"),
          "utf-8",
        ),
      ).claudeAiOauth.accessToken;
      expect(tok).toBe("shiny-new");
    }

    // The global account file is the source of truth.
    const globalContent = readFileSync(
      accountCredentialsPath("shared", home),
      "utf-8",
    );
    expect(JSON.parse(globalContent).claudeAiOauth.accessToken).toBe("shiny-new");
  });
});
