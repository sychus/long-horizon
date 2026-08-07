/**
 * `palace file` — author a drawer, with the checks applied at write time.
 *
 * Every gate here exists because the alternative is a map that is wrong without
 * anybody knowing: an unknown room silently becomes the fallback bucket, a
 * mistyped anchor points at nothing, and a two-line body is skipped by the miner
 * entirely. Catching those at authoring time is cheap. Discovering them months
 * later, while trusting the map, is not.
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { resolveProject, roomDir } from "../project.js";
import { ROOM_NAMES, isRoom, INBOX } from "../taxonomy.js";
import {
  renderDrawer,
  drawerFilename,
  today,
  brokenAnchors,
  MIN_BODY_CHARS,
} from "../drawer.js";
import { heading, ok, warn, info, out, die, dim, cyan, bold } from "../ui.js";

export interface FileArgs {
  room?: string;
  title?: string;
  anchors: string[];
  body?: string;
  force: boolean;
}

/** Read piped stdin, if any. Returns "" when stdin is a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function fileDrawer(args: FileArgs): Promise<void> {
  const project = resolveProject();

  if (!args.room) {
    die(`--room is required. One of: ${ROOM_NAMES.join(", ")}`);
  }
  if (!isRoom(args.room)) {
    die(
      `"${args.room}" is not a room in this palace.\n` +
        `  Valid rooms: ${ROOM_NAMES.join(", ")}\n` +
        `  The taxonomy is fixed on purpose — every palace has the same seven rooms.`,
    );
  }
  if (!args.title) {
    die(`--title is required.`);
  }

  const body = (args.body ?? (await readStdin())).trim();
  if (!body) {
    die(
      `No content. Pass --body "..." or pipe it:\n` +
        `  echo "..." | palace file --room ${args.room} --title "${args.title}"`,
    );
  }

  // ---- anchors ---------------------------------------------------------
  const broken = brokenAnchors(project.root, args.anchors);
  if (broken.length && !args.force) {
    die(
      `These anchors do not exist in the repo:\n` +
        broken.map((a) => `    ${a}`).join("\n") +
        `\n  Anchors are what make a drawer checkable later. Fix the paths, or pass --force.`,
    );
  }

  // ---- write -----------------------------------------------------------
  const dir = roomDir(project, args.room);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, drawerFilename(args.title));

  if (existsSync(target) && !args.force) {
    die(`${path.relative(project.root, target)} already exists. Edit it, or pass --force to overwrite.`);
  }

  writeFileSync(
    target,
    renderDrawer({
      room: args.room,
      title: args.title,
      anchors: args.anchors,
      updated: today(),
      body,
    }),
  );

  heading(`Filed into ${bold(args.room)}`);
  ok(path.relative(project.root, target));
  if (args.anchors.length) {
    info(`anchors: ${args.anchors.join(", ")}`);
  } else {
    warn("no anchors — this drawer cannot be checked for rot later");
  }
  if (broken.length) {
    warn(`forced past ${broken.length} broken anchor(s)`);
  }
  if (body.length < MIN_BODY_CHARS) {
    warn(
      `body is ${body.length} chars; drawers under ~${MIN_BODY_CHARS} are skipped by the miner ` +
        `and will not be searchable`,
    );
  }
  if (args.room === INBOX) {
    info("inbox is never canonical — move this into a real room when you know where it belongs");
  }
  out();
  out(`  ${dim("Run")} ${cyan("palace sync")} ${dim("to make it searchable.")}`);
  out();
}
