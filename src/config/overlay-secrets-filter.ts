/**
 * Overlay secrets-rejection filter (switchroom #1163, Phase E).
 *
 * Security gate: agent-authored overlay writes that declare a non-empty
 * `secrets:` list are REJECTED — not silently stripped — so an agent
 * cannot self-grant access to vault keys by simply scheduling a cron job
 * that names them. Operator-authored `switchroom.yaml` entries pass
 * through untouched; this filter ONLY fires when `source === "overlay"`.
 *
 * Decision points (do not relitigate without operator sign-off):
 *   - Reject vs strip: reject. Silent strip is a footgun — the agent
 *     thinks the job will have key X, the job runs and broker-denies,
 *     the agent gets confused. Loud reject with a structured error code
 *     lets the next-PR approval-card flow plug in cleanly.
 *   - Empty `secrets: []` is allowed: an empty array is the schema
 *     default and not a privilege request. Treat it as if the field
 *     were omitted.
 */

import type { OverlayDoc } from "./overlay-schema.js";

export type FilterSource = "overlay" | "operator";

export interface OverlaySecretsRejection {
  code: "E_OVERLAY_SECRETS_REQUIRES_APPROVAL";
  message: string;
  /** Index in `doc.schedule` of the offending entry. */
  entry_index: number;
  /** The secrets list the entry requested. */
  requested_secrets: string[];
}

/**
 * Inspect an overlay document for self-grant attempts. Returns null
 * when the document is safe to write; returns a structured rejection
 * otherwise. Operator-source documents always pass through.
 */
export function filterOverlaySecrets(
  doc: OverlayDoc,
  source: FilterSource,
): OverlaySecretsRejection | null {
  if (source !== "overlay") return null;
  const entries = doc.schedule ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const secrets = entry.secrets ?? [];
    if (secrets.length > 0) {
      return {
        code: "E_OVERLAY_SECRETS_REQUIRES_APPROVAL",
        message:
          "Overlay schedule entry declares secrets — operator approval " +
          "required. The next-PR approval-card flow will let the operator " +
          "review and grant access; this PR rejects pending that wiring.",
        entry_index: i,
        requested_secrets: secrets,
      };
    }
  }
  return null;
}
