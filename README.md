<p align="center">
  <img src="extension/icon.png" width="128" alt="Long Horizon" />
</p>

# Long Horizon

**Live observability for MemPalace MCP retrieval — token costs, latency, and spatial traversal, visualized in real time inside VS Code.**

---

## The problem

[MemPalace](https://github.com/MemPalace/mempalace) organizes long-term AI memory using a spatial metaphor: Wings → Rooms → Drawers. It runs as an MCP stdio server inside Docker. When Claude Code uses it, you have zero visibility into:

- **Where** in the palace it's looking (which wing, which room)
- **How much token budget** each retrieval consumes
- **How long** each tool call takes
- **What it actually found** (hits, distances, previews)

Letta and Zep visualize static memory. Nobody shows the live retrieval traversal plus its token cost. That's the gap Long Horizon fills.

---

## What it does

Long Horizon intercepts every JSON-RPC message between Claude Code and MemPalace and renders it in real time.

### Palace Map

An interactive force-directed graph showing your MemPalace structure as it's accessed:

- **Wings** appear as large labeled containers with a dashed border
- **Rooms** appear as colored circles orbiting their parent wing
- **Search trails** animate in real time — dashed blue edges show which rooms were hit and how close (edge thickness = relevance)
- **Tunnels** (cross-wing links) appear as orange dashed edges
- **Heat accumulation** — rooms accessed more often grow larger
- **Hover tooltips** show room name, hit count, cosine distance, and a content preview

### Token Breakdown

A live pie chart breaking down where your token budget goes each session:

| Category | What's counted |
|---|---|
| Handshake | `initialize` + `tools/list` — the fixed overhead per session |
| Search/Retrieve | `mempalace_search`, `traverse`, `follow_tunnels`, `get_drawer`, etc. |
| Write/Mine | `add_drawer`, `checkpoint`, `mine`, `create_tunnel` |
| Meta/Status | `list_wings`, `get_taxonomy`, `status`, etc. |

The typical finding: the `tools/list` handshake alone costs **~4600 tokens** — 3–7× the cost of an actual search.

### Event Timeline

A sidebar tree view listing every MCP event chronologically with token counts, latency, and color-coded severity. Palace events expand to show their hits with wing/room/distance.

### Status Bar

Always-visible session stats: total tool calls, cumulative tokens, average latency.

---

---

## Per-project palaces

Long Horizon ships with `palace`, a CLI that gives every project its own wing in
a shared memory palace — one store, one wing per project, so any two projects can
be linked by a tunnel.

```
<repo>/
  .palace/
    mempalace.yaml       generated taxonomy — never hand-edited
    architecture/        how it is put together, and where the seams are
    decisions/           why it is this way, and what was rejected
    docs/                how to use it
    tests/               what is verified, how, and what is not
    runbooks/            it is broken at 3am — what do I do
    glossary/            what a word means here
    inbox/               worth keeping, not yet placed — never canonical
  .mcp.json              wires this project's palace into Claude Code
```

Three rules the design rests on:

1. **The repository is the source of truth.** The markdown under `.palace/` *is*
   the palace. The Docker volume (`mempalace-atlas`) is a derived index,
   rebuildable at any time. Losing it is never data loss.
2. **The directory decides the room.** A file in `.palace/decisions/` is filed
   under `decisions` regardless of its filename or frontmatter — verified
   against MemPalace 3.5.0, including adversarial names like
   `decisions/adr-002-tests-harness-choice.md`, which routes to `decisions`.
3. **One wing per project, one shared store.** Wings are MemPalace's namespace
   mechanism, and tunnels only link wings *within* a store — so sharing the store
   is what lets one query reach across projects.

Because the palace lives in the repo, it is versioned, diffed and reviewed in
pull requests like the rest of the code — which means `.mcp.json` has to survive
being cloned onto someone else's machine. It names a PATH command
(`long-horizon-proxy`), never a filesystem path:

```json
{ "mcpServers": { "mempalace": {
  "command": "long-horizon-proxy",
  "args": [],
  "env": { "LENS_ARGS": "…", "HORIZON_WS_PORT": "19462", "PALACE_WING": "your-project" }
}}}
```

An absolute path here would resolve only on the machine that generated it.
`palace doctor` reports one explicitly — *"hardcodes a machine-specific path"* —
and `palace init` rewrites it.

The store is deliberately not `mempalace-data` — that one holds auto-mined
conversation transcripts, and mixing them in would put the noise back into every
search. One store remembers conversations, the other maps projects. Override with
`PALACE_VOLUME`.

### Commands

| Command | Purpose |
|---|---|
| `palace init` | Scaffold the palace and wire it into Claude Code. Idempotent — also repairs drift. |
| `palace scan` | Map an existing codebase into the skeleton. The entry point for any repo, new or years old. |
| `palace file` | Author a drawer, validated at write time. |
| `palace sync` | Rebuild the index from `.palace/`, pruning drawers whose notes are gone. |
| `palace status` | What is filed, on disk and in the index, side by side. |
| `palace doctor` | Verify the map is accurate. Exits non-zero when it is not. |
| `palace list` | Every wing in the shared store. |

### Install once per machine

```bash
npm i -g github:sychus/long-horizon
```

Requires Node ≥ 20 and Docker. Installs three commands:

| Command | Purpose |
|---|---|
| `long-horizon` | The CLI. No arguments opens an interactive menu. |
| `palace` | The same CLI, aliased — use it in scripts, CI and agents. |
| `long-horizon-proxy` | What every project's `.mcp.json` names as its MCP command. |

TypeScript is compiled to `dist/` at install time, so nothing is transpiled at
runtime — which matters because Claude Code spawns the proxy on every session.

For local development, `npm link` from a clone does the same thing.

### Then, in any repo

```bash
long-horizon init      # seven empty rooms
long-horizon scan      # map what already exists
long-horizon update    # make it searchable
long-horizon doctor    # what is wrong, and what is still unverified
```

Or just run `long-horizon` and pick:

```
  Long Horizon — my-project

  › scan
    update
    monitor
    doctor
    status
    init
    list

  Map the current codebase into the skeleton. Safe to re-run.

  ↑↓ move · ↵ run · q quit
```

The menu only appears for a human at a terminal. Piped or non-interactive
callers get usage instead — a picker blocking on a keypress in a pipeline is a
hang, not a prompt.

### `long-horizon monitor` — keep the map current while you work

Three streams in one log:

```
Monitoring my-project
  · watching .palace/ and anchored code
  · proxy port 19481

  16:04:04  info    attached to the proxy on port 19481 — watching retrieval
  16:03:24  drift   src/auth.ts changed — auth-boundary.md may be out of date
  16:03:30  sync    1 drawer(s) reindexed
  16:04:07  agent   search  → my-project/architecture, my-project/decisions  (1766 tok  347ms)

  q quit · s sync now · d doctor
```

- **sync** — a drawer changed, so it gets reindexed. Debounced, and never
  overlapping: each sync starts a container, and one per keystroke would be its
  own denial of service.
- **drift** — anchored code changed, so the drawer describing it is now suspect.
  You hear about it immediately instead of at the next `doctor`.
- **agent** — the proxy's WebSocket, showing what the agent actually retrieved
  and what it cost. The other two keep the map true; this one is the evidence
  any of it was worth writing.

Auto-sync is safe alongside a live agent session: mining takes MemPalace's
exclusive lock but MCP reads do not, and contention is retried.

### Dropping it into a codebase that already exists

`palace init` gives you an empty building. `palace scan` reads the working tree
through git — so `.gitignore` is honoured and uncommitted work still counts — and
writes the **factual skeleton**: module inventory, entry points, configuration
surface, test topology. Every drawer is anchored to real paths and stamped
`origin: scan, reviewed: false`.

What scan will not do is guess. `decisions/`, `runbooks/` and `glossary/` are
left deliberately empty:

```
Left empty on purpose
  · decisions  why it is this way, and what was rejected
  · runbooks   what to do when it breaks
  · glossary   what the domain words mean here
    None of this is recoverable from source. A scanner that filled
    these rooms would be inventing them.
```

Re-running scan is safe. Anything reviewed or hand-edited is preserved.

### Two coverage numbers, because they answer different questions

```
Coverage
  module         files  mapped  verified
  cli               17    100%  ..........   0%  ← nobody has verified this
  extension          8    100%  ..........   0%  ← nobody has verified this
  src                6    100%  ##########  100%

  · mapped:   31/31 (100%) — some drawer anchors it
  · verified:  6/31  (19%) — a human wrote or confirmed it
```

Straight after a scan, **mapped** is ~100% and **verified** is 0%. That gap is
the point. Reporting only "coverage" would let an inventory of filenames pass as
understanding — green and empty, which is the same false confidence `doctor`
exists to prevent, arriving by a quieter route. `verified` only moves when
someone reads a drawer, corrects it, and sets `reviewed: true`.

### Why `doctor` is the point

Ingestion is curated, never automatic. A map assembled from everything is
confidently wrong in the places nobody checked, and a map that is 90% right is
worse than none — you stop verifying, and the wrong 10% is where you get hurt.

So every drawer carries **anchors**: repo-relative paths it describes. That is
what makes it falsifiable. `palace doctor` checks that

- the taxonomy still matches the canonical seven rooms,
- no file sits outside a room, where it would silently land in the fallback bucket,
- no drawer's frontmatter disagrees with the directory that actually files it,
- every anchor still resolves, and flags notes whose anchored code changed after they were written,
- **the index matches disk** — drawers under ~40 characters are silently skipped by the miner, so a note can exist, look filed, and not be searchable,
- `.mcp.json` still points at this project's store, wing and port.

Reconciliation is scoped to this project's wing, never the palace-wide total —
that number moves whenever an unrelated repo syncs.

Failures mean the map is wrong and exit non-zero, so `palace doctor` can gate CI.
Warnings mean it is thin or drifting, but not lying.

---

## Architecture

```
Claude Code  →stdio→  [ proxy ]  →stdio→  MemPalace (Docker)
                          ↓
                   WebSocket :19420
                          ↓
                   VS Code Extension
                   ┌───────────────────┐
                   │  Palace Map (D3)  │
                   │  Event Timeline   │
                   │  Token Pie Chart  │
                   │  Status Bar       │
                   └───────────────────┘
```

The proxy replaces Docker in Claude Code's MCP config. Claude Code spawns the proxy as its MCP server; the proxy spawns Docker, forwards every JSON-RPC byte verbatim (Claude Code cannot detect the proxy), enriches tool calls with spatial metadata, and streams `PalaceEvent`s over WebSocket.

---

## Documentation

| | |
|---|---|
| **[USAGE.md](USAGE.md)** | Installation, commands, workflows, troubleshooting. Start here. |
| **[SPEC.md](SPEC.md)** | Technical design, and the measurements behind each decision. |

---

## Quick start (if already configured)

1. Start Claude Code — the proxy launches automatically.
2. Open VS Code in any project.
3. `Ctrl+Shift+P` → **Long Horizon: Show Palace Map**
4. Ask Claude to use its memory — watch the graph build in real time.
