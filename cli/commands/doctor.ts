/**
 * `palace doctor` — prove the map is accurate, or say exactly how it is wrong.
 *
 * This is the command the whole design exists to make possible. A palace earns
 * trust only if something independently verifiable keeps checking it, because a
 * map that is 90% right is more dangerous than no map: you stop verifying, and
 * the 10% is where you get hurt.
 *
 * Failures mean the map is actively wrong and the command exits non-zero, so it
 * can gate CI. Warnings mean the map is thin or drifting but not lying.
 */

import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { resolveProject, palaceDir, mcpPath, portFor, PALACE_DIR, type Project } from "../project.js";
import { ROOMS, CANONICAL_ROOMS, INBOX, renderConfig, readWing } from "../taxonomy.js";
import { readFileSync } from "node:fs";
import { MIN_BODY_CHARS, brokenAnchors } from "../drawer.js";
import { scanPalace, totalDrawers, type Scan } from "../drawers.js";
import { inspectRepo } from "../inspect.js";
import { computeCoverage, bar, pct } from "../coverage.js";
import { volumeExists, dockerAvailable } from "../docker.js";
import { readIndexState, wingTotal } from "../index-state.js";
import { checkMcpConfig } from "../mcp.js";
import { hasSection } from "../claudemd.js";
import { heading, ok, warn, fail, info, hint, out, die, dim, bold, green, red, yellow, cyan } from "../ui.js";

interface Report {
  failures: number;
  warnings: number;
}

export async function doctor(): Promise<void> {
  const project = resolveProject();
  const report: Report = { failures: 0, warnings: 0 };

  if (!existsSync(palaceDir(project))) {
    die(`No palace here. Run \`palace init\` to create one.`);
  }

  const scan = scanPalace(project);

  out();
  out(bold(`Palace doctor — ${project.slug}`));

  checkTaxonomy(project, scan, report);
  checkDrawers(project, scan, report);
  checkCoverage(project, scan, report);
  await checkIndex(project, scan, report);
  await checkWiring(project, report);

  // ---- verdict ---------------------------------------------------------
  out();
  if (report.failures > 0) {
    out(`${red("✗")} ${bold(`${report.failures} failure(s)`)}${report.warnings ? dim(`, ${report.warnings} warning(s)`) : ""}`);
    out(`  ${dim("The map is wrong. Fix these before trusting it.")}`);
    out();
    process.exit(1);
  }
  if (report.warnings > 0) {
    out(`${yellow("!")} ${bold(`${report.warnings} warning(s)`)} ${dim("— the map is accurate but thin or drifting.")}`);
    out();
    return;
  }
  out(`${green("✓")} ${bold("The map is accurate.")}`);
  out();
}

// ---- taxonomy ------------------------------------------------------------

function checkTaxonomy(project: Project, scan: Scan, report: Report): void {
  heading("Taxonomy");

  const configFile = path.join(palaceDir(project), "mempalace.yaml");
  if (!existsSync(configFile)) {
    fail(`${PALACE_DIR}/mempalace.yaml is missing — nothing routes drawers into rooms`);
    hint("run `palace init` to restore it");
    report.failures++;
  } else {
    const actual = readFileSync(configFile, "utf8");
    const expected = renderConfig(project.slug);
    if (actual === expected) {
      ok(`taxonomy matches the canonical seven rooms`);
    } else {
      const wing = readWing(actual);
      if (wing && wing !== project.slug) {
        fail(`config declares wing "${wing}" but this project is "${project.slug}"`);
        hint("drawers are filed under the wrong wing; run `palace init` then `palace sync`");
      } else {
        fail(`${PALACE_DIR}/mempalace.yaml has drifted from the canonical taxonomy`);
        hint("run `palace init` to regenerate it");
      }
      report.failures++;
    }
  }

  if (scan.missingRooms.length) {
    fail(`missing room director${scan.missingRooms.length === 1 ? "y" : "ies"}: ${scan.missingRooms.join(", ")}`);
    hint("run `palace init`");
    report.failures++;
  } else {
    ok("all seven room directories present");
  }

  if (scan.strays.length) {
    fail(`${scan.strays.length} file(s) outside any room — these land in the fallback bucket, not where you think`);
    for (const stray of scan.strays) hint(stray);
    report.failures++;
  }
}

// ---- drawers -------------------------------------------------------------

function checkDrawers(project: Project, scan: Scan, report: Report): void {
  heading("Drawers");

  const misfiled: string[] = [];
  const broken: string[] = [];
  const thin: string[] = [];
  const unanchored: string[] = [];
  const stale: string[] = [];
  const noFrontmatter: string[] = [];

  for (const [room, drawers] of scan.byRoom) {
    for (const drawer of drawers) {
      const { frontmatter, hasFrontmatter } = drawer.parsed;

      if (!hasFrontmatter) {
        noFrontmatter.push(drawer.rel);
      } else if (frontmatter.room && frontmatter.room !== room) {
        // The directory decides routing, so a disagreeing `room:` field is a
        // claim the palace will not honour — the note says one thing and the
        // map does another.
        misfiled.push(`${drawer.rel} ${dim(`claims "${frontmatter.room}", sits in "${room}"`)}`);
      }

      const anchors = frontmatter.anchors ?? [];
      const dead = brokenAnchors(project.root, anchors);
      for (const a of dead) broken.push(`${drawer.rel} → ${a}`);

      if (!anchors.length && CANONICAL_ROOMS.includes(room) && room !== "glossary") {
        unanchored.push(drawer.rel);
      }

      if (drawer.bodyLength < MIN_BODY_CHARS) thin.push(drawer.rel);

      // An anchor edited after the note was last touched means the code moved
      // on and the description may not have.
      if (frontmatter.updated) {
        for (const anchor of anchors) {
          const full = path.join(project.root, anchor);
          if (!existsSync(full)) continue;
          const anchorTime = statSync(full).mtime.getTime();
          const noteTime = Date.parse(`${frontmatter.updated}T23:59:59`);
          if (Number.isFinite(noteTime) && anchorTime > noteTime) {
            stale.push(`${drawer.rel} ${dim(`(${anchor} changed since ${frontmatter.updated})`)}`);
          }
        }
      }
    }
  }

  const total = totalDrawers(scan);
  if (total === 0) {
    warn("no drawers filed yet — the palace is empty");
    report.warnings++;
    return;
  }

  report.failures += emit(fail, misfiled, "drawer(s) filed in a room their frontmatter disagrees with", "move the file, or fix its `room:` field");
  report.failures += emit(fail, broken, "anchor(s) point at paths that no longer exist", "the code moved; update the drawer or the anchor");
  report.failures += emit(fail, thin, `drawer(s) under ${MIN_BODY_CHARS} chars — the miner will skip these entirely`, "add real content or delete the file");

  report.warnings += emit(warn, noFrontmatter, "drawer(s) without frontmatter", "add `room:` and `anchors:` so they can be checked");
  report.warnings += emit(warn, unanchored, "drawer(s) with no anchors — nothing to verify them against", "add `anchors:` pointing at the code they describe");
  report.warnings += emit(warn, stale, "drawer(s) whose anchored code changed after the note was written", "re-read them and bump `updated:`");

  const inbox = scan.byRoom.get(INBOX)?.length ?? 0;
  if (inbox > 0) {
    warn(`${inbox} drawer(s) sitting in inbox — never canonical, never searched with confidence`);
    hint("move each into a real room");
    report.warnings++;
  }

  if (!misfiled.length && !broken.length && !thin.length) {
    ok(`${total} drawer(s), all correctly placed with resolving anchors`);
  }
}

/** Print a group of problems, returning 1 if the group was non-empty. */
function emit(
  print: (s: string) => void,
  items: string[],
  summary: string,
  fix: string,
): number {
  if (!items.length) return 0;
  print(`${items.length} ${summary}`);
  for (const item of items.slice(0, 10)) hint(item);
  if (items.length > 10) hint(`… and ${items.length - 10} more`);
  hint(`fix: ${fix}`);
  return 1;
}

// ---- coverage ------------------------------------------------------------

/**
 * How much of the codebase the map actually says anything about, and how much of
 * the map nobody has checked.
 *
 * Both are warnings, never failures. An incomplete map is not a wrong map — it
 * is an honest one that is not finished, and failing the build over it would
 * teach people to stop running the command.
 */
function checkCoverage(project: Project, scan: Scan, report: Report): void {
  heading("Coverage");

  const facts = inspectRepo(project.root);
  if (facts.sourceFiles.length === 0) {
    info("no source files detected — nothing to cover");
    return;
  }

  const coverage = computeCoverage(project.root, facts, scan);

  out(`  ${dim("module".padEnd(14))} ${dim("files")}  ${dim("mapped")}  ${dim("verified")}`);
  for (const module of coverage.byModule) {
    const line =
      `  ${module.dir.padEnd(14)} ${String(module.total).padStart(5)}  ` +
      `${pct(module.mappedRatio).padStart(6)}  ` +
      `${bar(module.verifiedRatio)} ${pct(module.verifiedRatio).padStart(4)}`;
    if (module.verifiedRatio === 0) out(`${line}  ${yellow("← nobody has verified this")}`);
    else out(line);
  }

  out();
  info(`mapped:   ${coverage.mapped}/${coverage.total} (${pct(coverage.mappedRatio)}) ${dim("— some drawer anchors it")}`);
  info(`verified: ${coverage.verified}/${coverage.total} (${pct(coverage.verifiedRatio)}) ${dim("— a human wrote or confirmed it")}`);

  if (coverage.unmapped.length > 0) {
    warn(`${coverage.unmapped.length} source file(s) no drawer points at`);
    for (const file of coverage.unmapped.slice(0, 8)) hint(file);
    if (coverage.unmapped.length > 8) hint(`… and ${coverage.unmapped.length - 8} more`);
    hint("run `palace scan` for the factual skeleton, then describe what matters");
    report.warnings++;
  }

  // Scanned drawers are on the map from the moment they are written, which is
  // what makes day one useful. Counting them until someone confirms is what
  // stops "generated" from silently becoming "verified".
  let unreviewed = 0;
  for (const drawers of scan.byRoom.values()) {
    for (const drawer of drawers) {
      const { origin, reviewed } = drawer.parsed.frontmatter;
      if (origin === "scan" && reviewed !== true) unreviewed++;
    }
  }

  if (unreviewed > 0) {
    warn(`${unreviewed} drawer(s) written by scan that nobody has reviewed`);
    hint("read each one, correct it, then set `reviewed: true`");
    report.warnings++;
  } else if (coverage.unmapped.length === 0) {
    ok(`every source file is anchored by a verified drawer`);
  }
}

// ---- index ---------------------------------------------------------------

async function checkIndex(project: Project, scan: Scan, report: Report): Promise<void> {
  heading("Index");

  if (!(await dockerAvailable())) {
    warn("Docker is not running — cannot verify the index against disk");
    report.warnings++;
    return;
  }
  if (!(await volumeExists(project.volume))) {
    fail(`volume ${project.volume} does not exist — nothing is searchable`);
    hint("run `palace sync`");
    report.failures++;
    return;
  }

  const index = await readIndexState(project.volume, project.slug);
  if (!index) {
    fail("could not read the index");
    hint("run `palace sync`");
    report.failures++;
    return;
  }

  if (!index.wings.includes(project.slug)) {
    fail(`wing "${project.slug}" is not in the shared palace — this project is not on the map`);
    hint("run `palace sync`");
    report.failures++;
    return;
  }

  // The reconciliation that matters: a drawer can exist on disk, look perfectly
  // correct, and never have made it into the index. Nothing else surfaces that.
  const divergent: string[] = [];
  for (const room of ROOMS) {
    const onDisk = scan.byRoom.get(room.name)?.length ?? 0;
    const inIndex = index.rooms.get(room.name) ?? 0;
    if (onDisk !== inIndex) {
      divergent.push(`${room.name}: ${onDisk} on disk, ${inIndex} indexed`);
    }
  }

  if (divergent.length) {
    fail(`${divergent.length} room(s) where disk and index disagree`);
    for (const d of divergent) hint(d);
    hint("fix: run `palace sync`; if it persists, the drawers are being skipped as too short");
    report.failures++;
  } else {
    ok(`wing "${project.slug}" matches disk (${wingTotal(index)} drawer(s))`);
  }

  // Neighbours are expected — a shared store is what makes cross-project
  // tunnels possible. Reported as context, never as a problem.
  const neighbours = index.wings.filter((w) => w !== project.slug);
  if (neighbours.length) {
    info(`sharing this palace with ${neighbours.length} other wing(s): ${neighbours.join(", ")}`);
  }
}

// ---- wiring --------------------------------------------------------------

async function checkWiring(project: Project, report: Report): Promise<void> {
  heading("Wiring");

  const mcp = checkMcpConfig(mcpPath(project), project);
  if (mcp.ok) {
    ok(`.mcp.json routes mempalace through the proxy on port ${project.port}`);
  } else {
    fail(`.mcp.json: ${mcp.reason}`);
    hint("run `palace init` to rewrite it");
    report.failures++;
  }

  // Ports are derived by hashing the slug into 100 slots, so collisions are
  // rare but real. Two proxies fighting over one socket is a confusing failure,
  // so it gets named here rather than discovered at runtime.
  const index = await readIndexState(project.volume, project.slug);
  const siblings = (index?.wings ?? []).filter((w) => w !== project.slug);
  const collisions = siblings.filter((w) => portFor(w) === project.port);

  if (collisions.length) {
    warn(`port ${project.port} is also derived by: ${collisions.join(", ")}`);
    hint("only matters if both run at once; override HORIZON_WS_PORT in .mcp.json if so");
    report.warnings++;
  } else {
    ok(`port ${project.port} is unique among ${siblings.length + 1} wing(s)`);
  }

  // A palace nothing points at is a palace nobody queries. The MCP server gives
  // the agent the tools; this block is what tells it to use them.
  if (hasSection(project)) {
    ok("CLAUDE.md points Claude at the palace");
  } else {
    warn("CLAUDE.md does not point Claude at the palace");
    hint("an agent has the tools but no reason to prefer them over reading the repo");
    hint("run `long-horizon init` to add the section");
    report.warnings++;
  }
}
