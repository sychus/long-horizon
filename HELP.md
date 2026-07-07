# Long Horizon — Setup & Usage

## How it works

Two pieces working together:

**The proxy** sits between Claude Code and MemPalace. Instead of Claude Code talking directly to the Docker container, it talks to the proxy, which forwards everything to the container. Every message is intercepted, enriched with spatial metadata (wing, room, drawer, hits, distance), and streamed over WebSocket on port 19420.

**The VS Code extension** connects to the proxy's WebSocket and renders: a status bar with live stats, an event timeline with expandable palace events, an interactive force-directed palace map with live animations, and a token breakdown pie chart.

## Setup

### 1. Install dependencies

```bash
cd /path/to/long-horizon
pnpm install

cd extension
pnpm install
pnpm build
```

### 2. Configure Claude Code to use the proxy

In your MCP server config (`claude.json`, `claude_desktop_config.json`, or equivalent), replace the direct Docker command with the proxy:

```json
{
  "mcpServers": {
    "mempalace": {
      "command": "npx",
      "args": ["tsx", "/path/to/long-horizon/src/proxy.ts"],
      "env": {
        "LENS_CMD": "docker",
        "LENS_ARGS": "[\"run\", \"-i\", \"--rm\", \"-v\", \"mempalace-data:/data\", \"mempalace\"]"
      }
    }
  }
}
```

The proxy spawns the Docker container on your behalf. Claude Code does not notice the difference — the MCP protocol passes through transparently.

### 3. Install the VS Code extension

```bash
cd /path/to/long-horizon/extension
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension long-horizon-0.1.0.vsix
```

## Usage

1. Start Claude Code normally — the proxy launches automatically as the MCP server.
2. The VS Code status bar shows: `Lens: 0 calls · 0 tok · 0ms avg`.
3. As Claude uses MemPalace tools, the timeline populates in real time.
4. **Command Palette → "Long Horizon: Show Palace Map"** opens the interactive spatial map.
5. **Command Palette → "Long Horizon: Export Session"** saves the session as HTML report or raw JSONL.

If the proxy is not running, the status bar shows "offline" and retries every 5 seconds. Once the proxy starts, the extension reconnects automatically and replays any missed events.

## Commands

| Command | What it does |
|---|---|
| Long Horizon: Show Palace Map | Opens the interactive force-directed palace map |
| Long Horizon: Show Event Timeline | Focuses the sidebar timeline |
| Long Horizon: Clear Session | Resets all accumulated stats and map state |
| Long Horizon: Export Session | Export as self-contained HTML report or JSONL |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `long-horizon.wsPort` | `19420` | WebSocket port to connect to the proxy |
| `long-horizon.tokenWarningThreshold` | `2000` | Token count above which events get a warning icon |
| `long-horizon.latencyWarningMs` | `500` | Latency threshold for red coloring |
| `long-horizon.autoOpen` | `false` | Auto-open the palace map on session start |

## Environment variables (proxy)

| Variable | Default | Description |
|---|---|---|
| `LENS_CMD` | `docker` | The downstream command to spawn |
| `LENS_ARGS` | `["run","-i","--rm","-v","mempalace-data:/data","mempalace"]` | JSON array of arguments for the downstream command |
| `HORIZON_WS_PORT` | `19420` | Port for the HTTP + WebSocket server |

## Validation

To verify the proxy works against a real MemPalace container:

```bash
cd /path/to/long-horizon
pnpm run poc
```

This runs the test harness which performs a full MCP handshake, calls `mempalace_status` and `mempalace_search`, and asserts that enriched PalaceEvents are streamed over WebSocket with correct spatial metadata and token estimates.
