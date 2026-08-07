/**
 * Project identity — the thing every other module derives its answers from.
 *
 * A palace is bound to a repository. Given a repo root we must be able to
 * compute, deterministically and from nothing but the path, three values:
 *
 *   slug    — the wing name and the volume suffix
 *   volume  — the docker named volume holding this project's palace
 *   port    — the WebSocket port the Long Horizon proxy listens on
 *
 * Determinism matters more than it looks. The CLI writes `.mcp.json`, the
 * VS Code extension reads it, and neither one may consult shared mutable state
 * to agree on a port. Same repo path in, same numbers out, forever.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
/** Base of the port range. Ports run [19420, 19519]. */
export const PORT_BASE = 19420;
export const PORT_SPAN = 100;
/**
 * The shared store holding every project's wing.
 *
 * One volume, one wing per project. Wings are MemPalace's namespace mechanism
 * and tunnels only link wings *within* a store — so sharing the volume is what
 * makes cross-project links possible at all.
 *
 * Deliberately not `mempalace-data`. That volume holds auto-mined conversation
 * transcripts; mixing curated project drawers into it would put exactly the
 * noise this design excludes back into every search result. Two stores, two
 * jobs: `mempalace-data` remembers conversations, this one maps projects.
 */
export const SHARED_VOLUME = process.env.PALACE_VOLUME ?? "mempalace-atlas";
/**
 * Lowercase, collapse anything that isn't alphanumeric into single dashes,
 * trim leading/trailing dashes.
 *
 * MemPalace wing names have been normalized upstream to reject leading and
 * trailing separators (see `mempalace migrate-wings`), so we produce names
 * that are already in the normalized form and never need migrating.
 */
export function slugify(name) {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!slug)
        throw new Error(`Cannot derive a palace slug from "${name}"`);
    return slug;
}
/**
 * FNV-1a over the slug, folded into the port range.
 *
 * Collisions are possible across 100 slots and are NOT silently tolerated —
 * `palace doctor` reports a port already claimed by a different wing so the
 * user can pin an override rather than have two proxies fight over a socket.
 */
export function portFor(slug) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < slug.length; i++) {
        hash ^= slug.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return PORT_BASE + (hash % PORT_SPAN);
}
/** Walk up from `start` looking for a .git directory. */
export function findRepoRoot(start) {
    let dir = path.resolve(start);
    for (;;) {
        if (existsSync(path.join(dir, ".git")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * Resolve the project for a working directory.
 *
 * Requires a git repository: a palace that isn't version controlled cannot be
 * reviewed, and an unreviewed map is exactly the kind of map that goes wrong
 * without anyone noticing.
 */
export function resolveProject(cwd = process.cwd()) {
    const root = findRepoRoot(cwd);
    if (!root) {
        throw new Error(`No git repository found at or above ${cwd}.\n` +
            `A palace is versioned alongside the code it describes — run \`git init\` first.`);
    }
    const name = path.basename(root);
    const slug = slugify(name);
    return { root, name, slug, volume: SHARED_VOLUME, port: portFor(slug) };
}
// ---- well-known paths inside a project ----------------------------------
/** The room directories live here. One subdirectory per canonical room. */
export const PALACE_DIR = ".palace";
/** MemPalace reads this to decide which room each mined file belongs to. */
export const CONFIG_FILE = "mempalace.yaml";
/** Claude Code project-scoped MCP config. */
export const MCP_FILE = ".mcp.json";
export const palaceDir = (p) => path.join(p.root, PALACE_DIR);
export const roomDir = (p, room) => path.join(palaceDir(p), room);
export const configPath = (p) => path.join(p.root, CONFIG_FILE);
export const mcpPath = (p) => path.join(p.root, MCP_FILE);
