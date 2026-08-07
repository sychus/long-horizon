/**
 * Reading the palace as it exists on disk.
 *
 * Disk is the source of truth; the index is downstream. `status` and `doctor`
 * both need an honest picture of what is actually filed, including the things
 * that are in the wrong place — so this scanner reports strays rather than
 * quietly skipping them.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import * as path from "node:path";
import { parseDrawer } from "./drawer.js";
import { palaceDir } from "./project.js";
import { ROOM_NAMES } from "./taxonomy.js";
/**
 * Every markdown file in a room is a drawer — including one you did not mean to
 * put there. The scanner must see exactly what the miner sees, or the disk-vs-
 * index reconciliation in `palace doctor` reports divergence that isn't real and
 * misses divergence that is. Rooms are scaffolded with `.gitkeep`, never `.md`,
 * precisely so nothing here needs an exception.
 */
const isDrawer = (name) => name.endsWith(".md");
export function scanPalace(project) {
    const base = palaceDir(project);
    const byRoom = new Map();
    const strays = [];
    const missingRooms = [];
    for (const room of ROOM_NAMES) {
        const dir = path.join(base, room);
        if (!existsSync(dir)) {
            missingRooms.push(room);
            byRoom.set(room, []);
            continue;
        }
        const drawers = [];
        for (const entry of readdirSync(dir)) {
            const file = path.join(dir, entry);
            if (!statSync(file).isFile() || !isDrawer(entry))
                continue;
            const text = readFileSync(file, "utf8");
            const parsed = parseDrawer(text);
            drawers.push({
                file,
                rel: path.relative(project.root, file),
                room,
                parsed,
                bodyLength: parsed.body.trim().length,
            });
        }
        byRoom.set(room, drawers);
    }
    // Markdown sitting directly under .palace/, or in a directory that is not a
    // room, will be mined into the fallback bucket rather than where its author
    // expected. That is drift, and it gets reported.
    if (existsSync(base)) {
        for (const entry of readdirSync(base)) {
            const full = path.join(base, entry);
            if (statSync(full).isFile()) {
                if (isDrawer(entry))
                    strays.push(path.relative(project.root, full));
            }
            else if (!ROOM_NAMES.includes(entry)) {
                for (const nested of readdirSync(full)) {
                    if (isDrawer(nested))
                        strays.push(path.relative(project.root, path.join(full, nested)));
                }
            }
        }
    }
    return { byRoom, strays, missingRooms };
}
export const totalDrawers = (scan) => [...scan.byRoom.values()].reduce((sum, list) => sum + list.length, 0);
