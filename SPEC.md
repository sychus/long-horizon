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

1. **Proxy is the ONLY process that spawns the Docker container.** The proxy owns the child process lifecycle.

   *Corrected in §11.2:* the original claim here — "MemPalace uses a file lock; two writers crash" — is too broad. Measured on MemPalace 3.5.0: two MCP servers run concurrently against one volume without complaint. Only `mine` takes the exclusive lock.
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

## 11. Per-project palaces (`palace` CLI)

Added after v1. Long Horizon observes a palace; the `palace` CLI creates and
verifies one. The split is deliberate — every mutation lives in one tool with one
set of rules, and constraint #3 (the extension is read-only) stays intact.

### 11.1 Storage model

**One wing per project, one shared store.**

| Concept | Realization |
|---|---|
| Store | Docker volume `mempalace-atlas` — shared, derived, disposable |
| Wing | One project (its slug) |
| Room | A directory under `.palace/` |
| Drawer | A markdown file in a room |
| Port | `19420 + FNV1a(slug) % 100`, recorded in `.mcp.json` |

The repository is the source of truth; the volume is a rebuildable index. This
inverts nothing about MemPalace — it is how `mine` already works — but it makes
the palace reviewable in pull requests, which is what keeps it honest.

Wings are MemPalace's namespace mechanism and tunnels only link wings *within* a
store, so a shared store is what makes cross-project links possible. Verified: a
single query returns hits from two different projects' wings.

The store is deliberately **not** `mempalace-data`. That volume holds auto-mined
conversation transcripts; mixing curated project drawers into it would put back
exactly the noise §11.3 excludes. Two stores, two jobs — one remembers
conversations, one maps projects. Override with `PALACE_VOLUME`.

The port stays per-project: each Claude Code session runs its own proxy, and the
extension has to find the right one.

### 11.2 Concurrency

A shared store means two projects can touch it at once. Measured on MemPalace
3.5.0:

| Operation | Concurrent on one volume |
|---|---|
| MCP server (the read path — ~all runtime usage) | Works. No exclusive lock. |
| `mine` (only during `palace sync`) | Loser exits non-zero: `palace … is held by PID N`. Files nothing. |

It fails safe — a clean refusal, not corruption — but it does fail, and the
unretried loser's drawers are simply absent from the map. `palace sync`
therefore retries on lock contention (5 attempts, 3s apart) and scopes its prune
to its own wing so one project can never prune another's drawers.

Verified: two simultaneous `palace sync` runs, one hitting contention twice,
both completing with all drawers filed.

### 11.3 Taxonomy enforcement

`.palace/mempalace.yaml` declares the wing and the seven canonical rooms. Each
room carries exactly one keyword — its own name — and MemPalace matches keywords
against the mined file's path, so the containing directory determines the room.

Verified against MemPalace 3.5.0 with adversarial filenames:

| File | Contains keyword | Routed to |
|---|---|---|
| `decisions/adr-002-tests-harness-choice.md` | `tests` | `decisions` |
| `architecture/docs-pipeline.md` | `docs` | `architecture` |
| `runbooks/glossary-restore.md` | `glossary` | `runbooks` |
| `inbox/unsorted-thought.md` | — | `inbox` (empty-keyword fallback) |

Synonym keywords were rejected: they would reintroduce exactly the filename
ambiguity this layout removes.

The config is generated and compared by exact string equality, so `renderConfig`
must be byte-stable. Any hand edit is reported as drift rather than absorbed.

### 11.4 Ingestion

Curated only. `palace sync` mines `.palace/` — never the source tree. The config
lives at `.palace/mempalace.yaml` rather than the repo root precisely so the mine
root can be `.palace/` (MemPalace resolves the config relative to the mined
directory).

Room scaffolding uses `.gitkeep`, never `README.md`. Measured: a room README was
mined and ranked **first** in search for its own boilerplate. Nothing with a
document extension may sit in a room unless it is a real drawer.

### 11.5 Verification (`palace doctor`)

Anchors — repo-relative paths a drawer describes — are what make a drawer
falsifiable. Checks, with failures exiting non-zero so the command can gate CI:

| Check | Severity |
|---|---|
| Config matches canonical taxonomy; wing matches slug | fail |
| All seven room directories present | fail |
| No markdown outside a room | fail |
| Frontmatter `room:` agrees with containing directory | fail |
| Every anchor resolves | fail |
| Body ≥ 40 chars | fail |
| **Per-room disk count == index count, scoped to this wing** | fail |
| This project's wing exists in the shared store | fail |
| `.mcp.json` matches this project's store, wing and port | fail |
| Drawer has no anchors / no frontmatter | warn |
| Anchored file modified after the drawer's `updated:` date | warn |
| Drawers sitting in `inbox` | warn |
| Port also derived by a sibling wing | warn |

Reconciliation is scoped to this project's wing, never the palace-wide total —
that number moves whenever an unrelated repo syncs, which would report failures
that are not this project's and mask ones that are. Sibling wings are reported
as context, never as a problem: they are the point of a shared store.

The disk-vs-index reconciliation exists because of a measured failure mode:
drawers under ~40 characters are silently skipped by the miner. Threshold
measured on MemPalace 3.5.0 — a 20-char body was skipped, 40 and above filed.
The file exists, appears filed, and is not searchable. Nothing else surfaces it.

### 11.6 Bootstrapping an existing codebase (`palace scan`)

`palace init` produces an empty building, which is useless on a repository that
already has years of history. `palace scan` is the entry point for any repo: it
reads the working tree and writes the factual skeleton of the map.

**File discovery** goes through `git ls-files` plus `--others --exclude-standard`
— tracked files *and* untracked ones git does not ignore. Walking the tree
directly would mean reimplementing `.gitignore` badly and mining `node_modules`
on the first run; ignoring untracked files would miss a module written that
morning.

**What it writes**, all anchored to real paths:

| Room | Drawer | Derived from |
|---|---|---|
| `architecture` | Structure overview | module inventory, file counts |
| `architecture` | One per top-level module | source files under it |
| `docs` | Entry points and commands | manifest `bin`/`main`/`scripts`/deps |
| `docs` | Configuration surface | root config files by filename |
| `tests` | Test topology | test paths by convention |

**What it refuses to write.** `decisions`, `runbooks` and `glossary` are left
empty. Rationale, operational knowledge and domain vocabulary are not recoverable
from source, and a scanner that produced them would be generating confident
fiction — the precise failure this design exists to prevent.

Absence is itself recorded: when no tests are detected, the test-topology drawer
says so rather than being omitted, because "this codebase has no automated tests"
is load-bearing information about the map.

**Provenance.** Every scanned drawer carries `origin: scan, reviewed: false`.
Scan may only overwrite a drawer that is unconfirmed scan output; missing
provenance counts as human. Re-running after a year never destroys authored
knowledge.

### 11.7 Coverage

`doctor` answers "is what is written correct?". Coverage answers "is anything
written at all?" — a palace can pass the first while failing the second badly:
two drawers, forty undocumented files, and a clean green report.

Anchors make it measurable. Directory anchors expand to the files beneath them,
so a module drawer covers its module without listing every file.

Two numbers are reported, and reporting only the first would be misleading:

- **mapped** — any drawer anchors it. Usually ~100% straight after a scan.
- **verified** — a human wrote or confirmed the anchoring drawer. Starts at 0%
  regardless of how much scan produced.

Only source files enter the covered set; anchors legitimately point at manifests
and directories too, and counting those against the source-file total produced a
measured 110% before it was fixed.

Both are warnings, never failures. An incomplete map is honest and unfinished,
not wrong, and failing a build over it would only teach people to stop running
the command.

### 11.8 Portability of `.mcp.json`

`.mcp.json` is committed and shared, so anything machine-specific inside it is a
promise that breaks on the first clone.

The entry therefore names a **command**, never a path:

```json
{ "command": "long-horizon-proxy", "args": [], "env": { … } }
```

`long-horizon-proxy` is a `bin` of this package, installed by `npm link`. The
wrapper follows its own symlink to locate the repo, so the proxy is found
wherever long-horizon actually lives on that machine. This is the same shape
every working MCP config uses (`docker`, `npx`) and the only one that survives
being handed to someone else.

Naming a command moves a filesystem assumption into an installation
requirement, so both ends are checked rather than assumed:

| Condition | Reported by |
|---|---|
| `args` still contains a `proxy.ts` path | `doctor` — "hardcodes a machine-specific path"; `init` rewrites it |
| `command` is not `long-horizon-proxy` | `doctor` |
| `long-horizon-proxy` missing from PATH | `doctor` and `init`, with the install command |

Verified end to end: a generated config contains no absolute path, and a full
MCP `initialize` handshake completes through `long-horizon-proxy` → proxy →
docker → MemPalace 3.5.0.

### 11.9 Packaging and command surface

Installed with `npm i -g github:sychus/long-horizon`. Node ≥ 20 (recursive
`fs.watch` on Linux).

TypeScript is compiled to `dist/` by a `prepare` script; `bin` entries point at
the emitted JS, which keeps `tsx` out of the runtime entirely. That is not just
tidiness — Claude Code spawns the proxy on every session, and transpiling on each
spawn is latency paid forever.

Emitting runnable ESM required adding explicit `.js` extensions to all 58
relative imports. `moduleResolution: bundler` accepts extensionless specifiers in
source, but Node rejects them at runtime; the first build produced a binary that
compiled cleanly and died with `ERR_MODULE_NOT_FOUND` on launch. `tsc` does
preserve the shebang, so `bin` can point straight at the emitted file.

Three commands are installed:

| Command | Purpose |
|---|---|
| `long-horizon` | CLI; no arguments opens the interactive menu |
| `palace` | The same entrypoint, aliased for scripts, CI and agents |
| `long-horizon-proxy` | Named by every project's `.mcp.json` (see §11.8) |

The alias is load-bearing. Every menu entry is also a plain subcommand, because
an interactive picker is unusable to the agents and CI jobs that are half this
tool's audience. The menu therefore renders only when `stdin` is a TTY and falls
back to usage otherwise — blocking on a keypress that cannot arrive is a hang.

The menu is built on raw `stdin` keypress handling rather than a prompt library:
this package is installed globally and spawned as an MCP server, so every
dependency is one more way to break a user's session.

### 11.10 `monitor`

Merges three streams into one log:

| Stream | Source | Purpose |
|---|---|---|
| `sync` | `fs.watch` on `.palace/` | Reindex changed drawers, debounced 1.5s |
| `drift` | `fs.watch` on the repo root | An anchored file changed, so its drawer is suspect |
| `agent` | Proxy WebSocket on the project's port | What the agent retrieved, and what it cost |

Auto-sync is safe during a live agent session because of the concurrency result
in §11.2: mining takes the exclusive lock, MCP reads do not. Syncs never overlap
— a second concurrent miner would only lose the lock and file nothing — so an
in-flight change sets a pending flag instead of starting a rival container.

Drift watches the repository root recursively rather than one watcher per
anchored file, which would exhaust descriptors on a large tree. The anchor index
is rebuilt after every sync and on a 30s timer, so drawers added mid-session
start being watched without a restart.

Being disconnected from the proxy is the normal resting state, not an error: the
proxy exists only while Claude Code has a MemPalace session open. It is reported
once per transition and reconnected on a 3s timer.

### 11.11 Extension changes

The extension resolves its WebSocket port from the workspace `.mcp.json` rather
than a fixed constant, watches that file to rebind when it changes, and names the
observed wing in the status bar. Precedence: an explicitly pinned
`long-horizon.wsPort` setting, then `.mcp.json`, then the default. The extension
performs no writes; `Long Horizon: Setup` now delegates to the CLI in a terminal.

Because the store is shared, its volume name is identical for every project and
cannot identify the wing. The CLI records `PALACE_WING` in the MCP entry for
exactly this reason — there is nothing else to infer it from.

---

## 12. Resolved Decisions

1. **Palace structure bootstrap**: The proxy exposes a `GET /taxonomy` endpoint that calls `mempalace_get_taxonomy` on the downstream container and caches the result. The extension fetches this on connect to pre-populate the map with realistic structure before any traffic flows. The proxy remains transparent on the stdio pipe — the taxonomy call is a side-channel, not injected into the client↔server stream.
2. **Token estimator**: Swap the ~4chars/tok heuristic for tiktoken in **Phase 1**. The estimation is a core value prop of the tool — shipping with a known-inaccurate heuristic undermines trust.
3. **No JSONL file**: Events are buffered in an in-memory array inside the proxy. `GET /events` serves from that buffer. No file I/O, no rotation, no path config. The "Export Session" command in the extension serializes the in-memory buffer on demand. The session lifetime matches the proxy process lifetime — when the proxy dies, the buffer is gone.
