/**
 * Protective regression tests for Claude Code CLI native compatibility.
 *
 * Every assertion in this file pins ONE thing about how switchroom's
 * auth-broker integrates with Claude Code's native OAuth filesystem
 * contract. If a future refactor (or a future Claude release) breaks
 * any of them, CI fails here BEFORE agents silently lose authentication
 * in production.
 *
 * Why a dedicated file: the regression in PR #1254 — broker writing
 * `credentials.json` (no dot) instead of `.credentials.json` (dotfile)
 * — survived RFC review, three reviewer rounds, full implementation, AND
 * the post-implementation reviewer, because the existing tests verified
 * that the broker wrote A file, not that it wrote the RIGHT file. The
 * contract with the external claude binary needs explicit pins.
 *
 * Contract surface (each → an `it()` below):
 *
 *   1. Per-agent mirror lives at `<CLAUDE_CONFIG_DIR>/.credentials.json`
 *      (dotfile). Verified end-to-end via the broker.
 *
 *   2. File shape is `{ claudeAiOauth: { accessToken, refreshToken,
 *      expiresAt, ... } }` — the shape `claude setup-token` writes.
 *
 *   3. File mode is 0600 (owner read/write only). Per Linux standard
 *      for secret-bearing dotfiles.
 *
 *   4. The scaffolded `start.sh` exports
 *      `CLAUDE_CONFIG_DIR=<agentDir>/.claude` so claude actually looks
 *      where the broker writes.
 *
 *   5. The broker's per-agent mirror path matches what the scaffold's
 *      CLAUDE_CONFIG_DIR + `.credentials.json` resolves to. The two
 *      sides of the contract MUST agree.
 *
 *   6. (Runtime-gated) The on-disk `claude` binary's string table
 *      contains the exact literal `.credentials.json`. If a future
 *      claude release renames the file (e.g. to `credentials.json`),
 *      this fails first — operators can pin the previous claude
 *      version and retest the broker before upgrading. Skipped when
 *      `claude` is not on PATH (most dev/CI environments).
 *
 * NB: do NOT delete these tests "to clean up." Every one of them
 * corresponds to a known failure mode that has actually bitten the
 * fleet or that the binary's contract makes possible.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import { writeAccountCredentials } from "../account-store.js";
import type { SwitchroomConfig } from "../../config/schema.js";

/* ─── Harness ──────────────────────────────────────────────────── */

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-compat-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try { rmSync(h.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  harnesses = [];
});

function makeConfig(h: Harness, agents: string[]): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: Object.fromEntries(agents.map((a) => [a, {}])),
    auth: { active: "default", admin_agents: agents },
  } as unknown) as SwitchroomConfig;
}

function seedDefault(h: Harness): void {
  writeAccountCredentials(
    "default",
    {
      claudeAiOauth: {
        accessToken: "at-default-XYZ",
        refreshToken: "rt-default-XYZ",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    h.home,
  );
}

async function rpc(socketPath: string, req: object): Promise<unknown> {
  return await new Promise<unknown>((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error): void => {
      if (settled) return;
      settled = true;
      try { c.destroy(); } catch { /* ignore */ }
      if (err) rejectP(err); else resolveP(v);
    };
    c.on("connect", () => {
      c.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        try { settle(decodeResponse(line)); } catch (err) { settle(null, err as Error); }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

async function bootBrokerAndFanout(h: Harness, agentName: string): Promise<AuthBroker> {
  const config = makeConfig(h, [agentName]);
  seedDefault(h);
  mkdirSync(join(h.agentsDir, agentName), { recursive: true });
  const broker = new AuthBroker(config, {
    home: h.home,
    stateDir: h.stateDir,
    socketRoot: h.socketRoot,
    disableRefreshLoop: true,
  });
  await broker.start();
  // Trigger a fanout by re-asserting the active account.
  await rpc(join(h.socketRoot, agentName, "sock"), {
    v: 1,
    id: "1",
    op: "set-active",
    account: "default",
  });
  return broker;
}

/* ─── Tests ────────────────────────────────────────────────────── */

describe("Claude CLI compatibility — contract pins", () => {
  it("(1) per-agent mirror file is named `.credentials.json` (dotfile)", async () => {
    const h = makeHarness();
    const broker = await bootBrokerAndFanout(h, "ziggy");
    const dotfile = join(h.agentsDir, "ziggy", ".claude", ".credentials.json");
    const nondotfile = join(h.agentsDir, "ziggy", ".claude", "credentials.json");
    expect(existsSync(dotfile)).toBe(true);
    // No double-write: the non-dot path must NOT exist. A refactor that
    // wrote both "for safety" would mask a future filename regression.
    expect(existsSync(nondotfile)).toBe(false);
    broker.stop();
  });

  it("(2) per-agent mirror has the claudeAiOauth shape claude setup-token produces", async () => {
    const h = makeHarness();
    const broker = await bootBrokerAndFanout(h, "ziggy");
    const dotfile = join(h.agentsDir, "ziggy", ".claude", ".credentials.json");
    const parsed = JSON.parse(readFileSync(dotfile, "utf-8")) as {
      claudeAiOauth?: {
        accessToken?: unknown;
        refreshToken?: unknown;
        expiresAt?: unknown;
        scopes?: unknown;
      };
    };
    // Top-level key is `claudeAiOauth` — this is the discriminator
    // claude reads for OAuth-mode credentials. A refactor that wrote
    // a different envelope (e.g. flat `{accessToken: ...}`) would
    // silently break auth.
    expect(parsed).toHaveProperty("claudeAiOauth");
    expect(typeof parsed.claudeAiOauth).toBe("object");
    expect(typeof parsed.claudeAiOauth?.accessToken).toBe("string");
    expect((parsed.claudeAiOauth?.accessToken as string).length).toBeGreaterThan(0);
    expect(typeof parsed.claudeAiOauth?.refreshToken).toBe("string");
    expect(typeof parsed.claudeAiOauth?.expiresAt).toBe("number");
    // scopes is an array (claude inspects this for the user:inference scope)
    expect(Array.isArray(parsed.claudeAiOauth?.scopes)).toBe(true);
    broker.stop();
  });

  it("(3) per-agent mirror has mode 0600 (owner read/write only)", async () => {
    const h = makeHarness();
    const broker = await bootBrokerAndFanout(h, "ziggy");
    const dotfile = join(h.agentsDir, "ziggy", ".claude", ".credentials.json");
    const st = statSync(dotfile);
    // Mask off non-permission bits. Mode must be exactly 0o600. A
    // refactor that landed 0644 would expose tokens to any reader on
    // the host (vault-broker has caused this class of bug before; the
    // 0600 stance is intentional).
    expect(st.mode & 0o777).toBe(0o600);
    broker.stop();
  });

  it("(4) scaffold's start.sh exports CLAUDE_CONFIG_DIR=<agentDir>/.claude", async () => {
    // We don't scaffold an agent in this test (that pulls in a lot of
    // unrelated machinery). Instead we read the template source and
    // pin the line. If the export form changes (different env name,
    // different path shape, different quoting), this fires.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const startShPath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "profiles",
      "_base",
      "start.sh.hbs",
    );
    const startSh = fs.readFileSync(startShPath, "utf-8");
    // Must export CLAUDE_CONFIG_DIR pointing at <agentDir>/.claude.
    // The {{agentDir}} placeholder is the Handlebars template variable
    // that scaffold.ts substitutes per-agent. A refactor that switched
    // to e.g. `CLAUDE_HOME` or used a flat `~/.claude` would break the
    // broker's per-agent mirror discovery.
    expect(startSh).toMatch(/^export CLAUDE_CONFIG_DIR="\{\{agentDir\}\}\/\.claude"$/m);
  });

  it("(5) broker write path matches CLAUDE_CONFIG_DIR + .credentials.json", async () => {
    // The contract: scaffold sets CLAUDE_CONFIG_DIR=<agentDir>/.claude,
    // broker writes <agentDir>/.claude/.credentials.json, claude
    // reads $CLAUDE_CONFIG_DIR/.credentials.json. The three must
    // agree path-wise.
    const h = makeHarness();
    const broker = await bootBrokerAndFanout(h, "ziggy");

    // Derive the path the way claude would, given the scaffold's env:
    const claudeConfigDir = join(h.agentsDir, "ziggy", ".claude");
    const claudeReadsFrom = join(claudeConfigDir, ".credentials.json");

    // Verify the broker actually wrote that exact path. (Doesn't just
    // verify the file exists — verifies the broker's write matches the
    // scaffold's env-derived read path.)
    expect(existsSync(claudeReadsFrom)).toBe(true);

    // And content-wise: the file claude would open must contain the
    // broker's expected access token (i.e. there's no parallel
    // contradictory file somewhere else).
    const content = JSON.parse(readFileSync(claudeReadsFrom, "utf-8"));
    expect(content.claudeAiOauth.accessToken).toBe("at-default-XYZ");
    broker.stop();
  });

  it("(6) the on-disk claude binary uses `.credentials.json` (runtime gate)", () => {
    // Resolve the claude binary on PATH. If absent, skip — most dev
    // shells and minimal CI runners don't have it. CI environments
    // that do have claude installed will fail this test FIRST if a
    // future claude release renames the file (e.g. drops the dot).
    // Operators can then pin the prior claude version, validate the
    // broker against the new filename, and lift the pin.
    let claudePath: string;
    try {
      claudePath = execFileSync("which", ["claude"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      // PATH lookup failed — claude not installed in this environment.
      return;
    }
    if (!claudePath) return;

    let resolved: string;
    try {
      resolved = execFileSync("readlink", ["-f", claudePath], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      resolved = claudePath;
    }
    if (!existsSync(resolved)) return;

    // Use `strings` to scan the binary's literal table. Skipping
    // gracefully if `strings` isn't installed (containers without
    // binutils).
    let stringsOut: string;
    try {
      stringsOut = execFileSync(
        "sh",
        ["-c", `strings ${JSON.stringify(resolved)} | grep -c '"\\.credentials\\.json"' || true`],
        { stdio: ["ignore", "pipe", "ignore"] },
      ).toString();
    } catch {
      return; // strings unavailable
    }

    const count = parseInt(stringsOut.trim(), 10);
    // Either we found the literal, or we couldn't run strings — both
    // are acceptable. The fail case is "we ran strings successfully
    // AND found zero occurrences" — that means upstream claude no
    // longer treats `.credentials.json` as the canonical name.
    if (!Number.isNaN(count)) {
      expect(count).toBeGreaterThan(0);
    }
  });
});

/* ─── End-to-end: write our mirror, run claude --help, expect no auth complaint
 *
 * Deferred. Would require:
 *   1. `claude` on PATH (already gated above).
 *   2. `claude --help` to not phone home / not require network.
 *   3. A way to assert "no auth complaint" without coupling to claude's
 *      output format.
 * Reasonable to add when the test fixture stops being flaky. For now
 * the static contract pins above catch the load-bearing regressions.
 * ────────────────────────────────────────────────────────────────── */
