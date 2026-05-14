/**
 * switchroom-auth-broker entry point — invoked by docker as
 * `bun /opt/switchroom/dist/auth-broker/index.js`. Reads switchroom.yaml,
 * binds the operator + per-agent + per-consumer listeners, starts the
 * refresh loop, and stays alive on the bound sockets.
 *
 * Env:
 *   SWITCHROOM_CONFIG          — Path to switchroom.yaml (default
 *                                /etc/switchroom/switchroom.yaml inside
 *                                the broker container).
 *
 * Flags:
 *   --operator-uid <N>         — When set, bind the operator socket and
 *                                chown it to <N>. Without this, the
 *                                broker still binds per-agent / per-
 *                                consumer listeners (the operator surface
 *                                is purely additive).
 *
 * Signals:
 *   SIGTERM / SIGINT — graceful stop (close sockets, drop refresh timer).
 *   SIGHUP           — re-read switchroom.yaml, reconcile listeners.
 */

import { existsSync, readFileSync } from "node:fs";

import { loadConfig } from "../../config/loader.js";
import { AuthBroker } from "./server.js";

function parseFlags(argv: readonly string[]): { operatorUid?: number } {
  const out: { operatorUid?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--operator-uid") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--operator-uid requires an argument");
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--operator-uid '${next}' is not a non-negative integer`);
      }
      out.operatorUid = n;
      i++;
    } else if (a.startsWith("--operator-uid=")) {
      const v = a.slice("--operator-uid=".length);
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--operator-uid '${v}' is not a non-negative integer`);
      }
      out.operatorUid = n;
    }
  }
  return out;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);

  const configPath = process.env.SWITCHROOM_CONFIG;
  if (configPath !== undefined && !existsSync(configPath)) {
    process.stderr.write(
      `auth-broker fatal: SWITCHROOM_CONFIG='${configPath}' does not exist\n`,
    );
    process.exit(1);
  }
  // Defensive read to surface unreadable config early (loadConfig will read
  // it too, but its error path is less specific about the cause).
  if (configPath !== undefined) {
    try { readFileSync(configPath, "utf-8"); } catch (err) {
      process.stderr.write(
        `auth-broker fatal: failed to read ${configPath}: ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
  }

  const config = loadConfig(configPath);
  // Compose sets SWITCHROOM_AUTH_BROKER_STATE_DIR=/state/auth-broker; without
  // honouring it here the broker writes its healthy marker to the default
  // ~/.switchroom/state/auth-broker/ (inside the container that resolves to
  // /root/.switchroom/state/auth-broker/) while the Dockerfile's HEALTHCHECK
  // looks at /state/auth-broker/healthy — container never goes healthy and
  // any `depends_on: service_healthy` chain stalls forever.
  const stateDirEnv = process.env.SWITCHROOM_AUTH_BROKER_STATE_DIR;
  const broker = new AuthBroker(config, {
    operatorUid: flags.operatorUid,
    stateDir: stateDirEnv && stateDirEnv.length > 0 ? stateDirEnv : undefined,
  });

  const shutdown = (): void => {
    try { broker.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", () => {
    try {
      const reloaded = loadConfig(configPath);
      void broker.reload(reloaded).catch((err) => {
        process.stderr.write(`auth-broker: SIGHUP reload failed: ${(err as Error).message}\n`);
      });
    } catch (err) {
      process.stderr.write(`auth-broker: SIGHUP reload failed: ${(err as Error).message}\n`);
    }
  });

  await broker.start();
}

// Entry guard — mirrors the vault-broker pattern. Only fire when invoked
// directly as the bundled entry.
if (
  import.meta.url === `file://${process.argv[1]}` &&
  /(?:^|[/\\])(?:auth[/\\]broker[/\\])?(?:index|server)\.(?:js|ts)$/.test(
    process.argv[1] ?? "",
  )
) {
  main().catch((err) => {
    process.stderr.write(
      `auth-broker fatal: ${err instanceof Error ? err.stack : err}\n`,
    );
    process.exit(1);
  });
}
