/**
 * HTTP + WebSocket server for the long-horizon proxy.
 *
 * - `ws://localhost:{port}/events` — live event stream (one JSON message per event)
 * - `GET /events`    — replay all buffered events as application/x-ndjson
 * - `GET /taxonomy`  — cached palace taxonomy (fetched once from MemPalace at boot)
 * - `GET /health`    — uptime + event count
 *
 * Events are buffered in-memory. No file I/O.
 */
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
export function startServer(port) {
    const buffer = [];
    let taxonomy = null;
    const startTime = Date.now();
    const httpServer = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                ok: true,
                uptime: Date.now() - startTime,
                eventCount: buffer.length,
            }));
            return;
        }
        if (req.method === "GET" && req.url === "/events") {
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            for (const event of buffer) {
                res.write(JSON.stringify(event) + "\n");
            }
            res.end();
            return;
        }
        if (req.method === "GET" && req.url === "/taxonomy") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(taxonomy));
            return;
        }
        res.writeHead(404);
        res.end("Not found");
    });
    const wss = new WebSocketServer({ server: httpServer, path: "/events" });
    // Replay buffered events to newly connected clients
    wss.on("connection", (ws) => {
        for (const event of buffer) {
            ws.send(JSON.stringify(event));
        }
    });
    let heartbeatTimer = null;
    function emit(event) {
        buffer.push(event);
        const json = JSON.stringify(event);
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
            }
        }
    }
    return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(port, "127.0.0.1", () => {
            const addr = httpServer.address();
            const actualPort = typeof addr === "object" && addr ? addr.port : port;
            heartbeatTimer = setInterval(() => {
                const ping = JSON.stringify({ kind: "ping" });
                for (const client of wss.clients) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(ping);
                    }
                }
            }, 30_000);
            resolve({
                emit,
                setTaxonomy(t) { taxonomy = t; },
                async close() {
                    if (heartbeatTimer)
                        clearInterval(heartbeatTimer);
                    wss.close();
                    await new Promise((r) => httpServer.close(() => r()));
                },
                get port() { return actualPort; },
            });
        });
    });
}
