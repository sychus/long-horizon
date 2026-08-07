/**
 * `palace status` — what is in this palace, on disk and in the index.
 *
 * The two columns are shown side by side deliberately. They should agree; when
 * they do not, the palace is lying to you and the divergence is the single most
 * useful thing on the screen.
 */
import { existsSync } from "node:fs";
import { resolveProject, palaceDir } from "../project.js";
import { ROOMS, INBOX } from "../taxonomy.js";
import { volumeExists, dockerAvailable } from "../docker.js";
import { readIndexState, wingTotal } from "../index-state.js";
import { scanPalace, totalDrawers } from "../drawers.js";
import { heading, out, info, warn, die, dim, bold, green, yellow, cyan } from "../ui.js";
export async function status() {
    const project = resolveProject();
    if (!existsSync(palaceDir(project))) {
        die(`No palace here. Run \`palace init\` to create one.`);
    }
    const scan = scanPalace(project);
    const hasDocker = await dockerAvailable();
    const built = hasDocker && (await volumeExists(project.volume));
    const index = built ? await readIndexState(project.volume, project.slug) : null;
    heading(`Wing: ${bold(project.slug)}`);
    info(`store   ${project.volume}${built ? "" : dim("  (not built)")}`);
    info(`port    ${project.port}`);
    if (index) {
        const neighbours = index.wings.filter((w) => w !== project.slug);
        if (neighbours.length)
            info(`shares this store with ${neighbours.length} other wing(s)`);
    }
    heading(`Rooms${dim("                    disk   index")}`);
    for (const room of ROOMS) {
        const onDisk = scan.byRoom.get(room.name)?.length ?? 0;
        const inIndex = index?.rooms.get(room.name) ?? 0;
        const agree = !index || onDisk === inIndex;
        const counts = `${String(onDisk).padStart(4)}   ${index ? String(inIndex).padStart(5) : dim("    ?")}`;
        const name = room.name.padEnd(13);
        const line = `  ${name} ${dim(room.description.padEnd(9).slice(0, 9))} ${counts}`;
        if (!agree)
            out(`${line}  ${yellow("← differs")}`);
        else if (room.name === INBOX && onDisk > 0)
            out(`${line}  ${yellow("← unfiled")}`);
        else
            out(line);
    }
    const disk = totalDrawers(scan);
    const indexed = index ? wingTotal(index) : 0;
    out();
    info(`${disk} drawer(s) on disk${index ? `, ${indexed} indexed in this wing` : ""}`);
    if (scan.strays.length) {
        warn(`${scan.strays.length} file(s) outside any room — run \`palace doctor\``);
    }
    if (!built) {
        out();
        out(`  ${dim("Index not built yet. Run")} ${cyan("palace sync")}`);
    }
    else if (index && disk !== indexed) {
        out();
        out(`  ${dim("Disk and index disagree. Run")} ${cyan("palace sync")}${dim(", then")} ${cyan("palace doctor")}`);
    }
    else if (index) {
        out();
        out(`  ${green("✓")} ${dim("disk and index agree")}`);
    }
    out();
}
