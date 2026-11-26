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
- Roll-out of the winner is pending Paveen's decision (planned live in the demo video).
