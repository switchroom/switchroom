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
 * Recommended default `retain_mission` for new agents.
 *
 * Sourced verbatim from upstream Hindsight's per-user-memory guide:
 *   https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/guides/2026-04-15-guide-openclaw-per-user-memory-across-channels-setup.md
 *   (lines 188–193)
 *
 * The mission shapes the LLM extraction step that fires inside
 * Hindsight's auto-retain. Tighter wording here directly lifts retained
 * memory quality (less conversational filler stored, fewer marginal hits
 * surfacing in subsequent recalls).
 *
 * Switchroom seeds this for newly scaffolded agents only (see
 * `scaffoldAgent` in `src/agents/scaffold.ts`). Existing agents'
 * missions are left alone — operators may have customized them, and
 * `reconcileAgent` does not push a default. Operators can always
 * override per-agent via `agents.<name>.memory.retain_mission` in
 * `switchroom.yaml`.
 */
export const DEFAULT_RETAIN_MISSION =
  "Extract user preferences, ongoing projects, recurring commitments, " +
  "important context, and durable facts that should help across future " +
  "conversations. Skip one-off chatter and temporary task noise.";

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
 * Result of a Hindsight MCP probe.
 */
export type HindsightProbe =
  | { ok: true; serverName: string; serverVersion: string }
  | { ok: false; reason: string };

/**
 * Probe a Hindsight MCP endpoint by issuing an `initialize` request and
 * reading the `serverInfo` it returns. Used by `switchroom doctor` to
 * confirm that the URL configured in `memory.config.url` is actually
 * serving Hindsight (vs. some other process happening to bind the same
 * port) and to surface the server version in the doctor output.
 *
 * Best-effort with a short timeout; never throws. Connection refused /
 * fetch failures normalize to `{ ok: false, reason: "Unreachable" }` so
 * callers can render an operator-specific message; protocol errors
 * (HTTP non-200, missing session id, malformed JSON) surface as
 * `{ ok: false, reason: "..." }` with a concrete reason.
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param opts Optional fetch implementation and timeout
 */
export async function probeHindsight(
  apiUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<HindsightProbe> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 3000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom-doctor", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return { ok: false, reason: `HTTP ${resp.status}` };
    }

    const data = await parseSseOrJson<{
      result?: { serverInfo?: { name?: string; version?: string } };
    }>(resp);

    const info = data.result?.serverInfo;
    if (!info?.name || !info?.version) {
      return { ok: false, reason: "Missing serverInfo in initialize response" };
    }

    return { ok: true, serverName: info.name, serverVersion: info.version };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    const msg = String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("Failed to fetch") ||
      msg.includes("ENOTFOUND")
    ) {
      return { ok: false, reason: "Unreachable" };
    }
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timeout);
  }
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
 * Idempotently create a Hindsight bank via MCP.
 *
 * Calls Hindsight's create_bank tool. Hindsight's create_bank is documented
 * as "Create a new memory bank or get an existing one" — so calling this on
 * an already-existing bank is a no-op and returns success. Best-effort with
 * timeout; never throws.
 *
 * Used by `switchroom agent create` to make sure an agent's bank exists
 * BEFORE its first `retain` call — without this, the first retain against a
 * missing bank blows up with a raw foreign-key constraint violation because
 * Hindsight's `get_bank_stats` silently returns empty on a missing bank.
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param bankId The bank ID to create (typically the agent name)
 * @param opts Optional fetch implementation, timeout, and optional name/mission
 * @returns {ok: true} on success, {ok: false, reason} on error. reason will be
 *   "Unreachable" when the Hindsight daemon is not running (connection refused
 *   / network error) so callers can render a specific operator-facing message.
 */
export async function createBank(
  apiUrl: string,
  bankId: string,
  opts?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    name?: string;
    mission?: string;
  }
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

    // Step 2: Call create_bank tool
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const args: Record<string, unknown> = { bank_id: bankId };
    if (opts?.name) args.name = opts.name;
    if (opts?.mission) args.mission = opts.mission;

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
          name: "create_bank",
          arguments: args,
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
    // ECONNREFUSED / fetch failed → daemon not running. Normalize to
    // "Unreachable" so the CLI can surface a specific operator message.
    const msg = String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("Failed to fetch") ||
      msg.includes("ENOTFOUND")
    ) {
      return { ok: false, reason: "Unreachable" };
    }
    return { ok: false, reason: msg };
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
