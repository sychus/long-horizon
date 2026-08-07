/**
 * `palace search` — query the palace without the MCP server.
 *
 * Claude Code reads `.mcp.json` once, at startup, and there is no way to make it
 * reload. So the session that runs `palace init` is exactly the session that
 * cannot use the palace it just created — the tools appear only after a restart
 * nobody remembers to do. The failure is silent and self-defeating: the agent
 * reads the whole repository instead, and the palace looks useless on the day
 * you built it.
 *
 * This removes the dependency. The palace is queryable through the CLI from the
 * moment it exists, by an agent with a shell or by a person. The MCP server
 * becomes what it should have been all along — a faster path to the same data,
 * not the only one.
 *
 * Results are passed through rather than reformatted. MemPalace already prints
 * them legibly, and re-parsing its output to print it again would add a failure
 * point in exchange for nothing.
 */
import { existsSync } from "node:fs";
import { resolveProject, palaceDir } from "../project.js";
import { mempalace, dockerAvailable, volumeExists, stripNoise } from "../docker.js";
import { ROOM_NAMES, isRoom } from "../taxonomy.js";
import { out, die, dim, heading, info, cyan } from "../ui.js";
export async function search(args) {
    const project = resolveProject();
    if (!args.query) {
        die(`What should I search for?\n` +
            `  palace search "how is authentication isolated"\n` +
            `  palace search "rate limiting" --room decisions\n` +
            `  palace search "retry policy" --all-wings`);
    }
    if (args.room && !isRoom(args.room)) {
        die(`"${args.room}" is not a room. One of: ${ROOM_NAMES.join(", ")}`);
    }
    if (!existsSync(palaceDir(project))) {
        die(`No palace here. Run \`long-horizon init\` first.`);
    }
    if (!(await dockerAvailable()))
        die("Docker is not running.");
    if (!(await volumeExists(project.volume))) {
        die(`Nothing indexed yet. Run \`long-horizon update\` first.`);
    }
    const argv = ["search", args.query];
    if (!args.allWings)
        argv.push("--wing", project.slug);
    if (args.room)
        argv.push("--room", args.room);
    if (args.results)
        argv.push("--results", String(args.results));
    const result = await mempalace(argv, { volume: project.volume });
    const text = stripNoise(result.stdout + result.stderr);
    if (result.code !== 0) {
        out(text);
        die("Search failed.");
    }
    const scope = args.allWings ? "every wing" : `wing ${project.slug}`;
    heading(`Search — ${scope}${args.room ? ` · room ${args.room}` : ""}`);
    out();
    out(text);
    out();
    if (!/\[\d+\]/.test(text)) {
        info(`nothing matched — the palace may not cover this yet`);
        out(`    ${dim("Check what is in it with")} ${cyan("long-horizon map --open")}`);
        out();
    }
}
