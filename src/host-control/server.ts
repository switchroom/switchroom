/**
 * switchroom-hostd server — listens on per-agent Unix-domain sockets,
 * dispatches a closed set of operator-only switchroom verbs to the
 * host CLI.
 *
 * Phase 1 scope (per RFC C, `reference/rfcs/host-control-daemon.md`):
 *   - `agent_restart`  (mutating; self → any caller, cross-agent →
 *                      admin)
 *   - `upgrade_status` (read-only; any)
 *   - `get_status`     (lookup of prior async mutations; gate matches
 *                      the original verb)
 *
 * Shipped in Phase 2 (#1208): `update_check`, `update_apply`,
 * `apply`, `agent_start`, `agent_stop`. See RFC C §10 for the full
 * verb table. `update_apply` and `apply` share a new fleet-mutation
 * lock (this file's `fleetMutationInFlight`). `reconcile` was
 * dropped from the original list — no underlying CLI verb exists;
 * `apply` covers the intent.
 *
 * Still deferred: gateway integration (replacing
 * `spawnSwitchroomDetached` callsites in telegram-plugin/gateway/
 * with hostd RPC). Separate PR.
 */

import { createServer, type Server, type Socket } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, chmod, chown, unlink, appendFile } from "node:fs/promises";
import {
  readdirSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  ftruncateSync,
  writeSync,
  fsyncSync,
  closeSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  decodeRequest,
  encodeResponse,
  deniedResponse,
  IDEMPOTENCY_WINDOW_MS,
  MAX_FRAME_BYTES,
  CANONICAL_CONFIG_PATH,
  type HostdRequest,
  type HostdResponse,
  type Result,
} from "./protocol.js";
import { err } from "./error-builder.js";
import { chainRow, seedChain, type ChainState } from "../util/audit-hashchain.js";
import {
  maybeRotateLogFile,
  resolveRotationConfig,
} from "../util/log-rotation.js";
import {
  DEFAULT_HOSTD_AUDIT_MAX_BYTES,
  DEFAULT_HOSTD_AUDIT_MAX_FILES,
} from "./audit-rotation-config.js";
import { socketPathToIdentity, type SocketIdentity } from "./peercred.js";
import { redact } from "../secret-detect/redact.js";
import { detectInstallType, type InstallType } from "../cli/install-detect.js";
import {
  parseRolloutResultLine,
  parseRolloutPhaseLine,
  isVersionAssertable,
  type RolloutPhase,
} from "../cli/rollout.js";
import {
  recoverPinJournal,
  commitPinPersist,
  hasPinJournal,
  readPinJournal,
} from "../cli/rollout-pin-journal.js";
import { restoreComposeBackup } from "../cli/write-compose.js";
import { SWITCHROOM_VERSION } from "../cli/resolve-version.js";
import {
  needsSelfBump,
  bumpHostdComposeImageTag,
  encodePendingRolloutMarker,
  parsePendingRolloutMarker,
  isMarkerFresh,
  selfBumpHelperArgs,
  SELF_BUMP_MARKER_FILENAME,
  SELF_BUMP_HELPER_CONTAINER,
  SELF_BUMP_LOG_FILENAME,
  type PendingRolloutMarker,
} from "./self-bump.js";
import { parseUpdateResultLine } from "../cli/update.js";
import type { ComponentVersion } from "../cli/component-versions.js";
import {
  resolvePriorPinFromFleet,
  type PriorPinSource,
} from "./prior-pin.js";
import { parseAuditLine, latestRolloutRowForRequest } from "./audit-reader.js";
import {
  validateConfigEdit,
  admitSelfScopedNonAdminEdit,
} from "./config-edit-validator.js";
import { classifyBlastRadius } from "./config-blast-radius.js";
import type { ApprovalGateway } from "./approval-gateway.js";
import type { RolloutRelay } from "./rollout-relay.js";
import { renderRolloutStatus } from "./render-rollout-status.js";
import { readHostCliStamp } from "../cli/host-cli-stamp.js";
import { loadConfig, resolveAgentsDir, findConfigFile } from "../config/loader.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";
import {
  collectScheduleEntries,
  type SchedulerEntry,
  type DispatchResult,
} from "../scheduler/dispatch.js";
import { readRecentFires } from "../agent-scheduler/replay.js";
import { rpcRaw as brokerRpcRaw } from "../vault/broker/client.js";

/** Subset of switchroom.yaml the daemon reads. */
export interface ServerConfig {
  /** Per-agent admin flag — drives the verb gate. Daemon reads this
   *  once at startup (Phase 1) and reloads on SIGHUP (post-Phase-1
   *  follow-up). */
  agents: Record<string, { admin?: boolean }>;
  /** hostd verb-level knobs (RFC admin-agent-config-edit §3 / §4).
   *  Optional in the wire type so existing call-sites that synthesize
   *  a minimal config (test fixtures, legacy callers) keep compiling;
   *  the dispatcher treats "missing block" as "flag off". */
  hostd?: {
    config_edit_enabled?: boolean;
    config_edit_rate_per_hour?: number;
    /** #1841 — master switch for the operator-passphrase 2nd factor.
     *  Missing/false ⇒ feature inert (attestation accepted-and-audited
     *  when present, never required — byte-identical to pre-#1841). */
    operator_attest_enabled?: boolean;
    /** #1841 — verbs that REQUIRE attestation when the switch is on.
     *  Missing ⇒ RFC §5.4 default set (update_apply / apply / rollout). */
    operator_attest_required_verbs?: string[];
  };
}

/**
 * #1841 — operator-passphrase attestation verifier. hostd NEVER holds the
 * vault passphrase; it forwards the plaintext to the vault broker over its
 * own admin-client connection and treats a broker DENIED as a gate failure.
 * Abstracted behind this interface so the gate logic is unit-testable with a
 * stub, and the real transport (broker `list_grants` with `passphrase`, the
 * read-only op that already implements the passphrase plaintext-forward per
 * #1051) is injected in production.
 */
export interface AttestVerifier {
  /**
   * Verify a forwarded operator passphrase against the broker's currently
   * unlocked passphrase. Returns `{ ok: true }` on match, `{ ok: false }`
   * with a human reason on mismatch, broker-locked, or broker-unreachable
   * (all fail-closed — a verb that requires attestation must not pass when
   * the verifier cannot positively confirm the passphrase).
   */
  verify(passphrase: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** RFC §5.4 — the broker socket hostd uses for the attestation forward.
 *  Bound cross-compose (see `src/cli/hostd.ts` + `src/agents/compose.ts`). */
export const HOSTD_BROKER_SOCKET_PATH = "/run/switchroom/broker/hostd/sock";

/** RFC §5.4 default fleet-mutation verb set that requires operator-attest
 *  when the feature is enabled and no explicit override is configured. */
export const DEFAULT_OPERATOR_ATTEST_VERBS: readonly string[] = [
  "update_apply",
  "apply",
  "rollout",
];

/** Audit `method` tag for attested / attestation-denied rows (#1841),
 *  mirroring the vault broker's `method: "passphrase"` attribution. */
export const ATTEST_AUDIT_METHOD = "passphrase-attest";

// Rotation constants live in their own module so the pure reader can share
// them without importing the daemon — re-exported here for callers that
// already import from `server.ts`.
export {
  DEFAULT_HOSTD_AUDIT_MAX_BYTES,
  DEFAULT_HOSTD_AUDIT_MAX_FILES,
} from "./audit-rotation-config.js";

export interface ServerOptions {
  /** Operator HOME — daemon binds sockets under `<homeDir>/.switchroom/hostd/<agent>/sock`. */
  homeDir: string;
  /** Map of agent name → UID for chown. The daemon needs CHOWN/FOWNER
   *  caps (or to run as the operator owning the agent UIDs) to set
   *  ownership; mirrors the broker's pattern at
   *  `src/agents/compose.ts:549-552`. */
  agentUids: Record<string, number>;
  /** Config — admin gating. */
  config: ServerConfig;
  /** Absolute path to the host `switchroom` binary. Default: lookup on
   *  PATH at request time. */
  switchroomBin?: string;
  /** Absolute path to the host `docker` binary. Default: lookup on
   *  PATH at request time. Used by Phase 3 admin observability verbs
   *  (agent_logs / agent_exec) that shell out to docker directly. */
  dockerBin?: string;
  /** Audit-log path. Default: `<homeDir>/.switchroom/host-control-audit.log`. */
  auditLogPath?: string;
  /** Rotate the audit log once it reaches this many bytes. `0`/undefined →
   *  env `SWITCHROOM_HOSTD_AUDIT_MAX_BYTES` → {@link DEFAULT_HOSTD_AUDIT_MAX_BYTES}.
   *  A negative value disables rotation (operator escape hatch). */
  auditMaxBytes?: number;
  /** How many rotated generations (`.1` … `.N`) to retain. `0`/undefined →
   *  env `SWITCHROOM_HOSTD_AUDIT_MAX_FILES` → {@link DEFAULT_HOSTD_AUDIT_MAX_FILES}. */
  auditMaxFiles?: number;
  /** Allow non-Linux dev mode (skips chown). */
  allowNonLinux?: boolean;
  /**
   * Root the apply-asset preflight resolves package-relative apply
   * assets against (`<root>/profiles`, `<root>/vendor/hindsight-
   * memory`). Default: two dirs up from this module — for the bundled
   * daemon (`/opt/switchroom/dist/host-control/main.js`) that is
   * `/opt/switchroom`, exactly where Dockerfile.hostd bakes them and
   * the same root the CLI bundle resolves to. Test seam only.
   */
  applyAssetsRoot?: string;
  /**
   * Filesystem root the daemon uses to read host-side artifacts (e.g.
   * the install-type cache at `<bindRoot>/.switchroom/install-type.json`).
   * For the dockerised daemon, set this to the bind-mount path of the
   * operator's HOME inside the container (typically `/host-home`); for
   * the host-direct daemon, leave unset and the daemon falls back to
   * `homeDir`.
   */
  bindRoot?: string;
  /**
   * Test seam: override the image refs the digest resolver is called
   * with. When unset the daemon shells out to `docker compose config`
   * to enumerate refs from the operator's compose file.
   */
  imageRefsForDigests?: () => string[];
  /**
   * The running-container inventory the `prior_pin` derivation reads —
   * REQUIRED in production, and injected rather than defaulted.
   *
   * `main.ts` wires `dockerFleetComponents`: one `docker ps` through the
   * same collector `switchroom update --check` and `doctor` use, so the
   * three cannot disagree about what the fleet is running. Left unset,
   * the daemon sees an EMPTY fleet and records no `prior_pin` — which is
   * exactly what keeps a unit-test server from reading the host's real
   * containers.
   */
  fleetComponents?: () => ComponentVersion[];
  /**
   * Path to the live `switchroom.yaml` the config-edit validator (PR 1b)
   * reads when checking that a proposed unified diff applies cleanly
   * and the post-apply YAML survives schema + secret-leak validation.
   *
   * Defaults to `/state/config/switchroom.yaml` — the canonical path
   * the wire schema (`ConfigProposeEditRequestSchema.args.target_path`)
   * pins. Tests override this to point at a scratch file under `tmp/`
   * so the validation pipeline can be exercised end-to-end without
   * touching real fleet config.
   */
  configPath?: string;
  /** RFC §3.3 / #1623 — operator-approval surface; unset → `E_NO_APPROVAL_GATEWAY`. */
  approvalGateway?: ApprovalGateway;
  /**
   * #2726 Part 2 — optional in-chat rollout narration renderer. When set, each
   * rollout phase transition is fed to it so it edits ONE ordinary operator-DM
   * message through the phases (applying → canary → agent N/M → … → ✅/❌). It
   * PULLS from what it's fed and relays fire-and-forget edits through the
   * gateway; it never blocks or fails the roll. Unset in Part 1 (durable
   * observability ships alone). */
  rolloutNarrator?: RolloutNarrator;
  /**
   * #2726 Part 1 — terminal-push relay. When set, hostd pushes ONE ordinary
   * operator-DM message on the rollout terminal row (via the same gateway IPC
   * transport as the approval card). Fire-and-forget; never blocks/fails the
   * roll. Unset → no terminal ping (durable audit row is still written). */
  rolloutRelay?: RolloutRelay;
  /**
   * The daemon's own CLI version, compared against a rollout pin to
   * decide whether hostd must self-bump before driving the roll (#2645).
   * Default: the build-stamped SWITCHROOM_VERSION. Test seam.
   */
  selfVersion?: string;
  /**
   * The operator home as the HOST sees it — used as the bind-source
   * prefix for the self-bump helper container's mounts (a `/host-home/…`
   * container path is meaningless to dockerd). Default:
   * `SWITCHROOM_HOST_HOME` env (set in the hostd compose), falling back
   * to `homeDir` for the host-direct daemon. Test seam.
   */
  hostHomeDir?: string;
  /** Test seam: override the random hex id generator. */
  generateApprovalId?: () => string;
  /** Test seam: override the `switchroom apply` subprocess invocation. */
  runReconcile?: (args: {
    requestId: string;
    /**
     * A MIRROR of the env overlay the production spawn merges onto
     * `process.env` for this reconcile. Carries `SWITCHROOM_CONFIG` on the
     * `config_propose_edit` path (#4661 follow-up).
     *
     * It is NOT the child's environment: production never calls this seam, it
     * calls the default closure, which passes the same variable POSITIONALLY to
     * `runSwitchroom(args, extraEnv)` and ignores this parameter entirely. Two
     * independent references to one variable — nothing in the type system ties
     * them, and dropping the real spawn's argument would leave every
     * seam-asserting test green. What keeps the mirror honest is the real-spawn
     * test "spawns the REAL reconcile child (no runReconcile seam) with
     * SWITCHROOM_CONFIG pinned to the written file" in
     * `tests/host-control/config-propose-edit.test.ts`, which injects no seam
     * and reads the variable out of the child's own environment. Keep them in
     * step: change the spawn, and that test is what fails.
     */
    env?: Record<string, string>;
  }) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
  /**
   * Test seam: override how the live config file is written during a
   * `config_propose_edit` apply (both the forward write and the rollback
   * restores go through it). Default: `writeFileInPlacePreservingInode`.
   *
   * Exists so a test can install a write that SILENTLY DOES NOTHING and
   * assert the RESPONSE, which is the exact production failure the
   * post-write verification below guards: a write that does not throw but
   * does not land. Without the seam a test can only reach that state via a
   * filesystem trick (chattr / a bind mount / a racing writer), none of
   * which are portable in CI.
   */
  writeConfigFile?: (path: string, content: string) => void;
  /**
   * Test seam: override how the FLEET's config path is resolved for the
   * apply-time path-provenance gate (#4661 follow-up). Default:
   * {@link findConfigFile} — the same resolver every agent, the CLI, and
   * hostd's own `loadConfig()` go through.
   *
   * Exists because the gate's whole subject is a disagreement between two
   * resolvers, and the production one answers from `$SWITCHROOM_CONFIG` / cwd /
   * `~/.switchroom` — none of which a test can point at
   * `/state/config/switchroom.yaml` without root and a real bind mount.
   */
  resolveFleetConfigPath?: () => string;
  /**
   * Test seam: override the `stat(2)`-based file-identity probe the
   * path-provenance gate uses to tell two NAMES for one file apart from two
   * different files.
   */
  identifyForProvenance?: (p: string) => FileIdentity;
  /**
   * #1841 — operator-passphrase attestation verifier. Default: a
   * broker-backed verifier that forwards the passphrase to the vault
   * broker at `HOSTD_BROKER_SOCKET_PATH`. Tests inject a stub. Only
   * consulted when `config.hostd.operator_attest_enabled` is true AND the
   * verb is in the required set — so leaving it unset never changes
   * behaviour for the default (feature-off) posture.
   */
  attestVerifier?: AttestVerifier;
}

/**
 * #2726 Part 2 — the in-chat rollout narration renderer, as hostd sees it.
 * hostd owns the rollout request lifecycle and the gateway relay path (the same
 * one it uses for approval cards), so it drives the renderer by feeding it each
 * phase. The renderer is the thing that TAILS/edits; hostd only supplies phases.
 * Defined here (not in the renderer module) so Part 1 declares the seam and
 * Part 2 implements it — Part 1 leaves it unset.
 */
export interface RolloutNarrator {
  /**
   * Called once per rollout phase transition, in `_seq` order (hostd feeds
   * them as it parses the child's stdout). MUST be non-blocking and swallow all
   * errors — hostd calls it un-awaited, and an edit failure must never surface
   * back toward the roll. `entry.request_id` binds the surface to a
   * hostd-attested in-flight roll.
   */
  onPhase(entry: StatusEntry, phase: RolloutPhase): void;
  /**
   * Called once when the terminal row is written (success or failure), with the
   * final entry. Freezes the surface: no later edit may un-finalize it.
   */
  onTerminal(entry: StatusEntry): void;
  /**
   * Seed a resumed narrator with the message_id of the card the PRE-self-bump
   * hostd already posted (carried across the recreate in the pending-rollout
   * marker), so the resumed roll EDITS that card rather than posting a new one
   * and stranding the original. Optional — a narrator without it degrades to
   * the pre-fix re-post behaviour.
   */
  seedPostedMessage?(requestId: string, agentName: string, messageId: number): void;
}

/**
 * Per-request status snapshot retained for `get_status` lookups.
 * Capped at the most recent N requests per daemon process; entries
 * older than the cap age get evicted lazily.
 *
 * Exported (#2726) so the RolloutNarrator can read the terminal fields when
 * finalizing the in-chat narration surface.
 */
export interface StatusEntry {
  request_id: string;
  caller: SocketIdentity;
  op: string;
  result: Result;
  exit_code: number | null;
  /** ms since epoch */
  started_at: number;
  finished_at: number | null;
  stdout_tail: string;
  stderr_tail: string;
  error?: string;
  // ─── Update-flow enrichment (PR B) ─────────────────────────────────
  // Populated only on `update_apply` rows so the terminal audit row
  // carries enough information for the gateway / `get_status` reader
  // to surface what was rolled out without re-querying docker.
  channel?: string;
  pin?: string;
  /** Map of image-ref → "sha256:<hex>" digest, captured at the moment
   *  `docker compose pull` finished (best effort). */
  resolved_sha?: Record<string, string>;
  install_context?: {
    install_type: InstallType;
    detected_at: string;
  };
  // ─── Rollout-flow structured result (#2487) ────────────────────────
  // Populated only on `rollout` rows. The staggered rollout's outcome is
  // preserved as STRUCTURED fields (not flattened into a stdout tail) so
  // a `get_status` reader / the gateway can show exactly which agents
  // rolled and where it stopped. Parsed from the spawned child's
  // sentinel line (see parseRolloutResultLine in cli/rollout.ts).
  /** Agents confirmed on the target version, in order. */
  rolled?: string[];
  // ─── Live rollout phase (#2726) ────────────────────────────────────
  // Updated on every phase transition parsed off the child's stdout, so an
  // in-flight `get_status` shows the CURRENT phase ("canary-start",
  // "agent-start", …) instead of a bare "started". Set only on rollout rows.
  current_phase?: string;
  /** Roll-order position of the agent named in the current phase (1-based). */
  phase_n?: number;
  /** Total agents this roll restarts. */
  phase_m?: number;
  /** Agent named in the current phase (agent-start/-done, canary-*). */
  phase_agent?: string;
  /** Step that stopped the rollout (e.g. "restart-agent", "apply"). */
  failed_step?: string;
  /** Agent that failed the version assert (when failed_step is restart). */
  failed_agent?: string;
  /**
   * Structured residue names carried on a roll that converged its agents but
   * left something behind — a forward-fix, not a rollback. Two producers:
   *   - `failed_step === "verify-components"` (#3928): component(s) still
   *     BEHIND the target (`switchroom-web`, `switchroom-hindsight-autoheal`, …).
   *   - `failed_step === "ensure-banks"`: agent(s) whose Hindsight bank could
   *     not be created during the roll (the recovery is restarting that agent,
   *     never a rollback).
   *
   * Carried as structured data rather than left in the stderr tail so an
   * operator reading `get_status` from TELEGRAM is told exactly what is
   * stranded — the whole point of the managed path is that they never have to
   * open a host shell to find out.
   */
  drifted?: string[];
  /**
   * Non-fatal warnings the roll accumulated (e.g. web/hostd refresh misses,
   * skipped components, degraded steps). #3944 — `encodeRolloutResultLine`
   * has always put these on the sentinel wire (`warnings: result.warnings`),
   * but hostd's sentinel-lift dropped them: they never reached `get_status`
   * or the narration card, so the operator — who has no host shell on the
   * managed path — could not see what the roll flagged. Lifted here so the
   * structured status and the terminal card both surface them.
   */
  warnings?: string[];
  /** Actual version detected on failed_agent (null = unreachable). BONUS #2458 got-field gap. */
  got?: string | null;
  /**
   * True when the roll stopped because a bounded subprocess exceeded its
   * timeout and was killed (see ROLLOUT_RUN_TIMEOUT_MS / ROLLOUT_PROBE_TIMEOUT_MS
   * in cli/rollout.ts). A timeout is operationally distinct from a plain
   * non-zero exit — the step may have left work half-done and docker
   * grandchildren may still be running — so it is surfaced as its own field
   * rather than being flattened into the stderr tail. Absent (not `false`)
   * on rolls that did not time out.
   */
  timed_out?: boolean;
  // ─── Update-apply deferral result (#2458) ──────────────────────────
  // Steps that were deferred because the update ran in hostd-context
  // (SWITCHROOM_HOSTD_CONTEXT=1). Populated by parsing the
  // SWITCHROOM_UPDATE_RESULT sentinel from the child's stdout. Absent
  // when no steps were deferred (non-hostd-context run or older driver).
  deferred?: string[];
  // ─── Rollback prior-pin capture (#2492) ─────────────────────────────
  // The version-assertable semver that WAS running before this rollout
  // completed. Stamped on COMPLETED rollout terminal rows only — a failed
  // canary roll does not change the running version, so prior_pin is
  // intentionally absent on error rows. Enables `rollout --allow-downgrade`
  // to default its target to "the last good one" without the operator
  // having to remember the version string.
  //
  // DERIVED FROM THE RUNNING FLEET, not from `release.pin` — the roll
  // rewrites that field, so the config pin is the TARGET whenever it was
  // already set ahead of the roll, and rollback becomes a no-op. See
  // `prior-pin.ts`.
  prior_pin?: string;
  /** Every distinct version observed across the in-scope fleet, highest
   *  first. Present only when the fleet was NOT uniform — a mixed fleet
   *  is recorded honestly rather than collapsed to one silent pick. */
  prior_pin_observed?: string[];
  /** How `prior_pin` was arrived at — distinguishes "no prior version
   *  existed" (`all-on-target`) from "we could not look" (`unobserved`). */
  prior_pin_source?: PriorPinSource;
}

/**
 * Resolve docker image references to their RepoDigests via
 * `docker inspect --format='{{index .RepoDigests 0}}' <ref>`.
 *
 * Pure side-effect-free (only spawns `docker inspect`, no mutations).
 * Fail-soft: any image whose digest can't be read (image not present,
 * `docker` not on PATH, parse failure) is omitted from the returned
 * map rather than throwing. The audit row captures whatever digests
 * we COULD resolve and the caller can decide whether the partial set
 * is useful — typically yes, because even one resolved digest pins
 * the rollout's identity.
 *
 * Exported for unit-test access (mock `child_process.spawnSync`).
 */
export function resolveDigests(imageRefs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of imageRefs) {
    try {
      const r = spawnSync(
        "docker",
        ["inspect", "--format={{index .RepoDigests 0}}", ref],
        { encoding: "utf-8", timeout: 5000 },
      );
      if (r.status !== 0) continue;
      const trimmed = (r.stdout ?? "").trim();
      // Parse "repo@sha256:<hex>" → keep the "sha256:<hex>" half.
      const at = trimmed.lastIndexOf("@");
      if (at < 0) continue;
      const digest = trimmed.slice(at + 1);
      if (!/^sha256:[0-9a-f]{32,}$/.test(digest)) continue;
      out.set(ref, digest);
    } catch {
      // Spawn failure (docker not installed, EACCES). Skip silently —
      // see the fail-soft contract above.
      continue;
    }
  }
  return out;
}

/**
 * Read the host-side install-type cache written by `switchroom apply`
 * (see `writeInstallTypeCache` in `src/cli/apply.ts`). Reads from
 * `<bindRoot>/.switchroom/install-type.json` — for the daemon running
 * inside docker, `bindRoot` is `/host-home`; for the daemon running on
 * the host directly, it's the operator's home.
 *
 * Lazy detection: if the cache file is missing, run `detectInstallType()`
 * directly and write the result back atomically (`.tmp` + rename, mode
 * 0o644) so subsequent calls hit the cache. Mirrors the apply-side
 * writer so the two paths stay structurally identical.
 *
 * Defensive: a corrupt cache file (malformed JSON, missing fields)
 * collapses to `{install_type: "unknown"}` rather than throwing — the
 * audit row prefers a degraded value to a missing one. No mtime /
 * staleness check; `apply` is the canonical invalidator.
 *
 * Exported for unit-test access.
 */
export function readCachedInstallType(bindRoot: string): {
  install_type: InstallType;
  detected_at: string;
  source_paths?: { bin?: string; repo?: string };
} {
  const cacheDir = join(bindRoot, ".switchroom");
  const cachePath = join(cacheDir, "install-type.json");
  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.install_type === "string" &&
        typeof parsed.detected_at === "string"
      ) {
        return parsed;
      }
      return { install_type: "unknown", detected_at: new Date().toISOString() };
    } catch {
      return { install_type: "unknown", detected_at: new Date().toISOString() };
    }
  }
  // Lazy detect + write back.
  const ctx = detectInstallType();
  const payload = {
    install_type: ctx.install_type,
    detected_at: new Date().toISOString(),
    source_paths: ctx.source_paths,
  };
  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
    renameSync(tmp, cachePath);
  } catch {
    // Read-only filesystem (e.g. docker bind-mounted :ro) — return the
    // detected value without caching. Best-effort by contract.
  }
  return payload;
}

/**
 * RFC §3.3 — operator approval card lifespan for a config-propose card.
 *
 * Bumped to 60 min alongside the fleet-wide approval-card timeout raise (the
 * tool-use card + vault grant wait are now config-driven at 60-min default).
 * This surface stays a fixed default rather than config-driven: hostd runs in
 * its own daemon process and this window is coupled to the MCP client's wire
 * timeout (`WIRE_TIMEOUT_MS_BY_OP.config_propose_edit` in
 * `src/mcp/hostd/server.ts`) by the hard invariant `wire > window` — threading
 * a channel-config value into two separate processes while preserving that
 * coupling was out of scope for this change.
 */
const CONFIG_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

/** 8-hex random id for an in-flight config_propose_edit approval. */
function defaultApprovalId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Caller-identity scope prefix for the idempotency cache key (sec
 * host-control-F1). Two different callers must never share an idempotency
 * bucket — otherwise caller B replaying caller A's idempotency_key (or a
 * request_id collision) could be served A's cached mutation result. The
 * agent-name / operator distinction is authoritative because it's derived
 * from the daemon's own bind path (`socketPathToIdentity`), which a caller
 * cannot influence. The scope prefix (`operator` / `agent:<slug>`) contains
 * no space, and agent slugs contain no space, so the single-space separator
 * makes the scoped key unambiguous across distinct callers.
 */
function idempotencyScope(caller: SocketIdentity): string {
  return caller.kind === "agent" ? `agent:${caller.name}` : "operator";
}

/**
 * Map a deny `ApprovalResult` to the appropriate error string for
 * the config_propose_edit response. (#1762)
 *
 *   - `denySource === "dispatch_failure"` → `E_APPROVAL_DISPATCH_FAILED`
 *     (Telegram card never reached the operator — opaque
 *     "operator denied" would be a lie)
 *   - operator tap deny → `E_DENIED` with the reason (when present)
 *     appended for diagnostic value
 *
 * Exported only for unit testing — the production caller is
 * `handleConfigProposeEdit` in this file.
 */
export function formatConfigApprovalDenyError(
  approval: {
    reason?: string;
    denySource?: "operator" | "dispatch_failure";
  },
  approvalId: string,
): string {
  if (approval.denySource === "dispatch_failure") {
    const detail = approval.reason ?? "card dispatch failed";
    return `E_APPROVAL_DISPATCH_FAILED: ${detail} (approval_id=${approvalId})`;
  }
  const suffix = approval.reason ? `: ${approval.reason}` : "";
  return `E_DENIED: operator denied config_propose_edit${suffix} (approval_id=${approvalId})`;
}

/**
 * Write `content` to an existing file **in place**, preserving its inode.
 *
 * The obvious atomic-write strategy — write a sibling `<path>.tmp` then
 * `rename()` it over the target — is structurally broken for
 * switchroom.yaml. That file is itself an individual read-only bind-mount
 * source: it is bind-mounted into every agent container. `rename()` over a
 * path that is an active bind-mount source returns `EBUSY` ("resource busy
 * or locked"), so the swap never lands. (Confirmed via /proc/mounts:
 * `/dev/nvme0n1p2 /state/config/switchroom.yaml ext4 ro,relatime`.)
 *
 * Instead we open the existing file `O_RDWR` (no create, no rename),
 * truncate it, write the new bytes, and `fsync()`. The inode is preserved,
 * so every bind mount stays valid and the kernel never sees a rename over a
 * busy dentry. `O_RDWR` (mode `"r+"`) also preserves the file's existing
 * mode and owner — we never re-create it.
 *
 * Tradeoff — non-atomic: a crash between truncate and the final write could
 * leave a partial file. Callers mitigate by (a) snapshotting the prior
 * content for rollback, (b) `fsync` here, and (c) re-validating immediately
 * after (the reconcile run rejects a malformed config and triggers
 * rollback). A short post-write read-back length check below catches a
 * truncated write before reconcile even starts.
 *
 * @throws the underlying fs error (e.g. `EROFS`/`EACCES` if the mount is
 *   read-only at the hostd vantage, `ENOENT` if the target does not exist).
 */
function writeFileInPlacePreservingInode(
  targetPath: string,
  content: string,
): void {
  const buf = Buffer.from(content, "utf-8");
  // "r+" = O_RDWR, fails if the file is missing, never truncates/creates on
  // open — so mode/owner are untouched and we operate on the live inode.
  const fd = openSync(targetPath, "r+");
  try {
    ftruncateSync(fd, 0);
    let off = 0;
    while (off < buf.length) {
      off += writeSync(fd, buf, off, buf.length - off, off);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Immediate re-validate: confirm the bytes actually landed at full
  // length before the caller hands off to reconcile. Cheap insurance
  // against a silently short write leaving a truncated config.
  const readBack = readFileSync(targetPath);
  if (readBack.length !== buf.length) {
    throw new Error(
      `in-place write short: wrote ${buf.length} bytes but read back ${readBack.length}`,
    );
  }
}

/**
 * Outcome of the post-write verification for a `config_propose_edit` apply.
 * `ok` means the bytes we intended to write are the bytes the next reader of
 * `configPath` will see, AND that they mean semantically what the operator
 * approved. `size`/`mtimeMs` are echoed into the audit row on success so a
 * future false success leaves evidence behind.
 */
interface ConfigWriteObservation {
  ok: boolean;
  /** Human-readable failure reasons; empty iff `ok`. */
  reasons: string[];
  /** Observed bytes, or null when the read-back itself failed. */
  observed: Buffer | null;
  size: number | null;
  mtimeMs: number | null;
}

/**
 * #4661 — verify a config write was OBSERVED, not merely un-thrown.
 *
 * `writeFileInPlacePreservingInode` returning without throwing proves only
 * that a `write(2)` to SOME fd reported the right byte count. It does not
 * prove the bytes are visible at `configPath` to the next reader, and its own
 * read-back is a LENGTH-ONLY truncation guard. A real incident: a
 * `config_propose_edit` returned `result: completed, exit_code: 0` with a
 * clean reconcile while the approved block was absent from the config every
 * other process reads.
 *
 * Two independent assertions, both computed so the failure detail names each
 * one that tripped:
 *
 *  1. BYTE COMPARE — re-read `configPath` and compare against the exact bytes
 *     we handed the writer. Catches a no-op write, a partial write, and a
 *     competing writer that landed inside the window.
 *  2. SEMANTIC CHANGE SET — reclassify `snapshot → observed` and require the
 *     changed YAML paths to still equal the set the operator approved. This
 *     is the check that catches "the added block is absent" even if the byte
 *     compare were ever relaxed or defeated. Compared as a SET (order- and
 *     duplicate-insensitive) rather than positionally.
 *
 * Byte-exactness is safe here: `expected` originates from
 * `readFileSync(scratch, "utf8")` inside the validator's `applyPatch`, so it
 * can carry no lone surrogates, and the writer encodes with the same utf-8
 * codec we decode with — the string→bytes→string round trip is lossless.
 * `git apply` runs with `--whitespace=nowarn` (warn-suppression, NOT `fix`),
 * and every transformation applyPatch performs happens BEFORE `expected`
 * exists, so nothing downstream of the caller's write can legitimately alter
 * the bytes. The only remaining source of divergence is a writer outside the
 * apply mutex (documented residual race) — which is exactly what we want to
 * fail on, not tolerate.
 *
 * SCOPE: this reads back the SAME path it wrote, so it cannot detect a write
 * to the WRONG file — an aliased-or-wrong path reads back perfectly. That half
 * is {@link checkConfigPathProvenance}'s job, asserted BEFORE the write
 * (#4661 follow-up). The two compose and neither subsumes the other: a correct
 * path can still swallow a write, and a landed write to the wrong file is
 * still invisible to every other reader.
 */
function verifyConfigWriteObserved(
  configPath: string,
  expected: string,
  snapshot: string,
  proposedChangedPaths: string[],
): ConfigWriteObservation {
  const expectedBuf = Buffer.from(expected, "utf-8");
  let observed: Buffer;
  let size: number | null = null;
  let mtimeMs: number | null = null;
  try {
    observed = readFileSync(configPath);
    const st = statSync(configPath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch (e) {
    return {
      ok: false,
      reasons: [`post-write read-back of ${configPath} failed: ${(e as Error).message}`],
      observed: null,
      size: null,
      mtimeMs: null,
    };
  }
  const reasons: string[] = [];
  if (!observed.equals(expectedBuf)) {
    let firstDiff = 0;
    const min = Math.min(observed.length, expectedBuf.length);
    while (firstDiff < min && observed[firstDiff] === expectedBuf[firstDiff]) {
      firstDiff += 1;
    }
    reasons.push(
      `written bytes are not observable at ${configPath} ` +
        `(expected ${expectedBuf.length} bytes, read back ${observed.length}, ` +
        `first difference at offset ${firstDiff})`,
    );
  }
  // Independent of the byte compare: does the file on disk still MEAN what
  // the operator approved? A parse failure fails safe inside
  // classifyBlastRadius (`["<unparseable>"]`), which cannot match an
  // approved set, so a corrupted file trips this too.
  const observedChangedPaths = classifyBlastRadius(
    snapshot,
    observed.toString("utf-8"),
  ).changedPaths;
  const approvedSet = new Set(proposedChangedPaths);
  const observedSet = new Set(observedChangedPaths);
  const sameSet =
    approvedSet.size === observedSet.size &&
    [...approvedSet].every((p) => observedSet.has(p));
  if (!sameSet) {
    reasons.push(
      `on-disk change set diverged from what was approved ` +
        `(approved: [${[...approvedSet].sort().join(", ")}]; ` +
        `observed on disk: [${[...observedSet].sort().join(", ")}])`,
    );
  }
  return { ok: reasons.length === 0, reasons, observed, size, mtimeMs };
}

const STATUS_RETENTION_MS = 10 * 60 * 1000; // 10 min
const STATUS_MAX_ENTRIES = 256;

/** Tail length for stdout/stderr in audit + response frames. */
const TAIL_BYTES = 4096;

/**
 * #2487 item 7 — minimum age before a `started` fleet-mutation row with no
 * terminal counterpart is treated as ORPHANED on hostd boot. A normal
 * mutation completes (and writes its terminal row) well under this; only a
 * mutation whose process died without finishing (SIGKILL mid-rollout)
 * leaves a `started` row this stale. Conservative (15 min) so an in-flight
 * mutation that legitimately spans a quick hostd restart isn't falsely
 * flagged. Exported so the boot-reconcile test can pin the threshold.
 */
export const ORPHAN_RECONCILE_AGE_MS = 15 * 60 * 1000;

/**
 * Request-id prefix for watcher-initiated unattended rollouts (KEN-131,
 * `release.auto_update`). The prefix is the durable marker for "no
 * operator/agent is driving this roll": it survives the self-bump
 * resume marker (which round-trips only the request_id + args), so the
 * hardened no-operator failure path (rollback + alert card, no silent
 * retry) applies identically to a roll resumed after a hostd self-bump.
 */
export const AUTO_ROLLOUT_REQUEST_PREFIX = "auto-rollout-";

/** True when a request_id names an unattended auto-update rollout. */
export function isAutoRolloutRequestId(requestId: string): boolean {
  return requestId.startsWith(AUTO_ROLLOUT_REQUEST_PREFIX);
}

/**
 * KEN-131 — durable failed/attempted latch for unattended auto-update
 * rolls, persisted under the hostd state dir. An in-memory-only latch is
 * structurally insufficient: hostd restarts are ROUTINE on this path (the
 * self-bump recreates hostd's own container on essentially every auto
 * roll, and crash-loops / host reboots clear process memory), so a broken
 * release plus any restart would re-roll the same failed pin every
 * watcher tick — bouncing the canary agent indefinitely with no operator
 * in the loop. The latch is therefore written to disk AT LAUNCH
 * (`outcome: "attempting"`) and cleared only on a confirmed green roll;
 * a failure updates it to `"failed"`. Either state refuses an unattended
 * retry of the SAME pin across restarts and crash windows (a roll that
 * died mid-flight leaves `"attempting"` behind — exactly the case where
 * an unattended retry is least safe). A NEWER published release
 * supersedes the latch; the operator recovers by fixing the cause and
 * rolling manually (`switchroom rollout --pin <target>`), which advances
 * the durable pin and quiesces the check.
 */
export const AUTO_ROLLOUT_LATCH_FILENAME = "auto-rollout-latch.json";

interface AutoRolloutLatch {
  v: 1;
  pin: string;
  request_id: string;
  outcome: "attempting" | "failed";
  at: string;
  reason?: string;
}

/**
 * Last-resort config path when neither an explicit `opts.configPath`, nor
 * `$SWITCHROOM_CONFIG`, nor {@link findConfigFile} can name one. This is the
 * container path `hostd install` bind-mounts `~/.switchroom/switchroom.yaml`
 * onto (`src/cli/hostd.ts` — the `:/state/config/switchroom.yaml:rw` mount and
 * the `SWITCHROOM_CONFIG` it exports alongside it).
 *
 * Exported so a test can assert the fallback is the LAST arm, not the first.
 */
export const HOSTD_FALLBACK_CONFIG_PATH = CANONICAL_CONFIG_PATH;

/**
 * Result of comparing the file hostd would WRITE against the file the rest of
 * the fleet READS. `ok: false` is the only interesting case; `detail` is
 * operator-facing prose naming both paths and how they were compared.
 */
export interface ConfigPathProvenance {
  ok: boolean;
  /** The write target under scrutiny, verbatim. */
  writePath: string;
  /** What the fleet's own resolver named, or null when it could not name one. */
  resolvedPath: string | null;
  /**
   * True when the verdict rests on FILE IDENTITY (`st_dev` + `st_ino`) rather
   * than a string comparison. A `false` here on a `!ok` verdict means "these
   * are different strings and we could not prove anything about the inodes".
   */
  identityChecked: boolean;
  detail: string;
}

/** The `stat(2)` fields that define file identity. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

/** Default identity probe: `stat(2)`, which follows symlinks. */
function statIdentity(path: string): FileIdentity {
  const st = statSync(path);
  return { dev: st.dev, ino: st.ino };
}

/**
 * #4661 follow-up — does hostd write the file the fleet reads?
 *
 * `handleConfigProposeEdit` resolves its write target from the WIRE literal
 * (`req.args.target_path`, pinned to {@link CANONICAL_CONFIG_PATH}) whenever no
 * explicit `opts.configPath` is set — i.e. in production, since `main.ts` never
 * passes one. The reconcile child resolves its own config through
 * {@link findConfigFile} (`$SWITCHROOM_CONFIG` → cwd → `~/.switchroom`). Those
 * two agree today only because `hostd install` exports `SWITCHROOM_CONFIG`
 * pointing at the bind mount. Nothing enforced it, and on divergence hostd
 * wrote file X, reconciled file Y, and returned `completed, exit_code: 0` for a
 * change absent from the file everything else reads.
 *
 * The reconcile spawn now pins `SWITCHROOM_CONFIG` to the write target, so the
 * CHILD can no longer diverge. This function covers what is left: HOSTD-INTERNAL
 * consistency between the write target and hostd's OWN `findConfigFile()`
 * answer — the same resolver hostd's `loadConfig()` and pin journal use. It
 * cannot speak for the rest of the fleet: `findConfigFile()` is evaluated inside
 * the hostd container against hostd's cwd, `$HOME` and mount namespace, while an
 * agent container or the operator's host shell resolve in namespaces hostd
 * cannot observe. A divergence hostd CAN see is nonetheless proof that the write
 * is landing somewhere hostd itself would not read back, so the write must not
 * happen.
 *
 * Deliberately quiet about the cases that are NOT divergence, because a check
 * that cries wolf on every boot is worse than no check:
 *
 *  - **Resolver throws** (`No switchroom.yaml found`) → `ok`. It proves nothing
 *    about divergence, and the child would fail loudly on its own rather than
 *    silently reconcile a different file.
 *  - **Two names for one file** → `ok` when both sides carry the same
 *    `st_dev` + `st_ino`. `/state/config/switchroom.yaml` IS another name for
 *    `~/.switchroom/switchroom.yaml` in the shipped install, so comparing raw
 *    strings would fire on every single boot. Identity is compared as
 *    dev+inode rather than `realpath(2)` deliberately: `realpath` does NOT
 *    collapse a bind mount (a file bind-mounted to a second path realpaths to
 *    that second path) nor a hard link, so a realpath compare would report a
 *    DIFFERENT file for two names that are provably the same bytes — the exact
 *    false alarm this check must not raise. dev+inode is the definition.
 *  - **`stat` throws** (either side missing) → fall back to the string compare
 *    and SAY so in `detail` (`identityChecked: false`), so a mismatch report is
 *    never read as inode-level evidence when it is not.
 *
 * `findConfigFile` already `resolve()`s a relative `$SWITCHROOM_CONFIG` against
 * cwd, so a relative env value cannot produce a spurious string mismatch.
 */
export function checkConfigPathProvenance(
  writePath: string,
  resolveFleetConfig: () => string = findConfigFile,
  identify: (p: string) => FileIdentity = statIdentity,
): ConfigPathProvenance {
  let resolvedPath: string;
  try {
    resolvedPath = resolveFleetConfig();
  } catch (e) {
    return {
      ok: true,
      writePath,
      resolvedPath: null,
      identityChecked: false,
      detail:
        `fleet config resolver could not name a config file ` +
        `(${(e as Error).message}) — nothing to compare against ${writePath}`,
    };
  }
  if (resolvedPath === writePath) {
    return {
      ok: true,
      writePath,
      resolvedPath,
      identityChecked: false,
      detail: `write target and fleet config path are the same string (${writePath})`,
    };
  }
  let write: FileIdentity;
  let fleet: FileIdentity;
  try {
    write = identify(writePath);
    fleet = identify(resolvedPath);
  } catch (e) {
    return {
      ok: false,
      writePath,
      resolvedPath,
      identityChecked: false,
      detail:
        `write target ${writePath} differs from the fleet config path ` +
        `${resolvedPath}, and file identity could not be established ` +
        `(${(e as Error).message}) — compared as strings, not inodes`,
    };
  }
  if (write.dev === fleet.dev && write.ino === fleet.ino) {
    return {
      ok: true,
      writePath,
      resolvedPath,
      identityChecked: true,
      detail:
        `write target ${writePath} and fleet config path ${resolvedPath} are ` +
        `two names for the SAME file (dev=${write.dev} ino=${write.ino})`,
    };
  }
  return {
    ok: false,
    writePath,
    resolvedPath,
    identityChecked: true,
    detail:
      `write target ${writePath} (dev=${write.dev} ino=${write.ino}) is a ` +
      `DIFFERENT file from the config the fleet reads, ${resolvedPath} ` +
      `(dev=${fleet.dev} ino=${fleet.ino}) — a write here would be invisible ` +
      `to every other reader`,
  };
}

/**
 * Greppable tag for the boot-time path-provenance warning. Distinct and
 * stable so an operator (or a log alert) can match exactly this condition.
 */
export const CONFIG_PATH_PROVENANCE_TAG = "hostd-config-path-provenance";

/**
 * Boot-time assertion that hostd's canonical write target is the file the
 * fleet reads. Returns the log line to emit, or null when they agree.
 *
 * LOGS, never refuses: a config-layout change that trips this would otherwise
 * take hostd down entirely — losing every other verb, including the rollout
 * path — to protect one verb that has its own apply-time gate
 * (`E_CONFIG_PATH_MISMATCH`). A loud line plus a hard gate at the point of
 * damage beats a crash-loop at boot.
 */
export function configPathProvenanceWarning(
  resolveFleetConfig: () => string = findConfigFile,
  identify: (p: string) => FileIdentity = statIdentity,
): string | null {
  const prov = checkConfigPathProvenance(
    CANONICAL_CONFIG_PATH,
    resolveFleetConfig,
    identify,
  );
  if (prov.ok) return null;
  return (
    `${CONFIG_PATH_PROVENANCE_TAG}: ${prov.detail}. ` +
    `config_propose_edit will REFUSE with E_CONFIG_PATH_MISMATCH until this ` +
    `agrees — check the hostd bind mount over ${CANONICAL_CONFIG_PATH} and ` +
    `the SWITCHROOM_CONFIG it exports alongside it.`
  );
}

/**
 * Resolve the live `switchroom.yaml` this daemon reads/writes.
 *
 * This MUST agree, string-for-string, with what the rollout child resolves —
 * the child goes `getConfigPath` → {@link findConfigFile} → `$SWITCHROOM_CONFIG`
 * (`src/cli/rollout.ts`). It is not merely cosmetic agreement: the pin
 * journal's FILENAME is a digest of the absolute config path
 * (`pinJournalPath`, `src/cli/rollout-pin-journal.ts`), so a daemon that
 * resolves a different string than its child looks for a journal that does not
 * exist and silently recovers nothing — at boot and on every rollout terminal.
 * The older `dirname(configPath)` journal scheme degraded to "same directory,
 * wrong name"; digest keying degrades to "invisible".
 *
 * Order:
 *   1. an explicit `opts.configPath` (tests, and any future embedder);
 *   2. {@link findConfigFile} — **the child's own resolver, called directly**.
 *      It consults `$SWITCHROOM_CONFIG` first (what `hostd install` exports
 *      into the container), then cwd, then `~/.switchroom`;
 *   3. {@link HOSTD_FALLBACK_CONFIG_PATH}, only when 2 comes up empty (a
 *      hostd whose config has been deleted out from under it —
 *      `findConfigFile` THROWS there, and a throw out of a boot path or a
 *      rollout `.finally()` would be worse than a wrong-but-conventional
 *      guess).
 *
 * Arm 2 deliberately DELEGATES rather than re-deriving. An earlier shape read
 * `$SWITCHROOM_CONFIG` here itself and returned it unconditionally, one arm
 * ahead of `findConfigFile`. That looked equivalent — `findConfigFile` checks
 * the same variable first — but it is not: the child takes `$SWITCHROOM_CONFIG`
 * only `if (existsSync(envPath))` and otherwise falls through to cwd /
 * `~/.switchroom`. With the variable pointing at a path that does not exist,
 * hostd returned the dangling path while the child resolved a real file, the
 * two hashed to different journal names, and the divergence this function
 * exists to prevent reappeared — invisibly. Calling the child's resolver makes
 * the agreement structural instead of a claim two code paths have to keep
 * honouring independently.
 */
export function resolveHostdConfigPath(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return findConfigFile();
  } catch {
    return HOSTD_FALLBACK_CONFIG_PATH;
  }
}

export class HostdServer {
  // One Server per bound socket path. `node:net.Server.listen` can
  // only be called once per instance — to bind N agent sockets we
  // need N servers. Map: bindPath → Server.
  private servers = new Map<string, Server>();
  private statusByRequestId = new Map<string, StatusEntry>();
  /** Serializes audit-log appends. A redacted terminal row can be
   *  ~4 KiB — above Linux PIPE_BUF (4096), so concurrent appendFile
   *  calls (e.g. a terminal write racing a parallel agent_logs
   *  writeAudit) are no longer guaranteed atomic and could interleave
   *  into a corrupt JSONL line. Chaining the writes keeps every row
   *  whole; parseAuditLine still tolerates a torn line defensively. */
  private auditAppendChain: Promise<void> = Promise.resolve();
  /** sec WS10-F2 / #1417: per-row tamper-evidence hash-chain position.
   *  Seeded lazily from the existing log inside the serialized append
   *  section (so the seed read and the first chained write can't race
   *  the request path) and advanced only after a durable append. */
  private auditChainState: ChainState | undefined;
  /** idempotency_key → request_id of the canonical (first) call. */
  private idempotencyKeys = new Map<string, { request_id: string; ts: number }>();
  /**
   * Fleet-wide mutation lock — set while a long-running fleet
   * mutation (`update_apply` or `apply`) is in flight. Phase 2 verb
   * dispatchers consult this to refuse concurrent fleet mutations
   * with `denied`, with the in-flight verb's request_id in the reason
   * so the caller can `get_status` the existing run.
   *
   * Why fleet-wide and not per-verb: `update_apply` regenerates the
   * compose file + recreates containers — if it runs concurrently
   * with `apply` (which ALSO regenerates compose), the second one
   * sees a half-written compose mid-write. A single mutex
   * serializes both verbs even though they're different ops.
   *
   * Per-agent verbs (`agent_start`/`agent_stop`/`agent_restart`)
   * are NOT gated by this lock — `docker compose <op> <service>` is
   * service-scoped, and serializing across agents would prevent the
   * common "fleet boot in parallel" case for no real safety win.
   */
  private fleetMutationInFlight:
    | {
        op: "update_apply" | "apply" | "rollout";
        request_id: string;
        started_at: number;
      }
    | null = null;

  /**
   * KEN-131 — pin of the most recent FAILED unattended auto-update roll.
   * An unattended canary failure must NOT retry-loop every watcher tick
   * (each retry bounces the canary onto the same broken build); the
   * watcher's checkFn keeps reporting "available" until the durable pin
   * advances, so this latch refuses re-rolls of the same target. This
   * field is only the in-memory fast path / disk-write-failure fallback;
   * the AUTHORITATIVE latch is the on-disk file
   * ({@link AUTO_ROLLOUT_LATCH_FILENAME}) — see its doc comment for why
   * an in-memory latch alone would retry-loop across the routine hostd
   * restarts on this path (self-bump container recreate, crash-loops,
   * host reboots). Superseded by a NEWER target pin.
   */
  private lastAutoRolloutFailedPin: string | null = null;

  /** Path of the durable auto-rollout latch file. */
  private autoRolloutLatchPath(): string {
    return join(this.hostdDirPath(), AUTO_ROLLOUT_LATCH_FILENAME);
  }

  /** Read + validate the durable latch; null when absent/malformed. */
  private readAutoRolloutLatch(): AutoRolloutLatch | null {
    try {
      const raw = readFileSync(this.autoRolloutLatchPath(), "utf-8");
      const parsed = JSON.parse(raw) as AutoRolloutLatch;
      if (
        parsed &&
        parsed.v === 1 &&
        typeof parsed.pin === "string" &&
        parsed.pin.length > 0 &&
        (parsed.outcome === "attempting" || parsed.outcome === "failed")
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * KEN-131 — public read of the currently-latched auto-rollout target (the
   * durable file first, the in-memory fallback second), or null when none.
   *
   * Wired into the auto-update `checkFn` so a latched version stops being
   * reported as "available": without it, the pin never advances, so every
   * watcher tick re-enters `applyFn`, gets refused by this same latch, and
   * appends another `apply_failed` row to the telemetry log — forever, until
   * an operator intervenes.
   */
  autoRolloutLatchedPin(): string | null {
    return this.readAutoRolloutLatch()?.pin ?? this.lastAutoRolloutFailedPin;
  }

  /** Best-effort durable latch write — must NEVER throw into a roll path.
   *  A write failure degrades to the in-memory latch (logged). */
  private writeAutoRolloutLatch(latch: AutoRolloutLatch): void {
    try {
      mkdirSync(this.hostdDirPath(), { recursive: true });
      writeFileSync(this.autoRolloutLatchPath(), JSON.stringify(latch, null, 2), {
        mode: 0o600,
      });
    } catch (e) {
      process.stderr.write(
        `hostd: auto-rollout latch write failed (falling back to in-memory ` +
          `latch for this process lifetime): ${(e as Error).message}\n`,
      );
    }
  }

  /** Best-effort durable latch clear (green roll / superseded target). */
  private clearAutoRolloutLatch(): void {
    try {
      unlinkSync(this.autoRolloutLatchPath());
    } catch {
      // Absent or unremovable — absent is the common case; unremovable
      // only ever over-blocks (fail-safe direction).
    }
  }

  /**
   * #2726 Part 2 — optional in-chat narration renderer. When wired (via
   * `ServerOptions.rolloutNarrator`), each rollout phase transition is fed to
   * it so it edits ONE ordinary operator-DM message through the phases. Left
   * unset in Part 1 (durable observability ships alone); a null narrator makes
   * `onRolloutPhase` a pure audit-writer. The renderer PULLS from what it's fed
   * and holds no lifecycle state that a gateway restart could orphan. */
  private get rolloutNarrator(): RolloutNarrator | undefined {
    return this.opts.rolloutNarrator;
  }

  constructor(private opts: ServerOptions) {}

  /**
   * The live `switchroom.yaml` this daemon reads/writes.
   *
   * See {@link resolveHostdConfigPath} for why this is NOT a hardcoded
   * container path.
   */
  private hostdConfigPath(): string {
    return resolveHostdConfigPath(this.opts.configPath);
  }

  /**
   * The FLEET compose file (not hostd's own). Same resolution as
   * {@link imageRefsForDigestCapture} uses.
   */
  private fleetComposePath(): string {
    return join(
      this.opts.bindRoot ?? this.opts.homeDir,
      ".switchroom",
      "compose",
      "docker-compose.yml",
    );
  }

  /**
   * Revert an UNCOMMITTED provisional `release.pin` left behind by a rollout
   * that died before it could commit or revert its own write.
   *
   * The rollout child normally handles both outcomes itself (commit on
   * success, revert on a clean failure), so this is purely the crash net:
   * SIGKILL / OOM / hostd recreate between the pin write and the terminal.
   * It is a no-op when no journal exists, which is why it's safe to call
   * unconditionally at boot.
   *
   * NOT safe on every rollout terminal: a roll can succeed and still leave a
   * journal behind when the child's own commit-unlink fails, and reverting
   * THERE would roll back a proven pin. The terminal handler therefore routes
   * a structurally-successful roll to {@link clearProvenRolloutPinJournal}
   * instead. At BOOT there is no sentinel to consult, so the stale gate
   * (writer dead / journal aged out) is all we have — which is why a journal
   * that survives a successful commit must be reported loudly.
   *
   * Never throws — a stranded lock or a failed boot would be worse than the
   * stale pin it's fixing, so failures are reported and swallowed.
   */
  private recoverRolloutPinJournal(context: string): string | null {
    let note: string | null = null;
    try {
      note = recoverPinJournal(this.hostdConfigPath());
    } catch (e) {
      note = `rollout pin journal recovery threw: ${(e as Error).message}`;
    }
    if (note) process.stderr.write(`hostd (${context}): ${note}\n`);
    return note;
  }

  /**
   * The PROVEN-roll counterpart of {@link recoverRolloutPinJournal}: delete a
   * journal that outlived a roll the child structurally reported as `ok:true`.
   *
   * The child already tried this (`commitPin`) and surfaced its failure in the
   * roll's warnings; this is the second attempt, from a different process,
   * after the child's file handles are gone. It must NEVER revert: the pin it
   * would revert is the one the roll just proved. A journal we cannot clear is
   * reported so the operator can delete it host-side — while it exists, hostd's
   * BOOT recovery (which has no sentinel to consult) will eventually revert
   * that proven pin.
   *
   * **Only deletes a journal it can ATTRIBUTE to this roll.** "A journal
   * exists and this roll succeeded" does not imply the journal is this roll's
   * debris: the child journals only when it actually writes the pin, and it
   * no-ops when the config already names the target (`createRolloutDeps`'
   * `persistPin`). So a journal can equally be an ORPHAN a predecessor left
   * behind — and on a subset roll (`--agents`, which hostd passes alongside
   * `--pin`) that orphan is the only record that `release.pin` names a build
   * still unproven for every agent this roll did not touch. Deleting it
   * because some other roll went green destroys that record permanently.
   *
   * The discriminator is already in the record: the journal carries the `at`
   * the child wrote it, and `entry.started_at` is when this roll's child was
   * spawned. `journal.at < started_at` means the journal predates this roll,
   * so this roll did not write it — leave it, and say so.
   *
   * Never throws — same contract as the recovery path it replaces.
   */
  private clearProvenRolloutPinJournal(
    context: string,
    startedAt: number,
  ): string | null {
    let note: string | null = null;
    try {
      const configPath = this.hostdConfigPath();
      if (!hasPinJournal(configPath)) return null;
      const journal = readPinJournal(configPath, () => undefined);
      const at = journal ? Date.parse(journal.at) : Number.NaN;
      // An unreadable/malformed journal (readPinJournal returns null) or an
      // unparseable timestamp cannot be attributed either — same verdict.
      //
      // `<` vs `<=` is a genuine 1 ms tie (a journal stamped in the same
      // millisecond the child was spawned) and is deliberately left untested:
      // the two verdicts differ only for that single millisecond, both are
      // defensible there, and the safe one is reachable either way. Don't read
      // a surviving `<=` mutant here as a coverage gap — the discriminating
      // input shape does not exist in production.
      if (!Number.isFinite(at) || at < startedAt) {
        note =
          `rollout pin journal: LEFT IN PLACE a journal this roll did not ` +
          `write (journal at=${journal?.at ?? "unreadable"}, this roll started ` +
          `${new Date(startedAt).toISOString()}). It belongs to an earlier ` +
          `roll whose provisional \`release.pin\` was never committed, and it ` +
          `is the only record that the pin may name an unproven build — a ` +
          `subset roll going green does not prove it for the rest of the ` +
          `fleet. Verify \`release.pin\` host-side, then delete the journal.`;
      } else {
        const err = commitPinPersist(configPath);
        note =
          err ??
          `rollout pin journal: cleared a journal that outlived a SUCCESSFUL ` +
            `roll (the child's own commit did not remove it). release.pin is ` +
            `correct and was NOT reverted.`;
      }
    } catch (e) {
      note = `rollout pin journal: clearing a proven roll's journal threw: ${(e as Error).message}`;
    }
    if (note) process.stderr.write(`hostd (${context}): ${note}\n`);
    return note;
  }

  /** Start listening on every configured agent's socket. */
  async start(): Promise<void> {
    const hostdDir = join(this.opts.homeDir, ".switchroom", "hostd");
    await mkdir(hostdDir, { recursive: true });
    // 0o755 (not 0o700) so the operator's compose generator can
    // existsSync(<hostdDir>/<agentName>) at apply time — the dir
    // listing is needed to emit the per-agent bind mount into the
    // agent service. Confidentiality of incoming connections is
    // enforced by the SOCKET mode (0o660) + chown-to-agent-uid below,
    // not by the dir mode. The dir only ever contains other agent
    // subdirs + sockets, all of which are themselves access-controlled.
    // Pre-fix the daemon bound sockets but compose silently skipped
    // every bind mount because the operator's uid couldn't traverse
    // a root-owned 0700 dir, so no agent could ever reach the daemon.
    await chmod(hostdDir, 0o755).catch(() => undefined);

    // #2645 — self-bump boot resume. MUST run before the sockets bind
    // (so no incoming request can race the fleet-mutation lock the resume
    // takes) and before the orphan sweep below (a resumable roll isn't an
    // orphan — its terminal row is still coming). Best-effort: a resume
    // failure logs + terminal-rows but never blocks boot.
    await this.resumePendingSelfBumpRollout().catch((e) => {
      process.stderr.write(
        `hostd: self-bump resume failed (non-fatal): ${(e as Error).message}\n`,
      );
    });

    // Rollout pin-journal crash recovery. A roll that was SIGKILLed between
    // its provisional `release.pin` write and the commit leaves a journal on
    // disk; without this, the durable pin names a build that was never proven
    // and EVERY later restart / crash-loop recreate / reconcile / `compose up
    // -d` converges the rest of the fleet onto it. No-op when nothing is
    // journalled.
    //
    // ORDERING, precisely: awaiting `resumePendingSelfBumpRollout()` above does
    // NOT mean a resumed roll has finished. That path ends at `launchRollout`,
    // which takes the fleet-mutation latch, calls `spawnRollout`, and returns
    // SYNCHRONOUSLY — the roll then runs for minutes in a child process. So a
    // journal seen here may well belong to a roll that is still running, and
    // reverting it would fight a live roll (and could revert the pin of one
    // that is about to succeed).
    //
    // Two independent guards, deliberately belt-and-braces:
    //   1. the latch check below — if a resume is in flight, boot recovery is
    //      skipped outright and that roll's own terminal handler runs recovery
    //      when it finishes (see the rollout terminal `.finally()`);
    //   2. `recoverPinJournal` is stale-gated regardless: it reverts only when
    //      the journal's recorded pid is gone OR the journal has aged past
    //      PIN_JOURNAL_MAX_AGE_MS, so even a journal from a roll hostd doesn't
    //      know about (a host-shell `switchroom rollout`) is left alone while
    //      it is plausibly live.
    if (this.fleetMutationInFlight) {
      process.stderr.write(
        `hostd (boot): a rollout resumed at boot is still in flight — ` +
          `deferring pin-journal recovery to its terminal handler.\n`,
      );
    } else {
      this.recoverRolloutPinJournal("boot");
    }

    const agentNames = Object.keys(this.opts.agentUids).sort();
    if (agentNames.length === 0) {
      // No admin agents declared yet. Phase 1 no-op exit — the
      // compose generator only emits the daemon when there's at
      // least one admin agent, so reaching this branch in production
      // would be a config-generator bug.
      return;
    }

    // Partial-bind safety: if listen() rejects for agent N, the
    // sockets bound for agents 0..N-1 are still live. Without
    // cleanup the daemon would leave half its sockets in service
    // and main.ts would exit with the exception, stranding the
    // bound paths on disk. Wrap each iteration; on first failure,
    // tear down everything we've bound and rethrow.
    try {
      for (const name of agentNames) {
        const dir = join(hostdDir, name);
        const sockPath = join(dir, "sock");
        await mkdir(dir, { recursive: true });
        // Same rationale as the parent dir above: 0o755 so the
        // operator's `existsSync(<dir>)` in compose.ts succeeds;
        // socket-level mode + chown is the security boundary.
        await chmod(dir, 0o755).catch(() => undefined);
        if (existsSync(sockPath)) await unlink(sockPath).catch(() => undefined);

        const server = createServer((socket) =>
          this.onConnection(socket, sockPath),
        );
        server.on("error", (err) => {
          process.stderr.write(`hostd: server error on ${sockPath}: ${err.message}\n`);
        });

        await new Promise<void>((resolve, reject) => {
          server.listen(sockPath, () => resolve());
          server.once("error", reject);
        });
        await chmod(sockPath, 0o660).catch(() => undefined);
        if (process.platform === "linux" && !this.opts.allowNonLinux) {
          await chown(sockPath, this.opts.agentUids[name]!, -1).catch((err) => {
            process.stderr.write(
              `hostd: chown(${sockPath}, uid=${this.opts.agentUids[name]}): ${(err as Error).message}\n`,
            );
          });
        }
        this.servers.set(sockPath, server);
      }

      // Operator socket — host-shell reachable. Without this, hostd is
      // ONLY reachable agent→hostd (per-agent sockets are agent-UID-
      // owned 0660); the host operator's `switchroom doctor` etc. have
      // no transport. Mirrors the vault-broker / auth-broker operator-
      // listener pattern: bind `<hostdDir>/operator/sock`, mode 0600,
      // chowned to the operator UID. peercred maps this path to
      // kind:"operator" and checkGate leaves it ungated (the operator
      // IS root-equivalent on its own host). Inside the try so the
      // partial-bind teardown covers it. No-op when the operator UID
      // env is unset (tests / a legacy compose without it) — same
      // posture as the broker.
      const opUidStr = process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
      if (opUidStr !== undefined) {
        const opUid = Number.parseInt(opUidStr, 10);
        if (!Number.isFinite(opUid) || opUid <= 0) {
          process.stderr.write(
            `hostd: SWITCHROOM_HOSTD_OPERATOR_UID='${opUidStr}' is not a positive integer; skipping operator listener\n`,
          );
        } else {
          const dir = join(hostdDir, "operator");
          const sockPath = join(dir, "sock");
          await mkdir(dir, { recursive: true });
          await chmod(dir, 0o755).catch(() => undefined);
          if (existsSync(sockPath)) await unlink(sockPath).catch(() => undefined);
          const server = createServer((socket) =>
            this.onConnection(socket, sockPath),
          );
          server.on("error", (err) => {
            process.stderr.write(
              `hostd: server error on ${sockPath}: ${err.message}\n`,
            );
          });
          await new Promise<void>((resolve, reject) => {
            server.listen(sockPath, () => resolve());
            server.once("error", reject);
          });
          // 0600 (not 0660 like the per-agent sockets): operator-only.
          await chmod(sockPath, 0o600).catch(() => undefined);
          if (process.platform === "linux" && !this.opts.allowNonLinux) {
            await chown(sockPath, opUid, opUid).catch((err) => {
              process.stderr.write(
                `hostd: chown(${sockPath}, uid=${opUid}): ${(err as Error).message}\n`,
              );
            });
          }
          this.servers.set(sockPath, server);
        }
      }
    } catch (err) {
      await this.stop();
      throw err;
    }

    // #2487 item 7 — orphaned-`started`-row reconcile guard. A fleet
    // mutation (update_apply / apply / rollout) records a synchronous
    // `started` audit row, then a `terminal` row when the spawned child
    // finishes. If hostd is SIGKILLed mid-mutation (e.g. a rollout's
    // hostd-refresh recreated this very container — brick scenario #1),
    // the terminal row never lands: the fleet is left half-rolled and the
    // status shows a perpetual `started`. On the next boot we scan for
    // such orphans and emit a LOUD terminal failure row so the gap is
    // detectable (via /audit hostd / get_status) instead of silently
    // hanging forever. Best-effort: never throws, never blocks boot.
    await this.reconcileOrphanedFleetMutations().catch((e) => {
      process.stderr.write(
        `hostd: orphan-reconcile sweep failed (non-fatal): ${(e as Error).message}\n`,
      );
    });
  }

  /**
   * Scan the audit log for fleet-mutation `started` rows with no matching
   * `terminal` row, older than {@link ORPHAN_RECONCILE_AGE_MS}, and append
   * a loud terminal failure row for each (#2487 item 7). Emits
   * `rollout_orphaned` for rollout ops and `update_failed` for
   * update_apply/apply — the gateway / audit reader can branch on op +
   * this synthetic phase to alert the operator. A row that ALREADY has a
   * terminal counterpart, or that we already reconciled (its synthetic
   * row exists), is skipped — the sweep is idempotent across reboots.
   */
  private async reconcileOrphanedFleetMutations(): Promise<void> {
    const path = this.auditLogPath();
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return;
    }
    const FLEET_OPS = new Set(["update_apply", "apply", "rollout"]);
    // request_id → started row info; cleared when a terminal/orphan row
    // for the same request_id is seen.
    const startedRows = new Map<
      string,
      { op: string; ts: number; caller_name?: string }
    >();
    for (const line of raw.split("\n")) {
      const e = parseAuditLine(line);
      if (!e) continue;
      // Our synthetic orphan row (op=rollout_orphaned/update_failed,
      // phase=orphan_reconciled) carries the ORIGINAL request_id and
      // resolves the started — checked BEFORE the FLEET_OPS filter since
      // its own op is not a fleet op. This makes the sweep idempotent.
      if (e.phase === "orphan_reconciled") {
        startedRows.delete(e.request_id);
        continue;
      }
      if (!FLEET_OPS.has(e.op)) continue;
      // A terminal row resolves the started.
      if (e.phase === "terminal") {
        startedRows.delete(e.request_id);
        continue;
      }
      // Synchronous request-path `started` row (no phase).
      if (e.result === "started" && e.phase === undefined) {
        const tsMs = Date.parse(e.ts);
        startedRows.set(e.request_id, {
          op: e.op,
          ts: Number.isFinite(tsMs) ? tsMs : Date.now(),
          caller_name: e.caller.kind === "agent" ? e.caller.name : undefined,
        });
      }
    }
    const now = Date.now();
    for (const [request_id, info] of startedRows) {
      if (now - info.ts < ORPHAN_RECONCILE_AGE_MS) continue; // too fresh
      const synthOp = info.op === "rollout" ? "rollout_orphaned" : "update_failed";
      process.stderr.write(
        `hostd: ORPHANED ${info.op} (request_id=${request_id}, ` +
          `started ${Math.floor((now - info.ts) / 60000)}m ago, no terminal ` +
          `row) — emitting ${synthOp}. The fleet may be half-rolled; verify ` +
          `host-side.\n`,
      );
      await this.appendAuditRow({
        ts: new Date().toISOString(),
        op: synthOp,
        phase: "orphan_reconciled",
        // Carry the ORIGINAL request_id so the terminal row resolves the
        // orphan on the next boot's sweep (idempotency).
        request_id,
        original_op: info.op,
        caller: info.caller_name
          ? { kind: "agent", name: info.caller_name }
          : { kind: "operator" },
        result: "error",
        exit_code: null,
        duration_ms: now - info.ts,
        error:
          `${info.op} left a perpetual 'started' status with no terminal row ` +
          `(hostd likely SIGKILLed mid-mutation — brick scenario #1). ` +
          `Reconciled to a failure on hostd boot. The fleet may be ` +
          `half-rolled; verify versions host-side and re-run if needed.`,
      });
    }
  }

  /** Stop the server and clean up sockets. Idempotent. */
  async stop(): Promise<void> {
    const paths = [...this.servers.keys()];
    for (const [, server] of this.servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.servers.clear();
    for (const s of paths) {
      await unlink(s).catch(() => undefined);
    }
  }

  /** Test/observation hook — paths the server actually bound to. */
  getBoundPaths(): readonly string[] {
    return [...this.servers.keys()];
  }

  /** Test hook — clear retained status entries. */
  resetForTest(): void {
    this.statusByRequestId.clear();
    this.idempotencyKeys.clear();
  }

  private onConnection(socket: Socket, bindPath: string): void {
    // The bind path is closure-captured at server creation in
    // start() — one Server per agent path. This is the trusted
    // identity source: socketPathToIdentity parses the daemon's
    // OWN bind path, which an agent cannot influence.
    const identity = socketPathToIdentity(bindPath);
    if (!identity) {
      // Path doesn't parse — close. Caller can't be identified.
      // (Should be impossible with our own listen paths, but be
      // defensive.)
      socket.end();
      return;
    }

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // DoS guard: a malicious caller can stream bytes without ever
      // sending a newline and OOM the daemon if we just keep
      // appending. Cap the buffer at 2x MAX_FRAME_BYTES (same shape
      // as the client's incoming cap at client.ts) — one valid frame
      // plus a half-frame slack before we hard-close. The cap is
      // checked on every chunk, before the newline-search, so the
      // attacker can't slip past by chunk-aligning.
      if (Buffer.byteLength(buf, "utf8") > MAX_FRAME_BYTES * 2) {
        process.stderr.write(
          `hostd: closing connection — request exceeded ${MAX_FRAME_BYTES * 2} bytes without a newline\n`,
        );
        socket.destroy();
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      this.handleLine(line, identity, socket).catch((err) => {
        process.stderr.write(`hostd: handler error: ${(err as Error).message}\n`);
        socket.end();
      });
    });
    socket.on("error", () => undefined);
  }

  private async handleLine(
    line: string,
    caller: SocketIdentity,
    socket: Socket,
  ): Promise<void> {
    let req: HostdRequest;
    try {
      req = decodeRequest(line);
    } catch (err) {
      // Echo the caller's request_id when we can extract one (helps
      // them correlate the denial to their request); fall back to a
      // literal sentinel when the line wasn't even valid JSON or
      // didn't carry the field.
      let echoId = "malformed-request";
      try {
        const obj = JSON.parse(line) as { request_id?: unknown };
        if (typeof obj.request_id === "string" && obj.request_id.length > 0) {
          echoId = obj.request_id;
        }
      } catch {
        // Non-JSON line — keep the sentinel.
      }
      socket.write(
        encodeResponse(deniedResponse(echoId, `bad request: ${(err as Error).message}`)),
      );
      socket.end();
      return;
    }

    const now = Date.now();
    this.evictExpiredIdempotency(now);

    // sec host-control-F1: the authz gate MUST run BEFORE any idempotency
    // short-circuit. Previously the cache was consulted first, so a cached
    // result could be handed back before `checkGate` ever ran — and the
    // cache key was NOT scoped by caller, so caller B replaying caller A's
    // idempotency_key could be served A's mutation result, unaudited and
    // unauthorized. Gating first closes both halves: an unauthorized caller
    // is denied (and the denial is audited) before the cache is touched.
    const denied = this.checkGate(req, caller);
    if (denied) {
      const resp = deniedResponse(req.request_id, denied);
      await this.writeAudit({ caller, req, resp });
      socket.write(encodeResponse(resp));
      socket.end();
      return;
    }

    // Idempotency key is scoped by caller identity (sec host-control-F1) so
    // one caller's bucket can never collide with — or surface — another
    // caller's cached result. Consulted only after the gate above passes.
    const idempotencyKey = `${idempotencyScope(caller)} ${req.idempotency_key ?? req.request_id}`;
    const prior = this.idempotencyKeys.get(idempotencyKey);
    if (prior && now - prior.ts < IDEMPOTENCY_WINDOW_MS) {
      // Reuse the prior response if available. Note: only mutating
      // verbs (agent_restart) call recordStatus(), so the lookup
      // only hits a cached status for those. Read-only verbs
      // (upgrade_status, get_status) flow through here and re-run —
      // intentional: idempotency is about *mutation* safety, not
      // bandwidth saving on read-only queries.
      const cached = this.statusByRequestId.get(prior.request_id);
      if (cached) {
        socket.write(encodeResponse(this.statusEntryToResponse(req.request_id, cached)));
        socket.end();
        return;
      }
    }
    this.idempotencyKeys.set(idempotencyKey, { request_id: req.request_id, ts: now });

    // ── #1841 operator-attest 2nd factor (RFC §5.4) ──────────────────
    // Runs AFTER the admin/allowlist gate: attestation is an additional
    // factor, never a replacement. Inert unless the operator opted in
    // (`hostd.operator_attest_enabled`), so the default posture — and the
    // Telegram approval-card flow (#1427, layer 1) — is unchanged.
    const attest = await this.checkOperatorAttest(req, caller);
    if (attest.denied !== null) {
      const resp = deniedResponse(req.request_id, attest.denied);
      await this.writeAudit({ caller, req, resp, method: attest.method });
      socket.write(encodeResponse(resp));
      socket.end();
      return;
    }
    const attestMethod = attest.method;

    const started = Date.now();
    let resp: HostdResponse;
    try {
      switch (req.op) {
        case "agent_restart":
          resp = await this.handleAgentRestart(req, caller, started);
          break;
        case "upgrade_status":
          resp = await this.handleUpgradeStatus(req, started);
          break;
        case "get_status":
          resp = this.handleGetStatus(req, caller, started);
          break;
        // ── Phase 2 verbs ────────────────────────────────────────
        case "update_check":
          resp = await this.handleUpdateCheck(req, started);
          break;
        case "update_apply":
          resp = this.handleUpdateApply(req, caller, started);
          break;
        case "apply":
          resp = this.handleApply(req, caller, started);
          break;
        case "rollout":
          resp = await this.handleRollout(req, caller, started);
          break;
        case "agent_start":
          resp = await this.handleAgentStart(req, started);
          break;
        case "agent_stop":
          resp = await this.handleAgentStop(req, started);
          break;
        // ── Phase 3 admin-observability verbs ────────────────────
        case "agent_logs":
          resp = await this.handleAgentLogs(req, started);
          break;
        case "agent_exec":
          resp = await this.handleAgentExec(req, started);
          break;
        // ── Phase 3.1 read-only fleet doctor ─────────────────────
        case "doctor":
          resp = await this.handleDoctor(req, started);
          break;
        // ── Phase 3.2 read-only in-agent liveness battery ────────
        case "agent_smoke":
          resp = await this.handleAgentSmoke(req, started);
          break;
        // ── Dashboard read-ops (dockerless-web fix) ──────────────
        case "agent_status":
          resp = this.handleAgentStatus(req, started);
          break;
        case "agent_schedule":
          resp = this.handleAgentSchedule(req, started);
          break;
        // ── PR 1a (admin-agent-config-edit RFC) ──────────────────
        // Stub dispatcher: flag-gated disabled error or a
        // not-implemented marker. PR 1b adds validation; PR 1c adds
        // the approval card + apply path.
        case "config_propose_edit":
          resp = await this.handleConfigProposeEdit(req, caller, started);
          break;
      }
    } catch (e) {
      // #1761: top-level dispatch failure — no fix.kind applies
      // (genuine server fault). Envelope still carries the code so
      // agents can branch on `error_envelope.code` instead of regex.
      const msg = (e as Error).message;
      resp = err(
        "E_DISPATCH_FAILED",
        "hostd dispatch failed",
      )
        .why(msg)
        .op(req.op)
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .build(req.request_id, Date.now() - started);
      // Preserve the legacy error string for back-compat with existing
      // string-matching decoders.
      resp = { ...resp, error: `hostd dispatch failed: ${msg}` };
    }
    await this.writeAudit({ caller, req, resp, method: attestMethod });
    socket.write(encodeResponse(resp));
    socket.end();
  }

  /**
   * #1841 — operator-passphrase attestation (RFC §5.4, layer 3).
   *
   * Called AFTER `checkGate` (the admin/allowlist floor) passes. Returns
   * `{ denied: null }` to allow, or `{ denied: <reason> }` to reject. The
   * optional `method` is threaded onto the audit row for attribution.
   *
   * Posture:
   *   - Feature OFF (`operator_attest_enabled` !== true) ⇒ completely inert:
   *     the `operator_passphrase` field is IGNORED (present or absent), so
   *     behaviour is byte-identical to pre-#1841. Guarantees existing fleets
   *     and the Telegram approval-card flow are unaffected.
   *   - Operator socket caller ⇒ always allowed (already the fully-trusted
   *     first factor; the 2nd factor is for agent callers).
   *   - Feature ON + verb in `operator_attest_required_verbs` ⇒ a valid
   *     operator-passphrase attestation is REQUIRED (missing ⇒ denied;
   *     wrong/broker-unreachable ⇒ denied, fail-closed).
   *   - Feature ON + verb NOT required ⇒ accept-and-audit: a supplied
   *     attestation is verified (wrong ⇒ denied, fail-closed) and tagged;
   *     an absent one is allowed unchanged.
   *
   * hostd never holds the passphrase — verification is delegated to the
   * vault broker via `attestVerifier()`.
   */
  private async checkOperatorAttest(
    req: HostdRequest,
    caller: SocketIdentity,
  ): Promise<{ denied: string | null; method?: string }> {
    const hostdCfg = this.opts.config.hostd;
    if (hostdCfg?.operator_attest_enabled !== true) {
      // Feature inert — ignore any forwarded passphrase entirely.
      return { denied: null };
    }
    // Operator socket already carries the strongest identity; no 2nd factor.
    if (caller.kind === "operator") return { denied: null };

    const requiredVerbs =
      hostdCfg.operator_attest_required_verbs ?? DEFAULT_OPERATOR_ATTEST_VERBS;
    const required = requiredVerbs.includes(req.op);
    const passphrase = req.operator_passphrase;

    if (!required) {
      // Accept-and-audit: verify only when one is actually supplied.
      if (passphrase === undefined) return { denied: null };
      const v = await this.attestVerifier().verify(passphrase);
      return v.ok
        ? { denied: null, method: ATTEST_AUDIT_METHOD }
        : {
            denied: `${req.op} operator-attest failed: ${v.reason}`,
            method: ATTEST_AUDIT_METHOD,
          };
    }

    // Required verb — attestation is mandatory.
    if (passphrase === undefined) {
      return {
        denied:
          `${req.op} requires operator-passphrase attestation ` +
          `(hostd.operator_attest_enabled is on and ${req.op} is in ` +
          `operator_attest_required_verbs)`,
        method: ATTEST_AUDIT_METHOD,
      };
    }
    const v = await this.attestVerifier().verify(passphrase);
    return v.ok
      ? { denied: null, method: ATTEST_AUDIT_METHOD }
      : {
          denied: `${req.op} operator-attest failed: ${v.reason}`,
          method: ATTEST_AUDIT_METHOD,
        };
  }

  /** Lazily resolve the attestation verifier: the injected test seam, or
   *  the default broker-backed forwarder. */
  private attestVerifier(): AttestVerifier {
    if (this.opts.attestVerifier) return this.opts.attestVerifier;
    if (!this._defaultAttestVerifier) {
      this._defaultAttestVerifier = {
        verify: (passphrase: string) =>
          this.brokerAttestVerify(passphrase),
      };
    }
    return this._defaultAttestVerifier;
  }
  private _defaultAttestVerifier?: AttestVerifier;

  /**
   * Default verifier — forwards the passphrase to the vault broker over
   * hostd's admin-client connection at `HOSTD_BROKER_SOCKET_PATH` using the
   * read-only `list_grants` op (which already implements the
   * passphrase-plaintext-forward attestation per #1051). A broker `ok`
   * response ⇒ the passphrase matched the broker's unlocked passphrase; an
   * error response (e.g. DENIED on mismatch, or broker locked) or an
   * unreachable socket ⇒ fail-closed. hostd never persists the passphrase.
   */
  private async brokerAttestVerify(
    passphrase: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const res = await brokerRpcRaw(
      {
        v: 1,
        op: "list_grants",
        agent: "hostd",
        passphrase,
      },
      { vaultBrokerSocket: HOSTD_BROKER_SOCKET_PATH, timeoutMs: 5_000 },
    );
    if (res.kind === "unreachable") {
      return { ok: false, reason: `broker unreachable: ${res.msg}` };
    }
    const resp = res.resp as { ok?: boolean; code?: string; msg?: string };
    if (resp.ok === true) return { ok: true };
    return {
      ok: false,
      reason: `broker denied attestation (${resp.code ?? "DENIED"})`,
    };
  }

  /**
   * Per-verb gate. Returns null when the call is allowed, or a string
   * describing the denial reason. RFC C §5.4 trust model:
   *
   *   - any   — upgrade_status (and self-targeted agent_restart)
   *   - admin — cross-agent agent_restart
   *   - admin + operator-attest — update_apply / apply (Phase 2)
   */
  private checkGate(req: HostdRequest, caller: SocketIdentity): string | null {
    if (caller.kind === "operator") return null;
    const callerAdmin =
      this.opts.config.agents[caller.name]?.admin === true;
    switch (req.op) {
      case "upgrade_status":
        return null;
      case "agent_restart":
        if (req.args.name === caller.name) return null; // self-target
        return callerAdmin
          ? null
          : `agent_restart cross-agent requires admin: true on caller "${caller.name}"`;
      case "get_status": {
        // The lookup is admin-or-self relative to the *original*
        // request. Phase 1 stores caller on the entry; admins or the
        // original caller can read it. Anything else is denied to
        // avoid information leakage across agents.
        const entry = this.statusByRequestId.get(req.args.target_request_id);
        if (!entry) {
          // #2726 — durable-log fallback for a ROLLOUT request whose in-memory
          // entry is gone (hostd restarted mid-roll, or the 10-min entry aged
          // out). Rollout is admin/operator-only, so surfacing its LATEST
          // durable row to an admin agent (or the operator socket) is not a
          // cross-agent leak. A non-admin agent still gets the opaque
          // not-found so it can't probe request_ids that aren't theirs.
          if (
            callerAdmin &&
            this.rolloutRowExistsInLog(req.args.target_request_id)
          ) {
            return null;
          }
          // No leak: return "denied: not found" the same as the
          // unauthorized case so callers can't probe for the
          // existence of request_ids that aren't theirs.
          return `get_status: request_id not found or not visible to caller "${caller.name}"`;
        }
        const ownCall =
          entry.caller.kind === caller.kind &&
          ("name" in entry.caller && "name" in caller
            ? entry.caller.name === caller.name
            : true);
        if (ownCall || callerAdmin) return null;
        return `get_status: request_id not found or not visible to caller "${caller.name}"`;
      }
      // ── Phase 2 verb gates ─────────────────────────────────────
      case "update_check":
        // Read-only fleet introspection (calls `switchroom update
        // --check` — dry-run, prints the plan, no side effects).
        // Same posture as upgrade_status: any caller including
        // non-admin agents may query.
        return null;
      case "update_apply":
      case "apply":
      case "rollout":
        // Fleet-wide mutations. Require admin: a non-admin agent
        // accidentally regenerating compose / pulling images on the
        // whole fleet is the obvious foot-gun. Operator is always
        // allowed (kind === "operator" already returned null above).
        // `rollout` (#2487) is additionally kept OUT of HOSTD_MCP_TOOLS
        // in scaffold.ts, so an agent's call surfaces a Telegram approval
        // card — the human tap is the real boundary; this admin gate is
        // the wire-side floor.
        return callerAdmin
          ? null
          : `${req.op} requires admin: true on caller "${caller.name}"`;
      case "agent_start":
      case "agent_stop":
        // Mirror agent_restart's gate: self-target always allowed;
        // cross-agent requires admin. Mutations are per-service so
        // there's no concurrent-fleet-write hazard.
        if (req.args.name === ("name" in caller ? caller.name : null))
          return null;
        return callerAdmin
          ? null
          : `${req.op} cross-agent requires admin: true on caller "${caller.name}"`;
      case "agent_logs":
      case "agent_exec":
      case "agent_smoke":
        // Phase 3 admin-observability verbs. Self-target is allowed
        // (an agent reading its own logs / inspecting its own
        // container is harmless and useful for self-debugging);
        // cross-agent requires admin. agent_exec additionally enforces
        // a read-only argv allowlist at dispatch time — see
        // isAllowlistedReadOnlyArgv. agent_smoke runs a FIXED
        // read-only probe battery (no caller-supplied argv at all),
        // so it's strictly safer than agent_exec under the same gate.
        if (req.args.name === caller.name) return null;
        return callerAdmin
          ? null
          : `${req.op} cross-agent requires admin: true on caller "${caller.name}"`;
      case "doctor":
        // Read-only, but whole-fleet: running `switchroom doctor`
        // host-side enumerates every agent + singleton's health —
        // broader exposure than update_check's version/plan view, so
        // gate it to admin (no operator-attest / fleet-mutation lock;
        // it changes nothing). The gateway only surfaces the
        // whole-fleet option on admin agents, but the daemon is the
        // enforced boundary. Operator (kind === "operator") already
        // returned null at the top of this method.
        return callerAdmin
          ? null
          : `doctor requires admin: true on caller "${caller.name}"`;
      case "agent_status":
      case "agent_schedule":
        // Read-only dashboard observability. The real consumer is the
        // web, which connects over the OPERATOR socket and returned null
        // at the top of this method (ungated, by design — see the
        // dispatcher comment in main.ts and hostd-config-propose.ts).
        // For an AGENT caller we mirror agent_smoke/agent_logs: a
        // self-scoped query (its own name) is harmless self-debugging;
        // a single OTHER agent's view or the whole-fleet view (name
        // omitted) is broader exposure, so require admin — same posture
        // as doctor's whole-fleet enumeration. These verbs change
        // nothing; no fleet-mutation lock applies.
        if (req.args.name !== undefined && req.args.name === caller.name) {
          return null;
        }
        return callerAdmin
          ? null
          : `${req.op} ${req.args.name === undefined ? "fleet view" : "cross-agent"} requires admin: true on caller "${caller.name}"`;
      case "config_propose_edit":
        // Admin callers may propose ANY edit to the central
        // switchroom.yaml. Non-admin callers are admitted here but
        // confined to a SELF-SCOPED edit: `handleConfigProposeEdit`
        // runs `assertSelfScopedAllowEdit` after validation and rejects
        // anything that touches more than the caller's own
        // `agents.<caller>.tools.allow`. This is the one privileged
        // verb a non-admin agent can reach — it's what makes
        // "🔁 Always allow" persist for the whole fleet (operator-tapped,
        // single-shot, #1977 correlation), not just the 3 admin agents.
        // Binding a socket ≠ granting admin: the self-scope check is the
        // enforced boundary, not this gate.
        return null;
    }
  }

  private async handleAgentRestart(
    req: Extract<HostdRequest, { op: "agent_restart" }>,
    caller: SocketIdentity,
    started: number,
  ): Promise<HostdResponse> {
    const args = ["agent", "restart", req.args.name];
    if (req.args.force) args.push("--force");
    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
    };
    this.recordStatus(entry);

    // Fire-and-forget: return `started` immediately, drive the child
    // detached. The status entry gets updated on completion so a
    // later `get_status` poll can surface the outcome.
    this.runSwitchroom(args)
      .then((res) => {
        entry.result = res.exit_code === 0 ? "completed" : "error";
        entry.exit_code = res.exit_code;
        entry.finished_at = Date.now();
        entry.stdout_tail = tail(res.stdout);
        entry.stderr_tail = tail(res.stderr);
      })
      .catch((err) => {
        entry.result = "error";
        entry.exit_code = null;
        entry.finished_at = Date.now();
        entry.error = (err as Error).message;
      });

    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  private async handleUpgradeStatus(
    req: Extract<HostdRequest, { op: "upgrade_status" }>,
    started: number,
  ): Promise<HostdResponse> {
    const res = await this.runSwitchroom(["update", "--status"]);
    const result: Result = res.exit_code === 0 ? "completed" : "error";
    return {
      v: 1,
      request_id: req.request_id,
      result,
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 2 verbs (RFC §10)
  // ──────────────────────────────────────────────────────────────────

  /** Read-only: `switchroom update --check` — prints the plan, no
   *  side effects. Same shape as upgrade_status. */
  private async handleUpdateCheck(
    req: Extract<HostdRequest, { op: "update_check" }>,
    started: number,
  ): Promise<HostdResponse> {
    const res = await this.runSwitchroom(["update", "--check"]);
    const result: Result = res.exit_code === 0 ? "completed" : "error";
    return {
      v: 1,
      request_id: req.request_id,
      result,
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * Read-only: `switchroom doctor` run host-side, where the docker
   * socket is present, so it reports the FULL fleet (containers,
   * singletons, image/CLI ages) instead of the degraded in-container
   * view an agent gets when it shells `switchroom doctor` itself.
   *
   * Unlike update_check this is `completed` whenever the process ran,
   * regardless of exit code: `switchroom doctor` exits 1 when it
   * finds failing checks (a degraded fleet) — that's a *finding*, not
   * a verb-dispatch failure, and the report on stdout is exactly what
   * the operator wants surfaced. exit_code is carried through so the
   * caller can still see "doctor found problems". A genuine spawn
   * failure (CLI missing, OOM) throws and is caught upstream as
   * `error`.
   */
  private async handleDoctor(
    req: Extract<HostdRequest, { op: "doctor" }>,
    started: number,
  ): Promise<HostdResponse> {
    // `--fast`: the whole-fleet doctor reached via this verb (the
    // Telegram /doctor surface, #1518) must stay STRUCTURAL only. The
    // in-agent liveness section makes a hostd round-trip per agent;
    // running it here would risk the gateway's 30s shell-out timeout
    // and re-enter hostd recursively. Operators get in-agent liveness
    // by running `switchroom doctor` directly on the host (no 30s
    // budget), or via the standalone `agent_smoke` verb per agent.
    const res = await this.runSwitchroom(["doctor", "--fast"]);
    return {
      v: 1,
      request_id: req.request_id,
      result: "completed",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * Mutating + long-running: `switchroom update` (pull + apply +
   * recreate + doctor). Async fire-and-forget pattern (same as
   * agent_restart). The fleet-mutation lock gates concurrent
   * update_apply / apply calls — if one is in flight we return
   * `denied` with the in-flight request_id so the caller can poll
   * `get_status` instead of racing.
   */
  /**
   * Apply-asset preflight. `apply` / `update_apply` shell out to the
   * bundled `switchroom` CLI, which resolves profiles + the vendored
   * hindsight plugin RELATIVE TO ITSELF (no path arg). Those three
   * assets — `profiles/`, `vendor/hindsight-memory/` (scaffold.ts) and
   * `skills/` (update.ts's `sync-bundled-skills`) — now share one probe,
   * `resolveShippedAsset` in src/util/shipped-assets.ts (#4160/#4161).
   * Inside the hostd image its FIRST candidate is the npm-shaped
   * `<bundleDir>/../../<asset>` = `/opt/switchroom/<asset>`, which is
   * exactly what the `root` below reproduces.
   * If the hostd image was built without those (the klanker incident
   * for profiles/vendor; the ghost-skills incident #3492-follow-up for
   * skills/), `update_apply` pulls images then either dies at
   * apply-config or silently skips the skills sync and later throws at
   * verify-bundled-skills — stranding the fleet on the old image, or
   * leaving every agent's CLAUDE.md referencing default skills that
   * never reach the pool. We refuse BEFORE anything is pulled or
   * changed — same fail-fast principle as the `--rebuild` guard.
   * Future-proofs the per-asset fragility: any new package-relative
   * apply/update asset added here can't silently strand a fleet again.
   */
  private missingApplyAssets(): string[] {
    const root =
      this.opts.applyAssetsRoot ?? resolve(import.meta.dirname, "../..");
    return [
      join(root, "profiles"),
      join(root, "profiles", "default"),
      join(root, "vendor", "hindsight-memory"),
      // sync-bundled-skills (update.ts) mirrors this tree into the host
      // pool; a hostd image without it silently skips the sync and then
      // fails verify-bundled-skills. Guard it here so update_apply is
      // refused up front instead of stranding the fleet mid-roll.
      join(root, "skills"),
    ].filter((p) => !existsSync(p));
  }

  /** Operator-facing refusal if apply assets are missing, else null.
   *  Shared by handleUpdateApply + handleApply. */
  private applyAssetPreflight(
    request_id: string,
    started: number,
  ): HostdResponse | null {
    const missing = this.missingApplyAssets();
    if (missing.length === 0) return null;
    return deniedResponse(
      request_id,
      `refused: this switchroom-hostd image is missing apply-time ` +
        `assets [${missing.join(", ")}]. hostd's in-container ` +
        `\`switchroom apply\` cannot scaffold agents without them and ` +
        `would pull images then strand the fleet on the old image ` +
        `(the klanker incident). Nothing was pulled or changed. Fix: ` +
        `rebuild/refresh the hostd image — \`switchroom update\` ` +
        `(refreshes hostd) or \`switchroom hostd install\` on the ` +
        `host; meanwhile run \`switchroom update\` host-side.`,
      Date.now() - started,
    );
  }

  /**
   * KEN-129 — read-only lock probe for the update-check drift
   * notifier: it must not post a "tap to apply" card while a fleet
   * mutation is already rolling (the running mutation likely IS the
   * catch-up the card would ask for).
   */
  isFleetMutationLocked(): boolean {
    return this.fleetMutationInFlight !== null;
  }

  /**
   * KEN-129 — entry point for the update-check drift notifier's
   * Approve tap. Reuses the EXACT `update_apply` verb path
   * (fleet-mutation lock, apply-asset preflight, durable status
   * rows, get_status pollability) with a synthetic operator caller:
   * the authorization here is the operator's tap on the approval
   * card, the same human-in-the-loop that gates the agent-invoked
   * verb. Returns the verb's HostdResponse — `result: "started"` on
   * success, `denied` with an operator-facing `error` otherwise.
   */
  startOperatorApprovedUpdateApply(requestId: string): HostdResponse {
    const req = {
      v: 1 as const,
      request_id: requestId,
      op: "update_apply" as const,
    };
    const caller: SocketIdentity = { kind: "operator" };
    const resp = this.handleUpdateApply(req, caller, Date.now());
    // This path doesn't come through handleConnection, so it writes its
    // own audit row — an operator-approved fleet mutation with no audit
    // trail would be a forensic gap.
    void this.writeAudit({ caller, req, resp }).catch((err) => {
      process.stderr.write(
        `hostd: audit write failed for operator-approved update_apply ` +
          `(request_id=${requestId}): ${(err as Error).message}\n`,
      );
    });
    return resp;
  }

  private handleUpdateApply(
    req: Extract<HostdRequest, { op: "update_apply" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const denied = this.checkFleetMutationLock(req.op, req.request_id, started);
    if (denied) return denied;

    const assetDenied = this.applyAssetPreflight(req.request_id, started);
    if (assetDenied) return assetDenied;

    // Mutual exclusion of channel vs pin. Schema accepts both optional;
    // server-side enforcement here keeps the contract honest at the
    // dispatch boundary (and the structured `denied` is friendlier than
    // a Zod parse error after the fact).
    if (req.args?.channel && req.args?.pin) {
      return deniedResponse(
        req.request_id,
        "update_apply: `channel` and `pin` are mutually exclusive — pass at most one.",
        Date.now() - started,
      );
    }

    const args = ["update"];
    if (req.args?.skip_images) args.push("--skip-images");
    if (req.args?.rebuild) args.push("--rebuild");
    if (req.args?.channel) args.push("--channel", req.args.channel);
    if (req.args?.pin) args.push("--pin", req.args.pin);

    // Capture install-type + (best-effort) digests up-front so the
    // started/terminal rows for this request carry full forensic
    // context even if `docker inspect` becomes unavailable mid-flight.
    const installCtx = readCachedInstallType(
      this.opts.bindRoot ?? this.opts.homeDir,
    );
    const digestRefs = this.imageRefsForDigestCapture();
    const digests = resolveDigests(digestRefs);
    const resolved_sha: Record<string, string> = {};
    for (const [k, v] of digests) resolved_sha[k] = v;

    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
      ...(req.args?.channel ? { channel: req.args.channel } : {}),
      ...(req.args?.pin ? { pin: req.args.pin } : {}),
      ...(Object.keys(resolved_sha).length > 0 ? { resolved_sha } : {}),
      install_context: {
        install_type: installCtx.install_type,
        detected_at: installCtx.detected_at,
      },
    };
    this.recordStatus(entry);
    this.fleetMutationInFlight = {
      op: "update_apply",
      request_id: req.request_id,
      started_at: started,
    };
    // Inject SWITCHROOM_HOSTD_CONTEXT=1 so the update driver knows it is
    // running inside the hostd container and must defer the refresh-hostd /
    // refresh-web steps rather than attempting to recreate the very container
    // it is running in (#2458). The driver emits a SWITCHROOM_UPDATE_RESULT
    // sentinel line that we parse below to populate entry.deferred.
    this.spawnFleetMutation(req.op, args, entry, { SWITCHROOM_HOSTD_CONTEXT: "1" });
    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  /**
   * Mutating: `switchroom apply --non-interactive` (regenerate per-
   * agent scaffolds + compose file; doesn't recreate containers).
   * Faster than update_apply (10-30s typically) but still gated by
   * the same fleet-mutation lock — concurrent apply + update_apply
   * would write to the same compose file mid-render.
   */
  private handleApply(
    req: Extract<HostdRequest, { op: "apply" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const denied = this.checkFleetMutationLock(req.op, req.request_id, started);
    if (denied) return denied;

    const assetDenied = this.applyAssetPreflight(req.request_id, started);
    if (assetDenied) return assetDenied;

    const args = ["apply", "--non-interactive"];
    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
    };
    this.recordStatus(entry);
    this.fleetMutationInFlight = {
      op: "apply",
      request_id: req.request_id,
      started_at: started,
    };
    this.spawnFleetMutation(req.op, args, entry);
    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  /**
   * Mutating + long-running: `switchroom rollout` — the SAFE staggered
   * canary + per-agent version-assert + stop-on-mismatch fleet deploy
   * (#2487). Modeled on handleUpdateApply (shares the fleet-mutation lock
   * + apply-asset preflight) but with three load-bearing differences:
   *
   *   1. The spawned CLI runs with `SWITCHROOM_HOSTD_CONTEXT=1`, which
   *      flips the rollout to (a) persist the durable pin AFTER the canary
   *      confirms (not before — brick scenario #2), and (b) DROP the
   *      hostd self-refresh (it would SIGKILL this very rollout, which
   *      is hostd's own child — brick scenario #1). The web refresh runs
   *      in-plan (separate compose project — safe to recreate from here).
   *   2. The outcome (`rolled[]` / `failedStep` / `failedAgent`) is
   *      preserved into STRUCTURED status fields, parsed from the child's
   *      sentinel line — NOT flattened into a stdout tail.
   *   3. `pin` is semver-only (already enforced at the wire schema).
   *
   * Returns `started`; default wire timeout (no long override) — same
   * async fire-and-forget pattern as update_apply.
   */
  private async handleRollout(
    req: Extract<HostdRequest, { op: "rollout" }>,
    caller: SocketIdentity,
    started: number,
  ): Promise<HostdResponse> {
    const denied = this.checkFleetMutationLock(req.op, req.request_id, started);
    if (denied) return denied;

    // #2645 item 1 — hostd self-bump. hostd's CLI is baked into its image,
    // so it is older than EVERY freshly tagged release; without this branch
    // the roll is refused by the CLI-side `preflight-stale-cli` guard and
    // the only remedy is a host-shell `hostd install`, defeating the
    // agent-driven roll entirely. Instead: tag-bump hostd's own compose,
    // hand off to a detached sibling helper that recreates this container
    // on the target image, and let the NEW hostd resume this very request
    // from the marker at boot (see resumePendingSelfBumpRollout).
    if (
      needsSelfBump(this.opts.selfVersion ?? SWITCHROOM_VERSION, req.args.pin)
    ) {
      return this.beginSelfBump(req, caller, started);
    }

    const assetDenied = this.applyAssetPreflight(req.request_id, started);
    if (assetDenied) return assetDenied;

    // #2972 — fail fast on a bad `agents` list BEFORE spawning the child.
    // The child rejects unknown agents (stderr, exit 2) but by then hostd
    // has already replied "started", so the caller sees success and never
    // gets an approval card. Validate against the SAME config view the
    // child reads (`config.agents` keys) so there's no stale-view mismatch.
    if (req.args.agents !== undefined) {
      let validAgents: string[] | null = null;
      try {
        const cfg = loadConfig(this.opts.configPath) as {
          agents?: Record<string, unknown>;
        };
        validAgents = Object.keys(cfg.agents ?? {});
      } catch {
        // Malformed yaml: skip validation and proceed as before — the
        // child will fail and the MCP-side grace-window check surfaces it.
        validAgents = null;
      }
      if (validAgents !== null) {
        // #1758 structured envelope alongside the legacy `error` string.
        // ErrorBuilder synthesises `error` as "<code>: <human>", so the
        // legacy string stays exactly "E_UNKNOWN_AGENT: …" — the same shape
        // string-matching decoders already parse.
        const buildDenied = (human: string): HostdResponse =>
          err("E_UNKNOWN_AGENT", human)
            .fixBadInput("agents")
            .op("rollout")
            .caller(caller.kind)
            .agentName(caller.kind === "agent" ? caller.name : undefined)
            .asDenied()
            .build(req.request_id, Date.now() - started);
        const requested = req.args.agents;
        if (requested.length === 0) {
          return buildDenied(
            `empty agents list — pass at least one agent, ` +
              `or omit "agents" to roll all. Valid agents: ${validAgents.join(", ")}`,
          );
        }
        const unknown = requested.filter((a) => !validAgents!.includes(a));
        if (unknown.length > 0) {
          return buildDenied(
            `unknown agent(s): ${unknown.join(", ")}. ` +
              `Valid agents: ${validAgents.join(", ")}`,
          );
        }
      }
    }

    const entry = this.launchRollout(req.args, req.request_id, caller, started);
    return {
      v: 1,
      request_id: entry.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  /**
   * KEN-131 — entry point for the unattended auto-update path
   * (`release.auto_update: true`). Called by hostd's release watcher when
   * a new published release is detected; drives the SAME staggered canary
   * rollout pipeline as an operator/agent `rollout` request (fleet-
   * mutation lock, self-bump, apply-asset preflight, durable audit +
   * narration, structured status), differing only in caller identity
   * ({kind:"operator"} — the daemon acting host-side) and in the hardened
   * no-operator failure handling (see finishFailedAutoRollout).
   *
   * Returns `{started:false, reason}` instead of a wire denial — the
   * caller is the in-process watcher, which logs the reason and retries
   * (or not) on its own schedule.
   */
  public async startAutoRollout(
    pin: string,
  ): Promise<{ started: boolean; request_id?: string; reason?: string }> {
    const started = Date.now();
    const request_id = `${AUTO_ROLLOUT_REQUEST_PREFIX}${started}`;
    const diskLatch = this.readAutoRolloutLatch();
    if (this.lastAutoRolloutFailedPin === pin || diskLatch?.pin === pin) {
      const why =
        diskLatch?.pin === pin && diskLatch.outcome === "attempting"
          ? `a previous unattended roll to ${pin} did not complete (hostd ` +
            `restarted or crashed mid-roll — the fleet state is unverified)`
          : `a previous unattended roll to ${pin} FAILED`;
      return {
        started: false,
        reason:
          `${why} — refusing to retry unattended (the latch is durable ` +
          `across hostd restarts; fix the cause, then roll manually via ` +
          `\`switchroom rollout --pin ${pin}\`; a newer release supersedes ` +
          `the latch)`,
      };
    }
    const inFlight = this.fleetMutationInFlight;
    if (inFlight) {
      return {
        started: false,
        reason:
          `fleet-mutation lock held by ${inFlight.op} (request_id ` +
          `"${inFlight.request_id}") — will re-check next tick`,
      };
    }
    // A DIFFERENT (newer) target supersedes any stale latch. Ordered AFTER
    // the fleet-lock check: while a roll is in flight its launch-time
    // "attempting" latch must not be stripped by a superseding tick that
    // the lock is about to refuse anyway.
    if (diskLatch && diskLatch.pin !== pin) this.clearAutoRolloutLatch();
    const caller: SocketIdentity = { kind: "operator" };
    // hostd's baked-in CLI is older than EVERY fresh release, so the
    // self-bump branch is the COMMON path here: bump hostd's own compose,
    // hand off to the helper, and let the new hostd resume this very
    // request_id from the marker at boot (the auto- prefix survives the
    // marker round-trip, keeping the hardened failure handling attached).
    if (needsSelfBump(this.opts.selfVersion ?? SWITCHROOM_VERSION, pin)) {
      const req = {
        v: 1,
        request_id,
        op: "rollout",
        args: { pin },
      } as Extract<HostdRequest, { op: "rollout" }>;
      // Latch BEFORE committing: the self-bump recreates hostd's own
      // container, so only a durable marker written now can stop a fresh
      // daemon from re-launching this same target if the bump/resume dies
      // mid-flight. beginSelfBump's clean refusals ("nothing was changed")
      // clear it again — those are safe to retry next tick.
      this.writeAutoRolloutLatch({
        v: 1,
        pin,
        request_id,
        outcome: "attempting",
        at: new Date().toISOString(),
      });
      const resp = await this.beginSelfBump(req, caller, started);
      if (resp.result !== "started") {
        this.clearAutoRolloutLatch();
        return {
          started: false,
          reason: resp.error ?? `self-bump refused (result=${resp.result})`,
        };
      }
      return { started: true, request_id };
    }
    const assetDenied = this.applyAssetPreflight(request_id, started);
    if (assetDenied) {
      return {
        started: false,
        reason: assetDenied.error ?? "apply-asset preflight refused",
      };
    }
    // Durable "attempting" latch at launch: a roll that dies without a
    // terminal row (hostd SIGKILLed mid-canary) must NOT be silently
    // retried by the next daemon — cleared only on a confirmed green roll.
    this.writeAutoRolloutLatch({
      v: 1,
      pin,
      request_id,
      outcome: "attempting",
      at: new Date().toISOString(),
    });
    this.launchRollout({ pin }, request_id, caller, started);
    return { started: true, request_id };
  }

  /**
   * Shared tail of the rollout launch: build the child argv, capture
   * prior-pin + install context, record the status entry, take the
   * fleet-mutation lock and spawn the child. Used by the direct
   * `handleRollout` path and by the post-self-bump boot resume — the two
   * MUST stay behaviorally identical so a resumed roll is
   * indistinguishable from a direct one downstream (audit, narration,
   * get_status).
   */
  private launchRollout(
    args: {
      pin: string;
      agents?: string[];
      skip_web?: boolean;
      allow_downgrade?: boolean;
    },
    request_id: string,
    caller: SocketIdentity,
    started: number,
  ): StatusEntry {
    const argv = ["rollout", "--pin", args.pin];
    if (args.agents && args.agents.length > 0) {
      argv.push("--agents", args.agents.join(","));
    }
    if (args.skip_web) argv.push("--skip-web");
    if (args.allow_downgrade) argv.push("--allow-downgrade");

    const installCtx = readCachedInstallType(
      this.opts.bindRoot ?? this.opts.homeDir,
    );

    // Capture the version that is currently running BEFORE this roll
    // begins. Used to stamp `prior_pin` on the completed terminal row so
    // a subsequent `rollout --allow-downgrade` can default its target to
    // "the last good one" without the operator having to recall the tag.
    //
    // Read from the RUNNING FLEET, never from `release.pin` in the config
    // file — this roll's own `persist-pin` step writes that field, so a
    // config pin that was already set to the target makes `prior_pin` the
    // target and turns rollback into a no-op. See `prior-pin.ts` for the
    // full account and the two invariants. Fail-soft: an unreadable
    // inventory yields no `prior_pin` (it is optional) rather than falling
    // back to the config, which is the defect.
    const priorPin = resolvePriorPinFromFleet(
      this.fleetComponents(),
      args.pin,
      args.agents,
    );

    const entry: StatusEntry = {
      request_id,
      caller,
      op: "rollout",
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
      pin: args.pin,
      install_context: {
        install_type: installCtx.install_type,
        detected_at: installCtx.detected_at,
      },
      ...(priorPin.prior_pin ? { prior_pin: priorPin.prior_pin } : {}),
      ...(priorPin.prior_pin_observed
        ? { prior_pin_observed: priorPin.prior_pin_observed }
        : {}),
      prior_pin_source: priorPin.prior_pin_source,
    };
    this.recordStatus(entry);
    this.fleetMutationInFlight = {
      op: "rollout",
      request_id,
      started_at: started,
    };
    this.spawnRollout(argv, entry);
    return entry;
  }

  /** Daemon-view path of the hostd dir (compose file, marker, sockets). */
  private hostdDirPath(): string {
    return join(this.opts.homeDir, ".switchroom", "hostd");
  }

  /** HOST-view path of the hostd dir — what dockerd resolves bind sources
   *  against. Inside the dockerized daemon `homeDir` is `/host-home`,
   *  which is meaningless to dockerd; SWITCHROOM_HOST_HOME (baked into the
   *  hostd compose env) carries the real host home. */
  private hostdDirHostPath(): string {
    const hostHome =
      this.opts.hostHomeDir ??
      process.env.SWITCHROOM_HOST_HOME?.trim() ??
      this.opts.homeDir;
    return join(hostHome, ".switchroom", "hostd");
  }

  /**
   * #2645 item 1 — begin a hostd self-bump: tag-bump hostd's own compose
   * to the roll's target, write the resume marker, and hand the recreate
   * to a DETACHED SIBLING helper container. Answers `started`; the roll
   * itself is relaunched by the NEW hostd's boot resume under the same
   * request_id. Everything before the helper spawn is reversible; a
   * failed spawn restores the compose + marker so nothing changed.
   */
  private async beginSelfBump(
    req: Extract<HostdRequest, { op: "rollout" }>,
    caller: SocketIdentity,
    started: number,
  ): Promise<HostdResponse> {
    const ownVersion = this.opts.selfVersion ?? SWITCHROOM_VERSION;
    const composePath = join(this.hostdDirPath(), "docker-compose.yml");
    if (!existsSync(composePath)) {
      return deniedResponse(
        req.request_id,
        `rollout: hostd's CLI (v${ownVersion}) is older than the target ` +
          `${req.args.pin} and needs a self-bump first, but its compose file ` +
          `is missing at ${composePath}. Run \`switchroom hostd install ` +
          `--tag ${req.args.pin}\` on the host, then re-run the roll. ` +
          `Nothing was changed.`,
        Date.now() - started,
      );
    }
    const before = readFileSync(composePath, "utf8");
    const bumped = bumpHostdComposeImageTag(before, req.args.pin);
    if (!bumped) {
      return deniedResponse(
        req.request_id,
        `rollout: hostd needs a self-bump to ${req.args.pin} but no ` +
          `switchroom-hostd image line was found in ${composePath} ` +
          `(hand-edited compose?). Run \`switchroom hostd install --tag ` +
          `${req.args.pin}\` on the host, then re-run the roll. Nothing ` +
          `was changed.`,
        Date.now() - started,
      );
    }

    // Verify the target image is actually published BEFORE committing to
    // anything — a roll fired minutes after a tag push can beat the
    // docker-images workflow. Manifest inspect is a fast metadata round-trip
    // (no layer download); a failure refuses cleanly with nothing changed.
    const probe = await this.runDocker([
      "manifest",
      "inspect",
      bumped.newImageRef,
    ]);
    if (probe.exit_code !== 0) {
      return deniedResponse(
        req.request_id,
        `rollout: hostd needs a self-bump to ${req.args.pin} but the target ` +
          `image ${bumped.newImageRef} is not pullable yet (docker manifest ` +
          `inspect failed: ${tail(probe.stderr).trim() || "unknown error"}). ` +
          `The docker-images workflow may still be building — retry in a ` +
          `few minutes. Nothing was changed.`,
        Date.now() - started,
      );
    }

    // A stuck helper from a previous attempt holds the fixed name; remove
    // it so the fresh spawn can't fail on a name conflict. Per-name rm -f
    // of a container we own by construction (labeled switchroom.hostd-selfbump).
    await this.runDocker(["rm", "-f", SELF_BUMP_HELPER_CONTAINER]).catch(
      () => undefined,
    );

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const bakPath = `${composePath}.bak-selfbump-${ts}`;
    // Prune old self-bump backups (keep the newest few) — one accrues per
    // release rolled, and the hostd dir already drowned in compose baks once.
    try {
      const baks = readdirSync(this.hostdDirPath())
        .filter((f) => f.startsWith("docker-compose.yml.bak-selfbump-"))
        .sort();
      for (const f of baks.slice(0, Math.max(0, baks.length - 4))) {
        unlinkSync(join(this.hostdDirPath(), f));
      }
    } catch {
      // best-effort housekeeping
    }
    const markerPath = join(this.hostdDirPath(), SELF_BUMP_MARKER_FILENAME);
    const marker: PendingRolloutMarker = {
      v: 1,
      request_id: req.request_id,
      pin: req.args.pin,
      ...(req.args.agents && req.args.agents.length > 0
        ? { agents: req.args.agents }
        : {}),
      ...(req.args.skip_web ? { skip_web: true } : {}),
      ...(req.args.allow_downgrade ? { allow_downgrade: true } : {}),
      caller:
        caller.kind === "agent"
          ? { kind: "agent", name: caller.name }
          : { kind: "operator" },
      created_at: new Date().toISOString(),
      prior_hostd_version: ownVersion,
    };
    copyFileSync(composePath, bakPath);
    writeFileSync(composePath, bumped.yaml, "utf8");
    // #3919: log HOW MANY hostd image lines were bumped. The compose has
    // carried two since the hindsight-autoheal sidecar (#2910), and the bug
    // that stranded that sidecar for three releases was invisible precisely
    // because this step only ever reported the single hostd ref.
    process.stderr.write(
      `hostd: self-bump rewrote ${bumped.bumpedCount} switchroom-hostd ` +
        `image line(s) → ${bumped.newImageRef}\n`,
    );
    writeFileSync(markerPath, encodePendingRolloutMarker(marker), {
      mode: 0o600,
    });

    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
      pin: req.args.pin,
    };
    this.recordStatus(entry);
    this.fleetMutationInFlight = {
      op: "rollout",
      request_id: req.request_id,
      started_at: started,
    };
    // Durable phase row + narration: the operator sees "hostd refreshing
    // itself" instead of a silent gap while the container recreates.
    this.onRolloutPhase(entry, { phase: "self-bump", target: req.args.pin });

    const rollbackBump = (): void => {
      try {
        copyFileSync(bakPath, composePath);
        unlinkSync(markerPath);
      } catch (e) {
        process.stderr.write(
          `hostd: self-bump rollback failed (compose/marker may need manual ` +
            `restore from ${bakPath}): ${(e as Error).message}\n`,
        );
      }
    };

    const helper = await this.runDocker(
      selfBumpHelperArgs({
        hostdDirHostPath: this.hostdDirHostPath(),
        // Run the helper on the OLD (currently-running, guaranteed-local)
        // image so `docker run -d` returns immediately — the target image
        // is fetched by the helper's own `compose pull`, async to this
        // request. Running the target here would synchronously pull a
        // multi-GB image inside this await and blow the caller's wire
        // timeout before the `started` response lands.
        helperImage: bumped.oldImageRef,
        targetImage: bumped.newImageRef,
      }),
    ).catch((e) => ({
      exit_code: -1,
      stdout: "",
      stderr: (e as Error).message,
    }));
    if (helper.exit_code !== 0) {
      rollbackBump();
      entry.result = "error";
      entry.finished_at = Date.now();
      entry.error = `self-bump helper spawn failed: ${tail(helper.stderr).trim()}`;
      this.fleetMutationInFlight = null;
      void this.writeTerminalAudit(entry);
      return {
        v: 1,
        request_id: req.request_id,
        result: "error",
        exit_code: null,
        duration_ms: Date.now() - started,
        error:
          `rollout: could not spawn the hostd self-bump helper container ` +
          `(${tail(helper.stderr).trim() || "unknown error"}). The compose ` +
          `bump was rolled back — nothing is changed. Fallback: ` +
          `\`switchroom hostd install --tag ${req.args.pin}\` on the host, ` +
          `then re-run the roll.`,
      };
    }

    // Watch the helper from the OLD hostd. On success the helper recreates
    // this very container, so the watcher usually dies before firing — by
    // design. It only ever resolves meaningfully on FAILURE (pull error,
    // compose error): we are still alive, the marker would otherwise sit
    // until the staleness cutoff, and the caller would poll a perpetual
    // `started`. Fail loudly instead: restore, clear, terminal row.
    void this.runDocker(["wait", SELF_BUMP_HELPER_CONTAINER])
      .then((w) => {
        const code = Number.parseInt(w.stdout.trim(), 10);
        if (w.exit_code !== 0 || !Number.isFinite(code)) {
          // `docker wait` ITSELF failed (daemon hiccup, or the container
          // was already auto-removed after a success we raced). Do NOT
          // roll back on ambiguity: on a successful bump this container
          // is about to be recreated, and a spurious compose restore
          // would drift the on-disk tag below the running version. The
          // marker staleness cutoff + the still-stale resume check are
          // the backstop for a genuinely failed bump we couldn't observe.
          process.stderr.write(
            `hostd: self-bump watcher could not read the helper's exit ` +
              `code (docker wait rc=${w.exit_code}): ${tail(w.stderr).trim()}\n`,
          );
          return;
        }
        if (code === 0) return; // bump succeeded — recreate imminent
        rollbackBump();
        entry.result = "error";
        entry.finished_at = Date.now();
        entry.error =
          `self-bump helper failed (container exit ${Number.isFinite(code) ? code : "unknown"}). ` +
          `See ${join(this.hostdDirHostPath(), SELF_BUMP_LOG_FILENAME)} on the host. ` +
          `Compose bump rolled back. Fallback: \`switchroom hostd install ` +
          `--tag ${req.args.pin}\` host-side, then re-run the roll.`;
        if (
          this.fleetMutationInFlight &&
          this.fleetMutationInFlight.request_id === entry.request_id
        ) {
          this.fleetMutationInFlight = null;
        }
        void this.writeTerminalAudit(entry);
        this.pushRolloutTerminal(entry);
      })
      .catch(() => undefined);

    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
      payload: JSON.stringify({
        phase: "self-bump",
        pin: req.args.pin,
        rolled: [],
        note:
          `hostd's CLI (v${ownVersion}) is older than ${req.args.pin}, so ` +
          `hostd is refreshing itself first: its container restarts on the ` +
          `target image (~30-60s blip on this socket), then the roll resumes ` +
          `AUTOMATICALLY under this same request_id. Poll get_status with ` +
          `this request_id after the blip; do NOT re-issue the rollout.`,
      }),
    };
  }

  /**
   * Boot-side of the self-bump (#2645): if the previous hostd process
   * left a pending-rollout marker, relaunch that roll now — same
   * request_id, so the audit chain, narration surface and get_status
   * continue seamlessly. Single-shot: the marker is deleted before any
   * validation so a crash-looping resume can't re-fire the roll forever.
   * Runs BEFORE the sockets bind (no request can race the lock) and
   * BEFORE the orphan sweep (a resumable roll isn't an orphan).
   */
  /**
   * Persist the rollout narration card's Telegram message_id into the pending-
   * rollout marker, so a hostd self-bump can hand it to the resumed narrator
   * (which then EDITs the same card instead of re-posting a fresh one and
   * stranding the frozen original). Wired from main.ts as the narrator's
   * `onMessageId` sink.
   *
   * No-op when the marker is gone (the common case: most rolls never self-bump,
   * so no marker exists). Atomic (`.tmp` + rename) so a SIGKILL mid-write can
   * never leave a torn marker that would block the resume — the worst case is
   * the id simply isn't persisted and the resume degrades to a re-post.
   * Best-effort throughout: every failure is swallowed.
   */
  persistNarrationMessageId(requestId: string, messageId: number): void {
    try {
      if (!Number.isInteger(messageId) || messageId <= 0) return;
      const markerPath = join(this.hostdDirPath(), SELF_BUMP_MARKER_FILENAME);
      if (!existsSync(markerPath)) return; // no self-bump in flight — nothing to carry.
      const marker = parsePendingRolloutMarker(readFileSync(markerPath, "utf8"));
      if (!marker) return; // torn/foreign marker — leave it for the resume path to judge.
      if (marker.request_id !== requestId) return; // marker is for a different roll.
      const updated: PendingRolloutMarker = {
        ...marker,
        narration_message_id: messageId,
      };
      const tmp = `${markerPath}.tmp`;
      writeFileSync(tmp, encodePendingRolloutMarker(updated), { mode: 0o600 });
      renameSync(tmp, markerPath);
    } catch {
      // Best-effort: a failure here only means the card may re-post after a
      // self-bump (pre-fix behaviour), never a broken roll.
    }
  }

  private async resumePendingSelfBumpRollout(): Promise<void> {
    const markerPath = join(this.hostdDirPath(), SELF_BUMP_MARKER_FILENAME);
    if (!existsSync(markerPath)) return;
    let raw: string;
    try {
      raw = readFileSync(markerPath, "utf8");
    } finally {
      try {
        unlinkSync(markerPath);
      } catch {
        // Unreadable AND undeletable — nothing safe to do; the orphan
        // sweep will surface the stranded roll.
      }
    }
    const marker = parsePendingRolloutMarker(raw!);
    if (!marker) {
      process.stderr.write(
        `hostd: pending-rollout marker at ${markerPath} was malformed — ` +
          `dropped without resuming. The originating roll will surface via ` +
          `the orphan sweep.\n`,
      );
      return;
    }
    const caller: SocketIdentity =
      marker.caller.kind === "agent"
        ? { kind: "agent", name: marker.caller.name }
        : { kind: "operator" };
    const failResume = async (why: string): Promise<void> => {
      const entry: StatusEntry = {
        request_id: marker.request_id,
        caller,
        op: "rollout",
        result: "error",
        exit_code: null,
        started_at: Date.parse(marker.created_at) || Date.now(),
        finished_at: Date.now(),
        stdout_tail: "",
        stderr_tail: "",
        pin: marker.pin,
        failed_step: "self-bump",
        error: why,
      };
      this.recordStatus(entry);
      process.stderr.write(`hostd: self-bump resume failed: ${why}\n`);
      // KEN-131 — an UNATTENDED roll that died at the self-bump must latch
      // durably too, or the watcher's next tick re-runs the whole
      // bump-and-fail cycle forever (the pin never advanced, so the check
      // keeps reporting "available").
      if (isAutoRolloutRequestId(marker.request_id)) {
        this.lastAutoRolloutFailedPin = marker.pin;
        this.writeAutoRolloutLatch({
          v: 1,
          pin: marker.pin,
          request_id: marker.request_id,
          outcome: "failed",
          at: new Date().toISOString(),
          reason: "self-bump",
        });
      }
      await this.writeTerminalAudit(entry);
      this.pushRolloutTerminal(entry);
    };

    const ownVersion = this.opts.selfVersion ?? SWITCHROOM_VERSION;
    if (!isMarkerFresh(marker, Date.now())) {
      await failResume(
        `pending-rollout marker for ${marker.pin} (request_id ` +
          `${marker.request_id}) was older than the resume cutoff — the ` +
          `self-bump helper likely stalled. hostd is now on v${ownVersion}. ` +
          `Re-issue the rollout to try again.`,
      );
      return;
    }
    if (needsSelfBump(ownVersion, marker.pin)) {
      await failResume(
        `hostd is still on v${ownVersion} after the self-bump to ` +
          `${marker.pin} (helper failed? see ` +
          `${join(this.hostdDirHostPath(), SELF_BUMP_LOG_FILENAME)}). ` +
          `Fallback: \`switchroom hostd install --tag ${marker.pin}\` ` +
          `host-side, then re-issue the rollout.`,
      );
      return;
    }

    process.stderr.write(
      `hostd: resuming rollout ${marker.request_id} → ${marker.pin} after ` +
        `self-bump (v${marker.prior_hostd_version} → v${ownVersion})\n`,
    );
    const entry = this.launchRollout(
      {
        pin: marker.pin,
        ...(marker.agents ? { agents: marker.agents } : {}),
        ...(marker.skip_web ? { skip_web: true } : {}),
        ...(marker.allow_downgrade ? { allow_downgrade: true } : {}),
      },
      marker.request_id,
      caller,
      Date.now(),
    );
    // Adopt the card the PRE-self-bump hostd posted, if we carried its id, so
    // the resumed roll EDITS that card instead of stranding it and posting a
    // fresh one. MUST seed BEFORE feeding the first phase below, or that phase
    // would see a null message_id and re-post. Best-effort: absent id (helper
    // was SIGKILLed before the reply landed) degrades to the pre-fix re-post.
    if (
      marker.narration_message_id !== undefined &&
      caller.kind === "agent"
    ) {
      this.rolloutNarrator?.seedPostedMessage?.(
        marker.request_id,
        caller.name,
        marker.narration_message_id,
      );
    }
    this.onRolloutPhase(entry, { phase: "self-bump-done", target: marker.pin });
  }

  /** Synchronous: `switchroom agent start <name>` — fast (~1-2s for
   *  `docker compose start <service>`). No fleet-mutation lock —
   *  the underlying compose op is service-scoped. */
  private async handleAgentStart(
    req: Extract<HostdRequest, { op: "agent_start" }>,
    started: number,
  ): Promise<HostdResponse> {
    const res = await this.runSwitchroom(["agent", "start", req.args.name]);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /** Synchronous: `switchroom agent stop <name>`. Same posture as
   *  agent_start. Note: the CLI does NOT accept `--force` today
   *  (verified via `src/cli/agent.ts` registration). If drain-skip
   *  semantics arrive, plumb the flag here in lockstep with the
   *  schema's `args.force` field. */
  private async handleAgentStop(
    req: Extract<HostdRequest, { op: "agent_stop" }>,
    started: number,
  ): Promise<HostdResponse> {
    const args = ["agent", "stop", req.args.name];
    const res = await this.runSwitchroom(args);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * Target guard for the two docker-shell verbs (agent_logs /
   * agent_exec). Both build the target as `switchroom-${name}` and run
   * `docker logs`/`docker exec` on it, so `name` MUST be a CONFIGURED
   * AGENT. Without this an admin caller (checkGate lets an admin target
   * any name) could pass a SINGLETON service name — `vault-broker`,
   * `approval-kernel`, `hostd`, `web` — each of which runs as root with
   * the vault store + /etc/machine-id mounted, and read vault key
   * material via `docker exec`/`docker logs`. There is no legitimate
   * agent_exec/agent_logs use case for the singleton containers; the
   * trust model assumes the target is a peer AGENT container.
   *
   * `this.opts.agentUids` is the daemon's configured-agent registry
   * (name → UID), built at startup from `Object.keys(config.agents)`
   * (see main.ts) and binding one socket per configured agent — it does
   * NOT contain any singleton service name. Self-target still passes (a
   * caller's own name is always in the set); a real peer agent still
   * passes; only unconfigured names (singletons, typos) are rejected.
   * Returns a `denied` response to short-circuit the handler, or null
   * when the target is a configured agent.
   */
  private rejectUnconfiguredTarget(
    name: string,
    request_id: string,
    op: string,
    started: number,
  ): HostdResponse | null {
    if (Object.prototype.hasOwnProperty.call(this.opts.agentUids, name)) {
      return null;
    }
    return deniedResponse(
      request_id,
      `${op}: "${name}" is not a configured agent. ` +
        `${op} targets only peer agent containers (switchroom-<agent>); ` +
        `singleton service containers (vault-broker, approval-kernel, ` +
        `hostd, web) and unknown names are rejected. Configured agents: ` +
        `${Object.keys(this.opts.agentUids).sort().join(", ")}.`,
      Date.now() - started,
    );
  }

  /**
   * `docker logs --tail <n> <container>` — synchronous read of a peer
   * container's combined stdout/stderr. The default container name in
   * the switchroom compose project is `switchroom-<agent>`; we shell
   * out via `docker` directly rather than through the CLI because no
   * `switchroom agent logs` verb exists and adding one would just
   * proxy this anyway. The `4 KiB tail` cap on stdout_tail caps the
   * response frame size; for full logs the operator should use
   * `docker logs` directly on the host.
   */
  private async handleAgentLogs(
    req: Extract<HostdRequest, { op: "agent_logs" }>,
    started: number,
  ): Promise<HostdResponse> {
    const tailLines = req.args.tail ?? 100;
    const rejected = this.rejectUnconfiguredTarget(
      req.args.name,
      req.request_id,
      "agent_logs",
      started,
    );
    if (rejected) return rejected;
    const container = `switchroom-${req.args.name}`;
    const res = await this.runDocker([
      "logs",
      "--tail",
      String(tailLines),
      container,
    ]);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * `docker exec <container> <argv...>` — synchronous, gated by a
   * read-only inspection allowlist enforced here in the daemon. argv[0]
   * must be one of {@link READONLY_EXEC_ALLOWLIST}; writes / mutations
   * are rejected with a clear pointer to the deferred approval-kernel
   * scope work. This is deliberately a small allowlist: anything you
   * can do here you can also do via `agent_logs` + a careful reading of
   * the agent's state files, so the surface stays observability-only.
   */
  private async handleAgentExec(
    req: Extract<HostdRequest, { op: "agent_exec" }>,
    started: number,
  ): Promise<HostdResponse> {
    const argv0 = req.args.argv[0]!;
    if (!isAllowlistedReadOnlyArgv(argv0)) {
      return deniedResponse(
        req.request_id,
        `agent_exec: "${argv0}" is not on the read-only allowlist. ` +
          `Allowed: ${READONLY_EXEC_ALLOWLIST.join(", ")}. ` +
          `Writes inside peer containers require the host_os.exec ` +
          `approval-kernel scope, which is not yet wired — see ` +
          `reference/rfcs/approval-kernel.md §6 (deferred follow-up).`,
        Date.now() - started,
      );
    }
    // #1401 / #1400 target 3: reject any argv element carrying a C0
    // control byte (NUL/LF/CR + ESC and the rest of U+0000–U+001F),
    // DEL, or exceeding the per-element size cap — audit-log line
    // injection, ANSI-escape spoofing of the operator audit trail,
    // and arg-vector padding, all before the call.
    if (!req.args.argv.every(isSafeExecArgvElement)) {
      return deniedResponse(
        req.request_id,
        `agent_exec: an argv element contains a control character ` +
          `(C0 / DEL) or exceeds ${MAX_EXEC_ARGV_ELEMENT_BYTES} bytes, ` +
          `which is not permitted (#1401 / #1400).`,
        Date.now() - started,
      );
    }
    const rejected = this.rejectUnconfiguredTarget(
      req.args.name,
      req.request_id,
      "agent_exec",
      started,
    );
    if (rejected) return rejected;
    const container = `switchroom-${req.args.name}`;
    // No `--`. Unlike `docker run`, `docker exec` stops parsing its
    // OWN options at CONTAINER: every token after the container name
    // is the command/args. Verified against real docker —
    // `docker exec C -e X cmd` execs a program literally named "-e"
    // (it is NOT read as --env). So the #1401 concern (argv[0]
    // reinterpreted as a docker flag) cannot occur for `docker exec`;
    // and a literal `--` is actively harmful — docker exec tries to
    // exec a binary named "--" → "executable file not found" / exit
    // 127. The prior `--` silently broke EVERY real agent_exec; it
    // was only ever exercised against a docker STUB in tests, which
    // didn't model real docker's post-CONTAINER argv handling.
    const res = await this.runDocker(["exec", container, ...req.args.argv]);
    return {
      v: 1,
      request_id: req.request_id,
      result: res.exit_code === 0 ? "completed" : "error",
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  /**
   * Read-only in-agent liveness battery (Phase 3.2). hostd is the one
   * audited, admin-gated component with the docker socket, so the
   * privileged in-container probing lives HERE, not in an
   * unprivileged caller. Every probe is a FIXED literal command (no
   * caller argv) returning only a boolean/state — NEVER a secret
   * value (the bot-token probe uses `grep -q`, which emits nothing).
   * A down container or a docker failure degrades every probe to
   * `skip`; the verb itself is always `completed` when it ran (a
   * failing probe is a *finding* the caller renders, not a
   * verb-dispatch failure — same posture as the doctor verb). `deep`
   * adds an auth-liveness check that reads the agent's stored OAuth
   * credential and verifies it is present and unexpired; it makes NO
   * model call (the default path makes no model call either).
   */
  /**
   * `config_propose_edit` — full apply path (#1623 / RFC §3.3-3.4).
   *
   * Deliberately OUT of scope per operator decision (single-operator
   * single-host posture, see PR description):
   * crash-recovery journal, Prometheus metrics, literal `flock` on the
   * config file (the in-process mutex serializes hostd's own applies;
   * operator hand-edits are NOT under the lock — a ~ms residual race
   * remains, accepted), attachment fallback for very large diffs, 5s
   * safety-delay button swap.
   *
   * TOCTOU re-validation and apply-time privilege-escalation checks ARE
   * in scope since the #3084 audit + the #3121 follow-up: the apply path
   * re-applies the stored diff under the lock, pins the semantic change
   * set to what was approved, and re-runs the non-admin self-scope gate.
   */
  private async handleConfigProposeEdit(
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    started: number,
  ): Promise<HostdResponse> {
    const enabled = this.opts.config.hostd?.config_edit_enabled === true;
    if (!enabled) {
      // #1761: policy denial (feature flag off), not a server error.
      // Flip to `denied` so callers branching on `result` see the
      // right classification.
      return err("E_CONFIG_EDIT_DISABLED", "config_propose_edit is disabled")
        .why("operator opt-in per RFC §3.3")
        .fixFlipFlag("hostd.config_edit_enabled", true)
        .docs("https://switchroom.dev/docs/config-edit#opt-in")
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .asDenied()
        .build(req.request_id, Date.now() - started);
    }
    const configPath =
      this.opts.configPath ?? req.args.target_path;
    // ── #4661 follow-up — path provenance, BEFORE anything is read or written ──
    // When no explicit `opts.configPath` is set (production: `main.ts` never
    // passes one) the write target is the WIRE literal, NOT hostd's own
    // `resolveHostdConfigPath`. Prove that literal names the same file the fleet
    // reads before going anywhere near a snapshot, an approval card, or a write:
    // writing one file and reconciling another returns `completed, exit_code: 0`
    // for a change nothing else can see. First check in the handler after the
    // feature flag, so a mismatch cannot leave half-changed state behind.
    //
    // An EXPLICIT `opts.configPath` skips the gate. That arm is the documented
    // embedder/test override (see the opt's docs and `resolveHostdConfigPath`
    // arm 1): the embedder has named the file deliberately, and a scratch config
    // under `tmp/` legitimately differs from whatever `findConfigFile` finds.
    if (this.opts.configPath === undefined) {
      const provenance = checkConfigPathProvenance(
        configPath,
        this.opts.resolveFleetConfigPath ?? findConfigFile,
        this.opts.identifyForProvenance ?? statIdentity,
      );
      if (!provenance.ok) {
        return this.configPathMismatch(provenance.detail, req, caller, started);
      }
    }
    const verdict = validateConfigEdit({
      configPath,
      targetPath: req.args.target_path,
      unifiedDiff: req.args.unified_diff,
    });
    if (!verdict.ok) {
      // #1761: surface a structured envelope so the agent can render a
      // targeted fix hint (the unified_diff is the only author-input).
      return err(verdict.code, verdict.detail)
        .fixBadInput("unified_diff")
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .build(req.request_id, Date.now() - started);
    }
    // ── Self-scope gate (non-admin callers) ─────────────────────────
    // checkGate admits non-admin agents to this verb; this is the
    // enforced boundary. A non-admin agent may only:
    //   (a) widen its OWN `agents.<caller>.tools.allow` — the "🔁 Always
    //       allow" persistence path; OR
    //   (b) append to its OWN `agents.<caller>.memory.mental_models[]` —
    //       the agent-proposes → human-approves mental-model curation path
    //       (hindsight Phase 5). The operator tap on the proposal card is the
    //       human gate; this check proves the edit can ONLY grow the caller's
    //       own declared-model list (a forged proposal diff smuggling in any
    //       other field is rejected here).
    // Operators and admin agents skip the check (full trust).
    //
    // `beforeContent` is read for ALL callers: the apply path compares the
    // propose-time semantic change set (`proposedChangedPaths`, below) against
    // the change set the re-applied diff produces after any approval-window
    // drift (#3121 follow-up). Read failure degrades to "" — the change set
    // then covers the whole file, and any real apply-time change set will
    // mismatch, aborting fail-closed.
    let beforeContent: string;
    try {
      beforeContent = readFileSync(configPath, "utf-8");
    } catch {
      beforeContent = "";
    }
    if (caller.kind === "agent" && this.opts.config.agents[caller.name]?.admin !== true) {
      // A non-admin edit is admitted if it is EITHER a self-scoped tools.allow
      // widen (the "🔁 Always allow" path) OR a self-scoped append to the
      // caller's own memory.mental_models[] (the agent-proposes → human-
      // approves curation path). Only when BOTH fail is the edit rejected. The
      // either/or combination lives in admitSelfScopedNonAdminEdit so it is
      // unit-testable without standing up this server. On denial we surface the
      // tools.allow detail (the historical, most-common failure mode) and
      // document the mental-models path in `.why()`.
      const admission = admitSelfScopedNonAdminEdit(
        beforeContent,
        verdict.postApplyContent,
        caller.name,
      );
      if (!admission.ok) {
        return err("E_NOT_SELF_SCOPED", admission.detail)
          .why(
            "non-admin agents may only add rules to their own " +
              "agents.<self>.tools.allow OR append their own " +
              "agents.<self>.memory.mental_models via config_propose_edit " +
              `(mental-model check: ${admission.mentalModelDetail})`,
          )
          .fixBadInput("unified_diff")
          .op("config_propose_edit")
          .caller("agent")
          .agentName(caller.name)
          .asDenied()
          .build(req.request_id, Date.now() - started);
      }
    }
    // ── Propose-time semantic change set (#3121 follow-up) ─────────
    // What the operator approves is the RENDERED DIFF's effect against the
    // config as it stood at propose time. The apply path re-applies the diff
    // against the then-current file; even with context anchoring, drift during
    // the approval window could make the same textual hunks land at different
    // YAML paths. Pin the semantic change set now and require the apply-time
    // re-application to produce the SAME set, or abort.
    const proposedChangedPaths = classifyBlastRadius(
      beforeContent,
      verdict.postApplyContent,
    ).changedPaths;
    // ── Approval card ───────────────────────────────────────────────
    if (!this.opts.approvalGateway) {
      // #1761: missing approval-gateway wiring is an operator/infra
      // configuration gap — the agent cannot self-recover.
      return err(
        "E_NO_APPROVAL_GATEWAY",
        "validation passed but hostd was started without an approval-gateway wiring; the operator build is missing the telegram-plugin link",
      )
        .fixOperatorAction("infra", [
          "ensure hostd was launched with --approval-gateway / telegram-plugin link",
        ])
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .build(req.request_id, Date.now() - started);
    }
    const callerName = caller.kind === "agent" ? caller.name : "operator";
    // ── Idempotency: collapse identical in-flight proposals ─────────
    // A re-fired identical proposal (same caller + same diff) must not
    // post a SECOND approval card or apply twice. Key by caller+diff
    // hash and share the in-flight promise so duplicate/concurrent
    // proposals converge on ONE card and EXACTLY ONE apply. This is
    // the invariant that survives the 2026-06-15 klanker debacle's
    // failure class: re-fires (then driven by a 10s wire timeout) had
    // stacked phantom cards and double-wrote a config entry.
    const dedupeKey = `${callerName}:${createHash("sha256")
      .update(req.args.unified_diff)
      .digest("hex")}`;
    const pending = this.inflightConfigProposals.get(dedupeKey);
    if (pending) {
      process.stderr.write(
        `hostd: config_propose_edit — collapsed identical in-flight proposal from ${callerName} (dedupe)\n`,
      );
      return await pending;
    }
    // Everything from the pre-approval query through the apply is wrapped in a
    // single deduped promise, registered SYNCHRONOUSLY into
    // `inflightConfigProposals` before the first `await` — so concurrent
    // identical proposals collapse onto ONE card + ONE apply. (The
    // pre-approval query below is async, so it MUST NOT sit between the dedupe
    // `get` above and this `set`, or two concurrent identicals could each post
    // a card.)
    // #3084 security audit — the propose-time whole-file post-image is NEVER
    // written. config_propose_edit validates the diff HERE, at propose-time,
    // but the operator card can block up to 60 min before the apply runs. Any
    // config change that lands during that window (a second approved proposal,
    // an operator hand-edit) would be SILENTLY REVERTED if we wrote the stale
    // post-image verbatim — including security fields like another agent's
    // tools.allow or hostd.config_edit_enabled itself. So the apply path
    // (under the mutex) re-applies the STORED DIFF against the CURRENT live
    // file: concurrent edits to OTHER regions survive (a unified diff only
    // rewrites its own hunks), and only a REAL conflict — the drift overlaps
    // this diff's hunks so the patch no longer applies — aborts.
    const run = this.runConfigProposeRateThenApply(
      req,
      caller,
      callerName,
      configPath,
      started,
      proposedChangedPaths,
    );
    this.inflightConfigProposals.set(dedupeKey, run);
    try {
      return await run;
    } finally {
      this.inflightConfigProposals.delete(dedupeKey);
    }
  }

  /**
   * The pre-approval-bypass + rate-limit + audit + approval/apply stages of
   * `config_propose_edit`, wrapped so the whole thing rides ONE deduped
   * in-flight promise (the caller registers it synchronously). Split out from
   * `handleConfigProposeEdit` because the pre-approval query (#2975 Stage 2) is
   * async and must run INSIDE the deduped promise, not between the dedupe
   * lookup and its registration.
   */
  private async runConfigProposeRateThenApply(
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    callerName: string,
    configPath: string,
    started: number,
    proposedChangedPaths: string[],
  ): Promise<HostdResponse> {
    // ── Pre-approval bypass (#2975 Stage 2) ─────────────────────────
    // Before the rate limit, ask the gateway whether this EXACT (agent, diff)
    // pair is already operator-consented — i.e. it byte-matches a correlation
    // the gateway pre-registered when the operator tapped Approve on a
    // mental-model proposal (or "🔁 Always allow"). That persist posts NO card
    // and consumes zero operator attention, yet was subject to the same 3/hour
    // bucket (issue #2975 — an approved change silently lost). When (and only
    // when) the gateway answers affirmatively, we skip BOTH the rate-limit
    // enforcement AND its bucket count for this call.
    //
    // FAIL CLOSED: the query is a read-only optimisation. Any non-answer,
    // error, unknown/unsupported-message reply, or timeout (an old gateway
    // during a mixed-version roll) resolves `false` inside the gateway adapter
    // — so we fall through to today's EXACT behaviour (rate limit applies; then
    // Stage 1's gateway retry backstop covers the approved-but-throttled
    // persist). A hostd built with this check but wired to a gateway/stub that
    // lacks `checkPreApproved` is the same fail-closed default.
    let preApproved = false;
    try {
      if (this.opts.approvalGateway!.checkPreApproved) {
        preApproved = await this.opts.approvalGateway!.checkPreApproved(
          callerName,
          req.args.unified_diff,
        );
      }
    } catch {
      // Defensive: the adapter already fails closed, but never let a query
      // fault take down the config-edit path.
      preApproved = false;
    }
    // ── Server-side rate limit (circuit-breaker) ────────────────────
    // A looping agent that re-fires DISTINCT diffs (any whitespace/context
    // drift defeats the byte-exact dedup) would otherwise post a fresh operator
    // card every time. Throttle per-caller via the existing
    // `config_edit_rate_per_hour` config field so the operator sees at most
    // N cards/hour from any one agent. (#config-edit-hardening) A pre-approved
    // persist skips this entirely — no enforcement AND no bucket count (we
    // never call checkConfigEditRate, so no timestamp is recorded).
    if (!preApproved) {
      const rate = this.checkConfigEditRate(callerName, Date.now());
      if (!rate.ok) {
        const retryAtIso = new Date(rate.retryAtMs).toISOString();
        process.stderr.write(
          `hostd: config_propose_edit — RATE-LIMITED ${callerName} ` +
            `(>${rate.limit}/hour); next slot ${retryAtIso}\n`,
        );
        // Leave a trail so the operator can retroactively see the throttle.
        void this.appendAuditRow({
          ts: new Date().toISOString(),
          op: "config_propose_edit",
          phase: "rate_limited",
          request_id: req.request_id,
          caller:
            caller.kind === "agent"
              ? { kind: "agent", name: caller.name }
              : { kind: "operator" },
          result: "denied",
          exit_code: null,
          duration_ms: Date.now() - started,
          error: `E_RATE_LIMITED: >${rate.limit} config_propose_edit cards/hour`,
        });
        return err(
          "E_RATE_LIMITED",
          `config_propose_edit rate limit exceeded (max ${rate.limit}/hour for this agent)`,
        )
          .why(`next slot opens at ${retryAtIso}`)
          .fixRetryAfter(retryAtIso)
          .op("config_propose_edit")
          .caller(caller.kind === "agent" ? "agent" : "operator")
          .agentName(caller.kind === "agent" ? caller.name : undefined)
          .asDenied()
          .build(req.request_id, Date.now() - started);
      }
    }
    // ── Audit at card-post time (item 5) ────────────────────────────
    // config_propose_edit otherwise writes NO audit row until the apply
    // path (which only runs on Allow). A loop that never reaches apply —
    // or one parked 10 min awaiting an operator tap — left no trail. Emit
    // a `requested` row NOW so an operator can retroactively see "agent
    // fired Nx" even for proposals that time out or get denied.
    void this.appendAuditRow({
      ts: new Date().toISOString(),
      op: "config_propose_edit",
      phase: "requested",
      request_id: req.request_id,
      caller:
        caller.kind === "agent"
          ? { kind: "agent", name: caller.name }
          : { kind: "operator" },
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
      // #2975 Stage 2 — mark the persist that bypassed the rate limit because
      // the gateway confirmed it was already operator-consented.
      ...(preApproved ? { pre_approved: true } : {}),
    });
    return await this.runConfigProposeApprovalAndApply(
      req,
      caller,
      callerName,
      configPath,
      started,
      proposedChangedPaths,
    );
  }

  /** In-flight config_propose_edit proposals, keyed by caller+diff hash. */
  private inflightConfigProposals = new Map<string, Promise<HostdResponse>>();

  /**
   * Per-caller sliding-window of config_propose_edit CARD-POST timestamps
   * (epoch-ms), keyed by caller name. Enforces `config_edit_rate_per_hour`
   * so a looping agent is throttled SERVER-SIDE rather than spamming the
   * operator with approval cards. Only counts proposals that reach the
   * card path (a fresh, validated, non-deduped diff) — validation errors
   * and collapsed in-flight duplicates don't consume the budget.
   */
  private configEditPostTimes = new Map<string, number[]>();

  /** Default cards/hour cap when `hostd.config_edit_rate_per_hour` is unset.
   *  Mirrors the schema default (RFC admin-agent-config-edit §5). */
  private static readonly DEFAULT_CONFIG_EDIT_RATE_PER_HOUR = 3;

  /**
   * Record a card-post for `callerName` and report whether it stays within
   * the per-hour cap. Prunes timestamps older than 1h, then admits iff the
   * window count is below the cap. On admit the new timestamp is recorded;
   * on reject nothing is recorded (so a throttled caller doesn't push its
   * own reset further out by hammering).
   */
  private checkConfigEditRate(
    callerName: string,
    now: number,
  ): { ok: true } | { ok: false; limit: number; retryAtMs: number } {
    const limit =
      this.opts.config.hostd?.config_edit_rate_per_hour ??
      HostdServer.DEFAULT_CONFIG_EDIT_RATE_PER_HOUR;
    const windowMs = 60 * 60 * 1000;
    const cutoff = now - windowMs;
    const prior = (this.configEditPostTimes.get(callerName) ?? []).filter(
      (t) => t > cutoff,
    );
    if (prior.length >= limit) {
      // Oldest in-window timestamp frees a slot one window after it landed.
      const retryAtMs = prior[0]! + windowMs;
      this.configEditPostTimes.set(callerName, prior);
      return { ok: false, limit, retryAtMs };
    }
    prior.push(now);
    this.configEditPostTimes.set(callerName, prior);
    return { ok: true };
  }

  /**
   * The approval-card + mutex-serialized apply phase of
   * `config_propose_edit`, split out so identical in-flight proposals
   * can be deduped onto a single shared promise (exactly-once apply).
   * Caller (`handleConfigProposeEdit`) has already validated the diff,
   * passed the self-scope gate, and confirmed the approval gateway is
   * wired.
   */
  private async runConfigProposeApprovalAndApply(
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    callerName: string,
    configPath: string,
    started: number,
    /** Sorted semantic change set approved at propose time (#3121 follow-up). */
    proposedChangedPaths: string[],
  ): Promise<HostdResponse> {
    const approvalId = (this.opts.generateApprovalId ?? defaultApprovalId)();
    const approval = await this.opts.approvalGateway!.requestApproval({
      requestId: approvalId,
      agentName: callerName,
      reason: req.args.reason,
      unifiedDiff: req.args.unified_diff,
      timeoutMs: CONFIG_APPROVAL_TIMEOUT_MS,
    });
    if (approval.verdict === "deny") {
      // #1762: distinguish operator-tap deny from gateway-side
      // dispatch failure (card never reached the operator). Without
      // this, a Telegram sendMessage 400 surfaces as a misleading
      // "operator denied" — see ref #1758 structured-error work.
      // #1761: tap-deny is a POLICY DENIAL (result: "denied").
      // Dispatch-failure is INFRA (result: "error").
      const legacy = formatConfigApprovalDenyError(approval, approvalId);
      const isDispatchFailure = approval.denySource === "dispatch_failure";
      const code = isDispatchFailure
        ? "E_APPROVAL_DISPATCH_FAILED"
        : "E_DENIED";
      const human = isDispatchFailure
        ? "approval card dispatch failed before the operator could see it"
        : "operator denied config_propose_edit";
      const b = err(code, human)
        .why(legacy)
        .fixOperatorAction(
          isDispatchFailure ? "infra" : "policy_denied",
          isDispatchFailure
            ? ["check telegram-plugin gateway connectivity"]
            : undefined,
        )
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined);
      if (!isDispatchFailure) b.asDenied();
      const built = b.build(req.request_id, Date.now() - started);
      // Preserve the verbatim legacy `error` string (tests + existing
      // string-matching decoders depend on the exact format from
      // `formatConfigApprovalDenyError`).
      return { ...built, error: legacy };
    }
    if (approval.verdict === "timeout") {
      // #1761: timeout is a policy-path denial (operator never acted),
      // not a server failure.
      const legacy = `E_APPROVAL_TIMEOUT: operator approval card expired without a tap (approval_id=${approvalId})`;
      const built = err(
        "E_APPROVAL_TIMEOUT",
        "operator approval card expired without a tap",
      )
        .why(`approval_id=${approvalId}`)
        .fixOperatorAction("policy_denied")
        .op("config_propose_edit")
        .caller(caller.kind === "agent" ? "agent" : "operator")
        .agentName(caller.kind === "agent" ? caller.name : undefined)
        .asDenied()
        .build(req.request_id, Date.now() - started);
      return { ...built, error: legacy };
    }
    // ── Apply path (mutex-serialized) ───────────────────────────────
    // Serialize concurrent config-edit applies through a single
    // in-process promise chain. Hostd is the only PROGRAMMATIC writer of
    // switchroom.yaml, so no cross-process flock is used — but operator
    // hand-edits are NOT under this lock: a hand-edit racing the short
    // (milliseconds) window between the snapshot read and the write below is
    // possible, just vanishingly unlikely. This is a known, accepted residual
    // race — do not describe this path as zero-race.
    const release = await this.acquireConfigApplyLock();
    try {
      // Snapshot the live config so we can rollback if reconcile
      // fails. Read synchronously — the lock is held, no one else
      // is touching the file.
      let snapshot: string;
      try {
        snapshot = readFileSync(configPath, "utf-8");
      } catch (e) {
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: `pre-write snapshot read failed: ${(e as Error).message}`,
        });
        // #1761: real infrastructure failure during rollback path.
        return this.reconcileFailedRolledBack(
          `snapshot read failed: ${(e as Error).message}`,
          req,
          caller,
          started,
        );
      }
      // ── #3084 security audit — re-apply the STORED diff under the lock ──
      // The propose-time whole-file post-image is NEVER written. The operator
      // card can block up to 60 min, during which another approved proposal or
      // an operator hand-edit may have changed the live file. Writing the stale
      // whole-file post-image verbatim would SILENTLY REVERT that change
      // (including security fields like another agent's tools.allow or
      // hostd.config_edit_enabled). Instead, under the lock, re-run the
      // validator — which applies the STORED diff against the CURRENT live file
      // at `configPath` — and write THAT.
      //
      // A unified diff only rewrites its own hunks, so a concurrent change to
      // some OTHER region of the file still applies cleanly and its edit
      // survives (legitimate non-conflicting concurrent edits complete). We
      // ABORT with E_CONFIG_CHANGED when the diff no longer applies cleanly,
      // when the re-applied diff would change different YAML paths than the
      // operator approved, or when a non-admin caller's edit is no longer
      // self-scoped against the drifted base (checks below). The config is
      // left untouched on abort (no bytes written yet) — the agent must
      // re-propose against the new base.
      const reverdict = validateConfigEdit({
        configPath,
        targetPath: req.args.target_path,
        unifiedDiff: req.args.unified_diff,
      });
      if (!reverdict.ok) {
        const why =
          `stored diff no longer applies against the current config` +
          `: ${reverdict.detail}`;
        // Nothing was written — "aborted_config_changed", NOT the
        // rollback outcome (#3121 follow-up, review finding 4).
        await approval.finalize({
          outcome: "aborted_config_changed",
          detail: `config changed since proposal — re-propose (${why})`,
        });
        return this.configChangedSinceProposal(why, req, caller, started);
      }
      // Fresh post-image = current live file + the stored diff (re-applied
      // under the lock), never the propose-time whole-file snapshot.
      const postApplyFresh = reverdict.postApplyContent;
      // ── #3121 follow-up — the re-applied diff must mean what was approved ──
      // Even a clean re-apply can land at DIFFERENT YAML paths than the
      // operator saw at propose time (context lines are not globally unique in
      // a config full of structurally identical agent blocks). Structurally
      // compare the semantic change set of (current live file → fresh
      // post-image) against the propose-time set; any divergence aborts —
      // nothing has been written yet.
      const applyChangedPaths = classifyBlastRadius(
        snapshot,
        postApplyFresh,
      ).changedPaths;
      const sameChangeSet =
        applyChangedPaths.length === proposedChangedPaths.length &&
        applyChangedPaths.every((p, i) => p === proposedChangedPaths[i]);
      if (!sameChangeSet) {
        const why =
          `re-applied diff changes different config paths than approved ` +
          `(approved: [${proposedChangedPaths.join(", ")}]; ` +
          `would change: [${applyChangedPaths.join(", ")}])`;
        await approval.finalize({
          outcome: "aborted_config_changed",
          detail: `config changed since proposal — re-propose (${why})`,
        });
        return this.configChangedSinceProposal(why, req, caller, started);
      }
      // ── #3121 follow-up — re-run the self-scope gate at APPLY time ──
      // The propose-time admitSelfScopedNonAdminEdit call proved the edit was
      // self-scoped against the propose-time base. After drift, the re-applied
      // diff could produce a DIFFERENT effect (e.g. relocate into another
      // agent's block) — so for non-admin callers the gate must hold against
      // the fresh post-image too, or a non-admin agent escalates across the
      // approval window. Abort (nothing written) rather than apply.
      if (
        caller.kind === "agent" &&
        this.opts.config.agents[caller.name]?.admin !== true
      ) {
        const reAdmission = admitSelfScopedNonAdminEdit(
          snapshot,
          postApplyFresh,
          caller.name,
        );
        if (!reAdmission.ok) {
          const why =
            `re-applied diff is no longer self-scoped for non-admin caller ` +
            `"${caller.name}": ${reAdmission.detail}`;
          await approval.finalize({
            outcome: "aborted_config_changed",
            detail: `config changed since proposal — re-propose (${why})`,
          });
          return this.configChangedSinceProposal(why, req, caller, started);
        }
      }
      // In-place write preserving the inode (bind-mount safe). The old
      // `<path>.tmp` → rename() swap returned EBUSY here because
      // switchroom.yaml is itself a read-only bind-mount source mounted
      // into every agent container — see writeFileInPlacePreservingInode.
      try {
        this.writeLiveConfig(configPath, postApplyFresh);
      } catch (e) {
        // Write failed before any bytes were flushed, OR mid-write. We
        // hold the snapshot, so restore it in place to be safe rather
        // than assume the live file is untouched.
        try {
          this.writeLiveConfig(configPath, snapshot);
        } catch {
          /* best-effort restore; original error is the one that matters */
        }
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: `in-place write failed: ${(e as Error).message}`,
        });
        return this.reconcileFailedRolledBack(
          `write failed: ${(e as Error).message}`,
          req,
          caller,
          started,
        );
      }
      // ── #4661 — the write must be OBSERVED before we trust it ──
      // A write that neither throws nor lands used to flow straight into
      // reconcile, and a clean `switchroom apply` (which re-reads the
      // UNCHANGED file, so of course it passes) then returned
      // `result: completed, exit_code: 0` for an edit that was never applied.
      // `completed` must be keyed off the file, not off the reconcile's exit
      // code. Verify BEFORE the reconcile so a false success cannot be
      // laundered through it.
      const observation = verifyConfigWriteObserved(
        configPath,
        postApplyFresh,
        snapshot,
        proposedChangedPaths,
      );
      if (!observation.ok) {
        const why = `post-write verification failed: ${observation.reasons.join("; ")}`;
        // Bytes may or may not be on disk — we cannot tell, which is the
        // whole problem — so restore the snapshot unless what we read back
        // ALREADY is the snapshot (a no-op write: rewriting identical bytes
        // would only bump mtime and wake config watchers for nothing).
        const snapshotBuf = Buffer.from(snapshot, "utf-8");
        const alreadySnapshot =
          observation.observed !== null && observation.observed.equals(snapshotBuf);
        let restoreDetail: string;
        if (alreadySnapshot) {
          restoreDetail =
            "live config already byte-identical to the pre-write snapshot; no restore needed";
        } else {
          try {
            this.writeLiveConfig(configPath, snapshot);
            restoreDetail = "rolled back to the pre-write snapshot";
          } catch (e) {
            // Nested failure: verification failed AND the restore failed.
            // The live file is in an unknown state and no automated path can
            // recover it — say so loudly rather than implying a clean rollback.
            restoreDetail =
              `SNAPSHOT RESTORE ALSO FAILED: ${(e as Error).message} — ` +
              `live config at ${configPath} is in an UNKNOWN state, inspect it by hand`;
          }
        }
        // Closest available terminal card state — NOT a claim that a
        // reconcile ran and rejected the config (it never ran; see the
        // `writeNotObserved` doc comment, which is the WIRE code and IS
        // precise). `ApprovalResult.finalize`'s `outcome` is a 3-valued
        // contract — "applied" | "aborted_config_changed" |
        // "reconcile_failed_rolled_back" — shared with the telegram card
        // renderer, and old gateways reject an unknown outcome
        // (mixed-version safety), so widening it to a distinct
        // "write_not_observed" needs the gateway side to land first.
        // Same reuse, same reason, as update-notifier.ts's apply_refused
        // path. Until then the detail below carries the honest cause.
        // Tracked in #4667 (widen the outcome enum + card renderer).
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: `${why}; ${restoreDetail}`,
        });
        return this.writeNotObserved(
          `${why}; ${restoreDetail}`,
          req,
          caller,
          started,
        );
      }
      // Reconcile — scoped to the requesting agent when possible.
      // `switchroom apply --only <name>` scaffolds only that agent (8s
      // vs 2+ min for the full fleet), which keeps the round-trip well
      // within the gateway's 60s dispatch timeout. Falls back to a
      // full apply when the caller is the operator socket (rare) or
      // `runReconcile` is injected by tests.
      //
      // #4661 follow-up — PIN the child's config resolution to the file we just
      // wrote. Without this the child ran `findConfigFile()` itself
      // (`$SWITCHROOM_CONFIG` → cwd → `~/.switchroom`) while hostd wrote
      // `configPath`, and the two agreed only because `hostd install` happens to
      // export `SWITCHROOM_CONFIG`. Nothing enforced it, and the divergence is
      // silent by construction: hostd writes X, the child reconciles Y cleanly,
      // and the response is `completed, exit_code: 0` for a change absent from
      // the file the fleet reads. One env var makes the agreement structural.
      // The same overlay is handed to the ROLLBACK reconcile below (same
      // `runner`), so the restore is reconciled against the same file too.
      const reconcileEnv = { SWITCHROOM_CONFIG: configPath };
      const runner =
        this.opts.runReconcile ??
        (async () =>
          this.runSwitchroom(
            caller.kind === "agent"
              ? ["apply", "--only", callerName, "--non-interactive"]
              : ["apply", "--non-interactive"],
            reconcileEnv,
          ));
      const recRes = await runner({ requestId: approvalId, env: reconcileEnv });
      if (recRes.exit_code === 0) {
        // Tell the operator which agents must restart for this edit to go
        // live (claude loads config at boot — an applied edit is inert until
        // restart). Fails safe to fleet-wide on any ambiguity.
        const blast = classifyBlastRadius(snapshot, postApplyFresh);
        await approval.finalize({
          outcome: "applied",
          affectedAgents: blast.agents,
          fleetWide: blast.fleetWide,
        });
        // #4661 diagnosability: pin WHICH file this `completed` is a claim
        // about, and what it looked like immediately after the verified
        // write. A future false success then leaves evidence in the audit
        // row instead of an unattributable "exit 0".
        const writeEvidence =
          `config write observed: path=${configPath} ` +
          `size=${observation.size} mtime_ms=${observation.mtimeMs}`;
        return {
          v: 1,
          request_id: req.request_id,
          result: "completed",
          exit_code: 0,
          duration_ms: Date.now() - started,
          // Appended (not prefixed): `tail` keeps the END of an over-budget
          // string, so the evidence survives a chatty reconcile.
          stdout_tail: tail(`${recRes.stdout}\n--- ${writeEvidence} ---`),
          stderr_tail: tail(recRes.stderr),
        };
      }
      // ── Reconcile failed → rollback to snapshot, re-run reconcile.
      // Same in-place write (not rename) so the rollback path is also
      // bind-mount safe.
      let rollbackDetail = "";
      try {
        this.writeLiveConfig(configPath, snapshot);
      } catch (e) {
        rollbackDetail = `snapshot restore failed: ${(e as Error).message}`;
        await approval.finalize({
          outcome: "reconcile_failed_rolled_back",
          detail: rollbackDetail,
        });
        return this.reconcileFailedRolledBack(
          rollbackDetail,
          req,
          caller,
          started,
        );
      }
      const recRes2 = await runner({ requestId: approvalId, env: reconcileEnv });
      const recoveryNote =
        recRes2.exit_code === 0
          ? "rolled back successfully"
          : `rolled back but recovery reconcile also failed (exit ${recRes2.exit_code})`;
      // #2781: carry the failed reconcile's output into the audit row —
      // pre-fix the rolled-back path discarded stdout/stderr entirely,
      // so "reconcile exit 1" gave the operator nothing to diagnose with.
      await approval.finalize({
        outcome: "reconcile_failed_rolled_back",
        detail: `${recoveryNote}; reconcile stderr: ${tail(recRes.stderr, 512) || "(empty)"}`,
      });
      return this.reconcileFailedRolledBack(
        `reconcile exit ${recRes.exit_code}; ${recoveryNote}`,
        req,
        caller,
        started,
        { primary: recRes, recovery: recRes2 },
      );
    } finally {
      release();
    }
  }

  /**
   * #1761: shared helper for the five sites that bail out of
   * `handleConfigProposeEdit` with `E_RECONCILE_FAILED_ROLLED_BACK`.
   * Carries a structured `operator_action`/`infra` envelope (the
   * agent can't self-recover from a write/reconcile failure) while
   * preserving the verbatim legacy `error` string so audit-reader /
   * existing string-match decoders see no regression.
   */
  /**
   * #3084 security audit — the live config drifted between propose-time
   * validation and the (up to 60-min-delayed) operator approval, so the apply
   * ABORTS rather than clobber the intervening change. Nothing was written; the
   * live file is intact. Surfaced as a denial (policy outcome, not infra) with
   * a re-propose hint, since the agent CAN self-recover by re-proposing against
   * the new base.
   */
  private configChangedSinceProposal(
    why: string,
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const legacy = `E_CONFIG_CHANGED: config changed since proposal — re-propose (${why})`;
    const built = err(
      "E_CONFIG_CHANGED",
      "config changed since the proposal was validated; re-propose against the current config",
    )
      .why(why)
      .fixBadInput("unified_diff")
      .op("config_propose_edit")
      .caller(caller.kind === "agent" ? "agent" : "operator")
      .agentName(caller.kind === "agent" ? caller.name : undefined)
      .asDenied()
      .build(req.request_id, Date.now() - started);
    return { ...built, error: legacy };
  }

  /**
   * The single write path for the live config during a `config_propose_edit`
   * apply — forward write AND both rollback restores. Routed through the
   * `writeConfigFile` opt so a test can install a write that silently does
   * nothing (see the opt's doc comment); defaults to the real bind-mount-safe
   * in-place writer.
   */
  private writeLiveConfig(path: string, content: string): void {
    (this.opts.writeConfigFile ?? writeFileInPlacePreservingInode)(path, content);
  }

  /**
   * #4661 — the apply wrote bytes but they are NOT observable at
   * `configPath` (or the file on disk no longer means what the operator
   * approved). Deliberately DISTINCT from `E_RECONCILE_FAILED_ROLLED_BACK`:
   * that code says "the config changed and switchroom apply rejected it",
   * this one says "hostd cannot prove the config changed at all". Conflating
   * them is what let the original incident read as an ordinary reconcile
   * failure. Infra-class — the agent cannot self-recover by re-proposing,
   * because the diff was fine; the write path is what is broken.
   */
  private writeNotObserved(
    detail: string,
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const legacy = `E_WRITE_NOT_OBSERVED: ${detail}`;
    const built = err(
      "E_WRITE_NOT_OBSERVED",
      "config write could not be observed on the target file; apply aborted before reconcile",
    )
      .why(detail)
      .fixOperatorAction("infra", [
        "confirm hostd reads and writes the SAME switchroom.yaml the fleet reads (check the hostd bind mount over /state/config/switchroom.yaml)",
        "check for a competing writer to the config (operator hand-edit or editor daemon) during the apply window",
        "inspect the live config by hand before re-proposing — the diff was valid, the write path was not",
      ])
      .op("config_propose_edit")
      .caller(caller.kind === "agent" ? "agent" : "operator")
      .agentName(caller.kind === "agent" ? caller.name : undefined)
      .build(req.request_id, Date.now() - started);
    return { ...built, error: legacy };
  }

  /**
   * #4661 follow-up — the write target is not the file the fleet reads, so the
   * apply refused before touching anything. Sibling of
   * {@link HostdServer.writeNotObserved}, and the two compose as before/after
   * halves of the same guarantee: this one asserts path IDENTITY up front (the
   * limitation `verifyConfigWriteObserved` documents as out of its scope), the
   * other asserts the bytes LANDED at that path afterwards. Neither subsumes
   * the other — a correct path can still swallow a write, and an observed write
   * to the wrong file still reads back perfectly.
   */
  private configPathMismatch(
    detail: string,
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const legacy = `E_CONFIG_PATH_MISMATCH: ${detail}`;
    const built = err(
      "E_CONFIG_PATH_MISMATCH",
      "hostd would write a different switchroom.yaml than the fleet reads; apply refused before any write",
    )
      .why(detail)
      .fixOperatorAction("infra", [
        `confirm the hostd container bind-mounts the live switchroom.yaml onto ${CANONICAL_CONFIG_PATH}`,
        "confirm SWITCHROOM_CONFIG inside the hostd container points at that same path (hostd install exports it alongside the mount)",
        "re-propose once the two agree — the diff was never applied, nothing was written",
      ])
      .op("config_propose_edit")
      .caller(caller.kind === "agent" ? "agent" : "operator")
      .agentName(caller.kind === "agent" ? caller.name : undefined)
      .build(req.request_id, Date.now() - started);
    return { ...built, error: legacy };
  }

  private reconcileFailedRolledBack(
    detail: string,
    req: Extract<HostdRequest, { op: "config_propose_edit" }>,
    caller: SocketIdentity,
    started: number,
    // #2781: captured output of the failed reconcile (and the recovery
    // reconcile, when one ran). Pre-fix this path DISCARDED the child's
    // stdout/stderr while the success path returned stdout_tail/stderr_tail
    // — so a rolled-back edit surfaced only "reconcile exit 1" with zero
    // diagnostics. Mirror the success path's tail fields here.
    output?: {
      primary: { stdout: string; stderr: string };
      recovery?: { stdout: string; stderr: string; exit_code: number };
    },
  ): HostdResponse {
    const legacy = `E_RECONCILE_FAILED_ROLLED_BACK: ${detail}`;
    const built = err(
      "E_RECONCILE_FAILED_ROLLED_BACK",
      "config write or reconcile failed; live file rolled back to snapshot",
    )
      .why(detail)
      .fixOperatorAction("infra", [
        "inspect hostd logs + switchroom apply output to identify the underlying failure",
      ])
      .op("config_propose_edit")
      .caller(caller.kind === "agent" ? "agent" : "operator")
      .agentName(caller.kind === "agent" ? caller.name : undefined)
      .build(req.request_id, Date.now() - started);
    const resp: HostdResponse = { ...built, error: legacy };
    if (output) {
      const recoveryStdout =
        output.recovery && output.recovery.exit_code !== 0
          ? `\n--- recovery reconcile stdout ---\n${output.recovery.stdout}`
          : "";
      const recoveryStderr =
        output.recovery && output.recovery.exit_code !== 0
          ? `\n--- recovery reconcile stderr ---\n${output.recovery.stderr}`
          : "";
      resp.stdout_tail = tail(output.primary.stdout + recoveryStdout);
      resp.stderr_tail = tail(output.primary.stderr + recoveryStderr);
    }
    return resp;
  }

  /** Serializes concurrent config_propose_edit apply phases. */
  private configApplyLock: Promise<void> = Promise.resolve();
  private async acquireConfigApplyLock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const prior = this.configApplyLock;
    this.configApplyLock = prior.then(() => next);
    await prior;
    return release;
  }

  private async handleAgentSmoke(
    req: Extract<HostdRequest, { op: "agent_smoke" }>,
    started: number,
  ): Promise<HostdResponse> {
    // req.args.name is AgentNameSchema-validated at decode and passed
    // as its own argv element; docker exec stops parsing its options
    // at CONTAINER so nothing after it is read as a docker flag.
    // #3136: mirror handleAgentExec/handleAgentLogs — reject any target
    // that is not a configured peer agent BEFORE constructing the
    // container name, so smoke's docker exec / inspect can't be aimed at
    // a singleton service container (vault-broker, approval-kernel, …).
    // Defense-in-depth: smoke runs fixed literal probes and returns
    // exit-code-only, but the guard keeps this sink consistent with its
    // siblings and closes the boolean-existence-probe gap.
    const rejected = this.rejectUnconfiguredTarget(
      req.args.name,
      req.request_id,
      "agent_smoke",
      started,
    );
    if (rejected) return rejected;
    const container = `switchroom-${req.args.name}`;
    type Probe = { name: string; state: "ok" | "fail" | "skip"; detail: string };
    const respond = (
      containerState: "running" | "absent",
      probes: Probe[],
    ): HostdResponse => ({
      v: 1,
      request_id: req.request_id,
      result: "completed",
      exit_code: probes.some((p) => p.state === "fail") ? 1 : 0,
      duration_ms: Date.now() - started,
      stdout_tail: tail(
        JSON.stringify({
          container: containerState,
          deep: !!req.args.deep,
          probes,
        }),
      ),
    });

    let running = false;
    try {
      const insp = await this.runDocker([
        "inspect",
        "-f",
        "{{.State.Running}}",
        container,
      ]);
      running = insp.exit_code === 0 && insp.stdout.trim() === "true";
    } catch {
      running = false;
    }

    const PROBES: { name: string; cmd: string }[] = [
      {
        name: "auth",
        // The agent's claude state dir is /state/agent/.claude — NOT
        // $HOME/.claude (HOME=/state/agent/home) and CLAUDE_CONFIG_DIR
        // is unset in-container. Verified live: the OAuth credential
        // is /state/agent/.claude/.credentials.json. Probing the
        // $HOME/$CLAUDE_CONFIG_DIR paths gave a false "auth FAIL" for
        // every (healthy, Telegram-serving) agent. Match the other
        // probes, which already key off /state/agent.
        cmd: "test -s /state/agent/.claude/.credentials.json",
      },
      {
        name: "scheduler",
        cmd: "grep -q '_switchroom_supervise.*agent-scheduler' /state/agent/start.sh && pgrep -f agent-scheduler >/dev/null",
      },
      {
        name: "mcp",
        cmd: "python3 -m json.tool /state/agent/.mcp.json >/dev/null 2>&1",
      },
      {
        // grep -q emits NOTHING on stdout — only an exit code, so the
        // token value never leaves the container.
        name: "bot_token",
        cmd: "test -f /state/agent/telegram/.env && grep -qE '^TELEGRAM_BOT_TOKEN=[0-9]+:' /state/agent/telegram/.env",
      },
      { name: "state", cmd: "test -w /state/agent" },
      {
        // tzdata integrity. The compose `/etc/localtime` bind mount is
        // aimed at a path that stock Debian ships as a SYMLINK into
        // /usr/share/zoneinfo; Docker resolves the destination through
        // that symlink before mounting, so on any agent image built
        // before the Dockerfile.agent de-symlink step the agent's local
        // zonefile was written over /usr/share/zoneinfo/Etc/UTC. The
        // container then reports LOCAL time for every by-name UTC
        // lookup (`ZoneInfo("UTC")`, `TZ=UTC date`, Go/Java/Rust) —
        // hours wrong, silently, with no error anywhere.
        //
        // This probe is the loud detector for a stale image: it fails
        // when (a) /etc/localtime is still a symlink (the precondition
        // that lets the clobber happen at all) or (b) Etc/UTC no longer
        // decodes to a zero offset (the clobber already happened).
        // Condition (b) also catches a mount aimed at some other zone.
        // Exit code only — nothing is printed, so no container state
        // leaks into the hostd response.
        //
        // python3 is guaranteed present (the `mcp` probe above relies
        // on it). Single-quoted around the python body so the shell
        // passes it verbatim.
        name: "tzdata",
        cmd:
          "test ! -L /etc/localtime && python3 -c 'import sys;" +
          "from datetime import datetime;" +
          "from zoneinfo import ZoneInfo;" +
          'sys.exit(0 if datetime.now(ZoneInfo("Etc/UTC")).utcoffset()' +
          ".total_seconds()==0 else 1)'",
      },
    ];
    if (req.args.deep) {
      // Token-introspect probe: parse .credentials.json in-container and
      // verify the OAuth access token is present (correct format) and
      // non-expired. No model call — no programmatic usage. Replaces the
      // former `claude -p ok` check which was a compliance violation under
      // Anthropic's 2026-06-15 policy (programmatic usage, off subscription).
      // Closes #1798.
      PROBES.push({
        name: "auth_live",
        // python3 is already used by the `mcp` probe above so it is
        // guaranteed available. The script exits 0 only when:
        //   1. .credentials.json exists and is valid JSON
        //   2. claudeAiOauth.accessToken matches sk-ant-oat\d+- prefix
        //   3. claudeAiOauth.expiresAt is absent OR in the future (ms epoch)
        // Single-quoted around the python body so shell passes it verbatim.
        // Nothing is printed — exit code is the only signal; no token value
        // can leak into the hostd response or operator audit log.
        cmd:
          "python3 -c 'import json,sys,time,re;" +
          'c=json.load(open("/state/agent/.claude/.credentials.json"));' +
          'o=c.get("claudeAiOauth",{});' +
          't=o.get("accessToken","");' +
          'sys.exit(0 if re.match(r"sk-ant-oat\\d+-",t)' +
          ' and ("expiresAt" not in o or o["expiresAt"]>time.time()*1000)' +
          " else 1)'",
      });
    }

    if (!running) {
      return respond(
        "absent",
        PROBES.map((p) => ({
          name: p.name,
          state: "skip" as const,
          detail: `container ${container} is not running — use agent_start`,
        })),
      );
    }

    const probes: Probe[] = await Promise.all(
      PROBES.map(async (p): Promise<Probe> => {
        try {
          // No `--`: docker exec stops option-parsing at CONTAINER
          // (see handleAgentExec) — a literal `--` is exec'd as the
          // command → exit 127. p.cmd is a fixed literal anyway.
          const r = await this.runDocker([
            "exec",
            container,
            "sh",
            "-lc",
            p.cmd,
          ]);
          return {
            name: p.name,
            state: r.exit_code === 0 ? "ok" : "fail",
            // NEVER include r.stdout: probes are exit-code only so a
            // secret can't leak into the operator/audit surface.
            detail: r.exit_code === 0 ? "ok" : `exit ${r.exit_code}`,
          };
        } catch (err) {
          // docker binary missing / exec spawn error → not a health
          // signal about the agent. Skip, never fail.
          return {
            name: p.name,
            state: "skip",
            detail: `probe could not run: ${(err as Error).message}`,
          };
        }
      }),
    );
    return respond("running", probes);
  }

  /**
   * Read-only fleet (or single-agent) docker status — uptime + memory +
   * active. The whole point: hostd HAS the docker socket, so
   * `getAllAgentStatuses` (which shells `docker inspect`/`docker stats`)
   * works here, where it throws/returns-null in the dockerless web
   * container. Result is JSON-encoded into `payload` as `{ statuses }`.
   *
   * Always `completed` when the config loads and the status sweep runs
   * (a down/absent container is a *finding* in the per-agent status, not
   * a verb failure — same posture as doctor). A genuine fault (config
   * unreadable, status sweep throws) returns `error` with a message;
   * never crashes the daemon.
   */
  private handleAgentStatus(
    req: Extract<HostdRequest, { op: "agent_status" }>,
    started: number,
  ): HostdResponse {
    try {
      const cfg = loadConfig(this.opts.configPath);
      const all = getAllAgentStatuses(cfg);
      const statuses = req.args.name
        ? req.args.name in all
          ? { [req.args.name]: all[req.args.name]! }
          : {}
        : all;
      return {
        v: 1,
        request_id: req.request_id,
        result: "completed",
        exit_code: 0,
        duration_ms: Date.now() - started,
        payload: JSON.stringify({ statuses }),
      };
    } catch (e) {
      return {
        v: 1,
        request_id: req.request_id,
        result: "error",
        exit_code: null,
        duration_ms: Date.now() - started,
        error: `agent_status failed: ${(e as Error).message}`,
      };
    }
  }

  /**
   * Read-only cron schedule view — the cascade-resolved schedule entries
   * PLUS the most-recent fires per agent. Loads config FRESH (not the
   * daemon's cached startup config): `loadConfig` merges each agent's
   * `~/.switchroom/agents/<name>/schedule.d/*.yaml` overlays, and those
   * files are 0600 owned by the agent's container UID — readable here
   * (hostd runs as root with DAC_OVERRIDE) but EACCES from the
   * operator/web vantage. That overlay-merge is exactly why this lands
   * the agent-authored crons the dashboard otherwise misses.
   *
   * Result is JSON-encoded into `payload` as `{ entries, recentByAgent }`,
   * BOUNDED by {@link boundScheduleView} (prompt ≤160 chars, each fire's
   * outputSummary ≤100 chars, last 8 fires/agent) so the frame stays
   * under the 64 KiB cap even for a large fleet with long prompts.
   */
  private handleAgentSchedule(
    req: Extract<HostdRequest, { op: "agent_schedule" }>,
    started: number,
  ): HostdResponse {
    try {
      const cfg = loadConfig(this.opts.configPath);
      let entries = collectScheduleEntries(cfg);
      if (req.args.name) entries = entries.filter((e) => e.agent === req.args.name);
      const agentsDir = resolveAgentsDir(cfg);
      const recentByAgent: Record<string, DispatchResult[]> = {};
      for (const agent of new Set(entries.map((e) => e.agent))) {
        const rows = readRecentFires(resolve(agentsDir, agent, "scheduler.jsonl"));
        if (rows.length > 0) recentByAgent[agent] = rows;
      }
      const bounded = boundScheduleView(entries, recentByAgent);
      return {
        v: 1,
        request_id: req.request_id,
        result: "completed",
        exit_code: 0,
        duration_ms: Date.now() - started,
        payload: JSON.stringify(bounded),
      };
    } catch (e) {
      return {
        v: 1,
        request_id: req.request_id,
        result: "error",
        exit_code: null,
        duration_ms: Date.now() - started,
        error: `agent_schedule failed: ${(e as Error).message}`,
      };
    }
  }

  /** Spawn the host `docker` CLI and capture stdout/stderr. Symmetric
   *  with {@link runSwitchroom}; broken out for testability + so
   *  failures get a "docker binary missing" surface separate from
   *  switchroom CLI failures. */
  private runDocker(
    args: string[],
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const bin = this.opts.dockerBin ?? "docker";
      const child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) =>
        resolve({ exit_code: code ?? -1, stdout, stderr }),
      );
    });
  }

  /**
   * Acquire the fleet-mutation lock. If something else is already
   * holding it, return a `denied` response naming the in-flight
   * request so the caller can `get_status` it instead of waiting.
   * Idempotency-key dedupe already happened upstream — by the time
   * we reach this check, we know this isn't a retry of the
   * in-flight call.
   */
  /**
   * The running switchroom containers and the version each is on — the
   * source `prior_pin` is derived from.
   *
   * INJECTED, never self-serviced. The daemon does not reach for `docker`
   * on its own: production wires {@link dockerFleetComponents} at the sole
   * composition root (`main.ts`), and a server built without it sees an
   * EMPTY fleet, which the resolver records as
   * `prior_pin_source: "unobserved"` — an honest "could not look", never a
   * fallback to the config pin.
   *
   * The asymmetry is deliberate. A self-servicing default would make every
   * unit test's `prior_pin` depend on whichever containers the host running
   * the suite happens to have — the same host-vs-container divergence
   * `vitest.config.ts` scrubs env vars to prevent. The wiring is asserted
   * by `tests/host-control/hostd-fleet-components-callsite.test.ts`, so
   * dropping it fails CI instead of silently degrading rollback.
   */
  private fleetComponents(): ComponentVersion[] {
    return this.opts.fleetComponents ? this.opts.fleetComponents() : [];
  }

  /**
   * Enumerate the docker image refs the digest resolver should look up.
   * In production, shells out to `docker compose config --images` so
   * the resolver targets exactly the images the running compose file
   * references. Returns [] on any failure — the resolver itself is
   * fail-soft so missing input degrades to an empty digest map.
   *
   * Tests override via the `imageRefsForDigests` opt.
   */
  private imageRefsForDigestCapture(): string[] {
    if (this.opts.imageRefsForDigests) return this.opts.imageRefsForDigests();
    try {
      const composePath = join(
        this.opts.bindRoot ?? this.opts.homeDir,
        ".switchroom",
        "compose",
        "docker-compose.yml",
      );
      if (!existsSync(composePath)) return [];
      const r = spawnSync(
        "docker",
        [
          "compose",
          "-p",
          "switchroom",
          "-f",
          composePath,
          "config",
          "--images",
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      if (r.status !== 0) return [];
      return (r.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  private checkFleetMutationLock(
    op: "update_apply" | "apply" | "rollout",
    request_id: string,
    started: number,
  ): HostdResponse | null {
    const inFlight = this.fleetMutationInFlight;
    if (!inFlight) return null;
    const ageMs = Date.now() - inFlight.started_at;
    return deniedResponse(
      request_id,
      `${op}: fleet-mutation lock held by ${inFlight.op} ` +
        `(request_id "${inFlight.request_id}", running ${Math.floor(ageMs / 1000)}s). ` +
        `Wait for it to complete (poll get_status with target_request_id="${inFlight.request_id}") ` +
        `before issuing another fleet mutation.`,
      Date.now() - started,
    );
  }

  /** Shared fire-and-forget spawn used by update_apply + apply.
   *  Updates the status entry on completion AND releases the
   *  fleet-mutation lock (success or fail). */
  private spawnFleetMutation(
    op: "update_apply" | "apply" | "rollout",
    args: string[],
    entry: StatusEntry,
    extraEnv?: Record<string, string>,
  ): void {
    this.runSwitchroom(args, extraEnv)
      .then((res) => {
        entry.result = res.exit_code === 0 ? "completed" : "error";
        entry.exit_code = res.exit_code;
        entry.finished_at = Date.now();
        entry.stdout_tail = tail(res.stdout);
        entry.stderr_tail = tail(res.stderr);
        // Parse the deferral sentinel emitted by the update driver when
        // one or more steps were deferred due to hostd-context (#2458).
        // Only relevant for update_apply (apply/rollout don't emit it), but
        // parseUpdateResultLine is a no-op / returns null on absent sentinel.
        if (op === "update_apply") {
          const parsed = parseUpdateResultLine(res.stdout);
          if (parsed && parsed.deferred.length > 0) {
            entry.deferred = parsed.deferred;
          }
        }
      })
      .catch((err) => {
        entry.result = "error";
        entry.exit_code = null;
        entry.finished_at = Date.now();
        entry.error = (err as Error).message;
      })
      .finally(() => {
        // Durable terminal row. Fire-and-forget: the append is async
        // and NOT awaited here, so the lock releases before the row
        // hits disk — acceptable because (a) the synchronous `started`
        // row already records that the mutation was attempted, and
        // (b) appendAuditRow is best-effort by contract. If hostd is
        // SIGKILLed in the sub-millisecond window between this call
        // and the write landing, we lose only the terminal row, not
        // the fact-of-attempt. writeTerminalAudit never throws
        // (appendAuditRow swallows), so it's safe un-awaited here.
        void this.writeTerminalAudit(entry);
        // Release the lock IF we're still the one holding it. A test
        // (or a future code path) that reset the daemon's state
        // mid-call shouldn't have its replacement lock clobbered.
        if (
          this.fleetMutationInFlight &&
          this.fleetMutationInFlight.request_id === entry.request_id
        ) {
          this.fleetMutationInFlight = null;
        }
      });
  }

  /**
   * Fire-and-forget spawn for `rollout` (#2487). Distinct from
   * spawnFleetMutation: it injects the `SWITCHROOM_HOSTD_CONTEXT=1`
   * sentinel into the child env and parses the child's STRUCTURED result
   * sentinel off stdout into the status entry's `rolled[]` / `failed_step`
   * / `failed_agent` fields — instead of relying on a flattened stdout
   * tail. Releases the fleet-mutation lock on completion (success/fail).
   */
  private spawnRollout(args: string[], entry: StatusEntry): void {
    // KEN-131 — capture the prior pin NOW: the terminal handler below
    // deletes entry.prior_pin on failure (correct for --allow-downgrade
    // defaulting), but the unattended-failure recovery still needs it as
    // the rollback target.
    const priorPinAtStart = entry.prior_pin;
    // #2726 — tap the child's stdout line-by-line so each rollout PHASE
    // sentinel becomes a durable, hash-chained audit row AS the roll runs
    // (the log is the single source of truth; the narration surface in Part 2
    // PULLS from it). hostd is the SOLE writer of the chained log — the
    // subprocess only emits sentinels on stdout, never touches the file.
    const onLine = (line: string): void => {
      const phase = parseRolloutPhaseLine(line);
      if (phase) this.onRolloutPhase(entry, phase);
    };
    // Set ONLY when the child emitted a structured sentinel saying the roll
    // completed. `entry.result === "completed"` is NOT the same test: the
    // no-sentinel branch below infers "completed" from a zero exit code, which
    // is exactly the case where we cannot tell a proven roll from a child that
    // died quietly. See the `.finally()` below for why the distinction decides
    // whether a surviving journal is DELETED or ACTED ON.
    let sentinelProvenOk = false;
    this.runSwitchroom(args, { SWITCHROOM_HOSTD_CONTEXT: "1" }, onLine)
      .then((res) => {
        entry.exit_code = res.exit_code;
        entry.finished_at = Date.now();
        entry.stdout_tail = tail(res.stdout);
        entry.stderr_tail = tail(res.stderr);
        const parsed = parseRolloutResultLine(res.stdout);
        if (parsed) {
          entry.rolled = parsed.rolled;
          if (parsed.failedStep) entry.failed_step = parsed.failedStep;
          if (parsed.failedAgent) entry.failed_agent = parsed.failedAgent;
          // #3928 — the components the roll left behind. Lifted out of the
          // sentinel so the Telegram-side `get_status` names them.
          if (parsed.drifted && parsed.drifted.length > 0) {
            entry.drifted = parsed.drifted;
          }
          // #3944 — the roll's non-fatal warnings. `encodeRolloutResultLine`
          // puts them on the wire (`warnings: result.warnings`) but this lift
          // used to skip them, so they never reached get_status or the
          // narration card. Surface them alongside the other structured fields.
          if (parsed.warnings && parsed.warnings.length > 0) {
            entry.warnings = parsed.warnings;
          }
          // BONUS (#2458 got-field gap): the sentinel carries `got` (the
          // actual version detected on the failed agent, or null when
          // unreachable). Preserve it so get_status readers can surface the
          // mismatch without scraping stdout.
          if (parsed.got !== undefined) entry.got = parsed.got;
          // A timeout is its own outcome class: preserve it so get_status /
          // the terminal audit row can say "killed on timeout" rather than
          // just "exit 1". Only set when true — absence means "not a timeout".
          if (parsed.timedOut) entry.timed_out = true;
          // Structured `ok` is the authority; exit code corroborates.
          entry.result = parsed.ok ? "completed" : "error";
          sentinelProvenOk = parsed.ok === true;
        } else {
          // No sentinel — the child died before finishing (e.g. SIGKILL).
          // Fall back to the exit code; structured fields stay unset so a
          // reader can tell the outcome wasn't cleanly captured.
          entry.result = res.exit_code === 0 ? "completed" : "error";
        }
        // prior_pin is only meaningful on COMPLETED rows (#2492): a failed
        // canary roll does NOT change the running pin, so recording a
        // prior_pin on an error row would mislead subsequent --allow-downgrade
        // defaulting logic into thinking the roll succeeded. Strip it on
        // failure — together with the corroborating fields, so an error row
        // never carries a half-populated prior-pin story.
        if (entry.result !== "completed") {
          delete entry.prior_pin;
          delete entry.prior_pin_observed;
          delete entry.prior_pin_source;
        }
      })
      .catch((err) => {
        entry.result = "error";
        entry.exit_code = null;
        entry.finished_at = Date.now();
        entry.error = (err as Error).message;
        delete entry.prior_pin;
        delete entry.prior_pin_observed;
        delete entry.prior_pin_source;
      })
      .finally(() => {
        // Crash net for the durable pin, GATED ON THE OUTCOME.
        //
        // The rollout child commits its own provisional `release.pin` on
        // success and reverts it on a clean failure, so a journal surviving to
        // the TERMINAL usually means the child died in between (SIGKILL / OOM).
        // "Usually" is not "always", and the exception is the dangerous one:
        // `commitPinPersist` can FAIL to unlink the journal (EIO, a read-only
        // state dir, or a directory sitting at the journal path) on a roll that
        // otherwise SUCCEEDED. The child returns ok:true with a warning and
        // exits 0. Running recovery on that journal — with the child now dead,
        // so `isJournalWriterAlive` is false — would revert a PROVEN pin to
        // priorPin while telling the operator the roll succeeded, and every
        // later reconcile would drag the fleet back to the prior version.
        //
        // So: a sentinel that says ok:true means the pin is proven, and the
        // surviving journal is never input to REVERT. It is only debris to
        // delete when it is also attributable to THIS roll — the child no-ops
        // its journal write when the config already names the target, so a
        // journal can equally be a predecessor's orphan, and on a subset roll
        // that orphan is the only record the pin is unproven elsewhere.
        // `clearProvenRolloutPinJournal` makes that call from `started_at`.
        // Everything else (ok:false, no sentinel at all, a rejected promise)
        // goes through the stale-gated revert. Both run before the lock is
        // released and before any other mutation can start.
        const pinNote = sentinelProvenOk
          ? this.clearProvenRolloutPinJournal(
              `rollout terminal ${entry.request_id}`,
              entry.started_at,
            )
          : this.recoverRolloutPinJournal(
              `rollout terminal ${entry.request_id}`,
            );
        if (pinNote) entry.stderr_tail = `${entry.stderr_tail ?? ""}\n${pinNote}`.trim();
        void this.writeTerminalAudit(entry);
        // KEN-131 — unattended (auto-update) roll that FAILED: no operator
        // is watching, so the hardened no-operator path runs instead of the
        // plain terminal push: latch the failed pin (no unattended retry
        // loop), attempt rollback of pre-canary damage WHILE STILL HOLDING
        // the fleet-mutation lock (recovery runs `apply`/`agent restart` —
        // racing another mutation would interleave compose writes), then
        // alert the operator and release the lock.
        if (isAutoRolloutRequestId(entry.request_id) && entry.result !== "completed") {
          this.lastAutoRolloutFailedPin = entry.pin ?? null;
          if (entry.pin) {
            // Upgrade the launch-time "attempting" latch to a durable
            // "failed" — survives hostd restarts (self-bump recreate,
            // crash-loops), so the same broken pin is never re-rolled
            // unattended by a fresh daemon.
            this.writeAutoRolloutLatch({
              v: 1,
              pin: entry.pin,
              request_id: entry.request_id,
              outcome: "failed",
              at: new Date().toISOString(),
              ...(entry.failed_step ? { reason: entry.failed_step } : {}),
            });
          }
          void this.finishFailedAutoRollout(entry, priorPinAtStart);
          return;
        }
        // Green unattended roll — release the durable launch latch so the
        // NEXT release can auto-roll.
        if (isAutoRolloutRequestId(entry.request_id)) {
          this.clearAutoRolloutLatch();
        }
        // #2726 — terminal effects. All fire-and-forget and defensively
        // wrapped: a chat push / narrator finalize must NEVER block the lock
        // release or the roll's completion (a throwing narrator/relay can't
        // strand the fleet-mutation lock).
        this.pushRolloutTerminal(entry);
        try {
          this.rolloutNarrator?.onTerminal(entry);
        } catch (e) {
          process.stderr.write(
            `hostd: rollout narrator onTerminal threw (non-fatal): ${(e as Error).message}\n`,
          );
        }
        if (
          this.fleetMutationInFlight &&
          this.fleetMutationInFlight.request_id === entry.request_id
        ) {
          this.fleetMutationInFlight = null;
        }
      });
  }

  /**
   * KEN-131 — terminal handling for a FAILED unattended auto-update roll.
   * Runs (and awaits) the rollback recovery while the fleet-mutation lock
   * is STILL HELD, then alerts the operator via the existing rollout
   * terminal relay (with the recovery outcome appended), and only then
   * releases the lock. Every step is defensively wrapped — nothing here
   * may strand the lock.
   */
  private async finishFailedAutoRollout(
    entry: StatusEntry,
    priorPin: string | undefined,
  ): Promise<void> {
    // #3928 — a residual-drift failure is a DIFFERENT operator instruction
    // from a stopped-partway failure. The agents reached the target; what
    // did not converge is a named component. Telling the operator to
    // "re-run the roll" here would be wrong (it would not touch the stale
    // component), so name the components instead.
    const drifted = entry.drifted ?? [];
    const notes: string[] =
      entry.failed_step === "verify-components"
        ? [
            `Unattended auto-update roll to ${entry.pin ?? "?"} rolled ` +
              `${(entry.rolled ?? []).length} agent(s) but did NOT converge the ` +
              `whole host: ${drifted.join(", ") || "one or more components"} ` +
              `still behind. Re-running the roll will not fix this — run the ` +
              `per-component install named in the rollout warnings, then ` +
              `\`switchroom update --check\` to confirm.`,
          ]
        : entry.failed_step === "ensure-banks"
          ? // Same class as verify-components: the agents reached the target and
            // the pin is committed — the residue is a named agent whose Hindsight
            // bank could not be created. Restarting that agent re-runs its bank
            // creation; re-running the whole roll would not help.
            [
              `Unattended auto-update roll to ${entry.pin ?? "?"} rolled ` +
                `${(entry.rolled ?? []).length} agent(s) but could NOT create the ` +
                `Hindsight bank for: ${drifted.join(", ") || "one or more agents"}. ` +
                `Re-running the roll will not fix this — restart the named agent(s) ` +
                `to re-run bank creation now that Hindsight is back up.`,
            ]
          : [
            `Unattended auto-update roll to ${entry.pin ?? "?"} FAILED at ` +
              `${entry.failed_step ?? "unknown step"}` +
              `${entry.failed_agent ? ` (agent ${entry.failed_agent})` : ""}. ` +
              `Unattended retries of this version are disabled; fix the cause, ` +
              `then roll manually (\`switchroom rollout --pin ${entry.pin ?? "vX.Y.Z"}\`).`,
          ];
    try {
      notes.push(...(await this.recoverFailedAutoRollout(entry, priorPin)));
    } catch (e) {
      notes.push(
        `Automatic rollback THREW: ${(e as Error).message} — verify compose/` +
          `canary state host-side.`,
      );
    } finally {
      this.pushRolloutTerminal(entry, notes);
      try {
        this.rolloutNarrator?.onTerminal(entry);
      } catch (e) {
        process.stderr.write(
          `hostd: rollout narrator onTerminal threw (non-fatal): ${(e as Error).message}\n`,
        );
      }
      if (
        this.fleetMutationInFlight &&
        this.fleetMutationInFlight.request_id === entry.request_id
      ) {
        this.fleetMutationInFlight = null;
      }
    }
  }

  /**
   * KEN-131 — rollback for an unattended roll that failed BEFORE any agent
   * reached the target (failed `apply`, or a failed canary with nothing
   * rolled). In that window the durable pin was never persisted (hostd-
   * context rollouts persist AFTER the canary), so config still names the
   * prior pin — but the one-shot `apply --pin <target>` DID rewrite the
   * compose file, and a failed canary may have left the canary agent
   * restarted onto (or wedged against) the broken target image. Recovery:
   * regenerate compose on the prior pin, and restart the canary back onto
   * it. Past-canary failures are NOT auto-rolled-back: the canary proved
   * the build green, the fleet is mixed-but-functional, and an unattended
   * mass rollback is riskier than alerting the operator.
   *
   * Returns human-readable outcome notes for the alert message.
   */
  private async recoverFailedAutoRollout(
    entry: StatusEntry,
    priorPin: string | undefined,
  ): Promise<string[]> {
    const notes: string[] = [];
    const rolledCount = (entry.rolled ?? []).length;
    // #3928 — residual component drift is NOT a partially-applied roll, and
    // both generic branches below would misdescribe it: the agent fleet is
    // uniformly on the target (not "mixed"), and the change DID land (not
    // "nothing to revert"). Rolling back here would be actively wrong — it
    // would drag a converged fleet backwards to fix a stale singleton.
    if (entry.failed_step === "verify-components") {
      notes.push(
        `No automatic rollback: the agent fleet reached ` +
          `${entry.pin ?? "the target"} and the pin is committed — the gap is ` +
          `${(entry.drifted ?? []).join(", ") || "a component"}, not the fleet. ` +
          `Rolling back would move working agents backwards; converge the ` +
          `named component(s) forward instead.`,
      );
      return notes;
    }
    // ensure-banks is the same forward-fix class: the fleet is on the target
    // and the pin is committed; a rollback would drag working agents backwards
    // to fix a missing bank. Restart the named agent(s) instead.
    if (entry.failed_step === "ensure-banks") {
      notes.push(
        `No automatic rollback: the agent fleet reached ` +
          `${entry.pin ?? "the target"} and the pin is committed — the gap is a ` +
          `missing Hindsight bank for ${(entry.drifted ?? []).join(", ") || "an agent"}, ` +
          `not the fleet. Restart the named agent(s) to re-create the bank; do ` +
          `not roll back.`,
      );
      return notes;
    }
    const beforeAnyAgent =
      entry.failed_step === "apply" ||
      (entry.failed_step === "restart-agent" && rolledCount === 0);
    if (!beforeAnyAgent) {
      notes.push(
        rolledCount > 0
          ? `No automatic rollback: ${rolledCount} agent(s) already confirmed on ` +
              `${entry.pin ?? "the target"} past a green canary ` +
              `(${(entry.rolled ?? []).join(", ")}). The fleet is mixed — ` +
              `finish the roll or roll back manually.`
          : // rolled=0 but failed_step isn't apply/restart-agent — the roll
            // was refused BEFORE apply (e.g. preflight-stale-cli) or died
            // without a step label: nothing was changed, nothing to revert.
            `No automatic rollback: the roll stopped at ` +
              `${entry.failed_step ?? "an unknown step"} before any change ` +
              `landed — nothing to revert. Verify host-side if unsure.`,
      );
      return notes;
    }
    if (!priorPin) {
      notes.push(
        `No automatic rollback: no prior version could be read off the running ` +
          `fleet when this roll started (every agent was already on the target, ` +
          `or no agent container reported a semver tag), so there is no restore ` +
          `target to name. Verify compose host-side (\`switchroom apply\`).`,
      );
      return notes;
    }
    // Compose restore: the failed roll's `apply --pin <target>` rewrote the
    // compose file while the durable pin still names <prior>. Regenerating on
    // the prior pin realigns compose with config so the next reconcile/restart
    // cannot silently pull agents onto the broken target.
    const applyRes = await this.runSwitchroom(
      ["apply", "--pin", priorPin, "--compose-only", "--non-interactive"],
      { SWITCHROOM_HOSTD_CONTEXT: "1" },
    );
    if (applyRes.exit_code === 0) {
      notes.push(`Rollback: compose restored to ${priorPin}.`);
    } else {
      // Regeneration failed — fall back to the pre-version-bump compose
      // backup. This is the FIRST real consumer of `<compose>.bak`; the
      // write-side comment used to claim src/cli/update.ts rolled back to it,
      // but no such code existed. With the backup rule fixed
      // (shouldBackupCompose — a roll's per-agent restarts can no longer
      // clobber it), the file genuinely holds the pre-roll compose.
      //
      // Strictly a FALLBACK behind `apply --pin`, and not "known good": the
      // backup means "the last compose on a different image tag", which can
      // predate config changes or hold a previously-failed build. It is
      // service-set gated inside restoreComposeBackup — a backup that would
      // drop or resurrect an agent is refused rather than applied blind.
      const restore = await restoreComposeBackup(this.fleetComposePath());
      notes.push(
        `Rollback: compose regeneration to ${priorPin} exited ` +
          `${applyRes.exit_code} ` +
          `(${tail(applyRes.stderr).trim().slice(-300) || "no stderr"}). ` +
          (restore.restored
            ? `Fell back to the pre-bump compose backup (image tag ` +
              `${restore.imageTag ?? "unknown"}). Verify host-side with ` +
              `\`switchroom apply\`.`
            : `Backup fallback ALSO failed (${restore.reason ?? "unknown"}) — ` +
              `run \`switchroom apply\` host-side.`),
      );
    }
    if (entry.failed_step === "restart-agent" && entry.failed_agent) {
      const restartRes = await this.runSwitchroom(
        [
          "agent",
          "restart",
          entry.failed_agent,
          "--wait",
          "--force",
          "--pin",
          priorPin,
        ],
        { SWITCHROOM_HOSTD_CONTEXT: "1" },
      );
      notes.push(
        restartRes.exit_code === 0
          ? `Rollback: canary ${entry.failed_agent} restarted back on ${priorPin}.`
          : `Rollback FAILED: canary ${entry.failed_agent} did not restart ` +
              `cleanly on ${priorPin} (exit ${restartRes.exit_code}) — restart ` +
              `it manually.`,
      );
    }
    return notes;
  }

  /**
   * #2726 Part 1 — push ONE ordinary operator-DM message on the rollout
   * terminal row via the gateway relay. Fire-and-forget: `postTerminal` never
   * throws and never awaits a reply, so the roll can't stall on a slow/absent
   * gateway. No-op when no relay is wired or the caller isn't an agent (the
   * relay routes through the caller agent's gateway, like the approval card).
   */
  private pushRolloutTerminal(entry: StatusEntry, extraNotes?: string[]): void {
    if (!this.opts.rolloutRelay) return;
    // Relay routing: an agent-invoked roll pings through the CALLER agent's
    // gateway (unchanged). An unattended auto-update roll (KEN-131) has no
    // caller agent — route the alert through the FIRST admin agent's gateway
    // (the same class of agent whose gateway carries approval cards); when
    // no admin agent exists, drop (the durable audit row remains).
    const relayAgent =
      entry.caller.kind === "agent"
        ? entry.caller.name
        : isAutoRolloutRequestId(entry.request_id)
          ? this.firstAdminAgentName()
          : null;
    if (relayAgent === null) return;
    try {
      const text = renderRolloutStatus({
        target: entry.pin ?? "",
        rolled: entry.rolled,
        terminal: entry.result === "completed" ? "completed" : "error",
        requestId: entry.request_id,
        ...(entry.prior_pin ? { fromVersion: entry.prior_pin } : {}),
        ...(entry.finished_at !== null
          ? { elapsedMs: entry.finished_at - entry.started_at }
          : {}),
        ...(entry.failed_step ? { failedStep: entry.failed_step } : {}),
        ...(entry.failed_agent ? { failedAgent: entry.failed_agent } : {}),
        ...(entry.got !== undefined ? { got: entry.got } : {}),
        ...(entry.drifted && entry.drifted.length > 0
          ? { drifted: entry.drifted }
          : {}),
        // #3944 — surface the roll's non-fatal warnings on the terminal card.
        ...(entry.warnings && entry.warnings.length > 0
          ? { warnings: entry.warnings }
          : {}),
        // #4571 — hostd mounts the operator's `~/.switchroom`, so the host
        // CLI's own stamp is readable from here. Without it the card printed a
        // hardcoded `sudo npm i -g` (wrong for a user-owned nvm prefix) and
        // listed the host CLI as outstanding even once it was converged.
        ...(() => {
          const stamp = readHostCliStamp();
          return stamp ? { hostCli: stamp } : {};
        })(),
      });
      this.opts.rolloutRelay.postTerminal({
        requestId: entry.request_id,
        agentName: relayAgent,
        text:
          extraNotes && extraNotes.length > 0
            ? text + "\n\n" + extraNotes.map((n) => `- ${n}`).join("\n")
            : text,
      });
    } catch (e) {
      process.stderr.write(
        `hostd: rollout terminal push failed (non-fatal): ${(e as Error).message}\n`,
      );
    }
  }

  /**
   * First configured admin-tier agent, or null (KEN-131 — relay target for
   * unattended-rollout alerts, which have no caller agent).
   *
   * Matches `admin: true` OR `root: true` and iterates in SORTED key order —
   * the same rule and the same deterministic order the KEN-129 update-card
   * dispatch uses in main.ts. Matching only `admin` would silently drop the
   * alert on a fleet whose sole privileged agent is `root: true`, and object
   * insertion order would make the target depend on yaml key order.
   */
  private firstAdminAgentName(): string | null {
    const agents = (this.opts.config.agents ?? {}) as Record<
      string,
      { admin?: boolean; root?: boolean } | undefined
    >;
    for (const name of Object.keys(agents).sort()) {
      const a = agents[name];
      if (a?.admin === true || a?.root === true) return name;
    }
    return null;
  }

  private handleGetStatus(
    req: Extract<HostdRequest, { op: "get_status" }>,
    _caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const entry = this.statusByRequestId.get(req.args.target_request_id);
    if (!entry) {
      // #2726 — the gate admitted this because a ROLLOUT row for the
      // request_id exists in the durable log but the in-memory entry is gone
      // (hostd restarted mid-roll / entry aged out). Rebuild the status
      // response from the LATEST durable rollout row — the log is the source
      // of truth. If somehow no row is found now (raced eviction), fall through
      // to the internal-invariant error.
      const fromLog = this.rolloutStatusFromLog(
        req.request_id,
        req.args.target_request_id,
        started,
      );
      if (fromLog) return fromLog;
      // #1761: internal invariant violation — no fix.kind applies.
      const legacy = `get_status: internal: entry missing despite gate accept`;
      const built = err("E_INTERNAL", "entry missing despite gate accept")
        .op("get_status")
        .build(req.request_id, Date.now() - started);
      return { ...built, error: legacy };
    }
    return this.statusEntryToResponse(req.request_id, entry);
  }

  /** True when the durable audit log holds at least one rollout row for
   *  `targetRequestId` (#2726 get_status durable fallback). Best-effort:
   *  a read error is treated as "no row". */
  private rolloutRowExistsInLog(targetRequestId: string): boolean {
    const path = this.auditLogPath();
    if (!existsSync(path)) return false;
    try {
      const raw = readFileSync(path, "utf-8");
      return latestRolloutRowForRequest(raw, targetRequestId) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Build a `get_status` response for a rollout from its LATEST durable audit
   * row (#2726). Used only when the in-memory status entry is gone. Surfaces
   * the same rollout `payload` shape as the live path (phase / n / m / agent /
   * rolled / failedStep / failedAgent / pin / prior_pin) so a reader gets
   * identical structure whether the entry is live or reconstructed from disk.
   * Returns null when no rollout row exists for the request.
   */
  private rolloutStatusFromLog(
    responseRequestId: string,
    targetRequestId: string,
    started: number,
  ): HostdResponse | null {
    const path = this.auditLogPath();
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    const row = latestRolloutRowForRequest(raw, targetRequestId);
    if (!row) return null;
    // A terminal row's `result` is completed/error; a phase row's is "started".
    const isTerminal = row.phase === "terminal";
    const payload = JSON.stringify({
      rolled: row.rolled ?? [],
      // Phase rows carry the transition name in `phase`; the terminal row's
      // phase is the literal "terminal", which a reader shows as "done".
      ...(row.phase && !isTerminal ? { phase: row.phase } : {}),
      ...(row.n !== undefined ? { n: row.n } : {}),
      ...(row.m !== undefined ? { m: row.m } : {}),
      ...(row.agent ? { agent: row.agent } : {}),
      ...(row.failed_step ? { failedStep: row.failed_step } : {}),
      ...(row.failed_agent ? { failedAgent: row.failed_agent } : {}),
      // #3928 — same field the live path emits, so a reader gets the
      // stranded component names whether the entry is live or replayed.
      ...(row.drifted && row.drifted.length > 0 ? { drifted: row.drifted } : {}),
      ...(row.pin ? { pin: row.pin } : {}),
      ...(row.prior_pin ? { prior_pin: row.prior_pin } : {}),
    });
    return {
      v: 1,
      request_id: responseRequestId,
      result: row.result as Result,
      exit_code: row.exit_code,
      duration_ms: Date.now() - started,
      payload,
    };
  }

  private statusEntryToResponse(
    request_id: string,
    entry: StatusEntry,
  ): HostdResponse {
    // Rollout (#2487) surfaces its STRUCTURED outcome via `payload` so a
    // get_status reader gets rolled[]/failedStep/failedAgent as data, not
    // a stdout-tail it has to grep. Only emitted on rollout entries that
    // actually captured structured fields.
    const rolloutPayload =
      entry.op === "rollout" &&
      (entry.rolled !== undefined ||
        entry.failed_step !== undefined ||
        entry.failed_agent !== undefined ||
        // #3944 — a roll can succeed with warnings and NO other structured
        // field set (all agents rolled, but web/hostd refresh flagged a
        // non-fatal miss). Emit the payload on warnings alone so those don't
        // silently vanish from get_status on an otherwise-clean roll.
        (entry.warnings !== undefined && entry.warnings.length > 0) ||
        // #2726 point 2 — un-blind an IN-FLIGHT rollout too: a live phase (no
        // rolled[]/failed_step yet) is enough to emit a payload so a
        // get_status poll mid-roll shows the current phase, not a bare "started".
        entry.current_phase !== undefined)
        ? JSON.stringify({
            rolled: entry.rolled ?? [],
            // Current phase + roll-order (#2726) — present while in flight and
            // on the final row (the terminal phase leaves current_phase set to
            // the last transition seen). A reader can render "canary-start" /
            // "agent 3/8" without scraping the durable log.
            ...(entry.current_phase ? { phase: entry.current_phase } : {}),
            ...(entry.phase_n !== undefined ? { n: entry.phase_n } : {}),
            ...(entry.phase_m !== undefined ? { m: entry.phase_m } : {}),
            ...(entry.phase_agent ? { agent: entry.phase_agent } : {}),
            ...(entry.failed_step ? { failedStep: entry.failed_step } : {}),
            ...(entry.failed_agent ? { failedAgent: entry.failed_agent } : {}),
            // BONUS (#2458 got-field gap): include `got` when present.
            ...(entry.got !== undefined ? { got: entry.got } : {}),
            // #3928 — components left behind by the roll. Structured so a
            // Telegram `get_status` can name them without a host shell.
            ...(entry.drifted && entry.drifted.length > 0
              ? { drifted: entry.drifted }
              : {}),
            // #3944 — the roll's non-fatal warnings, surfaced structurally so a
            // Telegram get_status reader sees them without a host shell.
            ...(entry.warnings && entry.warnings.length > 0
              ? { warnings: entry.warnings }
              : {}),
            ...(entry.pin ? { pin: entry.pin } : {}),
            // Prior-pin (#2492) surfaced structurally too, so a rollback-aware
            // reader gets it from get_status, not only the durable terminal row.
            ...(entry.prior_pin ? { prior_pin: entry.prior_pin } : {}),
          })
        : undefined;
    // Update-apply (#2458) payload: deferred steps + channel/pin enrichment.
    const updatePayload: Record<string, unknown> | null =
      entry.op === "update_apply" &&
      (entry.deferred !== undefined ||
        entry.channel !== undefined ||
        entry.pin !== undefined)
        ? {
            ...(entry.deferred !== undefined ? { deferred: entry.deferred } : {}),
            ...(entry.pin !== undefined ? { pin: entry.pin } : {}),
            ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
          }
        : null;
    const payload = rolloutPayload ?? (updatePayload ? JSON.stringify(updatePayload) : undefined);
    return {
      v: 1,
      request_id,
      result: entry.result,
      exit_code: entry.exit_code,
      duration_ms: (entry.finished_at ?? Date.now()) - entry.started_at,
      stdout_tail: entry.stdout_tail || undefined,
      stderr_tail: entry.stderr_tail || undefined,
      ...(payload ? { payload } : {}),
      error: entry.error,
    };
  }

  private recordStatus(entry: StatusEntry): void {
    this.statusByRequestId.set(entry.request_id, entry);
    // Evict oldest if over cap.
    if (this.statusByRequestId.size > STATUS_MAX_ENTRIES) {
      const oldest = [...this.statusByRequestId.values()].sort(
        (a, b) => a.started_at - b.started_at,
      )[0];
      if (oldest) this.statusByRequestId.delete(oldest.request_id);
    }
    // Lazy expiration sweep — every insert.
    const cutoff = Date.now() - STATUS_RETENTION_MS;
    for (const [id, e] of this.statusByRequestId) {
      if (e.started_at < cutoff) this.statusByRequestId.delete(id);
    }
  }

  private evictExpiredIdempotency(now: number): void {
    for (const [k, v] of this.idempotencyKeys) {
      if (now - v.ts >= IDEMPOTENCY_WINDOW_MS) this.idempotencyKeys.delete(k);
    }
  }

  private auditLogPath(): string {
    return (
      this.opts.auditLogPath ??
      join(this.opts.homeDir, ".switchroom", "host-control-audit.log")
    );
  }

  /** Rotate `<audit>.log` → `<audit>.log.1` when it reaches the cap.
   *  Best-effort and never throws — housekeeping must not break the
   *  privileged-verb request path it guards. */
  private maybeRotateAuditLog(path: string): void {
    const { maxBytes, maxFiles } = resolveRotationConfig({
      maxBytes: this.opts.auditMaxBytes,
      maxFiles: this.opts.auditMaxFiles,
      envBytesVar: "SWITCHROOM_HOSTD_AUDIT_MAX_BYTES",
      envFilesVar: "SWITCHROOM_HOSTD_AUDIT_MAX_FILES",
      defaultBytes: DEFAULT_HOSTD_AUDIT_MAX_BYTES,
      defaultFiles: DEFAULT_HOSTD_AUDIT_MAX_FILES,
    });
    maybeRotateLogFile(path, { maxBytes, maxFiles, tag: "hostd-audit" });
  }

  /** Append one JSONL row. Best-effort: a failed append logs to
   *  stderr but never throws into the request path. Serialized via
   *  `auditAppendChain` so large rows can't interleave. */
  private appendAuditRow(row: Record<string, unknown>): Promise<void> {
    const path = this.auditLogPath();
    this.auditAppendChain = this.auditAppendChain.then(async () => {
      await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
      // Seed + chain INSIDE the serialized section so seq/prev are
      // computed against the latest durably-written row, never a stale
      // enqueue-time snapshot. State advances only after the append
      // resolves — a failed write can't desync the chain from disk.
      if (this.auditChainState === undefined) {
        this.auditChainState = seedChain(path);
      }
      // Size-based rotation, INSIDE the serialized section so it can never
      // interleave with an in-flight append (#3596). Rows carry redacted
      // terminal output (~4 KiB each) so this file grew to 44 MB unbounded
      // on a live host before this bound existed.
      //
      // The hash chain is deliberately NOT re-seeded across the rotation:
      // `this.auditChainState` keeps advancing, so the first row written
      // into the freshly-truncated file links back to the last row now
      // living in `<path>.1` and cross-file tamper-evidence continuity
      // holds. `verifyAuditLog` scores per-row self-consistency and merely
      // COUNTS linkage breaks as segments, so a rotation seam is never
      // reported as tampering; `parseAuditLine` returns null on a torn
      // line, so the reader is unaffected either way.
      this.maybeRotateAuditLog(path);
      const { line, next } = chainRow(this.auditChainState, row);
      try {
        await appendFile(path, line);
        this.auditChainState = next;
      } catch (err) {
        process.stderr.write(
          `hostd: audit append failed: ${(err as Error).message}\n`,
        );
      }
    });
    return this.auditAppendChain;
  }

  private async writeAudit(args: {
    caller: SocketIdentity;
    req: HostdRequest;
    resp: HostdResponse;
    /** #1841 — attestation attribution. `"passphrase-attest"` on rows
     *  where an operator-passphrase attestation was verified (or a
     *  required attestation was missing/rejected). NEVER carries the
     *  passphrase itself — only the method tag. */
    method?: string;
  }): Promise<void> {
    await this.appendAuditRow({
      ts: new Date().toISOString(),
      op: args.req.op,
      ...(args.method ? { method: args.method } : {}),
      caller:
        args.caller.kind === "agent"
          ? { kind: "agent", name: args.caller.name }
          : { kind: "operator" },
      request_id: args.req.request_id,
      result: args.resp.result,
      exit_code: args.resp.exit_code,
      duration_ms: args.resp.duration_ms,
      // NOTE: the generic request-path row deliberately does NOT
      // persist stdout_tail/stderr_tail. `agent_exec` (allowlist
      // includes `cat`) and `agent_logs` flow through here — an admin
      // running `agent_exec cat .../credentials.json` would otherwise
      // write a peer's OAuth token into a file admin agents can read
      // :ro. The audit log is the *detection* surface, not the secret
      // payload (PR #1215 reviewer invariant). Output-tail persistence
      // is scoped to the fleet-mutation terminal path only — see
      // writeTerminalAudit, where update_apply/apply are the only ops
      // and the tails are redacted before they hit disk.
      error: args.resp.error,
    });
  }

  /** Durable terminal-outcome row for an async fleet mutation
   *  (update_apply / apply ONLY — those are the sole ops that call
   *  spawnFleetMutation). Written directly from the spawn completion
   *  handler so the record does NOT depend on a get_status poll
   *  happening to land after the subprocess exits and before the next
   *  hostd recreate. `phase: "terminal"` distinguishes it from the
   *  synchronous `started` row the request path already wrote for the
   *  same request_id.
   *
   *  Secret posture: `switchroom update`/`apply` provision per-agent
   *  `.env` / vault material, so a stack trace dumping a config object
   *  could land secrets in the 4 KiB tail. We run stdout/stderr/error
   *  through the vendored synchronous `redact()` (the same scrubber
   *  the PreToolUse secret hook uses) BEFORE persisting. This is the
   *  load-bearing mitigation — NOT file perms: the audit log is bind-
   *  mounted :ro into admin agents (RFC C #1337) and MUST stay world-
   *  readable for `/audit hostd` to work, exactly like vault-audit.log
   *  (apply.ts pins it 0644 for the same reason). Tightening to 0600
   *  would break the feature; redaction + the writeAudit scoping above
   *  are what keep secrets out of the file. */
  private async writeTerminalAudit(entry: StatusEntry): Promise<void> {
    const stdoutTail = entry.stdout_tail ? redact(entry.stdout_tail) : "";
    const stderrTail = entry.stderr_tail ? redact(entry.stderr_tail) : "";
    const errMsg = entry.error ? redact(entry.error) : "";
    await this.appendAuditRow({
      ts: new Date().toISOString(),
      op: entry.op,
      phase: "terminal",
      caller:
        entry.caller.kind === "agent"
          ? { kind: "agent", name: entry.caller.name }
          : { kind: "operator" },
      request_id: entry.request_id,
      result: entry.result,
      exit_code: entry.exit_code,
      duration_ms: (entry.finished_at ?? Date.now()) - entry.started_at,
      ...(stdoutTail ? { stdout_tail: stdoutTail } : {}),
      ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      ...(errMsg ? { error: errMsg } : {}),
      // Update-flow enrichment fields (only present on update_apply
      // entries; spread-omit keeps them off other ops' rows).
      ...(entry.channel ? { channel: entry.channel } : {}),
      ...(entry.pin ? { pin: entry.pin } : {}),
      ...(entry.resolved_sha ? { resolved_sha: entry.resolved_sha } : {}),
      ...(entry.install_context ? { install_context: entry.install_context } : {}),
      // Rollout structured result (#2487) — only present on rollout rows.
      ...(entry.rolled ? { rolled: entry.rolled } : {}),
      ...(entry.failed_step ? { failed_step: entry.failed_step } : {}),
      ...(entry.failed_agent ? { failed_agent: entry.failed_agent } : {}),
      // #3928 — components left behind. Durable so `rolloutStatusFromLog`
      // can still name them after the in-memory entry is evicted.
      ...(entry.drifted && entry.drifted.length > 0 ? { drifted: entry.drifted } : {}),
      // BONUS (#2458 got-field gap): version detected on failed agent.
      ...(entry.got !== undefined ? { got: entry.got } : {}),
      // Update-apply deferral result (#2458) — only on update_apply rows.
      ...(entry.deferred ? { deferred: entry.deferred } : {}),
      // Prior-pin capture (#2492) — only on completed rollout rows.
      ...(entry.prior_pin ? { prior_pin: entry.prior_pin } : {}),
    });
  }

  /**
   * #2726 — handle one rollout PHASE transition parsed off the child's
   * stdout. Two effects, both fire-and-forget so a stall in either can NEVER
   * block or fail the roll:
   *   1. Persist a durable, hash-chained phase audit row (the single source of
   *      truth for rollout progress — `get_status` + the Part 2 narration
   *      surface both READ from here).
   *   2. Feed the narration renderer (Part 2), if one is attached, so the
   *      in-chat message edits through the phases. The renderer PULLS from what
   *      it's fed; it holds no lifecycle state that a gateway restart could
   *      orphan (recovery = re-read the log).
   */
  private onRolloutPhase(entry: StatusEntry, phase: RolloutPhase): void {
    // Record the live phase on the in-memory entry so an in-flight get_status
    // shows the current phase, not a bare "started" (#2726 point 2).
    entry.current_phase = phase.phase;
    entry.phase_n = phase.n;
    entry.phase_m = phase.m;
    entry.phase_agent = phase.agent;
    void this.writePhaseAudit(entry, phase);
    // Part 2 hook — attached only when a narration renderer is wired. Kept as
    // an optional member so Part 1 is mergeable alone (no renderer → no-op).
    // Defensively wrapped: a throwing narrator must not break the stdout tap
    // (and thus lose subsequent durable phase rows).
    try {
      this.rolloutNarrator?.onPhase(entry, phase);
    } catch (e) {
      process.stderr.write(
        `hostd: rollout narrator onPhase threw (non-fatal): ${(e as Error).message}\n`,
      );
    }
  }

  /**
   * Durable per-phase audit row for an in-flight rollout (#2726). Distinct
   * from {@link writeTerminalAudit}: `phase` here is the transition name
   * ("apply", "canary-start", …) rather than the literal "terminal" the
   * hostd terminal row uses — so a phase row is lexically incapable of being
   * mistaken for the terminal sentinel by any reader keyed on
   * `phase === "terminal"`. Carries `request_id` + `pin` on every row per the
   * observability contract, plus the roll-order `n`/`m` and `agent` when the
   * phase supplies them. Best-effort: `appendAuditRow` swallows write errors,
   * so this never throws into the stdout-tap that calls it.
   */
  private async writePhaseAudit(
    entry: StatusEntry,
    phase: RolloutPhase,
  ): Promise<void> {
    await this.appendAuditRow({
      ts: new Date().toISOString(),
      op: entry.op,
      // The transition name — NEVER the string "terminal". Terminal-sentinel
      // readers key on phase==="terminal"; a phase row can never collide.
      phase: phase.phase,
      caller:
        entry.caller.kind === "agent"
          ? { kind: "agent", name: entry.caller.name }
          : { kind: "operator" },
      request_id: entry.request_id,
      // In-flight: no exit code / final result yet. `result: "started"` marks
      // it as an in-progress row, disjoint from the terminal row's
      // completed/error.
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - entry.started_at,
      // Observability contract: pin on every rollout row.
      ...(entry.pin ? { pin: entry.pin } : {}),
      // Roll-order + agent context when the phase supplies them.
      ...(phase.agent !== undefined ? { agent: phase.agent } : {}),
      ...(phase.n !== undefined ? { n: phase.n } : {}),
      ...(phase.m !== undefined ? { m: phase.m } : {}),
    });
  }

  /**
   * Spawn the host switchroom CLI and capture stdout/stderr. An
   *  optional `extraEnv` is merged onto the inherited env — used by the
   *  rollout path to flip the in-container `SWITCHROOM_HOSTD_CONTEXT`
   *  sentinel (#2487). */
  private runSwitchroom(
    args: string[],
    extraEnv?: Record<string, string>,
    /**
     * Optional line-oriented stdout tap (#2726). Invoked once per COMPLETE
     * stdout line (newline-delimited) as the child emits it — used by
     * `spawnRollout` to persist each rollout phase sentinel to the durable
     * audit log AS the roll progresses, not after it exits. The full buffered
     * stdout is still returned on close (for the terminal sentinel parse), so
     * this tap is purely additive. Never throws into the child pipe: a callback
     * that throws is caught and logged so a persistence hiccup can't kill the
     * roll.
     */
    onStdoutLine?: (line: string) => void,
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const bin = this.opts.switchroomBin ?? "switchroom";
      const child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(extraEnv ?? {}) },
      });
      let stdout = "";
      let stderr = "";
      // Line-buffer for the optional stdout tap. Only maintained when a tap is
      // wired — the common (untapped) path keeps the cheap buffer-only shape.
      let lineBuf = "";
      const drainLines = (flush: boolean): void => {
        if (!onStdoutLine) return;
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          try {
            onStdoutLine(line);
          } catch (e) {
            process.stderr.write(
              `hostd: rollout stdout-tap threw (non-fatal): ${(e as Error).message}\n`,
            );
          }
        }
        if (flush && lineBuf.length > 0) {
          const line = lineBuf;
          lineBuf = "";
          try {
            onStdoutLine(line);
          } catch (e) {
            process.stderr.write(
              `hostd: rollout stdout-tap threw (non-fatal): ${(e as Error).message}\n`,
            );
          }
        }
      };
      child.stdout.on("data", (d: Buffer) => {
        const s = d.toString("utf8");
        stdout += s;
        if (onStdoutLine) {
          lineBuf += s;
          drainLines(false);
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        drainLines(true);
        resolve({ exit_code: code ?? -1, stdout, stderr });
      });
    });
  }
}

function tail(s: string, bytes = TAIL_BYTES): string {
  if (Buffer.byteLength(s, "utf8") <= bytes) return s;
  return s.slice(s.length - bytes);
}

/** Max chars retained from a schedule entry's `prompt` in the bounded
 *  `agent_schedule` payload — the web only renders a preview. */
export const SCHEDULE_PROMPT_MAX_CHARS = 160;
/** Max chars retained from a fire's `outputSummary` in the bounded payload. */
export const SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS = 100;
/**
 * Max recent fires retained PER CRON (keyed by promptKey) in the bounded
 * payload. The dashboard renders each cron's OWN fire history, so fires are
 * bounded per-cron — a busy cron must not crowd a quiet one out of the
 * agent's window (the old per-agent cap did exactly that). The frame budget
 * below is the absolute backstop for an agent with pathologically many crons.
 */
export const SCHEDULE_MAX_FIRES_PER_CRON = 8;
/**
 * Hard ceiling on the bytes the `agent_schedule` payload contributes to the
 * response FRAME. The payload is JSON-encoded then embedded as a STRING in
 * the response, so its frame cost = `JSON.stringify(JSON.stringify(view))`
 * length (escaping accounted for exactly). We trim until that's under
 * `MAX_FRAME_BYTES` minus envelope headroom — so `encodeResponse` can never
 * throw "frame too large", even for a pathological fleet.
 */
export const SCHEDULE_FRAME_BUDGET_BYTES = MAX_FRAME_BYTES - 2048;

export interface BoundedScheduleView {
  entries: SchedulerEntry[];
  recentByAgent: Record<string, DispatchResult[]>;
  /** True when entries/fires were shed to fit the frame budget. */
  truncated?: boolean;
}

/**
 * Render-only projection of a SchedulerEntry. Keeps only the fields the
 * dashboard renders (+ the small cheap-cron routing scalars) and DROPS the
 * UNBOUNDED `poll` / `action` specs (a Telegram action's `text`, a webhook
 * body/headers/url have no schema max). Truncates the prompt. This is what
 * makes a single entry's encoded size bounded by the prompt cap, not by
 * arbitrary operator-authored spec content.
 */
function slimScheduleEntry(e: SchedulerEntry): SchedulerEntry {
  const slim: SchedulerEntry = {
    agent: e.agent,
    scheduleIndex: e.scheduleIndex,
    cron: e.cron,
    promptKey: e.promptKey,
  };
  // The cron's human title (overlay `# name:` header) — a small string,
  // and the per-cron block header the dashboard renders, so keep it.
  if (e.name !== undefined) slim.name = e.name;
  if (e.prompt !== undefined) {
    slim.prompt =
      e.prompt.length > SCHEDULE_PROMPT_MAX_CHARS
        ? e.prompt.slice(0, SCHEDULE_PROMPT_MAX_CHARS)
        : e.prompt;
  }
  if (e.kind !== undefined) slim.kind = e.kind;
  if (e.model !== undefined) slim.model = e.model;
  if (e.context !== undefined) slim.context = e.context;
  if (e.topic !== undefined) slim.topic = e.topic;
  // poll / action specs intentionally dropped — unbounded + unrendered.
  return slim;
}

/** Exact frame cost of a payload object: its JSON encoded, then re-encoded
 *  as the response's `payload` STRING field (so quote/backslash escaping is
 *  counted precisely — no 2× guesswork). */
function scheduleFrameBytes(view: BoundedScheduleView): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(view)), "utf8");
}

/**
 * Pure, frame-bounding shaper for the `agent_schedule` payload (extracted so
 * it can be unit-tested without a daemon). It (a) projects each entry to a
 * render-only slim shape (dropping the unbounded poll/action specs) with a
 * truncated prompt, (b) keeps only the LAST
 * {@link SCHEDULE_MAX_FIRES_PER_CRON} fires PER CRON (by promptKey, newest)
 * with each `outputSummary` truncated, and (c) enforces a HARD frame budget: if the
 * payload would still exceed {@link SCHEDULE_FRAME_BUDGET_BYTES} (a
 * pathological fleet — hundreds of entries), it sheds the least-essential
 * data first (all fires, then entries from the tail) until it fits, setting
 * `truncated`. This guarantees the response frame can never overflow
 * `MAX_FRAME_BYTES`. Returns NEW objects — never mutates the inputs.
 */
export function boundScheduleView(
  entries: SchedulerEntry[],
  recentByAgent: Record<string, DispatchResult[]>,
): BoundedScheduleView {
  const slimEntries = entries.map(slimScheduleEntry);
  const truncSummary = (r: DispatchResult): DispatchResult =>
    typeof r.outputSummary === "string" &&
    r.outputSummary.length > SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS
      ? { ...r, outputSummary: r.outputSummary.slice(0, SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS) }
      : { ...r };
  // The promptKeys of the CURRENT crons, per agent. Fires whose promptKey
  // isn't a current cron are dropped — they're obsolete (a cron's prompt was
  // edited → new key) and the dashboard, which matches fires to a cron by
  // promptKey, would never render them anyway. Critically this also BOUNDS
  // the payload to (current crons × N): a long-lived agent accumulates fires
  // for many obsolete keys (e.g. 21 keys / 2638 fires), and keeping 8 of EACH
  // blew the frame budget → the trim shed ALL fires. Bounding to current crons
  // keeps it small.
  const currentKeysByAgent = new Map<string, Set<string>>();
  for (const e of entries) {
    let s = currentKeysByAgent.get(e.agent);
    if (!s) { s = new Set<string>(); currentKeysByAgent.set(e.agent, s); }
    s.add(e.promptKey);
  }
  const boundedRecent: Record<string, DispatchResult[]> = {};
  for (const [agent, rows] of Object.entries(recentByAgent)) {
    const currentKeys = currentKeysByAgent.get(agent) ?? new Set<string>();
    // Bound fires PER CRON (promptKey), not per agent — the dashboard renders
    // each cron's own fire history, so keep the last N of EACH current cron.
    // Group preserving input (chronological) order, keep the newest N per key.
    const byKey = new Map<string, DispatchResult[]>();
    for (const r of rows) {
      if (!currentKeys.has(r.promptKey)) continue; // drop obsolete-cron fires
      const arr = byKey.get(r.promptKey);
      if (arr) arr.push(r);
      else byKey.set(r.promptKey, [r]);
    }
    const kept: DispatchResult[] = [];
    for (const arr of byKey.values()) {
      for (const r of arr.slice(-SCHEDULE_MAX_FIRES_PER_CRON)) kept.push(truncSummary(r));
    }
    if (kept.length > 0) boundedRecent[agent] = kept;
  }

  let view: BoundedScheduleView = { entries: slimEntries, recentByAgent: boundedRecent };
  if (scheduleFrameBytes(view) <= SCHEDULE_FRAME_BUDGET_BYTES) return view;

  // Over budget. Shed fires first (supplementary), then trim entries from
  // the tail until it fits. Entries are the point; fires are a bonus.
  view = { entries: slimEntries, recentByAgent: {}, truncated: true };
  while (scheduleFrameBytes(view) > SCHEDULE_FRAME_BUDGET_BYTES && view.entries.length > 1) {
    const keep = Math.max(1, Math.floor(view.entries.length * 0.8));
    view = { entries: view.entries.slice(0, keep), recentByAgent: {}, truncated: true };
  }
  return view;
}

/**
 * argv[0] commands the daemon will run via `docker exec` against a
 * peer container without an approval-kernel grant. Curated to a small
 * set of obviously-side-effect-free POSIX inspection tools. Anything
 * that writes, mounts, kills, reboots, or modifies the network stack
 * stays off this list.
 *
 * **Trust model.** Admin-flagged agents can already restart any peer
 * (`agent_restart`), stop any peer (`agent_stop`), and recreate every
 * container in the fleet (`update_apply`). Granting them peer-container
 * READ via this allowlist is consistent with that posture: admin: true
 * is the operator's standing proxy. The CLAUDE.md "Admin surface"
 * block calls this out explicitly: "treat these like a root shell on
 * the host." Operators who want stricter posture should not flag any
 * agent admin: true at all.
 *
 * **What's reachable via `cat` / `env`.** Inside a peer container, an
 * allowlisted `cat /state/agent/telegram/.env` reveals the peer's bot
 * token; `cat /state/agent/.claude/credentials.json` reveals its
 * Claude OAuth refresh token. Both are credential-equivalent to root
 * over that peer. This is the deliberate trade-off — without read
 * access, "the peer is wedged" debugging requires shelling onto the
 * host, defeating the point of the admin surface. Operators who want
 * mutation gating beyond restart/stop should layer the
 * `host_os.exec` approval-kernel scope (deferred follow-up).
 *
 * Rationale for an allowlist over a blocklist: legible, auditable,
 * and forces a deliberate add when a new inspection tool is needed.
 */
export const READONLY_EXEC_ALLOWLIST = [
  "cat",
  "df",
  "du",
  // `env` deliberately omitted. A single `env` call dumps the entire
  // process environment (bot tokens, vault keys, etc.) into the 4 KiB
  // response tail — a no-friction secret-exfil gadget for a prompt-
  // injected admin agent. Equivalent forensic data is reachable via
  // `cat /proc/self/environ` (or `/proc/<pid>/environ` for tini's
  // child), which is one extra step a reviewer can spot in the
  // audit log. (Reviewer note on PR #1215.)
  "free",
  "grep",
  "head",
  "hostname",
  "id",
  "ls",
  "ps",
  "pwd",
  "stat",
  "tail",
  "uname",
  "uptime",
  "wc",
  "whoami",
] as const;

export function isAllowlistedReadOnlyArgv(argv0: string): boolean {
  return (READONLY_EXEC_ALLOWLIST as readonly string[]).includes(argv0);
}

/**
 * Upper bound on a single argv element. A read-only inspection
 * command's longest legitimate element is a path or a grep pattern —
 * 4 KiB is already absurdly generous for either. The cap stops a
 * post-approval admin agent padding the audit row / docker arg vector
 * with a multi-megabyte element.
 */
export const MAX_EXEC_ARGV_ELEMENT_BYTES = 4096;

/**
 * #1401 / #1400 target 3 — completes the WS5 per-element charclass
 * finding. Every argv element must be free of ALL C0 control bytes
 * (U+0000–U+001F) and DEL (U+007F), and must not exceed
 * {@link MAX_EXEC_ARGV_ELEMENT_BYTES}.
 *
 * #1401 already rejected NUL/LF/CR (audit-log line injection +
 * pre-`--` docker-flag confusion). The residual the WS5 audit flagged
 * is the *other* C0 controls — ESC (U+001B), backspace, the SGR /
 * cursor introducers — which have no place in a path, a `-n`-style
 * flag, or a grep pattern, but DO let a prompt-injected admin agent
 * smuggle ANSI escape sequences into the operator-facing
 * `switchroom audit hostd` trail (terminal / log spoofing). argv[0]
 * is separately allowlist-gated by isAllowlistedReadOnlyArgv; the
 * cross-agent credential-read residual is the explicitly-accepted
 * admin-surface trade-off whose sanctioned fix is the deferred
 * `host_os.exec` approval-kernel scope, not this charclass.
 */
export function isSafeExecArgvElement(s: string): boolean {
  if (Buffer.byteLength(s, "utf8") > MAX_EXEC_ARGV_ELEMENT_BYTES) return false;
  return !/[\u0000-\u001f\u007f]/.test(s);
}

// Exported for symmetry with src/vault/broker — most callers use the
// class methods, but tests + cli wrappers reach in.
export { readdirSync };
export { randomUUID };
