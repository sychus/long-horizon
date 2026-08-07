#!/usr/bin/env node
/**
 * long-horizon proxy
 *
 * Sits transparently between an MCP client (Claude Code) and the MemPalace
 * docker container, speaking the stdio JSON-RPC transport on both sides:
 *
 *   client  <--stdio-->  [ this proxy ]  <--stdio-->  docker run ... mempalace
 *
 * Every message is forwarded verbatim (the client must not notice the proxy)
 * and observed: parsed, timestamped, token-estimated, and pushed to the
 * WebSocket server + in-memory buffer as a LongHorizonEvent.
 *
 * MemPalace tools/call pairs are enriched into PalaceEvents with spatial
 * metadata (wing, room, drawer, hits, distance).
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { estimateTokens } from "./tokens.js";
import { enrich } from "./enrich.js";
import { startServer } from "./server.js";
// ---- config -------------------------------------------------------------
const DOWNSTREAM_CMD = process.env.LENS_CMD ?? "docker";
const DOWNSTREAM_ARGS = process.env.LENS_ARGS
    ? JSON.parse(process.env.LENS_ARGS)
    : ["run", "-i", "--rm", "-v", "mempalace-data:/data", "mempalace"];
const WS_PORT = Number(process.env.HORIZON_WS_PORT ?? "19420");
const PROXY_VERSION = "1.0.0";
// ---- event sink ----------------------------------------------------------
let server = null;
/** Correlate responses back to their originating request by JSON-RPC id. */
const pending = new Map();
function emit(event) {
    server?.emit(event);
    if ("direction" in event) {
        process.stderr.write(`[lens] ${event.direction} ${event.summary}\n`);
    }
}
const nowIso = () => new Date().toISOString();
function parse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
function observe(direction, rawLine) {
    const bytes = Buffer.byteLength(rawLine, "utf8");
    const tokens = estimateTokens(rawLine);
    const msg = parse(rawLine);
    if (!msg) {
        emit({
            kind: "non-json",
            ts: nowIso(),
            direction,
            bytes,
            tokens,
            id: null,
            summary: `non-json ${bytes}B`,
        });
        return;
    }
    const id = "id" in msg && msg.id != null ? msg.id : null;
    if (direction === "client->server" && "method" in msg) {
        const req = msg;
        const tool = req.method === "tools/call"
            ? (req.params?.name ?? null)
            : null;
        if (id != null) {
            pending.set(String(id), {
                method: req.method,
                tsSent: Date.now(),
                tool,
                args: req.params?.arguments ?? {},
            });
        }
        emit({
            kind: "request",
            ts: nowIso(),
            direction,
            bytes,
            tokens,
            id,
            method: req.method,
            tool,
            summary: `req ${req.method}${tool ? `:${tool}` : ""} (~${tokens}tok)`,
        });
        return;
    }
    // server -> client: a response (has id, no method) or a notification.
    const method = "method" in msg ? msg.method : null;
    const req = id != null ? pending.get(String(id)) : undefined;
    if (id != null)
        pending.delete(String(id));
    const latencyMs = req ? Date.now() - req.tsSent : null;
    const isError = "error" in msg && msg.error != null;
    // Try to enrich mempalace tools/call into a PalaceEvent
    if (req?.tool && !method) {
        const response = msg;
        const enriched = enrich({
            ts: nowIso(),
            tool: req.tool,
            args: req.args,
            result: response.result,
            bytes,
            tokens,
            id,
            latencyMs,
            isError,
        });
        if (enriched) {
            emit(enriched);
            return;
        }
    }
    const label = req?.method ?? method ?? "?";
    emit({
        kind: method ? "notification" : "response",
        ts: nowIso(),
        direction,
        bytes,
        tokens,
        id,
        method: method ?? req?.method ?? null,
        latencyMs,
        isError,
        summary: `res ${label} ~${tokens}tok${latencyMs != null ? ` ${latencyMs}ms` : ""}${isError ? " ERROR" : ""}`,
    });
}
// ---- bootstrap -----------------------------------------------------------
async function main() {
    server = await startServer(WS_PORT);
    process.stderr.write(`[lens] ws server on :${server.port}\n`);
    // Emit session-start
    emit({
        kind: "session-start",
        ts: nowIso(),
        proxyVersion: PROXY_VERSION,
        downstreamCmd: DOWNSTREAM_CMD,
        wsPort: server.port,
    });
    // Spawn downstream
    const child = spawn(DOWNSTREAM_CMD, DOWNSTREAM_ARGS, {
        stdio: ["pipe", "pipe", "inherit"],
    });
    child.on("error", (err) => {
        process.stderr.write(`[lens] failed to spawn downstream: ${err.message}\n`);
        process.exit(1);
    });
    child.on("exit", (code) => {
        process.stderr.write(`[lens] downstream exited code=${code}\n`);
        server?.close().then(() => process.exit(code ?? 0));
    });
    // client stdin -> observe -> child stdin
    const fromClient = readline.createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
    });
    fromClient.on("line", (line) => {
        if (line.length === 0)
            return;
        observe("client->server", line);
        child.stdin.write(line + "\n");
    });
    fromClient.on("close", () => child.stdin.end());
    // child stdout -> observe -> client stdout
    const fromServer = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
    });
    fromServer.on("line", (line) => {
        if (line.length === 0)
            return;
        observe("server->client", line);
        process.stdout.write(line + "\n");
    });
    process.stderr.write(`[lens] proxy up. downstream=${DOWNSTREAM_CMD} ws=:${server.port}\n`);
}
main().catch((err) => {
    process.stderr.write(`[lens] fatal: ${err}\n`);
    process.exit(1);
});
