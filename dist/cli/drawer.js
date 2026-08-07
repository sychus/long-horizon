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
/**
 * Metadata goes at the *end*, inside an HTML comment.
 *
 * Leading YAML frontmatter is the convention, and it was actively harmful here.
 * MemPalace previews a drawer by taking its first characters, so every search
 * result and every line of `wake-up` opened with
 * `--- room: architecture title: … origin: scan reviewed: false ---` instead of
 * the note itself. Measured on a four-drawer palace: roughly half of a ~323
 * token wake-up budget was spent restating frontmatter the agent already knows.
 *
 * Trailing it means previews start with the title and the first real sentence,
 * which is the whole point of retrieval. The HTML comment keeps it invisible
 * when the file is rendered on GitHub, where it is noise to a human reader too.
 */
export function renderDrawer(d) {
    const meta = [
        `room: ${d.room}`,
        `title: ${d.title}`,
        `anchors: ${d.anchors.join(", ")}`,
        `updated: ${d.updated}`,
    ];
    // Only written when non-default, so hand-authored drawers stay uncluttered.
    if (d.origin && d.origin !== "human")
        meta.push(`origin: ${d.origin}`);
    if (d.reviewed != null)
        meta.push(`reviewed: ${d.reviewed}`);
    return [
        `# ${d.title}`,
        "",
        d.body.trim(),
        "",
        "<!--palace",
        ...meta,
        "-->",
        "",
    ].join("\n");
}
/**
 * Parse a drawer file. Tolerant by design: a file with no metadata is a
 * legitimate parse whose `hasFrontmatter` is false, and `palace doctor` decides
 * whether that is a problem. Parsing and judging are kept separate so the
 * doctor owns every verdict.
 *
 * Both layouts are accepted — trailing `<!--palace … -->` (what we write now)
 * and leading `--- … ---` (what earlier versions wrote). Drawers are committed
 * to real repositories, so a format change must never turn someone's existing
 * notes into unparseable files.
 */
export function parseDrawer(text) {
    const trailing = text.match(/<!--palace\r?\n([\s\S]*?)\r?\n-->/);
    const leading = trailing ? null : text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const match = trailing ?? leading;
    if (!match)
        return { frontmatter: {}, body: text, hasFrontmatter: false };
    const block = match[1] ?? "";
    // Trailing metadata: the body is everything before the comment block.
    const body = trailing
        ? text.slice(0, text.indexOf("<!--palace"))
        : (match[2] ?? "");
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
