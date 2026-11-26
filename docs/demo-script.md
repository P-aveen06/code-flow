# code-flow demo script

## Before recording

- Run [Quick start](../README.md#quick-start). Keep Flagsmith, the code-flow
  API, and the web app running. Sign in to the [Flagsmith dashboard](http://localhost:8000)
  and open **code-flow → Production → Features** in a second tab.
- Set browser zoom to 100%. Open the [code-flow landing page](http://localhost:5173/)
  in the first tab. Rehearse the import once so the clone and snapshots are ready
  for reuse. Confirm both demo commits are in the 50-commit window.
- Check that `flow_view` and `flagsmith_mode` are on. Note the starting state of
  `get_current_api_usage_deprecated`, then turn it on for the first shot.
- In **Production → Experiments → flow_view: overlay vs side by side**, check
  that the experiment is running and the 1,300-reviewer results are visible.
  Have the results ready before the take in case a refresh takes a while.
- Pin the reviewer with `?reviewer=demo-reviewer`, or append
  `&reviewer=demo-reviewer` to a commit URL. The first two shots use a layout
  preview. The post-rollout URL uses a fresh reviewer and the SDK's assignment.

## 0:00–0:20 · Problem and import

**Say** “A 1,000-line diff makes it hard to see which calls changed. code-flow
turns each Python commit into a diagram. Let’s try it on Flagsmith itself.”

**Show** Open [http://localhost:5173/](http://localhost:5173/). Under **Try an
example**, click **Flagsmith/flagsmith (api/)**. Show **Import progress** as
it clones and analyzes. Click **Open** at **Ready**, or let the viewer open
automatically. If the import runs long, cut from progress to Ready.

## 0:20–0:48 · Two commits

**Say** “This commit changes Flagsmith’s usage tasks. Green, red, and amber
show what was added, removed, and changed. Here’s a second commit, side by
side, showing the change that added rollout decisions.”

**Show** Open [a9b66f5 in overlay](http://localhost:5173/repo/Flagsmith__flagsmith?commit=a9b66f5&reviewer=demo-reviewer&view=overlay).
Click `get_current_api_usage_deprecated` in the **Flagsmith** panel. Point
out the solid green path to `get_total_events_count` and dashed off path to
`get_current_api_usage`. Open [7052cea side by side](http://localhost:5173/repo/Flagsmith__flagsmith?commit=7052cea&reviewer=demo-reviewer&view=side_by_side).
Point to the before and after diagrams.

## 0:48–1:10 · Flag findings

**Say** “The code checks `experimentation_warehouses`, but the flag is missing
from Flagsmith’s environment export. The panel also marks flags whose checks
have stayed in place across commits.”

**Show** In the **Flagsmith** panel, point to `experimentation_warehouses`
under **Orphan**, then to the **Stale** badge on
`api_limiting_block_access_to_admin`. Return to [a9b66f5 in overlay](http://localhost:5173/repo/Flagsmith__flagsmith?commit=a9b66f5&reviewer=demo-reviewer&view=overlay)
and select `get_current_api_usage_deprecated` again.

## 1:10–1:42 · Flip the live path

**Say** “These edges come from the source. Flagsmith tells us which path is
live. Turning this flag off routes the usage checks to
`get_current_api_usage`.”

**Show** Switch to [http://localhost:8000](http://localhost:8000). Open
**code-flow → Production → Features**. Search for
`get_current_api_usage_deprecated` and switch it **Off**. Confirm the change
if prompted. Return to the viewer and watch the green path move within about
10–20 seconds.

## 1:42–2:03 · Hide and restore Flagsmith mode

**Say** “Flagsmith controls this panel too. Turning off Flagsmith mode hides
the panel and the live path styling.”

**Show** In **Production → Features**, search for `flagsmith_mode` and
switch it **Off**. Return to the viewer until the panel disappears. Switch
`flagsmith_mode` back **On** in the dashboard.

## 2:03–2:34 · Experiment results

**Say** “We tested three views. With 1,300 simulated reviewers, overlay plus
summary had 30.6 percent lift on understanding and a 100 percent win
probability in Flagsmith. The simulator assumes the summary helps. This run
shows that the experiment pipeline works.”

**Show** In **Production → Experiments**, open
**flow_view: overlay vs side by side**. Click **Refresh** if available.
Point to **Diff understood** and the `overlay_summary` row. Leave the cached
results on screen if the refresh is still running.

## 2:34–2:55 · Roll out the winner

**Say** “I’ll roll out overlay plus summary to everyone in Production. Here
it is for a new reviewer.”

**Show** On the experiment page, click **End Experiment → Roll out a
variant → overlay_summary → Complete experiment**. For the same action from
the repo root, run this command.

```sh
python3 scripts/flagsmith_experiment.py rollout --variant overlay_summary
```

Open [a9b66f5 as a fresh reviewer](http://localhost:5173/repo/Flagsmith__flagsmith?commit=a9b66f5&reviewer=demo-after-rollout).
Keep the **Summary** banner and overlay in frame.

## 2:55–3:00 · Close

**Say** “Open a commit, see what changed, and follow the path that’s live.”

## After recording

- In **Production → Features**, restore `get_current_api_usage_deprecated` to
  its starting state. Leave `flagsmith_mode` on.
- Keep the completed experiment and its results. To record another rollout,
  edit the `flow_view` Production default back to `side_by_side` and set
  `overlay` and `overlay_summary` to 33% each, leaving 34% for the default.
- In **Production → Experiments → Create Experiment**, give the new run a
  distinct name. Choose `flow_view`, the 34/33/33 split, and the existing two
  metrics with **Diff understood** first. Start it, then generate 1,300 fresh
  simulated identities.

```sh
(cd simulator && uv run python simulate.py --n 1300 --prefix "sim-retake-$(date +%s)")
```

- Refresh the new results in the dashboard. Use that experiment's page for
  the next rollout. Use a fresh `demo-` reviewer ID for the last shot.
