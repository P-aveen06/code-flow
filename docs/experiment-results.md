# flow_view experiment: results (simulated reviewers)

Run on 26 Nov 2026 in Paveen's self-hosted Flagsmith 2.295.2 (project `code-flow`, environment Production, Experimentation with the "Flagsmith database" warehouse). Numbers below are Flagsmith's own analysis, read from the experiment results endpoint (`python3 scripts/flagsmith_experiment.py status`).

**The reviewers are simulated.** Their behaviour comes from the assumptions in [`simulator/behaviour.yaml`](../simulator/behaviour.yaml) (understanding probability and decision time per variant, diff sizes sampled from 14 real flow-changing Flagsmith commits, and personas: role, experience, codebase familiarity, reading style). The model encodes our hypothesis, so this run demonstrates the experiment pipeline and Flagsmith's analysis; it is not evidence about real users.

- **Hypothesis:** reviewers understand a code change more often with an overlay flow diff plus a one-line summary than with before/after diagrams side by side.
- **Flag:** `flow_view` (multivariate): `side_by_side` (control) 34 %, `overlay` 33 %, `overlay_summary` 33 %.
- **Exposure:** `getExperimentFlag` / `get_experiment_flag("flow_view")`. **Primary metric:** "Diff understood" = occurrence of the `diff_understood` event (higher is better). Secondary: "Diff time to understand (ms)", mean value per exposure (lower is better; reviewers who never clicked "understood" count as 0, so this metric is only indicative).
- **Traffic:** 1,300 simulated reviewers with distinct personas, sent with the official Flagsmith Python SDK in three batches: `sim-persona-0001…0100`, `sim-persona-b-0001…0200`, `sim-persona-c-0001…1000`.

## Final: 1,300 reviewers

### Diff understood (primary)

| Variant | Reviewers (exposures) | Understood | Rate | Lift vs control | 95 % credible interval | Win probability |
|---|---:|---:|---:|---:|---|---:|
| side_by_side (control) | 432 | 220 | 50.9 % | | | |
| overlay | 447 | 273 | 61.1 % | +19.9 % | +5.7 % to +34.2 % | 99.7 % |
| overlay_summary | 421 | 280 | 66.5 % | +30.6 % | +15.6 % to +45.6 % | 100.0 % |

### Diff time to understand (secondary)

| Variant | Mean ms per exposure | Lift vs control | 95 % credible interval | Win probability |
|---|---:|---:|---|---:|
| side_by_side (control) | 52,466 | | | |
| overlay | 48,418 | −7.7 % | −26.6 % to +11.2 % | 78.8 % |
| overlay_summary | 41,596 | −20.7 % | −36.3 % to −5.1 % | 99.5 % |

## How the result built up

| Reviewers | Per variant (side_by_side / overlay / overlay_summary) | overlay_summary lift (understood) | Win probability |
|---:|---|---|---:|
| 100 | 24 / 41 / 35 | withheld by Flagsmith (< 50 per variant) | — |
| 300 | 94 / 111 / 95 | +37.7 % (+3.1 % to +72.2 %) | 98.4 % |
| 1,300 | 432 / 447 / 421 | +30.6 % (+15.6 % to +45.6 %) | 100.0 % |

## Reading it

- At 1,300 reviewers, `overlay_summary` beats the control on both metrics: +30.6 % more reviewers understand the change (credible interval well above zero, win probability 100.0 %) and they decide about 21 % faster (99.5 %). `overlay` also beats the control on understanding (+19.9 %, 99.7 %), but its time gain is not conclusive.
- More traffic narrowed the interval: at 300 reviewers the lift was +37.7 % with an interval from +3.1 % to +72.2 %; at 1,300 it is +30.6 % from +15.6 % to +45.6 %.
- With the first 100 reviewers only, Flagsmith withheld lift and win probability: it needs at least 50 identities and 5 conversions per variant (`RESULTS_MIN_IDENTITIES_PER_VARIANT`).
- These are simulated reviewers whose behaviour encodes the hypothesis (see the note at the top), so the run shows that the experiment, the events and Flagsmith's analysis work end to end; real reviewers are needed to test the hypothesis itself.
- **Rolled out:** on 26 Nov 2026 (16:35 UTC) the experiment was completed with `overlay_summary` as the winner; Flagsmith now serves `overlay_summary` to 100 % of identified reviewers in Production (`python3 scripts/flagsmith_experiment.py rollout --variant overlay_summary`).


# flow_direction experiment: results (simulated reviewers, long flows)

Run on 26 Nov 2026 in the same Flagsmith project and environment, after `flow_view` was rolled out to `overlay_summary` (so every reviewer saw the overlay + summary view, laid out horizontally or vertically).

**The reviewers are simulated** — the same fixed panel of 1,300 personas (`simulator/panels/default.csv`). Their behaviour for this experiment comes from the assumptions in [`simulator/experiments/flow_direction.yaml`](../simulator/experiments/flow_direction.yaml) (vertical assumed +5 points understood and −10 % median time at depth 4, slightly more per extra layer). The run demonstrates the pipeline and Flagsmith's analysis; it is not evidence about real users.

- **Hypothesis:** for long flows, a top-down layout is understood more often and faster than left-to-right.
- **Flag:** `flow_direction` (multivariate): `horizontal` (control) 50 %, `vertical` 50 %.
- **Long flow:** `flow_depth` ≥ 4 call layers in the changed neighbourhood (5 of the 14 flow-changing Flagsmith `api/` commits). Only reviewers shown a long flow are exposed (`getExperimentFlag('flow_direction')`); the simulator sampled only those 5 commits.
- **Metrics:** "Layout understood" = occurrence of `layout_understood` (primary); "Layout time to understand (ms)" = mean value per exposure (indicative only, non-converters count as 0).

## Layout understood (primary)

| Variant | Reviewers (exposures) | Understood | Rate | Lift vs control | 95 % credible interval | Win probability |
|---|---:|---:|---:|---:|---|---:|
| horizontal (control) | 648 | 394 | 60.8 % | | | |
| vertical | 652 | 437 | 67.0 % | +10.2 % | +1.2 % to +19.3 % | 98.7 % |

## Layout time to understand (secondary)

| Variant | Mean ms per exposure | Lift vs control | 95 % credible interval | Win probability |
|---|---:|---:|---|---:|
| horizontal (control) | 26,884 | | | |
| vertical | 25,431 | −5.4 % | −15.6 % to +4.8 % | 85.0 % |

## Reading it

- Vertical beats horizontal on understanding for long flows (+10.2 %, interval above zero, 98.7 % win probability). The time difference is not conclusive.
- The effect is what the simulator's assumptions put in; a real decision needs real reviewers.
- **Rolled out:** on 26 Nov 2026 (16:41 UTC) the experiment was completed with `vertical` as the winner (`python3 scripts/flagsmith_experiment.py --experiment flow_direction rollout --variant vertical`); Flagsmith now serves `vertical` to 100 % of identified reviewers. The viewer applies it to long flows only; short flows stay horizontal by design.

# Replay in the Development environment (26 Nov 2026)

After this point simulated runs belong in the **Development** environment; Production is for real reviewers. Both experiments above were replayed in Development of the same `code-flow` project with the same setup: original splits (`flow_view` 34/33/33, `flow_direction` 50/50), the same metrics, the same 1,300-reviewer panel (`simulator/panels/default.csv`, seed 7) and the same behaviour assumptions. `flow_view` was sent in the same steps (100 → 300 → 1,300). Both Development experiments are still running; nothing was rolled out there. Production was not touched.

Flagsmith assigns variants by hashing per environment, so the same reviewer can land in a different variant in Development; the splits and numbers are therefore close to Production but not identical.

## flow_view: Diff understood (primary)

| Reviewers | Environment | side_by_side (control) | overlay | overlay_summary | overlay lift (95 % CI), win prob. | overlay_summary lift (95 % CI), win prob. |
|---:|---|---:|---:|---:|---|---|
| 100 | Production | 24, 45.8 % | 41, 65.9 % | 35, 65.7 % | withheld (< 50 per variant) | withheld |
| 100 | Development | 39, 48.7 % | 28, 60.7 % | 33, 72.7 % | withheld (< 50 per variant) | withheld |
| 300 | Production | 94, 48.9 % | 111, 60.4 % | 95, 67.4 % | +23.3 % (−8.4 % to +55.0 %), 92.6 % | +37.7 % (+3.1 % to +72.2 %), 98.4 % |
| 300 | Development | 101, 52.5 % | 110, 62.7 % | 89, 68.5 % | +19.5 % (−8.7 % to +47.8 %), 91.3 % | +30.6 % (+0.0 % to +61.2 %), 97.5 % |
| 1,300 | Production | 432, 50.9 % | 447, 61.1 % | 421, 66.5 % | +19.9 % (+5.7 % to +34.2 %), 99.7 % | +30.6 % (+15.6 % to +45.6 %), 100.0 % |
| 1,300 | Development | 432, 48.4 % | 464, 62.1 % | 404, 69.8 % | +28.3 % (+12.8 % to +43.8 %), 100.0 % | +44.3 % (+27.4 % to +61.1 %), 100.0 % |

## flow_view: Diff time to understand (secondary, 1,300 reviewers)

| Environment | overlay | overlay_summary |
|---|---|---|
| Production | −7.7 % (−26.6 % to +11.2 %), 78.8 % | −20.7 % (−36.3 % to −5.1 %), 99.5 % |
| Development | −6.3 % (−26.0 % to +13.3 %), 73.6 % | −2.2 % (−22.4 % to +18.0 %), 58.4 % |

The time metric is the mean `diff_understood` value per exposure, with reviewers who never answered "understood" counted as 0. A variant with more "understood" answers therefore gets a higher mean even if each answer is faster, which is why this metric swings between runs. Treat it as indicative only.

## flow_direction (long flows, 1,300 reviewers)

| Environment | horizontal (control) | vertical | Layout understood: lift (95 % CI), win prob. | Layout time: lift (95 % CI), win prob. |
|---|---:|---:|---|---|
| Production | 648, 60.8 % | 652, 67.0 % | +10.2 % (+1.2 % to +19.3 %), 98.7 % | −5.4 % (−15.6 % to +4.8 %), 85.0 % |
| Development | 637, 60.1 % | 663, 68.6 % | +14.1 % (+4.8 % to +23.5 %), 99.9 % | −4.2 % (−14.5 % to +6.1 %), 78.8 % |

## Reading it

- Both replays reach the same conclusions as Production on the primary metrics: `overlay_summary` beats `side_by_side` on understanding, and `vertical` beats `horizontal` on long flows, with credible intervals above zero and win probabilities of 99.9–100 %.
- The exact percentages differ because Flagsmith's per-environment hashing put some reviewers in different variants, which changes their sampled outcomes. The secondary time metrics are inconclusive in Development.
- These are simulated reviewers whose behaviour encodes the hypotheses; agreement between the two runs shows that the pipeline and Flagsmith's analysis are consistent, not that real users behave this way.

On 2026-11-27, the `sync_mode` experiment ran in Development and compared a manual button, per-repo auto-sync, and global auto-sync. Auto-sync was dropped from scope to keep code-flow focused. The manual **Check for new commits** button stays.

# github_signin experiment: results (simulated visitors)

Run on 28 Nov 2026 in Paveen's self-hosted Flagsmith 2.295.2, project `code-flow`, environment **Development**, at commit `2e4fd71` (the Sign in with GitHub merge). Production was not touched. Numbers in the first table are Flagsmith's own analysis (`python3 scripts/flagsmith_experiment.py --experiment github_signin status`).

**The visitors are simulated.** Their journeys come from [`simulator/experiments/github_signin.yaml`](../simulator/experiments/github_signin.yaml): the share of each role who came for a private repository, and the chance of getting through each step. Those numbers are our guesses, so this run tests the setup and Flagsmith's analysis, not real users.

- **Hypothesis:** more visitors finish an import when they can sign in with GitHub and pick any repository they allow, including private ones, than when they can only paste a public URL.
- **Flag:** `github_signin` (multivariate): `url_import` (control) 50 %, `github_signin` 50 %.
- **Exposure:** `getExperimentFlag("github_signin")` on the landing page.
- **Metrics:**
  - Import completed: occurrence of `import_completed`. This is the goal, and higher is better.
  - Time to first flow (ms): mean `first_flow_viewed` value per exposure. Lower is better. This is the guardrail.
  - Import abandoned: occurrence of `import_abandoned`. Lower is better.
- **Traffic:** the same 1,300-persona panel as the other experiments (`simulator/panels/default.csv`), sent with `make simulate-signin`.

## Flagsmith's results (1,300 visitors)

| Metric | url_import (control), 635 | github_signin, 665 | Lift (95 % CI) | Win probability |
|---|---:|---:|---|---:|
| Import completed | 331, 52.1 % | 414, 62.3 % | +19.4 % (+8.1 % to +30.8 %) | 100.0 % |
| Time to first flow (ms), mean per exposure | 24,566 | 56,416 | +129.7 % (+105.5 % to +153.8 %) | 0.0 % |
| Import abandoned | 140, 22.0 % | 169, 25.4 % | +15.3 % (−7.3 % to +37.9 %) | 9.3 % |

Win probability is the chance that `github_signin` is better than the control. For time and abandonment, better means lower.

## The journey, step by step

These counts come from the simulator's own summary of the same run.

| Event | url_import | github_signin |
|---|---:|---:|
| import_started | 471 | 583 |
| signin_started | 0 | 518 |
| signin_completed | 0 | 478 |
| app_installed | 0 | 413 |
| repo_selected | 0 | 394 |
| import_completed | 331 | 414 |
| import_abandoned | 140 | 169 |
| Median time to first flow, visitors who saw one | 45,246 ms | 90,572 ms |

The offline rehearsal (`make simulate-signin-dry-run`) split the panel 676 / 624 and gave 47.6 % against 65.1 % completion. The live split differs because Flagsmith assigns variants with its own hashing.

## Reading it

- **Sign-in gets more visitors to a finished import:** +19.4 %, with the whole interval above zero. The gain comes from visitors who came for a private repository, which a public URL can't reach.
- **It takes about twice as long:** visitors who saw a flow waited about 91 s with sign-in and 47 s without (mean, derived from Flagsmith's per-exposure numbers). The extra time is the trip to GitHub to authorize and choose repositories. Flagsmith's +129.7 % is larger than that because visitors with no flow count as 0, and sign-in has more visitors with a flow. The guardrail fails, as expected when we planned it.
- **Abandonment is not conclusive:** the interval spans zero. Sign-in brings more visitors into the journey (583 against 471 started an import), and about the same share of those who start leave without finishing (29.0 % against 29.7 %). So the higher count reflects more starts, not a worse journey. The simulator's assumptions never made abandonment fall; the setup doc now says so.
- **Decision:** completed in Development on 28 Nov 2026 with `github_signin` rolled out at 100 % (the cached numbers above; a later refresh mixed in events from the app_flow round, whose visitors reused the same panel identities, and left the winner unchanged). Real visitors would also need the GitHub App to be set up on the hosted site first (see [GITHUB_SIGNIN.md](GITHUB_SIGNIN.md)). If the time cost matters, the obvious lever is to cut a GitHub trip, for example by letting visitors choose repositories while they authorize.

# app_flow experiment: which whole app helps reviewers finish? (simulated reviewers)

Run on 28 Nov 2026 in Paveen's self-hosted Flagsmith 2.295.2, project `code-flow`, environment **Development**. Production was not touched. Every number below is Flagsmith's own analysis (`python3 scripts/flagsmith_experiment.py --experiment <flag> --round <label> status`). How the rounds are run is in [APP_FLOW_BUILD.md](APP_FLOW_BUILD.md), "Running the rounds".

**The reviewers are simulated.** Each piece's effect on each step of the journey is one assumption in [`simulator/experiments/app_flow.yaml`](../simulator/experiments/app_flow.yaml), so these runs test the method and Flagsmith's analysis, not real users. That file also lets us check each result against the truth we assumed, which is how we caught two lucky wins below.

- **Hypothesis:** one of three complete designs, A Guided, B Workbench or C Canvas, gets more reviewers through the whole journey than the others.
- **Flags:** `app_flow` (multivariate): `a` (control) 34 %, `b` 33 %, `c` 33 %, plus 11 `ui_*` switches, one per piece (flow view layout, branch switch, repo details, repos, sign-in, landing, colours, font family, line spacing, font weight, buttons). Each switch follows `app_flow` by default, or is pinned to a, b or c, or split on its own.
- **Exposure:** `getExperimentFlag("app_flow")` on the landing page. In a per-piece round, the piece's own `getExperimentFlag("ui_<piece>")` exposes the visitor.
- **Main metric:** Journey completed: the reviewer answered "I understand it", then switched to a second branch and reached its flow view (`journey_completed`, higher is better). Supporting: Import completed, Diff understood, Journey clicks and Dead clicks (lower is better). Supporting metrics explain a result but never decide it.
- **Tie rule:** a round has a winner only when a flow has at least 95 % win probability against the control.

## Round 1: three whole apps (1,000 reviewers)

| Metric | a Guided (control), 342 | b Workbench, 351 | c Canvas, 305 |
|---|---:|---:|---:|
| Journey completed | 123, 36.0 % | 103, 29.3 %: −18.4 % (−36.0 % to −0.8 %), 2.0 % | 118, 38.7 %: +7.6 % (−14.0 % to +29.1 %), 75.5 % |
| Diff understood | 211, 61.7 % | 168, 47.9 %: −22.4 % (−33.1 % to −11.7 %), 0.0 % | 188, 61.6 %: −0.1 % (−12.3 % to +12.1 %), 49.4 % |
| Import completed | 266, 77.8 % | 262, 74.6 %: −4.0 % (−12.0 % to +4.0 %), 16.2 % | 237, 77.7 %: −0.1 % (−8.4 % to +8.2 %), 49.1 % |
| Journey clicks, mean per exposure | 3.8 | 3.0: −20.7 % (−38.0 % to −3.5 %), 99.1 % | 4.3: +12.5 % (−10.2 % to +35.2 %), 14.1 % |
| Dead clicks, mean per exposure | 1.2 | 1.6: +35.5 % (+18.6 % to +52.3 %), 0.0 % | 1.7: +47.7 % (+29.1 % to +66.3 %), 0.0 % |

Each cell after the control is: value, lift vs a (95 % credible interval), win probability vs a. For clicks, better means lower. At the first 500 reviewers c led on Journey completed with 92 %, short of the bar; the next 500 brought it to 75.5 %.

- **Workbench loses:** fewer reviewers finish and fewer understand the diff, both with intervals below zero. Its lower click count only reflects fewer reviewers reaching the end.
- **Guided and Canvas tie** by our rule. Canvas causes clearly more dead clicks (+47.7 %).
- So the ablation step had nothing to remove, and we moved straight to testing each piece on its own. The round was closed without a winner (`rollout --variant a` only closes it).

## Each piece on its own (11 rounds, 1,000 fresh reviewers each)

`app_flow` stayed split 34/33/33 while one `ui_*` switch at a time was split as its own experiment. Each round used new identities (`sim-stack-01` to `sim-stack-11`), and its winner was pinned before the next round.

| Round | Piece | Journey completed a / b / c | Win probability b, c vs a | Dead clicks a / b / c | Flagsmith's pick |
|---:|---|---|---|---|---|
| 1 | flow view layout | 30.2 / 30.4 / 38.8 % | 52.9 %, 98.1 % | 1.4 / 1.5 / 1.5 | c (lucky, see below) |
| 2 | branch switch | 33.1 / 34.9 / 33.2 % | 68.6 %, 51.9 % | 1.5 / 1.5 / 1.4 | a |
| 3 | repo details | 32.5 / 30.3 / 35.6 % | 26.1 %, 79.2 % | 1.4 / 1.4 / 1.6 | a |
| 4 | repos | 32.2 / 35.4 / 33.4 % | 79.4 %, 63.3 % | 1.4 / 1.6 / 1.5 | a |
| 5 | sign-in | 35.2 / 35.6 / 32.2 % | 54.2 %, 20.1 % | 1.4 / 1.4 / 1.4 | a |
| 6 | landing | 35.1 / 32.5 / 31.8 % | 22.7 %, 16.6 % | 1.4 / 1.4 / 1.4 | a |
| 7 | colours | 29.1 / 38.9 / 35.0 % | 98.8 %, 93.3 % | 1.3 / 1.5 / 1.4 | b (lucky, see below) |
| 8 | font family | 31.9 / 34.0 / 36.4 % | 71.1 %, 87.1 % | 1.4 / 1.4 / 1.5 | a |
| 9 | line spacing | 37.3 / 29.8 / 34.6 % | 1.2 %, 23.1 % | 1.5 / 1.3 / 1.4 | a |
| 10 | font weight | 35.0 / 33.3 / 36.4 % | 32.0 %, 63.6 % | 1.4 / 1.4 / 1.5 | a |
| 11 | buttons | 38.0 / 33.3 / 31.4 % | 9.5 %, 2.5 % | 1.2 / 1.5 / 1.4 | a |

## Reading it

- **Two of the 22 comparisons crossed 95 %, and both contradict what we assumed.** In `app_flow.yaml`, the flow view layout helps a review most with a (×1.10), then c (×1.04), so c should not beat a. Colours b only makes the review about 1 % faster and changes nobody's chance of finishing, so it cannot truly win on completion. At 95 % per comparison, about one lucky win in 22 is expected by chance, and we got two.
- **The rounds were too small for pieces this close.** The gaps we assumed between pieces are about 1 to 5 % relative. Telling those apart needs thousands of reviewers per variant, and each variant here had about 333.
- **What we did:** pinned both pieces back to the control, then re-ran the flow view layout once with enough reviewers and everything else fixed. The confirmation round is below.

## Confirmation: the flow view layout with 30,000 reviewers

Both lucky pieces were pinned back to a. Then `app_flow` was set to a, so every other piece was fixed at Guided, and only `ui_flow_view_layout` was split as experiment "ui_flow_view_layout: a vs b vs c [confirm]". 30,000 fresh reviewers (`sim-confirm-1` to `sim-confirm-3`, 10,000 each, no dropped events) took 27 minutes to send.

| Metric | a Guided (control), 10,175 | b Workbench, 9,898 | c Canvas, 9,927 |
|---|---:|---:|---:|
| Journey completed | 3,667, 36.0 % | 3,087, 31.2 %: −13.5 % (−16.8 % to −10.1 %), 0.0 % | 3,356, 33.8 %: −6.2 % (−9.7 % to −2.7 %), 0.0 % |
| Diff understood | 60.3 % | 52.9 %: −12.3 %, 0.0 % | 56.9 %: −5.6 %, 0.0 % |
| Import completed | 7,700, 75.7 % | 7,508, 75.9 %: +0.2 % (−1.3 % to +1.8 %), 61.6 % | 7,562, 76.2 %: +0.7 % (−0.9 % to +2.2 %), 79.6 % |
| Dead clicks, mean per exposure | 1.2 | 1.2: −0.7 % (−3.2 % to +1.7 %), 72.3 % | 1.2: +0.8 % (−1.7 % to +3.3 %), 25.9 % |

- **Guided's flow view is best**, 2.2 points ahead of Canvas and 4.8 ahead of Workbench, with both intervals well below zero. That matches the assumptions in `app_flow.yaml`, and it reverses the 1,000-reviewer round, where chance put Canvas first at 98.1 %.
- **The sanity check passes:** Import completed happens before the flow view, so the layout can't change it, and it is level across the three versions.
- **Decision:** completed with a rolled out. `app_flow` is a and every `ui_*` piece is a in Development, so the app is Guided throughout. Production is unchanged.

## What we learned about the method

- A 95 % bar per comparison is not enough when one round makes 22 comparisons: expect about one lucky win. Confirm any piece-level win with a round sized for the gap before rolling it out.
- Size each round for the smallest gap that matters. 1,000 reviewers separate whole apps that differ by 7 points (Workbench lost clearly in round 1) but not pieces that differ by 2.
- Give every round fresh identities. Flagsmith counts an identity's events in every experiment that identity is in, so reused reviewers mix rounds.

## Ablation: which pieces make the flows differ? (10,000 reviewers per round)

Paveen's method asks for an ablation before choosing a flow: keep `app_flow` split, switch one more piece off (back to the earlier UI) each round, and stop at the first round where the three flows tie. Round 1 had no clear winner between Guided and Canvas, but Workbench lost clearly, so the flows did not really tie. We ran the ablation with 10,000 fresh reviewers per round (`sim-abl-01` to `sim-abl-04`), big enough that a tie means the flows are equal and not just noise. Tie: neither b nor c has at least 95 % or at most 5 % win probability against a on Journey completed.

| Round | Pieces off (cumulative) | Journey completed a / b / c | Win probability b, c vs a | Import completed a / b / c | Dead clicks a / b / c | Result |
|---:|---|---|---|---|---|---|
| 1 | flow view | 34.0 / 30.6 / 29.8 % | 0.1 %, 0.0 % | 76.2 / 72.4 / 72.6 % | 1.2 / 1.6 / 1.5 | a ahead |
| 2 | + branch switch | 33.0 / 30.9 / 29.9 % | 2.6 %, 0.2 % | 74.7 / 73.3 / 72.8 % | 1.2 / 1.6 / 1.5 | a ahead |
| 3 | + repo details | 32.5 / 30.7 / 29.2 % | 4.4 %, 0.1 % | 75.4 / 72.9 / 69.7 % | 1.2 / 1.6 / 1.4 | a ahead |
| 4 | + repos | 31.2 / 30.7 / 30.3 % | 32.3 %, 20.7 % | 74.5 / 73.2 / 70.8 % | 1.2 / 1.6 / 1.5 | **tie** |

Round 4 in full: b −1.6 % (−8.7 % to +5.4 %), c −2.9 % (−9.9 % to +4.1 %). Each round was closed with `rollout --variant a`, which only closes it.

- **The baseline is four pieces off:** the flow view, the branch switch, repo details and the repos page. Guided's lead over Workbench and Canvas lives in those pieces, all of them after sign-in.
- **Guided still causes fewer dead clicks in every round** (1.2 against 1.4 to 1.6), so the pieces still on (landing, sign-in, buttons, fonts, colours) differ there, but not in how many reviewers finish.

## Stacking on the baseline (10,000 reviewers per round)

Starting from the baseline (those four pieces off, `app_flow` split, the other seven pieces following the flow), each removed piece was added back as its own a/b/c experiment, biggest gap first, and the winner was pinned before the next round (`sim-bstack-01` to `sim-bstack-04`).

| Round | Piece added back | Journey completed a / b / c | Win probability b, c vs a | Import completed a / b / c | Dead clicks a / b / c | Winner |
|---:|---|---|---|---|---|---|
| 1 | flow view | 33.3 / 30.3 / 31.8 % | 0.2 %, 8.0 % | 72.7 / 72.9 / 72.0 % | 1.5 / 1.4 / 1.5 | a |
| 2 | branch switch | 33.7 / 33.6 / 34.9 % | 45.1 %, 84.2 % | 72.0 / 73.1 / 73.4 % | 1.4 / 1.4 / 1.5 | a |
| 3 | repos | 33.7 / 33.2 / 34.8 % | 32.3 %, 82.2 % | 73.1 / 72.1 / 73.2 % | 1.4 / 1.5 / 1.4 | a |
| 4 | repo details | 34.8 / 33.0 / 34.9 % | 5.3 %, 53.2 % | 75.7 / 71.9 / 73.9 % | 1.4 / 1.4 / 1.5 | a |

Closest calls: round 2 c +3.5 % (−3.3 % to +10.4 %), round 3 c +3.2 % (−3.6 % to +10.1 %), round 4 b −5.2 % (−11.5 % to +1.1 %).

- **Guided's flow view wins for the third time** (round 1 of stacking, the 30,000-reviewer check, and its share of the ablation gap). Workbench's is clearly worse.
- **No Workbench or Canvas piece reached 95 %**, so Guided's version stays for the branch switch, the repos page and repo details. Our model does give Canvas's branch switch a very small edge (about 2 % at that step, under a point on completion), which fits round 2's +3.5 % but is too small for 10,000 reviewers to confirm.

## Decision

The whole method (best of three, ablation, stacking) lands on Guided wherever the flows differ in how many reviewers finish, and Guided causes the fewest dead clicks in every ablation round. **Flow A (Guided) is the pick for Production.** Development is pinned to Flow A: `app_flow` a and every `ui_*` piece a.
