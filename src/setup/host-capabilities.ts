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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Load the persisted host-capabilities document, or null if it doesn't
 * exist / is unreadable / is malformed. A missing or corrupt file is not
 * an error — callers (PR-B2 compose-gen, doctor) degrade by re-detecting
 * or skipping.
 */
export function loadHostCapabilities(): HostCapabilities | null {
  const path = hostCapabilitiesPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "voice" in parsed &&
      typeof (parsed as HostCapabilities).voice === "object"
    ) {
      return parsed as HostCapabilities;
    }
    return null;
  } catch {
    return null;
  }
}
