# code-flow

**Git for code flow.** code-flow turns every commit into a function-level flow
diagram and shows how that flow changes commit by commit, so reviewers read a
picture instead of a 1,000-line diff. That matters more now that so much code
is AI-generated and still has to be reviewed.

Built for the WeMakeDevs x Flagsmith **Toggle Wars** hackathon, Track 01
("Test Something Real").

> Status: under construction. See [docs/PLAN.md](docs/PLAN.md) for milestones
> and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## What it does

- **Flow timeline**: a static analyzer (tree-sitter) builds a call/flow graph for each commit of a Python repo.
- **Flow diff**: see what each commit added (green), removed (red) and changed (amber) in the flow.
- **Flagsmith mode**: finds Flagsmith flag checks in the analyzed code and colours which branch is live right now, using live flag state. It also flags stale, orphan and unused flags.

## How we use Flagsmith

- **The A/B test (Track 01)**: multivariate flag `flow_view` serves three diff styles (side by side, overlay, overlay + one-line summary) to reviewers. The success event is a reviewer clicking "Understood / Approve", measured with Flagsmith Experimentation.
- **Flagsmith mode switch**: boolean flag `flagsmith_mode` turns Flagsmith mode on or off.
- **Inside the analyzed code**: code-flow reads the analyzed app's own flags to show which flow is live.

## Setup

Prerequisites include [uv](https://docs.astral.sh/uv/) with Python 3.11+ and
Node.js 22.12+. Docker runs the self-hosted Flagsmith instance.

```sh
make install  # Install dependencies
make test     # Run tests and build the web app
make dev      # Start the API on port 8787 and the web app on port 5173
```

Press Ctrl-C to stop both dev servers. Configuration defaults work for the
scaffold; see `.env.example` for the environment variables used in later milestones.
Set `CODEFLOW_WEB_ORIGIN` in the server environment to allow a web origin other
than the default `http://localhost:5173`.

### Try the analyzer

```sh
bash examples/make_shop_demo.sh
cd analyzer && uv run code-flow analyze ../examples/shop-demo --out ../data/shop-demo
uv run code-flow diff ../data/shop-demo --head <sha> --format mermaid
```

Replace `<sha>` with one of the commit IDs printed by `analyze`.

### Flagsmith setup

1. Start your Docker Flagsmith instance with Experimentation enabled
   (`EXPERIMENTATION_ENABLED=true`). If needed, copy `.env.example` to `.env`
   and set `FLAGSMITH_API_URL` to the instance's API base URL.
2. In the Flagsmith dashboard, open **Organisation settings > API Keys**,
   create an organisation API key with admin access, and set
   `FLAGSMITH_ADMIN_API_KEY` in `.env`. Create a project named `code-flow`
   in that organisation if you haven't already.
   A personal API token with admin access also works.
3. Have a local Flagsmith checkout at `data/repos/Flagsmith__flagsmith`.
   Run `make flagsmith-setup-dry-run` to preview the setup, then run
   `make flagsmith-setup`. Pass `--environment-json PATH` to the Python
   script to use another local checkout or a local export file.

The script uses one existing environment in `code-flow`. It selects
`Production` if available, then `Development`, then the sole environment if
there is only one. To select an environment explicitly, run
`python3 scripts/flagsmith_setup.py --dry-run --environment NAME` and use the
same `--environment NAME` for the setup.

The project uses three tags. These defaults apply to newly created flags.

- `code-flow` groups `flow_view` (34% `side_by_side`, 33% `overlay`, 33%
  `overlay_summary`), `flagsmith_mode` (on), and `ai_summary` (off).
- `repo:flagsmith-api` groups the 13 flags from the local checkout's
  `api/integrations/flagsmith/data/environment.json`, using the export's
  enabled states and values.
- `repo:shop-demo` groups `new_checkout` and `holiday_discount`, both on.

The script adds missing tags to existing flags and reports differences from
the defaults. It writes the selected environment's client-side key to
`CODEFLOW_FLAGSMITH_ENV_KEY` and `VITE_CODEFLOW_FLAGSMITH_ENV_KEY` for the web
app, experiment, and simulator, and the server-side key to
`CODEFLOW_FLAGSMITH_SERVER_KEY` for the server's Flagsmith mode. Flagsmith
mode uses `data/flagsmith_scopes.json` to look up each repo's flags by its
tag membership. Use `--scope-file PATH` to change the output location.

If the script cannot enable the built-in warehouse, open the selected
environment in `code-flow` and choose **Environment Settings > Warehouse >
Flagsmith database > Enable**.

## Experiment

We hypothesize that reviewers understand a flow diff more often and decide
faster with a single overlay and a one-line summary than with side-by-side
diagrams. The Flagsmith flag `flow_view` allocates 34% to `side_by_side`
(control), 33% to `overlay`, and 33% to `overlay_summary`. The primary metric
is the share of exposed reviewers who record `diff_understood`. The simulator
attaches the decision time in milliseconds to both `diff_understood` and
`diff_confusing`.

The reviewers are **simulated** using the assumptions in
[behaviour.yaml](simulator/behaviour.yaml). Diff sizes come from flow-changing
commits in the local Flagsmith analysis, with the analyzed shop demo as a
fallback. The hypothesis model encodes the expected differences to
demonstrate the event pipeline and Flagsmith's analysis. Testing the
hypothesis with real reviewers requires real review data. The null model
gives every variant the same behaviour to check for spurious differences.

Each simulated reviewer gets a seeded persona with a role, years of
experience, codebase familiarity, and reading style. The persona mix and
their modest effects on understanding and decision time are assumptions in
`behaviour.yaml`. Flagsmith receives these attributes as identity traits,
and `--persona-summary` shows their distribution by variant. A run of 100
reviewers is a small sample, so Flagsmith's win probability may be inconclusive.

```sh
make simulate-dry-run
uv run --project simulator python simulator/simulate.py --dry-run --model null --n 3000 --rate 1000
make simulate  # Sends events to the running Flagsmith experiment
```

Import Flagsmith/flagsmith in the app or follow **Try the analyzer** to
prepare local commit data. The live run requires a running experiment with
keyed variants and reads `FLAGSMITH_API_URL` and `CODEFLOW_FLAGSMITH_ENV_KEY`
from the root `.env`. Shell environment variables take precedence. The Make
targets use 1,000 reviewers at up to 20 per second with seed 7. Use
`--prefix` in the CLI to give a separate run fresh reviewer identities.

## License

_To be decided (open-source core)._
