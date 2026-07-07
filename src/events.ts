/**
 * The shared contract between the proxy and the VS Code extension.
 *
 * This file is the single source of truth for what "an observed MemPalace
 * interaction" looks like. The proxy produces `LensEvent`s; the extension
 * consumes them. Define it once here, import it on both sides, and the two
 * halves can never drift apart — that is the entire reason this project is
 * in TypeScript.
 */

// ---- JSON-RPC (the wire format the MCP stdio transport speaks) -----------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A server-initiated notification has a method but no id. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

// ---- Lens events (what the UI actually renders) --------------------------

export type Direction = "client->server" | "server->client";

export type LongHorizonEventKind =
  | "request"
  | "response"
  | "notification"
  | "non-json";

interface LongHorizonEventBase {
  /** ISO-8601 timestamp of when the proxy observed the message. */
  ts: string;
  direction: Direction;
  /** Byte size of the raw framed line. */
  bytes: number;
  /** Estimated token cost of this message's payload. */
  tokens: number;
  /** JSON-RPC id used to correlate a response back to its request. */
  id: JsonRpcId | null;
  /** One-line human-readable summary for logs / compact UI rows. */
  summary: string;
}

/** A request or client notification travelling client -> server. */
export interface RequestEvent extends LongHorizonEventBase {
  kind: "request";
  method: string;
  /** For `tools/call`, the MemPalace tool name (e.g. "mempalace_search"). */
  tool: string | null;
}

/** A response (or server notification) travelling server -> client. */
export interface ResponseEvent extends LongHorizonEventBase {
  kind: "response" | "notification";
  method: string | null;
  /** Round-trip time in ms, when this response matched a pending request. */
  latencyMs: number | null;
  isError: boolean;
}

/** A line that was not valid JSON — surfaced instead of silently dropped. */
export interface NonJsonEvent extends LongHorizonEventBase {
  kind: "non-json";
}

// ---- Palace-enriched events ------------------------------------------------

export interface PalaceLocation {
  wing: string | null;
  room: string | null;
  drawerId: string | null;
}

export interface PalaceHit {
  wing: string;
  room: string;
  drawerId: string | null;
  /** Cosine distance for search results (lower = closer). */
  distance: number | null;
  /** Content preview (first 120 chars). */
  preview: string | null;
}

/** A tools/call enriched with MemPalace spatial context. */
export interface PalaceEvent extends LongHorizonEventBase {
  kind: "palace";
  method: "tools/call";
  tool: string;
  location: PalaceLocation | null;
  hits: PalaceHit[];
  latencyMs: number | null;
  isError: boolean;
}

/** Emitted once at proxy startup. */
export interface SessionStartEvent {
  kind: "session-start";
  ts: string;
  proxyVersion: string;
  downstreamCmd: string;
  wsPort: number;
}

export type LongHorizonEvent =
  | RequestEvent
  | ResponseEvent
  | NonJsonEvent
  | PalaceEvent
  | SessionStartEvent;

// ---- narrowing helpers ---------------------------------------------------

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg && msg.id !== undefined;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg && msg.id !== undefined);
}
