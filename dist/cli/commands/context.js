/**
 * `palace context` — show the orientation an agent gets for this project.
 *
 * This is the payoff of the whole design, made visible. Instead of a large
 * CLAUDE.md that every session pays for in full whether or not it is relevant,
 * an agent loads a few hundred tokens of orientation and retrieves the rest on
 * demand, from the room where it belongs.
 *
 * Printing it matters for the same reason `doctor` prints its checks: a context
 * budget you cannot see is one you cannot argue with. If this reads as noise,
 * the palace is thin and it will show here before it shows in a bad answer.
 */
import { existsSync } from "node:fs";
import { resolveProject, palaceDir } from "../project.js";
import { mempalace, dockerAvailable, volumeExists, stripNoise } from "../docker.js";
import { heading, out, info, warn, die, dim, bold, cyan } from "../ui.js";
const TOKENS = /~(\d+)\s*tokens/i;
export async function context() {
    const project = resolveProject();
    if (!existsSync(palaceDir(project))) {
        die(`No palace here. Run \`long-horizon init\` first.`);
    }
    if (!(await dockerAvailable()))
        die("Docker is not running.");
    if (!(await volumeExists(project.volume))) {
        die(`The store ${project.volume} does not exist yet. Run \`long-horizon update\` first.`);
    }
    const result = await mempalace(["wake-up", "--wing", project.slug], {
        volume: project.volume,
    });
    if (result.code !== 0) {
        out(stripNoise(result.stderr || result.stdout));
        die("Could not read the wake-up context.");
    }
    const text = stripNoise(result.stdout + result.stderr);
    const tokens = text.match(TOKENS)?.[1];
    heading(`Context for ${bold(project.slug)}`);
    info(`what an agent loads at the start of a session${tokens ? `, about ${tokens} tokens` : ""}`);
    out();
    out(text);
    out();
    out(`  ${dim("Everything else is retrieved on demand —")} ${cyan("mempalace_search")} ${dim("into the room that answers the question.")}`);
    if (tokens && Number(tokens) < 120) {
        warn("that is very little — the palace is nearly empty, so an agent has almost nothing to orient on");
        out(`    ${dim("Run")} ${cyan("long-horizon scan")} ${dim("and file a few real notes.")}`);
    }
    out();
}
