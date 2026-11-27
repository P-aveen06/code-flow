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
| `server/` | FastAPI app. Serves snapshots, diffs, code snippets, and live flag state. One spawned worker process handles Git imports and refresh analysis in the same container. | FastAPI, uvicorn, Python `multiprocessing`, `flagsmith` Python SDK |
| `web/` | Reviewer UI: commit timeline, flow diff in three styles, Flagsmith mode panel. Sends experiment exposure and success events to Flagsmith. | Vite, React, TypeScript, `@xyflow/react`, `elkjs`, `@flagsmith/flagsmith` JS SDK |
| `simulator/` | Generates simulated reviewers, each a Flagsmith identity, who receive a variant and send review events to Flagsmith Experimentation. | Python, `flagsmith` SDK |
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
    {"sha": "abc123", "parents": [], "author": "code-flow demo", "date": "2026-11-20T09:00:00Z", "message": "Add cart", "base": ""}
  ]
}
```

`source_root` is a repo-relative directory used to select files and derive
dotted module names. An empty string uses the repo root. An output directory
reuses snapshots by SHA, so use a fresh directory when changing include or
exclude patterns, `source_root`, or `keep_external`.

The `touching` option (`--touching DIR` in the CLI) lists only first-parent
commits that change the specified subfolder. Each diff compares against the
entry's `base` SHA, which points to the previous listed commit. The oldest
entry uses its unlisted first-parent snapshot when available, or `""` for an
empty graph at a root commit or shallow history boundary.

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

At viewport sizes of 1200×700 or larger, Source code starts at 30% of the
space shared with Flow. The divider enforces minimum panel heights and saves
its percentage under `code-flow:source-split` in local storage. The canvas
refits after resizing settles. Full screen expands the Flow panel.

## HTTP API

The server listens on port 8787 by default and serves JSON under `/api`.
The Docker image listens on `PORT` when supplied. The
`CODEFLOW_DATA_DIR` default is `data/` at the code-flow repo root. Relative
paths from the repo-root `.env` resolve against the repo root. Paths from
process environment variables resolve against the working directory.
`{repo}` is a plain analyzer output directory name such as `shop-demo`,
with no `/`, `\`, or `..`. SHA parameters accept full SHAs or unique prefixes,
and responses use full SHAs.

- `GET /api/health` returns `{"status": "ok", "analyzer_version": "0.1.0"}`.
- `GET /api/repos` lists indexed repos and import jobs, sorted by `name`.
  Each entry has `id`, `name`, `url`, `subdir`, `branch`, `commit_count`,
  `status`, `message`, and `warning`. Local analyzer output has `url: null`
  and `subdir: ""`.
- `POST /api/repos` accepts a JSON object with `url`, optional `subdir`
  (default `""` for the repo root), and optional `max_commits` (integer from 1 to
  `CODEFLOW_MAX_IMPORT_COMMITS`, which defaults to 200). An omitted count uses
  30 or the server limit if lower. Use a public `https://github.com/<owner>/<repo>` URL with an
  optional `.git` suffix and trailing slash. Owner and repo names use ASCII
  letters, digits, `.`, `_`, or `-`, with `.` and names containing `..` rejected.
  Use a repo-relative POSIX subfolder path without `..` components, a drive
  prefix, backslashes, or NULs. Invalid requests return 400. A new job returns
  202 with `{"id": "<owner>__<repo>", "status": "queued"}`. A request for an
  active ID returns 202 with its current status. Re-importing after completion
  fetches the default branch into the existing clone, reuses cached parses and
  snapshots for the same source root, and replaces the output on success.
- `POST /api/repos/{id}/refresh` returns 202 with the same `{id, status}`
  response as an import. It reuses a queued or running job for the same ID.
  For a new job, it validates the published GitHub URL, subfolder, and commit
  limit from `source.json` and fetches the default branch into the existing
  clone. A repository without a GitHub source returns 409. An unknown ID
  returns 404. The saved limit grows by the number of new first-parent commits
  that touch the subfolder, up to the same server limit. If the previous newest
  commit is absent from the default branch's first-parent history, refresh uses
  the saved limit capped at the server limit.
  Refresh reuses cached parses and snapshots and publishes the refreshed
  output and limit together. The previous output remains readable during a
  refresh and after a failure.
- `GET /api/auto-sync` returns `interval_seconds`, `all` (boolean), `repos`
  (repository IDs mapped to booleans), and `status` (repository IDs mapped to
  refresh status and counters). Status has nullable UTC timestamps
  `last_started`, `last_finished`, and `next_run`, a nullable `last_result`
  (`up_to_date`, `new_commits`, or `error`), and nullable `new_commits` and
  `error` fields. The in-memory counters are `runs` (automatic jobs started),
  `fetches` (Git fetch attempts), `analysed_commits` (graphs built, including
  a missing diff base), and `seconds` (wall time spent in automatic refresh
  jobs). A separate `manual_runs` counter tracks manual jobs started.
- `PUT /api/auto-sync` merges optional `all` and `repos` fields into the
  saved settings and returns the same shape as GET. A malformed body returns
  400, an unknown repository returns 404, and a repository without a GitHub
  import returns 409.
- `GET /api/repos/{id}/status` returns `id`, `name`, `status`, `message`,
  `current` and `total` commit counts, `seconds` elapsed, and nullable `warning`
  and `error` fields. The nullable integer `new_commits` counts SHAs in a
  successful refresh's new index that were absent from the old index.
  Zero means up to date. It is null for active or failed jobs, regular
  imports, and repositories without an in-memory job.
  Status is `queued`, `cloning`, `analyzing`, `ready`, or
  `error`. An empty latest graph or no selected commits gives a `ready` status
  with a warning that code-flow analyzes Python only for now. Failures give a
  readable `error`, such as `Repository not found or not public` or a missing
  subfolder message.
- Clones live in `data/repos/<owner>__<repo>`. Analysis outputs live in
  `data/<id>/`, with source URL, name, subfolder, commit limit, and import time
  in `data/<id>/source.json`.
- The app starts one long-lived analysis worker using Python's spawn context.
  A queue in the API process serializes imports and refreshes and deduplicates
  active repository IDs. The worker runs Git, keeps the blob parse cache, and
  writes a staged copy of the analysis while the API serves the last published
  snapshots. A pipe carries progress, refresh counts, and the result back to
  the API, which swaps in completed output under the store lock and invalidates
  its caches. If the worker exits during a job, that job goes to `error` and
  the next job starts a replacement worker. On shutdown, the scheduler stops
  queuing refreshes, the import queue drains, and the app joins the worker.
- `GET /api/repos/{repo}/commits` returns `{"repo": "shop-demo", "branch": "main", "commits": […]}`.
  Entries are oldest first and include the commit index fields plus `stats`
  (the five diff counts) and `summary`. Legacy indexes without `base` use the
  first parent or an empty graph for a root commit.
- `GET /api/repos/{repo}/snapshots/{sha}` returns that commit's `code-flow/graph@1` JSON.
  The API keeps the most recently used decoded graphs in memory.
  `CODEFLOW_SNAPSHOT_CACHE_SIZE` defaults to 16 graphs.
- `GET /api/repos/{repo}/flags?sha=SHA` returns `repo`, full `sha`,
  `flagsmith` (`connected`, `environment`, UTC `fetched_at`, `error`), and
  `flags`. Omit `sha` to use the newest listed commit. Each flag includes
  `name`, `status`, `enabled`, `value`, `in_flagsmith`, `checks`
  (`file`, `line`, `function`, `call`), `guarded_edges`
  (`source`, `target`, `when`, `live`), `stale`, `stale_reason`, and
  `dead_calls` (`source`, `target`). The order is orphan, live, off, unused,
  then by name within each status. Code-only results use `unknown`.
- `GET /api/repos/{repo}/diff?head=SHA&base=SHA&hops=1` returns `base`, `head`,
  `summary`, the `code-flow/diff@1` JSON in `diff`, overlay `nodes` and
  `edges`, integer `flow_depth`, and boolean `long_flow`. Omit `base` to use
  the commit index's diff base. `hops` defaults to 1 and accepts 0–3.
  `flow_depth` counts nodes along the longest call chain in the union of the
  base and head graphs within the requested neighbourhood, before grouping or
  collapsing nodes. It is 0 for an empty neighbourhood. A depth-first traversal
  visits roots and callees in sorted node ID order and ignores edges back to
  nodes on the current path. `long_flow` is true when the depth meets or exceeds
  `CODEFLOW_LONG_FLOW_MIN_DEPTH`, a positive integer that defaults to 4.
  The overlay contains the union of both graphs within the changed
  neighbourhood. Nodes are sorted by `id` and include `name`, `qualname`,
  `module`, `kind`, `file`, `line`, `end_line`, and `status` (`added`,
  `removed`, `changed`, or `context`). Each node has integer `lines_added`
  and `lines_removed` for its source spans, or `null` for both when source is
  unavailable for an added, removed, or changed node. Context nodes have zero
  counts and require no source reads. Edges are sorted by
  `(source, target)` and include `guard` and `status` (`added`, `removed`, or `context`).
  Both include `in_base` and `in_head` for the side-by-side view. Node
  locations and edge guards come from head when present, otherwise from base.
- `GET /api/repos/{repo}/function-diff?head=SHA&base=SHA&node=ID` returns
  `node`, `base`, `head`, `file`, `status`, `lines_added`, `lines_removed`, and
  `rows`. Omit `base` to use the same commit index base as `/diff`. The server
  reads each revision's source span from its snapshot. Each row has `kind`
  (`context`, `added`, or `removed`), `base_line`, `head_line`, and `text`.
  Line numbers are 1-based, with `null` when no corresponding line exists in
  that revision. Context symbols show head source with zero counts. The
  endpoint returns 404 for unknown nodes and unavailable source.
- `GET /api/repos/{repo}/code?sha=SHA&file=PATH&start=N&end=M` returns
  `{"sha": "…", "file": "shop/checkout.py", "start": 15, "end": 19, "lines": [{"number": 15, "text": "def new_checkout(…):"}, …]}`.
  Paths are repo-relative without `..`. Lines are 1-based and inclusive.
  Bounds are clamped to the file. Omit both to get the whole file.
- Unknown repos, SHAs, or files return 404 with `{"detail": "…"}`. Bad
  parameters return 400 or FastAPI's 422 for type errors.

### Automatic refresh

The server loads `data/auto_sync.json` once at startup and writes updates
atomically. The file uses schema `code-flow/auto-sync@1` and fields `all`
and `repos`. A missing or invalid file starts with both switches off.
For a published GitHub import, either `all: true` or `repos[id]: true`
enables a refresh. The scheduler runs for the app lifespan and checks for
newly enabled repositories on its next tick. It submits due refreshes to
the existing single worker and skips repos with queued or running jobs.
The switches are shared for a data directory, including changes made in
preview mode.
`CODEFLOW_AUTO_SYNC_INTERVAL_SECONDS` sets the interval (300 seconds by
default, minimum 10). Tests and scripts can supply `auto_sync_interval`
to `create_app`.

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

Paveen's free, self-hosted Flagsmith organisation has room for one project.
Flags are defined in the `code-flow` project and have a state in each
environment. The setup script selects Production by default and accepts
`--environment` for Development or another simulation environment.
On creation, `variant_preview` starts off in Production and on in the
simulation environments. Later Production runs report any state differences.

| Tag | Flags |
|---|---|
| `code-flow` | `flow_view`, `flow_direction`, `sync_mode`, `flagsmith_mode`, `ai_summary`, `variant_preview` |
| `repo:flagsmith-api` | The 13 Flagsmith API flags seeded from `api/integrations/flagsmith/data/environment.json` in Flagsmith/flagsmith |
| `repo:shop-demo` | `new_checkout`, `holiday_discount` |

The web app uses `VITE_CODEFLOW_FLAGSMITH_ENV_KEY` and the API server uses
`CODEFLOW_FLAGSMITH_SERVER_KEY`. Use Development keys for `develop` and
Production keys for `main`. Production setup writes both web and server keys
to `.env`. Development setup writes `CODEFLOW_SIM_FLAGSMITH_ENV_KEY`, which is
also the web client key for Development. See `.env.example` for configuration.

| Flag | Type | Purpose |
|---|---|---|
| `flow_view` | multivariate string | The Track 01 experiment. Control `side_by_side`; variants `overlay` and `overlay_summary`. Allocation 34/33/33 while the test runs; roll out the winner by setting it to 100%. |
| `flow_direction` | multivariate string | The long-flow layout experiment. Control `horizontal` (ELK RIGHT) and variant `vertical` (ELK DOWN), split 50/50. |
| `sync_mode` | multivariate string | Commit refresh experiment with `manual_button`, `per_repo_toggle`, and `global_toggle`, split 34/33/33 in Development. Production is disabled with `manual_button` as the default and zero treatment allocation. |
| `flagsmith_mode` | boolean | Toggles flag findings and live colouring. The Flagsmith section always shows the active flow settings. |
| `ai_summary` | boolean (optional) | Kill switch for calling an LLM for the summary; when off the rule-based summary is used. |
| `variant_preview` | boolean | Enables the view, direction, and sync preview controls and URL overrides in Development and simulation environments. Defaults off in Production and when Flagsmith is unavailable. |

The web app identifies each reviewer to Flagsmith (`flagsmith.identify(reviewerId)`),
so variant allocation is sticky per reviewer. View outcome events include the
assigned variant.

### Variants

With `variant_preview` enabled, the viewer accepts `?view=side_by_side`,
`?view=overlay`, or `?view=overlay_summary`, and `?direction=horizontal` or
`?direction=vertical`. The landing page and viewer also accept
`?sync=manual_button`, `?sync=per_repo_toggle`, or `?sync=global_toggle`.
Any preview override skips experiment exposures and keeps review outcomes
local. With previews disabled, the app uses the Flagsmith assignments and
keeps short flows horizontal.

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

The two recorded experiments used simulated reviewers in the shared
Production environment described above. For current runs, Production serves
the web app and real reviewers. The simulator and experiment CLI default to
Development through `CODEFLOW_SIM_ENVIRONMENT`. Development setup seeds the
original experiment flag states and writes `CODEFLOW_SIM_FLAGSMITH_ENV_KEY`
for the simulator. Production experiment writes and live simulated traffic
require the explicit `--environment Production` option. Simulator history is
scoped to the environment and flag, with pre-split history counted as Production.

- **Experiment**: in the `code-flow` project, multivariate flag `flow_view`, split 34/33/33, primary metric built from the event `diff_understood`.
- **Unit**: reviewer identity (real or simulated). Users must be identified for experiment events.
- **Exposure**: the web app evaluates the flag with `flagsmith.getExperimentFlag('flow_view')` (JS SDK `@flagsmith/flagsmith` >= 12.4.0, initialised with `enableEvents: true`), which records the exposure.
- **Success event**: `flagsmith.trackEvent('diff_understood', { value: msToUnderstand })` when the reviewer clicks "Understood / Approve". "Confusing" sends `diff_confusing`.
- **Simulated traffic**: `simulator/` uses the Python SDK: `get_experiment_flag("flow_view", identifier=id)` for exposure, then `track_event("diff_understood", identifier=id, value=ms)` (or `diff_confusing`), and `close()` at the end to flush. Identities are `sim-reviewer-NNNN`. The behaviour model (probability of understanding and time distribution per variant and per diff size) lives in `simulator/behaviour.yaml` and is stated openly in the README and the demo, because the users are simulated.
- **Local mirror (optional)**: the server can also log events to SQLite and show a simple per-variant table, as a backup if the Flagsmith results page lags during the demo.
- **Rollout**: after the run, roll out the winner from the experiment page (or set `flow_view` to it at 100%), shown live in the demo video.

### Long-flow layout experiment

The hypothesis for `flow_direction` is that reviewers understand long flows
more often and faster with a top-down layout. In the planned web integration,
only reviewers who see a long flow trigger `getExperimentFlag('flow_direction')`.
Short flows stay horizontal. After a layout exposure, the same Yes/No review
click sends `layout_understood` with `{value: ms}` or `layout_confusing`.
The primary metric is the occurrence of `layout_understood` and the secondary
metric is the mean value of that event per exposure.

**Long flow = `flow_depth ≥ 4` by default.** The cutoff of 4 selects 5 of the
14 flow-changing commits (35.7%) in the primary Flagsmith API analysis.
The distribution below uses `hops=1` and the indexed diff base for each commit.

| Analysis | Indexed commits | Flow-changing commits | Depth 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `Flagsmith__flagsmith` | 50 | 14 | 1 | 2 | 6 | 1 | 2 | 1 | 1 |
| `openai__whisper` | 30 | 12 | 1 | 5 | 6 | 0 | 0 | 0 | 0 |
| `openai__codex` | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

The simulator always samples eligible one-hop commits using the default
cutoff. It prefers the Flagsmith analysis and falls back to another local
analysis with long flows. `simulator/experiments/flow_direction.yaml` records
the hypothesis and null behaviour assumptions. The setup and experiment CLI
dry runs preview the new flag, both metrics, and the 50/50 experiment.

### Commit freshness experiment

`sync_mode` runs only in Development. The hypothesis is that auto-sync
shows new commits sooner without a noticeable cost in page load or server
load. The landing page evaluates the assigned variant with
`getExperimentFlag('sync_mode')` outside previews.

- **A `manual_button` (34%)** uses **Check for new commits** in the viewer.
- **B `per_repo_toggle` (33%)** adds an **Auto-sync** switch per GitHub
  import on the landing page.
- **C `global_toggle` (33%)** adds one **Auto-sync all repos** switch.

The manual button is available in all three variants. The two auto-sync
variants show each GitHub import's sync status on the landing page. The
[benchmark harness](../scripts/sync_benchmark.py) compares three history sizes
at one and five repositories with isolated local upstreams and a real
server and Chrome. Its dated reports in `docs/benchmarks/` include the raw
samples, observed rates, and formulas for the 300-second projections. CPU
covers the API and its descendants. The report lists separate API and worker
tree RSS peaks and the peak of their simultaneous sum. Use
`--report-name sync_mode-worker` to choose a filename for a rerun. The default
is `sync_mode-<UTC date>` and existing reports are protected.
Each case records `suspended: false` and `max_sample_gap_s`. A clock
divergence over 3 seconds or a sampling gap over 10 seconds triggers one
retry. The benchmark resumes from completed cases and imported templates
in its workdir. Case and template keys include the code-flow commit and
process sampling version. Use `--fresh` to remeasure cases with the cached
templates.
The report's `settings.elapsed_s` totals the active time saved with the
completed cases.
The [measured simulator config](../simulator/experiments/sync_mode.yaml)
assigns seeded workload traits to the default panel. After Flagsmith assigns
a variant, the simulator replays values from the matching benchmark cell.
It adds a modeled wait to measured refresh-to-visible time for freshness.
See the [results record](experiment-results.md#sync_mode-development) for
the measurement and reviewer assumptions.

| Metric | Event | Aggregation | Expected direction |
|---|---|---|---|
| New commit seen within 5 min (primary) | `new_commit_seen_within_5min` | Occurrence | Increase |
| Freshness (s) | `sync_freshness_s` | Mean | Decrease |
| Landing page load (ms) | `sync_page_load_ms` | Mean | Decrease |
| Server CPU (ms per hour) | `sync_server_cpu_ms` | Mean | Decrease |

## Flagsmith mode

Detects Flagsmith flag checks in the analyzed Python code and overlays live
flag state from Flagsmith.

Detection (analyzer, `codeflow/flags.py`):
- The configurable method list includes `is_feature_enabled`,
  `get_feature_value`, `has_feature`, `feature_enabled`, `get_value`, and the
  OpenFeature `get_{boolean,string,integer,float,object}_value` and `_details`
  methods. Detection matches the method name on a variable or a chained
  receiver such as `get_openfeature_client()`. The first argument or `flag_key=`
  can be a string literal, a bare name, or a dotted reference. The analyzer
  resolves references to a single module-level string assignment in the same
  module or through an import from another analyzed module. Reassigned,
  ambiguous, and unresolved keys are ignored.
- Direct, negated, or local-variable flag checks guard their branch body
  with `on` or `off` as appropriate, and chains starting with a flag check
  carry the opposite of the latest flag guard into later `elif` and `else`
  bodies unless a clause or nested branch has its own flag guard.

The server reads live flag state from the shared environment.

- The Python SDK remotely evaluates environment flags without an identity.
  It uses `FLAGSMITH_API_URL` (default `http://localhost:8000/api/v1/`) and
  `CODEFLOW_FLAGSMITH_SERVER_KEY`, with process environment variables taking
  precedence over the repo-root `.env`. Lookups use a four-second timeout and
  are cached for ten seconds across repositories.
- `make flagsmith-setup` reads the project tags and writes
  `data/flagsmith_scopes.json` (`code-flow/flagsmith-scopes@1`). Its `repos`
  object maps each analyzed repo ID to its flag names. The server reads the
  file from the data directory by default, with `CODEFLOW_FLAGSMITH_SCOPES_PATH`
  as an override. A repo's live state is limited to its scope and excludes
  `code_flow_flags`. The admin key is used during setup only.
- With no server key or a failed lookup, the API returns `connected: false`
  with an error, a null `fetched_at`, and only checked flags, with `unknown`
  status, `in_flagsmith: false`, and null `enabled`, `value`, and guarded-edge
  `live` fields.
- **live / off** flags are checked in code and enabled or disabled in Flagsmith.
  Guarded edges whose `when` disagrees with that state are `dead_calls`.
- **orphan** flags are checked in code and absent from the repo's scoped live
  state. Their guarded-edge `live` values are null. **unused** flags are present
  in the repo's scoped live state and have no checks at `sha`.
- **stale** flags are disabled or enabled with a null value and have the same
  nonempty set of `(file, function, call)` locations in every listed commit
  through `sha`, with a minimum of five commits. Dead calls for stale flags
  identify candidates for deletion.

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
    app/importer.py    queues GitHub imports and reports progress
    app/import_worker.py  runs Git and stages analysis in a child process
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
