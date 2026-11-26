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
3. `Module.attr()` resolves through the import table.
4. Anything unresolved is dropped by default (`--keep-external` keeps it as an
   `external` node collapsed per top-level package).

This is deliberately heuristic. Edges come only from parsing, never from an LLM.

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
- If such a call is the condition of an `if` / `elif` (also `not …`, and a local
  variable assigned from the call and then tested), calls inside the body get
  `guard: {flag, when: "on"}` and calls in the `else` get `when: "off"`.

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
    codeflow/{__init__,cli,graph,parse_python,resolve,git_history,diff,flags,summary,export_mermaid}.py
    tests/
  server/
    pyproject.toml
    app/{main,store,flagsmith_client}.py
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
