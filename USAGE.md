# Long Horizon — Installation & Usage

One memory palace per project: a curated, verifiable map of a codebase's
architecture, decisions, docs, tests, runbooks and vocabulary — searchable by
Claude Code through MemPalace, and continuously checked so it never quietly goes
stale.

The core idea: **a map that is 90% right is worse than no map**, because you stop
verifying and the wrong 10% is where you get hurt. So every note is anchored to
real files, and `doctor` keeps proving it true.

---

## Requirements

| | |
|---|---|
| Node | ≥ 20 |
| Docker | running |
| MemPalace image | `docker build -t mempalace https://github.com/MemPalace/mempalace.git` |
| Git | each project must be a repo |

---

## Install

```bash
pnpm setup                                # once per machine, if you never have
pnpm add -g github:sychus/long-horizon
```

> **Use pnpm, not npm.** `npm i -g` from a git URL symlinks the package to a
> temporary clone directory that npm then deletes, leaving three broken
> commands. Verified on npm 10 / Node 20. pnpm installs it correctly.

Installs three commands:

| Command | What it is |
|---|---|
| `long-horizon` | The CLI. No arguments opens an interactive menu. |
| `palace` | Same CLI, aliased. **Use this in scripts, CI and agents.** |
| `long-horizon-proxy` | Named by each project's `.mcp.json`. You never run it by hand. |

`dist/` is committed, so nothing is compiled at install time. After changing
source, run `pnpm build` and commit the output alongside it.

For local development, `pnpm link --global` from a clone points the commands at
your working copy instead.

---

## Quick start

```bash
cd your-project

long-horizon init      # create the palace, wire it into Claude Code
long-horizon scan      # map the code that already exists
long-horizon update    # build the searchable index
long-horizon doctor    # verify it
```

Then commit `.palace/` and `.mcp.json`, and restart Claude Code so it picks up
the MCP server.

Or just run `long-horizon` and pick from the menu.

---

## Concepts

| Term | What it is |
|---|---|
| **Store** | One shared Docker volume (`mempalace-atlas`) holding every project. |
| **Wing** | One project inside the store. Named after your repo directory. |
| **Room** | A topic. Seven fixed rooms, same in every project. |
| **Drawer** | One markdown note in a room. |
| **Anchor** | A repo-relative path a drawer describes. What makes it checkable. |

Two rules everything follows from:

1. **The repo is the source of truth.** `.palace/*.md` is the palace. The Docker
   volume is a rebuildable index — losing it is never data loss.
2. **The directory decides the room.** A file in `.palace/decisions/` is filed
   under `decisions` regardless of its filename or frontmatter.

Because the palace lives in the repo, it is versioned and reviewed in pull
requests like the rest of the code.

---

## Layout

```
your-project/
  .palace/
    mempalace.yaml       generated taxonomy — never edit by hand
    architecture/        how it is put together, and where the seams are
    decisions/           why it is this way, and what was rejected
    docs/                how to use it
    tests/               what is verified, and what is not
    runbooks/            it is broken at 3am — what do I do
    glossary/            what a word means here
    inbox/               worth keeping, not yet placed — never canonical
  .mcp.json              wires this project's palace into Claude Code
```

---

## Commands

| Command | What it does |
|---|---|
| `init` | Creates the seven rooms, the taxonomy, and `.mcp.json`. Idempotent — re-run it to repair drift. |
| `scan` | Reads the codebase and writes the factual skeleton of the map. Safe to re-run; never overwrites reviewed work. |
| `update` | Rebuilds the searchable index from `.palace/`, and prunes drawers whose notes were deleted. Alias: `sync`. |
| `monitor` | Long-running. Auto-syncs, warns on code drift, and shows what the agent retrieves live. |
| `file` | Writes one drawer, validated at write time. |
| `status` | What is filed, on disk and in the index, side by side. |
| `doctor` | Verifies the map. **Exits non-zero when it is wrong**, so it can gate CI. |
| `list` | Every wing in the shared store. |

### `scan`

```bash
long-horizon scan --dry-run    # preview, write nothing
```

Writes what it can **verify** from the repo: module inventory, entry points,
configuration surface, test topology. All anchored, all stamped
`origin: scan, reviewed: false`.

It deliberately leaves `decisions/`, `runbooks/` and `glossary/` **empty** — why
a decision was made, what breaks at 3am, and what a domain word means are not
recoverable from source. A scanner that filled them would be inventing them.

### `file`

```bash
palace file --room architecture --title "Auth boundary" \
  --anchor src/auth/session.ts --anchor src/auth/provider.ts \
  --body "Auth is isolated behind one module so swapping providers never reaches request handling."
```

| Flag | |
|---|---|
| `--room` | Required. One of the seven rooms. |
| `--title` | Required. |
| `--anchor` | Repo-relative path this note describes. Repeatable. |
| `--body` | Content. Omit to read from stdin. |
| `--force` | Overwrite an existing drawer, or accept a broken anchor. |

Rejected at write time: unknown rooms, anchors that don't exist, missing title.

### `monitor`

```
  16:04:04  info    attached to the proxy on port 19481 — watching retrieval
  16:03:24  drift   src/auth.ts changed — auth-boundary.md may be out of date
  16:03:30  sync    1 drawer(s) reindexed
  16:04:07  agent   search → my-app/architecture, my-app/decisions  (1766 tok  347ms)

  q quit · s sync now · d doctor
```

| Stream | Meaning |
|---|---|
| `sync` | A drawer changed and was reindexed. Debounced; never overlapping. |
| `drift` | Anchored code changed, so the drawer describing it is now suspect. |
| `agent` | What Claude actually retrieved, and what it cost. |

Safe to run during a live Claude Code session: only indexing takes MemPalace's
exclusive lock, reads never do, and contention is retried automatically.

---

## The seven rooms

| Room | Answers |
|---|---|
| `architecture` | How is this put together, and where are its seams? |
| `decisions` | Why is it this way, and what did we reject? |
| `docs` | How do I use it? |
| `tests` | What is verified, how, and what is not? |
| `runbooks` | It's broken at 3am — what do I do? |
| `glossary` | What does this word mean here? |
| `inbox` | Worth keeping, not yet placed. Empty it regularly. |

The taxonomy is fixed on purpose: walking into any repo, `architecture` means the
same thing and sits in the same place.

---

## Drawer format

```markdown
---
room: architecture
title: Auth boundary
anchors: src/auth/session.ts, src/auth/provider.ts
updated: 2026-08-07
origin: scan          # omit for hand-written notes
reviewed: false       # set true once a human has checked it
---

# Auth boundary

Authentication is isolated behind a single module so that swapping the provider
never reaches into request handling.
```

Notes:

- **Anchors are the point.** A drawer with no anchors can never be checked and
  will drift silently. `glossary` is the only fair exception.
- **Write what the code cannot tell you** — why this shape, what was rejected,
  which invariant must hold. Don't paraphrase the implementation.
- **Keep bodies over ~40 characters.** Shorter notes are silently skipped by the
  indexer; `doctor` catches this, but it's easier to avoid.

---

## Coverage: two numbers

```
  module         files  mapped  verified
  cli               17    100%  ..........   0%  ← nobody has verified this
  src                6    100%  ##########  100%

  · mapped:   31/31 (100%) — some drawer anchors it
  · verified:  6/31  (19%) — a human wrote or confirmed it
```

- **mapped** — any drawer anchors it. Usually ~100% right after a scan.
- **verified** — a human wrote or confirmed that drawer. Starts at 0%.

The gap is the point. An inventory of filenames isn't understanding, and
reporting a single "coverage" number would let it pass as one. `verified` only
moves when someone reads a drawer, corrects it, and sets `reviewed: true`.

---

## What `doctor` checks

**Failures** — the map is actively wrong. Exits non-zero.

| Check |
|---|
| Taxonomy matches the canonical seven rooms; wing matches the project |
| All seven room directories exist |
| No markdown sitting outside a room |
| No drawer whose `room:` disagrees with the directory filing it |
| Every anchor still resolves |
| No drawer too short to be indexed |
| Disk and index agree, per room, scoped to this wing |
| `.mcp.json` matches this project's store, wing and port |

**Warnings** — thin or drifting, but not lying.

| Check |
|---|
| Drawers with no anchors, or no frontmatter |
| Anchored code changed after the drawer was written |
| Drawers still sitting in `inbox` |
| Source files no drawer points at |
| Scan output nobody has reviewed |
| Port shared with another wing |

---

## Working with agents

Give Claude these rules:

1. **Use `palace <subcommand>`, never bare `long-horizon`** — that opens an
   interactive menu and will hang waiting for a keypress.
2. **Never write with `mempalace_add_drawer`.** It bypasses every check. Read
   tools (`mempalace_search`, `mempalace_traverse`) are expected and fine.
3. **Always anchor.**
4. **Run `palace update` after filing**, and `palace doctor` before trusting the
   map.

A `palace` skill for Claude Code lives at `~/.claude/skills/palace/SKILL.md`.

### Reviewing scan output

High-value agent work. For each drawer scan wrote:

1. Read it against the actual code.
2. Correct it, and add what the facts don't say — responsibilities, boundaries,
   seams.
3. Set `reviewed: true`.
4. `palace update`.

Never set `reviewed: true` on something you haven't checked. That flag is the
only thing separating generated inventory from real knowledge.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `long-horizon-proxy is not on your PATH` | Reinstall: `npm i -g github:sychus/long-horizon` |
| `.mcp.json hardcodes a machine-specific path` | `long-horizon init` — an older version wrote an absolute path |
| `disk and index disagree` | `long-horizon update`. If it persists, those drawers are too short to index. |
| `The palace stayed locked by another sync` | Another project is indexing. Nothing was filed — just run it again. |
| `wing "x" is not in the shared palace` | `long-horizon update` |
| `No git repository found` | A palace is versioned with its code. `git init` first. |
| MemPalace missing in Claude Code | Restart Claude Code — `.mcp.json` is read at startup. |
| Menu hangs in a script | Use `palace <subcommand>`, not bare `long-horizon`. |

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PALACE_VOLUME` | `mempalace-atlas` | The shared store. Deliberately separate from `mempalace-data`, which holds auto-mined conversation transcripts. |
| `HORIZON_WS_PORT` | derived from the project name | Proxy WebSocket port. Set in `.mcp.json`. |
| `PALACE_WING` | the project slug | Which wing this repo owns. Set in `.mcp.json`. |
| `LENS_CMD` / `LENS_ARGS` | `docker` / the run args | What the proxy spawns. Set in `.mcp.json`. |
| `NO_COLOR` | — | Disable colored output. |

---

## VS Code extension (optional)

Visualizes what the agent retrieves: a palace map, an event timeline, a token
breakdown, and live session stats in the status bar. It is **read-only** — every
change to a palace goes through the CLI.

```bash
cd extension
pnpm install && pnpm build
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension long-horizon-0.1.0.vsix
```

It picks up the palace from the workspace's `.mcp.json` automatically.

| Setting | Default | |
|---|---|---|
| `long-horizon.wsPort` | unset | Leave it alone and the port comes from `.mcp.json`. Set it only to pin one — an explicit value always wins. |
| `long-horizon.tokenWarningThreshold` | `2000` | Warn above this token count |
| `long-horizon.latencyWarningMs` | `500` | Warn above this latency |
| `long-horizon.autoOpen` | `false` | Open the map on session start |

---

## Notes and limits

- Searches reach **across projects** by default — one query can surface another
  project's decision. That's intentional; the store is shared so wings can be
  linked. Pass a `wing` filter to scope it.
- Two projects indexing at the same moment is normal and handled by retry.
- Losing the Docker volume is never data loss — `long-horizon update` rebuilds it
  from the repo.
- `.mcp.json` names a PATH command, so the repo can be cloned onto another
  machine. That machine still needs the tool installed.

For the technical design and the measurements behind these decisions, see
[SPEC.md](SPEC.md).
