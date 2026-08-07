/**
 * `palace init` — scaffold a project's palace.
 *
 * Creates the room directories, the generated MemPalace config, the docker
 * volume, and the project-scoped MCP wiring. Idempotent: running it on an
 * already-initialized project repairs drift instead of failing or duplicating.
 *
 * Generated files (`mempalace.yaml`, `.mcp.json`) are always rewritten to their
 * canonical form — they are outputs, not settings. Room READMEs are written only
 * when absent, because those are yours to edit.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { resolveProject, palaceDir, roomDir, mcpPath, type Project } from "../project.js";
import { ROOMS, renderConfig, ROOM_PLACEHOLDER } from "../taxonomy.js";
import { dockerAvailable, imageExists, volumeExists, createVolume } from "../docker.js";
import { writeMcpConfig, proxyCommandInstalled, PROXY_COMMAND, INSTALL_HINT } from "../mcp.js";
import { upsertSection } from "../claudemd.js";
import { heading, ok, info, warn, out, die, dim, bold, cyan, yellow } from "../ui.js";

export async function init(): Promise<void> {
  const project = resolveProject();

  heading(`Wing: ${bold(project.slug)}`);
  info(`repo    ${project.root}`);
  info(`store   ${project.volume} ${dim("(shared — one wing per project)")}`);
  info(`port    ${project.port}`);

  if (!(await dockerAvailable())) {
    die("Docker is not running. Start Docker Desktop and run `palace init` again.");
  }
  if (!(await imageExists())) {
    die(
      "The `mempalace` image is not built.\n" +
        "  Build it with:  docker build -t mempalace https://github.com/MemPalace/mempalace.git",
    );
  }

  // ---- rooms -----------------------------------------------------------
  heading("Rooms");
  mkdirSync(palaceDir(project), { recursive: true });

  for (const room of ROOMS) {
    const dir = roomDir(project, room.name);
    const created = !existsSync(dir);
    mkdirSync(dir, { recursive: true });

    // Keeps the empty room in git without putting minable text inside it.
    const placeholder = path.join(dir, ROOM_PLACEHOLDER);
    if (!existsSync(placeholder)) writeFileSync(placeholder, "");
    const label = `${room.name.padEnd(13)} ${dim(room.description)}`;
    created ? ok(label) : info(label);
  }

  // ---- generated config ------------------------------------------------
  heading("Configuration");

  const configFile = path.join(palaceDir(project), "mempalace.yaml");
  writeFileSync(configFile, renderConfig(project.slug));
  ok(`.palace/mempalace.yaml ${dim("(taxonomy — generated)")}`);

  writeMcpConfig(mcpPath(project), project);
  ok(`.mcp.json ${dim(`(${PROXY_COMMAND} → ${project.volume}, wing ${project.slug})`)}`);

  // Registering the MCP server gives Claude the tools; this is what tells it to
  // reach for them instead of reading the repository into context.
  const claudeMd = upsertSection(project);
  const note: Record<typeof claudeMd, string> = {
    created: "created — points Claude at the palace",
    updated: "palace section refreshed, your own content untouched",
    appended: "palace section added, your own content untouched",
    unchanged: "already points Claude at the palace",
  };
  ok(`CLAUDE.md ${dim(`(${note[claudeMd]})`)}`);

  // The config names a command rather than a path so it survives being cloned,
  // which means the command has to exist on each machine that uses it.
  if (!proxyCommandInstalled()) {
    warn(`\`${PROXY_COMMAND}\` is not on your PATH yet`);
    out(`    ${dim(`MemPalace will not start until it is — ${INSTALL_HINT}.`)}`);
  }

  // ---- volume ----------------------------------------------------------
  heading("Index");
  if (await volumeExists(project.volume)) {
    info(`shared store ${project.volume} already exists`);
  } else {
    await createVolume(project.volume);
    ok(`created shared store ${project.volume}`);
  }

  // ---- next steps ------------------------------------------------------
  heading("Next");
  out(`  1. ${cyan("long-horizon scan")}    map the code that already exists`);
  out(`  2. ${cyan("long-horizon update")}  build the searchable index`);
  out(`  3. ${cyan("long-horizon doctor")}  verify the map is accurate`);
  out();
  out(`  ${dim("Commit .palace/, .mcp.json and CLAUDE.md — the palace is versioned with the code.")}`);

  // Claude Code reads .mcp.json once at startup and cannot reload it, so the
  // session that ran this command is precisely the one without the tools. Said
  // quietly, that becomes a silent failure: the agent reads the whole repo
  // instead and the palace looks useless on the day it was built.
  if (process.env["CLAUDECODE"]) {
    out();
    out(`  ${yellow("▸")} ${bold("This Claude Code session cannot see the palace yet.")}`);
    out(`    ${dim("Claude Code reads .mcp.json at startup and cannot reload it — the")}`);
    out(`    ${dim("mempalace tools appear in your next session, not this one.")}`);
    out();
    out(`    ${dim("Nothing is blocked meanwhile:")} ${cyan("palace search \"...\"")} ${dim("works right now,")}`);
    out(`    ${dim("in this session, over the same index.")}`);
  }
  out();
}
