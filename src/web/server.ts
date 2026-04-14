import { readFileSync, existsSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { spawn } from "node:child_process";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  handleGetAgents,
  handleStartAgent,
  handleStopAgent,
  handleRestartAgent,
  handleGetLogs,
} from "./api.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Check bearer token auth if SWITCHROOM_WEB_TOKEN is set.
 * Returns null if auth passes, or a 401 Response if it fails.
 */
function checkAuth(req: Request): Response | null {
  const token = process.env.SWITCHROOM_WEB_TOKEN;
  if (!token) return null; // No token configured, allow all

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${token}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * Check bearer token for WebSocket upgrade requests.
 * Token can be passed as ?token= query param.
 */
function checkWsAuth(req: Request): boolean {
  const token = process.env.SWITCHROOM_WEB_TOKEN;
  if (!token) return true;

  const url = new URL(req.url);
  const paramToken = url.searchParams.get("token");
  return paramToken === token;
}

function parseRoute(
  pathname: string,
  method: string
): { handler: string; params: Record<string, string> } | null {
  // GET /api/agents
  if (method === "GET" && pathname === "/api/agents") {
    return { handler: "getAgents", params: {} };
  }

  // GET /api/agents/:name/logs
  const logsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/logs$/);
  if (method === "GET" && logsMatch) {
    return { handler: "getLogs", params: { name: logsMatch[1] } };
  }

  // POST /api/agents/:name/start
  const startMatch = pathname.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (method === "POST" && startMatch) {
    return { handler: "startAgent", params: { name: startMatch[1] } };
  }

  // POST /api/agents/:name/stop
  const stopMatch = pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    return { handler: "stopAgent", params: { name: stopMatch[1] } };
  }

  // POST /api/agents/:name/restart
  const restartMatch = pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
  if (method === "POST" && restartMatch) {
    return { handler: "restartAgent", params: { name: restartMatch[1] } };
  }

  return null;
}

export function startWebServer(config: SwitchroomConfig, port: number): void {
  const uiDir = resolve(import.meta.dirname, "ui");

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Handle CORS preflight — not needed for localhost-only server
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      // WebSocket upgrade
      if (pathname === "/ws") {
        if (!checkWsAuth(req)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = server.upgrade(req);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      // API routes — require auth if SWITCHROOM_WEB_TOKEN is set
      const route = parseRoute(pathname, req.method);
      if (route) {
        const authError = checkAuth(req);
        if (authError) return authError;

        switch (route.handler) {
          case "getAgents":
            return jsonResponse(handleGetAgents(config));

          case "getLogs": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const rawLines = parseInt(url.searchParams.get("lines") ?? "50", 10);
            const lines = (!isNaN(rawLines) && rawLines >= 1 && rawLines <= 10000)
              ? rawLines
              : 50;
            return jsonResponse(handleGetLogs(agentName, lines));
          }

          case "startAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleStartAgent(agentName));
          }

          case "stopAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleStopAgent(agentName));
          }

          case "restartAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleRestartAgent(agentName));
          }
        }
      }

      // Static files — no auth required
      let filePath = pathname === "/" ? "/index.html" : pathname;
      const fullPath = join(uiDir, filePath);

      // Prevent directory traversal
      if (!fullPath.startsWith(uiDir)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (existsSync(fullPath)) {
        const ext = extname(fullPath);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        const content = readFileSync(fullPath);
        return new Response(content, {
          headers: { "Content-Type": contentType },
        });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(_ws) {
        // No-op; tracking handled per-subscription
      },
      close(ws) {
        const proc = (ws as any)._logProcess;
        if (proc) {
          proc.kill();
          (ws as any)._logProcess = null;
        }
      },
      message(ws, message) {
        // Handle subscription requests for agent logs
        try {
          const data = JSON.parse(String(message));
          if (data.type === "subscribe" && data.agent) {
            const agentName = String(data.agent).replace(/[^a-zA-Z0-9_-]/g, "");

            // Kill any existing log process before subscribing to a new one
            const existing = (ws as any)._logProcess;
            if (existing) {
              existing.kill();
              (ws as any)._logProcess = null;
            }

            const child = spawn(
              "journalctl",
              ["--user", "-u", `switchroom-${agentName}`, "-f", "--no-pager", "-n", "20"],
              { stdio: ["ignore", "pipe", "pipe"] }
            );

            child.stdout.on("data", (chunk: Buffer) => {
              try {
                ws.send(JSON.stringify({
                  type: "log",
                  agent: agentName,
                  data: chunk.toString("utf-8"),
                }));
              } catch {
                // Client disconnected
                child.kill();
              }
            });

            child.stderr.on("data", (chunk: Buffer) => {
              try {
                ws.send(JSON.stringify({
                  type: "log_error",
                  agent: agentName,
                  data: chunk.toString("utf-8"),
                }));
              } catch {
                child.kill();
              }
            });

            // Store child reference for cleanup
            (ws as any)._logProcess = child;
          }
        } catch {
          // Ignore invalid messages
        }
      },
    },
  });

  console.log(`Switchroom dashboard running at http://localhost:${server.port}`);
}
