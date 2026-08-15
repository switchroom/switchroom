/**
 * Persisted host capabilities (voice feature PR-B1).
 *
 * The GPU/voice-engine verdict (`src/setup/gpu-detect.ts`) is computed once
 * at setup and written here so later phases — `update`, `doctor`, and the
 * compose generator that emits (or doesn't) the voice sidecar in PR-B2 —
 * can re-read the decision without re-probing `nvidia-smi`/`docker` on
 * every boot.
 *
 * No existing host-state JSON file fit (the closest precedent,
 * `~/.switchroom/user.json` written by `onboarding.ts:saveUserConfig`, is
 * Telegram identity, not host hardware), so this adds a small
 * `~/.switchroom/host-capabilities.json` writer in the same shape +
 * convention: `resolveStatePath`, mode 0600, JSON with a trailing newline.
 *
 * On-disk shape (versioned for forward-compat):
 *
 *   {
 *     "version": 1,
 *     "voice": {
 *       "gpuPresent": false,
 *       "containerToolkit": false,
 *       "engine": "cloud",
 *       "detectedAt": "2026-06-30T12:34:56.789Z"
 *     }
 *   }
 *
 * `engine` is the derived verdict; the raw `gpuPresent`/`containerToolkit`
 * booleans are persisted alongside so a reader can explain WHY without
 * re-deriving. `detectedAt` is an ISO-8601 timestamp so a stale verdict
 * (e.g. a GPU added after install) is visible.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveStatePath } from "../config/paths.js";
import type { GpuCapabilities, VoiceEngine } from "./gpu-detect.js";

/** Current on-disk schema version. Bump when the shape changes. */
export const HOST_CAPABILITIES_VERSION = 1;

/** The persisted voice-engine verdict (raw booleans + derived engine + timestamp). */
export interface PersistedVoiceCapability {
  gpuPresent: boolean;
  containerToolkit: boolean;
  engine: VoiceEngine;
  /** ISO-8601 timestamp of when the verdict was computed. */
  detectedAt: string;
}

/** The full `host-capabilities.json` document. */
export interface HostCapabilities {
  version: number;
  voice: PersistedVoiceCapability;
}

/** Absolute path to the persisted host-capabilities file. */
export function hostCapabilitiesPath(): string {
  return resolveStatePath("host-capabilities.json");
}

/**
 * Persist the voice-engine verdict to `~/.switchroom/host-capabilities.json`.
 *
 * Writes the raw probe booleans, the derived `engine`, and a fresh
 * `detectedAt` timestamp. `now` is injectable for deterministic tests.
 * Returns the document that was written.
 */
export function saveVoiceCapability(
  caps: GpuCapabilities,
  now: () => Date = () => new Date(),
): HostCapabilities {
  const doc: HostCapabilities = {
    version: HOST_CAPABILITIES_VERSION,
    voice: {
      gpuPresent: caps.gpuPresent,
      containerToolkit: caps.containerToolkit,
      engine: caps.engine,
      detectedAt: now().toISOString(),
    },
  };

  const path = hostCapabilitiesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  return doc;
}

/**
 * How the verdict file read went.
 *
 * `absent` and the three failure states used to be the SAME value (`null`) —
 * that conflation is the 2026-07-28 GPU regression. A capabilities file the
 * process cannot READ is indistinguishable from "this host has no GPU", so
 * every capability gate downstream (`hindsightGpuEnabled`, the compose voice
 * sidecar, the GPU-gated hindsight perf defaults) evaluated false and nothing
 * anywhere said why. Two real triggers, both hit in production:
 *
 *   - the file was written `root:root 0600` into a uid-1000 home, so any
 *     non-root run got `EACCES`;
 *   - `resolveStatePath` derives from `process.env.HOME ?? "/root"`, so a
 *     wrong/overridden HOME (sudo, a container) pointed at a path that does
 *     not exist.
 *
 * The second one is genuinely indistinguishable from a fresh install at this
 * layer, so it stays quiet. The FIRST one is not: the file is there and we
 * were denied. That must be loud.
 */
export type HostCapabilitiesReadStatus =
  /** Parsed and shape-checked. `caps` is non-null. */
  | "ok"
  /** `ENOENT` — never probed, or the wrong HOME. Legitimate; stay quiet. */
  | "absent"
  /** The file exists but could not be read (`EACCES`/`EPERM`/`EISDIR`/…). */
  | "unreadable"
  /** Read fine, but the bytes are not a valid capabilities document. */
  | "malformed";

/** The outcome of {@link readHostCapabilities} — never collapses to null. */
export interface HostCapabilitiesRead {
  status: HostCapabilitiesReadStatus;
  /** The path that was attempted, for messages the operator can act on. */
  path: string;
  /** The document, iff `status === "ok"`. */
  caps: HostCapabilities | null;
  /** Node errno for `unreadable` (e.g. `EACCES`), when one was available. */
  code?: string;
  /** One-line human explanation. Empty string for `ok` / `absent`. */
  detail: string;
}

/** True when the file is present but switchroom could not use it. */
export function isDegradedHostCapabilitiesRead(read: HostCapabilitiesRead): boolean {
  return read.status === "unreadable" || read.status === "malformed";
}

/**
 * Read the persisted host-capabilities document, reporting HOW the read went.
 *
 * This is the honest primitive; {@link loadHostCapabilities} is the lossy
 * back-compat wrapper over it. Callers that gate real behaviour on the verdict
 * (GPU passthrough, the GPU-gated perf defaults) must use THIS one so they can
 * tell "no GPU" from "could not tell".
 */
export function readHostCapabilities(): HostCapabilitiesRead {
  const path = hostCapabilitiesPath();

  // No `existsSync` pre-check: it cannot distinguish the cases we care about
  // (an unreadable file still "exists") and it adds a TOCTOU window. Let the
  // read itself report the errno.
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT ONLY. Every other errno — EACCES, EPERM, EISDIR, ENOTDIR — means
    // something IS at (or in the way of) that path and the read was stopped,
    // which is a different fact from "never probed" and must not be filed
    // under it. Filing it under it is precisely the original bug.
    if (code === "ENOENT") {
      return { status: "absent", path, caps: null, code, detail: "" };
    }
    return {
      status: "unreadable",
      path,
      caps: null,
      code,
      detail: `${code ?? "read failed"}: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      status: "malformed",
      path,
      caps: null,
      detail: `invalid JSON: ${(err as Error).message}`,
    };
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "voice" in parsed &&
    typeof (parsed as HostCapabilities).voice === "object" &&
    (parsed as HostCapabilities).voice !== null
  ) {
    return { status: "ok", path, caps: parsed as HostCapabilities, detail: "" };
  }
  return {
    status: "malformed",
    path,
    caps: null,
    detail: "document has no `voice` object — not a host-capabilities file",
  };
}

/**
 * Keyed by `<path>|<status>` so the warning fires once per process per
 * distinct problem (production: once), while a test that points HOME at a
 * fresh tmpdir still gets its own warning. {@link resetHostCapabilitiesWarnings}
 * exists for suites that assert the once-ness itself.
 */
const _warnedReads = new Set<string>();

/** @internal test seam — clears the warn-once memo. */
export function resetHostCapabilitiesWarnings(): void {
  _warnedReads.clear();
}

/**
 * Emit the one-time stderr WARN for a degraded read. Returns true if it wrote.
 *
 * stderr is the floor, not the ceiling: any command whose BEHAVIOUR changes
 * because of the degraded read (`switchroom memory setup --recreate`) must
 * also surface it on its own output — see `src/cli/memory.ts`. This exists so
 * the quieter callers (compose generation, singleton reconcile, the voice
 * sidecar token) are not silent either.
 */
export function warnDegradedHostCapabilities(read: HostCapabilitiesRead): boolean {
  if (!isDegradedHostCapabilitiesRead(read)) return false;
  const memo = `${read.path}|${read.status}`;
  if (_warnedReads.has(memo)) return false;
  _warnedReads.add(memo);
  process.stderr.write(
    `[switchroom] WARNING: host capabilities file is present but ${read.status} ` +
      `(${read.path}) — ${read.detail}\n` +
      "  GPU-gated features (hindsight `--gpus all`, the GPU perf defaults, the " +
      "local voice engine) are being treated as UNAVAILABLE because switchroom " +
      "cannot read the verdict, NOT because this host lacks a GPU.\n" +
      `  Fix: chown/chmod the file so this user can read it ` +
      `(\`sudo chown $(id -u):$(id -g) ${read.path} && chmod 600 ${read.path}\`), ` +
      "re-run `switchroom setup` to re-probe, or force the answer with " +
      "`hindsight.gpu: true` in switchroom.yaml.\n",
  );
  return true;
}

/**
 * Load the persisted host-capabilities document, or null if it doesn't
 * exist / is unreadable / is malformed. A missing file is not an error —
 * callers (compose-gen, doctor) degrade by re-detecting or skipping.
 *
 * Lossy by signature: prefer {@link readHostCapabilities} anywhere the null
 * would silently become a behaviour change. A degraded read still emits the
 * one-time stderr warning via {@link warnDegradedHostCapabilities}, so no
 * caller of this function can fail silently either.
 */
export function loadHostCapabilities(): HostCapabilities | null {
  const read = readHostCapabilities();
  warnDegradedHostCapabilities(read);
  return read.caps;
}

/** Why {@link resolveVoiceEngine} answered the way it did. */
export type VoiceEngineReason =
  /** A readable verdict file said so — the only NON-default answer. */
  | "verdict"
  /** `ENOENT` — never probed, or the wrong HOME. Defaulted to `cloud`. */
  | "no-verdict"
  /** Present but unreadable (`EACCES`/…). Defaulted to `cloud`. */
  | "unreadable"
  /** Present but not a capabilities document. Defaulted to `cloud`. */
  | "malformed";

/** The voice-engine verdict plus HOW it was reached. */
export interface VoiceEngineResolution {
  engine: VoiceEngine;
  reason: VoiceEngineReason;
  /** The verdict path that was attempted, for operator-actionable messages. */
  path: string;
  /** One-line human explanation. Empty for `verdict` / `no-verdict`. */
  detail: string;
}

/** True when the engine was DEFAULTED rather than read from a verdict. */
export function isDefaultedVoiceEngine(r: VoiceEngineResolution): boolean {
  return r.reason !== "verdict";
}

/**
 * Resolve the voice engine, reporting whether it came from a verdict or from
 * the fail-safe default.
 *
 * Callers used to do `loadHostCapabilities()?.voice.engine ?? "cloud"`, which
 * is exactly the collapse {@link loadHostCapabilities}'s own docstring warns
 * against: it cannot tell "this host has no GPU" from "we could not tell", and
 * for the voice sidecar that difference is a service being REMOVED from the
 * generated compose. `absent` stays quiet at the reader layer by design (a
 * fresh install is indistinguishable from a wrong HOME there) — so the reason
 * is returned instead, and the one call site where a default is destructive
 * (dropping an already-emitted `voice-sidecar`) attributes it. See
 * `computeComposeContent`.
 */
export function resolveVoiceEngine(): VoiceEngineResolution {
  const read = readHostCapabilities();
  warnDegradedHostCapabilities(read);
  if (read.status === "ok" && read.caps) {
    return {
      engine: read.caps.voice.engine,
      reason: "verdict",
      path: read.path,
      detail: "",
    };
  }
  // `ok` with a null `caps` violates HostCapabilitiesRead's own contract, so
  // it is not a real state — fold it in with `malformed`: either way the
  // document could not be used and the engine below is a DEFAULT, not a read.
  const reason: VoiceEngineReason =
    read.status === "absent"
      ? "no-verdict"
      : read.status === "unreadable"
        ? "unreadable"
        : "malformed";
  return { engine: "cloud", reason, path: read.path, detail: read.detail };
}
