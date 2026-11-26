# flow_view experiment: results (simulated reviewers)

Run on 26 Nov 2026 in Paveen's self-hosted Flagsmith 2.295.2 (project `code-flow`, environment Production, Experimentation with the "Flagsmith database" warehouse). Numbers below are Flagsmith's own analysis, read from the experiment results endpoint (`python3 scripts/flagsmith_experiment.py status`).

**The reviewers are simulated.** Their behaviour comes from the assumptions in [`simulator/behaviour.yaml`](../simulator/behaviour.yaml) (understanding probability and decision time per variant, diff sizes sampled from 14 real flow-changing Flagsmith commits, and personas: role, experience, codebase familiarity, reading style). The model encodes our hypothesis, so this run demonstrates the experiment pipeline and Flagsmith's analysis; it is not evidence about real users.

- **Hypothesis:** reviewers understand a code change more often with an overlay flow diff plus a one-line summary than with before/after diagrams side by side.
- **Flag:** `flow_view` (multivariate): `side_by_side` (control) 34 %, `overlay` 33 %, `overlay_summary` 33 %.
- **Exposure:** `getExperimentFlag` / `get_experiment_flag("flow_view")`. **Primary metric:** "Diff understood" = occurrence of the `diff_understood` event (higher is better). Secondary: "Diff time to understand (ms)", mean value per exposure (lower is better; reviewers who never clicked "understood" count as 0, so this metric is only indicative).
- **Traffic:** 300 simulated reviewers with distinct personas (`sim-persona-0001…0100`, then `sim-persona-b-0001…0200`), sent with the official Flagsmith Python SDK.

## Diff understood (primary)

| Variant | Reviewers (exposures) | Understood | Rate | Lift vs control | 95 % credible interval | Win probability |
|---|---:|---:|---:|---:|---|---:|
| side_by_side (control) | 94 | 46 | 48.9 % | | | |
| overlay | 111 | 67 | 60.4 % | +23.3 % | −8.4 % to +55.0 % | 92.6 % |
| overlay_summary | 95 | 64 | 67.4 % | +37.7 % | +3.1 % to +72.2 % | 98.4 % |

## Diff time to understand (secondary)

| Variant | Mean ms per exposure | Lift vs control | 95 % credible interval | Win probability |
|---|---:|---:|---|---:|
| side_by_side (control) | 41,204 | | | |
| overlay | 44,299 | +7.5 % | −32.8 % to +47.8 % | 35.8 % |
| overlay_summary | 40,173 | −2.5 % | −40.9 % to +35.9 % | 55.1 % |

## Reading it

- `overlay_summary` beats the control on the primary metric with a 98.4 % win probability, and its 95 % credible interval stays above zero. `overlay` is likely better than the control (92.6 %) but its interval still includes zero.
- The time metric is inconclusive at this sample size.
- With the first 100 reviewers only (24 / 41 / 35 per variant), Flagsmith withheld lift and win probability: it needs at least 50 identities and 5 conversions per variant (`RESULTS_MIN_IDENTITIES_PER_VARIANT`).
- Roll-out of the winner is pending Paveen's decision.
