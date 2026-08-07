/**
 * Resolving which palace this workspace belongs to.
 *
 * With one palace per project, the proxy no longer listens on a fixed port —
 * each project derives its own from its slug and records it in the committed
 * `.mcp.json`. The extension reads that file rather than keeping its own copy
 * of the derivation, so there is exactly one place where a project's port is
 * decided and no way for the two to disagree.
 *
 * This module only reads. Long Horizon observes palaces; it never edits them.
 * Authoring and repair belong to the `palace` CLI.
 */

import * as vscode from "vscode";
import { DEFAULT_WS_PORT } from "./types";

export interface PalaceBinding {
  /** Port the proxy for this workspace listens on. */
  port: number;
  /** This project's wing in the shared store, when it could be determined. */
  slug: string | null;
  /** Docker volume backing the store — shared by every project. */
  volume: string | null;
  /** Where the port came from — surfaced in the status bar tooltip. */
  source: "setting" | "mcp.json" | "default";
}

interface McpEntry {
  env?: Record<string, string>;
}

/** Read `.mcp.json` from the first workspace folder that has one. */
async function readMcpEntry(): Promise<McpEntry | null> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(folder.uri, ".mcp.json");
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const config = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
        mcpServers?: Record<string, McpEntry>;
      };
      const entry = config.mcpServers?.["mempalace"];
      if (entry) return entry;
    } catch {
      // no .mcp.json here, or it is not valid JSON — try the next folder
    }
  }
  return null;
}

/** `<volume>:/data` → volume. */
function parseVolume(lensArgs: string | undefined): string | null {
  if (!lensArgs) return null;
  try {
    const args = JSON.parse(lensArgs) as string[];
    const mount = args.find((a) => a.startsWith("mempalace-") && a.includes(":/data"));
    return mount ? mount.split(":")[0] ?? null : null;
  } catch {
    return null;
  }
}

/**
 * An explicitly configured port always wins — if someone pinned one to work
 * around a collision, silently overriding it from a generated file would be
 * exactly the kind of invisible disagreement this design exists to avoid.
 */
function explicitSetting(): number | null {
  const inspected = vscode.workspace.getConfiguration("long-horizon").inspect<number>("wsPort");
  return (
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue ??
    null
  );
}

export async function resolvePalace(): Promise<PalaceBinding> {
  const entry = await readMcpEntry();
  const volume = parseVolume(entry?.env?.["LENS_ARGS"]);
  // The store is shared, so its volume name is the same for every project and
  // says nothing about which wing this repo owns. The CLI records that
  // explicitly; there is nothing to infer it from otherwise.
  const slug = entry?.env?.["PALACE_WING"] ?? null;

  const pinned = explicitSetting();
  if (pinned != null) {
    return { port: pinned, slug, volume, source: "setting" };
  }

  const declared = Number(entry?.env?.["HORIZON_WS_PORT"]);
  if (Number.isFinite(declared) && declared > 0) {
    return { port: declared, slug, volume, source: "mcp.json" };
  }

  return { port: DEFAULT_WS_PORT, slug, volume, source: "default" };
}

/** Human-readable name for the observed palace. */
export const palaceLabel = (binding: PalaceBinding): string =>
  binding.slug ?? "no palace";
