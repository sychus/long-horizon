import * as vscode from "vscode";
import type { SessionState } from "./extension";
import { DEFAULT_WS_PORT, type LongHorizonEvent } from "./types";
import { checkStatus } from "./setup";

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private calls = 0;
  private tokens = 0;
  private totalLatency = 0;
  private latencyCount = 0;
  private proxyStatus: "running" | "offline" | "not-configured" = "offline";

  constructor(private readonly state: SessionState) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = "long-horizon.showTimeline";
    this.update();
    this.item.show();

    this.disposables.push(
      state.onEvent.event((e) => this.onEvent(e)),
      state.onConnection.event((connected) => {
        this.proxyStatus = connected ? "running" : "offline";
        this.update();
        // If disconnected, check if it's configured at all
        if (!connected) this.checkConfig();
      }),
    );

    // Initial config check
    this.checkConfig();
  }

  private async checkConfig(): Promise<void> {
    if (this.state.connected) return;
    const port = vscode.workspace.getConfiguration("long-horizon").get<number>("wsPort", DEFAULT_WS_PORT);
    this.proxyStatus = await checkStatus(port);
    this.update();
  }

  private onEvent(event: LongHorizonEvent): void {
    if (!event) {
      this.calls = 0;
      this.tokens = 0;
      this.totalLatency = 0;
      this.latencyCount = 0;
      this.update();
      return;
    }

    if (event.kind === "session-start") return;
    if (!("tokens" in event)) return;

    if (event.kind === "palace" || event.kind === "response") {
      this.calls++;
      this.tokens += event.tokens;
      if (event.latencyMs != null) {
        this.totalLatency += event.latencyMs;
        this.latencyCount++;
      }
    } else if (event.kind === "request") {
      this.tokens += event.tokens;
    }

    this.update();
  }

  private formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  private update(): void {
    const avg = this.latencyCount > 0
      ? Math.round(this.totalLatency / this.latencyCount)
      : 0;

    if (this.proxyStatus === "not-configured") {
      this.item.text = "$(eye) LH: not configured";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.tooltip = "Click to configure Long Horizon";
      this.item.command = "long-horizon.setup";
      return;
    }

    if (!this.state.connected) {
      this.item.text = "$(eye) LH: waiting for session";
      this.item.backgroundColor = undefined;
      this.item.tooltip = "Proxy configured — will connect when Claude Code starts a MemPalace session";
      this.item.command = "long-horizon.setup";
      return;
    }

    this.item.command = "long-horizon.showTimeline";
    this.item.backgroundColor = undefined;

    if (this.calls === 0) {
      this.item.text = "$(eye) LH: ready";
      this.item.tooltip = "Connected to proxy — waiting for MemPalace calls";
    } else {
      this.item.text = `$(eye) LH: ${this.calls} calls · ${this.formatTokens(this.tokens)} tok · ${avg}ms avg`;
      this.item.tooltip = "Click to show Event Timeline";
    }
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
