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
