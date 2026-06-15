/**
 * Hindsight remediation TRIGGERS for the dashboard Memory tab.
 *
 * The operator's complaint: the Memory tab shows extraction gaps,
 * corrupted/stale mental models, and missing user-profile models, but
 * offers no way to FIX them — only a curl recipe in the doctor output.
 * These helpers turn each problem into a one-click POST to hindsight's
 * own REST/MCP surface.
 *
 * SUBSCRIPTION-HONEST (vision pillar 3): the web makes ZERO model calls.
 * Each helper is a thin HTTP poke at `127.0.0.1:18888` — hindsight does
 * the LLM work on ITS OWN claude-code provider
 * (`HINDSIGHT_API_LLM_PROVIDER=claude-code`). The POST returns the
 * moment hindsight ACCEPTS the job; we do NOT await the extraction to
 * finish. Exactly the shape of the existing direct quota-refresh button.
 *
 * No Anthropic API / SDK / `claude -p` is imported here. The only
 * outbound is `fetch` (injectable for tests).
 *
 * All functions are best-effort with a short timeout and NEVER throw —
 * the caller (web handlers) maps the result to a toast.
 */

import { hindsightRestBase } from "../memory/bank-health.js";
import { ensureUserProfileMentalModel } from "../memory/hindsight.js";

/** Re-export so callers can derive the REST base without reaching into bank-health. */
export function restBaseFromMcpUrl(mcpUrl: string): string {
  return hindsightRestBase(mcpUrl);
}

interface TriggerOpts {
  fetchImpl?: typeof fetch;
  /**
   * These calls only ENQUEUE work (the LLM runs async on hindsight's
   * side), so a short timeout is correct — we're waiting for the job to
   * be accepted, not for extraction to complete.
   */
  timeoutMs?: number;
}

/** POST a URL with a short timeout; never throws. Returns ok / a reason. */
async function postTrigger(
  url: string,
  opts?: TriggerOpts,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") return { ok: false, reason: "Timeout" };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}

/**
 * Reprocess (re-extract facts from) one or more stuck documents.
 *
 * `restBase` is the REST base (NOT the MCP url) — derive it via
 * `restBaseFromMcpUrl` first. Each docId is POSTed sequentially; a
 * single failure does not abort the rest. Counts ok vs failed. The
 * first failure's reason is surfaced. Never throws.
 */
export async function reprocessDocuments(
  restBase: string,
  bank: string,
  docIds: string[],
  opts?: TriggerOpts,
): Promise<{ triggered: number; failed: number; error?: string }> {
  let triggered = 0;
  let failed = 0;
  let error: string | undefined;
  const encodedBank = encodeURIComponent(bank);
  for (const docId of docIds) {
    const url = `${restBase}/v1/default/banks/${encodedBank}/documents/${encodeURIComponent(docId)}/reprocess`;
    const r = await postTrigger(url, opts);
    if (r.ok) {
      triggered += 1;
    } else {
      failed += 1;
      if (!error) error = r.reason;
    }
  }
  return error ? { triggered, failed, error } : { triggered, failed };
}

/**
 * Refresh (regenerate) one mental model — the fix for a corrupted or
 * stale model. `restBase` is the REST base. Never throws.
 */
export async function refreshMentalModel(
  restBase: string,
  bank: string,
  modelId: string,
  opts?: TriggerOpts,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${restBase}/v1/default/banks/${encodeURIComponent(bank)}/mental-models/${encodeURIComponent(modelId)}/refresh`;
  const r = await postTrigger(url, opts);
  return r.ok ? { ok: true } : { ok: false, error: r.reason };
}

/**
 * Build (create-if-missing) the user-profile mental model for a bank —
 * the "knows you" feature. Thin wrapper over the exported
 * `ensureUserProfileMentalModel`, which takes the MCP url (NOT the REST
 * base) and drives the create over JSON-RPC. Never throws.
 */
export async function buildUserProfile(
  mcpUrl: string,
  bank: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await ensureUserProfileMentalModel(mcpUrl, bank, {
      fetchImpl: opts?.fetchImpl,
      timeoutMs: opts?.timeoutMs,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.reason };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}
