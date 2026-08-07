/**
 * `long-horizon monitor` — keep the map current while you and an agent work.
 *
 * Three streams into one log:
 *
 *   sync    a drawer changed  → reindex it, debounced
 *   drift   anchored code changed → the drawer describing it is now suspect
 *   agent   the proxy's WebSocket → what the agent actually retrieved
 *
 * The third is why this belongs in Long Horizon rather than in the CLI alone.
 * The other two keep the map true; this one shows the map being used, which is
 * the only evidence that any of it was worth writing.
 *
 * Mining takes MemPalace's exclusive lock while MCP reads do not, so auto-sync
 * can safely run alongside a live agent session — `palace sync` already retries
 * on contention. Syncs are debounced and never overlap, because each one starts
 * a container and firing one per keystroke would be its own denial of service.
 */
import { watch, existsSync } from "node:fs";
import { resolveProject, palaceDir, PALACE_DIR } from "../project.js";
import { scanPalace } from "../drawers.js";
import { mempalace, dockerAvailable, volumeExists, isLockContention } from "../docker.js";
import { out, dim, bold, cyan, green, yellow, red, die, heading, info } from "../ui.js";
/** Wait this long after the last change before syncing. */
const DEBOUNCE_MS = 1_500;
/** How often to re-read the palace for newly added anchors. */
const RESCAN_MS = 30_000;
const TAG = {
    sync: green("sync  "),
    drift: yellow("drift "),
    agent: cyan("agent "),
    info: dim("info  "),
};
function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return dim(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
}
function log(stream, message) {
    out(`  ${stamp()}  ${TAG[stream]}  ${message}`);
}
/** Render one retrieval as a single line: what was asked, what came back, what it cost. */
function describeEvent(event) {
    if (event.kind !== "palace")
        return null;
    const tool = (event.tool ?? "").replace(/^mempalace_/, "");
    const hits = event.hits ?? [];
    const rooms = [...new Set(hits.map((h) => `${h.wing}/${h.room}`))].slice(0, 3);
    const parts = [bold(tool)];
    if (rooms.length)
        parts.push(dim("→") + " " + rooms.join(", "));
    else
        parts.push(dim("→ no hits"));
    const cost = [];
    if (event.tokens != null)
        cost.push(`${event.tokens} tok`);
    if (event.latencyMs != null)
        cost.push(`${event.latencyMs}ms`);
    if (cost.length)
        parts.push(dim(`(${cost.join("  ")})`));
    if (event.isError)
        parts.push(red("error"));
    return parts.join("  ");
}
/**
 * Follow the proxy's event stream, reconnecting while it is down.
 *
 * The proxy only exists while Claude Code has a MemPalace session open, so being
 * disconnected is the normal resting state rather than an error — it is reported
 * once on each transition, never as a repeating failure.
 */
function followProxy(port, onClose) {
    let socket = null;
    let timer = null;
    let connected = false;
    let stopped = false;
    const connect = async () => {
        if (stopped)
            return;
        const { WebSocket } = await import("ws");
        socket = new WebSocket(`ws://127.0.0.1:${port}/events`);
        socket.on("open", () => {
            connected = true;
            log("info", `attached to the proxy on port ${port} — watching retrieval`);
        });
        socket.on("message", (data) => {
            try {
                const event = JSON.parse(data.toString());
                const line = describeEvent(event);
                if (line)
                    log("agent", line);
            }
            catch {
                // A frame we cannot parse is not worth interrupting the session for.
            }
        });
        const retry = () => {
            if (connected) {
                connected = false;
                onClose();
            }
            socket = null;
            if (!stopped)
                timer = setTimeout(() => void connect(), 3_000);
        };
        socket.on("close", retry);
        socket.on("error", () => socket?.terminate());
    };
    void connect();
    return {
        stop() {
            stopped = true;
            if (timer)
                clearTimeout(timer);
            socket?.close();
        },
    };
}
// ---- drift ---------------------------------------------------------------
/** Map every anchored path to the drawers that claim to describe it. */
function anchorIndex(project) {
    const index = new Map();
    const scan = scanPalace(project);
    for (const drawers of scan.byRoom.values()) {
        for (const drawer of drawers) {
            for (const anchor of drawer.parsed.frontmatter.anchors ?? []) {
                const list = index.get(anchor);
                if (list)
                    list.push(drawer.rel);
                else
                    index.set(anchor, [drawer.rel]);
            }
        }
    }
    return index;
}
/** Which anchors does a changed file fall under — itself, or a directory anchor. */
function affectedAnchors(relPath, index) {
    const hits = [];
    for (const anchor of index.keys()) {
        if (relPath === anchor || relPath.startsWith(`${anchor}/`))
            hits.push(anchor);
    }
    return hits;
}
// ---- command -------------------------------------------------------------
export async function monitor() {
    const project = resolveProject();
    if (!existsSync(palaceDir(project))) {
        die(`No palace here. Run \`long-horizon init\` first.`);
    }
    if (!(await dockerAvailable())) {
        die("Docker is not running.");
    }
    if (!(await volumeExists(project.volume))) {
        die(`The store ${project.volume} does not exist yet. Run \`long-horizon update\` first.`);
    }
    heading(`Monitoring ${bold(project.slug)}`);
    info(`watching ${PALACE_DIR}/ and anchored code`);
    info(`proxy port ${project.port}`);
    out(`  ${dim("q quit · s sync now")}`);
    out();
    let anchors = anchorIndex(project);
    let syncing = false;
    let pending = false;
    let debounce = null;
    // ---- sync ------------------------------------------------------------
    const runSync = async () => {
        if (syncing) {
            // Never overlap: a second miner would only lose the lock and file nothing.
            pending = true;
            return;
        }
        syncing = true;
        const mined = await mempalace(["mine", `/work/${PALACE_DIR}`, "--wing", project.slug, "--agent", "palace-monitor"], { volume: project.volume, workdir: project.root });
        const output = mined.stdout + mined.stderr;
        if (mined.code !== 0) {
            if (isLockContention(output)) {
                log("sync", dim("store busy — another project is syncing, will retry"));
                pending = true;
            }
            else {
                log("sync", red("mining failed"));
            }
        }
        else {
            const filed = Number(output.match(/Drawers filed:\s*(\d+)/)?.[1] ?? 0);
            if (filed > 0)
                log("sync", `${filed} drawer(s) reindexed`);
            else
                log("sync", dim("nothing new"));
            anchors = anchorIndex(project);
        }
        syncing = false;
        if (pending) {
            pending = false;
            setTimeout(() => void runSync(), 1_000);
        }
    };
    const scheduleSync = () => {
        if (debounce)
            clearTimeout(debounce);
        debounce = setTimeout(() => void runSync(), DEBOUNCE_MS);
    };
    // ---- watchers --------------------------------------------------------
    const watchers = [];
    watchers.push(watch(palaceDir(project), { recursive: true }, (_event, filename) => {
        if (!filename || !filename.toString().endsWith(".md"))
            return;
        log("info", `${PALACE_DIR}/${filename} changed`);
        scheduleSync();
    }));
    // Watching the repo root recursively covers every anchored path without
    // needing a watcher per file, which would exhaust descriptors on a big tree.
    watchers.push(watch(project.root, { recursive: true }, (_event, filename) => {
        if (!filename)
            return;
        const rel = filename.toString();
        if (rel.startsWith(PALACE_DIR) || rel.startsWith(".git"))
            return;
        const affected = affectedAnchors(rel, anchors);
        if (!affected.length)
            return;
        const drawers = [...new Set(affected.flatMap((a) => anchors.get(a) ?? []))];
        for (const drawer of drawers) {
            log("drift", `${rel} changed — ${bold(drawer)} may be out of date`);
        }
    }));
    const rescan = setInterval(() => { anchors = anchorIndex(project); }, RESCAN_MS);
    // ---- live retrieval --------------------------------------------------
    const proxy = followProxy(project.port, () => {
        log("info", dim("proxy went away — waiting for the next session"));
    });
    // ---- keys ------------------------------------------------------------
    const shutdown = () => {
        for (const w of watchers)
            w.close();
        clearInterval(rescan);
        if (debounce)
            clearTimeout(debounce);
        proxy.stop();
        if (process.stdin.isTTY)
            process.stdin.setRawMode(false);
        process.stdin.pause();
        out();
        out(`  ${dim("stopped watching")}`);
        out();
        process.exit(0);
    };
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (key) => {
            if (key === "q" || key === "")
                shutdown();
            else if (key === "s") {
                log("info", "manual sync");
                void runSync();
            }
            // Deliberately no `doctor` key: it exits non-zero on failure, which would
            // take the monitor down with it. Run it in another shell.
        });
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Hold the process open; every further line comes from a watcher or the proxy.
    await new Promise(() => { });
}
