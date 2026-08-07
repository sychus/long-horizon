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
export async function map(args) {
    const project = resolveProject();
    if (!existsSync(palaceDir(project))) {
        die(`No palace here. Run \`long-horizon init\` first.`);
    }
    const scan = scanPalace(project);
    const facts = inspectRepo(project.root);
    const coverage = computeCoverage(project.root, facts, scan);
    // The index is a nice-to-have here: without it the page still renders, it just
    // cannot flag a room whose disk and index disagree.
    let indexed = null;
    if (await dockerAvailable()) {
        if (await volumeExists(project.volume)) {
            const state = await readIndexState(project.volume, project.slug);
            indexed = state?.rooms ?? null;
        }
    }
    const html = renderReport({ project, scan, coverage, facts, indexed, generatedAt: stamp() });
    const target = path.join(palaceDir(project), "map.html");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, html);
    // Kept out of git from inside the palace, so the project's own .gitignore is
    // never touched.
    const ignore = path.join(palaceDir(project), ".gitignore");
    if (!existsSync(ignore))
        writeFileSync(ignore, "map.html\n");
    heading(`Map for ${bold(project.slug)}`);
    ok(path.relative(project.root, target));
    info(`${coverage.total} source file(s) · ${Math.round(coverage.verifiedRatio * 100)}% verified · ${coverage.unmapped.length} blind spot(s)`);
    if (!indexed)
        warn("index not read — the page cannot flag rooms whose disk and index disagree");
    if (args.open) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
        info("opening in your browser");
    }
    else {
        out();
        out(`  ${dim("Open it, or re-run with")} ${cyan("--open")}`);
    }
    out();
}
