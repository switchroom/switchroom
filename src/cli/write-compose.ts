/**
 * Single source of truth for *generating + writing* the fleet compose file.
 *
 * Extracted from `apply` so that BOTH `switchroom apply` and the
 * `agent restart` reconcile path emit byte-identical compose output — they
 * can never drift. This closes the gotcha behind the v0.14.92 roll
 * (memory `agent-restart-needs-apply-for-pin`): a `release.pin` bump in
 * switchroom.yaml reached the scaffold via `agent restart` but NOT the
 * compose image refs, because restart re-emitted the agent-dir layer only
 * and left the compose (hence the running image) on the old pin. Restart now
 * regenerates the compose, so "edit switchroom.yaml → restart → done" — the
 * promise `reconcileAndRestartAgent`'s own docstring already made — actually
 * holds for image/pin changes too.
 */

import { chownSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { generateCompose } from "../agents/compose.js";
import { resolveImageTag, resolveRelease, type ReleaseBlockShape } from "../config/release-resolve.js";
import { resolveOperatorUid } from "./operator-uid.js";

export interface WriteComposeOpts {
  config: SwitchroomConfig;
  composePath: string;
  /** Bind-mounted switchroom.yaml path baked into broker/kernel/scheduler. */
  switchroomConfigPath: string | undefined;
  /** CLI `--pin`/`--channel` override (apply/update). Restart passes none → uses config.release. */
  releaseOverride?: ReleaseBlockShape | undefined;
  buildMode?: "pull" | "local";
  buildContext?: string | undefined;
}

export interface WriteComposeResult {
  composePath: string;
  imageTag: string;
  bytes: number;
  /** True when the new content differs from what was on disk. */
  changed: boolean;
  /** The agent image tag previously on disk (for drift logging), or null. */
  previousImageTag: string | null;
}

const AGENT_IMAGE_TAG_RE = /image:\s*\S*switchroom-agent:(\S+)/;

/** Generate the compose content and write it (mode 0600). Always writes — same as apply. */
export async function writeComposeFile(opts: WriteComposeOpts): Promise<WriteComposeResult> {
  const release = resolveRelease({ override: opts.releaseOverride, root: opts.config.release });
  const imageTag = resolveImageTag(release);
  const operatorUid = resolveOperatorUid();
  const content = generateCompose({
    config: opts.config,
    imageTag,
    buildMode: opts.buildMode ?? "pull",
    buildContext: opts.buildContext,
    // Bake the operator's HOME absolute path into volume sources (avoids
    // `${HOME}` resolving to /root under sudo).
    homeDir: homedir(),
    switchroomConfigPath: opts.switchroomConfigPath,
    // Captured for the broker's host-shell operator socket chown.
    operatorUid,
  });

  let previous: string | null = null;
  try {
    previous = await readFile(opts.composePath, "utf8");
  } catch {
    previous = null;
  }
  const previousImageTag = previous ? (AGENT_IMAGE_TAG_RE.exec(previous)?.[1] ?? null) : null;

  await mkdir(dirname(opts.composePath), { recursive: true });
  await writeFile(opts.composePath, content, { encoding: "utf8", mode: 0o600 });

  // Keep the compose operator-owned when written under sudo. `apply` also
  // does this via its whole-tree restoreOperatorOwnership sweep, but the
  // `agent restart` path doesn't run that sweep — without this, a root-mode
  // restart would leave the compose root-owned and lock the operator out of
  // non-sudo `docker compose` reads. Best-effort (dev/no CAP_CHOWN/raced).
  if (operatorUid !== undefined && process.geteuid?.() === 0) {
    try {
      chownSync(opts.composePath, operatorUid, operatorUid);
    } catch {
      /* best-effort — matches restoreOperatorOwnership's per-path tolerance */
    }
  }

  return {
    composePath: opts.composePath,
    imageTag,
    bytes: Buffer.byteLength(content, "utf8"),
    changed: previous !== content,
    previousImageTag,
  };
}
