#!/usr/bin/env node
// Phase 0 spike broker. Listens on per-agent unix sockets:
//   /run/switchroom/broker/<agent>/sock
// On accept, getsockname() returns the bound socket path; the agent
// identity is derived from the path component <agent>. ACL is path-derived.
//
// Wire protocol: newline-delimited JSON request, single JSON response.
//   { op: "read", key: "<key>" }
//   -> { ok: true, value: "..." } | { ok: false, error: "...", reason: "..." }

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/run/switchroom/broker";
const AGENTS = (process.env.AGENTS || "alice,bob").split(",").map((s) => s.trim()).filter(Boolean);

// Tighten umask broker-process-wide before any inode is created. Any
// socket inode (created by net.Server.listen) and any directory we
// create will be born at a maximally-restricted mode; the explicit
// chmod calls then widen *only* to the intended mode. This closes the
// mkdir→chmod race window flagged by the adversarial review.
process.umask(0o077);

// Stub secret store. Each secret is owned by exactly one agent.
// ACL: agent X may read keys "<X>-*"; everything else is denied.
const SECRETS = {
  "alice-secret": "alice-treasure",
  "alice-config": "alice-config-blob",
  "bob-secret": "bob-treasure",
  "bob-config": "bob-config-blob",
};

function checkAclByAgent(agent, key) {
  // Path-derived agent identity → ACL decision.
  if (typeof agent !== "string" || !agent) {
    return { allow: false, reason: "no agent identity resolved" };
  }
  if (!Object.prototype.hasOwnProperty.call(SECRETS, key)) {
    return { allow: false, reason: `unknown key '${key}'` };
  }
  const expectedOwner = key.split("-", 1)[0];
  if (expectedOwner !== agent) {
    return { allow: false, reason: `key '${key}' not in ACL for ${agent}` };
  }
  return { allow: true };
}

function socketPathToAgent(sockPath) {
  // /run/switchroom/broker/<agent>/sock → <agent>
  const parts = sockPath.split(path.sep).filter(Boolean);
  // expect ['run','switchroom','broker','<agent>','sock']
  const idx = parts.indexOf("broker");
  if (idx >= 0 && parts.length >= idx + 3 && parts[idx + 2] === "sock") {
    return parts[idx + 1];
  }
  return null;
}

// Look up agent UIDs from /etc/passwd inside this container.
function lookupUid(name) {
  const passwd = fs.readFileSync("/etc/passwd", "utf8");
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f[0] === name) return parseInt(f[2], 10);
  }
  throw new Error(`no such user: ${name}`);
}

function ensureSocketDir(agent) {
  const dir = path.join(ROOT, agent);
  const uid = lookupUid(agent);
  // Create the dir already at mode 0700 so there is no umask-derived
  // window (typically 0755) between mkdir and a follow-up chmod where
  // a racing peer could open/connect/squat. mkdirSync's `mode` option
  // is applied atomically at creation. We then chown — chown does not
  // widen permissions, so the dir is never world-readable.
  // recursive:true is fine here even with mode: parent dirs that
  // already exist are not re-permed; only the final segment is created
  // with this mode (Node ≥10 semantics).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Belt-and-braces: if the dir already existed (e.g. across broker
  // restart on a persistent named volume) mkdirSync won't re-apply the
  // mode — re-assert it explicitly. chmod widens nothing if it was
  // already 0700; if it was wider, this narrows it.
  fs.chmodSync(dir, 0o700);
  fs.chownSync(dir, uid, uid);
  return dir;
}

function listenForAgent(agent) {
  const dir = ensureSocketDir(agent);
  const sockPath = path.join(dir, "sock");
  try { fs.unlinkSync(sockPath); } catch {}

  const server = net.createServer((conn) => {
    const bound = server.address(); // string (UDS path)
    const resolvedAgent = socketPathToAgent(bound);

    // SO_PEERCRED column intentionally omitted from the spike — Node has
    // no built-in capture and the matrix downgrades it to a forensics-only
    // signal under the path-derived identity model. Adding native
    // SO_PEERCRED is in-scope for Phase 2's production broker, not here.

    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let req;
      try { req = JSON.parse(line); }
      catch (e) {
        conn.end(JSON.stringify({ ok: false, error: "bad-json" }) + "\n");
        return;
      }
      const decision = checkAclByAgent(resolvedAgent, req.key);
      let resp;
      if (decision.allow) {
        resp = { ok: true, agent: resolvedAgent, key: req.key, value: SECRETS[req.key], boundSocket: bound };
      } else {
        resp = { ok: false, agent: resolvedAgent, key: req.key, error: "acl-deny", reason: decision.reason, boundSocket: bound };
      }
      conn.end(JSON.stringify(resp) + "\n");
    });
  });

  server.listen(sockPath, () => {
    // Order matters: chown FIRST (transferring ownership to the agent
    // uid while the inode is still at the umask-tight 0700), THEN
    // chmod to the intended 0660. With process umask 0o077 set at
    // startup, the socket inode is born ≤0700 owned by root — so at
    // every instant before the final chmod, no non-root peer can use
    // it. After the final chmod the inode is 0660 owned by the agent
    // uid, and the parent dir's 0700+agent-uid still gates access.
    fs.chownSync(sockPath, lookupUid(agent), lookupUid(agent));
    fs.chmodSync(sockPath, 0o660);
    process.stdout.write(`broker: listening for ${agent} on ${sockPath} (bound=${server.address()})\n`);
  });
  return server;
}

const servers = AGENTS.map(listenForAgent);

function shutdown() {
  for (const s of servers) { try { s.close(); } catch {} }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
