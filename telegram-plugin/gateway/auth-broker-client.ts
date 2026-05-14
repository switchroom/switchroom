/**
 * Thin adapter between the gateway and `src/auth/broker/client.ts`.
 *
 * The broker client is a stateful class (holds a persistent UDS
 * connection). The gateway constructs one per `/auth` command —
 * cheap, and avoids dangling sockets on idle. The handler only needs
 * `listState` and `setActive`, so this adapter narrows the surface to
 * the `AuthBrokerClient` interface from `./auth-command.ts`.
 */

import { AuthBrokerClient as BrokerClient } from '../../src/auth/broker/client.js'
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
