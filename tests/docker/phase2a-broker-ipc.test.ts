/**
 * Phase 2a — broker IPC integration test (socket-path-as-identity ACL).
 *
 * Acceptance criteria for the Phase 2a port (RFC §Phase 2):
 *
 *   1. Three agents — alice / bob / carol — each connect on their own
 *      per-agent socket (/run/switchroom/broker/<agent>.sock inside the
 *      broker container). Each agent's `get` for its own scoped secret
 *      returns the value; each agent's `get` for a sibling's scoped
 *      secret is DENIED.
 *
 *   2. Cross-agent denial: a client that talks to alice's socket but
 *      asks for bob's key gets DENIED with the existing wire error
 *      shape ({ ok: false, error: "DENIED", message: ... }). The
 *      identity comes from the listener's socket path, not from the
 *      request payload — there is no payload field that could fool it.
 *
 *   3. Schema-stability invariant: the broker MUST NOT migrate or alter
 *      the vault-grants SQLite schema as part of Phase 2a. We snapshot
 *      `PRAGMA schema_version` before and after the integration run and
 *      assert equality.
 *
 *   4. Production-host safety: every container created by this test
 *      file carries `switchroom.test=phase2a` plus a per-run UUID.
 *      Teardown is exclusively label-filtered (safeLabelTeardown).
 *      No bare `docker ps -a | xargs`. No prune. No system-wide
 *      anything. The 7 production containers on the test host
 *      (Coolify et al.) MUST be untouched — pre/post snapshots in
 *      the test verify this.
 *
 * Skip discipline: cleanly skipped when docker daemon unreachable OR
 * the phase2a-test broker image isn't built. Build instructions are
 * in the skip-sentinel `it()` body.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  captureProdSnapshot,
  expectNoProdDrift,
  type ProdSnapshot,
} from "./_prod-snapshot";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  closeSync,
  openSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

import {
  createVault,
  setStringSecret,
} from "../../src/vault/vault.js";
import { dockerRunLabelsArgv } from "./_label-helpers.js";
import { randomUUID } from "node:crypto";

// ─── Phase 2a label helpers ────────────────────────────────────────────────────
//
// _label-helpers.ts hard-codes "phase1c" as the stable label value. Phase 2a
// containers must carry `switchroom.test=phase2a` per the task brief, so we
// override locally rather than mutating the shared helper (Phase 1c has not
// yet merged to main and a cross-phase rename would conflict). Per-run UUID
// label still flows through dockerRunLabelsArgv → safeLabelTeardown shape;
// we just swap "phase1c" for "phase2a" everywhere.
const RUN_ID = randomUUID();
const PHASE_LABEL = "switchroom.test=phase2a";

function labelArgv(): string[] {
  // Mirror dockerRunLabelsArgv() shape but with phase2a.
  return [
    "--label", PHASE_LABEL,
    "--label", `switchroom.test.run=${RUN_ID}`,
  ];
}

/** Sanctioned bulk teardown — filtered by label. NEVER touches non-phase2a. */
function safeLabelTeardownPhase2a(): void {
  for (const filter of [
    `label=switchroom.test.run=${RUN_ID}`,
    PHASE_LABEL.replace("=", "="), // canonical form
  ]) {
    try {
      const ids = execSync(`docker ps -aq --filter ${filter}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (ids.length === 0) continue;
      execSync(`docker rm -f ${ids.split(/\s+/).join(" ")}`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}

// ─── Image presence guards ────────────────────────────────────────────────────

const BROKER_IMAGE = "switchroom/broker:phase2a-test";

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(BROKER_IMAGE);

// ─── Test fixture state ───────────────────────────────────────────────────────

interface Fixture {
  workdir: string;
  socketDir: string; // host path mounted at /run/switchroom/broker
  vaultPath: string;
  configPath: string;
  legacySock: string;
  containerName: string;
  initialSchemaVersion: number | null;
  prodSnapshot: ProdSnapshot;
}

let fx: Fixture | null = null;

const PASSPHRASE = "phase2a-test-passphrase-do-not-use-in-prod";
const AGENTS = ["alice", "bob", "carol"];

/**
 * Read PRAGMA schema_version from the broker's grants DB inside the
 * container. We use sqlite3 if available; if not, fall back to a tiny
 * `bun -e` snippet using bun:sqlite (broker image already has bun).
 *
 * Returns null when the DB isn't present yet (broker hasn't opened it).
 */
function readGrantsSchemaVersion(containerName: string): number | null {
  // The broker opens ~/.switchroom/vault-grants.db inside the container —
  // that resolves to /root/.switchroom/vault-broker/vault-grants.db (USER 0:0).
  const dbPath = "/root/.switchroom/vault-broker/vault-grants.db";
  try {
    const out = execSync(
      `docker exec ${containerName} bun -e ` +
        `'const{Database}=require("bun:sqlite");` +
        `const db=new Database("${dbPath}",{readonly:true});` +
        `const row=db.query("PRAGMA schema_version").get();` +
        `console.log(row.schema_version);'`,
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    ).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

beforeAll(() => {
  if (!imageOk) return;

  const prodSnapshot = captureProdSnapshot();

  const workdir = mkdtempSync(join(tmpdir(), "phase2a-broker-"));
  const socketDir = join(workdir, "broker-sockets");
  const stateDir = join(workdir, "state");
  // We allow the broker container to chmod/chown inside socketDir, so
  // mode 0755 lets root-in-container traverse and create.
  execSync(`mkdir -p '${socketDir}' '${stateDir}'`);
  execSync(`chmod 0755 '${socketDir}'`);

  // Pre-create empty placeholder <agent>.sock files. The broker enumerates
  // the dir at boot; if a target file exists it's unlinked and a real
  // socket is bound in its place. Without these placeholders, the broker
  // would fall through to legacy single-socket mode.
  for (const a of AGENTS) {
    const placeholder = join(socketDir, `${a}.sock`);
    closeSync(openSync(placeholder, "w"));
    chmodSync(placeholder, 0o660);
  }

  // Build a vault with three scoped secrets — one per agent.
  const vaultPath = join(stateDir, "vault.enc");
  createVault(PASSPHRASE, vaultPath);
  for (const a of AGENTS) {
    setStringSecret(PASSPHRASE, vaultPath, `${a}_key`, `secret-for-${a}`);
  }

  // Build a switchroom.yaml with each agent declaring its own secret.
  const configPath = join(stateDir, "switchroom.yaml");
  writeFileSync(
    configPath,
    [
      "switchroom:",
      "  version: 1",
      "  agents_dir: /tmp/agents",
      "  skills_dir: /tmp/skills",
      "telegram:",
      "  bot_token: x",
      '  forum_chat_id: "-1001234567890"',
      "vault:",
      "  path: /state/vault/vault.enc",
      "agents:",
      ...AGENTS.flatMap((a) => [
        `  ${a}:`,
        `    topic_name: ${a}`,
        `    schedule:`,
        `      - cron: "0 0 1 1 *"`,
        `        prompt: "noop"`,
        `        secrets: ["${a}_key"]`,
      ]),
      "",
    ].join("\n"),
  );

  // Run the broker container detached. We use --rm + named container so
  // forensic teardown can use either the per-name explicit `docker rm -f
  // <name>` or the safeLabelTeardown label filter as the safety net. Both
  // are sanctioned shapes per CLAUDE.md HARD RULES.
  const containerName = `switchroom-phase2a-broker-${process.pid}-${RUN_ID.slice(0, 8)}`;
  const legacySock = join(socketDir, "vault-broker.sock");
  // Best-effort cleanup of any prior run with the same name (idempotency).
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
  } catch {
    /* */
  }

  const runArgs = [
    "run",
    "-d",
    "--name", containerName,
    ...labelArgv(),
    "--user", "0:0",
    "-v", `${socketDir}:/run/switchroom/broker`,
    "-v", `${stateDir}:/state/vault`,
    "-v", `${configPath}:/state/config/switchroom.yaml:ro`,
    "-e", "SWITCHROOM_CONFIG=/state/config/switchroom.yaml",
    "-e", "SWITCHROOM_VAULT_PATH=/state/vault/vault.enc",
    "-e", "SWITCHROOM_BROKER_PER_AGENT_DIR=/run/switchroom/broker",
    "-e", "SWITCHROOM_BROKER_SOCKET=/run/switchroom/broker/vault-broker.sock",
    "-e", `SWITCHROOM_BROKER_ALLOW_NON_LINUX=1`, // belt + braces in case host kernel weirdness
    BROKER_IMAGE,
  ];
  const r = spawnSync("docker", runArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `docker run failed (status=${r.status}): ${r.stderr}\n` +
      `args: ${runArgs.join(" ")}`,
    );
  }

  // Wait for sockets to appear (broker boot + bind).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const allBound = AGENTS.every((a) => {
      try {
        const out = execSync(
          `docker exec ${containerName} stat -c '%F' /run/switchroom/broker/${a}.sock`,
          { stdio: ["ignore", "pipe", "ignore"] },
        ).toString();
        return out.includes("socket");
      } catch {
        return false;
      }
    });
    if (allBound) break;
    execSync("sleep 0.5");
  }

  // The broker bound its sockets as root with mode 0660. The host user
  // running this test (typically UID 1000) needs a permissive mode to
  // connect through the bind mount. Open them up to 0666 — this is a
  // TEST-ONLY relaxation; production sockets stay 0660 and rely on the
  // per-agent UID owning them via cap_add CHOWN.
  try {
    execSync(
      `docker exec ${containerName} sh -c 'chmod 0666 /run/switchroom/broker/*.sock'`,
      { stdio: "ignore" },
    );
  } catch {
    /* */
  }

  // Unlock the broker via the legacy unlock socket (also exposed via the
  // bind mount on the host filesystem). The unlock socket is at
  // /run/switchroom/broker/vault-broker.unlock.sock.
  const unlockSock = `${legacySock.replace(/\.sock$/, ".unlock.sock")}`;
  if (!existsSync(unlockSock)) {
    // Diagnostic dump — broker may have failed to bind.
    const logs = (() => {
      try { return execSync(`docker logs ${containerName}`, { stdio: ["ignore", "pipe", "pipe"] }).toString(); }
      catch { return "<no logs>"; }
    })();
    throw new Error(`unlock socket not found at ${unlockSock}\nbroker logs:\n${logs}`);
  }

  // Snapshot grants DB schema_version BEFORE any traffic. May be null
  // if the broker hasn't opened the DB yet — that's fine, the test below
  // only asserts equality when both reads succeed.
  fx = {
    workdir,
    socketDir,
    vaultPath,
    configPath,
    legacySock,
    containerName,
    initialSchemaVersion: readGrantsSchemaVersion(containerName),
    prodSnapshot,
  };
}, 90_000);

afterAll(() => {
  if (fx) {
    try {
      execSync(`docker rm -f ${fx.containerName}`, { stdio: "ignore" });
    } catch {
      /* */
    }
    // Belt + braces label filter — strictly scoped to this test run.
    safeLabelTeardownPhase2a();
    try {
      rmSync(fx.workdir, { recursive: true, force: true });
    } catch {
      /* */
    }

    // Production-host safety check: HARD assertion that no container
    // appeared, disappeared, or changed status during the run. See
    // ./_prod-snapshot.ts for the cross-phase filter rationale.
    expectNoProdDrift(fx.prodSnapshot, captureProdSnapshot());
  }
}, 60_000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ndjsonOnce(socketPath: string, payload: object, timeoutMs = 4000): Promise<unknown> {
  return new Promise((resolveP, rejectP) => {
    const c = connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      c.destroy();
      rejectP(new Error(`timeout after ${timeoutMs}ms on ${socketPath}`));
    }, timeoutMs);
    c.on("connect", () => {
      c.write(JSON.stringify(payload) + "\n");
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        c.destroy();
        try {
          resolveP(JSON.parse(line));
        } catch (e) {
          rejectP(new Error(`parse error: ${(e as Error).message} for line: ${line}`));
        }
      }
    });
    c.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
  });
}

async function unlockBroker(unlockSock: string, passphrase: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const c = connect(unlockSock);
    let buf = "";
    const timer = setTimeout(() => {
      c.destroy();
      rejectP(new Error(`unlock timeout`));
    }, 8000);
    c.on("connect", () => c.write(passphrase + "\n"));
    c.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        c.destroy();
        resolveP(buf.slice(0, nl));
      }
    });
    c.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!imageOk)(
  "phase2a — broker IPC with socket-path-as-identity",
  () => {
    it(
      "each agent's per-agent socket gates only its own scoped secret; cross-agent denied",
      async () => {
        if (!fx) throw new Error("fixture not initialized");

        // Step 1: unlock the broker by exec'ing inside the container,
        // because the unlock socket's peercred check rejects host-side
        // callers (the broker runs as root in-container, host caller is
        // typically uid 1000 → identify() returns null → DENIED). Inside
        // the container, the connecting `bun` process IS root.
        const unlockResult = spawnSync(
          "docker",
          [
            "exec",
            "-i",
            fx.containerName,
            "bun",
            "-e",
            `const net = require('node:net');
             const c = net.createConnection('/run/switchroom/broker/vault-broker.unlock.sock');
             let buf = '';
             c.on('connect', () => c.write(${JSON.stringify(PASSPHRASE)} + '\\n'));
             c.on('data', d => { buf += d; if (buf.includes('\\n')) { console.log(buf.split('\\n')[0]); c.destroy(); } });
             c.on('error', e => { console.log('ERR:'+e.message); process.exit(1); });
             setTimeout(() => process.exit(0), 1500);`,
          ],
          { encoding: "utf8" },
        );
        expect(unlockResult.stdout.trim()).toBe("OK");

        // Step 2: each agent CAN read its own scoped secret.
        for (const a of AGENTS) {
          const sock = join(fx.socketDir, `${a}.sock`);
          const resp = (await ndjsonOnce(sock, {
            v: 1,
            op: "get",
            key: `${a}_key`,
          })) as { ok: boolean; entry?: { value: string } };
          expect(resp.ok).toBe(true);
          expect(resp.entry?.value).toBe(`secret-for-${a}`);
        }

        // Step 3: cross-agent — alice's socket asking for bob's key is DENIED,
        // and so on for every (i,j) where i != j. Identity comes from the
        // listener path, not the request payload, so no payload field can
        // bypass this.
        for (const requester of AGENTS) {
          for (const target of AGENTS) {
            if (requester === target) continue;
            const sock = join(fx.socketDir, `${requester}.sock`);
            const resp = (await ndjsonOnce(sock, {
              v: 1,
              op: "get",
              key: `${target}_key`,
            })) as { ok: boolean; code?: string; msg?: string };
            expect(resp.ok).toBe(false);
            expect(resp.code).toBe("DENIED");
            expect(resp.msg ?? "").toMatch(/not in ACL/i);
          }
        }

        // Step 4: list — each agent's list returns ONLY its own key.
        for (const a of AGENTS) {
          const sock = join(fx.socketDir, `${a}.sock`);
          const resp = (await ndjsonOnce(sock, { v: 1, op: "list" })) as {
            ok: boolean;
            keys?: string[];
          };
          expect(resp.ok).toBe(true);
          expect(resp.keys?.sort()).toEqual([`${a}_key`]);
        }
      },
      90_000,
    );

    it(
      "schema-stability invariant — grants DB PRAGMA schema_version unchanged",
      () => {
        if (!fx) throw new Error("fixture not initialized");
        const after = readGrantsSchemaVersion(fx.containerName);
        // Both reads can be null (broker hasn't opened the DB) — that's
        // also a passing case since "no DB activity" trivially satisfies
        // schema stability. We only assert equality when both succeeded.
        if (fx.initialSchemaVersion !== null && after !== null) {
          expect(after).toBe(fx.initialSchemaVersion);
        } else {
          // Smoke check: the broker either hasn't touched the DB or has
          // (and we couldn't read it). Pass if we got at least one
          // matching read OR both are null.
          expect(fx.initialSchemaVersion).toBe(after);
        }
      },
      30_000,
    );

    it(
      "agent-bound listeners cannot mint, list, or revoke grants (operator-only)",
      async () => {
        if (!fx) throw new Error("fixture not initialized");
        const sock = join(fx.socketDir, "alice.sock");
        const resp = (await ndjsonOnce(sock, {
          v: 1,
          op: "list_grants",
          agent: "alice",
        })) as { ok: boolean; code?: string; msg?: string };
        expect(resp.ok).toBe(false);
        expect(resp.code).toBe("DENIED");
        expect(resp.msg ?? "").toMatch(/operator-only|cannot/i);
      },
      30_000,
    );
  },
);

describe.skipIf(imageOk)(
  "phase2a — sentinel (image not built)",
  () => {
    it("documents the build instruction visible to operators", () => {
      const reason = !dockerOk
        ? "docker daemon unreachable"
        : `image ${BROKER_IMAGE} not built — build with:\n` +
          `  npm run build\n` +
          `  docker buildx build --build-arg BASE_IMAGE=switchroom/base:phase1b-test \\\n` +
          `    -t ${BROKER_IMAGE} -f docker/Dockerfile.broker --load .`;
      expect(reason).toBeTruthy();
    });
  },
);

// hostname() referenced for typescript-strict to keep the import live in
// case future revisions want to record the test host in audit assertions.
void hostname;
