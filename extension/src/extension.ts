import * as vscode from "vscode";
import WebSocket from "ws";
import { type LongHorizonEvent } from "./types";
import { StatusBarController } from "./statusbar";
import { TimelineProvider } from "./timeline";
import { MapPanel } from "./mapPanel";
import { generateHtmlReport } from "./htmlReport";
import { setupCommand, checkStatus } from "./setup";
import { resolvePalace, type PalaceBinding } from "./palace";

/** Shared session state consumed by the status bar and timeline. */
export interface SessionState {
  events: LongHorizonEvent[];
  connected: boolean;
  /** Which palace this workspace observes. Null until first resolved. */
  palace: PalaceBinding | null;
  /** Notify all consumers that the events array changed. */
  onEvent: vscode.EventEmitter<LongHorizonEvent>;
  /** Notify all consumers of connection state changes. */
  onConnection: vscode.EventEmitter<boolean>;
}

let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = 5_000;

function isDuplicate(existing: LongHorizonEvent[], event: LongHorizonEvent): boolean {
  return existing.some((e) => {
    if (!("ts" in e) || !("ts" in event) || e.ts !== event.ts || e.kind !== event.kind) return false;
    if ("id" in e && "id" in event) return e.id === event.id;
    return true; // same ts + kind, no id (e.g. session-start) → deduplicate
  });
}

function ingest(state: SessionState, event: LongHorizonEvent): void {
  if ((event as { kind: string }).kind === "ping") return;
  if (isDuplicate(state.events, event)) return;
  state.events.push(event);
  state.onEvent.fire(event);
}

async function replayBuffered(port: number, state: SessionState): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    if (!res.ok) return;
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { ingest(state, JSON.parse(line) as LongHorizonEvent); } catch { /* skip */ }
    }
  } catch { /* proxy not ready */ }
}

async function connect(state: SessionState): Promise<void> {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  // Re-resolved on every attempt: the workspace may have gained a .mcp.json, or
  // the user may have switched to a project whose palace lives on another port.
  state.palace = await resolvePalace();
  const port = state.palace.port;
  const url = `ws://127.0.0.1:${port}/events`;

  ws = new WebSocket(url);

  ws.on("open", () => {
    state.connected = true;
    state.onConnection.fire(true);
    replayBuffered(port, state);
  });

  ws.on("message", (data) => {
    try {
      ingest(state, JSON.parse(data.toString()) as LongHorizonEvent);
    } catch {
      // ignore unparseable frames
    }
  });

  ws.on("close", () => {
    state.connected = false;
    state.onConnection.fire(false);
    ws = null;
    retryTimer = setTimeout(() => connect(state), RETRY_MS);
  });

  ws.on("error", () => {
    // 'close' will fire after this — retry happens there
    ws?.terminate();
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const state: SessionState = {
    events: [],
    connected: false,
    palace: null,
    onEvent: new vscode.EventEmitter<LongHorizonEvent>(),
    onConnection: new vscode.EventEmitter<boolean>(),
  };

  context.subscriptions.push(state.onEvent, state.onConnection);

  // Status bar
  const statusBar = new StatusBarController(state);
  context.subscriptions.push(statusBar);

  // Timeline tree view
  const timeline = new TimelineProvider(state);
  const treeView = vscode.window.createTreeView("long-horizon.timeline", {
    treeDataProvider: timeline,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Palace Map webview
  const mapPanel = new MapPanel(context.extensionUri, state);
  context.subscriptions.push(mapPanel);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("long-horizon.setup", () => setupCommand()),
    vscode.commands.registerCommand("long-horizon.showMap", () => {
      mapPanel.show();
    }),
    vscode.commands.registerCommand("long-horizon.showTimeline", () => {
      treeView.reveal(undefined as never, { focus: true });
    }),
    vscode.commands.registerCommand("long-horizon.clearSession", () => {
      state.events.length = 0;
      state.onEvent.fire(null as never);
    }),
    vscode.commands.registerCommand("long-horizon.exportSession", async () => {
      const format = await vscode.window.showQuickPick(
        [
          { label: "HTML Report", description: "Self-contained visual report", value: "html" },
          { label: "JSONL", description: "Raw event data", value: "jsonl" },
        ],
        { placeHolder: "Export format" },
      );
      if (!format) return;

      const ext = format.value === "html" ? "html" : "jsonl";
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`long-horizon-session.${ext}`),
        filters: { [ext.toUpperCase()]: [ext] },
      });
      if (!uri) return;

      const content = format.value === "html"
        ? generateHtmlReport(state.events)
        : state.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
      vscode.window.showInformationMessage(`Exported ${state.events.length} events as ${ext.toUpperCase()}`);
    }),
  );

  // Connect to proxy
  void connect(state);

  // Reconnect on config change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("long-horizon.wsPort")) {
        ws?.close();
        void connect(state);
      }
    }),
  );

  // `.mcp.json` carries the palace binding, so a change to it can move the
  // proxy to a different port. Watch it and rebind rather than sitting on a
  // dead socket until the next reload.
  const mcpWatcher = vscode.workspace.createFileSystemWatcher("**/.mcp.json");
  const rebind = () => { ws?.close(); void connect(state); };
  mcpWatcher.onDidChange(rebind);
  mcpWatcher.onDidCreate(rebind);
  context.subscriptions.push(mcpWatcher);
}

export function deactivate(): void {
  if (retryTimer) clearTimeout(retryTimer);
  ws?.close();
}
