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

_Coming with milestone M0. Will cover: Python (uv), Node, a self-hosted Flagsmith in Docker with Experimentation enabled, and the `.env` file._

## License

_To be decided (open-source core)._
