# code-flow hackathon plan

**Event:** WeMakeDevs x Flagsmith "Toggle Wars", **Track 01: Test Something Real**.
**Deadline:** Sun **Nov 29 2026, 8:00 PM IST** (14:30 UTC). Late submissions are not accepted.
**Internal cutoff:** submit by **Nov 29, 5:00 PM IST** to leave a buffer.

## What the track asks for

> "Build an app and run a real A/B test on it with Flagsmith Experimentation.
> The experiment is what counts, not the size of the app."

Judged on: a clear hypothesis, versions behind a flag, a metric from real
events, results you can explain. Simulated users and traffic are allowed.
Every submission needs a **public GitHub repo**, a **README with setup steps
and how Flagsmith is used**, and a **short demo video**. All-track scorecard:
Use of Flagsmith, Impact, Creativity, Demo video. AI coding assistants are
allowed, but Paveen must understand and explain the code, so keep the code
simple and the docs clear.

## Hypothesis

> Reviewers understand a code change faster and more often when they see a
> single **overlay** flow diff (with a one-line summary) than when they see the
> **before/after diagrams side by side**.

- Flag: `flow_view` (multivariate): `side_by_side` (control), `overlay`, `overlay_summary`.
- Success event: reviewer clicks **Understood / Approve** (`understood`).
- Secondary: time from `diff_viewed` to `understood`.

## Scope (in) and (out)

In: Python analyzer, per-commit graph JSON, diff, CLI, Mermaid export, web app
(timeline + 3 diff views), Flagsmith-driven experiment with simulated
reviewers, Flagsmith mode (flag-gated paths, live/off colouring, stale/orphan/
unused flags) gated by the `flagsmith_mode` flag, a scripted demo repo, a run
on Flagsmith/flagsmith.

Out (post-hackathon): TypeScript analyzer, GitHub App / PR comment bot,
hosted multi-tenant app, auth, runtime tracing.

## Milestones

Each milestone ends with something that runs, tests passing, a commit, and a
push. Times are IST.

| # | Target | Deliverable | Demo check |
|---|---|---|---|
| M0 | Nov 26, 2 PM | Repo scaffold, `AGENTS.md`, docs, `.env.example`, Python + web toolchains install cleanly | `uv run pytest` and `npm run build` succeed on empty skeleton |
| M1 | Nov 26, 11 PM | Analyzer: Python parser, call resolution, graph JSON, git history walker (incremental by blob sha), diff, flag detection, Mermaid export, CLI. Demo repo script. | `code-flow analyze examples/shop-demo --out data/shop-demo` writes one snapshot per commit; `code-flow diff --base A --head B --format mermaid` prints a diagram that renders on GitHub |
| M2 | Nov 26, 2 PM (done) | Server (snapshots, diffs, code snippets) + web app: commit timeline, overlay view, side-by-side view, click a node to see code, ELK layout of the changed neighbourhood | Open the web app, click through the shop-demo commits, watch the flow change |
| M2.5 | Nov 26, 11 PM (done 3 PM) | Landing page, "Analyze a GitHub repo" import with background analysis and progress, a self-explanatory viewer, OpenFeature flag detection, Flagsmith/flagsmith (`api/`, last ~50 commits) as the main demo | Paste `https://github.com/Flagsmith/flagsmith` + `api/` on the landing page, watch progress, open the repo and understand a real commit without being told what the screen means |
| M3 | Nov 27, 6 PM (done Nov 26, 3:30 PM) | Flagsmith wiring: JS SDK + identity, `flow_view` picks the view, `overlay_summary` banner, `flagsmith_mode` gates the Flagsmith panel, live flag colouring, stale/orphan/unused findings; seed a `flagsmith-api` project from `api/integrations/flagsmith/data/environment.json` | Flip a flag in Flagsmith and the live path in the diagram moves; turn `flagsmith_mode` off and the panel disappears |
| M4 | Nov 28, 2 PM | Experiment: Flagsmith Experimentation enabled on the Docker instance, exposure + success events from web app and simulator, results, roll-out of the winner | Run 1,000+ simulated reviewers; Flagsmith's results page shows lift and win probability per variant; winner rolled out |
| M5 | Nov 29, 2 PM | README polish, architecture diagram, demo video script and recording (on the Flagsmith repo) | Video recorded; README has setup steps and "How we use Flagsmith" |
| — | Nov 29, 5 PM | Submit | |

If time runs short, cut in this order: stale-flag history check → side-by-side
viewport sync → LLM summary (keep the
rule-based one). Never cut the experiment: it is what the track judges.

## Task list

### M0 Scaffold
- [x] `AGENTS.md`, `README.md` skeleton, `docs/`, `.gitignore`, `.env.example`
- [x] `analyzer/` uv project, package `codeflow`, console script `code-flow`, pytest
- [x] `server/` uv project depending on `analyzer` (path dependency), FastAPI hello route
- [x] `web/` Vite React TS app with `@xyflow/react`, `elkjs`, `flagsmith`
- [x] Root `Makefile` (or `justfile`): `make dev` runs server + web, `make test` runs all tests

### M1 Analyzer
- [x] `parse_python.py`: tree-sitter-python; collect modules, classes, functions, methods (qualified names), call sites with line numbers, import table, `if` conditions
- [x] `resolve.py`: call resolution rules from ARCHITECTURE.md; unit tests per rule
- [x] `graph.py`: dataclasses for Node/Edge/Flag/Graph, `to_json` / `from_json`, schema `code-flow/graph@1`, `body_hash` on normalized function text
- [x] `flags.py`: detect Flagsmith checks and set `guard` on edges (if/elif/else, `not`, local variable)
- [x] `git_history.py`: list first-parent commits on a branch (`--max-count N`), read files at a commit with `git ls-tree` / `git cat-file`, cache per-file parse results by blob sha, path include/exclude globs (skip tests and migrations by default)
- [x] `diff.py`: added/removed/changed nodes, added/removed edges, flag changes, stats, `neighbourhood(diff, hops=1)`
- [x] `summary.py`: rule-based one-line summary of a diff
- [x] `export_mermaid.py`: overlay diff as Mermaid `flowchart LR` with subgraphs per module and class-based colours
- [x] `cli.py`: `code-flow analyze <repo> [--branch] [--max-commits] [--include] [--exclude] --out <dir>`, `code-flow diff <dir> --base --head [--format json|mermaid]`, `code-flow flags <dir> --commit`
- [x] `examples/make_shop_demo.sh`: builds `examples/shop-demo/` git repo with ~8 commits (cart → payment → add `new_checkout` behind flag → refactor → remove dead path, etc.), deterministic dates
- [x] Tests: fixture repo built in a tmp dir; snapshot and diff assertions

### M2 Server + web
- [x] Server routes: `GET /api/repos`, `GET /api/repos/{repo}/commits`, `GET /api/repos/{repo}/snapshots/{sha}`, `GET /api/repos/{repo}/diff?base&head&hops`, `GET /api/repos/{repo}/code?sha&file&start&end`
- [x] Web: timeline (commit list with +/−/~ counts), diff canvas, node click opens code pane
- [x] `layout/elk.ts`: ELK layered, compound nodes per module, left-to-right
- [x] Views: `Overlay.tsx`, `SideBySide.tsx` (two canvases, synced viewport), `OverlaySummary.tsx`
- [x] "Understood / Approve" and "Confusing" buttons, timer from render

### M2.5 Landing page, repo import, explained viewer, Flagsmith demo
Why: a first-time user opening the M2 app had "zero idea what this web app does", no way to add a GitHub repo, and the demo must run on the real Flagsmith repo.
- [x] A. Landing page at `/`: one-sentence pitch, 3-step "How it works", "Analyze a GitHub repo" form (URL, optional subfolder, recent commits, default 30), example buttons (Flagsmith/flagsmith with `api/`, shop-demo), list of analyzed repos with status; viewer moves to `/repo/:id`
- [x] B. Repo import: `POST /api/repos {url, subdir, max_commits}` (public github.com only), clone into `data/repos/<owner>__<name>`, analyze in a background job, `GET /api/repos/{id}/status` (cloning / analyzing i of N / ready / error); web shows progress and opens the repo when ready; clear "Python only for now" message; re-analysis reuses the per-blob cache
- [x] C. Self-explanatory viewer: header with the commit's message, author, date and counts in words; dismissible "What am I looking at?" panel; legend in words; empty state for commits with no Python flow change and a "hide commits with no flow change" toggle (on by default); review bar reworded ("Did this diagram help you understand the change?" Yes / No, answers feed a Flagsmith A/B test), raw timer hidden but still measured; summary only in `overlay_summary`
- [x] D1. Analyzer: OpenFeature evaluation methods (`get_boolean_value`, `get_string_value`, `get_integer_value`, `get_float_value`, `get_object_value` and `_details` forms) in flag detection; progress callback; every listed commit gets a base snapshot when history is capped; performance on Flagsmith/flagsmith `api/`
- [x] D2. Analyze Flagsmith/flagsmith `api/`, last ~50 commits, tests and migrations excluded; record analysis time and flag checks found

### M3 Flagsmith
- [x] Flagsmith flags in the existing project `code-flow` (free org = one project), grouped by tags `code-flow`, `repo:flagsmith-api`, `repo:shop-demo`; scripted as `make flagsmith-setup` (`scripts/flagsmith_setup.py`), run on Nov 26
- [x] `web/src/flags.ts`: init SDK with self-hosted `api` URL + client-side env key, `identify(reviewerId)`, expose `flowView`, `flagsmithMode`
- [x] Server `flagsmith_client.py`: live flags for the analyzed app via server-side env key; cache 10 s
- [x] `GET /api/repos/{repo}/flags?sha` returns detected flags + live state + findings (live/off/stale/orphan/unused)
- [x] `FlagsmithPanel.tsx` + edge styling for guarded edges

### M4 Experiment
- [x] Turn on Experimentation in Paveen's Docker Flagsmith (`EXPERIMENTATION_ENABLED=true`, experimentation services + ClickHouse from Flagsmith's `docker-compose.yml`); connect the warehouse for the `code-flow` environment (done Nov 26: `EXPERIMENTATION_ENABLED` only, events in Postgres; warehouse "Flagsmith database" enabled for code-flow/Production by the setup script)
- [x] Create metric from event `diff_understood` and the experiment on `flow_view` (34/33/33); write the exact steps into README
- [x] Web: `getExperimentFlag('flow_view')` for exposure, `trackEvent('diff_understood', { value: ms })` / `trackEvent('diff_confusing')` on the buttons, `enableEvents: true`
- [x] `simulator/simulate.py` + `behaviour.yaml`: N identities, `get_experiment_flag` per identity, sample outcome and time from the behaviour model, `track_event`, `close()`; `--n`, `--rate`, `--seed`
- [ ] Optional: server SQLite mirror + small results table in the web app as a backup
- [ ] Read results in Flagsmith (lift, credible intervals, win probability); roll out the winner; screenshots for README (results read Nov 26, see docs/experiment-results.md; roll-out and dashboard screenshots pending)
### M5 Demo + polish
- [x] `examples/analyze_flagsmith.sh`: scripted version of the M2.5 import (clone Flagsmith/flagsmith, analyze last ~50 commits of `api/`)
- [x] README: pitch, screenshots/GIF, setup steps, "How we use Flagsmith", experiment hypothesis and results, architecture, limitations (simulated users, heuristic call resolution)
- [x] Four viewer sections with commit authors, compact flow cards, and per-function source diffs and line counts
- [ ] Demo video script (≤ 3 min): problem → timeline → diff views → Flagsmith mode flip → experiment results → roll-out (postponed: more features and experiments first)

## How the work is executed

Per Paveen's preference, implementation runs through **Codex CLI** with the
**GPT sol 6.1** model at **medium** reasoning effort, on Paveen's Mac (where
Codex is signed in and self-hosted Flagsmith runs in Docker). Each task above
is handed to Codex with a focused prompt that points at this plan and
`docs/ARCHITECTURE.md`; the result is reviewed, tested, committed and pushed,
and a PR is opened against `main`.

## Open questions for Paveen

- Flagsmith URL of the Docker instance (default `http://localhost:8000`) and the environment keys (put them in a local `.env`, never in chat or git).
- Whether the Docker setup can run Flagsmith **Experimentation** (needs `EXPERIMENTATION_ENABLED=true` and the ClickHouse service; the track requires it).
- ~~License for the open-source core~~ Resolved Nov 26: MIT (`LICENSE`).
