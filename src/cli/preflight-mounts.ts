/**
 * Pre-flight bind-source validation — the fail-LOUD backstop before
 * `docker compose up`.
 *
 * The 2026-06-23 outage: a generated compose carried host bind SOURCES that
 * didn't exist on the host, and `docker compose up` SILENTLY auto-created each
 * as a root-owned directory — so the broker's grants.db and the auth-broker's
 * switchroom.yaml became directories (SQLite "unable to open" / EISDIR), and
 * `~/.docker/cli-plugins/docker-compose` got auto-dir'd, shadowing the real
 * plugin. The codebase wrongly assumed a missing `:ro` source hard-fails `up`;
 * it does not.
 *
 * This validator parses the compose's host bind SOURCES and stats each before
 * `up`. A source that is missing, or is the wrong TYPE (a file mounted where a
 * dir is expected, or vice-versa — which is exactly what an auto-dir produces),
 * ABORTS the deploy with the offending paths. It covers every host source —
 * including the absolute mounts no host-home guard touches (/:/host, the docker
 * socket, machine-id, zoneinfo, operator bind_mounts) — for switchroom's deploy
 * path (which always brings the fleet up via the CLI, never a raw
 * `docker compose up`).
 *
 * Pure parse + stat; no compose-format change, so it can't itself break a mount.
 */

import { statSync } from "node:fs";

export interface BindSourceIssue {
  source: string;
  target: string;
  problem: "missing" | "expected-file-got-dir" | "expected-dir-got-file";
}

export interface PreflightResult {
  ok: boolean;
  checked: number;
  issues: BindSourceIssue[];
}

/**
 * Parse host bind SOURCES from a compose file's text. Handles the short syntax
 * the generator emits: `      - <source>:<target>[:mode]`. Only host *path*
 * sources (absolute, starting with `/`) are returned — named volumes,
 * tmpfs (`/tmp:size=…`), and `${HOME}`-interpolated lines are skipped (a
 * `${HOME}` source can't be stat'd from here; it's resolved by Docker at up
 * time, and the host-home resolver already validated that prefix).
 *
 * For each source we infer the EXPECTED type from the target/mode: a source
 * whose basename has a file extension or whose target looks like a file
 * (e.g. `.../switchroom.yaml`, `.../vault-grants.db`, `.../*.log`,
 * `.../.vault-token`, `/etc/machine-id`, `/etc/localtime`) is expected to be a
 * FILE; everything else a DIR. Type is what catches an auto-dir'd file.
 */
export function parseHostBindSources(
  composeText: string,
): { source: string; target: string; expectFile: boolean }[] {
  const out: { source: string; target: string; expectFile: boolean }[] = [];
  const FILE_HINT = /\.(ya?ml|db|log|toml|json|token|id)$|\/\.vault-token$|machine-id$|localtime$/;
  for (const raw of composeText.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const spec = line.slice(2).trim();
    // Only short-syntax host-path binds: `/abs/source:/target[:mode]`.
    if (!spec.startsWith("/")) continue; // named volume, ${HOME}, tmpfs, etc.
    const parts = spec.split(":");
    if (parts.length < 2) continue;
    const source = parts[0];
    const target = parts[1];
    if (!source.startsWith("/") || !target.startsWith("/")) continue;
    if (target.includes("size=") || source.includes("size=")) continue; // tmpfs
    const expectFile = FILE_HINT.test(source) || FILE_HINT.test(target);
    out.push({ source, target, expectFile });
  }
  return out;
}

/** Stat every host bind source; report missing / wrong-type. Deduplicates sources. */
export function validateBindSources(
  composeText: string,
  deps: { stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean } } = {},
): PreflightResult {
  const stat = deps.stat ?? ((p: string) => statSync(p));
  const sources = parseHostBindSources(composeText);
  const issues: BindSourceIssue[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const { source, target, expectFile } of sources) {
    if (seen.has(source)) continue;
    seen.add(source);
    checked++;
    let st: { isDirectory(): boolean; isFile(): boolean } | null = null;
    try {
      st = stat(source);
    } catch {
      st = null;
    }
    if (st === null) {
      issues.push({ source, target, problem: "missing" });
      continue;
    }
    if (expectFile && st.isDirectory()) {
      issues.push({ source, target, problem: "expected-file-got-dir" });
    } else if (!expectFile && st.isFile()) {
      issues.push({ source, target, problem: "expected-dir-got-file" });
    }
  }
  return { ok: issues.length === 0, checked, issues };
}

/** Render a deploy-aborting error message from a failed preflight. */
export function formatPreflightError(result: PreflightResult): string {
  const lines = result.issues
    .slice(0, 20)
    .map((i) => `  - ${i.problem}: ${i.source}  (→ ${i.target})`);
  return (
    `switchroom: refusing to bring the fleet up — ${result.issues.length} bind-mount source(s) ` +
    `are missing or the wrong type:\n${lines.join("\n")}\n\n` +
    `Bringing up now would let Docker auto-create the missing sources as empty root-owned ` +
    `directories, crashing the brokers (the 2026-06-23 outage). This usually means the compose ` +
    `was generated with the wrong host home (a container-context deploy). Recovery: regenerate ` +
    `from the HOST shell — \`switchroom apply\` — then retry; or \`switchroom host repair-mounts\` ` +
    `to clean already-poisoned auto-dir artifacts.`
  );
}
