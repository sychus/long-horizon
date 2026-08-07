/**
 * `palace sync` — rebuild the searchable index from the repository.
 *
 * The direction of truth is one-way and never reverses: markdown under
 * `.palace/` is the source, the docker volume is a derived index. Sync mines
 * the former into the latter, then prunes drawers whose source file has been
 * deleted or moved so the index cannot outlive the notes it came from.
 *
 * Only `.palace/` is mined — never the source tree. Ingestion is curated by
 * design, because a map assembled automatically from everything is a map that
 * is confidently wrong in the places nobody checked.
 */

import * as path from "node:path";
import { existsSync } from "node:fs";
import { resolveProject, palaceDir, PALACE_DIR } from "../project.js";
import {
  mempalace,
  volumeExists,
  createVolume,
  dockerAvailable,
  stripNoise,
  isLockContention,
  type RunResult,
} from "../docker.js";
import { readIndexState } from "../index-state.js";
import { heading, ok, warn, info, out, die, dim, cyan } from "../ui.js";

const FILED = /Drawers filed:\s*(\d+)/;
const SKIPPED = /Files skipped[^:]*:\s*(\d+)/;
const PRUNED = /(\d+)\s+drawers?\s+(?:deleted|pruned|removed)/i;

/** Attempts before giving up on the palace lock, and the gap between them. */
const LOCK_RETRIES = 5;
const LOCK_BACKOFF_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run a mempalace command, retrying while another miner holds the palace lock.
 *
 * The store is shared, so two projects syncing at the same moment is ordinary,
 * not exceptional. Verified behaviour: the loser exits non-zero with an explicit
 * "held by PID" message and files nothing — it fails safe, but it does fail, and
 * without a retry a project's drawers would simply be missing from the map.
 */
async function withLockRetry(
  args: string[],
  opts: { volume: string; workdir?: string },
  onWait: (attempt: number) => void,
): Promise<RunResult> {
  let result = await mempalace(args, opts);
  for (let attempt = 1; attempt <= LOCK_RETRIES; attempt++) {
    if (result.code === 0 || !isLockContention(result.stdout + result.stderr)) break;
    onWait(attempt);
    await sleep(LOCK_BACKOFF_MS);
    result = await mempalace(args, opts);
  }
  return result;
}

export async function sync(): Promise<void> {
  const project = resolveProject();

  if (!(await dockerAvailable())) {
    die("Docker is not running.");
  }
  if (!existsSync(palaceDir(project))) {
    die(`No ${PALACE_DIR}/ directory here. Run \`palace init\` first.`);
  }
  if (!existsSync(path.join(palaceDir(project), "mempalace.yaml"))) {
    die(`${PALACE_DIR}/mempalace.yaml is missing — the taxonomy is gone. Run \`palace init\` to restore it.`);
  }
  if (!(await volumeExists(project.volume))) {
    await createVolume(project.volume);
    info(`created volume ${project.volume}`);
  }

  // ---- mine ------------------------------------------------------------
  heading(`Mining ${PALACE_DIR}/ → ${project.slug}`);

  const mined = await withLockRetry(
    ["mine", `/work/${PALACE_DIR}`, "--wing", project.slug, "--agent", "palace-cli"],
    { volume: project.volume, workdir: project.root },
    (attempt) => info(`palace busy — another project is syncing (retry ${attempt}/${LOCK_RETRIES})`),
  );

  if (mined.code !== 0) {
    if (isLockContention(mined.stdout + mined.stderr)) {
      die(
        `The palace stayed locked by another sync after ${LOCK_RETRIES} attempts.\n` +
          `  Nothing was filed. Wait for the other project to finish and run \`palace sync\` again.`,
      );
    }
    out(stripNoise(mined.stderr || mined.stdout));
    die("Mining failed.");
  }

  const output = mined.stdout + mined.stderr;
  const filed = Number(output.match(FILED)?.[1] ?? 0);
  const skipped = Number(output.match(SKIPPED)?.[1] ?? 0);

  if (filed > 0) ok(`${filed} drawer(s) filed`);
  else info("nothing new to file");

  if (skipped > 0) {
    info(`${skipped} file(s) skipped ${dim("(already filed, or too short to index)")}`);
  }

  // ---- prune -----------------------------------------------------------
  // Drops drawers whose source markdown was deleted or moved. Without this the
  // index accumulates answers to questions the repo has stopped asking.
  // Scoped to this wing so a shared store never lets one project's prune reach
  // into another's drawers.
  const pruned = await withLockRetry(
    ["sync", "/work", "--wing", project.slug, "--apply"],
    { volume: project.volume, workdir: project.root },
    (attempt) => info(`palace busy — waiting to prune (retry ${attempt}/${LOCK_RETRIES})`),
  );

  if (pruned.code === 0) {
    const removed = (pruned.stdout + pruned.stderr).match(PRUNED)?.[1];
    if (removed && Number(removed) > 0) ok(`${removed} stale drawer(s) pruned`);
  } else {
    warn("prune step failed — the index may hold drawers whose notes are gone");
  }

  // ---- report ----------------------------------------------------------
  const state = await readIndexState(project.volume, project.slug);
  if (state) {
    heading("Index");
    for (const [room, count] of [...state.rooms].sort()) {
      info(`${room.padEnd(13)} ${count} drawer(s)`);
    }
    out();
    out(`  ${dim("Verify with")} ${cyan("palace doctor")}`);
    out();
  }
}
