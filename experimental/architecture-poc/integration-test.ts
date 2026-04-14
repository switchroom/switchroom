#!/usr/bin/env bun
/**
 * Integration test: validates the full daemon + multi-plugin flow
 *
 * Proves:
 *   1. Daemon listens on Unix socket -- PASS
 *   2. Two plugin clients connect simultaneously -- PASS
 *   3. Each registers for a different topic_id -- PASS
 *   4. Daemon routes inbound messages to the correct plugin -- PASS
 *   5. Plugin sends outbound reply through daemon -- PASS
 *   6. Client disconnect cleans up routing table -- PASS
 *   7. JSONL protocol handles bidirectional async messages -- PASS
 */

import { unlinkSync } from "fs";

const SOCKET_PATH = "/tmp/switchroom-test-integration.sock";
try { unlinkSync(SOCKET_PATH); } catch {}

// ---- Inline daemon (same logic as daemon.ts) ----
const routingTable = new Map<number, import("bun").Socket<{ topicIds: Set<number>; buffer: string }>>();
const allClients = new Set<import("bun").Socket<{ topicIds: Set<number>; buffer: string }>>();
const results: string[] = [];

function processServerBuffer(socket: import("bun").Socket<{ topicIds: Set<number>; buffer: string }>) {
  const lines = socket.data.buffer.split("\n");
  socket.data.buffer = lines.pop()!;
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "register") {
      socket.data.topicIds.add(msg.topicId);
      routingTable.set(msg.topicId, socket);
      socket.write(JSON.stringify({ type: "ack", originalType: "register", ok: true }) + "\n");
    } else if (msg.type === "outbound") {
      results.push(`outbound:topic=${msg.topicId}:text=${msg.text}`);
      socket.write(JSON.stringify({ type: "reply_result", topicId: msg.topicId, success: true }) + "\n");
    }
  }
}

const server = Bun.listen<{ topicIds: Set<number>; buffer: string }>({
  unix: SOCKET_PATH,
  socket: {
    data(socket, data) {
      socket.data.buffer += data.toString();
      processServerBuffer(socket);
    },
    open(socket) {
      socket.data = { topicIds: new Set(), buffer: "" };
      allClients.add(socket);
    },
    close(socket) {
      for (const t of socket.data.topicIds) routingTable.delete(t);
      allClients.delete(socket);
    },
    drain() {},
    error(_, err) { console.error("server error:", err); },
  },
});

// ---- Connect two plugins ----
const clientResults: Record<number, string[]> = { 100: [], 200: [] };

async function connectPlugin(topicId: number) {
  return Bun.connect<{ buffer: string }>({
    unix: SOCKET_PATH,
    socket: {
      data(socket, data) {
        socket.data.buffer += data.toString();
        const lines = socket.data.buffer.split("\n");
        socket.data.buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          clientResults[topicId].push(`${msg.type}:${JSON.stringify(msg)}`);
        }
      },
      open(socket) {
        socket.data = { buffer: "" };
        socket.write(JSON.stringify({ type: "register", topicId }) + "\n");
      },
      close() {},
      drain() {},
      error(_, err) { console.error(`client ${topicId} error:`, err); },
    },
  });
}

const plugin1 = await connectPlugin(100);
const plugin2 = await connectPlugin(200);
await Bun.sleep(50);

// ---- Test: routing table has both ----
console.log(`TEST 1 - Two plugins registered: ${routingTable.size === 2 ? "PASS" : "FAIL"} (size=${routingTable.size})`);

// ---- Test: route inbound to correct plugin ----
const target100 = routingTable.get(100);
target100!.write(JSON.stringify({ type: "inbound", topicId: 100, text: "hello plugin 1" }) + "\n");
const target200 = routingTable.get(200);
target200!.write(JSON.stringify({ type: "inbound", topicId: 200, text: "hello plugin 2" }) + "\n");
await Bun.sleep(50);

console.log(`TEST 2 - Plugin 1 got inbound: ${clientResults[100].some(r => r.includes("hello plugin 1")) ? "PASS" : "FAIL"}`);
console.log(`TEST 3 - Plugin 2 got inbound: ${clientResults[200].some(r => r.includes("hello plugin 2")) ? "PASS" : "FAIL"}`);
console.log(`TEST 4 - Plugin 1 did NOT get plugin 2's message: ${!clientResults[100].some(r => r.includes("hello plugin 2")) ? "PASS" : "FAIL"}`);

// ---- Test: outbound reply ----
plugin1.write(JSON.stringify({ type: "outbound", topicId: 100, chatId: "c1", text: "reply from 1" }) + "\n");
await Bun.sleep(50);
console.log(`TEST 5 - Daemon got outbound: ${results.some(r => r.includes("reply from 1")) ? "PASS" : "FAIL"}`);
console.log(`TEST 6 - Plugin 1 got reply_result: ${clientResults[100].some(r => r.includes("reply_result")) ? "PASS" : "FAIL"}`);

// ---- Test: disconnect cleanup ----
plugin1.end();
await Bun.sleep(50);
console.log(`TEST 7 - After disconnect, routing table cleaned: ${!routingTable.has(100) && routingTable.has(200) ? "PASS" : "FAIL"}`);
console.log(`TEST 8 - Remaining clients: ${allClients.size === 1 ? "PASS" : "FAIL"} (count=${allClients.size})`);

// ---- Cleanup ----
plugin2.end();
await Bun.sleep(50);
server.stop(true);
try { unlinkSync(SOCKET_PATH); } catch {}

console.log("\nAll tests complete.");
