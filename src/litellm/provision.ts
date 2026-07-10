/**
 * Thin LiteLLM admin-API client for per-agent virtual-key provisioning.
 *
 * Pure HTTP + small types — no vault, no fs, no config. The caller
 * (`src/cli/apply.ts`) owns idempotency at the vault level (it checks the
 * vault for an existing `litellm/<agent>/api-key` before calling here) and
 * owns secret storage + ACL grants. Keeping this module side-effect-free
 * makes it unit-testable with a mocked `fetchFn`.
 *
 * The operations:
 *   - ensureTeam: create the "switchroom" LiteLLM team (idempotent — an
 *     "already exists" response is treated as success).
 *   - ensureKey: generate a per-agent virtual key under the team. Self-heals an
 *     ORPHANED key alias: LiteLLM enforces unique key aliases (upstream
 *     issue #9730), so if a prior apply generated the alias but crashed before
 *     the vault write landed, the alias lives in LiteLLM with no recoverable key
 *     — every later /key/generate then hard-fails with 400 "Key with alias ...
 *     already exists". ensureKey recovers by deleting the orphan and regenerating.
 *   - validateKey: probe a stored virtual key against the proxy (GET /key/info)
 *     to detect DB drift (proxy DB reset / restore without the vault).
 *
 * LiteLLM admin API reference (v1.91 shapes): POST {base}/team/new,
 * POST {base}/key/generate, GET {base}/key/info?key=..., GET {base}/key/list,
 * POST {base}/key/delete — authenticated with the master key as a Bearer token.
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
  /**
   * Optional structured logger for the orphaned-alias self-heal path (delete +
   * regenerate). Defaults to a no-op — the module stays quiet on the happy path.
   */
  log?: (msg: string) => void;
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
 * Heuristic: does a /key/info error response mean "the proxy does not recognize
 * this virtual key" (DB drift) — as opposed to a bad master key or a transient
 * server error? Only a clear not-found semantic counts, so we never
 * destructively re-provision on an ambiguous failure (a bare 401/403 from a
 * bad master key, a 5xx blip, a non-drift 400). LiteLLM has surfaced an
 * unknown key as a 400 "not found in DB" across versions, and its auth path
 * can report it as a 401 "Authentication Error: Key not found" — so 401/403
 * count ONLY when the body carries the not-found semantic; a bare 401/403
 * stays ambiguous (→ `unreachable`: skip, warn, keep the stored key).
 */
function looksLikeUnknownKey(status: number, body: string): boolean {
  if (status !== 400 && status !== 401 && status !== 403 && status !== 404) return false;
  const t = body.toLowerCase();
  return (
    t.includes("not found") ||
    t.includes("does not exist") ||
    t.includes("no such key") ||
    t.includes("no key found")
  );
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

/** Internal outcome of a single /key/generate POST. */
type GenerateOutcome =
  | { kind: "ok"; key: string }
  | { kind: "duplicate-alias"; status: number; body: string }
  | { kind: "error"; error: LiteLLMProvisionError };

/** Perform one /key/generate POST and classify the result. */
async function generateKeyOnce(opts: EnsureKeyOpts, fetchFn: FetchFn): Promise<GenerateOutcome> {
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
    return {
      kind: "error",
      error: new LiteLLMProvisionError(
        `LiteLLM /key/generate request failed: ${(err as Error).message}`,
      ),
    };
  }
  if (!resp.ok) {
    const body = await safeText(resp);
    // A duplicate key alias is recoverable (orphaned-alias self-heal) — signal
    // it distinctly rather than as a generic error.
    if (looksLikeAlreadyExists(resp.status, body)) {
      return { kind: "duplicate-alias", status: resp.status, body };
    }
    return {
      kind: "error",
      error: new LiteLLMProvisionError(
        `LiteLLM /key/generate returned ${resp.status}`,
        resp.status,
        body,
      ),
    };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    return {
      kind: "error",
      error: new LiteLLMProvisionError(
        `LiteLLM /key/generate returned non-JSON body: ${(err as Error).message}`,
        resp.status,
      ),
    };
  }

  const key = (json as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || key.length === 0) {
    return {
      kind: "error",
      error: new LiteLLMProvisionError(
        `LiteLLM /key/generate response missing a "key" field`,
        resp.status,
        JSON.stringify(json),
      ),
    };
  }
  return { kind: "ok", key };
}

/**
 * Resolve the hashed token(s) LiteLLM stores for a given key_alias, best-effort.
 * Used only to enrich the /key/delete during orphaned-alias recovery — the
 * delete also passes `key_aliases`, so an empty result here is non-fatal.
 *
 * GET /key/list?key_alias=<alias>&return_full_object=true returns
 * `{ keys: [ { token, key_alias, ... } | "<token>" ], ... }` across v1.91 shapes.
 */
async function resolveTokensForAlias(
  baseUrl: string,
  masterKey: string,
  alias: string,
  fetchFn: FetchFn,
): Promise<string[]> {
  const url =
    `${normalizeBase(baseUrl)}/key/list?key_alias=${encodeURIComponent(alias)}` +
    `&return_full_object=true&include_team_keys=true`;
  let resp: Response;
  try {
    resp = await fetchFn(url, { method: "GET", headers: authHeaders(masterKey) });
  } catch {
    return [];
  }
  if (!resp.ok) return [];
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return [];
  }
  const keys = (json as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  const tokens: string[] = [];
  for (const k of keys) {
    if (typeof k === "string" && k.length > 0) tokens.push(k);
    else if (k && typeof k === "object") {
      const tok = (k as { token?: unknown; key?: unknown }).token;
      const raw = (k as { token?: unknown; key?: unknown }).key;
      if (typeof tok === "string" && tok.length > 0) tokens.push(tok);
      else if (typeof raw === "string" && raw.length > 0) tokens.push(raw);
    }
  }
  return tokens;
}

/**
 * Delete the orphaned key(s) for a given alias so a fresh key can be generated.
 * Deletes by `key_aliases` (unambiguous — LiteLLM matches the alias directly)
 * and, when resolvable, also by the hashed `keys` tokens for good measure.
 * Throws a LiteLLMProvisionError naming the MANUAL remediation on failure.
 */
async function deleteOrphanedAlias(
  opts: EnsureKeyOpts,
  fetchFn: FetchFn,
  log: (msg: string) => void,
): Promise<void> {
  const tokens = await resolveTokensForAlias(opts.baseUrl, opts.masterKey, opts.alias, fetchFn);
  const body: Record<string, unknown> = { key_aliases: [opts.alias] };
  if (tokens.length > 0) body.keys = tokens;

  const manual =
    `Manual remediation: delete the key with alias '${opts.alias}' in the LiteLLM ` +
    `admin UI, or run ` +
    `\`curl -X POST "${normalizeBase(opts.baseUrl)}/key/delete" -H "Authorization: Bearer <master-key>" ` +
    `-H "content-type: application/json" -d '{"key_aliases":["${opts.alias}"]}'\`, ` +
    `then re-run \`switchroom apply\`.`;

  const url = `${normalizeBase(opts.baseUrl)}/key/delete`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: authHeaders(opts.masterKey),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LiteLLMProvisionError(
      `LiteLLM /key/delete request failed while recovering orphaned alias ` +
        `'${opts.alias}': ${(err as Error).message}. ${manual}`,
    );
  }
  if (!resp.ok) {
    const errBody = await safeText(resp);
    throw new LiteLLMProvisionError(
      `LiteLLM /key/delete returned ${resp.status} while recovering orphaned ` +
        `alias '${opts.alias}'. ${manual}`,
      resp.status,
      errBody,
    );
  }
  log(
    `litellm: deleted orphaned key(s) for alias '${opts.alias}'` +
      (tokens.length > 0 ? ` (${tokens.length} token(s) resolved)` : "") +
      ` — regenerating`,
  );
}

/**
 * Generate a per-agent virtual key under the given team. Returns the new
 * key string. Idempotency at the vault level is the caller's responsibility
 * (it checks the vault first) — this always asks LiteLLM to generate a key.
 *
 * Self-heals an ORPHANED alias: if /key/generate reports the alias already
 * exists (the vault lost the previously-generated key), the orphan is deleted
 * and generation retried once. A second duplicate report, or a failed delete,
 * throws a LiteLLMProvisionError naming the manual remediation.
 */
export async function ensureKey(opts: EnsureKeyOpts, fetchFn: FetchFn = fetch): Promise<EnsureKeyResult> {
  const log = opts.log ?? (() => {});

  const first = await generateKeyOnce(opts, fetchFn);
  if (first.kind === "ok") return { key: first.key };
  if (first.kind === "error") throw first.error;

  // first.kind === "duplicate-alias": recover the orphan and regenerate once.
  log(
    `litellm: key_alias '${opts.alias}' already exists in LiteLLM but the vault ` +
      `has no recoverable key (orphaned by a prior failed provision) — ` +
      `self-healing: deleting the orphan and regenerating`,
  );
  await deleteOrphanedAlias(opts, fetchFn, log);

  const second = await generateKeyOnce(opts, fetchFn);
  if (second.kind === "ok") {
    log(`litellm: regenerated key for alias '${opts.alias}' after orphan recovery`);
    return { key: second.key };
  }
  if (second.kind === "duplicate-alias") {
    throw new LiteLLMProvisionError(
      `LiteLLM /key/generate still reports alias '${opts.alias}' already exists ` +
        `after deleting the orphan — the delete did not take effect. Manual ` +
        `remediation: remove the key with alias '${opts.alias}' via the LiteLLM ` +
        `admin UI (or POST /key/delete {"key_aliases":["${opts.alias}"]}) then ` +
        `re-run \`switchroom apply\`.`,
      second.status,
      second.body,
    );
  }
  throw second.error;
}

/** Options for `validateKey`. */
export interface ValidateKeyOpts {
  baseUrl: string;
  masterKey: string;
  /** The stored virtual key string to probe. */
  key: string;
}

/**
 * Outcome of validating a stored virtual key against the proxy:
 *   - `valid`: the proxy recognizes the key — nothing to do.
 *   - `unknown`: the proxy is reachable but does NOT recognize the key (DB
 *     drift) — the caller should re-provision.
 *   - `unreachable`: could not verify (network error, bad master key, 5xx) —
 *     the caller should SKIP validation with a warning and keep the stored key.
 *       Never triggers a destructive re-provision.
 */
export type ValidateKeyResult =
  | { kind: "valid" }
  | { kind: "unknown" }
  | { kind: "unreachable"; detail: string };

/**
 * Probe a stored virtual key against the proxy via GET /key/info. Used by the
 * apply path to detect DB drift (proxy DB reset/restored without the vault) so
 * a stale vault key can be re-provisioned instead of silently 401ing every
 * agent request. Availability-safe: any ambiguous failure degrades to
 * `unreachable` (skip), never to a destructive re-provision.
 */
export async function validateKey(
  opts: ValidateKeyOpts,
  fetchFn: FetchFn = fetch,
): Promise<ValidateKeyResult> {
  const url = `${normalizeBase(opts.baseUrl)}/key/info?key=${encodeURIComponent(opts.key)}`;
  let resp: Response;
  try {
    resp = await fetchFn(url, { method: "GET", headers: authHeaders(opts.masterKey) });
  } catch (err) {
    return { kind: "unreachable", detail: (err as Error).message };
  }
  if (resp.ok) return { kind: "valid" };
  const body = await safeText(resp);
  if (looksLikeUnknownKey(resp.status, body)) return { kind: "unknown" };
  // Bare 401/403 (bad master key, no not-found semantic), 5xx, or any other
  // ambiguous error — do NOT re-provision; keep the stored key and warn.
  return { kind: "unreachable", detail: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
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
