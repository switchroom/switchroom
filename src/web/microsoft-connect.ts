/**
 * In-browser Microsoft connect for the dashboard — RFC 8628 device-code.
 *
 * The dashboard parity of the Telegram `/connect microsoft` flow: the
 * operator clicks "Connect a Microsoft account", we start a device-code
 * flow against the shipped default app (or a BYO client), surface the
 * short user_code + verification URL, and poll Microsoft's token endpoint
 * in the background. On consent we register the account with the
 * auth-broker. Mirrors telegram-plugin/gateway/microsoft-connect-flow.ts
 * but reuses the src-level OAuth primitives directly so the web layer
 * doesn't import from the plugin.
 *
 * SECURITY: connecting an account is NOT a credential-access grant. The
 * device-code consent is a human action on Microsoft's own domain (an
 * agent can't complete someone else's sign-in), and a registered account
 * is unusable by any agent until the operator approves access via the
 * (Telegram-approval-gated) connection-access flow. So no approval card
 * is needed to START a connect — the Microsoft sign-in is the gate.
 */

import {
  requestDeviceCode as realRequestDeviceCode,
  pollDeviceToken as realPollDeviceToken,
  type MicrosoftDeviceCodeResponse,
  type MicrosoftOAuthClientConfig,
} from "../microsoft/oauth.js";
import { selectMicrosoftScopes } from "../microsoft/scopes.js";
import { buildMicrosoftCredentials } from "../microsoft/credentials.js";
import { resolveMicrosoftClientId } from "../auth/default-oauth-clients.js";
import { isVaultReference } from "../vault/resolver.js";
import { withAuthBrokerClient } from "../auth/broker/client.js";
import type { MicrosoftAddAccountCredentials } from "../auth/broker/client.js";

export interface MicrosoftConnectDeps {
  /** `config.microsoft_workspace?.microsoft_client_id` (may be a vault: ref). */
  configClientId?: string;
  orgMode?: boolean;
  requestDeviceCode?: (
    cfg: MicrosoftOAuthClientConfig,
  ) => Promise<MicrosoftDeviceCodeResponse>;
  pollDeviceToken?: typeof realPollDeviceToken;
  addAccount?: (
    label: string,
    creds: MicrosoftAddAccountCredentials,
  ) => Promise<unknown>;
  now?: () => number;
}

export type StartResult =
  | {
      kind: "started";
      device: MicrosoftDeviceCodeResponse;
      clientId: string;
      scopes: string[];
      source: "env" | "config" | "default";
    }
  | { kind: "byo-vault"; ref: string }
  | { kind: "error"; message: string };

/**
 * Request a device code. Does not register anything — returns the data
 * the dashboard needs to show the sign-in card. The caller stores the
 * pending entry and kicks off {@link runMicrosoftConnectPoll}.
 */
export async function startMicrosoftConnect(
  deps: MicrosoftConnectDeps = {},
): Promise<StartResult> {
  const resolved = resolveMicrosoftClientId(deps.configClientId);
  // A vaulted BYO client_id can't be resolved from the web process — the
  // operator must connect that install from the host CLI.
  if (isVaultReference(resolved.clientId)) {
    return { kind: "byo-vault", ref: resolved.clientId };
  }
  const scopes = selectMicrosoftScopes(deps.orgMode ?? false);
  const cfg: MicrosoftOAuthClientConfig = { client_id: resolved.clientId, scopes };
  try {
    const device = await (deps.requestDeviceCode ?? realRequestDeviceCode)(cfg);
    return { kind: "started", device, clientId: resolved.clientId, scopes, source: resolved.source };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

export type PollResult =
  | { state: "connected"; account: string; accountType: "personal" | "work" }
  | { state: "no-refresh-token" }
  | { state: "failed"; message: string };

/**
 * Poll Microsoft for consent, then register the account with the broker.
 * Blocks (with the device-code interval) up to `device.expires_in`.
 */
export async function runMicrosoftConnectPoll(
  flow: { device: MicrosoftDeviceCodeResponse; clientId: string; scopes: string[] },
  deps: MicrosoftConnectDeps = {},
): Promise<PollResult> {
  const now = deps.now ?? Date.now;
  const cfg: MicrosoftOAuthClientConfig = { client_id: flow.clientId, scopes: flow.scopes };

  let tokens;
  try {
    tokens = await (deps.pollDeviceToken ?? realPollDeviceToken)(cfg, flow.device, { now });
  } catch (err) {
    return { state: "failed", message: (err as Error).message };
  }

  const built = buildMicrosoftCredentials({
    tokens,
    clientId: flow.clientId,
    accountEmail: "", // device-code learns the email from the id_token
    fallbackScope: flow.scopes.join(" "),
    now,
  });

  // offline_access is requested; without a refresh token the account dies
  // at the first access-token expiry — refuse rather than register it.
  if (!built.credentials.microsoftOauth.refreshToken) {
    return { state: "no-refresh-token" };
  }
  const account = built.resolvedEmail;
  if (!account) {
    return { state: "failed", message: "Microsoft returned no account identity (no id_token)." };
  }

  const addAccount =
    deps.addAccount ??
    ((label: string, creds: MicrosoftAddAccountCredentials) =>
      withAuthBrokerClient((client) =>
        client.addAccount(label, creds, /*replace*/ true, "microsoft"),
      ));

  try {
    await addAccount(account, built.credentials as MicrosoftAddAccountCredentials);
  } catch (err) {
    return { state: "failed", message: (err as Error).message };
  }

  return {
    state: "connected",
    account,
    accountType: built.credentials.microsoftOauth.accountType,
  };
}
