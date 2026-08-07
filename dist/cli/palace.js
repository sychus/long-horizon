#!/usr/bin/env node
/**
 * long-horizon — one memory palace per project.
 *
 * Installed as three commands, all resolved here:
 *
 *   long-horizon        interactive menu (humans)
 *   long-horizon <cmd>  direct (humans in a hurry)
 *   palace <cmd>        the same, aliased for agents, scripts and CI
 *
 * The alias is not cosmetic. Every entry in the menu is also a plain subcommand
 * precisely because an interactive picker is unusable to the agents and CI jobs
 * that are half this tool's audience — and a menu that blocks on a keypress in a
 * pipeline is a hang, not a prompt.
 *
 * The model in one line: `.palace/` in the repo is the source of truth, the
 * docker volume is a derived index, and `doctor` is what keeps the first from
 * quietly diverging from reality.
 */
import { init } from "./commands/init.js";
import { scan } from "./commands/scan.js";
import { fileDrawer } from "./commands/file.js";
import { sync } from "./commands/sync.js";
import { status } from "./commands/status.js";
import { doctor } from "./commands/doctor.js";
import { monitor } from "./commands/monitor.js";
import { context } from "./commands/context.js";
import { map } from "./commands/map.js";
import { showMenu } from "./menu.js";
import { dockerAvailable, volumeExists } from "./docker.js";
import { readIndexState } from "./index-state.js";
import { portFor, SHARED_VOLUME, resolveProject } from "./project.js";
import { ROOMS } from "./taxonomy.js";
import { out, bold, dim, cyan, die, heading, info } from "./ui.js";
function usage() {
    out();
    out(bold("long-horizon") + dim(" — one memory palace per project"));
    out();
    out(`  ${dim("Run")} ${cyan("long-horizon")} ${dim("with no arguments for the interactive menu.")}`);
    out(`  ${dim("`palace` is an alias — use it in scripts, CI and agents.")}`);
    out();
    out(bold("  Commands"));
    out(`    ${cyan("init")}              scaffold the palace and wire it into Claude Code`);
    out(`    ${cyan("scan")}              map an existing codebase into the skeleton ${dim("(--dry-run)")}`);
    out(`    ${cyan("update")}            rebuild the searchable index ${dim("(alias: sync)")}`);
    out(`    ${cyan("monitor")}           watch live: auto-sync, code drift, agent retrieval`);
    out(`    ${cyan("context")}           show the orientation an agent gets for this project`);
    out(`    ${cyan("map")}               write a visual HTML map of the palace ${dim("(--open)")}`);
    out(`    ${cyan("file")}              author a drawer, validated at write time`);
    out(`    ${cyan("status")}            what is filed, on disk and in the index`);
    out(`    ${cyan("doctor")}            verify the map is accurate ${dim("(exits non-zero if not)")}`);
    out(`    ${cyan("list")}              every wing in the shared store`);
    out();
    out(bold("  file"));
    out(`    ${dim("--room")} <room>      required — one of the seven canonical rooms`);
    out(`    ${dim("--title")} <text>     required`);
    out(`    ${dim("--anchor")} <path>    repo-relative path this note describes ${dim("(repeatable)")}`);
    out(`    ${dim("--body")} <text>      content; omit to read from stdin`);
    out(`    ${dim("--force")}            overwrite, or accept broken anchors`);
    out();
    out(bold("  Rooms"));
    for (const room of ROOMS) {
        out(`    ${room.name.padEnd(14)}${dim(room.answers)}`);
    }
    out();
}
/** Every wing in the shared store — one per project. */
async function list() {
    if (!(await dockerAvailable()))
        die("Docker is not running.");
    if (!(await volumeExists(SHARED_VOLUME))) {
        out();
        info(`no palace yet — run \`palace init\` in a repo to create ${SHARED_VOLUME}`);
        out();
        return;
    }
    // Any wing works here; we only want the palace-wide wing list.
    const index = await readIndexState(SHARED_VOLUME, "");
    const wings = index?.wings ?? [];
    if (!wings.length) {
        out();
        info("the palace exists but holds no wings yet — run `palace sync` in a project");
        out();
        return;
    }
    heading(`Wings in ${SHARED_VOLUME} (${wings.length})`);
    for (const wing of [...wings].sort()) {
        info(`${wing.padEnd(24)} ${dim(`port ${portFor(wing)}`)}`);
    }
    out();
    out(`  ${dim("One store, one wing per project — tunnels can link any two.")}`);
    out();
}
function parseFileArgs(argv) {
    const args = { anchors: [], force: false };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i] ?? "";
        const value = argv[i + 1];
        switch (flag) {
            case "--room":
                args.room = value;
                i++;
                break;
            case "--title":
                args.title = value;
                i++;
                break;
            case "--anchor":
                if (value)
                    args.anchors.push(value);
                i++;
                break;
            case "--body":
                args.body = value;
                i++;
                break;
            case "--force":
                args.force = true;
                break;
            default:
                if (flag.startsWith("--"))
                    die(`Unknown flag: ${flag}`);
        }
    }
    return args;
}
/**
 * With no arguments, offer the menu — but only to a human at a terminal.
 * Piped or non-interactive callers get usage, because a picker waiting on a
 * keypress that will never arrive is a hang, not a prompt.
 */
async function interactive() {
    if (!process.stdin.isTTY)
        return usage();
    let title = "no palace here";
    try {
        title = resolveProject().slug;
    }
    catch {
        // Not a repo, or no palace yet — the menu still runs so `init` is reachable.
    }
    const choice = await showMenu(title);
    if (!choice)
        return;
    await dispatch(choice, []);
}
async function dispatch(command, rest) {
    switch (command) {
        case "init": return init();
        case "scan": return scan({ dryRun: rest.includes("--dry-run") });
        case "file": return fileDrawer(parseFileArgs(rest));
        case "sync":
        case "update": return sync();
        case "monitor": return monitor();
        case "context": return context();
        case "map": return map({ open: rest.includes("--open") });
        case "status": return status();
        case "doctor": return doctor();
        case "list": return list();
        case undefined: return interactive();
        case "menu": return interactive();
        case "help":
        case "--help":
        case "-h": return usage();
        default:
            die(`Unknown command: ${command}\n  Run \`long-horizon help\` for usage.`);
    }
}
async function main() {
    const [command, ...rest] = process.argv.slice(2);
    await dispatch(command, rest);
}
main().catch((err) => {
    die(err instanceof Error ? err.message : String(err));
});
