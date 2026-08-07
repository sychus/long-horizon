/**
 * Coverage — turning "is the map complete?" into a number.
 *
 * `palace doctor` answers "is what is written correct?". That is a different
 * question from "is anything written at all?", and a palace can pass the first
 * while failing the second badly: two drawers, forty undocumented files, and a
 * clean green report. Green and empty is its own kind of lie, because the green
 * is what stops you looking.
 *
 * Anchors make the second question answerable. Every drawer points at real
 * paths, so the set of anchored files can be subtracted from the set of source
 * files, and what remains is the part of the codebase the map says nothing about.
 */

import * as path from "node:path";
import { statSync, existsSync } from "node:fs";
import type { RepoFacts } from "./inspect.js";
import type { Scan } from "./drawers.js";

export interface ModuleCoverage {
  dir: string;
  total: number;
  /** Anchored by any drawer, including unreviewed scan output. */
  mapped: number;
  /** Anchored by a drawer a human wrote or confirmed. */
  verified: number;
  mappedRatio: number;
  verifiedRatio: number;
}

/**
 * Two numbers, because they answer different questions.
 *
 * `mapped` counts any anchor at all. Straight after `palace scan` this is
 * usually 100%, since module drawers anchor whole directories — which is
 * accurate but nearly meaningless: an inventory of filenames is not knowledge.
 * Reporting it alone would recreate the exact false confidence this tool exists
 * to remove, just by a quieter route.
 *
 * `verified` counts only drawers a person wrote or confirmed. That is the number
 * that tracks whether anyone actually understands the codebase, and it starts at
 * zero no matter how much scan produced.
 */
export interface Coverage {
  mapped: number;
  verified: number;
  total: number;
  mappedRatio: number;
  verifiedRatio: number;
  byModule: ModuleCoverage[];
  /** Source files no drawer points at. */
  unmapped: string[];
}

/**
 * Expand every anchor into the set of source files it accounts for.
 *
 * A directory anchor covers the files beneath it. Module-level drawers say
 * "`cli/` does this", which is a real statement about all of it — forcing them
 * to list every file instead would make the frontmatter unusable on any codebase
 * large enough to need a map.
 */
function anchoredFiles(root: string, anchors: string[], sourceFiles: string[]): Set<string> {
  // Anchors legitimately point at things that are not source — a manifest, a
  // tsconfig, a directory. Only source files may enter this set, or the count
  // is measured against a different population than the total and coverage can
  // exceed 100%.
  const source = new Set(sourceFiles);
  const covered = new Set<string>();

  for (const anchor of anchors) {
    const full = path.join(root, anchor);
    if (!existsSync(full)) continue;

    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      const prefix = anchor.endsWith("/") ? anchor : `${anchor}/`;
      for (const file of sourceFiles) {
        if (file.startsWith(prefix)) covered.add(file);
      }
    } else if (source.has(anchor)) {
      covered.add(anchor);
    }
  }

  return covered;
}

/** A drawer counts as verified unless it is unconfirmed scan output. */
const isVerified = (origin: string | undefined, reviewed: boolean | undefined): boolean =>
  origin !== "scan" || reviewed === true;

export function computeCoverage(root: string, facts: RepoFacts, scan: Scan): Coverage {
  const allAnchors: string[] = [];
  const verifiedAnchors: string[] = [];

  for (const drawers of scan.byRoom.values()) {
    for (const drawer of drawers) {
      const { anchors = [], origin, reviewed } = drawer.parsed.frontmatter;
      allAnchors.push(...anchors);
      if (isVerified(origin, reviewed)) verifiedAnchors.push(...anchors);
    }
  }

  const mapped = anchoredFiles(root, allAnchors, facts.sourceFiles);
  const verified = anchoredFiles(root, verifiedAnchors, facts.sourceFiles);
  const unmapped = facts.sourceFiles.filter((f) => !mapped.has(f));

  const byModule: ModuleCoverage[] = facts.modules
    .filter((m) => m.sourceFiles.length > 0)
    .map((m) => {
      const mappedHit = m.sourceFiles.filter((f) => mapped.has(f)).length;
      const verifiedHit = m.sourceFiles.filter((f) => verified.has(f)).length;
      return {
        dir: m.dir,
        total: m.sourceFiles.length,
        mapped: mappedHit,
        verified: verifiedHit,
        mappedRatio: mappedHit / m.sourceFiles.length,
        verifiedRatio: verifiedHit / m.sourceFiles.length,
      };
    })
    .sort((a, b) => a.verifiedRatio - b.verifiedRatio);

  const total = facts.sourceFiles.length;

  return {
    mapped: mapped.size,
    verified: verified.size,
    total,
    mappedRatio: total === 0 ? 1 : mapped.size / total,
    verifiedRatio: total === 0 ? 1 : verified.size / total,
    byModule,
    unmapped,
  };
}

/** Ten-cell bar. Plain ASCII so it survives any terminal or CI log. */
export function bar(ratio: number, width = 10): string {
  const filled = Math.round(ratio * width);
  return "#".repeat(filled) + ".".repeat(width - filled);
}

export const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;
