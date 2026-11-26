# code-flow architecture

code-flow is "git for code flow". It turns each commit of a repository into a
function-level flow graph, then shows how that graph changes commit by commit,
so a reviewer can read a diagram instead of a 1,000-line diff.

On top of that, code-flow is itself driven by Flagsmith feature flags, and it
can read Flagsmith flag checks inside the code it analyzes ("Flagsmith mode").

## Big picture

```
            ┌────────────────────────── analyzer (Python, open source) ─────────────────────────┐
 git repo ─▶│ git walker ─▶ tree-sitter parser ─▶ graph builder ─▶ flag detector ─▶ snapshots  │
            │                                                     (Flagsmith calls)  diff engine │
            └────────────────────────────────────────────────────────────────┬──────────────────┘
                                                                             │ graph JSON / diff JSON
                                     code-flow CLI (analyze / diff / export) │
                                                                             ▼
   Flagsmith (self-hosted, Docker) ◀──── server (FastAPI): snapshots, diffs, code, live flag state
   + Experimentation (ClickHouse)                │  REST API
        ▲        ▲                               ▼
        │        └── JS SDK: flow_view, ── web app (Vite + React + React Flow + ELK.js)
        │            flagsmith_mode, exposure + trackEvent('diff_understood')
        └─────────── Python SDK: get_experiment_flag + track_event ── traffic simulator
```

The analyzer outputs a **neutral graph JSON**. Every renderer (React Flow in
the web app, Mermaid for PR comments and static export) is only a view of that
JSON, so renderers can be swapped without touching the analyzer.

## Components

| Path | What it is | Tech |
|---|---|---|
| `analyzer/` | Python package `codeflow` + CLI `code-flow`. Parses code, builds graphs, walks git history, diffs snapshots, detects Flagsmith flag checks, exports Mermaid. Open-source core. | Python 3.11+, `tree-sitter`, `tree-sitter-python`, plain `git` via subprocess |
| `server/` | FastAPI app. Serves snapshots, diffs, code snippets; reads live flag state of the analyzed app from Flagsmith; builds the one-line diff summary; optional local mirror of experiment events. | FastAPI, uvicorn, `flagsmith` Python SDK, SQLite (optional) |
| `web/` | Reviewer UI: commit timeline, flow diff in three styles, Flagsmith mode panel. Sends experiment exposure and success events to Flagsmith. | Vite, React, TypeScript, `@xyflow/react`, `elkjs`, `@flagsmith/flagsmith` JS SDK |
| `simulator/` | Generates simulated reviewers, each a Flagsmith identity, who get a `flow_view` variant and send review events to Flagsmith Experimentation. | Python, `flagsmith` SDK |
| `examples/` | Scripts that build a small demo repo with a scripted git history (flag-gated checkout flow), and a script to analyze Flagsmith/flagsmith. | bash / Python |

## Graph JSON (`code-flow/graph@1`)

One file per commit: `<out>/snapshots/<sha>.json`.

```json
{
  "schema": "code-flow/graph@1",
  "repo": "shop-demo",
  "commit": {"sha": "abc123", "parents": ["def456"], "author": "…", "date": "2026-11-26T10:00:00Z", "message": "…"},
  "nodes": [
    {
      "id": "shop.checkout:new_checkout",
      "kind": "function",               // function | method | class | module
      "name": "new_checkout",
      "module": "shop.checkout",
      "file": "shop/checkout.py",
      "line": 12, "end_line": 30,
      "body_hash": "sha1 of normalized body"   // drives "changed" detection
    }
  ],
  "edges": [
    {
      "source": "shop.api:checkout",
      "target": "shop.checkout:new_checkout",
      "kind": "call",
      "line": 22,
      "guard": {"flag": "new_checkout", "when": "on"}   // null when the call is not behind a flag
    }
  ],
  "flags": [
    {"name": "new_checkout", "file": "shop/api.py", "line": 20, "function": "shop.api:checkout", "call": "is_feature_enabled"}
  ]
}
```

Node ids are `<dotted.module>:<Qualified.name>`; they stay stable across
commits as long as the function keeps its name and module, which is what makes
diffs possible.

### Call resolution (Python, static, best effort)

1. Calls to a bare name resolve to a function in the same module, then to an
   imported name (`from x import y`, `import x as z` then `z.y`).
2. `self.foo()` / `cls.foo()` resolve to a method of the enclosing class (and
   its in-repo base classes when resolvable).

   **2b.** `x.foo()` uses the same lookup when `x` has a single known in-repo
   class from a parameter annotation (including quoted and optional forms) or
   a constructor assignment in the function or module. Parameters and locals
   shadow module instances, conflicting assignments leave the class unknown,
   and chained receivers such as `x.attr.foo()` stay unresolved.

3. `Module.attr()` resolves through the import table.
4. Anything unresolved is dropped by default (`--keep-external` keeps it as an
   `external` node collapsed per top-level package).

This is deliberately heuristic. Edges come only from parsing, never from an LLM.

## Commit index JSON (`code-flow/commits@1`)

`<out>/commits.json` lists the selected first-parent commits oldest first.
Each entry uses the same commit fields as the graph JSON (`message` is the
commit subject and `date` is the author date in UTC). `repo_path` is the
absolute path of the analyzed Git repository, which the server uses to read
source at a commit.

```json
{
  "schema": "code-flow/commits@1",
  "repo": "shop-demo",
  "repo_path": "/path/to/shop-demo",
  "branch": "main",
  "source_root": "",
  "commits": [
    {"sha": "abc123", "parents": [], "author": "code-flow demo", "date": "2026-11-20T09:00:00Z", "message": "Add cart"}
  ]
}
```

`source_root` is a repo-relative directory used to select files and derive
dotted module names. An empty string uses the repo root. An output directory
reuses snapshots by SHA, so use a fresh directory when changing include or
exclude patterns, `source_root`, or `keep_external`.

## Diff JSON (`code-flow/diff@1`)

```json
{
  "schema": "code-flow/diff@1",
  "base": "def456", "head": "abc123",
  "nodes": {"added": ["id"], "removed": ["id"], "changed": ["id"]},
  "edges": {"added": [{"source": "…", "target": "…"}], "removed": [{"source": "…", "target": "…"}]},
  "flags": {"added": ["new_checkout"], "removed": []},
  "stats": {"nodes_added": 3, "nodes_removed": 1, "nodes_changed": 2, "edges_added": 4, "edges_removed": 1}
}
```

- **changed** = same id in both snapshots, different `body_hash`.
- **rerouted** paths show up as an edge removed plus an edge added from the same source.

### Keeping big repos readable

A whole-repo graph is unreadable. Every view renders the **changed
neighbourhood**: added, removed and changed nodes plus their 1-hop callers and
callees, grouped into compound nodes by module (ELK.js layered layout,
hierarchical). The user can expand to 2 hops or show the full module.

## HTTP API

The server listens on port 8787 and serves JSON under `/api`. The
`CODEFLOW_DATA_DIR` default is `data/` at the code-flow repo root. Relative
overrides resolve against the working directory. `{repo}` is a plain analyzer
output directory name such as `shop-demo`, with no `/`, `\`, or `..`. SHA
parameters accept full SHAs or unique prefixes, and responses use full SHAs.

- `GET /api/health` returns `{"status": "ok", "analyzer_version": "0.1.0"}`.
- `GET /api/repos` returns `[{"name": "shop-demo", "branch": "main", "commit_count": 8}]`
  for subdirectories containing `commits.json`, sorted by name.
- `GET /api/repos/{repo}/commits` returns `{"repo": "shop-demo", "branch": "main", "commits": […]}`.
  Entries are oldest first and include `sha`, `parents`, `author`, `date`, and
  `message` plus `stats` (the five diff counts) and `summary`. Each comparison
  uses the first parent's snapshot or an empty graph for the root commit.
- `GET /api/repos/{repo}/snapshots/{sha}` returns that commit's `code-flow/graph@1` JSON.
- `GET /api/repos/{repo}/diff?head=SHA&base=SHA&hops=1` returns `base`, `head`,
  `summary`, the `code-flow/diff@1` JSON in `diff`, and overlay `nodes` and
  `edges`. Omit `base` to compare with the first parent or with an empty
  graph (`"base": ""`) for a root commit. `hops` defaults to 1 and accepts 0–3.
  The overlay contains the union of both graphs within the changed
  neighbourhood. Nodes are sorted by `id` and include `name`, `qualname`,
  `module`, `kind`, `file`, `line`, `end_line`, and `status` (`added`,
  `removed`, `changed`, or `context`). Edges are sorted by `(source, target)`
  and include `guard` and `status` (`added`, `removed`, or `context`).
  Both include `in_base` and `in_head` for the side-by-side view. Node
  locations and edge guards come from head when present, otherwise from base.
- `GET /api/repos/{repo}/code?sha=SHA&file=PATH&start=N&end=M` returns
  `{"sha": "…", "file": "shop/checkout.py", "start": 15, "end": 19, "lines": [{"number": 15, "text": "def new_checkout(…):"}, …]}`.
  Paths are repo-relative without `..`. Lines are 1-based and inclusive.
  Bounds are clamped to the file. Omit both to get the whole file.
- Unknown repos, SHAs, or files return 404 with `{"detail": "…"}`. Bad
  parameters return 400 or FastAPI's 422 for type errors.

## Colours

| Meaning | Colour |
|---|---|
| added | green |
| removed | red (dashed in overlay) |
| changed | amber |
| unchanged context | grey |
| Flagsmith mode: live path (flag state selects it) | bold green edge with flag badge |
| Flagsmith mode: switched-off path | grey dashed edge with flag badge |

## Flags that control code-flow itself

All flags live in Paveen's **self-hosted Flagsmith (Docker)**, project
`code-flow`. URLs and keys come from environment variables (see
`.env.example`); nothing secret is committed.

| Flag | Type | Purpose |
|---|---|---|
| `flow_view` | multivariate string | The Track 01 experiment. Control `side_by_side`; variants `overlay` and `overlay_summary`. Allocation 34/33/33 while the test runs; roll out the winner by setting it to 100%. |
| `flagsmith_mode` | boolean | Turns Flagsmith mode on or off (Paveen's decision). When off, the panel and live colouring are hidden. |
| `ai_summary` | boolean (optional) | Kill switch for calling an LLM for the summary; when off the rule-based summary is used. |

The web app identifies each reviewer to Flagsmith (`flagsmith.identify(reviewerId)`),
so variant allocation is sticky per reviewer. The variant is attached to every
experiment event.

### Variants

- **A `side_by_side`**: two synchronized canvases, before (base) and after (head).
- **B `overlay`**: one canvas with the union graph, coloured added/removed/changed.
- **C `overlay_summary`**: B plus a one-line summary banner ("checkout now routes to `new_checkout` behind flag `new_checkout`; 3 functions added, 1 removed").
  The summary is rule-based by default (deterministic, no key needed); an LLM
  provider can be plugged in behind `ai_summary`.

## Experiment (Track 01)

The track requires **Flagsmith Experimentation** (beta). It works on the
open-source self-hosted build: set `EXPERIMENTATION_ENABLED=true` on the API,
and the Flagsmith `docker-compose.yml` runs the experimentation services with
a local ClickHouse. Results (lift, credible intervals, win probability) come
from Flagsmith's built-in Bayesian engine on the experiment's results page.
Docs: https://docs.flagsmith.com/experimentation

- **Experiment**: in the `code-flow` project, multivariate flag `flow_view`, split 34/33/33, primary metric built from the event `diff_understood`.
- **Unit**: reviewer identity (real or simulated). Users must be identified for experiment events.
- **Exposure**: the web app evaluates the flag with `flagsmith.getExperimentFlag('flow_view')` (JS SDK `@flagsmith/flagsmith` >= 12.4.0, initialised with `enableEvents: true`), which records the exposure.
- **Success event**: `flagsmith.trackEvent('diff_understood', { value: msToUnderstand })` when the reviewer clicks "Understood / Approve". "Confusing" sends `diff_confusing`.
- **Simulated traffic**: `simulator/` uses the Python SDK: `get_experiment_flag("flow_view", identifier=id)` for exposure, then `track_event("diff_understood", identifier=id, value=ms)` (or `diff_confusing`), and `close()` at the end to flush. Identities are `sim-reviewer-NNNN`. The behaviour model (probability of understanding and time distribution per variant and per diff size) lives in `simulator/behaviour.yaml` and is stated openly in the README and the demo, because the users are simulated.
- **Local mirror (optional)**: the server can also log events to SQLite and show a simple per-variant table, as a backup if the Flagsmith results page lags during the demo.
- **Rollout**: after the run, roll out the winner from the experiment page (or set `flow_view` to it at 100%), shown live in the demo video.

## Flagsmith mode

Detects Flagsmith flag checks in the analyzed Python code and overlays live
flag state from Flagsmith.

Detection (analyzer, `codeflow/flags.py`):
- Calls whose method name is one of `is_feature_enabled`, `get_feature_value`,
  `has_feature`, `feature_enabled`, `get_value` with a string-literal first
  argument. The list is configurable.
- Direct, negated, or local-variable flag checks guard their branch body
  with `on` or `off` as appropriate, and chains starting with a flag check
  carry the opposite of the latest flag guard into later `elif` and `else`
  bodies unless a clause or nested branch has its own flag guard.

Live state (server):
- Reads the analyzed app's environment flags from the self-hosted Flagsmith
  (`FLAGSMITH_API_URL`, `DEMO_APP_ENVIRONMENT_KEY`).

Findings shown in the panel:
- **live / off**: which branch of each flag-gated split users hit now.
- **stale**: flag is fully on (or fully off) in Flagsmith and the check has been
  in the code, unchanged, for at least N commits / D days of history. Suggests
  deleting the dead branch, naming the functions that become unreachable.
- **orphan**: flag checked in code but missing in Flagsmith.
- **unused**: flag defined in Flagsmith but never checked in the code.

## Repository layout (target)

```
code-flow/
  AGENTS.md            rules for coding agents (Codex) working in this repo
  README.md            what it is, how to run, demo, architecture summary
  docs/ARCHITECTURE.md this file
  docs/PLAN.md         milestones and task list
  .env.example
  analyzer/
    pyproject.toml
    codeflow/{__init__,cli,graph,parse_python,resolve,diff,flags,summary,export_mermaid}.py
    codeflow/git_history.py  reads first-parent commits and blobs with Git
    codeflow/analyze.py      caches file parses and writes snapshots and the commit index
    codeflow/build.py  assembles one commit's parsed files into a graph
    tests/
  server/
    pyproject.toml
    app/{config,main,store,flagsmith_client}.py
    tests/
  web/
    package.json, vite.config.ts
    src/{main.tsx,App.tsx,api.ts,flags.ts,layout/elk.ts}
    src/views/{Timeline,SideBySide,Overlay,OverlaySummary,FlagsmithPanel,CodePane}.tsx
  simulator/
    simulate.py, behaviour.yaml
  examples/
    make_shop_demo.sh   builds examples/shop-demo as a git repo with scripted commits
    analyze_flagsmith.sh
```
