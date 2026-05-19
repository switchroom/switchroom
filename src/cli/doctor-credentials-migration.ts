/**
 * Credentials-mount migration check (sec WS6-F2, #1390).
 *
 * The fix for WS6-F2 scoped the per-agent credentials bind mount from
 * the fleet-wide `~/.switchroom/credentials/` to per-agent
 * `~/.switchroom/credentials/<agent>/` (compose.ts). That closes a
 * cross-agent credential-exfil hole, but it also means any credential
 * file an operator previously placed FLAT under
 * `~/.switchroom/credentials/<file>` is no longer visible to agents.
 *
 * To guarantee the security fix never causes a SILENT credential
 * outage, this check loudly surfaces any flat (non-per-agent) entry
 * directly under `~/.switchroom/credentials/` and tells the operator
 * exactly how to migrate it. It is detection-only — it never moves or
 * deletes anything.
 *
 * Returns [] (silent) when there is no `credentials/` dir or it
 * contains only per-agent subdirectories — i.e. nothing to migrate.
 */

import {
  existsSync as realExistsSync,
  readdirSync as realReaddirSync,
  statSync as realStatSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SwitchroomConfig } from "../config/schema.js";

import type { CheckStatus } from "./doctor-status.js";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** FS injection seam — tests pass fakes; production uses real syscalls. */
export interface CredMigrationDeps {
  /** Defaults to `~/.switchroom/credentials`. */
  credentialsDir?: string;
  existsSync?: (p: string) => boolean;
  readdirSync?: (p: string) => string[];
  isDirectory?: (p: string) => boolean;
}

export function runCredentialsMigrationChecks(
  config: SwitchroomConfig,
  deps: CredMigrationDeps = {},
): CheckResult[] {
  const credDir =
    deps.credentialsDir ?? join(homedir(), ".switchroom", "credentials");
  const existsSync = deps.existsSync ?? ((p: string) => realExistsSync(p));
  const readdirSync = deps.readdirSync ?? ((p: string) => realReaddirSync(p));
  const isDirectory =
    deps.isDirectory ??
    ((p: string) => {
      try {
        return realStatSync(p).isDirectory();
      } catch {
        return false;
      }
    });

  if (!existsSync(credDir)) return [];

  const agentNames = new Set(Object.keys(config.agents ?? {}));
  let entries: string[];
  try {
    entries = readdirSync(credDir);
  } catch {
    return [
      {
        name: "credentials: layout",
        status: "warn",
        detail: `could not read ${credDir} — skipped migration check`,
      },
    ];
  }

  const flat: string[] = [];
  const perAgentDirs: string[] = [];
  for (const e of entries) {
    const full = join(credDir, e);
    if (isDirectory(full) && agentNames.has(e)) {
      perAgentDirs.push(e);
    } else {
      // A flat file, OR a directory whose name isn't a declared agent
      // (still flat from the agents' POV — no agent mounts it).
      flat.push(e);
    }
  }

  if (flat.length === 0) {
    return [
      {
        name: "credentials: layout",
        status: "ok",
        detail:
          perAgentDirs.length > 0
            ? `per-agent only (${perAgentDirs.length} agent dir(s)); no fleet-wide-readable entries`
            : "no flat entries",
      },
    ];
  }

  // Flat entries exist → they are NOT mounted into any agent after the
  // WS6-F2 fix. Loud WARN (not fail — this is a migration prompt, the
  // operator may have intentionally retired these), with the exact
  // remediation. Never silent.
  return [
    {
      name: "credentials: flat entries not visible to agents (sec WS6-F2)",
      status: "warn",
      detail:
        `${flat.length} entr(y/ies) directly under ${credDir} ` +
        `(${flat.slice(0, 5).join(", ")}${flat.length > 5 ? ", …" : ""}) ` +
        `are NOT bind-mounted into any agent since the WS6-F2 per-agent ` +
        `scoping fix — agents that relied on them will fail to find them`,
      fix:
        `move each file under the per-agent dir(s) that need it, e.g. ` +
        `\`mkdir -p ${credDir}/<agent> && mv ${credDir}/<file> ${credDir}/<agent>/\`, ` +
        `then \`switchroom update\`. Prefer the per-agent-ACL'd vault ` +
        `(\`switchroom vault set\`) for new secrets — see docs/configuration.md.`,
    },
  ];
}
