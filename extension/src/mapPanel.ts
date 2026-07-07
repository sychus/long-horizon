import * as vscode from "vscode";
import type { SessionState } from "./extension";
import type { LongHorizonEvent } from "./types";

/**
 * Manages the Palace Map webview panel.
 *
 * The extension host holds the event state and pushes updates to the webview
 * via postMessage. The webview is pure rendering (D3) — no WS connection of
 * its own.
 */
export class MapPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: SessionState,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "long-horizon.map",
      "Palace Map",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist"),
        ],
      },
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    // Send initial state once webview signals ready
    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string }) => {
        if (msg.type === "ready") {
          this.sendFullState();
        }
      },
      undefined,
      this.disposables,
    );

    // Push live events to the webview
    const sub = this.state.onEvent.event((e) => {
      if (!e) {
        // clearSession
        this.panel?.webview.postMessage({ type: "clear" });
        return;
      }
      this.panel?.webview.postMessage({ type: "event", event: e });
    });
    this.disposables.push(sub);

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.disposables.forEach((d) => d.dispose());
      this.disposables.length = 0;
    });
  }

  private sendFullState(): void {
    // Send all events for initial render (map uses palace, pie uses all)
    this.panel?.webview.postMessage({
      type: "init",
      events: this.state.events,
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "mapView.js"),
    );

    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>Palace Map</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
    #map { width: 100%; height: 100%; }

    /* Controls overlay */
    #controls {
      position: absolute; top: 12px; right: 12px;
      display: flex; gap: 6px; z-index: 10;
    }
    #controls button, #controls select {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 4px 10px; border-radius: 3px; font-size: 12px; cursor: pointer;
    }
    #controls button:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* Stats overlay */
    #stats {
      position: absolute; bottom: 12px; left: 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, transparent);
      padding: 6px 10px; border-radius: 4px; font-size: 11px;
      opacity: 0.9; z-index: 10;
    }

    /* Token pie chart panel */
    #token-panel {
      position: absolute; bottom: 12px; right: 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border, transparent);
      border-radius: 6px; padding: 10px; z-index: 10;
      opacity: 0.95; min-width: 200px;
    }
    #token-panel h3 {
      font-size: 12px; margin: 0 0 6px 0; font-weight: 600;
      color: var(--vscode-editor-foreground);
    }
    #token-panel .legend {
      display: flex; flex-direction: column; gap: 3px; font-size: 11px;
    }
    #token-panel .legend-item {
      display: flex; align-items: center; gap: 6px;
    }
    #token-panel .legend-swatch {
      width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0;
    }
    #token-panel .legend-value {
      margin-left: auto; font-variant-numeric: tabular-nums;
    }
    #pie-chart { display: block; margin: 0 auto 6px; }

    /* Node labels */
    .node-label {
      font-size: 11px; fill: var(--vscode-editor-foreground);
      pointer-events: none; text-anchor: middle; dominant-baseline: central;
    }
    .wing-label { font-weight: bold; font-size: 13px; }

    /* Tooltip */
    #tooltip {
      position: absolute; display: none;
      background: var(--vscode-editorHoverWidget-background);
      border: 1px solid var(--vscode-editorHoverWidget-border, transparent);
      padding: 8px 12px; border-radius: 4px; font-size: 11px;
      pointer-events: none; z-index: 20; max-width: 320px;
      color: var(--vscode-editorHoverWidget-foreground);
      line-height: 1.5;
    }
    #tooltip .tag {
      display: inline-block; font-size: 9px; font-weight: 700;
      letter-spacing: 1px; padding: 1px 5px; border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      vertical-align: middle; margin-right: 4px;
    }
    #tooltip .preview {
      display: block; margin-top: 4px;
      color: var(--vscode-descriptionForeground);
      font-style: italic; line-height: 1.4;
    }

    /* Legend pct */
    #token-panel .pct { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div id="controls">
    <select id="wing-filter"><option value="">All Wings</option></select>
    <button id="btn-labels">Labels</button>
    <button id="btn-reset">Reset</button>
    <button id="btn-pause">Pause</button>
  </div>
  <div id="stats"></div>
  <div id="tooltip"></div>
  <div id="token-panel">
    <h3>Token Breakdown</h3>
    <svg id="pie-chart" width="160" height="160"></svg>
    <div id="pie-legend" class="legend"></div>
  </div>
  <svg id="map"></svg>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
