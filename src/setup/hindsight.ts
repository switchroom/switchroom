import { execSync } from "node:child_process";
import { createServer } from "node:net";

/**
 * Default Hindsight ports (upstream defaults).
 */
export const HINDSIGHT_DEFAULT_API_PORT = 8888;
export const HINDSIGHT_DEFAULT_UI_PORT = 9999;

/**
 * Check if a TCP port is free for binding on 127.0.0.1.
 * Returns true if free, false if something is already listening.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find a free port starting at `start`, incrementing until one is found
 * or `maxAttempts` ports have been tried.
 *
 * @param start - First port to try
 * @param maxAttempts - How many ports to try before giving up
 * @returns The first free port, or null if none found in range
 */
export async function findFreePort(
  start: number,
  maxAttempts = 50,
): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = start + i;
    // Skip privileged ports just in case
    if (port < 1024) continue;
    if (await isPortFree(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Pick host ports for the Hindsight container.
 *
 * Tries the upstream defaults (8888/9999) first. If either is taken,
 * falls back to 18888/19999, then keeps incrementing.
 *
 * Returns the chosen { apiPort, uiPort }, or throws if no ports could be found.
 */
export async function pickHindsightPorts(): Promise<{
  apiPort: number;
  uiPort: number;
}> {
  // Try defaults first
  if (
    (await isPortFree(HINDSIGHT_DEFAULT_API_PORT)) &&
    (await isPortFree(HINDSIGHT_DEFAULT_UI_PORT))
  ) {
    return {
      apiPort: HINDSIGHT_DEFAULT_API_PORT,
      uiPort: HINDSIGHT_DEFAULT_UI_PORT,
    };
  }

  // Defaults taken; fall back to 18888/19999 then linear scan
  const apiPort = await findFreePort(18888);
  const uiPort = await findFreePort(19999);
  if (apiPort === null || uiPort === null) {
    throw new Error(
      "Could not find a free port for Hindsight. " +
        "Stop whatever is using 8888 / 9999 / 18888 / 19999 and retry.",
    );
  }
  return { apiPort, uiPort };
}

/**
 * Check if Docker is available on the system.
 */
export function isDockerAvailable(): boolean {
  try {
    execSync("docker --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the switchroom-hindsight container is currently running.
 */
export function isHindsightRunning(): boolean {
  try {
    const output = execSync(
      'docker ps --filter name=switchroom-hindsight --format "{{.Status}}"',
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if the switchroom-hindsight container exists (running or stopped).
 */
export function isHindsightContainerExists(): boolean {
  try {
    const output = execSync(
      'docker ps -a --filter name=switchroom-hindsight --format "{{.Names}}"',
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Start the Hindsight Docker container.
 *
 * @param provider - Optional LLM provider (e.g., "ollama", "openai", "anthropic")
 * @param apiKey - Optional LLM API key (e.g., OpenAI key)
 * @param ports - Optional host port mapping. If omitted, tries upstream
 *   defaults (8888/9999) then 18888/19999.
 */
export function startHindsight(
  provider?: string,
  apiKey?: string,
  ports?: { apiPort: number; uiPort: number },
): void {
  const apiPort = ports?.apiPort ?? HINDSIGHT_DEFAULT_API_PORT;
  const uiPort = ports?.uiPort ?? HINDSIGHT_DEFAULT_UI_PORT;
  const envArgs: string[] = [];
  if (provider) envArgs.push("-e", `HINDSIGHT_API_LLM_PROVIDER=${provider}`);
  if (apiKey) envArgs.push("-e", `HINDSIGHT_API_LLM_API_KEY=${apiKey}`);
  const args = [
    "run", "-d",
    "--name", "switchroom-hindsight",
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${apiPort}:8888`,
    "-p", `127.0.0.1:${uiPort}:9999`,
    "-v", "switchroom-hindsight-data:/home/hindsight/.pg0",
    ...envArgs,
    "ghcr.io/vectorize-io/hindsight:latest",
  ];

  execSync(`docker ${args.join(" ")}`, { stdio: "pipe" });
}

/**
 * Stop and remove the Hindsight Docker container.
 */
export function stopHindsight(): void {
  try {
    execSync("docker stop switchroom-hindsight", { stdio: "pipe" });
  } catch { /* container may already be stopped */ }
  try {
    execSync("docker rm switchroom-hindsight", { stdio: "pipe" });
  } catch { /* container may already be removed */ }
}

/**
 * Get the status of the Hindsight Docker container.
 * Returns a human-readable status string, or null if not found.
 */
export function getHindsightStatus(): string | null {
  try {
    const output = execSync(
      'docker ps -a --filter name=switchroom-hindsight --format "{{.Status}}"',
      { stdio: "pipe", encoding: "utf-8" },
    );
    const status = output.trim();
    return status.length > 0 ? status : null;
  } catch {
    return null;
  }
}

/**
 * Get the MCP server config for Hindsight via HTTP endpoint.
 * Hindsight exposes MCP via Streamable HTTP at localhost:8888/mcp.
 */
export function getHindsightMcpUrl(): {
  url: string;
} {
  return {
    url: "http://localhost:8888/mcp/",
  };
}

/**
 * Generate a docker-compose snippet for Hindsight.
 */
export function generateHindsightComposeSnippet(provider?: string): string {
  const envLines = provider
    ? [`      - LLM_PROVIDER=${provider}`]
    : [];

  return [
    "services:",
    "  switchroom-hindsight:",
    "    image: ghcr.io/vectorize-io/hindsight:latest",
    "    container_name: switchroom-hindsight",
    "    ports:",
    "      - \"8888:8888\"",
    "      - \"9999:9999\"",
    ...(envLines.length > 0
      ? ["    environment:", ...envLines]
      : []),
    "    volumes:",
    "      - switchroom-hindsight-data:/home/hindsight/.pg0",
    "    restart: unless-stopped",
    "",
    "volumes:",
    "  switchroom-hindsight-data:",
  ].join("\n");
}
