/**
 * Palace Map — webview-side D3 rendering.
 *
 * Visual hierarchy:
 *   Wing  — large dashed-border container, semi-transparent fill, label centered
 *   Room  — solid circle colored by parent wing, orbits its wing
 *
 * On PalaceEvent: rooms pulse, temporary "search trail" edges appear showing
 * which rooms were hit and how close (thickness = 1/distance).
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
  type Simulation,
} from "d3-force";
import { select, type Selection } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import "d3-transition";

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
  hits: number;
  radius: number;
  // last hit metadata (for tooltip)
  lastDistance: number | null;
  lastPreview: string | null;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  type: "contains" | "tunnel";
  label?: string;
}

interface TrailEdge {
  source: GraphNode;
  target: GraphNode;
  distance: number | null;
  born: number;
}

interface VsCodeApi { postMessage(msg: unknown): void; }
declare function acquireVsCodeApi(): VsCodeApi;

// ---- Palette & helpers -----------------------------------------------------

const vscode = acquireVsCodeApi();
const nodes: GraphNode[] = [];
const links: GraphLink[] = [];
const nodeMap = new Map<string, GraphNode>();
let showLabels = true;
let paused = false;

const PALETTE = [
  "#4fc3f7", "#81c784", "#ffb74d", "#e57373", "#ba68c8",
  "#4dd0e1", "#aed581", "#ff8a65", "#f06292", "#7986cb",
];
const wingColorMap = new Map<string, string>();

function wingColor(wing: string): string {
  if (!wingColorMap.has(wing)) {
    wingColorMap.set(wing, PALETTE[wingColorMap.size % PALETTE.length]!);
  }
  return wingColorMap.get(wing)!;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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
      hits: 0,
      radius: room ? 12 : 32,
      lastDistance: null,
      lastPreview: null,
    };
    nodes.push(node);
    nodeMap.set(id, node);

    if (room) {
      const wingNode = ensureNode(wing, null);
      const lid = `${wingNode.id}->${id}`;
      if (!links.some((l) => l.id === lid)) {
        links.push({ id: lid, source: wingNode as unknown as GraphNode, target: node as unknown as GraphNode, type: "contains" });
      }
      // Start room near its wing
      if (wingNode.x != null) {
        node.x = wingNode.x + (Math.random() - 0.5) * 60;
        node.y = (wingNode.y ?? 0) + (Math.random() - 0.5) * 60;
      }
    }
  }
  return node;
}

function ensureTunnel(srcWing: string, srcRoom: string, tgtWing: string, tgtRoom: string): void {
  const srcNode = ensureNode(srcWing, srcRoom);
  const tgtNode = ensureNode(tgtWing, tgtRoom);
  const lid = `tunnel:${srcNode.id}<->${tgtNode.id}`;
  const lid2 = `tunnel:${tgtNode.id}<->${srcNode.id}`;
  if (!links.some((l) => l.id === lid || l.id === lid2)) {
    links.push({ id: lid, source: srcNode as unknown as GraphNode, target: tgtNode as unknown as GraphNode, type: "tunnel" });
  }
}

// ---- D3 setup -------------------------------------------------------------

const svg = select<SVGSVGElement, unknown>("#map");
let W = window.innerWidth;
let H = window.innerHeight;
svg.attr("width", W).attr("height", H);

const defs = svg.append("defs");
// Glow filter for pulsing nodes
const glowFilter = defs.append("filter").attr("id", "glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
glowFilter.append("feGaussianBlur").attr("in", "SourceGraphic").attr("stdDeviation", "4").attr("result", "blur");
const feMerge = glowFilter.append("feMerge");
feMerge.append("feMergeNode").attr("in", "blur");
feMerge.append("feMergeNode").attr("in", "SourceGraphic");

const g = svg.append("g");

const zoomBehavior = zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.1, 8])
  .on("zoom", (event) => g.attr("transform", event.transform));
svg.call(zoomBehavior);

// Layers
const trailGroup = g.append("g").attr("class", "trails");
const linkGroup  = g.append("g").attr("class", "links");
const wingBgGroup = g.append("g").attr("class", "wing-bg");
const nodeGroup  = g.append("g").attr("class", "nodes");
const labelGroup = g.append("g").attr("class", "labels");

// ---- Custom clustering force ---------------------------------------------
// Pulls room nodes toward their parent wing node

function forceCluster() {
  let strength = 0.35;
  function force(alpha: number) {
    for (const node of nodes) {
      if (node.type !== "room") continue;
      const wing = nodeMap.get(node.wing);
      if (!wing || wing.x == null || wing.y == null) continue;
      const dx = wing.x - (node.x ?? 0);
      const dy = wing.y - (node.y ?? 0);
      node.vx = (node.vx ?? 0) + dx * strength * alpha;
      node.vy = (node.vy ?? 0) + dy * strength * alpha;
    }
  }
  force.strength = (s: number) => { strength = s; return force; };
  return force;
}

// ---- Simulation -----------------------------------------------------------

const simulation: Simulation<GraphNode, GraphLink> = forceSimulation<GraphNode>(nodes)
  .force("link", forceLink<GraphNode, GraphLink>(links)
    .id((d) => d.id)
    .distance((l) => l.type === "contains" ? 70 : 160)
    .strength((l) => l.type === "contains" ? 0.4 : 0.1))
  .force("charge", forceManyBody<GraphNode>().strength((d) => d.type === "wing" ? -400 : -80))
  .force("center", forceCenter(W / 2, H / 2))
  .force("collide", forceCollide<GraphNode>().radius((d) => d.radius + 10))
  .force("cluster", forceCluster())
  .on("tick", tick);

// ---- Tick -----------------------------------------------------------------

function tick(): void {
  // Wing background circles (convex hint)
  wingBgGroup.selectAll<SVGCircleElement, GraphNode>("circle.wing-bg")
    .attr("cx", (d) => d.x ?? 0)
    .attr("cy", (d) => d.y ?? 0);

  linkGroup.selectAll<SVGLineElement, GraphLink>("line")
    .attr("x1", (d) => ((d.source as GraphNode).x ?? 0))
    .attr("y1", (d) => ((d.source as GraphNode).y ?? 0))
    .attr("x2", (d) => ((d.target as GraphNode).x ?? 0))
    .attr("y2", (d) => ((d.target as GraphNode).y ?? 0));

  nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle.node")
    .attr("cx", (d) => d.x ?? 0)
    .attr("cy", (d) => d.y ?? 0);

  // Wing labels centered inside wing circle
  labelGroup.selectAll<SVGTextElement, GraphNode>("text.wing-label")
    .attr("x", (d) => d.x ?? 0)
    .attr("y", (d) => (d.y ?? 0) - 4);

  labelGroup.selectAll<SVGTextElement, GraphNode>("text.wing-sublabel")
    .attr("x", (d) => d.x ?? 0)
    .attr("y", (d) => (d.y ?? 0) + 11);

  // Room labels below circle
  labelGroup.selectAll<SVGTextElement, GraphNode>("text.room-label")
    .attr("x", (d) => d.x ?? 0)
    .attr("y", (d) => (d.y ?? 0) + d.radius + 13);

  labelGroup.selectAll<SVGTextElement, GraphNode>("text.room-hits")
    .attr("x", (d) => d.x ?? 0)
    .attr("y", (d) => (d.y ?? 0) + d.radius + 24);

  // Trail edges
  trailGroup.selectAll<SVGLineElement, TrailEdge>("line.trail")
    .attr("x1", (d) => d.source.x ?? 0)
    .attr("y1", (d) => d.source.y ?? 0)
    .attr("x2", (d) => d.target.x ?? 0)
    .attr("y2", (d) => d.target.y ?? 0);
}

// ---- Render ---------------------------------------------------------------

function render(): void {
  const color = (d: GraphNode) => wingColor(d.wing);

  // ----- Wing background circles (dashed ring) -----
  const wingNodes = nodes.filter((n) => n.type === "wing");
  const wingBg = wingBgGroup.selectAll<SVGCircleElement, GraphNode>("circle.wing-bg")
    .data(wingNodes, (d) => d.id);
  wingBg.exit().remove();
  wingBg.enter()
    .append("circle")
    .attr("class", "wing-bg")
    .attr("r", (d) => d.radius + 8)
    .attr("fill", (d) => hexToRgba(wingColor(d.wing), 0.08))
    .attr("stroke", (d) => wingColor(d.wing))
    .attr("stroke-width", 2)
    .attr("stroke-dasharray", "8 4")
    .attr("opacity", 0.7);

  // ----- Links -----
  const link = linkGroup.selectAll<SVGLineElement, GraphLink>("line")
    .data(links, (d) => d.id);
  link.exit().remove();
  link.enter()
    .append("line")
    .attr("stroke", (d) => d.type === "tunnel" ? "#ff9800" : "#444")
    .attr("stroke-width", (d) => d.type === "tunnel" ? 2 : 1)
    .attr("stroke-dasharray", (d) => d.type === "tunnel" ? "6 3" : "none")
    .attr("opacity", (d) => d.type === "tunnel" ? 0.8 : 0.3);

  // ----- Nodes -----
  const node = nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle.node")
    .data(nodes, (d) => d.id);
  node.exit().remove();

  const entered = node.enter()
    .append("circle")
    .attr("class", "node")
    .attr("r", (d) => d.radius)
    .attr("fill", (d) => {
      if (d.type === "wing") return hexToRgba(wingColor(d.wing), 0.25);
      return color(d);
    })
    .attr("stroke", (d) => d.type === "wing" ? wingColor(d.wing) : "rgba(255,255,255,0.6)")
    .attr("stroke-width", (d) => d.type === "wing" ? 2.5 : 1.5)
    .attr("opacity", 0.92)
    .attr("cursor", "pointer");

  entered.on("mouseover", (event, d) => showTooltip(event, d));
  entered.on("mousemove", (event) => moveTooltip(event));
  entered.on("mouseout", () => hideTooltip());

  // Update heat-based radius for rooms
  nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle.node")
    .attr("r", (d) => d.type === "room" ? d.radius + Math.min(d.hits * 1.2, 10) : d.radius);

  // ----- Labels -----
  const allLabels = labelGroup.selectAll<SVGTextElement, GraphNode>("text.wing-label")
    .data(wingNodes, (d) => d.id);
  allLabels.exit().remove();
  allLabels.enter()
    .append("text")
    .attr("class", "wing-label")
    .attr("text-anchor", "middle")
    .attr("fill", (d) => wingColor(d.wing))
    .attr("font-size", "12px")
    .attr("font-weight", "700")
    .attr("letter-spacing", "0.5px")
    .attr("display", showLabels ? "block" : "none")
    .text((d) => d.wing.toUpperCase());

  const wingSubLabels = labelGroup.selectAll<SVGTextElement, GraphNode>("text.wing-sublabel")
    .data(wingNodes, (d) => d.id);
  wingSubLabels.exit().remove();
  wingSubLabels.enter()
    .append("text")
    .attr("class", "wing-sublabel")
    .attr("text-anchor", "middle")
    .attr("fill", "var(--vscode-descriptionForeground)")
    .attr("font-size", "9px")
    .attr("display", showLabels ? "block" : "none")
    .text((d) => `wing`);

  const roomNodes = nodes.filter((n) => n.type === "room");
  const roomLabels = labelGroup.selectAll<SVGTextElement, GraphNode>("text.room-label")
    .data(roomNodes, (d) => d.id);
  roomLabels.exit().remove();
  roomLabels.enter()
    .append("text")
    .attr("class", "room-label")
    .attr("text-anchor", "middle")
    .attr("fill", "var(--vscode-editor-foreground)")
    .attr("font-size", "10px")
    .attr("display", showLabels ? "block" : "none")
    .text((d) => d.room ?? "");

  const roomHitLabels = labelGroup.selectAll<SVGTextElement, GraphNode>("text.room-hits")
    .data(roomNodes, (d) => d.id);
  roomHitLabels.exit().remove();
  roomHitLabels.enter()
    .append("text")
    .attr("class", "room-hits")
    .attr("text-anchor", "middle")
    .attr("fill", "var(--vscode-descriptionForeground)")
    .attr("font-size", "9px")
    .attr("display", showLabels ? "block" : "none")
    .text((d) => d.hits > 0 ? `${d.hits} hit${d.hits > 1 ? "s" : ""}` : "room");

  // Update hit counts on existing room labels
  labelGroup.selectAll<SVGTextElement, GraphNode>("text.room-hits")
    .text((d) => d.hits > 0 ? `${d.hits} hit${d.hits > 1 ? "s" : ""}` : "room");

  // Update label visibility
  labelGroup.selectAll("text").attr("display", showLabels ? "block" : "none");

  // Restart simulation
  simulation.nodes(nodes);
  (simulation.force("link") as ReturnType<typeof forceLink>).links(links);
  simulation.alpha(0.3).restart();
}

// ---- Search trail animation -----------------------------------------------

const activeTrails: TrailEdge[] = [];
const TRAIL_LIFETIME_MS = 3000;

function addSearchTrail(sourceNode: GraphNode | null, hits: PalaceHit[]): void {
  const now = Date.now();

  for (const hit of hits) {
    const targetNode = nodeMap.get(nodeId(hit.wing, hit.room));
    if (!targetNode || !sourceNode) continue;

    const trail: TrailEdge = {
      source: sourceNode,
      target: targetNode,
      distance: hit.distance,
      born: now,
    };
    activeTrails.push(trail);
  }

  renderTrails();

  // Schedule removal
  setTimeout(() => {
    const cutoff = now;
    const removed = activeTrails.filter((t) => t.born === cutoff);
    removed.forEach((t) => activeTrails.splice(activeTrails.indexOf(t), 1));
    renderTrails();
  }, TRAIL_LIFETIME_MS);
}

function renderTrails(): void {
  const trail = trailGroup.selectAll<SVGLineElement, TrailEdge>("line.trail")
    .data(activeTrails, (d) => `${d.source.id}->${d.target.id}-${d.born}`);

  trail.exit().transition().duration(400).attr("opacity", 0).remove();

  trail.enter()
    .append("line")
    .attr("class", "trail")
    .attr("stroke", "#64b5f6")
    .attr("stroke-dasharray", "4 3")
    .attr("stroke-width", (d) => {
      if (d.distance == null) return 2;
      return Math.max(1, Math.min(5, (1 - d.distance) * 6));
    })
    .attr("opacity", 0)
    .attr("x1", (d) => d.source.x ?? 0)
    .attr("y1", (d) => d.source.y ?? 0)
    .attr("x2", (d) => d.target.x ?? 0)
    .attr("y2", (d) => d.target.y ?? 0)
    .transition()
    .duration(300)
    .attr("opacity", 0.9);
}

// ---- Pulse ----------------------------------------------------------------

function pulseNode(id: string, tokenBadge?: number): void {
  const circle = nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle.node")
    .filter((d) => d.id === id);
  if (circle.empty()) return;

  circle
    .attr("filter", "url(#glow)")
    .attr("stroke", "#fff")
    .attr("stroke-width", 4)
    .transition().duration(700)
    .attr("filter", null)
    .attr("stroke-width", (d: GraphNode) => d.type === "wing" ? 2.5 : 1.5)
    .attr("stroke", (d: GraphNode) => d.type === "wing" ? wingColor(d.wing) : "rgba(255,255,255,0.6)");

  if (tokenBadge != null) {
    const node = nodeMap.get(id);
    if (node?.x != null && node.y != null) {
      g.append("text")
        .attr("x", node.x + node.radius + 6)
        .attr("y", node.y - node.radius - 6)
        .attr("fill", "#ffb74d")
        .attr("font-size", "11px")
        .attr("font-weight", "bold")
        .text(`~${tokenBadge > 999 ? `${(tokenBadge / 1000).toFixed(1)}k` : tokenBadge}tok`)
        .transition().duration(2500).attr("opacity", 0).remove();
    }
  }
}

// ---- Tooltip --------------------------------------------------------------

function showTooltip(event: MouseEvent, d: GraphNode): void {
  const el = document.getElementById("tooltip")!;
  const roomCount = nodes.filter((n) => n.type === "room" && n.wing === d.wing).length;

  let html = `<strong>${d.id}</strong><br>`;
  if (d.type === "wing") {
    html += `<span class="tag">WING</span> · ${roomCount} room${roomCount !== 1 ? "s" : ""}<br>`;
    html += `Heat: ${d.heat} accesses`;
  } else {
    html += `<span class="tag">ROOM</span> in <em>${d.wing}</em><br>`;
    html += `Hits: ${d.hits}`;
    if (d.lastDistance != null) html += ` · dist: ${d.lastDistance.toFixed(3)}`;
    if (d.lastPreview) html += `<br><em class="preview">${d.lastPreview.slice(0, 100)}…</em>`;
  }
  el.innerHTML = html;
  el.style.display = "block";
  moveTooltip(event);
}

function moveTooltip(event: MouseEvent): void {
  const el = document.getElementById("tooltip")!;
  el.style.left = `${event.pageX + 14}px`;
  el.style.top = `${event.pageY - 14}px`;
}

function hideTooltip(): void {
  document.getElementById("tooltip")!.style.display = "none";
}

// ---- Palace event processing ----------------------------------------------

function processPalaceEvent(e: PalaceEvent): void {
  let graphChanged = false;

  const srcId = e.location?.wing
    ? nodeId(e.location.wing, e.location.room)
    : null;

  if (e.location?.wing) {
    const node = ensureNode(e.location.wing, e.location.room);
    if (!nodeMap.has(srcId!)) graphChanged = true;
    node.heat++;
  }

  for (const hit of e.hits) {
    const wasNew = !nodeMap.has(nodeId(hit.wing, hit.room));
    const node = ensureNode(hit.wing, hit.room);
    node.heat++;
    node.hits++;
    node.lastDistance = hit.distance;
    if (hit.preview) node.lastPreview = hit.preview;
    if (wasNew) graphChanged = true;

    if (e.location?.wing && e.location.wing !== hit.wing && e.location.room && hit.room) {
      ensureTunnel(e.location.wing, e.location.room, hit.wing, hit.room);
      graphChanged = true;
    }
  }

  if (graphChanged) render();

  if (!paused) {
    const srcNode = srcId ? (nodeMap.get(srcId) ?? null) : null;
    const querySource = srcNode ?? (e.hits[0] ? nodeMap.get(nodeId(e.hits[0].wing, e.hits[0].wing)) ?? null : null);

    if (e.hits.length > 0 && querySource) {
      addSearchTrail(querySource, e.hits);
    }

    if (srcNode) pulseNode(srcNode.id, e.tokens);
    for (let i = 0; i < e.hits.length; i++) {
      const hitId = nodeId(e.hits[i]!.wing, e.hits[i]!.room);
      setTimeout(() => pulseNode(hitId), 200 + i * 120);
    }
  }

  updateStats();
}

// ---- Stats overlay --------------------------------------------------------

function updateStats(): void {
  const wingCount = nodes.filter((n) => n.type === "wing").length;
  const roomCount = nodes.filter((n) => n.type === "room").length;
  const tunnelCount = links.filter((l) => l.type === "tunnel").length;
  const totalHits = nodes.filter((n) => n.type === "room").reduce((s, n) => s + n.hits, 0);

  document.getElementById("stats")!.innerHTML =
    `<strong>${wingCount}</strong> wings &nbsp;·&nbsp; <strong>${roomCount}</strong> rooms &nbsp;·&nbsp; <strong>${tunnelCount}</strong> tunnels &nbsp;·&nbsp; <strong>${totalHits}</strong> total hits`;

  // Wing filter options
  const wings = new Set(nodes.filter((n) => n.type === "wing").map((n) => n.wing));
  const filterEl = document.getElementById("wing-filter") as HTMLSelectElement;
  const current = filterEl.value;
  const opts = Array.from(wings).sort();
  if (filterEl.options.length !== opts.length + 1) {
    filterEl.innerHTML = `<option value="">All Wings</option>` +
      opts.map((w) => `<option value="${w}">${w}</option>`).join("");
    filterEl.value = opts.includes(current) ? current : "";
  }
}

// ---- Token pie chart -------------------------------------------------------

interface TokenBucket { label: string; color: string; tokens: number; }

const tokenBuckets: TokenBucket[] = [
  { label: "Handshake",       color: "#78909c", tokens: 0 },
  { label: "Search/Retrieve", color: "#4fc3f7", tokens: 0 },
  { label: "Write/Mine",      color: "#81c784", tokens: 0 },
  { label: "Meta/Status",     color: "#ffb74d", tokens: 0 },
  { label: "Other",           color: "#b0bec5", tokens: 0 },
];

const HANDSHAKE_METHODS = new Set(["initialize", "notifications/initialized", "tools/list"]);
const RETRIEVAL_TOOLS = new Set(["mempalace_search","mempalace_traverse","mempalace_follow_tunnels","mempalace_find_tunnels","mempalace_get_drawer","mempalace_list_drawers","mempalace_kg_query","mempalace_kg_timeline"]);
const WRITE_TOOLS = new Set(["mempalace_add_drawer","mempalace_checkpoint","mempalace_mine","mempalace_create_tunnel","mempalace_update_drawer","mempalace_diary_write"]);
const META_TOOLS = new Set(["mempalace_status","mempalace_list_wings","mempalace_list_rooms","mempalace_list_hallways","mempalace_list_tunnels","mempalace_get_taxonomy","mempalace_graph_stats","mempalace_get_aaak_spec"]);

function classifyEvent(e: AnyEvent): number {
  const method = e.method ?? "";
  const tool = e.tool ?? "";
  if (HANDSHAKE_METHODS.has(method)) return 0;
  if (RETRIEVAL_TOOLS.has(tool)) return 1;
  if (WRITE_TOOLS.has(tool)) return 2;
  if (META_TOOLS.has(tool)) return 3;
  if (tool.startsWith("mempalace_")) return 3;
  return 4;
}

function trackTokens(e: AnyEvent): void {
  const tokens = e.tokens ?? 0;
  if (tokens === 0) return;
  tokenBuckets[classifyEvent(e)]!.tokens += tokens;
}

function renderPieChart(): void {
  const total = tokenBuckets.reduce((s, b) => s + b.tokens, 0);
  if (total === 0) return;

  const pieSvg = select<SVGSVGElement, unknown>("#pie-chart");
  pieSvg.selectAll("*").remove();

  const w = 160, h = 160, r = 64;
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
      .attr("stroke-width", 2);

    startAngle = endAngle;
  }

  pieSvg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 36)
    .attr("fill", "var(--vscode-editorWidget-background)");

  pieSvg.append("text").attr("x", cx).attr("y", cy - 5)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--vscode-editor-foreground)")
    .attr("font-size", "13px").attr("font-weight", "bold")
    .text(total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total));
  pieSvg.append("text").attr("x", cx).attr("y", cy + 10)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--vscode-descriptionForeground)")
    .attr("font-size", "9px").text("tokens");

  const legendEl = document.getElementById("pie-legend")!;
  legendEl.innerHTML = tokenBuckets
    .filter((b) => b.tokens > 0)
    .map((b) => {
      const pct = ((b.tokens / total) * 100).toFixed(0);
      const val = b.tokens >= 1000 ? `${(b.tokens / 1000).toFixed(1)}k` : String(b.tokens);
      return `<div class="legend-item">
        <span class="legend-swatch" style="background:${b.color}"></span>
        <span>${b.label}</span>
        <span class="legend-value">${val} <span class="pct">(${pct}%)</span></span>
      </div>`;
    }).join("");
}

// ---- Controls -------------------------------------------------------------

document.getElementById("btn-labels")!.addEventListener("click", () => {
  showLabels = !showLabels;
  labelGroup.selectAll("text").attr("display", showLabels ? "block" : "none");
  (document.getElementById("btn-labels") as HTMLButtonElement).textContent =
    showLabels ? "Labels" : "Labels ✕";
});

document.getElementById("btn-reset")!.addEventListener("click", () => {
  svg.transition().duration(500).call(zoomBehavior.transform, zoomIdentity);
  simulation.alpha(0.6).restart();
});

document.getElementById("btn-pause")!.addEventListener("click", () => {
  paused = !paused;
  (document.getElementById("btn-pause") as HTMLButtonElement).textContent = paused ? "Resume" : "Pause";
});

document.getElementById("wing-filter")!.addEventListener("change", (e) => {
  const wing = (e.target as HTMLSelectElement).value;
  nodeGroup.selectAll<SVGCircleElement, GraphNode>("circle.node")
    .attr("opacity", (d) => (!wing || d.wing === wing) ? 0.92 : 0.1);
  wingBgGroup.selectAll<SVGCircleElement, GraphNode>("circle.wing-bg")
    .attr("opacity", (d) => (!wing || d.wing === wing) ? 0.7 : 0.1);
  linkGroup.selectAll<SVGLineElement, GraphLink>("line")
    .attr("opacity", (d) => {
      if (!wing) return d.type === "tunnel" ? 0.8 : 0.3;
      const s = (d.source as GraphNode).wing;
      const t = (d.target as GraphNode).wing;
      return (s === wing || t === wing) ? 0.9 : 0.05;
    });
  labelGroup.selectAll<SVGTextElement, GraphNode>("text")
    .attr("opacity", (d) => (!wing || d.wing === wing) ? 1 : 0.1);
});

window.addEventListener("resize", () => {
  W = window.innerWidth;
  H = window.innerHeight;
  svg.attr("width", W).attr("height", H);
  (simulation.force("center") as ReturnType<typeof forceCenter>)?.x(W / 2).y(H / 2);
  simulation.alpha(0.1).restart();
});

// ---- Message handler -------------------------------------------------------

window.addEventListener("message", (event) => {
  const msg = event.data as { type: string; event?: AnyEvent; events?: AnyEvent[] };

  switch (msg.type) {
    case "init":
      if (msg.events) {
        for (const e of msg.events) {
          trackTokens(e);
          if (e.kind === "palace") processPalaceEvent(e as unknown as PalaceEvent);
        }
      }
      render();
      renderPieChart();
      break;

    case "event":
      if (msg.event) {
        trackTokens(msg.event);
        if (msg.event.kind === "palace") processPalaceEvent(msg.event as unknown as PalaceEvent);
        renderPieChart();
      }
      break;

    case "clear":
      nodes.length = 0;
      links.length = 0;
      nodeMap.clear();
      wingColorMap.clear();
      activeTrails.length = 0;
      for (const b of tokenBuckets) b.tokens = 0;
      wingBgGroup.selectAll("*").remove();
      linkGroup.selectAll("*").remove();
      nodeGroup.selectAll("*").remove();
      labelGroup.selectAll("*").remove();
      trailGroup.selectAll("*").remove();
      render();
      updateStats();
      renderPieChart();
      break;
  }
});

vscode.postMessage({ type: "ready" });
