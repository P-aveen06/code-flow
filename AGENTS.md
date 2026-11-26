# Rules for coding agents in this repo

This repo is built mostly by Codex CLI from task prompts, and reviewed by a
human who must be able to explain every line to hackathon judges. Optimise
for code that is **simple, readable and well named**, not clever.

## Read first

- `docs/PLAN.md`: milestones and task list. Only do the task you were given.
- `docs/ARCHITECTURE.md`: components, graph/diff JSON schemas, flags, experiment design. Follow the schemas exactly; if you must change one, update the doc in the same change.

## Layout

- `analyzer/`: Python package `codeflow` + CLI `code-flow` (uv project)
- `server/`: FastAPI app (uv project, depends on `analyzer` by path)
- `web/`: Vite + React + TypeScript (`@xyflow/react`, `elkjs`, `@flagsmith/flagsmith`)
- `simulator/`: Python traffic simulator
- `examples/`: demo repo builder and analysis scripts

## Commands

- Python: `cd analyzer && uv sync && uv run pytest` (same in `server/`)
- Web: `cd web && npm install && npm run build && npm test`
- Everything: `make test`, dev servers: `make dev`

## Conventions

- Python 3.11+, type hints, dataclasses, no global state. Format with `ruff format`, lint with `ruff check`.
- TypeScript strict mode, function components, no state library unless needed.
- Small modules with one job each; docstring at the top of each Python module saying what it does.
- Every analyzer feature gets a pytest test using a tiny fixture repo built in a temp dir.
- Keep dependencies minimal; ask before adding a heavy one.

## Never

- Never commit secrets: Flagsmith keys, API tokens, `.env`. Read config from environment variables documented in `.env.example`.
- Never hard-code `localhost` URLs in code paths that matter; read them from config with a localhost default.
- Never let an LLM invent graph edges. Edges come only from parsing; an LLM may only write summaries.
- Never skip or delete a failing test to make the suite pass.
