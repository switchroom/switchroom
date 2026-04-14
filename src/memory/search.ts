import type { SwitchroomConfig } from "../config/schema.js";
import { getCollectionForAgent, isStrictIsolation } from "./hindsight.js";

/**
 * Output the Hindsight CLI command to search memories in a collection.
 *
 * Hindsight is an external service; Switchroom does not embed a client.
 * This generates the equivalent CLI invocation.
 */
export function searchMemory(query: string, collection: string): string {
  return `hindsight recall --collection ${collection} --query "${query}"`;
}

/**
 * Output the Hindsight CLI command to get stats for a collection.
 */
export function getMemoryStats(collection: string): string {
  return `hindsight stats --collection ${collection}`;
}

/**
 * Generate a cross-agent reflection plan.
 *
 * Lists all non-strict collections and outputs the Hindsight CLI commands
 * needed to run reflection across them.
 */
export function reflectAcrossAgents(config: SwitchroomConfig): {
  eligible: Array<{ agent: string; collection: string }>;
  excluded: Array<{ agent: string; collection: string }>;
  commands: string[];
} {
  const eligible: Array<{ agent: string; collection: string }> = [];
  const excluded: Array<{ agent: string; collection: string }> = [];

  for (const agentName of Object.keys(config.agents)) {
    const collection = getCollectionForAgent(agentName, config);
    if (isStrictIsolation(agentName, config)) {
      excluded.push({ agent: agentName, collection });
    } else {
      eligible.push({ agent: agentName, collection });
    }
  }

  const commands = eligible.map(
    ({ collection }) => `hindsight reflect --collection ${collection}`,
  );

  return { eligible, excluded, commands };
}
