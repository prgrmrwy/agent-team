# Agent Team

A single-user, local web app that orchestrates multiple AI coding agents to
work a development task in parallel.

Each task spins up a small **team of role-based agents** — planner, engineer,
QA, CI — produced from a **factory** pattern. They collaborate through a shared
**chatroom** context bus and advance the task through a structured state
machine (`S0 → S1 → S2 → S6 → S7 → [S9 →] S10' → S11 → done`). You stay in the
loop from the browser: kick off a task, watch the agents talk and work, and
confirm the finish.

> Built as a self-bootstrapping experiment — an AI team building the "AI team"
> system. See `docs/bootstrap-notes.md` for the reflection notes.

## How it works

- **Chatroom as the context bus** — all task info (plan, artifacts, phase
  changes, seat status) flows through a shared chatroom exposed to agents as
  MCP tools. Agents read on demand instead of copying state around.
- **Factory pattern** — each role is a versioned YAML factory
  (`apps/server/src/domain/factory/defaults/`) that defines persona, system
  prompt, recommended skills/tools, permissions, and model profile.
- **Per-task isolation** — every task runs in its own process with its own git
  worktree and SQLite db under `DATA_HOME` (default `~/.agent-team/`).
- **Agent drivers** — agents run via ACP (`@agentclientprotocol/sdk`) bridged
  to Claude Code, with a Codex adapter as an alternative runtime.

Full design: [`docs/architecture.md`](docs/architecture.md).

## Prerequisites

- **Node.js 24+** (see `.nvmrc`) and **pnpm 11+** (via corepack).
- An authenticated AI coding CLI for the agents to drive:
  - **Claude Code** (default runtime, via the `@zed-industries/claude-code-acp`
    bridge), and/or
  - **Codex CLI** (`codex`, alternative runtime) — set `AGENT_TEAM_CODEX_BIN`
    if it is not on your `PATH`.
- `git`, and `gh` if you use the CI factory's real (non-stub) mode.

## Quick start

```bash
# 1. Node + pnpm
corepack enable
nvm use            # or ensure Node 24+

# 2. Install
pnpm install

# 3. Configure (optional — a token is auto-generated on first run)
cp .env.example .env

# 4. Run backend + frontend
pnpm --filter @agent-team/server dev    # http://localhost:3001
pnpm --filter @agent-team/web dev       # http://localhost:5173
```

Open http://localhost:5173. The frontend is authenticated by the local
`AGENT_TEAM_TOKEN` (auto-generated into `.env` on first server start). Create a
task from the home composer and watch the team work.

See [`.env.example`](.env.example) for all configuration options.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Start all workspace dev servers in parallel |
| `pnpm build` | Build all workspaces |
| `pnpm test` | Run server + protocol unit tests |
| `pnpm preflight` | Dependency rules (dependency-cruiser) + FSD rules (steiger) + typecheck + tests |

## Repository layout

```
apps/web/          Frontend SPA (React 19, FSD layers: app/pages/widgets/features/entities/shared)
apps/server/       Backend (http / ws / mcp / domain / adapters / process)
packages/protocol/ Shared zod schemas + WS/REST/MCP protocol contracts
tools/at-hook/     Hook reporting script
openspec/          Authoritative behavior specs (validate: openspec validate --all --strict)
docs/              Architecture and design docs
```

Architectural discipline (enforced by `pnpm preflight`): dependencies flow one
way across FSD layers, the backend `domain` never depends on transport layers,
and anything shared between front and back lives only in `packages/protocol`.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — full architecture (vision,
  factories, state machine, chatroom protocol, data model).
- [`openspec/specs/`](openspec/specs/) — authoritative behavior specs
  (SHALL/MUST + scenarios).
- `AGENTS.md` / `CLAUDE.md` — entry map for AI iterations working in this repo.

## License

[MIT](LICENSE) © 2026 prgrmrwy
