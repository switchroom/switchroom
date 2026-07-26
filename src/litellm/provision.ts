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
 *     "already exists" response is treated as success). Returns an
 *     `EnsureTeamResult`: `{kind:"bound", teamId}` (the UUID `/team/new` hands
 *     back, or resolved via `/team/list` on the already-exists path) so keys
 *     can be bound to the team, or `{kind:"unbound", reason}` carrying WHY no
 *     id could be resolved so the caller can degrade LOUDLY instead of
 *     silently binding nothing.
 *   - ensureKey: generate a per-agent virtual key under the team. Self-heals an
 *     ORPHANED key alias: LiteLLM enforces unique key aliases (upstream
 *     issue #9730), so if a prior apply generated the alias but crashed before
 *     the vault write landed, the alias lives in LiteLLM with no recoverable key
 *     — every later /key/generate then hard-fails with 400 "Key with alias ...
 *     already exists". ensureKey recovers by deleting the orphan and regenerating.
 *   - validateKey: probe a stored virtual key against the proxy (GET /key/info)
 *     to detect DB drift (proxy DB reset / restore without the vault) AND report
 *     the key's current `team_id` binding so a valid-but-unbound key can be
 *     re-bound on a steady-state re-apply.
 *   - bindKeyToTeam: re-bind an EXISTING key to a team in place via
 *     POST /key/update {key, team_id} — heals keys provisioned before the
 *     team-binding fix (or via the degraded unbound path) without deleting or
 *     regenerating them.
 *
 * LiteLLM admin API reference (verified against v1.91.0
 * litellm/proxy/management_endpoints/key_management_endpoints.py + _types.py):
 * POST {base}/team/new (returns a LiteLLM_TeamTable carrying `team_id`),
 * GET {base}/team/list (each entry carries `team_id` + `team_alias`),
 * POST {base}/key/generate (binds to a team via `team_id`),
 * GET {base}/key/info?key=... (returns `{key, info}` where the binding is at
 * `info.team_id`, null/absent ⇒ UNBOUND), GET {base}/key/list,
 * POST {base}/key/delete, POST {base}/key/update (accepts `UpdateKeyRequest`,
 * which inherits `team_id` from `GenerateRequestBase` via `KeyRequestBase`; the
 * handler's `is_different_team` guard rebinds null→team and team→team) —
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
  /**
   * Team id (the UUID `/team/new` returns) the key is bound under. LiteLLM's
   * `/key/generate` associates a key with a team via `team_id` — NOT via
   * `team_alias`, which is not a `GenerateKeyRequest` field and is silently
   * ignored (LiteLLM v1.91 `litellm/proxy/_types.py`: `GenerateRequestBase`
   * carries `team_id`, no `team_alias`). Per-team spend/budget tracking only
   * applies when `team_id` is sent — omit ⇒ the key lands UNBOUND to any team.
   */
  teamId?: string;
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
 * Create the LiteLLM team if it doesn't already exist, and return its
 * `team_id`. Idempotent: an "already exists" response (or 409) is treated as
 * success and the id is resolved by alias via `/team/list`.
 *
 * The returned `team_id` is what binds generated keys to the team
 * (`ensureKey`'s `teamId`). It is best-effort: if the id cannot be read from
 * the create response or resolved on the already-exists path, `undefined` is
 * returned rather than throwing — the provision still succeeds, the key just
 * falls back to unbound (the pre-fix behavior) instead of failing the apply.
 */
/**
 * Outcome of `ensureTeam`.
 *   - `bound`: carries the `team_id` keys must be attached to for per-team
 *     cost/spend tracking.
 *   - `unbound`: no id could be resolved (a fresh `/team/new` 200 with no
 *     parseable id, or an already-exists team whose id `/team/list` didn't
 *     yield). Carries a human `reason` so the CALLER can log a loud, specific
 *     warning instead of silently degrading to an unbound key (the pre-fix
 *     behavior swallowed the reason and provisioned a green "success").
 */
export type EnsureTeamResult =
  | { kind: "bound"; teamId: string }
  | { kind: "unbound"; reason: string };

export async function ensureTeam(
  baseUrl: string,
  masterKey: string,
  teamName: string,
  fetchFn: FetchFn = fetch,
  log?: (msg: string) => void,
): Promise<EnsureTeamResult> {
  const base = normalizeBase(baseUrl);
  const url = `${base}/team/new`;
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
  if (resp.ok) {
    // Fresh create: the response is a LiteLLM_TeamTable carrying the new
    // team_id (the UUID keys must be bound to).
    const id = await readTeamId(resp);
    if (id) return { kind: "bound", teamId: id };
    return {
      kind: "unbound",
      reason:
        `/team/new returned 200 for team '${teamName}' but the response ` +
        `carried no usable team_id`,
    };
  }
  const body = await safeText(resp);
  if (looksLikeAlreadyExists(resp.status, body)) {
    // Idempotent: the team already exists, so /team/new did NOT hand back the
    // id — resolve it by alias via /team/list so keys can still be bound.
    const id = await resolveTeamIdByAlias(base, masterKey, teamName, fetchFn, log);
    if (id) return { kind: "bound", teamId: id };
    return {
      kind: "unbound",
      reason:
        `team '${teamName}' already exists but its team_id could not be ` +
        `resolved via /team/list (list unavailable, unparseable, or no ` +
        `entry matching the alias)`,
    };
  }
  throw new LiteLLMProvisionError(
    `LiteLLM /team/new returned ${resp.status}`,
    resp.status,
    body,
  );
}

/**
 * Best-effort: pull `team_id` out of a `/team/new` (LiteLLM_TeamTable) body. A
 * missing / unparseable id is non-fatal — it just means the caller can't bind
 * the key to the team (the pre-fix behavior), so we degrade rather than throw.
 */
async function readTeamId(resp: Response): Promise<string | undefined> {
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return undefined;
  }
  const id = (json as { team_id?: unknown } | null)?.team_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Resolve an existing team's `team_id` from its `team_alias` via GET
 * /team/list (each entry is a LiteLLM_TeamTable carrying both `team_id` and
 * `team_alias`; some versions wrap the array as `{teams:[...]}`). Best-effort:
 * any failure returns undefined so an idempotent re-apply still succeeds.
 */
async function resolveTeamIdByAlias(
  base: string,
  masterKey: string,
  teamName: string,
  fetchFn: FetchFn,
  log?: (msg: string) => void,
): Promise<string | undefined> {
  let resp: Response;
  try {
    resp = await fetchFn(`${base}/team/list`, {
      method: "GET",
      headers: authHeaders(masterKey),
    });
  } catch {
    return undefined;
  }
  if (!resp.ok) return undefined;
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return undefined;
  }
  const teams: unknown[] = Array.isArray(json)
    ? json
    : Array.isArray((json as { teams?: unknown } | null)?.teams)
      ? (json as { teams: unknown[] }).teams
      : [];
  // Collect ALL ids sharing the alias. LiteLLM does NOT enforce a unique
  // team_alias, so /team/list can legitimately carry several teams with our
  // alias (e.g. a team recreated after a partial delete). Returning the first
  // match is array-order — server-defined and NONDETERMINISTIC: keys could
  // bind to a different team run-to-run, splitting cost tracking silently.
  const matches: string[] = [];
  for (const t of teams) {
    if (t && typeof t === "object") {
      const alias = (t as { team_alias?: unknown }).team_alias;
      const id = (t as { team_id?: unknown }).team_id;
      if (alias === teamName && typeof id === "string" && id.length > 0) {
        matches.push(id);
      }
    }
  }
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  // Duplicate aliases: pick DETERMINISTICALLY (the lexicographically smallest
  // team_id) so binding is stable across applies, and warn naming every
  // duplicate so the operator can dedupe the team upstream.
  const sorted = [...matches].sort();
  log?.(
    `WARNING: ${matches.length} LiteLLM teams share team_alias '${teamName}' ` +
    `(team_ids: ${sorted.join(", ")}); binding keys deterministically to the ` +
    `lexicographically smallest '${sorted[0]}'. Deduplicate the team in ` +
    `LiteLLM to silence this and guarantee cost tracking lands on one team.`,
  );
  return sorted[0];
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
  // Bind the key to the team via team_id — LiteLLM ignores team_alias here.
  if (opts.teamId) payload.team_id = opts.teamId;
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
  | {
      kind: "valid";
      teamId: string | null;
      /**
       * The key's model allowlist (`info.models`). `[]` means UNRESTRICTED in
       * LiteLLM — not "no models"; see `isUnrestrictedAllowlist` in
       * `key-allowlist.ts`. An absent/unreadable field degrades to `[]`, which
       * is the safe direction: it reads as unrestricted and reconciles
       * nothing, rather than inventing a truncation.
       */
      models: string[];
    }
  | { kind: "unknown" }
  | { kind: "unreachable"; detail: string };

/**
 * Probe a stored virtual key against the proxy via GET /key/info. Used by the
 * apply path to detect DB drift (proxy DB reset/restored without the vault) so
 * a stale vault key can be re-provisioned instead of silently 401ing every
 * agent request. Availability-safe: any ambiguous failure degrades to
 * `unreachable` (skip), never to a destructive re-provision.
 *
 * On `valid`, also reports the key's current team binding (`teamId`, from
 * `info.team_id` in the /key/info response — `null` when UNBOUND) so the
 * caller can re-bind a valid-but-unbound key on a steady-state re-apply
 * (see `bindKeyToTeam`).
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
  if (resp.ok) {
    // GET /key/info returns { key, info: {...VerificationToken row...} }
    // (verified v1.91.0 key_management_endpoints.py info_key_fn). The key's
    // team binding lives at info.team_id — null/absent ⇒ UNBOUND. Surface it
    // so a valid-but-unbound key can be healed in place (F1). A missing /
    // unparseable body degrades to `null` (unknown binding), never an error.
    //
    // `info.models` is the key's model allowlist, enforced at request auth by
    // `can_key_call_model` (auth_checks.py). Surfaced so a key that cannot
    // reach a config-declared lane can be healed in place (see
    // `updateKeyModels` + `key-allowlist.ts`).
    let teamId: string | null = null;
    let models: string[] = [];
    try {
      const json = (await resp.json()) as
        | { info?: { team_id?: unknown; models?: unknown } }
        | null;
      const t = json?.info?.team_id;
      if (typeof t === "string" && t.length > 0) teamId = t;
      const m = json?.info?.models;
      if (Array.isArray(m)) models = m.filter((x): x is string => typeof x === "string");
    } catch {
      /* body unreadable/non-JSON — binding unknown (null), allowlist unknown
         ([] ⇒ reads as unrestricted ⇒ reconciles nothing). */
    }
    return { kind: "valid", teamId, models };
  }
  const body = await safeText(resp);
  if (looksLikeUnknownKey(resp.status, body)) return { kind: "unknown" };
  // Bare 401/403 (bad master key, no not-found semantic), 5xx, or any other
  // ambiguous error — do NOT re-provision; keep the stored key and warn.
  return { kind: "unreachable", detail: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
}

/** Options for `bindKeyToTeam`. */
export interface BindKeyToTeamOpts {
  baseUrl: string;
  masterKey: string;
  /** The existing virtual key string to re-bind. */
  key: string;
  /** The team_id to bind the key under. */
  teamId: string;
}

/** Outcome of a bind-only /key/update. */
export type BindKeyToTeamResult =
  | { kind: "ok" }
  | { kind: "error"; detail: string };

/**
 * Re-bind an EXISTING virtual key to a team in place via
 * POST /key/update {key, team_id}. Heals keys provisioned before the
 * team-binding fix (or via the degraded unbound path) so per-team cost
 * tracking starts aggregating — WITHOUT deleting or regenerating the key
 * (which would churn the vault + break in-flight agents).
 *
 * Contract verified against LiteLLM v1.91.0
 * (litellm/proxy/management_endpoints/key_management_endpoints.py update_key_fn
 * + _types.py): POST /key/update accepts `UpdateKeyRequest`, which inherits the
 * optional `team_id` field from `GenerateRequestBase` via `KeyRequestBase`; the
 * handler's `is_different_team(data, existing_key_row)` guard rebinds a key
 * from null→team and team→team. Best-effort + LOUD on failure: never throws —
 * returns a structured error the caller surfaces as a warning.
 */
export async function bindKeyToTeam(
  opts: BindKeyToTeamOpts,
  fetchFn: FetchFn = fetch,
): Promise<BindKeyToTeamResult> {
  const url = `${normalizeBase(opts.baseUrl)}/key/update`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: authHeaders(opts.masterKey),
      body: JSON.stringify({ key: opts.key, team_id: opts.teamId }),
    });
  } catch (err) {
    return { kind: "error", detail: (err as Error).message };
  }
  if (resp.ok) return { kind: "ok" };
  const body = await safeText(resp);
  return { kind: "error", detail: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
}

/** Options for `updateKeyModels`. */
export interface UpdateKeyModelsOpts {
  baseUrl: string;
  masterKey: string;
  /** The existing virtual key string whose allowlist to rewrite. */
  key: string;
  /**
   * The FULL allowlist to store. LiteLLM's `/key/update` REPLACES `models`
   * rather than appending, so callers must pass the union they want to end up
   * with — `reconciledAllowlist()` in `key-allowlist.ts` computes it.
   */
  models: string[];
}

/** Outcome of an allowlist-only /key/update. */
export type UpdateKeyModelsResult =
  | { kind: "ok" }
  | { kind: "error"; detail: string };

/**
 * Rewrite an EXISTING virtual key's model allowlist in place via
 * POST /key/update {key, models}.
 *
 * Why this is needed at all: the allowlist is enforced at request auth
 * (`can_key_call_model`, `litellm/proxy/auth/auth_checks.py`) and stored in the
 * proxy's Postgres `LiteLLM_VerificationToken` row — NOT in
 * `litellm-config.yaml`. It therefore has no declarative home on the proxy side
 * and a DB rebuild silently reverts it. Reconciling it from `switchroom.yaml`
 * on every apply is what gives it one.
 *
 * Contract verified against LiteLLM v1.91.0
 * (`litellm/proxy/management_endpoints/key_management_endpoints.py update_key_fn`
 * + `_types.py`): `UpdateKeyRequest` inherits the optional `models` field from
 * `GenerateRequestBase` via `KeyRequestBase`, and the handler writes it through
 * to the token row. Semantics are REPLACE, not merge — hence the full-union
 * contract on {@link UpdateKeyModelsOpts.models}.
 *
 * Best-effort + LOUD on failure: never throws, never deletes or regenerates the
 * key (which would churn the vault and break in-flight callers) — returns a
 * structured error the caller surfaces as a warning.
 */
export async function updateKeyModels(
  opts: UpdateKeyModelsOpts,
  fetchFn: FetchFn = fetch,
): Promise<UpdateKeyModelsResult> {
  const url = `${normalizeBase(opts.baseUrl)}/key/update`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "POST",
      headers: authHeaders(opts.masterKey),
      body: JSON.stringify({ key: opts.key, models: opts.models }),
    });
  } catch (err) {
    return { kind: "error", detail: (err as Error).message };
  }
  if (resp.ok) return { kind: "ok" };
  const body = await safeText(resp);
  return { kind: "error", detail: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
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
