/**
 * Renders the palace as a single self-contained HTML page.
 *
 * The palace is searchable by an agent, which is the point — but a store you can
 * only query is one you cannot survey. This gives the *human* the same thing the
 * agent gets: what exists, what it says, what it anchors to, and which parts of
 * the codebase nobody has written down.
 *
 * Everything is inlined. The page is written into `.palace/`, opened from the
 * filesystem, and must work with no network and no server.
 *
 * Colour choices follow the validated reference palette. Only three jobs are
 * given colour: coverage magnitude (a two-step blue ordinal ramp, validated for
 * both surfaces), status (good/warning/critical, always paired with an icon and
 * a word), and ink. The seven rooms are deliberately *not* colour-coded — their
 * names already carry identity, and seven hues would spend the colourblind
 * budget to say something the label already says.
 */

import type { Project } from "./project.js";
import type { Scan } from "./drawers.js";
import type { Coverage } from "./coverage.js";
import type { RepoFacts } from "./inspect.js";
import { ROOMS } from "./taxonomy.js";

export interface ReportInput {
  project: Project;
  scan: Scan;
  coverage: Coverage;
  facts: RepoFacts;
  /** Drawer counts per room in the search index, when it could be read. */
  indexed: Map<string, number> | null;
  generatedAt: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The body still opens with its own `# Title`; the card shows that separately. */
function bodyText(body: string): string {
  return body.replace(/^\s*#\s+.*$/m, "").trim();
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

function styles(): string {
  return `
:root {
  color-scheme: light;
  --surface: #fcfcfb;
  --plane: #f9f9f7;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --line: #e1e0d9;
  --ring: rgba(11,11,11,0.10);
  --fill: #2a78d6;
  --fill-soft: #86b6ef;
  --good: #0ca30c;
  --warn: #fab219;
  --crit: #d03b3b;
}
/* Dark tokens are declared under both scopes on purpose: the media query carries
   the OS preference, the data-theme scope carries a viewer's explicit toggle, and
   the toggle has to win in both directions. The :not() guard lets a light stamp
   beat OS-dark; :where() keeps the media block below the toggle in specificity. */
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --surface: #1a1a19;
    --plane: #0d0d0d;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --line: #2c2c2a;
    --ring: rgba(255,255,255,0.10);
    --fill: #3987e5;
    --fill-soft: #184f95;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1a1a19;
  --plane: #0d0d0d;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --muted: #898781;
  --line: #2c2c2a;
  --ring: rgba(255,255,255,0.10);
  --fill: #3987e5;
  --fill-soft: #184f95;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 40px 24px 80px; }
h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.02em; }
h2 { font-size: 15px; margin: 40px 0 14px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; }
.sub { color: var(--ink-2); margin: 0 0 4px; }
.meta { color: var(--muted); font-size: 13px; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 24px; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 16px 18px; }
.tile .v { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; }
.tile .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
.tile .n { color: var(--ink-2); font-size: 12px; margin-top: 6px; }

.status { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
.status .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ok .dot { background: var(--good); } .ok { color: var(--good); }
.wa .dot { background: var(--warn); } .wa { color: var(--ink-2); }
.cr .dot { background: var(--crit); } .cr { color: var(--crit); }

table.cov { width: 100%; border-collapse: collapse; }
table.cov td { padding: 7px 0; vertical-align: middle; border-bottom: 1px solid var(--line); }
table.cov td.name { width: 1%; white-space: nowrap; padding-right: 16px; font-weight: 550; }
table.cov td.num { width: 1%; white-space: nowrap; text-align: right; padding-left: 14px; color: var(--ink-2); font-variant-numeric: tabular-nums; font-size: 13px; }
.bar { position: relative; height: 12px; background: var(--line); border-radius: 4px; overflow: hidden; }
.bar i { position: absolute; inset: 0 auto 0 0; display: block; border-radius: 4px; }
.bar .mapped { background: var(--fill-soft); }
.bar .verified { background: var(--fill); }

.legend { display: flex; gap: 18px; margin: 0 0 14px; font-size: 13px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 7px; }
.sw { width: 12px; height: 12px; border-radius: 3px; flex: none; }

.controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
input[type=search] {
  flex: 1 1 240px; min-width: 200px; padding: 9px 12px; font: inherit; font-size: 14px;
  border: 1px solid var(--ring); border-radius: 8px; background: var(--surface); color: var(--ink);
}
.chip {
  padding: 6px 12px; border: 1px solid var(--ring); border-radius: 999px; background: var(--surface);
  color: var(--ink-2); font: inherit; font-size: 13px; cursor: pointer;
}
.chip[aria-pressed="true"] { background: var(--ink); color: var(--surface); border-color: var(--ink); }

/* A severity stripe carries state in form, so a room needing attention reads
   at a glance rather than requiring the number to be parsed. */
.room {
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  margin-bottom: 12px; overflow: hidden; border-left: 3px solid transparent;
}
.room.attn { border-left-color: var(--crit); }
.room.soft { border-left-color: var(--warn); }
.room > header { padding: 14px 18px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.room h3 { margin: 0; font-size: 16px; }
.room .q { color: var(--muted); font-size: 13px; flex: 1 1 auto; }
.room .count { color: var(--ink-2); font-size: 13px; font-variant-numeric: tabular-nums; }
.empty { padding: 0 18px 16px; color: var(--muted); font-size: 13px; max-width: 62ch; }
.empty strong { color: var(--ink-2); font-weight: 600; }

:where(a, button, summary, input):focus-visible { outline: 2px solid var(--fill); outline-offset: 2px; border-radius: 4px; }

details.drawer { border-top: 1px solid var(--line); }
details.drawer > summary { padding: 11px 18px; cursor: pointer; list-style: none; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
details.drawer > summary::-webkit-details-marker { display: none; }
details.drawer > summary:hover { background: var(--plane); }
.t { font-weight: 550; }
.badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--ring); color: var(--ink-2); white-space: nowrap; }
.badge.unrev { border-color: var(--warn); color: var(--ink-2); }
.anchors { color: var(--muted); font-size: 12px; margin-left: auto; }
.body { padding: 2px 18px 16px; color: var(--ink-2); white-space: pre-wrap; font-size: 14px; }
.body .none { color: var(--muted); font-style: italic; }

ul.files { columns: 2; column-gap: 24px; margin: 0; padding-left: 18px; color: var(--ink-2); font-size: 13px; }
@media (max-width: 640px) { ul.files { columns: 1; } .wrap { padding: 24px 16px 60px; } }
.note { color: var(--muted); font-size: 13px; margin-top: 10px; }
.hidden { display: none !important; }
`;
}

function script(): string {
  return `
const q = document.getElementById('q');
const chips = [...document.querySelectorAll('.chip')];
let room = 'all';

function apply() {
  const term = q.value.trim().toLowerCase();
  for (const el of document.querySelectorAll('details.drawer')) {
    const inRoom = room === 'all' || el.dataset.room === room;
    const hit = !term || el.dataset.search.includes(term);
    el.classList.toggle('hidden', !(inRoom && hit));
    if (term && hit) el.open = true;
  }
  for (const sec of document.querySelectorAll('.room')) {
    const anyVisible = sec.querySelector('details.drawer:not(.hidden)');
    const inRoom = room === 'all' || sec.dataset.room === room;
    const emptyRoom = !sec.querySelector('details.drawer');
    sec.classList.toggle('hidden', !inRoom || (!anyVisible && !(emptyRoom && !term)));
  }
}

q.addEventListener('input', apply);
for (const c of chips) {
  c.addEventListener('click', () => {
    room = c.dataset.room;
    for (const o of chips) o.setAttribute('aria-pressed', String(o === c));
    apply();
  });
}
`;
}

function tiles(input: ReportInput): string {
  const { scan, coverage } = input;
  const total = [...scan.byRoom.values()].reduce((n, l) => n + l.length, 0);
  const roomsUsed = [...scan.byRoom.values()].filter((l) => l.length > 0).length;

  let unreviewed = 0;
  for (const drawers of scan.byRoom.values()) {
    for (const d of drawers) {
      if (d.parsed.frontmatter.origin === "scan" && d.parsed.frontmatter.reviewed !== true) unreviewed++;
    }
  }

  const health =
    coverage.verifiedRatio >= 0.5
      ? `<span class="status ok"><span class="dot"></span>Solid</span>`
      : coverage.verifiedRatio > 0
        ? `<span class="status wa"><span class="dot"></span>Thin</span>`
        : `<span class="status cr"><span class="dot"></span>Unverified</span>`;

  return `
<div class="tiles">
  <div class="tile"><div class="v">${total}</div><div class="k">Drawers</div>
    <div class="n">${roomsUsed} of ${ROOMS.length} rooms in use</div></div>
  <div class="tile"><div class="v">${pct(coverage.mappedRatio)}</div><div class="k">Mapped</div>
    <div class="n">${coverage.mapped} of ${coverage.total} source files</div></div>
  <div class="tile"><div class="v">${pct(coverage.verifiedRatio)}</div><div class="k">Verified</div>
    <div class="n">${unreviewed} drawer(s) unreviewed</div></div>
  <div class="tile"><div class="v">${health}</div><div class="k">Map health</div>
    <div class="n">${coverage.unmapped.length} file(s) undocumented</div></div>
</div>`;
}

function coverageTable(input: ReportInput): string {
  const rows = input.coverage.byModule
    .map((m) => {
      const mapped = Math.round(m.mappedRatio * 100);
      const verified = Math.round(m.verifiedRatio * 100);
      return `<tr>
  <td class="name mono">${esc(m.dir)}</td>
  <td><div class="bar" role="img" aria-label="${esc(m.dir)}: ${mapped}% mapped, ${verified}% verified">
    <i class="mapped" style="width:${mapped}%"></i><i class="verified" style="width:${verified}%"></i>
  </div></td>
  <td class="num">${m.total} files</td>
  <td class="num">${verified}% verified</td>
</tr>`;
    })
    .join("\n");

  return `
<h2>Coverage by module</h2>
<div class="legend">
  <span><i class="sw" style="background:var(--fill)"></i>Verified — a human wrote or confirmed it</span>
  <span><i class="sw" style="background:var(--fill-soft)"></i>Mapped — some drawer anchors it</span>
</div>
<table class="cov">${rows}</table>
<p class="note">Straight after a scan, mapped is near 100% and verified is 0%. The gap is the honest measure:
an inventory of filenames is not understanding.</p>`;
}

function roomSections(input: ReportInput): string {
  return ROOMS.map((room) => {
    const drawers = input.scan.byRoom.get(room.name) ?? [];
    const indexed = input.indexed?.get(room.name);
    const mismatch = indexed != null && indexed !== drawers.length;

    const items = drawers
      .map((d) => {
        const fm = d.parsed.frontmatter;
        const title = fm.title ?? d.rel.split("/").pop() ?? d.rel;
        const anchors = fm.anchors ?? [];
        const unreviewed = fm.origin === "scan" && fm.reviewed !== true;
        const body = bodyText(d.parsed.body);
        const search = `${title} ${body} ${anchors.join(" ")}`.toLowerCase();

        const badges = [
          unreviewed ? `<span class="badge unrev">unreviewed</span>` : "",
          fm.origin === "scan" ? `<span class="badge">scan</span>` : "",
          fm.updated ? `<span class="badge">${esc(fm.updated)}</span>` : "",
        ].join("");

        return `<details class="drawer" data-room="${esc(room.name)}" data-search="${esc(search)}">
  <summary><span class="t">${esc(title)}</span>${badges}
    <span class="anchors mono">${anchors.length ? esc(anchors.join(" · ")) : "no anchors"}</span></summary>
  <div class="body">${body ? esc(body) : `<span class="none">empty</span>`}</div>
</details>`;
      })
      .join("\n");

    const unreviewed = drawers.filter(
      (d) => d.parsed.frontmatter.origin === "scan" && d.parsed.frontmatter.reviewed !== true,
    ).length;

    const countLabel = mismatch
      ? `<span class="status cr"><span class="dot"></span>${drawers.length} on disk, ${indexed} indexed</span>`
      : unreviewed > 0
        ? `<span class="status wa"><span class="dot"></span>${unreviewed} of ${drawers.length} unreviewed</span>`
        : `<span class="count">${drawers.length}</span>`;

    // Rooms scan cannot fill are a different kind of empty from rooms nobody got
    // to — saying so is the difference between a gap and a design decision.
    const notDerivable = room.name === "decisions" || room.name === "runbooks" || room.name === "glossary";
    const emptyNote = notDerivable
      ? `<strong>Nothing here yet.</strong> Scan leaves this room alone on purpose — rationale,
         operational knowledge and domain language cannot be read off the source. Only a person
         or an agent that reasoned about the project can fill it.`
      : `<strong>Nothing here yet.</strong> Run <code>long-horizon scan</code> to lay down the
         factual skeleton for this room.`;

    const stripe = mismatch ? " attn" : unreviewed > 0 ? " soft" : "";

    return `<section class="room${stripe}" data-room="${esc(room.name)}">
  <header><h3>${esc(room.name)}</h3><span class="q">${esc(room.answers)}</span>${countLabel}</header>
  ${drawers.length ? items : `<p class="empty">${emptyNote}</p>`}
</section>`;
  }).join("\n");
}

function blindSpots(input: ReportInput): string {
  if (input.coverage.unmapped.length === 0) {
    return `<h2>Blind spots</h2><p class="note"><span class="status ok"><span class="dot"></span>None</span>
      — every source file is anchored by at least one drawer.</p>`;
  }
  const shown = input.coverage.unmapped.slice(0, 60);
  return `
<h2>Blind spots</h2>
<p class="note">${input.coverage.unmapped.length} source file(s) that no drawer points at — the parts of this
codebase the map is silent about.</p>
<ul class="files mono">${shown.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
${input.coverage.unmapped.length > shown.length ? `<p class="note">…and ${input.coverage.unmapped.length - shown.length} more.</p>` : ""}`;
}

export function renderReport(input: ReportInput): string {
  const { project, facts } = input;
  const chips = [`<button class="chip" data-room="all" aria-pressed="true">all rooms</button>`]
    .concat(ROOMS.map((r) => `<button class="chip" data-room="${esc(r.name)}" aria-pressed="false">${esc(r.name)}</button>`))
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(project.slug)} — palace map</title>
<style>${styles()}</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(project.slug)}</h1>
  <p class="sub">Memory palace — ${facts.sourceFiles.length} source file(s) across ${facts.modules.length} module(s)</p>
  <p class="meta mono">${esc(project.volume)} · wing ${esc(project.slug)} · generated ${esc(input.generatedAt)}</p>

  ${tiles(input)}
  ${coverageTable(input)}

  <h2>Rooms</h2>
  <div class="controls">
    <input type="search" id="q" placeholder="Search titles, contents and anchors…" aria-label="Search drawers">
    ${chips}
  </div>
  ${roomSections(input)}

  ${blindSpots(input)}

  <p class="note">Generated by <code>long-horizon map</code>. The palace itself lives in
  <code>.palace/</code> and is the source of truth; this page is a view of it.</p>
</div>
<script>${script()}</script>
</body>
</html>
`;
}
