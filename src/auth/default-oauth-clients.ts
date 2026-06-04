/**
 * Shipped default OAuth client IDs — out-of-box external-account connect
 * (RFC #1873 / Microsoft-first out-of-box, see memory
 * project_oauth_out_of_box_microsoft_first).
 *
 * A client_id is a PUBLIC identifier, not a secret. For a **public
 * client** (PKCE / device-code, no client_secret) it is safe — and
 * expected — to ship in a distributed application. This mirrors the
 * Anthropic OAuth client baked into `src/auth/account-refresh.ts`
 * (`DEFAULT_CLIENT_ID`): a module-level constant with an env override.
 *
 * **Microsoft.** switchroom.ai's multi-tenant + personal-accounts Entra
 * app registration (`signInAudience: AzureADandPersonalMicrosoftAccount`,
 * "Allow public client flows" enabled, NO client secret). Shipping it as
 * the default lets a fresh install connect a Microsoft account with zero
 * Azure-portal work — the "batteries included, assembly optional"
 * default. Operators who want their own app (tighter scope control,
 * publisher verification, single-tenant lockdown) override it via
 * `microsoft_workspace.microsoft_client_id` in switchroom.yaml or the
 * `SWITCHROOM_MICROSOFT_CLIENT_ID` env var. That BYO path is the opt-in
 * complexity — never the default.
 *
 * Caveat (by design, not a bug): an UNVERIFIED multitenant app can't be
 * consented by users in *external work/school* tenants with risk-based
 * step-up consent on — those need a one-time tenant-admin approval (or a
 * BYO app). Personal Microsoft accounts (outlook.com/hotmail) and the
 * app's home tenant are unaffected, which is the headline "connect from
 * your phone" case.
 *
 * **Google.** No default ships, by design. Google's full Drive/Gmail are
 * "restricted" scopes requiring per-app brand verification + an annual
 * third-party CASA security assessment to serve external users, so Google
 * stays operator-owned / BYO. See the memory above for the decision.
 */

/**
 * switchroom.ai's shipped Microsoft Entra public client.
 *
 * Multi-tenant + personal Microsoft accounts, "Allow public client
 * flows" enabled, no secret. Public identifier — safe to ship.
 */
export const DEFAULT_MICROSOFT_CLIENT_ID =
  "9dff88fa-3126-457b-9d1d-37e58c219019";

/** Where a resolved Microsoft client_id came from. */
export type MicrosoftClientIdSource = "env" | "config" | "default";

export interface ResolvedMicrosoftClientId {
  clientId: string;
  source: MicrosoftClientIdSource;
}

/**
 * Resolve the Microsoft OAuth client_id with the full precedence:
 *
 *   `SWITCHROOM_MICROSOFT_CLIENT_ID` env  →  operator config
 *   (`microsoft_workspace.microsoft_client_id`)  →  shipped default.
 *
 * The returned `source` lets callers tell the operator whether they're
 * on the shipped default vs. their own app (BYO). The config value is
 * returned verbatim — it may be a `vault:<key>` reference the caller
 * still has to resolve; the env value and the default are always
 * literal client IDs.
 *
 * This is the single source of truth for Microsoft client_id precedence;
 * the host-CLI connect path (`auth microsoft account add`) and the
 * broker refresh path (`AuthBroker` ctor) both call it so they can't
 * drift.
 */
export function resolveMicrosoftClientId(
  configClientId?: string,
): ResolvedMicrosoftClientId {
  const env = process.env.SWITCHROOM_MICROSOFT_CLIENT_ID;
  if (env !== undefined && env.trim().length > 0) {
    return { clientId: env.trim(), source: "env" };
  }
  if (configClientId !== undefined && configClientId.length > 0) {
    return { clientId: configClientId, source: "config" };
  }
  return { clientId: DEFAULT_MICROSOFT_CLIENT_ID, source: "default" };
}
