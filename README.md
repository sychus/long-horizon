<p align="center">
  <img src="extension/icon.png" width="128" alt="Long Horizon" />
</p>

# Long Horizon

**A verified map of every project you work on — and a live view of what your AI actually reads from it.**

---

## The problem

Software that survives is software whose people have an exact map: where each
thing lives, and enough context to find it without guessing. Most projects don't
have one. The knowledge sits in heads, in old PRs, in a wiki that stopped being
true two refactors ago.

AI agents make this worse and better at once. Worse, because an agent with a
wrong map is confidently wrong at scale. Better, because an agent will actually
maintain a map if you give it one it can check.

The trap is the obvious fix. A map auto-generated from the codebase is ~90%
right, and **90% right is worse than nothing** — you stop verifying, and the
wrong 10% is where you get hurt.

## What this is

Two halves of the same idea.

**`palace`** — a CLI that gives each project a curated, verifiable map, stored in
the repo and searchable by Claude Code through
[MemPalace](https://github.com/MemPalace/mempalace).

- Seven fixed rooms — architecture, decisions, docs, tests, runbooks, glossary, inbox
- Every note **anchored** to real file paths, so it can be proven stale
- `doctor` verifies the map and exits non-zero when it's wrong, so CI can gate it
- `scan` bootstraps an existing codebase from verifiable facts, and refuses to
  invent the parts it can't derive

**The VS Code extension** — a transparent stdio proxy plus a live view of what
the agent retrieves, so you can see whether the map is actually being used and
what it costs.

---

## Install

```bash
pnpm setup                                # once per machine, if you never have
pnpm add -g github:sychus/long-horizon
```

```bash
cd your-project
long-horizon init      # create the palace, wire it into Claude Code
long-horizon scan      # map the code that already exists
long-horizon update    # build the searchable index
long-horizon doctor    # verify it
```

**→ Full installation, commands and workflows: [USAGE.md](USAGE.md)**

---

## Why `doctor` is the point

Anything can generate documentation. The hard part is keeping it true.

Every drawer carries **anchors** — the repo paths it describes. That makes it
falsifiable: when `src/auth.ts` moves, the note describing it is provably
suspect. `doctor` checks placement, anchors, taxonomy drift, disk-vs-index
agreement and MCP wiring, then reports two coverage numbers:

```
  module         files  mapped  verified
  cli               17    100%  ..........   0%  ← nobody has verified this
  src                6    100%  ##########  100%

  · mapped:   31/31 (100%) — some drawer anchors it
  · verified:  6/31  (19%) — a human wrote or confirmed it
```

**mapped** is any anchor at all — usually ~100% right after a scan. **verified**
counts only what a person wrote or confirmed, and starts at zero. Reporting one
number would let an inventory of filenames pass as understanding. The gap is the
honest measure of how much of your codebase anyone actually has in hand.

---

## The observability half

The proxy sits between Claude Code and MemPalace, forwards every JSON-RPC byte
verbatim, and streams enriched events over WebSocket.

```
Claude Code  →stdio→  [ proxy ]  →stdio→  MemPalace (Docker)
                          ↓
                    WebSocket
                          ↓
                  VS Code extension
```

- **Palace Map** — force-directed graph of wings and rooms; search trails animate
  as they're hit, tunnels render as distinct edges, frequently-read rooms grow,
  and hovering shows hit count, cosine distance and a content preview.
- **Token Breakdown** — live pie chart splitting the session into Handshake,
  Search/Retrieve, Write/Mine and Meta/Status.
- **Event Timeline** — every MCP event with token cost and latency; palace events
  expand to their hits.
- **Status Bar** — which wing you're observing, plus calls, tokens and average latency.

The extension is **read-only**. Every change to a palace goes through the CLI.

### What a session actually costs

Measured through the proxy against MemPalace 3.5.0, with the tiktoken estimator:

| | tokens |
|---|---|
| `initialize` | 63 |
| `tools/list` response | **5102** |
| one `mempalace_search` | 1573 |

The `tools/list` handshake is a fixed ~5.1k per session — about **3× an actual
search**, paid before the agent retrieves anything. Surfacing that was the
original reason this project exists.

`long-horizon monitor` merges the same live stream with auto-sync and drift
detection, so the map stays current while you work.

---

## Documentation

| | |
|---|---|
| **[USAGE.md](USAGE.md)** | Installation, commands, workflows, troubleshooting. Start here. |
| **[SPEC.md](SPEC.md)** | Technical design, and the measurements behind each decision. |

## Status

Working and in use, but young. Known rough edges:

- Installs from git with **pnpm**; `npm i -g` from a git URL is broken by an npm
  bug that symlinks the package to a temp clone it then deletes.
- `dist/` is committed, because a global install from git has no compiler. A
  pre-commit hook rebuilds and stages it, and CI fails if the two ever diverge.
- The VS Code extension is built and installed manually from `extension/`.

## Developing

```bash
pnpm install
pnpm setup:hooks          # required — keeps the committed dist/ in step
pnpm link --global        # point the commands at your working copy
```

`pnpm setup:hooks` sets `core.hooksPath`. Without it you can commit a source
change with the previous build attached, and nothing local will complain — CI
catches it, but a lot later than the hook would.
