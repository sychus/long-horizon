/**
 * Drawer authoring and validation.
 *
 * A drawer is a markdown file under `.palace/<room>/` with a small, strict
 * frontmatter block:
 *
 *   ---
 *   room: architecture
 *   title: Proxy boundary
 *   anchors: src/proxy.ts, src/server.ts
 *   updated: 2026-08-07
 *   ---
 *
 * `anchors` is the load-bearing field. A note about architecture that does not
 * point at the code it describes cannot be checked, and anything that cannot be
 * checked rots quietly. Anchors give `palace doctor` something falsifiable:
 * if `src/proxy.ts` disappears, the drawer describing it is provably suspect.
 *
 * The frontmatter is deliberately flat — single-line scalars and a comma
 * separated anchor list — so it parses without a YAML dependency and cannot
 * express structure that later needs interpreting.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
/**
 * Bodies shorter than this risk being silently skipped by the miner.
 *
 * Measured against MemPalace 3.5.0: a 20-character body was skipped, 40 and
 * above were filed. A skipped drawer is the worst failure mode this tool has —
 * the file exists, you believe it is in the map, and it is not — so we warn at
 * write time and reconcile authoritatively in `palace doctor`.
 */
export const MIN_BODY_CHARS = 40;
export function renderDrawer(d) {
    const lines = [
        "---",
        `room: ${d.room}`,
        `title: ${d.title}`,
        `anchors: ${d.anchors.join(", ")}`,
        `updated: ${d.updated}`,
    ];
    // Only written when non-default, so hand-authored drawers stay uncluttered.
    if (d.origin && d.origin !== "human")
        lines.push(`origin: ${d.origin}`);
    if (d.reviewed != null)
        lines.push(`reviewed: ${d.reviewed}`);
    lines.push("---", "", `# ${d.title}`, "", d.body.trim(), "");
    return lines.join("\n");
}
/**
 * Parse a drawer file. Tolerant by design: a file with no frontmatter is a
 * legitimate parse whose `hasFrontmatter` is false, and `palace doctor` decides
 * whether that is a problem. Parsing and judging are kept separate so the
 * doctor owns every verdict.
 */
export function parseDrawer(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match)
        return { frontmatter: {}, body: text, hasFrontmatter: false };
    const block = match[1] ?? "";
    const body = match[2] ?? "";
    const frontmatter = {};
    for (const line of block.split(/\r?\n/)) {
        const kv = line.match(/^([a-z]+):[ \t]*(.*)$/);
        if (!kv)
            continue;
        const key = kv[1];
        const value = (kv[2] ?? "").trim();
        if (key === "room")
            frontmatter.room = value;
        else if (key === "title")
            frontmatter.title = value;
        else if (key === "updated")
            frontmatter.updated = value;
        else if (key === "origin")
            frontmatter.origin = value === "scan" ? "scan" : "human";
        else if (key === "reviewed")
            frontmatter.reviewed = value === "true";
        else if (key === "anchors") {
            frontmatter.anchors = value
                .replace(/^\[|\]$/g, "")
                .split(",")
                .map((a) => a.trim())
                .filter(Boolean);
        }
    }
    return { frontmatter, body, hasFrontmatter: true };
}
/** Filesystem-safe slug for a drawer filename. */
export function drawerFilename(title) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `${slug || "untitled"}.md`;
}
/** Today as YYYY-MM-DD, in local time. */
export function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Anchors that do not resolve against the repo root. */
export function brokenAnchors(root, anchors) {
    return anchors.filter((a) => !existsSync(path.join(root, a)));
}
