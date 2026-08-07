/**
 * `long-horizon map` — write the palace out as a page you can actually look at.
 *
 * `context` shows what an agent loads; this shows what a person needs: the whole
 * structure at once, what each drawer says, and — the part no query surfaces —
 * which files nothing points at.
 *
 * Written into `.palace/map.html` and gitignored from inside the palace. It is
 * derived output: regenerating is cheap, and committing it would put a large
 * diff into every pull request that touched a note.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { resolveProject, palaceDir } from "../project.js";
import { scanPalace } from "../drawers.js";
import { inspectRepo } from "../inspect.js";
import { computeCoverage } from "../coverage.js";
import { readIndexState } from "../index-state.js";
import { dockerAvailable, volumeExists } from "../docker.js";
import { renderReport } from "../report.js";
import { heading, ok, info, warn, out, die, dim, cyan, bold } from "../ui.js";
/** Local time, minute precision — enough to tell two runs apart. */
function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/**
 * Regenerate the page from the palace's current state.
 *
 * Exported because `update` and `monitor` call it too. A map you have to
 * remember to regenerate is a map that is quietly out of date exactly when you
 * reach for it, so writing it is a side effect of changing anything rather than
 * a separate thing to run.
 *
 * Cheap by design: everything but the index count is read straight off disk, and
 * a missing index degrades the page rather than failing it.
 */
export async function writeMap(project) {
    const scan = scanPalace(project);
    const facts = inspectRepo(project.root);
    const coverage = computeCoverage(project.root, facts, scan);
    let indexed = null;
    if (await dockerAvailable()) {
        if (await volumeExists(project.volume)) {
            const state = await readIndexState(project.volume, project.slug);
            indexed = state?.rooms ?? null;
        }
    }
    const html = renderReport({ project, scan, coverage, facts, indexed, generatedAt: stamp() });
    const file = path.join(palaceDir(project), "map.html");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, html);
    // Kept out of git from inside the palace, so the project's own .gitignore is
    // never touched.
    const ignore = path.join(palaceDir(project), ".gitignore");
    if (!existsSync(ignore))
        writeFileSync(ignore, "map.html\n");
    return {
        file,
        verifiedRatio: coverage.verifiedRatio,
        blindSpots: coverage.unmapped.length,
        indexRead: indexed !== null,
    };
}
export async function map(args) {
    const project = resolveProject();
    if (!existsSync(palaceDir(project))) {
        die(`No palace here. Run \`long-horizon init\` first.`);
    }
    const { file, verifiedRatio, blindSpots, indexRead } = await writeMap(project);
    heading(`Map for ${bold(project.slug)}`);
    ok(path.relative(project.root, file));
    info(`${Math.round(verifiedRatio * 100)}% verified · ${blindSpots} blind spot(s)`);
    if (!indexRead)
        warn("index not read — the page cannot flag rooms whose disk and index disagree");
    if (args.open) {
        openInBrowser(file);
        info("opening in your browser");
    }
    else {
        out();
        out(`  ${dim("Open it once and refresh — it is rewritten on every")} ${cyan("update")}`);
    }
    out();
}
export function openInBrowser(file) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [file], { detached: true, stdio: "ignore" }).unref();
}
