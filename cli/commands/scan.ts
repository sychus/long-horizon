/**
 * `palace scan` — the entry point for any repository, new or ten years old.
 *
 * Reads the current state of the working tree and writes the factual skeleton of
 * the map: which modules exist, what runs, where the tests are. From there the
 * palace keeps filling — by a person, by an agent, drawer by drawer.
 *
 * What scan will not do is guess. Every drawer it writes states something that
 * can be re-derived from the repository and checked, and every one is stamped
 * `origin: scan, reviewed: false` so nothing generated can quietly pass as
 * something understood. `decisions/` and `runbooks/` are left empty on purpose:
 * rationale and operational knowledge are not recoverable from source, and a
 * scanner that invented them would produce the confident fiction this whole
 * design exists to prevent.
 *
 * Re-runnable. Anything a human has touched is left alone.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { resolveProject, roomDir, palaceDir, type Project } from "../project.js";
import { inspectRepo, type RepoFacts, type Module } from "../inspect.js";
import { renderDrawer, parseDrawer, today, type Drawer } from "../drawer.js";
import { heading, ok, info, warn, out, die, dim, bold, cyan } from "../ui.js";

interface Planned {
  room: string;
  file: string;
  title: string;
  anchors: string[];
  body: string;
}

const list = (items: string[], max = 20): string =>
  items.slice(0, max).map((i) => `- \`${i}\``).join("\n") +
  (items.length > max ? `\n- …and ${items.length - max} more` : "");

// ---- drawer construction -------------------------------------------------

function structureDrawer(facts: RepoFacts): Planned {
  const rows = facts.modules
    .map((m) => `| \`${m.dir}\` | ${m.sourceFiles.length} | ${m.testFiles.length} |`)
    .join("\n");

  return {
    room: "architecture",
    file: "structure-overview.md",
    title: "Structure overview",
    anchors: facts.modules.map((m) => m.dir).filter((d) => d !== "."),
    body: [
      `The repository has ${facts.sourceFiles.length} source file(s) across ` +
        `${facts.modules.length} top-level module(s), plus ${facts.testFiles.length} test file(s).`,
      "",
      "| Module | Source files | Test files |",
      "|---|---|---|",
      rows,
      "",
      "**Derived from the working tree — describes what exists, not why.**",
      "What belongs here next: how these modules depend on each other, which",
      "boundaries are deliberate, and which ones are accidents nobody has fixed.",
    ].join("\n"),
  };
}

function moduleDrawer(module: Module): Planned {
  const roots = [...new Set(module.sourceFiles.map((f) => path.dirname(f)))].sort();

  return {
    room: "architecture",
    file: `module-${module.dir.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
    title: `Module: ${module.dir}`,
    anchors: [module.dir],
    body: [
      `\`${module.dir}/\` contains ${module.sourceFiles.length} source file(s)` +
        (module.testFiles.length ? ` and ${module.testFiles.length} test file(s)` : "") +
        `, organised across ${roots.length} director${roots.length === 1 ? "y" : "ies"}.`,
      "",
      "Files:",
      list(module.sourceFiles),
      "",
      "**Derived from the working tree.**",
      `What belongs here next: what \`${module.dir}/\` is responsible for, what it`,
      "must not know about, and where its seams are.",
    ].join("\n"),
  };
}

function entryPointsDrawer(facts: RepoFacts): Planned | null {
  const { manifest } = facts;
  if (!manifest.file || manifest.entries.length === 0) return null;

  const rows = manifest.entries
    .map((e) => `| \`${e.label}\` | \`${e.value}\` |`)
    .join("\n");

  return {
    room: "docs",
    file: "entry-points.md",
    title: "Entry points and commands",
    anchors: [manifest.file],
    body: [
      `Declared in \`${manifest.file}\`` + (manifest.name ? ` for \`${manifest.name}\`` : "") + ":",
      "",
      "| Entry | Value |",
      "|---|---|",
      rows,
      "",
      manifest.dependencies.length
        ? `Runtime dependencies: ${manifest.dependencies.map((d) => `\`${d}\``).join(", ")}.`
        : "No runtime dependencies declared.",
      "",
      "**Read from the manifest — states what runs, not how to use it.**",
      "What belongs here next: which of these a newcomer actually needs, in what",
      "order, and what each one expects to already be true.",
    ].join("\n"),
  };
}

function configDrawer(facts: RepoFacts): Planned | null {
  if (facts.configFiles.length === 0) return null;

  return {
    room: "docs",
    file: "configuration-surface.md",
    title: "Configuration surface",
    anchors: facts.configFiles,
    body: [
      `${facts.configFiles.length} configuration file(s) at the repository root:`,
      "",
      list(facts.configFiles),
      "",
      "**Detected by filename — states what is configured, not what the settings mean.**",
      "What belongs here next: which of these you are expected to edit, which are",
      "generated, and what breaks when they disagree.",
    ].join("\n"),
  };
}

function testTopologyDrawer(facts: RepoFacts): Planned {
  const dirs = [...new Set(facts.testFiles.map((f) => path.dirname(f)))].sort();

  // "There are no tests" is a fact, and a load-bearing one. Recording it makes
  // the gap visible on the map instead of leaving the room mysteriously empty.
  const body = facts.testFiles.length
    ? [
        `${facts.testFiles.length} test file(s) across ${dirs.length} director${dirs.length === 1 ? "y" : "ies"}:`,
        "",
        list(dirs),
        "",
        "**Located by path convention — states where tests are, not what they cover.**",
        "What belongs here next: what is actually verified, what is deliberately",
        "not, and which gaps are known and accepted.",
      ]
    : [
        "No test files were detected by path convention (`test`, `spec`, `__tests__`, `e2e`).",
        "",
        "That may mean there are no automated tests, or that they live somewhere",
        "this heuristic does not recognise. Either way it is worth resolving —",
        "an unverified codebase is a map with no ground truth underneath it.",
        "",
        "**Derived from the working tree.**",
        "What belongs here next: how this project is verified, if it is.",
      ];

  return {
    room: "tests",
    file: "test-topology.md",
    title: "Test topology",
    anchors: dirs.length ? dirs : [],
    body: body.join("\n"),
  };
}

function plan(facts: RepoFacts): Planned[] {
  const planned: Planned[] = [structureDrawer(facts)];
  for (const module of facts.modules) {
    if (module.dir !== ".") planned.push(moduleDrawer(module));
  }
  const entries = entryPointsDrawer(facts);
  if (entries) planned.push(entries);
  const config = configDrawer(facts);
  if (config) planned.push(config);
  planned.push(testTopologyDrawer(facts));
  return planned;
}

// ---- writing -------------------------------------------------------------

/**
 * A drawer may only be replaced if scan wrote it and nobody has confirmed it.
 *
 * Re-running scan after a year of edits must never overwrite what someone
 * reasoned about. Absent provenance counts as human — the conservative reading,
 * because destroying real knowledge is far worse than skipping a refresh.
 */
function mayOverwrite(file: string): boolean {
  if (!existsSync(file)) return true;
  const { frontmatter } = parseDrawer(readFileSync(file, "utf8"));
  return frontmatter.origin === "scan" && frontmatter.reviewed !== true;
}

export interface ScanArgs {
  dryRun: boolean;
}

export async function scan(args: ScanArgs): Promise<void> {
  const project: Project = resolveProject();

  if (!existsSync(palaceDir(project))) {
    die(`No palace here yet. Run \`palace init\` first, then \`palace scan\`.`);
  }

  const facts = inspectRepo(project.root);
  if (facts.tracked.length === 0) {
    die(
      `git reported no files in this repository.\n` +
        `  Scan reads the working tree through git so it respects .gitignore.`,
    );
  }

  heading(`Scanning ${bold(project.slug)}`);
  info(`${facts.tracked.length} file(s), ${facts.sourceFiles.length} source, ${facts.testFiles.length} test`);
  info(`${facts.modules.length} module(s), manifest: ${facts.manifest.file ?? "none detected"}`);

  const planned = plan(facts);

  heading(args.dryRun ? "Would write" : "Drawers");
  let written = 0;
  let preserved = 0;

  for (const item of planned) {
    const target = path.join(roomDir(project, item.room), item.file);
    const rel = path.relative(project.root, target);

    if (!mayOverwrite(target)) {
      info(`${rel} ${dim("(kept — reviewed or hand-edited)")}`);
      preserved++;
      continue;
    }

    if (!args.dryRun) {
      mkdirSync(path.dirname(target), { recursive: true });
      const drawer: Drawer = {
        room: item.room,
        title: item.title,
        anchors: item.anchors,
        updated: today(),
        origin: "scan",
        reviewed: false,
        body: item.body,
      };
      writeFileSync(target, renderDrawer(drawer));
    }
    ok(rel);
    written++;
  }

  // ---- what scan deliberately did not do -------------------------------
  heading("Left empty on purpose");
  info(`${cyan("decisions")}  why it is this way, and what was rejected`);
  info(`${cyan("runbooks")}   what to do when it breaks`);
  info(`${cyan("glossary")}   what the domain words mean here`);
  out(`    ${dim("None of this is recoverable from source. A scanner that filled")}`);
  out(`    ${dim("these rooms would be inventing them.")}`);

  heading("Next");
  if (args.dryRun) {
    out(`  ${dim("Dry run — nothing written. Re-run without")} ${cyan("--dry-run")}`);
    out();
    return;
  }
  out(`  ${written} drawer(s) written${preserved ? `, ${preserved} preserved` : ""}, all marked ${dim("origin: scan, reviewed: false")}`);
  out();
  out(`  1. ${cyan("palace sync")}     make the skeleton searchable`);
  out(`  2. Read each drawer, correct it, set ${dim("reviewed: true")}`);
  out(`  3. ${cyan("palace doctor")}   see what is still unreviewed and uncovered`);
  out();
  warn("nothing scan wrote has been verified by a human yet");
  out();
}
