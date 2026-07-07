# Technical Specification: long-horizon

**Document Status:** Draft
**Version:** 1.0
**Date:** 2026-07-06
**Last Updated:** 2026-07-06

## Executive Summary

**Problem:** MemPalace runs as an MCP stdio server inside Docker. There is zero visibility into what Claude Code retrieves, how much token budget each retrieval consumes, or what spatial path the agent walks through the palace. Letta/Zep visualize static memory — nobody shows the live TRAVERSAL (wing → room → tunnel → room) plus its token cost.

**Solution:** A VS Code extension backed by a transparent stdio proxy that intercepts every JSON-RPC message between Claude Code and MemPalace, emits structured events, and renders them as (1) a live timeline with token costs, (2) a spatial palace map showing the retrieval path, and (3) a session stats dashboard.

**Impact:** Developers using MemPalace can see WHERE their token budget goes, WHICH palace paths are hot, and WHETHER retrieval is efficient — in real time, without modifying MemPalace or Claude Code.

---

## 1. Context

### Background

MemPalace organizes long-term memory in a spatial metaphor:

| Concept | Role | Analogy |
|---------|------|---------|
| **Wing** | Top-level namespace (project, person, agent) | Building wing |
| **Room** | Topic within a wing (backend, decisions, meetings) | Room in that wing |
| **Drawer** | Single piece of verbatim content inside a room | Filing cabinet drawer |
| **Hallway** | Intra-wing co-occurrence link between entities (built at mine time) | Corridor connecting rooms |
| **Tunnel** | Explicit cross-wing link (e.g., API design ↔ DB schema) | Underground passage between wings |

A typical retrieval session looks like:

```
search("auth flow")
  → hits wing_prowler / room_backend (drawer #42, distance 0.3)
  → hits wing_prowler / room_decisions (drawer #78, distance 0.5)
traverse("backend")
  → discovers tunnel to wing_infra / room_terraform
follow_tunnels(wing="prowler", room="backend")
  → returns connected rooms in wing_infra with drawer previews
```

The POC (validated) proves the proxy can intercept this traffic transparently. This spec defines the full system.

### What exists today (POC)

| Component | Status |
|-----------|--------|
| `src/events.ts` — shared type contract | ✅ Validated |
| `src/tokens.ts` — token estimation (~4 chars/tok) | ✅ Validated |
| `src/proxy.ts` — transparent stdio proxy | ✅ Validated |
| `src/harness.ts` — test harness | ✅ Validated |
| Extension / UI | ❌ Not started |
| Real-time channel (proxy → extension) | ❌ Not started |
| Palace-aware event enrichment | ❌ Not started |

### POC Findings

- Protocol intact: full MCP handshake passes through proxy unmodified.
- `tools/list` alone = **~4604 tokens** of overhead per session (7× a typical `mempalace_search` response at ~644 tok). This is the first thing the UI must surface.
- Latency is measurable per request-response pair via JSON-RPC id correlation.

---

## 2. Architecture

```
┌─────────────┐  stdio   ┌──────────────────────┐  stdio    ┌───────────────┐
│ Claude Code  │ ───────► │mempalace-long-horizon│ ───────► │  MemPalace    │
│  (MCP client)│ ◄─────── │     proxy            │ ◄─────── │  (Docker)     │
└─────────────┘           │                      │          └───────────────┘
                          │  ┌────────────────┐  │
                          │  │ Event Enricher │  │
                          │  └───────┬────────┘  │
                          └──────────┼───────────┘
                                     │
                          ┌──────────▼───────────┐
                          │   WebSocket server   │
                          │   :19420 (default)   │
                          └──────────┬───────────┘
                                     │ ws://
                          ┌──────────▼───────────┐
                          │  VS Code Extension   │
                          │  ┌─────────────────┐ │
                          │  │ Timeline Panel  │ │
                          │  │ Palace Map      │ │
                          │  │ Stats Bar       │ │
                          │  └─────────────────┘ │
                          └──────────────────────┘
```

### Key constraints

1. **Proxy is the ONLY process that spawns the Docker container.** MemPalace uses a file lock; two writers crash. The proxy owns the child process lifecycle.
2. **The proxy must be transparent.** Claude Code must not detect its presence. Every byte is forwarded verbatim. Zero modification to the JSON-RPC stream.
3. **Extension is read-only.** It observes events. It never injects messages into the stdio pipe.

---

## 3. Event Contract

### 3.1 Current events (from POC)

The base `LongHorizonEvent` discriminated union remains as-is:

```typescript
type LongHorizonEventKind = "request" | "response" | "notification" | "non-json";
type Direction = "client->server" | "server->client";
```

Every event carries: `ts`, `direction`, `bytes`, `tokens`, `id`, `summary`.

- **RequestEvent**: adds `method`, `tool` (extracted tool name for `tools/call`).
- **ResponseEvent**: adds `method`, `latencyMs`, `isError`.
- **NonJsonEvent**: raw bytes that weren't valid JSON.

### 3.2 New: Enriched events

The proxy currently treats all `tools/call` equally. For palace visualization, we need to extract spatial metadata from the MemPalace-specific tool arguments and results. This is done by the **Event Enricher** — a post-parse layer inside the proxy.

New event type added to the union:

```typescript
/** A tools/call enriched with MemPalace spatial context. */
export interface PalaceEvent extends LongHorizonEventBase {
  kind: "palace";
  /** The original JSON-RPC method (always "tools/call"). */
  method: "tools/call";
  /** MemPalace tool name (e.g., "mempalace_search", "mempalace_traverse"). */
  tool: string;
  /** Spatial coordinates extracted from the request arguments. */
  location: PalaceLocation | null;
  /** Spatial coordinates extracted from the response results. */
  hits: PalaceHit[];
  /** Round-trip time in ms. */
  latencyMs: number | null;
  isError: boolean;
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
  /** Cosine distance for search results (lower = closer). */
  distance: number | null;
  /** Content preview (first 120 chars). */
  preview: string | null;
}
```

### 3.3 Tool → spatial extraction map

The enricher inspects both the request `params.arguments` and the matched response `result` to extract spatial data:

| MemPalace Tool | Request fields → `location` | Response → `hits` |
|---|---|---|
| `mempalace_search` | `wing?`, `room?` filter from args | Each result: `wing`, `room`, `drawer_id`, `distance` |
| `mempalace_traverse` | `start_room` → room | Connected rooms across wings |
| `mempalace_follow_tunnels` | `wing`, `room` | Target rooms with drawer previews |
| `mempalace_find_tunnels` | `wing_a?`, `wing_b?` | Bridging rooms |
| `mempalace_get_drawer` | `drawer_id` | Single drawer: wing, room, content |
| `mempalace_list_drawers` | `wing?`, `room?` filter | Drawer list with previews |
| `mempalace_list_rooms` | `wing?` | Rooms with counts |
| `mempalace_list_wings` | — | Wings with counts |
| `mempalace_get_taxonomy` | — | Full wing → room → count tree |
| `mempalace_add_drawer` | `wing`, `room` | Created drawer id |
| `mempalace_checkpoint` | Items: `wing`, `room` each | Filed drawer ids |
| `mempalace_kg_query` | `entity` | Relationships with optional temporal data |
| `mempalace_kg_timeline` | `entity?` | Chronological facts |
| Other tools | Best-effort extraction | — |

Non-MemPalace `tools/call` messages (if any pass through) emit standard `RequestEvent`/`ResponseEvent`, not `PalaceEvent`.

### 3.4 Session metadata event

Emitted once at proxy startup and available for the extension to show session context:

```typescript
export interface SessionStartEvent {
  kind: "session-start";
  ts: string;
  proxyVersion: string;
  downstreamCmd: string;
  wsPort: number;
}
```

---

## 4. Communication: Proxy → Extension

### 4.1 WebSocket server

The proxy starts an HTTP + WebSocket server on `localhost:19420` (configurable via `HORIZON_WS_PORT` env var).

**Endpoints:**

| Path | Protocol | Purpose |
|------|----------|---------|
| `ws://localhost:19420/events` | WebSocket | Live event stream. Sends each `LongHorizonEvent` as a JSON text frame the moment it's emitted. |
| `GET /events` | HTTP | Returns all buffered events (in-memory) as `application/x-ndjson`. For replay/catch-up on extension activation. |
| `GET /taxonomy` | HTTP | Returns cached palace taxonomy (wing → room → count). Proxy fetches this from MemPalace once at startup via a side-channel `tools/call` to `mempalace_get_taxonomy`. |
| `GET /health` | HTTP | Returns `{ ok: true, uptime, eventCount }`. Extension uses this to detect if proxy is running. |

**WebSocket protocol:**
- Each message is one JSON-serialized `LongHorizonEvent`.
- No framing beyond WebSocket's own frames. No batching. One event = one message.
- Server sends; client (extension) only receives. No client→server messages defined.
- Heartbeat: server sends `{"kind":"ping"}` every 30s if idle. Client ignores it (or uses it for connection health).

**No file persistence:** Events live in an in-memory buffer inside the proxy. Buffer lifetime = proxy process lifetime. The extension's "Export Session" command serializes the buffer on demand if the user wants to save.

### 4.2 Extension connection lifecycle

1. Extension activates → tries `GET /health` on configured port.
2. If healthy → fetches `GET /taxonomy` to pre-populate the palace map.
3. Opens `ws://…/events` + fetches `GET /events` for replay of buffered events.
4. Merges: replayed events first (deduplicated by `ts+id`), then live stream.
5. If proxy not running → shows "Proxy offline" in status bar. Retries every 5s.
6. On WebSocket disconnect → same retry loop. Replays missed events on reconnect.

---

## 5. VS Code Extension

### 5.1 Extension ID & activation

- **ID:** `mempalace-long-horizon`
- **Display name:** MemPalace Lens
- **Activation:** `onStartupFinished` (background, non-blocking).
- **Contributes:** one Webview Panel, one Status Bar Item, one Tree View.

### 5.2 UI Components

#### A. Status Bar Item (always visible)

Position: left, priority 100.

```
$(eye) Lens: 3 calls · 5.8k tok · 342ms avg
```

- Shows cumulative session stats: total tool calls, total tokens, average latency.
- Color: green (connected), yellow (replaying), red (proxy offline).
- Click → opens/focuses the Webview Panel.

#### B. Timeline Tree View (sidebar)

Activity bar icon: `$(list-unordered)`.

A standard VS Code TreeView in the sidebar showing events chronologically:

```
▼ Session 2026-07-06 14:32:01
  ► initialize                    — 128 tok  45ms
  ► tools/list                    — 4604 tok 120ms  ⚠️
  ▼ mempalace_search "auth flow"  — 644 tok  89ms
      hit: prowler/backend #42 (d=0.31)
      hit: prowler/decisions #78 (d=0.52)
  ▼ mempalace_traverse "backend"  — 312 tok  67ms
      → infra/terraform (via tunnel)
  ► mempalace_follow_tunnels      — 891 tok  103ms
```

Features:
- **Inline token badge**: each row shows estimated token cost. Rows exceeding a configurable threshold (default 2000 tok) get a `⚠️` icon.
- **Expand to see hits**: `PalaceEvent` rows expand to show `hits[]` with wing/room/distance.
- **Latency color**: green < 100ms, yellow < 500ms, red ≥ 500ms.
- **Click to inspect**: opens the raw JSON in a read-only editor tab (for debugging).

#### C. Palace Map Webview Panel (main area)

A webview panel rendering an interactive spatial map.

**Layout: force-directed graph** (using D3.js or a lightweight alternative bundled in the webview).

Nodes:
- **Wing** (large circle, labeled, colored by name hash)
- **Room** (medium circle inside/near its wing, labeled)
- **Drawer** (small dot, only shown on expand/hover)

Edges:
- **Hallway** (intra-wing, thin gray line)
- **Tunnel** (cross-wing, colored dashed line with label)

**Live animation:**
1. On session start, the map renders the full palace structure from `GET /taxonomy` (pre-fetched by proxy at startup).
2. When a `PalaceEvent` arrives:
   - The source `location` node pulses (brief highlight).
   - Each `hit` node pulses in sequence.
   - Edges traversed animate (moving dot or glow).
   - A floating token badge appears briefly near the target.
3. Accumulated heat: nodes that are accessed more frequently grow slightly / get a warmer color. This reveals hotspots.

**Controls:**
- Zoom/pan (standard D3 behavior).
- Toggle labels on/off.
- Filter by wing (dropdown).
- Reset layout button.
- Pause/resume animation.

**Implementation note:** The webview communicates with the extension host via `postMessage`. The extension host holds the event state and pushes updates to the webview. The webview is pure rendering — no WebSocket connection of its own.

### 5.3 Commands & Configuration

**Commands** (Command Palette):

| Command | ID | Description |
|---|---|---|
| Show Palace Map | `long-horizon.showMap` | Opens/focuses the webview panel |
| Show Event Timeline | `long-horizon.showTimeline` | Focuses the tree view |
| Clear Session | `long-horizon.clearSession` | Resets accumulated stats and map heat |
| Export Session | `long-horizon.exportSession` | Serializes in-memory events to a user-chosen JSONL file |

**Settings** (`contributes.configuration`):

| Setting | Type | Default | Description |
|---|---|---|---|
| `long-horizon.wsPort` | number | `19420` | WebSocket port to connect to |
| `long-horizon.tokenWarningThreshold` | number | `2000` | Token count above which a warning icon appears |
| `long-horizon.latencyWarningMs` | number | `500` | Latency above which the row turns red |
| `long-horizon.autoOpen` | boolean | `false` | Auto-open the palace map on session start |

---

## 6. Proxy Enhancements (from POC → v1)

### 6.1 Changes to `proxy.ts`

1. **Add WebSocket server**: Start an HTTP server alongside the stdio proxy. Upgrade `/events` to WebSocket. Serve `/health`, `GET /events` (from in-memory buffer), and `GET /taxonomy` (cached side-channel call).
2. **Replace JSONL file with in-memory buffer**: Remove `createWriteStream` / `EVENTS_PATH`. Events go into an array and are pushed to WebSocket clients.
3. **Add Event Enricher**: After `observe()` parses a message pair (request + matched response), run it through `enrich()` which checks if the tool is a `mempalace_*` tool and extracts spatial data into a `PalaceEvent`.
4. **Emit `SessionStartEvent`** on proxy boot.
5. **Pending response buffer**: The current `observe()` emits request and response separately. For enrichment, we need to buffer the request until its response arrives (already partially done via `pending` map), then emit the combined `PalaceEvent`. Non-palace tools continue emitting separate request/response events.
6. **Swap token estimator**: Replace the ~4chars/tok heuristic in `tokens.ts` with tiktoken (cl100k_base for Claude models).

### 6.2 New file: `src/enrich.ts`

Responsible for:
- Detecting `mempalace_*` tool calls.
- Extracting `location` from request `params.arguments`.
- Extracting `hits[]` from response `result`.
- Returning a `PalaceEvent` or `null` (if not a palace tool).

This keeps the enrichment logic isolated and testable without needing the proxy's I/O.

### 6.3 New file: `src/server.ts`

The HTTP + WebSocket server. Separated from `proxy.ts` to keep the stdio forwarding path clean and minimize risk of the server accidentally interfering with the pipe.

---

## 7. Implementation Phases

### Phase 1: Enriched proxy with WebSocket (no UI yet)

**Goal:** Proxy emits `PalaceEvent`s and streams them over WebSocket.

Files to create/modify:
- `src/events.ts` — add `PalaceEvent`, `PalaceLocation`, `PalaceHit`, `SessionStartEvent`
- `src/enrich.ts` — new, enrichment logic
- `src/server.ts` — new, HTTP + WS server with in-memory event buffer
- `src/tokens.ts` — replace heuristic with tiktoken
- `src/proxy.ts` — integrate enricher + server, remove JSONL file I/O
- `src/harness.ts` — extend to validate enriched events + WS delivery
- `package.json` — add `ws` + tiktoken dependencies

**Acceptance criteria:**
- [ ] `mempalace_search` calls produce `PalaceEvent` with `hits[]` containing wing, room, distance
- [ ] `mempalace_traverse` calls produce `PalaceEvent` with connected rooms
- [ ] WebSocket client receives events in real time (< 50ms after proxy observes them)
- [ ] `GET /events` returns buffered events as NDJSON for replay
- [ ] `GET /taxonomy` returns cached palace taxonomy
- [ ] `GET /health` returns uptime and event count
- [ ] Token estimates use tiktoken (cl100k_base), not the 4-char heuristic
- [ ] No file I/O for events — everything is in-memory
- [ ] Non-mempalace tools still emit standard request/response events
- [ ] Typecheck passes, all existing harness assertions still pass

### Phase 2: Extension skeleton with Timeline

**Goal:** VS Code extension connects to proxy and shows a live Timeline tree view.

Files to create:
- `extension/` directory with standard VS Code extension scaffolding
- `extension/src/extension.ts` — activation, WS connection, retry logic
- `extension/src/timeline.ts` — TreeDataProvider for the event timeline
- `extension/src/statusbar.ts` — status bar item
- `extension/package.json` — extension manifest

**Acceptance criteria:**
- [ ] Extension activates and connects to proxy WebSocket
- [ ] Status bar shows live stats (call count, tokens, avg latency)
- [ ] Timeline tree view shows events with token badges and latency colors
- [ ] `PalaceEvent` rows expand to show hits with wing/room/distance
- [ ] Proxy offline state is indicated and recovery is automatic
- [ ] Replay on reconnect works without duplicate events

### Phase 3: Palace Map Webview

**Goal:** Interactive spatial visualization of palace traversal.

Files to create:
- `extension/src/mapPanel.ts` — WebviewPanel provider
- `extension/webview/` — HTML + JS + CSS for the D3 map
- `extension/webview/map.ts` — graph rendering logic
- `extension/webview/styles.css` — map styles

**Acceptance criteria:**
- [ ] Map renders wings and rooms as a force-directed graph
- [ ] Live events animate: source node pulses, hit nodes pulse in sequence
- [ ] Tunnel edges are visually distinct from hallway edges
- [ ] Heat accumulation visible (hotter color = more access)
- [ ] Zoom, pan, filter by wing, reset layout all work
- [ ] Map state survives panel hide/show

### Phase 4: Polish & Ship

- Token breakdown pie chart (how much goes to `tools/list` vs actual retrieval)
- Export session as shareable HTML report
- Extension marketplace packaging

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| WebSocket server on proxy blocks stdio pipe | Protocol breaks, Claude Code sees stalls | Server runs on separate async I/O. Stdio forwarding is synchronous line-by-line, never awaits server operations. |
| MemPalace response format changes break enricher | `PalaceEvent.hits` empty or wrong | Enricher is best-effort: on parse failure, it falls back to emitting standard `ResponseEvent`. Version field in `SessionStartEvent` for debugging. |
| Port conflict on 19420 | Extension can't connect | Configurable port. Health endpoint lets extension detect conflict early. |
| Large `tools/list` response slows proxy | Added latency to first call | Proxy forwards bytes as they arrive (line-by-line), enrichment is post-forward. No blocking. |
| Webview D3 bundle too large | Slow extension load | Lazy-load webview only when panel is opened. Use lightweight D3 subset (d3-force + d3-selection only). |

---

## 9. Non-functional Requirements

| Requirement | Target |
|---|---|
| Proxy added latency | < 5ms per message (parse + enrich + emit) |
| WebSocket delivery | < 50ms from proxy observation to extension receipt |
| Extension memory | < 50MB for sessions up to 1000 events |
| Extension activation | < 500ms (webview is lazy) |
| Proxy crash isolation | If the WS server crashes, stdio forwarding continues unaffected |

---

## 10. Out of Scope (v1)

- Modifying MemPalace itself.
- Injecting queries or commands from the extension into the MCP stream.
- Multi-session comparison or historical analysis.
- Authentication on the WebSocket (localhost only, single user).
- Supporting non-MemPalace MCP servers in the palace map (they show in timeline only).

---

## 11. Resolved Decisions

1. **Palace structure bootstrap**: The proxy exposes a `GET /taxonomy` endpoint that calls `mempalace_get_taxonomy` on the downstream container and caches the result. The extension fetches this on connect to pre-populate the map with realistic structure before any traffic flows. The proxy remains transparent on the stdio pipe — the taxonomy call is a side-channel, not injected into the client↔server stream.
2. **Token estimator**: Swap the ~4chars/tok heuristic for tiktoken in **Phase 1**. The estimation is a core value prop of the tool — shipping with a known-inaccurate heuristic undermines trust.
3. **No JSONL file**: Events are buffered in an in-memory array inside the proxy. `GET /events` serves from that buffer. No file I/O, no rotation, no path config. The "Export Session" command in the extension serializes the in-memory buffer on demand. The session lifetime matches the proxy process lifetime — when the proxy dies, the buffer is gone.
