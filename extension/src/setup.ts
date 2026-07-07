/**
 * Setup command — configures Claude Code to route MemPalace through the proxy.
 *
 * Runs `claude mcp remove mempalace` + `claude mcp add mempalace ...`
 * pointing to the proxy instead of Docker directly.
 */

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_WS_PORT } from "./types";

const execFileAsync = promisify(execFile);

// claude CLI may not be in VS Code's PATH — check common locations
const CLAUDE_PATHS = [
  "/Users/sychus/.local/bin/claude",
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  "claude", // fallback to PATH
];

async function findClaude(): Promise<string | null> {
  for (const p of CLAUDE_PATHS) {
    if (p === "claude" || existsSync(p)) {
      try {
        await execFileAsync(p, ["--version"]);
        return p;
      } catch {
        // not this one
      }
    }
  }
  return null;
}

async function findProxyPath(): Promise<string | null> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, "src", "proxy.ts");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function isAlreadyConfigured(claude: string): Promise<"proxy" | "docker" | "none"> {
  try {
    const { stdout } = await execFileAsync(claude, ["mcp", "list"]);
    const mempalaceLine = stdout.split("\n").find((l) => l.startsWith("mempalace:"));
    if (!mempalaceLine) return "none";
    if (mempalaceLine.includes("proxy.ts")) return "proxy";
    return "docker";
  } catch {
    return "none";
  }
}

async function isProxyReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function setupCommand(): Promise<void> {
  const port = vscode.workspace.getConfiguration("long-horizon").get<number>("wsPort", DEFAULT_WS_PORT);

  // Find claude CLI
  const claude = await findClaude();
  if (!claude) {
    vscode.window.showErrorMessage(
      "Could not find the `claude` CLI. Make sure Claude Code is installed.",
    );
    return;
  }

  // Check current state
  const configured = await isAlreadyConfigured(claude);
  const reachable = await isProxyReachable(port);

  if (configured === "proxy" && reachable) {
    vscode.window.showInformationMessage(
      "Long Horizon is fully operational — proxy is configured and running.",
    );
    return;
  }

  if (configured === "proxy" && !reachable) {
    vscode.window.showInformationMessage(
      "Long Horizon is configured correctly. The proxy will start automatically when Claude Code uses MemPalace.",
    );
    return;
  }

  // Need to configure
  const currentConfig = configured as "docker" | "none";
  let proxyPath = await findProxyPath();
  if (!proxyPath) {
    const manualPath = await vscode.window.showInputBox({
      prompt: "Path to long-horizon proxy.ts",
      placeHolder: "/path/to/long-horizon/src/proxy.ts",
      validateInput: (v) => existsSync(v) ? null : "File not found",
    });
    if (!manualPath) return;
    proxyPath = manualPath;
  }

  await configureProxy(claude, proxyPath, currentConfig, port);
}

async function configureProxy(claude: string, proxyPath: string, current: "docker" | "none", port: number): Promise<void> {
  const action = current === "docker"
    ? "Reconfigure MemPalace to route through the Long Horizon proxy?"
    : "Add MemPalace MCP server routed through the Long Horizon proxy?";

  const confirm = await vscode.window.showInformationMessage(
    `${action}\n\nProxy: ${proxyPath}`,
    { modal: true },
    "Configure",
  );

  if (confirm !== "Configure") return;

  try {
    // Remove existing config if any
    if (current === "docker") {
      await execFileAsync(claude, ["mcp", "remove", "mempalace"]);
    }

    // Add proxy config
    await execFileAsync(claude, [
      "mcp", "add", "mempalace",
      "-e", "LENS_CMD=docker",
      "-e", `LENS_ARGS=["run","-i","--rm","-v","mempalace-data:/data","mempalace"]`,
      "-e", `HORIZON_WS_PORT=${port}`,
      "--",
      "npx", "tsx", proxyPath,
    ]);

    vscode.window.showInformationMessage(
      "Long Horizon configured! MemPalace will now route through the proxy when Claude Code starts a session.",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Setup failed: ${msg}`);
  }
}

export async function checkStatus(port: number): Promise<"running" | "offline" | "not-configured"> {
  const reachable = await isProxyReachable(port);
  if (reachable) return "running";

  const claude = await findClaude();
  if (!claude) return "not-configured";

  const configured = await isAlreadyConfigured(claude);
  if (configured === "proxy") return "offline";
  return "not-configured";
}
