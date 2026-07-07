/**
 * Palace Map — webview-side D3 rendering.
 *
 * Receives events from the extension host via postMessage and renders a
 * force-directed graph of wings, rooms, and tunnel connections.
 *
 * Nodes pulse when a PalaceEvent arrives. Accumulated heat (access count)
 * shifts the node color toward warm tones.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import { scaleSequential } from "d3-scale";
import { interpolateYlOrRd } from "d3-scale-chromatic";
import "d3-transition"; // side-effect import for selection.transition()

// ---- Types ----------------------------------------------------------------

interface PalaceHit {
  wing: string;
  room: string;
  drawerId: string | null;
  distance: number | null;
  preview: string | null;
}

interface PalaceEvent {
  kind: "palace";
  tool: string;
  location: { wing: string | null; room: string | null } | null;
  hits: PalaceHit[];
  tokens: number;
  latencyMs: number | null;
}

/** Any event from the proxy (we only need kind/tokens/method/tool for the pie). */
interface AnyEvent {
  kind: string;
  tokens?: number;
  method?: string;
  tool?: string | null;
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  type: "wing" | "room";
  wing: string;
  room: string | null;
  heat: number;
  radius: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  type: "contains" | "tunnel";
  label?: string;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// ---- State ----------------------------------------------------------------

const vscode = acquireVsCodeApi();
const nodes: GraphNode[] = [];
const links: GraphLink[] = [];
const nodeMap = new Map<string, GraphNode>();
let showLabels = true;
let paused = false;

// Heat color scale: 0 = cool (blue-ish), high = hot (orange/red)
const heatScale = scaleSequential(interpolateYlOrRd).domain([0, 20]);

// Base colors per wing (hash-derived)
const wingColors = new Map<string, string>();
const PALETTE = [
  "#4fc3f7", "#81c784", "#ffb74d", "#e57373", "#ba68c8",
  "#4dd0e1", "#aed581", "#ff8a65", "#f06292", "#7986cb",
];

function wingColor(wing: string): string {
  if (!wingColors.has(wing)) {
    wingColors.set(wing, PALETTE[wingColors.size % PALETTE.length]!);
  }
  return wingColors.get(wing)!;
}

function nodeId(wing: string, room?: string | null): string {
  return room ? `${wing}/${room}` : wing;
}

// ---- Graph construction ---------------------------------------------------

function ensureNode(wing: string, room: string | null): GraphNode {
  const id = nodeId(wing, room);
  let node = nodeMap.get(id);
  if (!node) {
    node = {
      id,
      type: room ? "room" : "wing",
      wing,
      room,
      heat: 0,
      radius: room ? 8 : 18,
    };
    nodes.push(node);
    nodeMap.set(id, node);

    // If this is a room, ensure its wing exists and link them
    if (room) {
      const wingNode = ensureNode(wing, null);
      const linkId = `${wingNode.id}->${id}`;
      if (!links.some((l) => `${(l.source as GraphNode).id ?? l.source}->${(l.target as GraphNode).id ?? l.target}` === linkId)) {
        links.push({ source: wingNode.id as unknown as GraphNode, target: id as unknown as GraphNode, type: "contains" });
      }
    }
  }
  return node;
}

function ensureTunnel(srcWing: string, srcRoom: string, tgtWing: string, tgtRoom: string): void {
  ensureNode(srcWing, srcRoom);
  ensureNode(tgtWing, tgtRoom);
  const srcId = nodeId(srcWing, srcRoom);
  const tgtId = nodeId(tgtWing, tgtRoom);
  if (!links.some((l) => {
    const s = (l.source as GraphNode).id ?? l.source;
    const t = (l.target as GraphNode).id ?? l.target;
    return l.type === "tunnel" && ((s === srcId && t === tgtId) || (s === tgtId && t === srcId));
  })) {
    links.push({ source: srcId as unknown as GraphNode, target: tgtId as unknown as GraphNode, type: "tunnel" });
  }
}

// ---- D3 setup -------------------------------------------------------------

const svg = select<SVGSVGElement, unknown>("#map");
const width = window.innerWidth;
const height = window.innerHeight;
svg.attr("width", width).attr("height", height);

const g = svg.append("g");

// Zoom
const zoomBehavior = zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.2, 5])
  .on("zoom", (event) => g.attr("transform", event.transform));
svg.call(zoomBehavior);

// Layers (order matters for rendering)
const linkGroup = g.append("g").attr("class", "links");
const nodeGroup = g.append("g").attr("class", "nodes");
const labelGroup = g.append("g").attr("class", "labels");

// Force simulation
const simulation = forceSimulation<GraphNode>(nodes)
  .force("link", forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance((l) => l.type === "contains" ? 60 : 150))
  .force("charge", forceManyBody().strength(-200))
  .force("center", forceCenter(width / 2, height / 2))
  .force("collide", forceCollide<GraphNode>().radius((d) => d.radius + 6))
  .on("tick", tick);

function tick(): void {
  linkGroup.selectAll<SVGLineElement, GraphLink>("line")
    .attr("x1", (d) => ((d.source as GraphNode).x ?? 0))
    .attr("y1", (d) => ((d.source as GraphNode).y ?? 0))
    .attr("x2", (d) => ((d.target as GraphNode).x ?? 0))
    .attr("y2", (d) => ((d.target as GraphNode).y ?? 0));

  nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle")
    .attr("cx", (d) => d.x ?? 0)
    .attr("cy", (d) => d.y ?? 0);

  labelGroup.selectAll<SVGTextElement, GraphNode>("text")
    .attr("x", (d) => d.x ?? 0)
    .attr("y", (d) => (d.y ?? 0) + d.radius + 14);
}

// ---- Render ---------------------------------------------------------------

function render(): void {
  // Links
  const link = linkGroup.selectAll<SVGLineElement, GraphLink>("line")
    .data(links, (d) => `${(d.source as GraphNode).id ?? d.source}-${(d.target as GraphNode).id ?? d.target}`);

  link.exit().remove();

  link.enter()
    .append("line")
    .attr("stroke", (d) => d.type === "tunnel" ? "#ff9800" : "#555")
    .attr("stroke-width", (d) => d.type === "tunnel" ? 2 : 1)
    .attr("stroke-dasharray", (d) => d.type === "tunnel" ? "6 3" : "none")
    .attr("opacity", 0.6);

  // Nodes
  const node = nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle")
    .data(nodes, (d) => d.id);

  node.exit().remove();

  const entered = node.enter()
    .append("circle")
    .attr("r", (d) => d.radius)
    .attr("fill", (d) => d.heat > 0 ? heatScale(Math.min(d.heat, 20)) : wingColor(d.wing))
    .attr("stroke", (d) => d.type === "wing" ? "#fff" : wingColor(d.wing))
    .attr("stroke-width", (d) => d.type === "wing" ? 2 : 1.5)
    .attr("opacity", 0.9)
    .attr("cursor", "pointer");

  entered.on("mouseover", (_event, d) => {
    const tooltip = document.getElementById("tooltip")!;
    tooltip.style.display = "block";
    tooltip.innerHTML = `<strong>${d.id}</strong><br>Heat: ${d.heat} accesses${d.type === "wing" ? " (wing)" : ""}`;
  });
  entered.on("mousemove", (event) => {
    const tooltip = document.getElementById("tooltip")!;
    tooltip.style.left = `${event.pageX + 12}px`;
    tooltip.style.top = `${event.pageY - 12}px`;
  });
  entered.on("mouseout", () => {
    document.getElementById("tooltip")!.style.display = "none";
  });

  // Update existing node colors (heat may have changed)
  nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle")
    .attr("fill", (d) => d.heat > 0 ? heatScale(Math.min(d.heat, 20)) : wingColor(d.wing))
    .attr("r", (d) => d.radius + Math.min(d.heat * 0.5, 6));

  // Labels
  const label = labelGroup.selectAll<SVGTextElement, GraphNode>("text")
    .data(nodes, (d) => d.id);

  label.exit().remove();

  label.enter()
    .append("text")
    .attr("class", (d) => `node-label ${d.type === "wing" ? "wing-label" : ""}`)
    .text((d) => d.room ?? d.wing)
    .attr("display", showLabels ? "block" : "none");

  // Update label visibility
  labelGroup.selectAll<SVGTextElement, GraphNode>("text")
    .attr("display", showLabels ? "block" : "none");

  // Restart simulation with new data
  simulation.nodes(nodes);
  (simulation.force("link") as ReturnType<typeof forceLink>)!.links(links);
  simulation.alpha(0.3).restart();
}

// ---- Pulse animation ------------------------------------------------------

function pulseNode(id: string, tokenBadge?: number): void {
  const circle = nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle")
    .filter((d) => d.id === id);

  if (circle.empty()) return;

  // Flash
  circle
    .attr("opacity", 1)
    .attr("stroke", "#fff")
    .attr("stroke-width", 4)
    .transition()
    .duration(600)
    .attr("opacity", 0.9)
    .attr("stroke-width", (d: GraphNode) => d.type === "wing" ? 2 : 1.5)
    .attr("stroke", (d: GraphNode) => d.type === "wing" ? "#fff" : wingColor(d.wing));

  // Brief token badge
  if (tokenBadge != null) {
    const node = nodeMap.get(id);
    if (node?.x != null && node.y != null) {
      g.append("text")
        .attr("x", node.x + node.radius + 4)
        .attr("y", node.y - node.radius - 4)
        .attr("fill", "#ffb74d")
        .attr("font-size", "10px")
        .attr("font-weight", "bold")
        .text(`~${tokenBadge}tok`)
        .transition()
        .duration(2000)
        .attr("opacity", 0)
        .remove();
    }
  }
}

// ---- Event handling -------------------------------------------------------

function processPalaceEvent(e: PalaceEvent): void {
  let graphChanged = false;

  // Source location
  if (e.location?.wing) {
    const node = ensureNode(e.location.wing, e.location.room);
    node.heat++;
    if (!nodeMap.has(node.id)) graphChanged = true;
  }

  // Hits
  for (const hit of e.hits) {
    const wasNew = !nodeMap.has(nodeId(hit.wing, hit.room));
    const node = ensureNode(hit.wing, hit.room);
    node.heat++;
    if (wasNew) graphChanged = true;

    // If source and hit are in different wings, that's a tunnel traversal
    if (e.location?.wing && e.location.wing !== hit.wing && e.location.room && hit.room) {
      ensureTunnel(e.location.wing, e.location.room, hit.wing, hit.room);
      graphChanged = true;
    }
  }

  if (graphChanged) render();

  // Animate
  if (!paused) {
    if (e.location?.wing) {
      pulseNode(nodeId(e.location.wing, e.location.room), e.tokens);
    }
    for (const hit of e.hits) {
      setTimeout(() => pulseNode(nodeId(hit.wing, hit.room)), 200);
    }
  }

  updateStats();
}

function updateStats(): void {
  const wings = new Set(nodes.filter((n) => n.type === "wing").map((n) => n.wing));
  const rooms = nodes.filter((n) => n.type === "room").length;
  const tunnels = links.filter((l) => l.type === "tunnel").length;
  const totalHeat = nodes.reduce((s, n) => s + n.heat, 0);

  document.getElementById("stats")!.innerHTML =
    `${wings.size} wings · ${rooms} rooms · ${tunnels} tunnels · ${totalHeat} accesses`;

  // Update wing filter dropdown
  const filterEl = document.getElementById("wing-filter") as HTMLSelectElement;
  const current = filterEl.value;
  const opts = Array.from(wings).sort();
  if (filterEl.options.length !== opts.length + 1) {
    filterEl.innerHTML = `<option value="">All Wings</option>` +
      opts.map((w) => `<option value="${w}">${w}</option>`).join("");
    filterEl.value = current;
  }
}

// ---- Controls -------------------------------------------------------------

document.getElementById("btn-labels")!.addEventListener("click", () => {
  showLabels = !showLabels;
  labelGroup.selectAll("text").attr("display", showLabels ? "block" : "none");
});

document.getElementById("btn-reset")!.addEventListener("click", () => {
  svg.transition().duration(500).call(zoomBehavior.transform, zoomIdentity);
  simulation.alpha(0.5).restart();
});

document.getElementById("btn-pause")!.addEventListener("click", () => {
  paused = !paused;
  (document.getElementById("btn-pause") as HTMLButtonElement).textContent =
    paused ? "Resume" : "Pause";
});

document.getElementById("wing-filter")!.addEventListener("change", (e) => {
  const wing = (e.target as HTMLSelectElement).value;
  nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle")
    .attr("opacity", (d) => (!wing || d.wing === wing) ? 0.9 : 0.15);
  linkGroup.selectAll<SVGLineElement, GraphLink>("line")
    .attr("opacity", (d) => {
      if (!wing) return 0.6;
      const s = (d.source as GraphNode).wing ?? "";
      const t = (d.target as GraphNode).wing ?? "";
      return (s === wing || t === wing) ? 0.6 : 0.08;
    });
  labelGroup.selectAll<SVGTextElement, GraphNode>("text")
    .attr("opacity", (d) => (!wing || d.wing === wing) ? 1 : 0.15);
});

// Resize
window.addEventListener("resize", () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  svg.attr("width", w).attr("height", h);
  (simulation.force("center") as ReturnType<typeof forceCenter>)
    ?.x(w / 2).y(h / 2);
  simulation.alpha(0.1).restart();
});

// ---- Token pie chart -------------------------------------------------------

interface TokenBucket {
  label: string;
  color: string;
  tokens: number;
}

const tokenBuckets: TokenBucket[] = [
  { label: "Handshake", color: "#78909c", tokens: 0 },      // initialize, tools/list
  { label: "Search/Retrieve", color: "#4fc3f7", tokens: 0 }, // mempalace_search, get_drawer, traverse, etc.
  { label: "Write/Mine", color: "#81c784", tokens: 0 },      // add_drawer, checkpoint, mine
  { label: "Meta/Status", color: "#ffb74d", tokens: 0 },     // status, list_wings, taxonomy, etc.
  { label: "Other", color: "#b0bec5", tokens: 0 },
];

const HANDSHAKE_METHODS = new Set(["initialize", "notifications/initialized", "tools/list"]);
const RETRIEVAL_TOOLS = new Set([
  "mempalace_search", "mempalace_traverse", "mempalace_follow_tunnels",
  "mempalace_find_tunnels", "mempalace_get_drawer", "mempalace_list_drawers",
  "mempalace_kg_query", "mempalace_kg_timeline",
]);
const WRITE_TOOLS = new Set([
  "mempalace_add_drawer", "mempalace_checkpoint", "mempalace_mine",
  "mempalace_create_tunnel", "mempalace_update_drawer", "mempalace_diary_write",
]);
const META_TOOLS = new Set([
  "mempalace_status", "mempalace_list_wings", "mempalace_list_rooms",
  "mempalace_list_hallways", "mempalace_list_tunnels", "mempalace_get_taxonomy",
  "mempalace_graph_stats", "mempalace_get_aaak_spec",
]);

function classifyEvent(e: AnyEvent): number {
  const method = e.method ?? "";
  const tool = e.tool ?? "";

  if (HANDSHAKE_METHODS.has(method)) return 0;
  if (RETRIEVAL_TOOLS.has(tool)) return 1;
  if (WRITE_TOOLS.has(tool)) return 2;
  if (META_TOOLS.has(tool)) return 3;
  if (tool.startsWith("mempalace_")) return 3; // unknown mempalace tool → meta
  return 4;
}

function trackTokens(e: AnyEvent): void {
  const tokens = e.tokens ?? 0;
  if (tokens === 0) return;
  const bucket = classifyEvent(e);
  tokenBuckets[bucket]!.tokens += tokens;
}

function renderPieChart(): void {
  const total = tokenBuckets.reduce((s, b) => s + b.tokens, 0);
  if (total === 0) return;

  const pieSvg = select<SVGSVGElement, unknown>("#pie-chart");
  pieSvg.selectAll("*").remove();

  const w = 160, h = 160, r = 70;
  const cx = w / 2, cy = h / 2;

  let startAngle = -Math.PI / 2;

  for (const bucket of tokenBuckets) {
    if (bucket.tokens === 0) continue;
    const sliceAngle = (bucket.tokens / total) * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = sliceAngle > Math.PI ? 1 : 0;

    pieSvg.append("path")
      .attr("d", `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`)
      .attr("fill", bucket.color)
      .attr("stroke", "var(--vscode-editor-background)")
      .attr("stroke-width", 1.5);

    startAngle = endAngle;
  }

  // Center label with total
  pieSvg.append("text")
    .attr("x", cx).attr("y", cy - 6)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--vscode-editor-foreground)")
    .attr("font-size", "14px")
    .attr("font-weight", "bold")
    .text(total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total));
  pieSvg.append("text")
    .attr("x", cx).attr("y", cy + 10)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--vscode-descriptionForeground)")
    .attr("font-size", "10px")
    .text("tokens");

  // Legend
  const legendEl = document.getElementById("pie-legend")!;
  legendEl.innerHTML = tokenBuckets
    .filter((b) => b.tokens > 0)
    .map((b) => {
      const pct = ((b.tokens / total) * 100).toFixed(0);
      const val = b.tokens >= 1000 ? `${(b.tokens / 1000).toFixed(1)}k` : String(b.tokens);
      return `<div class="legend-item">
        <span class="legend-swatch" style="background:${b.color}"></span>
        <span>${b.label}</span>
        <span class="legend-value">${val} (${pct}%)</span>
      </div>`;
    })
    .join("");
}

// ---- Message handler (from extension host) --------------------------------

window.addEventListener("message", (event) => {
  const msg = event.data as { type: string; event?: AnyEvent; events?: AnyEvent[] };

  switch (msg.type) {
    case "init":
      if (msg.events) {
        for (const e of msg.events) {
          trackTokens(e);
          if (e.kind === "palace") processPalaceEvent(e as PalaceEvent);
        }
      }
      render();
      renderPieChart();
      break;

    case "event":
      if (msg.event) {
        trackTokens(msg.event);
        if (msg.event.kind === "palace") processPalaceEvent(msg.event as PalaceEvent);
        renderPieChart();
      }
      break;

    case "clear":
      nodes.length = 0;
      links.length = 0;
      nodeMap.clear();
      wingColors.clear();
      for (const b of tokenBuckets) b.tokens = 0;
      render();
      updateStats();
      renderPieChart();
      break;
  }
});

// Signal ready to extension host
vscode.postMessage({ type: "ready" });
