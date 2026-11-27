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

# sync_mode (Development)

**Status** · Running in the Flagsmith **Development** environment since
2026-11-27 08:16 UTC. Not rolled out. Production has the flag disabled and
serves `manual_button`.

**Question** (Paveen): how should code-flow pick up new commits, and what does
it cost in app performance, page load and server load as repos get bigger and
more numerous?

| Variant | Share | What reviewers get |
|---|---:|---|
| A · `manual_button` (control) | 34% | The "Check for new commits" button in the viewer |
| B · `per_repo_toggle` | 33% | An Auto-sync switch per repo on the landing page (plus the button) |
| C · `global_toggle` | 33% | One "Auto-sync all repos" switch (plus the button) |

## What is measured and what is simulated

**Measured** (real runs on Paveen's MacBook, Apple M2, 2026-11-27 06:37–08:15
UTC, mains power, no sleep during any case; [harness](../scripts/sync_benchmark.py),
[tables](benchmarks/sync_mode-2026-11-27.md), [raw samples](benchmarks/sync_mode-2026-11-27.json)):

- the real code-flow API and importer on copies of imported data (never the real `data/`),
  fed by local bare Git upstreams that receive one new commit per repo per interval;
- landing page load in headless Chrome (production build, cold cache, ready = repo list and sync controls rendered);
- API p50/p95 for `/repos`, `/commits` and `/diff` while syncs run;
- API process CPU and peak RSS (1 s samples), Git fetches (Git trace), graphs built, disk growth;
- freshness: time from an upstream commit to the SHA showing in `/commits`.

**Simulated or modelled** (stated assumptions, not measurements):

- the workload mix of the reviewers: each of the 1,300 panel identities gets a
  seeded `repo_size` (small 40 % / medium 40 % / large 20 %) and `repo_count`
  (1 repo 70 % / 5 repos 30 %), sent as traits;
- how often a person clicks the manual button: **2 checks per repo per hour** (A, and
  repos not followed in B);
- which repos are followed in B: the only repo, or 2 of 5;
- the benchmark ran at a 30 s interval; per-hour CPU and freshness are
  projected to the 300 s default with the formulas in the tables file
  (freshness = measured detection-to-visible time + a seeded uniform wait for
  the next tick or visit).

Sizes: small = the 8-commit shop demo, medium = 50 and large = 200 first-parent
commits touching Flagsmith/flagsmith `api/`. Each identity's events are the
measured samples of the benchmark cell matching its assigned variant, size and
repo count; the conversion `new_commit_seen_within_5min` fires when its
freshness is at most 300 s.

## Benchmark by variant, size and repo count

Page load p50 / p95 in ms; CPU and freshness projected to the 300 s default.

| Variant | Size | Repos | Page load ms | API CPU s/h | Freshness p50 s | Peak RSS MiB |
|---|---|---:|---:|---:|---:|---:|
| A | small | 1 | 88 / 102 | 33 | 621 | 53 |
| A | small | 5 | 85 / 96 | 97 | 665 | 54 |
| A | medium | 1 | 84 / 91 | 187 | 624 | 150 |
| A | medium | 5 | 85 / 95 | 341 | 668 | 152 |
| A | large | 1 | 85 / 101 | 267 | 629 | 160 |
| A | large | 5 | 91 / 117 | 351 | 675 | 158 |
| B | small | 1 | 94 / 102 | 53 | 104 | 63 |
| B | small | 5 | 96 / 106 | 100 | 242 | 44 |
| B | medium | 1 | 96 / 106 | 218 | 106 | 153 |
| B | medium | 5 | 106 / **1,018** | 236 | 245 | 162 |
| B | large | 1 | 96 / 113 | 258 | 112 | 159 |
| B | large | 5 | 95 / **4,728** | 472 | 254 | 180 |
| C | small | 1 | 85 / 103 | 54 | 104 | 64 |
| C | small | 5 | 88 / 95 | 99 | 111 | 64 |
| C | medium | 1 | 91 / 102 | 203 | 106 | 159 |
| C | medium | 5 | 92 / **592** | 346 | 114 | 169 |
| C | large | 1 | 100 / 121 | 261 | 111 | 161 |
| C | large | 5 | **3,312 / 5,396** | **732** | 124 | 172 |

One-time imports: small 0.5 s, medium 7.7 s (129 MiB of snapshots), large
25.8 s (423 MiB), API peak RSS 63–102 MiB.

## Flagsmith results (Development, refreshed 2026-11-27 08:23 UTC)

| Metric | A · manual button (control) | B · per-repo toggle | C · global toggle |
|---|---:|---:|---:|
| Exposures | 477 | 426 | 397 |
| New commit seen within 5 min | 74 / 15.5 % | 362 / 85.0 % | 392 / 98.7 % |
| | | +447.8 % [+330.9, +564.7], win 100 % | +536.5 % [+402.9, +670.1], win 100 % |
| Mean freshness (s) | 931 | 287 | 156 |
| | | −69.1 % [−73.1, −65.1], win 100 % | −83.3 % [−84.5, −82.0], win 100 % |
| Mean landing page load (ms) | 89 | 192 | 261 |
| | | +114.8 % [+51.0, +178.5], win 0 % | +192.5 % [+98.8, +286.1], win 0 % |
| Mean API CPU (ms per hour) | 164,500 | 178,477 | 196,099 |
| | | +8.5 % [−1.0, +18.0], win 4 % | +19.2 % [+7.6, +30.8], win 0.1 % |

Lift is vs control with Flagsmith's 95 % credible interval; "win" is the
probability the variant beats control in the metric's expected direction.

## Reading the results

- **Freshness is the big win.** With 2 manual checks per repo per hour, only
  15.5 % of A reviewers see a new commit within 5 minutes (mean wait 15.5 min).
  Auto-sync gets B to 85 % and C to 98.7 %. B is lower than C only because
  reviewers with 5 repos follow 2 of them.
- **Page load is the cost, and it is a tail problem.** The median landing page
  stays at 85–106 ms in every cell except C with five large repos. The means
  in Flagsmith rise because of a few very slow loads in the 5-repo medium and
  large cells (p95 0.6–4.7 s) and C/large/5 (p50 3.3 s): every page load there
  overlapped a sync, and the analysis runs in the API process, so requests
  wait behind it.
- **Server CPU** barely moves for B (+8.5 %, not significant) and rises for C
  (+19 %), up to 732 CPU s/h (about 20 % of a core) for five large repos.
- Memory stays under 185 MiB in every cell, so all three fit the 512 MB Render
  instance; at 5 large repos the hosted instance would still feel C's page-load
  tail.

## Recommendation (not rolled out)

**B · per-repo toggle** is the better trade-off today: 85 % see new commits
within 5 minutes (vs 15.5 %), with no significant CPU increase and normal
median page loads. C is fresher still but costs the most CPU and makes the
landing page slow when several large repos sync together.

Before rolling B out, move the refresh analysis off the API's request path
(a separate worker process, or lower priority) and re-run the large/5-repo
cells: that should remove the page-load tail for both B and C, and then C may
become the better default for small setups. Leave the experiment running in
Development until then.
