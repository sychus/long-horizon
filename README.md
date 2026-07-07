# Long Horizon

**Live observability for MemPalace MCP retrieval — token costs, latency, and spatial traversal, visualized in real time inside VS Code.**

---

## The problem

[MemPalace](https://github.com/MemPalace/mempalace) organizes long-term AI memory using a spatial metaphor: Wings → Rooms → Drawers. It runs as an MCP stdio server inside Docker. When Claude Code uses it, you have zero visibility into:

- **Where** in the palace it's looking (which wing, which room)
- **How much token budget** each retrieval consumes
- **How long** each tool call takes
- **What it actually found** (hits, distances, previews)

Letta and Zep visualize static memory. Nobody shows the live retrieval traversal plus its token cost. That's the gap Long Horizon fills.

---

## What it does

Long Horizon intercepts every JSON-RPC message between Claude Code and MemPalace and renders it in real time.

### Palace Map

An interactive force-directed graph showing your MemPalace structure as it's accessed:

- **Wings** appear as large labeled containers with a dashed border
- **Rooms** appear as colored circles orbiting their parent wing
- **Search trails** animate in real time — dashed blue edges show which rooms were hit and how close (edge thickness = relevance)
- **Tunnels** (cross-wing links) appear as orange dashed edges
- **Heat accumulation** — rooms accessed more often grow larger
- **Hover tooltips** show room name, hit count, cosine distance, and a content preview

### Token Breakdown

A live pie chart breaking down where your token budget goes each session:

| Category | What's counted |
|---|---|
| Handshake | `initialize` + `tools/list` — the fixed overhead per session |
| Search/Retrieve | `mempalace_search`, `traverse`, `follow_tunnels`, `get_drawer`, etc. |
| Write/Mine | `add_drawer`, `checkpoint`, `mine`, `create_tunnel` |
| Meta/Status | `list_wings`, `get_taxonomy`, `status`, etc. |

The typical finding: the `tools/list` handshake alone costs **~4600 tokens** — 3–7× the cost of an actual search.

### Event Timeline

A sidebar tree view listing every MCP event chronologically with token counts, latency, and color-coded severity. Palace events expand to show their hits with wing/room/distance.

### Status Bar

Always-visible session stats: total tool calls, cumulative tokens, average latency.

---

## Architecture

```
Claude Code  →stdio→  [ proxy ]  →stdio→  MemPalace (Docker)
                          ↓
                   WebSocket :19420
                          ↓
                   VS Code Extension
                   ┌───────────────────┐
                   │  Palace Map (D3)  │
                   │  Event Timeline   │
                   │  Token Pie Chart  │
                   │  Status Bar       │
                   └───────────────────┘
```

The proxy replaces Docker in Claude Code's MCP config. Claude Code spawns the proxy as its MCP server; the proxy spawns Docker, forwards every JSON-RPC byte verbatim (Claude Code cannot detect the proxy), enriches tool calls with spatial metadata, and streams `PalaceEvent`s over WebSocket.

---

## Setup

Full setup instructions — including dependencies, Claude Code MCP config, and extension installation — are in **[HELP.md](HELP.md)**.

---

## Quick start (if already configured)

1. Start Claude Code — the proxy launches automatically.
2. Open VS Code in any project.
3. `Ctrl+Shift+P` → **Long Horizon: Show Palace Map**
4. Ask Claude to use its memory — watch the graph build in real time.
