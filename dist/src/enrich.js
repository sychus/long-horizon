/**
 * Event Enricher — extracts MemPalace spatial metadata from tools/call
 * request-response pairs and produces PalaceEvents.
 *
 * Best-effort: if parsing fails, returns null and the caller falls back
 * to emitting a standard RequestEvent + ResponseEvent.
 */
function str(v) {
    return typeof v === "string" ? v : null;
}
function extractLocation(args) {
    const wing = str(args.wing ?? args.source_wing ?? args.start_room ? null : null);
    const room = str(args.room ?? args.source_room ?? args.start_room);
    const drawerId = str(args.drawer_id);
    // For tools that take wing/room as direct args
    const w = str(args.wing) ?? str(args.source_wing) ?? str(args.wing_a);
    const r = str(args.room) ?? str(args.source_room) ?? str(args.start_room);
    const d = str(args.drawer_id);
    if (!w && !r && !d)
        return null;
    return { wing: w, room: r, drawerId: d };
}
function preview(content) {
    if (typeof content !== "string")
        return null;
    return content.length > 120 ? content.slice(0, 120) + "..." : content;
}
function extractSearchHits(result) {
    if (!result || typeof result !== "object")
        return [];
    const content = result.content;
    if (!Array.isArray(content))
        return [];
    // MCP tool results come as content[].text — parse the text as JSON
    const hits = [];
    for (const item of content) {
        if (typeof item !== "object" || item === null)
            continue;
        const text = item.text;
        if (typeof text !== "string")
            continue;
        try {
            const parsed = JSON.parse(text);
            // Search results may be an array or a single object with results
            const results = Array.isArray(parsed) ? parsed : parsed.results ?? [parsed];
            for (const r of results) {
                if (typeof r !== "object" || r === null)
                    continue;
                const rec = r;
                hits.push({
                    wing: str(rec.wing) ?? "?",
                    room: str(rec.room) ?? "?",
                    drawerId: str(rec.drawer_id ?? rec.id),
                    distance: typeof rec.distance === "number" ? rec.distance : null,
                    preview: preview(rec.content ?? rec.content_preview),
                });
            }
        }
        catch {
            // Not JSON — try to extract from plaintext
        }
    }
    return hits;
}
function extractTraverseHits(result) {
    if (!result || typeof result !== "object")
        return [];
    const content = result.content;
    if (!Array.isArray(content))
        return [];
    const hits = [];
    for (const item of content) {
        if (typeof item !== "object" || item === null)
            continue;
        const text = item.text;
        if (typeof text !== "string")
            continue;
        try {
            const parsed = JSON.parse(text);
            const nodes = Array.isArray(parsed) ? parsed : parsed.nodes ?? parsed.connections ?? [parsed];
            for (const n of nodes) {
                if (typeof n !== "object" || n === null)
                    continue;
                const rec = n;
                if (rec.wing || rec.room) {
                    hits.push({
                        wing: str(rec.wing) ?? "?",
                        room: str(rec.room) ?? "?",
                        drawerId: str(rec.drawer_id ?? rec.id),
                        distance: null,
                        preview: preview(rec.content ?? rec.content_preview ?? rec.label),
                    });
                }
            }
        }
        catch {
            // ignore
        }
    }
    return hits;
}
function extractDrawerHit(result) {
    if (!result || typeof result !== "object")
        return [];
    const content = result.content;
    if (!Array.isArray(content))
        return [];
    for (const item of content) {
        if (typeof item !== "object" || item === null)
            continue;
        const text = item.text;
        if (typeof text !== "string")
            continue;
        try {
            const parsed = JSON.parse(text);
            if (parsed.wing || parsed.room) {
                return [{
                        wing: str(parsed.wing) ?? "?",
                        room: str(parsed.room) ?? "?",
                        drawerId: str(parsed.drawer_id ?? parsed.id),
                        distance: null,
                        preview: preview(parsed.content),
                    }];
            }
        }
        catch {
            // ignore
        }
    }
    return [];
}
/** Tool name → hit extractor. */
const hitExtractors = {
    mempalace_search: extractSearchHits,
    mempalace_traverse: extractTraverseHits,
    mempalace_follow_tunnels: extractTraverseHits,
    mempalace_find_tunnels: extractTraverseHits,
    mempalace_get_drawer: extractDrawerHit,
    mempalace_list_drawers: extractSearchHits,
    mempalace_list_rooms: extractTraverseHits,
    mempalace_list_wings: extractTraverseHits,
    mempalace_get_taxonomy: extractTraverseHits,
    mempalace_add_drawer: extractDrawerHit,
    mempalace_checkpoint: extractSearchHits,
    mempalace_kg_query: extractTraverseHits,
    mempalace_kg_timeline: extractTraverseHits,
};
/**
 * Try to produce a PalaceEvent from a tools/call request+response pair.
 * Returns null if the tool is not a mempalace_* tool.
 */
export function enrich(input) {
    if (!input.tool.startsWith("mempalace_"))
        return null;
    const extractor = hitExtractors[input.tool] ?? (() => []);
    return {
        kind: "palace",
        ts: input.ts,
        direction: "server->client",
        bytes: input.bytes,
        tokens: input.tokens,
        id: input.id,
        method: "tools/call",
        tool: input.tool,
        location: extractLocation(input.args),
        hits: extractor(input.result),
        latencyMs: input.latencyMs,
        isError: input.isError,
        summary: `palace ${input.tool} ~${input.tokens}tok${input.latencyMs != null ? ` ${input.latencyMs}ms` : ""}${input.isError ? " ERROR" : ""}`,
    };
}
