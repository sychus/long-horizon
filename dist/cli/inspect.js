/**
 * Repository inspection — facts only.
 *
 * Everything here is read directly off the repository and can be re-derived and
 * checked at any time: which files git tracks, which modules exist, what the
 * manifest declares, where the tests live. Nothing is inferred about intent.
 *
 * That boundary is the whole reason `palace scan` is safe to run on a codebase
 * with years of history. A scanner that guessed *why* something is the way it is
 * would fill the map with confident fiction, and a map you cannot trust is worse
 * than no map at all. So: structure, inventory, entry points, topology — yes.
 * Rationale, tradeoffs, invariants — never. Those rooms stay empty until a
 * person or an agent that actually reasoned about the project fills them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
/** Extensions treated as source for coverage and module grouping. */
const SOURCE_EXT = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".scala", ".ex", ".exs",
    ".vue", ".svelte",
]);
const TEST_HINT = /(^|[./_-])(test|tests|spec|specs|__tests__|e2e)([./_-]|$)/i;
/**
 * Ask git for the file list rather than walking the tree.
 *
 * git already knows exactly what is part of the project and what is build
 * output, vendored, or ignored. Re-implementing that with a directory walk would
 * mean re-implementing .gitignore, badly, and scanning `node_modules` into the
 * map on the first run.
 */
function trackedFiles(root) {
    const ls = (args) => {
        try {
            const stdout = execFileSync("git", ["-C", root, "ls-files", "-z", ...args], {
                encoding: "utf8",
                maxBuffer: 64 * 1024 * 1024,
            });
            return stdout.split("\0").filter(Boolean);
        }
        catch {
            return [];
        }
    };
    // Tracked files, plus untracked ones git does not ignore. "Scan the current
    // state" has to mean the working tree as it stands — a module written this
    // morning and not yet committed is part of the project, and a scanner that
    // skipped it would report a map that is complete only by accident.
    // `--exclude-standard` keeps .gitignore honoured, so build output stays out.
    return [...new Set([...ls([]), ...ls(["--others", "--exclude-standard"])])].sort();
}
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
function readManifest(root) {
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
        const pkg = readJson(pkgPath) ?? {};
        const entries = [];
        const bin = pkg["bin"];
        if (typeof bin === "string")
            entries.push({ label: "bin", value: bin });
        else if (bin && typeof bin === "object") {
            for (const [k, v] of Object.entries(bin)) {
                entries.push({ label: `bin:${k}`, value: v });
            }
        }
        if (typeof pkg["main"] === "string")
            entries.push({ label: "main", value: pkg["main"] });
        const scripts = pkg["scripts"];
        if (scripts && typeof scripts === "object") {
            for (const [k, v] of Object.entries(scripts)) {
                entries.push({ label: `script:${k}`, value: v });
            }
        }
        return {
            kind: "node",
            file: "package.json",
            name: typeof pkg["name"] === "string" ? pkg["name"] : null,
            entries,
            dependencies: Object.keys(pkg["dependencies"] ?? {}),
        };
    }
    const others = [
        ["pyproject.toml", "python"],
        ["setup.py", "python"],
        ["go.mod", "go"],
        ["Cargo.toml", "rust"],
        ["Gemfile", "ruby"],
    ];
    for (const [file, kind] of others) {
        if (existsSync(path.join(root, file))) {
            return { kind, file, name: null, entries: [], dependencies: [] };
        }
    }
    return { kind: "unknown", file: null, name: null, entries: [], dependencies: [] };
}
const CONFIG_PATTERNS = [
    /^tsconfig.*\.json$/, /^\.eslintrc/, /^eslint\.config\./, /^\.prettierrc/,
    /^vite\.config\./, /^webpack\.config\./, /^rollup\.config\./, /^next\.config\./,
    /^jest\.config\./, /^vitest\.config\./, /^playwright\.config\./, /^pytest\.ini$/,
    /^Dockerfile/, /^docker-compose/, /^Makefile$/, /^\.env\.example$/,
    /^\.github$/, /^tox\.ini$/, /^ruff\.toml$/, /^\.mcp\.json$/,
];
const isSource = (f) => SOURCE_EXT.has(path.extname(f));
const isTest = (f) => TEST_HINT.test(f);
export function inspectRepo(root) {
    // The palace describes the repo; it is not part of what needs describing.
    const tracked = trackedFiles(root).filter((f) => !f.startsWith(".palace/"));
    const sourceFiles = tracked.filter(isSource);
    const testFiles = sourceFiles.filter(isTest);
    const nonTestSource = sourceFiles.filter((f) => !isTest(f));
    const byDir = new Map();
    for (const file of tracked) {
        const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
        const list = byDir.get(top);
        if (list)
            list.push(file);
        else
            byDir.set(top, [file]);
    }
    const modules = [...byDir.entries()]
        .map(([dir, files]) => ({
        dir,
        files,
        sourceFiles: files.filter((f) => isSource(f) && !isTest(f)),
        testFiles: files.filter((f) => isSource(f) && isTest(f)),
    }))
        // A directory with no source is documentation, assets or config — real, but
        // not something an architecture drawer has anything to say about.
        .filter((m) => m.sourceFiles.length > 0 || m.testFiles.length > 0)
        .sort((a, b) => b.sourceFiles.length - a.sourceFiles.length);
    const configFiles = tracked.filter((f) => {
        const base = path.basename(f);
        return !f.includes("/") && CONFIG_PATTERNS.some((p) => p.test(base));
    });
    return {
        tracked,
        sourceFiles: nonTestSource,
        testFiles,
        modules,
        manifest: readManifest(root),
        configFiles,
    };
}
/** Files with no drawer anchoring them — the measurable shape of "incomplete". */
export function uncovered(facts, anchored) {
    return facts.sourceFiles.filter((f) => !anchored.has(f));
}
