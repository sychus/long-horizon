/**
 * Interactive menu, shown when `long-horizon` is run with no arguments.
 *
 * Written against raw stdin rather than a prompt library on purpose: this package
 * is installed globally and spawned by Claude Code as an MCP server, so every
 * dependency is one more thing that can break a user's session. Arrow-key
 * selection is about sixty lines; a dependency for it is not worth the risk.
 *
 * The menu is for humans. Every entry is also a plain subcommand, because an
 * interactive picker is hostile to the agents and CI jobs that are the other
 * half of this tool's audience.
 */
import * as readline from "node:readline";
import { bold, dim, cyan, green, out } from "./ui.js";
export const MENU = [
    { command: "scan", label: "scan", detail: "Map the current codebase into the skeleton. Safe to re-run." },
    { command: "sync", label: "update", detail: "Rebuild the searchable index from .palace/." },
    { command: "monitor", label: "monitor", detail: "Watch live: auto-sync, code drift, and what the agent retrieves." },
    { command: "context", label: "context", detail: "Show the orientation an agent gets for this project, and what it costs." },
    { command: "map", label: "map", detail: "Write a visual HTML map of the whole palace and open it." },
    { command: "doctor", label: "doctor", detail: "Verify the map is accurate and see what is still unverified." },
    { command: "status", label: "status", detail: "What is filed, on disk and in the index." },
    { command: "init", label: "init", detail: "Scaffold the palace and wire it into Claude Code." },
    { command: "list", label: "list", detail: "Every wing in the shared store." },
];
const ESC = "\x1b";
const CLEAR_LINE = `${ESC}[2K`;
const CURSOR_UP = `${ESC}[1A`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
/**
 * Render the menu, then rewind the cursor so the next paint overwrites it.
 * Redrawing in place keeps the terminal free of a scrollback wall of repeats.
 */
function paint(selected, title, first) {
    const lines = [];
    lines.push("");
    lines.push(`  ${bold("Long Horizon")} ${dim("—")} ${cyan(title)}`);
    lines.push("");
    for (const [i, item] of MENU.entries()) {
        const active = i === selected;
        const marker = active ? green("›") : " ";
        const label = active ? bold(item.label.padEnd(10)) : dim(item.label.padEnd(10));
        lines.push(`  ${marker} ${label}`);
    }
    lines.push("");
    lines.push(`  ${dim(MENU[selected]?.detail ?? "")}`);
    lines.push("");
    lines.push(`  ${dim("↑↓ move · ↵ run · q quit")}`);
    if (!first) {
        // Rewind over the previous frame before drawing the new one.
        process.stdout.write(CURSOR_UP.repeat(lines.length) + "\r");
    }
    process.stdout.write(lines.map((l) => CLEAR_LINE + l).join("\n") + "\n");
}
/**
 * Show the menu and resolve with the chosen subcommand, or null if the user
 * quit. Falls back to printing usage when stdin is not a TTY — piped or CI
 * invocations must never block waiting for a keypress that cannot arrive.
 */
export function showMenu(title) {
    if (!process.stdin.isTTY)
        return Promise.resolve(null);
    return new Promise((resolve) => {
        let selected = 0;
        let first = true;
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdout.write(HIDE_CURSOR);
        paint(selected, title, first);
        first = false;
        const finish = (result) => {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("keypress", onKey);
            process.stdout.write(SHOW_CURSOR);
            out();
            resolve(result);
        };
        function onKey(_str, key) {
            if (!key)
                return;
            if (key.name === "up" || key.name === "k") {
                selected = (selected - 1 + MENU.length) % MENU.length;
                paint(selected, title, false);
            }
            else if (key.name === "down" || key.name === "j") {
                selected = (selected + 1) % MENU.length;
                paint(selected, title, false);
            }
            else if (key.name === "return" || key.name === "space") {
                finish(MENU[selected]?.command ?? null);
            }
            else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
                finish(null);
            }
        }
        process.stdin.on("keypress", onKey);
    });
}
