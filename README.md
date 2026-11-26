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
   `FLAGSMITH_ADMIN_API_KEY` in `.env`.
3. Have a local Flagsmith checkout at `data/repos/Flagsmith__flagsmith`.
   Run `make flagsmith-setup-dry-run` to preview the setup, then run
   `make flagsmith-setup`. Pass `--environment-json PATH` to the Python
   script to use another local checkout or a local export file.

The script provisions the `Development` environment in `code-flow`,
`shop-demo`, and `flagsmith-api`. It sets the `flow_view` experiment split to
34% side by side, 33% overlay, and 33% overlay with a summary, turns on
`flagsmith_mode`, and turns off `ai_summary`. It turns on `new_checkout` and
`holiday_discount` in the shop demo and loads the Flagsmith API project's
flag defaults from the local export. It writes the SDK keys into `.env`.
The generated shop demo still reads `DEMO_APP_FLAGSMITH_SERVER_KEY` when run
as a standalone app. Supply `SHOP_DEMO_FLAGSMITH_SERVER_KEY` under that
legacy name in the demo's process environment.

If the script cannot enable the built-in warehouse, open `code-flow` →
`Development` and select **Environment Settings > Warehouse > Flagsmith
database > Enable**.

## License

_To be decided (open-source core)._
