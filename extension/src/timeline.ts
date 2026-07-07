import * as vscode from "vscode";
import type { SessionState } from "./extension";
import type {
  LongHorizonEvent,
  PalaceEvent,
  PalaceHit,
  RequestEvent,
  ResponseEvent,
} from "./types";

// ---- Tree items -----------------------------------------------------------

type TimelineElement = EventItem | HitItem;

class EventItem extends vscode.TreeItem {
  constructor(
    public readonly event: LongHorizonEvent,
    private readonly config: { tokenWarn: number; latencyWarn: number },
  ) {
    const label = EventItem.label(event);
    const expandable =
      event.kind === "palace" && event.hits.length > 0;

    super(label, expandable
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    );

    this.description = EventItem.description(event);
    this.iconPath = EventItem.icon(event, config);
    this.tooltip = EventItem.tooltip(event);
    this.contextValue = event.kind;
  }

  private static label(e: LongHorizonEvent): string {
    switch (e.kind) {
      case "session-start":
        return `Session ${e.ts.slice(0, 19).replace("T", " ")}`;
      case "request":
        return e.tool
          ? `${e.tool}`
          : e.method;
      case "response":
      case "notification":
        return e.method ?? "response";
      case "palace":
        return e.tool;
      case "non-json":
        return "non-json";
    }
  }

  private static description(e: LongHorizonEvent): string {
    if (e.kind === "session-start") return e.proxyVersion;
    const parts: string[] = [];
    if ("tokens" in e && e.tokens > 0) parts.push(`${e.tokens} tok`);
    if ("latencyMs" in e && e.latencyMs != null) parts.push(`${e.latencyMs}ms`);
    if (e.kind === "palace" && e.hits.length > 0) parts.push(`${e.hits.length} hits`);
    return parts.join(" · ");
  }

  private static icon(
    e: LongHorizonEvent,
    config: { tokenWarn: number; latencyWarn: number },
  ): vscode.ThemeIcon {
    if (e.kind === "session-start") return new vscode.ThemeIcon("rocket");

    if (e.kind === "request") {
      return new vscode.ThemeIcon(
        e.tool ? "search" : "arrow-right",
        new vscode.ThemeColor("charts.blue"),
      );
    }

    if (("isError" in e && e.isError)) {
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    }

    // Token warning
    if ("tokens" in e && e.tokens >= config.tokenWarn) {
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
    }

    // Latency coloring
    if ("latencyMs" in e && typeof e.latencyMs === "number") {
      if (e.latencyMs >= config.latencyWarn) {
        return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
      }
      if (e.latencyMs >= 100) {
        return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.yellow"));
      }
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
    }

    if (e.kind === "palace") {
      return new vscode.ThemeIcon("compass", new vscode.ThemeColor("charts.purple"));
    }

    return new vscode.ThemeIcon("circle-outline");
  }

  private static tooltip(e: LongHorizonEvent): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendCodeblock(JSON.stringify(e, null, 2), "json");
    return md;
  }
}

class HitItem extends vscode.TreeItem {
  constructor(hit: PalaceHit) {
    const dist = hit.distance != null ? ` (d=${hit.distance.toFixed(2)})` : "";
    super(
      `${hit.wing}/${hit.room}${dist}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.description = hit.preview ?? "";
    this.iconPath = new vscode.ThemeIcon("pin", new vscode.ThemeColor("charts.orange"));
    if (hit.drawerId) {
      this.tooltip = `Drawer: ${hit.drawerId}`;
    }
  }
}

// ---- Provider --------------------------------------------------------------

export class TimelineProvider implements vscode.TreeDataProvider<TimelineElement> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly state: SessionState) {
    state.onEvent.event(() => this._onDidChange.fire());
  }

  private getConfig() {
    const cfg = vscode.workspace.getConfiguration("long-horizon");
    return {
      tokenWarn: cfg.get<number>("tokenWarningThreshold", 2000),
      latencyWarn: cfg.get<number>("latencyWarningMs", 500),
    };
  }

  getTreeItem(element: TimelineElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TimelineElement): TimelineElement[] {
    if (!element) {
      // Root: all events, newest first for easy scanning
      const config = this.getConfig();
      return [...this.state.events]
        .reverse()
        .map((e) => new EventItem(e, config));
    }

    // Children: PalaceEvent hits
    if (element instanceof EventItem && element.event.kind === "palace") {
      return element.event.hits.map((h) => new HitItem(h));
    }

    return [];
  }
}
