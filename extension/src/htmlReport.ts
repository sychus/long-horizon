/**
 * Generates a self-contained HTML session report.
 *
 * Includes: session summary, token breakdown pie chart (inline SVG),
 * event timeline table, and palace graph data — all in one file,
 * no external dependencies.
 */

import type { LongHorizonEvent } from "./types";

interface Bucket {
  label: string;
  color: string;
  tokens: number;
}

const HANDSHAKE = new Set(["initialize", "notifications/initialized", "tools/list"]);
const RETRIEVAL = new Set([
  "mempalace_search", "mempalace_traverse", "mempalace_follow_tunnels",
  "mempalace_find_tunnels", "mempalace_get_drawer", "mempalace_list_drawers",
  "mempalace_kg_query", "mempalace_kg_timeline",
]);
const WRITES = new Set([
  "mempalace_add_drawer", "mempalace_checkpoint", "mempalace_mine",
  "mempalace_create_tunnel", "mempalace_update_drawer", "mempalace_diary_write",
]);
const META = new Set([
  "mempalace_status", "mempalace_list_wings", "mempalace_list_rooms",
  "mempalace_list_hallways", "mempalace_list_tunnels", "mempalace_get_taxonomy",
  "mempalace_graph_stats", "mempalace_get_aaak_spec",
]);

function classify(e: { method?: string | null; tool?: string | null }): number {
  const method = e.method ?? "";
  const tool = e.tool ?? "";
  if (HANDSHAKE.has(method)) return 0;
  if (RETRIEVAL.has(tool)) return 1;
  if (WRITES.has(tool)) return 2;
  if (META.has(tool)) return 3;
  if (tool.startsWith("mempalace_")) return 3;
  return 4;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function pieSvg(buckets: Bucket[], total: number): string {
  if (total === 0) return "";
  const r = 80, cx = 100, cy = 100;
  let angle = -Math.PI / 2;
  let paths = "";

  for (const b of buckets) {
    if (b.tokens === 0) continue;
    const slice = (b.tokens / total) * Math.PI * 2;
    const end = angle + slice;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const large = slice > Math.PI ? 1 : 0;
    paths += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${b.color}" stroke="#1e1e1e" stroke-width="1.5"/>`;
    angle = end;
  }

  return `<svg width="200" height="200" style="display:block;margin:0 auto 12px">
    ${paths}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#d4d4d4" font-size="16" font-weight="bold">${fmtTok(total)}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="#888" font-size="11">tokens</text>
  </svg>`;
}

export function generateHtmlReport(events: LongHorizonEvent[]): string {
  const buckets: Bucket[] = [
    { label: "Handshake", color: "#78909c", tokens: 0 },
    { label: "Search/Retrieve", color: "#4fc3f7", tokens: 0 },
    { label: "Write/Mine", color: "#81c784", tokens: 0 },
    { label: "Meta/Status", color: "#ffb74d", tokens: 0 },
    { label: "Other", color: "#b0bec5", tokens: 0 },
  ];

  let totalTokens = 0;
  let totalCalls = 0;
  let totalLatency = 0;
  let latencyCount = 0;

  for (const e of events) {
    if (e.kind === "session-start") continue;
    if (!("tokens" in e)) continue;
    const tokens = e.tokens;
    totalTokens += tokens;
    buckets[classify(e as { method?: string | null; tool?: string | null })]!.tokens += tokens;

    if (e.kind === "palace" || e.kind === "response") {
      totalCalls++;
      if (e.latencyMs != null) {
        totalLatency += e.latencyMs;
        latencyCount++;
      }
    }
  }

  const avgLatency = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;
  const total = buckets.reduce((s, b) => s + b.tokens, 0);
  const sessionStart = events.find((e) => e.kind === "session-start");
  const ts = sessionStart?.ts ?? new Date().toISOString();

  // Event rows
  const rows = events
    .filter((e) => e.kind !== "session-start")
    .map((e) => {
      if (!("summary" in e)) return "";
      const kind = e.kind;
      const tokens = "tokens" in e ? e.tokens : 0;
      const latency = "latencyMs" in e && e.latencyMs != null ? `${e.latencyMs}ms` : "-";
      const cls = kind === "palace" ? "palace" : kind === "request" ? "request" : "response";
      return `<tr class="${cls}">
        <td>${esc(e.ts.slice(11, 23))}</td>
        <td>${esc(kind)}</td>
        <td>${esc(e.summary)}</td>
        <td class="num">${fmtTok(tokens)}</td>
        <td class="num">${latency}</td>
      </tr>`;
    })
    .join("\n");

  // Legend
  const legend = buckets
    .filter((b) => b.tokens > 0)
    .map((b) => {
      const pct = total > 0 ? ((b.tokens / total) * 100).toFixed(0) : "0";
      return `<div class="legend-item">
        <span class="swatch" style="background:${b.color}"></span>
        ${esc(b.label)}
        <span class="val">${fmtTok(b.tokens)} (${pct}%)</span>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Long Horizon Session Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 4px; color: #fff; }
  .sub { font-size: 12px; color: #888; margin-bottom: 24px; }
  .cards { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .card { background: #252526; border: 1px solid #3c3c3c; border-radius: 6px; padding: 12px 16px; flex: 1; min-width: 140px; }
  .card .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 22px; font-weight: bold; margin-top: 4px; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 14px; color: #fff; margin-bottom: 8px; border-bottom: 1px solid #3c3c3c; padding-bottom: 4px; }
  .pie-section { display: flex; gap: 24px; align-items: flex-start; justify-content: center; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 4px; }
  .swatch { width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
  .val { margin-left: auto; font-variant-numeric: tabular-nums; color: #aaa; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 6px 8px; border-bottom: 2px solid #3c3c3c; color: #888; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td { padding: 4px 8px; border-bottom: 1px solid #2d2d2d; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.palace td { color: #ba68c8; }
  tr.request td { color: #4fc3f7; }
  tr.response td { color: #d4d4d4; }
  tr:hover td { background: #2a2d2e; }
  .footer { margin-top: 32px; font-size: 11px; color: #555; text-align: center; }
</style>
</head>
<body>
  <h1>Long Horizon — Session Report</h1>
  <div class="sub">${esc(ts.slice(0, 19).replace("T", " "))} · ${events.length} events</div>

  <div class="cards">
    <div class="card"><div class="label">Total Tokens</div><div class="value">${fmtTok(totalTokens)}</div></div>
    <div class="card"><div class="label">Tool Calls</div><div class="value">${totalCalls}</div></div>
    <div class="card"><div class="label">Avg Latency</div><div class="value">${avgLatency}ms</div></div>
  </div>

  <div class="section">
    <h2>Token Breakdown</h2>
    <div class="pie-section">
      ${pieSvg(buckets, total)}
      <div>${legend}</div>
    </div>
  </div>

  <div class="section">
    <h2>Event Timeline</h2>
    <table>
      <thead><tr><th>Time</th><th>Kind</th><th>Summary</th><th class="num">Tokens</th><th class="num">Latency</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="footer">Generated by Long Horizon · ${new Date().toISOString().slice(0, 10)}</div>
</body>
</html>`;
}
