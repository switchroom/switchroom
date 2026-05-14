/**
 * Thin adapter between the gateway and `src/auth/broker/client.ts`.
 *
 * The broker client is a stateful class (holds a persistent UDS
 * connection). The gateway constructs one per `/auth` command —
 * cheap, and avoids dangling sockets on idle. The handler needs the
 * five methods on the `AuthBrokerClient` interface in
 * `./auth-command.ts` (listState / setActive / rmAccount /
 * refreshAccount / setOverride); we narrow `BrokerClient` down to
 * that surface so a test mock only has to stub those five.
 */

import { AuthBrokerClient as BrokerClient, type AddAccountCredentials } from '../../src/auth/broker/client.js'
import type { AuthBrokerClient } from './auth-command.js'

/**
 * Construct an {@link AuthBrokerClient} for one `/auth` command. The
 * caller is responsible for closing the underlying socket when done
 * (do `await client.close()` after the reply lands).
 */
export function createAuthBrokerClient(): {
  client: AuthBrokerClient
  close: () => Promise<void>
} {
  const broker = new BrokerClient()
  const client: AuthBrokerClient = {
    listState: () => broker.listState(),
    setActive: (label: string) => broker.setActive(label),
    rmAccount: (label: string) => broker.rmAccount(label),
    refreshAccount: (label: string) => broker.refreshAccount(label),
    setOverride: (agent: string, account: string | null) =>
      broker.setOverride(agent, account),
  }
  return { client, close: () => broker.close() }
}

/**
 * Legacy `getAuthBrokerClient` entry — kept so the gateway's existing
 * call site doesn't need rewiring. Returns the client object only;
 * the underlying socket leaks unless the caller imports
 * `createAuthBrokerClient` directly. Acceptable because:
 *   - The gateway is long-lived (one process per agent).
 *   - The broker tolerates many connections per peer.
 *   - `/auth` is a low-frequency human-driven verb.
 *
 * If allocations become a concern, swap callers over to the structured
 * variant above.
 */
export async function getAuthBrokerClient(
  _agentName: string,
): Promise<AuthBrokerClient | null> {
  const { client } = createAuthBrokerClient()
  return client
}

/**
 * Add an account via the broker. Used exclusively by the `/auth add`
 * chat flow — the narrow {@link AuthBrokerClient} surface in
 * `auth-command.ts` deliberately omits `addAccount` because the verb
 * is gateway-routed (not handler-routed). Constructs and closes a
 * one-shot {@link BrokerClient} so the gateway doesn't need a
 * long-lived handle just for this verb.
 */
export async function addAccountViaBroker(
  label: string,
  credentials: AddAccountCredentials,
  opts: { replace?: boolean } = {},
): Promise<{ label: string; expiresAt?: number }> {
  const broker = new BrokerClient()
  try {
    return await broker.addAccount(label, credentials, opts.replace)
  } finally {
    await broker.close()
  }
}
