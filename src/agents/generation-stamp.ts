/**
 * Generation stamp — the drift-detection anchor for scaffold-generated
 * agent files (KEN-130, stage 2 of KEN-128).
 *
 * On every host-side reconcile (`switchroom apply`, `switchroom agent
 * reconcile/restart`) the scaffolder records, into
 * `<agentDir>/.switchroom-generated.json`:
 *
 *   - a sha256 per managed file it just enforced on disk
 *     (start.sh, the Switchroom-managed section of CLAUDE.md, .mcp.json),
 *   - a canonical hash of the RESOLVED agent config the render used, and
 *   - the switchroom version that did the rendering.
 *
 * Drift detection is then a pure hash comparison — no re-render needed:
 *
 *   - deployed file hash ≠ stamped hash   → the file was modified (or
 *     partially written) since the last apply;
 *   - current resolved-config hash ≠ stamped configHash → switchroom.yaml
 *     changed but was never applied (stale generation);
 *   - installed VERSION ≠ stamped switchroomVersion → switchroom was
 *     updated but the agent was never re-applied.
 *
 * The stamp lives inside the (bind-mounted) agent dir so BOTH the host
 * (`switchroom doctor`) and the in-container gateway boot-card probe can
 * run the same comparison. This module is intentionally dependency-free
 * (node:fs / node:crypto / node:path only) so the telegram-plugin gateway
 * can import it without dragging in the 7k-line scaffolder.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Basename of the stamp file inside an agent dir. */
export const GENERATION_STAMP_FILE = ".switchroom-generated.json";

/**
 * Visible boundary between the Switchroom-managed (scaffold-regenerated)
 * top of `<agentDir>/CLAUDE.md` and the operator-owned bottom that survives
 * every `switchroom apply`.
 *
 * STRUCTURAL PROMISE — never change this text or its semantics again
 * (see scaffold.ts #1857). Canonical home moved here (KEN-130) so the
 * gateway-side drift probe can split without importing scaffold.ts;
 * scaffold.ts re-exports it for its existing importers.
 */
export const CLAUDE_MD_YOURS_MARKER = "# --- Yours (preserved across apply) ---";

/** The managed files a stamp tracks, relative to the agent dir. */
export const STAMPED_FILES = ["start.sh", "CLAUDE.md", ".mcp.json"] as const;
export type StampedFile = (typeof STAMPED_FILES)[number];

export interface GenerationStamp {
  version: 1;
  /** ISO timestamp of the reconcile that wrote this stamp. */
  generatedAt: string;
  /** Switchroom VERSION that performed the render. */
  switchroomVersion: string;
  /** sha256 of the canonical JSON of the RESOLVED agent config. */
  configHash: string;
  /** relative path → sha256 of the managed content at stamp time. */
  files: Partial<Record<StampedFile, string>>;
}

export function sha256Text(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Deterministic JSON: object keys sorted at every level so semantically
 * identical configs always hash identically regardless of yaml key order.
 */
export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return val;
  });
}

/** Canonical hash of a resolved agent config (post-cascade). */
export function computeConfigHash(resolvedAgentConfig: unknown): string {
  return sha256Text(stableStringify(resolvedAgentConfig));
}

/**
 * Hash only the Switchroom-managed section of a CLAUDE.md — everything
 * above (and including) the `# --- Yours ---` marker. Edits BELOW the
 * marker are operator-owned by contract and must never read as drift.
 * Files without a marker (legacy single-section) hash whole.
 */
export function hashManagedClaudeMd(content: string): string {
  const idx = content.indexOf(CLAUDE_MD_YOURS_MARKER);
  const managed =
    idx === -1 ? content : content.slice(0, idx + CLAUDE_MD_YOURS_MARKER.length);
  return sha256Text(managed);
}

/** Hash the managed content of one stamped file as read from disk. */
function hashStampedFileOnDisk(agentDir: string, rel: StampedFile): string | null {
  const p = join(agentDir, rel);
  if (!existsSync(p)) return null;
  let content: string;
  try {
    content = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  return rel === "CLAUDE.md" ? hashManagedClaudeMd(content) : sha256Text(content);
}

/**
 * Read the current on-disk state of every stamped file and return the
 * hash map. Missing/unreadable files are omitted (a stamp never claims a
 * file it couldn't read).
 */
export function computeStampFilesFromDisk(
  agentDir: string,
): Partial<Record<StampedFile, string>> {
  const files: Partial<Record<StampedFile, string>> = {};
  for (const rel of STAMPED_FILES) {
    const h = hashStampedFileOnDisk(agentDir, rel);
    if (h !== null) files[rel] = h;
  }
  return files;
}

export function writeGenerationStamp(
  agentDir: string,
  stamp: Omit<GenerationStamp, "version" | "generatedAt"> &
    Partial<Pick<GenerationStamp, "generatedAt">>,
): void {
  const full: GenerationStamp = {
    version: 1,
    generatedAt: stamp.generatedAt ?? new Date().toISOString(),
    switchroomVersion: stamp.switchroomVersion,
    configHash: stamp.configHash,
    files: stamp.files,
  };
  writeFileSync(
    join(agentDir, GENERATION_STAMP_FILE),
    JSON.stringify(full, null, 2) + "\n",
    "utf-8",
  );
}

export function readGenerationStamp(agentDir: string): GenerationStamp | null {
  const p = join(agentDir, GENERATION_STAMP_FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as GenerationStamp;
    // `typeof null === "object"` — a stamp with `"files": null` (partial
    // write / hand-edit) must read as no-stamp, not crash the comparer.
    if (
      parsed?.version !== 1 ||
      typeof parsed.files !== "object" ||
      parsed.files === null ||
      Array.isArray(parsed.files)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** One drifted surface, named. */
export interface StampDriftFinding {
  /** Surface name shown to the operator (e.g. "start.sh", "CLAUDE.md"). */
  surface: string;
  detail: string;
}

export interface StampDriftResult {
  /** False when no stamp exists yet (fresh agent / pre-KEN-130 install) —
   *  callers must treat that as "not checkable", never as drift. */
  hasStamp: boolean;
  findings: StampDriftFinding[];
}

/**
 * Pure hash comparison of the deployed managed files against the stamp,
 * plus optional stale-generation checks when the caller can supply the
 * current resolved-config hash and/or installed version (host-side only —
 * the in-container gateway probe omits both).
 */
export function detectStampDrift(
  agentDir: string,
  opts: { currentConfigHash?: string; currentVersion?: string } = {},
): StampDriftResult {
  const stamp = readGenerationStamp(agentDir);
  if (!stamp) return { hasStamp: false, findings: [] };

  const findings: StampDriftFinding[] = [];
  for (const rel of STAMPED_FILES) {
    const stamped = stamp.files[rel];
    if (!stamped) continue; // file wasn't managed at stamp time
    const current = hashStampedFileOnDisk(agentDir, rel);
    if (current === null) {
      findings.push({ surface: rel, detail: "missing (was present at last apply)" });
    } else if (current !== stamped) {
      findings.push({ surface: rel, detail: "modified since last apply" });
    }
  }

  if (opts.currentConfigHash && opts.currentConfigHash !== stamp.configHash) {
    findings.push({
      surface: "config",
      detail: "switchroom.yaml changed since last apply (generated files are stale)",
    });
  }
  if (opts.currentVersion && opts.currentVersion !== stamp.switchroomVersion) {
    findings.push({
      surface: "version",
      detail: `generated by switchroom ${stamp.switchroomVersion}, installed ${opts.currentVersion} — re-apply to refresh`,
    });
  }

  return { hasStamp: true, findings };
}
