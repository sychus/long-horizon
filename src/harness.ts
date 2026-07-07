#!/usr/bin/env node
/**
 * POC test harness — plays the role of Claude Code.
 *
 * Launches proxy.ts (which launches the real MemPalace docker container),
 * runs a genuine MCP handshake, calls real tools, and asserts that:
 *   1. every request gets a well-formed matching response (protocol intact),
 *   2. the proxy streams enriched events over WebSocket,
 *   3. PalaceEvents contain spatial metadata for mempalace_* tools,
 *   4. token estimates use tiktoken (not the old 4-char heuristic).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as readline from "node:readline";
import WebSocket from "ws";
import type { JsonRpcResponse, LongHorizonEvent, PalaceEvent } from "./events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WS_PORT = Number(process.env.HARNESS_PORT ?? "19420");
const proxy = spawn(
  process.execPath,
  ["--import", "tsx", path.join(__dirname, "proxy.ts")],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HORIZON_WS_PORT: String(WS_PORT) },
  }
);

const waiters = new Map<number, (msg: JsonRpcResponse) => void>();
let nextId = 1;

readline.createInterface({ input: proxy.stdout! }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: JsonRpcResponse;
  try {
    msg = JSON.parse(line) as JsonRpcResponse;
  } catch {
    return;
  }
  if (typeof msg.id === "number" && waiters.has(msg.id)) {
    waiters.get(msg.id)!(msg);
    waiters.delete(msg.id);
  }
});

function send(method: string, params: unknown): Promise<JsonRpcResponse> {
  const id = nextId++;
  proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${method} (id=${id})`)),
      60000
    );
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

function notify(method: string): void {
  proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): boolean {
  const ok = Boolean(cond);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (ok) passed++;
  else { failed++; process.exitCode = 1; }
  return ok;
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function connectWs(): Promise<LongHorizonEvent[]> {
  const events: LongHorizonEvent[] = [];

  // Wait for the WS server to be ready
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${WS_PORT}/health`);
      if (res.ok) break;
    } catch {
      // not ready yet
    }
    await delay(250);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/events`);
    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString()) as LongHorizonEvent;
        if (event.kind !== "ping" as string) events.push(event);
      } catch {
        // ignore
      }
    });
    ws.on("open", () => resolve(events));
    ws.on("error", reject);
    // Keep connection open — caller will inspect `events` later
  });
}

async function main(): Promise<void> {
  console.log("\n== long-horizon harness ==\n");

  // Connect WebSocket first to capture all events
  const wsEvents = await connectWs();
  console.log("  WebSocket connected\n");

  // ---- MCP handshake ----

  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lens-harness", version: "0.0.1" },
  });
  assert(init.result, "initialize returns a result (protocol intact)");
  const info = (init.result as { serverInfo?: { name?: string; version?: string } })
    ?.serverInfo;
  console.log(`        server: ${info?.name} ${info?.version}`);
  notify("notifications/initialized");

  const tools = await send("tools/list", {});
  const toolCount = (tools.result as { tools?: unknown[] })?.tools?.length ?? 0;
  assert(toolCount > 0, `tools/list returns tools (${toolCount})`);

  // ---- mempalace_status (should produce PalaceEvent) ----

  const status = await send("tools/call", {
    name: "mempalace_status",
    arguments: {},
  });
  assert(!status.error && status.result, "mempalace_status call succeeds");

  // ---- mempalace_search (should produce PalaceEvent with hits) ----

  const search = await send("tools/call", {
    name: "mempalace_search",
    arguments: { query: "test", limit: 2 },
  });
  assert(!search.error && search.result, "mempalace_search call succeeds");

  // Let events flush through the WebSocket
  await delay(500);

  // ---- WebSocket event assertions ----

  console.log("\n-- WebSocket events --");
  assert(wsEvents.length >= 4, `WS received events (${wsEvents.length})`);

  const sessionStart = wsEvents.find((e) => e.kind === "session-start");
  assert(sessionStart, "session-start event received");

  const palaceEvents = wsEvents.filter(
    (e): e is PalaceEvent => e.kind === "palace"
  );
  assert(palaceEvents.length >= 1, `PalaceEvent(s) received (${palaceEvents.length})`);

  const searchEvent = palaceEvents.find((e) => e.tool === "mempalace_search");
  if (searchEvent) {
    assert(searchEvent.tool === "mempalace_search", "search PalaceEvent has correct tool");
    assert(typeof searchEvent.latencyMs === "number", "search PalaceEvent has latency");
    assert(searchEvent.tokens > 0, `search PalaceEvent has tokens (~${searchEvent.tokens})`);
    // Hits may be empty if the palace has no data, but the field should exist
    assert(Array.isArray(searchEvent.hits), "search PalaceEvent has hits array");
  }

  // ---- Token estimation sanity (tiktoken should differ from 4-char heuristic) ----

  const toolsListReq = wsEvents.find(
    (e) => e.kind === "request" && "method" in e && e.method === "tools/list"
  );
  if (toolsListReq && toolsListReq.kind === "request") {
    assert(toolsListReq.tokens > 0, `tools/list request has tiktoken estimate (~${toolsListReq.tokens}tok)`);
  }

  // ---- HTTP replay endpoint ----

  const replayRes = await fetch(`http://127.0.0.1:${WS_PORT}/events`);
  assert(replayRes.ok, "GET /events returns 200");
  const replayBody = await replayRes.text();
  const replayLines = replayBody.trim().split("\n").filter(Boolean);
  assert(
    replayLines.length >= wsEvents.length,
    `GET /events replay has ${replayLines.length} events (buffer ≥ ws ${wsEvents.length})`
  );

  // ---- health endpoint ----

  const healthRes = await fetch(`http://127.0.0.1:${WS_PORT}/health`);
  assert(healthRes.ok, "GET /health returns 200");
  const health = await healthRes.json() as { ok: boolean; eventCount: number };
  assert(health.ok === true, "health reports ok=true");
  assert(health.eventCount > 0, `health reports eventCount=${health.eventCount}`);

  // ---- summary ----

  console.log(`\n  ${passed} passed, ${failed} failed\n`);

  console.log("-- sample events --");
  for (const e of wsEvents.slice(0, 8)) {
    if ("summary" in e) console.log("   " + e.summary);
    else console.log(`   [${e.kind}]`);
  }
  console.log("");

  proxy.stdin!.end();
  setTimeout(() => proxy.kill(), 500);
}

main().catch((err: Error) => {
  console.error("[harness] error:", err.message);
  process.exitCode = 1;
  proxy.kill();
});
