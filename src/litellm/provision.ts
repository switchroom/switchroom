/**
 * Thin LiteLLM admin-API client for per-agent virtual-key provisioning.
 *
 * Pure HTTP + small types — no vault, no fs, no config. The caller
 * (`src/cli/apply.ts`) owns idempotency at the vault level (it checks the
 * vault for an existing `litellm/<agent>/api-key` before calling here) and
 * owns secret storage + ACL grants. Keeping this module side-effect-free
 * makes it unit-testable with a mocked `fetchFn`.
 *
 * The two operations:
 *   - ensureTeam: create the "switchroom" LiteLLM team (idempotent — an
 *     "already exists" response is treated as success).
 *   - ensureKey: generate a per-agent virtual key under the team.
 *
 * LiteLLM admin API reference: POST {base}/team/new, POST {base}/key/generate,
 * authenticated with the master key as a Bearer token.
 */

/**
 * Injectable fetch for testability. Just the call signature we use — NOT
 * `typeof fetch` (which carries runtime-specific extras like Bun's
 * `preconnect` that a test mock can't satisfy). Defaults to the global
 * `fetch`.
 */
export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

/** Raised when a LiteLLM admin-API call fails in a non-recoverable way. */
export class LiteLLMProvisionError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "LiteLLMProvisionError";
    this.status = status;
    this.body = body;
  }
}

/** Result of `ensureKey` — the freshly-generated virtual key string. */
export interface EnsureKeyResult {
  key: string;
}

export interface EnsureKeyOpts {
  baseUrl: string;
  masterKey: string;
  /** Stable key alias, e.g. "agent:clerk". */
  alias: string;
  /** Optional model allowlist for the key. Omit ⇒ team/all models. */
  models?: string[];
  /** Team alias the key is created under (e.g. "switchroom"). */
  team?: string;
  /** Arbitrary metadata tags attached to the key. */
  metadata?: Record<string, string>;
}

/** Normalize a base URL by stripping a trailing slash so path joins are clean. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function authHeaders(masterKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${masterKey}`,
  };
}

/**
 * Heuristic: does this error response indicate the resource already exists?
 * LiteLLM returns a 400-ish error with a message mentioning "already exists"
 * (the exact shape has varied across versions), so we match loosely on the
 * body text rather than a status code.
 */
function looksLikeAlreadyExists(status: number, body: string): boolean {
  const text = body.toLowerCase();
  if (text.includes("already exist")) return true;
  // Some versions surface a duplicate-team conflict as 409.
  if (status === 409) return true;
  return false;
}

/**
 * Create the LiteLLM team if it doesn't already exist. Idempotent: an
 * "already exists" response (or 409) is treated as success.
 */
export async function ensureTeam(
  baseUrl: string,
  masterKey: string,
  teamName: string,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const url = `${normalizeBase(baseUrl)}/team/new`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: authHeaders(masterKey),
      body: JSON.stringify({ team_alias: teamName }),
    });
  } catch (err) {
    throw new LiteLLMProvisionError(
      `LiteLLM /team/new request failed: ${(err as Error).message}`,
    );
  }
  if (resp.ok) return;
  const body = await safeText(resp);
  if (looksLikeAlreadyExists(resp.status, body)) return; // idempotent
  throw new LiteLLMProvisionError(
    `LiteLLM /team/new returned ${resp.status}`,
    resp.status,
    body,
  );
}

/**
 * Generate a per-agent virtual key under the given team. Returns the new
 * key string. Idempotency is the caller's responsibility (it checks the
 * vault first) — this always asks LiteLLM to generate a key.
 */
export async function ensureKey(opts: EnsureKeyOpts, fetchFn: FetchFn = fetch): Promise<EnsureKeyResult> {
  const url = `${normalizeBase(opts.baseUrl)}/key/generate`;
  const payload: Record<string, unknown> = {
    key_alias: opts.alias,
  };
  if (opts.models && opts.models.length > 0) payload.models = opts.models;
  if (opts.team) payload.team_alias = opts.team;
  if (opts.metadata && Object.keys(opts.metadata).length > 0) {
    payload.metadata = opts.metadata;
  }

  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: authHeaders(opts.masterKey),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new LiteLLMProvisionError(
      `LiteLLM /key/generate request failed: ${(err as Error).message}`,
    );
  }
  if (!resp.ok) {
    const body = await safeText(resp);
    throw new LiteLLMProvisionError(
      `LiteLLM /key/generate returned ${resp.status}`,
      resp.status,
      body,
    );
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    throw new LiteLLMProvisionError(
      `LiteLLM /key/generate returned non-JSON body: ${(err as Error).message}`,
      resp.status,
    );
  }

  const key = (json as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new LiteLLMProvisionError(
      `LiteLLM /key/generate response missing a "key" field`,
      resp.status,
      JSON.stringify(json),
    );
  }
  return { key };
}

/** Read a Response body as text, swallowing any read error (best-effort
 * for error-message enrichment). */
async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
