/**
 * Project-scoped MCP wiring (`.mcp.json`).
 *
 * Registering MemPalace at project scope rather than globally is what makes
 * "one palace per project" real: open the repo, get that repo's palace, with no
 * ambient state deciding which memory you are talking to. The file is committed,
 * so a teammate cloning the repo inherits the same wiring.
 *
 * The MCP entry points at the Long Horizon proxy rather than at Docker directly,
 * which is what keeps the palace observable. The proxy stays transparent — it
 * forwards every byte verbatim — so routing through it costs nothing but buys
 * the live map.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { Project } from "./project.js";

const SERVER_NAME = "mempalace";

/**
 * The command `.mcp.json` names for the proxy.
 *
 * A command, never a path. `.mcp.json` is committed and shared, so an absolute
 * path baked into it resolves only on the machine that generated it — clone the
 * repo anywhere else and MCP fails. Naming a PATH command is what every working
 * MCP config does (`docker`, `npx`), and it is the only form that survives
 * being handed to somebody else.
 *
 * Installed by `npm link` (or `npm i -g`) from the long-horizon repo.
 */
export const PROXY_COMMAND = "long-horizon-proxy";

/** Whether `long-horizon-proxy` resolves on this machine's PATH. */
export function proxyCommandInstalled(): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${PROXY_COMMAND}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** How to install it, shown wherever the command is found missing. */
export const INSTALL_HINT = "install it with `npm link` from the long-horizon repo";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The entry a correctly-wired project must contain.
 *
 * `PALACE_WING` is carried explicitly because the store is shared: the volume
 * name is identical for every project and no longer says which wing this repo
 * owns. Without it the extension could not name the palace it is observing.
 */
export function expectedEntry(p: Project): McpServerEntry {
  return {
    command: PROXY_COMMAND,
    args: [],
    env: {
      LENS_CMD: "docker",
      LENS_ARGS: JSON.stringify(["run", "-i", "--rm", "-v", `${p.volume}:/data`, "mempalace"]),
      HORIZON_WS_PORT: String(p.port),
      PALACE_WING: p.slug,
    },
  };
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readMcpConfig(file: string): McpConfig | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as McpConfig;
  } catch {
    return null;
  }
}

/**
 * Write the mempalace entry, preserving every other server already configured.
 * Clobbering a teammate's unrelated MCP servers to install our own would be a
 * hostile thing for a scaffolding tool to do.
 */
export function writeMcpConfig(file: string, p: Project): void {
  const existing = readMcpConfig(file) ?? {};
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  servers[SERVER_NAME] = expectedEntry(p);
  existing.mcpServers = servers;
  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
}

export type McpStatus =
  | { ok: true }
  | { ok: false; reason: string };

/** Compare what is on disk against what this project requires. */
export function checkMcpConfig(file: string, p: Project): McpStatus {
  const config = readMcpConfig(file);
  if (!config) return { ok: false, reason: `${path.basename(file)} is missing or is not valid JSON` };

  const entry = config.mcpServers?.[SERVER_NAME] as McpServerEntry | undefined;
  if (!entry) return { ok: false, reason: `no "${SERVER_NAME}" server registered` };

  const want = expectedEntry(p);

  if (entry.env?.HORIZON_WS_PORT !== want.env.HORIZON_WS_PORT) {
    return {
      ok: false,
      reason: `port is ${entry.env?.HORIZON_WS_PORT ?? "unset"}, expected ${want.env.HORIZON_WS_PORT}`,
    };
  }
  if (entry.env?.LENS_ARGS !== want.env.LENS_ARGS) {
    return {
      ok: false,
      reason: `store wiring does not match — expected ${p.volume}`,
    };
  }
  if (entry.env?.PALACE_WING !== want.env.PALACE_WING) {
    return {
      ok: false,
      reason: `wing is "${entry.env?.PALACE_WING ?? "unset"}", expected "${p.slug}"`,
    };
  }
  // An absolute path here is the old, unportable form. Name it precisely,
  // because "not routed through the proxy" would send someone looking for the
  // wrong problem — the wiring is right, it just cannot survive a clone.
  const hardcoded = entry.args?.find((a) => a.includes("proxy.ts"));
  if (hardcoded) {
    return {
      ok: false,
      reason: `hardcodes a machine-specific path (${hardcoded}) — only works on the machine that wrote it`,
    };
  }
  if (entry.command !== PROXY_COMMAND) {
    return { ok: false, reason: `command is "${entry.command}", expected "${PROXY_COMMAND}"` };
  }
  if (!proxyCommandInstalled()) {
    return { ok: false, reason: `\`${PROXY_COMMAND}\` is not on your PATH — ${INSTALL_HINT}` };
  }
  return { ok: true };
}
