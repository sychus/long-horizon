import * as vscode from "vscode";
import type { SessionState } from "./extension";
import { type LongHorizonEvent } from "./types";
import { checkStatus } from "./setup";
import { resolvePalace, palaceLabel } from "./palace";

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
    const palace = this.state.palace ?? (await resolvePalace());
    this.state.palace = palace;
    this.proxyStatus = await checkStatus(palace.port);
    this.update();
  }

  /**
   * Which palace this window observes. With one palace per project this is no
   * longer implicit, and a status bar that does not name it invites reading
   * another project's numbers as your own.
   */
  private get scope(): string {
    const palace = this.state.palace;
    if (!palace) return "";
    return ` ${palaceLabel(palace)}`;
  }

  private get scopeTooltip(): string {
    const palace = this.state.palace;
    if (!palace) return "";
    const where = palace.source === "mcp.json" ? ".mcp.json" : palace.source;
    return `\n\nWing: ${palaceLabel(palace)}\nStore: ${palace.volume ?? "unknown"} (shared)\nPort: ${palace.port} (from ${where})`;
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
      this.item.text = "$(eye) LH: no palace";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.tooltip = "No palace wired for this workspace — run `palace init`, or click to configure";
      this.item.command = "long-horizon.setup";
      return;
    }

    if (!this.state.connected) {
      this.item.text = `$(eye) LH:${this.scope} waiting`;
      this.item.backgroundColor = undefined;
      this.item.tooltip =
        "Palace configured — will connect when Claude Code starts a MemPalace session" +
        this.scopeTooltip;
      this.item.command = "long-horizon.setup";
      return;
    }

    this.item.command = "long-horizon.showTimeline";
    this.item.backgroundColor = undefined;

    if (this.calls === 0) {
      this.item.text = `$(eye) LH:${this.scope} ready`;
      this.item.tooltip = "Connected — waiting for MemPalace calls" + this.scopeTooltip;
    } else {
      this.item.text = `$(eye) LH:${this.scope} ${this.calls} calls · ${this.formatTokens(this.tokens)} tok · ${avg}ms avg`;
      this.item.tooltip = "Click to show Event Timeline" + this.scopeTooltip;
    }
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
