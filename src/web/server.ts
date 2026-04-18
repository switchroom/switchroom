import {
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { resolve, extname, join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
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

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve the bearer token the dashboard will require for every request.
 *
 * Precedence: `SWITCHROOM_WEB_TOKEN` env var wins. Otherwise we generate
 * a 256-bit random token and persist it at `~/.switchroom/web-token`
 * (mode 0o600) — subsequent runs reuse it. Auth is NEVER optional:
 * without a token, any website the user visits could CSRF the localhost
 * dashboard into starting/stopping agents or streaming journal logs.
 */
function resolveWebToken(): string {
  const fromEnv = process.env.SWITCHROOM_WEB_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const home = process.env.HOME ?? homedir();
  const tokenPath = join(home, ".switchroom", "web-token");
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) return existing;
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token + "\n", { encoding: "utf8", mode: 0o600 });
  return token;
}

/**
 * Reject requests whose Origin doesn't belong to our own localhost-bound
 * server. Prevents a malicious page the user happens to load in a browser
 * from issuing same-site-ish requests to 127.0.0.1:<port> and piggy-backing
 * on any ambient credentials a browser might attach. We accept requests
 * with NO Origin header (CLI / curl / same-origin) but block any Origin
 * that isn't http[s]://localhost[:port] or http[s]://127.0.0.1[:port].
 */
function isOriginAllowed(req: Request, port: number): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  const allowed = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
  return allowed.includes(origin);
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Browsers can't set Authorization on WebSocket upgrades, but they CAN set
  // Sec-WebSocket-Protocol — client does `new WebSocket(url, ["bearer", token])`.
  const wsProto = req.headers.get("Sec-WebSocket-Protocol");
  if (wsProto) {
    const parts = wsProto.split(",").map((s) => s.trim());
    const idx = parts.indexOf("bearer");
    if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  }
  return null;
}

function checkAuth(req: Request, token: string): Response | null {
  const presented = extractBearerToken(req);
  if (!presented || !constantTimeEqual(presented, token)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

function checkWsAuth(req: Request, token: string): boolean {
  const presented = extractBearerToken(req);
  return presented !== null && constantTimeEqual(presented, token);
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

export function startWebServer(config: SwitchroomConfig, port: number): { token: string } {
  const uiDirRaw = resolve(import.meta.dirname, "ui");
  // Resolve symlinks once at startup so the traversal check compares real paths.
  const uiDir = existsSync(uiDirRaw) ? realpathSync(uiDirRaw) : uiDirRaw;
  const token = resolveWebToken();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Cross-origin requests from any page the user happens to load in a
      // browser must not reach the privileged API. Reject anything whose
      // Origin isn't our own loopback. Requests with no Origin (CLI, curl,
      // same-origin fetches) are still allowed.
      if (!isOriginAllowed(req, port)) {
        return new Response("Forbidden", { status: 403 });
      }

      // Handle CORS preflight — not needed for localhost-only server
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      // WebSocket upgrade
      if (pathname === "/ws") {
        if (!checkWsAuth(req, token)) {
          return new Response("Unauthorized", { status: 401 });
        }
        // If the client sent a Sec-WebSocket-Protocol header for auth, echo
        // back "bearer" so the negotiated subprotocol is valid.
        const wsProto = req.headers.get("Sec-WebSocket-Protocol");
        const headers =
          wsProto && wsProto.split(",").map((s) => s.trim()).includes("bearer")
            ? { "Sec-WebSocket-Protocol": "bearer" }
            : undefined;
        const upgraded = server.upgrade(req, headers ? { headers } : undefined);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      // API routes — require auth if SWITCHROOM_WEB_TOKEN is set
      const route = parseRoute(pathname, req.method);
      if (route) {
        const authError = checkAuth(req, token);
        if (authError) return authError;

        switch (route.handler) {
          case "getAgents":
            return jsonResponse(handleGetAgents(config));

          case "getLogs": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const rawLines = Number(url.searchParams.get("lines") ?? "50");
            const lines =
              Number.isInteger(rawLines) && rawLines >= 1 && rawLines <= 10000
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

      // Resolve symlinks before comparing so traversal via symlinked uiDir
      // (or symlinks inside it) can't escape the static root.
      if (!existsSync(fullPath)) {
        return new Response("Not Found", { status: 404 });
      }
      let realFullPath: string;
      try {
        realFullPath = realpathSync(fullPath);
      } catch {
        return new Response("Not Found", { status: 404 });
      }
      const rel = relative(uiDir, realFullPath);
      if (rel.startsWith("..") || resolve(uiDir, rel) !== realFullPath) {
        return new Response("Forbidden", { status: 403 });
      }

      const ext = extname(realFullPath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = readFileSync(realFullPath);
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
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
            // Only allow subscribing to agents that actually exist in config.
            if (!agentName || !config.agents[agentName]) {
              try {
                ws.send(JSON.stringify({ type: "error", error: "Unknown agent" }));
              } catch {}
              return;
            }

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
  return { token };
}
