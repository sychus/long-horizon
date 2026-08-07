/**
 * Setup — delegating to the `palace` CLI rather than wiring anything itself.
 *
 * The extension used to register the MCP server directly, pointing every
 * workspace at one shared volume. With a palace per project that is no longer
 * correct, and more importantly it is no longer the extension's job: the CLI
 * owns every mutation so that scaffolding, validation and repair all live in
 * one place with one set of rules. Long Horizon observes.
 *
 * So this command reports what it sees and offers to run the CLI in a terminal,
 * where the output is visible and the user stays in control.
 */

import * as vscode from "vscode";
import { resolvePalace } from "./palace";

/** Does this workspace have a palace wired at project scope? */
async function hasPalaceBinding(): Promise<boolean> {
  const palace = await resolvePalace();
  return palace.slug !== null;
}

async function isProxyReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Run a palace command in a visible terminal at the workspace root. */
function runInTerminal(command: string): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const terminal = vscode.window.createTerminal({ name: "palace", cwd });
  terminal.show();
  terminal.sendText(command);
}

export async function setupCommand(): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showWarningMessage("Open a project folder first — a palace belongs to a repository.");
    return;
  }

  const palace = await resolvePalace();

  if (!palace.slug) {
    const choice = await vscode.window.showInformationMessage(
      "This project has no palace yet. `palace init` creates one: seven rooms, a generated taxonomy, and its own index.",
      "Run palace init",
      "Not now",
    );
    if (choice === "Run palace init") runInTerminal("palace init");
    return;
  }

  if (await isProxyReachable(palace.port)) {
    vscode.window.showInformationMessage(
      `Observing palace "${palace.slug}" on port ${palace.port} — the proxy is running.`,
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Palace "${palace.slug}" is wired on port ${palace.port}, but the proxy is not running yet. ` +
      `It starts automatically when Claude Code opens a MemPalace session in this project.`,
    "Check the palace",
    "Dismiss",
  );
  if (choice === "Check the palace") runInTerminal("palace doctor");
}

export async function checkStatus(port: number): Promise<"running" | "offline" | "not-configured"> {
  if (await isProxyReachable(port)) return "running";
  return (await hasPalaceBinding()) ? "offline" : "not-configured";
}
