/**
 * Reading the state of the search index.
 *
 * MemPalace reports through formatted console output rather than a machine
 * readable channel, so this module owns the parsing. It is isolated here so
 * that when the upstream format shifts, exactly one file is wrong — and it
 * fails by returning nothing rather than by inventing numbers, because a
 * confidently wrong drawer count is worse than an absent one.
 */
import { mempalace } from "./docker.js";
/**
 * Drawers belonging to one project.
 *
 * Not `total`: the store is shared, so the palace-wide count includes every
 * other project. Reconciling this project's disk against a number that moves
 * when an unrelated repo syncs would report failures that are not this
 * project's, and mask ones that are.
 */
export const wingTotal = (state) => [...state.rooms.values()].reduce((sum, n) => sum + n, 0);
const TOTAL = /Status\s+[—-]\s+(\d+)\s+drawers/;
const WING = /^\s*WING:\s*(\S+)/;
const ROOM = /^\s*ROOM:\s*(\S+)\s+(\d+)\s+drawers/;
export function parseStatus(output, wing) {
    const state = { total: 0, rooms: new Map(), wings: [] };
    const total = output.match(TOTAL);
    if (total)
        state.total = Number(total[1] ?? 0);
    let currentWing = null;
    for (const line of output.split("\n")) {
        const wingMatch = line.match(WING);
        if (wingMatch?.[1]) {
            currentWing = wingMatch[1];
            state.wings.push(currentWing);
            continue;
        }
        const roomMatch = line.match(ROOM);
        if (roomMatch?.[1] && currentWing === wing) {
            state.rooms.set(roomMatch[1], Number(roomMatch[2] ?? 0));
        }
    }
    return state;
}
/** Query the index. Returns null when the palace has never been built. */
export async function readIndexState(volume, wing) {
    const { code, stdout, stderr } = await mempalace(["status"], { volume });
    if (code !== 0)
        return null;
    const output = stdout + stderr;
    if (!TOTAL.test(output))
        return null;
    return parseStatus(output, wing);
}
