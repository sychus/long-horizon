/**
 * The one instruction file the palace still needs.
 *
 * An agent cannot consult a palace it does not know exists. Registering the MCP
 * server gives Claude the *tools*; nothing tells it to reach for them instead of
 * reading half the repository into context.
 *
 * So `init` writes a short block into the project's `CLAUDE.md`. This is not the
 * large context file the palace exists to replace — it is what makes replacing
 * it possible. It says where the knowledge is and to go get it, and deliberately
 * contains no architecture, no decisions and no vocabulary, because every line
 * of that kind is paid for on every session whether it is relevant or not.
 *
 * It lives in the repo rather than in a per-user skill so that someone cloning
 * the project inherits it.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import type { Project } from "./project.js";

const START = "<!-- palace:start -->";
const END = "<!-- palace:end -->";

export const claudeMdPath = (p: Project): string => path.join(p.root, "CLAUDE.md");

export function renderSection(project: Project): string {
  return [
    START,
    "",
    "## Project memory",
    "",
    `This project keeps its knowledge in a memory palace at \`.palace/\`, indexed`,
    `under the wing \`${project.slug}\` and searchable through the \`mempalace\` MCP server.`,
    "",
    "**Search it before reading the codebase broadly.** `mempalace_search` answers",
    "architecture, decisions, docs, tests, runbooks and vocabulary questions from the",
    "room that owns them, and returns the file paths each note describes.",
    "",
    "**Do not add that knowledge to this file.** Anything written here is loaded in",
    "full on every session, relevant or not — that is the cost the palace exists to",
    "avoid. File it instead:",
    "",
    "```bash",
    'palace file --room decisions --title "..." --anchor path/to/file.ts --body "..."',
    "palace update",
    "```",
    "",
    "Run `palace doctor` before trusting the map, and never write with",
    "`mempalace_add_drawer` — it bypasses every check.",
    "",
    END,
  ].join("\n");
}

export type ClaudeMdOutcome = "created" | "updated" | "appended" | "unchanged";

/**
 * Insert or refresh the block, leaving everything else in the file untouched.
 *
 * The markers exist so re-running `init` updates our section in place instead of
 * appending a second copy — and so a project's own instructions, which are none
 * of our business, survive intact.
 */
export function upsertSection(project: Project): ClaudeMdOutcome {
  const file = claudeMdPath(project);
  const section = renderSection(project);

  if (!existsSync(file)) {
    writeFileSync(file, section + "\n");
    return "created";
  }

  const current = readFileSync(file, "utf8");
  const start = current.indexOf(START);
  const end = current.indexOf(END);

  if (start !== -1 && end !== -1 && end > start) {
    const existing = current.slice(start, end + END.length);
    if (existing === section) return "unchanged";
    writeFileSync(file, current.slice(0, start) + section + current.slice(end + END.length));
    return "updated";
  }

  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(file, current + separator + section + "\n");
  return "appended";
}

/** Whether the project carries the block that points an agent at the palace. */
export function hasSection(project: Project): boolean {
  const file = claudeMdPath(project);
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8").includes(START);
}
