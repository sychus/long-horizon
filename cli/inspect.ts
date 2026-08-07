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

/**
 * What cannot be program source. Everything else is assumed to be.
 *
 * This is deliberately a denylist, and the direction matters more than the
 * contents. An allowlist of known languages fails *silently*: a project written
 * in something not on the list reports as almost empty, and a map that says
 * "there is nothing here" is indistinguishable from a small project. Measured
 * on a real Flutter repo — 197 files, 25 recognised, and the detected "modules"
 * were the platform folders, because every `.dart` file was invisible.
 *
 * Inverted, an unfamiliar language is source by default and works on day one,
 * with no list to maintain. The failure mode flips too: a new kind of data file
 * gets counted as source, which shows up as something visibly asking to be
 * documented rather than as an absence nobody can see.
 *
 * No LLM is involved here on purpose. `scan` must be deterministic, offline and
 * free — the same repo has to produce the same map every time, and asking a
 * model "what counts as code here?" is exactly the kind of guess this command
 * exists to keep out of the palace.
 */
const NON_SOURCE_EXT = new Set([
  // prose
  ".md", ".mdx", ".rst", ".txt", ".adoc", ".org",
  // data and configuration (configuration is surfaced separately)
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".xml", ".csv", ".tsv", ".properties", ".plist", ".lock", ".env",
  // images, fonts, media
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".mov", ".avi", ".webm", ".ogg", ".flac",
  // archives and documents
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".docx", ".xlsx", ".pptx",
  // build output and binaries
  ".map", ".log", ".snap", ".pyc", ".pyo", ".class", ".jar",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".wasm",
]);

const TEST_HINT = /(^|[./_-])(test|tests|spec|specs|__tests__|e2e)([./_-]|$)/i;

/**
 * Directories holding generated output rather than authored code.
 *
 * Normally `.gitignore` keeps these out and git never reports them, but a repo
 * can commit its build deliberately — this one commits `dist/` so global
 * installs work — and then generated files look exactly like source. Measured
 * here: `dist/` was reported as the largest module in this very repository.
 *
 * This is a hardcoded list, which is the thing that was wrong with the language
 * allowlist above. It is defensible where that was not, for two reasons: build
 * directory conventions are a small and slow-moving set, where programming
 * languages are open-ended and keep arriving; and being wrong here is *visible*
 * — a module named `dist` appears in the map and someone notices — where a
 * missing language was invisible by construction.
 */
const GENERATED_DIRS = new Set([
  "dist", "build", "out", "target", "coverage", "vendor", "node_modules",
  ".next", ".nuxt", ".svelte-kit", ".output", "__pycache__", ".venv", "venv",
  "Pods", "DerivedData", "obj",
]);

const isGenerated = (f: string): boolean =>
  f.split("/").some((segment) => GENERATED_DIRS.has(segment));

export interface Module {
  /** Top-level directory under the repo root, or "." for root-level files. */
  dir: string;
  files: string[];
  sourceFiles: string[];
  testFiles: string[];
}

export interface Manifest {
  kind:
    | "node" | "python" | "go" | "rust" | "ruby" | "dart"
    | "php" | "java" | "dotnet" | "elixir" | "unknown";
  file: string | null;
  name: string | null;
  /** Runnable entry points: bin targets, scripts, main. */
  entries: { label: string; value: string }[];
  /** Direct runtime dependencies, names only. */
  dependencies: string[];
}

export interface RepoFacts {
  /** Every git-tracked file, repo-relative. Respects .gitignore for free. */
  tracked: string[];
  sourceFiles: string[];
  testFiles: string[];
  modules: Module[];
  manifest: Manifest;
  /** Config/tooling files present at the root. */
  configFiles: string[];
}

/**
 * Ask git for the file list rather than walking the tree.
 *
 * git already knows exactly what is part of the project and what is build
 * output, vendored, or ignored. Re-implementing that with a directory walk would
 * mean re-implementing .gitignore, badly, and scanning `node_modules` into the
 * map on the first run.
 */
function trackedFiles(root: string): string[] {
  const ls = (args: string[]): string[] => {
    try {
      const stdout = execFileSync("git", ["-C", root, "ls-files", "-z", ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout.split("\0").filter(Boolean);
    } catch {
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

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readManifest(root: string): Manifest {
  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath) ?? {};
    const entries: { label: string; value: string }[] = [];

    const bin = pkg["bin"];
    if (typeof bin === "string") entries.push({ label: "bin", value: bin });
    else if (bin && typeof bin === "object") {
      for (const [k, v] of Object.entries(bin as Record<string, string>)) {
        entries.push({ label: `bin:${k}`, value: v });
      }
    }
    if (typeof pkg["main"] === "string") entries.push({ label: "main", value: pkg["main"] });
    const scripts = pkg["scripts"];
    if (scripts && typeof scripts === "object") {
      for (const [k, v] of Object.entries(scripts as Record<string, string>)) {
        entries.push({ label: `script:${k}`, value: v });
      }
    }

    return {
      kind: "node",
      file: "package.json",
      name: typeof pkg["name"] === "string" ? pkg["name"] : null,
      entries,
      dependencies: Object.keys((pkg["dependencies"] as Record<string, string>) ?? {}),
    };
  }

  // Only the manifest's presence is used for these — entries and dependencies
  // stay empty rather than half-parsed, since a partly-read manifest would put
  // guesses into a map whose whole point is that it does not guess.
  const others: [string, Manifest["kind"]][] = [
    ["pubspec.yaml", "dart"],
    ["pyproject.toml", "python"],
    ["setup.py", "python"],
    ["requirements.txt", "python"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["Gemfile", "ruby"],
    ["composer.json", "php"],
    ["mix.exs", "elixir"],
    ["build.gradle", "java"],
    ["build.gradle.kts", "java"],
    ["pom.xml", "java"],
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
  /^pubspec\.yaml$/, /^analysis_options\.yaml$/, /^go\.mod$/, /^Cargo\.toml$/,
];

/**
 * Extensionless files (LICENSE, Makefile, Dockerfile, CHANGELOG) are not counted
 * as source. They are mostly licence text and build plumbing, and letting them
 * in would inflate the coverage denominator with files nobody should be writing
 * architecture notes about.
 */
const isSource = (f: string): boolean => {
  if (isGenerated(f)) return false;
  const ext = path.extname(f).toLowerCase();
  return ext !== "" && !NON_SOURCE_EXT.has(ext);
};
const isTest = (f: string): boolean => TEST_HINT.test(f);

export function inspectRepo(root: string): RepoFacts {
  // The palace describes the repo; it is not part of what needs describing.
  const tracked = trackedFiles(root).filter((f) => !f.startsWith(".palace/"));

  const sourceFiles = tracked.filter(isSource);
  const testFiles = sourceFiles.filter(isTest);
  const nonTestSource = sourceFiles.filter((f) => !isTest(f));

  const byDir = new Map<string, string[]>();
  for (const file of tracked) {
    const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
    const list = byDir.get(top);
    if (list) list.push(file);
    else byDir.set(top, [file]);
  }

  const modules: Module[] = [...byDir.entries()]
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
export function uncovered(facts: RepoFacts, anchored: Set<string>): string[] {
  return facts.sourceFiles.filter((f) => !anchored.has(f));
}
