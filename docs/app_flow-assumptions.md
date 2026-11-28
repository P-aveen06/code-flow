# app_flow: simulator assumptions

These are hypotheses for judges to check, not user data. The simulator (`simulator/pieces.py`,
`simulator/experiments/app_flow.yaml`) walks a simulated reviewer from the landing page to a second
branch of the same repo. Exposure comes from the `app_flow` flag (control a 34%, b 33%, c 33%). Each
`ui_*` switch sets one piece to today, a, b or c.

## Fewest clicks per step

Clicks a visitor needs with no dead clicks. Totals: **today 10, flow A 9, flow B 9, flow C 9.**

| Step | Today | A | B | C | Source |
|---|---|---|---|---|---|
| Start sign-in (landing) | 1 | 1 | 1 | 1 | Today: the sign-in card's button (`pages/SignInImport.tsx`). B: inline card (`flows/b/Landing.tsx`). A and C: from the designs. |
| Sign-in | 1 | 2 | 2 | 2 | One intermediate sign-in surface before GitHub: A a `/signin` page, B an inline panel, C a modal. |
| Pick repo | 1 | 1 | 1 | 1 | One repo row in each picker. |
| Analyze | 1 | 1 | 1 | 1 | Analyze button (`RepoDetails.tsx`, `SignIn.tsx`). |
| First flow | 0 | 0 | 0 | 0 | The flow view opens on its own. |
| Answer review | 1 | 1 | 1 | 1 | One answer button (`FlowView.tsx`, `diff_understood` / `diff_confusing`). |
| Branch switch | 5 | 3 | 3 | 3 | Today: link to the picker, repo row, native select (open and pick), Analyze (`screens.tsx`). Flows: open the switcher, pick a branch, Analyze (`BranchSwitch.tsx`). |

Caveat: on this branch the flow A and C sign-in screens are stubs. Their sign-in counts come from the
designs, not from code.

## Assumptions beyond the code and designs

| Assumption | Value | Basis |
|---|---|---|
| Exposure split | a 34, b 33, c 33 | `scripts/flagsmith_setup.py` (app_flow flag) |
| Visitors who never start sign-in | 15% leave at once | Hypothesis |
| GitHub round trip | Leaving there sends no events | `journey.ts` (`leavingForGitHub`), `signinEvents.ts` (`redirecting`) |
| `import_abandoned` | Only after repo pick or analysis | `signinEvents.ts` (`shouldReportAbandon`) |
| `first_flow_viewed` | Sent only after `import_started` | `signinEvents.ts` (line 78) |
| `app_installed` | Sent when the picker lists repos | `useGitHubRepoList.ts` |
| Review time | From the diff render to the answer | `events.ts` (`ms`) |
| Dead clicks | Counted per step; zero for GitHub leavers | Hypothesis; `journey.ts` (`recordClick`) |
| Clicks in `journey_clicks` | Include dead clicks | `journey.ts` (`recordClick`) |
| Persona effects | Apply to the review step only | `personas.yaml`, `personas.py` |
| Step times and pass chances | Lognormal times, probabilities from the base journey | Hypothesis, in `app_flow.yaml` |
| Piece effects | Each change is a hypothesis with a one-line note in `app_flow.yaml` | Hypothesis |
| Buttons | Change dead clicks only, never pass chances | Hypothesis: mis-clicks, not paths |

## Dry-run results

Round 1 uses reviewers 1 to 500 of the default panel, the hypothesis model and seed 7.

| Flow | Exposed | Completed | Median ms (completers) | Median clicks (completers) |
|---|---|---|---|---|
| A | 163 | 38.0% | 108,736 | 11.0 |
| B | 193 | 33.2% | 109,187 | 11.0 |
| C | 144 | 31.2% | 107,904 | 11.0 |

The same 500 visitors with every switch off (today's UI): A 30.1%, B 35.2%, C 28.5%, overall 31.6%.

Expected from the assumptions alone: A 35.6%, B 29.3%, C 32.4%, today 29.7%. With about 150 visitors
per flow, one standard error is about 4 points, so this round cannot separate the flows. It checks
that the pipeline runs and that the numbers are sensible.

**Ablation** (`--pieces ui_flow_view_layout=off`): A 38.0% to 35.0%, B 33.2% to 34.2%, C 31.2% to 29.2%.
Only the review step changes. A and C lose their review boost. B's review returns to today's value.

**Stacking** (`--pieces ui_buttons=split`): completion, time and clicks do not change, because buttons
do not affect pass chances in this model. Dead clicks per visitor move as the visitors get random
button shapes. Dead clicks range 1.42 to 1.52 under the split, against 1.32 to 1.69 in round 1.

## How to run

Set up the flags once: `make flagsmith-setup-app-flow` (Development).

- Round 1, offline: `make simulate-app-flow-dry-run`
  (`cd simulator && uv run python simulate.py --experiment app_flow --panel default --limit 500 --dry-run`)
- Round 1, live to Development: `make simulate-app-flow` (reviewers 1 to 500).
- Ablation, offline: add `--pieces ui_flow_view_layout=off` to the dry-run command.
- Ablation, live: set `ui_flow_view_layout` to off in Development, then run
  `uv run python simulate.py --experiment app_flow --panel default --offset 500 --limit 500`.
  The offset gives fresh reviewers, because the repeat guard blocks reused ones.
- Stacking, offline: add `--pieces ui_buttons=split` to the dry-run command.
- Stacking, live: set `ui_buttons` to a 34/33/33 experiment in Development, then run with
  `--offset 1000 --limit 300`.
- Today's baseline, offline: every `ui_*` switch set to `off` with `--pieces`.

## Tests

`simulator/tests/test_pieces.py` has 48 tests covering the resolver, exposure, event order,
once-per-visitor sends, the abandon path, dry-run determinism, overrides moving outcomes in the
expected direction, the fewest-click totals, rejected YAML and the CLI error paths. The whole
simulator suite passes (130 tests).
