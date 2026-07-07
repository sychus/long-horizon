/**
 * Event types consumed by the extension.
 *
 * These MUST match the types in src/events.ts (the proxy's source of truth).
 * The extension only needs the event types — not the JSON-RPC types or
 * narrowing helpers.
 */

/** Default WebSocket port — must match package.json "long-horizon.wsPort" default. */
export const DEFAULT_WS_PORT = 19420;

export type JsonRpcId = string | number;

export type Direction = "client->server" | "server->client";

export type LongHorizonEventKind =
  | "request"
  | "response"
  | "notification"
  | "non-json"
  | "palace"
  | "session-start";

interface LongHorizonEventBase {
  ts: string;
  direction: Direction;
  bytes: number;
  tokens: number;
  id: JsonRpcId | null;
  summary: string;
}

export interface RequestEvent extends LongHorizonEventBase {
  kind: "request";
  method: string;
  tool: string | null;
}

export interface ResponseEvent extends LongHorizonEventBase {
  kind: "response" | "notification";
  method: string | null;
  latencyMs: number | null;
  isError: boolean;
}

export interface NonJsonEvent extends LongHorizonEventBase {
  kind: "non-json";
}

export interface PalaceLocation {
  wing: string | null;
  room: string | null;
  drawerId: string | null;
}

export interface PalaceHit {
  wing: string;
  room: string;
  drawerId: string | null;
  distance: number | null;
  preview: string | null;
}

export interface PalaceEvent extends LongHorizonEventBase {
  kind: "palace";
  method: "tools/call";
  tool: string;
  location: PalaceLocation | null;
  hits: PalaceHit[];
  latencyMs: number | null;
  isError: boolean;
}

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
