import type { SwitchroomConfig, MemoryBackendConfig } from "../config/schema.js";

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Generate the MCP server config entry for Hindsight.
 *
 * Hindsight exposes MCP via Streamable HTTP at /mcp/. The host/port can be
 * overridden in switchroom.yaml's memory.config.url; defaults to localhost:8888
 * (the upstream default). Note that 8888 conflicts with Coolify and other
 * common services — host the container on 18888 and set memory.config.url
 * accordingly.
 */
export function generateHindsightMcpConfig(
  collection: string,
  memoryConfig: MemoryBackendConfig,
): McpServerConfig {
  const url = (memoryConfig.config?.url as string | undefined)
    ?? "http://localhost:8888/mcp/";
  return {
    type: "http",
    url,
    headers: {
      "X-Bank-Id": collection,
    },
  };
}

/**
 * Generate a docker-compose YAML snippet for the Hindsight service.
 */
export function generateDockerComposeSnippet(
  memoryConfig: MemoryBackendConfig,
): string {
  const provider = memoryConfig.config?.provider ?? "ollama";
  const model = memoryConfig.config?.model;

  const envLines = [`      - LLM_PROVIDER=${provider}`];
  if (model) {
    envLines.push(`      - EMBEDDING_MODEL=${model}`);
  }
  if (memoryConfig.config?.api_key) {
    envLines.push(`      - API_KEY=${memoryConfig.config.api_key}`);
  }

  return [
    "hindsight:",
    "  image: ghcr.io/vectorize-io/hindsight:latest",
    "  ports:",
    "    - \"8888:8888\"",
    "    - \"9999:9999\"",
    "  environment:",
    ...envLines,
    "  volumes:",
    "    - hindsight-data:/home/hindsight/.pg0",
    "  restart: unless-stopped",
  ].join("\n");
}

/**
 * Look up the Hindsight collection name for an agent.
 * Falls back to the agent's name if no explicit collection is configured.
 */
export function getCollectionForAgent(
  agentName: string,
  config: SwitchroomConfig,
): string {
  const agentConfig = config.agents[agentName];
  return agentConfig?.memory?.collection ?? agentName;
}

/**
 * Check whether an agent has strict memory isolation.
 * Strict agents are excluded from cross-agent reflection.
 */
export function isStrictIsolation(
  agentName: string,
  config: SwitchroomConfig,
): boolean {
  const agentConfig = config.agents[agentName];
  return agentConfig?.memory?.isolation === "strict";
}

/**
 * Parse a Hindsight MCP response body.
 *
 * Hindsight's MCP server returns text/event-stream responses of the form:
 *
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * `await resp.json()` throws on that because it is not raw JSON. Strip the
 * SSE preamble and parse the JSON payload manually. Falls back to raw text
 * parsing if no `data:` line is present, so a server that responds with
 * plain JSON still works.
 */
async function parseSseOrJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = dataLine ? dataLine.slice("data: ".length) : text;
  return JSON.parse(payload) as T;
}

/**
 * Ensure the user-profile Mental Model exists for a bank.
 *
 * Creates the Mental Model if it doesn't exist, idempotent on subsequent calls.
 * The MM is pre-computed via reflection and answers "what do we know about the user?"
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param bankId The bank ID to create the MM in
 * @param opts Optional fetch implementation and timeout
 * @returns {ok: true} on success, {ok: false, reason} on error
 */
export async function ensureUserProfileMentalModel(
  apiUrl: string,
  bankId: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Step 1: Initialize MCP session
    const initResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!initResponse.ok) {
      return { ok: false, reason: `HTTP ${initResponse.status}` };
    }

    const sessionId = initResponse.headers.get("mcp-session-id");
    if (!sessionId) {
      return { ok: false, reason: "No session ID returned" };
    }

    // Step 2: Check if MM already exists
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const listResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "list_mental_models",
          arguments: {},
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout2);

    if (listResponse.ok) {
      try {
        const listData = await parseSseOrJson<{
          result?: { content?: Array<{ text?: string }> };
        }>(listResponse);
        const models = listData.result?.content?.[0]?.text;
        if (models && typeof models === "string" && models.includes("user-profile")) {
          return { ok: true }; // Already exists
        }
      } catch {
        // Parse failed (not SSE and not JSON). Fall through to create attempt;
        // if the MM already exists, create will return an idempotent error
        // we also swallow below.
      }
    }

    // Step 3: Create the MM
    const timeout3 = setTimeout(() => controller.abort(), timeoutMs);
    const createResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "create_mental_model",
          arguments: {
            name: "user-profile",
            query: "What are the key facts, preferences, context, and communication style about the user I talk to? Summarize what matters for making the agent feel like it knows them.",
            types: ["world", "experience"],
          },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout3);

    if (!createResponse.ok) {
      return { ok: false, reason: `Create MM HTTP ${createResponse.status}` };
    }

    return { ok: true };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    return { ok: false, reason: String(err) };
  }
}

/**
 * Update bank mission statements via MCP.
 *
 * Calls Hindsight's update_bank tool to set bank_mission and/or retain_mission.
 * Best-effort with timeout; never throws.
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param bankId The bank ID to update
 * @param missions Object with optional bank_mission and/or retain_mission
 * @param opts Optional fetch implementation and timeout
 * @returns {ok: true} on success, {ok: false, reason} on error
 */
export async function updateBankMissions(
  apiUrl: string,
  bankId: string,
  missions: { bank_mission?: string; retain_mission?: string },
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Step 1: Initialize MCP session
    const initResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!initResponse.ok) {
      return { ok: false, reason: `HTTP ${initResponse.status}` };
    }

    const sessionId = initResponse.headers.get("mcp-session-id");
    if (!sessionId) {
      return { ok: false, reason: "No session ID returned" };
    }

    // Step 2: Call update_bank tool
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const toolResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "update_bank",
          arguments: {
            bank_id: bankId,
            mission: missions.bank_mission,
            retain_mission: missions.retain_mission,
          },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout2);

    if (!toolResponse.ok) {
      return { ok: false, reason: `Tool call HTTP ${toolResponse.status}` };
    }

    return { ok: true };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    return { ok: false, reason: String(err) };
  }
}
